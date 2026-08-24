# Release checklist

Release from `master`. Use semantic versions and annotated tags in the form
`vX.Y.Z`. Git tags are the stable references used by Pi and Nix consumers.

## Choose the version

- [ ] Confirm the intended work is complete and `master` is clean.
- [ ] Review every change since the previous tag.
- [ ] Choose the next version:
  - Patch for compatible fixes and documentation corrections.
  - Minor for compatible features.
  - Major for incompatible command, package, or versioned-contract changes.
- [ ] Before `1.0.0`, an incompatible change may use a minor release, but must be marked `**Breaking:**` in `CHANGELOG.md`.
- [ ] If a contract format, field, or limit changed, update the contract version in `extensions/quick-review/contract.ts` and update `docs/contract.md`.

## Prepare the release

- [ ] Move the relevant `Unreleased` entries in `CHANGELOG.md` under `[X.Y.Z] - YYYY-MM-DD`.
- [ ] Add a new empty `Unreleased` section above the release.
- [ ] For the first release, add these comparison links at the end of `CHANGELOG.md`:

  ```markdown
  [unreleased]: https://github.com/alexjercan/quick-review/compare/vX.Y.Z...HEAD
  [X.Y.Z]: https://github.com/alexjercan/quick-review/releases/tag/vX.Y.Z
  ```

- [ ] For later releases, update `unreleased` and add a comparison from the previous tag:

  ```markdown
  [X.Y.Z]: https://github.com/alexjercan/quick-review/compare/vPREVIOUS...vX.Y.Z
  ```

- [ ] Update both package manifests without creating a commit or tag:

  ```bash
  npm version X.Y.Z --no-git-tag-version
  ```

- [ ] Confirm `package.json` and `package-lock.json` contain the same version.

## Verify

- [ ] Run the TypeScript and behavior checks:

  ```bash
  npm run check
  ```

- [ ] Run the packaging and offline checks:

  ```bash
  nix flake check
  ```

- [ ] Inspect the final diff and confirm it contains only release changes.

## Tag and publish

- [ ] Commit the version, changelog, and final documentation:

  ```bash
  git add package.json package-lock.json CHANGELOG.md RELEASE.md docs
  git commit -m "Release vX.Y.Z"
  ```

- [ ] Create an annotated tag on that commit:

  ```bash
  git tag -a vX.Y.Z -m "Quick Review vX.Y.Z"
  ```

- [ ] Push `master` and the tag:

  ```bash
  git push origin master
  git push origin vX.Y.Z
  ```

- [ ] Create a GitHub release from the tag. Copy the matching changelog section into its release notes.

## Verify the published tag

- [ ] Test the tagged Pi package:

  ```bash
  pi -e git:github.com/alexjercan/quick-review@vX.Y.Z
  ```

- [ ] Build the tagged Nix package:

  ```bash
  nix build github:alexjercan/quick-review/vX.Y.Z#quick-review
  ```

- [ ] Update downstream pinned references, such as the `quick-review` input in `nix.dotfiles`, only after both checks pass.
