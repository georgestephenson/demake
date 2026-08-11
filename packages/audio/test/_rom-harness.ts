/**
 * Booting a built audio ROM and reading back what the chip received.
 *
 * This is doc 16 §The proof, Level A, and it is the strongest oracle the audio
 * domain has: a sound chip is a deterministic state machine, so *identical
 * writes at identical times produce identical output*, on hardware and in any
 * correct model of it. Comparing register streams is therefore not a proxy for
 * comparing audio — it is the thing itself, and unlike a waveform diff it is
 * exact, integer, and names the tick when it fails.
 *
 * Tick attribution is by program counter, not by a marker the ROM writes. The
 * driver's `Tick` label comes back in the build's symbol table, so entering it
 * opens a new group; nothing is added to the cartridge to make it observable,
 * which matters because the ROM under test must be the ROM that ships.
 *
 * Running it in `@demake/dmg` rather than SameBoy is what keeps it a plain unit
 * test with no toolchain and no emulator install — the same trade
 * `packages/demotic/test/rom.test.ts` makes, for the same reason.
 */

import { Gameboy } from "@demake/dmg";
import { Md } from "@demake/md";
import { Nes } from "@demake/nes";
import { Pce } from "@demake/pce";
import { Sms } from "@demake/sms";
import { Wsc } from "@demake/wsc";

import type { ChipScript, TickWrites } from "../src/chipscript.js";
import { PSG_CHIP, YM_CHIP } from "../src/rom/md-chips.js";
import { buildAudioRom, type AudioRomOptions } from "../src/rom/index.js";

/**
 * One write, as a tap reports it.
 *
 * `chip` is what the Mega Drive needs and every other console answers zero to:
 * that board has two devices, so a register number identifies nothing on its own
 * — `$25` is the FM chip's timer reload and the PSG's one write port at once.
 */
interface Capture {
  reg: number;
  value: number;
  chip: number;
}

/** What a core has to offer for a schedule to be read back out of it. */
interface TappedMachine {
  stepInstruction(): unknown;
}

/** A ROM that can be stepped one driver tick at a time. */
export class AudioRomRunner {
  readonly machine: TappedMachine;
  readonly rom: Uint8Array;
  /**
   * The schedule this ROM promises, which is what a capture must be diffed
   * against.
   *
   * Not always the one that went in: a console whose chip is initialised from a
   * table at boot performs those writes before the first tick, so its tick 0 is
   * shorter than the demaker's. Comparing against the input there would be
   * asking the driver for writes it correctly made somewhere else.
   */
  readonly performed: ChipScript;
  private readonly tickAddress: number;
  /**
   * Where the driver is, which is not always a field called `pc`.
   *
   * Five of the six families name it that; the WonderSwan's V30MZ is an 8086 and
   * names it `ip`, because on that architecture an address is a segment and an
   * offset and this is the offset. The driver is in the same segment as
   * everything else a cartridge runs, so the offset is the whole address —
   * `_audio-battery.ts` §`pc` says the same thing one layer up.
   */
  private readonly pc: () => number;
  /**
   * Where a tick *ends*, when the driver says so.
   *
   * Absent on every console whose driver writes nothing to the chip between two
   * ticks, which was all of them until the Mega Drive: there the clock is the
   * FM chip's own timer, so acknowledging an overflow is a write to the same
   * device the schedule addresses, and it happens after one tick and before the
   * next. Grouping from entry to entry would file it under the tick before it —
   * two writes the schedule does not have, reported as a driver bug.
   *
   * The label costs the cartridge nothing, which is what keeps the rule that the
   * ROM under test is the ROM that ships: no instruction is added to make this
   * observable, only a name for one that was already there.
   */
  private readonly endAddress: number | undefined;
  private current: Capture[] | undefined;

  /**
   * Build a ROM and wrap it, which is asynchronous because the build is.
   *
   * `buildAudioRom` reaches its family through an `import()` so that a console's
   * driver and the assembler under it are a chunk of their own in the page's
   * bundle (`rom/index.ts`). A constructor cannot await, so this is where a
   * runner comes from.
   */
  static async create(script: ChipScript, options: AudioRomOptions = {}): Promise<AudioRomRunner> {
    return new AudioRomRunner(await buildAudioRom(script, options), script.console);
  }

  private constructor(built: Awaited<ReturnType<typeof buildAudioRom>>, consoleId: string) {
    this.rom = built.bytes;
    this.performed = built.performed;
    const tick = built.symbols.get("Tick");
    if (tick === undefined) throw new Error("the driver defined no Tick symbol");
    this.tickAddress = tick;
    this.endAddress = built.symbols.get("TickEnd");
    // `chip` defaults to zero, which every single-chip console's schedule also
    // says — so only the Mega Drive's tap passes one and nothing else changes.
    const push = (reg: number, value: number, chip = 0): void => {
      this.current?.push({ reg, value, chip });
    };
    // The core is the console's, and the tap is the window each of them offers
    // on the chip it owns. Both models *are* `@demake/chip`'s, so this is a
    // window on the same object the schedule was fitted against rather than on
    // a second implementation of it.
    if (built.family === "nes") {
      const machine = new Nes(built.bytes);
      machine.apuTap = push;
      this.machine = machine;
    } else if (built.family === "pce") {
      const machine = new Pce(built.bytes);
      machine.psgTap = push;
      this.machine = machine;
    } else if (built.family === "md") {
      // The only console here with *two* chips, so the tap is two taps — and the
      // FM one reports the bus *port* rather than a decoded register, because
      // that is what the schedule's own register number is on this machine.
      // Which chip a write addressed is part of what has to match: `$25` is the
      // FM chip's timer reload and the PSG's one write port at once.
      const machine = new Md(built.bytes);
      machine.ymTap = (port, value) => push(port, value, YM_CHIP);
      machine.psgTap = (reg, value) => push(reg, value, PSG_CHIP);
      this.machine = machine;
    } else if (built.family === "wsc") {
      // Which *WonderSwan* it comes up as is a constructor argument rather than
      // anything in the cartridge, because these two machines do not differ in
      // a byte a footer could record — so the console the schedule was fitted
      // to is what decides, exactly as `@demake/wsc`'s own tests do.
      const machine = new Wsc(built.bytes, consoleId === "ws" ? "ws" : "wsc");
      machine.soundTap = push;
      this.machine = machine;
    } else if (built.family === "sms") {
      // Which *Sega* it comes up as is the cartridge's own region nibble, never
      // an argument — the same rule `@demake/dmg` follows for its header, so a
      // Game Gear build is played on a Game Gear because it says it is one.
      const machine = new Sms(built.bytes);
      machine.psgTap = push;
      this.machine = machine;
    } else {
      const machine = new Gameboy(built.bytes);
      machine.apuTap = push;
      this.machine = machine;
    }

    const machine = this.machine;
    this.pc =
      machine instanceof Wsc
        ? () => machine.cpu.ip
        : () => (machine as { cpu: { pc: number } }).cpu.pc;
  }

  /**
   * Every write the ROM makes before its first tick.
   *
   * The boot half, which no capture of ticks can see: a console that uploads
   * waveforms at boot and then skipped the upload would play the right notes
   * through empty wavetables, which is a cartridge that is perfect in a register
   * diff and silent on the machine.
   */
  captureBoot(): Capture[] {
    const writes: Capture[] = [];
    this.current = writes;
    let guard = 0;
    while (this.pc() !== this.tickAddress) {
      this.machine.stepInstruction();
      guard += 1;
      if (guard > 10_000_000) throw new Error("audio rom: the driver never reached its first tick");
    }
    this.current = undefined;
    return writes;
  }

  /**
   * Run until the driver has performed `count` ticks, and return them.
   *
   * A group opens when the driver *enters* its tick routine, so the run
   * continues until the group after the last one we want opens — otherwise the
   * final tick would be reported half-finished and a trailing write would go
   * missing in a way that looks like a driver bug.
   */
  capture(count: number): TickWrites[] {
    const groups: Capture[][] = [];
    let guard = 0;
    while (groups.length <= count) {
      this.machine.stepInstruction();
      if (this.pc() === this.tickAddress) {
        this.current = [];
        groups.push(this.current);
      } else if (this.pc() === this.endAddress) {
        this.current = undefined;
      }
      guard += 1;
      if (guard > 200_000_000) throw new Error("audio rom: the driver stopped ticking");
    }
    return groups.slice(0, count).map((writes) => ({ writes }));
  }
}

/** The writes a built ROM performs over its first `count` driver ticks. */
export async function captureRomWrites(
  script: ChipScript,
  count: number,
  options: AudioRomOptions = {},
): Promise<TickWrites[]> {
  return (await AudioRomRunner.create(script, options)).capture(count);
}

/**
 * A schedule and the writes its own ROM made, ready to be diffed.
 *
 * One call rather than two, because the two have to come from the same build:
 * asking for the ticks and the capture separately is how a console that strips
 * a boot prefix comes to be compared against the schedule it was handed.
 */
export async function captureAgainstRom(
  script: ChipScript,
  count: number,
  options: AudioRomOptions = {},
): Promise<{ expected: readonly TickWrites[]; actual: readonly TickWrites[] }> {
  const runner = await AudioRomRunner.create(script, options);
  return { expected: runner.performed.ticks.slice(0, count), actual: runner.capture(count) };
}

/**
 * Where two write streams first differ, or `null` when they agree.
 *
 * Reported as a string rather than left to a deep-equal assertion because the
 * useful information is *which tick and which write*, and a diff of two
 * thousand-element arrays does not carry it.
 */
export function firstDivergence(
  expected: readonly TickWrites[],
  actual: readonly TickWrites[],
): string | null {
  for (let tick = 0; tick < expected.length; tick += 1) {
    const want = expected[tick]!.writes;
    const got = actual[tick]?.writes;
    if (!got) return `tick ${tick}: the ROM never performed it`;
    if (want.length !== got.length) {
      return `tick ${tick}: expected ${want.length} writes, the ROM made ${got.length} (${show(got)})`;
    }
    for (let index = 0; index < want.length; index += 1) {
      const a = want[index]!;
      const b = got[index]!;
      if (a.reg !== b.reg || a.value !== b.value || (a.chip ?? 0) !== (b.chip ?? 0)) {
        return `tick ${tick}, write ${index}: expected ${show([a])}, the ROM wrote ${show([b])}`;
      }
    }
  }
  return null;
}

function hex(value: number): string {
  return `$${value.toString(16).padStart(2, "0").toUpperCase()}`;
}

function show(writes: readonly { reg: number; value: number; chip?: number }[]): string {
  return writes
    .map((w) => `${w.chip ? `chip${w.chip}:` : ""}${hex(w.reg)}=${hex(w.value)}`)
    .join(" ");
}
