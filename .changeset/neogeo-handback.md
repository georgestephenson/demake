---
"@demake/audio": minor
---

Give a Neo Geo's borrowed channel back holding the music's own registers.

The last driver in the set without a handback has one. The packed music is a
delta stream, so a channel a sound effect borrowed came back holding the
effect's period and level — and the music, having already stated its own, never
stated them again. On a square that is a note coming back at the wrong pitch and
staying there until the part next moves.

Two things were in the way and both are this chip's rather than this processor's.
A packed byte on this board is a bus **port** and not a register number, so a
recorder cannot tell one of a channel's bytes from another by looking at the
byte: the shadow therefore carries the latch as a fourth byte, and the recorder
classifies on the port — an even one latched a register and the byte _is_ that
number, an odd one is the datum and the latch says which copy it belongs to. And
a game's effect was packed to end with the silence block, which turns every
channel off and then rests for ever: it took the music with it and held the
borrowed channel long after the effect had finished. Effects now end with the
order list's terminator, which is what `gb-game.ts` and `sms-game.ts` have always
done.

The replay is three registers because an effect only ever borrows a square. An FM
voice's state is a whole patch, and nothing on this console ever hands one back.

Cartridge bytes move for `demake build -c neogeo`: the sound program's run walk
gains a recording loop, the release a replay, and each borrowable channel four
bytes of the Z80's work RAM. `Z80ShadowChannel` gained an optional `take`, so the
Sega 8-bits' driver — which shares this stream player — is byte-identical.

The shared game-audio battery's handback assertion, which this console was
skipping, now runs everywhere with no exceptions.
