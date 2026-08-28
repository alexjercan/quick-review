# Quick Review

`/quick-review` opens a progressive exact-revision project graph written and
answered by the session's own agent. It analyzes a diff by default or a
committed HEAD snapshot on request. It runs in Pi and Claude Code.

## Pi

```bash
pi install npm:@alexjercan/quick-review   # or: pi install /path/to/quick-review
```

Then in the session:

```
/quick-review                                      # diff graph
/quick-review --base origin/main --target HEAD     # explicit diff graph
/quick-review --scope head                         # committed snapshot
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
