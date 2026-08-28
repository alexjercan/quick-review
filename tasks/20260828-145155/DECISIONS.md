# Decisions

## Adopted product shape

- Use one progressive graph. A node enhances in place into a nested graph.
- Support two exact scopes: committed `HEAD` and a base-to-target diff overlay.
- `Focus` creates synchronized tabs. An enhanced container tab shows its
  contents as the root graph; a collapsed container or leaf shows itself.
- Keep decompiler output and syntax-highlighted code as first-class graph nodes.
- Keep `Enhance`, `Ask`, and `Focus` on nodes.
- Keep the project tree fully indexed. Route it to the current tab, nearest open
  ancestor tab, or Project canvas, in that order.
- Use background pan, pointer-centered wheel zoom, top-center tree snapping, a
  pinned context breadcrumb, and a minimal minimap. Do not show native canvas
  scrollbars.
- Use the Quick Review square-panel style with the accepted Gruber-inspired
  palette.

## Core constraints

- The current session agent builds the graph and answers questions. Do not add a
  generator, sub-agent, workspace, or job dependency.
- Keep Pi APIs in `index.ts` and MCP behavior in `mcp.ts`. Graph contracts,
  state, Git reads, page generation, and server actions remain plain Node.
- Preserve loopback-only token protection, request bounds, exact-revision
  checks around every action, durable terminal decisions, and invalidation
  after a change request.
- Treat host-loaded trusted instructions and skills as guidance. Treat arbitrary
  repository documentation as evidence, not executable instruction.
- Every graph claim must identify confidence and exact-revision evidence.
  Inferred edges must remain visibly distinct from confirmed edges.

## Implementation gates

- Make the project graph the only host-adapter experience. Do not expose a
  scope option: without `--base`, analyze one committed target snapshot; with
  `--base`, analyze its base-to-target diff. Do not expose the linear
  walkthrough submission tool.
- Keep `approved` and `changes-requested` in both scopes. In HEAD scope,
  approval accepts the exact committed architecture snapshot; it does not claim
  that a diff is ready to merge.
- Review committed HEAD only. Report a dirty worktree, but exclude it from the
  graph identity and evidence.
- Give graph artifacts, graph state, and graph completion independent version 1
  contracts and a separate `quick-review:graph-completed` event. Do not change
  the meaning of walkthrough completion version 1.

## Interaction polish

- Pan from every non-interactive canvas surface, not only the viewport element.
  Use pointer capture and animation-frame geometry updates to keep dragging
  stable.
- Keep Ask and Comment composers inside their graph node. Do not interrupt graph
  context with dialogs.
- Remove viewed-state controls and approval gating from the graph page. Retain
  the version 1 `viewed` state field for compatibility; this does not change a
  contract format.
- Render exact code as a collapsible, linked client-side projection node with
  line numbers and syntax colors. It is not an evidence claim or graph artifact
  node.
- Make the canvas feel infinite by starting in a large centered world and
  rebasing coordinates near its edges without moving visible nodes. Move the
  grid with that world.
- Rank visible roots from their directed graph edges and place ranks on distinct
  hierarchy levels. Place direct children in one child rank instead of a fixed
  two-column grid. Manual node movement overrides automatic root placement.
- Submit inline Ask and Comment forms with Ctrl+Enter or Command+Enter while
  preserving plain Enter for multiline text.
- Indent Project structure descendants with one fixed-width guide segment per
  ancestor and a visible branch connector for the direct parent.

## Comment workflow

- Use one Comment composer for node and exact-code-line anchors. Its actions are
  `Send to agent`, passive `Comment`, and `Cancel`; Ctrl+Enter selects the first.
- Save comments immediately. Agent delivery is a nonblocking FIFO with one
  active current-session request and visible draft, queued, active, answered,
  failed, or superseded state. Do not add parallel agents or review rounds.
- Add neutral `commented` completion. It supersedes active and queued individual
  sends, ends the review immediately, and asks the current session agent to
  triage comments and suggest next steps without editing.
- Version graph state and completion as version 3 because comments are ordered
  reviewer-agent message threads. Keep artifact and delta at version 1.
- A thread keeps one node or exact-line anchor. Only its latest draft reviewer
  message can be edited. Once sent, a message freezes; `Reply` appends a new
  draft to the last message in the chain. Agent responses are inserted directly
  after the reviewer message they answer.
- After neutral feedback, approval, change request, or external close, count
  down three seconds and attempt to close the browser tab with a visible
  fallback.

## Compatibility direction

- Keep graph artifact, state, delta, and completion versions independent. The
  old walkthrough implementation can remain as internal source while planning
  and Git behavior are reused, but Pi and MCP no longer register its tools or
  route commands to its page.
