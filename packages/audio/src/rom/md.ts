/**
 * The Mega Drive audio driver: a bootable cartridge that plays a `ChipScript`.
 *
 * The fifth standalone cartridge, and the first whose **clock register lives on
 * the chip it is playing**. Everywhere else the two are separate devices — a
 * Game Boy's timer is the CPU's, an NES's is the picture's, a PC Engine's is the
 * CPU's, a Sega 8-bit's is the VDP's — so a schedule and a driver could never
 * write the same byte. Here they can, and three things follow.
 *
 *   - **The boot prefix must be stripped, or the schedule switches off its own
 *     clock.** `binding/md.ts`'s initialisation writes `$27 = 0` ("no timers,
 *     channel 3 in normal mode"), and `$27` is exactly the register the driver
 *     programmes. Performed at the head of the stream, tick 0 would stop the
 *     timer that was about to deliver tick 1. So the prefix comes off and is
 *     performed once from a table at boot, which is the PC Engine's mechanism
 *     reached for a reason neither predecessor has: there it makes a schedule
 *     *packable*, on a Game Boy it merely stops an effect powering the chip up
 *     again, and here it is what keeps the cartridge running at all.
 *   - **The clock is polled, and on this console that is exact rather than a
 *     compromise.** The YM2612's timer A is a real programmable clock, but on
 *     this board its interrupt line goes to the Z80 rather than to the 68000 —
 *     which is why a *game* cannot have it (`rom/index.ts` §`GAME_CLOCKS`): a
 *     game would have to poll it from a main loop whose period is the game's own
 *     work, so the rate would be the loop's and not the timer's. A cartridge
 *     whose main loop does nothing but poll has no such period. It reads the
 *     status byte every few microseconds against a tick of a hundred and
 *     thirty-seven thousand cycles, so what it keeps is the timer's rate, and
 *     the drift is bounded by one poll rather than by one frame.
 *   - **The overflow is acknowledged without reloading.** Writing `$27` with the
 *     reset bit set and the run bit still set clears the flag and leaves the
 *     counter free-running, so the acknowledge's own latency never accumulates.
 *     Clearing and restarting would lose exactly the time the poll took, every
 *     tick, for ever.
 *
 * Two more facts are the board's rather than the chip's. The **Z80 is held in
 * reset and its bus is held by the 68000**, because the FM chip at `$A04000` is
 * decoded inside the Z80's address space and this cartridge ships no Z80
 * program — a sound processor left running whatever powered up is a second
 * writer on the bus. And the packed format is **always the run format**, even
 * with one stream and nothing to preempt, for the reason `md-game.ts` already
 * gives: a tick that installs six four-operator patches is four hundred writes
 * and a run's count is seven bits, so the chaining is what makes tick 0
 * expressible at all.
 *
 * Sources:
 * - Sega — Genesis Software Manual (VDP and bus arbitration).
 * - Nemesis — YM2612 register and timer documentation, Sega-16 forums.
 */

import {
  Asm68k,
  AsmError,
  eaAbs,
  eaD,
  eaIdx,
  eaImm,
  eaInd,
  eaPost,
  label,
  MD_CHECKSUM_START,
  MD_ROM_SIZES,
  packMdRom,
} from "@demake/core";

import type { ChipScript, Rational } from "../chipscript.js";
import { bindingFor } from "../binding/registry.js";

import type { DriverData } from "./data.js";
import { AudioRomError, type AudioRomOptions, type BuiltAudioRom } from "./gb.js";
import { checkMdLatchDiscipline, mdChannelTag, mdPort, MD_PSG_PORT, YM_CHIP } from "./md-chips.js";
import {
  emitStream,
  emitStreamData,
  PSG_ADDRESS,
  YM_ADDRESS,
  type MdStreamState,
} from "./md-driver.js";
import { pack, rateHz, stripBoot } from "./shared.js";

/** Where the 68000 starts and where the stack lives — the top of work RAM. */
const STACK_TOP = 0xfffffe;

/**
 * The security register a model-1+ console holds the VDP off the bus until.
 *
 * The version register's low nibble says whether this machine has one, which is
 * why the write is guarded rather than unconditional: an early console has no
 * such register and writing there is a bus error.
 */
const TMSS = { VERSION: 0xa10001, REGISTER: 0xa14000, KEY: 0x53454741 } as const;

/** The sound processor's bus request and reset lines. */
const Z80 = { BUS: 0xa11100, RESET: 0xa11200 } as const;

/** The VDP's control port, which is where its registers are written. */
const VDP_CONTROL = 0xc00004;

/** The FM chip's timer registers, and the two values the driver writes to `$27`. */
const TIMER = {
  /** Timer A's reload, high eight bits. */
  HIGH: 0x24,
  /** Timer A's reload, low two bits. */
  LOW: 0x25,
  /** Load A and enable its overflow flag; channel 3 stays in normal mode. */
  CONTROL: 0x27,
  /** What starts it: run A, flag A enabled. */
  START: 0x05,
  /**
   * What acknowledges an overflow: the same, plus the reset bit.
   *
   * The run bit stays set, so the counter is *not* reloaded — the hardware only
   * reloads when the bit goes from clear to set. That is what keeps the poll's
   * own latency out of the tempo.
   */
  ACK: 0x15,
} as const;

/** Where the terminator sits in the boot table, which no port byte can be. */
const BOOT_END = 0xff;

/**
 * The driver's state, in work RAM.
 *
 * Longwords, because a pointer on this CPU is one — and even-aligned, because an
 * odd word or long access is an address error on a 68000. A standalone cartridge
 * owns the whole 64 KiB, so the layout starts at the first byte of it.
 */
const STATE: MdStreamState = {
  data: 0xff0000,
  order: 0xff0004,
  loop: 0xff0008,
  rest: 0xff000c,
};

/** The tick rate, and the reload register that produces it. */
interface Clock {
  rate: Rational;
  /** Timer A's ten-bit reload, as `$24`/`$25` hold it. */
  reload: number;
}

/**
 * Resolve a schedule's driver clock to the register that produces it.
 *
 * The opposite refusal from `resolveMdClock`'s, and the pair is the point: a
 * *game* on this console can only have the frame, because polling the timer from
 * a loop that is also running a game gives the loop's rate; a cartridge whose
 * loop does nothing else can have the timer exactly. So each names the clock the
 * other cannot keep rather than quietly accepting both.
 */
export function resolveMdAudioClock(script: ChipScript): Clock {
  const { rate, source, divisor } = script.driver;
  if (source !== "timer") {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `a standalone md audio cartridge has no '${source}' clock`,
      "this cartridge polls the YM2612's timer A, which is the finest clock the board offers a 68000; re-arrange with `timer`.",
    );
  }
  if (divisor === undefined || !Number.isInteger(divisor) || divisor < 0 || divisor > 0x3ff) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `${rateHz(rate)} Hz arrived without a timer reload the chip can hold`,
      "a schedule carries the register that makes its rate as well as the rate; this is a bug in the timing fit, not in the track.",
    );
  }
  return { rate, reload: divisor };
}

/** Build a cartridge that plays this schedule on a Mega Drive. */
export function buildMdAudioRom(script: ChipScript, options: AudioRomOptions = {}): BuiltAudioRom {
  const clock = resolveMdAudioClock(script);
  const boot = bindingFor(script.console).init();
  // Stripped, so no tick can write `$27` and stop the clock it runs on. What
  // comes off is performed once from `AudioBoot`, and `performed` is what the
  // conformance harness diffs against.
  const performed = stripBoot(script, boot);
  checkMdLatchDiscipline(performed);

  // Always the run format, even with one stream and nothing to preempt: a tick
  // that installs six four-operator patches is four hundred writes and a run's
  // count is seven bits, so the flags byte per run is what buys the chaining.
  // Nothing is stealable here, so every run tags no channel at all.
  const data = pack(performed, { channelOf: mdChannelTag([]), port: mdPort });

  const attempt = () => {
    const asm = new Asm68k(MD_CHECKSUM_START);
    const built = emitDriver(asm, data, clock, boot);
    try {
      return { asm, code: asm.assemble(), ...built };
    } catch (error) {
      if (error instanceof AsmError) {
        throw new AudioRomError(
          "E_INTERNAL",
          `the driver emitter produced invalid code: ${error.message}`,
        );
      }
      throw error;
    }
  };

  const finished = attempt();
  // The smallest board this console shipped that holds the program. The code is
  // assembled once because nothing in it moves with the cartridge size: the
  // whole image is mapped from `$000000` and the header records where it ends,
  // so growing one is padding a bigger array (`asm/md-cart.ts` §`MD_ROM_SIZES`).
  const needed = finished.code.length + MD_CHECKSUM_START;
  const size = MD_ROM_SIZES.find((board) => board >= needed);
  if (size === undefined) {
    throw new AudioRomError(
      "E_TRACK_TOO_LARGE",
      `this driver assembles to ${finished.code.length} bytes and the largest flat Mega Drive cartridge holds ${(MD_ROM_SIZES[MD_ROM_SIZES.length - 1] as number) - MD_CHECKSUM_START}`,
      "shorten the track, loop it earlier, or arrange with fewer per-tick writes; bank switching is not in v1.",
    );
  }

  const reset = finished.asm.symbols().get("Reset") as number;
  const wanted = script.driver.rate.num / script.driver.rate.den;
  const actual = clock.rate.num / clock.rate.den;

  return {
    bytes: packMdRom(finished.code, reset, STACK_TOP, {
      size,
      ...(options.title === undefined ? {} : { title: options.title }),
    }),
    symbols: finished.asm.symbols(),
    performed,
    stats: {
      code: finished.dataStart - MD_CHECKSUM_START,
      data: finished.code.length - (finished.dataStart - MD_CHECKSUM_START),
      free: size - MD_CHECKSUM_START - finished.code.length,
      ticks: data.ticks,
      blocks: data.blocks.length,
      order: data.order.length,
      blocksSaved: data.blocksSaved,
      helpers: finished.helpers,
      rate: clock.rate,
      ratePpmError: wanted === 0 ? 0 : Math.round(((actual - wanted) / wanted) * 1e6),
    },
  };
}

/**
 * Emit the whole program and report which routines it pulled in.
 *
 * Assembled at `$000200` rather than at zero, because that is where the
 * cartridge puts it: the vectors and the header come first and are
 * `packMdRom`'s. Assembling at zero and adding the offset afterwards would fix
 * the symbol table and leave every *absolute* reference inside the code two
 * hundred bytes low — a `jsr` into the middle of the header, which is a
 * cartridge that boots and immediately executes its own title string.
 */
function emitDriver(
  asm: Asm68k,
  data: DriverData,
  clock: Clock,
  boot: readonly { reg: number; value: number; chip?: number }[],
): { helpers: string[]; dataStart: number } {
  const helpers: string[] = ["tick", "timer-clock", "boot-table"];

  // --- start-up --------------------------------------------------------------
  asm.label("Reset");
  asm.moveToSr(eaImm(0x2700));

  // TMSS: a model-1+ console holds the VDP off its bus until the security
  // register has been written, and an accurate core does the same. The version
  // register's low nibble says whether this machine has one.
  asm.move("b", eaAbs(TMSS.VERSION), eaD(0));
  asm.andi("b", 0x0f, eaD(0));
  asm.bcc("eq", "NoTmss");
  asm.move("l", eaImm(TMSS.KEY), eaAbs(TMSS.REGISTER));
  asm.label("NoTmss");

  // The sound processor is held in reset and its bus is taken, and kept: the FM
  // chip is decoded inside the Z80's address space, and this cartridge ships no
  // Z80 program — so a processor left running whatever powered up would be a
  // second writer on the bus the driver is about to use.
  asm.move("w", eaImm(0x0100), eaAbs(Z80.BUS));
  asm.move("w", eaImm(0x0000), eaAbs(Z80.RESET));

  // The picture hardware still belongs to this cartridge even though it draws
  // nothing, and the two registers that matter are the ones that could raise an
  // interrupt: this program fills no vector but the reset one.
  emitVdpRegister(asm, 0, 0x04); // no horizontal interrupt
  emitVdpRegister(asm, 1, 0x04); // display off, no vertical interrupt
  emitVdpRegister(asm, 10, 0xff); // the line counter, parked

  asm.movea("l", eaImm(STACK_TOP), 7);
  asm.clr("b", eaAbs(STATE.rest));
  asm.jsr("AudioInit");

  // The stream's pointers, then its first block. `NextBlock` is what turns an
  // order entry into a data pointer, so nothing here has to know how a block is
  // laid out.
  asm.move("l", eaImm(label("Order0")), eaAbs(STATE.order));
  asm.move("l", eaImm(label("Order0", data.loopOrderIndex * 4)), eaAbs(STATE.loop as number));
  asm.jsr("NextBlock");

  // The clock last, and after `AudioInit`, because the boot table's own `$27`
  // write would otherwise stop what this starts.
  emitYmWrite(asm, TIMER.HIGH, (clock.reload >> 2) & 0xff);
  emitYmWrite(asm, TIMER.LOW, clock.reload & 0x03);
  emitYmWrite(asm, TIMER.CONTROL, TIMER.START);

  // --- the clock -------------------------------------------------------------
  //
  // Poll, acknowledge, tick. The status byte is the same on all four of the
  // chip's bus addresses, and bit 0 is timer A's overflow.
  // The acknowledge goes *before* the tick, not after: an overflow that lands
  // while a tick is being performed has to survive it, or a tick that ran long
  // would swallow the one behind it. Tick 0 installs six four-operator patches
  // and is by far the longest, at about a tenth of a period.
  asm.label("Idle");
  asm.move("b", eaAbs(YM_ADDRESS), eaD(0));
  asm.btst(0, eaD(0));
  asm.bcc("eq", "Idle");
  emitYmWrite(asm, TIMER.CONTROL, TIMER.ACK);
  asm.jsr("Tick");
  // A label and not an instruction, so the cartridge is unchanged by it. It is
  // what tells the conformance harness where a tick *ends*: this is the first
  // console whose driver writes the chip it is playing between two ticks — the
  // acknowledge above — and a capture that ran from one tick's entry to the
  // next would file those two writes under the tick before them
  // (`test/_rom-harness.ts` §`endAddress`).
  asm.label("TickEnd");
  asm.bra("Idle");

  // --- the tick --------------------------------------------------------------
  helpers.push(...emitStream(asm, { prefix: "", state: STATE, data }));

  // --- the chip's own initialisation -----------------------------------------
  //
  // A table rather than a run of stores, for the PC Engine's reason: eighty-odd
  // writes is six hundred bytes of instructions against a hundred and sixty of
  // data. The walk is the stream's own write dispatch with a terminator instead
  // of a count.
  asm.label("AudioInit");
  asm.movea("l", eaImm(label("AudioBoot")), 0);
  asm.movea("l", eaImm(YM_ADDRESS), 1);
  asm.movea("l", eaImm(PSG_ADDRESS), 2);
  asm.label("AudioInitNext");
  asm.move("b", eaPost(0), eaD(4));
  asm.cmpi("b", BOOT_END, eaD(4));
  asm.bcc("eq", "AudioInitDone");
  asm.move("b", eaPost(0), eaD(0));
  asm.cmpi("b", MD_PSG_PORT, eaD(4));
  asm.bcc("ne", "AudioInitFm");
  asm.move("b", eaD(0), eaInd(2));
  asm.bra("AudioInitNext");
  asm.label("AudioInitFm");
  // The index has to be widened: `move.b` leaves a register's high three bytes
  // alone, and an indexed address mode reads the whole long.
  asm.andi("l", 3, eaD(4));
  asm.move("b", eaD(0), eaIdx(1, 0, 4));
  asm.bra("AudioInitNext");
  asm.label("AudioInitDone");
  asm.rts();

  // --- data ------------------------------------------------------------------
  const dataStart = asm.pc;
  asm.label("AudioBoot");
  for (const write of boot) {
    asm.db(mdPort(write.reg, write.chip ?? YM_CHIP));
    asm.db(write.value & 0xff);
  }
  asm.db(BOOT_END);
  emitStreamData(asm, "", 0, data);

  return { helpers, dataStart };
}

/** Write one FM register: the address on the first port, the datum on the second. */
function emitYmWrite(asm: Asm68k, register: number, value: number): void {
  asm.move("b", eaImm(register), eaAbs(YM_ADDRESS));
  asm.move("b", eaImm(value), eaAbs(YM_ADDRESS + 1));
}

/** Write one VDP register, which is a single word to the control port. */
function emitVdpRegister(asm: Asm68k, register: number, value: number): void {
  asm.move("w", eaImm(0x8000 | (register << 8) | value), eaAbs(VDP_CONTROL));
}
