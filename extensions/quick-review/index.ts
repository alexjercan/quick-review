/** Pi adapter for the progressive Quick Review project decompiler. */

import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { openBrowser } from "./browser.ts";
import { planAnalysis, verifyAnalysis, type GraphPlan } from "./analysis.ts";
import {
  GRAPH_COMPLETION_EVENT,
  GRAPH_LIMITS,
  assertGraphRange,
  parseGraphDelta,
  parseProjectGraph,
  type GraphComment,
  type GraphCompletionEvent,
  type GraphDelta,
  type GraphNode,
  type GuidanceSource,
} from "./graph-contract.ts";
import {
  buildExpansionPrompt,
  buildGraphCommentPrompt,
  buildGraphCompletionMessage,
  buildGraphPrompt,
} from "./graph-prompt.ts";
import {
  discardGraphPlan,
  openGraphReview,
  type OpenGraphReview,
} from "./graph-review.ts";
import { bounded, LIMITS } from "./contract.ts";
import { parseOptions, USAGE } from "./options.ts";

const REQUEST_TIMEOUT = 15 * 60 * 1000;
const COMMENT_TYPE = "quick-review-comment";

interface PendingComment {
  resolve(answer: string): void;
  reject(error: Error): void;
}

interface PendingExpansion {
  revision: string;
  parentId: string;
  resolve(delta: GraphDelta): void;
  reject(error: Error): void;
}

function notifier(
  ctx: ExtensionContext,
): (message: string, level: "info" | "error") => void {
  return (message, level) => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(message, level);
    } catch {
      /* the session moved on */
    }
  };
}

function guidanceFrom(ctx: {
  getSystemPromptOptions?: () => unknown;
}): GuidanceSource[] {
  if (typeof ctx.getSystemPromptOptions !== "function") return [];
  const options = ctx.getSystemPromptOptions() as {
    contextFiles?: Array<{ path?: unknown }>;
    skills?: Array<{ path?: unknown; name?: unknown }>;
    customPrompt?: unknown;
  };
  const result: GuidanceSource[] = [];
  for (const file of options.contextFiles ?? [])
    if (typeof file.path === "string")
      result.push({ path: file.path, kind: "context" });
  for (const skill of options.skills ?? []) {
    const path =
      typeof skill.path === "string"
        ? skill.path
        : typeof skill.name === "string"
          ? skill.name
          : undefined;
    if (path) result.push({ path, kind: "skill" });
  }
  if (typeof options.customPrompt === "string" && options.customPrompt.trim())
    result.push({ path: "Pi custom system prompt", kind: "host" });
  return result.slice(0, 32);
}

/** Take plain assistant text only from the response segment for this comment. */
function answerFor(ctx: ExtensionContext, id: string): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  const asked = entries.findIndex(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === COMMENT_TYPE &&
      (entry.details as { commentId?: string } | undefined)?.commentId === id,
  );
  if (asked < 0) return undefined;
  let answer = "";
  for (const entry of entries.slice(asked + 1)) {
    if (entry.type === "custom_message") break;
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") break;
    if (entry.message.role !== "assistant") continue;
    const text = entry.message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();
    if (text) answer = text;
  }
  return answer ? bounded(answer, LIMITS.answer) : "";
}

export default function quickReview(pi: ExtensionAPI): void {
  let pending:
    | { plan: GraphPlan; open: boolean; guidance: GuidanceSource[] }
    | undefined;
  let active: OpenGraphReview | undefined;
  let opening: AbortController | undefined;
  const comments = new Map<string, PendingComment>();
  const expansions = new Map<string, PendingExpansion>();

  const discardPending = () => {
    const request = pending;
    pending = undefined;
    if (request)
      try {
        discardGraphPlan(request.plan, true);
      } catch {
        /* a leftover plan directory is not worth failing a close over */
      }
  };

  const closeActive = async () => {
    const review = active;
    active = undefined;
    if (review) await review.server.close().catch(() => undefined);
  };

  const failRequests = (reason: string) => {
    for (const [id, comment] of comments) {
      comments.delete(id);
      comment.reject(new Error(reason));
    }
    for (const [id, expansion] of expansions) {
      expansions.delete(id);
      expansion.reject(new Error(reason));
    }
  };

  const comment = (request: {
    node: GraphNode;
    comment: GraphComment;
    signal: AbortSignal;
  }): Promise<string> => {
    const review = active;
    if (!review) throw new Error("no project graph is open");
    const id = request.comment.id;
    return new Promise<string>((resolve, reject) => {
      if (request.signal.aborted) {
        reject(new Error("the comment was superseded"));
        return;
      }
      const timer = setTimeout(() => {
        comments.delete(id);
        reject(new Error("the session agent did not respond in time"));
      }, REQUEST_TIMEOUT);
      timer.unref?.();
      const settle = (finish: () => void) => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        comments.delete(id);
        finish();
      };
      const abort = () =>
        settle(() => reject(new Error("the comment was superseded")));
      comments.set(id, {
        resolve: (answer) => settle(() => resolve(answer)),
        reject: (error) => settle(() => reject(error)),
      });
      request.signal.addEventListener("abort", abort, { once: true });
      pi.sendMessage(
        {
          customType: COMMENT_TYPE,
          content: buildGraphCommentPrompt({
            ...request,
            revision: review.plan.inputs.revision,
          }),
          display: true,
          details: { commentId: id, nodeId: request.node.id },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
  };

  const expand = (request: {
    node: GraphNode;
    knownIds: string[];
  }): Promise<GraphDelta> => {
    const review = active;
    if (!review) throw new Error("no project graph is open");
    const id = randomBytes(12).toString("hex");
    return new Promise<GraphDelta>((resolve, reject) => {
      const timer = setTimeout(() => {
        expansions.delete(id);
        reject(
          new Error("the session agent did not enhance the graph in time"),
        );
      }, REQUEST_TIMEOUT);
      timer.unref?.();
      const settle = (finish: () => void) => {
        clearTimeout(timer);
        expansions.delete(id);
        finish();
      };
      expansions.set(id, {
        revision: review.plan.inputs.revision,
        parentId: request.node.id,
        resolve: (delta) => settle(() => resolve(delta)),
        reject: (error) => settle(() => reject(error)),
      });
      pi.sendMessage(
        {
          customType: "quick-review-expansion",
          content: buildExpansionPrompt({
            id,
            revision: review.plan.inputs.revision,
            ...request,
          }),
          display: true,
          details: { requestId: id, nodeId: request.node.id },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
  };

  const complete = (event: GraphCompletionEvent, warning?: string) => {
    try {
      pi.events.emit(GRAPH_COMPLETION_EVENT, event);
    } catch {
      /* no consumer is listening */
    }
    try {
      pi.sendMessage(
        {
          customType: "quick-review-graph-outcome",
          content: buildGraphCompletionMessage(event, warning),
          display: true,
          details: event,
        },
        {
          deliverAs: event.outcome === "commented" ? "steer" : "followUp",
          triggerTurn: true,
        },
      );
    } catch {
      /* completion.json holds the durable outcome */
    }
  };

  pi.registerCommand("quick-review", {
    description: "Open a progressive exact-revision project graph",
    getArgumentCompletions: (prefix: string) => {
      const flags = ["--base", "--target", "--repo", "--no-open", "--help"]
        .filter((flag) => flag.startsWith(prefix))
        .map((flag) => ({ value: flag, label: flag }));
      return flags.length > 0 ? flags : null;
    },
    handler: async (args, ctx) => {
      const say = notifier(ctx);
      let created: GraphPlan | undefined;
      try {
        const options = parseOptions(args ?? "");
        if (options.help) {
          say(USAGE, "info");
          if (!ctx.hasUI) throw new Error(USAGE);
          return;
        }
        if (ctx.mode === "print" || ctx.mode === "json")
          throw new Error(
            `${ctx.mode} mode cannot host a review page; run /quick-review from an interactive or RPC session`,
          );
        if (active || pending)
          throw new Error(
            "a Quick Review is already open; finish it on the page or run /quick-review-close",
          );
        const plan = await planAnalysis({
          cwd: ctx.cwd,
          scope: options.baseRef ? "diff" : "head",
          repository: options.repository,
          baseRef: options.baseRef,
          targetRef: options.targetRef,
        });
        created = plan;
        pending = {
          plan,
          open: options.open,
          guidance: guidanceFrom(ctx),
        };
        pi.setActiveTools([
          ...new Set([
            ...pi.getActiveTools(),
            "quick_review_graph_submit",
            "quick_review_graph_expand",
            "quick_review_comment_respond",
          ]),
        ]);
        say(
          `Quick Review: building the ${plan.scope.toUpperCase()} project graph at ${plan.inputs.revision.slice(0, 12)}.`,
          "info",
        );
        pi.sendMessage(
          {
            customType: "quick-review-graph-request",
            content: buildGraphPrompt(plan, pending.guidance),
            display: false,
            details: {
              ...plan.inputs,
              scope: plan.scope,
              directory: plan.directory,
            },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      } catch (error) {
        if (created) {
          if (pending?.plan === created) pending = undefined;
          try {
            discardGraphPlan(created, true);
          } catch {
            /* a leftover plan directory is not worth failing the command */
          }
        }
        const detail = error instanceof Error ? error.message : String(error);
        if (!ctx.hasUI) throw new Error(`Quick Review: ${detail}`);
        say(`Quick Review: ${detail}`, "error");
      }
    },
  });

  pi.registerCommand("quick-review-close", {
    description: "Close the open Quick Review project graph without a decision",
    handler: async (_args, ctx) => {
      const wasOpen = active !== undefined || pending !== undefined;
      discardPending();
      opening?.abort();
      failRequests("the review page was closed");
      await closeActive();
      notifier(ctx)(
        wasOpen ? "Quick Review closed." : "No Quick Review is open.",
        "info",
      );
    },
  });

  pi.registerTool(
    defineTool({
      name: "quick_review_graph_submit",
      label: "Submit project graph",
      description:
        "Submit the bounded exact-revision project graph once. This opens the project decompiler page.",
      promptSnippet: "Submit the requested Quick Review project graph",
      executionMode: "sequential",
      parameters: Type.Object(
        {
          revision: Type.String({ pattern: "^[0-9a-f]{40}$" }),
          graph: Type.String({
            minLength: 1,
            maxLength: GRAPH_LIMITS.artifact,
          }),
          nodeCount: Type.Integer({
            minimum: 1,
            maximum: GRAPH_LIMITS.nodes,
          }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, toolSignal, _update, ctx) {
        const request = pending;
        if (!request)
          throw new Error("no Quick Review is waiting for a project graph");
        if (active) throw new Error("a Quick Review is already open");
        if (params.revision !== request.plan.inputs.revision)
          throw new Error("project graph revision does not match the review");
        const graph = parseProjectGraph(params.graph);
        assertGraphRange(
          graph,
          request.plan.scope,
          request.plan.inputs.revision,
          request.plan.inputs.baseRevision,
        );
        const trustedGuidance = new Set(
          request.guidance.map((item) => `${item.kind}\0${item.path}`),
        );
        if (
          graph.guidance.some(
            (item) => !trustedGuidance.has(`${item.kind}\0${item.path}`),
          )
        )
          throw new Error("project graph reports guidance Pi did not load");
        if (graph.nodes.length !== params.nodeCount)
          throw new Error(
            `nodeCount is ${params.nodeCount} but the graph has ${graph.nodes.length} nodes`,
          );

        const controller = new AbortController();
        opening = controller;
        const signal = toolSignal
          ? AbortSignal.any([toolSignal, controller.signal])
          : controller.signal;
        let review: OpenGraphReview;
        try {
          await verifyAnalysis(request.plan, signal);
          if (signal.aborted)
            throw new Error("the review was closed while it was opening");
          review = await openGraphReview(
            request.plan,
            graph,
            { comment, expand, complete },
            { signal },
          );
          if (signal.aborted || active || pending !== request) {
            await review.server.close().catch(() => undefined);
            discardGraphPlan(request.plan, true);
            throw new Error("the review was closed while it was opening");
          }
          pending = undefined;
          active = review;
        } catch (error) {
          if (pending === request) discardPending();
          throw error;
        } finally {
          if (opening === controller) opening = undefined;
        }
        void review.server.finished.then(closeActive);
        if (request.open) openBrowser(review.url);
        notifier(ctx)(
          `Quick Review project graph is open at ${review.url}`,
          "info",
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Quick Review project graph is open at ${review.url} with ${graph.nodes.length} initial nodes. Wait for enhancement requests, comments, or the outcome.`,
            },
          ],
          details: {
            url: review.url,
            nodes: graph.nodes.length,
            revision: graph.revision,
            scope: graph.scope,
          },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "quick_review_graph_expand",
      label: "Submit graph enhancement",
      description:
        "Answer one open graph enhancement request with a bounded direct-child delta.",
      promptSnippet: "Submit one requested project graph enhancement",
      executionMode: "sequential",
      parameters: Type.Object(
        {
          requestId: Type.String({ pattern: "^[0-9a-f]{24}$" }),
          delta: Type.String({
            minLength: 1,
            maxLength: GRAPH_LIMITS.delta,
          }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const request = expansions.get(params.requestId);
        if (!request)
          throw new Error("that graph enhancement request is no longer open");
        const delta = parseGraphDelta(params.delta, request.revision);
        if (delta.parentId !== request.parentId)
          throw new Error(
            "graph enhancement parent does not match the request",
          );
        request.resolve(delta);
        return {
          content: [
            {
              type: "text" as const,
              text: "The reviewer has the enhanced graph.",
            },
          ],
          details: {
            requestId: params.requestId,
            parentId: delta.parentId,
            nodes: delta.nodes.length,
          },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "quick_review_comment_respond",
      label: "Respond to review comment",
      description:
        "Respond to the one active Quick Review comment. Only call this for a commentId the page sent.",
      promptSnippet: "Respond to one active Quick Review comment by id",
      executionMode: "sequential",
      parameters: Type.Object(
        {
          commentId: Type.String({ pattern: "^[0-9a-f]{24}$" }),
          response: Type.String({
            minLength: 1,
            maxLength: LIMITS.answer,
          }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const comment = comments.get(params.commentId);
        if (!comment)
          throw new Error("that Quick Review comment is no longer active");
        comment.resolve(params.response);
        return {
          content: [
            {
              type: "text" as const,
              text: "The reviewer has the comment response.",
            },
          ],
          details: { commentId: params.commentId },
        };
      },
    }),
  );

  pi.on("agent_settled", (_event, ctx) => {
    for (const [id, comment] of [...comments]) {
      const answer = answerFor(ctx, id);
      if (answer === undefined) continue;
      comments.delete(id);
      if (answer) comment.resolve(answer);
      else
        comment.reject(
          new Error("the session agent finished without a response"),
        );
    }
  });

  pi.on("session_shutdown", async () => {
    discardPending();
    opening?.abort();
    failRequests("the session is shutting down");
    await closeActive();
  });
}
