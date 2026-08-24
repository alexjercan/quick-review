# Concept

Quick Review turns a git range into a walkthrough page that a person can review
change by change, without leaving the Pi session that produced the work.

## What it is

`/quick-review` is a command in a plain Pi session. The session's own agent
builds the walkthrough. There is no spawned generator and no sub-agent: the
agent that knows the change explains the change, and the same agent answers the
reviewer's questions while the page is open.

The page runs on loopback with a random path token. It shows one section per
change with prose, the exact hunk, and a review prompt. The reviewer marks
changes viewed, asks for an explanation, asks a free question, loads
exact-revision file context, reads the full diff, leaves comments, and finishes
with one terminal decision: approve or request changes.

## Why it is shaped this way

- **Any git repository.** Base and target are parameters. There is no
  workspace, branch, or job assumption. `--base` and `--target` accept any
  revision expression git accepts.
- **The session agent does the work.** The walkthrough is one tool call away
  from the conversation that produced the change, so questions have context and
  the outcome lands where the follow-up work happens.
- **Exact revisions, all the way through.** The artifact names the revisions it
  describes, the state file is bound to one artifact by content hash, and every
  page action rechecks that the range still resolves to the same commits.
- **Bounded by construction.** Artifact size, change count, comment size,
  context size, and patch size all have limits that are enforced on both sides.

## Flow

1. `/quick-review [--base <ref>] [--target <ref>]` resolves the range, captures
   the exact patch, and asks the session agent for a walkthrough.
2. The agent calls `quick_review_submit` once. The extension validates the
   artifact against the exact range, writes the artifact bundle, and opens the
   page.
3. The reviewer works through the page. `Explain` and `Ask agent` send a
   question back to the session agent, which answers with
   `quick_review_answer`.
4. `Approve` or `Request changes` writes a versioned completion event, emits it
   on the extension event bus, and tells the session agent the outcome. A change
   request also invalidates the artifact, so a stale walkthrough cannot be
   reused against a moved revision.

## What lives where

| Concern                           | Module                                   |
| --------------------------------- | ---------------------------------------- |
| Versioned types, limits, patterns | `extensions/quick-review/contract.ts`    |
| Artifact parsing and validation   | `extensions/quick-review/walkthrough.ts` |
| Review state and durable storage  | `extensions/quick-review/state.ts`       |
| Bounded git access                | `extensions/quick-review/git.ts`         |
| Page markup, style, and script    | `extensions/quick-review/page.ts`        |
| Loopback server and action rules  | `extensions/quick-review/server.ts`      |
| Range planning and page wiring    | `extensions/quick-review/review.ts`      |
| Pi command, tools, and events     | `extensions/quick-review/index.ts`       |
| Event queue for a host that pulls | `extensions/quick-review/host.ts`        |
| Newline-delimited JSON-RPC        | `extensions/quick-review/jsonrpc.ts`     |
| MCP tools and stdio entry point   | `extensions/quick-review/mcp.ts`         |

Only the adapters know a host. Everything else is plain Node, which is what
makes the tests and the end-to-end proofs cheap to run.

## Two hosts, one review

`ReviewHost` is the whole seam between a review and the agent that owns it: one
call to ask the agent something, one call to hand it the outcome.

Pi pushes. The extension injects a message and triggers a turn, so the page can
interrupt the agent whenever the reviewer acts. Claude Code has no such
primitive, so there the agent pulls: it calls `quick_review_wait`, which blocks
until the reviewer does something. Both adapters open the same review with the
same `openReview`, against the same exact revisions, with the same limits.

Read `docs/claude.md` for what that costs and what it implies.
