/** Server rules that need a controlled actions layer: rechecks and commits. */

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import {
  committedError,
  type ReviewState,
  type WalkthroughDocument,
} from "../extensions/quick-review/contract.ts";
import {
  startReviewServer,
  type ReviewActions,
  type ReviewServer,
} from "../extensions/quick-review/server.ts";
import { initialState } from "../extensions/quick-review/state.ts";
import { parseWalkthrough } from "../extensions/quick-review/walkthrough.ts";
import { walkthrough } from "./helpers.ts";

const REVISION = "a".repeat(40);
const BASE = "b".repeat(40);

interface Harness {
  server: ReviewServer;
  document: WalkthroughDocument;
  state: ReviewState;
  calls: string[];
  act(body: object): Promise<{ status: number; payload: any }>;
  close(): Promise<void>;
}

async function harness(
  overrides: Partial<ReviewActions> = {},
): Promise<Harness> {
  const document = parseWalkthrough(
    walkthrough(REVISION, BASE, [{ id: "one" }]),
  );
  const state = initialState(document);
  const calls: string[] = [];
  const actions: ReviewActions = {
    verify: async () => void calls.push("verify"),
    persist: () => calls.push("persist"),
    context: async () => "context",
    fullDiff: async () => "diff",
    ask: async () => "answer",
    approve: async () => void calls.push("approve"),
    requestChanges: async () => void calls.push("request-changes"),
    ...overrides,
  };
  const server = await startReviewServer(document, state, actions);
  return {
    server,
    document,
    state,
    calls,
    act: async (body) => {
      const response = await fetch(new URL("action", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, payload: await response.json() };
    },
    close: () => server.close(),
  };
}

function rawStatus(
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(target.port),
        path: `${target.pathname}action`,
        method: "POST",
        headers: { "content-length": "0", ...headers },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    call.once("error", reject);
    call.end();
  });
}

test("a terminal action rechecks the revision immediately before committing", async () => {
  let checks = 0;
  const test = await harness({
    verify: async () => {
      checks += 1;
      // The range moves after the action is admitted but before it commits.
      if (checks > 1) throw new Error("the reviewed revision changed");
    },
  });
  try {
    await test.act({ action: "mark-viewed", section: "one" });
    checks = 0;
    const result = await test.act({ action: "approve" });
    assert.equal(result.status, 400);
    assert.match(result.payload.error, /reviewed revision changed/);
    assert.equal(result.payload.state.outcome, "open");
    assert.ok(!test.calls.includes("approve"));
  } finally {
    await test.close();
  }
});

test("request changes also rechecks before committing", async () => {
  let checks = 0;
  const test = await harness({
    verify: async () => {
      checks += 1;
      if (checks > 1) throw new Error("the reviewed revision changed");
    },
  });
  try {
    const result = await test.act({
      action: "request-changes",
      comment: "not yet",
    });
    assert.equal(result.status, 400);
    assert.match(result.payload.error, /reviewed revision changed/);
    assert.ok(!test.calls.includes("request-changes"));
  } finally {
    await test.close();
  }
});

test("a decision that is already durable is never reopened", async () => {
  const test = await harness({
    approve: async () => {
      throw committedError();
    },
  });
  try {
    await test.act({ action: "mark-viewed", section: "one" });
    const result = await test.act({ action: "approve" });
    assert.equal(result.status, 400);
    assert.match(result.payload.error, /already has a terminal action/);
    // The review is closed, not reopened: no later action may replace it.
    const after = await test.act({ action: "request-changes", comment: "no" });
    assert.equal(after.status, 400);
    assert.match(after.payload.error, /already has a terminal action/);
    await test.server.finished;
  } finally {
    await test.close();
  }
});

test("a failure before the commit boundary reopens the review", async () => {
  const test = await harness({
    approve: async () => {
      throw new Error("delivery failed");
    },
  });
  try {
    await test.act({ action: "mark-viewed", section: "one" });
    const result = await test.act({ action: "approve" });
    assert.equal(result.status, 400);
    // approve() failing before the commit boundary must reopen the review.
    assert.equal(result.payload.state.outcome, "open");
    const retry = await test.act({ action: "approve" });
    assert.equal(retry.status, 400);
    assert.match(retry.payload.error, /delivery failed/);
  } finally {
    await test.close();
  }
});

test("an action must come from the exact origin of its own request", async () => {
  const test = await harness();
  try {
    const port = test.server.port;
    const cases: Array<[string, string, number]> = [
      // scheme mismatch
      [`127.0.0.1:${port}`, `https://127.0.0.1:${port}`, 403],
      // both cross-alias directions: the aliases are different origins
      [`127.0.0.1:${port}`, `http://localhost:${port}`, 403],
      [`localhost:${port}`, `http://127.0.0.1:${port}`, 403],
      // each alias with its own origin is accepted and reaches the action
      [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`, 400],
      [`localhost:${port}`, `http://localhost:${port}`, 400],
    ];
    for (const [host, origin, expected] of cases)
      assert.equal(
        await rawStatus(test.server.url, {
          host,
          "content-type": "application/json",
          origin,
        }),
        expected,
        `${host} with ${origin}`,
      );
  } finally {
    await test.close();
  }
});

test("closing stops acceptance and fences work already in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let checks = 0;
  const test = await harness({
    verify: async () => {
      checks += 1;
      if (checks > 1) await gate;
    },
  });
  try {
    // Admit one action, then hold it inside its own revision check.
    await test.act({ action: "mark-viewed", section: "one" });
    const slow = test.act({ action: "reopen", section: "one" });
    while (checks < 2) await new Promise((resolve) => setTimeout(resolve, 5));

    const closed = test.server.close();
    // Acceptance stops synchronously, before the drain finishes.
    const during = await test
      .act({ action: "mark-viewed", section: "one" })
      .catch(() => ({ status: 0, payload: {} }));
    assert.ok(
      during.status === 503 || during.status === 0,
      `late request was accepted with ${during.status}`,
    );

    release();
    await closed;
    const result = await slow.catch(() => ({ status: 0, payload: {} }));
    if (result.status !== 0) {
      assert.equal(result.status, 400);
      assert.match(result.payload.error, /closing/);
    }
    // The fenced action must not have mutated the review.
    assert.equal(test.state.viewed.one, true);
  } finally {
    await test.close();
  }
});

test("a terminal action cannot commit once the review is closing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let checks = 0;
  const test = await harness({
    verify: async () => {
      checks += 1;
      if (checks > 1) await gate;
    },
  });
  try {
    await test.act({ action: "mark-viewed", section: "one" });
    const approving = test.act({ action: "approve", comment: "ship" });
    while (checks < 2) await new Promise((resolve) => setTimeout(resolve, 5));

    const closed = test.server.close();
    release();
    await closed;
    await approving.catch(() => undefined);
    assert.ok(
      !test.calls.includes("approve"),
      "approve committed while closing",
    );
    assert.equal(test.state.outcome, "open");
  } finally {
    await test.close();
  }
});

test("actions receive an abort signal that a close triggers", async () => {
  let seen: AbortSignal | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let checks = 0;
  const test = await harness({
    verify: async (signal) => {
      seen = signal;
      checks += 1;
      if (checks > 1) await gate;
    },
  });
  try {
    await test.act({ action: "mark-viewed", section: "one" });
    const slow = test.act({ action: "reopen", section: "one" });
    while (checks < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(seen);
    assert.equal(seen!.aborted, false);
    const closed = test.server.close();
    assert.equal(seen!.aborted, true);
    release();
    await closed;
    await slow.catch(() => undefined);
  } finally {
    await test.close();
  }
});
