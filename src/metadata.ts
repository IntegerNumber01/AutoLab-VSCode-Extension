import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { readSettings } from "./config";
import type { AutolabAssessment, AutolabCourse, LabMetadata } from "./types";
import { isPathInside, safePathSegment } from "./utils";

export const METADATA_DIRECTORY = ".autolab";
export const METADATA_FILENAME = "assessment.json";

export interface LocalLab {
  directory: string;
  metadata: LabMetadata;
}

export function assessmentDirectory(course: Pick<AutolabCourse, "name">, assessment: Pick<AutolabAssessment, "name">): string | undefined {
  const root = readSettings().workspaceFolder;
  if (!root) {
    return undefined;
  }
  return path.join(root, safePathSegment(course.name), safePathSegment(assessment.name));
}

export async function readLabMetadata(directory: string): Promise<LabMetadata | undefined> {
  const filename = path.join(directory, METADATA_DIRECTORY, METADATA_FILENAME);
  try {
    const parsed = JSON.parse(await fs.promises.readFile(filename, "utf8")) as Partial<LabMetadata>;
    if (
      parsed.version !== 1 ||
      typeof parsed.host !== "string" ||
      typeof parsed.course !== "string" ||
      typeof parsed.assessment !== "string" ||
      !Array.isArray(parsed.artifacts)
    ) {
      return undefined;
    }
    return parsed as LabMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

export async function writeLabMetadata(directory: string, metadata: LabMetadata): Promise<void> {
  const metadataDirectory = path.join(directory, METADATA_DIRECTORY);
  await fs.promises.mkdir(metadataDirectory, { recursive: true });
  await fs.promises.writeFile(
    path.join(metadataDirectory, METADATA_FILENAME),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

export async function findCurrentLab(): Promise<LocalLab | undefined> {
  const activeFile = vscode.window.activeTextEditor?.document.uri;
  if (activeFile?.scheme === "file") {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeFile);
    if (workspaceFolder) {
      const found = await findLabFromDirectory(path.dirname(activeFile.fsPath), workspaceFolder.uri.fsPath);
      if (found) {
        return found;
      }
    }
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const metadata = await readLabMetadata(folder.uri.fsPath);
    if (metadata) {
      return { directory: folder.uri.fsPath, metadata };
    }
  }
  return undefined;
}

export async function findLabFromDirectory(start: string, boundary: string): Promise<LocalLab | undefined> {
  let current = path.resolve(start);
  const root = path.resolve(boundary);
  if (!isPathInside(root, current)) {
    return undefined;
  }

  while (isPathInside(root, current)) {
    const metadata = await readLabMetadata(current);
    if (metadata) {
      return { directory: current, metadata };
    }
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }
  return undefined;
}

export async function localLabFor(course: string, assessment: string): Promise<LocalLab | undefined> {
  const root = readSettings().workspaceFolder;
  if (!root) {
    return undefined;
  }
  const directory = path.join(root, safePathSegment(course), safePathSegment(assessment));
  const metadata = await readLabMetadata(directory);
  const settings = readSettings();
  return metadata
    && metadata.host === settings.host
    && metadata.course === course
    && metadata.assessment === assessment
    ? { directory, metadata }
    : undefined;
}
