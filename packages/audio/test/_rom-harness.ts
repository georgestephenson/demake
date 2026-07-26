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

import type { ChipScript, TickWrites } from "../src/chipscript.js";
import { buildAudioRom, type AudioRomOptions } from "../src/rom/index.js";

/** A ROM that can be stepped one driver tick at a time. */
export class AudioRomRunner {
  readonly machine: Gameboy;
  readonly rom: Uint8Array;
  private readonly tickAddress: number;
  private current: { reg: number; value: number }[] | undefined;

  constructor(script: ChipScript, options: AudioRomOptions = {}) {
    const built = buildAudioRom(script, options);
    this.rom = built.bytes;
    const tick = built.symbols.get("Tick");
    if (tick === undefined) throw new Error("the driver defined no Tick symbol");
    this.tickAddress = tick;
    this.machine = new Gameboy(built.bytes);
    this.machine.apuTap = (reg, value) => {
      this.current?.push({ reg, value });
    };
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
    const groups: { reg: number; value: number }[][] = [];
    let guard = 0;
    while (groups.length <= count) {
      this.machine.stepInstruction();
      if (this.machine.cpu.pc === this.tickAddress) {
        this.current = [];
        groups.push(this.current);
      }
      guard += 1;
      if (guard > 200_000_000) throw new Error("audio rom: the driver stopped ticking");
    }
    return groups.slice(0, count).map((writes) => ({ writes }));
  }
}

/** The writes a built ROM performs over its first `count` driver ticks. */
export function captureRomWrites(
  script: ChipScript,
  count: number,
  options: AudioRomOptions = {},
): TickWrites[] {
  return new AudioRomRunner(script, options).capture(count);
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
      if (a.reg !== b.reg || a.value !== b.value) {
        return `tick ${tick}, write ${index}: expected ${hex(a.reg)}=${hex(a.value)}, the ROM wrote ${hex(b.reg)}=${hex(b.value)}`;
      }
    }
  }
  return null;
}

function hex(value: number): string {
  return `$${value.toString(16).padStart(2, "0").toUpperCase()}`;
}

function show(writes: readonly { reg: number; value: number }[]): string {
  return writes.map((w) => `${hex(w.reg)}=${hex(w.value)}`).join(" ");
}
