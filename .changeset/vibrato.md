---
"@demake/audio": minor
---

Produce vibrato, read off the source's own modulation wheel — the arranger half
of doc 13 §A5.5's first and largest line.

Nothing in `@demake/audio` produced vibrato **at all**: not through a chip LFO,
and not through pitch writes on the consoles that have no LFO to use. A period
arranger uses it constantly, so this was the one A5.5 line that was the
arranger's before it was any binding's, and the one doc 13 said to do first.

**MIDI states vibrato, so the depth is read rather than invented.** General MIDI
puts it on controller 1, the modulation wheel; `score/midi.ts` now keeps that one
controller and discards the rest of the control-change bus, because the rest is
either the mixing desk's job (volume, expression, pan) or something the arranger
decides for itself against the hardware — reading those would be taking an
instruction the demake cannot honour. `Note.vibrato` carries it per **note**,
because that is the resolution the source has: a wheel can swell across a phrase,
so a note takes the highest it reached while sounding rather than its value at the
onset. A note that begins dry and is leaned into is the common way it is written,
and sampling only the attack reads it as dry.

Waiting for the transcription front end would have been the wrong way round: an
MP3 is where vibrato has to be _inferred_, and a MIDI is where it is already
written down.

**Rate, width and delay are the demaker's**, since the source does not state them
— controller 76 exists for the rate and almost nothing writes it. A little over
five cycles a second, a quarter-tone at the top of the wheel, and a short delay so
a note is placed in tune and leaned into. The delay pays twice: it is what a
listener expects, and it costs no pitch writes, so a schedule pays for vibrato
only on notes long enough to have any.

**No existing output moves.** A source that never touches the wheel produces
byte-for-byte the schedule it always did, and that is every MIDI in the example
library — so this closes a line and re-baselines nothing. Verified by dumping
every console's schedule for every fixture before and after.

**What it costs, stated rather than discovered later**: a modulated held note is a
pitch write per driver tick, so a track of long notes with the wheel at full runs
two to five times a dry track's register writes — 80 against 452 on a Game Boy for
the pathological case. That is what doc 13 predicted for a console that must
_write_ the modulation. Spending a chip LFO where one exists (the YM2612's, the
HuC6280's) would collapse most of that into a handful of register writes, and is
what remains of the line.
