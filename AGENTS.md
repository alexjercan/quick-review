# AGENTS.md

Global `~/AGENTS.md` applies. This file defines project-specific instructions.

## Project

- `quick-review` is a standalone package that adds `/quick-review` to Pi and to
  Claude Code. One review core, one contract, one adapter per host.
- The current session agent writes the walkthrough and answers page questions.
- Never add a generator, sub-agent, workspace, Scufris, or job-model dependency.

## Workflow

- Work on `master` unless the user requests an isolated worktree.
- Use one Tatr task for requested tracked work and its follow-ups. Keep decisions
  and verification under `tasks/<id>/`.
- Read installed Pi documentation and local source before network research.

## Conventions

- Keep host APIs in an adapter: Pi in `extensions/quick-review/index.ts`, MCP in
  `extensions/quick-review/mcp.ts`. Keep other modules plain Node and
  independently testable.
- The MCP adapter depends on no MCP library. Keep the stdio transport in
  `extensions/quick-review/jsonrpc.ts` and keep `dependencies` empty.
- Preserve exact-revision checks, bounded data, the token-protected loopback
  page, and invalidation after a change request.
- A contract format, field, or limit change requires a contract version change
  and an update to `docs/contract.md`.
- Use strict, type-strippable TypeScript and Prettier. Do not use enums,
  namespaces, or parameter properties.
- Put Pi APIs in `peerDependencies` and other runtime libraries in
  `dependencies`.
- Keep `README.md` short. Put durable documentation in `docs/`.
- Prefer focused integration tests with temporary Git repositories and real
  loopback HTTP requests.
- Run the cheapest relevant check. Use `npm run check` for behavior and
  `nix flake check` for packaging.
