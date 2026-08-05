/**
 * The Neo Geo Pocket around its processor: memory, the cartridge, and the boot
 * ROM's job.
 *
 * Three things about this machine decide the shape of this file.
 *
 *   - **The boot ROM is ours, and it is four lines.** SNK's is not something
 *     this project ships, and a demade cartridge needs almost nothing from it:
 *     read the entry address out of the header, point the stack somewhere, jump.
 *     `@demake/snes` takes the same position about that console's sound-processor
 *     boot ROM — implement the *documented* hand-off rather than transcribe
 *     somebody's code — and this is the same bargain one console along.
 *   - **An interrupt handler is a pointer in RAM.** The processor has a vector
 *     table of its own and the boot ROM owns it, dispatching through a table at
 *     `$6FB8` instead. So a cartridge installs a vertical-blank handler by
 *     *writing four bytes*, and this machine reads them and calls — which is
 *     what {@link Ngp.step} does at the end of every frame.
 *   - **Video memory is memory.** `$8000`–`$BFFF` is the display controller's,
 *     and the processor writes to it directly with no port and no upload, so the
 *     array this machine allocates is the same one {@link Display} reads.
 *
 * **Input is absent rather than half-implemented.** The controller status byte's
 * bit layout is not in either hardware reference this project could reach, and a
 * machine description that is wrong *and consistent* passes every test there is
 * (AGENTS.md §Gotchas) — so there is no button register here at all, and adding
 * one is a matter of pinning it against a source rather than of writing code.
 * The sound processor, its four kilobytes and the on-chip timers are absent on
 * the same terms.
 */

import {
  NGP_ENTRY_OFFSET,
  NGP_RAM,
  NGP_RAM_RESERVED,
  NGP_RAM_SIZE,
  NGP_ROM_BASE,
  NGP_VECTOR_VBLANK,
  NGP_VIDEO,
  NGP_Z80_RAM,
} from "@demake/core";

import { Tlcs900, type Bus } from "./cpu.js";
import { Display, VIDEO_SIZE, type NgpModel } from "./display.js";

/** Bytes of RAM the sound processor and the main CPU share. */
const SOUND_RAM_SIZE = 0x1000;

/**
 * Where a cartridge's stack starts.
 *
 * The top of the RAM a cartridge may use, growing down — this machine's choice
 * rather than the hardware's, because the boot ROM that would have made it is
 * one this project does not ship. A build that wants its own says so by writing
 * `XSP` in its first instructions.
 */
export const DEFAULT_STACK = NGP_RAM_RESERVED;

export class Ngp implements Bus {
  /** Twelve kilobytes at `$4000`, of which the top kilobyte is the boot ROM's. */
  readonly ram = new Uint8Array(NGP_RAM_SIZE);

  /** The sound processor's four kilobytes, which the main CPU can also address. */
  readonly soundRam = new Uint8Array(SOUND_RAM_SIZE);

  /** `$8000`–`$BFFF`: registers, palettes, maps, objects and characters. */
  readonly video = new Uint8Array(VIDEO_SIZE);

  /** The processor's own on-chip register page at `$0000`. */
  readonly io = new Uint8Array(0x100);

  /** The cartridge, as it answers from `$200000`. */
  rom: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  readonly cpu = new Tlcs900(this);

  readonly display: Display;

  /** Frames completed since the machine was loaded. */
  frames = 0;

  constructor(readonly model: NgpModel = "ngpc") {
    this.display = new Display(model, this.video);
  }

  /**
   * Load a cartridge and perform the boot ROM's hand-off.
   *
   * The entry address is a 24-bit little-endian field in the header rather than
   * a vector the processor fetches, so there is nothing to chase: read it, point
   * the stack at the top of usable RAM, and go.
   */
  load(rom: Uint8Array, stack = DEFAULT_STACK): void {
    this.rom = rom;
    this.ram.fill(0);
    this.video.fill(0);
    this.io.fill(0);
    this.frames = 0;
    const entry =
      (rom[NGP_ENTRY_OFFSET] as number) |
      ((rom[NGP_ENTRY_OFFSET + 1] as number) << 8) |
      ((rom[NGP_ENTRY_OFFSET + 2] as number) << 16);
    this.cpu.reset(entry, stack);
  }

  read(address: number): number {
    const at = address & 0xffffff;
    if (at >= NGP_ROM_BASE) {
      const offset = at - NGP_ROM_BASE;
      // An address past the end of the board reads as erased flash, which is
      // what an unpopulated device does.
      return offset < this.rom.length ? (this.rom[offset] as number) : 0xff;
    }
    if (at >= NGP_VIDEO && at < NGP_VIDEO + VIDEO_SIZE) {
      return this.video[at - NGP_VIDEO] as number;
    }
    if (at >= NGP_Z80_RAM && at < NGP_Z80_RAM + SOUND_RAM_SIZE) {
      return this.soundRam[at - NGP_Z80_RAM] as number;
    }
    if (at >= NGP_RAM && at < NGP_RAM + NGP_RAM_SIZE) {
      return this.ram[at - NGP_RAM] as number;
    }
    if (at < 0x100) return this.io[at] as number;
    return 0;
  }

  write(address: number, value: number): void {
    const at = address & 0xffffff;
    const byte = value & 0xff;
    if (at >= NGP_ROM_BASE) return; // flash, and nothing here writes to it
    if (at >= NGP_VIDEO && at < NGP_VIDEO + VIDEO_SIZE) {
      this.video[at - NGP_VIDEO] = byte;
      return;
    }
    if (at >= NGP_Z80_RAM && at < NGP_Z80_RAM + SOUND_RAM_SIZE) {
      this.soundRam[at - NGP_Z80_RAM] = byte;
      return;
    }
    if (at >= NGP_RAM && at < NGP_RAM + NGP_RAM_SIZE) {
      this.ram[at - NGP_RAM] = byte;
      return;
    }
    if (at < 0x100) this.io[at] = byte;
  }

  /**
   * Run one instruction and give the display what it cost.
   *
   * When the beam reaches the first blanked line the vertical-blank handler is
   * called if one has been installed — which the reference says cannot be
   * masked, so this asks about the pointer rather than about the interrupt
   * enable.
   */
  step(): number {
    const cycles = this.cpu.step();
    if (this.display.step(cycles)) {
      this.frames += 1;
      const handler = this.vector(NGP_VECTOR_VBLANK);
      if (handler !== 0) this.cpu.interrupt(handler);
    }
    return cycles;
  }

  /** Run until the next frame has been completed. */
  runFrame(limit = 400_000): void {
    const target = this.frames + 1;
    for (let step = 0; step < limit && this.frames < target; step += 1) this.step();
  }

  /** Read one of the boot ROM's dispatch pointers out of RAM. */
  private vector(address: number): number {
    const at = address - NGP_RAM;
    return (
      ((this.ram[at] as number) |
        ((this.ram[at + 1] as number) << 8) |
        ((this.ram[at + 2] as number) << 16)) &
      0xffffff
    );
  }
}
