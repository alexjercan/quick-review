/**
 * End-to-end proof against the packaged extension.
 *
 * Builds a real repository, opens the real review page, drives it over HTTP,
 * approves it, and writes the rendered page and completion event to $out.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageRoot = process.env.QUICK_REVIEW_PACKAGE;
const out = process.env.out;
assert.ok(packageRoot, "QUICK_REVIEW_PACKAGE is required");
assert.ok(out, "out is required");

const { planReview, openReview } = await import(
  `${packageRoot}/extensions/quick-review/review.ts`
);
const { parseWalkthrough } = await import(
  `${packageRoot}/extensions/quick-review/walkthrough.ts`
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
const plan = await planReview({ cwd: repository });
assert.equal(plan.inputs.baseRef, "main");
assert.equal(plan.inputs.targetRef, "HEAD");

const artifact = `# Greet by name

The greeting now takes a name.

:::walkthrough
version: 1
status: ready
revision: ${plan.inputs.revision}
baseRevision: ${plan.inputs.baseRevision}
files: ${plan.files}
added: ${plan.added}
removed: ${plan.removed}
:::

:::change
id: greet-by-name
importance: critical
file: src/app.js
lines: 1-3
:::

The helper now interpolates the caller name.

\`\`\`diff
-  return 'hi';
+  return \`hi \${name}\`;
\`\`\`

:::review
Does the helper handle an empty name?
:::
`;

const completions = [];
const review = await openReview(plan, parseWalkthrough(artifact), {
  ask: async () => "The caller must always pass a name.",
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
assert.match(first, /data-card="greet-by-name"/);
assert.match(first, new RegExp(plan.inputs.revision));
assert.match(first, /data-action="approve"[^>]* disabled/);

await act({ action: "explain", section: "greet-by-name" });
const context = await act({ action: "context", section: "greet-by-name" });
assert.match(context.context, /export function greet\(name\)/);
const diff = await act({ action: "full-diff" });
assert.match(diff.diff, /diff --git a\/src\/app\.js/);
await act({
  action: "add-comment",
  section: "greet-by-name",
  comment: "An empty name still renders.",
});
await act({ action: "mark-viewed", section: "greet-by-name" });
const approved = await act({
  action: "approve",
  comment: "Ship it after the empty name check.",
});
assert.equal(approved.state.outcome, "approved");

const page = await (await fetch(review.url)).text();
assert.match(page, /The caller must always pass a name\./);
assert.match(page, /An empty name still renders\./);
assert.match(page, /<main class="closed">/);
assert.match(page, /class="outcome approved" data-outcome>Approved\./);
await review.server.finished;
await review.server.close();

assert.equal(completions.length, 1);
const event = completions[0];
assert.equal(event.version, 1);
assert.equal(event.outcome, "approved");
assert.equal(event.revision, plan.inputs.revision);
assert.equal(event.comments.length, 1);
assert.equal(event.questions.length, 1);
assert.deepEqual(JSON.parse(readFileSync(plan.completionPath, "utf8")), event);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "review.html"), page);
writeFileSync(join(out, "walkthrough.md"), readFileSync(plan.artifactPath));
writeFileSync(join(out, "state.json"), readFileSync(plan.statePath));
writeFileSync(join(out, "completion.json"), readFileSync(plan.completionPath));
console.log(`rendered ${page.length} bytes of review page`);
