# Verification

- Python standard-library HTML parser - passed.
- Extracted the inline script and ran `node --check` - passed.
- Checked the required mode, graph, inspector, open, and ask interaction hooks -
  passed.
- Rendered the artifact from a local `file://` URL with headless Chromium -
  passed. The executed DOM contained 12 initially rendered nodes, including the
  six children of the expanded review-core container, and no JavaScript syntax
  or runtime error was reported.
- Captured a 1600x1000 headless Chromium screenshot and inspected the rendered
  Gruber-style canvas, expanded containment, graph edges, code highlighting,
  project tree, and first-class decompiler node.
- Checked required hooks for nested canvases, pointer dragging, background
  panning, wheel zoom, focused tabs, full-screen mode, decompiler and code-level
  views, node questions, and the PR overlay - passed.
- Drove the rendered page through Chromium's DevTools Protocol - passed. The
  check proved that the initial root layout has no overlapping nodes, `Focus`
  opens a synchronized Review core tab containing its child nodes without the
  outer Review core wrapper, a focused Pi extension leaf shows only that leaf,
  `Ask` renders a fixed overlay above the graph, wheel input increases zoom, and
  dragging the background changes both viewport scroll axes.
- Captured and inspected the focused Review core tab at 1600x1000. Its Git,
  lifecycle, server, state, protocol, and recovered-architecture nodes are the
  root graph of the tab. The redundant in-grid contents label is absent.
- Added a focused-view regression through Chromium's DevTools Protocol. It
  compares an SVG edge endpoint in screen coordinates to its source-node center
  and passed within two pixels. The focused canvas now keeps the same logical
  dimensions as its SVG view box.
- Enhanced Git snapshot through both detail levels and checked DOM scroll size
  against allocated node size - passed. A second maximum-detail sweep expanded
  every container and checked all 25 nodes - passed with no node, body, or code
  overflow in either axis. Code blocks have no internal size cap.
- Drove a pointer drag from the prose area of Pi extension through Chromium's
  DevTools Protocol. Both model coordinates increased and the browser selection
  remained empty - passed.
- Moved a root node below y=2300 and a focused child below y=2600, then checked
  canvas height, viewport scroll height, SVG view-box height, and edge bounds -
  passed. Root and focused canvases grow past the initial 1500-pixel height.
- Focused collapsed Review lifecycle - passed: the tab showed only the lifecycle
  node. Enhanced it in that tab - passed: the same tab switched to its four
  child nodes and updated its label to `Review lifecycle / contents`.
- Chromium minimap regression - passed. It verifies the 148x96 bound, six root
  markers, viewport tracking after pan, click-to-recenter, dynamic view-box
  growth after a deep node move, and hidden scrollbars for both WebKit and
  Firefox CSS properties.
- Captured and inspected the 1600x1000 canvas with the lower-right minimap and
  no native viewport scrollbars.
- Chromium tree-routing regression - passed with all 26 project and node rows.
  Git snapshot stayed in the active Review core tab, Pi extension returned to
  Project canvas, and planReview selected the nearer existing Review lifecycle
  tab, expanded it, and became visible. Active `[T]` and `[C]` markers matched
  each destination.
- Captured and inspected the fully indexed project tree. Collapsed descendants
  remain available but visually dim until navigation reveals them.
- Chromium breadcrumb regression - passed. It verifies the initial
  `quick-review / Review core` context, a four-level path to planReview, and the
  current crumb. Integration proofs snapped to 22 pixels from the viewport left
  and 18 pixels from its top. The breadcrumb's screen position stayed fixed
  after another 600 pixels of canvas scrolling.
- Captured and inspected the 1600x1000 workspace with the pinned breadcrumb in
  the existing header and no duplicate graph label.

## Scope

This is a visual and interaction artifact. Graph extraction, persistence,
server actions, exact-revision reads, and host adapters are intentionally
simulated. No production contract or behavior changed.
