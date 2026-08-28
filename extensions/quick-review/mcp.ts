/** Dependency-free MCP adapter for the progressive project decompiler. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./browser.ts";
import { planAnalysis, verifyAnalysis, type GraphPlan } from "./analysis.ts";
import { LIMITS, SHA } from "./contract.ts";
import {
  GRAPH_LIMITS,
  assertGraphRange,
  parseGraphDelta,
  parseProjectGraph,
} from "./graph-contract.ts";
import { createGraphQueueHost, type GraphQueueHost } from "./graph-host.ts";
import {
  buildExpansionPrompt,
  buildGraphCompletionMessage,
  buildGraphPrompt,
  buildGraphQuestionPrompt,
} from "./graph-prompt.ts";
import {
  discardGraphPlan,
  openGraphReview,
  type OpenGraphReview,
} from "./graph-review.ts";
import {
  invalidParams,
  methodNotFound,
  serve,
  type Dispatch,
} from "./jsonrpc.ts";

export const MCP_INLINE_PATCH_LIMIT = 24 * 1024;
export const WAIT_TIMEOUT = 5 * 60 * 1000;

const PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];
const DEFAULT_PROTOCOL = "2025-06-18";

const INSTRUCTIONS = `Quick Review opens a progressive exact-revision project graph.

Run it as a loop and do not stop early:
1. quick_review_start returns exact HEAD or diff graph instructions. Follow them.
2. quick_review_graph_submit opens the project decompiler.
3. quick_review_wait blocks until the reviewer asks for an enhancement, asks a
   question, or decides. Use quick_review_graph_expand or quick_review_answer,
   then call quick_review_wait again. Repeat until the outcome arrives.

The reviewer cannot reach you except through quick_review_wait. Do not edit files
or decide the review while the graph is open.`;

const TOOLS = [
  {
    name: "quick_review_start",
    description:
      "Plan a progressive project graph. Without base it analyzes one target snapshot; with base it analyzes a diff.",
    inputSchema: {
      type: "object",
      properties: {
        base: {
          type: "string",
          maxLength: LIMITS.ref,
          description:
            "Diff base. Its presence selects a base-to-target overlay.",
        },
        target: {
          type: "string",
          maxLength: LIMITS.ref,
          description: "Exact target ref. Defaults to HEAD.",
        },
        repo: {
          type: "string",
          description:
            "Repository to analyze. Defaults to the server working directory.",
        },
        open: {
          type: "boolean",
          description: "Open a browser. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "quick_review_graph_submit",
    description:
      "Submit the exact-revision root project graph once and open the project decompiler.",
    inputSchema: {
      type: "object",
      properties: {
        revision: { type: "string", pattern: "^[0-9a-f]{40}$" },
        graph: {
          type: "string",
          minLength: 1,
          maxLength: GRAPH_LIMITS.artifact,
        },
        nodeCount: {
          type: "integer",
          minimum: 1,
          maximum: GRAPH_LIMITS.nodes,
        },
      },
      required: ["revision", "graph", "nodeCount"],
      additionalProperties: false,
    },
  },
  {
    name: "quick_review_graph_expand",
    description:
      "Answer one enhancement request from quick_review_wait with a direct-child graph delta.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", pattern: "^[0-9a-f]{24}$" },
        delta: {
          type: "string",
          minLength: 1,
          maxLength: GRAPH_LIMITS.delta,
        },
      },
      required: ["requestId", "delta"],
      additionalProperties: false,
    },
  },
  {
    name: "quick_review_wait",
    description:
      "Wait for a graph enhancement, graph question, or terminal outcome. Keep calling until the outcome arrives.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "quick_review_answer",
    description:
      "Answer one open graph question. Only use a questionId returned by quick_review_wait.",
    inputSchema: {
      type: "object",
      properties: {
        questionId: { type: "string", pattern: "^[0-9a-f]{24}$" },
        answer: {
          type: "string",
          minLength: 1,
          maxLength: LIMITS.answer,
        },
      },
      required: ["questionId", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "quick_review_close",
    description:
      "Close the open project graph without a decision. Use only when the user asks to abandon it.",
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
  cwd?: string;
  waitTimeout?: number;
  inlinePatchLimit?: number;
  version?: string;
  newHost?: () => GraphQueueHost;
}

export interface QuickReviewMcp {
  dispatch: Dispatch;
  shutdown(): Promise<void>;
}

export function createQuickReviewMcp(options: McpOptions = {}): QuickReviewMcp {
  const cwd = options.cwd ?? process.cwd();
  const waitTimeout = options.waitTimeout ?? WAIT_TIMEOUT;
  const inlineLimit = options.inlinePatchLimit ?? MCP_INLINE_PATCH_LIMIT;
  const newHost = options.newHost ?? createGraphQueueHost;

  let pending: { plan: GraphPlan; open: boolean } | undefined;
  let active: OpenGraphReview | undefined;
  let host: GraphQueueHost | undefined;
  let opening: AbortController | undefined;

  const discardPending = () => {
    const request = pending;
    pending = undefined;
    if (request)
      try {
        discardGraphPlan(request.plan, true);
      } catch {
        /* a leftover plan directory is not worth failing a call */
      }
  };

  const closeActive = async () => {
    const review = active;
    active = undefined;
    host = undefined;
    if (review) await review.server.close().catch(() => undefined);
  };

  const start = async (params: unknown) => {
    const source = fields(params);
    if (
      Object.keys(source).some(
        (key) => !["base", "target", "repo", "open"].includes(key),
      )
    )
      throw invalidParams("quick_review_start has an unknown argument");
    const baseRef = optionalText(source, "base", LIMITS.ref);
    const targetRef = optionalText(source, "target", LIMITS.ref);
    const repository = optionalText(source, "repo", LIMITS.ref * 4);
    const open = optionalFlag(source, "open") ?? true;
    if (active || pending)
      throw new Error(
        "a Quick Review is already open; finish it on the page or call quick_review_close",
      );
    const plan = await planAnalysis({
      cwd,
      scope: baseRef ? "diff" : "head",
      repository,
      baseRef,
      targetRef,
    });
    pending = { plan, open };
    return text(buildGraphPrompt(plan, [], inlineLimit));
  };

  const submit = async (params: unknown, signal: AbortSignal) => {
    const source = fields(params);
    const revision = requiredText(source, "revision", 40);
    const graphSource = requiredText(source, "graph", GRAPH_LIMITS.artifact);
    const nodeCount = requiredCount(source, "nodeCount", GRAPH_LIMITS.nodes);
    if (!SHA.test(revision))
      throw invalidParams("revision must be a full commit hash");
    const request = pending;
    if (!request)
      throw new Error("no Quick Review is waiting for a project graph");
    if (active) throw new Error("a Quick Review is already open");
    if (revision !== request.plan.inputs.revision)
      throw new Error("project graph revision does not match the review");
    const graph = parseProjectGraph(graphSource);
    assertGraphRange(
      graph,
      request.plan.scope,
      request.plan.inputs.revision,
      request.plan.inputs.baseRevision,
    );
    if (graph.nodes.length !== nodeCount)
      throw new Error(
        `nodeCount is ${nodeCount} but the graph has ${graph.nodes.length} nodes`,
      );

    const controller = new AbortController();
    opening = controller;
    const combined = AbortSignal.any([signal, controller.signal]);
    const reviewHost = newHost();
    let review: OpenGraphReview;
    try {
      await verifyAnalysis(request.plan, combined);
      if (combined.aborted)
        throw new Error("the review was closed while it was opening");
      review = await openGraphReview(request.plan, graph, reviewHost, {
        signal: combined,
      });
      if (combined.aborted || active || pending !== request) {
        await review.server.close().catch(() => undefined);
        discardGraphPlan(request.plan, true);
        throw new Error("the review was closed while it was opening");
      }
      pending = undefined;
      active = review;
      host = reviewHost;
    } catch (error) {
      if (pending === request) discardPending();
      throw error;
    } finally {
      if (opening === controller) opening = undefined;
    }
    void review.server.finished.then(closeActive);
    if (request.open) openBrowser(review.url);
    return text(
      `Quick Review project graph is open at ${review.url} with ${graph.nodes.length} nodes.\n\nCall quick_review_wait now and keep calling it until the outcome arrives.`,
    );
  };

  const submitExpansion = async (params: unknown) => {
    const source = fields(params);
    const requestId = requiredText(source, "requestId", 24);
    const deltaSource = requiredText(source, "delta", GRAPH_LIMITS.delta);
    if (!host || !active) throw new Error("no project graph is open");
    const delta = parseGraphDelta(deltaSource, active.plan.inputs.revision);
    if (!host.submitExpansion(requestId, delta))
      throw new Error("that graph enhancement request is no longer open");
    return text(
      "The reviewer has the enhanced graph. Call quick_review_wait again.",
    );
  };

  const wait = async (params: unknown, signal: AbortSignal) => {
    fields(params);
    const review = active;
    const current = host;
    if (!review || !current) throw new Error("no Quick Review is open");
    const event = await current.next({ timeout: waitTimeout, signal });
    if (!event)
      return text(
        active
          ? "No Quick Review event yet. The project graph is still open. Call quick_review_wait again."
          : "The Quick Review page was closed without a decision. Stop waiting.",
      );
    if (event.kind === "question")
      return text(
        buildGraphQuestionPrompt({
          id: event.requestId,
          node: event.node,
          question: event.question,
          revision: review.plan.inputs.revision,
        }),
      );
    if (event.kind === "expansion")
      return text(
        buildExpansionPrompt({
          id: event.requestId,
          node: event.node,
          knownIds: event.knownIds,
          revision: review.plan.inputs.revision,
        }),
      );
    return text(
      `${buildGraphCompletionMessage(event.event, event.warning)}\n\nThe graph review is finished. Stop calling quick_review_wait.`,
    );
  };

  const answer = async (params: unknown) => {
    const source = fields(params);
    const questionId = requiredText(source, "questionId", 24);
    const body = requiredText(source, "answer", LIMITS.answer);
    if (!host?.answer(questionId, body))
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
    try {
      switch (name) {
        case "quick_review_start":
          return await start(source.arguments);
        case "quick_review_graph_submit":
          return await submit(source.arguments, signal);
        case "quick_review_graph_expand":
          return await submitExpansion(source.arguments);
        case "quick_review_wait":
          return await wait(source.arguments, signal);
        case "quick_review_answer":
          return await answer(source.arguments);
        case "quick_review_close":
          return await close(source.arguments);
        default:
          throw invalidParams(`unknown tool: ${name}`);
      }
    } catch (error) {
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
