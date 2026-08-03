/**
 * Packing a background map, for the consoles whose map entry is a word.
 *
 * ```text
 *   $00        the end
 *   $01..$7F   n cells follow, two bytes each
 *   $81..$FF   the next two bytes, (n & $7F) times
 * ```
 *
 * The unit is a *cell* rather than a byte because an entry on these machines is
 * two of them — a tile and whatever the hardware puts beside it — so a run of
 * identical cells is `T A T A T A` and has no byte runs in it at all. That is the
 * one thing this does not share with the NES's `packCells`, whose entries are
 * single bytes and which stays where it is.
 *
 * It is here rather than in one backend because two of them want it: a Master
 * System name-table entry is a tile and an attribute byte, and a PC Engine BAT
 * entry is a character number and a sub-palette in one word. A screenful is 768
 * cells on the first and 1792 on the second, so two pictures stored raw would be
 * a tenth of a Sega cartridge and a seventh of what a HuCard build can address —
 * and a demade screen is mostly runs, so it packs to a fraction of that.
 *
 * The format is the encoder's and the decoder's business and nothing else's:
 * what is guaranteed is the bytes that reach the video chip, and each console's
 * rendering oracle checks *those* against the level and the picture rather than
 * checking this encoding. Same rule the audio driver's packing runs under
 * (doc 16 §The driver format is not part of the contract).
 */

/** Pack a run of two-byte cells. */
export function packCellPairs(cells: Uint8Array): Uint8Array {
  const out: number[] = [];
  const same = (a: number, b: number): boolean =>
    cells[a * 2] === cells[b * 2] && cells[a * 2 + 1] === cells[b * 2 + 1];
  const total = cells.length >> 1;
  let at = 0;
  while (at < total) {
    let run = 1;
    while (run < 127 && at + run < total && same(at + run, at)) run += 1;
    // Two of a kind is a wash — three bytes either way — so a run has to be worth
    // the control byte before it is taken, and pairs go through as literals.
    if (run >= 3) {
      out.push(0x80 | run, cells[at * 2] as number, cells[at * 2 + 1] as number);
      at += run;
      continue;
    }
    const start = at;
    while (at < total && at - start < 127) {
      let ahead = 1;
      while (ahead < 3 && at + ahead < total && same(at + ahead, at)) ahead += 1;
      if (ahead >= 3) break;
      at += 1;
    }
    out.push(at - start, ...cells.subarray(start * 2, at * 2));
  }
  out.push(0x00);
  return Uint8Array.from(out);
}
