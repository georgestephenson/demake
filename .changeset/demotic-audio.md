---
"@demake/core": minor
"@demake/demotic": minor
---

Demotic games have music and sound, demade by the audio engine into the same
cartridge.

Two statements join the language (doc 14 §Sound, the shape doc 17 §Demotic
integration set out and the maintainer chose):

```
music rally.mid in play
sound bounce.wav on ball hits paddle
```

`music` is scoped to a scene — entering it starts the track, leaving it stops
it — and `sound` takes `when`'s own triggers verbatim, `in` and `if` included.
What a `sound` has no room for is `then`: playing a sound is not a property
assignment, and that is why it is a statement rather than something a rule could
do. A `sound` whose trigger exactly matches an existing rule is merged into it by
the compiler, which is the difference between thirty bytes and four and a half
kilobytes when the trigger is a collision over nine aliens.

Both files go through the demakers the CLI already exposes: `arrange` for the
track, `sfx` for each effect, called from `demake build` with the bytes the edge
supplied — the same hand-off `.dmt` art already makes to the image pipeline. The
game code owns no notes and no registers.

`packages/audio/src/rom/` grew the driver a game embeds. One stream player
serves both it and the standalone music cartridge; what is new is that music and
effects share one timer, so the game states the rate and every piece is fitted to
it (`ArrangeOptions.driverHz`, `SfxOptions.rateHz`), an effect borrows a channel
and hands it back, and `NR51` is merged rather than stored so neither stream can
erase the other's panning. Only what a game uses is emitted: a game with no
effects has no preemption test anywhere in it.

`packages/demotic/test/audio.test.ts` is doc 16's Level A proof for a cartridge
that is also playing a game — boot it, watch `AudioTick` by program counter, and
diff every register write the APU receives against the schedules the demakers
produced. With nothing preempting, the music's stream is the schedule's byte for
byte; while an effect plays, its own channel is its schedule's and the music's
channels are untouched. No toolchain, no emulator install.

Every example game gained a theme and its effects, so the fixtures are the shop
window for all four demakers at once.

**Output bytes change.** A trace of a game with audio carries an extra
`# audio=track,effect` header line and an `audio=<track>,<effect>` field per
line, recording what the game _asked for_ on that tick — the conformance oracle
doc 17 requires, so a ROM and the interpreter cannot disagree about when a sound
fires. `packages/demotic/fixtures/pong.gb.trace` is re-baselined; a game with no
`music` and no `sound` traces exactly as before.

`demake build` also now loads a program's **backdrops**, which it never did: it
loaded the art _requests_, and a backdrop makes none, so the CLI was building
cartridges without title screens while the browser built them with. Both edges
now hand over every asset the program names.
