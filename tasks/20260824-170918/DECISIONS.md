# Decisions

- Publish under `@alexjercan/quick-review` because the unscoped `quick-review` name is already owned on npm.
- Use npm trusted publishing and GitHub OIDC for later releases. Do not store a long-lived npm token in GitHub.
- Trigger releases from version tags. Keep publication idempotent so the first manually published npm version does not block its GitHub release.
- Release v0.1.1 for the package identity and publication workflow changes.
