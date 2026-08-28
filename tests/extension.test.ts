/**
 * The Pi entry point itself: registration, generation, answers, guards,
 * terminal delivery, and shutdown, against a controlled Pi harness.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COMPLETION_EVENT } from "../extensions/quick-review/contract.ts";
import quickReview from "../extensions/quick-review/index.ts";
import { createPi, type PiHarness } from "./pi-harness.ts";
import {
  graphDelta,
  projectGraph,
  repository,
  walkthrough,
  type Fixture,
} from "./helpers.ts";

interface Session {
  pi: PiHarness;
  fixture: Fixture;
  stateDirectory: string;
  url: string;
  act(body: object): Promise<{ status: number; payload: any }>;
  cleanup(): void;
}

function start(mode: "tui" | "rpc" | "json" | "print" = "tui"): {
  pi: PiHarness;
  fixture: Fixture;
  stateDirectory: string;
  cleanup(): void;
} {
  const fixture = repository();
  const stateDirectory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  process.env.QUICK_REVIEW_NO_OPEN = "1";
  const pi = createPi({ cwd: fixture.path, mode });
  quickReview(pi.api);
  return {
    pi,
    fixture,
    stateDirectory,
    cleanup: () => {
      fixture.cleanup();
      rmSync(stateDirectory, { recursive: true, force: true });
      delete process.env.QUICK_REVIEW_STATE_DIR;
    },
  };
}

/** Drive the command and the submit tool the way a real session would. */
async function session(sections = [{ id: "greet-by-name" }]): Promise<Session> {
  const base = start();
  await base.pi.run("quick-review", "--no-open");
  const request = base.pi.deliver("quick-review-request");
  const revision = String(request.details?.revision);
  const baseRevision = String(request.details?.baseRevision);
  const markdown = walkthrough(revision, baseRevision, sections);
  const result = await base.pi.call("quick_review_submit", {
    revision,
    markdown,
    sectionCount: sections.length,
  });
  const url = String(
    (result.details as { url?: string } | undefined)?.url ?? "",
  );
  return {
    ...base,
    url,
    act: async (body) => {
      const response = await fetch(new URL("action", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, payload: await response.json() };
    },
    cleanup: () => {
      void base.pi.fire("session_shutdown");
      base.cleanup();
    },
  };
}

test("the extension registers its commands and tools", async () => {
  const base = start();
  try {
    await assert.rejects(base.pi.run("nope"), /no command named/);
    await base.pi.run("quick-review", "--help");
    assert.match(
      base.pi.notifications[0]!.message,
      /\/quick-review \[--scope head\|diff\]/,
    );
    await base.pi.run("quick-review-close");
    assert.match(base.pi.notifications[1]!.message, /No Quick Review is open/);
  } finally {
    base.cleanup();
  }
});

test("print and json sessions are refused where the caller can see it", async () => {
  for (const mode of ["print", "json"] as const) {
    const base = start(mode);
    try {
      await assert.rejects(
        base.pi.run("quick-review", "--no-open"),
        new RegExp(`${mode} mode cannot host a review page`),
      );
      assert.deepEqual(base.pi.sent, []);
      assert.deepEqual(readdirSync(base.stateDirectory), []);
    } finally {
      base.cleanup();
    }
  }
});

test("the command asks the session agent for a walkthrough", async () => {
  const base = start();
  try {
    await base.pi.run("quick-review", "--no-open");
    assert.equal(base.pi.sent.length, 1);
    const request = base.pi.sent[0]!;
    assert.equal(request.customType, "quick-review-request");
    assert.match(request.content, /quick_review_submit/);
    assert.match(request.content, new RegExp(base.fixture.head));
    assert.match(request.content, /```diff/);
    assert.equal(request.details?.revision, base.fixture.head);
    assert.ok(base.pi.activeTools.includes("quick_review_submit"));
    assert.ok(base.pi.activeTools.includes("quick_review_answer"));
    assert.ok(base.pi.activeTools.includes("read"));
    assert.match(base.pi.notifications[0]!.message, /Building the walkthrough/);
  } finally {
    base.cleanup();
  }
});

test("the extension opens and progressively enhances a diff project graph", async () => {
  const base = start();
  try {
    await base.pi.run(
      "quick-review",
      `--scope diff --base ${base.fixture.base} --no-open`,
    );
    const request = base.pi.deliver("quick-review-graph-request");
    const revision = String(request.details?.revision);
    const baseRevision = String(request.details?.baseRevision);
    assert.match(request.content, /quick_review_graph_submit/);
    const submitted = await base.pi.call("quick_review_graph_submit", {
      revision,
      graph: projectGraph(revision, baseRevision, "diff"),
      nodeCount: 1,
    });
    const url = String((submitted.details as { url?: string }).url);
    const act = async (body: object) => {
      const response = await fetch(new URL("action", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        payload: (await response.json()) as any,
      };
    };

    const enhancing = act({ action: "enhance", node: "greeting" });
    const expansion = await waitFor(() =>
      base.pi.sent.find((item) => item.customType === "quick-review-expansion"),
    );
    await base.pi.call("quick_review_graph_expand", {
      requestId: String(expansion.details?.requestId),
      delta: graphDelta(revision),
    });
    assert.equal((await enhancing).payload.data.nodes.length, 2);

    const asking = act({
      action: "ask",
      node: "greeting.format",
      comment: "Why interpolate?",
    });
    const question = await waitFor(() =>
      base.pi.sent.find((item) => item.customType === "quick-review-question"),
    );
    await base.pi.call("quick_review_answer", {
      questionId: String(question.details?.questionId),
      answer: "It formats the supplied name.",
    });
    assert.equal((await asking).status, 200);
    await act({ action: "mark-viewed", node: "greeting" });
    await act({ action: "mark-viewed", node: "greeting.format" });
    const approved = await act({
      action: "approve",
      comment: "Architecture matches.",
    });
    assert.equal(approved.status, 200);
    assert.equal(base.pi.emitted.at(-1)?.name, "quick-review:graph-completed");
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});

test("the extension approves a committed HEAD project graph", async () => {
  const base = start();
  try {
    await base.pi.run("quick-review", "--scope head --no-open");
    const request = base.pi.deliver("quick-review-graph-request");
    const revision = String(request.details?.revision);
    assert.equal(request.details?.baseRevision, revision);
    const submitted = await base.pi.call("quick_review_graph_submit", {
      revision,
      graph: projectGraph(revision, revision, "head"),
      nodeCount: 1,
    });
    const url = String((submitted.details as { url?: string }).url);
    const act = async (body: object) => {
      const response = await fetch(new URL("action", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        payload: (await response.json()) as any,
      };
    };
    await act({ action: "mark-viewed", node: "greeting" });
    assert.equal(
      (await act({ action: "approve", comment: "Snapshot accepted." })).status,
      200,
    );
    const event = base.pi.emitted.at(-1)!;
    assert.equal(event.name, "quick-review:graph-completed");
    assert.equal((event.payload as { scope: string }).scope, "head");
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});

test("a second command while one is pending is refused and leaves one plan", async () => {
  const base = start();
  try {
    await base.pi.run("quick-review", "--no-open");
    const before = readdirSync(base.stateDirectory);
    assert.equal(before.length, 1);
    await base.pi.run("quick-review", "--no-open");
    assert.match(
      base.pi.notifications.at(-1)!.message,
      /already open; finish it on the page/,
    );
    assert.deepEqual(readdirSync(base.stateDirectory), before);
    assert.equal(base.pi.sent.length, 1);
  } finally {
    base.cleanup();
  }
});

test("closing a pending review removes its plan", async () => {
  const base = start();
  try {
    await base.pi.run("quick-review", "--no-open");
    assert.equal(readdirSync(base.stateDirectory).length, 1);
    await base.pi.run("quick-review-close");
    assert.match(base.pi.notifications.at(-1)!.message, /Quick Review closed/);
    assert.deepEqual(readdirSync(base.stateDirectory), []);
  } finally {
    base.cleanup();
  }
});

test("submitting the walkthrough opens the page", async () => {
  const test = await session();
  try {
    assert.match(test.url, /^http:\/\/127\.0\.0\.1:[0-9]+\/[A-Za-z0-9_-]+\/$/);
    const page = await fetch(test.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-card="greet-by-name"/);
    // The page is now the open review, so another command is refused.
    await test.pi.run("quick-review", "--no-open");
    assert.match(test.pi.notifications.at(-1)!.message, /already open/);
  } finally {
    test.cleanup();
  }
});

test("closing an opened review keeps its record on disk", async () => {
  const test = await session();
  try {
    const directory = join(
      test.stateDirectory,
      readdirSync(test.stateDirectory)[0]!,
    );
    await test.pi.run("quick-review-close");
    assert.equal(await closed(test.url), true);
    // The review happened: only its page went away.
    assert.deepEqual(readdirSync(directory).sort(), [
      "patch.diff",
      "state.json",
      "walkthrough.md",
    ]);
    // And a fresh review can start afterwards.
    await test.pi.run("quick-review", "--no-open");
    assert.equal(readdirSync(test.stateDirectory).length, 2);
  } finally {
    test.cleanup();
  }
});

test("a walkthrough for the wrong revision is refused", async () => {
  const base = start();
  try {
    await base.pi.run("quick-review", "--no-open");
    base.pi.deliver("quick-review-request");
    await assert.rejects(
      base.pi.call("quick_review_submit", {
        revision: "c".repeat(40),
        markdown: walkthrough("c".repeat(40), "d".repeat(40)),
        sectionCount: 1,
      }),
      /revision does not match/,
    );
    await assert.rejects(
      base.pi.call("quick_review_submit", {
        revision: base.fixture.head,
        markdown: walkthrough(base.fixture.head, base.fixture.base),
        sectionCount: 4,
      }),
      /sectionCount is 4 but the walkthrough has 1/,
    );
  } finally {
    base.cleanup();
  }
});

test("the agent answers a page question with the answer tool", async () => {
  const test = await session();
  try {
    const asking = test.act({
      action: "ask",
      section: "greet-by-name",
      comment: "Why the rename?",
    });
    const question = await waitFor(() =>
      test.pi.sent.find((item) => item.customType === "quick-review-question"),
    );
    assert.match(question.content, /Why the rename\?/);
    await test.pi.call("quick_review_answer", {
      questionId: String(question.details?.questionId),
      answer: "The caller now supplies the name.",
    });
    const result = await asking;
    assert.equal(result.status, 200);
    assert.equal(
      result.payload.state.questions[0].answer,
      "The caller now supplies the name.",
    );
  } finally {
    test.cleanup();
  }
});

test("plain assistant text answers only the question that caused it", async () => {
  const test = await session();
  try {
    const asking = test.act({
      action: "ask",
      section: "greet-by-name",
      comment: "Why the rename?",
    });
    await waitFor(() =>
      test.pi.sent.find((item) => item.customType === "quick-review-question"),
    );
    // Text written before the agent received the question is not an answer.
    test.pi.assistant("Unrelated earlier reply.");
    await test.pi.fire("agent_settled");
    assert.equal(test.pi.emitted.length, 0);

    test.pi.deliver("quick-review-question");
    test.pi.assistant("The caller now supplies the name.");
    await test.pi.fire("agent_settled");
    const result = await asking;
    assert.equal(
      result.payload.state.questions[0].answer,
      "The caller now supplies the name.",
    );
  } finally {
    test.cleanup();
  }
});

test("a tool preamble does not win over the final answer", async () => {
  const test = await session();
  try {
    const asking = test.act({
      action: "ask",
      section: "greet-by-name",
      comment: "Why the rename?",
    });
    await waitFor(() =>
      test.pi.sent.find((item) => item.customType === "quick-review-question"),
    );
    test.pi.deliver("quick-review-question");
    // A normal tool-calling turn: a preamble, a tool round trip, the answer.
    test.pi.assistant("I will read src/app.js first.", "read");
    test.pi.toolResult("export function greet(name) {");
    test.pi.assistant("The caller now supplies the name.");
    await test.pi.fire("agent_settled");
    const result = await asking;
    assert.equal(result.status, 200);
    assert.equal(
      result.payload.state.questions[0].answer,
      "The caller now supplies the name.",
    );
  } finally {
    test.cleanup();
  }
});

test("text after a later request is not treated as this answer", async () => {
  const test = await session();
  try {
    const asking = test.act({
      action: "ask",
      section: "greet-by-name",
      comment: "Why the rename?",
    });
    await waitFor(() =>
      test.pi.sent.find((item) => item.customType === "quick-review-question"),
    );
    test.pi.deliver("quick-review-question");
    test.pi.user("Forget that, do something else.");
    test.pi.assistant("Working on the other thing.");
    await test.pi.fire("agent_settled");
    const result = await asking;
    assert.equal(result.status, 400);
    assert.match(result.payload.error, /finished without an answer/);
  } finally {
    test.cleanup();
  }
});

test("a settled turn with no answer fails the question instead of hanging", async () => {
  const test = await session();
  try {
    const asking = test.act({
      action: "ask",
      section: "greet-by-name",
      comment: "Why the rename?",
    });
    await waitFor(() =>
      test.pi.sent.find((item) => item.customType === "quick-review-question"),
    );
    test.pi.deliver("quick-review-question");
    await test.pi.fire("agent_settled");
    const result = await asking;
    assert.equal(result.status, 400);
    assert.match(result.payload.error, /finished without an answer/);
  } finally {
    test.cleanup();
  }
});

test("approval reaches the event bus and the session agent", async () => {
  const test = await session();
  try {
    await test.act({ action: "mark-viewed", section: "greet-by-name" });
    const approved = await test.act({ action: "approve", comment: "ship it" });
    assert.equal(approved.status, 200);
    const event = test.pi.emitted.at(-1)!;
    assert.equal(event.name, COMPLETION_EVENT);
    assert.equal((event.payload as { outcome: string }).outcome, "approved");
    const outcome = test.pi.sent.at(-1)!;
    assert.equal(outcome.customType, "quick-review-outcome");
    assert.match(outcome.content, /approved this exact revision/);
    assert.match(outcome.content, /ship it/);
    await waitFor(async () => (await closed(test.url)) || undefined);
  } finally {
    test.cleanup();
  }
});

test("shutdown closes the page and fails pending questions", async () => {
  const test = await session();
  try {
    const asking = test.act({
      action: "ask",
      section: "greet-by-name",
      comment: "Why the rename?",
    });
    await waitFor(() =>
      test.pi.sent.find((item) => item.customType === "quick-review-question"),
    );
    await test.pi.fire("session_shutdown");
    const result = await asking;
    assert.equal(result.status, 400);
    assert.match(result.payload.error, /shutting down/);
    assert.equal(await closed(test.url), true);
  } finally {
    test.cleanup();
  }
});

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the harness");
}

async function closed(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return false;
  } catch {
    return true;
  }
}

test("the review directory holds the whole bundle", async () => {
  const test = await session();
  try {
    const directory = readdirSync(test.stateDirectory)[0]!;
    const files = readdirSync(join(test.stateDirectory, directory)).sort();
    assert.deepEqual(files, ["patch.diff", "state.json", "walkthrough.md"]);
    assert.ok(
      existsSync(join(test.stateDirectory, directory, "walkthrough.md")),
    );
  } finally {
    test.cleanup();
  }
});

/** Start a review and return everything needed to submit its walkthrough. */
async function readyToSubmit(base: ReturnType<typeof start>) {
  await base.pi.run("quick-review", "--no-open");
  const request = base.pi.deliver("quick-review-request");
  const revision = String(request.details?.revision);
  const baseRevision = String(request.details?.baseRevision);
  return {
    revision,
    markdown: walkthrough(revision, baseRevision),
    sectionCount: 1,
  };
}

test("closing during page startup refuses the page and leaves nothing", async () => {
  const base = start();
  try {
    const params = await readyToSubmit(base);
    const submitting = base.pi.call("quick_review_submit", params);
    // Close in the same tick: the submit is still verifying the range.
    await base.pi.run("quick-review-close");
    await assert.rejects(submitting, /closed while it was opening|closing/);
    assert.deepEqual(readdirSync(base.stateDirectory), []);
    // No page survived the close.
    for (const message of base.pi.sent)
      assert.ok(!/127\.0\.0\.1/.test(message.content));
    // A fresh review can start immediately.
    await base.pi.run("quick-review", "--no-open");
    assert.equal(readdirSync(base.stateDirectory).length, 1);
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});

test("shutdown during page startup refuses the page and leaves nothing", async () => {
  const base = start();
  try {
    const params = await readyToSubmit(base);
    const submitting = base.pi.call("quick_review_submit", params);
    await base.pi.fire("session_shutdown");
    await assert.rejects(submitting, /closed while it was opening|closing/);
    assert.deepEqual(readdirSync(base.stateDirectory), []);
  } finally {
    base.cleanup();
  }
});

test("an aborted submit tool call opens nothing", async () => {
  const base = start();
  try {
    const params = await readyToSubmit(base);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      base.pi.call("quick_review_submit", params, controller.signal),
      /closed while it was opening|closing/,
    );
    assert.deepEqual(readdirSync(base.stateDirectory), []);
    // The pending review is gone, so a fresh one may start.
    await base.pi.run("quick-review", "--no-open");
    assert.equal(readdirSync(base.stateDirectory).length, 1);
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});

test("a failed page start clears the pending review so a retry can run", async () => {
  const base = start();
  try {
    const params = await readyToSubmit(base);
    // Make the artifact write fail the way an exclusive create does.
    const directory = join(
      base.stateDirectory,
      readdirSync(base.stateDirectory)[0]!,
    );
    writeFileSync(join(directory, "walkthrough.md"), "taken", "utf8");
    await assert.rejects(base.pi.call("quick_review_submit", params), /EEXIST/);
    assert.deepEqual(readdirSync(base.stateDirectory), []);

    // A fresh review starts and opens normally.
    const retry = await readyToSubmit(base);
    const result = await base.pi.call("quick_review_submit", retry);
    const url = String((result.details as { url?: string }).url);
    assert.match(url, /^http:\/\/127\.0\.0\.1:[0-9]+\//);
    assert.equal((await fetch(url)).status, 200);
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});
