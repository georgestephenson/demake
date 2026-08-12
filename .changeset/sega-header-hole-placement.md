---
"@demake/demotic": minor
"@demake/audio": minor
---

Place the Sega cartridge header hole one data block at a time, not wholesale.

This console's `TMR SEGA` header is sixteen bytes **inside** the image at
`$7FF0`, and a 48 KiB build used to pad its whole data section past it in one
move — which threw away everything between the end of the code and the header,
up to thirty-two kilobytes for a game whose code is short and whose tables are
long.

Everything a Sega build emits after `ctx.finish()` is addressed by label rather
than by a branch, so a block that would be laid across the header can move past
it whole and take its label with it while every block that fits below stays
below. That is now the question asked in front of each block. The audio driver's
packed schedules are the one block that places itself: they are dozens of small
label-addressed blocks rather than one, so `SmsGameAudio.emitData` takes an
optional `DataHole` and steps over it at whichever of its own boundaries falls
there — the same mechanism the standalone Sega audio cartridge has always used.

The awkward part is that a block's length is not known until it has been
emitted, so the lengths come from the pass that has already happened:
`emitProgram` now returns an `EmittedProgram` carrying them, the second pass
reads the length of the block it is about to emit out of the first pass's
measurements, and the two are compared afterwards because a size list that had
drifted would place the hole somewhere plausible and wrong.

A game whose _code_ reaches `$7FF0` is still refused by name — that is now an
explicit check on where the code ends rather than a padding error caught by its
message. Every existing cartridge is byte-identical: a game that fits below
`$7FF0` never makes the second pass at all.
