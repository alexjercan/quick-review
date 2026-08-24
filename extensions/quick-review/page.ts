/** Server-rendered review page: escaped HTML, one stylesheet, one script. */

import type {
  ReviewComment,
  ReviewState,
  SectionState,
  WalkthroughDocument,
  WalkthroughSection,
} from "./contract.ts";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const INLINE_CODE = /`([^`\n]+)`/g;
const LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;
const BOLD = /\*\*([^*\n]+?)\*\*/g;
const ITALIC = /(?<!\*)\*([^*\n]+?)\*(?!\*)/g;
const HEADING = /^(#{1,6}) +(.+)$/;
const ORDERED = /^[0-9]{1,9}[.)] +(.+)$/;

function emphasis(value: string): string {
  return value
    .replace(LINK, '$1 <code class="md-link">$2</code>')
    .replace(BOLD, "<strong>$1</strong>")
    .replace(ITALIC, "<em>$1</em>");
}

function inline(value: string): string {
  const escaped = escapeHtml(value);
  const parts: string[] = [];
  let position = 0;
  for (const match of escaped.matchAll(INLINE_CODE)) {
    parts.push(emphasis(escaped.slice(position, match.index)));
    parts.push(`<code>${match[1]}</code>`);
    position = match.index + match[0].length;
  }
  parts.push(emphasis(escaped.slice(position)));
  return parts.join("");
}

/** Render a safe structured Markdown subset to fully escaped HTML. */
export function renderMarkdown(value: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  let listTag = "";
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0)
      blocks.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (items.length > 0)
      blocks.push(
        `<${listTag}>${items.map((item) => `<li>${item}</li>`).join("")}</${listTag}>`,
      );
    items = [];
    listTag = "";
  };
  const flushQuote = () => {
    if (quote.length > 0)
      blocks.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`);
    quote = [];
  };
  const flush = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  const lines = value.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const stripped = lines[index]!.trim();
    if (stripped.startsWith("```")) {
      flush();
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.trim().startsWith("```")) {
        code.push(lines[index]!);
        index++;
      }
      blocks.push(
        `<pre class="md-code"><code>${escapeHtml(code.join("\n"))}</code></pre>`,
      );
      continue;
    }
    const heading = HEADING.exec(stripped);
    const ordered = ORDERED.exec(stripped);
    if (heading) {
      flush();
      const level = Math.min(heading[1]!.length + 2, 6);
      blocks.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (["---", "***", "___"].includes(stripped)) {
      flush();
      blocks.push("<hr>");
    } else if (/^[-*+] /.test(stripped)) {
      flushParagraph();
      flushQuote();
      if (listTag !== "ul") {
        flushList();
        listTag = "ul";
      }
      items.push(inline(stripped.slice(2).trim()));
    } else if (ordered) {
      flushParagraph();
      flushQuote();
      if (listTag !== "ol") {
        flushList();
        listTag = "ol";
      }
      items.push(inline(ordered[1]!));
    } else if (stripped.startsWith(">")) {
      flushParagraph();
      flushList();
      quote.push(stripped.slice(1).trim());
    } else if (!stripped) flush();
    else {
      flushList();
      flushQuote();
      paragraph.push(stripped);
    }
  }
  flush();
  return blocks.join("");
}

export function diffClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (
    /^(?:diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename)/.test(
      line,
    )
  )
    return "file";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

export function renderDiff(value: string): string {
  return value
    .split("\n")
    .map(
      (line) =>
        `<span class="diff-line diff-${diffClass(line)}">${escapeHtml(line) || " "}</span>`,
    )
    .join("");
}

const STATE_LABELS: Record<SectionState, string> = {
  "not-reviewed": "Not viewed",
  viewed: "Viewed",
  "needs-explanation": "Needs explanation",
};

const OUTCOME_LABELS: Record<string, string> = {
  approved: "Approved. The session agent has the result.",
  "changes-requested":
    "Changes requested. This review is closed and the walkthrough is invalidated.",
};

function title(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function commentHtml(comment: ReviewComment): string {
  return (
    '<div class="review-comment">' +
    `<div class="review-comment-head">Comment on ${escapeHtml(comment.file)}:${escapeHtml(comment.lines)}</div>` +
    `<div class="review-comment-body">${escapeHtml(comment.body)}</div></div>`
  );
}

function masthead(document: WalkthroughDocument): string {
  const warnings = document.warnings
    .map(
      (item) =>
        `<div class="warning" role="note">warn: ${escapeHtml(item)}</div>`,
    )
    .join("");
  return (
    '<header class="masthead">' +
    '<div class="mast-line"><span class="eyebrow">quick review</span>' +
    `<code class="mast-rev" title="Reviewed revision">${escapeHtml(document.revision.slice(0, 12))}</code></div>` +
    `<h1>${escapeHtml(document.title)}</h1>` +
    `<div class="prose intro">${renderMarkdown(document.summary)}</div>` +
    '<dl class="facts">' +
    `<div class="fact"><dt>revision</dt><dd><code>${escapeHtml(document.revision)}</code></dd></div>` +
    `<div class="fact"><dt>base</dt><dd><code>${escapeHtml(document.baseRevision)}</code></dd></div>` +
    `<div class="fact"><dt>files</dt><dd>${document.files}</dd></div>` +
    `<div class="fact"><dt>lines</dt><dd><span class="added">+${document.added}</span> <span class="removed">-${document.removed}</span></dd></div>` +
    `<div class="fact"><dt>contract</dt><dd>walkthrough v${document.version}</dd></div>` +
    "</dl>" +
    warnings +
    '<div class="mast-tools" data-scope>' +
    '<button class="button" data-action="full-diff">View exact full diff</button>' +
    '<div class="feedback" role="status" aria-live="polite"></div>' +
    '<pre class="full-diff diff" data-full-diff aria-label="Exact full diff" hidden></pre>' +
    "</div></header>"
  );
}

function index(document: WalkthroughDocument, state: ReviewState): string {
  const rows = document.sections
    .map((section) => {
      const viewed = state.viewed[section.id] === true;
      return (
        `<li><a class="index-row" href="#change-${escapeHtml(section.id)}">` +
        `<span class="index-mark${viewed ? " done" : ""}" data-nav-viewed="${escapeHtml(section.id)}">${viewed ? "[x]" : "[ ]"}</span>` +
        `<span class="index-title">${escapeHtml(title(section.id))}</span>` +
        `<code class="index-file">${escapeHtml(section.file)}:${escapeHtml(section.lines)}</code>` +
        `<span class="tag importance-${section.importance}">${section.importance}</span>` +
        "</a></li>"
      );
    })
    .join("");
  const viewed = Object.values(state.viewed).filter(Boolean).length;
  const total = document.sections.length;
  return (
    '<nav class="index" id="changes" aria-label="Changes">' +
    `<div class="index-head"><h2>Changes (${total})</h2>` +
    `<span class="index-progress"><span data-reviewed>${viewed}</span>/<span data-total>${total}</span> viewed</span></div>` +
    `<progress class="progress" data-progress value="${viewed}" max="${total}"></progress>` +
    `<ol class="index-list">${rows}</ol>` +
    '<p class="kbd-hint">keys: <kbd>j</kbd> next change / <kbd>k</kbd> previous change / <kbd>v</kbd> toggle viewed</p>' +
    "</nav>"
  );
}

function card(
  position: number,
  total: number,
  section: WalkthroughSection,
  state: ReviewState,
): string {
  const id = escapeHtml(section.id);
  const value = state.sections[section.id] ?? "not-reviewed";
  const viewed = state.viewed[section.id] === true;
  const answers = state.questions
    .filter((item) => item.sectionId === section.id)
    .map(
      (item) =>
        `<div class="answer"><strong>${escapeHtml(item.question)}</strong><div>${escapeHtml(item.answer)}</div></div>`,
    )
    .join("");
  const comments = state.comments
    .filter((item) => item.sectionId === section.id)
    .map(commentHtml)
    .join("");
  return (
    `<article class="card${viewed ? " viewed" : ""}" id="change-${id}" data-card="${id}" tabindex="-1">` +
    '<header class="card-head"><div class="card-title">' +
    `<p class="card-count">change ${position} of ${total}</p>` +
    `<h2>${escapeHtml(title(section.id))}</h2>` +
    `<p class="meta"><code class="card-file">${escapeHtml(section.file)}:${escapeHtml(section.lines)}</code></p>` +
    `<p class="meta tags"><span class="tag importance-${section.importance}">${section.importance}</span>` +
    `<span class="badge state-${value}" data-state="${id}">${STATE_LABELS[value]}</span></p>` +
    "</div>" +
    `<label class="view-control" data-scope data-section="${id}">` +
    `<input type="checkbox" data-viewed="${id}"${viewed ? " checked" : ""}><span>Viewed</span>` +
    '<span class="feedback compact" role="status" aria-live="polite"></span></label></header>' +
    '<div class="card-details">' +
    `<div class="prose">${renderMarkdown(section.markdown)}</div>` +
    `<pre class="diff" tabindex="0" aria-label="Git diff">${renderDiff(section.diff)}</pre>` +
    `<div class="prompt"><strong>Review prompt</strong>${escapeHtml(section.prompt)}</div>` +
    `<div class="answers" data-answers="${id}">${answers}</div>` +
    `<div class="controls" data-scope data-section="${id}">` +
    `<div class="comment-thread" data-comments="${id}">${comments}</div>` +
    '<div class="comment-composer"><textarea class="comment" maxlength="4096" placeholder="Leave a comment on this change" aria-label="Change review comment"></textarea>' +
    '<button class="button comment-action" data-action="add-comment" data-input=".comment">Add comment</button></div>' +
    '<div class="actions"><button class="button" data-action="explain">Explain review prompt</button>' +
    '<button class="button" data-action="context">Show context</button></div>' +
    '<div class="question-composer"><input class="question" maxlength="4096" placeholder="Ask the session agent about this exact revision" aria-label="Question for the session agent">' +
    '<button class="button" data-action="ask" data-input=".question">Ask agent</button></div>' +
    '<div class="feedback" role="status" aria-live="polite"></div>' +
    '<pre class="context-view" aria-label="Exact-revision file context" hidden><code></code></pre>' +
    "</div></div></article>"
  );
}

function final(document: WalkthroughDocument, state: ReviewState): string {
  const viewed = Object.values(state.viewed).filter(Boolean).length;
  const total = document.sections.length;
  const canApprove = viewed === total && state.outcome === "open";
  return (
    '<section class="final" data-scope>' +
    "<h2>Final review</h2>" +
    '<div class="final-counts">' +
    `<span><span data-reviewed>${viewed}</span>/<span data-total>${total}</span> viewed</span>` +
    `<span><span data-note-count>${state.comments.length}</span> change comments</span></div>` +
    `<div class="review-summary comment-thread" data-review-summary>${state.comments.map(commentHtml).join("")}</div>` +
    '<label class="overall-label" for="overall-review-comment">Overall review comment</label>' +
    '<textarea id="overall-review-comment" class="overall-comment" maxlength="4096" placeholder="Leave an optional approval comment, or explain why changes are needed" aria-label="Overall review comment"></textarea>' +
    '<p class="final-note">Approval requires every change to be viewed. Request changes requires an overall explanation and carries every comment above back to the session agent.</p>' +
    `<div class="actions"><button class="button primary" data-action="approve" data-input=".overall-comment"${canApprove ? "" : " disabled"}>${state.comments.length > 0 ? "Approve with comments" : "Approve"}</button>` +
    '<button class="button danger" data-action="request-changes" data-input=".overall-comment" hidden>Request changes</button></div>' +
    '<div class="feedback" role="status" aria-live="polite"></div>' +
    `<div class="outcome ${state.outcome}" data-outcome${state.outcome === "open" ? " hidden" : ""}>${
      state.outcome === "open" ? "" : OUTCOME_LABELS[state.outcome]
    }</div>` +
    "</section>"
  );
}

export function renderPage(
  document: WalkthroughDocument,
  state: ReviewState,
): string {
  const total = document.sections.length;
  const cards = document.sections
    .map((section, position) => card(position + 1, total, section, state))
    .join("");
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    `<title>${escapeHtml(document.title)}</title>` +
    '<link rel="stylesheet" href="style.css"></head><body>' +
    '<a class="skip" href="#changes">Skip to changes</a>' +
    `<main${state.outcome === "open" ? "" : ' class="closed"'}>${masthead(document)}${index(document, state)}${cards}${final(document, state)}</main>` +
    '<script src="app.js" defer></script></body></html>'
  );
}

export const PAGE_CSS = String.raw`
:root {
  color-scheme: light dark;
  --bg: #eceeed;
  --panel: #fbfcfb;
  --ink: #1a1f20;
  --muted: #535e5d;
  --line: #c3cbc9;
  --strong: #87958f;
  --accent: #00587a;
  --ok: #17632a;
  --err: #9e1b26;
  --warn: #7a4e00;
  --add-bg: #e1f1e3;
  --del-bg: #f6e3e3;
  --hunk-bg: #e2ecf1;
  --code-bg: #f0f2f1;
  --hover: #e5e9e8;
  --on-solid: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111514;
    --panel: #171c1b;
    --ink: #d9e1de;
    --muted: #939d99;
    --line: #2e3634;
    --strong: #4d5a57;
    --accent: #4fb3d9;
    --ok: #46a05e;
    --err: #e06058;
    --warn: #cf9a3d;
    --add-bg: #142b1c;
    --del-bg: #33191b;
    --hunk-bg: #122733;
    --code-bg: #131817;
    --hover: #1f2624;
    --on-solid: #101413;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 13px/1.6 ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas,
    "DejaVu Sans Mono", "Liberation Mono", monospace;
}
main { max-width: 1080px; margin: 0 auto; padding: 28px 20px 90px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.skip {
  position: absolute;
  left: -9999px;
  top: 0;
  z-index: 10;
  background: var(--panel);
  border: 1px solid var(--strong);
  padding: 8px 12px;
  color: var(--ink);
}
.skip:focus { left: 12px; top: 12px; }

.masthead { background: var(--panel); border: 1px solid var(--line); padding: 22px 24px; margin-bottom: 18px; }
.mast-line { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.eyebrow { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
.mast-rev { color: var(--muted); font-size: 12px; border: 1px solid var(--line); background: var(--code-bg); padding: 1px 8px; }
h1 { margin: 0 0 10px; font-size: 19px; line-height: 1.35; }
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  border-top: 1px solid var(--line);
  border-left: 1px solid var(--line);
  margin: 16px 0 0;
}
.fact {
  background: var(--panel);
  padding: 8px 12px;
  min-width: 0;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.fact dt { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin: 0 0 3px; }
.fact dd { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.added { color: var(--ok); font-weight: 700; }
.removed { color: var(--err); font-weight: 700; }
.warning { margin: 14px 0 0; padding: 8px 12px; border: 1px solid var(--warn); border-left-width: 3px; color: var(--warn); }
.mast-tools { margin-top: 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.full-diff { flex-basis: 100%; max-height: 520px; overflow: auto; margin: 4px 0 0; }

.index { background: var(--panel); border: 1px solid var(--line); padding: 16px 20px; margin-bottom: 18px; }
.index-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.index h2, .final h2 { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.index-progress { color: var(--muted); font-size: 12px; }
.progress { appearance: none; display: block; width: 100%; height: 10px; border: 1px solid var(--line); background: var(--code-bg); }
.progress::-webkit-progress-bar { background: var(--code-bg); }
.progress::-webkit-progress-value { background: var(--ok); }
.progress::-moz-progress-bar { background: var(--ok); }
.index-list { list-style: none; margin: 12px 0 0; padding: 0; border-top: 1px solid var(--line); }
.index-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 7px 4px;
  border-bottom: 1px solid var(--line);
  color: inherit;
  text-decoration: none;
  min-width: 0;
}
.index-row:hover { background: var(--hover); }
.index-mark { color: var(--muted); flex: none; }
.index-mark.done { color: var(--ok); font-weight: 700; }
.index-title { font-weight: 600; flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; }
.index-file { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; min-width: 0; flex: 1; }
.kbd-hint { margin: 10px 0 0; color: var(--muted); font-size: 11px; }
kbd { border: 1px solid var(--strong); background: var(--code-bg); padding: 0 5px; font: inherit; font-size: 11px; }

.tag, .badge {
  display: inline-block;
  border: 1px solid var(--line);
  background: var(--code-bg);
  color: var(--muted);
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
.importance-critical { color: var(--err); border-color: var(--err); }
.importance-important { color: var(--warn); border-color: var(--warn); }
.importance-supporting { color: var(--muted); border-color: var(--strong); }
.state-not-reviewed { color: var(--muted); }
.state-viewed { color: var(--ok); border-color: var(--ok); }
.state-needs-explanation { color: var(--accent); border-color: var(--accent); }

.card { background: var(--panel); border: 1px solid var(--line); margin: 0 0 18px; scroll-margin-top: 16px; }
.card.viewed { border-left: 3px solid var(--ok); }
.card.viewed .card-details { display: none; }
.card.viewed .card-head { border-bottom: 0; }
.card.viewed h2 { color: var(--muted); }
.card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
.card-title { min-width: 0; }
.card-count { margin: 0 0 4px; color: var(--muted); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
.card h2 { margin: 0 0 6px; font-size: 15px; }
.meta { margin: 4px 0 0; display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; min-width: 0; }
.card-file { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.view-control {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
  flex: none;
  cursor: pointer;
}
.view-control input { width: 15px; height: 15px; margin: 0; accent-color: var(--ok); }

.prose { padding: 14px 20px; overflow-wrap: break-word; }
.prose.intro { padding: 0; }
.prose p { margin: 8px 0; }
.prose h3, .prose h4, .prose h5, .prose h6 { margin: 14px 0 6px; font-size: 13px; letter-spacing: 0.05em; text-transform: uppercase; }
.prose h3 { font-size: 14px; }
.prose ul, .prose ol { margin: 8px 0; padding-left: 22px; }
.prose li { margin: 3px 0; }
.prose blockquote { margin: 10px 0; padding: 2px 12px; border-left: 3px solid var(--strong); color: var(--muted); }
.prose hr { border: 0; border-top: 1px solid var(--line); margin: 14px 0; }
.prose code { background: var(--code-bg); border: 1px solid var(--line); padding: 0 4px; font-size: 12px; overflow-wrap: anywhere; }
.prose .md-code { margin: 10px 0; padding: 10px 12px; border: 1px solid var(--line); background: var(--code-bg); overflow-x: auto; font-size: 12px; line-height: 18px; }
.prose .md-code code { border: 0; background: none; padding: 0; }

.diff { margin: 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); overflow-x: auto; background: var(--code-bg); font-size: 12px; line-height: 20px; }
.diff-line { display: block; white-space: pre; min-width: max-content; padding: 0 14px; border-left: 3px solid transparent; }
.diff-add { background: var(--add-bg); border-left-color: var(--ok); }
.diff-del { background: var(--del-bg); border-left-color: var(--err); }
.diff-hunk { background: var(--hunk-bg); color: var(--accent); }
.diff-file { color: var(--muted); font-weight: 600; }

.prompt { margin: 14px 20px; padding: 10px 14px; border: 1px solid var(--line); border-left: 3px solid var(--accent); background: var(--code-bg); }
.prompt strong { display: block; color: var(--accent); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 4px; }
.answers { margin: 0 20px; }
.answer { border: 1px solid var(--line); background: var(--code-bg); padding: 10px 14px; margin: 10px 0; }
.answer strong { display: block; margin-bottom: 4px; }
.answer div { white-space: pre-wrap; overflow-wrap: anywhere; }
.controls { padding: 14px 20px 20px; }

.comment-thread { border: 1px solid var(--line); margin: 10px 0; }
.comment-thread:empty { display: none; }
.review-comment + .review-comment { border-top: 1px solid var(--line); }
.review-comment-head { padding: 6px 12px; background: var(--code-bg); border-bottom: 1px solid var(--line); font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.review-comment-body { padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }

.comment, .question, .overall-comment {
  width: 100%;
  border: 1px solid var(--strong);
  background: var(--panel);
  color: var(--ink);
  padding: 8px 10px;
  margin: 0 0 10px;
  font: inherit;
}
.comment, .overall-comment { min-height: 84px; resize: vertical; }
::placeholder { color: var(--muted); opacity: 0.8; }
.comment-composer, .question-composer { border-top: 1px solid var(--line); padding-top: 14px; margin-top: 14px; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }

.button {
  appearance: none;
  border: 1px solid var(--strong);
  background: var(--panel);
  color: var(--ink);
  font: inherit;
  font-weight: 600;
  padding: 6px 14px;
  cursor: pointer;
}
.button:hover { background: var(--hover); }
.button:disabled { opacity: 0.45; cursor: not-allowed; }
.button.primary { background: var(--ok); border-color: var(--ok); color: var(--on-solid); }
.button.danger { background: var(--err); border-color: var(--err); color: var(--on-solid); }
.button.comment-action { background: var(--accent); border-color: var(--accent); color: var(--on-solid); }
.button.primary:hover, .button.danger:hover, .button.comment-action:hover { filter: brightness(1.12); }

.feedback { min-height: 20px; margin-top: 8px; color: var(--muted); font-size: 12px; }
.feedback.error { color: var(--err); font-weight: 600; }
.feedback.success { color: var(--ok); }
.feedback.compact { width: 100%; min-height: 0; margin: 0; white-space: normal; text-align: right; }
.feedback.compact:empty { display: none; }
.spinner { display: inline-block; width: 9px; height: 9px; background: currentColor; margin-right: 7px; vertical-align: -1px; animation: pulse 1s steps(2, start) infinite; }
@keyframes pulse { to { opacity: 0; } }
.context-view { max-height: 420px; overflow: auto; margin: 12px 0 0; padding: 10px 12px; border: 1px solid var(--line); background: var(--code-bg); font-size: 12px; line-height: 18px; white-space: pre; }

.final { background: var(--panel); border: 1px solid var(--line); padding: 20px 24px; margin-top: 24px; }
.final-counts { display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-weight: 600; font-size: 12px; margin-top: 12px; }
.review-summary { margin-top: 12px; }
.review-summary:empty { display: none; }
.overall-label { display: block; font-weight: 700; margin: 16px 0 6px; }
.final-note { color: var(--muted); font-size: 12px; margin: 10px 0; }
.outcome { margin-top: 14px; padding: 10px 14px; border: 1px solid var(--ok); border-left-width: 3px; color: var(--ok); font-weight: 700; }
.outcome.changes-requested { border-color: var(--err); color: var(--err); }

main.closed .view-control,
main.closed .comment-composer,
main.closed .question-composer,
main.closed .card .actions,
main.closed .final .actions,
main.closed .overall-label,
main.closed .overall-comment,
main.closed .final-note { display: none; }
main.closed .card.viewed .card-details { display: block; }

@media (max-width: 680px) {
  main { padding: 14px 10px 60px; }
  .masthead, .index, .final { padding: 14px; }
  .card-head { flex-direction: column; gap: 10px; }
  .view-control { justify-content: flex-start; }
  .prose, .controls { padding-left: 14px; padding-right: 14px; }
  .prompt, .answers { margin-left: 14px; margin-right: 14px; }
  .actions .button { flex: 1; }
  .index-row { flex-wrap: wrap; }
  .index-file { flex-basis: 100%; }
  .index-row .tag { margin-left: auto; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .spinner { animation: none; }
}
`;

export const PAGE_JS = String.raw`
const root=document.querySelector('main');
const cards=[...root.querySelectorAll('[data-card]')];
let currentState=null;
let activeCard=-1;
const stateLabels={'not-reviewed':'Not viewed','viewed':'Viewed','needs-explanation':'Needs explanation'};
const outcomeLabels={'approved':'Approved. The session agent has the result.','changes-requested':'Changes requested. This review is closed and the walkthrough is invalidated.'};
function commentBox(item){const box=document.createElement('div');box.className='review-comment';const head=document.createElement('div');head.className='review-comment-head';head.textContent='Comment on '+item.file+':'+item.lines;const body=document.createElement('div');body.className='review-comment-body';body.textContent=item.body;box.append(head,body);return box}
function diffKind(line){if(line.startsWith('@@'))return 'hunk';if(/^(?:diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename)/.test(line))return 'file';if(line.startsWith('+'))return 'add';if(line.startsWith('-'))return 'del';return 'context'}
function renderDiff(target,value){target.replaceChildren();for(const line of value.split('\n')){const span=document.createElement('span');span.className='diff-line diff-'+diffKind(line);span.textContent=line||' ';target.append(span)}}
function syncFinalActions(){
  const overall=document.querySelector('.overall-comment');const hasOverall=Boolean(overall&&overall.value.trim());const closed=Boolean(currentState&&currentState.outcome!=='open');
  const approve=document.querySelector('[data-action="approve"]');
  if(approve){const count=currentState?currentState.comments.length:0;approve.textContent=(count>0||hasOverall)?'Approve with comments':'Approve';if(currentState){const viewed=Object.values(currentState.viewed).filter(Boolean).length;approve.disabled=closed||viewed!==Object.keys(currentState.sections).length}}
  const request=document.querySelector('[data-action="request-changes"]');if(request){request.hidden=!hasOverall||closed;request.disabled=closed}
  const outcome=document.querySelector('[data-outcome]');
  if(outcome){if(closed){outcome.hidden=false;outcome.className='outcome '+currentState.outcome;outcome.textContent=outcomeLabels[currentState.outcome]||currentState.outcome}else{outcome.hidden=true}}
}
function renderState(state){
  currentState=state;
  root.classList.toggle('closed',state.outcome!=='open');
  let viewed=0;
  for(const [id,value] of Object.entries(state.sections)){
    if(state.viewed[id])viewed++;
    const card=document.querySelector('[data-card="'+CSS.escape(id)+'"]');if(card)card.classList.toggle('viewed',state.viewed[id]);
    const checkbox=document.querySelector('[data-viewed="'+CSS.escape(id)+'"]');if(checkbox)checkbox.checked=state.viewed[id];
    const mark=document.querySelector('[data-nav-viewed="'+CSS.escape(id)+'"]');if(mark){mark.textContent=state.viewed[id]?'[x]':'[ ]';mark.classList.toggle('done',state.viewed[id])}
    const badge=document.querySelector('[data-state="'+CSS.escape(id)+'"]');
    if(badge){badge.className='badge state-'+value;badge.textContent=stateLabels[value]||value}
    const answers=document.querySelector('[data-answers="'+CSS.escape(id)+'"]');
    if(answers){answers.replaceChildren();for(const item of state.questions.filter(q=>q.sectionId===id)){
      const box=document.createElement('div');box.className='answer';const strong=document.createElement('strong');strong.textContent=item.question;const text=document.createElement('div');text.textContent=item.answer;box.append(strong,text);answers.append(box)
    }}
    for(const thread of document.querySelectorAll('[data-comments="'+CSS.escape(id)+'"]')){thread.replaceChildren();for(const item of state.comments.filter(n=>n.sectionId===id))thread.append(commentBox(item))}
  }
  const total=Object.keys(state.sections).length;
  document.querySelectorAll('[data-reviewed]').forEach(x=>x.textContent=viewed);
  document.querySelectorAll('[data-total]').forEach(x=>x.textContent=total);
  document.querySelectorAll('[data-note-count]').forEach(x=>x.textContent=state.comments.length);
  document.querySelectorAll('[data-progress]').forEach(x=>{x.max=total;x.value=viewed});
  const summary=document.querySelector('[data-review-summary]');if(summary){summary.replaceChildren();for(const item of state.comments)summary.append(commentBox(item))}
  syncFinalActions();
}
async function act(control,action=control.dataset.action){
  const scope=control.closest('[data-scope]');const feedback=scope.querySelector('.feedback');const controls=scope.querySelectorAll('button,input,textarea');const input=control.dataset.input?scope.querySelector(control.dataset.input):null;const payload={action};if(scope.dataset.section)payload.section=scope.dataset.section;if(input)payload.comment=input.value;
  controls.forEach(x=>x.disabled=true);feedback.className='feedback';feedback.replaceChildren(Object.assign(document.createElement('span'),{className:'spinner'}),document.createTextNode('Working...'));
  try{
    const response=await fetch('action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    let result;try{result=await response.json()}catch{throw new Error('Request failed ('+response.status+')')}
    if(result.state)renderState(result.state);
    if(!response.ok||!result.ok)throw new Error(result.error||'Request failed ('+response.status+')');
    if(typeof result.context==='string'){const view=scope.querySelector('.context-view');if(view){view.querySelector('code').textContent=result.context;view.hidden=false}}
    if(typeof result.diff==='string'){const view=scope.querySelector('[data-full-diff]');if(view){renderDiff(view,result.diff);view.hidden=false}}
    feedback.textContent=result.message||'Updated.';feedback.className='feedback success';
    if(input&&['ask','add-comment'].includes(payload.action))input.value='';
  }
  catch(error){feedback.textContent=error instanceof Error?error.message:String(error);feedback.className='feedback error'}
  finally{controls.forEach(x=>x.disabled=false);if(currentState)renderState(currentState)}
}
root.addEventListener('click',event=>{const button=event.target.closest('button[data-action]');if(button){event.preventDefault();act(button)}});
root.addEventListener('change',event=>{const checkbox=event.target.closest('input[data-viewed]');if(checkbox)act(checkbox,checkbox.checked?'mark-viewed':'reopen')});
root.addEventListener('input',event=>{if(event.target.matches('.overall-comment'))syncFinalActions()});
root.addEventListener('focusin',event=>{const card=event.target.closest('[data-card]');if(card)activeCard=cards.indexOf(card)});
function focusCard(index){if(cards.length===0)return;activeCard=Math.min(cards.length-1,Math.max(0,index));const card=cards[activeCard];card.focus({preventScroll:true});card.scrollIntoView({block:'start'})}
function typingTarget(target){return target instanceof HTMLElement&&(target.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(target.tagName))}
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||typingTarget(event.target))return;
  if(event.key==='j'){event.preventDefault();focusCard(activeCard+1)}
  else if(event.key==='k'){event.preventDefault();focusCard(activeCard<=0?0:activeCard-1)}
  else if(event.key==='v'&&activeCard>=0){const checkbox=cards[activeCard].querySelector('input[data-viewed]');if(checkbox&&!checkbox.disabled){event.preventDefault();checkbox.checked=!checkbox.checked;act(checkbox,checkbox.checked?'mark-viewed':'reopen')}}
});
`;
