import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diffClass,
  escapeHtml,
  renderDiff,
  renderMarkdown,
  renderPage,
} from "../extensions/quick-review/page.ts";
import { parseWalkthrough } from "../extensions/quick-review/walkthrough.ts";
import {
  addComment,
  initialState,
  recordQuestion,
  setViewed,
} from "../extensions/quick-review/state.ts";
import { walkthrough } from "./helpers.ts";

const REVISION = "a".repeat(40);
const BASE = "b".repeat(40);

function fixture() {
  const document = parseWalkthrough(
    walkthrough(REVISION, BASE, [{ id: "one" }, { id: "two" }]),
  );
  return { document, state: initialState(document) };
}

test("escapes every HTML metacharacter", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('x')">&`),
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;",
  );
});

test("markdown renders a safe subset", () => {
  const html = renderMarkdown(
    "# Title\n\nSome `code` and **bold**.\n\n- one\n- two\n\n> quoted\n\n```\nraw <b>\n```",
  );
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<pre class="md-code"><code>raw &lt;b&gt;<\/code><\/pre>/);
});

test("markdown never emits raw HTML from the artifact", () => {
  const html = renderMarkdown(
    "<script>alert(1)</script>\n\n[x](javascript:alert(1))",
  );
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("diff lines are classified and escaped", () => {
  assert.equal(diffClass("@@ -1 +1 @@"), "hunk");
  assert.equal(diffClass("--- a/x"), "file");
  assert.equal(diffClass("+added"), "add");
  assert.equal(diffClass("-removed"), "del");
  assert.equal(diffClass(" kept"), "context");
  const html = renderDiff("+<b>\n-old");
  assert.match(html, /diff-add">\+&lt;b&gt;</);
  assert.match(html, /diff-del">-old</);
});

test("the page shows every change, the range, and the contract version", () => {
  const { document, state } = fixture();
  const html = renderPage(document, state);
  assert.match(html, /<title>Greet by name<\/title>/);
  assert.match(html, new RegExp(REVISION));
  assert.match(html, new RegExp(BASE));
  assert.match(html, /walkthrough v1/);
  assert.match(html, /data-card="one"/);
  assert.match(html, /data-card="two"/);
  assert.match(html, /Does the helper handle an empty name\?/);
  assert.match(html, /0<\/span>\/<span data-total>2/);
  assert.match(html, /data-action="approve"[^>]* disabled/);
  assert.match(html, /data-action="full-diff"/);
});

test("the page reflects viewed changes, comments, and answers", () => {
  const { document, state } = fixture();
  setViewed(state, "one", true);
  addComment(document, state, "one", "needs a test");
  recordQuestion(state, "two", "why?", "because the caller needs it");
  const html = renderPage(document, state);
  assert.match(html, /1<\/span>\/<span data-total>2/);
  assert.match(html, /class="card viewed"/);
  assert.match(html, /Comment on src\/app\.js:1-3/);
  assert.match(html, /needs a test/);
  assert.match(html, /because the caller needs it/);
  assert.match(html, /badge state-needs-explanation/);
});

test("approval unlocks once every change is viewed", () => {
  const { document, state } = fixture();
  setViewed(state, "one", true);
  setViewed(state, "two", true);
  const html = renderPage(document, state);
  assert.ok(!/data-action="approve"[^>]* disabled/.test(html));
});

test("a closed review renders no enabled approval", () => {
  const { document, state } = fixture();
  setViewed(state, "one", true);
  setViewed(state, "two", true);
  state.outcome = "approved";
  assert.match(
    renderPage(document, state),
    /data-action="approve"[^>]* disabled/,
  );
});

test("hostile artifact text cannot break out of the page", () => {
  const document = parseWalkthrough(
    walkthrough(REVISION, BASE, [
      {
        id: "hostile",
        prose: "</pre><script>alert(1)</script>",
        prompt: "</div><script>alert(2)</script>",
        diff: "+</pre><script>alert(3)</script>",
      },
    ]),
  );
  const html = renderPage(document, initialState(document));
  assert.ok(!html.includes("<script>alert"));
  assert.equal(html.match(/&lt;script&gt;alert/g)?.length, 3);
});

test("a closed review shows the outcome and hides the composers", () => {
  const { document, state } = fixture();
  setViewed(state, "one", true);
  setViewed(state, "two", true);
  state.outcome = "changes-requested";
  const html = renderPage(document, state);
  assert.match(html, /<main class="closed">/);
  assert.match(
    html,
    /class="outcome changes-requested" data-outcome>Changes requested\./,
  );
});
