---
"@demake/core": minor
"@demake/demotic": minor
---

Add `backdrop <file>` to Demotic, and give every example game a demade title
screen and a demade playfield.

A scene's background layer is either a level or a picture, and `backdrop` names
the picture. The file goes through the **image pipeline** — `prep`, at the
console's own screen size, with the same fitter a photograph gets — and comes
back as deduplicated tiles plus a tilemap the background layer draws for free.
So a game's first screen is full-bleed artwork demade by the same engine as
everything else, which is what the whole tool is for.

- `backdrop <file> [in <scene>]`, with `E_DUPLICATE_BACKDROP`,
  `E_BACKDROP_WITH_LEVEL` and `E_BACKDROP_TILES` for the three ways it can be
  wrong. A picture and a playfield are the same hardware layer, so the compiler
  says which to drop rather than picking; and a bank that overflows names the
  number, because a title screen with holes in it is not a smaller title screen.
- Backdrop tiles are **pooled against the whole bank**: a cell already drawn by
  the built-in font, by a sprite's art, or by another scene's picture is pointed
  at rather than stored twice. Two screenfuls of the same night sky cost one
  tile between them.
- `prep` gains a synchronous twin, `prepSync`, which is what lets the game
  backend fit a picture inline; `prep` is now a thin async wrapper over it.
- `levelwidth`/`levelheight` fold against **the scene the statement is in**,
  which is the same playfield `checkGeometry` measures that statement's object
  against. They used to fold against the entry scene — identical as long as a
  game began on the scene with the level in it, and silently wrong the day one
  gained a title screen.

The example library is redrawn to go with it. All seven games open on a title
screen and enter play on A; the five without levels have playfield art too, and
the two with levels have new tile art including scenery for the empty cells. The
sprites are redrawn from the cover art in the same palettes, and every `.dmt`
that was overloading `hero.svg` for a ship, a bird and a hero now has its own.

Two things about how that art is drawn are load-bearing, and both are properties
of the hardware:

- **Backdrops are authored at 640×576, not at 160×144.** A picture is fitted to
  the screen of whichever console is being built for, and those differ fourfold
  in area, so art whose finest feature is one Game Boy pixel gives a Mega Drive
  nothing to resolve. The screens carry detail down to a quarter of a Game Boy
  pixel — bevels, rules, inner rims — which a mono fit averages away and a
  sixteen-colour one keeps.
- **Sprites are eight pixels to a cell everywhere**, so what a bigger console
  has more of is colour, not room: the silhouette sits on well-separated
  luminance tiers and the modelling sits between them.
