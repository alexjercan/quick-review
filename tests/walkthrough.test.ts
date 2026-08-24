import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../extensions/quick-review/contract.ts";
import {
  assertWalkthroughRange,
  parseWalkthrough,
} from "../extensions/quick-review/walkthrough.ts";
import { walkthrough } from "./helpers.ts";

const REVISION = "a".repeat(40);
const BASE = "b".repeat(40);

test("parses a valid walkthrough", () => {
  const document = parseWalkthrough(walkthrough(REVISION, BASE));
  assert.equal(document.version, 1);
  assert.equal(document.title, "Greet by name");
  assert.equal(document.summary, "The greeting now takes a name.");
  assert.equal(document.revision, REVISION);
  assert.equal(document.baseRevision, BASE);
  assert.deepEqual(document.warnings, []);
  assert.equal(document.sections.length, 1);
  const section = document.sections[0]!;
  assert.equal(section.id, "greet-by-name");
  assert.equal(section.file, "src/app.js");
  assert.equal(section.importance, "critical");
  assert.equal(section.prompt, "Does the helper handle an empty name?");
  assert.match(section.diff, /return `hi \$\{name\}`/);
  assert.equal(
    section.markdown,
    "The helper now interpolates the caller name.",
  );
  assert.match(document.identity, /^[0-9a-f]{64}$/);
});

test("identity changes with the artifact text", () => {
  const one = parseWalkthrough(walkthrough(REVISION, BASE));
  const two = parseWalkthrough(
    walkthrough(REVISION, BASE, [{ id: "greet-by-name", prose: "Other." }]),
  );
  assert.notEqual(one.identity, two.identity);
});

test("rejects an unsupported artifact version", () => {
  assert.throws(
    () =>
      parseWalkthrough(
        walkthrough(REVISION, BASE, undefined, { version: "2" }),
      ),
    /unsupported walkthrough version/,
  );
});

test("rejects a missing metadata field", () => {
  const source = walkthrough(REVISION, BASE).replace("files: 1\n", "");
  assert.throws(
    () => parseWalkthrough(source),
    /metadata must contain exactly/,
  );
});

test("rejects short revisions", () => {
  assert.throws(
    () => parseWalkthrough(walkthrough("abc", BASE)),
    /full 40-character SHAs/,
  );
});

test("rejects a walkthrough over the size limit", () => {
  const source = walkthrough(REVISION, BASE, [
    { id: "big", prose: "x".repeat(LIMITS.artifact) },
  ]);
  assert.throws(() => parseWalkthrough(source), /exceeds 256 KiB/);
});

test("rejects more changes than the bounded limit", () => {
  const sections = Array.from({ length: LIMITS.sections + 1 }, (_, index) => ({
    id: `change-${index}`,
  }));
  assert.throws(
    () => parseWalkthrough(walkthrough(REVISION, BASE, sections)),
    /more than 40 changes/,
  );
});

test("warns and drops a change with an escaping path", () => {
  const document = parseWalkthrough(
    walkthrough(REVISION, BASE, [
      { id: "good" },
      { id: "bad", file: "../../etc/passwd" },
    ]),
  );
  assert.deepEqual(
    document.sections.map((section) => section.id),
    ["good"],
  );
  assert.deepEqual(document.warnings, ["Malformed change directive 2"]);
});

test("warns and drops a duplicate change id", () => {
  const document = parseWalkthrough(
    walkthrough(REVISION, BASE, [{ id: "same" }, { id: "same" }]),
  );
  assert.equal(document.sections.length, 1);
  assert.deepEqual(document.warnings, ["Duplicate change id: same"]);
});

test("warns and drops a change without a review prompt", () => {
  const source = `${walkthrough(REVISION, BASE)}
:::change
id: unprompted
importance: supporting
file: README.md
lines: 1
:::

No prompt follows this diff.

\`\`\`diff
+# demo
\`\`\`
`;
  const document = parseWalkthrough(source);
  assert.equal(document.sections.length, 1);
  assert.deepEqual(document.warnings, [
    "Change unprompted needs one diff and one review prompt",
  ]);
});

test("warns about an unsupported directive", () => {
  const document = parseWalkthrough(
    `${walkthrough(REVISION, BASE)}\n:::sneaky\nrun me\n:::\n`,
  );
  assert.deepEqual(document.warnings, ["Unsupported directive: sneaky"]);
});

test("rejects a walkthrough with no valid change", () => {
  const source = walkthrough(REVISION, BASE, [{ id: "bad", lines: "0" }]);
  assert.throws(() => parseWalkthrough(source), /no valid changes/);
});

test("binds the artifact to the reviewed range", () => {
  const document = parseWalkthrough(walkthrough(REVISION, BASE));
  assertWalkthroughRange(document, REVISION, BASE);
  assert.throws(
    () => assertWalkthroughRange(document, BASE, REVISION),
    /revisions do not match/,
  );
});
