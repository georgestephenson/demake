---
"@demake/core": minor
"demake": minor
---

Harden the Game Boy path against extreme images (found by a full
prep→gen→ROM→SameBoy→compare sweep over flat / full-screen / noise / mirrored /
many-palette / 8×8 inputs). Three correctness fixes, all output-affecting:

- **DMG has no background tile flip.** The original Game Boy's BG tilemap carries
  no per-tile attribute bits — H/V flip is a CGB-only feature (its bank-1
  attribute map). `dmg` declared `flip: true`, so `gen` flip-deduplicated tiles
  the hardware then rendered unflipped. Fixed to `flip: false`; GBC keeps flip.
- **Tile-budget enforcement now actually hits the cap.** The old greedy
  nearest-pair merge was O(n³) and, on high-entropy full-screen images, exhausted
  its iteration guard while still over budget (e.g. 337 > 256 on DMG), producing
  a ROM that overran VRAM. Replaced with a one-pass "keep the `budget` most-used
  tiles, remap the rest to their nearest kept representative" — guaranteed within
  budget, deterministic, and far faster.
- **GBC uploads VRAM bank 1.** The ROM harness only copied tiles to bank 0
  (≤256), so images with 257–512 unique tiles rendered garbage. It now spills
  tiles 256..511 into bank 1, matching the per-tile bank bit `gen` already writes
  into the attribute map.

The pixel-perfect emulator E2E now runs the whole battery (DMG + GBC) and asserts
zero mismatched pixels for every case.
