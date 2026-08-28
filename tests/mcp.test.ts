import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { serve } from "../extensions/quick-review/jsonrpc.ts";
import {
  createQuickReviewMcp,
  type QuickReviewMcp,
} from "../extensions/quick-review/mcp.ts";
import {
  graphDelta,
  projectGraph,
  repository,
  type Fixture,
} from "./helpers.ts";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface Client {
  fixture: Fixture;
  server: QuickReviewMcp;
  call(method: string, params?: unknown): Promise<any>;
  request(
    method: string,
    params?: unknown,
  ): { id: number; result: Promise<any> };
  notify(method: string, params?: unknown): void;
  tool(name: string, args?: unknown): Promise<ToolResult>;
  cleanup(): Promise<void>;
}

function client(options: { waitTimeout?: number } = {}): Client {
  const fixture = repository();
  const stateDirectory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  process.env.QUICK_REVIEW_NO_OPEN = "1";
  const input = new PassThrough();
  const output = new PassThrough();
  const server = createQuickReviewMcp({
    cwd: fixture.path,
    waitTimeout: options.waitTimeout ?? 5000,
  });
  const connection = serve({ input, output, dispatch: server.dispatch });
  const waiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: { code: number; message: string };
      };
      const pending =
        message.id === undefined ? undefined : waiting.get(message.id);
      if (!pending) continue;
      waiting.delete(message.id!);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  });
  let counter = 0;
  const request = (method: string, params?: unknown) => {
    const id = ++counter;
    const result = new Promise<any>((resolve, reject) =>
      waiting.set(id, { resolve, reject }),
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return { id, result };
  };
  return {
    fixture,
    server,
    call: (method, params) => request(method, params).result,
    request,
    notify: (method, params) =>
      void input.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      ),
    tool: (name, args) =>
      request("tools/call", { name, arguments: args })
        .result as Promise<ToolResult>,
    cleanup: async () => {
      await server.shutdown();
      connection.close();
      fixture.cleanup();
      rmSync(stateDirectory, { recursive: true, force: true });
      delete process.env.QUICK_REVIEW_STATE_DIR;
    },
  };
}

function body(result: ToolResult): string {
  return result.content.map((item) => item.text).join("\n");
}

const RANGE = /\(([0-9a-f]{40})\) -> \S+ \(([0-9a-f]{40})\)/;

async function act(url: string, request: object) {
  const response = await fetch(new URL("action", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return { status: response.status, payload: (await response.json()) as any };
}

async function opened(session: Client, scope: "head" | "diff" = "diff") {
  const started = await session.tool("quick_review_start", {
    ...(scope === "diff" ? { base: session.fixture.base } : {}),
    target: "HEAD",
    open: false,
  });
  const range = RANGE.exec(body(started));
  assert.ok(range);
  const baseRevision = range[1]!;
  const revision = range[2]!;
  const submitted = await session.tool("quick_review_graph_submit", {
    revision,
    graph: projectGraph(revision, baseRevision, scope),
    nodeCount: 1,
  });
  const url = /(http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/.exec(
    body(submitted),
  );
  assert.ok(url);
  return { url: url[1]!, revision, baseRevision };
}

test("MCP lists only progressive graph tools", async () => {
  const session = client();
  try {
    const initialized = await session.call("initialize", {
      protocolVersion: "2025-06-18",
    });
    assert.equal(initialized.protocolVersion, "2025-06-18");
    assert.match(initialized.instructions, /project graph/);
    const listed = await session.call("tools/list");
    assert.deepEqual(
      listed.tools.map((tool: { name: string }) => tool.name),
      [
        "quick_review_start",
        "quick_review_graph_submit",
        "quick_review_graph_expand",
        "quick_review_wait",
        "quick_review_comment_respond",
        "quick_review_close",
      ],
    );
    assert.ok(
      !listed.tools.some(
        (tool: { name: string }) => tool.name === "quick_review_submit",
      ),
    );
  } finally {
    await session.cleanup();
  }
});

test("unscoped MCP start defaults to a committed HEAD graph", async () => {
  const session = client();
  try {
    const started = await session.tool("quick_review_start", { open: false });
    assert.match(body(started), /"scope": "head"/);
    assert.match(body(started), /quick_review_graph_submit/);
  } finally {
    await session.cleanup();
  }
});

test("MCP enhances, responds to comments, and sends neutral review", async () => {
  const session = client();
  try {
    const review = await opened(session);
    const enhancing = act(review.url, { action: "enhance", node: "greeting" });
    const request = await session.tool("quick_review_wait");
    const requestId = /requestId ([0-9a-f]{24})/.exec(body(request));
    assert.ok(requestId);
    await session.tool("quick_review_graph_expand", {
      requestId: requestId[1],
      delta: graphDelta(review.revision),
    });
    assert.equal((await enhancing).payload.data.nodes.length, 2);

    assert.equal(
      (
        await act(review.url, {
          action: "send-comment",
          node: "greeting.format",
          line: "2",
          comment: "Why interpolate?",
        })
      ).status,
      200,
    );
    const comment = await session.tool("quick_review_wait");
    const commentId = /commentId ([0-9a-f]{24})/.exec(body(comment));
    assert.ok(commentId);
    await session.tool("quick_review_comment_respond", {
      commentId: commentId[1],
      response: "It formats the supplied name.",
    });

    const sending = act(review.url, { action: "send-review" });
    const outcome = await session.tool("quick_review_wait");
    assert.match(body(outcome), /ended with neutral feedback/);
    assert.equal((await sending).status, 200);
  } finally {
    await session.cleanup();
  }
});

test("MCP supports committed HEAD graphs", async () => {
  const session = client();
  try {
    const review = await opened(session, "head");
    assert.equal(review.baseRevision, review.revision);
    await act(review.url, { action: "mark-viewed", node: "greeting" });
    const approving = act(review.url, {
      action: "approve",
      comment: "Snapshot accepted.",
    });
    const outcome = await session.tool("quick_review_wait");
    assert.match(body(outcome), /approved the exact HEAD project graph/);
    assert.equal((await approving).status, 200);
  } finally {
    await session.cleanup();
  }
});

test("a cancelled wait leaves the graph comment queued", async () => {
  const session = client();
  try {
    const review = await opened(session);
    const sending = act(review.url, {
      action: "send-comment",
      node: "greeting",
      line: "1",
      comment: "Is this exact?",
    });
    const first = session.request("tools/call", {
      name: "quick_review_wait",
      arguments: {},
    });
    session.notify("notifications/cancelled", { requestId: first.id });
    await first.result;
    assert.equal((await sending).status, 200);
    const second = await session.tool("quick_review_wait");
    const commentId = /commentId ([0-9a-f]{24})/.exec(body(second));
    assert.ok(commentId);
    await session.tool("quick_review_comment_respond", {
      commentId: commentId[1],
      response: "Yes.",
    });
  } finally {
    await session.cleanup();
  }
});

test("close frees MCP for another project graph", async () => {
  const session = client();
  try {
    const review = await opened(session);
    assert.match(body(await session.tool("quick_review_close")), /closed/i);
    await assert.rejects(fetch(review.url), /fetch failed|ECONNREFUSED/);
    assert.equal(
      (await session.tool("quick_review_start", { open: false })).isError,
      undefined,
    );
  } finally {
    await session.cleanup();
  }
});

test("malformed and out-of-order graph calls are tool errors", async () => {
  const session = client();
  try {
    assert.equal((await session.tool("quick_review_wait")).isError, true);
    assert.equal(
      (await session.tool("quick_review_start", { scope: "head", open: false }))
        .isError,
      true,
    );
    assert.equal(
      (
        await session.tool("quick_review_graph_submit", {
          revision: "not-a-sha",
          graph: "{}",
          nodeCount: 1,
        })
      ).isError,
      true,
    );
    await assert.rejects(
      session.call("tools/call", { arguments: {} }),
      /name is required/,
    );
  } finally {
    await session.cleanup();
  }
});
