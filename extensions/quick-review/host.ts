/**
 * A review host for agents that pull instead of being pushed to.
 *
 * Pi pushes: the extension injects a message and triggers a turn, so the page
 * can interrupt the agent at any moment. An agent that cannot be interrupted
 * has to come and ask, so this host queues what the page produces and hands it
 * over one event at a time.
 *
 * A waiter that gives up takes nothing with it. Events are only removed from
 * the queue at the moment they are handed to a live waiter, so a cancelled wait
 * leaves the reviewer's question exactly where it was.
 */

import { randomBytes } from "node:crypto";
import {
  bounded,
  LIMITS,
  type CompletionEvent,
  type WalkthroughSection,
} from "./contract.ts";
import type { ReviewHost } from "./review.ts";

/** How long the page waits for the agent to answer one question. */
export const QUESTION_TIMEOUT = 15 * 60 * 1000;

export interface QuestionEvent {
  kind: "question";
  questionId: string;
  sectionId: string;
  section: WalkthroughSection;
  question: string;
}

export interface OutcomeEvent {
  kind: "outcome";
  event: CompletionEvent;
  warning?: string;
}

export type ReviewEvent = QuestionEvent | OutcomeEvent;

export interface WaitOptions {
  /** Give up after this long and leave the queue untouched. */
  timeout?: number;
  signal?: AbortSignal;
}

export interface QueueHost extends ReviewHost {
  /** Take the oldest event, or undefined when the wait ends empty. */
  next(options?: WaitOptions): Promise<ReviewEvent | undefined>;
  /** Settle one open question. False when that question is no longer open. */
  answer(questionId: string, answer: string): boolean;
  /** Fail every open question and drop every undelivered event. */
  fail(reason: string): void;
  /** Questions the page is still waiting on. */
  readonly open: number;
}

interface Waiter {
  settle(event: ReviewEvent | undefined): void;
}

export interface HostOptions {
  questionTimeout?: number;
  id?: () => string;
}

export function createQueueHost(options: HostOptions = {}): QueueHost {
  const questionTimeout = options.questionTimeout ?? QUESTION_TIMEOUT;
  const identify = options.id ?? (() => randomBytes(12).toString("hex"));
  const queue: ReviewEvent[] = [];
  const waiters: Waiter[] = [];
  const questions = new Map<
    string,
    { resolve(answer: string): void; reject(error: Error): void }
  >();

  const drain = () => {
    while (queue.length > 0 && waiters.length > 0)
      waiters.shift()!.settle(queue.shift()!);
  };

  const push = (event: ReviewEvent) => {
    queue.push(event);
    drain();
  };

  return {
    get open() {
      return questions.size;
    },

    ask: (request) => {
      const questionId = identify();
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          questions.delete(questionId);
          reject(new Error("the session agent did not answer in time"));
        }, questionTimeout);
        timer.unref?.();
        const settle = (finish: () => void) => {
          clearTimeout(timer);
          questions.delete(questionId);
          finish();
        };
        questions.set(questionId, {
          resolve: (answer) => settle(() => resolve(answer)),
          reject: (error) => settle(() => reject(error)),
        });
        push({
          kind: "question",
          questionId,
          sectionId: request.sectionId,
          section: request.section,
          question: request.question,
        });
      });
    },

    complete: (event, warning) =>
      void push({ kind: "outcome", event, warning }),

    answer: (questionId, answer) => {
      const question = questions.get(questionId);
      if (!question) return false;
      question.resolve(bounded(answer, LIMITS.answer));
      return true;
    },

    next: ({ timeout, signal }: WaitOptions = {}) => {
      // Cancelled first, queue second: a wait nobody is listening to any more
      // must not take an event with it.
      if (signal?.aborted) return Promise.resolve(undefined);
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise<ReviewEvent | undefined>((resolve) => {
        let settled = false;
        // Leaving the queue first is what makes giving up lossless: after this
        // the waiter can never be handed an event it will not deliver.
        const give = (event: ReviewEvent | undefined) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(event);
        };
        const waiter: Waiter = { settle: give };
        const abort = () => give(undefined);
        const timer = timeout
          ? setTimeout(() => give(undefined), timeout)
          : undefined;
        timer?.unref?.();
        signal?.addEventListener("abort", abort, { once: true });
        waiters.push(waiter);
      });
    },

    fail: (reason) => {
      queue.length = 0;
      for (const [questionId, question] of [...questions]) {
        questions.delete(questionId);
        question.reject(new Error(reason));
      }
      while (waiters.length > 0) waiters.shift()!.settle(undefined);
    },
  };
}
