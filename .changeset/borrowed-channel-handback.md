---
"@demake/audio": minor
"@demake/demotic": minor
---

Give a borrowed channel back holding the music's own registers.

The packed music is a delta stream, so a register the music's own value did
not change is one it never states again. After a sound effect borrowed a
channel the chip was left holding the effect's values for it, and the music's
next volume step re-triggered the voice through a register whose neighbour
still carried the effect's pitch — a Game Boy pulse coming back a whole tone
sharp and ringing until the bar ended, on every bounce in pong.

The music now keeps a copy of every register belonging to a channel an effect
can take, and the release replays it. Six drivers: SM83, 6502 (the NES and the
PC Engine), Z80, SPC700 and ARM (the Game Boy Advance and the Nintendo DS).
The Mega Drive is named as a gap in doc 13 — neither chip on that board has a
register number the packed byte carries.

Cartridge bytes move on every console with a driver: the run walk gains a
recording loop and the release a replay, and each borrowable channel takes a
few bytes of driver RAM.

Also: a percussion part could be assigned to a pitched channel when the winning
arrangement had no percussion channel, and then played General MIDI's drum
numbers as pitches. It is dropped and counted instead.
