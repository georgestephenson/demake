---
"@demake/core": minor
---

The web app's cartridge pane plays the cartridge.

`@demake/chip` gained `StreamSink`: the same renderer as `render()`, for a chip
that is still running. Same box integration, same sample boundaries computed from
an absolute index, same DC blocker — carried across calls rather than restarted,
because restarting it per chunk is a step at every frame boundary and sixty
clicks a second. `packages/chip/test/stream.test.ts` asserts a chip driven in
emulator-sized chunks produces bit-identical samples to the same chip driven by
`render`, in any chunk size, which is what makes the page a playback device
rather than a second implementation of the hardware.

`@demake/dmg` already had `audioSink`; the ROM pane now attaches one and hands
the buffer to a bare `AudioBufferSourceNode`. Nothing else goes in the graph —
not even a `GainNode`, since muting is the context suspended and the stream
detached — and a Playwright spec records the Web Audio constructors before the
app loads to assert it.

Two behaviours worth knowing:

- **With sound on, the audio device clocks the emulator.** The pane runs frames
  until the chip has produced the samples the player still needs, rather than on
  the frame clock; a tab whose display and audio clocks differ by a few parts per
  million drifts into a click every few minutes otherwise. Sound off restores the
  frame clock exactly as it was.
- **Sound is a button, off by default**, because a browser will not start an
  `AudioContext` without a user gesture — a page that tried to start it on its
  own would be quiet with no way to say why.

Reset also works now: the frame loop reads the machine each frame instead of
closing over the one it was created with, so replacing it actually replaces what
is running.
