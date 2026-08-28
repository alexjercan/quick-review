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

- Make the project graph the only host-adapter experience. Plain
  `/quick-review` and unscoped MCP start default to diff; `--scope head` selects
  a committed snapshot. Do not expose the linear walkthrough submission tool.
- Keep `approved` and `changes-requested` in both scopes. In HEAD scope,
  approval accepts the exact committed architecture snapshot; it does not claim
  that a diff is ready to merge.
- Review committed HEAD only. Report a dirty worktree, but exclude it from the
  graph identity and evidence.
- Give graph artifacts, graph state, and graph completion independent version 1
  contracts and a separate `quick-review:graph-completed` event. Do not change
  the meaning of walkthrough completion version 1.

## Compatibility direction

- Keep graph artifact, state, delta, and completion versions independent. The
  old walkthrough implementation can remain as internal source while planning
  and Git behavior are reused, but Pi and MCP no longer register its tools or
  route commands to its page.
