import * as vscode from "vscode";
import type { LabGrouping, SubmissionFormat } from "./types";
import { normalizeHost } from "./utils";

/** These are always excluded from generated archives. Use exact-file mode to submit one deliberately. */
const REQUIRED_EXCLUDES = [
  ".autolab/**",
  ".vscode/**",
  ".git/**",
  "node_modules/**",
  ".venv/**",
  "__pycache__/**",
  "**/.env*",
  "**/.ssh/**",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ecdsa",
  "**/id_ed25519",
];

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

  const configuredExcludes = config.get<unknown>("exclude", []);
  const extraExcludes = Array.isArray(configuredExcludes)
    ? configuredExcludes.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];

  return {
    host,
    clientId: config.get<string>("clientId", "").trim(),
    workspaceFolder: config.get<string>("workspaceFolder", "").trim(),
    allowInsecureHttp,
    submissionFormat: config.get<SubmissionFormat>("submissionFormat", "ask"),
    groupBy: config.get<LabGrouping>("groupBy", "course"),
    courses: config.get<string[]>("courses", []).map((value) => value.trim()).filter(Boolean),
    exclude: [...new Set([
      ...REQUIRED_EXCLUDES,
      ...extraExcludes,
    ])],
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
