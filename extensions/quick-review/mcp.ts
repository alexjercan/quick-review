/**
 * Quick Review over MCP: a stdio server for hosts that cannot be interrupted.
 *
 * The Pi extension drives the agent. Here the agent drives: it starts a review,
 * submits the walkthrough, then calls `quick_review_wait` to collect whatever
 * the reviewer does next. The review itself is the same one, opened by the same
 * `openReview`, against the same exact revisions.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { openBrowser } from "./browser.ts";
import { LIMITS, SHA } from "./contract.ts";
import { createQueueHost, type QueueHost } from "./host.ts";
import {
  invalidParams,
  methodNotFound,
  serve,
  type Dispatch,
} from "./jsonrpc.ts";
import {
  buildCompletionMessage,
  buildPrompt,
  buildQuestionPrompt,
} from "./prompt.ts";
import {
  discardPlan,
  openReview,
  planReview,
  verifyRange,
  type OpenReview,
  type ReviewPlan,
} from "./review.ts";
import { assertWalkthroughRange, parseWalkthrough } from "./walkthrough.ts";

/**
 * How much patch one `quick_review_start` result may carry.
 *
 * A host warns and then truncates long tool output, so the patch stops being
 * inlined well before that. Above this the agent reads `patch.diff` instead,
 * which costs one file read and never loses a hunk.
 */
export const MCP_INLINE_PATCH_LIMIT = 24 * 1024;

/**
 * How long one `quick_review_wait` blocks before reporting nothing.
 *
 * Short enough that a host's idle-abort never fires, long enough that the agent
 * is not spinning. Nothing is lost when it expires: the wait leaves the queue
 * untouched, so the next call collects whatever arrived meanwhile.
 */
export const WAIT_TIMEOUT = 5 * 60 * 1000;

const PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];
const DEFAULT_PROTOCOL = "2025-06-18";

const INSTRUCTIONS = `Quick Review turns a git range into a walkthrough page that the user reviews change by change.

Run it as a loop and do not stop early:
1. quick_review_start returns the walkthrough instructions. Follow them.
2. quick_review_submit posts the walkthrough once. This opens the page.
3. quick_review_wait blocks until the reviewer asks something or decides. Answer
   a question with quick_review_answer, then call quick_review_wait again.
   Repeat until the outcome arrives.

The reviewer cannot reach you except through quick_review_wait, so a question
goes unanswered for as long as you are not waiting. Do not act on the change
while the review is open: the reviewer decides on the page.`;

const TOOLS = [
  {
    name: "quick_review_start",
    description:
      "Plan a Quick Review of a git range and return the walkthrough instructions. Call this first, then follow the instructions it returns.",
    inputSchema: {
      type: "object",
      properties: {
        base: {
          type: "string",
          maxLength: LIMITS.ref,
          description:
            "Base of the reviewed range. Defaults to the merge base with the repository default branch.",
        },
        target: {
          type: "string",
          maxLength: LIMITS.ref,
          description: "Target of the reviewed range. Defaults to HEAD.",
        },
        repo: {
          type: "string",
          description:
            "Repository to review. Defaults to the directory the server runs in.",
        },
        open: {
          type: "boolean",
          description: "Open a browser for the review page. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "quick_review_submit",
    description:
      "Submit the exact-revision Quick Review walkthrough once. This opens the review page for the user.",
    inputSchema: {
      type: "object",
      properties: {
        revision: {
          type: "string",
          pattern: "^[0-9a-f]{40}$",
          description: "The target revision the walkthrough describes.",
        },
        markdown: {
          type: "string",
          minLength: 1,
          maxLength: LIMITS.artifact,
          description: "The complete walkthrough document.",
        },
        sectionCount: {
          type: "integer",
          minimum: 1,
          maximum: LIMITS.sections,
          description: "How many changes the walkthrough contains.",
        },
      },
      required: ["revision", "markdown", "sectionCount"],
      additionalProperties: false,
    },
  },
  {
    name: "quick_review_wait",
    description:
      "Wait for the next Quick Review event: a reviewer question, or the terminal outcome. Call this in a loop until the outcome arrives.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "quick_review_answer",
    description:
      "Answer one open Quick Review question. Only call this for a questionId quick_review_wait gave you.",
    inputSchema: {
      type: "object",
      properties: {
        questionId: { type: "string", pattern: "^[0-9a-f]{24}$" },
        answer: { type: "string", minLength: 1, maxLength: LIMITS.answer },
      },
      required: ["questionId", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "quick_review_close",
    description:
      "Close the open Quick Review page without a decision. Use this only when the user asks to abandon the review.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

function fields(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params))
    throw invalidParams("arguments must be an object");
  return params as Record<string, unknown>;
}

function optionalText(
  source: Record<string, unknown>,
  name: string,
  maximum: number,
): string | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw invalidParams(`${name} must be a non-empty string`);
  if (Buffer.byteLength(value, "utf8") > maximum)
    throw invalidParams(`${name} exceeds ${maximum} bytes`);
  return value;
}

function requiredText(
  source: Record<string, unknown>,
  name: string,
  maximum: number,
): string {
  const value = optionalText(source, name, maximum);
  if (value === undefined) throw invalidParams(`${name} is required`);
  return value;
}

function optionalFlag(
  source: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw invalidParams(`${name} must be a boolean`);
  return value;
}

function requiredCount(
  source: Record<string, unknown>,
  name: string,
  maximum: number,
): number {
  const value = source[name];
  if (typeof value !== "number" || !Number.isInteger(value))
    throw invalidParams(`${name} must be an integer`);
  if (value < 1 || value > maximum)
    throw invalidParams(`${name} must be between 1 and ${maximum}`);
  return value;
}

function text(body: string) {
  return { content: [{ type: "text", text: body }] };
}

function failure(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Quick Review: ${detail}` }],
    isError: true,
  };
}

export interface McpOptions {
  /** Repository directory used when a call names none. */
  cwd?: string;
  waitTimeout?: number;
  inlinePatchLimit?: number;
  version?: string;
  newHost?: () => QueueHost;
}

export interface QuickReviewMcp {
  dispatch: Dispatch;
  /** Tear down every review this server owns. */
  shutdown(): Promise<void>;
}

export function createQuickReviewMcp(options: McpOptions = {}): QuickReviewMcp {
  const cwd = options.cwd ?? process.cwd();
  const waitTimeout = options.waitTimeout ?? WAIT_TIMEOUT;
  const inlineLimit = options.inlinePatchLimit ?? MCP_INLINE_PATCH_LIMIT;
  const newHost = options.newHost ?? createQueueHost;

  let pending: { plan: ReviewPlan; open: boolean } | undefined;
  let active: OpenReview | undefined;
  let host: QueueHost | undefined;
  // One submit may be opening a page while a close arrives. The close aborts it
  // and the submit refuses to adopt anything it produced afterwards.
  let opening: AbortController | undefined;

  const drop = (plan: ReviewPlan) => {
    try {
      discardPlan(plan, true);
    } catch {
      /* a leftover plan directory is not worth failing a call over */
    }
  };

  const discardPending = () => {
    const request = pending;
    pending = undefined;
    if (request) drop(request.plan);
  };

  const closeActive = async () => {
    const review = active;
    active = undefined;
    host = undefined;
    if (review) await review.server.close().catch(() => undefined);
  };

  const start = async (params: unknown) => {
    const source = fields(params);
    const baseRef = optionalText(source, "base", LIMITS.ref);
    const targetRef = optionalText(source, "target", LIMITS.ref);
    const repository = optionalText(source, "repo", LIMITS.ref * 4);
    const open = optionalFlag(source, "open") ?? true;
    // A pending plan is a review that has not reached its page yet. Replacing
    // it would strand the walkthrough the agent is already writing.
    if (active || pending)
      throw new Error(
        "a Quick Review is already open; finish it on the page or call quick_review_close",
      );
    const plan = await planReview({ cwd, repository, baseRef, targetRef });
    pending = { plan, open };
    return text(buildPrompt(plan, inlineLimit));
  };

  const submit = async (params: unknown, signal: AbortSignal) => {
    const source = fields(params);
    const revision = requiredText(source, "revision", 40);
    const markdown = requiredText(source, "markdown", LIMITS.artifact);
    const sectionCount = requiredCount(source, "sectionCount", LIMITS.sections);
    if (!SHA.test(revision))
      throw invalidParams("revision must be a full commit hash");
    const request = pending;
    if (!request)
      throw new Error("no Quick Review is waiting for a walkthrough");
    if (active) throw new Error("a Quick Review is already open");
    if (revision !== request.plan.inputs.revision)
      throw new Error("walkthrough revision does not match the review");
    const document = parseWalkthrough(markdown);
    assertWalkthroughRange(
      document,
      request.plan.inputs.revision,
      request.plan.inputs.baseRevision,
    );
    if (document.sections.length !== sectionCount)
      throw new Error(
        `sectionCount is ${sectionCount} but the walkthrough has ${document.sections.length} changes`,
      );

    const controller = new AbortController();
    opening = controller;
    const combined = AbortSignal.any([signal, controller.signal]);
    const closed = () =>
      new Error("the review was closed while it was opening");
    const reviewHost = newHost();
    let review: OpenReview;
    try {
      await verifyRange(request.plan, combined);
      if (combined.aborted) throw closed();
      review = await openReview(request.plan, document, reviewHost, {
        signal: combined,
      });
      if (combined.aborted || active) {
        // A close raced the last await: refuse the page, do not adopt it.
        await review.server.close().catch(() => undefined);
        drop(request.plan);
        if (pending === request) pending = undefined;
        throw closed();
      }
      pending = undefined;
      active = review;
      host = reviewHost;
    } catch (error) {
      // The page never opened, so this request stops being the pending review
      // and a fresh quick_review_start can begin.
      if (pending === request) discardPending();
      throw error;
    } finally {
      if (opening === controller) opening = undefined;
    }
    void review.server.finished.then(closeActive);
    if (request.open) openBrowser(review.url);
    return text(
      `Quick Review is open at ${review.url} with ${document.sections.length} changes.\n\nCall quick_review_wait now and keep calling it until the outcome arrives. Do not act on the change until then.`,
    );
  };

  const wait = async (params: unknown, signal: AbortSignal) => {
    fields(params);
    const current = host;
    const review = active;
    // The terminal action closes the page, so `active` can clear while this
    // waits. The revision the question is about is the one this wait started on.
    if (!review || !current) throw new Error("no Quick Review is open");
    const event = await current.next({ timeout: waitTimeout, signal });
    if (!event)
      return text(
        active
          ? "No Quick Review event yet. The page is still open. Call quick_review_wait again."
          : "The Quick Review page was closed without a decision. Stop waiting.",
      );
    if (event.kind === "question")
      return text(
        buildQuestionPrompt({
          id: event.questionId,
          question: event.question,
          section: event.section,
          revision: review.plan.inputs.revision,
        }),
      );
    return text(
      `${buildCompletionMessage(
        event.event.outcome,
        event.event.overallComment,
        event.event.comments,
        event.warning,
      )}\n\nThe review is finished. Stop calling quick_review_wait.`,
    );
  };

  const answer = async (params: unknown) => {
    const source = fields(params);
    const questionId = requiredText(source, "questionId", 24);
    const body = requiredText(source, "answer", LIMITS.answer);
    const current = host;
    if (!current || !current.answer(questionId, body))
      throw new Error("that Quick Review question is no longer open");
    return text("The reviewer has the answer. Call quick_review_wait again.");
  };

  const close = async (params: unknown) => {
    fields(params);
    const was = active !== undefined || pending !== undefined;
    discardPending();
    opening?.abort();
    host?.fail("the review page was closed");
    await closeActive();
    return text(was ? "Quick Review closed." : "No Quick Review is open.");
  };

  const call = async (params: unknown, signal: AbortSignal) => {
    const source = fields(params);
    const name = source.name;
    if (typeof name !== "string") throw invalidParams("name is required");
    const args = source.arguments;
    try {
      switch (name) {
        case "quick_review_start":
          return await start(args);
        case "quick_review_submit":
          return await submit(args, signal);
        case "quick_review_wait":
          return await wait(args, signal);
        case "quick_review_answer":
          return await answer(args);
        case "quick_review_close":
          return await close(args);
        default:
          throw invalidParams(`unknown tool: ${name}`);
      }
    } catch (error) {
      // A tool that fails is a result the agent can recover from, not a
      // protocol fault. Only a malformed call is an RPC error.
      return failure(error);
    }
  };

  return {
    dispatch: (method, params, signal) => {
      switch (method) {
        case "initialize": {
          const asked = (params as { protocolVersion?: unknown } | undefined)
            ?.protocolVersion;
          return {
            protocolVersion:
              typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
                ? asked
                : DEFAULT_PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: {
              name: "quick-review",
              version: options.version ?? "0.0.0",
            },
            instructions: INSTRUCTIONS,
          };
        }
        case "notifications/initialized":
          return {};
        case "ping":
          return {};
        case "tools/list":
          return { tools: TOOLS };
        case "tools/call":
          return call(params, signal);
        default:
          throw methodNotFound(method);
      }
    },

    shutdown: async () => {
      discardPending();
      opening?.abort();
      host?.fail("the session is shutting down");
      await closeActive();
    },
  };
}

function packageVersion(): string {
  try {
    const path = new URL("../../package.json", import.meta.url);
    const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
    const version = (manifest as { version?: unknown }).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function main(): void {
  const server = createQuickReviewMcp({ version: packageVersion() });
  const stop = () => {
    void server.shutdown().finally(() => process.exit(0));
  };
  serve({
    input: process.stdin,
    output: process.stdout,
    dispatch: server.dispatch,
    onClose: stop,
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const entry = process.argv[1];
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) main();
