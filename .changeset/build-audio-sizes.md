---
"demake": patch
---

Hold `demake build`'s audio size reporting to a test, and finish the rule behind
it.

The reporting bug itself is already fixed: `demake build` used to say `0 bytes of
driver, 0 of schedule` for every cartridge it made, on every console and in
`--json`, while the audio was in the ROM and playing — a driver is emitted lazily
during `assemble`, and the backends read its sizes one step earlier, at
`bindAudio`, capturing the zero they held before anything was emitted. The Z80
driver work corrected `code` and `data` in passing.

What was missing is why it survived so long: nothing asserted the numbers were
real. The size sweep in `demotic/test/audio.test.ts` now does, for every fixture
on every console with a driver.

`helpers` is made a query too, in all three backends. It was reading correctly
only because copying an array copies its reference and the emitter pushes rather
than replaces — true today, luck rather than design, and not a distinction worth
asking the next backend to remember. `BoundAudioShape` states the rule for all
three fields in one place.

No output bytes change: this is what the build reports, not what it builds.
