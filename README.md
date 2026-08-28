# Quick Review

`/quick-review` opens an exact-revision review written and answered by the
session's own agent. Use the progressive project decompiler for a committed
HEAD snapshot or diff overlay. The version 1 linear walkthrough remains
available during the compatibility release. It runs in Pi and Claude Code.

## Pi

```bash
pi install npm:@alexjercan/quick-review   # or: pi install /path/to/quick-review
```

Then in the session:

```
/quick-review --scope head
/quick-review --scope diff --base origin/main --target HEAD
/quick-review                         # legacy linear walkthrough
/quick-review --base origin/main --target HEAD
/quick-review --repo /path/to/repo --no-open
/quick-review --help
```

## Claude Code

```
/plugin marketplace add alexjercan/quick-review
/plugin install quick-review@alexjercan
```

Then `/quick-review` with the same flags. Read `docs/claude.md` for how the
review page reaches the agent there.

## Nix

```bash
nix build .#quick-review   # result/share/quick-review is a pi package
nix flake check
nix develop
```

Read `docs/concept.md` for the design and `docs/contract.md` for the versioned
artifact, page, and completion-event contract.
