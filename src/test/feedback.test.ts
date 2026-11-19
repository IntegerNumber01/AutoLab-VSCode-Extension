import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { candidateSymbols, findDeclaration, locateTestFailures, matchFeedbackFile, parseFeedbackLocations, parseTestFailures, resolveFeedbackLocations } from "../feedback";
import { resultsHtml } from "../panels";

suite("Feedback source mapping", () => {
  test("parses compiler errors and warnings with exact log offsets", () => {
    const text = "building…\nsrc/main.c:12:4: error: incompatible type\nsrc/util.c:9: warning: unused variable\n";
    const locations = parseFeedbackLocations(text);
    assert.strictEqual(locations.length, 2);
    assert.deepStrictEqual(locations.map(({ file, line, column, severity, message }) => ({ file, line, column, severity, message })), [
      { file: "src/main.c", line: 12, column: 4, severity: "error", message: "incompatible type" },
      { file: "src/util.c", line: 9, column: 1, severity: "warning", message: "unused variable" },
    ]);
    assert.strictEqual(text.slice(locations[0].start, locations[0].end), "src/main.c:12:4");
  });

  test("parses Python, JavaScript, and Windows compiler locations", () => {
    const text = '  File "/home/grader/solution.py", line 7, in solve\n    at solve (/work/src/main.js:42:9)\nC:\\labs\\main.cpp(8,3): warning C123: conversion\n';
    const locations = parseFeedbackLocations(text);
    assert.deepStrictEqual(locations.map(({ file, line, column }) => ({ file, line, column })), [
      { file: "/home/grader/solution.py", line: 7, column: 1 },
      { file: "/work/src/main.js", line: 42, column: 9 },
      { file: "C:\\labs\\main.cpp", line: 8, column: 3 },
    ]);
    assert.strictEqual(locations[0].severity, undefined);
    assert.strictEqual(locations[2].severity, "warning");
  });

  test("rejects invalid positions and leaves prose without source locations alone", () => {
    assert.deepStrictEqual(parseFeedbackLocations("main.c:0:4\nmain.c:4:0\nmain.c:999999999999999999999999\nFailed test: expected 42"), []);
  });

  test("maps remote prefixes and separators without guessing ambiguous basenames", () => {
    const files = ["src/main.c", "tests/main.c", "solution.py", "src/util.c"];
    assert.strictEqual(matchFeedbackFile("/home/grader/src/main.c", files), "src/main.c");
    assert.strictEqual(matchFeedbackFile("C:\\grader\\src\\util.c", files), "src/util.c");
    assert.strictEqual(matchFeedbackFile("/tmp/solution.py", files), "solution.py");
    assert.strictEqual(matchFeedbackFile("main.c", files), undefined);
    assert.strictEqual(matchFeedbackFile("../solution.py", files), undefined);
    assert.strictEqual(matchFeedbackFile("missing.c", files), undefined);
  });

  test("resolves existing lab files and excludes symlinked files", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autolab-feedback-"));
    try {
      const lab = path.join(root, "lab");
      await fs.promises.mkdir(path.join(lab, "src"), { recursive: true });
      await fs.promises.writeFile(path.join(lab, "src", "main.c"), "int main() {}\n");
      await fs.promises.writeFile(path.join(root, "outside.c"), "private\n");
      let linked = false;
      try {
        await fs.promises.symlink(path.join(root, "outside.c"), path.join(lab, "escape.c"));
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") { throw error; }
      }
      const [locations] = await resolveFeedbackLocations(lab, ["/grader/src/main.c:1:1: error: bad\nescape.c:1:1\nmissing.c:2:1"]);
      assert.strictEqual(locations.length, 1);
      assert.strictEqual(locations[0].localFile, await fs.promises.realpath(path.join(lab, "src", "main.c")));
      if (linked) { assert.ok(!locations.some((item) => item.file === "escape.c")); }
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test("renders verified source buttons, escapes log HTML, and deduplicates feedback", () => {
    const text = 'main.c:2:3: error: <script>alert(1)</script>';
    const location = { ...parseFeedbackLocations(text)[0], localFile: "/lab/main.c", id: 0 };
    const html = resultsHtml(
      { name: "lab", display_name: "Lab", start_at: null, due_at: null, end_at: null }, [],
      { version: 2, filename: "submission.zip", created_at: "2026-01-01", scores: {} }, [],
      [{ problem: "one", text, locations: [location] }, { problem: "two", text }],
    );
    assert.ok(html.includes('data-action="source" data-location="0"'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.strictEqual((html.match(/<pre class="feedback">/g) ?? []).length, 1);
    assert.ok(html.includes("current local files"));
  });
});

const KNIGHT_LOG = [
  "Autograder [Tue Nov 17 22:01:33 2026]: Here is the output from the autograder:",
  "---",
  "Running tests...",
  "Java Test Runner Version: 1.2",
  "",
  "---- Failure in test: testGetBestMove ----",
  "selectMoveLocation: best move not found expected:<(1, 4)> but was:<null>",
  "",
  "---- Failure in test: testUpdateAccess ----",
  "updateAccess: expected negative value @ (3,3)",
  "",
  "---- Failure in test: testTour ----",
  "Tour: expected 64 locations occupied expected:<64> but was:<0>",
  "",
  "Correctness Score: 0.0%",
  "",
  "======== Final Score ========",
  '{"scores": {"Correctness": 0.0}}',
].join("\n");

suite("Test failure feedback", () => {
  test("splits Java test runner failures and their expected/actual values", () => {
    const failures = parseTestFailures(KNIGHT_LOG);
    assert.deepStrictEqual(failures.map(({ test, message, expected, actual }) => ({ test, message, expected, actual })), [
      { test: "testGetBestMove", message: "selectMoveLocation: best move not found", expected: "(1, 4)", actual: "null" },
      { test: "testUpdateAccess", message: "updateAccess: expected negative value @ (3,3)", expected: undefined, actual: undefined },
      { test: "testTour", message: "Tour: expected 64 locations occupied", expected: "64", actual: "0" },
    ]);
    assert.ok(KNIGHT_LOG.slice(failures[0].start, failures[0].end).endsWith("but was:<null>"));
  });

  test("derives method names from the message prefix, then the test name", () => {
    const [bestMove] = parseTestFailures(KNIGHT_LOG);
    assert.deepStrictEqual(candidateSymbols(bestMove), ["selectMoveLocation", "getBestMove"]);
  });

  test("finds declarations and skips calls, prototypes, and returns", () => {
    const source = [
      "public class KnightCritter extends Critter {",
      "  abstract void updateAccess(int r);",
      "  public Location run() { return selectMoveLocation(list); }",
      "    selectMoveLocation(locs);",
      "  public Location selectMoveLocation(ArrayList<Location> locs) {",
      "  def solve(x):",
    ].join("\n");
    assert.deepStrictEqual(findDeclaration(source, "selectMoveLocation"), { line: 5, column: 19 });
    assert.strictEqual(findDeclaration(source, "updateAccess"), undefined);
    assert.deepStrictEqual(findDeclaration(source, "solve"), { line: 6, column: 7 });
  });

  test("points failures at student methods, never at test files", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autolab-tests-"));
    try {
      await fs.promises.writeFile(path.join(root, "KnightCritterTest.java"), "void testGetBestMove() {}\nvoid selectMoveLocation() {}\n");
      await fs.promises.writeFile(path.join(root, "KnightCritter.java"),
        "class KnightCritter {\n  private void updateAccess(Location loc) {\n  }\n  public Location selectMoveLocation(ArrayList<Location> locs) {\n  }\n}\n");
      const located = await locateTestFailures(root, KNIGHT_LOG, []);
      const real = await fs.promises.realpath(path.join(root, "KnightCritter.java"));
      assert.deepStrictEqual(located[0].target, { localFile: real, line: 4, column: 19, symbol: "selectMoveLocation" });
      assert.deepStrictEqual(located[1].target, { localFile: real, line: 2, column: 16, symbol: "updateAccess" });
      assert.strictEqual(located[2].target, undefined);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test("renders failing tests as a flat list with source links and the raw log collapsed", () => {
    const failures = parseTestFailures(KNIGHT_LOG).map((failure, index) => index === 0
      ? { ...failure, target: { localFile: "/lab/KnightCritter.java", line: 4, column: 19, symbol: "selectMoveLocation" }, targetId: 0 }
      : failure);
    const html = resultsHtml(
      { name: "lab", display_name: "Knight Critter Tour", start_at: null, due_at: null, end_at: null, max_total_score: 100 }, [],
      { version: 9, filename: "submission.zip", created_at: "2026-11-17", scores: { Correctness: 0 } }, [],
      [{ problem: "Correctness", text: KNIGHT_LOG, failures }],
    );
    assert.ok(html.includes("3 tests failing"));
    assert.ok(html.includes("selectMoveLocation() · KnightCritter.java:4"));
    assert.ok(html.includes('data-action="source" data-location="0"'));
    assert.ok(html.includes('<details class="raw"><summary>'));
    assert.ok(!html.includes("Refresh"));
  });
});
