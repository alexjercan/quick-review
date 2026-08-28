# Decisions

## Treat the project as a progressive graph

- Use a Ghidra-like project decompiler metaphor: the initial view shows
  architecture boundaries, and opening a node creates a nested graph for that
  component.
- Keep one graph model for both modes. `HEAD` shows the architecture snapshot.
  `PR DIFF` adds changed and transitively impacted states.
- Show claims with exact paths, revision identity, confidence, and evidence.
  Distinguish confirmed edges from inferred edges.
- Keep agent questions attached to the selected node instead of creating a
  separate general chat interface.

## Prototype the interaction before extraction

- Build one standalone HTML artifact with no dependencies and no network
  access. Use this repository as representative data.
- Simulate nested navigation, graph selection, PR and HEAD modes, filtering,
  zoom, impact tracing, exact-source loading, and node-scoped agent questions.
- Do not change the production review page, server, or versioned contract in
  this task. A live extractor would mix UI validation with language and project
  analysis concerns.

## Use one nested analysis canvas

- Do not navigate between graph pages or levels. Enhancing a node grows that
  node in place and inserts its recovered internals into a nested canvas.
- A nested graph moves with its owning node. Every visible node can also be
  dragged within its current container.
- Further enhancement happens on child nodes. Leaf nodes reveal more prose,
  evidence, exact revision metadata, and syntax-highlighted code in two steps.
- Put decompiler output on the graph as a first-class, prominent node. Keep
  `Ask` and `Enhance` controls directly on each architecture, symbol, code, and
  decompiler node.
- Use the square panel language of the current Quick Review page with a
  Gruber-inspired near-black, warm yellow, green, brown, red, and neutral color
  scheme.

## Keep floating context and add focused projections

- Keep `Project canvas` as the permanent first workspace tab. `Focus` opens a
  synchronized tab for a node without removing that node from the canvas.
- A focused tab for a container renders its contents as the tab's root graph;
  it does not wrap those contents in another copy of the container node. A leaf
  with no internal graph renders the leaf node itself.
- Focused contents use the same mutable child nodes as the project canvas.
  Enhancement in either view therefore updates both views instead of creating a
  stale snapshot. Focus also preserves current detail: a collapsed container
  first shows the container node, then switches to its contents only after the
  reviewer enhances it.
- Closing a focused tab returns to the unchanged project canvas. Full-screen
  mode can hide the outer project chrome without changing graph state.

## Canvas interaction

- Background pointer dragging pans by default. Non-interactive node surfaces
  drag nodes.
- The wheel zooms around the pointer location. Code blocks keep their own
  scrolling.
- Enhancement reflows the expanded container and all ancestor containers, then
  packs the root graph into non-overlapping rows.
- Grow the logical canvas and root SVG view box from current node bounds. Nodes
  dragged below or to the right of the initial canvas keep their edges and add
  pannable canvas area.
- Hide native canvas scrollbars because background dragging is the primary
  navigation. Keep scrolling internally so pan, wheel zoom, focus, and minimap
  recentering use the same viewport state.
- Show a minimal 148x96 minimap in the lower-right corner. It contains only
  root-node bounds and the current viewport rectangle. Clicking it recenters the
  canvas; it has no labels or secondary controls.
- Size nodes from their complete visible summary and highlighted code instead
  of clipping content to one uniform card height. Code blocks expand their node
  in both axes; they do not introduce an internal scrollbar.
- Dragging any non-interactive part of a node moves that node. Disable text
  selection on graph nodes so a body drag cannot accidentally highlight prose.
  Buttons, inputs, and question editors keep their normal interaction.
- Render questions in one fixed top-level overlay layer. Nested stacking
  contexts cannot place a graph node above that layer.

## Artifact

- `project-decompiler.html` is the interactive PoC. Open it directly in a
  browser. The review core starts expanded to demonstrate containment. Drag or
  pan the canvas, wheel to zoom, focus nodes into synchronized tabs, enhance
  `Review lifecycle` or `Action server`, and use `Ask` to attach a simulated
  session-agent explanation.
