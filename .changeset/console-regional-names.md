---
"@demake/core": minor
"@demake/demotic": minor
"@demake/cli": minor
"@demake/web": minor
---

Call each console every name it was sold under.

Half the machines in the matrix had two. A Mega Drive is a Genesis in America, a
PC Engine is a TurboGrafx-16, an NES is a Family Computer in Japan, a Mega Duck
is a Cougar Boy in Brazil — and somebody who grew up with one of those names
could not find the machine in a picker that only offered the other. Every picker
now shows all of them: the art, music, sound and game sections of the web app,
the level editor's viewport picker, `demake consoles`, and the generated support
matrix. A caption that is naming an already-chosen console — the pane heading
over a demade image, the chip drawn on a level's viewport overlay — still shows
one name, because a caption is not a search.

A `ConsoleSpec` carries the extra names in `otherNames`, in region order —
British, Japanese, American, then anywhere else, with a region that kept the
previous region's name not listed twice, so most consoles carry none and the
Mega Drive carries exactly one. `consoleNames`/`consoleLabel` are the only place
the list is joined, and the separator is doc 03's own `/`.

Two things fall out of it. **A name a picker offers is a name the parser takes**,
so every regional name resolves through the alias table in its hyphenated form
and a test asserts that for all of them — `family-computer` and `super-famicom`
are new aliases as a result. And `@demake/demotic`'s profile table restates the
label rather than importing it, because the simulator imports nothing;
`profiles.test.ts` cross-checks it against `consoleLabel` exactly as it already
cross-checks every screen dimension.

One console's British name does not lead, and it says so where it is declared:
the Supervision was built by Watara and badged by its distributors — QuickShot
in the UK — so the manufacturer's name leads and the badge follows it.

No output bytes change. `demake gen`'s provenance header, every cartridge and
every demade image are untouched; what moves is `demake consoles`' table (which
gains an `ALSO KNOWN AS` column and aligns its `ID` column), the `label` field on
`consoles --json`'s support rows, and `docs/console-support.md`'s Console column.
