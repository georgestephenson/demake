---
"@demake/audio": minor
"demake": minor
---

Read ProTracker modules (doc 17 §Stage 0).

`demake arrange` takes a `.mod` as well as a `.mid`, which closes half of that
document's opening claim — "any track: a MIDI file, a tracker module, an MP3".

Doc 17 calls this "almost a transpile", and it is: a module is already
channelized, already has instruments and already runs on a tick rate. The half
that is not is the **timeline**.

- **A module has no tempo map.** It has a _speed_ in ticks per row and a _tempo_
  in beats a minute, either of which any row can change with `Fxx` — and both
  carry across patterns, so a row's duration is state rather than arithmetic.
- **The song is an order list, not a pattern table.** A pattern named twice is
  heard twice at two different ticks, so the walk is over the order.
- **A note ends when the next one on its channel starts** and at no other time.
  That is what a tracker does rather than a simplification: it sustains until
  told otherwise.

Which parser reads a file is a **sniff rather than an extension**, on
`decodeImage`'s terms — both formats state themselves in their first bytes, so a
file named wrongly is still read correctly.

Notes, volumes, the order list, both timing effects and vibrato (`4xy`, whose
depth feeds the same `Note.vibrato` a modulation wheel does) are read. Every
other effect is **counted and reported** rather than dropped, on the "never lose
a part silently" rule — and as a _warning_ rather than a note, because a module
leaning on portamento for its melody is one this ingest reads as a series of flat
notes, which is a demake that is wrong about the tune rather than merely coarser
than it.

Two things it deliberately does not infer, because doc 17 §Stage 0 is about
exactly the line between what a format states and what has to be guessed:

- **There is no General MIDI programme**, so the role prior `analysis.ts` takes
  from one is absent and roles come from the material alone.
- **There is no drum channel.** A MIDI file states percussion outright and a
  module says nothing — a kick is a sample like any other — so a kit arrives as
  an ordinary pitched part. A sample named "kick" is a hint rather than a
  statement, and acting on one would put a bassline on the drums the first time
  somebody named a sample badly.

`.xm`, `.s3m` and `.it` are still unread; they are a different header and a wider
effect set over the same walk.
