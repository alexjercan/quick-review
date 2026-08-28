# Verification

## Planning

- The task references the accepted interaction artifact and preserves its UX
  decisions.
- The plan separates contract, exact scope, state, adapters, server, page,
  compatibility, and release proof.
- Each implementation phase names its cheapest focused verification.
- Contract, completion, dirty-worktree, and command-shape decisions are explicit
  gates rather than hidden implementation assumptions.

## Implementation

- `npm run check` passed with 112 tests after graph mode replaced the adapter
  walkthrough paths. This includes strict graph and delta
  parsing, cycles and hostile text, atomic graph state, HEAD and diff planning,
  moved revisions, queue cancellation, real loopback graph actions, Pi adapter
  flows for HEAD and diff, and an MCP diff enhancement/question/outcome loop.
- `nix flake check` passed all five package, test, format, Nix format, and
  end-to-end checks after every new module was staged into the source closure.
- Chromium CDP against the real graph server passed initial rendering, nested
  enhancement, synchronized focus tabs, pointer wheel zoom, root dragging,
  top-center tree snapping, and syntax highlighting.
- A polish follow-up verified background canvas panning in both axes, inline Ask
  and Comment composers, visible in-progress enhancement state, collapsible
  linked code projections, line numbers, and syntax colors. Captured and
  inspected `/tmp/quick-review-graph-polish.png`.
- The top-center target was 18.08 pixels below the viewport top and 0.10 pixels
  from its horizontal center in a 1600x1000 Chromium viewport.
- Captured and inspected `/tmp/quick-review-graph-production.png`. The production
  page shows the project tree, pinned breadcrumb, graph edges, action controls,
  highlighted code, hidden native scrollbars, minimap, status line, and final
  review entry point.
- `git diff --check` passed. Agent-authored additions use ASCII prose.

## Scope delivered

- Made plain `/quick-review` and unscoped MCP start open a committed target
  graph. Supplying `--base` or MCP `base` selects a diff overlay. There is no
  public scope option. Linear walkthrough tools are no longer registered by
  either host adapter.
- Added independently versioned graph artifact, state, delta, and completion
  contracts with documented bounds.
- Added committed HEAD and exact diff inventory planning.
- Added current-session root submission, enhancement, questions, and completion
  for Pi and dependency-free MCP.
- Added the production project-decompiler page and token-protected serialized
  graph server actions. Polished panning, inline node-local review input,
  enhancement feedback, and collapsible highlighted code projections.
- Updated package metadata, command guidance, durable documentation, and the
  changelog.
