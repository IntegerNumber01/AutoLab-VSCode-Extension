import type { AutolabAssessment, AutolabAssessmentDetails, AutolabCourse } from "./types";

/**
 * A course or lab the student added by hand.
 *
 * Autolab guards `/api/v1/courses` and the per-course assessment index behind the
 * `user_courses` scope, so an OAuth application registered without it cannot discover
 * anything. Every other endpoint the extension needs is either unguarded
 * (`assessments/:name`) or covered by `user_scores` / `user_submit`, so a student can
 * still work normally once they name the labs themselves.
 */
export interface ManualLab {
  course: string;
  /** Absent for a course-level reference, which needs the `user_courses` scope to expand. */
  assessment?: string;
}

const COURSE_PATH = /\/courses\/([^/?#]+)(?:\/assessments\/([^/?#]+))?/;

/**
 * Accepts an Autolab web URL, `course/lab`, or a bare course name.
 * `host` is only used to reject a URL that points at a different Autolab server.
 */
export function parseLabReference(input: string, host?: string): ManualLab {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Enter an Autolab course or lab URL.");
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("That does not look like a valid URL.");
    }
    if (host) {
      const configured = safeHostname(host);
      if (configured && url.hostname.toLowerCase() !== configured) {
        throw new Error(`That URL points at ${url.hostname}, but Autolab is configured for ${configured}.`);
      }
    }
    return fromPath(url.pathname, trimmed);
  }

  if (trimmed.includes("/courses/")) {
    return fromPath(trimmed, trimmed);
  }

  const parts = trimmed.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 1) {
    return { course: parts[0] };
  }
  if (parts.length === 2) {
    return { course: parts[0], assessment: parts[1] };
  }
  throw new Error(referenceHelp());
}

function fromPath(pathname: string, original: string): ManualLab {
  const match = COURSE_PATH.exec(pathname);
  if (!match) {
    throw new Error(`Could not find a course in "${original}". ${referenceHelp()}`);
  }
  return {
    course: decodeURIComponent(match[1]),
    assessment: match[2] ? decodeURIComponent(match[2]) : undefined,
  };
}

function referenceHelp(): string {
  return "Use a lab URL such as https://autolab.example.edu/courses/COURSE/assessments/LAB.";
}

function safeHostname(host: string): string | undefined {
  try {
    return new URL(host).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function formatLabReference(lab: ManualLab): string {
  return lab.assessment ? `${lab.course}/${lab.assessment}` : lab.course;
}

/** Parses configured references, dropping malformed entries so one typo cannot empty the view. */
export function parseLabReferences(values: string[]): ManualLab[] {
  const seen = new Set<string>();
  const labs: ManualLab[] = [];
  for (const value of values) {
    let lab: ManualLab;
    try {
      lab = parseLabReference(value);
    } catch {
      continue;
    }
    const key = formatLabReference(lab);
    if (!seen.has(key)) {
      seen.add(key);
      labs.push(lab);
    }
  }
  return labs;
}

/** Stands in for `/api/v1/courses` output, which needs the `user_courses` scope. */
export function placeholderCourse(name: string): AutolabCourse {
  return {
    name,
    display_name: name,
    semester: "Added by URL",
    late_slack: 0,
    grace_days: 0,
    auth_level: "student",
  };
}

/** Stands in for the assessment index until `assessments/:name` fills in the real fields. */
export function placeholderAssessment(name: string): AutolabAssessment {
  return {
    name,
    display_name: name,
    start_at: null,
    due_at: null,
    end_at: null,
  };
}

/**
 * `assessments/:name` carries every field the assessment index would have returned,
 * so a manually added lab looks identical to a discovered one once details load.
 */
export function assessmentFromDetails(
  name: string,
  details: AutolabAssessmentDetails | undefined,
): AutolabAssessment {
  const placeholder = placeholderAssessment(name);
  if (!details) {
    return placeholder;
  }
  return {
    name: details.name || placeholder.name,
    display_name: details.display_name || placeholder.display_name,
    start_at: details.start_at ?? null,
    due_at: details.due_at ?? null,
    end_at: details.end_at ?? null,
    category_name: details.category_name,
  };
}
