import * as fs from "fs";
import * as path from "path";
import fg = require("fast-glob");
import { isPathInside } from "./utils";

export interface FeedbackLocation {
  file: string;
  line: number;
  column: number;
  start: number;
  end: number;
  message: string;
  severity?: "error" | "warning";
}

export interface ResolvedFeedbackLocation extends FeedbackLocation {
  localFile: string;
}

/** Common compiler, Python traceback, and JavaScript stack locations. Offsets refer to the raw log. */
export function parseFeedbackLocations(text: string): FeedbackLocation[] {
  const patterns = [
    /File "([^"\r\n]+)", line (\d+)/g,
    /((?:[A-Za-z]:)?[\w./\\@+ -]+\.[A-Za-z][\w+-]*):(\d+)(?::(\d+))?/g,
    /((?:[A-Za-z]:)?[\w./\\@+ -]+\.[A-Za-z][\w+-]*)\((\d+)(?:,(\d+))?\)/g,
  ];
  const locations: FeedbackLocation[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const line = Number(match[2]);
      const column = Number(match[3] ?? 1);
      if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) {
        continue;
      }
      const start = match.index!;
      const end = start + match[0].length;
      const remainder = text.slice(end, text.indexOf("\n", end) < 0 ? text.length : text.indexOf("\n", end)).trim();
      const diagnostic = /^:?\s*(?:fatal )?(error|warning)\b[^:]*:\s*(.*)/i.exec(remainder);
      locations.push({
        file: match[1].trim().replace(/^at\s+/, ""), line, column, start, end,
        message: diagnostic?.[2] || remainder || "Autograder source reference",
        severity: diagnostic ? diagnostic[1].toLowerCase() as "error" | "warning" : undefined,
      });
    }
  }
  return locations.sort((a, b) => a.start - b.start).filter((item, index, all) => index === 0 || item.start >= all[index - 1].end);
}

/** Match grader paths to a unique local suffix. Never guess between duplicate filenames. */
export function matchFeedbackFile(reported: string, files: string[]): string | undefined {
  const normalized = reported.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.split("/").includes("..")) {
    return undefined;
  }
  if (files.includes(normalized)) {
    return normalized;
  }
  const parts = normalized.split("/").filter(Boolean);
  for (let count = parts.length; count > 0; count--) {
    const suffix = parts.slice(-count).join("/");
    const matches = files.filter((file) => file === suffix || file.endsWith(`/${suffix}`));
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      return undefined;
    }
  }
  return undefined;
}

export async function resolveFeedbackLocations(directory: string, texts: string[]): Promise<ResolvedFeedbackLocation[][]> {
  const root = await fs.promises.realpath(directory);
  const files = await fg("**/*", {
    cwd: root, onlyFiles: true, followSymbolicLinks: false, dot: false,
    ignore: ["**/node_modules/**", "**/.venv/**", "**/__pycache__/**"],
  });
  return Promise.all(texts.map(async (text) => {
    const resolved: ResolvedFeedbackLocation[] = [];
    for (const location of parseFeedbackLocations(text)) {
      const match = matchFeedbackFile(location.file, files);
      if (!match) {
        continue;
      }
      try {
        const localFile = await fs.promises.realpath(path.join(root, match));
        if (isPathInside(root, localFile)) {
          resolved.push({ ...location, localFile });
        }
      } catch {
        // A file can disappear while a run is being loaded.
      }
    }
    return resolved;
  }));
}

export interface TestFailure {
  test: string;
  message: string;
  expected?: string;
  actual?: string;
  /** Offsets of the failure block in the raw log. */
  start: number;
  end: number;
}

export interface SourceTarget {
  localFile: string;
  line: number;
  column: number;
  /** Method name for a heuristic match; undefined when the log named the exact line. */
  symbol?: string;
}

export interface LocatedTestFailure extends TestFailure {
  target?: SourceTarget;
}

const FAILURE_HEADER = /^-{2,}[ \t]*Failure in test:?[ \t]*(.+?)[ \t]*-{2,}[ \t]*$/gim;
const BLOCK_END = /^(?:-{2,}\s*Failure in test|={3,}|[A-Za-z ]*Score:|\{"scores")/i;

/** Splits "---- Failure in test: name ----" blocks out of an autograder log. */
export function parseTestFailures(text: string): TestFailure[] {
  const failures: TestFailure[] = [];
  for (const match of text.matchAll(FAILURE_HEADER)) {
    const start = match.index!;
    const bodyStart = start + match[0].length;
    const lines: string[] = [];
    let end = bodyStart;
    let cursor = bodyStart;
    for (const line of text.slice(bodyStart).split("\n").slice(1)) {
      cursor += line.length + 1;
      if (BLOCK_END.test(line.trim())) { break; }
      if (line.trim()) { lines.push(line.trimEnd()); end = Math.min(cursor, text.length); }
      else if (lines.length) { break; }
    }
    const message = lines.join("\n").trim();
    const comparison = /expected:\s*<([\s\S]*?)>\s*but was:\s*<([\s\S]*?)>/i.exec(message);
    failures.push({
      test: match[1],
      message: comparison ? message.slice(0, comparison.index).trim() || message : message,
      expected: comparison?.[1],
      actual: comparison?.[2],
      start,
      end: Math.max(end, bodyStart),
    });
  }
  return failures;
}

/** Method names a failure most likely exercises: the message prefix first, then the test name. */
export function candidateSymbols(failure: TestFailure): string[] {
  const names: string[] = [];
  const prefix = /^([A-Za-z_]\w*)\s*(?:\(\))?\s*:/.exec(failure.message);
  if (prefix) { names.push(prefix[1]); }
  const fromTest = failure.test.replace(/^test_?/i, "");
  if (fromTest && fromTest !== failure.test) { names.push(fromTest[0].toLowerCase() + fromTest.slice(1)); }
  return [...new Set(names)];
}

const SOURCE_EXTENSIONS = ["java", "py", "c", "cc", "cpp", "h", "hpp", "js", "ts", "cs", "kt", "scala", "go", "rs"];
const NOT_A_TYPE = new Set(["return", "new", "else", "throw", "case", "await", "yield", "if", "while", "for", "switch", "catch", "assert"]);

/** Finds the declaration line of `name` in source text, or undefined. Calls and prototypes are ignored. */
export function findDeclaration(source: string, name: string): { line: number; column: number } | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const python = new RegExp(`^\\s*(?:async\\s+)?def\\s+(${escaped})\\s*\\(`, "i");
  const keyword = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function|fn|func)\\s+(${escaped})\\s*[(<]`, "i");
  const typed = new RegExp(`^(\\s*(?:[\\w$<>\\[\\],?.]+\\s+)+)(${escaped})\\s*\\(`, "i");
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    const simple = python.exec(text) ?? keyword.exec(text);
    if (simple) { return { line: index + 1, column: text.indexOf(simple[1]) + 1 }; }
    const match = typed.exec(text);
    if (!match || text.trimEnd().endsWith(";")) { continue; }
    const words = match[1].trim().split(/\s+/);
    if (words.some((word) => NOT_A_TYPE.has(word))) { continue; }
    return { line: index + 1, column: match[1].length + 1 };
  }
  return undefined;
}

function isTestFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return /(?:^|\/)tests?\//i.test(normalized)
    || /^[Tt]est(?:[_A-Z.]|s\.)/.test(base)
    || /(?:Test|Tests|Tester|Runner|_test|_tests)\.\w+$/.test(base);
}

/**
 * Pairs each failing test with a source location. An exact file:line from the failure's own
 * text wins; otherwise the declaration of the method the test names, in a non-test file.
 */
export async function locateTestFailures(
  directory: string | undefined,
  text: string,
  locations: ResolvedFeedbackLocation[],
): Promise<LocatedTestFailure[]> {
  const failures = parseTestFailures(text);
  if (!directory || !failures.length) { return failures; }
  const root = await fs.promises.realpath(directory);
  const files = (await fg(`**/*.{${SOURCE_EXTENSIONS.join(",")}}`, {
    cwd: root, onlyFiles: true, followSymbolicLinks: false, dot: false,
    ignore: ["**/node_modules/**", "**/.venv/**", "**/__pycache__/**"],
  })).filter((file) => !isTestFile(file)).sort();
  const contents = new Map<string, string | undefined>();
  const read = async (file: string): Promise<string | undefined> => {
    if (!contents.has(file)) {
      try {
        const real = await fs.promises.realpath(path.join(root, file));
        const stat = await fs.promises.stat(real);
        contents.set(file, isPathInside(root, real) && stat.size < 1_000_000 ? await fs.promises.readFile(real, "utf8") : undefined);
      } catch {
        contents.set(file, undefined);
      }
    }
    return contents.get(file);
  };

  return Promise.all(failures.map(async (failure): Promise<LocatedTestFailure> => {
    const exact = locations.find((location) => location.start >= failure.start && location.end <= failure.end && !isTestFile(path.relative(root, location.localFile)));
    if (exact) {
      return { ...failure, target: { localFile: exact.localFile, line: exact.line, column: exact.column } };
    }
    for (const symbol of candidateSymbols(failure)) {
      for (const file of files) {
        const source = await read(file);
        const found = source === undefined ? undefined : findDeclaration(source, symbol);
        if (found) {
          return { ...failure, target: { localFile: await fs.promises.realpath(path.join(root, file)), ...found, symbol } };
        }
      }
    }
    return failure;
  }));
}

/** Re-checks before opening that a target still lives inside the lab and is not a symlink escape. */
export async function verifyTarget(directory: string, localFile: string): Promise<boolean> {
  try {
    const root = await fs.promises.realpath(directory);
    return isPathInside(root, await fs.promises.realpath(localFile));
  } catch {
    return false;
  }
}
