import * as fs from "fs";
import * as zlib from "zlib";
import { promisify } from "util";

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const UTF8_FLAG = 0x0800;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const UNIX_VERSION_MADE_BY = (3 << 8) | 45;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1_024 * 1_024;
const MAX_ZIP_ENTRIES = 20_000;
const DEFAULT_MAX_ENTRY_BYTES = 268_435_456;

type Bytes = Buffer<ArrayBufferLike>;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

export interface ZipSourceEntry {
  /** Slash-separated path stored inside the archive. A trailing slash marks a directory. */
  archivePath: string;
  /** Absolute path of the file to read. Omitted for directory entries. */
  sourcePath?: string;
}

export interface CreateZipOptions {
  /** Deflate level, 0 (store only) through 9. */
  level?: number;
}

interface CentralRecord {
  name: Buffer;
  extra: Buffer;
  versionNeeded: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  dosTime: number;
  dosDate: number;
  externalAttributes: number;
  localHeaderOffset: number;
}

/**
 * Writes a ZIP archive with Node's own deflate implementation. Nothing here shells out to a
 * platform zip binary, so Windows, macOS, and Linux all produce the same archive for the same
 * inputs and the same file modes.
 */
export async function createZipFile(
  outputFile: string,
  entries: ZipSourceEntry[],
  options: CreateZipOptions = {},
): Promise<void> {
  const level = options.level ?? zlib.constants.Z_DEFAULT_COMPRESSION;
  const handle = await fs.promises.open(outputFile, "w");
  try {
    const records: CentralRecord[] = [];
    let offset = 0;

    for (const entry of entries) {
      const archivePath = normalizeArchivePath(entry.archivePath);
      if (!archivePath) {
        continue;
      }
      const isDirectory = archivePath.endsWith("/");
      const name = Buffer.from(archivePath, "utf8");
      if (name.length > MAX_UINT16) {
        throw new ZipFormatError(`The path is too long to store in a ZIP archive: ${archivePath}`);
      }

      let content: Bytes = Buffer.alloc(0);
      let unixMode = isDirectory ? 0o755 : 0o644;
      let modified = new Date();

      if (!isDirectory) {
        if (!entry.sourcePath) {
          throw new ZipFormatError(`No source file was given for the archive entry ${archivePath}.`);
        }
        const stats = await fs.promises.stat(entry.sourcePath);
        modified = stats.mtime;
        content = await fs.promises.readFile(entry.sourcePath);
        unixMode = permissionsFor(stats, content);
      }

      let method = METHOD_STORE;
      let payload: Bytes = content;
      if (!isDirectory && content.length > 0 && level !== 0) {
        const deflated = await deflateRaw(content, { level });
        if (deflated.length < content.length) {
          method = METHOD_DEFLATE;
          payload = deflated;
        }
      }

      const checksum = isDirectory ? 0 : crc32(content);
      const { dosTime, dosDate } = toDosDateTime(modified);
      const needsZip64 = content.length > MAX_UINT32 || payload.length > MAX_UINT32 || offset > MAX_UINT32;
      const versionNeeded = needsZip64 ? 45 : 20;
      const localExtra = needsZip64
        ? zip64ExtraField([BigInt(content.length), BigInt(payload.length)])
        : Buffer.alloc(0);

      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
      localHeader.writeUInt16LE(versionNeeded, 4);
      localHeader.writeUInt16LE(UTF8_FLAG, 6);
      localHeader.writeUInt16LE(method, 8);
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(checksum, 14);
      localHeader.writeUInt32LE(needsZip64 ? MAX_UINT32 : payload.length, 18);
      localHeader.writeUInt32LE(needsZip64 ? MAX_UINT32 : content.length, 22);
      localHeader.writeUInt16LE(name.length, 26);
      localHeader.writeUInt16LE(localExtra.length, 28);

      await writeAll(handle, [localHeader, name, localExtra, payload]);

      const zip64Values: bigint[] = [];
      if (content.length > MAX_UINT32) {
        zip64Values.push(BigInt(content.length));
      }
      if (payload.length > MAX_UINT32) {
        zip64Values.push(BigInt(payload.length));
      }
      if (offset > MAX_UINT32) {
        zip64Values.push(BigInt(offset));
      }

      records.push({
        name,
        extra: zip64Values.length ? zip64ExtraField(zip64Values) : Buffer.alloc(0),
        versionNeeded,
        method,
        crc: checksum,
        compressedSize: payload.length,
        size: content.length,
        dosTime,
        dosDate,
        externalAttributes: externalAttributesFor(unixMode, isDirectory),
        localHeaderOffset: offset,
      });

      offset += localHeader.length + name.length + localExtra.length + payload.length;
    }

    const centralDirectoryOffset = offset;
    for (const record of records) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
      header.writeUInt16LE(UNIX_VERSION_MADE_BY, 4);
      header.writeUInt16LE(record.versionNeeded, 6);
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(record.method, 10);
      header.writeUInt16LE(record.dosTime, 12);
      header.writeUInt16LE(record.dosDate, 14);
      header.writeUInt32LE(record.crc, 16);
      header.writeUInt32LE(Math.min(record.compressedSize, MAX_UINT32), 20);
      header.writeUInt32LE(Math.min(record.size, MAX_UINT32), 24);
      header.writeUInt16LE(record.name.length, 28);
      header.writeUInt16LE(record.extra.length, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(record.externalAttributes, 38);
      header.writeUInt32LE(Math.min(record.localHeaderOffset, MAX_UINT32), 42);

      await writeAll(handle, [header, record.name, record.extra]);
      offset += header.length + record.name.length + record.extra.length;
    }

    const centralDirectorySize = offset - centralDirectoryOffset;
    const needsZip64Directory = records.length > MAX_UINT16
      || centralDirectorySize > MAX_UINT32
      || centralDirectoryOffset > MAX_UINT32;

    if (needsZip64Directory) {
      const zip64Record = Buffer.alloc(56);
      zip64Record.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
      zip64Record.writeBigUInt64LE(44n, 4);
      zip64Record.writeUInt16LE(UNIX_VERSION_MADE_BY, 12);
      zip64Record.writeUInt16LE(45, 14);
      zip64Record.writeUInt32LE(0, 16);
      zip64Record.writeUInt32LE(0, 20);
      zip64Record.writeBigUInt64LE(BigInt(records.length), 24);
      zip64Record.writeBigUInt64LE(BigInt(records.length), 32);
      zip64Record.writeBigUInt64LE(BigInt(centralDirectorySize), 40);
      zip64Record.writeBigUInt64LE(BigInt(centralDirectoryOffset), 48);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(offset), 8);
      locator.writeUInt32LE(1, 16);

      await writeAll(handle, [zip64Record, locator]);
    }

    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(Math.min(records.length, MAX_UINT16), 8);
    endRecord.writeUInt16LE(Math.min(records.length, MAX_UINT16), 10);
    endRecord.writeUInt32LE(Math.min(centralDirectorySize, MAX_UINT32), 12);
    endRecord.writeUInt32LE(Math.min(centralDirectoryOffset, MAX_UINT32), 16);
    endRecord.writeUInt16LE(0, 20);
    await writeAll(handle, [endRecord]);
  } finally {
    await handle.close();
  }
}

export interface ZipEntry {
  /** Slash-separated path exactly as stored in the archive. */
  path: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  /** Uncompressed size in bytes. */
  size: number;
  compressedSize: number;
  /** Permission bits, or undefined when the archive carries no Unix metadata. */
  unixMode?: number;
  crc: number;
  method: number;
  modified: Date;
  localHeaderOffset: number;
}

/**
 * Reads a ZIP archive without loading it into memory. Entries are inflated one at a time, so a
 * large handout costs only as much memory as its single largest file.
 */
export class ZipArchive {
  private constructor(
    private readonly handle: fs.promises.FileHandle,
    private readonly fileSize: number,
    readonly entries: ZipEntry[],
  ) {}

  static async open(filename: string): Promise<ZipArchive> {
    const handle = await fs.promises.open(filename, "r");
    try {
      const { size } = await handle.stat();
      return new ZipArchive(handle, size, await readCentralDirectory(handle, size));
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(entry: ZipEntry, maxOutputBytes = DEFAULT_MAX_ENTRY_BYTES): Promise<Buffer> {
    if (entry.isDirectory) {
      return Buffer.alloc(0);
    }
    if (entry.size > maxOutputBytes) {
      throw new ZipFormatError(`The archive entry ${entry.path} exceeds the extraction limit.`);
    }
    if (entry.localHeaderOffset < 0 || entry.localHeaderOffset + 30 > this.fileSize) {
      throw new ZipFormatError(`The archive entry ${entry.path} points outside the ZIP file.`);
    }

    const localHeader = await readExactly(this.handle, entry.localHeaderOffset, 30);
    if (localHeader.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
      throw new ZipFormatError(`The archive entry ${entry.path} has a damaged local header.`);
    }
    const nameLength = localHeader.readUInt16LE(26);
    const extraLength = localHeader.readUInt16LE(28);
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (dataOffset > this.fileSize || entry.compressedSize > this.fileSize - dataOffset) {
      throw new ZipFormatError(`The archive entry ${entry.path} points outside the ZIP file.`);
    }
    const compressed = await readExactly(this.handle, dataOffset, entry.compressedSize);

    let content: Bytes;
    if (entry.method === METHOD_STORE) {
      content = compressed;
    } else if (entry.method === METHOD_DEFLATE) {
      try {
        content = await inflateRaw(compressed, {
          maxOutputLength: Math.max(1, Math.min(entry.size, maxOutputBytes)),
        });
      } catch (error) {
        throw new ZipFormatError(
          error instanceof RangeError
            ? `The archive entry ${entry.path} exceeds its declared or allowed size.`
            : `The archive entry ${entry.path} could not be decompressed safely.`,
        );
      }
    } else {
      throw new ZipFormatError(
        `The archive entry ${entry.path} uses unsupported compression method ${entry.method}.`,
      );
    }

    if (content.length !== entry.size) {
      throw new ZipFormatError(`The archive entry ${entry.path} has an unexpected size.`);
    }
    if (crc32(content) !== entry.crc) {
      throw new ZipFormatError(`The archive entry ${entry.path} failed its checksum.`);
    }
    return content;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

async function readCentralDirectory(handle: fs.promises.FileHandle, fileSize: number): Promise<ZipEntry[]> {
  const scanLength = Math.min(fileSize, MAX_UINT16 + 22);
  if (scanLength < 22) {
    throw new ZipFormatError("The file is too small to be a ZIP archive.");
  }
  const tail = await readExactly(handle, fileSize - scanLength, scanLength);

  let endOffset = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (
      tail.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY_SIGNATURE
      && index + 22 + tail.readUInt16LE(index + 20) === tail.length
    ) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0) {
    throw new ZipFormatError("The file is not a ZIP archive.");
  }

  let entryCount = tail.readUInt16LE(endOffset + 10);
  let directorySize = tail.readUInt32LE(endOffset + 12);
  let directoryOffset = tail.readUInt32LE(endOffset + 16);

  if (entryCount === MAX_UINT16 || directorySize === MAX_UINT32 || directoryOffset === MAX_UINT32) {
    const locatorOffset = endOffset - 20;
    if (locatorOffset < 0 || tail.readUInt32LE(locatorOffset) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new ZipFormatError("The ZIP archive is missing its ZIP64 locator.");
    }
    const zip64Offset = asSafeNumber(tail.readBigUInt64LE(locatorOffset + 8), "ZIP64 directory offset");
    if (zip64Offset > fileSize - 56) {
      throw new ZipFormatError("The ZIP64 directory record points outside the archive.");
    }
    const zip64Record = await readExactly(handle, zip64Offset, 56);
    if (zip64Record.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ZipFormatError("The ZIP archive has a damaged ZIP64 directory record.");
    }
    entryCount = asSafeNumber(zip64Record.readBigUInt64LE(32), "ZIP64 entry count");
    directorySize = asSafeNumber(zip64Record.readBigUInt64LE(40), "ZIP64 directory size");
    directoryOffset = asSafeNumber(zip64Record.readBigUInt64LE(48), "ZIP64 directory offset");
  }

  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new ZipFormatError(`The ZIP archive contains more than ${MAX_ZIP_ENTRIES.toLocaleString()} entries.`);
  }
  if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new ZipFormatError("The ZIP central directory exceeds the safety limit.");
  }
  if (directoryOffset > fileSize || directorySize > fileSize - directoryOffset) {
    throw new ZipFormatError("The ZIP central directory points outside the archive.");
  }

  const directory = await readExactly(handle, directoryOffset, directorySize);
  const entries: ZipEntry[] = [];
  let cursor = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipFormatError("The ZIP archive has a damaged central directory.");
    }
    const versionMadeBy = directory.readUInt16LE(cursor + 4);
    const method = directory.readUInt16LE(cursor + 10);
    const dosTime = directory.readUInt16LE(cursor + 12);
    const dosDate = directory.readUInt16LE(cursor + 14);
    const crc = directory.readUInt32LE(cursor + 16);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (recordLength > directory.length - cursor) {
      throw new ZipFormatError("The ZIP archive has a truncated central-directory entry.");
    }
    const externalAttributes = directory.readUInt32LE(cursor + 38);

    const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);

    let size = directory.readUInt32LE(cursor + 24);
    let compressedSize = directory.readUInt32LE(cursor + 20);
    let localHeaderOffset = directory.readUInt32LE(cursor + 42);
    const zip64 = readZip64ExtraField(extra, [
      size === MAX_UINT32,
      compressedSize === MAX_UINT32,
      localHeaderOffset === MAX_UINT32,
    ]);
    size = zip64[0] ?? size;
    compressedSize = zip64[1] ?? compressedSize;
    localHeaderOffset = zip64[2] ?? localHeaderOffset;

    const madeOnUnix = (versionMadeBy >> 8) === 3;
    const unixMode = madeOnUnix ? (externalAttributes >>> 16) & 0xffff : undefined;
    const isDirectory = name.endsWith("/")
      || Boolean(externalAttributes & DOS_DIRECTORY_ATTRIBUTE)
      || (unixMode !== undefined && (unixMode & 0xf000) === S_IFDIR);

    entries.push({
      path: name.replace(/\\/g, "/"),
      isDirectory,
      isSymbolicLink: unixMode !== undefined && (unixMode & 0xf000) === S_IFLNK,
      size,
      compressedSize,
      unixMode: unixMode === undefined ? undefined : unixMode & 0o7777,
      crc,
      method,
      modified: fromDosDateTime(dosDate, dosTime),
      localHeaderOffset,
    });

    cursor += recordLength;
  }

  if (cursor !== directory.length) {
    throw new ZipFormatError("The ZIP central directory contains unexpected trailing data.");
  }

  return entries;
}

function readZip64ExtraField(extra: Buffer, wanted: boolean[]): (number | undefined)[] {
  const result: (number | undefined)[] = wanted.map(() => undefined);
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    if (id !== ZIP64_EXTRA_FIELD_ID) {
      cursor += 4 + size;
      continue;
    }
    let valueCursor = cursor + 4;
    for (let index = 0; index < wanted.length; index += 1) {
      if (!wanted[index] || valueCursor + 8 > cursor + 4 + size) {
        continue;
      }
      result[index] = asSafeNumber(extra.readBigUInt64LE(valueCursor), "ZIP64 field");
      valueCursor += 8;
    }
    return result;
  }
  return result;
}

function zip64ExtraField(values: bigint[]): Buffer {
  const field = Buffer.alloc(4 + values.length * 8);
  field.writeUInt16LE(ZIP64_EXTRA_FIELD_ID, 0);
  field.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => field.writeBigUInt64LE(value, 4 + index * 8));
  return field;
}

/**
 * Windows reports no executable bit, so a shebang is the portable signal that a student's
 * script has to stay runnable for the autograder on the server.
 */
function permissionsFor(stats: fs.Stats, content: Buffer): number {
  if (process.platform !== "win32") {
    return (stats.mode & 0o7777) || 0o644;
  }
  return content.length >= 2 && content[0] === 0x23 && content[1] === 0x21 ? 0o755 : 0o644;
}

function externalAttributesFor(unixMode: number, isDirectory: boolean): number {
  const fileType = isDirectory ? S_IFDIR : S_IFREG;
  const dosAttributes = isDirectory ? DOS_DIRECTORY_ATTRIBUTE : 0;
  return ((fileType | (unixMode & 0o7777)) & 0xffff) * 0x10000 + dosAttributes;
}

function normalizeArchivePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

function toDosDateTime(value: Date): { dosTime: number; dosDate: number } {
  const date = Number.isNaN(value.valueOf()) ? new Date() : value;
  const year = Math.max(1980, date.getFullYear());
  return {
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function fromDosDateTime(dosDate: number, dosTime: number): Date {
  return new Date(
    1980 + ((dosDate >> 9) & 0x7f),
    Math.max(0, ((dosDate >> 5) & 0x0f) - 1),
    Math.max(1, dosDate & 0x1f),
    (dosTime >> 11) & 0x1f,
    (dosTime >> 5) & 0x3f,
    (dosTime & 0x1f) * 2,
  );
}

function asSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipFormatError(`${label} is larger than this extension can handle.`);
  }
  return Number(value);
}

async function readExactly(handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead === 0) {
      throw new ZipFormatError("The ZIP archive ended earlier than its directory claims.");
    }
    read += result.bytesRead;
  }
  return buffer;
}

async function writeAll(handle: fs.promises.FileHandle, chunks: Bytes[]): Promise<void> {
  for (const chunk of chunks) {
    if (chunk.length > 0) {
      await handle.write(chunk);
    }
  }
}
