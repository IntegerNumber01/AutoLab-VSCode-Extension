import type {
  AutolabAssessmentDetails,
  AutolabProblem,
  AutolabSubmission,
  DashboardAssessment,
} from "./types";
import {
  escapeHtml,
  formatDate,
  formatNumber,
  submissionScore,
} from "./utils";
import type { LocatedTestFailure, ResolvedFeedbackLocation } from "./feedback";

export type LocatedFailure = LocatedTestFailure & { targetId?: number };

export interface ProblemFeedback {
  problem: string;
  text?: string;
  error?: string;
  locations?: (ResolvedFeedbackLocation & { id: number })[];
  failures?: LocatedFailure[];
}

export function problemsFromDetails(details: AutolabAssessmentDetails): AutolabProblem[] {
  return Object.entries(details.max_scores ?? {}).map(([name, max_score]) => ({ name, max_score }));
}

export function assessmentHtml(item: DashboardAssessment): string {
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
      : '<section class="empty"><h2>Nothing submitted yet</h2><p>Download the lab, open it in this workspace, and submit when ready.</p></section>'}
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

export function resultsHtml(
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

  const entries = uniqueFeedback(feedback);
  const failures = entries.flatMap((entry) => (entry.failures ?? []).map((failure) => ({ entry, failure })));
  const compilerMessages = entries.flatMap((entry) => (entry.locations ?? []).filter((location) => location.severity));
  const status = failures.length
    ? `<span class="pill danger">${failures.length} ${failures.length === 1 ? "test" : "tests"} failing</span>`
    : compilerMessages.some((item) => item.severity === "error")
      ? '<span class="pill danger">Compile errors</span>'
      : "";

  const versions = allSubmissions.length > 1
    ? `<div class="versions"><span class="muted">Version</span>${allSubmissions.map((item) =>
        `<button class="chip${item.version === submission.version ? " active" : ""}" data-action="version" data-version="${escapeHtml(item.version)}">${escapeHtml(item.version)}</button>`,
      ).join("")}</div>`
    : "";

  const showProblem = entries.length > 1;
  const failureList = failures.length
    ? `<h2>Failing tests <span class="count">${failures.length}</span></h2>
      <ul class="issues">${failures.map(({ entry, failure }) => failureItem(failure, showProblem ? entry.problem : undefined)).join("")}</ul>`
    : "";
  const compilerList = compilerMessages.length
    ? `<h2>Compiler messages <span class="count">${compilerMessages.length}</span></h2>
      <ul class="issues">${compilerMessages.map(compilerItem).join("")}</ul>`
    : "";
  const hasFindings = Boolean(failures.length || compilerMessages.length);

  return page(nonce, `
    <header>
      <h1>${escapeHtml(details.display_name)}</h1>
      <div class="score-line"><span class="score">${escapeHtml(scoreText)}</span>${status}</div>
    </header>
    <div class="actions"><button data-action="submit" class="primary">Submit again</button><button data-action="assessment">Lab details</button></div>
    ${versions}
    ${failureList}
    ${compilerList}
    ${problems.length > 1 || Object.keys(submission.scores).length > 1 ? resultsScoreTable(submission, problems) : ""}
    ${rawOutput(entries, feedback, !hasFindings)}
    ${hasFindings ? '<p class="muted note">Links open your current local files, which may have changed since this version was submitted.</p>' : ""}
  `, true);
}

function uniqueFeedback(feedback: ProblemFeedback[]): ProblemFeedback[] {
  return feedback.filter((entry, index) => entry.text?.trim() && feedback.findIndex((other) => other.text === entry.text) === index);
}

function sourceButton(id: number | undefined, label: string, title: string): string {
  return id === undefined
    ? ""
    : `<button class="source-link" data-action="source" data-location="${id}" title="${escapeHtml(title)}">${escapeHtml(label)}</button>`;
}

function failureItem(failure: LocatedFailure, problem?: string): string {
  const target = failure.target;
  const fileName = target ? target.localFile.split(/[\/]/).pop() ?? target.localFile : "";
  const link = target
    ? sourceButton(failure.targetId, `${target.symbol ? `${target.symbol}() · ` : ""}${fileName}:${target.line}`,
      target.symbol ? `Open the ${target.symbol} method this test exercises` : "Open the line the autograder reported")
    : "";
  const comparison = failure.expected !== undefined || failure.actual !== undefined
    ? `<div class="compare"><span>Expected</span><code>${escapeHtml(failure.expected ?? "")}</code><span>Got</span><code>${escapeHtml(failure.actual ?? "")}</code></div>`
    : "";
  return `<li class="issue">
    <div class="issue-head"><span class="mark error" aria-hidden="true">✕</span><span class="name">${escapeHtml(failure.test)}</span>${problem ? `<span class="muted">${escapeHtml(problem)}</span>` : ""}</div>
    ${failure.message ? `<div class="message">${escapeHtml(failure.message)}</div>` : ""}
    ${comparison}
    ${link ? `<div class="where">${link}</div>` : ""}
  </li>`;
}

function compilerItem(location: ResolvedFeedbackLocation & { id: number }): string {
  const fileName = location.localFile.split(/[\/]/).pop() ?? location.file;
  return `<li class="issue">
    <div class="issue-head"><span class="mark ${location.severity === "error" ? "error" : "warning"}" aria-hidden="true">${location.severity === "error" ? "✕" : "!"}</span><span class="message">${escapeHtml(location.message)}</span></div>
    <div class="where">${sourceButton(location.id, `${fileName}:${location.line}:${location.column}`, "Open this line")}</div>
  </li>`;
}

function rawOutput(entries: ProblemFeedback[], feedback: ProblemFeedback[], open: boolean): string {
  if (!entries.length) {
    const firstError = feedback.find((entry) => entry.error)?.error;
    return `<p class="muted">${escapeHtml(firstError ?? "No feedback is available for this submission yet.")}</p>`;
  }
  return entries.map((entry) => {
    const label = entries.length === 1 ? "Full autograder output" : `${entry.problem} — full output`;
    return `<details class="raw"${open ? " open" : ""}><summary>${escapeHtml(label)}</summary><pre class="feedback">${linkedFeedback(entry)}</pre></details>`;
  }).join("");
}

function linkedFeedback(entry: ProblemFeedback): string {
  const text = entry.text ?? "";
  let html = "";
  let offset = 0;
  for (const location of entry.locations ?? []) {
    html += escapeHtml(text.slice(offset, location.start));
    html += '<button class="source-link" data-action="source" data-location="' + location.id + '" title="Open local source">' + escapeHtml(text.slice(location.start, location.end)) + '</button>';
    offset = location.end;
  }
  return html + escapeHtml(text.slice(offset));
}

function scoresTable(submission: AutolabSubmission, details?: AutolabAssessmentDetails): string {
  const rows = Object.entries(submission.scores).map(([problem, value]) => {
    const max = details?.max_scores?.[problem];
    const valueText = typeof value === "number"
      ? max === undefined ? formatNumber(value) : `${formatNumber(value)} / ${formatNumber(max)}`
      : value === "unreleased" ? "Unreleased" : "—";
    return `<tr><td>${escapeHtml(problem)}</td><td class="numeric">${escapeHtml(valueText)}</td></tr>`;
  }).join("");
  return `<section><h2>Latest submission</h2><p class="muted">Version ${escapeHtml(submission.version)} · ${escapeHtml(formatDate(submission.created_at) ?? submission.created_at)}</p><table><tbody>${rows || "<tr><td>Scores are pending</td><td>—</td></tr>"}</tbody></table></section>`;
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
  return `<section><h2>Scores</h2><table><thead><tr><th>Problem</th><th class="numeric">Score</th></tr></thead><tbody>${rows || '<tr><td>Scores are pending</td><td class="numeric">—</td></tr>'}</tbody></table></section>`;
}

function page(nonce: string, body: string, script: boolean): string {
  return `<!doctype html><html lang="en"><head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style nonce="${nonce}">
      :root { color-scheme: light dark; }
      body { margin: 0; padding: 12px 12px 24px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
      h1 { margin: 6px 0 14px; font-size: 1.35rem; overflow-wrap: anywhere; line-height: 1.15; }
      h2 { margin-top: 32px; font-size: 1.15rem; }
      .eyebrow { color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .08em; font-size: .78rem; }
      .badges, .actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .badge { padding: 4px 9px; border: 1px solid var(--vscode-widget-border); border-radius: 999px; color: var(--vscode-descriptionForeground); }
      .badge.success { color: var(--vscode-testing-iconPassed); }
      .badge.danger, .warning { color: var(--vscode-errorForeground); }
      .actions { margin: 26px 0; }
      button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 5px 9px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); cursor: pointer; font-family: inherit; font-size: inherit; }
      button:hover { background: var(--vscode-button-secondaryHoverBackground); }
      button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
      button.primary:hover { background: var(--vscode-button-hoverBackground); }
      button:disabled { opacity: .45; cursor: not-allowed; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: 10px; }
      .fact { padding: 14px; border: 1px solid var(--vscode-widget-border); border-radius: 5px; background: var(--vscode-editorWidget-background); overflow-wrap: anywhere; }
      .fact span { display: block; color: var(--vscode-descriptionForeground); font-size: .78rem; margin-bottom: 5px; }
      .description { white-space: pre-wrap; line-height: 1.55; }
      table { overflow-wrap: anywhere; border-collapse: collapse; width: 100%; margin-top: 10px; }
      th, td { border-bottom: 1px solid var(--vscode-widget-border); text-align: left; padding: 9px 4px; }
      .numeric { text-align: right; font-variant-numeric: tabular-nums; }
      .muted { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
      code { font-family: var(--vscode-editor-font-family); }
      .empty { padding: 18px; border: 1px dashed var(--vscode-widget-border); border-radius: 5px; color: var(--vscode-descriptionForeground); }
      .score-line { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
      .score { font-size: 1.6rem; font-weight: 600; font-variant-numeric: tabular-nums; }
      .pill { padding: 2px 8px; border-radius: 999px; font-size: .85rem; border: 1px solid currentColor; }
      .pill.danger { color: var(--vscode-errorForeground); }
      .versions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: -12px 0 8px; }
      .versions .muted { margin-right: 4px; }
      .chip { min-width: 2.2em; padding: 2px 6px; }
      .chip.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
      .count { color: var(--vscode-descriptionForeground); font-weight: normal; }
      ul.issues { list-style: none; margin: 8px 0 0; padding: 0; }
      .issue { padding: 10px 0 10px 2px; border-bottom: 1px solid var(--vscode-widget-border); }
      .issue:last-child { border-bottom: 0; }
      .issue-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .issue .name { font-weight: 600; font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
      .mark { width: 1em; flex: none; text-align: center; font-weight: 700; }
      .mark.error { color: var(--vscode-errorForeground); }
      .mark.warning { color: var(--vscode-editorWarning-foreground); }
      .issue .message { margin: 4px 0 0 calc(1em + 8px); white-space: pre-wrap; overflow-wrap: anywhere; }
      .issue-head .message { margin: 0; }
      .compare { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 6px 0 0 calc(1em + 8px); }
      .compare span { color: var(--vscode-descriptionForeground); }
      .compare code { overflow-wrap: anywhere; }
      .where { margin: 6px 0 0 calc(1em + 8px); }
      .note { margin-top: 18px; font-size: .9em; }
      details.raw { margin-top: 28px; }
      details.raw summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
      .source-link { display: inline; padding: 0; border: 0; background: transparent; color: var(--vscode-textLink-foreground); text-decoration: underline; font: inherit; text-align: left; white-space: pre-wrap; }
      .source-link:hover { background: transparent; }
      .feedback { white-space: pre-wrap; word-break: break-word; max-height: 30rem; overflow: auto; padding: 12px; margin: 8px 0 0; border-radius: 4px; background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.45; }
    </style></head><body>${body}
    ${script ? `<script nonce="${nonce}">const vscode = acquireVsCodeApi(); document.addEventListener('click', (event) => { const button = event.target.closest('button[data-action]'); if (button && !button.disabled) vscode.postMessage({ action: button.dataset.action, version: button.dataset.version ? Number(button.dataset.version) : undefined, location: button.dataset.location !== undefined ? Number(button.dataset.location) : undefined }); });</script>` : ""}
  </body></html>`;
}

export function loadingHtml(message: string): string {
  return page(getNonce(), `<div class="empty">${escapeHtml(message)}</div>`, false);
}

export function errorHtml(message: string): string {
  return page(getNonce(), `<button data-action="assessment">Lab details</button><button data-action="refresh">Retry</button><p class="warning">${escapeHtml(message)}</p>`, true);
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
