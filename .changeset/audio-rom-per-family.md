---
"@demake/audio": minor
"@demake/chip": patch
"@demake/md": patch
---

`buildAudioRom` reaches each console's cartridge builder through an `import()`,
and is asynchronous as a result.

Behind each of those builders is a whole CPU's assembler, and `rom/index.ts`
imported all five statically — so every visitor to the web app downloaded the
SM83, 6502, HuC6280, Z80 and 68000 backends to build a cartridge for one console.
That was invisible while the list was short and stopped being so the moment the
Sega and Mega Drive cartridges landed: a visitor's payload went from 394 KB
gzipped to 402 against a 400 KB budget, which is exactly what the budget is for.

The split is the one
[doc 07](../docs/07-web-app.md) already prescribes for `demotic`'s
`codegen/registry.ts` and the page's emulator cores, and this was the third place
that needed it. It also took the _Game Boy's_ driver out of the always-loaded
bundle, where it had been since standalone audio cartridges existed — so a
visitor now downloads **328 KB** of shared code plus one family, 369 KB in total,
which is better than before either new console arrived.

`rom/artifact.ts` is new and holds the four declarations a dispatch has to name —
`BuiltAudioRom`, `AudioRomStats`, `AudioRomOptions`, `AudioRomError`. They lived
in `gb.ts` while the Game Boy was the only console that built one, and importing
them from there would drag that family back into the always-loaded bundle and
quietly undo the split. `gb.ts` re-exports all four, so every emitter and caller
imports them from where it always did.

The Mega Drive audio battery's building cases now state a timeout instead of inheriting the
default twenty seconds, and the measurement is why: the Mega Drive's timbre is
_searched_ hardware-in-the-loop rather than selected, so `arrangeScore` takes
8685 ms on the shooter's theme there against 9 ms on a Master System. That case
was spending nineteen of its twenty seconds inside a search that is the design
working — a coin toss on a loaded runner rather than a signal.
