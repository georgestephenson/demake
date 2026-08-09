---
"@demake/demotic": patch
---

Memoise the NES art conversion, which was the one art module of eight that did
not.

`nes-art.ts` demakes a picture and a sprite bank on every call, where
`art.ts`, `sms-art.ts`, `snes-art.ts`, `md-art.ts`, `pce-art.ts`, `wsc-art.ts`,
`ngpc-art.ts` and `gba-art.ts` all remember theirs. The conversion is a pure
function of (bytes, budget, overrides) — the budget belongs in the key because
what a picture may spend is what the ones before it left — so remembering its
answer cannot change one, which is the same argument the other seven already
make and the reason no cartridge's bytes move.

This console is the one that wanted it most: a screenful here is 960 cells
against a Game Boy's 360, fitted to a fixed master palette, and its pictures are
converted one at a time rather than concurrently, so a build that demakes two of
them is two whole tournaments back to back. What that cost was visible in the
test suite, where one file builds a fixture several times over:
`nes-rom.test.ts` goes from 150 s to 52 s. The web app's per-keystroke rebuild
gets the same saving for the same reason.

The oracle that compares a cartridge's cells against `demake prep -c nes` calls
`prep` directly, one layer below the memo, so it still compares a demake against
a demake rather than a cache hit against itself.
