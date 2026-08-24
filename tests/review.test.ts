/** End-to-end: plan a real range, open the page, and drive it over HTTP. */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CompletionEvent } from "../extensions/quick-review/contract.ts";
import {
  discardPlan,
  openReview,
  planReview,
  verifyRange,
  withReviewDirectory,
  type OpenReview,
  type ReviewPlan,
} from "../extensions/quick-review/review.ts";
import { parseWalkthrough } from "../extensions/quick-review/walkthrough.ts";
import {
  commit,
  git,
  repository,
  walkthrough,
  write,
  type Fixture,
} from "./helpers.ts";

/** fetch() refuses to set Host, so drive the header check over raw http. */
function rawStatus(url: string, host: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(target.port),
        path: target.pathname,
        headers: { host },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

interface Harness {
  fixture: Fixture;
  plan: ReviewPlan;
  review: OpenReview;
  asked: Array<{ sectionId: string; question: string }>;
  completed: CompletionEvent[];
  get(path: string, init?: RequestInit): Promise<Response>;
  act(body: object): Promise<{ status: number; payload: any }>;
  cleanup(): Promise<void>;
}

async function harness(
  answer = "The caller must pass a name.",
): Promise<Harness> {
  const fixture = repository();
  const stateDirectory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  const plan = await planReview({ cwd: fixture.path });
  const document = parseWalkthrough(
    walkthrough(plan.inputs.revision, plan.inputs.baseRevision, [
      { id: "greet-by-name" },
      {
        id: "readme-note",
        file: "README.md",
        lines: "1",
        importance: "supporting",
      },
    ]),
  );
  const asked: Array<{ sectionId: string; question: string }> = [];
  const completed: CompletionEvent[] = [];
  const review = await openReview(
    plan,
    document,
    {
      ask: async (request) => {
        asked.push({
          sectionId: request.sectionId,
          question: request.question,
        });
        return answer;
      },
      complete: (event) => void completed.push(event),
    },
    { now: () => "2026-08-24T13:10:54.000Z" },
  );
  return {
    fixture,
    plan,
    review,
    asked,
    completed,
    get: (path, init) => fetch(new URL(path, review.url), init),
    act: async (body) => {
      const response = await fetch(new URL("action", review.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, payload: await response.json() };
    },
    cleanup: async () => {
      await review.server.close();
      fixture.cleanup();
      rmSync(stateDirectory, { recursive: true, force: true });
      delete process.env.QUICK_REVIEW_STATE_DIR;
    },
  };
}

test("planning captures the exact range and patch", async () => {
  const fixture = repository();
  const stateDirectory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  try {
    const plan = await planReview({ cwd: join(fixture.path, "src") });
    assert.equal(plan.inputs.repository, fixture.path);
    assert.equal(plan.inputs.baseRef, "main");
    assert.equal(plan.inputs.targetRef, "HEAD");
    assert.equal(plan.inputs.baseRevision, fixture.base);
    assert.equal(plan.inputs.revision, fixture.head);
    assert.deepEqual(
      { files: plan.files, added: plan.added, removed: plan.removed },
      { files: 1, added: 2, removed: 2 },
    );
    assert.equal(plan.subject, "Greet by name");
    assert.equal(plan.dirty, false);
    assert.match(
      readFileSync(plan.patchPath, "utf8"),
      /\+export function greet\(name\)/,
    );
    await assert.rejects(
      planReview({ cwd: fixture.path, baseRef: "HEAD", targetRef: "HEAD" }),
      /nothing to review/,
    );
  } finally {
    fixture.cleanup();
    rmSync(stateDirectory, { recursive: true, force: true });
    delete process.env.QUICK_REVIEW_STATE_DIR;
  }
});

test("the review page serves only its token path on loopback", async () => {
  const test = await harness();
  try {
    const page = await test.get("");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /default-src 'none'/,
    );
    const html = await page.text();
    assert.match(html, new RegExp(test.plan.inputs.revision));
    assert.match(html, /data-card="greet-by-name"/);
    assert.match(html, /data-card="readme-note"/);
    assert.equal((await test.get("style.css")).status, 200);
    assert.equal((await test.get("app.js")).status, 200);
    assert.equal((await test.get("../secret")).status, 404);
    assert.match(
      test.review.url,
      /^http:\/\/127\.0\.0\.1:[0-9]+\/[A-Za-z0-9_-]{20,}\/$/,
    );
    assert.equal(await rawStatus(test.review.url, "evil.example"), 403);
    assert.equal(
      await rawStatus(test.review.url, `localhost:${test.review.server.port}`),
      200,
    );
    const crossOrigin = await fetch(new URL("action", test.review.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.example",
      },
      body: JSON.stringify({ action: "full-diff" }),
    });
    assert.equal(crossOrigin.status, 403);
  } finally {
    await test.cleanup();
  }
});

test("the reviewer works through changes and approves", async () => {
  const test = await harness();
  try {
    const viewed = await test.act({
      action: "mark-viewed",
      section: "greet-by-name",
    });
    assert.equal(viewed.status, 200);
    assert.equal(viewed.payload.state.viewed["greet-by-name"], true);
    assert.equal(viewed.payload.state.sections["greet-by-name"], "viewed");
    assert.deepEqual(
      JSON.parse(readFileSync(test.plan.statePath, "utf8")),
      viewed.payload.state,
    );

    const reopened = await test.act({
      action: "reopen",
      section: "greet-by-name",
    });
    assert.equal(reopened.payload.state.viewed["greet-by-name"], false);

    const comment = await test.act({
      action: "add-comment",
      section: "greet-by-name",
      comment: "Name is never checked for empty.",
    });
    assert.equal(comment.payload.state.comments.length, 1);
    assert.equal(comment.payload.state.comments[0].file, "src/app.js");

    const explained = await test.act({
      action: "explain",
      section: "greet-by-name",
    });
    assert.equal(explained.status, 200);
    assert.deepEqual(test.asked, [
      {
        sectionId: "greet-by-name",
        question: "Does the helper handle an empty name?",
      },
    ]);
    assert.equal(explained.payload.state.questions.length, 1);
    assert.equal(
      explained.payload.state.sections["greet-by-name"],
      "needs-explanation",
    );

    const asked = await test.act({
      action: "ask",
      section: "readme-note",
      comment: "Why touch the readme?",
    });
    assert.equal(asked.payload.state.questions.length, 2);
    assert.equal(test.asked[1]?.question, "Why touch the readme?");

    const context = await test.act({
      action: "context",
      section: "greet-by-name",
    });
    assert.match(
      context.payload.context,
      new RegExp(test.plan.inputs.revision),
    );
    assert.match(context.payload.context, /export function greet\(name\)/);

    const diff = await test.act({ action: "full-diff" });
    assert.match(diff.payload.diff, /diff --git a\/src\/app\.js/);

    const early = await test.act({ action: "approve" });
    assert.equal(early.status, 400);
    assert.match(early.payload.error, /every change must be viewed/);
    assert.equal(test.completed.length, 0);

    await test.act({ action: "mark-viewed", section: "greet-by-name" });
    await test.act({ action: "mark-viewed", section: "readme-note" });
    const approved = await test.act({
      action: "approve",
      comment: "Good to go once the empty name is handled.",
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.payload.state.outcome, "approved");

    await test.review.server.finished;
    assert.equal(test.completed.length, 1);
    const event = test.completed[0]!;
    assert.equal(event.version, 1);
    assert.equal(event.outcome, "approved");
    assert.equal(event.revision, test.plan.inputs.revision);
    assert.equal(event.baseRevision, test.plan.inputs.baseRevision);
    assert.equal(event.identity, test.review.document.identity);
    assert.equal(event.sections, 2);
    assert.equal(
      event.overallComment,
      "Good to go once the empty name is handled.",
    );
    assert.deepEqual(event.comments, [
      {
        sectionId: "greet-by-name",
        file: "src/app.js",
        lines: "1-3",
        body: "Name is never checked for empty.",
      },
    ]);
    assert.equal(event.questions.length, 2);
    assert.equal(event.completedAt, "2026-08-24T13:10:54.000Z");
    assert.deepEqual(
      JSON.parse(readFileSync(test.plan.completionPath, "utf8")),
      event,
    );
    assert.ok(existsSync(test.plan.artifactPath));

    const afterTerminal = await test.act({ action: "full-diff" });
    assert.equal(afterTerminal.status, 400);
    assert.match(afterTerminal.payload.error, /terminal action/);
  } finally {
    await test.cleanup();
  }
});

test("requesting changes invalidates the walkthrough", async () => {
  const test = await harness();
  try {
    await test.act({
      action: "add-comment",
      section: "greet-by-name",
      comment: "Handle the empty name.",
    });
    const missing = await test.act({ action: "request-changes" });
    assert.equal(missing.status, 400);
    assert.match(missing.payload.error, /overall review comment/);

    const requested = await test.act({
      action: "request-changes",
      comment: "Guard the empty name before this lands.",
    });
    assert.equal(requested.status, 200);
    assert.equal(requested.payload.state.outcome, "changes-requested");
    await test.review.server.finished;

    const event = test.completed[0]!;
    assert.equal(event.outcome, "changes-requested");
    assert.equal(
      event.overallComment,
      "Guard the empty name before this lands.",
    );
    assert.equal(event.comments.length, 1);
    assert.equal(existsSync(test.plan.artifactPath), false);
    assert.equal(existsSync(test.plan.statePath), false);
    assert.equal(existsSync(test.plan.patchPath), false);
    assert.ok(existsSync(test.plan.completionPath));
  } finally {
    await test.cleanup();
  }
});

test("an action after the revision moves is refused", async () => {
  const test = await harness();
  try {
    write(
      test.fixture.path,
      "src/app.js",
      "export const greet = () => 'hi';\n",
    );
    commit(test.fixture.path, "Rewrite the greeting");
    const result = await test.act({
      action: "mark-viewed",
      section: "greet-by-name",
    });
    assert.equal(result.status, 400);
    assert.match(result.payload.error, /reviewed revision changed/);
    assert.equal(result.payload.state.viewed["greet-by-name"], false);
  } finally {
    await test.cleanup();
  }
});

test("unknown actions and unknown changes are refused", async () => {
  const test = await harness();
  try {
    assert.match(
      (await test.act({ action: "land" })).payload.error,
      /unknown action/,
    );
    assert.match(
      (await test.act({ action: "mark-viewed", section: "nope" })).payload
        .error,
      /unknown change/,
    );
    assert.match(
      (await test.act({ action: "ask", section: "greet-by-name" })).payload
        .error,
      /needs text/,
    );
    const bad = await fetch(new URL("action", test.review.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    assert.equal(bad.status, 400);
  } finally {
    await test.cleanup();
  }
});

test("an explicit base that moves invalidates the range", async () => {
  const fixture = repository();
  const stateDirectory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  try {
    const plan = await planReview({ cwd: fixture.path, baseRef: "main" });
    assert.equal(plan.baseExplicit, true);
    assert.equal(plan.inputs.baseRevision, fixture.base);
    await verifyRange(plan);

    // Move main forward on its own line. The merge base with the reviewed
    // target is still the planned base, but explicit "main" is not.
    git(fixture.path, "checkout", "-q", "main");
    write(fixture.path, "README.md", "# demo\n\nUnrelated.\n");
    const moved = commit(fixture.path, "Unrelated main commit");
    git(fixture.path, "checkout", "-q", "feature");
    assert.notEqual(moved, fixture.base);
    assert.equal(git(fixture.path, "merge-base", "main", "HEAD"), fixture.base);

    await assert.rejects(
      verifyRange(plan),
      /main no longer resolves to the reviewed base revision/,
    );
  } finally {
    fixture.cleanup();
    rmSync(stateDirectory, { recursive: true, force: true });
    delete process.env.QUICK_REVIEW_STATE_DIR;
  }
});

test("a defaulted base keeps merge-base semantics when the branch moves", async () => {
  const fixture = repository();
  const stateDirectory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  try {
    const plan = await planReview({ cwd: fixture.path });
    assert.equal(plan.baseExplicit, false);
    git(fixture.path, "checkout", "-q", "main");
    write(fixture.path, "README.md", "# demo\n\nUnrelated.\n");
    commit(fixture.path, "Unrelated main commit");
    git(fixture.path, "checkout", "-q", "feature");
    // The reviewed range is unchanged, so the review stays valid.
    await verifyRange(plan);
  } finally {
    fixture.cleanup();
    rmSync(stateDirectory, { recursive: true, force: true });
    delete process.env.QUICK_REVIEW_STATE_DIR;
  }
});

test("a durable decision cannot be replaced by a later one", async () => {
  const test = await harness();
  try {
    // A completion already exists, so the next terminal action is refused and
    // the recorded decision survives untouched.
    writeFileSync(test.plan.completionPath, "{}\n", "utf8");
    await test.act({ action: "mark-viewed", section: "greet-by-name" });
    await test.act({ action: "mark-viewed", section: "readme-note" });
    const result = await test.act({ action: "approve", comment: "ship" });
    assert.equal(result.status, 400);
    assert.match(result.payload.error, /already has a terminal action/);
    assert.equal(readFileSync(test.plan.completionPath, "utf8"), "{}\n");
    assert.equal(test.completed.length, 0);
    await test.review.server.finished;
  } finally {
    await test.cleanup();
  }
});

test("an abandoned plan leaves no directory behind", async () => {
  const fixture = repository();
  const stateDirectory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  try {
    const plan = await planReview({ cwd: fixture.path });
    assert.ok(existsSync(plan.patchPath));
    discardPlan(plan);
    assert.equal(existsSync(plan.directory), false);
  } finally {
    fixture.cleanup();
    rmSync(stateDirectory, { recursive: true, force: true });
    delete process.env.QUICK_REVIEW_STATE_DIR;
  }
});

test("a planned review that opened is never discarded", async () => {
  const test = await harness();
  try {
    discardPlan(test.plan);
    assert.ok(existsSync(test.plan.artifactPath));
    assert.ok(existsSync(test.plan.directory));
  } finally {
    await test.cleanup();
  }
});

test("a failed invalidation is reported, not claimed as success", async () => {
  const test = await harness();
  try {
    // Make one deletion impossible while leaving the other two removable.
    rmSync(test.plan.patchPath, { force: true });
    mkdirSync(test.plan.patchPath, { recursive: true });
    writeFileSync(join(test.plan.patchPath, "blocked"), "x", "utf8");

    const result = await test.act({
      action: "request-changes",
      comment: "Guard the empty name before this lands.",
    });
    assert.equal(result.status, 200);
    assert.match(result.payload.message, /could not be fully removed/);
    // Every deletion was still attempted.
    assert.equal(existsSync(test.plan.artifactPath), false);
    assert.equal(existsSync(test.plan.statePath), false);
    assert.ok(existsSync(test.plan.completionPath));
    const record = join(test.plan.directory, "cleanup-error.txt");
    assert.ok(existsSync(record));
    assert.match(readFileSync(record, "utf8"), /patch\.diff/);
    await test.review.server.finished;
  } finally {
    rmSync(test.plan.patchPath, { recursive: true, force: true });
    await test.cleanup();
  }
});

test("a page that fails to open leaves nothing to block a retry", async () => {
  const fixture = repository();
  const stateDirectory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  try {
    const plan = await planReview({ cwd: fixture.path });
    const document = parseWalkthrough(
      walkthrough(plan.inputs.revision, plan.inputs.baseRevision),
    );
    // Simulate the partial state a failed page start leaves behind.
    writeFileSync(plan.artifactPath, document.source, "utf8");
    writeFileSync(plan.statePath, "{}\n", "utf8");
    discardPlan(plan, true);
    assert.equal(existsSync(plan.directory), false);

    // A retry can now plan and open the same range again.
    const retry = await planReview({ cwd: fixture.path });
    const opened = await openReview(retry, document, {
      ask: async () => "answer",
      complete: () => undefined,
    });
    assert.ok(existsSync(retry.artifactPath));
    await opened.server.close();
  } finally {
    fixture.cleanup();
    rmSync(stateDirectory, { recursive: true, force: true });
    delete process.env.QUICK_REVIEW_STATE_DIR;
  }
});

test("a decided review is never discarded, even forcibly", async () => {
  const test = await harness();
  try {
    writeFileSync(test.plan.completionPath, "{}\n", "utf8");
    discardPlan(test.plan, true);
    assert.ok(existsSync(test.plan.completionPath));
    assert.ok(existsSync(test.plan.artifactPath));
  } finally {
    await test.cleanup();
  }
});

/** Byte-for-byte snapshot of one directory, for proving it was untouched. */
function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  );
}

test("a planning failure removes the directory it had already created", () => {
  const root = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  try {
    let directory = "";
    assert.throws(
      () =>
        withReviewDirectory(
          root,
          () => "abc123abc123-deadbeefdeadbeef",
          (claimed) => {
            directory = claimed;
            writeFileSync(join(claimed, "patch.diff"), "partial", "utf8");
            throw new Error("planning failed");
          },
        ),
      /planning failed/,
    );
    // Nothing is left for a caller that never received a plan.
    assert.equal(existsSync(directory), false);
    assert.deepEqual(readdirSync(root), []);

    const kept = withReviewDirectory(
      root,
      () => "abc123abc123-deadbeefdeadbeef",
      (claimed) => claimed,
    );
    assert.ok(existsSync(kept));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a name collision claims a new directory and touches neither review", () => {
  const root = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  try {
    // One review still open, one already decided with its patch invalidated.
    const open = join(root, "abc123abc123-0000000000000001");
    mkdirSync(open);
    writeFileSync(join(open, "walkthrough.md"), "open walkthrough\n", "utf8");
    writeFileSync(join(open, "state.json"), '{"open":true}\n', "utf8");
    writeFileSync(join(open, "patch.diff"), "open patch\n", "utf8");
    const decided = join(root, "abc123abc123-0000000000000002");
    mkdirSync(decided);
    writeFileSync(
      join(decided, "completion.json"),
      '{"outcome":"changes-requested"}\n',
      "utf8",
    );
    const before = { open: snapshot(open), decided: snapshot(decided) };

    const names = [
      "abc123abc123-0000000000000001",
      "abc123abc123-0000000000000002",
      "abc123abc123-0000000000000003",
    ];
    let index = 0;
    const claimed = withReviewDirectory(
      root,
      () => names[index++]!,
      (directory) => {
        writeFileSync(join(directory, "patch.diff"), "new patch\n", "utf8");
        return directory;
      },
    );

    // The new plan lands somewhere of its own.
    assert.equal(claimed, join(root, "abc123abc123-0000000000000003"));
    assert.equal(index, 3);
    // Both existing reviews are byte-for-byte unchanged.
    assert.deepEqual(snapshot(open), before.open);
    assert.deepEqual(snapshot(decided), before.decided);
    assert.deepEqual(readdirSync(root).sort(), names);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failure after a collision removes only the claimed directory", () => {
  const root = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  try {
    const decided = join(root, "abc123abc123-0000000000000001");
    mkdirSync(decided);
    writeFileSync(
      join(decided, "completion.json"),
      '{"outcome":"approved"}\n',
      "utf8",
    );
    const before = snapshot(decided);

    const names = [
      "abc123abc123-0000000000000001",
      "abc123abc123-0000000000000004",
    ];
    let index = 0;
    assert.throws(
      () =>
        withReviewDirectory(
          root,
          () => names[index++]!,
          () => {
            throw new Error("planning failed");
          },
        ),
      /planning failed/,
    );
    // The decided review survives; only the directory this call created is gone.
    assert.deepEqual(snapshot(decided), before);
    assert.deepEqual(readdirSync(root), ["abc123abc123-0000000000000001"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allocation gives up rather than reuse a taken directory", () => {
  const root = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  try {
    const taken = join(root, "abc123abc123-0000000000000005");
    mkdirSync(taken);
    writeFileSync(join(taken, "completion.json"), '{"kept":true}\n', "utf8");
    const before = snapshot(taken);
    let attempts = 0;
    assert.throws(
      () =>
        withReviewDirectory(
          root,
          () => {
            attempts += 1;
            return "abc123abc123-0000000000000005";
          },
          () => "never",
        ),
      /could not claim a review directory/,
    );
    assert.ok(attempts > 1, "every attempt should use a fresh name");
    assert.deepEqual(snapshot(taken), before);
    assert.deepEqual(readdirSync(root), ["abc123abc123-0000000000000005"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planning leaves existing reviews alone and claims its own directory", async () => {
  const fixture = repository();
  const stateDirectory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  try {
    const first = await planReview({ cwd: fixture.path });
    writeFileSync(first.completionPath, '{"outcome":"approved"}\n', "utf8");
    rmSync(first.patchPath, { force: true });
    const before = snapshot(first.directory);

    const second = await planReview({ cwd: fixture.path });
    assert.notEqual(second.directory, first.directory);
    // The decided review keeps every byte, including its completion record.
    assert.deepEqual(snapshot(first.directory), before);
    assert.equal(readdirSync(stateDirectory).length, 2);
    // Names carry the target revision and a random suffix of eight bytes.
    for (const name of readdirSync(stateDirectory))
      assert.match(
        name,
        new RegExp(`^${first.inputs.revision.slice(0, 12)}-[0-9a-f]{16}$`),
      );
  } finally {
    fixture.cleanup();
    rmSync(stateDirectory, { recursive: true, force: true });
    delete process.env.QUICK_REVIEW_STATE_DIR;
  }
});

test("a planning failure before the directory exists leaves the root empty", async () => {
  const fixture = repository();
  const stateDirectory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  try {
    await assert.rejects(
      planReview({ cwd: fixture.path, baseRef: "HEAD", targetRef: "HEAD" }),
      /nothing to review/,
    );
    await assert.rejects(
      planReview({ cwd: fixture.path, baseRef: "no-such-ref" }),
      /does not resolve to a commit/,
    );
    assert.deepEqual(readdirSync(stateDirectory), []);
  } finally {
    fixture.cleanup();
    rmSync(stateDirectory, { recursive: true, force: true });
    delete process.env.QUICK_REVIEW_STATE_DIR;
  }
});

test("an opening review that is aborted leaves nothing behind", async () => {
  const fixture = repository();
  const stateDirectory = mkdtempSync(join(tmpdir(), "quick-review-state-"));
  process.env.QUICK_REVIEW_STATE_DIR = stateDirectory;
  try {
    const plan = await planReview({ cwd: fixture.path });
    const document = parseWalkthrough(
      walkthrough(plan.inputs.revision, plan.inputs.baseRevision),
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      openReview(
        plan,
        document,
        { ask: async () => "answer", complete: () => undefined },
        { signal: controller.signal },
      ),
      /closed while it was opening/,
    );
    assert.equal(existsSync(plan.directory), false);
  } finally {
    fixture.cleanup();
    rmSync(stateDirectory, { recursive: true, force: true });
    delete process.env.QUICK_REVIEW_STATE_DIR;
  }
});
