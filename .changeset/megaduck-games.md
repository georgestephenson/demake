---
"@demake/core": minor
"demake": minor
---

Games for the Mega Duck, and a generated console-support matrix.

`demake build -c megaduck` produces a real Mega Duck (Cougar Boy) cartridge. The
console is a Game Boy clone whose I/O pins were rewired, so it added a machine
description and not a backend: a register page (`core/src/asm/megaduck.ts`), a
permuted `LCDC`, an entry point at `$0000` and no cartridge header — the console
has no boot ROM to check one. Every game in the example library reproduces the
reference interpreter tick for tick there, in the same battery both Game Boys and
the NES run, and its audio is the same `@demake/chip` APU reached through a
different address, proven by the same register-write diff. `@demake/dmg` plays it,
in the grey ramp the console spec calls the hardware's, and so does the web app.

`docs/console-support.md` is new and generated: what each of the 21 consoles
supports across art, data, ROM, games and audio, derived from the registries that
decide it rather than restated in prose. Run `pnpm gen:console-docs`; a staleness
test fails CI if it drifts. Generating it corrected a claim that had already
gone stale — eight console specs declared a `rom` output format with no builder
behind it, so `gen --format rom` reported a missing toolchain where the truth was
that the family cannot be assembled at all.

`@demake/dmg` now depends on `@demake/core` for the shared Mega Duck I/O map, and
`packages/cli/src/rom/registry.ts` replaces the `--format rom` if/else chain with
one table the dispatch and the support matrix both read.
