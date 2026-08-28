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

## Artifact

- `project-decompiler.html` is the interactive PoC. Open it directly in a
  browser. The review core starts expanded to demonstrate containment. Drag any
  node, enhance `Review lifecycle` or `Action server` for a second nested graph,
  and use `Ask` to attach a simulated session-agent explanation.
