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
 * **Input goes through the one description, and that description is
 * unverified.** The controller byte's address is confirmed by every reference
 * this project could reach and its *bit order* is in none of them, so
 * `NGP_BUTTON_BITS` writes it down as a guess rather than hiding it — and this
 * core writes the byte through those same constants a cartridge reads it
 * through. That is exactly the shape AGENTS.md §Gotchas warns about: a machine
 * description that is wrong *and consistent* passes every test there is. It is
 * one line to change when a source turns up, and both readers pick it up.
 *
 * **The sound chip is here and the sound *processor* is not**, which is the
 * hardware offering two routes and a demade cartridge taking the simpler one.
 * On the board the T6W28's own bus belongs to a Z80 that runs its own program;
 * the main CPU can also reach the chip through two bytes of its own I/O page,
 * once it has written the pair that hands it over. `demake build` emits no Z80
 * program, so it takes that route and this machine models it — the four
 * kilobytes the two processors share are ordinary RAM here, and the Z80 that
 * would read them is absent rather than half-implemented, as are the on-chip
 * timers and DMA.
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
  NGP_BUTTON_BITS,
  NGP_BUTTONS,
  NGP_SOUND_ENABLE,
  NGP_SOUND_ENABLE_HIGH,
  NGP_SOUND_ENABLE_HIGH_VALUE,
  NGP_SOUND_ENABLE_VALUE,
  NGP_SOUND_LEFT,
  NGP_SOUND_RIGHT,
} from "@demake/core";
import { T6w28, T6W28_LEFT, T6W28_RIGHT, type SampleSink } from "@demake/chip";

import { Tlcs900, type Bus } from "./cpu.js";
import { Display, VIDEO_SIZE, type NgpModel } from "./display.js";

/** Bytes of RAM the sound processor and the main CPU share. */
const SOUND_RAM_SIZE = 0x1000;

/**
 * Master clocks in one processor state.
 *
 * The TLCS-900/H's system clock is the crystal halved and its instruction
 * timings are in *states* of that clock, while the display controller counts the
 * crystal itself — so this is the ratio between the two, and the reason
 * {@link Ngp.step} multiplies for one of them and not the other.
 */
const MASTER_PER_STATE = 2;

/**
 * Where a cartridge's stack starts.
 *
 * The top of the RAM a cartridge may use, growing down — this machine's choice
 * rather than the hardware's, because the boot ROM that would have made it is
 * one this project does not ship. A build that wants its own says so by writing
 * `XSP` in its first instructions.
 */
export const DEFAULT_STACK = NGP_RAM_RESERVED;

/**
 * Keys, as the language names them.
 *
 * Seven, which is doc 14's portable floor — and the seventh is Option, because
 * this console has no separate Start and Option is the button a game pauses on.
 */
export const BUTTONS = ["left", "right", "up", "down", "a", "b", "start"] as const;

/** One key. */
export type Button = (typeof BUTTONS)[number];

/** Which bit of the controller byte each abstract key is, once. */
const KEY_BITS: readonly number[] = BUTTONS.map(
  (button) => NGP_BUTTON_BITS[button === "start" ? "option" : button] ?? 0,
);

export class Ngp implements Bus {
  /** Twelve kilobytes at `$4000`, of which the top kilobyte is the boot ROM's. */
  readonly ram = new Uint8Array(NGP_RAM_SIZE);

  /** The sound processor's four kilobytes, which the main CPU can also address. */
  readonly soundRam = new Uint8Array(SOUND_RAM_SIZE);

  /** `$8000`–`$BFFF`: registers, palettes, maps, objects and characters. */
  readonly video = new Uint8Array(VIDEO_SIZE);

  /** The processor's own on-chip register page at `$0000`. */
  readonly io = new Uint8Array(0x100);

  /** The sound chip, which the main CPU reaches through two I/O bytes. */
  readonly sound = new T6w28();

  /**
   * Whether the main CPU has taken the sound chip from the Z80.
   *
   * Both bytes of the unlock, and until they are there a write to either port
   * does nothing — which is the hardware's own arrangement rather than a guard
   * this model invented, and the reason a cartridge's boot writes two bytes it
   * would otherwise have no reason to.
   */
  private get soundEnabled(): boolean {
    return (
      this.io[NGP_SOUND_ENABLE] === NGP_SOUND_ENABLE_VALUE &&
      this.io[NGP_SOUND_ENABLE_HIGH] === NGP_SOUND_ENABLE_HIGH_VALUE
    );
  }

  /**
   * Every write the sound chip receives, reported rather than intercepted.
   *
   * The audio conformance oracle's entire interface to the machine (doc 16 §The
   * proof, Level A). It observes rather than intercepts — the write still
   * reaches the chip — because an oracle that changed what the hardware saw
   * would be testing itself.
   *
   * The register it reports is `@demake/chip`'s numbering, which is the
   * numbering a `ChipScript` carries: the *port*, because on this chip that is
   * what a register number is. An oracle that saw only the byte could not tell
   * a left-hand attenuator from a right-hand one.
   */
  soundTap: ((reg: number, value: number) => void) | undefined = undefined;

  /**
   * Where the chip's samples go, when anything is listening.
   *
   * Left unset the chip still receives every write and keeps its state; it is
   * only *rendered* when a sink is attached, so the conformance suites pay
   * nothing for hardware they never listen to.
   */
  audioSink: SampleSink | undefined = undefined;

  /** The cartridge, as it answers from `$200000`. */
  rom: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  readonly cpu = new Tlcs900(this);

  readonly display: Display;

  /** Frames completed since the machine was loaded. */
  frames = 0;

  /** Which keys are down, as the controller byte the cartridge will read. */
  private held = 0;

  /**
   * Load a cartridge, if one is given.
   *
   * Which Neo Geo Pocket this is is *not* a header's decision: these two
   * machines differ in nothing a cartridge could record, so the caller names it
   * — the WonderSwan's arrangement, one console along.
   */
  constructor(
    rom?: Uint8Array,
    readonly model: NgpModel = "ngpc",
  ) {
    this.display = new Display(model, this.video);
    if (rom) this.load(rom);
  }

  /** The picture, as RGBA. */
  get framebuffer(): Uint8ClampedArray {
    return this.display.framebuffer;
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
    // The keys survive a reload, because a harness sets them before it boots.
    this.write(NGP_BUTTONS, this.held);
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
    if (at >= 0x100) return;
    this.io[at] = byte;
    if (at !== NGP_SOUND_RIGHT && at !== NGP_SOUND_LEFT) return;
    if (!this.soundEnabled) return;
    const port = at === NGP_SOUND_LEFT ? T6W28_LEFT : T6W28_RIGHT;
    this.sound.write(port, byte);
    this.soundTap?.(port, byte);
  }

  /**
   * Run one instruction and give the display and the chip what it cost.
   *
   * **A processor state is not a master cycle**, and this is the one place on
   * this machine where the difference is visible. A TLCS-900/H's own unit is the
   * *state* — its system clock, which is the 6.144 MHz crystal halved — and
   * {@link Tlcs900.step} counts those, because that is what the instruction
   * timings in the datasheet are in. The display controller counts the crystal:
   * 515 of them a line and 199 lines a frame, which is what puts this console at
   * 59.95 Hz. So the display is handed twice what the processor spent, and the
   * sound chip is handed it unchanged — the chip runs at the crystal halved too,
   * so it and the processor are the one pair on this board whose clocks agree.
   *
   * When the beam reaches the first blanked line the vertical-blank handler is
   * called if one has been installed — which the reference says cannot be
   * masked, so this asks about the pointer rather than about the interrupt
   * enable.
   */
  step(): number {
    const states = this.cpu.step();
    if (this.audioSink) this.sound.run(states, this.audioSink);
    if (this.display.step(states * MASTER_PER_STATE)) {
      this.frames += 1;
      const handler = this.vector(NGP_VECTOR_VBLANK);
      if (handler !== 0) this.cpu.interrupt(handler);
    }
    return states;
  }

  /** Run one instruction and clock the display with what it cost. */
  stepInstruction(): number {
    return this.step();
  }

  /** Run until the next frame boundary, and return the frame index. */
  runFrame(limit = 4_000_000): number {
    const target = this.frames + 1;
    let guard = 0;
    while (this.frames < target) {
      this.step();
      // A runtime that hangs must fail a harness rather than the process.
      if ((guard += 1) > limit) throw new Error("ngp: no frame after 4M instructions");
    }
    return this.frames;
  }

  /**
   * Set which keys are down.
   *
   * The byte lives in the boot ROM's reserved page rather than behind a port, so
   * "the controller" on this machine is four bytes of RAM somebody else's
   * firmware would have written — which is why this is a plain store and why the
   * bit numbers come from the one description both sides read.
   */
  setButtons(down: Iterable<Button>): void {
    let mask = 0;
    for (const button of down) {
      const index = BUTTONS.indexOf(button as Button);
      if (index >= 0) mask |= 1 << (KEY_BITS[index] as number);
    }
    this.held = mask;
    this.write(NGP_BUTTONS, mask);
  }

  /**
   * Read `length` bytes of the machine's address space — the trace reader's
   * window.
   *
   * Through the bus rather than out of the RAM array, because on this console a
   * plan's addresses are the machine's: work RAM at `$4000`, the display's own
   * memory at `$8000` and the cartridge at `$200000` are all things a caller may
   * legitimately want to look at, and one of them is not an array this class
   * owns.
   */
  readMemory(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = this.read(address + index);
    return out;
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
