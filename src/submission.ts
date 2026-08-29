import fg = require("fast-glob");
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as tar from "tar";
import * as vscode from "vscode";
import type { AutolabApi } from "./api";
import { readSettings } from "./config";
import { findCurrentLab, localLabFor, writeLabMetadata, type LocalLab } from "./metadata";
import type { AutolabAssessmentDetails, SubmitResult, SubmissionFormat } from "./types";
import { errorMessage, formatBytes } from "./utils";
import { createZipFile } from "./zip";

const MAX_PACKAGE_BYTES = 268_435_456;

export interface SubmissionResult extends SubmitResult {
  course: string;
  assessment: string;
}

export class SubmissionManager {
  constructor(private readonly api: AutolabApi) {}

  async submit(course?: string, assessment?: string): Promise<SubmissionResult | undefined> {
    const lab = course && assessment ? await localLabFor(course, assessment) : await findCurrentLab();
    if (!lab) {
      throw new Error("Open a downloaded Autolab lab folder before submitting.");
    }
    const settings = readSettings();
    if (lab.metadata.host !== settings.host) {
      throw new Error(
        `This lab belongs to ${lab.metadata.host}, but the extension is configured for ${settings.host}. Switch Autolab servers before submitting.`,
      );
    }
    if ((course && lab.metadata.course !== course) || (assessment && lab.metadata.assessment !== assessment)) {
      throw new Error("The open lab does not match the selected Autolab assessment.");
    }

    const details = await this.assessmentDetails(lab);
    if (details?.disable_handins) {
      throw new Error(`${lab.metadata.assessmentDisplayName} is not accepting submissions right now.`);
    }
    if (!(await this.confirmDeadline(lab, details))) {
      return undefined;
    }

    const selected = await this.chooseSubmission(lab);
    if (!selected) {
      return undefined;
    }

    try {
      const confirmed = await vscode.window.showWarningMessage(
        `Submit ${selected.description} to ${lab.metadata.courseDisplayName} / ${lab.metadata.assessmentDisplayName}?`,
        {
          modal: true,
          detail: "Autolab submissions cannot be undone. If Autolab rejects it, read the error before trying again.",
        },
        "Submit",
      );
      if (confirmed !== "Submit") {
        return undefined;
      }

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Submitting ${lab.metadata.assessmentDisplayName}`,
          cancellable: false,
        },
        () => this.api.submit(lab.metadata.course, lab.metadata.assessment, selected.filename),
      );

      await this.rememberFormat(lab, selected.format);
      return { ...result, course: lab.metadata.course, assessment: lab.metadata.assessment };
    } finally {
      if (selected.temporaryDirectory) {
        await fs.promises.rm(selected.temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  private async assessmentDetails(lab: LocalLab): Promise<AutolabAssessmentDetails | undefined> {
    try {
      return await this.api.getAssessment(lab.metadata.course, lab.metadata.assessment);
    } catch {
      // A details lookup failure must not block a submission Autolab would still accept.
      return undefined;
    }
  }

  private async confirmDeadline(lab: LocalLab, details: AutolabAssessmentDetails | undefined): Promise<boolean> {
    const due = Date.parse(details?.due_at ?? "");
    if (!due || due >= Date.now()) {
      return true;
    }
    const end = Date.parse(details?.end_at ?? "");
    if (end && end < Date.now()) {
      throw new Error(`${lab.metadata.assessmentDisplayName} closed for submissions on ${new Date(end).toLocaleString()}.`);
    }
    const choice = await vscode.window.showWarningMessage(
      `${lab.metadata.assessmentDisplayName} was due ${new Date(due).toLocaleString()}.`,
      { modal: true, detail: "Autolab may record this as late and apply a grace day or a late penalty." },
      "Submit Anyway",
    );
    return choice === "Submit Anyway";
  }

  private async rememberFormat(lab: LocalLab, format: Exclude<SubmissionFormat, "ask">): Promise<void> {
    if (lab.metadata.submissionFormat === format) {
      return;
    }
    try {
      await writeLabMetadata(lab.directory, { ...lab.metadata, submissionFormat: format });
    } catch {
      // Remembering the format is a convenience; a read-only lab folder must not fail the submit.
    }
  }

  private async chooseSubmission(lab: LocalLab): Promise<PreparedSubmission | undefined> {
    const settings = readSettings();
    let format: Exclude<SubmissionFormat, "ask">;

    if (settings.submissionFormat !== "ask") {
      format = settings.submissionFormat;
    } else {
      const remembered = lab.metadata.submissionFormat;
      const picks: FormatPick[] = [
        { label: "$(file-zip) Package lab as ZIP", description: "Recommended for most assessments", format: "zip" },
        { label: "$(file-zip) Package lab as tar.gz", description: "For assessments that require a tar archive", format: "tar.gz" },
        { label: "$(file) Choose one file", description: "Submit an existing archive or source file", format: "file" },
      ];
      for (const pick of picks) {
        if (pick.format === remembered) {
          pick.description = `${pick.description} · used last time`;
          pick.picked = true;
        }
      }
      picks.sort((left, right) => Number(right.picked ?? false) - Number(left.picked ?? false));

      const picked = await vscode.window.showQuickPick<FormatPick>(picks, {
        placeHolder: "How should this lab be submitted?",
        title: "Autolab: Prepare Submission",
      });
      if (!picked) {
        return undefined;
      }
      format = picked.format;
    }

    if (format === "file") {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(lab.directory),
        openLabel: "Use as Submission",
      });
      if (!picked?.[0]) {
        return undefined;
      }
      const stat = await fs.promises.stat(picked[0].fsPath);
      return {
        filename: picked[0].fsPath,
        format,
        description: `${path.basename(picked[0].fsPath)} (${formatBytes(stat.size)})`,
      };
    }

    return this.packageFolder(lab.directory, format);
  }

  private async packageFolder(
    directory: string,
    format: Exclude<SubmissionFormat, "ask" | "file">,
  ): Promise<PreparedSubmission> {
    const settings = readSettings();
    const files = await fg("**/*", {
      cwd: directory,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      ignore: settings.exclude,
    });
    files.sort((left, right) => left.localeCompare(right));
    if (files.length === 0) {
      throw new Error("No files remain after applying the Autolab exclude patterns.");
    }

    let totalBytes = 0;
    for (const file of files) {
      totalBytes += (await fs.promises.stat(path.join(directory, file))).size;
    }
    if (totalBytes > MAX_PACKAGE_BYTES) {
      throw new Error(
        `This lab holds ${formatBytes(totalBytes)}, past the ${formatBytes(MAX_PACKAGE_BYTES)} packaging limit. Add large folders to the autolab.exclude setting, or choose an existing submission file instead.`,
      );
    }

    const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autolab-submit-"));
    try {
      const filename = path.join(temporaryDirectory, format === "zip" ? "submission.zip" : "submission.tar.gz");
      if (format === "zip") {
        await createZipFile(
          filename,
          files.map((file) => ({ archivePath: file, sourcePath: path.join(directory, file) })),
        );
      } else {
        await tar.create({ cwd: directory, file: filename, gzip: true, portable: true }, files);
      }

      const archiveSize = (await fs.promises.stat(filename)).size;
      return {
        filename,
        format,
        temporaryDirectory,
        description: `${files.length} ${files.length === 1 ? "file" : "files"} as ${path.basename(filename)} (${formatBytes(archiveSize)}, ${formatBytes(totalBytes)} uncompressed)`,
      };
    } catch (error) {
      await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
      throw new Error(`Could not package this lab: ${errorMessage(error)}`);
    }
  }
}

interface FormatPick extends vscode.QuickPickItem {
  format: Exclude<SubmissionFormat, "ask">;
}

interface PreparedSubmission {
  filename: string;
  description: string;
  format: Exclude<SubmissionFormat, "ask">;
  temporaryDirectory?: string;
}
