/** The text handed to the session agent: kickoff and outcome, both bounded. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../extensions/quick-review/contract.ts";
import {
  buildCompletionMessage,
  buildQuestionPrompt,
} from "../extensions/quick-review/prompt.ts";

const SECTION = {
  id: "greet-by-name",
  importance: "critical" as const,
  file: "src/app.js",
  lines: "1-3",
  markdown: "prose",
  diff: "+code",
  prompt: "Does the helper handle an empty name?",
};

test("an approval message carries the comments verbatim", () => {
  const message = buildCompletionMessage("approved", "ship it", [
    { file: "src/app.js", lines: "1-3", body: "needs a test" },
  ]);
  assert.match(message, /approved this exact revision/);
  assert.match(message, /Overall comment: ship it/);
  assert.match(message, /- src\/app\.js:1-3: needs a test/);
  assert.ok(!message.includes("truncated"));
});

test("a change request states a failed cleanup instead of claiming success", () => {
  const clean = buildCompletionMessage("changes-requested", "not yet", []);
  assert.match(clean, /The walkthrough is invalidated\./);
  const failed = buildCompletionMessage(
    "changes-requested",
    "not yet",
    [],
    "Warning: the walkthrough could not be fully removed; see cleanup-error.txt in the review directory.",
  );
  assert.match(failed, /could not be fully removed/);
  assert.match(failed, /Treat the walkthrough as invalid regardless\./);
  assert.ok(!failed.includes("The walkthrough is invalidated."));
});

test("the largest possible outcome message stays inside the cap", () => {
  // The worst case the contract allows: every change commented at full size,
  // plus a full-size overall comment.
  const body = "x".repeat(LIMITS.comment);
  const comments = Array.from({ length: LIMITS.sections }, (_, index) => ({
    file: `src/file-${index}.ts`,
    lines: "1-200",
    body,
  }));
  const message = buildCompletionMessage(
    "changes-requested",
    "y".repeat(LIMITS.comment),
    comments,
  );
  const size = Buffer.byteLength(message, "utf8");
  assert.ok(
    size > LIMITS.outcome / 2,
    "the fixture should be large enough to truncate",
  );
  assert.ok(size <= LIMITS.outcome, `outcome message is ${size} bytes`);
  assert.match(message, /\[Comment list truncated\./);
  assert.match(message, /completion\.json/);
});

test("a cleanup warning survives a maximum-size outcome message", () => {
  const body = "x".repeat(LIMITS.comment);
  const warning =
    "Warning: the walkthrough could not be fully removed; see cleanup-error.txt in the review directory.";
  const message = buildCompletionMessage(
    "changes-requested",
    "y".repeat(LIMITS.comment),
    Array.from({ length: LIMITS.sections }, (_, index) => ({
      file: `src/file-${index}.ts`,
      lines: "1-200",
      body,
    })),
    warning,
  );
  assert.ok(Buffer.byteLength(message, "utf8") <= LIMITS.outcome);
  // The parts the agent must act on are never the parts that get cut.
  assert.ok(message.includes(warning));
  assert.match(message, /Treat the walkthrough as invalid regardless\./);
  assert.match(message, /Address the feedback/);
  assert.match(message, /\[Comment list truncated\./);
});

test("a maximum-size approval keeps its instruction after truncation", () => {
  const message = buildCompletionMessage(
    "approved",
    "z".repeat(LIMITS.comment),
    Array.from({ length: LIMITS.sections }, () => ({
      file: "src/app.js",
      lines: "1-3",
      body: "x".repeat(LIMITS.comment),
    })),
  );
  assert.ok(Buffer.byteLength(message, "utf8") <= LIMITS.outcome);
  assert.match(message, /Decide what follows from the project workflow\./);
  assert.match(message, /\[Comment list truncated\./);
});

test("a multi-byte outcome message truncates on a character boundary", () => {
  const message = buildCompletionMessage(
    "approved",
    "é".repeat(LIMITS.comment / 2),
    Array.from({ length: LIMITS.sections }, () => ({
      file: "src/app.js",
      lines: "1-3",
      body: "é".repeat(LIMITS.comment / 2),
    })),
  );
  assert.ok(Buffer.byteLength(message, "utf8") <= LIMITS.outcome);
  assert.ok(!message.includes("�"));
});

test("a question prompt names the exact revision and the answer tool", () => {
  const prompt = buildQuestionPrompt({
    id: "a".repeat(24),
    question: "Why the rename?",
    section: SECTION,
    revision: "b".repeat(40),
  });
  assert.match(prompt, /exact revision b{40}/);
  assert.match(prompt, /greet-by-name \(src\/app\.js:1-3\)/);
  assert.match(prompt, /Why the rename\?/);
  assert.match(prompt, new RegExp(`quick_review_answer with questionId a{24}`));
});
