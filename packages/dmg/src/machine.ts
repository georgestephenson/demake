/**
 * The Game Boy around the processor: memory map, PPU, APU, timer, and joypad.
 *
 * Enough hardware to run a `demake build` ROM faithfully and nothing more. The
 * PPU is a scanline renderer on the published 456-dot line — mode 2 for 80,
 * mode 3 for 172, mode 0 for the rest, ten lines of VBlank — because a
 * per-scanline picture is what a fixed-tick game needs and a pixel-FIFO would
 * buy accuracy no demade game can observe.
 *
 * **Both machines, decided by the cartridge.** A ROM whose header carries the
 * CGB flag runs as a Game Boy Color: two VRAM banks, eight background and eight
 * object palettes of RGB555, per-cell attributes, and eight WRAM banks. A ROM
 * without it runs as a DMG and is shown on the green LCD ramp the hardware
 * really had. Which one a cartridge gets is never a setting here — it is the
 * header byte, so the machine a player sees is the machine the build targeted.
 *
 * The APU is not implemented here: it is `@demake/chip`'s `GbApu`, the same
 * model the audio pipeline renders previews with (doc 16 §Packages). That is
 * the whole reason the package exists — the preview and the emulator cannot
 * quietly stop agreeing about a chip they share. This module only routes
 * `$FF10`–`$FF3F` to it, and offers the write tap the audio proof reads
 * (§apuTap).
 *
 * Three things are deliberately absent. There is no MBC: a build is 32 KiB, and
 * the day a game needs banking the runtime gains a mapper and this gains the
 * three lines to match. There is no CGB double speed and no HDMA, because the
 * generated runtime programs neither — `KEY1` and the HDMA registers are plain
 * storage, so a ROM that tried would be visibly wrong here rather than subtly
 * wrong. And VRAM is *not* blocked outside VBlank — a real Game Boy drops those
 * writes, and the runtime is written to do its VRAM work in the VBlank window
 * regardless, so modelling the block here would only convert a discipline
 * failure into a mystery. The SameBoy E2E is where that gets caught.
 */

import { GbApu, type SampleSink } from "@demake/chip";

import { type Bus, Cpu, INT } from "./cpu.js";

/** Visible framebuffer size. */
export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 144;

/** T-cycles in one frame: 154 lines × 456 dots. */
export const FRAME_CYCLES = 70224;

/** Joypad buttons, in the order the hardware reports them. */
export const BUTTONS = ["right", "left", "up", "down", "a", "b", "select", "start"] as const;

/** One joypad button. */
export type Button = (typeof BUTTONS)[number];

/**
 * The four DMG shades, lightest first, as the green LCD really showed them.
 *
 * Not grey. The original Game Boy's screen is a reflective green LCD, and the
 * four shades below are the ramp the `dmg` console spec carries as its
 * `mono-ramp` DAC model and the SameBoy capturer compares against — a DAC model
 * is a tested artifact here, not decoration, so the player, the console spec and
 * the pixel-perfect E2E all show the same four colours.
 * `test/ppu.test.ts` pins them against `@demake/core`'s spec.
 */
export const DMG_SHADES: readonly (readonly [number, number, number])[] = [
  [155, 188, 15],
  [139, 172, 15],
  [48, 98, 48],
  [15, 56, 15],
];

/** Sound registers, as offsets from `$FF00`: NR10–NR52, then wave RAM. */
const APU_FIRST = 0x10;
const APU_LAST = 0x3f;

/** Bytes in one VRAM bank; a CGB has two, a DMG one. */
const VRAM_BANK = 0x2000;

/** Bytes in one switchable work-RAM bank; a CGB has seven plus the fixed one. */
const WRAM_BANK = 0x1000;

/** Header byte carrying the CGB flag: `$80` CGB-aware, `$C0` CGB-only. */
const HEADER_CGB = 0x0143;

/**
 * Expand a 5-bit channel to eight bits by bit replication.
 *
 * The CGB's own LCD applies a panel curve on top of this, but that curve is a
 * *simulation* and the author space is the raw expansion (doc 04 §author space)
 * — which is also what the emulator E2E compares against, with SameBoy's colour
 * correction disabled. Showing the raw expansion here keeps the page, the CLI's
 * PNG and the hardware comparison in one colour space.
 */
function expand5(code: number): number {
  const value = code & 31;
  return (value << 3) | (value >> 2);
}

/** A Game Boy with a 32 KiB cartridge in it — DMG or CGB, per the header. */
export class Gameboy implements Bus {
  readonly cpu = new Cpu(this);
  /** The sound hardware — `@demake/chip`'s model, not a second one. */
  readonly apu = new GbApu();
  readonly rom: Uint8Array;
  /** Whether this cartridge asked for Game Boy Color hardware. */
  readonly cgb: boolean;
  /** Both VRAM banks, back to back; a DMG only ever addresses the first. */
  readonly vram = new Uint8Array(VRAM_BANK * 2);
  /** Eight work-RAM banks; a DMG only ever addresses the first two. */
  readonly wram = new Uint8Array(WRAM_BANK * 8);
  readonly oam = new Uint8Array(0xa0);
  readonly hram = new Uint8Array(0x7f);
  readonly io = new Uint8Array(0x80);
  /** CGB palette RAM: eight palettes of four BGR555 colours, low byte first. */
  readonly bgPaletteRam = new Uint8Array(64);
  readonly objPaletteRam = new Uint8Array(64);
  private vramBank = 0;
  private wramBank = 1;
  private interruptEnable = 0;

  /**
   * One byte per pixel: the raw colour index the tile carried, 0–3.
   *
   * On a DMG that is the shade after the palette register has been applied; on
   * a CGB it is the index *within* the cell's palette, and {@link colors} holds
   * what the screen actually shows.
   */
  readonly indices = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  /** BGR555 per pixel, filled only in CGB mode. */
  readonly colors = new Uint16Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  /** RGBA, ready for `putImageData`. */
  readonly framebuffer = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);

  /** Raw background colour indices for the line being drawn, for OBJ priority. */
  private readonly bgRow = new Uint8Array(SCREEN_WIDTH);
  /** CGB: whether the background cell at this pixel asked to sit above objects. */
  private readonly bgAbove = new Uint8Array(SCREEN_WIDTH);
  /** Which pixels of this line an object has already claimed. */
  private readonly objRow = new Uint8Array(SCREEN_WIDTH);
  private dot = 0;
  private divCounter = 0;
  private timerCounter = 0;
  private held = 0;
  /** Frames completed since power-on — the harness's clock. */
  frames = 0;

  /**
   * Called for every write the CPU makes to a sound register.
   *
   * This is the audio conformance oracle's entire interface to the machine
   * (doc 16 §The proof, Level A). It observes rather than intercepts — the
   * write still reaches the APU — because an oracle that changed what the
   * hardware saw would be testing itself.
   */
  apuTap: ((reg: number, value: number) => void) | undefined = undefined;

  /**
   * Where the APU's samples go, when anything is listening.
   *
   * Left unset the chip still receives every write and keeps its state; it is
   * only *rendered* when a sink is attached, so the game conformance suite pays
   * nothing for hardware it never listens to.
   */
  audioSink: SampleSink | undefined = undefined;

  constructor(rom: Uint8Array) {
    this.rom = rom;
    this.cgb = ((rom[HEADER_CGB] ?? 0) & 0x80) !== 0;
    // Post-boot-ROM register state, so a cartridge that assumes the boot ROM ran
    // sees what it expects without us shipping Nintendo's copyrighted code.
    this.io[0x00] = 0xcf;
    this.io[0x05] = 0x00;
    this.io[0x06] = 0x00;
    this.io[0x07] = 0x00;
    this.io[0x0f] = 0xe1;
    this.io[0x40] = 0x91;
    this.io[0x41] = 0x85;
    this.io[0x44] = 0x00;
    this.io[0x47] = 0xfc;
    this.io[0x48] = 0xff;
    this.io[0x49] = 0xff;
    // The one register state a CGB cartridge is entitled to read: the boot ROM
    // leaves `A` at $11, which is how a dual-mode cartridge knows which machine
    // it woke up on.
    if (this.cgb) this.cpu.a = 0x11;
    this.framebuffer.fill(0xff);
  }

  // --- bus -------------------------------------------------------------------

  read(address: number): number {
    const at = address & 0xffff;
    if (at < 0x8000) return this.rom[at] ?? 0xff;
    if (at < 0xa000) return this.vram[this.vramBank * VRAM_BANK + (at - 0x8000)] as number;
    if (at < 0xc000) return 0xff; // no cartridge RAM
    if (at < 0xe000) return this.wram[this.wramOffset(at)] as number;
    if (at < 0xfe00) return this.wram[this.wramOffset(at - 0x2000)] as number; // echo
    if (at < 0xfea0) return this.oam[at - 0xfe00] as number;
    if (at < 0xff00) return 0xff;
    if (at < 0xff80) return this.readIo(at - 0xff00);
    if (at < 0xffff) return this.hram[at - 0xff80] as number;
    return this.interruptEnable;
  }

  write(address: number, value: number): void {
    const at = address & 0xffff;
    const byte = value & 0xff;
    if (at < 0x8000) return; // ROM is read-only; no mapper to poke
    if (at < 0xa000) {
      this.vram[this.vramBank * VRAM_BANK + (at - 0x8000)] = byte;
      return;
    }
    if (at < 0xc000) return;
    if (at < 0xe000) {
      this.wram[this.wramOffset(at)] = byte;
      return;
    }
    if (at < 0xfe00) {
      this.wram[this.wramOffset(at - 0x2000)] = byte;
      return;
    }
    if (at < 0xfea0) {
      this.oam[at - 0xfe00] = byte;
      return;
    }
    if (at < 0xff00) return;
    if (at < 0xff80) {
      this.writeIo(at - 0xff00, byte);
      return;
    }
    if (at < 0xffff) {
      this.hram[at - 0xff80] = byte;
      return;
    }
    this.interruptEnable = byte;
  }

  /**
   * Where a work-RAM address really lands.
   *
   * `$C000`–`$CFFF` is always bank 0; `$D000`–`$DFFF` is the bank `SVBK`
   * selects, and bank 0 selected there means bank 1 — which is why a DMG game
   * that never writes `SVBK` sees the flat 8 KiB it expects.
   */
  private wramOffset(address: number): number {
    if (address < 0xd000) return address - 0xc000;
    return this.wramBank * WRAM_BANK + (address - 0xd000);
  }

  private readIo(register: number): number {
    if (register >= APU_FIRST && register <= APU_LAST) return this.apu.read(register);
    switch (register) {
      case 0x00:
        return this.joypadRegister();
      case 0x0f:
        return (this.io[0x0f] as number) | 0xe0;
      case 0x4f:
        return this.cgb ? this.vramBank | 0xfe : 0xff;
      case 0x69:
        return this.cgb ? (this.bgPaletteRam[(this.io[0x68] as number) & 0x3f] as number) : 0xff;
      case 0x6b:
        return this.cgb ? (this.objPaletteRam[(this.io[0x6a] as number) & 0x3f] as number) : 0xff;
      case 0x70:
        return this.cgb ? this.wramBank | 0xf8 : 0xff;
      default:
        return this.io[register] as number;
    }
  }

  private writeIo(register: number, value: number): void {
    if (register >= APU_FIRST && register <= APU_LAST) {
      this.apu.write(register, value);
      this.apuTap?.(register, value);
      return;
    }
    switch (register) {
      case 0x04:
        // Any write resets the divider, and with it the timer's prescaler.
        this.io[0x04] = 0;
        this.divCounter = 0;
        return;
      case 0x44:
        return; // LY is read-only
      case 0x46: {
        // OAM DMA. Real hardware takes 160 machine cycles and locks the bus;
        // nothing a demade game does can observe the difference, so it is
        // instant here and the cycles are still charged by the caller.
        const source = value << 8;
        for (let index = 0; index < 0xa0; index += 1) {
          this.oam[index] = this.read(source + index);
        }
        this.io[0x46] = value;
        return;
      }
      case 0x4f:
        if (this.cgb) this.vramBank = value & 1;
        this.io[0x4f] = value;
        return;
      case 0x69:
      case 0x6b: {
        if (!this.cgb) {
          this.io[register] = value;
          return;
        }
        // BCPD/OCPD write through the index register, which auto-increments when
        // its top bit is set — the only way a ROM ever fills 64 bytes of palette
        // RAM in a VBlank, and therefore the only path worth being exact about.
        const control = register === 0x69 ? 0x68 : 0x6a;
        const ram = register === 0x69 ? this.bgPaletteRam : this.objPaletteRam;
        const spec = this.io[control] as number;
        ram[spec & 0x3f] = value;
        if ((spec & 0x80) !== 0) this.io[control] = 0x80 | ((spec + 1) & 0x3f);
        return;
      }
      case 0x70:
        if (this.cgb) this.wramBank = (value & 7) === 0 ? 1 : value & 7;
        this.io[0x70] = value;
        return;
      default:
        this.io[register] = value;
    }
  }

  // --- joypad ----------------------------------------------------------------

  /** Set which buttons are down. Reads are level-sensitive, so this is state. */
  setButtons(down: Iterable<Button>): void {
    let mask = 0;
    for (const button of down) {
      const index = BUTTONS.indexOf(button);
      if (index >= 0) mask |= 1 << index;
    }
    this.held = mask;
  }

  private joypadRegister(): number {
    const select = (this.io[0x00] as number) & 0x30;
    let low = 0x0f;
    // Both lines can be selected at once, and the hardware ANDs the results.
    if ((select & 0x10) === 0) low &= ~((this.held >> 0) & 0x0f) & 0x0f;
    if ((select & 0x20) === 0) low &= ~((this.held >> 4) & 0x0f) & 0x0f;
    return 0xc0 | select | low;
  }

  // --- timing ----------------------------------------------------------------

  private request(bit: number): void {
    this.io[0x0f] = ((this.io[0x0f] as number) | bit) & 0x1f;
  }

  /** Run one instruction (or an interrupt dispatch) and clock the hardware. */
  stepInstruction(): number {
    let cycles = this.cpu.serviceInterrupts(
      this.interruptEnable,
      this.io[0x0f] as number,
      (bit) => {
        this.io[0x0f] = (this.io[0x0f] as number) & ~bit & 0x1f;
      },
    );
    if (cycles === 0) cycles = this.cpu.step();
    this.advance(cycles);
    return cycles;
  }

  /** Run until the start of the next VBlank, and return the frame index. */
  runFrame(): number {
    const target = this.frames + 1;
    let guard = 0;
    while (this.frames < target) {
      this.stepInstruction();
      // A runtime that hangs must fail the harness rather than the process.
      if ((guard += 1) > 4_000_000) throw new Error("dmg: no VBlank after 4M instructions");
    }
    return this.frames;
  }

  private advance(cycles: number): void {
    this.clockTimer(cycles);
    this.clockPpu(cycles);
    // A DMG's APU runs on the same master clock the CPU counts in, so one
    // T-cycle is one APU clock and there is no ratio to get wrong.
    if (this.audioSink) this.apu.run(cycles, this.audioSink);
  }

  private clockTimer(cycles: number): void {
    this.divCounter += cycles;
    while (this.divCounter >= 256) {
      this.divCounter -= 256;
      this.io[0x04] = (((this.io[0x04] as number) + 1) & 0xff) as number;
    }
    const control = this.io[0x07] as number;
    if ((control & 4) === 0) return;
    const period = [1024, 16, 64, 256][control & 3] as number;
    this.timerCounter += cycles;
    while (this.timerCounter >= period) {
      this.timerCounter -= period;
      const next = ((this.io[0x05] as number) + 1) & 0xff;
      if (next === 0) {
        this.io[0x05] = this.io[0x06] as number;
        this.request(INT.timer);
      } else {
        this.io[0x05] = next;
      }
    }
  }

  private clockPpu(cycles: number): void {
    if (((this.io[0x40] as number) & 0x80) === 0) {
      // LCD off: the counter parks at line 0 in mode 0, as on hardware.
      this.dot = 0;
      this.io[0x44] = 0;
      this.io[0x41] = (this.io[0x41] as number) & ~3;
      return;
    }
    this.dot += cycles;
    while (this.dot >= 456) {
      this.dot -= 456;
      const line = (this.io[0x44] as number) + 1;
      if (line < SCREEN_HEIGHT) {
        this.io[0x44] = line;
        this.renderLine(line);
      } else if (line === SCREEN_HEIGHT) {
        this.io[0x44] = line;
        this.request(INT.vblank);
        this.frames += 1;
        this.present();
      } else if (line > 153) {
        this.io[0x44] = 0;
        this.renderLine(0);
      } else {
        this.io[0x44] = line;
      }
      this.updateStat();
    }
  }

  private updateStat(): void {
    const line = this.io[0x44] as number;
    const status = this.io[0x41] as number;
    const mode = line >= SCREEN_HEIGHT ? 1 : this.dot < 80 ? 2 : this.dot < 252 ? 3 : 0;
    const coincidence = line === (this.io[0x45] as number);
    this.io[0x41] = (status & ~0x07) | (coincidence ? 4 : 0) | mode;
    const wanted =
      (coincidence && (status & 0x40) !== 0) ||
      (mode === 0 && (status & 0x08) !== 0) ||
      (mode === 1 && (status & 0x10) !== 0) ||
      (mode === 2 && (status & 0x20) !== 0);
    if (wanted) this.request(INT.stat);
  }

  // --- rendering -------------------------------------------------------------

  /** One BGR555 colour out of a CGB palette RAM block. */
  private paletteColor(ram: Uint8Array, palette: number, index: number): number {
    const at = (palette & 7) * 8 + (index & 3) * 2;
    return ((ram[at] as number) | ((ram[at + 1] as number) << 8)) & 0x7fff;
  }

  /**
   * Draw one scanline: background, then window, then sprites.
   *
   * Sprite priority on a DMG is by X coordinate and then by OAM index — a CGB
   * drops the X rule and goes by OAM index alone — and the ten-per-line limit is
   * real hardware behaviour a demade game is *supposed* to run into: doc 14
   * §Budgets has the compiler warn about it, so the core must actually enforce
   * it or the warning would be unfalsifiable.
   */
  private renderLine(line: number): void {
    const control = this.io[0x40] as number;
    const base = line * SCREEN_WIDTH;
    const row = this.indices.subarray(base, base + SCREEN_WIDTH);
    row.fill(0);
    this.bgRow.fill(0);
    this.bgAbove.fill(0);
    this.objRow.fill(0);
    if (this.cgb) this.colors.fill(0, base, base + SCREEN_WIDTH);
    if ((control & 0x80) === 0) return;

    const bgp = this.io[0x47] as number;
    const tileBase = (control & 0x10) !== 0 ? 0x0000 : 0x1000;

    // LCDC bit 0 means two different things: on a DMG it turns the background
    // off entirely, on a CGB it only decides whether the background may sit
    // above objects. So a CGB always paints it.
    if (this.cgb || (control & 0x01) !== 0) {
      const scy = this.io[0x42] as number;
      const scx = this.io[0x43] as number;
      const mapBase = (control & 0x08) !== 0 ? 0x1c00 : 0x1800;
      const y = (line + scy) & 0xff;
      for (let x = 0; x < SCREEN_WIDTH; x += 1) {
        this.plotBackground(base, x, mapBase, tileBase, (x + scx) & 0xff, y, bgp);
      }

      // The window, drawn over the background from (WX-7, WY).
      const wy = this.io[0x4a] as number;
      const wx = (this.io[0x4b] as number) - 7;
      if ((control & 0x20) !== 0 && line >= wy && wx < SCREEN_WIDTH) {
        const windowMap = (control & 0x40) !== 0 ? 0x1c00 : 0x1800;
        for (let x = Math.max(0, wx); x < SCREEN_WIDTH; x += 1) {
          this.plotBackground(base, x, windowMap, tileBase, x - wx, line - wy, bgp);
        }
      }
    }

    if ((control & 0x02) === 0) return;
    const tall = (control & 0x04) !== 0 ? 16 : 8;
    const candidates: number[] = [];
    for (let entry = 0; entry < 40 && candidates.length < 10; entry += 1) {
      const top = (this.oam[entry * 4] as number) - 16;
      if (line >= top && line < top + tall) candidates.push(entry);
    }
    // Highest priority first, and a pixel belongs to the first sprite that
    // claims it — including when that sprite then loses to the background,
    // which is what stops a sprite behind it showing through the gap.
    if (!this.cgb) {
      candidates.sort((a, b) => {
        const ax = this.oam[a * 4 + 1] as number;
        const bx = this.oam[b * 4 + 1] as number;
        return ax === bx ? a - b : ax - bx;
      });
    }

    for (const entry of candidates) {
      const top = (this.oam[entry * 4] as number) - 16;
      const left = (this.oam[entry * 4 + 1] as number) - 8;
      const flags = this.oam[entry * 4 + 3] as number;
      let tile = this.oam[entry * 4 + 2] as number;
      if (tall === 16) tile &= 0xfe;
      let inner = line - top;
      if ((flags & 0x40) !== 0) inner = tall - 1 - inner;
      const bank = this.cgb && (flags & 0x08) !== 0 ? VRAM_BANK : 0;
      const address = bank + tile * 16 + inner * 2;
      const low = this.vram[address] as number;
      const high = this.vram[address + 1] as number;
      const palette = this.io[(flags & 0x10) !== 0 ? 0x49 : 0x48] as number;
      for (let bit = 0; bit < 8; bit += 1) {
        const x = left + ((flags & 0x20) !== 0 ? 7 - bit : bit);
        if (x < 0 || x >= SCREEN_WIDTH) continue;
        if (this.objRow[x] === 1) continue; // a higher-priority sprite has it
        const shift = 7 - bit;
        const index = ((low >> shift) & 1) | (((high >> shift) & 1) << 1);
        if (index === 0) continue; // colour 0 is transparent for sprites
        this.objRow[x] = 1;
        // OBJ-behind-BG: the sprite loses to background colours 1–3, either
        // because it asked to or — on a CGB, and only while the background
        // holds priority at all — because the background cell did.
        const behind =
          (flags & 0x80) !== 0 || (this.cgb && (control & 0x01) !== 0 && this.bgAbove[x] === 1);
        if (behind && (this.bgRow[x] as number) !== 0) continue;
        if (this.cgb) {
          this.colors[base + x] = this.paletteColor(this.objPaletteRam, flags & 0x07, index);
          row[x] = index;
        } else {
          row[x] = (palette >> (index * 2)) & 3;
        }
      }
    }
  }

  /** One background (or window) pixel, including its CGB attribute. */
  private plotBackground(
    base: number,
    x: number,
    mapBase: number,
    tileBase: number,
    worldX: number,
    worldY: number,
    bgp: number,
  ): void {
    const map = mapBase + ((worldY >> 3) & 31) * 32 + ((worldX >> 3) & 31);
    const id = this.vram[map] as number;
    const attr = this.cgb ? (this.vram[VRAM_BANK + map] as number) : 0;
    const inner = (attr & 0x40) !== 0 ? 7 - (worldY & 7) : worldY & 7;
    const bank = (attr & 0x08) !== 0 ? VRAM_BANK : 0;
    const address =
      bank + (tileBase === 0 ? id * 16 + inner * 2 : 0x1000 + signed(id) * 16 + inner * 2);
    const low = this.vram[address] as number;
    const high = this.vram[address + 1] as number;
    const shift = (attr & 0x20) !== 0 ? worldX & 7 : 7 - (worldX & 7);
    const index = ((low >> shift) & 1) | (((high >> shift) & 1) << 1);
    this.bgRow[x] = index;
    if (this.cgb) {
      this.bgAbove[x] = (attr & 0x80) !== 0 ? 1 : 0;
      this.colors[base + x] = this.paletteColor(this.bgPaletteRam, attr & 0x07, index);
      this.indices[base + x] = index;
      return;
    }
    this.indices[base + x] = (bgp >> (index * 2)) & 3;
  }

  /** Colour the finished frame into RGBA. */
  private present(): void {
    if (this.cgb) {
      for (let pixel = 0; pixel < this.colors.length; pixel += 1) {
        const color = this.colors[pixel] as number;
        const at = pixel * 4;
        this.framebuffer[at] = expand5(color);
        this.framebuffer[at + 1] = expand5(color >> 5);
        this.framebuffer[at + 2] = expand5(color >> 10);
        this.framebuffer[at + 3] = 0xff;
      }
      return;
    }
    for (let pixel = 0; pixel < this.indices.length; pixel += 1) {
      const shade = DMG_SHADES[this.indices[pixel] as number] as readonly [number, number, number];
      const at = pixel * 4;
      this.framebuffer[at] = shade[0];
      this.framebuffer[at + 1] = shade[1];
      this.framebuffer[at + 2] = shade[2];
      this.framebuffer[at + 3] = 0xff;
    }
  }

  /** Read `length` bytes of work RAM from an absolute address. */
  readMemory(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = this.read(address + index);
    return out;
  }
}

function signed(byte: number): number {
  return byte > 127 ? byte - 256 : byte;
}
