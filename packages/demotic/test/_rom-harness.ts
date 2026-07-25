/**
 * Driving a built ROM headlessly, so trace conformance is a unit test.
 *
 * Doc 14 §Conformance puts state-trace equality first because it finds bugs
 * fastest: a divergence names the tick and the property, where a framebuffer
 * diff names a pixel. Running it in `@demake/dmg` rather than SameBoy is what
 * makes it available with no toolchain and no emulator install — the SameBoy
 * E2E still exists, one layer up, to test what this cannot: that the *picture*
 * is right.
 *
 * The handshake is the runtime's tick counter, not the frame counter. They are
 * usually the same, but a tick that overruns its frame must not be mistaken for
 * two ticks — the trace would silently gain a duplicate line.
 */

import { Gameboy, type Button } from "@demake/dmg";

import type { InputState, InputTape } from "../src/sim.js";
import type { Program } from "../src/program.js";
import { buildGbRom } from "../src/rom/gb.js";
import { RAM } from "../src/rom/format.js";
import { romReady, romTraceLine } from "../src/rom/trace.js";

/** Abstract buttons map straight onto the Game Boy's, which is the floor the
 * portable set was chosen against (doc 14 §Buttons). */
const BUTTONS: Readonly<Record<string, Button>> = {
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  a: "a",
  b: "b",
  start: "start",
};

/** A booted ROM, ready to be stepped a tick at a time. */
export class RomRunner {
  readonly machine: Gameboy;
  private readonly read = (address: number, length: number) =>
    this.machine.readMemory(address, length);

  constructor(readonly program: Program) {
    this.machine = new Gameboy(buildGbRom(program).bytes);
    // Let the runtime finish initialising before the first input is offered.
    this.settle();
  }

  /**
   * Run to the point where the loop is about to read input for tick 1.
   *
   * Stopping *before* the first `ReadInput` is what aligns the two sides:
   * `new Sim(program)` is also at tick zero with the entry scene reset, so one
   * tape frame produces tick 1 in both.
   */
  private settle(): void {
    for (let guard = 0; guard < 500_000; guard += 1) {
      if (this.machine.readMemory(RAM.booted, 1)[0] !== 0) return;
      this.machine.stepInstruction();
    }
    throw new Error("rom: the runtime never finished initialising");
  }

  /** Feed one tick of input and run until the runtime has consumed it. */
  step(input: InputState): void {
    const down: Button[] = [];
    for (const [action, held] of Object.entries(input)) {
      const button = BUTTONS[action];
      if (held && button) down.push(button);
    }
    this.machine.setButtons(down);
    const before = romReady(this.read);
    for (let guard = 0; guard < 4_000_000; guard += 1) {
      this.machine.stepInstruction();
      if (romReady(this.read) !== before) return;
    }
    throw new Error("rom: a tick never completed");
  }

  /** The trace line for the tick just finished. */
  line(): string {
    return romTraceLine(this.program, this.read);
  }
}

/**
 * Run a tape and return the trace, in the same format `trace()` produces.
 *
 * The first tick is special: the runtime completes one before any input can be
 * offered, exactly as `new Sim(program)` starts on tick zero with the entry
 * scene reset. Both sides therefore report tick 1 after one tape frame.
 */
export function romTrace(program: Program, tape: InputTape): string {
  const runner = new RomRunner(program);
  const lines: string[] = [
    `# demake-game trace v1 console=${program.profile.id}`,
    `# props=x,y,xdirection,ydirection,speed,value units=16.16`,
  ];
  for (const frame of tape) {
    runner.step(frame);
    lines.push(runner.line());
  }
  return lines.join("\n");
}
