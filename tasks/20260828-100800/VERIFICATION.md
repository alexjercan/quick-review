# Verification

- Python standard-library HTML parser - passed.
- Extracted the inline script and ran `node --check` - passed.
- Checked the required mode, graph, inspector, open, and ask interaction hooks -
  passed.
- Rendered the artifact from a local `file://` URL with headless Chromium -
  passed. The executed DOM contained all six initial graph nodes and no
  JavaScript syntax or runtime error was reported.

## Scope

This is a visual and interaction artifact. Graph extraction, persistence,
server actions, exact-revision reads, and host adapters are intentionally
simulated. No production contract or behavior changed.
