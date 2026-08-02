/**
 * The console around the processor: memory map, video RAM banks, the 2D engine,
 * DMA, the pad.
 *
 * The seventh of the owned cores, and it exists for the two jobs the other six
 * do (doc 14 §Conformance, doc 07 §no CDN): run a `demake build` cartridge in
 * Vitest with no toolchain and no emulator install, and play one in the page
 * without fetching a core from anywhere.
 *
 * **It is mostly a memory map, and that is the news.** The processor is
 * `@demake/gba`'s `Arm7` and the picture is `@demake/gba`'s `Ppu`, because on
 * the parts a demade game uses they are the same processor and the same engine —
 * ARMv4 in ARM state, and a mode-0 2D engine with the same registers at the same
 * offsets, the same screen entries and the same character formats. Nintendo
 * built the DS that way; it is how one machine runs the other's cartridges. A
 * second copy of either here is how the two consoles would come to disagree
 * about a tile, which is the rule `@demake/chip` exists to keep for sound
 * (AGENTS.md §Working on audio).
 *
 * What *is* this console's, and therefore what this file is:
 *
 *   - **A cartridge is not in the address space.** The ARM9's binary is copied
 *     into main RAM before anything runs — by the firmware on hardware, by the
 *     loader in an emulator, and by {@link Nds}'s constructor here — so a
 *     program's own code, its data and its state are all in the 4 MiB the two
 *     processors share, and nothing is fetched from a cartridge bus at all.
 *   - **Video RAM is banked, and a bank has to be pointed somewhere.** Nine
 *     banks with a control byte each; until one is mapped, the address a
 *     background reads answers with nothing. `demake build` maps A to background
 *     memory and B to object memory, and any other arrangement raises here
 *     rather than being quietly accepted (§{@link Nds.writeVramControl}).
 *   - **The screen is bigger.** 256×192 against 240×160, which is a constructor
 *     option on the shared engine and not a branch in its loops.
 *   - **The engines have to be powered.** `POWCNT1` gates the LCDs and each 2D
 *     engine, and a cartridge that never writes it draws to hardware that is
 *     switched off.
 *
 * Two absences, named rather than left to be discovered:
 *
 *   - **Interrupts are not modelled**, because nothing reaches them: this
 *     console's backend waits on the beam rather than on a vertical-blank
 *     handler (`codegen/gba/machine.ts` §`frame`). A write that tried to enable
 *     one raises, so the day a driver wants an interrupt this fails loudly
 *     instead of hanging in a wait loop that will never be released.
 *   - **The ARM7 does not run.** A cartridge carries a binary for it and this
 *     copies that binary into main RAM, because a loader does and the memory
 *     image should be the one hardware has — but the second processor exists to
 *     drive the sound registers, and there is no audio driver for this console
 *     yet. Doc 13 §D4 is where that is tracked; when it lands, this is where the
 *     second processor arrives.
 *
 * Platform-pure on the same terms as `@demake/core`: no `fs`, no DOM, no wall
 * clock. Rendering produces a plain RGBA buffer; where that goes is the caller's
 * business.
 *
 * Sources: GBATEK — *DS Memory Maps*, *DS Video*, *DS Cartridge Header*,
 * *DMA Transfers* (https://problemkaputt.de/gbatek.htm).
 */

import { NDS_ARM7_RAM, NDS_ARM9_RAM, NDS_HEADER_SIZE } from "@demake/core";
import { Arm7, Ppu, type Bus } from "@demake/gba";

/** Visible width, in pixels. */
export const FRAME_WIDTH = 256;
/** Visible height. */
export const FRAME_HEIGHT = 192;
/** Scanlines in a frame, visible and blanking together. */
export const LINES_PER_FRAME = 263;

/**
 * The ARM9's clock: twice the 33.513982 MHz the rest of the machine runs at.
 *
 * The figure a speed measurement is against, and the reason this console's
 * numbers are not comparable with a Game Boy Advance's: the same code runs four
 * times as fast here as on the machine the backend was written for.
 */
export const CLOCK_HZ = 67027964;

/**
 * ARM9 cycles in one scanline.
 *
 * A line is 355 dots of six system clocks each — 2130 of them — and the
 * processor runs at twice that clock, so it gets 4260. Multiplying rather than
 * dividing keeps the raster in the units the CPU model counts in.
 */
export const CYCLES_PER_LINE = 4260;

/** Cycles in a whole frame, which is what one `runFrame` costs. */
export const FRAME_CYCLES = CYCLES_PER_LINE * LINES_PER_FRAME;

/** Where the ARM9's stack is left, which the cartridge sets for itself. */
export const STACK_TOP = 0x0237ff00;

/** Bytes of main RAM, shared by both processors. */
export const MAIN_RAM_SIZE = 0x400000;

/** Bytes of shared work RAM; all of it is the ARM9's until `WRAMCNT` says else. */
const SHARED_WRAM_SIZE = 0x8000;

/** Bytes one video RAM bank holds, for the two this core maps. */
const BANK_A_SIZE = 0x20000;
const BANK_B_SIZE = 0x20000;

/** The pad, in `KEYINPUT` bit order — the Game Boy Advance's exactly. */
export const BUTTONS = [
  "a",
  "b",
  "select",
  "start",
  "right",
  "left",
  "up",
  "down",
  "r",
  "l",
] as const;

/** One of the pad's buttons. */
export type Button = (typeof BUTTONS)[number];

/** Raised when a cartridge asks for hardware this core does not model. */
export class NdsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NdsError";
  }
}

/** One DMA channel's registers. */
interface Dma {
  source: number;
  dest: number;
  control: number;
}

/** A Nintendo DS with a cartridge in it. */
export class Nds implements Bus {
  readonly cpu = new Arm7(this);

  /**
   * 2D engine A, on the screen the picture is shown on.
   *
   * Engine B exists on the hardware and draws the other screen; `demake build`
   * programs one screen, so the second engine is absent here rather than
   * half-implemented — the same stance `@demake/snes` takes on the background
   * layers it omits (AGENTS.md §Iron rules). A write to its registers raises.
   */
  readonly ppu: Ppu;

  /** The 4 MiB both processors share, and where the program itself lives. */
  readonly ram = new Uint8Array(MAIN_RAM_SIZE);
  /** The 32 KiB of shared work RAM, all of it the ARM9's at boot. */
  readonly wram = new Uint8Array(SHARED_WRAM_SIZE);
  /** Video RAM bank A, which a build maps to background memory. */
  readonly bankA: Uint8Array;
  /** Video RAM bank B, which a build maps to object memory. */
  readonly bankB: Uint8Array;

  /** Frames completed since power-on — the harness's clock. */
  frames = 0;

  private held = 0;
  private cycles = 0;
  private powcnt = 0;
  /** One control byte per video RAM bank, `VRAMCNT_A` through `VRAMCNT_I`. */
  private readonly vramcnt = new Uint8Array(9);
  private readonly dma: Dma[] = Array.from({ length: 4 }, () => ({
    source: 0,
    dest: 0,
    control: 0,
  }));

  constructor(rom: Uint8Array) {
    if (rom.length < NDS_HEADER_SIZE) {
      throw new NdsError("a cartridge is at least a header region");
    }
    this.bankA = new Uint8Array(BANK_A_SIZE);
    this.bankB = new Uint8Array(BANK_B_SIZE);
    this.ppu = new Ppu({
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      // Bank A is the backgrounds' and bank B is the objects': two address
      // spaces rather than one region with the objects on top, which is the one
      // thing about this engine's memory that is not the Game Boy Advance's.
      // The *machine* owns both, because a bus routes to them and a bank the
      // engine allocated for itself would be a second copy nothing wrote to.
      vram: this.bankA,
      objVram: this.bankB,
    });

    // Direct boot: what the firmware does before either processor starts is copy
    // both binaries out of the cartridge and into main RAM. Nothing is mapped
    // from a cartridge bus afterwards, which is why this is a *load* and not a
    // memory region.
    const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
    this.load(
      rom,
      view.getUint32(0x020, true),
      view.getUint32(0x028, true),
      view.getUint32(0x02c, true),
    );
    this.load(
      rom,
      view.getUint32(0x030, true),
      view.getUint32(0x038, true),
      view.getUint32(0x03c, true),
    );
    const entry = view.getUint32(0x024, true) >>> 0;
    if (entry !== NDS_ARM9_RAM) {
      throw new NdsError(
        `this cartridge starts the ARM9 at $${entry.toString(16)}; direct boot enters at $${NDS_ARM9_RAM.toString(16)}`,
      );
    }
    // The stacks are the cartridge's own on this console — a program sets its
    // own stack pointer at boot rather than inheriting one, because where the
    // BIOS leaves it depends on where it put data TCM. These are what a program
    // that forgot would fall back on, and they are inside main RAM so that a
    // forgotten one is a wrong game rather than a silent nothing.
    this.cpu.reset(entry, { sys: STACK_TOP, irq: STACK_TOP - 0x100, svc: STACK_TOP - 0x200 });
  }

  /** Copy one processor's binary out of the image and into main RAM. */
  private load(rom: Uint8Array, offset: number, address: number, length: number): void {
    if (length === 0) return;
    const at = address >>> 0;
    if (at < NDS_ARM9_RAM || at + length > NDS_ARM9_RAM + MAIN_RAM_SIZE) {
      throw new NdsError(
        `this cartridge loads a binary at $${at.toString(16)}, which is outside main RAM`,
      );
    }
    if (offset + length > rom.length) {
      throw new NdsError("this cartridge names a binary past the end of its image");
    }
    this.ram.set(rom.subarray(offset, offset + length), at - NDS_ARM9_RAM);
  }

  /** The picture the console's screen shows, as RGBA. */
  get framebuffer(): Uint8ClampedArray {
    return this.ppu.view().pixels;
  }

  /** Where the ARM7's binary was loaded, for a harness that wants to see it. */
  get arm7Base(): number {
    return NDS_ARM7_RAM;
  }

  // --- the bus ---------------------------------------------------------------

  /**
   * Extra cycles this address costs beyond the one every access takes.
   *
   * Main RAM is the only region a demade game spends real time in, and on this
   * console it is *slow*: a 16-bit bus behind a cache the ARM9 has and this core
   * does not model, so the honest figure without the cache is what the hardware
   * charges an uncached access. Video memory and I/O are on the fast bus.
   */
  wait(address: number, width: 1 | 2 | 4): number {
    const region = (address >>> 24) & 0xf;
    if (region === 0x2) return width === 4 ? 8 : 4;
    return 0;
  }

  read8(address: number): number {
    const at = address >>> 0;
    switch ((at >>> 24) & 0xf) {
      case 0x2:
        return this.ram[at & (MAIN_RAM_SIZE - 1)] as number;
      case 0x3:
        return this.wram[at & (SHARED_WRAM_SIZE - 1)] as number;
      case 0x4:
        return this.readIo(at & 0xffffff);
      case 0x5: {
        const entry = this.ppu.palette[(at & 0x7ff) >> 1] as number;
        return (at & 1) !== 0 ? (entry >> 8) & 0xff : entry & 0xff;
      }
      case 0x6:
        return this.vramByte(at);
      case 0x7: {
        const entry = this.ppu.oam[(at & 0x7ff) >> 1] as number;
        return (at & 1) !== 0 ? (entry >> 8) & 0xff : entry & 0xff;
      }
      default:
        return 0;
    }
  }

  read16(address: number): number {
    const at = address & ~1;
    const region = (at >>> 24) & 0xf;
    if (region === 0x5) return this.ppu.palette[(at & 0x7ff) >> 1] as number;
    if (region === 0x7) return this.ppu.oam[(at & 0x7ff) >> 1] as number;
    if (region === 0x6) return this.vramByte(at) | (this.vramByte(at + 1) << 8);
    return (this.read8(at) | (this.read8(at + 1) << 8)) & 0xffff;
  }

  read32(address: number): number {
    const at = address & ~3;
    return (this.read16(at) | (this.read16(at + 2) << 16)) >>> 0;
  }

  write8(address: number, value: number): void {
    const at = address >>> 0;
    const byte = value & 0xff;
    switch ((at >>> 24) & 0xf) {
      case 0x2:
        this.ram[at & (MAIN_RAM_SIZE - 1)] = byte;
        return;
      case 0x3:
        this.wram[at & (SHARED_WRAM_SIZE - 1)] = byte;
        return;
      case 0x4:
        this.writeIo(at & 0xffffff, byte);
        return;
      case 0x5:
      case 0x6:
      case 0x7:
        // Palette, video and attribute memory are halfword devices on this
        // console and a byte write to them does *nothing at all* — unlike the
        // Game Boy Advance, where it writes both halves. Nothing demake emits
        // does it; refusing is what makes that a fact rather than a hope.
        throw new NdsError(
          `a byte write to $${at.toString(16)} — video memory on this console takes halfwords`,
        );
      default:
        return;
    }
  }

  write16(address: number, value: number): void {
    const at = address & ~1;
    const half = value & 0xffff;
    switch ((at >>> 24) & 0xf) {
      case 0x5:
        this.ppu.palette[(at & 0x7ff) >> 1] = half;
        return;
      case 0x6:
        this.writeVram(at, half & 0xff);
        this.writeVram(at + 1, (half >> 8) & 0xff);
        return;
      case 0x7:
        this.ppu.oam[(at & 0x7ff) >> 1] = half;
        return;
      case 0x4:
        this.writeIo(at & 0xffffff, half & 0xff);
        this.writeIo((at & 0xffffff) + 1, (half >> 8) & 0xff);
        return;
      default:
        this.write8(at, half & 0xff);
        this.write8(at + 1, (half >> 8) & 0xff);
    }
  }

  write32(address: number, value: number): void {
    const at = address & ~3;
    this.write16(at, value & 0xffff);
    this.write16(at + 2, (value >>> 16) & 0xffff);
  }

  // --- video RAM -------------------------------------------------------------

  /**
   * Which bank answers an address in the video region, and where inside it.
   *
   * `null` for an address no enabled bank covers, which reads as zero and
   * swallows a write — the hardware's own answer, and the reason a build maps a
   * bank before it uploads anything. Engine A's backgrounds start at `$6000000`
   * and its objects at `$6400000`; the other four windows are the sub engine's
   * and the texture memory's, neither of which this core has.
   */
  private bankFor(at: number): { bytes: Uint8Array; index: number } | null {
    const window = (at >>> 20) & 0xf;
    if (window === 0x0 && (this.vramcnt[0] as number) === 0x81) {
      return { bytes: this.bankA, index: at & (BANK_A_SIZE - 1) };
    }
    if (window === 0x4 && (this.vramcnt[1] as number) === 0x82) {
      return { bytes: this.bankB, index: at & (BANK_B_SIZE - 1) };
    }
    return null;
  }

  private vramByte(at: number): number {
    const found = this.bankFor(at);
    return found === null ? 0 : (found.bytes[found.index] as number);
  }

  private writeVram(at: number, byte: number): void {
    const found = this.bankFor(at);
    if (found !== null) found.bytes[found.index] = byte;
  }

  /**
   * A bank's control byte, and the two arrangements this core has.
   *
   * Nine banks, each with an enable bit, a three-bit purpose and a two-bit
   * offset — enough combinations that modelling them all would be modelling
   * hardware nothing drives. What `demake build` programs is bank A to
   * background memory and bank B to object memory, so those two are what this
   * accepts; anything else raises by name, because a bank silently pointed
   * somewhere else is a picture that draws from an address nobody filled.
   */
  private writeVramControl(index: number, value: number): void {
    const byte = value & 0xff;
    this.vramcnt[index] = byte;
    if ((byte & 0x80) === 0) return;
    const wanted = index === 0 ? 0x81 : index === 1 ? 0x82 : -1;
    if (byte !== wanted) {
      throw new NdsError(
        `VRAMCNT_${String.fromCharCode(65 + index)} = $${byte.toString(16)} is a bank arrangement this core does not model; ` +
          "demake maps A to background memory and B to object memory",
      );
    }
  }

  // --- registers -------------------------------------------------------------

  private readIo(at: number): number {
    switch (at) {
      case 0x000:
        return this.ppu.dispcnt & 0xff;
      case 0x001:
        return (this.ppu.dispcnt >> 8) & 0xff;
      case 0x002:
        return (this.ppu.dispcnt >> 16) & 0xff;
      case 0x003:
        return (this.ppu.dispcnt >> 24) & 0xff;
      case 0x004:
        return this.ppu.dispstat & 0xff;
      case 0x005:
        return (this.ppu.dispstat >> 8) & 0xff;
      case 0x006:
        return this.ppu.vcount & 0xff;
      case 0x007:
        return (this.ppu.vcount >> 8) & 0xff;
      case 0x130:
        return ~this.held & 0xff;
      case 0x131:
        return (~this.held >> 8) & 0x03;
      case 0x304:
        return this.powcnt & 0xff;
      case 0x305:
        return (this.powcnt >> 8) & 0xff;
      default:
        break;
    }
    if (at >= 0x008 && at <= 0x00f) {
      const index = (at - 0x008) >> 1;
      const value = this.ppu.bgcnt[index] as number;
      return (at & 1) !== 0 ? (value >> 8) & 0xff : value & 0xff;
    }
    if (at >= 0x240 && at <= 0x248) return this.vramcnt[at - 0x240] as number;
    return 0;
  }

  private writeIo(at: number, value: number): void {
    switch (at) {
      case 0x000:
        this.ppu.dispcnt = (this.ppu.dispcnt & ~0xff) | value;
        return;
      case 0x001:
        this.ppu.dispcnt = (this.ppu.dispcnt & ~0xff00) | (value << 8);
        return;
      case 0x002:
        this.ppu.dispcnt = ((this.ppu.dispcnt & ~0xff0000) | (value << 16)) >>> 0;
        this.checkDisplayMode();
        return;
      case 0x003:
        this.ppu.dispcnt = ((this.ppu.dispcnt & ~0xff000000) | (value << 24)) >>> 0;
        return;
      case 0x004:
        this.ppu.dispstat = (this.ppu.dispstat & ~0xff) | value;
        return;
      case 0x005:
        this.ppu.dispstat = (this.ppu.dispstat & ~0xff00) | (value << 8);
        return;
      case 0x06c:
      case 0x06d:
        // `MASTER_BRIGHT`: a fade over the whole screen. Zero is "none", which
        // is what a build writes and the only value this core draws.
        if (value !== 0) {
          throw new NdsError("this core draws no master brightness fade; demake writes none");
        }
        return;
      case 0x208:
      case 0x210:
      case 0x211:
      case 0x212:
      case 0x213:
        // `IME` and `IE`. Interrupts are not modelled — see the file header —
        // and the backend waits on the beam, so nothing should reach these. A
        // *disable* is harmless and lets a cartridge be defensive; an enable
        // would be a wait loop nothing ever releases.
        if (value !== 0) {
          throw new NdsError(
            "this cartridge enables an interrupt; this core models none, because " +
              "the backend waits on the beam rather than on a handler",
          );
        }
        return;
      case 0x304:
        this.powcnt = (this.powcnt & ~0xff) | value;
        return;
      case 0x305:
        this.powcnt = (this.powcnt & ~0xff00) | (value << 8);
        return;
      default:
        break;
    }
    if (at >= 0x008 && at <= 0x00f) {
      const index = (at - 0x008) >> 1;
      const old = this.ppu.bgcnt[index] as number;
      this.ppu.bgcnt[index] = (at & 1) !== 0 ? (old & 0xff) | (value << 8) : (old & 0xff00) | value;
      return;
    }
    if (at >= 0x010 && at <= 0x01f) {
      const index = (at - 0x010) >> 2;
      const target = ((at - 0x010) & 2) !== 0 ? this.ppu.bgvofs : this.ppu.bghofs;
      const old = target[index] as number;
      target[index] = (at & 1) !== 0 ? (old & 0x00ff) | ((value & 1) << 8) : (old & 0x100) | value;
      return;
    }
    if (at >= 0x0b0 && at <= 0x0df) {
      this.writeDma(at, value);
      return;
    }
    if (at >= 0x240 && at <= 0x248) {
      this.writeVramControl(at - 0x240, value);
      return;
    }
    if (at >= 0x1000 && at < 0x1060) {
      throw new NdsError(
        "this cartridge programs 2D engine B; demake draws one screen and this core models one engine",
      );
    }
  }

  /**
   * The display-mode field, which has no counterpart on a Game Boy Advance.
   *
   * `DISPCNT` bits 16–17 say what the engine puts on the screen at all: nothing,
   * the graphics it renders, a video RAM bank shown as a bitmap, or the capture
   * unit's output. A build writes 1, and the other three are hardware this core
   * does not draw — so they raise rather than showing the picture anyway, which
   * would be a cartridge that works here and shows a blank screen on the console.
   */
  private checkDisplayMode(): void {
    const mode = (this.ppu.dispcnt >>> 16) & 3;
    if (mode !== 1) {
      throw new NdsError(
        `display mode ${mode} is not implemented; demake builds mode 1, the engine's own graphics`,
      );
    }
  }

  // --- DMA -------------------------------------------------------------------

  /**
   * A DMA channel's registers, which are one word here rather than two halves.
   *
   * The Game Boy Advance splits the count and the control across `CNT_L` and
   * `CNT_H`; this console widens the count to twenty-one bits and moves the
   * control bits up to make room. What matters for a build is that the *word* a
   * transfer is started with means the same thing on both — enable at bit 31,
   * thirty-two bits at 26, immediate timing at 27–29, a fixed source at 24 — so
   * `codegen/gba/emit.ts`'s `emitDma` needs no case for this machine.
   */
  private writeDma(at: number, value: number): void {
    const index = ((at - 0x0b0) / 12) | 0;
    const channel = this.dma[index] as Dma;
    const offset = (at - 0x0b0) % 12;
    const put = (field: "source" | "dest" | "control", shift: number): void => {
      channel[field] = ((channel[field] & ~(0xff << shift)) | (value << shift)) >>> 0;
    };
    if (offset < 4) return put("source", offset * 8);
    if (offset < 8) return put("dest", (offset - 4) * 8);
    const before = channel.control;
    put("control", (offset - 8) * 8);
    if ((before & 0x80000000) === 0 && (channel.control & 0x80000000) !== 0) this.runDma(index);
  }

  /** Perform a whole transfer. */
  private runDma(index: number): void {
    const channel = this.dma[index] as Dma;
    const control = channel.control;
    const timing = (control >>> 27) & 7;
    if (timing !== 0) {
      throw new NdsError(
        `DMA channel ${index} asks for start timing ${timing}; demake transfers immediately`,
      );
    }
    const wide = (control & 0x04000000) !== 0;
    const step = wide ? 4 : 2;
    const destMode = (control >>> 21) & 3;
    const sourceMode = (control >>> 23) & 3;
    const units = (control & 0x1fffff) === 0 ? 0x200000 : control & 0x1fffff;
    let source = channel.source >>> 0;
    let dest = channel.dest >>> 0;
    for (let unit = 0; unit < units; unit += 1) {
      if (wide) this.write32(dest, this.read32(source));
      else this.write16(dest, this.read16(source));
      if (sourceMode === 0) source = (source + step) >>> 0;
      else if (sourceMode === 1) source = (source - step) >>> 0;
      if (destMode === 0 || destMode === 3) dest = (dest + step) >>> 0;
      else if (destMode === 1) dest = (dest - step) >>> 0;
    }
    // No repeat, so the channel disables itself the way the hardware does.
    channel.control = (control & ~0x80000000) >>> 0;
  }

  // --- the pad ---------------------------------------------------------------

  /** Hold this set of buttons, releasing everything else. */
  setButtons(down: readonly string[]): void {
    let held = 0;
    for (const [index, name] of BUTTONS.entries()) {
      if (down.includes(name)) held |= 1 << index;
    }
    this.held = held;
  }

  // --- running ---------------------------------------------------------------

  /** Run one instruction and advance the raster by what it cost. */
  stepInstruction(): number {
    const cycles = this.cpu.step();
    this.advance(cycles);
    return cycles;
  }

  /** Advance the raster, which on this console is the only clock anything has. */
  private advance(cycles: number): void {
    this.cycles += cycles;
    while (this.cycles >= CYCLES_PER_LINE) {
      this.cycles -= CYCLES_PER_LINE;
      this.ppu.vcount += 1;
      if (this.ppu.vcount === FRAME_HEIGHT) this.ppu.dispstat |= 1;
      if (this.ppu.vcount >= LINES_PER_FRAME) {
        this.ppu.vcount = 0;
        this.ppu.dispstat &= ~1;
        this.frames += 1;
      }
    }
  }

  /** Run until the next frame boundary, and report the cycles it took. */
  runFrame(): number {
    const target = this.frames + 1;
    let cycles = 0;
    for (let guard = 0; guard < 8_000_000 && this.frames < target; guard += 1) {
      cycles += this.stepInstruction();
    }
    return cycles;
  }

  /** Read a run of bytes out of the console's address space. */
  readMemory(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = this.read8(address + index);
    return out;
  }
}
