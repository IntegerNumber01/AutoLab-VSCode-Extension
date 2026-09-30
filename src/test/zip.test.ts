import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import * as zlib from "zlib";
import { crc32, createZipFile, ZipArchive, ZipFormatError } from "../zip";

suite("Portable ZIP writer and reader", () => {
  let workspace: string;

  setup(async () => {
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autolab-zip-test-"));
  });

  teardown(async () => {
    await fs.promises.rm(workspace, { recursive: true, force: true });
  });

  test("round-trips nested, unicode, empty, and binary files", async () => {
    const files: Record<string, Buffer> = {
      "main.c": Buffer.from("int main(void) { return 0; }\n", "utf8"),
      "src/deep/nested/notes.md": Buffer.from("# Notes\n".repeat(500), "utf8"),
      "données/héllo wörld.txt": Buffer.from("naïve café — ✓", "utf8"),
      "empty.txt": Buffer.alloc(0),
      "data.bin": Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256)),
    };

    const source = path.join(workspace, "lab");
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(source, ...name.split("/"));
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content);
    }

    const archivePath = path.join(workspace, "submission.zip");
    await createZipFile(
      archivePath,
      Object.keys(files).map((name) => ({ archivePath: name, sourcePath: path.join(source, ...name.split("/")) })),
    );

    const archive = await ZipArchive.open(archivePath);
    try {
      assert.deepStrictEqual(archive.entries.map((entry) => entry.path).sort(), Object.keys(files).sort());
      for (const entry of archive.entries) {
        const expected = files[entry.path];
        assert.ok(expected, `unexpected entry ${entry.path}`);
        assert.strictEqual(entry.isDirectory, false);
        assert.strictEqual(entry.size, expected.length);
        assert.deepStrictEqual(await archive.read(entry), expected);
      }
    } finally {
      await archive.close();
    }
  });

  test("stores incompressible data instead of growing the archive", async () => {
    const incompressible = randomBytes(65_536);

    const sourcePath = path.join(workspace, "blob.gz");
    await fs.promises.writeFile(sourcePath, incompressible);
    const archivePath = path.join(workspace, "store.zip");
    await createZipFile(archivePath, [{ archivePath: "blob.gz", sourcePath }]);

    const archive = await ZipArchive.open(archivePath);
    try {
      const [entry] = archive.entries;
      assert.strictEqual(entry.method, 0, "expected the STORE method for incompressible data");
      assert.strictEqual(entry.compressedSize, incompressible.length);
      assert.deepStrictEqual(await archive.read(entry), incompressible);
    } finally {
      await archive.close();
    }
  });

  test("writes a spec-compliant layout that an independent parser can walk", async () => {
    const content = Buffer.from("submission body\n".repeat(200), "utf8");
    const sourcePath = path.join(workspace, "answer.txt");
    await fs.promises.writeFile(sourcePath, content);
    const archivePath = path.join(workspace, "layout.zip");
    await createZipFile(archivePath, [{ archivePath: "answer.txt", sourcePath }]);

    const raw = await fs.promises.readFile(archivePath);

    // End of central directory, parsed without touching the extension's own reader.
    const endOffset = raw.length - 22;
    assert.strictEqual(raw.readUInt32LE(endOffset), 0x06054b50);
    assert.strictEqual(raw.readUInt16LE(endOffset + 10), 1, "one central directory entry");
    const directorySize = raw.readUInt32LE(endOffset + 12);
    const directoryOffset = raw.readUInt32LE(endOffset + 16);
    assert.strictEqual(directoryOffset + directorySize, endOffset);

    // Central directory header.
    assert.strictEqual(raw.readUInt32LE(directoryOffset), 0x02014b50);
    assert.strictEqual(raw.readUInt16LE(directoryOffset + 8) & 0x0800, 0x0800, "UTF-8 name flag");
    const method = raw.readUInt16LE(directoryOffset + 10);
    const storedCrc = raw.readUInt32LE(directoryOffset + 16);
    const compressedSize = raw.readUInt32LE(directoryOffset + 20);
    const uncompressedSize = raw.readUInt32LE(directoryOffset + 24);
    const localOffset = raw.readUInt32LE(directoryOffset + 42);
    assert.strictEqual(uncompressedSize, content.length);
    assert.strictEqual(storedCrc, crc32(content));
    assert.strictEqual(localOffset, 0);

    // Unix permissions survive in the upper half of the external attributes.
    const externalAttributes = raw.readUInt32LE(directoryOffset + 38);
    assert.strictEqual((externalAttributes >>> 16) & 0xf000, 0o100000, "regular file type bits");

    // Local header, then inflate the payload with zlib directly.
    assert.strictEqual(raw.readUInt32LE(localOffset), 0x04034b50);
    const nameLength = raw.readUInt16LE(localOffset + 26);
    const extraLength = raw.readUInt16LE(localOffset + 28);
    assert.strictEqual(raw.subarray(localOffset + 30, localOffset + 30 + nameLength).toString("utf8"), "answer.txt");
    const dataStart = localOffset + 30 + nameLength + extraLength;
    const payload = raw.subarray(dataStart, dataStart + compressedSize);
    const decoded = method === 0 ? payload : zlib.inflateRawSync(payload);
    assert.deepStrictEqual(decoded, content);
  });

  test("reads a store-only archive built byte by byte elsewhere", async () => {
    const name = Buffer.from("hello.txt", "utf8");
    const content = Buffer.from("hello from another zip tool", "utf8");
    const checksum = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);

    const directoryOffset = local.length + name.length + content.length;
    const directorySize = central.length + name.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryOffset, 16);

    const archivePath = path.join(workspace, "external.zip");
    await fs.promises.writeFile(archivePath, Buffer.concat([local, name, content, central, name, end]));

    const archive = await ZipArchive.open(archivePath);
    try {
      assert.strictEqual(archive.entries.length, 1);
      assert.strictEqual(archive.entries[0].path, "hello.txt");
      assert.deepStrictEqual(await archive.read(archive.entries[0]), content);
    } finally {
      await archive.close();
    }
  });

  test("marks directory entries and normalizes separators", async () => {
    const sourcePath = path.join(workspace, "file.txt");
    await fs.promises.writeFile(sourcePath, "x");
    const archivePath = path.join(workspace, "dirs.zip");
    await createZipFile(archivePath, [
      { archivePath: "starter/" },
      { archivePath: "starter\\windows\\style.txt", sourcePath },
      { archivePath: "/leading/slash.txt", sourcePath },
    ]);

    const archive = await ZipArchive.open(archivePath);
    try {
      const byPath = new Map(archive.entries.map((entry) => [entry.path, entry]));
      assert.strictEqual(byPath.get("starter/")?.isDirectory, true);
      assert.ok(byPath.has("starter/windows/style.txt"), "backslashes become forward slashes");
      assert.ok(byPath.has("leading/slash.txt"), "leading slashes are stripped");
    } finally {
      await archive.close();
    }
  });

  test("keeps a shebang script executable for the autograder", async () => {
    const sourcePath = path.join(workspace, "run.sh");
    await fs.promises.writeFile(sourcePath, "#!/bin/sh\necho hi\n", "utf8");
    if (process.platform !== "win32") {
      await fs.promises.chmod(sourcePath, 0o755);
    }
    const archivePath = path.join(workspace, "script.zip");
    await createZipFile(archivePath, [{ archivePath: "run.sh", sourcePath }]);

    const archive = await ZipArchive.open(archivePath);
    try {
      assert.strictEqual((archive.entries[0].unixMode ?? 0) & 0o111, 0o111);
    } finally {
      await archive.close();
    }
  });

  test("rejects corrupted payloads instead of writing bad files into a lab", async () => {
    const sourcePath = path.join(workspace, "notes.txt");
    await fs.promises.writeFile(sourcePath, "the quick brown fox ".repeat(100), "utf8");
    const archivePath = path.join(workspace, "corrupt.zip");
    await createZipFile(archivePath, [{ archivePath: "notes.txt", sourcePath }]);

    const raw = await fs.promises.readFile(archivePath);
    raw[40] = raw[40] ^ 0xff;
    await fs.promises.writeFile(archivePath, raw);

    const archive = await ZipArchive.open(archivePath);
    try {
      await assert.rejects(() => archive.read(archive.entries[0]));
    } finally {
      await archive.close();
    }
  });

  test("bounds actual inflated output even when an entry lies about its size", async () => {
    const sourcePath = path.join(workspace, "bomb.txt");
    await fs.promises.writeFile(sourcePath, "highly compressible ".repeat(10_000), "utf8");
    const archivePath = path.join(workspace, "lying-size.zip");
    await createZipFile(archivePath, [{ archivePath: "bomb.txt", sourcePath }]);

    const raw = await fs.promises.readFile(archivePath);
    const endOffset = raw.length - 22;
    const directoryOffset = raw.readUInt32LE(endOffset + 16);
    raw.writeUInt32LE(1, 22);
    raw.writeUInt32LE(1, directoryOffset + 24);
    await fs.promises.writeFile(archivePath, raw);

    const archive = await ZipArchive.open(archivePath);
    try {
      await assert.rejects(() => archive.read(archive.entries[0]), /decompressed safely|allowed size/);
    } finally {
      await archive.close();
    }
  });

  test("rejects an impossible central-directory size before allocating it", async () => {
    const sourcePath = path.join(workspace, "small.txt");
    await fs.promises.writeFile(sourcePath, "small", "utf8");
    const archivePath = path.join(workspace, "huge-directory.zip");
    await createZipFile(archivePath, [{ archivePath: "small.txt", sourcePath }]);

    const raw = await fs.promises.readFile(archivePath);
    raw.writeUInt32LE(0xffff_fffe, raw.length - 22 + 12);
    await fs.promises.writeFile(archivePath, raw);
    await assert.rejects(() => ZipArchive.open(archivePath), /central directory/);
  });

  test("refuses a file that is not a ZIP archive", async () => {
    const archivePath = path.join(workspace, "not-a-zip.bin");
    await fs.promises.writeFile(archivePath, Buffer.alloc(2048, 7));
    await assert.rejects(() => ZipArchive.open(archivePath), ZipFormatError);
  });

  test("matches known CRC-32 values", () => {
    assert.strictEqual(crc32(Buffer.from("", "utf8")), 0x00000000);
    assert.strictEqual(crc32(Buffer.from("123456789", "utf8")), 0xcbf43926);
    assert.strictEqual(crc32(Buffer.from("The quick brown fox jumps over the lazy dog", "utf8")), 0x414fa339);
  });
});
