---
---

The Demotic language surface now lives in one registry
(`packages/demotic/src/lang/spec.ts`), the way the CLI's lives in `cli-spec`. The
lexer's unit and builtin tables, the compiler's property tables, the checked-in
markdown reference and the web app's new reference section are all derived from
it or tested against it.

Adds `pnpm gen:demotic-docs`, a `demotic reference` section on the site, and
tests that fail if the registry, the engine and the generated docs disagree —
including one that compiles every example in the reference.
