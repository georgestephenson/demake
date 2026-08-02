/**
 * The Game Boy Advance's 2D engine, in the one video mode a demade game uses.
 *
 * **Mode 0 and the object layer, and nothing else.** Modes 1 and 2 add affine
 * backgrounds, 3 to 5 are bitmaps, and none of them is what `demake build`
 * programs — a game is a scrolling tilemap with hardware sprites, which is what
 * `codegen/shape.ts` means by a console. A renderer that answered plausibly for
 * hardware nothing drives would be a renderer nobody is checking, which is the
 * same position `@demake/snes` takes on the three background layers it omits
 * (AGENTS.md §Iron rules). Asking for another mode raises.
 *
 * What this machine has that no console before it in this project does, and what
 * the backend above therefore spends:
 *
 *   - **Four background layers with independent scroll.** The other consoles
 *     have one, which is why a scrolling scene on them has to draw its HUD with
 *     sprites — the background moves as one piece and a cell of it cannot be
 *     held still. Here the HUD gets a layer of its own, and the whole mechanism
 *     is absent rather than worked around.
 *   - **256-colour tiles.** A cell is not restricted to a sub-palette at all, so
 *     a picture demade for this console has 256 colours available in *every*
 *     cell rather than sixteen chosen per cell. That is a strictly larger space
 *     than sixteen palettes of sixteen, and it is what the art path fits to.
 *   - **128 objects, and a per-line budget in *cycles* rather than a count.** An
 *     object costs its width in pixels on each line it covers, against 1210
 *     cycles a line — so eight sprites is not the wall it is on every other
 *     console here, and a wide object is affordable. The budget is modelled,
 *     because a game that overspends it must lose the same sprites the hardware
 *     would.
 *
 * **And it is the Nintendo DS's 2D engine A as well**, which is why the sizes
 * below are constructor options rather than constants baked into the loops. That
 * is not a generalisation invented here: a DS's engine A *is* this engine with
 * more memory in front of it — the same mode-0 text backgrounds, the same screen
 * entries, the same 4bpp and 256-colour characters, the same attribute layout,
 * at the same register offsets — and Nintendo built it that way, which is how one
 * machine runs the other's cartridges. What differs is the screen it draws on and
 * where object characters answer, and both of those are a *machine description*
 * (`@demake/nds`'s `machine.ts`) rather than a second renderer. Writing that
 * second renderer is how the two consoles would come to disagree about a tile.
 *
 * Sources: GBATEK — *LCD I/O Display Control*, *LCD I/O BG Control*, *LCD OBJ —
 * OAM Attributes*, *DS Video* (https://problemkaputt.de/gbatek.htm).
 */

/** Visible width, in pixels. */
export const FRAME_WIDTH = 240;
/** Visible height. */
export const FRAME_HEIGHT = 160;
/** Scanlines in a frame, visible and blanking together. */
export const LINES_PER_FRAME = 228;
/** Processor cycles in one scanline. */
export const CYCLES_PER_LINE = 1232;

/** Bytes of video RAM: 64 KiB of background and 32 KiB of object. */
export const VRAM_SIZE = 0x18000;
/** Where object character data starts, inside the same 96 KiB. */
export const OBJ_VRAM_BASE = 0x10000;
/** Colours the palette holds: 256 for the backgrounds, 256 for the objects. */
export const PALETTE_ENTRIES = 512;
/** Object entries in attribute memory. */
export const OAM_ENTRIES = 128;

/** What a machine tells the engine about itself. */
export interface PpuOptions {
  /** Visible width, in pixels. Defaults to a Game Boy Advance's. */
  width?: number;
  /** Visible height. */
  height?: number;
  /**
   * Background character and map memory, where the machine owns it.
   *
   * On a Game Boy Advance the engine owns one 96 KiB region with the objects at
   * the top of it, and nothing has to be passed. On a Nintendo DS the two are
   * separate address spaces filled by separate video RAM *banks*, which the
   * machine holds and a bus routes to — so it hands both of them over here
   * rather than the engine allocating memory the bus would then have to mirror.
   * Two arrays for one memory is how a picture ends up uploaded to one and read
   * from the other, which draws a black screen with every register correct.
   */
  vram?: Uint8Array;
  /**
   * Object character memory, where it is not the top of the same array.
   *
   * Absent means "the region at {@link OBJ_VRAM_BASE}", which is the Game Boy
   * Advance's arrangement and the reason that console needs no options at all.
   */
  objVram?: Uint8Array;
}

/** A rendered frame, as RGBA. */
export interface Frame {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Raised when a cartridge asks for hardware this core does not model. */
export class PpuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PpuError";
  }
}

/** Object dimensions, indexed by shape then size — GBATEK's own table. */
const OBJ_SIZE: readonly (readonly (readonly [number, number])[])[] = [
  [
    [8, 8],
    [16, 16],
    [32, 32],
    [64, 64],
  ],
  [
    [16, 8],
    [32, 8],
    [32, 16],
    [64, 32],
  ],
  [
    [8, 16],
    [8, 32],
    [16, 32],
    [32, 64],
  ],
];

/** Expand a five-bit channel to eight by replicating its high bits. */
function expand(value: number): number {
  const five = value & 0x1f;
  return ((five << 3) | (five >> 2)) & 0xff;
}

/** One pixel's worth of candidate, while a scanline is being resolved. */
interface Layer {
  /** Palette index, or −1 for transparent. */
  colour: number;
  priority: number;
}

/** The 2D engine, with its own memory. */
export class Ppu {
  /** Visible width, in pixels — a machine's, not this file's. */
  readonly width: number;
  /** Visible height. */
  readonly height: number;
  /** Background character and map memory; 96 KiB with the objects on top. */
  readonly vram: Uint8Array;
  /** Object character memory, which may be a window into {@link Ppu.vram}. */
  readonly objVram: Uint8Array;
  /** 512 entries of RGB555 — the backgrounds' 256, then the objects'. */
  readonly palette = new Uint16Array(PALETTE_ENTRIES);
  /** Object attribute memory, as the halfwords the hardware reads. */
  readonly oam = new Uint16Array(OAM_ENTRIES * 4);

  /** Display control. Forced blank at power-on, which is what the BIOS leaves. */
  dispcnt = 0x0080;
  /** Display status: the blanking flags, their interrupt enables, and `LYC`. */
  dispstat = 0;
  /** The scanline being drawn, blanking lines included. */
  vcount = 0;
  /** One control register per background layer. */
  readonly bgcnt = new Uint16Array(4);
  /** Horizontal scroll, per layer — write-only on the hardware, and kept here. */
  readonly bghofs = new Uint16Array(4);
  /** Vertical scroll, per layer. */
  readonly bgvofs = new Uint16Array(4);

  private readonly pixels: Uint8ClampedArray;
  /** One scanline of object output: palette index and priority per pixel. */
  private readonly objLine: Int16Array;
  private readonly objPriority: Uint8Array;

  constructor(options: PpuOptions = {}) {
    this.width = options.width ?? FRAME_WIDTH;
    this.height = options.height ?? FRAME_HEIGHT;
    this.vram = options.vram ?? new Uint8Array(VRAM_SIZE);
    this.objVram = options.objVram ?? this.vram.subarray(OBJ_VRAM_BASE);
    this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
    this.objLine = new Int16Array(this.width);
    this.objPriority = new Uint8Array(this.width);
  }

  /** Read a halfword out of video RAM. */
  private vram16(at: number): number {
    return (this.vram[at] as number) | ((this.vram[at + 1] as number) << 8);
  }

  /**
   * Paint the whole frame from the registers as they stand.
   *
   * Whole-frame rather than per-scanline, as `@demake/md`'s and `@demake/sms`'s
   * renderers are, and for the same reason: nothing `demake build` emits changes
   * a video register inside the visible picture, because every upload it makes
   * runs in the blanking interval. A raster effect would need this to be a line
   * renderer, and it would need a language that can ask for one first.
   */
  render(): void {
    const mode = this.dispcnt & 7;
    if (mode !== 0) {
      throw new PpuError(`video mode ${mode} is not implemented; demake builds mode 0`);
    }
    if ((this.dispcnt & 0x80) !== 0) {
      this.pixels.fill(0xff);
      return;
    }
    const backdrop = this.palette[0] as number;
    for (let y = 0; y < this.height; y += 1) {
      if ((this.dispcnt & 0x1000) !== 0) this.renderObjects(y);
      else this.objLine.fill(-1);
      for (let x = 0; x < this.width; x += 1) {
        let colour = backdrop;
        let best = 4;
        // Objects first, so that an object and a background at the same priority
        // resolve in the object's favour — which is the hardware's rule and the
        // reason a sprite is never hidden by the layer it shares a priority with.
        const objIndex = this.objLine[x] as number;
        if (objIndex >= 0) {
          best = this.objPriority[x] as number;
          colour = this.palette[256 + objIndex] as number;
        }
        for (let bg = 0; bg < 4; bg += 1) {
          if ((this.dispcnt & (0x100 << bg)) === 0) continue;
          const priority = (this.bgcnt[bg] as number) & 3;
          // Strictly lower, so an earlier layer at the same priority keeps the
          // pixel — background zero is in front of background one.
          if (priority >= best) continue;
          const layer = this.backgroundPixel(bg, x, y);
          if (layer.colour < 0) continue;
          best = layer.priority;
          colour = this.palette[layer.colour] as number;
        }
        const at = (y * this.width + x) * 4;
        this.pixels[at] = expand(colour);
        this.pixels[at + 1] = expand(colour >> 5);
        this.pixels[at + 2] = expand(colour >> 10);
        this.pixels[at + 3] = 0xff;
      }
    }
  }

  /** One text background's contribution at one pixel. */
  private backgroundPixel(bg: number, x: number, y: number): Layer {
    const control = this.bgcnt[bg] as number;
    const priority = control & 3;
    const charBase = ((control >> 2) & 3) * 0x4000;
    const screenBase = ((control >> 8) & 0x1f) * 0x800;
    const deep = (control & 0x80) !== 0;
    const size = (control >> 14) & 3;
    const wide = (size & 1) !== 0;
    const tall = (size & 2) !== 0;

    const sourceX = (x + (this.bghofs[bg] as number)) & (wide ? 511 : 255);
    const sourceY = (y + (this.bgvofs[bg] as number)) & (tall ? 511 : 255);
    // A map wider or taller than one screen block is *several* blocks a kilobyte
    // apart rather than a rectangle — the same fact the Super Nintendo's tilemap
    // has, reached by different hardware.
    let block = 0;
    if (wide && sourceX >= 256) block += 1;
    if (tall && sourceY >= 256) block += wide ? 2 : 1;
    const cellX = (sourceX & 255) >> 3;
    const cellY = (sourceY & 255) >> 3;
    const entry = this.vram16(screenBase + block * 0x800 + (cellY * 32 + cellX) * 2);

    const tile = entry & 0x3ff;
    let row = sourceY & 7;
    let column = sourceX & 7;
    if ((entry & 0x800) !== 0) row = 7 - row;
    if ((entry & 0x400) !== 0) column = 7 - column;

    if (deep) {
      const index = this.vram[charBase + tile * 64 + row * 8 + column] as number;
      return { colour: index === 0 ? -1 : index, priority };
    }
    const byte = this.vram[charBase + tile * 32 + row * 4 + (column >> 1)] as number;
    const index = (column & 1) !== 0 ? byte >> 4 : byte & 0xf;
    return { colour: index === 0 ? -1 : (((entry >> 12) & 0xf) << 4) | index, priority };
  }

  /**
   * Resolve one scanline's objects, spending the hardware's own cycle budget.
   *
   * The budget is why this is a *rendering* step rather than a lookup: objects
   * are evaluated in attribute order, each costs its width on every line it
   * covers, and the hardware simply stops when the line's cycles run out. A core
   * that drew all 128 regardless would let a game look correct here and lose its
   * furthest-right sprites on the console.
   */
  private renderObjects(line: number): void {
    this.objLine.fill(-1);
    let budget = (this.dispcnt & 0x20) !== 0 ? 954 : 1210;
    const oneDimensional = (this.dispcnt & 0x40) !== 0;
    for (let index = 0; index < OAM_ENTRIES; index += 1) {
      const attr0 = this.oam[index * 4] as number;
      const mode = (attr0 >> 8) & 3;
      if (mode === 2) continue; // hidden, and it costs nothing
      if ((mode & 1) !== 0) {
        throw new PpuError(
          "an affine object is enabled; this core draws no rotation or scaling, " +
            "and nothing demake builds asks for it",
        );
      }
      const attr1 = this.oam[index * 4 + 1] as number;
      const attr2 = this.oam[index * 4 + 2] as number;
      const shape = (attr0 >> 14) & 3;
      if (shape === 3) continue; // the reserved shape draws nothing
      const [width, height] = (OBJ_SIZE[shape] as readonly (readonly [number, number])[])[
        (attr1 >> 14) & 3
      ] as readonly [number, number];

      // Y is eight bits, so an object near the bottom of the screen is expressed
      // as one that wraps past it.
      let top = attr0 & 0xff;
      if (top + height > 256) top -= 256;
      const row = line - top;
      if (row < 0 || row >= height) continue;

      if (budget < width) break;
      budget -= width;

      let left = attr1 & 0x1ff;
      if (left >= 256) left -= 512;
      const deep = (attr0 & 0x2000) !== 0;
      const priority = (attr2 >> 10) & 3;
      const bank = (attr2 >> 12) & 0xf;
      const flipX = (attr1 & 0x1000) !== 0;
      const flipY = (attr1 & 0x2000) !== 0;
      const sourceRow = flipY ? height - 1 - row : row;

      // In one-dimensional mapping an object's tiles are consecutive; in
      // two-dimensional they sit in a 32-tile-wide grid, and 256-colour tiles
      // take two of its slots each.
      const unitsPerTile = deep ? 2 : 1;
      const stride = oneDimensional ? (width >> 3) * unitsPerTile : 32;
      const rowBase = (attr2 & 0x3ff) + (sourceRow >> 3) * stride;

      for (let offset = 0; offset < width; offset += 1) {
        const x = left + offset;
        if (x < 0 || x >= this.width) continue;
        const existing = this.objLine[x] as number;
        // Attribute order is the priority among objects: an earlier entry that
        // already painted this pixel keeps it, whatever its layer priority.
        if (existing >= 0) continue;
        const sourceColumn = flipX ? width - 1 - offset : offset;
        const unit = rowBase + (sourceColumn >> 3) * unitsPerTile;
        const inTileRow = sourceRow & 7;
        const inTileColumn = sourceColumn & 7;
        let colour: number;
        if (deep) {
          colour = this.objVram[unit * 32 + inTileRow * 8 + inTileColumn] as number;
        } else {
          const byte = this.objVram[unit * 32 + inTileRow * 4 + (inTileColumn >> 1)] as number;
          const nibble = (inTileColumn & 1) !== 0 ? byte >> 4 : byte & 0xf;
          colour = nibble === 0 ? 0 : (bank << 4) | nibble;
        }
        if (colour === 0) continue;
        this.objLine[x] = colour;
        this.objPriority[x] = priority;
      }
    }
  }

  /** The picture, rendered from the registers as they stand. */
  view(): Frame {
    this.render();
    return { pixels: this.pixels, width: this.width, height: this.height };
  }
}
