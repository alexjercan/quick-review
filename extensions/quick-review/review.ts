/**
 * One review, end to end: plan a range, store the artifact bundle, and wire the
 * page actions to git and to whichever agent hosts the session.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  committedError,
  COMPLETION_VERSION,
  LIMITS,
  type CompletionEvent,
  type ReviewInputs,
  type ReviewState,
  type WalkthroughDocument,
  type WalkthroughSection,
} from "./contract.ts";
import * as git from "./git.ts";
import { startReviewServer, type ReviewServer } from "./server.ts";
import { initialState, saveState } from "./state.ts";

export interface ReviewPlan {
  inputs: ReviewInputs;
  /** True when the reviewer named the base ref instead of taking the default. */
  baseExplicit: boolean;
  files: number;
  added: number;
  removed: number;
  subject: string;
  dirty: boolean;
  directory: string;
  artifactPath: string;
  statePath: string;
  patchPath: string;
  completionPath: string;
  patch: string;
}

export interface ReviewHost {
  /** Route one reviewer question to the agent that owns this session. */
  ask(question: {
    sectionId: string;
    question: string;
    section: WalkthroughSection;
  }): Promise<string>;
  /** Deliver the terminal outcome, with any post-commit cleanup warning. */
  complete(event: CompletionEvent, warning?: string): Promise<void> | void;
}

export interface OpenReview {
  document: WalkthroughDocument;
  state: ReviewState;
  plan: ReviewPlan;
  server: ReviewServer;
  url: string;
}

function stateRoot(): string {
  const override = process.env.QUICK_REVIEW_STATE_DIR;
  if (override) return override;
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "quick-review");
}

function writeNew(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export interface PlanOptions {
  cwd: string;
  repository?: string;
  baseRef?: string;
  targetRef?: string;
}

/** Resolve the reviewed range and capture the exact patch. */
export async function planReview(options: PlanOptions): Promise<ReviewPlan> {
  const repository = await git.resolveRepository(
    options.repository ?? options.cwd,
  );
  const targetRef = options.targetRef ?? "HEAD";
  const revision = await git.resolveCommit(repository, targetRef);
  const baseRef = options.baseRef ?? (await git.defaultBranch(repository));
  const baseRevision = options.baseRef
    ? await git.resolveCommit(repository, options.baseRef)
    : await git.mergeBase(repository, baseRef, revision);
  if (baseRevision === revision)
    throw new Error(
      `nothing to review: ${baseRef} and ${targetRef} resolve to the same commit`,
    );
  const patch = await git.patch(repository, baseRevision, revision);
  if (!patch.trim())
    throw new Error(`nothing to review between ${baseRef} and ${targetRef}`);
  const stat = await git.diffStat(repository, baseRevision, revision);
  // Every fallible lookup happens before the directory exists, so the only
  // work the rollback has to cover is writing the patch.
  const subject = await git.subject(repository, revision);
  const dirty = await git.isDirty(repository);
  return withReviewDirectory(
    stateRoot(),
    () => `${revision.slice(0, 12)}-${randomBytes(8).toString("hex")}`,
    (directory) => {
      const plan: ReviewPlan = {
        inputs: { repository, baseRef, targetRef, baseRevision, revision },
        baseExplicit: options.baseRef !== undefined,
        ...stat,
        subject,
        dirty,
        directory,
        artifactPath: join(directory, "walkthrough.md"),
        statePath: join(directory, "state.json"),
        patchPath: join(directory, "patch.diff"),
        completionPath: join(directory, "completion.json"),
        patch,
      };
      writeNew(plan.patchPath, patch);
      return plan;
    },
  );
}

/** How many names to try before giving up on claiming a review directory. */
const CLAIM_ATTEMPTS = 8;

/**
 * Claim a fresh review directory, and remove it again if setup fails.
 *
 * The directory is created exclusively, never recursively, so an existing
 * review is never adopted: a name that is already taken is retried with a new
 * random one. Rollback then removes only the directory this call proved it
 * created, so a planning failure can never touch another review's record.
 */
export function withReviewDirectory<T>(
  root: string,
  name: () => string,
  work: (directory: string) => T,
): T {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const directory = join(root, name());
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      return work(directory);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error(
    `could not claim a review directory under ${root} after ${CLAIM_ATTEMPTS} attempts`,
  );
}

/**
 * Fail unless the reviewed range still resolves to the planned revisions.
 *
 * The target is read on both sides of the base lookup, so a target that moves
 * while the base is being resolved cannot slip through as one consistent
 * snapshot. An explicit base must still resolve exactly; only a defaulted base
 * may fall back to merge-base semantics, because that is how it was derived.
 */
export async function verifyRange(
  plan: ReviewPlan,
  signal?: AbortSignal,
): Promise<void> {
  const { repository, baseRef, targetRef, baseRevision, revision } =
    plan.inputs;
  const moved = new Error(
    "the reviewed revision changed; run /quick-review again",
  );
  // A cancelled lookup must surface as a cancellation, not as a missing ref.
  const optional = (error: unknown) => {
    if (signal?.aborted) throw error;
    return undefined;
  };
  if ((await git.resolveCommit(repository, targetRef, signal)) !== revision)
    throw moved;
  const base = await git
    .resolveCommit(repository, baseRef, signal)
    .catch(optional);
  if (base !== baseRevision) {
    if (plan.baseExplicit)
      throw new Error(
        `${baseRef} no longer resolves to the reviewed base revision; run /quick-review again`,
      );
    const merge = await git
      .mergeBase(repository, baseRef, revision, signal)
      .catch(optional);
    if (merge !== baseRevision)
      throw new Error("the base revision changed; run /quick-review again");
  }
  if ((await git.resolveCommit(repository, targetRef, signal)) !== revision)
    throw moved;
}

async function exactContext(
  plan: ReviewPlan,
  section: WalkthroughSection,
  signal?: AbortSignal,
): Promise<string> {
  const { repository, revision, baseRevision } = plan.inputs;
  const current = await git.showFile(
    repository,
    revision,
    section.file,
    signal,
  );
  if (current !== undefined)
    return `Exact revision ${revision}\n${"-".repeat(60)}\n${current}`;
  const before = await git.showFile(
    repository,
    baseRevision,
    section.file,
    signal,
  );
  if (before !== undefined)
    return `Exact base revision ${baseRevision}\n${"-".repeat(60)}\n${before}`;
  return "Context unavailable at either exact revision.";
}

function completion(
  plan: ReviewPlan,
  document: WalkthroughDocument,
  state: ReviewState,
  outcome: "approved" | "changes-requested",
  overallComment: string,
  completedAt: string,
): CompletionEvent {
  return {
    version: COMPLETION_VERSION,
    outcome,
    ...plan.inputs,
    identity: document.identity,
    sections: document.sections.length,
    comments: state.comments.map(({ sectionId, file, lines, body }) => ({
      sectionId,
      file,
      lines,
      body,
    })),
    overallComment: overallComment.trim(),
    questions: [...state.questions],
    artifact: plan.artifactPath,
    state: plan.statePath,
    completedAt,
  };
}

/**
 * Remove the artifact and state so a stale walkthrough cannot be reused.
 *
 * Every deletion is attempted even when one fails, and the failures are
 * returned so the caller can report them instead of claiming a safety property
 * that did not hold.
 */
export function invalidate(plan: ReviewPlan): string[] {
  const failures: string[] = [];
  for (const path of [plan.artifactPath, plan.statePath, plan.patchPath])
    try {
      rmSync(path, { force: true });
    } catch (error) {
      failures.push(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  return failures;
}

/**
 * Drop a planned review.
 *
 * A decided review is never removed. `force` covers a plan that never became
 * an open review, including one whose page failed to start after the artifact
 * was written.
 */
export function discardPlan(plan: ReviewPlan, force = false): void {
  if (existsSync(plan.completionPath)) return;
  if (!force && existsSync(plan.artifactPath)) return;
  rmSync(plan.directory, { recursive: true, force: true });
}

export interface OpenOptions {
  now?: () => string;
  /** Abort an opening review: nothing may be left listening or on disk. */
  signal?: AbortSignal;
}

const CLOSED_WHILE_OPENING = "the review was closed while it was opening";

export async function openReview(
  plan: ReviewPlan,
  document: WalkthroughDocument,
  host: ReviewHost,
  options: OpenOptions = {},
): Promise<OpenReview> {
  const now = options.now ?? (() => new Date().toISOString());
  const { signal } = options;
  const state = initialState(document);
  try {
    if (signal?.aborted) throw new Error(CLOSED_WHILE_OPENING);
    writeNew(plan.artifactPath, document.source);
    saveState(plan.statePath, state);
    if (signal?.aborted) throw new Error(CLOSED_WHILE_OPENING);
  } catch (error) {
    discardPlan(plan, true);
    throw error;
  }

  /**
   * Commit one terminal decision.
   *
   * Creating the completion file exclusively is the commit boundary. Before it,
   * a failure leaves the review open. After it, the decision is durable, so
   * invalidation and outcome delivery may fail without reopening the review.
   */
  const finalize = async (
    outcome: "approved" | "changes-requested",
    overallComment: string,
  ): Promise<string | undefined> => {
    const event = completion(
      plan,
      document,
      state,
      outcome,
      overallComment,
      now(),
    );
    try {
      writeFileSync(
        plan.completionPath,
        `${JSON.stringify(event, null, 2)}\n`,
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw committedError();
      throw error;
    }
    let warning: string | undefined;
    if (outcome === "changes-requested") {
      const failures = invalidate(plan);
      if (failures.length > 0) {
        warning =
          "Warning: the walkthrough could not be fully removed; see cleanup-error.txt in the review directory.";
        try {
          writeFileSync(
            join(plan.directory, "cleanup-error.txt"),
            `${failures.join("\n")}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        } catch {
          /* the decision is durable; the warning still reaches the reviewer */
        }
      }
    }
    try {
      await host.complete(event, warning);
    } catch {
      /* the decision is durable; completion.json carries the outcome */
    }
    return warning;
  };

  let server;
  try {
    server = await startReviewServer(document, state, {
      verify: (signal) => verifyRange(plan, signal),
      persist: (next) => saveState(plan.statePath, next),
      context: (section, signal) => exactContext(plan, section, signal),
      fullDiff: async () => {
        const patch = readFileSync(plan.patchPath, "utf8");
        if (Buffer.byteLength(patch, "utf8") > LIMITS.patch)
          throw new Error("the exact full diff exceeds the review limit");
        return patch;
      },
      ask: (sectionId, question) =>
        host.ask({
          sectionId,
          question,
          section: document.sections.find((item) => item.id === sectionId)!,
        }),
      approve: (overallComment) => finalize("approved", overallComment),
      requestChanges: (explanation) =>
        finalize("changes-requested", explanation),
    });
  } catch (error) {
    // The page never opened, so nothing may be left behind to block a retry.
    discardPlan(plan, true);
    throw error;
  }

  // The page can finish listening after a close began. Nothing may survive it.
  if (signal?.aborted) {
    await server.close().catch(() => undefined);
    discardPlan(plan, true);
    throw new Error(CLOSED_WHILE_OPENING);
  }

  return { document, state, plan, server, url: server.url };
}
