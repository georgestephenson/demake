/**
 * Driving a built ROM headlessly, so trace conformance is a unit test.
 *
 * Doc 14 §Conformance puts state-trace equality first because it finds bugs
 * fastest: a divergence names the tick and the property, where a framebuffer
 * diff names a pixel. Running it in our own cores rather than in SameBoy or a
 * libretro build is what makes it available with no toolchain and no emulator
 * install — the pixel-perfect E2Es still exist, one layer up, to test what this
 * cannot: that the *picture* is right.
 *
 * The runner is console-generic, and that is the point rather than a
 * convenience. `Backend` says compiling a Demotic program is one shape with a
 * per-console implementation (doc 14 §Runtime model); a harness that took the
 * Game Boy's word for what a trace looks like would let the NES's drift. Here
 * both consoles are booted by the same loop, watched through the same handshake
 * byte, and read by the same `rom/trace.ts` — so "the NES plays the same game" is
 * checked by running the same code, not by two files that resemble each other.
 *
 * The handshake is the runtime's tick counter, not the frame counter. They are
 * usually the same, but a tick that overruns its frame must not be mistaken for
 * two ticks — the trace would silently gain a duplicate line.
 */

import { Gameboy, type Button as GbButton, type Machine as GbMachine } from "@demake/dmg";
import { Md, type Button as MdButton } from "@demake/md";
import { Nes, type Button as NesButton } from "@demake/nes";
import { Sms, type Button as SmsButton } from "@demake/sms";
import { Snes, type Button as SnesButton } from "@demake/snes";

import { buildGbRom } from "../src/codegen/gb.js";
import type { Layout } from "../src/codegen/layout.js";
import { buildMdRom } from "../src/codegen/md.js";
import { buildNesRom } from "../src/codegen/nes.js";
import { buildSmsRom } from "../src/codegen/sms.js";
import { buildSnesRom } from "../src/codegen/snes.js";
import type { BuildOptions, BuiltRom } from "../src/codegen/backend.js";
import type { Program } from "../src/program.js";
import { romReady, romTraceLine } from "../src/rom/trace.js";
import type { InputState, InputTape } from "../src/sim.js";
import { traceHeader } from "../src/trace.js";

/** What the runner needs of a booted machine, whichever console it is. */
export interface RomMachine {
  readMemory(address: number, length: number): Uint8Array;
  stepInstruction(): number;
  /** Run to the start of the next vertical blank; the speed measurement's clock. */
  runFrame(): number;
  setButtons(down: readonly string[]): void;
}

/** One console, as the harness sees it: build a cartridge, boot it, press keys. */
export interface RomTarget {
  /** The console id a program is compiled for. */
  readonly console: string;
  build(program: Program, options: BuildOptions): Promise<BuiltRom>;
  boot(bytes: Uint8Array): RomMachine;
}

/**
 * Abstract buttons map straight onto the Game Boy's, which is the floor the
 * portable set was chosen against (doc 14 §Buttons) — and onto the NES's, which
 * has the same seven and a Select besides.
 */
const BUTTONS = ["left", "right", "up", "down", "a", "b", "start"] as const;

function gameboyTarget(consoleId: string, machineKind: GbMachine): RomTarget {
  return {
    console: consoleId,
    build: (program, options) => buildGbRom(program, options),
    boot: (bytes) => {
      const machine = new Gameboy(bytes, machineKind);
      return {
        readMemory: (address, length) => machine.readMemory(address, length),
        stepInstruction: () => machine.stepInstruction(),
        runFrame: () => machine.runFrame(),
        setButtons: (down) => machine.setButtons(down as GbButton[]),
      };
    },
  };
}

export const gbTarget: RomTarget = gameboyTarget("gb", "gameboy");
export const gbcTarget: RomTarget = gameboyTarget("gbc", "gameboy");

/**
 * The Mega Duck: the same backend and the same core, told which machine it is.
 *
 * Both Game Boys take their machine from the cartridge header; this console has
 * no header, so the harness names it — exactly as it names `Nes` below.
 */
export const megaduckTarget: RomTarget = gameboyTarget("megaduck", "megaduck");

export const nesTarget: RomTarget = {
  console: "nes",
  build: (program, options) => buildNesRom(program, options),
  boot: (bytes) => {
    const machine = new Nes(bytes);
    return {
      readMemory: (address, length) => machine.readMemory(address, length),
      stepInstruction: () => machine.stepInstruction(),
      runFrame: () => machine.runFrame(),
      setButtons: (down) => machine.setButtons(down as NesButton[]),
    };
  },
};

export const smsTarget: RomTarget = {
  console: "sms",
  build: (program, options) => buildSmsRom(program, options),
  boot: (bytes) => {
    const machine = new Sms(bytes);
    return {
      readMemory: (address, length) => machine.readMemory(address, length),
      stepInstruction: () => machine.stepInstruction(),
      runFrame: () => machine.runFrame(),
      setButtons: (down) => machine.setButtons(down as SmsButton[]),
    };
  },
};

/** The same backend, the same machine code, a smaller window. */
export const ggTarget: RomTarget = { ...smsTarget, console: "gg" };

/**
 * The Super Nintendo, whose pad has more buttons than the abstract set and maps
 * the ones it needs the conventional way: this machine's B and Y sit where the
 * NES's A and B sat, so that is what they are.
 */
export const snesTarget: RomTarget = {
  console: "snes",
  build: (program, options) => buildSnesRom(program, options),
  boot: (bytes) => {
    const machine = new Snes(bytes);
    const map: Readonly<Record<string, SnesButton>> = { a: "b", b: "y" };
    return {
      readMemory: (address, length) => machine.readMemory(address, length),
      stepInstruction: () => machine.stepInstruction(),
      runFrame: () => machine.runFrame(),
      setButtons: (down) =>
        machine.setButtons(down.map((name) => map[name] ?? (name as SnesButton))),
    };
  },
};

export const mdTarget: RomTarget = {
  console: "md",
  build: (program, options) => buildMdRom(program, options),
  boot: (bytes) => {
    const machine = new Md(bytes);
    return {
      readMemory: (address, length) => machine.readMemory(address, length),
      stepInstruction: () => machine.stepInstruction(),
      runFrame: () => machine.runFrame(),
      setButtons: (down) => machine.setButtons(down as MdButton[]),
    };
  },
};

/** A booted ROM, ready to be stepped a tick at a time. */
export class RomRunner {
  readonly machine: RomMachine;
  readonly layout: Layout;
  readonly rom: Uint8Array;
  private readonly read = (address: number, length: number) =>
    this.machine.readMemory(address, length);

  private constructor(
    readonly program: Program,
    built: BuiltRom,
    readonly target: RomTarget,
  ) {
    this.layout = built.layout;
    this.rom = built.bytes;
    this.machine = target.boot(built.bytes);
    // Let the runtime finish initialising before the first input is offered.
    this.settle();
  }

  /**
   * Build the cartridge and boot it.
   *
   * A factory rather than a constructor because building is asynchronous now:
   * the art and audio tournaments may be spread across threads (doc 04 §Running
   * the tournament), and a constructor cannot wait for one.
   */
  static async create(
    program: Program,
    options: BuildOptions = {},
    target: RomTarget = gbTarget,
  ): Promise<RomRunner> {
    return new RomRunner(program, await target.build(program, options), target);
  }

  /**
   * Run to the point where the loop is about to read input for tick 1.
   *
   * Stopping *before* the first `ReadInput` is what aligns the two sides:
   * `new Sim(program)` is also at tick zero with the entry scene reset, so one
   * tape frame produces tick 1 in both.
   */
  private settle(): void {
    for (let guard = 0; guard < 2_000_000; guard += 1) {
      if (this.machine.readMemory(this.layout.booted, 1)[0] !== 0) return;
      this.machine.stepInstruction();
    }
    throw new Error("rom: the runtime never finished initialising");
  }

  /** Feed one tick of input and run until the runtime has consumed it. */
  step(input: InputState): void {
    const down: string[] = [];
    for (const action of BUTTONS) if (input[action]) down.push(action);
    this.machine.setButtons(down);
    const before = romReady(this.layout, this.read);
    for (let guard = 0; guard < 8_000_000; guard += 1) {
      this.machine.stepInstruction();
      if (romReady(this.layout, this.read) !== before) return;
    }
    throw new Error("rom: a tick never completed");
  }

  /** The trace line for the tick just finished. */
  line(): string {
    return romTraceLine(this.program, this.layout, this.read);
  }
}

/**
 * Run a tape and return the trace, in the same format `trace()` produces.
 *
 * The first tick is special: the runtime completes one before any input can be
 * offered, exactly as `new Sim(program)` starts on tick zero with the entry
 * scene reset. Both sides therefore report tick 1 after one tape frame.
 */
export async function romTrace(
  program: Program,
  tape: InputTape,
  options: BuildOptions = {},
  target: RomTarget = gbTarget,
): Promise<string> {
  const runner = await RomRunner.create(program, options, target);
  const lines: string[] = traceHeader(program);
  for (const frame of tape) {
    runner.step(frame);
    lines.push(runner.line());
  }
  return lines.join("\n");
}
