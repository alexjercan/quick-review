import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  assertRef,
  defaultBranch,
  diffStat,
  isDirty,
  mergeBase,
  patch,
  resolveCommit,
  resolveRepository,
  showFile,
  subject,
} from "../extensions/quick-review/git.ts";
import { repository, type Fixture } from "./helpers.ts";

let fixture: Fixture;

before(() => {
  fixture = repository();
});
after(() => fixture.cleanup());

test("refs that could be read as options are rejected", () => {
  assert.equal(assertRef("HEAD~2"), "HEAD~2");
  assert.equal(assertRef("origin/main^"), "origin/main^");
  assert.throws(() => assertRef("--upload-pack=evil"), /invalid git ref/);
  assert.throws(() => assertRef(""), /invalid git ref/);
  assert.throws(() => assertRef("a b"), /invalid git ref/);
  assert.throws(() => assertRef("x".repeat(300)), /invalid git ref/);
});

test("the repository root resolves from a subdirectory", async () => {
  const nested = join(fixture.path, "src");
  assert.equal(await resolveRepository(nested), fixture.path);
});

test("refs resolve to exact commits", async () => {
  assert.equal(await resolveCommit(fixture.path, "HEAD"), fixture.head);
  assert.equal(await resolveCommit(fixture.path, "main"), fixture.base);
  assert.equal(
    await resolveCommit(fixture.path, fixture.head.slice(0, 8)),
    fixture.head,
  );
  await assert.rejects(
    resolveCommit(fixture.path, "no-such-ref"),
    /does not resolve to a commit/,
  );
});

test("the default branch and merge base define the range", async () => {
  assert.equal(await defaultBranch(fixture.path), "main");
  assert.equal(await mergeBase(fixture.path, "main", "HEAD"), fixture.base);
});

test("the range reports its exact statistics and patch", async () => {
  const stat = await diffStat(fixture.path, fixture.base, fixture.head);
  assert.deepEqual(stat, { files: 1, added: 2, removed: 2 });
  const text = await patch(fixture.path, fixture.base, fixture.head);
  assert.match(text, /diff --git a\/src\/app\.js b\/src\/app\.js/);
  assert.match(text, /\+export function greet\(name\)/);
});

test("file context comes from an exact revision", async () => {
  assert.match(
    (await showFile(fixture.path, fixture.head, "src/app.js")) ?? "",
    /greet\(name\)/,
  );
  assert.match(
    (await showFile(fixture.path, fixture.base, "src/app.js")) ?? "",
    /return 'hi';/,
  );
  assert.equal(
    await showFile(fixture.path, fixture.head, "src/missing.js"),
    undefined,
  );
  await assert.rejects(
    showFile(fixture.path, fixture.head, "../escape"),
    /relative repository path/,
  );
  await assert.rejects(
    showFile(fixture.path, "main", "src/app.js"),
    /exact revision/,
  );
});

test("the head subject is available for the kickoff prompt", async () => {
  assert.equal(await subject(fixture.path, fixture.head), "Greet by name");
});

test("a dirty worktree is detected", async () => {
  assert.equal(await isDirty(fixture.path), false);
  mkdirSync(join(fixture.path, "src"), { recursive: true });
  writeFileSync(join(fixture.path, "src", "scratch.js"), "// scratch\n");
  assert.equal(await isDirty(fixture.path), true);
});
