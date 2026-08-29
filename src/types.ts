export interface AutolabUser {
  first_name: string;
  last_name: string;
  email: string;
  school?: string | null;
  major?: string | null;
  year?: string | null;
}

export interface AutolabCourse {
  name: string;
  display_name: string;
  semester: string;
  late_slack: number;
  grace_days: number;
  auth_level: "student" | "course_assistant" | "instructor" | string;
}

export interface AutolabAssessment {
  name: string;
  display_name: string;
  start_at: string | null;
  due_at: string | null;
  end_at: string | null;
  category_name?: string | null;
}

export interface AutolabAssessmentDetails extends AutolabAssessment {
  description?: string | null;
  updated_at?: string | null;
  max_grace_days?: number | null;
  max_submissions?: number | null;
  disable_handins?: boolean;
  group_size?: number | null;
  writeup_format?: "file" | "url" | "none";
  handout_format?: "file" | "url" | "none";
  has_scoreboard?: boolean;
  has_autograder?: boolean;
  max_unpenalized_submissions?: number | null;
  max_total_score?: number | null;
  max_scores?: Record<string, number>;
}

export interface AutolabProblem {
  name: string;
  description?: string | null;
  max_score: number;
  optional?: boolean;
  starred?: boolean;
}

export type AutolabScore = number | "unreleased" | string | null;

export interface AutolabSubmission {
  version: number;
  filename: string;
  created_at: string;
  scores: Record<string, AutolabScore>;
}

export interface SubmitResult {
  version: number;
  filename: string;
}

export type AttachmentResponse =
  | { kind: "file"; filename: string; contentType: string; data: Uint8Array }
  | { kind: "url"; url: string }
  | { kind: "none" };

export interface SessionTokens {
  host: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface LabArtifact {
  kind: "handout" | "writeup";
  format: "file" | "url" | "none";
  filename?: string;
  url?: string;
  extracted?: boolean;
}

export interface LabMetadata {
  version: 1;
  host: string;
  course: string;
  courseDisplayName: string;
  assessment: string;
  assessmentDisplayName: string;
  downloadedAt: string;
  artifacts: LabArtifact[];
  /** Packaging choice from the last successful submission, offered first next time. */
  submissionFormat?: Exclude<SubmissionFormat, "ask">;
}

export interface DashboardAssessment {
  course: AutolabCourse;
  assessment: AutolabAssessment;
  details?: AutolabAssessmentDetails;
  submissions: AutolabSubmission[];
  localPath?: string;
  localArtifacts?: LabArtifact[];
  error?: string;
}

export type LabGrouping = "course" | "status";

export type SubmissionFormat = "ask" | "zip" | "tar.gz" | "file";
