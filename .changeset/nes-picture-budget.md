---
"@demake/demotic": minor
---

Give an NES picture the rest of the hardware. Two changes, both of which the
console was already offering:

- **The built-in bank is pulled, not pushed.** The font, the level patterns and
  the placeholder block are 64 patterns and a game draws about 25 of them. On a
  Game Boy that is free; here it comes out of the same 256 a picture is fitted
  into, so a build now emits only the characters its captions and counters
  actually write. The blank stays at index zero, because that is what an empty
  cell draws.
- **No sub-palette is reserved for the font.** A caption's cells are replaced by
  glyph tiles, so the only colours that matter there are the universal backdrop
  and the ink — and the fitter rarely fills all sixteen slots, so the font takes
  one the picture left empty and the picture keeps all four palettes. Where the
  fit used every slot, the caption goes in the palette with the most contrast at
  the ink's index.

A title screen goes from 96 patterns and three sub-palettes to 201–231 and four;
the shooter's, which merged 216 of its 960 cells, now merges none.

NES cartridge bytes change.
