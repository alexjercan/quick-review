/**
 * Loopback review page server.
 *
 * The page lives behind a random path token on 127.0.0.1, every action
 * rechecks the reviewed revision, and one terminal action closes the review.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  isCommitted,
  LIMITS,
  type ReviewState,
  type WalkthroughDocument,
  type WalkthroughSection,
} from "./contract.ts";
import { PAGE_CSS, PAGE_JS, renderPage } from "./page.ts";
import {
  addComment,
  isApprovable,
  recordQuestion,
  setViewed,
} from "./state.ts";

/**
 * Everything the page can ask for. Each asynchronous action receives the
 * server's abort signal so a close can cancel work already in flight.
 * The terminal actions may return a warning to show the reviewer.
 */
export interface ReviewActions {
  /** Recheck that the reviewed range still resolves to the same revisions. */
  verify(signal: AbortSignal): Promise<void>;
  persist(state: ReviewState): void;
  context(section: WalkthroughSection, signal: AbortSignal): Promise<string>;
  fullDiff(signal: AbortSignal): Promise<string>;
  ask(sectionId: string, question: string): Promise<string>;
  approve(
    overallComment: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  requestChanges(
    explanation: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}

export interface ReviewServer {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Resolves after a terminal action commits. */
  finished: Promise<void>;
}

interface ActionRequest {
  action: string;
  section?: string;
  comment?: string;
}

const SECTION_ACTIONS = [
  "mark-viewed",
  "reopen",
  "add-comment",
  "explain",
  "ask",
  "context",
];
const GLOBAL_ACTIONS = ["full-diff", "approve", "request-changes"];

const HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function parseAction(body: string): ActionRequest {
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("action request is invalid");
  const request = value as Record<string, unknown>;
  if (
    typeof request.action !== "string" ||
    Object.keys(request).some(
      (key) => !["action", "section", "comment"].includes(key),
    ) ||
    (request.section !== undefined && typeof request.section !== "string") ||
    (request.comment !== undefined && typeof request.comment !== "string")
  )
    throw new Error("action request is invalid");
  return request as unknown as ActionRequest;
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > LIMITS.request) {
        reject(new Error("action body exceeds the review limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

export async function startReviewServer(
  document: WalkthroughDocument,
  state: ReviewState,
  actions: ReviewActions,
): Promise<ReviewServer> {
  const token = randomBytes(24).toString("base64url");
  const prefix = `/${token}/`;
  let queue: Promise<unknown> = Promise.resolve();
  let terminal: "open" | "committed" = "open";
  let closing = false;
  const closer = new AbortController();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));

  /**
   * Fence every step that mutates state or commits a decision. Close sets the
   * flag synchronously, so nothing admitted before a close can act after it.
   */
  const assertOpen = () => {
    if (closing) throw new Error("the review is closing");
  };

  const execute = async (
    request: ActionRequest,
  ): Promise<{ message: string; context?: string; diff?: string }> => {
    const { action } = request;
    const sectionId = request.section ?? "";
    const section = document.sections.find((item) => item.id === sectionId);
    const scoped = SECTION_ACTIONS.includes(action);
    if (!scoped && !GLOBAL_ACTIONS.includes(action))
      throw new Error("unknown action");
    if (scoped && !section) throw new Error("unknown change");
    if (terminal !== "open")
      throw new Error("this review already has a terminal action");
    const comment = (request.comment ?? "").trim();
    if (Buffer.byteLength(comment, "utf8") > LIMITS.comment)
      throw new Error("review text exceeds the bounded review limit");

    assertOpen();
    await actions.verify(closer.signal);
    assertOpen();

    if (action === "mark-viewed" || action === "reopen") {
      const previous = {
        viewed: state.viewed[sectionId]!,
        section: state.sections[sectionId]!,
      };
      setViewed(state, sectionId, action === "mark-viewed");
      try {
        actions.persist(state);
      } catch (error) {
        state.viewed[sectionId] = previous.viewed;
        state.sections[sectionId] = previous.section;
        throw error;
      }
      return {
        message: action === "mark-viewed" ? "Marked viewed." : "Reopened.",
      };
    }
    if (action === "add-comment") {
      const added = addComment(document, state, sectionId, comment);
      try {
        actions.persist(state);
      } catch (error) {
        state.comments = state.comments.filter((item) => item.id !== added.id);
        throw error;
      }
      return { message: "Comment recorded." };
    }
    if (action === "explain" || action === "ask") {
      const question = action === "explain" ? section!.prompt : comment;
      if (!question) throw new Error("a question needs text");
      const answer = await actions.ask(sectionId, question);
      if (!answer.trim()) throw new Error("the agent returned no answer");
      assertOpen();
      await actions.verify(closer.signal);
      assertOpen();
      const previous = state.sections[sectionId]!;
      recordQuestion(state, sectionId, question, answer);
      try {
        actions.persist(state);
      } catch (error) {
        state.questions.pop();
        state.sections[sectionId] = previous;
        throw error;
      }
      return { message: "The session agent answered." };
    }
    if (action === "context") {
      const context = await actions.context(section!, closer.signal);
      if (Buffer.byteLength(context, "utf8") > LIMITS.context)
        throw new Error("exact-revision context exceeds the review limit");
      return { message: "Exact-revision context loaded.", context };
    }
    if (action === "full-diff") {
      const diff = await actions.fullDiff(closer.signal);
      return { message: "Loaded the exact full diff.", diff };
    }
    if (action === "approve") {
      if (!isApprovable(state))
        throw new Error("every change must be viewed before approval");
      // Recheck immediately before the durable transition: the entry check
      // above happened before this action's own work.
      await actions.verify(closer.signal);
      assertOpen();
      state.outcome = "approved";
      let warning: string | undefined;
      try {
        actions.persist(state);
        warning = await actions.approve(comment, closer.signal);
      } catch (error) {
        if (isCommitted(error)) {
          terminal = "committed";
          throw error;
        }
        state.outcome = "open";
        try {
          actions.persist(state);
        } catch {
          /* the in-memory state is authoritative for the response */
        }
        throw error;
      }
      terminal = "committed";
      return {
        message: `Approved. The session agent has the result.${warning ? ` ${warning}` : ""}`,
      };
    }
    if (!comment)
      throw new Error("Request changes needs an overall review comment");
    await actions.verify(closer.signal);
    assertOpen();
    state.outcome = "changes-requested";
    let warning: string | undefined;
    try {
      warning = await actions.requestChanges(comment, closer.signal);
    } catch (error) {
      if (isCommitted(error)) {
        terminal = "committed";
        throw error;
      }
      state.outcome = "open";
      throw error;
    }
    terminal = "committed";
    return {
      message: `Changes requested. This review is closed.${warning ? ` ${warning}` : ""}`,
    };
  };

  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) => {
    const send = (status: number, body: string, type: string) => {
      response.writeHead(status, { ...HEADERS, "Content-Type": type });
      response.end(body);
    };
    const json = (status: number, value: object) =>
      send(status, JSON.stringify(value), "application/json; charset=utf-8");
    if (closing) {
      send(503, "Review is closing", "text/plain; charset=utf-8");
      return;
    }
    const address = server.address() as AddressInfo | null;
    const host = request.headers.host ?? "";
    const hosts = address
      ? [`127.0.0.1:${address.port}`, `localhost:${address.port}`]
      : [];
    if (!hosts.includes(host)) {
      send(403, "Forbidden", "text/plain; charset=utf-8");
      return;
    }
    const path = new URL(request.url ?? "/", `http://${host}`).pathname;
    if (request.method === "GET") {
      if (path === prefix)
        send(200, renderPage(document, state), "text/html; charset=utf-8");
      else if (path === `${prefix}style.css`)
        send(200, PAGE_CSS, "text/css; charset=utf-8");
      else if (path === `${prefix}app.js`)
        send(200, PAGE_JS, "text/javascript; charset=utf-8");
      else send(404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    if (request.method !== "POST" || path !== `${prefix}action`) {
      json(404, { ok: false, error: "Not found" });
      return;
    }
    // The page origin is the one this request names, not either loopback alias.
    const origin = request.headers.origin;
    if (origin && originOf(origin) !== `http://${host}`) {
      json(403, { ok: false, error: "Forbidden" });
      return;
    }
    const previous = queue;
    queue = (async () => {
      await previous.catch(() => undefined);
      try {
        const action = parseAction(await readBody(request));
        const result = await execute(action);
        if (terminal === "committed") response.once("finish", finish);
        json(200, { ok: true, state, ...result });
      } catch (error) {
        // A commit that reported failure is still a commit: close the review.
        if (terminal === "committed") response.once("finish", finish);
        json(400, {
          ok: false,
          state,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}${prefix}`,
    port: address.port,
    finished,
    close: async () => {
      // Stop accepting and cancel in-flight work before anything is awaited,
      // so no action admitted earlier can mutate or commit after this returns.
      closing = true;
      closer.abort();
      server.close();
      server.closeIdleConnections?.();
      // Then give in-flight actions a bounded chance to answer their caller.
      await Promise.race([
        (async () => {
          let seen: Promise<unknown> | undefined;
          while (seen !== queue) {
            seen = queue;
            await seen.catch(() => undefined);
          }
        })(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          timer.unref?.();
        }),
      ]);
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          for (const socket of sockets) socket.destroy();
          resolve();
          return;
        }
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
