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

type TokenProvider = (forceRefresh?: boolean) => Promise<string>;

export class AutolabApi {
  constructor(
    private readonly host: string,
    private readonly tokenProvider: TokenProvider,
  ) {}

  async getUser(): Promise<AutolabUser> {
    return this.getJson<AutolabUser>("/api/v1/user");
  }

  async getCourses(): Promise<AutolabCourse[]> {
    return this.getJson<AutolabCourse[]>("/api/v1/courses");
  }

  async getAssessments(course: string): Promise<AutolabAssessment[]> {
    return this.getJson<AutolabAssessment[]>(this.apiPath("courses", course, "assessments"));
  }

  async getAssessment(course: string, assessment: string): Promise<AutolabAssessmentDetails> {
    return this.getJson<AutolabAssessmentDetails>(this.apiPath("courses", course, "assessments", assessment));
  }

  async getProblems(course: string, assessment: string): Promise<AutolabProblem[]> {
    return this.getJson<AutolabProblem[]>(this.apiPath("courses", course, "assessments", assessment, "problems"));
  }

  async getSubmissions(course: string, assessment: string): Promise<AutolabSubmission[]> {
    const submissions = await this.getJson<AutolabSubmission[]>(
      this.apiPath("courses", course, "assessments", assessment, "submissions"),
    );
    // Every caller treats index 0 as the latest attempt, so do not rely on the server's ordering.
    return [...submissions].sort((left, right) => right.version - left.version);
  }

  async getFeedback(course: string, assessment: string, version: number, problem: string): Promise<string> {
    const endpoint = this.apiPath("courses", course, "assessments", assessment, "submissions", String(version), "feedback");
    const result = await this.getJson<{ feedback: string }>(`${endpoint}?problem=${encodeURIComponent(problem)}`);
    return result.feedback;
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
    return this.requestJson<SubmitResult>(this.apiPath("courses", course, "assessments", assessment, "submit"), {
      method: "POST",
      body: form,
    }, 120_000);
  }

  private async getJson<T>(endpoint: string): Promise<T> {
    return this.requestJson<T>(endpoint, { method: "GET" });
  }

  private async requestJson<T>(endpoint: string, init: RequestInit, timeoutMs = 30_000): Promise<T> {
    const response = await this.request(endpoint, init, true, timeoutMs);
    const text = await response.text();
    if (!text) {
      throw new AutolabApiError("Autolab returned an empty response.", response.status);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AutolabApiError("Autolab returned an unexpected response.", response.status);
    }
  }

  private async downloadAttachment(endpoint: string, fallbackName: string): Promise<AttachmentResponse> {
    // Handouts are whole starter projects, so they get the same generous budget as an upload.
    const response = await this.request(endpoint, { method: "GET" }, true, 120_000);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (contentType.toLowerCase().includes("json")) {
      const value = await response.json() as { url?: string };
      return value.url ? { kind: "url", url: value.url } : { kind: "none" };
    }

    const filename = parseContentDisposition(response.headers.get("content-disposition"))
      ?? fallbackFilename(fallbackName, contentType);
    return {
      kind: "file",
      filename: this.basename(filename) || fallbackName,
      contentType,
      data: new Uint8Array(await response.arrayBuffer()),
    };
  }

  private async request(endpoint: string, init: RequestInit, retry = true, timeoutMs = 30_000): Promise<Response> {
    const accessToken = await this.tokenProvider(false);
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json, application/octet-stream;q=0.9, */*;q=0.8");
    headers.set("Authorization", `Bearer ${accessToken}`);

    let response = await this.fetchWithTimeout(joinHostPath(this.host, endpoint), { ...init, headers }, timeoutMs);
    if (response.status === 401 && retry) {
      const refreshedToken = await this.tokenProvider(true);
      headers.set("Authorization", `Bearer ${refreshedToken}`);
      response = await this.fetchWithTimeout(joinHostPath(this.host, endpoint), { ...init, headers }, timeoutMs);
    }

    if (!response.ok) {
      throw await responseError(response);
    }
    return response;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Autolab did not respond within ${Math.round(timeoutMs / 1_000)} seconds.`);
      }
      throw new Error(`Could not reach Autolab: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timeout);
    }
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

export async function responseError(response: Response): Promise<AutolabApiError> {
  let message = `Autolab request failed (${response.status} ${response.statusText}).`;
  let code: string | undefined;
  try {
    const body = await response.json() as { error?: string; error_description?: string };
    code = body.error;
    message = body.error_description || body.error || message;
  } catch {
    // Keep the HTTP status message when the response is not JSON.
  }
  return new AutolabApiError(message, response.status, code);
}
