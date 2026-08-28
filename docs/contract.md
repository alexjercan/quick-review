# Contract

Walkthrough artifacts, walkthrough state, and walkthrough completion remain at
version `1`. Progressive graph artifacts, graph state, and graph completion use
three independent version `1` contracts. Consumers refuse unknown versions.

## Inputs

| Input           | Source               | Default                                       |
| --------------- | -------------------- | --------------------------------------------- |
| Repository path | `--repo <path>`      | the git root of the session directory         |
| Base ref        | `--base <ref>`       | merge base with the repository default branch |
| Target ref      | `--target <ref>`     | `HEAD`                                        |
| Graph scope     | `--scope head\|diff` | omitted, which selects the legacy walkthrough |

The default branch is `origin/HEAD` when it is set, otherwise the first of
`main`, `master`, `trunk`, `develop` that exists. When no default branch is
found, `--base` is required.

Refs are rejected when they are empty, start with `-`, exceed 256 characters, or
contain whitespace, control characters, or backslashes. Revision expressions
such as `HEAD~2` and `origin/main^` are accepted. Both refs must resolve to
commits, and the resolved commits must differ.

How the base was chosen changes how it is rechecked later:

- An **explicit** `--base` names one commit. For the rest of the review that ref
  must keep resolving to exactly that commit. A base branch that moves ends the
  review, even when its merge base with the target is unchanged.
- A **defaulted** base is derived through merge-base, so it is rechecked the
  same way. The default branch may move as long as the merge base with the
  reviewed target still equals the reviewed base.

Every recheck reads the target, then the base, then the target again, so a
target that moves while the base is being resolved cannot pass as one
consistent snapshot.

## Output 1: the walkthrough artifact

One Markdown document, at most 256 KiB, with at most 40 changes. Written to
`<review directory>/walkthrough.md`.

````markdown
# Title of the change

Summary paragraph shown under the title.

:::walkthrough
version: 1
status: ready
revision: <40-character target SHA>
baseRevision: <40-character base SHA>
files: <integer>
added: <integer>
removed: <integer>
:::

:::change
id: kebab-case-id
importance: critical | important | supporting
file: path/relative/to/repository
lines: 120 or 120-168
:::

Prose about this change.

```diff
@@ -1,3 +1,3 @@
-old
+new
```

:::review
One question the reviewer should answer about this change.
:::
````

Rules enforced by the parser:

- The `:::walkthrough` block must contain exactly the seven fields above.
- `version` must be `1` and `status` must be `ready`.
- `revision` and `baseRevision` must be full 40-character SHAs and must equal
  the reviewed range.
- Every `:::change` block must contain exactly `id`, `importance`, `file`, and
  `lines`. `file` must be a relative repository path with no `..` segment and no
  backslash. `lines` must be `N` or `N-M` with positive integers.
- Every change must be followed by exactly one ` ```diff ` block and exactly one
  `:::review` block of at most 4 KiB.

A malformed change is dropped with a warning that is shown on the page. An
artifact with no valid change, an unsupported version, malformed metadata, or an
oversized body is rejected outright.

The SHA-256 of the exact artifact text is its **identity**. Review state is
bound to that identity.

## Output 1b: the progressive project graph

`--scope diff` uses the same exact range and patch rules as the walkthrough.
`--scope head` binds both revisions to one committed target and excludes dirty
worktree data. The bounded inventory is produced from Git tree objects.

The agent submits `graph.json`, a JSON graph artifact at version `1`. It is at
most 256 KiB, with at most 160 nodes, 320 edges, 16 roots, six levels, eight
evidence records per node, and 16 KiB of exact code per node. Each node has:

- a stable lowercase ID and optional parent;
- a kind, title, summary, confidence, diff overlay, and expandable flag;
- an optional paired repository path and line range;
- optional language and exact code;
- exact-target evidence with `confirmed` or `inferred` confidence.

Edges identify existing nodes and use one of `contains`, `calls`, `reads`,
`writes`, `emits`, `depends-on`, `implements`, `tests`, or `flows-to`. Inferred
edges remain explicit. Guidance records report trusted context, skill, or host
sources that affected the graph.

Enhancement deltas are separately bounded to 64 KiB, 32 nodes, and 64 edges.
They name one expandable parent and may add only direct children. IDs cannot be
reused. Applying a delta is atomic and aggregate limits still apply.

`graph-state.json` is capped at 512 KiB. It binds to the SHA-256 identity of the
immutable root graph and stores validated deltas, viewed nodes, node questions,
node comments, and the terminal outcome. Transient pan, zoom, and node position
are browser-local.

Graph mode uses `quick_review_graph_submit` for the root and
`quick_review_graph_expand` for enhancement responses. Questions continue to
use `quick_review_answer`. Pi pushes requests into the current session. MCP
returns both question and enhancement events from `quick_review_wait`.

## Output 2: the review page

A loopback HTTP server on `127.0.0.1` with an ephemeral port and a random
24-byte path token: `http://127.0.0.1:<port>/<token>/`.

| Route                | Method | Purpose           |
| -------------------- | ------ | ----------------- |
| `/<token>/`          | GET    | the rendered page |
| `/<token>/style.css` | GET    | the stylesheet    |
| `/<token>/app.js`    | GET    | the script        |
| `/<token>/action`    | POST   | one review action |

Every response carries `Content-Security-Policy: default-src 'none'` with
`self` for style, script, and connect, plus `no-store`, `nosniff`, and
`no-referrer`. Requests with an unexpected `Host` header are refused, and an
`Origin` header must equal `http://` plus that request's own `Host`. The two
loopback aliases are different origins, so `127.0.0.1` and `localhost` never
stand in for each other.

Walkthrough actions are `mark-viewed`, `reopen`, `add-comment`, `explain`,
`ask`, `context`, `full-diff`, `approve`, and `request-changes`. Graph actions
are `enhance`, `mark-viewed`, `reopen-node`, `add-comment`, `ask`, `code`,
`approve`, and `request-changes`. Actions run one at a time. Every
action rechecks the reviewed revisions first; `explain` and `ask` recheck again
after the agent answers; `approve` and `request-changes` recheck once more
immediately before they commit. Once a terminal action commits, every later
action is refused.

Closing the review stops accepting requests immediately, aborts the git work of
any action already running, and refuses that action before it can mutate state
or commit a decision. A close therefore never turns into a decision.

The review state file is written to `<review directory>/state.json`:

```json
{
  "version": 1,
  "identity": "<sha256 of the artifact>",
  "revision": "<target SHA>",
  "baseRevision": "<base SHA>",
  "sections": { "<change id>": "not-reviewed | viewed | needs-explanation" },
  "viewed": { "<change id>": false },
  "questions": [{ "sectionId": "...", "question": "...", "answer": "..." }],
  "comments": [
    {
      "id": "<24 hex>",
      "sectionId": "...",
      "file": "...",
      "lines": "...",
      "body": "..."
    }
  ],
  "outcome": "open | approved | changes-requested"
}
```

State that does not match the artifact identity, the revisions, or the exact set
of change ids is rejected on load.

## Output 3: the completion event

Written to `<review directory>/completion.json`, emitted on the Pi extension
event bus as `quick-review:completed`, and summarised back to the session agent
as a custom message.

Creating that file is the commit boundary, and it is created exclusively. Before
it, any failure leaves the review open. After it, the decision is durable: a
failing invalidation or a failing delivery cannot reopen the review, and a
second terminal action cannot replace the recorded decision.

```json
{
  "version": 1,
  "outcome": "approved | changes-requested",
  "repository": "/abs/path",
  "baseRef": "main",
  "targetRef": "HEAD",
  "baseRevision": "<40 hex>",
  "revision": "<40 hex>",
  "identity": "<sha256 of the artifact>",
  "sections": 7,
  "comments": [
    { "sectionId": "...", "file": "...", "lines": "...", "body": "..." }
  ],
  "overallComment": "...",
  "questions": [{ "sectionId": "...", "question": "...", "answer": "..." }],
  "artifact": "<path>",
  "state": "<path>",
  "completedAt": "<ISO 8601>"
}
```

`changes-requested` also deletes `walkthrough.md`, `state.json`, and
`patch.diff` from the review directory. `completion.json` stays as the record.
Every deletion is attempted even if one fails. A failure is written to
`cleanup-error.txt`, reported to the reviewer, and stated to the session agent
instead of claiming the walkthrough is gone. It never reopens the decision.

## Graph completion

Graph completion is written through the same exclusive commit boundary, but it
is a separate version `1` record and Pi event:
`quick-review:graph-completed`. It records `scope`, graph node count, node
comments and questions, exact revisions, identity, artifact and state paths,
and the same two outcomes. A change request invalidates `graph.json`,
`graph-state.json`, `inventory.json`, and `patch.diff`.

## Review directory

`$QUICK_REVIEW_STATE_DIR`, else `$XDG_STATE_HOME/quick-review`, else
`~/.local/state/quick-review`. The root is created if it is missing. One
directory per review, named `<first 12 of target SHA>-<8 random bytes>`, created
with mode `0700`. A walkthrough holds `walkthrough.md`, `state.json`, and
`patch.diff`. A graph holds `graph.json`, `graph-state.json`, `inventory.json`,
and `patch.diff`. Terminal reviews add `completion.json`. Files use mode `0600`.

Each review directory is claimed exclusively: creation is never recursive, so a
name that already exists is never adopted, and a taken name is retried with a
fresh random one. A review only ever removes a directory it created itself, and
never one that holds `completion.json`, so an existing review's record cannot be
reused or deleted by a later review.

## Compatibility policy

- All six artifact, state, and completion version numbers are independent. A
  consumer must refuse a version it does not know rather than guess.
- Within a version, fields are never removed, renamed, or given a new meaning.
  Parsers reject unknown fields in the metadata block, in review state, and in
  action requests, so new optional fields need a new version.
- New page actions, new page markup, and new prose are not contract changes.
- The `quick-review:completed` event name is stable for the lifetime of
  completion contract version 1.
- Walkthrough and graph limits stated above are part of their contracts.
  Raising one is a version change.
- The outcome message handed to the session agent is capped at 32 KiB and says
  so when it truncates. It is a convenience summary; `completion.json` is the
  complete record and is never truncated.

## Environment

| Variable                 | Effect                                      |
| ------------------------ | ------------------------------------------- |
| `QUICK_REVIEW_STATE_DIR` | overrides the review directory root         |
| `QUICK_REVIEW_NO_OPEN`   | never launch a browser                      |
| `XDG_STATE_HOME`         | used when `QUICK_REVIEW_STATE_DIR` is unset |
