import * as fs from "fs";
import * as path from "path";
import type { AutolabScore, AutolabSubmission } from "./types";

export function normalizeHost(input: string, allowInsecureHttp = false): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Enter your Autolab server URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a complete URL, such as https://autolab.example.edu.");
  }

  if (parsed.protocol !== "https:" && !(allowInsecureHttp && parsed.protocol === "http:")) {
    throw new Error("Autolab must use HTTPS. Enable insecure HTTP only for a trusted local development server.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("The Autolab URL must not contain credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("The Autolab URL must not contain a query string or fragment.");
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

export function joinHostPath(host: string, endpoint: string): string {
  return `${host}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

/**
 * Resolves a URL supplied by Autolab without allowing it to invoke a local/custom
 * protocol handler. OAuth destinations must stay on the configured origin; course
 * materials may use another HTTPS origin (for example, a university file host).
 */
export function resolveExternalUrl(host: string, value: string, sameOrigin = false): string {
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(host);
    resolved = new URL(value, `${host}/`);
  } catch {
    throw new Error("Autolab returned an invalid external URL.");
  }

  if (resolved.username || resolved.password) {
    throw new Error("Autolab returned an external URL containing credentials.");
  }
  const trustedLocalHttp = base.protocol === "http:"
    && resolved.protocol === "http:"
    && resolved.origin === base.origin;
  if (resolved.protocol !== "https:" && !trustedLocalHttp) {
    throw new Error(`Refusing to open an unsafe ${resolved.protocol || "unknown"} URL from Autolab.`);
  }
  if (sameOrigin && resolved.origin !== base.origin) {
    throw new Error(`Refusing to open an Autolab sign-in page on ${resolved.origin}.`);
  }
  return resolved.toString();
}

/** Path of an assessment's page on the Autolab website, which is not the API path. */
export function assessmentPath(course: string, assessment: string): string {
  return `/courses/${encodeURIComponent(course)}/assessments/${encodeURIComponent(assessment)}`;
}

export function safePathSegment(value: string): string {
  const safe = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/^\.+$/g, "");
  return safe || "lab";
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Rejects an existing symlink or junction anywhere along a path before a write. */
export async function assertNoSymbolicLinkPath(root: string, candidate: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isPathInside(resolvedRoot, resolvedCandidate)) {
    throw new Error(`Refusing to write outside ${resolvedRoot}.`);
  }

  const relative = path.relative(resolvedRoot, resolvedCandidate);
  const parts = relative ? relative.split(path.sep) : [];
  let current = resolvedRoot;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) {
      current = path.join(current, parts[index]);
    }
    try {
      if ((await fs.promises.lstat(current)).isSymbolicLink()) {
        throw new Error(`Refusing to write through the symbolic link ${current}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

export function isSafeArchivePath(entryPath: string): boolean {
  if (!entryPath || path.posix.isAbsolute(entryPath) || path.win32.isAbsolute(entryPath)) {
    return false;
  }
  const normalized = entryPath.replace(/\\/g, "/");
  if (normalized.length > 4_096 || normalized.includes("\0")) {
    return false;
  }
  const parts = normalized.split("/").filter((part, index, all) => part || index !== all.length - 1);
  return !parts.some((part) => (
    !part
    || part === "."
    || part === ".."
    || /[<>:"|?*\u0000-\u001f]/.test(part)
    || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  ));
}

export function parseContentDisposition(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }

  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return path.basename(decodeURIComponent(encoded.replace(/^"|"$/g, "")));
    } catch {
      // Fall through to the plain filename form.
    }
  }

  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(header);
  const filename = (plain?.[1] ?? plain?.[2])?.trim();
  return filename ? path.basename(filename.replace(/\\/g, "/")) : undefined;
}

export function numericScore(value: AutolabScore): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function submissionScore(submission: AutolabSubmission | undefined): {
  earned: number;
  hasNumericScore: boolean;
  hasUnreleasedScore: boolean;
} {
  let earned = 0;
  let hasNumericScore = false;
  let hasUnreleasedScore = false;

  for (const value of Object.values(submission?.scores ?? {})) {
    const numeric = numericScore(value);
    if (numeric !== undefined) {
      earned += numeric;
      hasNumericScore = true;
    } else if (value === "unreleased") {
      hasUnreleasedScore = true;
    }
  }

  return { earned, hasNumericScore, hasUnreleasedScore };
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_048_576) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function formatDate(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AutograderPayload {
  scores?: Record<string, unknown>;
  stages?: Record<string, unknown>;
  _presentation?: string;
}

/**
 * Autolab autograders end their output with a JSON line holding the machine-readable scores.
 * Surfacing it as a table saves students from reading past a wall of build output.
 */
export function parseAutograderFeedback(raw: string): AutograderPayload | undefined {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as AutograderPayload;
      if (parsed && typeof parsed === "object" && (parsed.scores || parsed.stages)) {
        return parsed;
      }
    } catch {
      // Not the JSON summary line; keep scanning upward.
    }
  }
  return undefined;
}
