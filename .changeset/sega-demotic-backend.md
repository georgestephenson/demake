---
"@demake/core": minor
"@demake/sms": minor
"@demake/demotic": minor
"demake": minor
---

Compile a Demotic game to a real Sega cartridge. `demake build -c sms` (and
`-c gg`) produces a 32 KiB Master System or Game Gear ROM — Z80 machine code
written for that game, `TMR SEGA` header and checksum, art demade into
sixteen-colour tiles by the image pipeline on the way — and every game in the
example library reproduces the reference interpreter tick for tick, in the same
battery both Game Boys and the NES already run.

Three new pieces make it: a Z80 assembler in `@demake/core/src/asm/`, alongside
the SM83 and 6502 ones and on the same design; the Sega cartridge wrapper
(`sms-cart.ts`), which stamps the header and the checksum in place; and
`@demake/sms`, a self-hosted core — Z80, VDP and SN76489 — for the two jobs
`@demake/dmg` and `@demake/nes` exist for.

Nothing moved out of `codegen/backend.ts` or `codegen/shape.ts` to make room for
the third console, which is the strongest evidence yet that compiling a Demotic
program is an interface rather than a resemblance: the only thing a backend owns
is its instruction set.

`sms-arith.test.ts` proves every 16.16 operation against `fixed.ts` on the real
CPU, and `sms-rom.test.ts` checks the name table against the level grid the
cartridge carries, cell by cell, before and after the camera has travelled.

Sound is named as unsupported rather than dropped: a game that names music still
builds, plays silently, and records what a rule asked for, so a silent build
traces identically to a sounding one. The SN76489 driver is doc 13 §A5's work.
