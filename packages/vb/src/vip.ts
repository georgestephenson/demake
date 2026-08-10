/**
 * The Virtual Boy's video processor — and the only renderer in this project
 * that draws every scene **twice**.
 *
 * The VIP is two units on one die: a *drawing* processor that fills framebuffers
 * from a display list, and a *display* processor that scans them out to two LED
 * arrays, one an eye. What makes it unlike every other picture hardware in the
 * matrix is that the display list carries a **depth**: a world names where it
 * goes on the screen and how far apart its two eyes' copies are pulled, and an
 * object carries the same field for itself. Nothing else here has a third axis
 * at all.
 *
 * Five things about it decide the shape of this file.
 *
 *   - **A parallax is a signed pixel shift applied in opposite directions.** The
 *     left eye's copy goes at `X − P` and the right eye's at `X + P`, so a
 *     positive parallax pulls the two apart (uncrossed disparity — the layer
 *     reads as *behind* the display plane) and a negative one crosses them, which
 *     reads as *in front*. {@link VB_NEARER} is that sign with a name on it, and
 *     it has exactly one definition because a project with two would have its
 *     scenery in front of its sprites on one of them.
 *   - **A framebuffer is columns.** 384 of them, 256 pixels at two bits each, so
 *     a column is 64 bytes and consecutive bytes are *vertical* neighbours. A
 *     reader that walked it row-major would produce noise rather than a wrong
 *     picture, which is why {@link vbFramebufferBit} has one definition in
 *     `@demake/core` and both this file and the E2E read through it.
 *   - **Pixel value 0 is transparent, on both layers.** It shows `BKCOL`, so a
 *     palette holds three colours and not four — the NES's shared backdrop
 *     reached by different hardware, and the reason {@link vbShade} exists: on
 *     this display shade 0 is the LEDs being *off*, which is the opposite end of
 *     the ramp from where every other mono console in this project puts index 0.
 *   - **The display list ends where it says it does.** Worlds are processed from
 *     31 down to 0 and the one with `END` set stops the processor, so a scene
 *     costs what it uses. A program that omitted the marker would have the
 *     hardware draw thirty more worlds of whatever was in memory.
 *   - **Objects are drawn in groups, and which group is positional.** The
 *     drawing processor keeps a counter that starts at 3 and steps down each
 *     time it meets an object world, and `SPT0`–`SPT3` say where each group
 *     ends. So "which objects does this world draw" is decided by how many
 *     object worlds came before it, not by anything in the world itself.
 *
 * What is **absent rather than half-implemented**: the affine and h-bias world
 * modes (a demade cartridge draws neither), the LED brightness curve — `BRTA`,
 * `BRTB` and `BRTC` are stored, and all three being zero blanks the screen,
 * because a cartridge that forgets to set them is dark on the hardware and this
 * model must not hide that; but the intensity *between* them is the spec's own
 * ramp rather than a curve no reference this project could reach pins down — and
 * the column tables, which are LED scan timing a demade cartridge never changes.
 *
 * Sources: the Virtual Boy *Sacred Tech Scroll* (`vbtech`) — the drawing
 * procedure, world and object formats; Planet Virtual Boy — *VIP* wiki page.
 */

import {
  VB_BGMAP,
  VB_BGMAP_BYTES,
  VB_CHR_MIRROR,
  VB_FB_COLUMN,
  VB_FB_L0,
  VB_FB_L1,
  VB_FB_R0,
  VB_FB_R1,
  VB_OAM,
  VB_OBJ_BYTES,
  VB_SCREEN_H,
  VB_SCREEN_W,
  VB_WORLDS,
  VB_WORLD_BGM_OBJ,
  VB_WORLD_BYTES,
  VB_WORLD_COUNT,
  VB_WORLD_END,
  VB_WORLD_LON,
  VB_WORLD_OVR,
  VB_WORLD_RON,
  vbFramebufferBit,
  vbShade,
  VB_DEPTH,
  VB_NEARER_SIGN,
  vbParallax,
} from "@demake/core";

export { vbShade, VB_DEPTH, vbParallax };

/** Bytes of video memory the drawing processor addresses. */
export const VRAM_SIZE = 0x40000;

/** Where the register page begins, and how many bytes of it there are. */
const REGS_BASE = 0x0005f800;
const REGS_SIZE = 0x80;

/** Which eye a draw or a read is about. */
export type Eye = "left" | "right";

/**
 * The sign a parallax takes to put a layer in front of the display plane.
 *
 * `@demake/core`'s, re-exported rather than restated: it is a fact about the
 * hardware and it has readers on both sides of the package boundary — this
 * renderer, the display-ROM builder, and the depth ladder {@link VB_DEPTH}
 * itself. Two definitions would put a cartridge's sprites behind its scenery on
 * whichever of them was wrong.
 */
/**
 * One eye's picture, in pixels.
 *
 * Named the way every other core here names it, because the page's screen table
 * reads it — and *one eye's* rather than the pair's, since a browser canvas is
 * not a stereoscope and this display has no second hue to build an anaglyph out
 * of. What the page shows is the left eye, which is what every screenshot of
 * this console has ever been.
 */
export const SCREEN_WIDTH = VB_SCREEN_W;
export const SCREEN_HEIGHT = VB_SCREEN_H;

export const VB_NEARER = VB_NEARER_SIGN;

/**
 * The four shades, in the **hardware's** order: index 0 is the LEDs being off.
 *
 * The console spec's ramp runs the other way — index 0 is the brightest shade,
 * because that is where every mono console in this project puts the lightest
 * one, and a fit's index 0 is its lightest. So the two are reverses of each
 * other, `packages/vb/test/vip.test.ts` pins that against the spec, and
 * {@link vbShade} is the one place the reversal happens.
 *
 * The spacing is uneven because it is *measured* rather than derived: the spec's
 * ramp reproduces what beetle-vb puts on screen at the brightness a demade
 * cartridge programs, and that emulator applies a gamma to the LED intensities.
 * An evenly spaced ramp would fail the pixel-perfect E2E on every mid-tone.
 */
export const VB_SHADES: readonly number[] = [0, 135, 185, 254];

/** A world attribute entry, as the drawing processor reads it. */
interface World {
  head: number;
  gx: number;
  gp: number;
  gy: number;
  mx: number;
  mp: number;
  my: number;
  w: number;
  h: number;
  overplane: number;
}

export class Vip {
  /** `$00000`–`$3FFFF`: framebuffers, characters, BGMaps, worlds and objects. */
  readonly vram = new Uint8Array(VRAM_SIZE);

  /** The register page at `$5F800`. */
  readonly regs = new Uint16Array(REGS_SIZE / 2);

  /** Which framebuffer pair the drawing processor is filling. */
  private bank = 0;

  /**
   * One rendered picture per eye.
   *
   * Two buffers rather than one, and it is this console's own hazard: every
   * other core here has a single framebuffer, so returning the same array twice
   * is ordinary. Here a caller's whole reason to render is to *compare* the two
   * — which is what a depth assertion is — and one shared buffer makes them
   * trivially identical, so a layer standing off the display plane reads as a
   * layer that is not there.
   */
  private readonly rgba: Record<Eye, Uint8ClampedArray> = {
    left: new Uint8ClampedArray(VB_SCREEN_W * VB_SCREEN_H * 4),
    right: new Uint8ClampedArray(VB_SCREEN_W * VB_SCREEN_H * 4),
  };

  constructor() {
    this.reset();
  }

  reset(): void {
    this.vram.fill(0);
    this.regs.fill(0);
    this.bank = 0;
  }

  // --- the address space --------------------------------------------------

  /**
   * Where an address lands in {@link vram}, or −1 if it is a register.
   *
   * The one interesting case is the character mirror: characters live in four
   * 8 KiB blocks with the framebuffers between them, *and* end to end at
   * `$78000`. A program uploads through the mirror because that is one loop
   * rather than four, and this is where the two views are reconciled.
   */
  private map(address: number): number {
    const at = address & 0x7ffff;
    if (at >= VB_CHR_MIRROR) {
      const offset = at - VB_CHR_MIRROR;
      return 0x6000 + (offset >> 13) * 0x8000 + (offset & 0x1fff);
    }
    if (at >= REGS_BASE && at < REGS_BASE + REGS_SIZE) return -1;
    return at & (VRAM_SIZE - 1);
  }

  read(address: number): number {
    const at = this.map(address);
    if (at >= 0) return this.vram[at] as number;
    const index = ((address & 0x7ffff) - REGS_BASE) >> 1;
    const word = this.regs[index] as number;
    return (address & 1) === 0 ? word & 0xff : (word >> 8) & 0xff;
  }

  write(address: number, value: number): void {
    const at = this.map(address);
    if (at >= 0) {
      this.vram[at] = value & 0xff;
      return;
    }
    const offset = (address & 0x7ffff) - REGS_BASE;
    const index = offset >> 1;
    const word = this.regs[index] as number;
    this.regs[index] =
      (address & 1) === 0
        ? ((word & 0xff00) | (value & 0xff)) & 0xffff
        : ((word & 0x00ff) | ((value & 0xff) << 8)) & 0xffff;
  }

  /** A register, by its address. */
  reg(address: number): number {
    return this.regs[((address & 0x7ffff) - REGS_BASE) >> 1] as number;
  }

  /** Set a register, by its address. */
  setReg(address: number, value: number): void {
    this.regs[((address & 0x7ffff) - REGS_BASE) >> 1] = value & 0xffff;
  }

  private half(at: number): number {
    return (this.vram[at] as number) | ((this.vram[at + 1] as number) << 8);
  }

  // --- drawing ---------------------------------------------------------------

  /**
   * Fill both eyes' framebuffers from the display list.
   *
   * Called once a game frame by the machine around it. The two framebuffer pairs
   * alternate, exactly as the hardware's do — a program that reads `XPSTTS` to
   * find out which one it may touch gets an answer that changes.
   */
  drawFrame(): void {
    this.bank ^= 1;
    const left = this.bank === 0 ? VB_FB_L0 : VB_FB_L1;
    const right = this.bank === 0 ? VB_FB_R0 : VB_FB_R1;
    const backdrop = this.reg(0x0005f870) & 3;
    this.clear(left, backdrop);
    this.clear(right, backdrop);

    // The object-group counter starts at 3 and steps down each time an object
    // world is met — so which objects a world draws is decided by its position
    // in the list rather than by anything in the world itself.
    let group = 3;
    for (let index = VB_WORLD_COUNT - 1; index >= 0; index -= 1) {
      const base = VB_WORLDS + index * VB_WORLD_BYTES;
      const head = this.half(base);
      if ((head & VB_WORLD_END) !== 0) break;
      const isObject = (head & 0x3000) === VB_WORLD_BGM_OBJ;
      if (isObject) {
        if ((head & (VB_WORLD_LON | VB_WORLD_RON)) !== 0) {
          this.drawObjects(group, left, right);
        }
        group = (group - 1) & 3;
        continue;
      }
      if ((head & (VB_WORLD_LON | VB_WORLD_RON)) === 0) continue;
      const world: World = {
        head,
        gx: signed16(this.half(base + 2)),
        gp: signed16(this.half(base + 4)),
        gy: signed16(this.half(base + 6)),
        mx: signed16(this.half(base + 8)),
        mp: signed16(this.half(base + 10)),
        my: signed16(this.half(base + 12)),
        w: signed16(this.half(base + 14)),
        h: signed16(this.half(base + 16)),
        overplane: this.half(base + 20),
      };
      if ((head & VB_WORLD_LON) !== 0) this.drawWorld(world, left, -1);
      if ((head & VB_WORLD_RON) !== 0) this.drawWorld(world, right, +1);
    }
  }

  /** Fill a framebuffer with one shade, which is what `BKCOL` names. */
  private clear(base: number, shade: number): void {
    const byte = shade | (shade << 2) | (shade << 4) | (shade << 6);
    this.vram.fill(byte, base, base + VB_SCREEN_W * VB_FB_COLUMN);
  }

  /**
   * Draw one BGMap world into one eye.
   *
   * `sign` is +1 for the right eye and −1 for the left, which is the whole of
   * this console's depth: it decides both where the copy goes *and* where in the
   * map it is taken from, and a world that sets `MP` equal to `GP` therefore
   * shows the same pixels at two positions rather than two different pixels.
   */
  private drawWorld(world: World, fb: number, sign: number): void {
    const scx = (world.head >> 10) & 3;
    const scy = (world.head >> 8) & 3;
    const over = (world.head & VB_WORLD_OVR) !== 0;
    const mapsX = 1 << scx;
    const mapsY = 1 << scy;
    const base = world.head & 0x0f;
    const destX = world.gx + sign * world.gp;
    const srcX = world.mx + sign * world.mp;

    for (let dy = 0; dy <= world.h; dy += 1) {
      const y = world.gy + dy;
      if (y < 0 || y >= VB_SCREEN_H) continue;
      const sy = world.my + dy;
      for (let dx = 0; dx <= world.w; dx += 1) {
        const x = destX + dx;
        if (x < 0 || x >= VB_SCREEN_W) continue;
        const pixel = this.mapPixel(base, mapsX, mapsY, over, world.overplane, srcX + dx, sy);
        if (pixel === 0) continue;
        this.plot(
          fb,
          x,
          y,
          (this.reg(0x0005f860 + ((this.lastPalette & 3) << 1)) >> (pixel * 2)) & 3,
        );
      }
    }
  }

  /** The sub-palette the last {@link mapPixel} came from. */
  private lastPalette = 0;

  /**
   * One pixel of a world's map, and the sub-palette it names.
   *
   * A BGMap entry carries its own palette, so there is no attribute table
   * anywhere on this console — the PC Engine's arrangement at a quarter of the
   * depth. The palette travels back through {@link lastPalette} rather than in
   * the return value because the caller needs the *pixel* on every iteration and
   * the palette only when the pixel is not transparent.
   */
  private mapPixel(
    base: number,
    mapsX: number,
    mapsY: number,
    over: boolean,
    overplane: number,
    x: number,
    y: number,
  ): number {
    const width = mapsX * 512;
    const height = mapsY * 512;
    let entry: number;
    if (over && (x < 0 || y < 0 || x >= width || y >= height)) {
      entry = overplane;
    } else {
      const mx = ((x % width) + width) % width;
      const my = ((y % height) + height) % height;
      const map = (base + (my >> 9) * mapsX + (mx >> 9)) & 0x0f;
      const cell = ((my >> 3) & 63) * 64 + ((mx >> 3) & 63);
      entry = this.half(VB_BGMAP + map * VB_BGMAP_BYTES + cell * 2);
    }
    this.lastPalette = (entry >> 14) & 3;
    return this.charPixel(entry & 0x07ff, x & 7, y & 7, (entry >> 12) & 1, (entry >> 13) & 1);
  }

  /** One pixel of a character, with the two flips applied. */
  private charPixel(character: number, x: number, y: number, hflip: number, vflip: number): number {
    const cx = hflip ? 7 - x : x;
    const cy = vflip ? 7 - y : y;
    // Characters are four 8 KiB blocks with the framebuffers between them.
    const offset = character * 16 + cy * 2;
    const at = 0x6000 + ((offset >> 13) << 15) + (offset & 0x1fff);
    const row = (this.vram[at] as number) | ((this.vram[at + 1] as number) << 8);
    return (row >> (cx * 2)) & 3;
  }

  /**
   * Draw one object group into both eyes.
   *
   * Descending, from the group's last object to its first, so a *lower*-numbered
   * object is drawn later and therefore appears in front — which is the opposite
   * of the order the worlds themselves are processed in and the sort of thing
   * that is only ever wrong in one direction.
   */
  private drawObjects(group: number, left: number, right: number): void {
    const end = this.reg(0x0005f848 + group * 2) & 0x3ff;
    const start = group === 0 ? 0 : ((this.reg(0x0005f848 + (group - 1) * 2) & 0x3ff) + 1) & 0x3ff;
    for (let index = end; index >= start; index -= 1) {
      const base = VB_OAM + index * VB_OBJ_BYTES;
      const jx = (this.half(base) << 22) >> 22;
      const word = this.half(base + 2);
      const jp = (word << 18) >> 18;
      const jy = this.half(base + 4) & 0xff;
      const attr = this.half(base + 6);
      const character = attr & 0x07ff;
      const hflip = (attr >> 13) & 1;
      const vflip = (attr >> 12) & 1;
      const palette = this.reg(0x0005f868 + (((attr >> 14) & 3) << 1));
      if ((word & 0x4000) !== 0)
        this.drawObject(left, jx - jp, jy, character, hflip, vflip, palette);
      if ((word & 0x8000) !== 0) {
        this.drawObject(right, jx + jp, jy, character, hflip, vflip, palette);
      }
    }
  }

  private drawObject(
    fb: number,
    x0: number,
    y0: number,
    character: number,
    hflip: number,
    vflip: number,
    palette: number,
  ): void {
    for (let dy = 0; dy < 8; dy += 1) {
      const y = y0 + dy;
      if (y < 0 || y >= VB_SCREEN_H) continue;
      for (let dx = 0; dx < 8; dx += 1) {
        const x = x0 + dx;
        if (x < 0 || x >= VB_SCREEN_W) continue;
        const pixel = this.charPixel(character, dx, dy, hflip, vflip);
        if (pixel === 0) continue;
        this.plot(fb, x, y, (palette >> (pixel * 2)) & 3);
      }
    }
  }

  private plot(fb: number, x: number, y: number, shade: number): void {
    const { byte, shift } = vbFramebufferBit(x, y);
    const at = fb + byte;
    this.vram[at] = (((this.vram[at] as number) & ~(3 << shift)) | ((shade & 3) << shift)) & 0xff;
  }

  // --- display ---------------------------------------------------------------

  /** Whether the display processor is putting anything on the LEDs. */
  private get lit(): boolean {
    if ((this.reg(0x0005f822) & 0x0002) === 0) return false;
    // All three brightness registers at zero is a dark screen, which is what a
    // cartridge that forgot to set them gets on the hardware. The intensities
    // *between* them are not modelled — see this file's header.
    return (this.reg(0x0005f824) | this.reg(0x0005f826) | this.reg(0x0005f828)) !== 0;
  }

  /**
   * One eye's picture as RGBA — the framebuffer the display is *showing*.
   *
   * Which is the one just finished, not the one being filled: the two pairs
   * alternate, and a frame becomes visible when the drawing processor has done
   * with it. A model that read the *other* one would be a frame behind for ever,
   * which reads as a runtime that never draws anything.
   */
  render(eye: Eye = "left"): Uint8ClampedArray {
    const base = this.shownBuffer(eye);
    const rgba = this.rgba[eye];
    const lit = this.lit;
    let out = 0;
    for (let y = 0; y < VB_SCREEN_H; y += 1) {
      for (let x = 0; x < VB_SCREEN_W; x += 1) {
        const { byte, shift } = vbFramebufferBit(x, y);
        const shade = lit ? ((this.vram[base + byte] as number) >> shift) & 3 : 0;
        rgba[out] = VB_SHADES[shade] as number;
        rgba[out + 1] = 0;
        rgba[out + 2] = 0;
        rgba[out + 3] = 255;
        out += 4;
      }
    }
    return rgba;
  }

  /** Which framebuffer the display is putting on one eye's LEDs. */
  private shownBuffer(eye: Eye): number {
    if (eye === "left") return this.bank === 0 ? VB_FB_L0 : VB_FB_L1;
    return this.bank === 0 ? VB_FB_R0 : VB_FB_R1;
  }

  /** The raw two-bit picture one eye is being shown, one byte a pixel. */
  shades(eye: Eye = "left"): Uint8Array {
    const base = this.shownBuffer(eye);
    const out = new Uint8Array(VB_SCREEN_W * VB_SCREEN_H);
    for (let y = 0; y < VB_SCREEN_H; y += 1) {
      for (let x = 0; x < VB_SCREEN_W; x += 1) {
        const { byte, shift } = vbFramebufferBit(x, y);
        out[y * VB_SCREEN_W + x] = ((this.vram[base + byte] as number) >> shift) & 3;
      }
    }
    return out;
  }
}

function signed16(value: number): number {
  return (value << 16) >> 16;
}
