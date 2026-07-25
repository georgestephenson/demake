---
"@demake/demotic": minor
"@demake/core": patch
"demake": minor
---

Build Demotic games into playable Game Boy ROMs, and play them in the page.

`demake build game.dmt -o game.gb` writes a real 32 KiB cartridge. The console
runtime (`runtime-harness/gb/`) is a fixed SM83 engine that consumes the program
tables the compiler emits — doc 14 §2's "compile to data, not to assembly" — so
a build is a byte patch into a checked-in engine image rather than a toolchain
invocation. Three consequences: builds need no assembler, the browser can
produce byte-identical ROMs, and adding a language feature is one opcode per
runtime instead of a code path per code generator.

The new `@demake/demotic` surface is `emitTables`, `buildGbRom`,
`unsupportedFeatures`, and the `rom*` trace readers. A new package,
`@demake/dmg`, is a dependency-free Game Boy core: it runs the conformance
suite headlessly in Vitest and plays the cartridge in the web app, where doc 07
forbids a CDN core.

Conformance is proven, not asserted: `packages/demotic/test/rom.test.ts` boots
each built ROM and diffs raw 16.16 entity state against the reference
interpreter, tick for tick, for the golden Pong trace and four more fixtures.

Known gaps, each a build error rather than a silent difference: levels, tiles
and the camera are not implemented, so `caves` and `runner` refuse to build;
sprite art waits on doc 15's rasteriser, so objects draw as a built-in block;
and the interpreter needs about three Game Boy frames per tick, so a game runs
near 20 Hz on hardware — the web app reports the measured figure rather than
hiding it.

No image output bytes change.
