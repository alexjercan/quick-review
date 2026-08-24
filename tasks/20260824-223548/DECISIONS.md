# Decisions

## Invert the direction instead of duplicating the review

- `ReviewHost` in `review.ts` is already the only seam between a review and the
  agent that owns it. Add a second implementation, not a second review.
- Pi pushes: `pi.sendMessage` with `triggerTurn` interrupts the agent. Claude
  Code has no such primitive, so the agent pulls: `quick_review_wait` blocks
  until the page produces an event.
- Events leave the queue only when handed to a live waiter. A wait that expires
  or is cancelled leaves the reviewer's question where it was.
- `next()` checks the abort signal before the queue, so a wait that was already
  cancelled never consumes an event it will not deliver.

## Considered and rejected

- **A CLI binary plus a skill.** The loopback server has to outlive each
  command, so this needs a daemon with a PID or socket file, a port claim, and
  cleanup on crash. That is new orphan and fencing surface in a project whose
  discipline is exact ownership. A `Bash` call also caps at ten minutes, so
  every wait would be a fresh process and a short poll. An MCP stdio server gets
  the lifetime for free: the host starts it with the session and kills it with
  the session.
- **Channels.** `notifications/claude/channel` is the real analogue of
  `pi.sendMessage` and would keep the push shape. It is a research preview:
  custom channels are off the Anthropic allowlist, need
  `--dangerously-load-development-channels`, require Anthropic authentication,
  need an admin switch on Team and Enterprise, and the contract may change.
  Right shape, wrong time. `ReviewHost` is where it plugs in later.
- **`@modelcontextprotocol/sdk`.** Ninety-four packages and 27 MB, including
  two HTTP frameworks and an OAuth stack, to serve a pipe. It also assumes zod
  where this project uses typebox. The stdio transport is newline-delimited
  JSON-RPC 2.0; `jsonrpc.ts` implements it in one file and `dependencies` stays
  empty. The SDK becomes mandatory only for channels.
- **A separate repository.** One contract, one test suite, one release. A split
  would need a coordinated version bump for every limit or format change.

## Shape

- `host.ts`: the event queue and the pull-side `ReviewHost`. Harness-neutral.
- `jsonrpc.ts`: newline-delimited JSON-RPC 2.0 over a byte stream. Knows nothing
  about Quick Review, so a test drives it over a pipe exactly as a host does.
- `mcp.ts`: five tools, the review lifecycle, and the stdio entry point.
- Packaged as a Claude Code plugin, with the server declared in a plugin-root
  `.mcp.json`. Three forms were tried against a real install and measured with
  `claude plugin details`: an `mcpServers` object inside `plugin.json` reports
  `MCP servers (0)`, an `mcpServers` path field pointing at another file also
  reports `0`, and only the root `.mcp.json` reports `1`. Every official plugin
  uses the root file for the same reason.
- The cost is that this repository's own `.mcp.json` is also read as project
  configuration, where the schema wants a `mcpServers` wrapper and
  `${CLAUDE_PLUGIN_ROOT}` is unset, so a maintainer working inside the checkout
  sees a parse warning. Adding the wrapper satisfies both readers but then
  offers a broken server for approval, which is worse. No filename satisfies
  both, and nobody installing the plugin is affected.
- `buildPrompt` takes an inline patch limit. A host warns above ten thousand
  tokens of tool output, so the MCP adapter stops inlining at 24 KiB and points
  the agent at `patch.diff`. The prompt is not part of the versioned contract,
  so no contract version change is required.
- Tools stay registered for the whole session. There is no equivalent of
  `pi.setActiveTools`; the runtime guards that already exist do the work.
