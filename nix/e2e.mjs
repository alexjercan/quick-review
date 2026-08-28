import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageRoot = process.env.QUICK_REVIEW_PACKAGE;
const out = process.env.out;
assert.ok(packageRoot, "QUICK_REVIEW_PACKAGE is required");
assert.ok(out, "out is required");

const { planAnalysis } = await import(
  `${packageRoot}/extensions/quick-review/analysis.ts`
);
const { parseProjectGraph, parseGraphDelta } = await import(
  `${packageRoot}/extensions/quick-review/graph-contract.ts`
);
const { openGraphReview } = await import(
  `${packageRoot}/extensions/quick-review/graph-review.ts`
);

const repository = mkdtempSync(join(tmpdir(), "quick-review-e2e-"));
const environment = {
  ...process.env,
  HOME: repository,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Quick Review",
  GIT_AUTHOR_EMAIL: "quick-review@example.invalid",
  GIT_COMMITTER_NAME: "Quick Review",
  GIT_COMMITTER_EMAIL: "quick-review@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00",
};
const git = (...args) =>
  execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: environment,
  }).trim();

mkdirSync(join(repository, "src"), { recursive: true });
writeFileSync(
  join(repository, "src", "app.js"),
  "export function greet() {\n  return 'hi';\n}\n",
);
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "Add the greeting");
git("checkout", "-q", "-b", "feature");
writeFileSync(
  join(repository, "src", "app.js"),
  "export function greet(name) {\n  return `hi ${name}`;\n}\n",
);
git("add", "-A");
git("commit", "-q", "-m", "Greet by name");

process.env.QUICK_REVIEW_STATE_DIR = mkdtempSync(
  join(tmpdir(), "quick-review-state-"),
);
const plan = await planAnalysis({ cwd: repository, scope: "diff" });
assert.equal(plan.inputs.baseRef, "main");
assert.equal(plan.inputs.targetRef, "HEAD");

const evidence = {
  file: "src/app.js",
  lines: "1-3",
  revision: plan.inputs.revision,
  confidence: "confirmed",
};
const artifact = JSON.stringify({
  version: 1,
  title: "Greeting architecture",
  summary: "The greeting accepts a caller name.",
  scope: "diff",
  revision: plan.inputs.revision,
  baseRevision: plan.inputs.baseRevision,
  roots: ["greeting"],
  nodes: [
    {
      id: "greeting",
      parentId: null,
      kind: "component",
      title: "Greeting",
      summary: "Formats the greeting.",
      confidence: "confirmed",
      overlay: "modified",
      expandable: true,
      file: "src/app.js",
      lines: "1-3",
      language: "javascript",
      evidence: [evidence],
    },
  ],
  edges: [],
  guidance: [],
});
const delta = JSON.stringify({
  version: 1,
  revision: plan.inputs.revision,
  parentId: "greeting",
  nodes: [
    {
      id: "greeting.format",
      parentId: "greeting",
      kind: "symbol",
      title: "greet",
      summary: "Interpolates the name.",
      confidence: "confirmed",
      overlay: "modified",
      expandable: false,
      file: "src/app.js",
      lines: "1-3",
      language: "javascript",
      evidence: [evidence],
    },
  ],
  edges: [
    {
      id: "greeting-contains-format",
      source: "greeting",
      target: "greeting.format",
      kind: "contains",
      confidence: "confirmed",
    },
  ],
});

const completions = [];
const review = await openGraphReview(plan, parseProjectGraph(artifact), {
  ask: async () => "The caller must pass a name.",
  expand: async () => parseGraphDelta(delta, plan.inputs.revision),
  complete: (event) => void completions.push(event),
});

const act = async (body) => {
  const response = await fetch(new URL("action", review.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.ok(payload.ok, `action ${body.action} failed: ${payload.error}`);
  return payload;
};

const first = await (await fetch(review.url)).text();
assert.match(first, /project decompiler/);
assert.match(first, /data-payload=/);
await act({ action: "enhance", node: "greeting" });
await act({
  action: "ask",
  node: "greeting.format",
  comment: "Does the caller supply a name?",
});
const code = await act({ action: "code", node: "greeting.format" });
assert.match(code.code, /export function greet\(name\)/);
await act({
  action: "add-comment",
  node: "greeting.format",
  comment: "An empty name still renders.",
});
await act({ action: "mark-viewed", node: "greeting" });
await act({ action: "mark-viewed", node: "greeting.format" });
await act({ action: "approve", comment: "Architecture matches." });
await review.server.finished;
await review.server.close();

assert.equal(completions.length, 1);
const event = completions[0];
assert.equal(event.version, 1);
assert.equal(event.outcome, "approved");
assert.equal(event.scope, "diff");
assert.equal(event.comments.length, 1);
assert.equal(event.questions.length, 1);
assert.deepEqual(JSON.parse(readFileSync(plan.completionPath, "utf8")), event);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "review.html"), first);
writeFileSync(join(out, "graph.json"), readFileSync(plan.artifactPath));
writeFileSync(join(out, "graph-state.json"), readFileSync(plan.statePath));
writeFileSync(join(out, "completion.json"), readFileSync(plan.completionPath));
console.log(`rendered ${first.length} bytes of project decompiler page`);
