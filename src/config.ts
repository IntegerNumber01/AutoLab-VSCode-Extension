import * as vscode from "vscode";
import type { LabGrouping, SubmissionFormat } from "./types";
import { normalizeHost } from "./utils";

export interface ConnectionSettings {
  host: string;
  clientId: string;
  workspaceFolder: string;
  allowInsecureHttp: boolean;
}

export interface ExtensionSettings extends ConnectionSettings {
  submissionFormat: SubmissionFormat;
  exclude: string[];
  groupBy: LabGrouping;
  /** Course or lab references used when Autolab will not list courses for this client. */
  courses: string[];
}

export function readSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration("autolab");
  const allowInsecureHttp = config.get<boolean>("allowInsecureHttp", false);
  const rawHost = config.get<string>("host", "");
  let host = "";
  if (rawHost) {
    try {
      host = normalizeHost(rawHost, allowInsecureHttp);
    } catch {
      host = rawHost.trim().replace(/\/+$/, "");
    }
  }

  return {
    host,
    clientId: config.get<string>("clientId", "").trim(),
    workspaceFolder: config.get<string>("workspaceFolder", "").trim(),
    allowInsecureHttp,
    submissionFormat: config.get<SubmissionFormat>("submissionFormat", "ask"),
    groupBy: config.get<LabGrouping>("groupBy", "course"),
    courses: config.get<string[]>("courses", []).map((value) => value.trim()).filter(Boolean),
    exclude: config.get<string[]>("exclude", [".autolab/**", ".git/**", "node_modules/**", ".venv/**", "__pycache__/**"]),
  };
}

export function validateConnectionSettings(settings = readSettings()): ConnectionSettings {
  const host = normalizeHost(settings.host, settings.allowInsecureHttp);
  if (!settings.clientId) {
    throw new Error("Enter the client ID provided by your instructor or Autolab administrator.");
  }
  return { ...settings, host };
}

export async function updateGlobalSetting<T>(key: string, value: T): Promise<void> {
  await vscode.workspace.getConfiguration("autolab").update(key, value, vscode.ConfigurationTarget.Global);
}
