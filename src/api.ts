import * as fs from "fs";
import type {
  AttachmentResponse,
  AutolabAssessment,
  AutolabAssessmentDetails,
  AutolabCourse,
  AutolabProblem,
  AutolabSubmission,
  AutolabUser,
  SubmitResult,
} from "./types";
import { errorMessage, joinHostPath, parseContentDisposition } from "./utils";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_JSON_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const MAX_ATTACHMENT_RESPONSE_BYTES = 128 * 1_024 * 1_024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1_024;
const MAX_RESPONSE_CHUNKS = 65_536;
const MAX_API_COLLECTION_ITEMS = 20_000;

export class AutolabApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AutolabApiError";
  }
}

/**
 * True when Autolab refused the request for lack of an OAuth scope. Doorkeeper answers
 * `403 insufficient_scope`, and Autolab's own `require_privilege` also raises `:forbidden`,
 * so both mean "this application was registered without the scope this endpoint needs".
 */
export function isForbidden(error: unknown): boolean {
  return error instanceof AutolabApiError && (error.status === 403 || error.code === "insufficient_scope");
}

type TokenProvider = (forceRefresh?: boolean) => Promise<string>;

export class AutolabApi {
  constructor(
    private readonly host: string,
    private readonly tokenProvider: TokenProvider,
  ) {}

  async getUser(): Promise<AutolabUser> {
    return parseUser(await this.getJson("/api/v1/user"));
  }

  async getCourses(): Promise<AutolabCourse[]> {
    return expectArray(await this.getJson("/api/v1/courses"), "courses").map(parseCourse);
  }

  async getAssessments(course: string): Promise<AutolabAssessment[]> {
    return expectArray(await this.getJson(this.apiPath("courses", course, "assessments")), "assessments")
      .map(parseAssessment);
  }

  async getAssessment(course: string, assessment: string): Promise<AutolabAssessmentDetails> {
    return parseAssessmentDetails(await this.getJson(this.apiPath("courses", course, "assessments", assessment)));
  }

  async getProblems(course: string, assessment: string): Promise<AutolabProblem[]> {
    return expectArray(
      await this.getJson(this.apiPath("courses", course, "assessments", assessment, "problems")),
      "problems",
    ).map(parseProblem);
  }

  async getSubmissions(course: string, assessment: string): Promise<AutolabSubmission[]> {
    const submissions = expectArray(
      await this.getJson(this.apiPath("courses", course, "assessments", assessment, "submissions")),
      "submissions",
    ).map(parseSubmission);
    // Every caller treats index 0 as the latest attempt, so do not rely on the server's ordering.
    return [...submissions].sort((left, right) => right.version - left.version);
  }

  async getFeedback(course: string, assessment: string, version: number, problem: string): Promise<string> {
    const endpoint = this.apiPath("courses", course, "assessments", assessment, "submissions", String(version), "feedback");
    const result = expectRecord(await this.getJson(`${endpoint}?problem=${encodeURIComponent(problem)}`), "feedback");
    return expectString(result.feedback, "feedback.feedback");
  }

  async downloadHandout(course: string, assessment: string): Promise<AttachmentResponse> {
    return this.downloadAttachment(this.apiPath("courses", course, "assessments", assessment, "handout"), "handout");
  }

  async downloadWriteup(course: string, assessment: string): Promise<AttachmentResponse> {
    return this.downloadAttachment(this.apiPath("courses", course, "assessments", assessment, "writeup"), "writeup");
  }

  async submit(course: string, assessment: string, filename: string): Promise<SubmitResult> {
    const form = new FormData();
    form.append("submission[file]", await readAsBlob(filename), this.basename(filename));
    const result = await this.requestJson(this.apiPath("courses", course, "assessments", assessment, "submit"), {
      method: "POST",
      body: form,
    }, 120_000);
    const value = expectRecord(result, "submission result");
    return {
      version: expectSafeInteger(value.version, "submission result.version"),
      filename: expectString(value.filename, "submission result.filename"),
    };
  }

  private async getJson(endpoint: string): Promise<unknown> {
    return this.requestJson(endpoint, { method: "GET" });
  }

  private async requestJson(endpoint: string, init: RequestInit, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const { response, data } = await this.request(endpoint, init, true, timeoutMs, MAX_JSON_RESPONSE_BYTES);
    if (!data.length) {
      throw new AutolabApiError("Autolab returned an empty response.", response.status);
    }
    try {
      return parseBufferedJson(data);
    } catch {
      throw new AutolabApiError("Autolab returned an unexpected response.", response.status);
    }
  }

  private async downloadAttachment(endpoint: string, fallbackName: string): Promise<AttachmentResponse> {
    // Handouts are whole starter projects, so they get the same generous budget as an upload.
    const { response, data } = await this.request(
      endpoint,
      { method: "GET" },
      true,
      120_000,
      MAX_ATTACHMENT_RESPONSE_BYTES,
    );
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (contentType.toLowerCase().includes("json")) {
      const value = expectRecord(parseBufferedJson(data), "attachment");
      return typeof value.url === "string" ? { kind: "url", url: value.url } : { kind: "none" };
    }

    const filename = parseContentDisposition(response.headers.get("content-disposition"))
      ?? fallbackFilename(fallbackName, contentType);
    return {
      kind: "file",
      filename: this.basename(filename) || fallbackName,
      contentType,
      data,
    };
  }

  private async request(
    endpoint: string,
    init: RequestInit,
    retry = true,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxBytes = MAX_JSON_RESPONSE_BYTES,
  ): Promise<BufferedResponse> {
    const accessToken = await this.tokenProvider(false);
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json, application/octet-stream;q=0.9, */*;q=0.8");
    headers.set("Authorization", `Bearer ${accessToken}`);

    let result = await fetchBufferedResponse(joinHostPath(this.host, endpoint), { ...init, headers }, timeoutMs, maxBytes);
    if (result.response.status === 401 && retry) {
      const refreshedToken = await this.tokenProvider(true);
      headers.set("Authorization", `Bearer ${refreshedToken}`);
      result = await fetchBufferedResponse(joinHostPath(this.host, endpoint), { ...init, headers }, timeoutMs, maxBytes);
    }

    if (!result.response.ok) {
      throw responseErrorFromBytes(result.response, result.data);
    }
    return result;
  }

  private apiPath(...segments: string[]): string {
    return `/api/v1/${segments.map(encodeURIComponent).join("/")}`;
  }

  private basename(filename: string): string {
    return filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  }
}

/**
 * `fs.openAsBlob` streams the upload instead of buffering it, but it is still flagged
 * experimental, so fall back to a plain in-memory Blob wherever it is unavailable.
 */
async function readAsBlob(filename: string): Promise<Blob> {
  if (typeof fs.openAsBlob === "function") {
    try {
      return await fs.openAsBlob(filename);
    } catch {
      // Fall through to reading the file into memory.
    }
  }
  const data = await fs.promises.readFile(filename);
  return new Blob([data]);
}

function fallbackFilename(base: string, contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("zip")) {
    return `${base}.zip`;
  }
  if (normalized.includes("gzip")) {
    return `${base}.tar.gz`;
  }
  if (normalized.includes("tar")) {
    return `${base}.tar`;
  }
  if (normalized.includes("pdf")) {
    return `${base}.pdf`;
  }
  return base;
}

export function responseErrorFromBytes(response: Response, data: Uint8Array): AutolabApiError {
  let message = `Autolab request failed (${response.status} ${response.statusText}).`;
  let code: string | undefined;
  try {
    const parsed = parseBufferedJson(data);
    const body = expectRecord(parsed, "error response");
    code = typeof body.error === "string" ? body.error : undefined;
    message = typeof body.error_description === "string" ? body.error_description : code || message;
  } catch {
    // Keep the HTTP status message when the response is not JSON.
  }
  return new AutolabApiError(message, response.status, code);
}

export interface BufferedResponse {
  response: Response;
  data: Uint8Array;
}

/** Fetches and consumes a response under one deadline and a decoded-body byte limit. */
export async function fetchBufferedResponse(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<BufferedResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    const limit = response.ok ? maxBytes : Math.min(maxBytes, MAX_ERROR_RESPONSE_BYTES);
    return { response, data: await readResponseBytes(response, limit) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Autolab did not respond within ${Math.max(1, Math.round(timeoutMs / 1_000))} seconds.`);
    }
    if (error instanceof AutolabApiError) {
      throw error;
    }
    throw new Error(`Could not reach Autolab: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseBufferedJson(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as unknown;
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("The Autolab response-size limit is invalid.");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new AutolabApiError(`Autolab returned more than ${formatLimit(maxBytes)}.`, response.status);
  }
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AutolabApiError(`Autolab returned more than ${formatLimit(maxBytes)}.`, response.status);
      }
      chunks.push(value);
      if (chunks.length > MAX_RESPONSE_CHUNKS) {
        await reader.cancel();
        throw new AutolabApiError("Autolab returned an excessively fragmented response.", response.status);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function formatLimit(bytes: number): string {
  return bytes < 1_048_576 ? `${bytes} bytes` : `${Math.ceil(bytes / 1_048_576)} MB`;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Autolab returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Autolab returned invalid ${label}.`);
  }
  if (value.length > MAX_API_COLLECTION_ITEMS) {
    throw new Error(`Autolab returned too many ${label}.`);
  }
  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Autolab returned an invalid ${label}.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null | undefined {
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  throw new Error(`Autolab returned an invalid ${label}.`);
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Autolab returned an invalid ${label}.`);
  }
  return value;
}

function expectSafeInteger(value: unknown, label: string): number {
  const number = expectNumber(value, label);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Autolab returned an invalid ${label}.`);
  }
  return number;
}

function optionalNumber(value: unknown, label: string): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return expectNumber(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  throw new Error(`Autolab returned an invalid ${label}.`);
}

function parseUser(value: unknown): AutolabUser {
  const item = expectRecord(value, "user");
  return {
    first_name: expectString(item.first_name, "user.first_name"),
    last_name: expectString(item.last_name, "user.last_name"),
    email: expectString(item.email, "user.email"),
    school: optionalString(item.school, "user.school"),
    major: optionalString(item.major, "user.major"),
    year: optionalString(item.year, "user.year"),
  };
}

function parseCourse(value: unknown): AutolabCourse {
  const item = expectRecord(value, "course");
  return {
    name: expectString(item.name, "course.name"),
    display_name: expectString(item.display_name, "course.display_name"),
    semester: expectString(item.semester, "course.semester"),
    late_slack: expectNumber(item.late_slack, "course.late_slack"),
    grace_days: expectNumber(item.grace_days, "course.grace_days"),
    auth_level: expectString(item.auth_level, "course.auth_level"),
  };
}

function parseAssessment(value: unknown): AutolabAssessment {
  const item = expectRecord(value, "assessment");
  return {
    name: expectString(item.name, "assessment.name"),
    display_name: expectString(item.display_name, "assessment.display_name"),
    start_at: optionalString(item.start_at, "assessment.start_at") ?? null,
    due_at: optionalString(item.due_at, "assessment.due_at") ?? null,
    end_at: optionalString(item.end_at, "assessment.end_at") ?? null,
    category_name: optionalString(item.category_name, "assessment.category_name"),
  };
}

function parseAssessmentDetails(value: unknown): AutolabAssessmentDetails {
  const item = expectRecord(value, "assessment details");
  const base = parseAssessment(item);
  const maxScoresRecord = item.max_scores === undefined || item.max_scores === null
    ? undefined
    : expectRecord(item.max_scores, "assessment.max_scores");
  if (maxScoresRecord && Object.keys(maxScoresRecord).length > MAX_API_COLLECTION_ITEMS) {
    throw new Error("Autolab returned too many assessment.max_scores entries.");
  }
  const maxScores = maxScoresRecord === undefined
    ? undefined
    : Object.fromEntries(Object.entries(maxScoresRecord).map(
      ([name, score]) => [name, expectNumber(score, `assessment.max_scores.${name}`)],
    ));
  const handoutFormat = optionalFormat(item.handout_format, "assessment.handout_format");
  const writeupFormat = optionalFormat(item.writeup_format, "assessment.writeup_format");
  return {
    ...base,
    description: optionalString(item.description, "assessment.description"),
    updated_at: optionalString(item.updated_at, "assessment.updated_at"),
    max_grace_days: optionalNumber(item.max_grace_days, "assessment.max_grace_days"),
    max_submissions: optionalNumber(item.max_submissions, "assessment.max_submissions"),
    disable_handins: optionalBoolean(item.disable_handins, "assessment.disable_handins"),
    group_size: optionalNumber(item.group_size, "assessment.group_size"),
    writeup_format: writeupFormat,
    handout_format: handoutFormat,
    has_scoreboard: optionalBoolean(item.has_scoreboard, "assessment.has_scoreboard"),
    has_autograder: optionalBoolean(item.has_autograder, "assessment.has_autograder"),
    max_unpenalized_submissions: optionalNumber(
      item.max_unpenalized_submissions,
      "assessment.max_unpenalized_submissions",
    ),
    max_total_score: optionalNumber(item.max_total_score, "assessment.max_total_score"),
    max_scores: maxScores,
  };
}

function optionalFormat(value: unknown, label: string): "file" | "url" | "none" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "file" || value === "url" || value === "none") {
    return value;
  }
  throw new Error(`Autolab returned an invalid ${label}.`);
}

function parseProblem(value: unknown): AutolabProblem {
  const item = expectRecord(value, "problem");
  return {
    name: expectString(item.name, "problem.name"),
    description: optionalString(item.description, "problem.description"),
    max_score: expectNumber(item.max_score, "problem.max_score"),
    optional: optionalBoolean(item.optional, "problem.optional"),
    starred: optionalBoolean(item.starred, "problem.starred"),
  };
}

function parseSubmission(value: unknown): AutolabSubmission {
  const item = expectRecord(value, "submission");
  const rawScores = expectRecord(item.scores, "submission.scores");
  if (Object.keys(rawScores).length > MAX_API_COLLECTION_ITEMS) {
    throw new Error("Autolab returned too many submission.scores entries.");
  }
  const scores = Object.fromEntries(Object.entries(rawScores).map(([name, score]) => {
    if (score !== null && typeof score !== "string" && (typeof score !== "number" || !Number.isFinite(score))) {
      throw new Error(`Autolab returned an invalid submission.scores.${name}.`);
    }
    return [name, score];
  }));
  return {
    version: expectSafeInteger(item.version, "submission.version"),
    filename: expectString(item.filename, "submission.filename"),
    created_at: expectString(item.created_at, "submission.created_at"),
    scores,
  };
}
