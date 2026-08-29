import * as vscode from "vscode";
import type { SessionManager } from "./auth";
import { readSettings } from "./config";
import type { DashboardModel } from "./views";
import type {
  AutolabAssessmentDetails,
  AutolabProblem,
  AutolabSubmission,
  DashboardAssessment,
} from "./types";
import {
  errorMessage,
  escapeHtml,
  formatDate,
  formatNumber,
  joinHostPath,
  parseAutograderFeedback,
  submissionScore,
} from "./utils";
import type { AutograderPayload } from "./utils";

interface WebviewMessage {
  action?: string;
  version?: number;
}

export class PanelManager implements vscode.Disposable {
  private readonly assessmentPanels = new Map<string, vscode.WebviewPanel>();
  private readonly resultsPanels = new Map<string, vscode.WebviewPanel>();
  /** Version each results panel is currently showing, so Refresh keeps the chosen version. */
  private readonly resultsVersions = new Map<string, number | undefined>();

  constructor(
    private readonly session: SessionManager,
    private readonly dashboard: DashboardModel,
  ) {}

  dispose(): void {
    for (const panel of [...this.assessmentPanels.values(), ...this.resultsPanels.values()]) {
      panel.dispose();
    }
    this.assessmentPanels.clear();
    this.resultsPanels.clear();
    this.resultsVersions.clear();
  }

  async showAssessment(course: string, assessment: string): Promise<void> {
    const key = `${course}/${assessment}`;
    const existing = this.assessmentPanels.get(key);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active);
      await this.renderAssessmentPanel(existing, course, assessment);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "autolabAssessment",
      "Autolab Lab",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.assessmentPanels.set(key, panel);
    panel.onDidDispose(() => this.assessmentPanels.delete(key));
    panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      try {
        switch (message.action) {
          case "download":
            await vscode.commands.executeCommand("autolab.download", course, assessment);
            break;
          case "open":
            await vscode.commands.executeCommand("autolab.openLab", course, assessment);
            break;
          case "submit":
            await vscode.commands.executeCommand("autolab.submitAssessment", course, assessment);
            break;
          case "results":
            await this.showResults(course, assessment);
            break;
          case "browser":
            await vscode.env.openExternal(vscode.Uri.parse(assessmentUrl(course, assessment)));
            return;
          case "refresh":
            this.dashboard.refresh();
            break;
        }
        if (this.assessmentPanels.has(key)) {
          await this.renderAssessmentPanel(panel, course, assessment);
        }
      } catch (error) {
        await vscode.window.showErrorMessage(errorMessage(error));
      }
    });
    await this.renderAssessmentPanel(panel, course, assessment);
  }

  async showResults(course: string, assessment: string, requestedVersion?: number): Promise<void> {
    const key = `${course}/${assessment}`;
    let panel = this.resultsPanels.get(key);
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "autolabResults",
        `${assessment} — results`,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.resultsPanels.set(key, panel);
      panel.onDidDispose(() => {
        this.resultsPanels.delete(key);
        this.resultsVersions.delete(key);
      });

      const owned = panel;
      owned.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
        try {
          if (message.action === "version" && typeof message.version === "number") {
            this.resultsVersions.set(key, message.version);
          }
          if (message.action === "version" || message.action === "refresh") {
            await this.renderResultsPanel(owned, course, assessment, this.resultsVersions.get(key));
          }
        } catch (error) {
          await vscode.window.showErrorMessage(errorMessage(error));
        }
      });
    } else {
      panel.reveal(vscode.ViewColumn.Active);
    }

    this.resultsVersions.set(key, requestedVersion);
    await this.renderResultsPanel(panel, course, assessment, requestedVersion);
  }

  private async renderResultsPanel(
    panel: vscode.WebviewPanel,
    course: string,
    assessment: string,
    requestedVersion?: number,
  ): Promise<void> {
    panel.webview.html = loadingHtml("Loading scores and feedback…");

    const api = this.session.api();
    const [details, problems, submissions] = await Promise.all([
      api.getAssessment(course, assessment),
      api.getProblems(course, assessment).catch(() => [] as AutolabProblem[]),
      api.getSubmissions(course, assessment),
    ]);

    const submission = requestedVersion === undefined
      ? submissions[0]
      : submissions.find((item) => item.version === requestedVersion);
    if (!submission) {
      throw new Error(
        requestedVersion === undefined
          ? "This lab has no submissions yet."
          : `Submission version ${requestedVersion} was not found.`,
      );
    }

    // Autolab returns feedback per problem, so ask for every problem the submission was scored on.
    const problemNames = problems.length
      ? problems.map((problem) => problem.name)
      : Object.keys(submission.scores);
    const feedback = await Promise.all(problemNames.map(async (problem): Promise<ProblemFeedback> => {
      try {
        return { problem, text: await api.getFeedback(course, assessment, submission.version, problem) };
      } catch (error) {
        return { problem, error: errorMessage(error) };
      }
    }));

    panel.title = `${details.display_name} — v${submission.version}`;
    panel.webview.html = resultsHtml(details, problems, submission, submissions, feedback);
  }

  private async renderAssessmentPanel(panel: vscode.WebviewPanel, course: string, assessment: string): Promise<void> {
    panel.webview.html = loadingHtml("Loading lab…");
    let item: DashboardAssessment | undefined;
    try {
      item = await this.dashboard.find(course, assessment);
    } catch (error) {
      panel.webview.html = errorHtml(errorMessage(error));
      return;
    }
    if (!item) {
      panel.webview.html = errorHtml("This lab is no longer available in your courses.");
      return;
    }
    panel.title = item.assessment.display_name;
    panel.webview.html = assessmentHtml(item);
  }
}

interface ProblemFeedback {
  problem: string;
  text?: string;
  error?: string;
}

function assessmentUrl(course: string, assessment: string): string {
  const host = readSettings().host;
  return joinHostPath(host, `/courses/${encodeURIComponent(course)}/assessments/${encodeURIComponent(assessment)}`);
}

function assessmentHtml(item: DashboardAssessment): string {
  const nonce = getNonce();
  const latest = item.submissions[0];
  const score = submissionScore(latest);
  const maxScore = item.details?.max_total_score;
  const scoreText = score.hasNumericScore
    ? maxScore === null || maxScore === undefined
      ? formatNumber(score.earned)
      : `${formatNumber(score.earned)} / ${formatNumber(maxScore)}`
    : latest
      ? score.hasUnreleasedScore ? "Score not released" : "Submitted — awaiting score"
      : "Not submitted";
  const now = Date.now();
  const closed = Boolean(item.details?.disable_handins) || (Date.parse(item.assessment.end_at ?? "") || Infinity) < now;
  const details = item.details;
  const used = item.submissions.length;
  const limit = details?.max_submissions;
  const attemptsText = limit === null || limit === undefined || limit < 0
    ? `${used} used · unlimited`
    : `${used} of ${limit} used`;

  return page(nonce, `
    <header>
      <div class="eyebrow">${escapeHtml(item.course.display_name)} · ${escapeHtml(item.course.semester)}</div>
      <h1>${escapeHtml(item.assessment.display_name)}</h1>
      <div class="badges">
        <span class="badge">${escapeHtml(scoreText)}</span>
        ${item.localPath ? '<span class="badge success">Downloaded</span>' : '<span class="badge">Cloud only</span>'}
        ${closed ? '<span class="badge danger">Submissions closed</span>' : ""}
      </div>
    </header>

    <section class="actions">
      ${item.localPath
        ? `<button data-action="open" class="primary">Open Lab</button><button data-action="submit"${closed ? " disabled" : ""}>Submit</button>`
        : '<button data-action="download" class="primary">Download Lab</button>'}
      ${latest ? '<button data-action="results">Scores &amp; Feedback</button>' : ""}
      <button data-action="browser">View on Autolab</button>
      <button data-action="refresh">Refresh</button>
    </section>

    <section class="grid">
      ${fact("Due", formatDate(item.assessment.due_at) ?? "No due date")}
      ${fact("Available", dateRange(item.assessment.start_at, item.assessment.end_at))}
      ${fact("Attempts", attemptsText)}
      ${fact("Autograder", details?.has_autograder ? "Enabled" : "Not listed")}
      ${fact("Handout", describeArtifact(item, "handout", details?.handout_format))}
      ${fact("Writeup", describeArtifact(item, "writeup", details?.writeup_format))}
    </section>

    ${item.localPath ? `<p class="muted">Local folder: <code>${escapeHtml(item.localPath)}</code></p>` : ""}
    ${details?.description ? `<section><h2>About this lab</h2><p class="description">${escapeHtml(stripHtml(details.description))}</p></section>` : ""}
    ${latest
      ? scoresTable(latest, details)
      : '<section class="empty"><h2>Nothing submitted yet</h2><p>Download the lab, open it in a dedicated VS Code window, and submit when ready.</p></section>'}
    ${item.error ? `<p class="warning">${escapeHtml(item.error)}</p>` : ""}
  `, true);
}

function describeArtifact(
  item: DashboardAssessment,
  kind: "handout" | "writeup",
  format: string | null | undefined,
): string {
  const artifact = item.localArtifacts?.find((entry) => entry.kind === kind);
  if (artifact?.format === "file" && artifact.filename) {
    return artifact.extracted ? `${artifact.filename} (extracted)` : artifact.filename;
  }
  if (artifact?.format === "url") {
    return "Online link";
  }
  return format ?? "Unknown";
}

function resultsHtml(
  details: AutolabAssessmentDetails,
  problems: AutolabProblem[],
  submission: AutolabSubmission,
  allSubmissions: AutolabSubmission[],
  feedback: ProblemFeedback[],
): string {
  const nonce = getNonce();
  const score = submissionScore(submission);
  const scoreText = score.hasNumericScore
    ? details.max_total_score === null || details.max_total_score === undefined
      ? formatNumber(score.earned)
      : `${formatNumber(score.earned)} / ${formatNumber(details.max_total_score)}`
    : "Awaiting score";

  const versions = allSubmissions.length > 1
    ? `<section><h2>Versions</h2><div class="actions">${allSubmissions.map((item) =>
        `<button data-action="version" data-version="${item.version}"${item.version === submission.version ? ' class="primary"' : ""}>v${item.version}</button>`,
      ).join("")}</div></section>`
    : "";

  return page(nonce, `
    <header>
      <div class="eyebrow">Submission version ${submission.version} · ${escapeHtml(submission.filename)}</div>
      <h1>${escapeHtml(details.display_name)}</h1>
      <div class="badges">
        <span class="badge">${escapeHtml(scoreText)}</span>
        <span class="badge">${escapeHtml(formatDate(submission.created_at) ?? submission.created_at)}</span>
      </div>
    </header>
    <section class="actions"><button data-action="refresh" class="primary">Refresh Results</button></section>
    ${resultsScoreTable(submission, problems)}
    ${versions}
    <section>
      <h2>Autograder feedback</h2>
      ${feedbackSections(feedback)}
    </section>
  `, true);
}

function feedbackSections(feedback: ProblemFeedback[]): string {
  const withText = feedback.filter((entry) => entry.text?.trim());
  if (!withText.length) {
    const firstError = feedback.find((entry) => entry.error)?.error;
    return `<div class="empty"><p>${escapeHtml(firstError ?? "No feedback is available for this submission yet.")}</p></div>`;
  }

  return withText.map((entry, index) => {
    const parsed = parseAutograderFeedback(entry.text ?? "");
    const summary = parsed ? autograderSummary(parsed) : "";
    const label = withText.length === 1 ? "Autograder output" : entry.problem;
    return `<details${index === 0 ? " open" : ""}>
      <summary>${escapeHtml(label)}</summary>
      ${summary}
      <pre class="feedback">${escapeHtml(entry.text ?? "")}</pre>
    </details>`;
  }).join("");
}

function autograderSummary(payload: AutograderPayload): string {
  const parts: string[] = [];

  const scoreRows = Object.entries(payload.scores ?? {})
    .map(([name, value]) => `<tr><td>${escapeHtml(name)}</td><td class="numeric">${escapeHtml(
      typeof value === "number" ? formatNumber(value) : String(value),
    )}</td></tr>`)
    .join("");
  if (scoreRows) {
    parts.push(`<table><thead><tr><th>Reported score</th><th class="numeric">Value</th></tr></thead><tbody>${scoreRows}</tbody></table>`);
  }

  const stageRows = Object.entries(payload.stages ?? {}).map(([name, value]) => {
    const stage = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const passed = stage._passed ?? stage.passed;
    const message = stage._message ?? stage.message ?? "";
    const status = typeof passed === "boolean" ? (passed ? "Passed" : "Failed") : "—";
    return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(status)}</td><td>${escapeHtml(String(message))}</td></tr>`;
  }).join("");
  if (stageRows) {
    parts.push(`<table><thead><tr><th>Stage</th><th>Result</th><th>Detail</th></tr></thead><tbody>${stageRows}</tbody></table>`);
  }

  return parts.length ? `<div class="summary">${parts.join("")}</div>` : "";
}

function scoresTable(submission: AutolabSubmission, details?: AutolabAssessmentDetails): string {
  const rows = Object.entries(submission.scores).map(([problem, value]) => {
    const max = details?.max_scores?.[problem];
    const valueText = typeof value === "number"
      ? max === undefined ? formatNumber(value) : `${formatNumber(value)} / ${formatNumber(max)}`
      : value === "unreleased" ? "Unreleased" : "—";
    return `<tr><td>${escapeHtml(problem)}</td><td class="numeric">${escapeHtml(valueText)}</td></tr>`;
  }).join("");
  return `<section><h2>Latest submission</h2><p class="muted">Version ${submission.version} · ${escapeHtml(formatDate(submission.created_at) ?? submission.created_at)}</p><table><tbody>${rows || "<tr><td>Scores are pending</td><td>—</td></tr>"}</tbody></table></section>`;
}

function resultsScoreTable(submission: AutolabSubmission, problems: AutolabProblem[]): string {
  const byName = new Map(problems.map((problem) => [problem.name, problem]));
  const rows = Object.entries(submission.scores).map(([problem, value]) => {
    const max = byName.get(problem)?.max_score;
    const valueText = typeof value === "number"
      ? max === undefined ? formatNumber(value) : `${formatNumber(value)} / ${formatNumber(max)}`
      : value === "unreleased" ? "Unreleased" : "—";
    return `<tr><td>${escapeHtml(problem)}</td><td class="numeric">${escapeHtml(valueText)}</td></tr>`;
  }).join("");
  return `<section><h2>Problem scores</h2><table><thead><tr><th>Problem</th><th class="numeric">Score</th></tr></thead><tbody>${rows || '<tr><td>Scores are pending</td><td class="numeric">—</td></tr>'}</tbody></table></section>`;
}

function page(nonce: string, body: string, script: boolean): string {
  return `<!doctype html><html lang="en"><head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style nonce="${nonce}">
      :root { color-scheme: light dark; }
      body { max-width: 900px; margin: 0 auto; padding: 36px 28px 64px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
      h1 { margin: 6px 0 14px; font-size: 2rem; line-height: 1.15; }
      h2 { margin-top: 32px; font-size: 1.15rem; }
      .eyebrow { color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .08em; font-size: .78rem; }
      .badges, .actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .badge { padding: 4px 9px; border: 1px solid var(--vscode-widget-border); border-radius: 999px; color: var(--vscode-descriptionForeground); }
      .badge.success { color: var(--vscode-testing-iconPassed); }
      .badge.danger, .warning { color: var(--vscode-errorForeground); }
      .actions { margin: 26px 0; }
      button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 7px 14px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; font-family: inherit; font-size: inherit; }
      button:hover { background: var(--vscode-button-secondaryHoverBackground); }
      button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
      button.primary:hover { background: var(--vscode-button-hoverBackground); }
      button:disabled { opacity: .45; cursor: not-allowed; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
      .fact { padding: 14px; border: 1px solid var(--vscode-widget-border); border-radius: 5px; background: var(--vscode-editorWidget-background); overflow-wrap: anywhere; }
      .fact span { display: block; color: var(--vscode-descriptionForeground); font-size: .78rem; margin-bottom: 5px; }
      .description { white-space: pre-wrap; line-height: 1.55; }
      table { border-collapse: collapse; width: 100%; margin-top: 10px; }
      th, td { border-bottom: 1px solid var(--vscode-widget-border); text-align: left; padding: 9px 4px; }
      .numeric { text-align: right; font-variant-numeric: tabular-nums; }
      .muted { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
      code { font-family: var(--vscode-editor-font-family); }
      .empty { padding: 18px; border: 1px dashed var(--vscode-widget-border); border-radius: 5px; color: var(--vscode-descriptionForeground); }
      details { margin-top: 12px; border: 1px solid var(--vscode-widget-border); border-radius: 5px; padding: 10px 14px; }
      summary { cursor: pointer; font-weight: 600; }
      .summary { margin-top: 8px; }
      .feedback { white-space: pre-wrap; word-break: break-word; max-height: 30rem; overflow: auto; padding: 16px; margin-top: 12px; border: 1px solid var(--vscode-widget-border); border-radius: 5px; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.45; }
    </style></head><body>${body}
    ${script ? `<script nonce="${nonce}">const vscode = acquireVsCodeApi(); document.addEventListener('click', (event) => { const button = event.target.closest('button[data-action]'); if (button && !button.disabled) vscode.postMessage({ action: button.dataset.action, version: button.dataset.version ? Number(button.dataset.version) : undefined }); });</script>` : ""}
  </body></html>`;
}

function loadingHtml(message: string): string {
  return page(getNonce(), `<div class="empty">${escapeHtml(message)}</div>`, false);
}

function errorHtml(message: string): string {
  return page(getNonce(), `<h1>Couldn’t load this lab</h1><p class="warning">${escapeHtml(message)}</p>`, false);
}

function fact(label: string, value: string): string {
  return `<div class="fact"><span>${escapeHtml(label)}</span>${escapeHtml(value)}</div>`;
}

/** Autolab assessment descriptions are instructor-authored HTML; the panel shows them as text. */
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim();
}

function dateRange(start: string | null, end: string | null): string {
  const formattedStart = formatDate(start);
  const formattedEnd = formatDate(end);
  if (formattedStart && formattedEnd) {
    return `${formattedStart} – ${formattedEnd}`;
  }
  return formattedStart ? `From ${formattedStart}` : formattedEnd ? `Until ${formattedEnd}` : "No restrictions listed";
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
