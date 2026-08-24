# Verification

- `npm run check` - passed: strict TypeScript, 101 tests, and Prettier.
- `nix flake check -L` - passed: tests, formatting, package structure, and end-to-end review page checks.
- `git diff --check` - passed.
- `actionlint` was not installed; Prettier parsed and checked the workflow YAML through `npm run check`.
