# AGENTS.md

Global `~/AGENTS.md` applies. This file defines project-specific instructions.

## Project

- `quick-review` is a standalone Pi package. It ships one extension that adds
  `/quick-review` to any Pi session.
- The session's own agent builds the walkthrough and answers page questions.
  Never add a spawned generator, a sub-agent, or a workspace assumption.
- Scufris is one consumer, not the owner. Nothing here may depend on Scufris,
  Sprout, or a job model.

## Workflow

- Work directly on `master` unless the user requests an isolated worktree.
- Use Tatr for requested tracked work. Keep one task for one request and its
  follow-up work.
- Keep decisions and verification evidence under `tasks/<id>/`.
- Inspect installed Pi documentation and local source before network research.

## Conventions

- Keep Pi APIs in `extensions/quick-review/index.ts`. Every other module stays
  plain Node so it can be tested without a Pi session.
- Keep the versioned contract in `extensions/quick-review/contract.ts`. Changing
  a format, a limit, or a field means changing a version and `docs/contract.md`.
- Preserve the safety properties: exact-revision validation, a revision recheck
  around every action, bounded artifact and message sizes, a loopback page
  behind a random path token, and invalidation after a change request.
- Add files with their first tested behaviour. Do not add empty placeholders.
- Use strict TypeScript and Prettier. Type-stripping must keep working, so no
  `enum`, no namespaces, and no parameter properties.
- Put Pi APIs in `peerDependencies` and other runtime libraries in
  `dependencies`.
- Keep `README.md` to the description and Quickstart. Put durable documentation
  in `docs/`.
- Prefer focused integration tests and small end-to-end examples. The page and
  the git range are testable for real: drive the server over HTTP against a
  temporary repository.
- Run the cheapest relevant check. Use `npm run check` for TypeScript behaviour
  and `nix flake check` for packaging and offline verification.
