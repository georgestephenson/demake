---
"@demake/core": minor
---

Spend every colour slot the console has.

An NES title screen was coming out in six colours of a possible thirteen, and
nothing in the pipeline could say so: a sub-palette short of a colour, or one no
cell ever chose, is invisible in every number the tournament reports. The fit is
internally consistent and the judge scores what it produced rather than what it
could have, so the only symptom is a picture in fewer colours than the hardware
draws — yellow coins arriving pale blue, a green alien row arriving white.

Three things, all in stage 4:

- **Dedupe returned a palette shorter than the caller asked for.** Two centroids
  that converge on different Oklab means can snap to the _same_ lattice colour,
  which is routine on a fixed master palette — the NES's shadow end is sparse
  enough that three tints of one sky land on one entry. The duplicate was dropped
  and nothing replaced it. `latticeKmeans` now tops up from the point the palette
  serves worst, and stops as soon as the points hold no colour it does not
  already have. Adding a centre can only reduce error, because assignment is
  nearest-centre, so this needs no further iteration.

- **A sub-palette that lost all its cells could never win one back.** A cell only
  ever moves to the palette that serves it _best_, and an unused palette holds
  either nothing or the shared backdrop alone, so it serves nothing best and
  stays unused for the rest of the fit — a quarter of an NES's colour budget
  sitting idle. An unused palette is now reseeded from the cell its own palette
  serves worst, which is the move `latticeKmeans` already makes for an empty
  cluster, one level up.

- **A reserved backdrop is a frozen centroid, not a colour prepended
  afterwards.** On a `sharedIndex0` console index 0 is decided before the fit, and
  the other K−1 were fitted over the whole cell and the backdrop put in front of
  them — so one of the free centroids routinely landed back on the backdrop and
  was deduped away. It now goes _into_ the k-means and competes for points, so
  the free colours cover what it cannot.

The example library's seven title screens go from three palettes of three and one
of one to four of four, and from six to ten distinct colours. `quality.test.ts`
gains two floors over a picture built to need every slot exactly once, on a
shared-backdrop console and a per-cell-palette one.

Output bytes change for any picture whose fit was leaving a slot unspent — every
NES conversion in practice, and some on the Game Boy Color and the Mega Drive.
The GBC eval battery scores are unchanged to four decimal places.
