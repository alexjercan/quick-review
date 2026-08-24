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
  const questions = new Map<string, PendingQuestion>();

  const openings = new Set<Opening>();

  const closeActive = async () => {
    const review = active;
    active = undefined;
    if (review) await review.server.close().catch(() => undefined);
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

  const failQuestions = (reason: string) => {
    for (const [id, question] of questions) {
      questions.delete(id);
      question.reject(new Error(reason));
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
      const flags = ["--base", "--target", "--repo", "--no-open", "--help"]
        .filter((flag) => flag.startsWith(prefix))
        .map((flag) => ({ value: flag, label: flag }));
      return flags.length > 0 ? flags : null;
    },
    handler: async (args, ctx) => {
      const say = notifier(ctx);
      // Only this invocation's own plan may be discarded on failure. A refused
      // duplicate must leave the review it collided with untouched.
      let created: ReviewPlan | undefined;
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
        if (active || pending)
          throw new Error(
            "a Quick Review is already open; finish it on the page or run /quick-review-close",
          );
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
      const wasPending = pending !== undefined || openings.size > 0;
      discardPending();
      failQuestions("the review page was closed");
      const wasOpen = active !== undefined;
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
    failQuestions("the session is shutting down");
    await closeOpenings();
    await closeActive();
  });
}
