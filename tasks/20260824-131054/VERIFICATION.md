# Verification

Recorded against the final tree of this branch, after the independent review
findings were resolved.

## Repository checks

```
npm run check        # tsc --noEmit, 101 node tests, prettier --check
nix flake check      # tests, format, nix-format, package, end-to-end
```

Both passed. Test counts by file: 21 review, 20 extension, 13 walkthrough, 10
page, 9 state, 8 git, 8 server, 7 prompt, 5 options.

`nix flake check` builds five checks:

| Check | What it proves |
| --- | --- |
| `tests` | the offline test suite runs on nixpkgs `nodejs_24` and `git` |
| `format` | the tree matches the pinned Prettier (3.8.3 in npm and nixpkgs) |
| `nix-format` | `flake.nix` and `nix/checks.nix` match alejandra |
| `package` | the package output is a valid Pi package: manifest keyword, `pi.extensions` entry present, no `node_modules`, no `tests`, no reference to scufris or sprout, Pi imports only in `index.ts`, and every other module loads on plain Node |
| `end-to-end` | a real repository, a real page, real HTTP actions, a real approval |

### What the Nix test check cannot run, and why that is safe

`tests/extension.test.ts` loads the Pi entry point, which imports
`@earendil-works/pi-coding-agent` and `typebox` at runtime. The Nix check has no
npm dependency tree, so it cannot run that file. Rather than skip silently, the
check derives the Pi-dependent set from the tree (every test importing
`quick-review/index.ts`), compares it against a declared list, fails if they
differ, and prints both the skipped and the running files. That file does run in
`npm run check`, which is this project's declared TypeScript check, and the same
paths are exercised live below.

Building npm dependencies inside Nix was attempted and rejected:
`importNpmLock` and `fetchNpmDeps` both fail on this lock because
`@earendil-works/pi-coding-agent` ships a shrinkwrap whose six sub-packages have
no `integrity` field.

## Rendered output inspected, not just exit status

`nix build .#checks.x86_64-linux.end-to-end` writes `review.html`,
`walkthrough.md`, `state.json`, and `completion.json`. The HTML was read
directly: masthead facts with both revisions and `walkthrough v1`, the change
index, the diff with `diff-add` and `diff-del` classes, the review prompt, the
recorded answer, the comment thread, the closed-review banner, and the disabled
approval control. Copies of the rendered pages are in `evidence/`.

## Live proof at final HEAD

A fresh repository (`main` base, `retries` target) and an interactive Pi session
loading `extensions/quick-review/index.ts`.

1. **Print mode refuses visibly.** `pi --print "/quick-review --no-open"` wrote
   `Extension error (command:quick-review): Quick Review: print mode cannot host
   a review page; run /quick-review from an interactive or RPC session` to
   stderr and created no plan directory.
   Evidence: `evidence/final-print-mode-refusal.txt`.
2. **Duplicate command while pending.** Two `/quick-review` commands three
   seconds apart: the second was refused with `a Quick Review is already open`,
   and exactly one plan directory existed afterwards. Before the fix this path
   deleted the first plan.
3. **Generation and page.** The session agent submitted a valid walkthrough and
   the page served at `http://127.0.0.1:39395/<token>/`.
4. **Origin refusal.** A POST with `Origin: https://127.0.0.1:<port>` returned
   403; the same request with `http://` returned 200. This is the full-origin
   comparison the review asked for.
5. **Question routed to the session agent.** A free question about the dropped
   queue item was answered by that same session through `quick_review_answer`.
6. **Approval.** Marked viewed, commented, approved with an overall comment;
   `completion.json` version 1 recorded one comment and one question, and the
   agent received the outcome and correctly landed nothing.
   Evidence: `evidence/final-completion-approved.json`,
   `evidence/final-walkthrough.md`.
7. **Cleanup of an abandoned review.** A second command left a pending plan the
   agent declined to fill; `/quick-review-close` removed that plan directory and
   left the completed review untouched.
8. **Explicit base and change request.** `/quick-review --base 39425dc` produced
   a two-change walkthrough over the explicit range; `request-changes` deleted
   `walkthrough.md`, `state.json`, and `patch.diff`, kept `completion.json`, and
   told the agent the walkthrough was invalidated.
   Evidence: `evidence/final-completion-changes-requested.json`,
   `evidence/final-review-page.html`.

## Live lifecycle proof after the correction re-review

A second fresh repository (`main` base, `expiry` target) at the final tree.

1. **Exact-origin rule.** All five combinations checked over HTTP against the
   live page: each loopback alias with its own origin is accepted (200), each
   alias with the other alias's origin is refused (403), and an `https` origin
   is refused (403). `evidence/lifecycle-origin-matrix.txt`.
2. **Close fences work in flight.** An `explain` action was left waiting on the
   session agent, then `/quick-review-close` ran. The action returned a clean
   `the review page was closed` error rather than a dropped connection, the page
   stopped listening, and the agent's later answer attempt was told the question
   was no longer open. `evidence/lifecycle-close-fencing.txt`.
3. **A full approval still works at final HEAD.** A second review was opened,
   viewed, and approved; the version 1 completion event recorded the range and
   the overall comment, and the agent landed nothing.
   `evidence/lifecycle-completion-approved.json`,
   `evidence/lifecycle-review-page.html`.

## Allocation ownership proof

`evidence/allocation-ownership.txt` records a byte-level run against a state
root that already holds one open review and one decided `changes-requested`
review. A new plan is forced to collide with both names: it skips them and
creates its own. A failing plan is then forced to collide with the decided one:
its rollback removes only the directory it created. Every file of both existing
reviews has the same SHA-256 before and after.

## Live opening-window proof

A third repository (`main` base, `safe-parse` target) at the final tree.

1. `/quick-review` opened a page and wrote the review bundle.
2. `/quick-review-close` closed the page (connection refused afterwards) and
   **kept** `walkthrough.md`, `state.json`, and `patch.diff`. The first attempt
   at this run deleted them, which is how the opening-registry regression was
   found and fixed; see `DECISIONS.md`.
3. A fresh `/quick-review` started in the same session, opened a new page, and
   was approved. Both directories survive and only the approved one carries
   `completion.json`. `evidence/opening-lifecycle.txt`,
   `evidence/opening-completion-approved.json`,
   `evidence/opening-review-page.html`.

The earlier live runs are kept as `evidence/live-*` (before the first review
pass), `evidence/final-*` (after it), and `evidence/lifecycle-*` (after the
second pass) for comparison.

## Test coverage

Nine files, 101 tests:

- `extension.test.ts` — the Pi entry point through a controlled Pi harness:
  registration, print and json refusal, kickoff message and tool activation,
  duplicate command with one plan preserved, close removing a pending plan,
  submit opening the page, revision and section-count refusal, the
  `quick_review_answer` route, the causal text fallback (including text written
  before the question, which must not count), a tool preamble losing to the
  final answer, text belonging to a later request being ignored, a settled turn
  with no answer, approval reaching the event bus and the agent, shutdown
  closing the page and failing pending questions, the review directory
  contents, closing an opened review keeping its record while the page goes
  away, and four opening-window races: close during startup, shutdown during
  startup, an aborted tool signal, and a failed startup followed by a
  successful retry.
- `server.test.ts` — pre-terminal revision recheck for both terminal actions,
  the non-reversible commit boundary, a pre-commit failure reopening the review,
  exact-origin refusal across both loopback aliases and a scheme mismatch, and
  three shutdown properties: acceptance stops synchronously, a fenced action
  cannot mutate, and a terminal action cannot commit once closing has begun.
- `prompt.test.ts` — the outcome message: comments carried verbatim, a failed
  cleanup stated instead of a false invalidation claim, the largest message the
  contract allows capped at 32 KiB with its truncation notice, a cleanup warning
  surviving that maximum-size message, an approval keeping its instruction after
  truncation, and multi-byte truncation on a character boundary.
- `review.test.ts` — planning, token path isolation, host refusal, the full
  action set, approval, change-request invalidation, revision-change refusal,
  malformed requests, explicit-base invalidation when the ref moves, defaulted
  base keeping merge-base semantics, exclusive completion, plan discard, a
  reported invalidation failure that still attempts every deletion, a partial
  page-open leaving nothing that blocks a retry, a decided review surviving
  forced cleanup, an aborted open leaving nothing behind, planning failures
  before and after the directory exists leaving the state root empty, and
  directory allocation: a name collision with an open review and with a decided
  review whose patch is already gone, a failure after a collision, exhaustion of
  the retry budget, and planning beside a decided review. Every collision case
  asserts the existing reviews stay byte-for-byte identical.
- `walkthrough.test.ts`, `state.test.ts`, `page.test.ts`, `git.test.ts`,
  `options.test.ts` — artifact parsing and limits, state transitions and byte
  bounds, page rendering and escaping, bounded git access, argument parsing.

## Known gaps

- The typecheck and `tests/extension.test.ts` run in `npm run check` only, for
  the dependency reason above.
- `nix flake check` was run for `x86_64-linux` only. The other three declared
  systems are not built here.
- The text-answer fallback, including the tool-preamble case, is proven by the
  harness, not by a live model: there is no reliable way to make a real session
  answer in prose instead of calling the tool.
- Shutdown cancellation is proven at the action boundary, at the opening
  boundary, and, live, at the page boundary. A git child process that ignores
  its abort signal would still run to its own timeout; the fences guarantee its
  result cannot mutate the review or be adopted as a page.
- The post-`mkdir` planning rollback and the collision retry are proven through
  `withReviewDirectory`, the helper `planReview` uses, by supplying the names it
  tries. Forcing a real random collision through `planReview` is not practical,
  so the integration test asserts the weaker property that a new plan never
  disturbs an existing review.
- Browser launch is best effort and untested automatically; every run used
  `--no-open` or `QUICK_REVIEW_NO_OPEN`.
- Stage 3's release is deliberately not done. Packaging and checks are complete,
  the release remains gated, and this request forbids releasing.
