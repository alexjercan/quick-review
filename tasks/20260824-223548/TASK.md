# Add a Claude Code adapter: stdio MCP server and plugin

- STATUS: CLOSED
- PRIORITY: 0
- TAGS: claude, mcp

Make `/quick-review` available in Claude Code without a second review core.
Claude Code cannot push a turn into a session, so the review page has to reach
the agent some other way. Keep one contract, one page, and one set of
exact-revision guarantees across both hosts.
