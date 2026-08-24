# Decisions

- Use Keep a Changelog headings and Semantic Versioning.
- Use annotated `vX.Y.Z` tags from `master` as stable Pi and Nix references.
- Keep package and lockfile versions synchronized with `npm version --no-git-tag-version`.
- Require contract documentation and contract-version updates when a format, field, or limit changes.
- Verify both the Pi git-package path and the Nix flake package after publishing a tag.
- Repeat work and the out-of-context `/review` until it approves, then use `/quick-review` once as the final user approval gate.
- Keep the repository-specific `pi-extension` skill, the Tatr workflow skill, and the explicitly invoked Pair mode under `.agents/skills/`. A release skill would only duplicate `RELEASE.md`.
- Expose project skills to Claude through relative links instead of duplicating content.
- Keep `AGENTS.md` short and specific to Quick Review. Make `CLAUDE.md` include it as the single instruction source.
