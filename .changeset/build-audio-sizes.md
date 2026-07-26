---
"demake": patch
---

`demake build` reports what a game's audio really cost.

It said `0 bytes of driver, 0 of schedule` for every cartridge it has ever built,
on both consoles and in `--json`, while the audio was in the ROM and playing. The
driver is emitted lazily — `@demake/audio` hands back `emitCode`/`emitData`
closures and only learns their sizes once the assembler has run them, which
happens during `assemble` — and both game backends copied the sizes out of the
binding one step earlier, capturing the zero they held before anything had been
emitted. They are live queries now — as is `helpers`, which was reading correctly
only because copying an array copies its reference — and `BoundAudioShape` says
why, so the next backend does not repeat it.

No output bytes change: this is what the build _reports_, not what it builds. A
Game Boy Pong is 575 bytes of driver and 5101 of schedule; the same game on the
NES is 677 and 3639.
