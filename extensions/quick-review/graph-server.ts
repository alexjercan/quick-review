/** Token-protected loopback server for one progressive project graph. */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { bounded, isCommitted, LIMITS } from "./contract.ts";
import type {
  GraphComment,
  GraphCommentDelivery,
  GraphDelta,
  GraphNode,
  GraphState,
  ProjectGraph,
  ReviewerCommentMessage,
} from "./graph-contract.ts";
import { mergeGraph } from "./graph-contract.ts";
import {
  GRAPH_PAGE_CSS,
  GRAPH_PAGE_JS,
  graphPageData,
  renderGraphPage,
} from "./graph-page.ts";
import {
  addGraphComment,
  applyGraphDelta,
  editGraphComment,
  graphApprovable,
  queueGraphComment,
  replyGraphComment,
  setGraphViewed,
} from "./graph-state.ts";

export interface GraphActions {
  verify(signal: AbortSignal): Promise<void>;
  persist(state: GraphState): void;
  expand(node: GraphNode): Promise<GraphDelta>;
  comment(
    node: GraphNode,
    comment: GraphComment,
    message: ReviewerCommentMessage,
    signal: AbortSignal,
  ): Promise<string>;
  code(node: GraphNode, signal: AbortSignal): Promise<string>;
  approve(comment: string, signal: AbortSignal): Promise<string | undefined>;
  requestChanges(
    comment: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  sendReview(signal: AbortSignal): Promise<string | undefined>;
}

export interface GraphServer {
  url: string;
  port: number;
  close(): Promise<void>;
  finished: Promise<void>;
}

interface ActionRequest {
  action: string;
  node?: string;
  comment?: string;
  line?: string;
  thread?: string;
  message?: string;
}
const NODE_ACTIONS = [
  "enhance",
  "send-comment",
  "reply-comment",
  "send-reply",
  "queue-comment",
  "edit-comment",
  "code",
  "mark-viewed",
  "reopen-node",
  "add-comment",
];
const GLOBAL_ACTIONS = ["approve", "request-changes", "send-review"];
const HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function parseAction(source: string): ActionRequest {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("action request is invalid");
  const request = value as Record<string, unknown>;
  if (
    typeof request.action !== "string" ||
    Object.keys(request).some(
      (key) =>
        !["action", "node", "comment", "line", "thread", "message"].includes(
          key,
        ),
    ) ||
    (request.node !== undefined && typeof request.node !== "string") ||
    (request.comment !== undefined && typeof request.comment !== "string") ||
    (request.line !== undefined && typeof request.line !== "string") ||
    (request.thread !== undefined && typeof request.thread !== "string") ||
    (request.message !== undefined && typeof request.message !== "string")
  )
    throw new Error("action request is invalid");
  return request as unknown as ActionRequest;
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
      } else chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

export async function startGraphServer(
  graph: ProjectGraph,
  state: GraphState,
  actions: GraphActions,
): Promise<GraphServer> {
  const token = randomBytes(24).toString("base64url");
  const prefix = `/${token}/`;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T> | T): Promise<T> => {
    const result = queue.catch(() => undefined).then(task);
    queue = result;
    return result;
  };
  const commentQueue: Array<{ threadId: string; messageId: string }> = [];
  let commentWorker = false;
  let activeComment: AbortController | undefined;
  let terminal = false;
  let closing = false;
  const closer = new AbortController();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const assertOpen = () => {
    if (closing) throw new Error("the review is closing");
  };
  const data = () => graphPageData(graph, state);
  const reviewerMessages = () =>
    state.comments.flatMap((thread) =>
      thread.messages
        .filter((message) => message.author === "reviewer")
        .map((message) => ({ thread, message })),
    );
  const supersedeComments = () => {
    const previous = reviewerMessages().map(
      ({ message }) => [message.id, message.delivery] as const,
    );
    activeComment?.abort();
    commentQueue.length = 0;
    for (const { message } of reviewerMessages())
      if (message.delivery === "queued" || message.delivery === "active")
        message.delivery = "superseded";
    return previous;
  };
  const restoreComments = (
    previous: ReadonlyArray<readonly [string, GraphCommentDelivery]>,
  ) => {
    for (const [id, delivery] of previous) {
      const found = reviewerMessages().find(({ message }) => message.id === id);
      if (!found || (delivery !== "queued" && delivery !== "active")) continue;
      found.message.delivery = "queued";
      commentQueue.push({
        threadId: found.thread.id,
        messageId: found.message.id,
      });
    }
    void pumpComments();
  };
  const pumpComments = async () => {
    if (commentWorker) return;
    commentWorker = true;
    try {
      while (!terminal) {
        const current = await serialize(async () => {
          const queued = commentQueue.shift();
          const thread = state.comments.find(
            (item) => item.id === queued?.threadId,
          );
          const message = thread?.messages.find(
            (item) => item.id === queued?.messageId,
          );
          if (
            !thread ||
            !message ||
            message.author !== "reviewer" ||
            message.delivery !== "queued"
          )
            return undefined;
          try {
            await actions.verify(closer.signal);
          } catch {
            message.delivery = "failed";
            actions.persist(state);
            return undefined;
          }
          message.delivery = "active";
          actions.persist(state);
          return { thread, message };
        });
        if (!current) return;
        const merged = mergeGraph(graph, state.deltas);
        const node = merged.nodes.find(
          (item) => item.id === current.thread.nodeId,
        );
        if (!node) continue;
        const controller = new AbortController();
        activeComment = controller;
        try {
          const response = await actions.comment(
            node,
            current.thread,
            current.message,
            controller.signal,
          );
          await serialize(async () => {
            if (terminal || current.message.delivery !== "active") return;
            await actions.verify(closer.signal);
            const body = bounded(response.trim(), LIMITS.answer);
            current.message.delivery = body ? "answered" : "failed";
            if (body) {
              const index = current.thread.messages.findIndex(
                (item) => item.id === current.message.id,
              );
              current.thread.messages.splice(index + 1, 0, {
                id: randomBytes(12).toString("hex"),
                author: "agent",
                body,
              });
            }
            actions.persist(state);
          });
        } catch {
          await serialize(() => {
            if (terminal || current.message.delivery !== "active") return;
            current.message.delivery = controller.signal.aborted
              ? "superseded"
              : "failed";
            actions.persist(state);
          });
        } finally {
          if (activeComment === controller) activeComment = undefined;
        }
      }
    } finally {
      commentWorker = false;
      if (!terminal && commentQueue.length) void pumpComments();
    }
  };

  const execute = async (
    request: ActionRequest,
  ): Promise<Record<string, unknown>> => {
    const scoped = NODE_ACTIONS.includes(request.action);
    if (!scoped && !GLOBAL_ACTIONS.includes(request.action))
      throw new Error("unknown action");
    const merged = mergeGraph(graph, state.deltas);
    const node = merged.nodes.find((item) => item.id === (request.node ?? ""));
    if (scoped && !node) throw new Error("unknown graph node");
    if (terminal) throw new Error("this review already has a terminal action");
    const comment = (request.comment ?? "").trim();
    if (Buffer.byteLength(comment, "utf8") > LIMITS.comment)
      throw new Error("review text exceeds the bounded limit");
    assertOpen();
    await actions.verify(closer.signal);
    assertOpen();

    if (request.action === "mark-viewed" || request.action === "reopen-node") {
      const previous = state.viewed[node!.id]!;
      setGraphViewed(state, node!.id, request.action === "mark-viewed");
      try {
        actions.persist(state);
      } catch (error) {
        state.viewed[node!.id] = previous;
        throw error;
      }
      return {
        message:
          request.action === "mark-viewed"
            ? "Node marked viewed."
            : "Node reopened.",
      };
    }
    if (request.action === "add-comment" || request.action === "send-comment") {
      const queued = request.action === "send-comment";
      const added = addGraphComment(graph, state, node!.id, comment, {
        line: request.line,
        delivery: queued ? "queued" : "draft",
      });
      const message = added.messages[0] as ReviewerCommentMessage;
      try {
        actions.persist(state);
      } catch (error) {
        state.comments = state.comments.filter((item) => item.id !== added.id);
        throw error;
      }
      if (queued) {
        commentQueue.push({ threadId: added.id, messageId: message.id });
        void pumpComments();
      }
      return {
        message: queued
          ? "Comment queued for the session agent."
          : "Review comment recorded.",
      };
    }
    if (request.action === "reply-comment" || request.action === "send-reply") {
      const threadId = request.thread ?? "";
      const thread = state.comments.find((item) => item.id === threadId);
      if (!thread || thread.nodeId !== node!.id)
        throw new Error("unknown graph comment thread");
      const queued = request.action === "send-reply";
      const message = replyGraphComment(
        state,
        threadId,
        comment,
        queued ? "queued" : "draft",
      );
      try {
        actions.persist(state);
      } catch (error) {
        thread.messages = thread.messages.filter(
          (item) => item.id !== message.id,
        );
        throw error;
      }
      if (queued) {
        commentQueue.push({ threadId, messageId: message.id });
        void pumpComments();
      }
      return {
        message: queued
          ? "Reply queued for the session agent."
          : "Draft reply recorded.",
      };
    }
    if (request.action === "edit-comment") {
      const thread = state.comments.find((item) => item.id === request.thread);
      if (!thread || thread.nodeId !== node!.id)
        throw new Error("unknown graph comment thread");
      const target = thread.messages.find(
        (item) => item.id === request.message,
      );
      const oldBody = target?.body;
      const edited = editGraphComment(
        state,
        request.thread ?? "",
        request.message ?? "",
        comment,
      );
      try {
        actions.persist(state);
      } catch (error) {
        if (oldBody !== undefined) edited.body = oldBody;
        throw error;
      }
      return { message: `Draft ${edited.id} updated.` };
    }
    if (request.action === "queue-comment") {
      const threadId = request.thread ?? "";
      const thread = state.comments.find((item) => item.id === threadId);
      if (!thread || thread.nodeId !== node!.id)
        throw new Error("unknown graph comment thread");
      const queued = queueGraphComment(state, threadId, request.message ?? "");
      try {
        actions.persist(state);
      } catch (error) {
        queued.delivery = "draft";
        throw error;
      }
      commentQueue.push({ threadId, messageId: queued.id });
      void pumpComments();
      return { message: "Draft queued for the session agent." };
    }
    if (request.action === "enhance") {
      if (!node!.expandable) throw new Error("this node cannot be enhanced");
      const delta = await actions.expand(node!);
      assertOpen();
      await actions.verify(closer.signal);
      assertOpen();
      const oldDeltas = [...state.deltas];
      const oldViewed = { ...state.viewed };
      applyGraphDelta(graph, state, delta);
      try {
        actions.persist(state);
      } catch (error) {
        state.deltas = oldDeltas;
        state.viewed = oldViewed;
        throw error;
      }
      return { message: `Enhanced ${node!.title}.` };
    }
    if (request.action === "code") {
      const code = await actions.code(node!, closer.signal);
      return { message: "Exact code loaded.", code };
    }
    if (request.action === "send-review") {
      await actions.verify(closer.signal);
      assertOpen();
      const previousComments = supersedeComments();
      state.outcome = "commented";
      let warning: string | undefined;
      try {
        actions.persist(state);
        warning = await actions.sendReview(closer.signal);
      } catch (error) {
        if (isCommitted(error)) {
          terminal = true;
          throw error;
        }
        state.outcome = "open";
        restoreComments(previousComments);
        try {
          actions.persist(state);
        } catch {}
        throw error;
      }
      terminal = true;
      return {
        message: `Review feedback sent.${warning ? ` ${warning}` : ""}`,
      };
    }
    if (request.action === "approve") {
      if (!graphApprovable(graph, state))
        throw new Error("view every visible graph claim before approval");
      await actions.verify(closer.signal);
      assertOpen();
      const previousComments = supersedeComments();
      state.outcome = "approved";
      let warning: string | undefined;
      try {
        actions.persist(state);
        warning = await actions.approve(comment, closer.signal);
      } catch (error) {
        if (isCommitted(error)) {
          terminal = true;
          throw error;
        }
        state.outcome = "open";
        restoreComments(previousComments);
        try {
          actions.persist(state);
        } catch {}
        throw error;
      }
      terminal = true;
      return {
        message: `Approved exact graph.${warning ? ` ${warning}` : ""}`,
      };
    }
    if (!comment)
      throw new Error("Request changes needs an overall explanation");
    await actions.verify(closer.signal);
    assertOpen();
    const previousComments = supersedeComments();
    state.outcome = "changes-requested";
    let warning: string | undefined;
    try {
      warning = await actions.requestChanges(comment, closer.signal);
    } catch (error) {
      if (isCommitted(error)) {
        terminal = true;
        throw error;
      }
      state.outcome = "open";
      restoreComments(previousComments);
      throw error;
    }
    terminal = true;
    return {
      message: `Changes requested. This graph review is closed.${warning ? ` ${warning}` : ""}`,
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
        send(200, renderGraphPage(graph, state), "text/html; charset=utf-8");
      else if (path === `${prefix}state`) json(200, { ok: true, data: data() });
      else if (path === `${prefix}style.css`)
        send(200, GRAPH_PAGE_CSS, "text/css; charset=utf-8");
      else if (path === `${prefix}app.js`)
        send(200, GRAPH_PAGE_JS, "text/javascript; charset=utf-8");
      else send(404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    if (request.method !== "POST" || path !== `${prefix}action`) {
      json(404, { ok: false, error: "Not found" });
      return;
    }
    const origin = request.headers.origin;
    if (origin && originOf(origin) !== `http://${host}`) {
      json(403, { ok: false, error: "Forbidden" });
      return;
    }
    const previous = queue;
    queue = (async () => {
      await previous.catch(() => undefined);
      try {
        const result = await execute(parseAction(await readBody(request)));
        if (terminal) response.once("finish", finish);
        json(200, { ok: true, data: data(), ...result });
      } catch (error) {
        if (terminal) response.once("finish", finish);
        json(400, {
          ok: false,
          data: data(),
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
      closing = true;
      activeComment?.abort();
      closer.abort();
      server.close();
      server.closeIdleConnections?.();
      await Promise.race([
        queue.catch(() => undefined),
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
