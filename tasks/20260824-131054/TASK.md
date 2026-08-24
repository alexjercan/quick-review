# Extract Quick Review into a standalone Pi extension

- STATUS: IN_PROGRESS
- PRIORITY: 60
- TAGS: review, extension, extraction

## Objective

Turn Quick Review into its own repository: a shippable Pi extension any
session can use, with Scufris as one consumer. The current in-repo
pipeline (`extensions/scufris/workflow/walkthrough.ts`,
`walkthrough-reviewer.ts`, `tools/quick-review/`, the
`scufris_job_quick_review` tool) is the proof of concept - same effect,
different shape. Do not port it as-is; redesign against the concept
below and keep only what earned its place.

## Concept

- A `/quick-review` command in a plain Pi session. The session's own
  agent does the work - no spawned generator, no sub-agent: it builds
  the walkthrough itself and opens the local review page.
- Customizable range, not hardcoded: base and target are parameters
  (`/quick-review [--base <ref>] [--target <ref>]`) with sensible
  defaults (merge-base with the default branch; HEAD). No Sprout or
  workspace assumptions; any git repo works.
- The review page keeps the PoC's interaction set: one section per
  change with diff and review prompt; mark viewed and reopen; explain;
  ask a free question; exact-revision context; change requests.
  Questions flow back to the same session's agent.
- Keep the PoC's proven safety properties: exact-revision validation
  of the walkthrough artifact, revision recheck around every action,
  bounded artifact size, loopback page with a random path token,
  invalidation after a change request.

## Scufris integration (after extraction)

- Quick Review gets its own `.scufris.toml` entry. Review becomes a
  pluggable slot: quick-review, Plannotator, and the independent
  reviewer are selectable agents, not built-ins.
- Scufris runs review as a separate review agent - a Pi session with
  this extension - so the foreground never hosts the bridge or the
  state machine again. The foreground keeps only job bookkeeping and
  the completion follow-up.
- Remove the in-repo pipeline from scufris2 once parity is verified.

## Stages

1. Contract and concept doc in the new repository: inputs (repo path,
   base ref, target ref), outputs (versioned walkthrough artifact,
   review page, completion event), compatibility policy.
2. Extension implementation: the `/quick-review` command, in-session
   generation, page server, bridge.
3. Nix packaging, checks, and a release.
4. scufris2 consumes it: `.scufris.toml` entry, review-agent spawn,
   in-repo pipeline removed.
5. nix.dotfiles pin and wiring.

## Completion criteria

- `/quick-review` works in a plain Pi session on an arbitrary git
  repository with chosen base and target refs.
- Page interaction parity with the PoC, including invalidation on
  change requests, verified in live use.
- The artifact and completion-event contract is versioned from day
  one.
- The scufris2 foreground no longer contains the bridge, the state
  machine, or the walkthrough tools; review selection happens through
  `.scufris.toml`.
- Repository checks and Nix checks pass in both repos; released and
  pinned through the normal gate.

## Progress

- 2026-08-24: stage 1 and stage 2 are complete. Stage 3 is complete except the
  release: packaging, the Nix package output, and five flake checks are in
  `flake.nix` and `nix/`, but no tag was created and nothing was published,
  because releasing is outside this request. Contract and concept docs are in
  `docs/`, the extension in `extensions/quick-review/`.
- 2026-08-24: an independent review raised eight findings and two residual
  risks. All are resolved; the resolutions and the two bugs the new Pi harness
  found are recorded in `DECISIONS.md`.
- Stage 4 (scufris2 consumes it, in-repo pipeline removed) and stage 5
  (nix.dotfiles pin) are not started and were out of scope for that request.
- Design decisions, including everything dropped from the proof of concept, are
  in `DECISIONS.md`. Verification, including the live Pi session run and the
  rendered page inspection, is in `VERIFICATION.md` with artifacts under
  `evidence/`.
- Completion criteria met so far: `/quick-review` works on an arbitrary git
  repository with chosen base and target refs; page interaction parity including
  invalidation on change requests is verified in live use; the artifact, state,
  and completion-event contracts are versioned. Repository checks and Nix checks
  pass here. The scufris2 side, the release, and the pin remain.

## Migration and reference

- Moved from `scufris2/tasks/20260824-131054/` into this repository on
  2026-08-24. The original task was introduced in scufris2 commit
  `8a50b593d54b43b2db6f475e29468e1bb896938b`; its pre-migration `TASK.md`
  SHA-256 was
  `2d33cf5bdbb551a82afbea78e44788b2da4294a323f750a003d485667e92cede`.
- The inspiration and behavior/appearance reference is the existing Quick
  Review proof of concept in the scufris2 repository at
  `/home/alex/personal/scufris2`. Start with
  `extensions/scufris/workflow/walkthrough.ts`,
  `extensions/scufris/workflow/walkthrough-reviewer.ts`, and
  `tools/quick-review/`. Use it as a reference, not as an implementation to
  copy unchanged.
