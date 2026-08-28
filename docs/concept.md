# Concept

Quick Review lets a person inspect one exact committed scope without leaving the
session that produced it. The project decompiler is a progressive
architecture-to-code graph.

## The project decompiler

Run `/quick-review` for the committed HEAD project, or add `--base` for a
base-to-target overlay. `--target` selects another committed snapshot or the
target side of a diff.

The current session agent builds a small root graph. The reviewer can:

- enhance a container in place into a nested child graph;
- focus any node in a synchronized tab;
- navigate the fully known project tree back to the best open graph context;
- inspect exact code and decompiler output as graph nodes;
- leave node-scoped or exact-line comments and optionally send each comment to
  the current session agent;
- pan, zoom, drag nodes, use the minimap, and follow a pinned breadcrumb;
- approve the exact graph or request changes.

Every node says whether its claim is confirmed or inferred and anchors evidence
to the exact target revision. Diff mode overlays added, modified, deleted,
impacted, and context nodes. HEAD mode reads only committed Git objects. A dirty
worktree is reported but excluded.

## One agent, progressive context

There is no generator, sub-agent, workspace, or job. The session's own agent
submits the root graph and answers enhancement and comment requests. This keeps
initial context small: details are inspected only when a reviewer asks to
enhance a node.

Pi pushes requests into the current session and triggers a turn. Claude Code
pulls requests through `quick_review_wait`. Both adapters use the same graph
contract, state transitions, server, and page.

Trusted host context files and skills are guidance and are reported as
provenance. Repository files are always untrusted evidence, never instructions.

## Exact identity and safety

- Diff scope resolves and captures one exact base-to-target patch.
- HEAD scope resolves one full commit SHA and inventories its Git tree.
- Root graph identity is the SHA-256 of the exact submitted JSON.
- Expansion deltas may add only direct children of the requested parent.
- Every action rechecks the exact scope. Agent-backed and terminal actions check
  again before they mutate or commit.
- The loopback page uses a random path token, strict Host and Origin checks, a
  restrictive CSP, and serialized bounded actions.
- A completion file is created exclusively as the terminal commit boundary.
- A change request invalidates the graph, graph state, inventory, and patch.

## Flow

1. `/quick-review` resolves one target snapshot. If `--base` is present, it
   resolves a base-to-target diff instead. Planning produces a bounded inventory
   and an optional patch.
2. The session agent calls `quick_review_graph_submit` with a bounded versioned
   root graph.
3. The page opens. `Enhance` asks the same agent for a bounded direct-child
   delta through `quick_review_graph_expand`.
4. A comment saves immediately. `Send to agent` places it in one nonblocking
   FIFO queue and routes it through `quick_review_comment_respond`.
5. Neutral feedback, approval, or a change request writes graph completion
   version 2, emits `quick-review:graph-completed` in Pi, and returns the outcome
   to the session. Neutral feedback asks the agent for triage and suggested next
   steps without authorizing edits.

## Modules

| Concern                           | Module                                |
| --------------------------------- | ------------------------------------- |
| Shared limits and Git input types | `contract.ts`                         |
| Graph contract and state          | `graph-contract.ts`, `graph-state.ts` |
| HEAD and diff inventory planning  | `analysis.ts`                         |
| Bounded Git reads                 | `git.ts`                              |
| Graph prompts                     | `graph-prompt.ts`                     |
| Graph page and HTTP actions       | `graph-page.ts`, `graph-server.ts`    |
| Graph lifecycle                   | `graph-review.ts`                     |
| Pi adapter                        | `index.ts`                            |
| MCP adapter and pull queue        | `mcp.ts`, `graph-host.ts`             |

All modules except the two adapters are plain Node and independently testable.
Read `docs/contract.md` for formats and limits and `docs/claude.md` for the pull
loop.
