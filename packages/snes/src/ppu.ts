/**
 * The S-PPU, as far as a Demotic cartridge uses it.
 *
 * The counterpart of `@demake/nes`'s `Ppu` and `@demake/sms`'s `Vdp`, and its
 * scope is set the same way: what the generated runtime actually programs.
 * **Mode 1's BG1 and the object layer**, which is what `demake build -c snes`
 * emits — the other three backgrounds, the two extra modes with them, colour
 * maths, windows, mosaic and offset-per-tile are absent rather than
 * half-implemented, because a renderer that answers plausibly for hardware
 * nothing drives is a renderer nobody is checking.
 *
 * Four of this chip's facts are load-bearing here, and each is a place a
 * plausible implementation is quietly wrong:
 *
 *   - **The background is scrolled one line late.** Screen line `N` shows
 *     background line `BG1VOFS + N + 1`, so a game that wants its picture where
 *     it drew it writes `-1`. That is not a quirk of any one emulator: it is what
 *     the chip does, it is why the image E2E's harness sets `$3FF`, and modelling
 *     it the obvious way puts every scene one pixel high.
 *   - **A tilemap is a grid of 32×32 screens, not a rectangle.** A 64×32 map is
 *     *two* 32×32 blocks a kilobyte apart, so column 32 is not one word past
 *     column 31 — it is `$400` words past column 0. The runtime relies on the
 *     wider map for scrolling, so getting this wrong shows up as a level whose
 *     right half is its left half.
 *   - **A 4bpp tile is two 2bpp tiles stacked.** Planes 0 and 1 interleave down
 *     the rows for sixteen bytes and then planes 2 and 3 do, which is why the
 *     sprite path has a `pairs` packing that is neither `planar` nor `grouped`.
 *   - **Object priority is by OAM index and it runs the other way.** Entry zero
 *     is in front, so a naive front-to-back paint draws the wrong sprite on top —
 *     and the per-line cap picks its thirty-two by scanning *forward*, which means
 *     the sprites that get dropped are not the ones that lose the priority fight.
 *
 * Sources: SNESdev Wiki — Backgrounds (https://snes.nesdev.org/wiki/Backgrounds),
 * Objects (https://snes.nesdev.org/wiki/Objects), CGRAM
 * (https://snes.nesdev.org/wiki/CGRAM) and PPU registers
 * (https://snes.nesdev.org/wiki/PPU_registers).
 */

/** The visible picture, in pixels. */
export const SCREEN_WIDTH = 256;
export const SCREEN_HEIGHT = 224;

/** Master cycles in one scanline, and scanlines in one NTSC frame. */
export const MASTER_PER_LINE = 1364;
export const LINES_PER_FRAME = 262;

/** The first scanline of the vertical blank, in a 224-line picture. */
export const VBLANK_LINE = 225;

/** Objects the hardware will evaluate on one scanline. */
export const OBJECTS_PER_LINE = 32;

/** Which of the two sizes an object entry's size bit selects, in pixels. */
const OBJECT_SIZES: readonly (readonly [number, number])[] = [
  [8, 16],
  [8, 32],
  [8, 64],
  [16, 32],
  [16, 64],
  [32, 64],
  [16, 32],
  [16, 32],
];

export class Ppu {
  /** 64 KiB of video RAM, which the chip addresses as 32768 words. */
  readonly vram = new Uint16Array(0x8000);
  /** 256 colours of BGR555. */
  readonly cgram = new Uint16Array(0x100);
  /** 128 object entries of four bytes, then the 32-byte high table. */
  readonly oam = new Uint8Array(544);
  /** The picture, as RGBA. */
  readonly framebuffer = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);

  /** Frames whose vertical blank has begun. */
  frames = 0;
  /** Whether the chip is in the vertical blank right now. */
  vblank = false;
  /** Raised when the vertical blank begins; the machine turns it into an NMI. */
  vblankStarted = false;

  /** Scanline being generated, and how far into it in master cycles. */
  line = 0;
  private clock = 0;

  // --- registers -------------------------------------------------------------

  /** `$2100`: forced blank in bit 7, brightness in bits 0–3. */
  private iniDisp = 0x8f;
  /** `$2101`: object sizes, name select, and the object character base. */
  private obsel = 0;
  /** `$2107`: BG1's tilemap base and its size in screens. */
  private bg1sc = 0;
  /** `$210B`: BG1's character base, in 4096-word units. */
  private bg12nba = 0;
  /**
   * `$210D`/`$210E`: BG1's scroll, ten bits each, written a byte at a time.
   *
   * Two latches rather than one, because the chip has two: every scroll register
   * shares `ofsLatch`, and the *horizontal* ones keep a second latch of their own
   * for the low three bits. Writing low then high produces the value the caller
   * meant either way — which is the only sequence anything emits — but modelling
   * one latch would make an interleaved write silently right for `VOFS` and
   * silently wrong for `HOFS`.
   */
  private bg1hofs = 0;
  private bg1vofs = 0;
  private ofsLatch = 0;
  private hofsLatch = 0;
  /** `$2115`: video-RAM address increment. */
  private vmain = 0;
  /** `$2116`/`$2117`: the video-RAM word address. */
  private vmadd = 0;
  /** `$2121`: the colour-RAM index, and the byte-pair toggle that follows it. */
  private cgadd = 0;
  private cgLatch = 0;
  private cgHigh = false;
  /** `$2102`/`$2103`: the object-RAM word address, and its byte toggle. */
  private oamAddr = 0;
  private oamHigh = false;
  private oamLatch = 0;
  /** `$212C`: which layers reach the main screen. */
  private mainScreen = 0;

  /** Scratch for one scanline: the colour index and the layer that won it. */
  private readonly rowColor = new Uint16Array(SCREEN_WIDTH);
  private readonly rowRank = new Uint8Array(SCREEN_WIDTH);
  /** Objects the current scanline evaluated, in OAM order. */
  private readonly lineObjects = new Int32Array(OBJECTS_PER_LINE);

  // --- registers -------------------------------------------------------------

  writeRegister(address: number, value: number): void {
    const byte = value & 0xff;
    switch (address & 0xffff) {
      case 0x2100:
        this.iniDisp = byte;
        return;
      case 0x2101:
        this.obsel = byte;
        return;
      case 0x2102:
        this.oamAddr = (this.oamAddr & 0x100) | byte;
        this.oamHigh = false;
        return;
      case 0x2103:
        this.oamAddr = (this.oamAddr & 0xff) | ((byte & 1) << 8);
        this.oamHigh = false;
        return;
      case 0x2104:
        this.writeOam(byte);
        return;
      case 0x2105:
        // The background mode. Only mode 1 is rendered, and the runtime programs
        // nothing else — a mode this chip has and this renderer does not is a gap
        // stated in the header rather than a byte quietly kept.
        return;
      case 0x2107:
        this.bg1sc = byte;
        return;
      case 0x210b:
        this.bg12nba = byte;
        return;
      case 0x210d:
        // Ten bits through an eight-bit port: the two latches supply the low half
        // from whatever was written last, so low-then-high produces the value the
        // caller meant.
        this.bg1hofs = ((byte << 8) | (this.ofsLatch & 0xf8) | (this.hofsLatch & 0x07)) & 0x3ff;
        this.ofsLatch = byte;
        this.hofsLatch = byte;
        return;
      case 0x210e:
        this.bg1vofs = ((byte << 8) | this.ofsLatch) & 0x3ff;
        this.ofsLatch = byte;
        return;
      case 0x2115:
        this.vmain = byte;
        return;
      case 0x2116:
        this.vmadd = (this.vmadd & 0xff00) | byte;
        return;
      case 0x2117:
        this.vmadd = (this.vmadd & 0x00ff) | (byte << 8);
        return;
      case 0x2118: {
        const word = this.vmadd & 0x7fff;
        this.vram[word] = ((this.vram[word] as number) & 0xff00) | byte;
        if ((this.vmain & 0x80) === 0) this.stepVram();
        return;
      }
      case 0x2119: {
        const word = this.vmadd & 0x7fff;
        this.vram[word] = ((this.vram[word] as number) & 0x00ff) | (byte << 8);
        if ((this.vmain & 0x80) !== 0) this.stepVram();
        return;
      }
      case 0x2121:
        this.cgadd = byte;
        this.cgHigh = false;
        return;
      case 0x2122:
        if (!this.cgHigh) {
          this.cgLatch = byte;
          this.cgHigh = true;
          return;
        }
        this.cgram[this.cgadd & 0xff] = ((byte & 0x7f) << 8) | this.cgLatch;
        this.cgadd = (this.cgadd + 1) & 0xff;
        this.cgHigh = false;
        return;
      case 0x212c:
        this.mainScreen = byte;
        return;
      default:
        // Everything else this chip has, the runtime does not program. Ignoring
        // it is the honest answer: a register nothing writes cannot be wrong, and
        // a register something writes has a case above.
        return;
    }
  }

  readRegister(address: number): number {
    switch (address & 0xffff) {
      case 0x2138: {
        const byte = (this.oam[this.oamAddr * 2 + (this.oamHigh ? 1 : 0)] ?? 0) as number;
        this.stepOam();
        return byte;
      }
      case 0x2139: {
        const word = this.vram[this.vmadd & 0x7fff] as number;
        if ((this.vmain & 0x80) === 0) this.stepVram();
        return word & 0xff;
      }
      case 0x213a: {
        const word = this.vram[this.vmadd & 0x7fff] as number;
        if ((this.vmain & 0x80) !== 0) this.stepVram();
        return (word >> 8) & 0xff;
      }
      case 0x213b: {
        const word = this.cgram[this.cgadd & 0xff] as number;
        const byte = this.cgHigh ? (word >> 8) & 0x7f : word & 0xff;
        if (this.cgHigh) this.cgadd = (this.cgadd + 1) & 0xff;
        this.cgHigh = !this.cgHigh;
        return byte;
      }
      default:
        return 0;
    }
  }

  /** Write one byte into object RAM through the port's own latch. */
  private writeOam(byte: number): void {
    if (this.oamAddr >= 0x100) {
      // The high table has no latch: a byte written there lands immediately,
      // which is what lets a 32-byte block copy fill it.
      const at = 0x200 + (this.oamAddr & 0x0f) * 2 + (this.oamHigh ? 1 : 0);
      if (at < this.oam.length) this.oam[at] = byte;
      this.stepOam();
      return;
    }
    if (!this.oamHigh) {
      this.oamLatch = byte;
      this.oamHigh = true;
      return;
    }
    this.oam[this.oamAddr * 2] = this.oamLatch;
    this.oam[this.oamAddr * 2 + 1] = byte;
    this.oamAddr = (this.oamAddr + 1) & 0x1ff;
    this.oamHigh = false;
  }

  private stepOam(): void {
    if (this.oamHigh) {
      this.oamAddr = (this.oamAddr + 1) & 0x1ff;
      this.oamHigh = false;
      return;
    }
    this.oamHigh = true;
  }

  /** Advance the video-RAM address by whatever `VMAIN` asked for. */
  private stepVram(): void {
    const step = [1, 32, 128, 128][this.vmain & 3] as number;
    this.vmadd = (this.vmadd + step) & 0xffff;
  }

  /** Write one byte to a data port, which is how the DMA controller reaches it. */
  writePort(low: number, value: number): void {
    this.writeRegister(0x2100 | (low & 0xff), value);
  }

  readPort(low: number): number {
    return this.readRegister(0x2100 | (low & 0xff));
  }

  // --- timing ----------------------------------------------------------------

  /** Advance by `master` master-clock cycles, rendering the lines it crosses. */
  step(master: number): void {
    this.clock += master;
    while (this.clock >= MASTER_PER_LINE) {
      this.clock -= MASTER_PER_LINE;
      this.finishLine();
    }
  }

  private finishLine(): void {
    // Screen row `line - 1`: scanline zero is the pre-render line, so the first
    // visible row is generated on scanline one.
    if (this.line >= 1 && this.line <= SCREEN_HEIGHT) this.renderRow(this.line - 1);
    this.line += 1;
    if (this.line === VBLANK_LINE) {
      this.vblank = true;
      this.vblankStarted = true;
      this.frames += 1;
      return;
    }
    if (this.line >= LINES_PER_FRAME) {
      this.line = 0;
      this.vblank = false;
    }
  }

  // --- rendering -------------------------------------------------------------

  /**
   * Layer ranks, front to back, for mode 1 with BG1 and objects.
   *
   * The chip's own ordering with the layers this renderer does not have removed:
   * an object at priority 3 is in front of everything, BG1's high-priority cells
   * come next, and an object at priority 0 is behind BG1 entirely. Lower is
   * nearer, and `RANK_NONE` is "nothing has claimed this pixel".
   */
  private static readonly RANK_NONE = 0xff;
  private static readonly RANK_OBJ = [8, 6, 4, 1] as const;
  private static readonly RANK_BG1 = [5, 2] as const;

  private renderRow(y: number): void {
    const out = y * SCREEN_WIDTH * 4;
    if ((this.iniDisp & 0x80) !== 0) {
      // Forced blank: the screen is black whatever is in memory, which is the
      // state a full redraw paints under.
      for (let x = 0; x < SCREEN_WIDTH; x += 1) {
        const at = out + x * 4;
        this.framebuffer[at] = 0;
        this.framebuffer[at + 1] = 0;
        this.framebuffer[at + 2] = 0;
        this.framebuffer[at + 3] = 255;
      }
      return;
    }

    this.rowColor.fill(this.cgram[0] as number);
    this.rowRank.fill(Ppu.RANK_NONE);
    if ((this.mainScreen & 0x01) !== 0) this.renderBackground(y);
    if ((this.mainScreen & 0x10) !== 0) this.renderObjects(y);

    const brightness = this.iniDisp & 0x0f;
    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      const colour = this.rowColor[x] as number;
      const at = out + x * 4;
      this.framebuffer[at] = expand(colour & 0x1f, brightness);
      this.framebuffer[at + 1] = expand((colour >> 5) & 0x1f, brightness);
      this.framebuffer[at + 2] = expand((colour >> 10) & 0x1f, brightness);
      this.framebuffer[at + 3] = 255;
    }
  }

  /** BG1, 4bpp, through whichever of the four screen arrangements is selected. */
  private renderBackground(y: number): void {
    const mapBase = (this.bg1sc & 0xfc) << 8;
    const wide = (this.bg1sc & 0x01) !== 0;
    const tall = (this.bg1sc & 0x02) !== 0;
    const charBase = (this.bg12nba & 0x0f) << 12;
    const width = wide ? 512 : 256;
    const height = tall ? 512 : 256;
    // The one-line offset: screen line `y` shows background line `vofs + y + 1`.
    const bgY = (this.bg1vofs + y + 1) & (height - 1);
    const mapRow = (bgY >> 3) & 31;
    const rowInTile = bgY & 7;
    const tallHalf = tall && (bgY & 0x100) !== 0 ? (wide ? 0x800 : 0x400) : 0;

    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      const bgX = (this.bg1hofs + x) & (width - 1);
      const mapCol = (bgX >> 3) & 31;
      const wideHalf = wide && (bgX & 0x100) !== 0 ? 0x400 : 0;
      const entry = this.vram[
        (mapBase + tallHalf + wideHalf + mapRow * 32 + mapCol) & 0x7fff
      ] as number;
      const priority = (entry >> 13) & 1;
      const rank = Ppu.RANK_BG1[priority] as number;
      if (rank >= (this.rowRank[x] as number)) continue;
      const tile = entry & 0x3ff;
      const flipX = (entry & 0x4000) !== 0;
      const flipY = (entry & 0x8000) !== 0;
      const row = flipY ? 7 - rowInTile : rowInTile;
      const column = flipX ? 7 - (bgX & 7) : bgX & 7;
      const index = this.tilePixel(charBase + tile * 16, row, column);
      if (index === 0) continue;
      this.rowColor[x] = this.cgram[(((entry >> 10) & 7) * 16 + index) & 0xff] as number;
      this.rowRank[x] = rank;
    }
  }

  /** One 4bpp pixel: two plane-pair words, sixteen bytes apart. */
  private tilePixel(wordBase: number, row: number, column: number): number {
    const low = this.vram[(wordBase + row) & 0x7fff] as number;
    const high = this.vram[(wordBase + 8 + row) & 0x7fff] as number;
    const bit = 7 - column;
    return (
      ((low >> bit) & 1) |
      (((low >> (8 + bit)) & 1) << 1) |
      (((high >> bit) & 1) << 2) |
      (((high >> (8 + bit)) & 1) << 3)
    );
  }

  /**
   * The object layer for one scanline.
   *
   * Two passes, and the split is the hardware's rather than a convenience: the
   * per-line cap is filled by scanning OAM *forward* and stopping at
   * thirty-two, while priority runs the other way — entry zero is in front. A
   * single pass that painted as it scanned would drop the wrong sprites and
   * stack the rest upside down.
   */
  private renderObjects(y: number): void {
    const [small, large] = OBJECT_SIZES[(this.obsel >> 5) & 7] as readonly [number, number];
    const base = (this.obsel & 7) << 13;
    const secondPage = base + ((((this.obsel >> 3) & 3) + 1) << 12);

    // Two bits per object in the high table: the low one is the ninth bit of X and
    // the high one chooses between the two sizes `OBSEL` selected.
    const extra = (index: number): number =>
      ((this.oam[0x200 + (index >> 2)] as number) >> ((index & 3) * 2)) & 3;

    let found = 0;
    for (let index = 0; index < 128 && found < OBJECTS_PER_LINE; index += 1) {
      const pixels = (extra(index) & 2) !== 0 ? large : small;
      const top = this.oam[index * 4 + 1] as number;
      // An object's Y wraps at 256, so one near the bottom of the field reappears
      // at the top; the comparison is done in that wrapped space rather than by
      // sign-extending, because the hardware has no sign there.
      const within = (y - top) & 0xff;
      if (within >= pixels) continue;
      this.lineObjects[found] = index;
      found += 1;
    }

    for (let slot = found - 1; slot >= 0; slot -= 1) {
      const index = this.lineObjects[slot] as number;
      const bits = extra(index);
      const pixels = (bits & 2) !== 0 ? large : small;
      const attributes = this.oam[index * 4 + 3] as number;
      const rank = Ppu.RANK_OBJ[(attributes >> 4) & 3] as number;
      const palette = 128 + ((attributes >> 1) & 7) * 16;
      const flipX = (attributes & 0x40) !== 0;
      const flipY = (attributes & 0x80) !== 0;
      const tile = ((attributes & 1) << 8) | (this.oam[index * 4 + 2] as number);
      const rawX = ((bits & 1) << 8) | (this.oam[index * 4] as number);
      const left = rawX >= 256 ? rawX - 512 : rawX;
      const top = this.oam[index * 4 + 1] as number;
      const within = (y - top) & 0xff;
      const row = flipY ? pixels - 1 - within : within;

      for (let offset = 0; offset < pixels; offset += 1) {
        const x = left + offset;
        if (x < 0 || x >= SCREEN_WIDTH) continue;
        // Strictly greater, not "greater or equal": two objects at one priority
        // are separated by their OAM index, and this pass runs *backwards* so
        // that entry zero paints last. An equal-rank pixel must therefore win,
        // which is the opposite of what the background's test wants — there is
        // one background layer and nothing to tie with.
        if (rank > (this.rowRank[x] as number)) continue;
        const column = flipX ? pixels - 1 - offset : offset;
        // The name table is a 16×16 grid of tiles that a large object walks with
        // wrapping, so a sprite at its right-hand edge continues from column zero
        // rather than running into the next row.
        const tileX = ((tile & 0x0f) + (column >> 3)) & 0x0f;
        const tileY = (((tile >> 4) & 0x0f) + (row >> 3)) & 0x0f;
        const number_ = (tile & 0x100) | (tileY << 4) | tileX;
        const wordBase =
          number_ < 0x100 ? base + number_ * 16 : secondPage + (number_ - 0x100) * 16;
        const index4 = this.tilePixel(wordBase, row & 7, column & 7);
        if (index4 === 0) continue;
        this.rowColor[x] = this.cgram[(palette + index4) & 0xff] as number;
        this.rowRank[x] = rank;
      }
    }
  }
}

/** A five-bit channel as eight bits, scaled by the display's brightness. */
function expand(channel: number, brightness: number): number {
  const full = (channel << 3) | (channel >> 2);
  return brightness >= 15 ? full : Math.floor((full * brightness) / 15);
}

/** The size bit of an object entry's two bits in the high table. */
export function objectSizeBit(oam: Uint8Array, index: number): boolean {
  return (((oam[0x200 + (index >> 2)] as number) >> ((index & 3) * 2 + 1)) & 1) !== 0;
}
