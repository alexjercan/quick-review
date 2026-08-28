# Quick Review in Claude Code

Quick Review runs in Claude Code as a plugin. The plugin carries a stdio MCP
server and the `/quick-review` command. The review itself is the one described
in `docs/concept.md`: the same legacy walkthrough or progressive project graph,
the same loopback security, and the same exact-revision checks.

## Install

```
/plugin marketplace add alexjercan/quick-review
/plugin install quick-review@alexjercan
```

The server runs `node <plugin>/extensions/quick-review/mcp.ts`. Node 24 strips
the types, so there is no build step and no dependency to install.

To run a checkout instead, point an MCP server entry at it:

```bash
claude mcp add quick-review -- node /path/to/quick-review/extensions/quick-review/mcp.ts
```

Then use `/mcp` to see the tool names, which a plugin prefixes with
`mcp__plugin_quick-review_review__`.

## Why the agent waits

Pi drives the agent: the extension pushes a message into the session and starts
a turn, so the review page can interrupt the agent the moment a reviewer asks
something. Claude Code has no equivalent. Nothing outside the session starts a
turn.

So the direction reverses. The agent calls `quick_review_wait`, which blocks
until the page produces an event, and answers what it gets:

```
quick_review_start         ->  instructions for a walkthrough or graph scope
quick_review_submit        ->  the legacy page opens
quick_review_graph_submit  ->  the project decompiler opens
quick_review_wait          ->  enhancement, question, or outcome
quick_review_graph_expand  ->  an enhanced subtree reaches the page
quick_review_answer        ->  a node question unblocks
```

`extensions/quick-review/host.ts` and `graph-host.ts` are the queues behind
that. They hold what the page produced and hand over one event per wait.

**The reviewer can only reach the agent while the agent is waiting.** An agent
that stops looping leaves `Explain` and `Ask agent` hanging until the question
times out after fifteen minutes. The command and the server instructions both
say to keep waiting; that is the whole contract.

## What the timeouts are for

| Bound                                  | Value      | Why                                         |
| -------------------------------------- | ---------- | ------------------------------------------- |
| One `quick_review_wait`                | 5 minutes  | Reports nothing and asks to be called again |
| One unanswered question or enhancement | 15 minutes | The page stops waiting on the agent         |
| Inlined patch in `start`               | 24 KiB     | Above it the agent reads `patch.diff`       |

A host warns above ten thousand tokens of tool output and truncates well before
a large patch fits, so `start` stops inlining early and points at the patch file
instead.

A host may also move a tool call that runs past two minutes into a background
task. That is fine and wanted: the wait stops holding the session, the user
keeps their prompt, and the reviewer's question arrives as a notification.

Nothing is lost when a wait ends empty or is cancelled. Events leave the queue
only when they are handed to a live waiter, so pressing escape during a wait
leaves the reviewer's question exactly where it was.

## No MCP library

The transport is newline-delimited JSON-RPC 2.0 over stdin and stdout, which is
all the MCP stdio transport is. `extensions/quick-review/jsonrpc.ts` implements
it in one file with no dependencies, and `mcp.ts` answers `initialize`,
`tools/list`, `tools/call`, `ping`, and `notifications/cancelled`.

This keeps `dependencies` empty. The reference SDK brings ninety-four packages
and two HTTP frameworks to serve a pipe.

The one thing that would require the SDK is a
[channel](https://code.claude.com/docs/en/channels-reference), which is how a
server pushes events into a session without being asked. That is Pi's model, and
it would replace the wait loop with the same shape the Pi adapter already has.
It is a research preview today: custom channels are off the approved allowlist,
they need `--dangerously-load-development-channels` to run at all, and the
contract may change. `ReviewHost` is where that would plug in when it settles.

## Limits

- The server is declared in the plugin-root `.mcp.json`. A `mcpServers` field
  in `plugin.json` is ignored, whether it holds an object or a path to another
  file. `claude plugin details quick-review` reports `MCP servers (1)` when the
  declaration is being read.
- That same `.mcp.json` is also read as project configuration by anyone whose
  working directory is this repository, where `${CLAUDE_PLUGIN_ROOT}` does not
  exist and the schema wants a `mcpServers` wrapper. They see a parse warning in
  `claude mcp list`. It affects only work inside this checkout, never an
  installed plugin, and there is no filename that satisfies both readers.
- Nothing writes to stdout except JSON-RPC. A stray `console.log` breaks the
  connection.
- Tools stay registered for the whole session. There is no equivalent of Pi's
  `setActiveTools`, so `quick_review_answer` exists even with no review open. It
  refuses, as it does in Pi.
- One review at a time per server, as in Pi.
