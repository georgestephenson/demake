/**
 * The console around the processor: memory map, mapper, VDP, PSG, controllers.
 *
 * The Sega counterpart of `@demake/dmg`'s `Gameboy` and `@demake/nes`'s `Nes`,
 * for the same two jobs (doc 14 §Conformance, doc 07 §no CDN): boot a
 * `demake build` cartridge in Vitest with no toolchain and no emulator install,
 * and play one in the page without fetching a core from anywhere.
 *
 * One class is two machines, decided by the cartridge's own region nibble — the
 * arrangement `@demake/dmg` already uses for the DMG and the Game Boy Color, and
 * for the same reason: which console this is, is a property of the cartridge and
 * never a setting. A Game Gear ROM comes up with two-byte colour entries and a
 * 160×144 window; a Master System one comes up with one-byte entries and the
 * full frame. Nothing else differs, because on this hardware nothing else does.
 *
 * Scope is what the backend emits. **A 32 KiB cartridge**, so the mapper's bank
 * registers are implemented — a write to `$FFFC`–`$FFFF` is a write to ordinary
 * RAM as well, and a game that stored state there would page itself out — but
 * nothing pages, because the whole image is visible from reset.
 *
 * The PSG is not implemented here: it is `@demake/chip`'s `Sn76489`, the same
 * model the audio pipeline renders previews with (doc 16 §Packages). This module
 * only routes the port writes to it and offers the tap the audio proof reads.
 *
 * Sources: SMS Power! — Memory Map (https://www.smspower.org/Development/MemoryMap),
 * Port $DC (https://www.smspower.org/Development/PeripheralPorts) and Game Gear
 * Programming (https://www.smspower.org/Development/GameGearProgramming).
 */

import { Sn76489, type SampleSink } from "@demake/chip";

import { type Bus, Z80 } from "./cpu.js";
import {
  CYCLES_PER_LINE,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  GG_HEIGHT,
  GG_WIDTH,
  LINES_PER_FRAME,
  Vdp,
} from "./vdp.js";

export { FRAME_HEIGHT, FRAME_WIDTH, GG_HEIGHT, GG_WIDTH };

/** CPU cycles in one NTSC frame. */
export const FRAME_CYCLES = LINES_PER_FRAME * CYCLES_PER_LINE;

/**
 * The abstract buttons, in the order the controller port reports the first six.
 *
 * `start` is the odd one and the language says so (doc 14's button table): a
 * Master System pad has no Start button at all. The console's Pause button is
 * wired to the CPU's non-maskable interrupt instead, so that is what `start`
 * means here — a real button on a Game Gear, and an interrupt on a Master
 * System. Mapping it onto a face button would make two of the pad's buttons the
 * same one, which is worse than a warning.
 */
export const BUTTONS = ["up", "down", "left", "right", "a", "b", "start"] as const;

/** One controller button. */
export type Button = (typeof BUTTONS)[number];

/** Where the region nibble lives inside a cartridge, and what it means. */
const HEADER_OFFSET = 0x7ff0;

/** A Master System or a Game Gear, with a mapper-less cartridge in it. */
export class Sms implements Bus {
  readonly cpu = new Z80(this);
  readonly vdp: Vdp;
  /** The sound hardware — `@demake/chip`'s model, not a second one. */
  readonly psg: Sn76489;
  /** The whole cartridge image. */
  readonly rom: Uint8Array;
  /** The console's 8 KiB, which is the whole of a game's state. */
  readonly ram = new Uint8Array(0x2000);
  /** Which machine the cartridge declared itself for. */
  readonly gameGear: boolean;

  /** Frames completed since power-on — the harness's clock. */
  frames = 0;

  /** The mapper's three bank registers, and the slot-2 RAM enable. */
  private readonly banks = new Uint8Array([0, 1, 2]);
  private held = 0;
  /** A Pause press waiting to be taken, on a machine where Pause is an interrupt. */
  private pausePending = false;
  private startWasDown = false;

  /**
   * Called for every write the CPU makes to the sound chip.
   *
   * The audio conformance oracle's entire interface to the machine (doc 16 §The
   * proof, Level A). It observes rather than intercepts — the write still
   * reaches the PSG — because an oracle that changed what the hardware saw would
   * be testing itself.
   *
   * The register it reports is `@demake/chip`'s numbering, which is the numbering
   * a `ChipScript` carries: `0` for the chip's one write port and `$06` for the
   * Game Gear's stereo latch. Two different devices, so an oracle that saw only
   * the byte could not tell a pan change from a note.
   */
  psgTap: ((reg: number, value: number) => void) | undefined = undefined;

  /**
   * Where the PSG's samples go, when anything is listening.
   *
   * Left unset the chip still receives every write and keeps its state; it is
   * only *rendered* when a sink is attached, so the conformance suites pay
   * nothing for hardware they never listen to.
   */
  audioSink: SampleSink | undefined = undefined;

  constructor(rom: Uint8Array) {
    if (rom.length < HEADER_OFFSET + 16) {
      throw new Error("sms: a cartridge is at least 32 KiB");
    }
    this.rom = rom;
    const region = (rom[HEADER_OFFSET + 15] as number) >> 4;
    this.gameGear = region >= 5;
    this.vdp = new Vdp(this.gameGear ? "gg" : "sms");
    this.psg = new Sn76489({ stereo: this.gameGear });
    this.cpu.reset();
  }

  /** The picture the console's screen shows, as RGBA. */
  get framebuffer(): Uint8ClampedArray {
    return this.vdp.view().pixels;
  }

  // --- bus -------------------------------------------------------------------

  /**
   * Map a CPU address into the cartridge.
   *
   * The first kilobyte is never paged — it holds the reset and interrupt vectors,
   * and paging it out would take the interrupt handler with it. Everything above
   * that goes through the bank register for its slot, masked by how many banks
   * the cartridge really has so a 32 KiB image wraps instead of reading past its
   * end.
   */
  private romAddress(at: number): number {
    if (at < 0x0400) return at;
    const slot = at >> 14;
    const bank = (this.banks[slot] as number) % Math.max(1, this.rom.length >> 14);
    return (bank << 14) | (at & 0x3fff);
  }

  read(address: number): number {
    const at = address & 0xffff;
    if (at < 0xc000) return this.rom[this.romAddress(at)] as number;
    return this.ram[at & 0x1fff] as number;
  }

  write(address: number, value: number): void {
    const at = address & 0xffff;
    const byte = value & 0xff;
    // The cartridge is ROM; a store there is a no-op except at the mapper's own
    // four bytes, which are decoded out of the RAM mirror rather than out of it.
    if (at < 0xc000) return;
    this.ram[at & 0x1fff] = byte;
    if (at >= 0xfffc) {
      if (at > 0xfffc) this.banks[at - 0xfffd] = byte;
      return;
    }
  }

  in(port: number): number {
    const at = port & 0xff;
    if (this.gameGear && at < 0x07) {
      // $00 carries the Start button, active low, and the region bit above it.
      if (at === 0x00) return (this.isDown("start") ? 0x00 : 0x80) | 0x40;
      return 0xff;
    }
    if (at < 0x40) return 0xff; // memory and I/O control are write-only
    if (at < 0x80) return (at & 1) === 0 ? this.vdp.vCounter : this.vdp.hCounter;
    if (at < 0xc0) return (at & 1) === 0 ? this.vdp.readData() : this.vdp.readControl();
    return (at & 1) === 0 ? this.readPortA() : this.readPortB();
  }

  out(port: number, value: number): void {
    const at = port & 0xff;
    const byte = value & 0xff;
    if (this.gameGear && at === 0x06) {
      // The Game Gear's stereo register lives on the PSG, not on the VDP.
      this.psg.write(0x06, byte);
      this.psgTap?.(0x06, byte);
      return;
    }
    if (at < 0x40) return; // memory control and I/O control: nothing to model
    if (at < 0x80) {
      // Both halves of this range are the sound chip's one write port.
      this.psg.write(0, byte);
      this.psgTap?.(0, byte);
      return;
    }
    if (at < 0xc0) {
      if ((at & 1) === 0) this.vdp.writeData(byte);
      else this.vdp.writeControl(byte);
      return;
    }
    // The controller ports are inputs; a write to them does nothing here.
  }

  // --- controllers -----------------------------------------------------------

  /**
   * Set which buttons are down.
   *
   * A rising edge on `start` is a Pause press on a Master System, so it is
   * latched here rather than sampled: the interrupt fires once per press, which
   * is what the hardware does and what a title screen expects.
   */
  setButtons(down: Iterable<Button>): void {
    let mask = 0;
    for (const button of down) {
      const index = BUTTONS.indexOf(button);
      if (index >= 0) mask |= 1 << index;
    }
    this.held = mask;
    const start = this.isDown("start");
    if (!this.gameGear && start && !this.startWasDown) this.pausePending = true;
    this.startWasDown = start;
  }

  private isDown(button: Button): boolean {
    return (this.held & (1 << BUTTONS.indexOf(button))) !== 0;
  }

  /** Port `$DC`: player one's six inputs, active low, in the pad's own order. */
  private readPortA(): number {
    let bits = 0xff;
    for (let index = 0; index < 6; index += 1) {
      if ((this.held & (1 << index)) !== 0) bits &= ~(1 << index);
    }
    return bits & 0xff;
  }

  /** Port `$DD`: player two, the reset button, and the two `TH` lines. */
  private readPortB(): number {
    return 0xff;
  }

  // --- timing ----------------------------------------------------------------

  /** Run one instruction (or an interrupt dispatch) and clock the hardware. */
  stepInstruction(): number {
    let cycles = 0;
    if (this.pausePending) {
      this.pausePending = false;
      cycles += this.cpu.nmi();
    } else if (this.vdp.irq) {
      cycles += this.cpu.interrupt();
    }
    cycles += this.cpu.step();
    const before = this.vdp.frames;
    this.vdp.step(cycles);
    if (this.vdp.frames !== before) this.frames = this.vdp.frames;
    // The PSG's clock is the CPU's on this hardware, so one cycle is one chip
    // clock and there is no ratio to get wrong.
    if (this.audioSink) this.psg.run(cycles, this.audioSink);
    return cycles;
  }

  /** Run until the start of the next frame, and return the frame index. */
  runFrame(): number {
    const target = this.frames + 1;
    let guard = 0;
    while (this.frames < target) {
      this.stepInstruction();
      // A runtime that hangs must fail the harness rather than the process.
      if ((guard += 1) > 4_000_000) throw new Error("sms: no frame after 4M instructions");
    }
    return this.frames;
  }

  /** Read `length` bytes from an absolute address — the trace reader's window. */
  readMemory(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = this.read(address + index);
    return out;
  }
}
