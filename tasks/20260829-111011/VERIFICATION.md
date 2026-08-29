# Verification

Release preparation for `v0.2.0` on 2026-08-29.

- `npm run check`: passed. TypeScript passed, 114 tests passed, and Prettier passed.
- `nix flake check`: passed all five checks on `x86_64-linux`.
- `git diff --check`: passed.
- Confirmed `package.json`, `package-lock.json`, its root package entry, and `.claude-plugin/plugin.json` all use `0.2.0`.
- Reviewed all commits and the diff from `v0.1.1` through `HEAD`.
