---
"@demake/audio": minor
"@demake/md": minor
"demake": minor
---

Release the Mega Drive's sound hardware from reset, which every cartridge this
tool built had left held.

`$A11200` is the Z80's reset line **and the YM2612's** — one wire, both chips —
so a 68000 program that leaves it asserted gets six four-operator voices that
discard everything sent to them. Every Mega Drive cartridge demake produced did
exactly that: a game never wrote the register at all, and the standalone audio
cartridge wrote it with the reset held on purpose, to stop a sound processor
nobody had programmed from running.

**The register stream was perfect throughout, and that is the point.**
`@demake/md` models no Z80 — a demade cartridge emits no program for one — so
`$A11200` was a store to nothing and the FM voices went on answering. Doc 16's
Level A diffed the writes the chip received against the schedule and matched them
tick for tick on a chip that, on the board, was not listening. This is the
failure AGENTS.md §Gotchas names as a description that is wrong and consistent,
reached through the one peripheral that core deliberately does not have.

Doc 16's **Level B** is what found it, against genesis-plus-gx:

|                                       | RMS     |
| ------------------------------------- | ------- |
| a standalone track, reset held        | 0.00046 |
| a standalone track, reset released    | 0.28203 |
| a demade game's music, reset held     | 0.00749 |
| a demade game's music, reset released | 0.17821 |

Three things changed. `md-chips.ts` gained `emitZ80Handover` — take the sound
processor's bus and keep it, then release the reset, which is safe in that order
because a Z80 whose bus the 68000 holds never fetches an instruction. `rom/md.ts`
and `rom/md-game.ts` both call it, so a game emits it exactly when it emits an
audio driver at all and a game with no audio still emits neither store. And
`@demake/md` now **models the reset line**: the FM chip powers up held and
discards writes until `$A11200` bit 8 is set, so a cartridge that forgets it
fails in `pnpm test` rather than only on the hardware.

**Output bytes**: every `demake build -c md` cartridge with audio, and every
`demake gen -c md --format rom` cartridge, grows the two stores.
