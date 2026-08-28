# Plan

## Goal

Implement the interaction proven by
`tasks/20260828-100800/project-decompiler.html` as a bounded, exact-revision
Quick Review mode for Pi and Claude Code. The first production slice must work
for both committed `HEAD` analysis and diff analysis, must expand progressively,
and must use the current session agent.

## Decision gates before implementation

Resolve these before changing production contracts:

1. **Command shape.** Choose between `--scope head|diff`, subcommands, or a new
   command while the old walkthrough remains available.
2. **HEAD completion.** Decide whether HEAD analysis ends with approve/request
   changes or a non-approval `finish` outcome. A new outcome changes the
   completion contract.
3. **Artifact transition.** Decide whether graph mode is additive during one
   release or immediately becomes the default page.
4. **Dirty worktrees.** The planned baseline is committed HEAD only. Decide
   separately whether a later immutable worktree snapshot is worth its identity
   and storage complexity.

Record each answer in `DECISIONS.md` before implementing the affected phase.

## Phase 1: Specify the graph contract

- Add a host-neutral graph artifact with independent versioning.
- Define bounded node, edge, evidence, code excerpt, guidance-source, and diff
  overlay records.
- Give every node a stable ID, kind, title, summary, confidence, expansion
  state, and exact-revision evidence.
- Define expansion deltas. A delta may add or refine only the requested subtree
  and must not silently rewrite unrelated reviewed claims.
- Define limits for artifact bytes, node and edge counts, depth, code excerpts,
  questions, and one expansion response.
- Define graph-state identity from the exact artifact plus scope revisions.
- Update `docs/contract.md` before production code consumes the format.
- Add parser fixtures for accepted, malformed, oversized, escaping, duplicate,
  and unsupported-version records.

Verification: focused parser and state tests, TypeScript, and formatting.

## Phase 2: Add exact scope planning

- Generalize range planning into a host-neutral analysis plan.
- Diff scope keeps the current exact base and target semantics and patch bundle.
- HEAD scope binds analysis to one full commit SHA and reads only that tree.
- Record dirty-worktree presence, but do not include dirty files in the first
  HEAD implementation.
- Add bounded project inventory helpers for tracked paths, manifests, language
  hints, and exact-revision file reads.
- Keep repository content untrusted. Expose evidence to the agent without
  elevating arbitrary files to instructions.

Verification: temporary Git repositories for HEAD, explicit diff, default diff,
moved refs, dirty worktrees, deleted files, and bounds.

## Phase 3: Build graph state and expansion rules

- Persist the root graph and incremental expansion deltas under the review
  directory.
- Validate parent ownership, depth, stable IDs, evidence paths, revision
  identity, and aggregate limits before applying a delta.
- Make delta application atomic. A failed expansion leaves the prior graph and
  review state unchanged.
- Track viewed nodes, node questions, comments, focused state needed for page
  restoration, and terminal outcome without storing transient pan coordinates
  unless a later UX test proves they are durable review state.
- Invalidate the graph artifact and state after a change request exactly as the
  walkthrough is invalidated now.

Verification: state round trips, rejected deltas, aggregate-bound exhaustion,
identity mismatch, atomic failure, and invalidation tests.

## Phase 4: Define the current-session protocol

- Add a root graph submission tool and a structured expansion-answer tool.
- Pi pushes expansion requests into the current session and triggers a turn.
- MCP returns expansion requests from `quick_review_wait`; the agent submits the
  delta and resumes waiting.
- Keep ordinary node questions on the same host seam and bind each request to a
  node and exact revision.
- Discover Pi context-file and skill provenance through the adapter's system
  prompt options. For MCP, require the session agent to report applied guidance
  provenance in its structured submission.
- Never spawn another model.

Verification: adapter tests for root submit, expansion, question, cancellation,
timeout, duplicate response, close, session shutdown, and moved revision.

## Phase 5: Extend server actions

- Add actions for enhance, focus metadata, graph context, exact code, and graph
  questions while preserving serialized action execution.
- Recheck exact scope before and after agent-backed actions.
- Abort in-flight Git and expansion work when the review closes.
- Keep action requests bounded and reject unknown fields.
- Preserve the exclusive completion-file commit boundary.

Verification: real loopback HTTP tests for every action, Origin and Host
rejection, concurrent actions, close races, moved revisions, and terminal-state
refusal.

## Phase 6: Replace mock data with the production graph page

- Port the accepted PoC behavior into the server-rendered page without a client
  framework or remote assets.
- Render escaped graph data and syntax-highlighted exact code.
- Implement nested enhancement, draggable nodes, collision reflow, global ask
  overlay, synchronized focused tabs, project-tree routing, breadcrumb, minimap,
  pan, wheel zoom, and dynamic SVG bounds.
- Keep the page keyboard accessible. Add non-pointer actions for navigation,
  enhance, ask, focus, tab switching, and close.
- Respect reduced motion and preserve responsive behavior.
- Keep transient layout local to the page unless restoration becomes a stated
  requirement.

Verification: page unit tests, real HTTP state updates, Chromium interaction
checks for the accepted PoC regressions, accessibility smoke checks, and narrow
viewport screenshots.

## Phase 7: Integrate outcomes and compatibility

- Connect graph review comments and questions to the completion record selected
  at the decision gate.
- Keep existing approval and change-request safety properties.
- If completion fields or outcomes change, bump the completion version and
  update all Pi, MCP, documentation, and test consumers together.
- Provide an explicit legacy walkthrough path during the agreed transition.

Verification: full Pi harness loop and full MCP stdio loop for both HEAD and diff
scope, including question, expansion, approval or finish, and change request.

## Phase 8: Documentation and release proof

- Update `docs/concept.md`, `docs/contract.md`, `docs/claude.md`, README command
  examples, and changelog.
- Document graph confidence, evidence provenance, committed-HEAD semantics,
  bounds, and the legacy transition.
- Run `npm run check` after focused tests.
- Run `nix flake check` because the packaged Pi and Claude artifacts both gain
  files and protocol behavior.
- Perform one live Pi diff review, one live Pi HEAD analysis, and one Claude MCP
  review with at least one expansion and one question.

## Delivery slices

Keep each slice independently reviewable:

1. Contract and parser tests.
2. HEAD and diff planning.
3. Graph state and atomic deltas.
4. Pi protocol.
5. MCP protocol.
6. Server actions.
7. Production graph page.
8. Completion compatibility, documentation, and live proof.

Do not begin a later slice while an earlier slice has unresolved identity,
bound, or lifecycle failures.
