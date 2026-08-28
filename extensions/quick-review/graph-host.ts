/** Pull-based graph host for MCP sessions. */

import { randomBytes } from "node:crypto";
import { bounded, LIMITS } from "./contract.ts";
import type {
  GraphComment,
  GraphCompletionEvent,
  GraphDelta,
  GraphNode,
  ReviewerCommentMessage,
} from "./graph-contract.ts";
import type { GraphHost } from "./graph-review.ts";

export type GraphHostEvent =
  | {
      kind: "comment";
      requestId: string;
      node: GraphNode;
      comment: GraphComment;
      message: ReviewerCommentMessage;
    }
  | {
      kind: "expansion";
      requestId: string;
      node: GraphNode;
      knownIds: string[];
    }
  | { kind: "outcome"; event: GraphCompletionEvent; warning?: string };

export interface GraphQueueHost extends GraphHost {
  next(options?: {
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<GraphHostEvent | undefined>;
  respondToComment(requestId: string, response: string): boolean;
  submitExpansion(requestId: string, delta: GraphDelta): boolean;
  fail(reason: string): void;
}

export function createGraphQueueHost(
  options: { timeout?: number; id?: () => string } = {},
): GraphQueueHost {
  const timeout = options.timeout ?? 15 * 60 * 1000;
  const identify = options.id ?? (() => randomBytes(12).toString("hex"));
  const queue: GraphHostEvent[] = [];
  const waiters: Array<(event: GraphHostEvent | undefined) => void> = [];
  const comments = new Map<
    string,
    { resolve(value: string): void; reject(error: Error): void }
  >();
  const expansions = new Map<
    string,
    { resolve(value: GraphDelta): void; reject(error: Error): void }
  >();
  const push = (event: GraphHostEvent) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else queue.push(event);
  };
  const pending = <T>(
    map: Map<string, { resolve(value: T): void; reject(error: Error): void }>,
    id: string,
    event: GraphHostEvent,
  ) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        map.delete(id);
        reject(new Error("the session agent did not answer in time"));
      }, timeout);
      timer.unref?.();
      map.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          map.delete(id);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          map.delete(id);
          reject(error);
        },
      });
      push(event);
    });
  return {
    comment: ({ node, comment, message, signal }) => {
      const requestId = message.id;
      const result = pending(comments, requestId, {
        kind: "comment",
        requestId,
        node,
        comment: structuredClone(comment),
        message: structuredClone(message),
      });
      const abort = () => {
        const request = comments.get(requestId);
        if (!request) return;
        queue.splice(
          0,
          queue.length,
          ...queue.filter(
            (event) =>
              event.kind !== "comment" || event.requestId !== requestId,
          ),
        );
        request.reject(new Error("the comment was superseded"));
      };
      signal.addEventListener("abort", abort, { once: true });
      return result.finally(() => signal.removeEventListener("abort", abort));
    },
    expand: ({ node, knownIds }) => {
      const requestId = identify();
      return pending(expansions, requestId, {
        kind: "expansion",
        requestId,
        node,
        knownIds,
      });
    },
    complete: (event, warning) =>
      void push({ kind: "outcome", event, warning }),
    next: ({ timeout: wait, signal } = {}) => {
      if (signal?.aborted) return Promise.resolve(undefined);
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => {
        let settled = false;
        const give = (event: GraphHostEvent | undefined) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          const index = waiters.indexOf(give);
          if (index >= 0) waiters.splice(index, 1);
          resolve(event);
        };
        const abort = () => give(undefined);
        const timer = wait
          ? setTimeout(() => give(undefined), wait)
          : undefined;
        timer?.unref?.();
        signal?.addEventListener("abort", abort, { once: true });
        waiters.push(give);
      });
    },
    respondToComment: (id, response) => {
      const request = comments.get(id);
      if (!request) return false;
      request.resolve(bounded(response, LIMITS.answer));
      return true;
    },
    submitExpansion: (requestId, delta) => {
      const request = expansions.get(requestId);
      if (!request) return false;
      request.resolve(delta);
      return true;
    },
    fail: (reason) => {
      queue.length = 0;
      for (const request of comments.values())
        request.reject(new Error(reason));
      for (const request of expansions.values())
        request.reject(new Error(reason));
      comments.clear();
      expansions.clear();
      while (waiters.length) waiters.shift()!(undefined);
    },
  } as GraphQueueHost;
}
