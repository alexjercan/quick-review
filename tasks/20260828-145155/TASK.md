# Implement the progressive project decompiler

- STATUS: OPEN
- PRIORITY: 0
- TAGS: architecture, extension, graph, quick-review

Replace the flat walkthrough experience with a progressive, exact-revision
project graph derived by the current session agent. Support a committed `HEAD`
snapshot and a base-to-target diff overlay. Keep initial context small, then let
the reviewer enhance nodes, inspect code, ask node-scoped questions, and focus
subgraphs without leaving one analysis canvas.

The accepted interaction prototype and its evidence are in
`tasks/20260828-100800/`. This task starts from that behavior but must preserve
Quick Review's host-neutral core, bounds, loopback security, exact-revision
checks, and current-session ownership.

