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

## Artifact

- `project-decompiler.html` is the interactive PoC. Open it directly in a
  browser. Double-click graph nodes to descend into the review core, page, and
  action-server views.
