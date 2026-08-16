---
"@demake/audio": minor
"demake": minor
---

Build a standalone Nintendo DS audio cartridge.

`demake gen <schedule> -c nds --format rom` now produces a bootable `.nds` that
plays the schedule. It is the ninth standalone cartridge and cost what the
roadmap said it would: `nds-driver.ts` already exported this console's whole
share — the port map, the write routine, the bank copy, the timer pair and the
main loop — so `rom/nds.ts` is a boot, one stream and a wrapper.

**It is the only cartridge in the set whose main processor does nothing at all.**
The sound channels answer the ARM7 alone and a `.nds` names two binaries the
loader copies into the memory they share, so the ARM9's whole program is a branch
to itself and there is no upload, no handshake and no request. The Super
Nintendo's driver is also off the console's own CPU and has to be _sent_ there;
here the loader does it.

Its clock is the same one a game gets, which no other two-caller console can say.
Timer 0 reloads at the driver rate and timer 1 counts its overflows, so how many
ticks have happened is a register the driver reads rather than a flag it must
catch — there is nothing for a caller to drift against, so `resolveNdsClock` is
called rather than mirrored.

Two things cost the time rather than the typing. The shared main loop calls
`AudioTick` where a single-stream driver's own entry is `Tick`, so both names go
on one address and no tail call is emitted. And a tick here is attributed by the
**ARM7's** program counter, which made this the first standalone whose proof
could not sample one: a host step is several of that processor's instructions, so
sampling saw one arrival as none and reported an empty tick. `_rom-harness.ts`
gained the `watch` hook `packages/demotic/test/_audio-battery.ts` already had for
exactly this, one layer up — the group opens inside the core's own report of
where the driver is, rather than after a host step.
