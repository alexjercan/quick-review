---
name: pi-extension
description: Change Quick Review commands, walkthrough generation, Git range handling, review page behavior, session questions, or completion flow.
---

# Pi extension

Read installed Pi `docs/extensions.md` completely before changing the extension.
Read `docs/packages.md`, `docs/tui.md`, and installed examples when those APIs
are involved.

- Keep Pi registration and lifecycle code in `extensions/quick-review/index.ts`.
  Keep Git, artifact, page, server, state, and parsing code plain Node.
- Keep walkthrough generation and question answering in the current session
  agent. Never spawn another model or assume a workspace or job.
- Preserve the exact base and target revisions through planning, submission,
  page actions, and completion. Recheck the range around every action.
- Keep all artifact, patch, context, message, section, and comment bounds.
- Serve only on loopback behind the random path token. Start on demand and close
  idempotently on command completion or `session_shutdown`.
- Invalidate the artifact after a change request.
- Update the contract version and `docs/contract.md` for every format, field, or
  limit change.

Test Git behavior in temporary repositories and page behavior over real HTTP.
Run the focused test, then `npm run check`. Run `nix flake check` for package or
Nix changes.
