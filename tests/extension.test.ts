import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import quickReview from "../extensions/quick-review/index.ts";
import { createPi, type PiHarness } from "./pi-harness.ts";
import {
  graphDelta,
  projectGraph,
  repository,
  type Fixture,
} from "./helpers.ts";

interface Base {
  pi: PiHarness;
  fixture: Fixture;
  stateDirectory: string;
  cleanup(): void;
}

function start(mode: "tui" | "rpc" | "json" | "print" = "tui"): Base {
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

async function open(base: Base, args = "--no-open") {
  await base.pi.run("quick-review", args);
  const request = base.pi.deliver("quick-review-graph-request");
  const revision = String(request.details?.revision);
  const baseRevision = String(request.details?.baseRevision);
  const scope = request.details?.scope === "head" ? "head" : "diff";
  const submitted = await base.pi.call("quick_review_graph_submit", {
    revision,
    graph: projectGraph(revision, baseRevision, scope),
    nodeCount: 1,
  });
  const url = String((submitted.details as { url?: string }).url);
  const act = async (body: object) => {
    const response = await fetch(new URL("action", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: (await response.json()) as any };
  };
  return { request, revision, baseRevision, scope, url, act };
}

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the Pi harness");
}

test("plain quick-review defaults to the committed HEAD graph", async () => {
  const base = start();
  try {
    await base.pi.run("quick-review", "--no-open");
    const request = base.pi.sent[0]!;
    assert.equal(request.customType, "quick-review-graph-request");
    assert.equal(request.details?.scope, "head");
    assert.match(request.content, /quick_review_graph_submit/);
    assert.ok(base.pi.activeTools.includes("quick_review_graph_submit"));
    assert.ok(base.pi.activeTools.includes("quick_review_graph_expand"));
    assert.ok(base.pi.activeTools.includes("quick_review_comment_respond"));
    await assert.rejects(
      base.pi.call("quick_review_submit", {}),
      /no tool named/,
    );
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});

test("help and non-page modes describe the graph command", async () => {
  const base = start();
  try {
    await base.pi.run("quick-review", "--help");
    assert.match(base.pi.notifications[0]!.message, /With no --base/);
  } finally {
    base.cleanup();
  }
  for (const mode of ["print", "json"] as const) {
    const current = start(mode);
    try {
      await assert.rejects(
        current.pi.run("quick-review", "--no-open"),
        new RegExp(`${mode} mode cannot host a review page`),
      );
      assert.deepEqual(readdirSync(current.stateDirectory), []);
    } finally {
      current.cleanup();
    }
  }
});

test("the Pi session enhances, responds to comments, and approves", async () => {
  const base = start();
  try {
    const review = await open(
      base,
      `--base ${base.fixture.base} --target HEAD --no-open`,
    );
    assert.equal(review.scope, "diff");
    const enhancing = review.act({ action: "enhance", node: "greeting" });
    const expansion = await waitFor(() =>
      base.pi.sent.find((item) => item.customType === "quick-review-expansion"),
    );
    await base.pi.call("quick_review_graph_expand", {
      requestId: String(expansion.details?.requestId),
      delta: graphDelta(review.revision),
    });
    assert.equal((await enhancing).payload.data.nodes.length, 2);

    assert.equal(
      (
        await review.act({
          action: "send-comment",
          node: "greeting.format",
          line: "2",
          comment: "Why interpolate?",
        })
      ).status,
      200,
    );
    const comment = await waitFor(() =>
      base.pi.sent.find((item) => item.customType === "quick-review-comment"),
    );
    await base.pi.call("quick_review_comment_respond", {
      commentId: String(comment.details?.commentId),
      response: "It formats the supplied name.",
    });
    for (let count = 0; count < 100; count++) {
      const state = (await (await fetch(new URL("state", review.url))).json())
        .data.state;
      if (state.comments[0]?.delivery === "answered") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await review.act({ action: "mark-viewed", node: "greeting" });
    await review.act({ action: "mark-viewed", node: "greeting.format" });
    assert.equal(
      (
        await review.act({
          action: "approve",
          comment: "Architecture matches.",
        })
      ).status,
      200,
    );
    assert.equal(base.pi.emitted.at(-1)?.name, "quick-review:graph-completed");
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});

test("a target without a base binds one committed snapshot", async () => {
  const base = start();
  try {
    const review = await open(base, "--target HEAD --no-open");
    assert.equal(review.scope, "head");
    assert.equal(review.baseRevision, review.revision);
    await review.act({ action: "mark-viewed", node: "greeting" });
    assert.equal(
      (await review.act({ action: "approve", comment: "Snapshot accepted." }))
        .status,
      200,
    );
    assert.equal(
      (base.pi.emitted.at(-1)?.payload as { scope: string }).scope,
      "head",
    );
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});

test("neutral review asks the current agent for triage without edits", async () => {
  const base = start();
  try {
    const review = await open(base, "--no-open");
    await review.act({
      action: "add-comment",
      node: "greeting",
      line: "2",
      comment: "This may need a fallback.",
    });
    assert.equal((await review.act({ action: "send-review" })).status, 200);
    const event = base.pi.emitted.at(-1)?.payload as {
      version: number;
      outcome: string;
    };
    assert.equal(event.version, 2);
    assert.equal(event.outcome, "commented");
    const outcome = base.pi.sent.find(
      (item) => item.customType === "quick-review-graph-outcome",
    );
    assert.match(outcome?.content ?? "", /concise triage summary/);
    assert.match(outcome?.content ?? "", /Do not edit files/);
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});

test("wrong revisions and duplicate reviews are refused", async () => {
  const base = start();
  try {
    await base.pi.run("quick-review", "--no-open");
    const request = base.pi.deliver("quick-review-graph-request");
    await base.pi.run("quick-review", "--no-open");
    assert.match(base.pi.notifications.at(-1)!.message, /already open/);
    await assert.rejects(
      base.pi.call("quick_review_graph_submit", {
        revision: "c".repeat(40),
        graph: projectGraph(
          String(request.details?.revision),
          String(request.details?.baseRevision),
        ),
        nodeCount: 1,
      }),
      /revision does not match/,
    );
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});

test("close removes a pending plan and closes an open page", async () => {
  const base = start();
  try {
    await base.pi.run("quick-review", "--no-open");
    assert.equal(readdirSync(base.stateDirectory).length, 1);
    await base.pi.run("quick-review-close");
    assert.deepEqual(readdirSync(base.stateDirectory), []);
    const review = await open(base);
    await base.pi.run("quick-review-close");
    await assert.rejects(fetch(review.url), /fetch failed|ECONNREFUSED/);
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});

test("plain assistant text can respond to the active comment", async () => {
  const base = start();
  try {
    const review = await open(base);
    await review.act({
      action: "send-comment",
      node: "greeting",
      line: "1",
      comment: "Why?",
    });
    await waitFor(() =>
      base.pi.sent.find((item) => item.customType === "quick-review-comment"),
    );
    base.pi.deliver("quick-review-comment");
    base.pi.assistant("The exact code supplies the behavior.");
    await base.pi.fire("agent_settled");
    for (let count = 0; count < 100; count++) {
      const state = (await (await fetch(new URL("state", review.url))).json())
        .data.state;
      if (state.comments[0]?.delivery === "answered") {
        assert.equal(
          state.comments[0].response,
          "The exact code supplies the behavior.",
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    await base.pi.fire("session_shutdown");
    base.cleanup();
  }
});
