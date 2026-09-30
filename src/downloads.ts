import * as fs from "fs";
import * as path from "path";
import * as tar from "tar";
import * as vscode from "vscode";
import type { AutolabApi } from "./api";
import { isForbidden } from "./api";
import { readSettings } from "./config";
import { localLabFor, METADATA_DIRECTORY, readLabMetadata, writeLabMetadata } from "./metadata";
import type {
  AttachmentResponse,
  AutolabAssessment,
  AutolabAssessmentDetails,
  AutolabCourse,
  LabArtifact,
  LabMetadata,
} from "./types";
import {
  assertNoSymbolicLinkPath,
  assessmentPath,
  isPathInside,
  isSafeArchivePath,
  joinHostPath,
  safePathSegment,
} from "./utils";
import { ZipArchive } from "./zip";

const MAX_EXTRACTED_BYTES = 1_073_741_824;

export interface DownloadResult {
  directory: string;
  externalUrls: string[];
  alreadyExisted: boolean;
}

export class LabDownloader {
  constructor(private readonly api: AutolabApi) {}

  async download(
    course: AutolabCourse,
    assessment: AutolabAssessment,
    details?: AutolabAssessmentDetails,
  ): Promise<DownloadResult | undefined> {
    const settings = readSettings();
    if (!settings.workspaceFolder) {
      throw new Error("Choose an Autolab workspace folder before downloading a lab.");
    }

    await fs.promises.mkdir(settings.workspaceFolder, { recursive: true });
    const workspaceRoot = await fs.promises.realpath(settings.workspaceFolder);
    const directory = path.join(
      workspaceRoot,
      safePathSegment(course.name),
      safePathSegment(assessment.name),
    );
    await assertNoSymbolicLinkPath(workspaceRoot, directory);
    const storedMetadata = await readLabMetadata(directory);
    if (storedMetadata && (
      storedMetadata.host !== settings.host
      || storedMetadata.course !== course.name
      || storedMetadata.assessment !== assessment.name
    )) {
      throw new Error(
        `The target folder already belongs to ${storedMetadata.host} / ${storedMetadata.course} / ${storedMetadata.assessment}. Choose a different Autolab workspace folder so labs from different servers cannot be mixed.`,
      );
    }
    const existingMetadata = storedMetadata;
    if (existingMetadata) {
      const choice = await vscode.window.showInformationMessage(
        `${assessment.display_name} is already downloaded. Existing work will never be overwritten.`,
        "Open Lab",
        "Download Missing Files",
      );
      if (choice === "Open Lab") {
        return { directory, externalUrls: [], alreadyExisted: true };
      }
      if (choice !== "Download Missing Files") {
        return undefined;
      }
    } else if (await pathExists(directory)) {
      const choice = await vscode.window.showWarningMessage(
        `The folder ${directory} already exists but is not an Autolab lab. Missing handout files can be added without overwriting anything.`,
        { modal: true },
        "Use Folder Safely",
      );
      if (choice !== "Use Folder Safely") {
        return undefined;
      }
    }

    await createDirectorySafely(workspaceRoot, directory);
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${assessment.display_name}`, cancellable: false },
      async (progress) => {
        progress.report({ message: "Fetching handout and writeup…" });
        const [handout, writeup] = await Promise.all([
          this.fetchAttachment("handout", course.name, assessment.name, settings.host, details),
          this.fetchAttachment("writeup", course.name, assessment.name, settings.host, details),
        ]);

        const externalUrls: string[] = [];
        const artifacts: LabArtifact[] = [];
        progress.report({ message: "Saving lab files…" });
        artifacts.push(await this.saveAttachment(directory, "handout", handout, settings.host, externalUrls));
        artifacts.push(await this.saveAttachment(directory, "writeup", writeup, settings.host, externalUrls));

        const metadata: LabMetadata = {
          version: 1,
          host: settings.host,
          course: course.name,
          courseDisplayName: course.display_name,
          assessment: assessment.name,
          assessmentDisplayName: assessment.display_name,
          downloadedAt: new Date().toISOString(),
          artifacts: mergeArtifacts(existingMetadata?.artifacts ?? [], artifacts),
        };
        await writeLabMetadata(directory, metadata);
        return { directory, externalUrls, alreadyExisted: Boolean(existingMetadata) };
      },
    );
  }

  async open(course: string, assessment: string): Promise<boolean> {
    const lab = await localLabFor(course, assessment);
    if (!lab) {
      return false;
    }
    await openLabWindow(lab.directory);
    return true;
  }

  /**
   * Handout and writeup downloads sit behind the `user_courses` scope. When the OAuth
   * application does not have it, fall back to the Autolab web page for the file: the
   * student's browser session can still fetch it, so the lab is only one click away
   * instead of unavailable.
   */
  private async fetchAttachment(
    kind: "handout" | "writeup",
    course: string,
    assessment: string,
    host: string,
    details?: AutolabAssessmentDetails,
  ): Promise<AttachmentResponse> {
    try {
      return kind === "handout"
        ? await this.api.downloadHandout(course, assessment)
        : await this.api.downloadWriteup(course, assessment);
    } catch (error) {
      if (!isForbidden(error)) {
        throw error;
      }
      const format = kind === "handout" ? details?.handout_format : details?.writeup_format;
      if (format === "none") {
        return { kind: "none" };
      }
      return { kind: "url", url: joinHostPath(host, `${assessmentPath(course, assessment)}/${kind}`) };
    }
  }

  private async saveAttachment(
    directory: string,
    kind: "handout" | "writeup",
    attachment: AttachmentResponse,
    host: string,
    externalUrls: string[],
  ): Promise<LabArtifact> {
    if (attachment.kind === "none") {
      return { kind, format: "none" };
    }
    if (attachment.kind === "url") {
      const url = resolveAttachmentUrl(host, attachment.url);
      externalUrls.push(url);
      return { kind, format: "url", url };
    }

    const filename = safePathSegment(attachment.filename);
    if (isArchive(filename)) {
      const artifactDirectory = path.join(directory, METADATA_DIRECTORY, "artifacts");
      await createDirectorySafely(directory, artifactDirectory);
      const archivePath = path.join(artifactDirectory, filename);
      await assertNoSymbolicLinkPath(directory, archivePath);
      await fs.promises.writeFile(archivePath, attachment.data);
      const extracted = await extractArchiveSafely(archivePath, directory);
      return { kind, format: "file", filename, extracted };
    }

    await writeIfMissing(directory, path.join(directory, filename), attachment.data);
    return { kind, format: "file", filename, extracted: false };
  }
}

export async function openLabWindow(directory: string): Promise<void> {
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(directory), { forceNewWindow: true });
}

async function extractArchiveSafely(archivePath: string, destination: string): Promise<boolean> {
  await assertNoSymbolicLinkPath(destination, destination);
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    const archive = await ZipArchive.open(archivePath);
    try {
      const expandedBytes = archive.entries.reduce(
        (total, entry) => total + (entry.isDirectory ? 0 : entry.size),
        0,
      );
      if (expandedBytes > MAX_EXTRACTED_BYTES) {
        throw new Error("The handout archive expands beyond the 1 GB safety limit.");
      }

      for (const entry of archive.entries) {
        if (!isSafeArchivePath(entry.path)) {
          throw new Error(`The handout archive contains an unsafe path: ${entry.path}`);
        }
        const target = path.join(destination, ...entry.path.split("/"));
        if (!isPathInside(destination, target)) {
          throw new Error(`The handout archive tried to write outside the lab: ${entry.path}`);
        }
        if (entry.isDirectory) {
          await createDirectorySafely(destination, target);
          continue;
        }
        if (entry.isSymbolicLink) {
          continue;
        }
        if (await writeIfMissing(destination, target, await archive.read(entry))) {
          await applyExecutableBit(destination, target, entry.unixMode);
        }
      }
    } finally {
      await archive.close();
    }
    return true;
  }

  if (lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    let expandedBytes = 0;
    await tar.extract({
      cwd: destination,
      file: archivePath,
      keep: true,
      preservePaths: false,
      strict: true,
      filter: (entryPath, entry) => {
        const type = "type" in entry ? String(entry.type) : "";
        const safeTypes = new Set(["File", "OldFile", "ContiguousFile", "Directory", "GNUDumpDir"]);
        if (type !== "Directory" && type !== "GNUDumpDir") {
          expandedBytes += entry.size;
          if (expandedBytes > MAX_EXTRACTED_BYTES) {
            throw new Error("The handout archive expands beyond the 1 GB safety limit.");
          }
        }
        return isSafeArchivePath(entryPath) && safeTypes.has(type);
      },
    });
    return true;
  }
  return false;
}

function isArchive(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".zip") || lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

/** Returns true when the file was created, false when student work was already there. */
async function writeIfMissing(root: string, filename: string, data: Uint8Array): Promise<boolean> {
  await createDirectorySafely(root, path.dirname(filename));
  await assertNoSymbolicLinkPath(root, filename);
  try {
    await fs.promises.writeFile(filename, data, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return false;
  }
}

async function createDirectorySafely(root: string, directory: string): Promise<void> {
  await assertNoSymbolicLinkPath(root, directory);
  await fs.promises.mkdir(directory, { recursive: true });
  await assertNoSymbolicLinkPath(root, directory);
}

/** Keeps instructor-provided scripts runnable. Windows has no executable bit to restore. */
async function applyExecutableBit(root: string, filename: string, unixMode: number | undefined): Promise<void> {
  if (process.platform === "win32" || unixMode === undefined || !(unixMode & 0o111)) {
    return;
  }
  try {
    await assertNoSymbolicLinkPath(root, filename);
    await fs.promises.chmod(filename, 0o755);
  } catch {
    // A lab folder on a filesystem without permission bits still holds usable file contents.
  }
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await fs.promises.access(filename);
    return true;
  } catch {
    return false;
  }
}

function resolveAttachmentUrl(host: string, value: string): string {
  try {
    return new URL(value, `${host}/`).toString();
  } catch {
    return joinHostPath(host, value);
  }
}

function mergeArtifacts(existing: LabArtifact[], incoming: LabArtifact[]): LabArtifact[] {
  const merged = new Map(existing.map((artifact) => [artifact.kind, artifact]));
  for (const artifact of incoming) {
    if (artifact.format !== "none" || !merged.has(artifact.kind)) {
      merged.set(artifact.kind, artifact);
    }
  }
  return [...merged.values()];
}
