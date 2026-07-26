---
"@demake/demotic": patch
"@demake/nes": patch
---

Fix three ways the NES drew a scrolling game wrongly. None of them touched
simulation state, so every trace was already correct — which is why they needed
looking at rather than diffing.

- **The picture is uploaded from the VBlank handler**, not the main loop. The
  loop's flag says a VBlank _happened_, not that we are in one, so a tick that
  overran its frame uploaded during active rendering — where the PPU reloads its
  address register from the scroll latch, dropping the tail of a scrolled column
  back at the top of the column. That was the flicker a scrolling level showed
  every few frames.
- **An object off the side of the screen is dropped, not wrapped.** A sprite's
  position is a byte and an object's is not, so a coin one pixel past the right
  edge came back inside the wall on the left. Each cell's position is now
  computed sixteen bits wide and pushed only when the screen can hold it.
- **A level the nametable holds whole no longer scrolls vertically.** Thirty rows
  of map against thirty of raster leave nothing to scroll into but the level's own
  top, so the two overscan rows showed the ceiling under the floor. The vertical
  scroll is pinned and the objects with it, and the column painter no longer
  writes a thirty-first row into the attribute table.

`@demake/nes` exposes the frame's scroll position and nametable for harnesses;
`nes-rom.test.ts` uses it to check all thirty rows rather than the game's
twenty-eight, since the last two are exactly where this went wrong.
