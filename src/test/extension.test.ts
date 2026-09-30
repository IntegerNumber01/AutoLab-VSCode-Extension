import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AutolabSubmission } from "../types";
import {
  assertNoSymbolicLinkPath,
  formatBytes,
  isPathInside,
  isSafeArchivePath,
  normalizeHost,
  parseAutograderFeedback,
  parseContentDisposition,
  safePathSegment,
  submissionScore,
} from "../utils";

suite("Autolab core safety and formatting", () => {
  test("normalizes HTTPS hosts and preserves an installation path", () => {
    assert.strictEqual(normalizeHost(" https://example.edu/autolab/ "), "https://example.edu/autolab");
  });

  test("rejects insecure and credential-bearing server URLs", () => {
    assert.throws(() => normalizeHost("http://example.edu"), /HTTPS/);
    assert.throws(() => normalizeHost("https://student:password@example.edu"), /credentials/);
    assert.strictEqual(normalizeHost("http://localhost:3000", true), "http://localhost:3000");
  });

  test("creates filesystem-safe course and assessment names", () => {
    assert.strictEqual(safePathSegment("lab: one/intro?.zip"), "lab- one-intro-.zip");
    assert.strictEqual(safePathSegment("..."), "lab");
  });

  test("blocks archive traversal and absolute paths", () => {
    assert.strictEqual(isSafeArchivePath("starter/src/main.c"), true);
    assert.strictEqual(isSafeArchivePath("../outside.txt"), false);
    assert.strictEqual(isSafeArchivePath("starter/../../outside.txt"), false);
    assert.strictEqual(isSafeArchivePath("C:\\outside.txt"), false);
    assert.strictEqual(isSafeArchivePath("/outside.txt"), false);
  });

  test("detects whether a path stays within the lab", () => {
    const root = process.platform === "win32" ? "C:\\labs\\lab1" : "/labs/lab1";
    const inside = process.platform === "win32" ? "C:\\labs\\lab1\\src\\main.c" : "/labs/lab1/src/main.c";
    const outside = process.platform === "win32" ? "C:\\labs\\lab2\\secret" : "/labs/lab2/secret";
    assert.strictEqual(isPathInside(root, inside), true);
    assert.strictEqual(isPathInside(root, outside), false);
  });

  test("rejects writes through an existing directory symlink", async function () {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autolab-symlink-test-"));
    const lab = path.join(workspace, "lab");
    const outside = path.join(workspace, "outside");
    const link = path.join(lab, "redirect");
    await Promise.all([fs.promises.mkdir(lab), fs.promises.mkdir(outside)]);
    try {
      try {
        await fs.promises.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          this.skip();
          return;
        }
        throw error;
      }
      await assert.rejects(
        assertNoSymbolicLinkPath(lab, path.join(link, "escaped.txt")),
        /symbolic link/,
      );
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true });
    }
  });

  test("parses regular and RFC 5987 download filenames", () => {
    assert.strictEqual(parseContentDisposition('inline; filename="handout.zip"'), "handout.zip");
    assert.strictEqual(parseContentDisposition("attachment; filename*=UTF-8''lab%20one.tar.gz"), "lab one.tar.gz");
  });

  test("sums released problem scores and tracks unreleased scores", () => {
    const submission: AutolabSubmission = {
      version: 2,
      filename: "submission.zip",
      created_at: "2026-08-27T12:00:00Z",
      scores: { correctness: 7.5, style: 2, hidden: "unreleased" },
    };
    assert.deepStrictEqual(submissionScore(submission), {
      earned: 9.5,
      hasNumericScore: true,
      hasUnreleasedScore: true,
    });
  });

  test("pulls the autograder summary out of the trailing JSON line", () => {
    const feedback = [
      "make: entering directory /home/autolab",
      "Running 12 tests...",
      '{"scores": {"Correctness": 45, "Style": 5}, "_presentation": "semantic"}',
    ].join("\n");
    assert.deepStrictEqual(parseAutograderFeedback(feedback)?.scores, { Correctness: 45, Style: 5 });
  });

  test("ignores autograder output that carries no JSON summary", () => {
    assert.strictEqual(parseAutograderFeedback("Segmentation fault (core dumped)"), undefined);
    assert.strictEqual(parseAutograderFeedback('{"not_scores": 1}'), undefined);
    assert.strictEqual(parseAutograderFeedback("{ this is not json }"), undefined);
    assert.strictEqual(parseAutograderFeedback(""), undefined);
  });

  test("prefers the last JSON summary when a build prints several objects", () => {
    const feedback = [
      '{"scores": {"Correctness": 0}}',
      "retrying after a flaky test...",
      '{"scores": {"Correctness": 50}}',
      "done",
    ].join("\r\n");
    assert.deepStrictEqual(parseAutograderFeedback(feedback)?.scores, { Correctness: 50 });
  });

  test("formats package sizes for the submission confirmation", () => {
    assert.strictEqual(formatBytes(512), "512 B");
    assert.strictEqual(formatBytes(2_048), "2.0 KB");
    assert.strictEqual(formatBytes(5_242_880), "5.0 MB");
  });
});
