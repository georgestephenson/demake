# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

Every user-visible change adds a changeset describing it and the semver bump it
warrants (doc 09 §Stability, doc 11 §release.yml):

```sh
pnpm changeset
```

Semver policy for this project:

- **patch** — no change to output bytes or the public API.
- **minor** — may change output bytes (re-baseline goldens in the same PR) or add
  API surface.
- **major** — a breaking CLI/API change.

Merging the bot's "Version Packages" PR tags the release and drives publishing.
