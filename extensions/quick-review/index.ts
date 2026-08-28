/**
 * Quick Review: `/quick-review` builds a walkthrough with the session's own
 * agent and opens a local review page. Questions from the page go back to that
 * same agent, and the terminal decision comes back as a versioned event.
 */

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
  type GraphCompletionEvent,
  type GraphDelta,
  type GraphNode,
  type GuidanceSource,
} from "./graph-contract.ts";
import {
  assertGraphRange,
  parseGraphDelta,
  parseProjectGraph,
} from "./graph-contract.ts";
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
  bounded,
  COMPLETION_EVENT,
  LIMITS,
  type CompletionEvent,
  type WalkthroughSection,
} from "./contract.ts";
import { parseOptions, USAGE } from "./options.ts";
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

/** How long the page waits for the session agent to answer one question. */
const QUESTION_TIMEOUT = 15 * 60 * 1000;

const QUESTION_TYPE = "quick-review-question";

interface PendingQuestion {
  resolve(answer: string): void;
  reject(error: Error): void;
}

interface PendingExpansion {
  revision: string;
  parentId: string;
  resolve(delta: GraphDelta): void;
  reject(error: Error): void;
}

/** One page opening in flight, owned by the session that started it. */
interface Opening {
  plan: ReviewPlan;
  controller: AbortController;
  done: Promise<void>;
  signal: AbortSignal;
  settle(): void;
  current(): boolean;
  assertCurrent(): void;
}

/** UI calls throw once a session is replaced, and no message is worth failing on. */
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

/**
 * Find the answer the agent wrote for one specific question.
 *
 * Pi persists a custom message when the agent actually receives it, so the
 * question entry opens the response segment, and the next delivered user or
 * custom input closes it. A response often spans several assistant messages -
 * "I will read the file" and a tool call, then the real answer - so the last
 * substantive text in that segment is the answer, not the first.
 *
 * Returns undefined when the question has not been delivered yet, and an empty
 * string when it was delivered but drew no text.
 */
function answerFor(ctx: ExtensionContext, id: string): string | undefined {
  const entries = ctx.sessionManager.getBranch();
  const asked = entries.findIndex(
    (entry) =>
      entry.type === "custom_message" &&
      entry.customType === QUESTION_TYPE &&
      (entry.details as { questionId?: string } | undefined)?.questionId === id,
  );
  if (asked < 0) return undefined;
  let answer = "";
  for (const entry of entries.slice(asked + 1)) {
    // A later input starts a different request, so the segment ends here.
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
  let pending: { plan: ReviewPlan; open: boolean } | undefined;
  let active: OpenReview | undefined;
  let graphPending:
    | { plan: GraphPlan; open: boolean; guidance: GuidanceSource[] }
    | undefined;
  let activeGraph: OpenGraphReview | undefined;
  let graphOpening: AbortController | undefined;
  const questions = new Map<string, PendingQuestion>();
  const expansions = new Map<string, PendingExpansion>();

  const openings = new Set<Opening>();

  const closeActive = async () => {
    const review = active;
    active = undefined;
    if (review) await review.server.close().catch(() => undefined);
    const graph = activeGraph;
    activeGraph = undefined;
    if (graph) await graph.server.close().catch(() => undefined);
  };

  /**
   * Register one in-flight page opening.
   *
   * The returned handle carries a signal that a close aborts, a check that
   * tells the opener whether it still owns the review, and a promise the close
   * can wait on within its own bound.
   */
  const beginOpening = (
    plan: ReviewPlan,
    toolSignal?: AbortSignal,
  ): Opening => {
    const controller = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    const signal = toolSignal
      ? AbortSignal.any([toolSignal, controller.signal])
      : controller.signal;
    const opening: Opening = {
      plan,
      controller,
      done,
      signal,
      settle,
      current: () => openings.has(opening) && !signal.aborted,
      assertCurrent: () => {
        if (!opening.current())
          throw new Error("the review was closed while it was opening");
      },
    };
    openings.add(opening);
    return opening;
  };

  /** Cancel every opening page and wait, bounded, for them to unwind. */
  const closeOpenings = async () => {
    const current = [...openings];
    openings.clear();
    if (current.length === 0) return;
    for (const opening of current) opening.controller.abort();
    await Promise.race([
      Promise.all(current.map((opening) => opening.done)),
      new Promise<void>((resolve) => {
        const bound = setTimeout(resolve, 2000);
        bound.unref?.();
      }),
    ]);
    // Only a plan that never became the open review may be removed here.
    for (const opening of current) {
      if (active?.plan === opening.plan) continue;
      try {
        discardPlan(opening.plan, true);
      } catch {
        /* a leftover plan directory is not worth failing a close over */
      }
    }
  };

  /** Drop a planned review that will never open, and its patch directory. */
  const discardPending = () => {
    const request = pending;
    pending = undefined;
    if (request) {
      try {
        discardPlan(request.plan, true);
      } catch {
        /* a leftover plan directory is not worth failing a command over */
      }
    }
  };

  const discardGraphPending = () => {
    const request = graphPending;
    graphPending = undefined;
    if (request) {
      try {
        discardGraphPlan(request.plan, true);
      } catch {
        /* a leftover plan directory is not worth failing a close over */
      }
    }
  };

  const failQuestions = (reason: string) => {
    for (const [id, question] of questions) {
      questions.delete(id);
      question.reject(new Error(reason));
    }
    for (const [id, expansion] of expansions) {
      expansions.delete(id);
      expansion.reject(new Error(reason));
    }
  };

  const ask = (request: {
    sectionId: string;
    question: string;
    section: WalkthroughSection;
  }): Promise<string> => {
    const review = active;
    if (!review) throw new Error("no review is open");
    const id = randomBytes(12).toString("hex");
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        questions.delete(id);
        reject(new Error("the session agent did not answer in time"));
      }, QUESTION_TIMEOUT);
      timer.unref?.();
      const settle = (finish: () => void) => {
        clearTimeout(timer);
        questions.delete(id);
        finish();
      };
      questions.set(id, {
        resolve: (answer) => settle(() => resolve(answer)),
        reject: (error) => settle(() => reject(error)),
      });
      pi.sendMessage(
        {
          customType: QUESTION_TYPE,
          content: buildQuestionPrompt({
            id,
            question: request.question,
            section: request.section,
            revision: review.plan.inputs.revision,
          }),
          display: true,
          details: { questionId: id, sectionId: request.sectionId },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
  };

  const graphAsk = (request: {
    node: GraphNode;
    question: string;
  }): Promise<string> => {
    const review = activeGraph;
    if (!review) throw new Error("no project graph is open");
    const id = randomBytes(12).toString("hex");
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        questions.delete(id);
        reject(new Error("the session agent did not answer in time"));
      }, QUESTION_TIMEOUT);
      timer.unref?.();
      const settle = (finish: () => void) => {
        clearTimeout(timer);
        questions.delete(id);
        finish();
      };
      questions.set(id, {
        resolve: (answer) => settle(() => resolve(answer)),
        reject: (error) => settle(() => reject(error)),
      });
      pi.sendMessage(
        {
          customType: QUESTION_TYPE,
          content: buildGraphQuestionPrompt({
            id,
            ...request,
            revision: review.plan.inputs.revision,
          }),
          display: true,
          details: { questionId: id, nodeId: request.node.id },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
  };

  const graphExpand = (request: {
    node: GraphNode;
    knownIds: string[];
  }): Promise<GraphDelta> => {
    const review = activeGraph;
    if (!review) throw new Error("no project graph is open");
    const id = randomBytes(12).toString("hex");
    return new Promise<GraphDelta>((resolve, reject) => {
      const timer = setTimeout(() => {
        expansions.delete(id);
        reject(
          new Error("the session agent did not enhance the graph in time"),
        );
      }, QUESTION_TIMEOUT);
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

  const graphComplete = (event: GraphCompletionEvent, warning?: string) => {
    try {
      pi.events.emit(GRAPH_COMPLETION_EVENT, event);
    } catch {}
    try {
      pi.sendMessage(
        {
          customType: "quick-review-graph-outcome",
          content: buildGraphCompletionMessage(event, warning),
          display: true,
          details: event,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {}
  };

  const complete = (event: CompletionEvent, warning?: string) => {
    // The decision is already durable. Neither delivery may undo it, and one
    // failing must not stop the other.
    try {
      pi.events.emit(COMPLETION_EVENT, event);
    } catch {
      /* no consumer is listening */
    }
    try {
      pi.sendMessage(
        {
          customType: "quick-review-outcome",
          content: buildCompletionMessage(
            event.outcome,
            event.overallComment,
            event.comments,
            warning,
          ),
          display: true,
          details: event,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      /* the session moved on; completion.json holds the outcome */
    }
  };

  pi.registerCommand("quick-review", {
    description: "Review a git range and open the local Quick Review page",
    getArgumentCompletions: (prefix: string) => {
      const flags = [
        "--scope",
        "--base",
        "--target",
        "--repo",
        "--no-open",
        "--help",
      ]
        .filter((flag) => flag.startsWith(prefix))
        .map((flag) => ({ value: flag, label: flag }));
      return flags.length > 0 ? flags : null;
    },
    handler: async (args, ctx) => {
      const say = notifier(ctx);
      // Only this invocation's own plan may be discarded on failure. A refused
      // duplicate must leave the review it collided with untouched.
      let created: ReviewPlan | undefined;
      let createdGraph: GraphPlan | undefined;
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
        // A pending plan is an open review that has not reached its page yet.
        // Replacing it would strand the first agent's submission.
        if (active || pending || activeGraph || graphPending)
          throw new Error(
            "a Quick Review is already open; finish it on the page or run /quick-review-close",
          );
        if (options.scope) {
          if (options.scope === "head" && options.baseRef)
            throw new Error("--base is not used with --scope head");
          const plan = await planAnalysis({
            cwd: ctx.cwd,
            scope: options.scope,
            repository: options.repository,
            baseRef: options.baseRef,
            targetRef: options.targetRef,
          });
          createdGraph = plan;
          graphPending = {
            plan,
            open: options.open,
            guidance: guidanceFrom(ctx),
          };
          pi.setActiveTools([
            ...new Set([
              ...pi.getActiveTools(),
              "quick_review_graph_submit",
              "quick_review_graph_expand",
              "quick_review_answer",
            ]),
          ]);
          say(
            `Quick Review: building the ${plan.scope.toUpperCase()} project graph at ${plan.inputs.revision.slice(0, 12)}.`,
            "info",
          );
          pi.sendMessage(
            {
              customType: "quick-review-graph-request",
              content: buildGraphPrompt(plan, graphPending.guidance),
              display: false,
              details: {
                ...plan.inputs,
                scope: plan.scope,
                directory: plan.directory,
              },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
          return;
        }
        const plan = await planReview({
          cwd: ctx.cwd,
          repository: options.repository,
          baseRef: options.baseRef,
          targetRef: options.targetRef,
        });
        created = plan;
        pending = { plan, open: options.open };
        pi.setActiveTools([
          ...new Set([
            ...pi.getActiveTools(),
            "quick_review_submit",
            "quick_review_answer",
          ]),
        ]);
        say(
          `Quick Review: ${plan.inputs.baseRef} -> ${plan.inputs.targetRef}, ${plan.files} files, +${plan.added} -${plan.removed}. Building the walkthrough.`,
          "info",
        );
        pi.sendMessage(
          {
            customType: "quick-review-request",
            content: buildPrompt(plan),
            display: false,
            details: { ...plan.inputs, directory: plan.directory },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      } catch (error) {
        if (created) {
          if (pending?.plan === created) pending = undefined;
          try {
            discardPlan(created, true);
          } catch {
            /* a leftover plan directory is not worth failing a command over */
          }
        }
        if (createdGraph) {
          if (graphPending?.plan === createdGraph) graphPending = undefined;
          try {
            discardGraphPlan(createdGraph, true);
          } catch {
            /* a leftover graph directory is not worth failing a command over */
          }
        }
        const detail = error instanceof Error ? error.message : String(error);
        // Modes without UI have no notification channel, so the command error
        // path is the only way the caller learns anything at all.
        if (!ctx.hasUI) throw new Error(`Quick Review: ${detail}`);
        say(`Quick Review: ${detail}`, "error");
      }
    },
  });

  pi.registerCommand("quick-review-close", {
    description: "Close the open Quick Review page without a decision",
    handler: async (_args, ctx) => {
      const wasPending =
        pending !== undefined ||
        graphPending !== undefined ||
        openings.size > 0 ||
        graphOpening !== undefined;
      discardPending();
      discardGraphPending();
      graphOpening?.abort();
      failQuestions("the review page was closed");
      const wasOpen = active !== undefined || activeGraph !== undefined;
      await closeOpenings();
      await closeActive();
      notifier(ctx)(
        wasOpen || wasPending
          ? "Quick Review closed."
          : "No Quick Review is open.",
        "info",
      );
    },
  });

  pi.registerTool(
    defineTool({
      name: "quick_review_submit",
      label: "Submit walkthrough",
      description:
        "Submit the exact-revision Quick Review walkthrough once. This opens the review page for the user.",
      promptSnippet:
        "Submit the Quick Review walkthrough for the requested revision",
      executionMode: "sequential",
      parameters: Type.Object(
        {
          revision: Type.String({ pattern: "^[0-9a-f]{40}$" }),
          markdown: Type.String({ minLength: 1, maxLength: LIMITS.artifact }),
          sectionCount: Type.Integer({ minimum: 1, maximum: LIMITS.sections }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, toolSignal, _update, ctx) {
        const request = pending;
        if (!request)
          throw new Error("no Quick Review is waiting for a walkthrough");
        if (active) throw new Error("a Quick Review is already open");
        if (params.revision !== request.plan.inputs.revision)
          throw new Error("walkthrough revision does not match the review");
        const document = parseWalkthrough(params.markdown);
        assertWalkthroughRange(
          document,
          request.plan.inputs.revision,
          request.plan.inputs.baseRevision,
        );
        if (document.sections.length !== params.sectionCount)
          throw new Error(
            `sectionCount is ${params.sectionCount} but the walkthrough has ${document.sections.length} changes`,
          );
        // Opening a page is a session resource of its own: a close or a
        // shutdown during it must cancel it, and nothing it produced may be
        // adopted afterwards.
        const opening = beginOpening(request.plan, toolSignal);
        let review: OpenReview;
        try {
          await verifyRange(request.plan, opening.signal);
          opening.assertCurrent();
          review = await openReview(
            request.plan,
            document,
            { ask, complete },
            { signal: opening.signal },
          );
          if (!opening.current() || active) {
            // A close raced the last await: refuse the page, do not adopt it.
            await review.server.close().catch(() => undefined);
            discardPlan(request.plan, true);
            if (pending === request) pending = undefined;
            throw new Error("the review was closed while it was opening");
          }
          pending = undefined;
          active = review;
        } catch (error) {
          // The page never opened, so this request stops being the pending
          // review and a fresh /quick-review can start.
          if (pending === request) discardPending();
          throw error;
        } finally {
          // The opening is over either way: a later close must not cancel it
          // or clean up the review it produced.
          openings.delete(opening);
          opening.settle();
        }
        void review.server.finished.then(closeActive);
        if (request.open) openBrowser(review.url);
        notifier(ctx)(`Quick Review is open at ${review.url}`, "info");
        return {
          content: [
            {
              type: "text" as const,
              text: `Quick Review is open at ${review.url} with ${document.sections.length} changes. Wait for the reviewer; do not act on the change until the outcome arrives.`,
            },
          ],
          details: {
            url: review.url,
            sections: document.sections.length,
            revision: document.revision,
          },
        };
      },
    }),
  );

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
          nodeCount: Type.Integer({ minimum: 1, maximum: GRAPH_LIMITS.nodes }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params, toolSignal, _update, ctx) {
        const request = graphPending;
        if (!request)
          throw new Error("no Quick Review is waiting for a project graph");
        if (activeGraph || active)
          throw new Error("a Quick Review is already open");
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
        graphOpening = controller;
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
            { ask: graphAsk, expand: graphExpand, complete: graphComplete },
            { signal },
          );
          if (signal.aborted || activeGraph || graphPending !== request) {
            await review.server.close().catch(() => undefined);
            discardGraphPlan(request.plan, true);
            throw new Error("the review was closed while it was opening");
          }
          graphPending = undefined;
          activeGraph = review;
        } catch (error) {
          if (graphPending === request) discardGraphPending();
          throw error;
        } finally {
          if (graphOpening === controller) graphOpening = undefined;
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
              text: `Quick Review project graph is open at ${review.url} with ${graph.nodes.length} initial nodes. Wait for enhancement requests, questions, or the outcome.`,
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
          delta: Type.String({ minLength: 1, maxLength: GRAPH_LIMITS.delta }),
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
      name: "quick_review_answer",
      label: "Answer review question",
      description:
        "Answer one open Quick Review question. Only call this for a questionId the review page asked for.",
      promptSnippet: "Answer one open Quick Review question by id",
      executionMode: "sequential",
      parameters: Type.Object(
        {
          questionId: Type.String({ pattern: "^[0-9a-f]{24}$" }),
          answer: Type.String({ minLength: 1, maxLength: LIMITS.answer }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, params) {
        const question = questions.get(params.questionId);
        if (!question)
          throw new Error("that Quick Review question is no longer open");
        question.resolve(params.answer);
        return {
          content: [
            { type: "text" as const, text: "The reviewer has the answer." },
          ],
          details: { questionId: params.questionId },
        };
      },
    }),
  );

  // The agent should answer with quick_review_answer. When it answers in plain
  // text instead, take that text, but only the text its own question drew.
  pi.on("agent_settled", (_event, ctx) => {
    for (const [id, question] of [...questions]) {
      const answer = answerFor(ctx, id);
      if (answer === undefined) continue;
      questions.delete(id);
      if (answer) question.resolve(answer);
      else
        question.reject(
          new Error("the session agent finished without an answer"),
        );
    }
  });

  pi.on("session_shutdown", async () => {
    discardPending();
    discardGraphPending();
    graphOpening?.abort();
    failQuestions("the session is shutting down");
    await closeOpenings();
    await closeActive();
  });
}
