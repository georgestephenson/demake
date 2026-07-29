/**
 * The console around the processor: memory map, video and sound registers, DMA,
 * timers, interrupts, the pad.
 *
 * The Game Boy Advance counterpart of `@demake/dmg`'s `Gameboy`, `@demake/nes`'s
 * `Nes`, `@demake/sms`'s `Sms`, `@demake/snes`'s `Snes` and `@demake/md`'s `Md`,
 * for the same two jobs (doc 14 §Conformance, doc 07 §no CDN): boot a
 * `demake build` cartridge in Vitest with no toolchain and no emulator install,
 * and play one in the page without fetching a core from anywhere.
 *
 * Four things here are this console's rather than a restatement of a predecessor:
 *
 *   - **The sound hardware is two devices in one register page.** Four channels
 *     of the Game Boy's own APU sit at `$4000060`–`$4000084` under a *permuted*
 *     register map, and two direct-sound channels sit beside them being fed
 *     eight-bit samples by DMA. The first of those is `@demake/chip`'s `GbApu`
 *     reached through a map — the Mega Duck's arrangement exactly (AGENTS.md
 *     §How to add a console) — and the second is `GbaPcm`, which is a mixer
 *     rather than a generator.
 *   - **DMA is not an optimisation, it is how sound reaches the DAC.** Channels
 *     one and two in their special timing mode transfer four words into a
 *     sixteen-byte FIFO whenever it drops below half, clocked by a hardware
 *     timer; there is no other path. So a core that treated DMA as a fast copy
 *     would be silent, and the *bytes that cross it* are what doc 16's proof
 *     compares (§The proof, extended for a mixer console).
 *   - **The interrupt vector is in a BIOS this core owns.** A cartridge cannot
 *     install one — `$00000018` is ROM — so the dispatcher that saves registers
 *     and jumps through `$03007FFC` is six instructions of *our* ARM, written
 *     here as words. Nintendo's BIOS is neither shipped nor needed.
 *   - **Internal work RAM is where a game's state goes**, and the memory plan
 *     says so: 32 KiB on a 32-bit bus with no wait states, against 256 KiB of
 *     external RAM on a 16-bit bus with two. The bus charges for the difference,
 *     so the speed figure a build reports reflects it.
 *
 * Sources: GBATEK — *GBA Memory Map*, *DMA Transfers*, *Timers*, *Interrupt
 * Control*, *GBA Sound Controller* (https://problemkaputt.de/gbatek.htm).
 */

import { GbApu, type SampleSink } from "@demake/chip";

import { Arm7, type Bus } from "./cpu.js";
import { DirectSound } from "./sound.js";
import {
  CYCLES_PER_LINE,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  LINES_PER_FRAME,
  OBJ_VRAM_BASE,
  Ppu,
} from "./ppu.js";

export { FRAME_HEIGHT, FRAME_WIDTH, OBJ_VRAM_BASE };

/** Processor cycles in one frame — the clock every other rate is derived from. */
export const FRAME_CYCLES = LINES_PER_FRAME * CYCLES_PER_LINE;

/** The system clock, in hertz. */
export const CLOCK_HZ = 16777216;

/** Where the cartridge is mapped. */
export const ROM_BASE = 0x08000000;

/**
 * The abstract buttons, and where they are on this pad.
 *
 * Every button the portable vocabulary names is here and is a real button:
 * a dedicated Start, and A and B where the language expects them. The shoulder
 * buttons exist on the hardware and the language has no word for them, so they
 * read as released.
 */
export const BUTTONS = ["a", "b", "select", "start", "right", "left", "up", "down"] as const;

/** One pad button. */
export type Button = (typeof BUTTONS)[number];

/** Interrupt sources, by the bit each occupies in `IE` and `IF`. */
export const IRQ = {
  vblank: 1 << 0,
  hblank: 1 << 1,
  vcount: 1 << 2,
  timer0: 1 << 3,
  timer1: 1 << 4,
  timer2: 1 << 5,
  timer3: 1 << 6,
  dma0: 1 << 8,
  dma1: 1 << 9,
  dma2: 1 << 10,
  dma3: 1 << 11,
  keypad: 1 << 12,
} as const;

/** What each of the four prescaler settings divides the system clock by. */
const PRESCALE = [1, 64, 256, 1024] as const;

/**
 * How loud the four Game Boy channels sit against the two sample channels.
 *
 * A fact about the *console* rather than about either device — the same APU is
 * the whole output on a Game Boy — so it is stated by the machine that has both,
 * exactly as `@demake/md` states the balance between its PSG and its FM chip.
 * The audio engine states the same number from the other side.
 */
export const PSG_MIX_GAIN = 0.35;

/** One DMA channel's registers. */
interface Dma {
  source: number;
  dest: number;
  count: number;
  control: number;
  /** The addresses the transfer is currently walking, which repeat does not reset. */
  liveSource: number;
  liveDest: number;
}

/** One hardware timer. */
interface Timer {
  reload: number;
  counter: number;
  control: number;
  /** Fractional prescaler clocks carried between calls, so nothing drifts. */
  owed: number;
}

/**
 * The interrupt dispatcher, as words.
 *
 * demake's own, not Nintendo's, and the documented six-instruction sequence a
 * cartridge is entitled to assume: save the registers the ABI does not, jump
 * through the user vector at `$03007FFC` — reached here through the mirror at
 * `$03FFFFFC`, which is how every GBA program spells it — then restore and
 * return through `subs pc, lr, #4`.
 *
 *   0x18:  b     0x128
 *   0x128: stmfd sp!, {r0-r3, r12, lr}
 *          mov   r0, #0x04000000
 *          add   lr, pc, #0
 *          ldr   pc, [r0, #-4]
 *   0x138: ldmfd sp!, {r0-r3, r12, lr}
 *          subs  pc, lr, #4
 */
const BIOS_WORDS: readonly (readonly [number, number])[] = [
  [0x18, 0xea000042], // b 0x128
  [0x128, 0xe92d500f], // stmfd sp!, {r0-r3, r12, lr}
  [0x12c, 0xe3a00301], // mov r0, #0x04000000
  [0x130, 0xe28fe000], // add lr, pc, #0
  [0x134, 0xe510f004], // ldr pc, [r0, #-4]
  [0x138, 0xe8bd500f], // ldmfd sp!, {r0-r3, r12, lr}
  [0x13c, 0xe25ef004], // subs pc, lr, #4
];

/** A Game Boy Advance with a cartridge in it. */
export class Gba implements Bus {
  readonly cpu = new Arm7(this);
  readonly ppu = new Ppu();
  /** The Game Boy's four channels — `@demake/chip`'s model, not a second copy. */
  readonly psg = new GbApu();
  /**
   * The two eight-bit converters DMA feeds.
   *
   * The *hardware*, not the mixer: `@demake/chip`'s `GbaPcm` says what samples
   * should arrive here, and this says nothing about them and only carries them.
   * Keeping the two apart is what makes doc 16's comparison a comparison
   * between a schedule and a cartridge rather than between two copies of one
   * piece of code.
   */
  readonly pcm = new DirectSound();

  /** The whole cartridge image. */
  readonly rom: Uint8Array;
  /** 256 KiB of external work RAM: a 16-bit bus, two wait states. */
  readonly ewram = new Uint8Array(0x40000);
  /** 32 KiB of internal work RAM: a 32-bit bus, none. This is where a game lives. */
  readonly iwram = new Uint8Array(0x8000);
  /** The BIOS this core owns — an interrupt dispatcher and nothing else. */
  readonly bios = new Uint8Array(0x4000);

  /** Frames completed since power-on — the harness's clock. */
  frames = 0;

  /**
   * Called for every write the program makes to a Game Boy sound register.
   *
   * The audio conformance oracle's interface to the PSG half (doc 16 §The proof,
   * Level A), and `@demake/dmg`'s `apuTap` exactly: it observes rather than
   * intercepts, and reports the register in `@demake/chip`'s numbering — which
   * is a Game Boy's `$10`–`$3F`, not this console's permuted address — because
   * that is what a `ChipScript` holds.
   */
  apuTap: ((reg: number, value: number) => void) | undefined = undefined;

  /**
   * Called for every byte that crosses into a direct-sound FIFO.
   *
   * The sample half's proof is not a register diff, because a software mixer
   * performs no per-note register write: what is compared is *the audio itself*,
   * byte for byte, against what `GbaPcm` renders from the same voice schedule.
   * This is where those bytes are observed. The channel is 0 for A and 1 for B.
   */
  fifoTap: ((channel: number, byte: number) => void) | undefined = undefined;

  /** Where the Game Boy channels' samples go, when anything is listening. */
  audioSink: SampleSink | undefined = undefined;
  /** Where the sample channels' output goes — a second sink, a second clock. */
  pcmSink: SampleSink | undefined = undefined;

  private held = 0;
  private cycles = 0;
  private ie = 0;
  private iff = 0;
  private ime = 0;
  private waitcnt = 0;
  private keycnt = 0;
  private readonly dma: Dma[] = Array.from({ length: 4 }, () => ({
    source: 0,
    dest: 0,
    count: 0,
    control: 0,
    liveSource: 0,
    liveDest: 0,
  }));
  private readonly timers: Timer[] = Array.from({ length: 4 }, () => ({
    reload: 0,
    counter: 0,
    control: 0,
    owed: 0,
  }));
  /** `SOUNDCNT_H`: the sample channels' volumes, timers, enables and resets. */
  private soundcntH = 0;
  private soundbias = 0x200;
  /** Chip clocks owed the APU, carried so the 4.19 MHz : 16.78 MHz ratio is exact. */
  private psgOwed = 0;

  constructor(rom: Uint8Array) {
    if (rom.length < 0xc0) throw new Error("gba: a cartridge is at least 192 bytes");
    this.rom = rom;
    for (const [at, word] of BIOS_WORDS) {
      this.bios[at] = word & 0xff;
      this.bios[at + 1] = (word >>> 8) & 0xff;
      this.bios[at + 2] = (word >>> 16) & 0xff;
      this.bios[at + 3] = (word >>> 24) & 0xff;
    }
    this.cpu.reset(ROM_BASE);
  }

  /** The picture the console's screen shows, as RGBA. */
  get framebuffer(): Uint8ClampedArray {
    return this.ppu.view().pixels;
  }

  // --- the bus ---------------------------------------------------------------

  /** Fold video RAM's odd mirror: 96 KiB repeating in 128 KiB steps. */
  private static vramAddress(address: number): number {
    const at = address & 0x1ffff;
    return at >= 0x18000 ? at - 0x8000 : at;
  }

  /**
   * Extra cycles this address costs beyond the one every access takes.
   *
   * The three ROM mirrors have their own wait states, and `WAITCNT` chooses
   * them — which is why a build sets that register before anything else: the
   * default is five cycles for a first access where the fastest setting is
   * three, and a game's code is fetched from there on every instruction.
   */
  wait(address: number, width: 1 | 2 | 4): number {
    const region = (address >>> 24) & 0xf;
    switch (region) {
      case 0x2: // external work RAM: 16 bits wide, two wait states
        return width === 4 ? 5 : 2;
      case 0x5: // palette
      case 0x6: // video RAM
        return width === 4 ? 1 : 0;
      case 0x8:
      case 0x9: {
        const first = [4, 3, 2, 8][(this.waitcnt >> 2) & 3] as number;
        const next = ((this.waitcnt >> 4) & 1) !== 0 ? 1 : 2;
        return width === 4 ? first + next : first;
      }
      case 0xa:
      case 0xb: {
        const first = [4, 3, 2, 8][(this.waitcnt >> 5) & 3] as number;
        const next = ((this.waitcnt >> 7) & 1) !== 0 ? 1 : 4;
        return width === 4 ? first + next : first;
      }
      case 0xc:
      case 0xd: {
        const first = [4, 3, 2, 8][(this.waitcnt >> 8) & 3] as number;
        const next = ((this.waitcnt >> 10) & 1) !== 0 ? 1 : 8;
        return width === 4 ? first + next : first;
      }
      default:
        // BIOS, internal work RAM, I/O and object attribute memory are all
        // thirty-two bits wide with no wait states.
        return 0;
    }
  }

  read8(address: number): number {
    const at = address >>> 0;
    const region = (at >>> 24) & 0xf;
    switch (region) {
      case 0x0:
        return at < 0x4000 ? (this.bios[at] as number) : 0;
      case 0x2:
        return this.ewram[at & 0x3ffff] as number;
      case 0x3:
        return this.iwram[at & 0x7fff] as number;
      case 0x4:
        return this.readIo(at & 0xffff);
      case 0x5: {
        const entry = this.ppu.palette[(at & 0x3ff) >> 1] as number;
        return (at & 1) !== 0 ? (entry >> 8) & 0xff : entry & 0xff;
      }
      case 0x6:
        return this.ppu.vram[Gba.vramAddress(at)] as number;
      case 0x7: {
        const entry = this.ppu.oam[(at & 0x3ff) >> 1] as number;
        return (at & 1) !== 0 ? (entry >> 8) & 0xff : entry & 0xff;
      }
      case 0x8:
      case 0x9:
      case 0xa:
      case 0xb:
      case 0xc:
      case 0xd:
        return this.rom[at & 0x01ffffff] ?? 0;
      default:
        return 0;
    }
  }

  read16(address: number): number {
    const at = address & ~1;
    const region = (at >>> 24) & 0xf;
    // Palette, video RAM and attribute memory are halfword devices, so they are
    // read as halfwords rather than assembled from two bytes.
    if (region === 0x5) return this.ppu.palette[(at & 0x3ff) >> 1] as number;
    if (region === 0x7) return this.ppu.oam[(at & 0x3ff) >> 1] as number;
    if (region === 0x6) {
      const base = Gba.vramAddress(at);
      return (this.ppu.vram[base] as number) | ((this.ppu.vram[base + 1] as number) << 8);
    }
    return (this.read8(at) | (this.read8(at + 1) << 8)) & 0xffff;
  }

  read32(address: number): number {
    const at = address & ~3;
    return ((this.read16(at) | (this.read16(at + 2) << 16)) >>> 0) as number;
  }

  write8(address: number, value: number): void {
    const at = address >>> 0;
    const byte = value & 0xff;
    switch ((at >>> 24) & 0xf) {
      case 0x2:
        this.ewram[at & 0x3ffff] = byte;
        return;
      case 0x3:
        this.iwram[at & 0x7fff] = byte;
        return;
      case 0x4:
        this.writeIo(at & 0xffff, byte);
        return;
      case 0x5:
      case 0x7:
        // A byte write to palette or attribute memory writes *both* halves of
        // the halfword on this hardware. Nothing demake emits does it; the
        // hardware's answer is cheaper to implement than an exception.
        this.write16(at & ~1, byte | (byte << 8));
        return;
      case 0x6:
        this.ppu.vram[Gba.vramAddress(at)] = byte;
        return;
      default:
        return;
    }
  }

  write16(address: number, value: number): void {
    const at = address & ~1;
    const half = value & 0xffff;
    switch ((at >>> 24) & 0xf) {
      case 0x5:
        this.ppu.palette[(at & 0x3ff) >> 1] = half;
        return;
      case 0x6: {
        const base = Gba.vramAddress(at);
        this.ppu.vram[base] = half & 0xff;
        this.ppu.vram[base + 1] = (half >> 8) & 0xff;
        return;
      }
      case 0x7:
        this.ppu.oam[(at & 0x3ff) >> 1] = half;
        return;
      case 0x4:
        this.writeIo(at & 0xffff, half & 0xff);
        this.writeIo((at & 0xffff) + 1, (half >> 8) & 0xff);
        return;
      default:
        this.write8(at, half & 0xff);
        this.write8(at + 1, (half >> 8) & 0xff);
    }
  }

  write32(address: number, value: number): void {
    const at = address & ~3;
    // The two sound FIFOs are the one place a word write is not two halfword
    // writes: four samples arrive at one address and go into a queue.
    if (at >>> 24 === 0x4 && (at & 0xffff) >= 0x0a0 && (at & 0xffff) <= 0x0a4) {
      this.pushFifo((at & 0xffff) === 0x0a0 ? 0 : 1, value >>> 0);
      return;
    }
    this.write16(at, value & 0xffff);
    this.write16(at + 2, (value >>> 16) & 0xffff);
  }

  // --- registers -------------------------------------------------------------

  private readIo(at: number): number {
    switch (at) {
      case 0x000:
        return this.ppu.dispcnt & 0xff;
      case 0x001:
        return (this.ppu.dispcnt >> 8) & 0xff;
      case 0x004:
        return this.ppu.dispstat & 0xff;
      case 0x005:
        return (this.ppu.dispstat >> 8) & 0xff;
      case 0x006:
        return this.ppu.vcount & 0xff;
      case 0x007:
        return 0;
      case 0x130:
        return this.keys() & 0xff;
      case 0x131:
        return (this.keys() >> 8) & 0xff;
      case 0x132:
        return this.keycnt & 0xff;
      case 0x133:
        return (this.keycnt >> 8) & 0xff;
      case 0x200:
        return this.ie & 0xff;
      case 0x201:
        return (this.ie >> 8) & 0xff;
      case 0x202:
        return this.iff & 0xff;
      case 0x203:
        return (this.iff >> 8) & 0xff;
      case 0x204:
        return this.waitcnt & 0xff;
      case 0x205:
        return (this.waitcnt >> 8) & 0xff;
      case 0x208:
        return this.ime & 1;
      default:
        break;
    }
    if (at >= 0x008 && at <= 0x00f) {
      const value = this.ppu.bgcnt[(at - 0x008) >> 1] as number;
      return (at & 1) !== 0 ? (value >> 8) & 0xff : value & 0xff;
    }
    if (at >= 0x060 && at <= 0x0a7) return this.readSound(at);
    if (at >= 0x0b0 && at <= 0x0df) return this.readDma(at);
    if (at >= 0x100 && at <= 0x10f) return this.readTimer(at);
    return 0;
  }

  private writeIo(at: number, value: number): void {
    switch (at) {
      case 0x000:
        this.ppu.dispcnt = (this.ppu.dispcnt & 0xff00) | value;
        return;
      case 0x001:
        this.ppu.dispcnt = (this.ppu.dispcnt & 0x00ff) | (value << 8);
        return;
      case 0x004:
        // The three status flags are read-only; only the enables are writable.
        this.ppu.dispstat = (this.ppu.dispstat & 0xff07) | (value & 0xf8);
        return;
      case 0x005:
        this.ppu.dispstat = (this.ppu.dispstat & 0x00ff) | (value << 8);
        return;
      case 0x132:
        this.keycnt = (this.keycnt & 0xff00) | value;
        return;
      case 0x133:
        this.keycnt = (this.keycnt & 0x00ff) | (value << 8);
        return;
      case 0x200:
        this.ie = (this.ie & 0xff00) | value;
        return;
      case 0x201:
        this.ie = (this.ie & 0x00ff) | (value << 8);
        return;
      case 0x202:
        // Writing a one *clears* the flag; a handler acknowledges what it took.
        this.iff &= ~value & 0xffff;
        return;
      case 0x203:
        this.iff &= ~(value << 8) & 0xffff;
        return;
      case 0x204:
        this.waitcnt = (this.waitcnt & 0xff00) | value;
        return;
      case 0x205:
        this.waitcnt = (this.waitcnt & 0x00ff) | (value << 8);
        return;
      case 0x208:
        this.ime = value & 1;
        return;
      case 0x301:
        // `HALTCNT`. Bit 7 clear halts until an interrupt; set would stop the
        // whole console, which nothing here does.
        if ((value & 0x80) === 0) this.cpu.halted = true;
        return;
      default:
        break;
    }
    if (at >= 0x008 && at <= 0x00f) {
      const index = (at - 0x008) >> 1;
      const old = this.ppu.bgcnt[index] as number;
      this.ppu.bgcnt[index] =
        (at & 1) !== 0 ? (old & 0x00ff) | (value << 8) : (old & 0xff00) | value;
      return;
    }
    if (at >= 0x010 && at <= 0x01f) {
      const index = (at - 0x010) >> 2;
      const target = ((at - 0x010) & 2) !== 0 ? this.ppu.bgvofs : this.ppu.bghofs;
      const old = target[index] as number;
      target[index] = (at & 1) !== 0 ? (old & 0x00ff) | ((value & 1) << 8) : (old & 0x100) | value;
      return;
    }
    if (at >= 0x060 && at <= 0x0a7) {
      this.writeSound(at, value);
      return;
    }
    if (at >= 0x0b0 && at <= 0x0df) {
      this.writeDma(at, value);
      return;
    }
    if (at >= 0x100 && at <= 0x10f) this.writeTimer(at, value);
  }

  // --- sound -----------------------------------------------------------------

  /**
   * This console's sound-register address to the Game Boy's own register number.
   *
   * A machine description rather than a second chip, exactly as the Mega Duck's
   * is (`core/src/asm/megaduck.ts`): the same four channels, the same envelopes,
   * the same wave RAM, at addresses of their own with gaps where the Game Boy
   * has none. `undefined` means the address has no APU register behind it, and
   * such an address must not fall through as identity — the Mega Duck learned
   * that one twice (AGENTS.md §Gotchas).
   */
  private static apuRegister(at: number): number | undefined {
    if (at >= 0x090 && at <= 0x09f) return 0x30 + (at - 0x090);
    const map: Readonly<Record<number, number>> = {
      0x060: 0x10,
      0x062: 0x11,
      0x063: 0x12,
      0x064: 0x13,
      0x065: 0x14,
      0x068: 0x16,
      0x069: 0x17,
      0x06c: 0x18,
      0x06d: 0x19,
      0x070: 0x1a,
      0x072: 0x1b,
      0x073: 0x1c,
      0x074: 0x1d,
      0x075: 0x1e,
      0x078: 0x20,
      0x079: 0x21,
      0x07c: 0x22,
      0x07d: 0x23,
      0x080: 0x24,
      0x081: 0x25,
      0x084: 0x26,
    };
    return map[at];
  }

  private readSound(at: number): number {
    if (at === 0x082) return this.soundcntH & 0xff;
    if (at === 0x083) return (this.soundcntH >> 8) & 0xff;
    if (at === 0x088) return this.soundbias & 0xff;
    if (at === 0x089) return (this.soundbias >> 8) & 0xff;
    const register = Gba.apuRegister(at);
    if (register === undefined) return 0;
    return this.psg.read(register);
  }

  private writeSound(at: number, value: number): void {
    if (at === 0x082) {
      this.soundcntH = (this.soundcntH & 0xff00) | value;
      this.applySoundControl();
      return;
    }
    if (at === 0x083) {
      this.soundcntH = (this.soundcntH & 0x00ff) | (value << 8);
      // Bits 11 and 15 are one-shot resets rather than state, so they are acted
      // on and then cleared; a core that stored them would empty the queue on
      // every subsequent read-modify-write of this register.
      if ((value & 0x08) !== 0) this.pcm.resetFifo(0);
      if ((value & 0x80) !== 0) this.pcm.resetFifo(1);
      this.soundcntH &= ~0x8800;
      this.applySoundControl();
      return;
    }
    if (at === 0x088) {
      this.soundbias = (this.soundbias & 0xff00) | value;
      return;
    }
    if (at === 0x089) {
      this.soundbias = (this.soundbias & 0x00ff) | (value << 8);
      return;
    }
    const register = Gba.apuRegister(at);
    if (register === undefined) return;
    this.psg.write(register, value);
    this.apuTap?.(register, value);
  }

  /** Hand `SOUNDCNT_H`'s volume and routing bits to the converters. */
  private applySoundControl(): void {
    this.pcm.volume[0] = (this.soundcntH & 0x0004) !== 0 ? 256 : 128;
    this.pcm.volume[1] = (this.soundcntH & 0x0008) !== 0 ? 256 : 128;
    (this.pcm.enable[0] as boolean[])[0] = (this.soundcntH & 0x0200) !== 0;
    (this.pcm.enable[0] as boolean[])[1] = (this.soundcntH & 0x0100) !== 0;
    (this.pcm.enable[1] as boolean[])[0] = (this.soundcntH & 0x2000) !== 0;
    (this.pcm.enable[1] as boolean[])[1] = (this.soundcntH & 0x1000) !== 0;
  }

  /** Four samples arriving at a direct-sound FIFO, low byte first. */
  private pushFifo(channel: number, word: number): void {
    for (let index = 0; index < 4; index += 1) {
      const byte = (word >>> (index * 8)) & 0xff;
      this.pcm.push(channel, byte);
      this.fifoTap?.(channel, byte);
    }
  }

  // --- DMA -------------------------------------------------------------------

  private readDma(at: number): number {
    const channel = this.dma[((at - 0x0b0) / 12) | 0] as Dma;
    const offset = (at - 0x0b0) % 12;
    // Only the control halfword reads back; the addresses and the count are
    // write-only on this hardware.
    if (offset === 10) return channel.control & 0xff;
    if (offset === 11) return (channel.control >> 8) & 0xff;
    return 0;
  }

  private writeDma(at: number, value: number): void {
    const index = ((at - 0x0b0) / 12) | 0;
    const channel = this.dma[index] as Dma;
    const offset = (at - 0x0b0) % 12;
    if (offset < 4) {
      const shift = offset * 8;
      channel.source = ((channel.source & ~(0xff << shift)) | (value << shift)) >>> 0;
      return;
    }
    if (offset < 8) {
      const shift = (offset - 4) * 8;
      channel.dest = ((channel.dest & ~(0xff << shift)) | (value << shift)) >>> 0;
      return;
    }
    if (offset < 10) {
      const shift = (offset - 8) * 8;
      channel.count = (channel.count & ~(0xff << shift)) | (value << shift);
      return;
    }
    const shift = (offset - 10) * 8;
    const before = channel.control;
    channel.control = (channel.control & ~(0xff << shift)) | (value << shift);
    if ((before & 0x8000) === 0 && (channel.control & 0x8000) !== 0) {
      channel.liveSource = channel.source;
      channel.liveDest = channel.dest;
      // Immediate timing runs the moment the channel is enabled, which is what
      // a build's video-RAM uploads use and the only thing that makes the boot
      // sequence affordable.
      if (((channel.control >> 12) & 3) === 0) this.runDma(index);
    }
  }

  /** Perform a whole transfer, or one FIFO refill for a sound channel. */
  private runDma(index: number, fifo = false): void {
    const channel = this.dma[index] as Dma;
    const control = channel.control;
    const wide = fifo || (control & 0x0400) !== 0;
    const step = wide ? 4 : 2;
    const destMode = (control >> 5) & 3;
    const sourceMode = (control >> 7) & 3;
    const units = fifo ? 4 : channel.count === 0 ? (index === 3 ? 0x10000 : 0x4000) : channel.count;
    for (let unit = 0; unit < units; unit += 1) {
      if (wide) {
        this.write32(channel.liveDest, this.read32(channel.liveSource));
      } else {
        this.write16(channel.liveDest, this.read16(channel.liveSource));
      }
      if (sourceMode === 0) channel.liveSource = (channel.liveSource + step) >>> 0;
      else if (sourceMode === 1) channel.liveSource = (channel.liveSource - step) >>> 0;
      // A FIFO transfer holds its destination whatever the mode field says.
      if (!fifo) {
        if (destMode === 0 || destMode === 3) channel.liveDest = (channel.liveDest + step) >>> 0;
        else if (destMode === 1) channel.liveDest = (channel.liveDest - step) >>> 0;
      }
    }
    if ((control & 0x4000) !== 0) this.request(IRQ.dma0 << index);
    if ((control & 0x0200) === 0) {
      channel.control &= ~0x8000;
    } else if (destMode === 3) {
      channel.liveDest = channel.dest;
    }
  }

  // --- timers ----------------------------------------------------------------

  private readTimer(at: number): number {
    const timer = this.timers[(at - 0x100) >> 2] as Timer;
    switch ((at - 0x100) & 3) {
      case 0:
        return timer.counter & 0xff;
      case 1:
        return (timer.counter >> 8) & 0xff;
      case 2:
        return timer.control & 0xff;
      default:
        return 0;
    }
  }

  private writeTimer(at: number, value: number): void {
    const index = (at - 0x100) >> 2;
    const timer = this.timers[index] as Timer;
    switch ((at - 0x100) & 3) {
      case 0:
        timer.reload = (timer.reload & 0xff00) | value;
        return;
      case 1:
        timer.reload = (timer.reload & 0x00ff) | (value << 8);
        return;
      case 2: {
        const before = timer.control;
        timer.control = value;
        // Enabling a stopped timer loads the reload value; re-writing the
        // control of a running one does not, which is what lets a driver change
        // the interrupt enable without losing its place in the tempo.
        if ((before & 0x80) === 0 && (value & 0x80) !== 0) {
          timer.counter = timer.reload;
          timer.owed = 0;
        }
        return;
      }
      default:
        return;
    }
  }

  /** Advance the timers by `cycles`, cascading and raising as they overflow. */
  private stepTimers(cycles: number): void {
    let cascade = 0;
    for (let index = 0; index < 4; index += 1) {
      const timer = this.timers[index] as Timer;
      if ((timer.control & 0x80) === 0) {
        cascade = 0;
        continue;
      }
      let ticks: number;
      if (index > 0 && (timer.control & 0x04) !== 0) {
        ticks = cascade;
      } else {
        const divider = PRESCALE[timer.control & 3] as number;
        timer.owed += cycles;
        ticks = (timer.owed / divider) | 0;
        timer.owed -= ticks * divider;
      }
      let overflows = 0;
      while (ticks > 0) {
        const room = 0x10000 - timer.counter;
        if (ticks < room) {
          timer.counter += ticks;
          break;
        }
        ticks -= room;
        timer.counter = timer.reload;
        overflows += 1;
        // A timer whose reload is 0x10000-0 would never advance; the hardware
        // reloads to the register, and a reload of zero counts a whole period.
        if (timer.reload === 0 && ticks > 0) {
          const whole = (ticks / 0x10000) | 0;
          overflows += whole;
          ticks -= whole * 0x10000;
        }
      }
      if (overflows > 0) {
        if ((timer.control & 0x40) !== 0) this.request(IRQ.timer0 << index);
        this.serviceSound(index, overflows);
      }
      cascade = overflows;
    }
  }

  /**
   * A timer overflow, as the direct-sound channels see it.
   *
   * Each channel names the timer that clocks it, and one overflow moves one
   * eight-bit sample out of the FIFO and into the DAC. When the queue drops to
   * half, the DMA channel wired to it refills — which is the whole of how audio
   * reaches this console's speaker.
   */
  private serviceSound(timer: number, overflows: number): void {
    for (let channel = 0; channel < 2; channel += 1) {
      const selector = channel === 0 ? 10 : 14;
      if (((this.soundcntH >> selector) & 1) !== timer) continue;
      this.pcm.clock(channel, overflows);
      if (this.pcm.wantsRefill(channel)) {
        const index = channel === 0 ? 1 : 2;
        const dma = this.dma[index] as Dma;
        if ((dma.control & 0x8000) !== 0 && ((dma.control >> 12) & 3) === 3) {
          this.runDma(index, true);
        }
      }
    }
  }

  // --- interrupts and the pad ------------------------------------------------

  /** Raise an interrupt source, waking the processor if it is halted. */
  private request(mask: number): void {
    this.iff |= mask;
    if ((this.ie & mask) !== 0) this.cpu.halted = false;
  }

  /** The pad, active low, as `KEYINPUT` reports it. */
  private keys(): number {
    // Ten bits, and the language names eight of them. The shoulder buttons have
    // no word, so they stay high — released — rather than being mapped onto
    // something the program could then read as pressed.
    return (0x03ff & ~this.held) >>> 0;
  }

  /** Which buttons are down, by the abstract names the language uses. */
  setButtons(down: readonly string[]): void {
    let held = 0;
    for (const [index, name] of BUTTONS.entries()) {
      if (down.includes(name)) held |= 1 << index;
    }
    this.held = held;
  }

  // --- running ---------------------------------------------------------------

  /**
   * Run one instruction and advance everything else by what it cost.
   *
   * The interrupt is offered *before* the instruction rather than after, which is
   * the ordering every core in this project uses: a handler that ran one
   * instruction late would put the frame flag on the wrong side of a wait loop
   * about once in every few thousand frames.
   */
  stepInstruction(): number {
    if (this.ime !== 0 && (this.ie & this.iff & 0x3fff) !== 0) this.cpu.interrupt();
    const cycles = this.cpu.step();
    this.advance(cycles);
    if (this.audioSink) {
      // The APU runs at a quarter of the system clock, exactly, so this ratio
      // has no remainder to carry — unlike the Mega Drive's.
      this.psgOwed += cycles;
      const clocks = this.psgOwed >> 2;
      this.psgOwed -= clocks << 2;
      if (clocks > 0) this.psg.run(clocks, this.audioSink);
    }
    if (this.pcmSink) this.pcm.run(cycles, this.pcmSink);
    return cycles;
  }

  /** Advance the raster and the timers, raising what falls due. */
  private advance(cycles: number): void {
    this.stepTimers(cycles);
    this.cycles += cycles;
    while (this.cycles >= CYCLES_PER_LINE) {
      this.cycles -= CYCLES_PER_LINE;
      this.ppu.vcount += 1;
      if (this.ppu.vcount === FRAME_HEIGHT) {
        this.ppu.dispstat |= 1;
        if ((this.ppu.dispstat & 0x08) !== 0) this.request(IRQ.vblank);
        this.runTimedDma(1);
      }
      if (this.ppu.vcount >= LINES_PER_FRAME) {
        this.ppu.vcount = 0;
        this.ppu.dispstat &= ~1;
        this.frames += 1;
      }
      const match = (this.ppu.dispstat >> 8) & 0xff;
      if (this.ppu.vcount === match) {
        this.ppu.dispstat |= 4;
        if ((this.ppu.dispstat & 0x20) !== 0) this.request(IRQ.vcount);
      } else {
        this.ppu.dispstat &= ~4;
      }
    }
  }

  /** Run every DMA channel armed for this timing. */
  private runTimedDma(timing: number): void {
    for (let index = 0; index < 4; index += 1) {
      const channel = this.dma[index] as Dma;
      if ((channel.control & 0x8000) === 0) continue;
      if (((channel.control >> 12) & 3) !== timing) continue;
      this.runDma(index);
    }
  }

  /** Run to the start of the next vertical blank; the speed measurement's clock. */
  runFrame(): number {
    const target = this.frames + 1;
    let cycles = 0;
    for (let guard = 0; guard < 4_000_000 && this.frames < target; guard += 1) {
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
