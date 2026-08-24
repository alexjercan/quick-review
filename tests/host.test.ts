/** The pull host: what a waiter takes, and what giving up leaves behind. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CompletionEvent,
  WalkthroughSection,
} from "../extensions/quick-review/contract.ts";
import { createQueueHost } from "../extensions/quick-review/host.ts";

const SECTION: WalkthroughSection = {
  id: "greet-by-name",
  importance: "critical",
  file: "src/app.js",
  lines: "1-3",
  markdown: "prose",
  diff: "-a\n+b",
  prompt: "Does it handle an empty name?",
};

function outcome(): CompletionEvent {
  return {
    version: 1,
    outcome: "approved",
    repository: "/repo",
    baseRef: "main",
    targetRef: "HEAD",
    baseRevision: "b".repeat(40),
    revision: "a".repeat(40),
    identity: "c".repeat(64),
    sections: 1,
    comments: [],
    overallComment: "",
    questions: [],
    artifact: "/repo/walkthrough.md",
    state: "/repo/state.json",
    completedAt: "2026-01-01T00:00:00.000Z",
  };
}

function question(host: ReturnType<typeof createQueueHost>) {
  return host.ask({
    sectionId: SECTION.id,
    question: "why?",
    section: SECTION,
  });
}

test("a question reaches the waiter and its answer reaches the page", async () => {
  const host = createQueueHost();
  const asked = question(host);
  const event = await host.next({ timeout: 1000 });
  assert.equal(event?.kind, "question");
  assert.equal(event.kind === "question" && event.question, "why?");
  assert.equal(host.open, 1);
  const id = event.kind === "question" ? event.questionId : "";
  assert.equal(host.answer(id, "because"), true);
  assert.equal(await asked, "because");
  assert.equal(host.open, 0);
  assert.equal(host.answer(id, "again"), false);
});

test("a waiter that arrives first is handed the next event", async () => {
  const host = createQueueHost();
  const waiting = host.next({ timeout: 1000 });
  const asked = question(host);
  const event = await waiting;
  assert.equal(event?.kind, "question");
  host.answer(event.kind === "question" ? event.questionId : "", "ok");
  assert.equal(await asked, "ok");
});

test("a wait that was already cancelled takes nothing", async () => {
  const host = createQueueHost();
  const asked = question(host);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await host.next({ signal: controller.signal }), undefined);
  // The reviewer is still waiting, so the question must survive the cancel.
  const event = await host.next({ timeout: 1000 });
  assert.equal(event?.kind, "question");
  host.answer(event.kind === "question" ? event.questionId : "", "still here");
  assert.equal(await asked, "still here");
});

test("an abandoned waiter frees its place for the next wait", async () => {
  const host = createQueueHost();
  const controller = new AbortController();
  const waiting = host.next({ signal: controller.signal });
  controller.abort();
  assert.equal(await waiting, undefined);
  const asked = question(host);
  const event = await host.next({ timeout: 1000 });
  assert.equal(event?.kind, "question");
  host.answer(event.kind === "question" ? event.questionId : "", "delivered");
  assert.equal(await asked, "delivered");
});

test("an expired wait leaves the event queued", async () => {
  const host = createQueueHost();
  assert.equal(await host.next({ timeout: 10 }), undefined);
  const asked = question(host);
  const event = await host.next({ timeout: 1000 });
  assert.equal(event?.kind, "question");
  host.answer(event.kind === "question" ? event.questionId : "", "late");
  assert.equal(await asked, "late");
});

test("events are handed over in the order the page produced them", async () => {
  const host = createQueueHost();
  const first = question(host);
  host.complete(outcome());
  const one = await host.next({ timeout: 1000 });
  const two = await host.next({ timeout: 1000 });
  assert.equal(one?.kind, "question");
  assert.equal(two?.kind, "outcome");
  host.answer(one.kind === "question" ? one.questionId : "", "answered");
  assert.equal(await first, "answered");
});

test("an unanswered question fails on its own timeout", async () => {
  const host = createQueueHost({ questionTimeout: 10 });
  await assert.rejects(question(host), /did not answer in time/);
  assert.equal(host.open, 0);
});

test("a close fails open questions and drops undelivered events", async () => {
  const host = createQueueHost();
  const asked = question(host);
  host.complete(outcome());
  const taken = host.next({ timeout: 1000 });
  host.fail("the review page was closed");
  await assert.rejects(asked, /the review page was closed/);
  // The question was already handed over; the outcome behind it was not.
  assert.equal((await taken)?.kind, "question");
  assert.equal(await host.next({ timeout: 10 }), undefined);
  assert.equal(host.open, 0);
});

test("a close wakes a waiter that has nothing to take", async () => {
  const host = createQueueHost();
  const blocked = host.next({ timeout: 5000 });
  host.fail("the session is shutting down");
  assert.equal(await blocked, undefined);
});

test("an answer is bounded before the page receives it", async () => {
  const host = createQueueHost();
  const asked = question(host);
  const event = await host.next({ timeout: 1000 });
  host.answer(
    event?.kind === "question" ? event.questionId : "",
    "x".repeat(20 * 1024),
  );
  assert.equal(Buffer.byteLength(await asked, "utf8"), 16 * 1024);
});
