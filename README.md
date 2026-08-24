# Quick Review

Quick Review is a Pi extension. `/quick-review` turns a git range into a
walkthrough page that the session's own agent writes and answers questions
about, and returns one versioned approval or change request.

## Quickstart

```bash
pi -e ./extensions/quick-review/index.ts
```

Then in the session:

```
/quick-review
/quick-review --base origin/main --target HEAD
/quick-review --repo /path/to/repo --no-open
/quick-review --help
```

Install it from npm or a local checkout:

```bash
pi install npm:@alexjercan/quick-review
pi install /path/to/quick-review
```

With Nix:

```bash
nix build .#quick-review   # result/share/quick-review is a pi package
nix flake check
nix develop
```

Read `docs/concept.md` for the design and `docs/contract.md` for the versioned
artifact, page, and completion-event contract.
