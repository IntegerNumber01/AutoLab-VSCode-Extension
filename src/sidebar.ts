import * as vscode from "vscode";
import type { SessionManager } from "./auth";
import { readSettings } from "./config";
import { locateTestFailures, parseTestFailures, resolveFeedbackLocations, verifyTarget, type LocatedTestFailure, type SourceTarget } from "./feedback";
import { placeholderCourse } from "./manual";
import { findCurrentLab, localLabFor } from "./metadata";
import { assessmentHtml, errorHtml, loadingHtml, problemsFromDetails, resultsHtml, type ProblemFeedback } from "./panels";
import type { AutolabProblem } from "./types";
import { assessmentPath, errorMessage, joinHostPath } from "./utils";
import type { DashboardModel } from "./views";

interface Selection {
  course: string;
  assessment: string;
  results: boolean;
  version?: number;
}

interface WebviewMessage {
  action?: string;
  version?: number;
  location?: number;
}

export class LabSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private selection?: Selection;
  private generation = 0;
  private host = readSettings().host;
  private targets: SourceTarget[] = [];
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("autolab");
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly selectionEmitter = new vscode.EventEmitter<{ course: string; assessment: string }>();
  /** Fires when a different lab is shown, so Run History and the current lab can follow it. */
  readonly onDidSelectLab = this.selectionEmitter.event;

  constructor(private readonly session: SessionManager, private readonly dashboard: DashboardModel) {
    this.subscriptions.push(dashboard.onDidChange(() => { void this.render(); }));
  }

  dispose(): void {
    this.generation++;
    this.diagnostics.dispose();
    this.selectionEmitter.dispose();
    this.subscriptions.forEach((subscription) => subscription.dispose());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void this.handleMessage(message).catch((error) => vscode.window.showErrorMessage(errorMessage(error)));
      }),
      view.onDidDispose(() => { this.view = undefined; this.generation++; }),
    );
    if (this.selection) { void this.render(); }
    else { void this.syncCurrentLab().then(() => this.render()); }
  }

  async syncCurrentLab(): Promise<void> {
    const lab = await findCurrentLab();
    if (lab && lab.metadata.host === readSettings().host) {
      const { course, assessment } = lab.metadata;
      if (!this.selection || this.selection.course !== course || this.selection.assessment !== assessment) {
        this.select({ course, assessment, results: false });
        await this.render();
      }
    } else if (!this.selection) {
      await this.render();
    }
  }

  async showAssessment(course: string, assessment: string): Promise<void> {
    this.select({ course, assessment, results: false });
    await vscode.commands.executeCommand("autolab.details.focus");
    await this.render();
  }

  async showResults(course: string, assessment: string, version?: number): Promise<void> {
    this.select({ course, assessment, results: true, version });
    await vscode.commands.executeCommand("autolab.details.focus");
    await this.render();
  }

  private select(selection: Selection): void {
    const previous = this.selection;
    this.selection = selection;
    if (previous?.course !== selection.course || previous.assessment !== selection.assessment) {
      this.selectionEmitter.fire({ course: selection.course, assessment: selection.assessment });
    }
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    const selected = this.selection;
    if (!selected) { return; }
    const { course, assessment } = selected;
    switch (message.action) {
      case "source": {
        const location = Number.isInteger(message.location) ? this.targets[message.location!] : undefined;
        if (location) {
          const lab = await localLabFor(course, assessment);
          // Revalidate in case a file was replaced with a symlink since rendering.
          if (!lab || !(await verifyTarget(lab.directory, location.localFile))) { return; }
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(location.localFile));
          const line = Math.min(location.line - 1, document.lineCount - 1);
          const column = Math.min(location.column - 1, document.lineAt(line).text.length);
          const position = new vscode.Position(line, column);
          await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true });
        }
        return;
      }
      case "version":
        if (!Number.isSafeInteger(message.version) || message.version! < 1) { return; }
        this.selection = { ...selected, version: message.version, results: true };
        break;
      case "assessment": this.selection = { course, assessment, results: false }; break;
      case "results": this.selection = { course, assessment, results: true }; break;
      case "download": await vscode.commands.executeCommand("autolab.download", course, assessment); break;
      case "open": await vscode.commands.executeCommand("autolab.openLab", course, assessment); break;
      case "submit": await vscode.commands.executeCommand("autolab.submitAssessment", course, assessment); return;
      case "browser": await vscode.env.openExternal(vscode.Uri.parse(joinHostPath(readSettings().host, assessmentPath(course, assessment)))); return;
      case "refresh": this.dashboard.refresh(); return;
      default: return;
    }
    await this.render();
  }

  private async render(): Promise<void> {
    const generation = ++this.generation;
    this.targets = [];
    this.diagnostics.clear();
    if (this.host !== readSettings().host) {
      this.host = readSettings().host;
      this.selection = undefined;
    }
    const view = this.view;
    if (!view) { return; }
    const selected = this.selection;
    const current = (): boolean => generation === this.generation && this.view === view;
    if (!selected) {
      view.webview.html = loadingHtml("Open a downloaded lab or select a lab in Labs to see its details and runs here.");
      return;
    }
    view.webview.html = loadingHtml("Loading lab…");
    const { course, assessment, results, version } = selected;
    try {
      if (!(await this.session.hasSession())) {
        if (current()) { view.webview.html = loadingHtml("Sign in from Account to see lab details and runs."); }
        return;
      }
      if (!results) {
        let item = await this.dashboard.find(course, assessment).catch(() => undefined);
        if (!item) {
          // Metadata labs work even when course discovery is unavailable.
          const details = await this.session.api().getAssessment(course, assessment);
          const lab = await localLabFor(course, assessment);
          item = {
            course: { ...placeholderCourse(course), display_name: lab?.metadata.courseDisplayName ?? course },
            assessment: { ...details, name: assessment }, details,
            submissions: await this.session.api().getSubmissions(course, assessment),
            localPath: lab?.directory, localArtifacts: lab?.metadata.artifacts,
          };
        }
        if (current()) { view.webview.html = assessmentHtml(item); }
        return;
      }
      const api = this.session.api();
      const [details, fetchedProblems, submissions] = await Promise.all([
        api.getAssessment(course, assessment),
        api.getProblems(course, assessment).catch(() => [] as AutolabProblem[]),
        api.getSubmissions(course, assessment),
      ]);
      const problems = fetchedProblems.length ? fetchedProblems : problemsFromDetails(details);
      const submission = version === undefined ? submissions[0] : submissions.find((item) => item.version === version);
      if (!submission) { throw new Error("No submissions are available for this version yet."); }
      const names = [...new Set([...problems.map((problem) => problem.name), ...Object.keys(submission.scores)])];
      const feedback = await Promise.all(names.map(async (problem): Promise<ProblemFeedback> => {
        try { return { problem, text: await api.getFeedback(course, assessment, submission.version, problem) }; }
        catch (error) { return { problem, error: errorMessage(error) }; }
      }));
      const lab = await localLabFor(course, assessment);
      const texts = feedback.map((entry) => entry.text ?? "");
      const locations = lab ? await resolveFeedbackLocations(lab.directory, texts).catch(() => []) : [];
      const failures = await Promise.all(texts.map((text, index) =>
        locateTestFailures(lab?.directory, text, locations[index] ?? []).catch((): LocatedTestFailure[] => parseTestFailures(text))));
      if (!current()) { return; }
      this.targets = [];
      const track = (target: SourceTarget): number => this.targets.push(target) - 1;
      feedback.forEach((entry, index) => {
        entry.locations = (locations[index] ?? []).map((location) => ({ ...location, id: track(location) }));
        entry.failures = failures[index].map((failure) => ({ ...failure, targetId: failure.target ? track(failure.target) : undefined }));
      });
      this.publishDiagnostics(submission.version, feedback);
      view.webview.html = resultsHtml(details, problems, submission, submissions, feedback);
    } catch (error) {
      if (current()) { view.webview.html = errorHtml(errorMessage(error)); }
    }
  }

  /** Mirrors compiler errors and failing tests into the Problems panel and the editor. */
  private publishDiagnostics(version: number, feedback: ProblemFeedback[]): void {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const add = (file: string, range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity): void => {
      const items = byFile.get(file) ?? [];
      if (items.some((item) => item.range.isEqual(range) && item.message === message)) { return; }
      const diagnostic = new vscode.Diagnostic(range, message, severity);
      diagnostic.source = `Autolab v${version}`;
      items.push(diagnostic);
      byFile.set(file, items);
    };
    for (const entry of feedback) {
      for (const location of entry.locations ?? []) {
        if (!location.severity) { continue; }
        add(location.localFile, new vscode.Range(location.line - 1, location.column - 1, location.line - 1, location.column), location.message,
          location.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      }
      for (const failure of entry.failures ?? []) {
        const target = failure.target;
        if (!target) { continue; }
        const width = target.symbol?.length ?? 1;
        const outcome = failure.expected !== undefined || failure.actual !== undefined
          ? ` (expected ${failure.expected ?? ""}, got ${failure.actual ?? ""})`
          : "";
        add(target.localFile, new vscode.Range(target.line - 1, target.column - 1, target.line - 1, target.column - 1 + width),
          `${failure.test} failed: ${failure.message}${outcome}`,
          // A method matched by name is a likely place to look, not a confirmed fault.
          target.symbol ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
      }
    }
    for (const [file, diagnostics] of byFile) { this.diagnostics.set(vscode.Uri.file(file), diagnostics); }
  }
}
