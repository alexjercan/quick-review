# Verification

- `npm run check` - passed: strict TypeScript, 123 tests, and Prettier. 22 of
  those tests are new: 10 in `tests/host.test.ts` and 12 in `tests/mcp.test.ts`.
- `nix flake check` - passed: tests, formatting, package structure, and the
  end-to-end review page. The package check now also asserts that the plugin
  manifest, the marketplace manifest, and the command ship, that the server path
  in `mcpServers` resolves to a real file, and that `host.ts`, `jsonrpc.ts`, and
  `mcp.ts` import on plain Node with no dependency tree.
- Real process handshake: `node extensions/quick-review/mcp.ts` fed
  `initialize`, `notifications/initialized`, and `tools/list` on stdin. Every
  stdout line was valid JSON-RPC, stderr was empty, the server reported version
  `0.1.1` read from `package.json`, and it exited cleanly when stdin closed.
  Recorded in `evidence/stdio-handshake.jsonl`.

## What the tests cover

`tests/mcp.test.ts` drives the real transport over a pipe against a real
temporary git repository and the real loopback page. The full loop runs: start,
submit, a page `ask` answered through `quick_review_wait` and
`quick_review_answer`, `mark-viewed`, and `approve` collected as the outcome.
Change requests, cancellation, duplicate starts, a wrong-revision walkthrough,
malformed calls, and close are covered too.

`tests/host.test.ts` covers the queue property the loop depends on: a wait that
expires, is cancelled before it starts, or is abandoned mid-flight leaves the
reviewer's question in the queue for the next wait.

## Live install

- `claude plugin validate` - passed on the marketplace manifest.
- `claude plugin marketplace add <checkout>` then
  `claude plugin install quick-review@alexjercan --scope local` - installed.
- `claude plugin details quick-review` - reports one command and
  `MCP servers (1) review`. This is what caught the packaging bug: an
  `mcpServers` object in `plugin.json` reported `0`, and so did an `mcpServers`
  path field. Only the plugin-root `.mcp.json` reports `1`.
- `claude mcp list` - `plugin:quick-review:review` connects, so the server
  completes the MCP handshake under a real host and not only under the tests.
- Always-on cost is about 30 tokens. Tool schemas resolve at runtime and are not
  counted against the session.

## Live review

Run from a Claude Code session after `/reload-plugins`, which reported one
plugin MCP server.

- `/quick-review` with no arguments refused with `nothing to review: master and
  HEAD resolve to the same commit`. Correct: the adapter's own work was staged,
  not committed. The refusal reached the agent through the real host.
- `/quick-review --base HEAD~1 --target HEAD` ran the whole loop:
  `quick_review_start` returned the walkthrough instructions with the inlined
  patch, `quick_review_submit` opened the page on loopback with two changes, and
  `quick_review_wait` returned the approval once the reviewer decided.
- The five tools resolved as
  `mcp__plugin_quick-review_review__quick_review_*` and arrived as deferred
  tools, so only their names cost context until they were called.

## Not verified

- No reviewer question was asked from the page during the live run, so
  `quick_review_answer` has not round-tripped outside the tests. That path is
  covered by `tests/mcp.test.ts` against the real transport and the real page.
- The 15-minute question timeout and the 5-minute wait timeout are exercised
  only at short values injected by tests. No wait ran long enough to be moved to
  a background task.
