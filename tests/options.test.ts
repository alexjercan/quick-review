import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOptions, tokenize } from "../extensions/quick-review/options.ts";

test("defaults leave snapshot and diff selection to the base option", () => {
  const options = parseOptions("");
  assert.deepEqual(options, { open: true, help: false });
});

test("reads separated and inline values", () => {
  assert.equal(parseOptions("--base origin/main").baseRef, "origin/main");
  assert.equal(parseOptions("--base=origin/main").baseRef, "origin/main");
  const options = parseOptions("--base HEAD~3 --target HEAD --repo /tmp/repo");
  assert.equal(options.baseRef, "HEAD~3");
  assert.equal(options.targetRef, "HEAD");
  assert.equal(options.repository, "/tmp/repo");
});

test("quoted values keep their spaces", () => {
  assert.deepEqual(tokenize(`--repo "/tmp/my repo" --base main`), [
    "--repo",
    "/tmp/my repo",
    "--base",
    "main",
  ]);
  assert.equal(
    parseOptions(`--repo "/tmp/my repo"`).repository,
    "/tmp/my repo",
  );
});

test("--no-open and --help are recognised", () => {
  assert.equal(parseOptions("--no-open").open, false);
  assert.equal(parseOptions("--help").help, true);
  assert.equal(parseOptions("-h").help, true);
});

test("rejects unknown options, missing values, and repeats", () => {
  assert.throws(() => parseOptions("--nope"), /unknown option: --nope/);
  assert.throws(() => parseOptions("--scope head"), /unknown option: --scope/);
  assert.throws(() => parseOptions("main"), /unknown option: main/);
  assert.throws(() => parseOptions("--base"), /--base needs a value/);
  assert.throws(() => parseOptions("--base a --base b"), /given twice/);
});
