import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LIMITS } from "../extensions/quick-review/contract.ts";
import { parseWalkthrough } from "../extensions/quick-review/walkthrough.ts";
import {
  addComment,
  initialState,
  isApprovable,
  loadState,
  recordQuestion,
  saveState,
  setViewed,
  validateState,
} from "../extensions/quick-review/state.ts";
import { walkthrough } from "./helpers.ts";

const REVISION = "a".repeat(40);
const BASE = "b".repeat(40);
const document = parseWalkthrough(
  walkthrough(REVISION, BASE, [{ id: "one" }, { id: "two" }]),
);

test("initial state covers every change", () => {
  const state = initialState(document);
  assert.equal(state.version, 1);
  assert.equal(state.outcome, "open");
  assert.deepEqual(Object.keys(state.sections).sort(), ["one", "two"]);
  assert.deepEqual(Object.values(state.viewed), [false, false]);
  assert.equal(isApprovable(state), false);
});

test("marking viewed and reopening moves the change state", () => {
  const state = initialState(document);
  setViewed(state, "one", true);
  assert.equal(state.sections.one, "viewed");
  setViewed(state, "one", false);
  assert.equal(state.sections.one, "not-reviewed");
  assert.throws(
    () => setViewed(state, "missing", true),
    /unknown review section/,
  );
});

test("an explained change keeps its state when reviewed later", () => {
  const state = initialState(document);
  recordQuestion(state, "one", "why?", "because");
  assert.equal(state.sections.one, "needs-explanation");
  setViewed(state, "one", true);
  assert.equal(state.sections.one, "needs-explanation");
  setViewed(state, "one", false);
  assert.equal(state.sections.one, "needs-explanation");
});

test("approval needs every change viewed", () => {
  const state = initialState(document);
  setViewed(state, "one", true);
  assert.equal(isApprovable(state), false);
  setViewed(state, "two", true);
  assert.equal(isApprovable(state), true);
});

test("comments carry the anchor of their change", () => {
  const state = initialState(document);
  const comment = addComment(document, state, "two", "  needs a test  ");
  assert.equal(comment.file, "src/app.js");
  assert.equal(comment.lines, "1-3");
  assert.equal(comment.body, "needs a test");
  assert.match(comment.id, /^[0-9a-f]{24}$/);
  assert.throws(() => addComment(document, state, "two", "   "), /needs text/);
  assert.throws(
    () => addComment(document, state, "missing", "hi"),
    /unknown review section/,
  );
});

test("state validation rejects a foreign artifact", () => {
  const state = initialState(document);
  const other = parseWalkthrough(walkthrough(REVISION, BASE, [{ id: "one" }]));
  assert.throws(
    () => validateState(other, state),
    /does not match the artifact/,
  );
});

test("state validation rejects tampered values", () => {
  const state = initialState(document);
  assert.throws(
    () => validateState(document, { ...state, version: 2 }),
    /does not match the artifact/,
  );
  assert.throws(
    () =>
      validateState(document, {
        ...state,
        sections: { ...state.sections, one: "approved" },
      }),
    /section state is invalid/,
  );
  assert.throws(
    () =>
      validateState(document, {
        ...state,
        comments: [
          {
            id: "x",
            sectionId: "one",
            file: "src/app.js",
            lines: "1-3",
            body: "b",
          },
        ],
      }),
    /comments are invalid/,
  );
  assert.throws(
    () => validateState(document, { ...state, outcome: "approved" }),
    /unviewed sections/,
  );
});

test("state survives a save and load round trip", () => {
  const directory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  try {
    const path = join(directory, "state.json");
    const state = initialState(document);
    setViewed(state, "one", true);
    addComment(document, state, "one", "looks fine");
    recordQuestion(state, "two", "why?", "because the caller needs it");
    saveState(path, state);
    assert.deepEqual(loadState(path, document), state);
    writeFileSync(path, "{ not json", "utf8");
    assert.throws(() => loadState(path, document));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recorded question text is bounded by bytes, not code units", () => {
  const state = initialState(document);
  const wide = "é".repeat(LIMITS.answer);
  recordQuestion(state, "one", wide, wide);
  const recorded = state.questions[0]!;
  assert.ok(Buffer.byteLength(recorded.question, "utf8") <= LIMITS.comment);
  assert.ok(Buffer.byteLength(recorded.answer, "utf8") <= LIMITS.answer);
  assert.doesNotThrow(() => validateState(document, state));
});
