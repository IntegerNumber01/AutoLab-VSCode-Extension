import * as vscode from "vscode";
import { isForbidden } from "./api";
import type { AutolabApi } from "./api";
import type { SessionManager } from "./auth";
import { readSettings, validateConnectionSettings } from "./config";
import {
  assessmentFromDetails,
  parseLabReferences,
  placeholderAssessment,
  placeholderCourse,
} from "./manual";
import type { ManualLab } from "./manual";
import { findCurrentLab, localLabFor } from "./metadata";
import type {
  AutolabAssessment,
  AutolabCourse,
  AutolabSubmission,
  DashboardAssessment,
} from "./types";
import { errorMessage, formatDate, formatNumber, submissionScore } from "./utils";

/** Raised when nothing at all can be listed because the OAuth application lacks a scope. */
export class MissingScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingScopeError";
  }
}

/** What a load could not fetch, and whether a missing scope was the reason. */
interface LoadReport {
  messages: string[];
  scopeLimited: boolean;
}

export class DashboardModel implements vscode.Disposable {
  private cache: DashboardAssessment[] | undefined;
  private loading: Promise<DashboardAssessment[]> | undefined;
  private generation = 0;
  private report: LoadReport | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly sessionSubscription: vscode.Disposable;

  constructor(private readonly session: SessionManager) {
    this.sessionSubscription = session.onDidChangeSession(() => this.refresh());
  }

  dispose(): void {
    this.sessionSubscription.dispose();
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.generation += 1;
    this.cache = undefined;
    this.loading = undefined;
    this.report = undefined;
    this.changeEmitter.fire();
  }

  /** Explains anything the last load could not fetch, or undefined when it fetched everything. */
  get accessNotice(): string | undefined {
    return this.report?.messages.length ? [...new Set(this.report.messages)].join(" ") : undefined;
  }

  /** True when a missing scope, rather than a transient failure, limited the last load. */
  get isScopeLimited(): boolean {
    return this.report?.scopeLimited ?? false;
  }

  async load(): Promise<DashboardAssessment[]> {
    if (this.cache) {
      return this.cache;
    }
    if (!this.loading) {
      const generation = this.generation;
      const loading = this.loadFromApi().then((items) => {
        if (this.generation === generation) {
          this.cache = items;
        }
        return items;
      }).finally(() => {
        if (this.loading === loading) {
          this.loading = undefined;
        }
      });
      this.loading = loading;
    }
    return this.loading;
  }

  async find(course: string, assessment: string): Promise<DashboardAssessment | undefined> {
    return (await this.load()).find((item) => item.course.name === course && item.assessment.name === assessment);
  }

  private async loadFromApi(): Promise<DashboardAssessment[]> {
    validateConnectionSettings();
    if (!(await this.session.hasSession())) {
      throw new Error("Sign in to see your labs.");
    }

    this.report = undefined;
    const api = this.session.api();
    const manualLabs = parseLabReferences(readSettings().courses);
    const report: LoadReport = { messages: [], scopeLimited: false };
    const plans = await this.planCourses(api, manualLabs, report);

    const items = await Promise.all(plans.flatMap(({ course, entries }) =>
      entries.map(async ({ assessment, discovered }): Promise<DashboardAssessment> => {
        const [detailsResult, submissionsResult, localLab] = await Promise.all([
          attempt(api.getAssessment(course.name, assessment.name)),
          attempt(api.getSubmissions(course.name, assessment.name)),
          localLabFor(course.name, assessment.name),
        ]);
        const errors = [detailsResult.error, submissionsResult.error].filter(Boolean);
        return {
          course,
          // A manually added lab starts as a bare name; its real fields come from the details call.
          assessment: discovered ? assessment : assessmentFromDetails(assessment.name, detailsResult.value),
          details: detailsResult.value,
          submissions: submissionsResult.value ?? [],
          localPath: localLab?.directory,
          localArtifacts: localLab?.metadata.artifacts,
          error: errors.length ? errors.join(" ") : undefined,
        };
      }),
    ));

    this.report = report;
    return items.sort((left, right) => {
      const leftDue = Date.parse(left.assessment.due_at ?? "") || Number.MAX_SAFE_INTEGER;
      const rightDue = Date.parse(right.assessment.due_at ?? "") || Number.MAX_SAFE_INTEGER;
      return leftDue - rightDue;
    });
  }

  /**
   * Works out which labs to load. Discovery uses `/courses` and the per-course assessment
   * index, both of which need the `user_courses` scope; whatever they refuse is filled in
   * from the labs the student added by URL.
   */
  private async planCourses(api: AutolabApi, manualLabs: ManualLab[], report: LoadReport): Promise<CoursePlan[]> {
    let discoveredCourses: AutolabCourse[] | undefined;
    try {
      discoveredCourses = await api.getCourses();
    } catch (error) {
      if (!isForbidden(error)) {
        throw error;
      }
      if (!manualLabs.length) {
        throw new MissingScopeError(
          "This Autolab application cannot list your courses because it is missing the user_courses scope. Add a lab by URL to keep working, or ask your instructor to add the scope.",
        );
      }
      report.scopeLimited = true;
      report.messages.push("Your courses cannot be listed with this Autolab application, so only labs added by URL are shown.");
    }

    const courses = new Map<string, AutolabCourse>();
    for (const course of discoveredCourses ?? []) {
      courses.set(course.name, course);
    }
    for (const lab of manualLabs) {
      if (!courses.has(lab.course)) {
        courses.set(lab.course, placeholderCourse(lab.course));
      }
    }

    return Promise.all([...courses.values()].map(async (course) => {
      const manualNames = manualLabs
        .filter((lab) => lab.course === course.name && lab.assessment)
        .map((lab) => lab.assessment as string);

      let discovered: AutolabAssessment[] | undefined;
      try {
        discovered = await api.getAssessments(course.name);
      } catch (error) {
        if (!isForbidden(error)) {
          report.messages.push(errorMessage(error));
        } else if (!manualNames.length) {
          report.scopeLimited = true;
          report.messages.push(`Labs in ${course.display_name} cannot be listed with this Autolab application. Add one by URL.`);
        }
      }

      const entries = new Map<string, CourseEntry>();
      for (const assessment of discovered ?? []) {
        entries.set(assessment.name, { assessment, discovered: true });
      }
      for (const name of manualNames) {
        if (!entries.has(name)) {
          entries.set(name, { assessment: placeholderAssessment(name), discovered: false });
        }
      }
      return { course, entries: [...entries.values()] };
    }));
  }
}

interface CourseEntry {
  assessment: AutolabAssessment;
  /** False for a lab added by URL, whose fields are not known until details load. */
  discovered: boolean;
}

interface CoursePlan {
  course: AutolabCourse;
  entries: CourseEntry[];
}

interface Attempt<T> {
  value?: T;
  error?: string;
}

async function attempt<T>(promise: Promise<T>): Promise<Attempt<T>> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

type AssignmentNode = GroupNode | AssessmentNode | MessageNode;

interface GroupNode {
  type: "group";
  label: string;
  description: string;
  icon: string;
  contextValue: string;
  assessments: DashboardAssessment[];
}

interface AssessmentNode {
  type: "assessment";
  item: DashboardAssessment;
}

interface MessageNode {
  type: "message";
  label: string;
  command?: vscode.Command;
  icon?: string;
}

export class AssignmentsProvider implements vscode.TreeDataProvider<AssignmentNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<AssignmentNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly modelSubscription: vscode.Disposable;

  constructor(private readonly model: DashboardModel) {
    this.modelSubscription = model.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  dispose(): void {
    this.modelSubscription.dispose();
    this.changeEmitter.dispose();
  }

  /** Redraws the tree from the cached model, for changes that need no new network calls. */
  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: AssignmentNode): vscode.TreeItem {
    if (node.type === "message") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.command = node.command;
      item.tooltip = node.label;
      item.iconPath = new vscode.ThemeIcon(node.icon ?? (node.command ? "sign-in" : "info"));
      return item;
    }

    if (node.type === "group") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = node.description;
      item.tooltip = `${node.label}\n${node.description}\n${node.assessments.length} labs`;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.contextValue = node.contextValue;
      return item;
    }

    const { item: assessment } = node;
    const treeItem = new vscode.TreeItem(assessment.assessment.display_name, vscode.TreeItemCollapsibleState.None);
    treeItem.description = assessmentDescription(assessment);
    treeItem.tooltip = assessmentTooltip(assessment);
    treeItem.iconPath = assessmentIcon(assessment);
    treeItem.contextValue = assessment.localPath ? "autolabAssessmentDownloaded" : "autolabAssessment";
    treeItem.command = {
      command: "autolab.showAssessment",
      title: "Show Lab",
      arguments: [assessment.course.name, assessment.assessment.name],
    };
    return treeItem;
  }

  async getChildren(node?: AssignmentNode): Promise<AssignmentNode[]> {
    if (node?.type === "group") {
      return node.assessments.map((item) => ({ type: "assessment", item }));
    }
    if (node) {
      return [];
    }

    try {
      const items = await this.model.load();
      const notice = this.model.accessNotice;
      const noticeNodes: AssignmentNode[] = notice
        ? [{
          type: "message",
          label: notice,
          icon: "warning",
          // Adding a lab by hand only helps when a missing scope, not a failed request, hid it.
          command: this.model.isScopeLimited
            ? { command: "autolab.addLab", title: "Add Lab by URL" }
            : { command: "autolab.refresh", title: "Refresh" },
        }]
        : [];
      if (!items.length) {
        return [...noticeNodes, { type: "message", label: "No released labs found." }];
      }
      const groups = readSettings().groupBy === "status" ? groupByStatus(items) : groupByCourse(items);
      return [...groups, ...noticeNodes];
    } catch (error) {
      if (error instanceof MissingScopeError) {
        return [{
          type: "message",
          label: errorMessage(error),
          icon: "warning",
          command: { command: "autolab.addLab", title: "Add Lab by URL" },
        }];
      }
      const configured = Boolean(readSettings().host && readSettings().clientId);
      return [{
        type: "message",
        label: errorMessage(error),
        command: { command: configured ? "autolab.signIn" : "autolab.setup", title: configured ? "Sign In" : "Set Up Autolab" },
      }];
    }
  }
}

export class AccountProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly sessionSubscription: vscode.Disposable;

  constructor(private readonly session: SessionManager) {
    this.sessionSubscription = session.onDidChangeSession(() => this.refresh());
  }

  dispose(): void {
    this.sessionSubscription.dispose();
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const settings = readSettings();
    if (!settings.host || !settings.clientId) {
      return [actionItem("Set up Autolab", "autolab.setup", "rocket")];
    }

    let signedIn = false;
    try {
      signedIn = await this.session.hasSession();
    } catch {
      // The server URL validation error is shown in the setup item.
    }
    if (!signedIn) {
      return [
        actionItem("Sign in", "autolab.signIn", "sign-in"),
        detailItem("Server", settings.host, "server"),
        detailItem("Workspace", settings.workspaceFolder || "Not selected", "folder"),
      ];
    }

    try {
      const user = await this.session.api().getUser();
      return [
        detailItem(`${user.first_name} ${user.last_name}`, user.email, "account"),
        detailItem("Server", settings.host, "server"),
        detailItem("Workspace", settings.workspaceFolder || "Not selected", "folder"),
        actionItem("Sign out", "autolab.signOut", "sign-out"),
      ];
    } catch (error) {
      return [
        actionItem(errorMessage(error), "autolab.signIn", "warning"),
        detailItem("Server", settings.host, "server"),
      ];
    }
  }
}

type SubmissionNode = SubmissionVersionNode | SubmissionScoreNode | MessageNode;

interface SubmissionVersionNode {
  type: "submission";
  submission: AutolabSubmission;
  course: string;
  assessment: string;
}

interface SubmissionScoreNode {
  type: "score";
  problem: string;
  score: string;
  parent: SubmissionVersionNode;
}

export class SubmissionsProvider implements vscode.TreeDataProvider<SubmissionNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<SubmissionNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly sessionSubscription: vscode.Disposable;

  constructor(private readonly session: SessionManager) {
    this.sessionSubscription = session.onDidChangeSession(() => this.refresh());
  }

  dispose(): void {
    this.sessionSubscription.dispose();
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: SubmissionNode): vscode.TreeItem {
    if (node.type === "message") {
      const item = new vscode.TreeItem(node.label);
      item.command = node.command;
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }
    if (node.type === "submission") {
      const item = new vscode.TreeItem(`Version ${node.submission.version}`, vscode.TreeItemCollapsibleState.Expanded);
      const score = submissionScore(node.submission);
      item.description = score.hasNumericScore ? formatNumber(score.earned) : formatDate(node.submission.created_at);
      item.tooltip = `${node.submission.filename}\nSubmitted ${formatDate(node.submission.created_at) ?? node.submission.created_at}`;
      item.iconPath = new vscode.ThemeIcon(score.hasNumericScore ? "check" : "clock");
      item.contextValue = "autolabSubmission";
      item.command = {
        command: "autolab.showResults",
        title: "Show Results",
        arguments: [node.course, node.assessment, node.submission.version],
      };
      return item;
    }

    const item = new vscode.TreeItem(node.problem);
    item.description = node.score;
    item.iconPath = new vscode.ThemeIcon(node.score === "Unreleased" ? "eye-closed" : "symbol-number");
    item.command = {
      command: "autolab.showResults",
      title: "Show Feedback",
      arguments: [node.parent.course, node.parent.assessment, node.parent.submission.version],
    };
    return item;
  }

  async getChildren(node?: SubmissionNode): Promise<SubmissionNode[]> {
    if (node?.type === "submission") {
      return Object.entries(node.submission.scores).map(([problem, value]) => ({
        type: "score",
        problem,
        score: typeof value === "number" ? formatNumber(value) : value === "unreleased" ? "Unreleased" : "—",
        parent: node,
      }));
    }
    if (node) {
      return [];
    }

    const lab = await findCurrentLab();
    if (!lab) {
      return [{ type: "message", label: "Open a downloaded lab to see submissions." }];
    }
    if (lab.metadata.host !== readSettings().host) {
      return [{
        type: "message",
        label: `This lab belongs to ${lab.metadata.host}. Switch Autolab servers to load its submissions.`,
        command: { command: "autolab.setup", title: "Switch Autolab Server" },
      }];
    }
    try {
      const submissions = await this.session.api().getSubmissions(lab.metadata.course, lab.metadata.assessment);
      if (!submissions.length) {
        return [{
          type: "message",
          label: "No submissions yet — submit this lab when ready.",
          command: { command: "autolab.submit", title: "Submit Lab" },
        }];
      }
      return submissions.map((submission) => ({
        type: "submission",
        submission,
        course: lab.metadata.course,
        assessment: lab.metadata.assessment,
      }));
    } catch (error) {
      return [{ type: "message", label: errorMessage(error) }];
    }
  }
}

function groupByCourse(items: DashboardAssessment[]): GroupNode[] {
  const courses = new Map<string, GroupNode>();
  for (const item of items) {
    const existing = courses.get(item.course.name) ?? {
      type: "group" as const,
      label: item.course.display_name,
      description: item.course.semester,
      icon: "book",
      contextValue: "autolabCourse",
      assessments: [],
    };
    existing.assessments.push(item);
    courses.set(item.course.name, existing);
  }
  return [...courses.values()];
}

type LabStatus = "todo" | "awaiting" | "graded" | "upcoming" | "closed";

const STATUS_GROUPS: { status: LabStatus; label: string; icon: string }[] = [
  { status: "todo", label: "To do", icon: "circle-outline" },
  { status: "awaiting", label: "Awaiting score", icon: "clock" },
  { status: "graded", label: "Graded", icon: "check" },
  { status: "upcoming", label: "Not open yet", icon: "lock" },
  { status: "closed", label: "Closed", icon: "archive" },
];

function groupByStatus(items: DashboardAssessment[]): GroupNode[] {
  const buckets = new Map<LabStatus, DashboardAssessment[]>();
  for (const item of items) {
    const status = labStatus(item);
    buckets.set(status, [...(buckets.get(status) ?? []), item]);
  }

  return STATUS_GROUPS.flatMap(({ status, label, icon }) => {
    const assessments = buckets.get(status);
    if (!assessments?.length) {
      return [];
    }
    return [{
      type: "group" as const,
      label,
      description: `${assessments.length}`,
      icon,
      contextValue: "autolabStatusGroup",
      assessments,
    }];
  });
}

function labStatus(item: DashboardAssessment): LabStatus {
  const now = Date.now();
  const starts = Date.parse(item.assessment.start_at ?? "");
  if (starts && starts > now) {
    return "upcoming";
  }

  const score = submissionScore(item.submissions[0]);
  if (score.hasNumericScore) {
    return "graded";
  }
  if (item.submissions.length) {
    return "awaiting";
  }

  const ends = Date.parse(item.assessment.end_at ?? "");
  return (ends && ends < now) || item.details?.disable_handins ? "closed" : "todo";
}

function actionItem(label: string, command: string, icon: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.command = { command, title: label };
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function detailItem(label: string, description: string, icon: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label);
  item.description = description;
  item.tooltip = description;
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

function assessmentDescription(item: DashboardAssessment): string {
  const latest = item.submissions[0];
  const score = submissionScore(latest);
  const max = item.details?.max_total_score;
  const parts: string[] = [];
  if (score.hasNumericScore) {
    parts.push(max !== null && max !== undefined ? `${formatNumber(score.earned)} / ${formatNumber(max)}` : formatNumber(score.earned));
  } else if (score.hasUnreleasedScore) {
    parts.push("Score unreleased");
  } else if (latest) {
    parts.push("Submitted");
  } else {
    parts.push("Not submitted");
  }
  const due = formatDate(item.assessment.due_at);
  if (due) {
    parts.push(`Due ${due}`);
  }
  if (item.localPath) {
    parts.push("Downloaded");
  }
  return parts.join(" • ");
}

function assessmentTooltip(item: DashboardAssessment): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${item.assessment.display_name}**  \n`);
  tooltip.appendMarkdown(`${item.course.display_name}  \n`);
  tooltip.appendMarkdown(`${assessmentDescription(item)}  \n`);
  if (item.details?.description) {
    tooltip.appendText(item.details.description);
  }
  if (item.error) {
    tooltip.appendMarkdown(`  \n$(warning) ${item.error}`);
  }
  return tooltip;
}

function assessmentIcon(item: DashboardAssessment): vscode.ThemeIcon {
  if (item.error) {
    return new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
  }
  const now = Date.now();
  const starts = Date.parse(item.assessment.start_at ?? "");
  const ends = Date.parse(item.assessment.end_at ?? "");
  if (starts && starts > now) {
    return new vscode.ThemeIcon("lock");
  }
  if (ends && ends < now) {
    return new vscode.ThemeIcon("archive");
  }
  return new vscode.ThemeIcon(item.submissions.length ? "check" : "circle-outline");
}
