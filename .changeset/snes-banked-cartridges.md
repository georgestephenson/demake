---
"@demake/core": minor
"@demake/demotic": minor
---

Bank a Super Nintendo cartridge's code, so `quest` builds and plays there.

`quest.dmt` — three levels, a boss, a secret room — compiles to eighty kilobytes
of 65816 against a 32 KiB LoROM bank, and it is the first example in the library
that no mapper-less cartridge can hold. It now builds on this console, on a
128 KiB board, and `rom.test.ts` runs it against the reference interpreter tick
for tick.

**A bank per scene.** A scene's four routines are the only things anything
outside them reaches, and they are reached exactly four ways — the tick, reset,
camera and render dispatches. They are packed into banks first fit, bank zero
first so a game that only just outgrew it keeps most of its scenes where they
were, and a scene that does not fit a whole bank is refused by name.

**No controller: `SNES_ROM_SIZES` is every power of two up to four megabytes**
and the build takes the smallest board that holds the banks it opened. LoROM past
the first bank is address decoding, so `@demake/snes` needed no change at all.
The sound processor's image is elastic too — two banks now rather than one, which
is as far as the upload's `long,X` reaches.

**Reaching a banked routine costs one instruction each way**: `jsl` and `rtl`
instead of `jsr` and `rts`. The switch is all-or-nothing, because which of the
two returns a routine ends with has to match how every caller reaches it — so a
game that fits one bank is assembled exactly as it always was and **every
existing Super Nintendo cartridge is byte-identical**.

Three things made it cheap and each is worth knowing before touching it. All the
data stays in bank zero, so with the data bank register at zero a scene in bank
four reads its own level with the same absolute instruction it used before, and
not one data access changed. `Asm65816.section` moves no bytes — it changes what
an address means, so a label carries its bank for `jsl` and still means its low
sixteen bits everywhere else. And the extra banks are emitted _first_, bank zero
last, because helpers are pulled by whatever code calls them and `ctx.finish()`
has to run after all of it.

`RomStats.free` on this console is now measured against the largest LoROM
cartridge rather than against bank zero, which is the rule it was always supposed
to follow.

What is still cut on that console is quest's music, and that is the hardware
rather than a gap: its four tracks and eight effects pack to 103912 bytes and the
sound processor has 64 KiB of its own.
