# Changelog

All notable changes to Quick Review are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add a Claude Code adapter: a dependency-free stdio MCP server, the
  `/quick-review` command, and a plugin manifest.
- Add `quick_review_wait` so the review page can reach an agent that cannot be
  interrupted. A wait that expires or is cancelled leaves the reviewer's
  question queued.
- Add `--scope head|diff` progressive project graphs with nested enhancement,
  synchronized focus tabs, project-tree routing, exact code nodes, questions,
  comments, minimap navigation, pan, zoom, and draggable graph nodes.
- Add independently versioned graph artifacts, atomic expansion deltas, graph
  state, and graph completion events for Pi and Claude Code.

### Changed

- Make the diff project graph the default `/quick-review` experience and remove
  the linear walkthrough tools from both host adapters.

### Packaging

- Ship the Claude Code plugin in the npm package and the Nix package.

## [0.1.1] - 2026-08-24

### Packaging

- Publish the Pi package as `@alexjercan/quick-review` for installation from npm and discovery in the Pi package gallery.
- Add an automated, provenance-attested npm and GitHub release workflow for version tags.

## [0.1.0] - 2026-08-24

### Added

- Add `/quick-review` for building an agent-written walkthrough of any Git range.
- Add a loopback review page with per-change navigation, exact hunks, file context, comments, questions, approval, and change requests.
- Route page questions and the final review outcome through the Pi session that opened the review.

### Security

- Bind each review to exact base and target revisions and recheck them around every page action.
- Bound artifact, patch, context, message, section, and comment sizes.
- Protect the loopback page with a random path token and invalidate it after a change request.

### Packaging

- Ship Quick Review as a Pi package and as a Nix flake package for Linux and macOS.
- Check locked Node dependencies and Nix packaging in GitHub Actions.

[unreleased]: https://github.com/alexjercan/quick-review/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/alexjercan/quick-review/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alexjercan/quick-review/releases/tag/v0.1.0
