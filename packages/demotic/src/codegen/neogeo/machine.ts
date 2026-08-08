/**
 * The Neo Geo's geometry, and the one fact that decides the whole renderer.
 *
 * **A hardware cell here is 16×16 and a language cell is 8×8.** Every other
 * console in the set draws its playfield out of 8×8 tiles, so a level's grid maps
 * onto the tilemap one cell to one cell and a backdrop is fitted at the same
 * granularity the rules talk in. This machine's playfield is built from sprite
 * *tiles*, and the smallest of those is sixteen pixels square — so one plane cell
 * covers a **2×2 block of language cells**, and the mapping is 2:1 on both axes.
 *
 * Three consequences follow, and the third is the expensive one.
 *
 *   - **The plane is 21×15 cells against a 20×14 screen.** 320×224 is exactly
 *     twenty by fourteen hardware cells, and one spare column and row is what a
 *     scrolling scene paints its leading edge into. That is smaller than any
 *     other console's map in *cells* while covering more screen, which is what
 *     makes twenty-one sprite strips enough to be a tilemap at all.
 *   - **The HUD is unaffected, because the fix layer is 8×8.** Forty by
 *     twenty-eight of them across the same screen — which is the language's own
 *     cell grid, exactly. So a caption lands on the cell the rules name, with
 *     none of the halving below, and this is the second reason (after its
 *     priority) that the HUD belongs there rather than on the plane.
 *   - **The level grid has to be composed at build time.** A hardware tile is
 *     four language cells, so the art path cannot hand a level's tiles to the
 *     plane one at a time: it has to take each 2×2 block of the grid, compose the
 *     four 8×8 patterns into one 16×16 tile, and dedup *those*. That is legal
 *     only because a Demotic tile layer cannot change — a door that opens is doc
 *     13 §D6's still-to-come work — and it is why {@link CELLS_PER_TILE} is a
 *     named constant rather than a `2` written in four emitters.
 *
 * The PC Engine hit the first half of this — "there is no 8×8 sprite", so an
 * object is composed from four 8×8 patterns — and `pce-art.ts` is the precedent
 * for the composition. What is new here is that the *background* has the same
 * problem, which that console does not have because its BAT cells are 8×8.
 */

import { FIRST_USABLE_SPRITE, FRAME_HEIGHT, FRAME_WIDTH } from "@demake/neogeo";

/** Pixels on a side of a hardware tile — a sprite tile, not a fix tile. */
export const TILE_PIXELS = 16;

/** Language cells to a hardware tile, on each axis. The whole design's hinge. */
export const CELLS_PER_TILE = 2;

/** Hardware cells the screen shows: 320×224 is exactly 20×14 of them. */
export const VIEW_TILES_W = FRAME_WIDTH / TILE_PIXELS;
export const VIEW_TILES_H = FRAME_HEIGHT / TILE_PIXELS;

/**
 * Strips the plane is built from: the visible columns and one to scroll into.
 *
 * Each is a sprite, and all but the first are sticky — chained to the one before
 * it — so the whole plane carries a single position and scrolling is two writes.
 */
export const PLANE_STRIPS = VIEW_TILES_W + 1;

/** Rows of SCB1 each strip fills. One past the screen, for the same reason. */
export const PLANE_ROWS = VIEW_TILES_H + 1;

/** The strip the plane's chain is anchored on; sprite 0 is the hardware's. */
export const PLANE_SPRITE0 = FIRST_USABLE_SPRITE;

/** The first strip an object may use: past sprite 0 and past the plane. */
export const OBJECT_SPRITE0 = PLANE_SPRITE0 + PLANE_STRIPS;

/**
 * The fix layer's visible grid, which *is* the language's cell grid.
 *
 * The map is 40×32 words in VRAM and NTSC shows the first twenty-eight rows, so
 * the visible area and the profile's `screenWidth`/`screenHeight` are the same
 * numbers — the only console in the set where a HUD cell and a language cell are
 * the same object with no arithmetic between them.
 */
export const FIX_VIEW_W = 40;
export const FIX_VIEW_H = 28;

/** Sub-palettes reserved for the font, on each of the two layers that need one. */
export const SYSTEM_PALETTE = 0;

/**
 * The first palette art may use.
 *
 * The fix layer can only reach the first sixteen palettes of the bank, so the
 * font's has to be one of those or a caption is unreadable — and palette 0 is the
 * natural choice because colour `$400000` is required to be pure black anyway,
 * which is a backdrop the ink is guaranteed to be legible against.
 */
export const ART_PALETTE0 = 1;

/**
 * Sub-palettes a picture is fitted into.
 *
 * Fifteen rather than the hardware's 256, and this is a *cost* bound rather than
 * a capability one — the distinction AGENTS.md §Gotchas draws about the Game Boy
 * Advance's 256-colour mode. A k-means iteration is `O(pixels x centroids)`, so
 * asking for 255 sub-palettes of sixteen is a fit measured in minutes for a
 * picture that has only 280 cells to spend them on. Fifteen is 225 colours on
 * screen against a Mega Drive's 61 and a Master System's 31, so nothing is
 * starved — and it keeps every art palette inside the sixteen the fix layer can
 * reach, which costs nothing and means one pool serves both layers. The console
 * spec still declares the 256 the hardware has, because that is what it has.
 */
export const ART_PALETTES = 15;
