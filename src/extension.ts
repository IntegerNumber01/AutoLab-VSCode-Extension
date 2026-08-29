import * as fs from "fs";
import * as vscode from "vscode";
import { SessionManager } from "./auth";
import { readSettings, updateGlobalSetting } from "./config";
import { LabDownloader, openLabWindow } from "./downloads";
import { findCurrentLab } from "./metadata";
import { PanelManager } from "./panels";
import { SubmissionManager } from "./submission";
import type { AutolabSubmission, DashboardAssessment } from "./types";
import { errorMessage, formatNumber, normalizeHost, submissionScore } from "./utils";
import { AccountProvider, AssignmentsProvider, DashboardModel, SubmissionsProvider } from "./views";

export function activate(context: vscode.ExtensionContext): void {
  const session = new SessionManager(context.secrets);
  const dashboard = new DashboardModel(session);
  const accountProvider = new AccountProvider(session);
  const assignmentsProvider = new AssignmentsProvider(dashboard);
  const submissionsProvider = new SubmissionsProvider(session);
  const panels = new PanelManager(session, dashboard);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "autolab.submit";

  context.subscriptions.push(
    session,
    dashboard,
    accountProvider,
    assignmentsProvider,
    submissionsProvider,
    panels,
    statusBar,
    vscode.window.registerTreeDataProvider("autolab.account", accountProvider),
    vscode.window.registerTreeDataProvider("autolab.assignments", assignmentsProvider),
    vscode.window.registerTreeDataProvider("autolab.submissions", submissionsProvider),
  );

  const refreshAll = (): void => {
    dashboard.refresh();
    accountProvider.refresh();
    submissionsProvider.refresh();
    void updateContext(statusBar);
  };

  context.subscriptions.push(
    register("autolab.setup", () => guidedSetup(session, refreshAll)),
    register("autolab.signIn", async () => {
      await session.signIn();
      if (await session.hasSession()) {
        refreshAll();
        const user = await session.api().getUser();
        await vscode.window.showInformationMessage(`Signed in to Autolab as ${user.first_name} ${user.last_name}.`);
      }
    }),
    register("autolab.signOut", async () => {
      const choice = await vscode.window.showWarningMessage(
        "Sign out of Autolab on this device?",
        { modal: true },
        "Sign Out",
      );
      if (choice === "Sign Out") {
        await session.signOut();
        refreshAll();
      }
    }),
    register("autolab.selectWorkspace", async () => {
      const selected = await selectWorkspaceFolder();
      if (selected) {
        await updateGlobalSetting("workspaceFolder", selected);
        refreshAll();
        await vscode.window.showInformationMessage(`Autolab workspace set to ${selected}.`);
      }
    }),
    register("autolab.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "autolab")),
    register("autolab.toggleGrouping", async () => {
      const next = readSettings().groupBy === "status" ? "course" : "status";
      await updateGlobalSetting("groupBy", next);
      assignmentsProvider.refresh();
      vscode.window.setStatusBarMessage(
        next === "status" ? "Autolab: labs grouped by status" : "Autolab: labs grouped by course",
        3_000,
      );
    }),
    register("autolab.refresh", async () => refreshAll()),
    register("autolab.download", async (first?: unknown, second?: unknown) => {
      const selected = await resolveAssessment(dashboard, first, second);
      const downloader = new LabDownloader(session.api());
      const result = await downloader.download(selected.course, selected.assessment);
      if (!result) {
        return;
      }
      refreshAll();
      const actions = ["Open Lab"];
      if (result.externalUrls.length) {
        actions.push("Open Online Material");
      }
      const choice = await vscode.window.showInformationMessage(
        result.alreadyExisted ? "Your existing lab is ready. No work was overwritten." : "Lab downloaded successfully.",
        ...actions,
      );
      if (choice === "Open Lab") {
        await openLabWindow(result.directory);
      } else if (choice === "Open Online Material") {
        for (const url of result.externalUrls) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      }
    }),
    register("autolab.openLab", async (first?: unknown, second?: unknown) => {
      const selected = await resolveAssessment(dashboard, first, second);
      const downloader = new LabDownloader(session.api());
      if (!(await downloader.open(selected.course.name, selected.assessment.name))) {
        const choice = await vscode.window.showInformationMessage("This lab has not been downloaded yet.", "Download Lab");
        if (choice === "Download Lab") {
          await vscode.commands.executeCommand("autolab.download", selected.course.name, selected.assessment.name);
        }
      }
    }),
    register("autolab.submit", async () => submitLab(session, submissionsProvider, dashboard, panels)),
    register("autolab.submitAssessment", async (first?: unknown, second?: unknown) => {
      const selected = await resolveAssessment(dashboard, first, second);
      await submitLab(session, submissionsProvider, dashboard, panels, selected.course.name, selected.assessment.name);
    }),
    register("autolab.showAssessment", async (first?: unknown, second?: unknown) => {
      const selected = await resolveAssessment(dashboard, first, second);
      await panels.showAssessment(selected.course.name, selected.assessment.name);
    }),
    register("autolab.showResults", async (first?: unknown, second?: unknown, third?: unknown) => {
      const resolved = resolveResultsArguments(first, second, third);
      await panels.showResults(resolved.course, resolved.assessment, resolved.version);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("autolab")) {
        refreshAll();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      submissionsProvider.refresh();
      void updateContext(statusBar);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      submissionsProvider.refresh();
      void updateContext(statusBar);
    }),
  );

  void updateContext(statusBar);
}

export function deactivate(): void {}

function register(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(command, async (...args: unknown[]) => {
    try {
      return await callback(...args);
    } catch (error) {
      await vscode.window.showErrorMessage(errorMessage(error));
      return undefined;
    }
  });
}

async function guidedSetup(session: SessionManager, refresh: () => void): Promise<void> {
  const current = readSettings();
  const hostInput = await vscode.window.showInputBox({
    title: "Autolab Setup (1/3)",
    prompt: "Autolab server URL",
    placeHolder: "https://autolab.example.edu",
    value: current.host,
    ignoreFocusOut: true,
    validateInput: (value) => {
      try {
        normalizeHost(value, current.allowInsecureHttp);
        return undefined;
      } catch (error) {
        return errorMessage(error);
      }
    },
  });
  if (hostInput === undefined) {
    return;
  }
  const host = normalizeHost(hostInput, current.allowInsecureHttp);

  const clientId = await vscode.window.showInputBox({
    title: "Autolab Setup (2/3)",
    prompt: "Public client ID provided by your instructor or Autolab administrator",
    value: current.clientId,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : "Enter the client ID. Never enter or request a client secret.",
  });
  if (clientId === undefined) {
    return;
  }

  const workspaceFolder = await selectWorkspaceFolder("Autolab Setup (3/3): Choose where labs will be downloaded");
  if (!workspaceFolder) {
    return;
  }

  await Promise.all([
    updateGlobalSetting("host", host),
    updateGlobalSetting("clientId", clientId.trim()),
    updateGlobalSetting("workspaceFolder", workspaceFolder),
  ]);
  refresh();

  const choice = await vscode.window.showInformationMessage(
    "Autolab is configured. Sign in now to load your courses?",
    "Sign In",
  );
  if (choice === "Sign In") {
    await session.signIn();
    refresh();
  }
}

async function selectWorkspaceFolder(title = "Choose your Autolab workspace folder"): Promise<string | undefined> {
  const current = readSettings().workspaceFolder;
  if (current) {
    try {
      await fs.promises.mkdir(current, { recursive: true });
    } catch {
      // The folder picker will fall back to VS Code's default location.
    }
  }
  const picked = await vscode.window.showOpenDialog({
    title,
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: current ? vscode.Uri.file(current) : undefined,
    openLabel: "Use for Autolab Labs",
  });
  return picked?.[0]?.fsPath;
}

async function resolveAssessment(
  dashboard: DashboardModel,
  first?: unknown,
  second?: unknown,
): Promise<DashboardAssessment> {
  let course: string | undefined;
  let assessment: string | undefined;
  if (typeof first === "string" && typeof second === "string") {
    course = first;
    assessment = second;
  } else if (isAssessmentNode(first)) {
    return first.item;
  }
  if (!course || !assessment) {
    throw new Error("Select an Autolab lab first.");
  }
  const item = await dashboard.find(course, assessment);
  if (!item) {
    throw new Error("The selected lab is no longer available.");
  }
  return item;
}

function isAssessmentNode(value: unknown): value is { type: "assessment"; item: DashboardAssessment } {
  return Boolean(value && typeof value === "object" && (value as { type?: string }).type === "assessment" && (value as { item?: unknown }).item);
}

function resolveResultsArguments(first?: unknown, second?: unknown, third?: unknown): {
  course: string;
  assessment: string;
  version?: number;
} {
  if (typeof first === "string" && typeof second === "string") {
    return { course: first, assessment: second, version: typeof third === "number" ? third : undefined };
  }
  if (first && typeof first === "object" && (first as { type?: string }).type === "submission") {
    const node = first as {
      course: string;
      assessment: string;
      submission: { version: number };
    };
    return { course: node.course, assessment: node.assessment, version: node.submission.version };
  }
  throw new Error("Select a submission first.");
}

async function submitLab(
  session: SessionManager,
  submissionsProvider: SubmissionsProvider,
  dashboard: DashboardModel,
  panels: PanelManager,
  course?: string,
  assessment?: string,
): Promise<void> {
  const result = await new SubmissionManager(session.api()).submit(course, assessment);
  if (!result) {
    return;
  }
  submissionsProvider.refresh();
  dashboard.refresh();

  const item = await dashboard.find(result.course, result.assessment).catch(() => undefined);
  const graded = item?.details?.has_autograder
    ? await awaitAutograder(session, result)
    : undefined;

  if (graded) {
    submissionsProvider.refresh();
    dashboard.refresh();
  }

  const score = graded ? submissionScore(graded) : undefined;
  const message = score?.hasNumericScore
    ? `Version ${result.version} scored ${formatNumber(score.earned)}${
      item?.details?.max_total_score ? ` / ${formatNumber(item.details.max_total_score)}` : ""
    }.`
    : `Submitted successfully as version ${result.version}.`;

  const choice = await vscode.window.showInformationMessage(message, "View Results");
  if (choice === "View Results") {
    await panels.showResults(result.course, result.assessment, result.version);
  }
}

/**
 * Autograding is asynchronous, so poll briefly instead of making the student re-check by hand.
 * Returns undefined when the grader is still running, the poll was cancelled, or the API failed.
 */
async function awaitAutograder(
  session: SessionManager,
  result: { course: string; assessment: string; version: number },
): Promise<AutolabSubmission | undefined> {
  const POLL_INTERVAL_MS = 5_000;
  const TIMEOUT_MS = 3 * 60_000;

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Autolab: waiting for the autograder (version ${result.version})`,
      cancellable: true,
    },
    async (_progress, token) => {
      const deadline = Date.now() + TIMEOUT_MS;
      while (!token.isCancellationRequested && Date.now() < deadline) {
        await cancellableDelay(POLL_INTERVAL_MS, token);
        if (token.isCancellationRequested) {
          return undefined;
        }
        try {
          const submissions = await session.api().getSubmissions(result.course, result.assessment);
          const match = submissions.find((submission) => submission.version === result.version);
          if (match && submissionScore(match).hasNumericScore) {
            return match;
          }
        } catch {
          // Autolab is unreachable or the score is still hidden; stop polling quietly.
          return undefined;
        }
      }
      return undefined;
    },
  );
}

function cancellableDelay(milliseconds: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    let subscription: vscode.Disposable | undefined;
    const timer = setTimeout(() => {
      subscription?.dispose();
      resolve();
    }, milliseconds);
    subscription = token.onCancellationRequested(() => {
      clearTimeout(timer);
      subscription?.dispose();
      resolve();
    });
  });
}

async function updateContext(statusBar: vscode.StatusBarItem): Promise<void> {
  const lab = await findCurrentLab();
  await vscode.commands.executeCommand("setContext", "autolab.isLab", Boolean(lab));
  if (lab) {
    statusBar.text = `$(cloud-upload) Autolab: ${lab.metadata.assessmentDisplayName}`;
    statusBar.tooltip = `Submit ${lab.metadata.courseDisplayName} / ${lab.metadata.assessmentDisplayName}`;
    statusBar.show();
  } else {
    statusBar.hide();
  }
}
