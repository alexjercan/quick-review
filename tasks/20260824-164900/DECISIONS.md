# Decisions

- Use one CI job because the Node and Nix checks are small and the Nix checks complement the full npm dependency-backed suite.
- Run on `master`, pull requests, and manual dispatches.
- Use Node 24 to match `package.json` and install dependencies with `npm ci`.
- Cancel superseded runs for the same workflow and ref.
