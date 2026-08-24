# Decisions

Stage 1 and stage 2 are implemented in this repository. Stage 3 is implemented
except its release: packaging, the package output, and the flake checks are
done, but no tag was created and nothing was published, because releasing is
outside this request. Stage 4 (scufris2 consumption) and stage 5 (nix.dotfiles
pin) stay out of scope.

## Redesign against the proof of concept

| Proof of concept | This repository | Why |
| --- | --- | --- |
| Spawned `pi --print` generator with `submit_walkthrough` | The session's own agent, driven by `pi.sendMessage(..., triggerTurn)` and `quick_review_submit` | The concept requires in-session generation with no sub-agent |
| Python page server plus a JSON-lines bridge over stdio | In-process `node:http` server in the extension | Removes the bridge, the second process, and the Python runtime dependency |
| Sprout job id, landing branch, clean-worktree gate | `--repo`, `--base`, `--target` on any git repository | The concept requires a customisable range and no workspace assumptions |
| Questions answered by a second spawned model | Questions routed back to the session agent through `quick_review_answer` | Same session, same context, one model |
| Full diff handed to Plannotator | Full diff rendered in the page from the captured patch | Standalone: no external reviewer dependency |
| `approved: boolean` plus unused per-section change requests | `outcome: open \| approved \| changes-requested` and comments only | Kept what earned its place; the terminal decision carries the comments |
| Unversioned artifact and ad hoc completion payload | `version: 1` in the artifact, the state file, and the completion event | The task requires a versioned contract from day one |

## Preserved safety properties

- Exact-revision validation: the submitted artifact must name the planned
  revisions, and the parser rejects anything else.
- Revision recheck around every action, and a second recheck after the agent
  answers a question.
- Bounded sizes: artifact, change count, comment, answer, context, patch,
  request body, and state file all have enforced limits.
- Loopback page behind a random 24-byte path token, with a strict CSP, a `Host`
  header check, and a cross-origin `Origin` refusal.
- Invalidation after a change request: `walkthrough.md`, `state.json`, and
  `patch.diff` are deleted; `completion.json` stays as the record.

## Choices worth recording

- **In-process server over a subprocess.** The extension already runs Node, so
  the page server needs no bridge protocol, no Python, and no second process
  lifetime to manage. `session_shutdown` and the terminal action close it.
- **Pi APIs only in `index.ts`.** Every other module is plain Node, so the whole
  page, state machine, and git layer are testable and packageable without a Pi
  session. The Nix `package` check enforces the boundary.
- **`agent_settled` fallback for answers.** A question resolves when the agent
  calls `quick_review_answer`. If the agent settles without calling it, the
  fallback reads the session branch: it finds that question's own custom-message
  entry, bounds the response segment at the next delivered input, and takes the
  last substantive assistant text inside it. Anchoring on the question entry
  keeps an unrelated turn from answering, and taking the last text keeps a tool
  preamble from being recorded as the answer.
- **Refuse `print` and `json` modes.** Those modes never deliver the triggered
  turn, so the review would hang. The command now fails immediately with a clear
  message. This was found by running the command in `pi --print`.
- **No `pi` flake input.** The flake stays on nixpkgs and flake-parts. The
  consumer (nix.dotfiles, through Scufris) already pins Pi, so adding it here
  would only duplicate a heavy input and slow `nix flake check`. The package
  output is a plain Pi package directory, which is what a consumer pins.
- **Typecheck stays in `npm run check`.** It needs the Pi type declarations from
  npm. The Nix checks cover behaviour, formatting, packaging, and a full
  end-to-end run without a network fetch.
- **State outside the repository.** Review artifacts live under
  `$QUICK_REVIEW_STATE_DIR` or `$XDG_STATE_HOME/quick-review`, mode `0700`, so a
  review never writes into the repository under review.

## Independent review resolutions (job 45b376acf851)

Every finding was actionable and every one is resolved in code.

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | A moved explicit `--base` still validated through merge-base | `ReviewPlan.baseExplicit` records how the base was chosen. An explicit base must keep resolving to the same commit; only a defaulted base may fall back to merge-base. Regression tests cover both. |
| 2 | Terminal actions could commit after the target moved mid-check | `verifyRange` now reads the target, the base, then the target again, so a mid-check move cannot pass as one snapshot. `approve` and `request-changes` recheck immediately before they commit. |
| 3 | The text-answer fallback was not tied to the question | The fallback finds the question's own custom-message entry in the session branch and takes the first assistant text after it. `agent_start` and whole-branch "last text" are gone. A settled turn with no such text now fails the question instead of waiting out the timeout. |
| 4 | A post-write failure could reopen and later overwrite a decision | `completion.json` is created exclusively and is the commit boundary. Before it, failures reopen the review; after it, invalidation and delivery failures are contained, and a second terminal action is refused as already committed. |
| 5 | Print and JSON refusal was silent | The mode check throws, and every command failure rethrows when `ctx.hasUI` is false, so Pi's command error path reports it. Proven live in `pi --print`. |
| 6 | No coverage of the Pi entry point | `tests/pi-harness.ts` plus `tests/extension.test.ts` drive the real extension factory: registration, mode refusal, generation, submit validation, both answer routes, duplicate commands, terminal delivery, and shutdown. It found two real bugs (below). The Nix `tests` check now names the files it cannot run offline and fails if that set drifts. |
| 7 | A second command replaced a pending review | `pending` counts as an open review. A refused duplicate leaves the first plan untouched, and abandoned plans are removed on failure, on close, and on shutdown. |
| 8 | Stage 3 described as complete without a release | Stage 3 is recorded as packaging and checks done, release still gated. This request forbids releasing, so no tag or publish was made. |

Residual risks the review raised are also closed: the `Origin` check now compares
the full origin including scheme, and the outcome message handed to the session
agent is capped at 32 KiB and says so when it truncates.

### Bugs the new harness found

- A refused duplicate `/quick-review` discarded the pending review it collided
  with, because the failure path cleaned up whatever was pending rather than the
  plan that invocation created.
- Closing the server destroyed sockets while an action was still writing its
  response, so a shutdown during a pending question produced a dropped
  connection instead of an error the page could show. Close now drains in-flight
  actions first, bounded by two seconds.

### Fixed from live use

The kickoff prompt said "submit exactly once", which one session read as "never
submit this revision again" after an earlier review of the same commit. It now
says to submit this walkthrough once, whether or not the revision was reviewed
before.

## Correction re-review resolutions (job 45b376acf851, second pass)

| # | Finding | Resolution |
| --- | --- | --- |
| 1 (medium) | The fallback could record a tool preamble instead of the answer | The response segment now runs from the question's own entry to the next delivered input, and the last substantive assistant text inside it is the answer. Two regressions cover a preamble-plus-tool turn and text belonging to a later request. |
| 2 (medium) | Shutdown was time-bounded at the HTTP surface only | `close()` synchronously sets a closing flag, aborts an `AbortController` the actions receive, stops the listener, and only then drains with a bound. Requests during close get 503, and `assertOpen()` fences every mutation and both terminal commits. Git calls take the signal and fail as "the review is closing". |
| 3 (low) | The origin check accepted the other loopback alias | The `Origin` must equal `http://` plus that request's own `Host`. Both cross-alias directions and both matching pairs are tested. |
| 4 (low) | A partial page-open left a plan cleanup refused to remove | `openReview` rolls back its own artifacts if the page fails to start, and pending-plan cleanup is forced, because a plan that never became active is never in use. A decided review is still never removed. |
| 5 (low) | A failed invalidation was reported as success | `invalidate` attempts all three deletions and returns the failures. A failure writes `cleanup-error.txt`, is appended to the reviewer's message, and is stated to the session agent, without reopening the committed decision. |
| 6 (low) | Two decision statements described superseded behaviour | The stage line and the fallback bullet above are corrected. |

The reviewer also asked for a focused aggregate outcome-cap proof:
`tests/prompt.test.ts` builds the largest message the contract allows (40
full-size comments plus a full-size overall comment) and asserts it stays inside
32 KiB, carries the truncation notice, and never truncates mid-character.

## Opening-window re-review resolutions (job 45b376acf851, third pass)

| Finding | Resolution |
| --- | --- |
| Close and shutdown did not fence a review while it was opening | Opening a page is now a tracked session resource. `quick_review_submit` registers an `Opening` that carries an abort signal combining Pi's tool signal with the extension's own controller, passes it through range verification and `openReview`, and refuses to adopt a page whose opening is no longer current: it closes that server, removes the plan, and fails. `/quick-review-close` and `session_shutdown` abort every opening synchronously and wait for them within a two-second bound before closing the active page. `openReview` also checks the signal after writing its files and after the server starts listening, so nothing survives a cancelled open. |
| A failed open left the pending review set, blocking a retry | The submit tool clears its own pending entry on failure, so a fresh `/quick-review` starts immediately and the abandoned directory is gone. |
| A capped outcome message could drop the cleanup warning | The message is built as a head (decision, explanation, cleanup warning or invalidation statement, and the instruction) plus a comment list. Only the list can be truncated, so the parts the agent must act on always survive. |
| `planReview` could leave a directory when it failed after `mkdir` | All fallible lookups now run before the directory exists, and the remaining work runs inside `withPlanDirectory`, which removes the directory if setup throws. |

### Bug the live proof found

Registering openings introduced a regression that the harness did not catch:
completed openings stayed in the set, so a later `/quick-review-close` treated an
adopted review as an abandoned plan and deleted its artifact directory. The
first live run showed the record disappearing. Openings are now deregistered as
soon as they finish, cleanup skips any plan that became the active review, and
`tests/extension.test.ts` asserts that closing an opened review keeps
`walkthrough.md`, `state.json`, and `patch.diff`.

## Allocation re-review resolution (job 45b376acf851, fourth pass)

| Finding | Resolution |
| --- | --- |
| A review-directory name collision could delete or reuse an existing review | Allocation is now exclusive and ownership-bounded. The state root is created separately, each review directory is created with `recursive: false` so an existing name raises `EEXIST` instead of being adopted, a taken name is retried with a fresh random suffix, and the rollback removes only the directory that attempt proved it created. The random suffix is eight bytes instead of four. |

`withPlanDirectory` is replaced by `withReviewDirectory(root, name, work)`, which
owns the whole claim-and-rollback cycle. Every other path that removes something
was rechecked against the same invariant: `discardPlan` still refuses any
directory holding `completion.json` and only ever sees a directory this session
claimed, `closeOpenings` skips the plan that became the active review,
`invalidate` deletes three named files, and the completion file is still created
exclusively.

Four regressions cover it: a collision with an open review and a decided
`changes-requested` review whose `patch.diff` is already gone, a failure after a
collision, exhaustion of the retry budget, and planning around a decided
directory. Each asserts the existing reviews stay byte-for-byte identical while
the new plan gets a directory of its own.
