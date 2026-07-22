---
"@demake/core": minor
"demake": minor
---

Phase 0 foundations: pnpm-workspace monorepo, strict TypeScript project
references, ESLint (with custom platform-purity and determinism rules) +
Prettier, Vitest, and a CI skeleton. Ships a hello-world `@demake/core` surface
imported by a stub `demake` CLI that honors `--help`, `--version`, and the
documented exit codes.
