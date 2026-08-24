# Verification

- `npm run format:check` - passed.
- `git diff --check` - passed.
- Reviewed the release flow against `package.json`, `package-lock.json`, the Pi package manifest, and the Nix flake outputs.
- Parsed `.scufris.toml` with Python `tomllib` and asserted the standalone-extension preference.
- Resolved every `.claude/skills/` link to its canonical `.agents/skills/*/SKILL.md` file.
- Checked every skill for required `name` and `description` frontmatter.
- Confirmed the `pi-extension`, `tatr`, and user-invoked-only `pair` skills remain, with no release skill or broken Claude links.
- Confirmed `CLAUDE.md` delegates to the shortened project `AGENTS.md`.
