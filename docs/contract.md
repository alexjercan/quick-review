# Contract

The project graph artifact, graph state, and graph completion event have
independent version numbers. Artifact and delta are version `1`; state and
completion are version `2`. Consumers refuse unknown versions.

## Inputs

| Input      | Source           | Default                           |
| ---------- | ---------------- | --------------------------------- |
| Repository | `--repo <path>`  | Git root of the session directory |
| Base ref   | `--base <ref>`   | omitted                           |
| Target ref | `--target <ref>` | `HEAD`                            |

Without a base, planning binds both revisions to one committed target snapshot.
With a base, it resolves one exact base-to-target range and captures its patch.
Dirty worktree files are reported but excluded.

Refs are rejected when empty, option-like,
longer than 256 characters, or contain whitespace, controls, or backslashes.

A base must keep resolving to the same commit. Every diff recheck reads target,
base, then target so a moving ref cannot pass as one snapshot. Snapshot mode
reads its target twice.

## Graph artifact version 1

The current session agent submits `graph.json` through
`quick_review_graph_submit`. It is one JSON object with these fields:

```json
{
  "version": 1,
  "title": "Project architecture",
  "summary": "Short exact-scope summary",
  "scope": "head | diff",
  "revision": "<40 hex>",
  "baseRevision": "<40 hex>",
  "roots": ["root-id"],
  "nodes": [],
  "edges": [],
  "guidance": []
}
```

The SHA-256 of the exact JSON text is the artifact identity. Scope and revisions
must equal the plan.

### Nodes

Each node has exactly:

- `id`: stable lowercase letters, digits, dash, dot, or colon;
- `parentId`: null for roots, otherwise an existing node ID;
- `kind`: `project`, `component`, `module`, `boundary`, `data`, `flow`,
  `symbol`, `code`, `decompiler`, or `test`;
- `title`, `summary`;
- `confidence`: `confirmed` or `inferred`;
- `overlay`: `unchanged`, `added`, `modified`, `deleted`, `impacted`, or
  `context`;
- `expandable`: boolean;
- `evidence`: one or more exact-target evidence records.

Optional fields are paired `file` and `lines`, plus `language` and `code`.
Repository paths are relative, non-escaping, and backslash-free. Line ranges are
`N` or `N-M`. Evidence records contain `file`, `lines`, the exact target
`revision`, and `confidence`.

### Edges

Each edge has `id`, `source`, `target`, `kind`, and `confidence`, plus optional
`label`. Kind is `contains`, `calls`, `reads`, `writes`, `emits`, `depends-on`,
`implements`, `tests`, or `flows-to`. Endpoints must exist. IDs are unique.
Inferred edges remain explicit in the page.

### Guidance

Guidance records have `path` and kind `context`, `skill`, or `host`. Pi accepts
only guidance that its structured system-prompt options report as loaded. MCP
requires the session agent to report the trusted guidance it applied.
Repository content is evidence, not guidance.

### Bounds

| Value               |     Limit |
| ------------------- | --------: |
| Root artifact       |   256 KiB |
| Nodes               |       160 |
| Edges               |       320 |
| Roots               |        16 |
| Depth               |         6 |
| Evidence per node   |         8 |
| Exact code per node |    16 KiB |
| Title               | 160 bytes |
| Summary             |     4 KiB |

## Expansion delta version 1

`Enhance` asks the current session agent for one delta through
`quick_review_graph_expand`:

```json
{
  "version": 1,
  "revision": "<exact target SHA>",
  "parentId": "requested-node",
  "nodes": [],
  "edges": []
}
```

A delta is at most 64 KiB, 32 nodes, and 64 edges. Every new node must be a
direct child of the requested expandable parent. IDs cannot be reused. A parent
can be expanded once. Aggregate graph and depth limits still apply. Delta
application and state persistence are atomic.

## Graph state version 2

`graph-state.json` is bound to the root identity and exact revisions:

```json
{
  "version": 2,
  "identity": "<sha256>",
  "revision": "<40 hex>",
  "baseRevision": "<40 hex>",
  "deltas": [],
  "viewed": { "node-id": false },
  "questions": [{ "nodeId": "node-id", "question": "...", "answer": "..." }],
  "comments": [
    {
      "id": "<24 hex>",
      "nodeId": "node-id",
      "file": "path.ts",
      "lines": "1-10",
      "body": "...",
      "delivery": "draft | queued | active | answered | failed | superseded",
      "response": "..."
    }
  ],
  "outcome": "open | approved | changes-requested | commented"
}
```

State is capped at 512 KiB, 100 retained version 1 questions, 160 comments, 4
KiB per comment, and 16 KiB per agent response. The `viewed` and `questions`
fields remain for compatibility, but they are not approval gates or page
controls. Transient pan, zoom, tab, code
projection, composer, and node positions stay in the browser.

## Loopback page

The page listens on `127.0.0.1` at an ephemeral port behind a random 24-byte
path token. It serves HTML, CSS, JavaScript, a read-only state route, and one
serialized action route.

Responses use `no-store`, `nosniff`, `no-referrer`, and a CSP that permits only
same-origin style, script, and connect. Host must be the listening loopback
address. Origin, when present, must equal that request's exact origin.

Page actions are `enhance`, `add-comment`, `send-comment`, `code`, `send-review`,
`approve`, and `request-changes`. Comments can use a node anchor or an exact line
inside that node. Saving is immediate. Sending enters one FIFO current-session
agent queue and returns without waiting. Requests are capped at 16 KiB and run
one at a time. Every action verifies the exact scope first. Agent-backed and
terminal actions verify again before mutation or commit. Closing aborts
in-flight work and fences all later mutation.

`send-review` supersedes active and queued individual comment sends and commits
neutral feedback immediately. Approval is available while the exact graph is
open. A terminal action is never replaceable. After any terminal action, the
page counts down for three seconds, attempts to close its tab, and shows a
manual-close fallback when browser policy refuses.

## Graph completion version 2

The exclusive creation of `completion.json` is the terminal commit boundary.
Before it, failure leaves the graph open. After it, delivery or cleanup failure
cannot reopen the decision.

The record contains version, `approved | changes-requested | commented`, scope,
refs, exact revisions, identity, node count, node comments, overall comment,
questions, artifact and state paths, and completion time. Pi emits the same
record as `quick-review:graph-completed`.

A change request invalidates `graph.json`, `graph-state.json`, `inventory.json`,
and `patch.diff`. Cleanup failures are written to `cleanup-error.txt` and
reported without claiming invalidation succeeded.

## Review directory

The root is `$QUICK_REVIEW_STATE_DIR`, else `$XDG_STATE_HOME/quick-review`, else
`~/.local/state/quick-review`. Each review exclusively claims a mode `0700`
directory named from the first 12 target SHA characters plus eight random
bytes. Files use mode `0600`.

A review never adopts an existing directory. A pending failed review removes
only the directory it claimed. A directory containing `completion.json` is
never discarded.

## Compatibility

- Fields and limits do not change meaning within a version.
- Unknown fields in graph, delta, state, and action records are rejected.
- A field or limit change requires its relevant version to change.
- The Pi event name `quick-review:graph-completed` is stable across graph
  completion versions. Consumers must inspect the payload version.

## Environment

| Variable                 | Effect                             |
| ------------------------ | ---------------------------------- |
| `QUICK_REVIEW_STATE_DIR` | override the review directory root |
| `QUICK_REVIEW_NO_OPEN`   | never launch a browser             |
| `XDG_STATE_HOME`         | state root fallback                |
