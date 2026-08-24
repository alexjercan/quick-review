/**
 * The MCP entry point over a real transport.
 *
 * The client here writes the same newline-delimited JSON a host writes, and the
 * page is the real loopback server, so the pull loop is exercised end to end.
 */

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
import { repository, walkthrough, type Fixture } from "./helpers.ts";

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
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = createQuickReviewMcp({
    cwd: fixture.path,
    waitTimeout: options.waitTimeout ?? 5000,
  });
  const connection = serve({
    input: toServer,
    output: toClient,
    dispatch: server.dispatch,
  });

  const waiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let buffer = "";
  toClient.on("data", (chunk: Buffer) => {
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
      if (message.error) {
        const error = new Error(message.error.message);
        (error as { code?: number }).code = message.error.code;
        pending.reject(error);
      } else pending.resolve(message.result);
    }
  });

  let counter = 0;
  const request = (method: string, params?: unknown) => {
    const id = ++counter;
    const result = new Promise<any>((resolve, reject) =>
      waiting.set(id, { resolve, reject }),
    );
    toServer.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return { id, result };
  };

  return {
    fixture,
    server,
    call: (method, params) => request(method, params).result,
    request,
    notify: (method, params) =>
      void toServer.write(
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

/** Start a review, submit a one-change walkthrough, and return the page URL. */
async function opened(
  session: Client,
  sections = [{ id: "greet-by-name" }],
): Promise<string> {
  const started = await session.tool("quick_review_start", { open: false });
  const range = RANGE.exec(body(started));
  assert.ok(range, "the walkthrough request names both revisions");
  const [, baseRevision, revision] = range as unknown as [
    string,
    string,
    string,
  ];
  const submitted = await session.tool("quick_review_submit", {
    revision,
    markdown: walkthrough(revision, baseRevision, sections),
    sectionCount: sections.length,
  });
  assert.equal(submitted.isError, undefined);
  const url = /(http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/.exec(
    body(submitted),
  );
  assert.ok(url, "submit reports the page URL");
  return url[1]!;
}

test("the server initializes and lists its tools", async () => {
  const session = client();
  try {
    const initialized = await session.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(initialized.protocolVersion, "2025-06-18");
    assert.deepEqual(initialized.capabilities, { tools: {} });
    assert.equal(initialized.serverInfo.name, "quick-review");
    assert.match(initialized.instructions, /quick_review_wait/);
    session.notify("notifications/initialized");
    assert.deepEqual(await session.call("ping"), {});
    const listed = await session.call("tools/list");
    assert.deepEqual(
      listed.tools.map((tool: { name: string }) => tool.name),
      [
        "quick_review_start",
        "quick_review_submit",
        "quick_review_wait",
        "quick_review_answer",
        "quick_review_close",
      ],
    );
  } finally {
    await session.cleanup();
  }
});

test("an unknown protocol version falls back to a supported one", async () => {
  const session = client();
  try {
    const initialized = await session.call("initialize", {
      protocolVersion: "1999-01-01",
    });
    assert.equal(initialized.protocolVersion, "2025-06-18");
  } finally {
    await session.cleanup();
  }
});

test("an unknown method is a protocol error", async () => {
  const session = client();
  try {
    await assert.rejects(session.call("resources/list"), /unknown method/);
  } finally {
    await session.cleanup();
  }
});

test("the agent walks a review from start to approval", async () => {
  const session = client();
  try {
    const url = await opened(session);

    // The reviewer works the page, so the agent goes and waits for them.
    const asking = act(url, {
      action: "ask",
      section: "greet-by-name",
      comment: "Why interpolate instead of concatenating?",
    });
    const waited = await session.tool("quick_review_wait");
    assert.equal(waited.isError, undefined);
    assert.match(body(waited), /Why interpolate/);
    assert.match(body(waited), /quick_review_answer/);
    const questionId = /questionId ([0-9a-f]{24})/.exec(body(waited));
    assert.ok(questionId, "the wait names the question to answer");

    const answered = await session.tool("quick_review_answer", {
      questionId: questionId[1],
      answer: "A template keeps the empty-name case readable.",
    });
    assert.equal(answered.isError, undefined);
    const asked = await asking;
    assert.equal(asked.status, 200);
    assert.match(asked.payload.message, /answered/);

    await act(url, { action: "mark-viewed", section: "greet-by-name" });
    const approving = act(url, { action: "approve", comment: "Looks right." });
    const outcome = await session.tool("quick_review_wait");
    assert.equal(outcome.isError, undefined);
    assert.match(body(outcome), /approved this exact revision/);
    assert.match(body(outcome), /Looks right/);
    assert.match(body(outcome), /Stop calling quick_review_wait/);
    assert.equal((await approving).status, 200);
  } finally {
    await session.cleanup();
  }
});

test("a change request comes back with its explanation", async () => {
  const session = client();
  try {
    const url = await opened(session);
    const requesting = act(url, {
      action: "request-changes",
      comment: "Guard the empty name.",
    });
    const outcome = await session.tool("quick_review_wait");
    assert.match(body(outcome), /requested changes on this exact revision/);
    assert.match(body(outcome), /Guard the empty name/);
    assert.match(body(outcome), /walkthrough is invalidated/);
    assert.equal((await requesting).status, 200);
  } finally {
    await session.cleanup();
  }
});

test("waiting without a review is a tool error, not a protocol error", async () => {
  const session = client();
  try {
    const waited = await session.tool("quick_review_wait");
    assert.equal(waited.isError, true);
    assert.match(body(waited), /no Quick Review is open/);
    const answered = await session.tool("quick_review_answer", {
      questionId: "a".repeat(24),
      answer: "nobody asked",
    });
    assert.equal(answered.isError, true);
    assert.match(body(answered), /no longer open/);
  } finally {
    await session.cleanup();
  }
});

test("an empty wait tells the agent to keep waiting", async () => {
  const session = client({ waitTimeout: 50 });
  try {
    await opened(session);
    const waited = await session.tool("quick_review_wait");
    assert.equal(waited.isError, undefined);
    assert.match(body(waited), /Call quick_review_wait again/);
  } finally {
    await session.cleanup();
  }
});

test("a cancelled wait leaves the reviewer's question for the next one", async () => {
  const session = client();
  try {
    const url = await opened(session);
    const asking = act(url, {
      action: "ask",
      section: "greet-by-name",
      comment: "Is the name ever undefined?",
    });
    const first = session.request("tools/call", {
      name: "quick_review_wait",
      arguments: {},
    });
    // The user pressed escape. The question is still the reviewer's, so it must
    // survive for whichever wait comes next.
    session.notify("notifications/cancelled", { requestId: first.id });
    await first.result;
    const second = await session.tool("quick_review_wait");
    assert.match(body(second), /Is the name ever undefined/);
    const questionId = /questionId ([0-9a-f]{24})/.exec(body(second))![1];
    await session.tool("quick_review_answer", {
      questionId,
      answer: "The template renders undefined literally.",
    });
    assert.equal((await asking).status, 200);
  } finally {
    await session.cleanup();
  }
});

test("a second start is refused while one review is in flight", async () => {
  const session = client();
  try {
    const started = await session.tool("quick_review_start", { open: false });
    assert.equal(started.isError, undefined);
    const again = await session.tool("quick_review_start", { open: false });
    assert.equal(again.isError, true);
    assert.match(body(again), /already open/);
  } finally {
    await session.cleanup();
  }
});

test("a walkthrough for the wrong revision is refused and the review survives", async () => {
  const session = client();
  try {
    const started = await session.tool("quick_review_start", { open: false });
    const [, baseRevision, revision] = RANGE.exec(body(started)) as unknown as [
      string,
      string,
      string,
    ];
    const refused = await session.tool("quick_review_submit", {
      revision: "0".repeat(40),
      markdown: walkthrough(revision, baseRevision),
      sectionCount: 1,
    });
    assert.equal(refused.isError, true);
    assert.match(body(refused), /revision does not match/);
    // The plan is untouched, so the agent can submit the right walkthrough.
    const accepted = await session.tool("quick_review_submit", {
      revision,
      markdown: walkthrough(revision, baseRevision),
      sectionCount: 1,
    });
    assert.equal(accepted.isError, undefined);
  } finally {
    await session.cleanup();
  }
});

test("a malformed call is an invalid-params error", async () => {
  const session = client();
  try {
    await assert.rejects(
      session.call("tools/call", { arguments: {} }),
      /name is required/,
    );
    const bad = await session.tool("quick_review_submit", {
      revision: "not-a-sha",
      markdown: "x",
      sectionCount: 1,
    });
    assert.equal(bad.isError, true);
  } finally {
    await session.cleanup();
  }
});

test("closing ends the review and frees the server for the next one", async () => {
  const session = client();
  try {
    const url = await opened(session);
    const closed = await session.tool("quick_review_close");
    assert.match(body(closed), /Quick Review closed/);
    await assert.rejects(fetch(url), /fetch failed|ECONNREFUSED/);
    const waited = await session.tool("quick_review_wait");
    assert.equal(waited.isError, true);
    const started = await session.tool("quick_review_start", { open: false });
    assert.equal(started.isError, undefined);
  } finally {
    await session.cleanup();
  }
});
