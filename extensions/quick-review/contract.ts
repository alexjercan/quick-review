/**
 * Versioned Quick Review contract.
 *
 * Three artifacts carry a version from day one: the walkthrough Markdown
 * document, the review state file, and the completion event. Consumers must
 * refuse versions they do not know.
 */

export const ARTIFACT_VERSION = 1;
export const STATE_VERSION = 1;
export const COMPLETION_VERSION = 1;

export const LIMITS = {
  /** Maximum size of the walkthrough Markdown artifact. */
  artifact: 256 * 1024,
  /** Maximum number of reviewed changes in one walkthrough. */
  sections: 40,
  /** Maximum size of one review prompt inside a change. */
  prompt: 4096,
  /** Maximum size of one reviewer comment or question. */
  comment: 4096,
  /** Maximum size of one agent answer. */
  answer: 16 * 1024,
  /** Maximum size of exact-revision file context. */
  context: 128 * 1024,
  /** Maximum size of the base-to-target patch. */
  patch: 512 * 1024,
  /** Maximum size of one action request body. */
  request: 16 * 1024,
  /** Maximum size of the outcome message handed back to the session agent. */
  outcome: 32 * 1024,
  /** Maximum size of the persisted review state file. */
  state: 256 * 1024,
  /** Maximum number of recorded questions. */
  questions: 100,
  /** Maximum length of a git ref argument. */
  ref: 256,
} as const;

export const SHA = /^[0-9a-f]{40}$/;
export const SECTION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RECORD_ID = /^[0-9a-f]{24}$/;
/** Relative, non-escaping, backslash-free repository path. */
export const SAFE_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[^\x00-\x1f\x7f]+$/;
export const LINE_RANGE = /^(?:[1-9][0-9]*)(?:-[1-9][0-9]*)?$/;

export type Importance = "critical" | "important" | "supporting";
export type SectionState = "not-reviewed" | "viewed" | "needs-explanation";
export type ReviewOutcome = "open" | "approved" | "changes-requested";

export interface WalkthroughSection {
  id: string;
  importance: Importance;
  file: string;
  lines: string;
  markdown: string;
  diff: string;
  prompt: string;
}

export interface WalkthroughDocument {
  version: number;
  title: string;
  summary: string;
  revision: string;
  baseRevision: string;
  files: number;
  added: number;
  removed: number;
  sections: WalkthroughSection[];
  warnings: string[];
  /** SHA-256 of the exact artifact text. Binds review state to one artifact. */
  identity: string;
  source: string;
}

export interface ReviewComment {
  id: string;
  sectionId: string;
  file: string;
  lines: string;
  body: string;
}

export interface ReviewQuestion {
  sectionId: string;
  question: string;
  answer: string;
}

export interface ReviewState {
  version: number;
  identity: string;
  revision: string;
  baseRevision: string;
  sections: Record<string, SectionState>;
  viewed: Record<string, boolean>;
  questions: ReviewQuestion[];
  comments: ReviewComment[];
  outcome: ReviewOutcome;
}

/** Inputs that define one review range. */
export interface ReviewInputs {
  repository: string;
  baseRef: string;
  targetRef: string;
  baseRevision: string;
  revision: string;
}

export interface CompletionEvent {
  version: number;
  outcome: "approved" | "changes-requested";
  repository: string;
  baseRef: string;
  targetRef: string;
  baseRevision: string;
  revision: string;
  identity: string;
  sections: number;
  comments: Array<Omit<ReviewComment, "id">>;
  overallComment: string;
  questions: ReviewQuestion[];
  artifact: string;
  state: string;
  completedAt: string;
}

export const COMPLETION_EVENT = "quick-review:completed";

/**
 * Raised when a terminal decision is already durable.
 *
 * The completion file is created exclusively, so this is the one failure that
 * must never reopen a review: the decision it reports already happened.
 */
export function committedError(): Error {
  const error = new Error("this review already has a terminal action");
  (error as { quickReviewCommitted?: boolean }).quickReviewCommitted = true;
  return error;
}

export function isCommitted(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { quickReviewCommitted?: boolean }).quickReviewCommitted === true
  );
}

/** Truncate on a UTF-8 boundary so byte limits hold for any script. */
export function bounded(value: string, maximum: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maximum) return value;
  return buffer
    .subarray(0, maximum)
    .toString("utf8")
    .replace(/\ufffd$/, "");
}
