/**
 * The audio compliance oracle (doc 16 §Two representations).
 *
 * Deliberately written naively — count the writes, check every register value
 * against the chip's width, compare the totals against the budgets — so it can
 * act as an independent check on the arranger rather than restating it. This is
 * the counterpart of `inspect` for images, and it is used the same way: as a
 * validity gate that disqualifies a tournament candidate before any metric is
 * allowed to praise it.
 */

import { getConsole, type AudioSpec } from "@demake/core";

import type { ChipScript } from "./chipscript.js";

/** One reason a script is not playable as it stands. */
export interface AudioViolation {
  code: string;
  message: string;
  /** Where it happens, when that is meaningful. */
  tick?: number;
}

export interface AudioInspectResult {
  compliant: boolean;
  console: string;
  violations: AudioViolation[];
  stats: {
    ticks: number;
    seconds: number;
    writes: number;
    peakWritesPerTick: number;
    writeBudget: number;
    /** Rough driver-data size: two bytes per write plus a per-tick marker. */
    estimatedBytes: number;
    romBudget: number;
  };
}

/** Highest register address each chip answers to. */
const REGISTER_LIMIT: Record<string, number> = {
  "gb-apu": 0x3f,
  sn76489: 0x06,
  "nes-apu": 0x17,
};

/** Check a script against the console it claims to target. */
export function inspectScript(script: ChipScript): AudioInspectResult {
  const spec = getConsole(script.console).audio;
  const violations: AudioViolation[] = [];
  if (!spec) {
    violations.push({
      code: "E_NO_AUDIO_SPEC",
      message: `${script.console} has no audio spec`,
    });
    return {
      compliant: false,
      console: script.console,
      violations,
      stats: emptyStats(script),
    };
  }

  checkRegisters(script, violations);
  checkBudgets(script, spec, violations);
  checkTiming(script, violations);
  checkLoop(script, violations);

  return {
    compliant: violations.length === 0,
    console: script.console,
    violations,
    stats: stats(script, spec),
  };
}

function checkRegisters(script: ChipScript, violations: AudioViolation[]): void {
  const limit = REGISTER_LIMIT[script.chips[0] ?? ""] ?? 0xff;
  for (let tick = 0; tick < script.ticks.length; tick += 1) {
    for (const write of script.ticks[tick]!.writes) {
      if (!Number.isInteger(write.reg) || write.reg < 0 || write.reg > limit) {
        violations.push({
          code: "E_REGISTER_RANGE",
          message: `register 0x${write.reg.toString(16)} is outside the chip's map`,
          tick,
        });
        return;
      }
      if (!Number.isInteger(write.value) || write.value < 0 || write.value > 0xff) {
        violations.push({
          code: "E_VALUE_RANGE",
          message: `value ${write.value} is not a byte`,
          tick,
        });
        return;
      }
    }
  }
}

function checkBudgets(script: ChipScript, spec: AudioSpec, violations: AudioViolation[]): void {
  // The first tick carries the chip's initialisation, which a driver performs
  // once before playback rather than inside the tick budget.
  let peak = 0;
  let peakTick = 0;
  for (let tick = 1; tick < script.ticks.length; tick += 1) {
    const count = script.ticks[tick]!.writes.length;
    if (count > peak) {
      peak = count;
      peakTick = tick;
    }
  }
  if (peak > spec.driver.writesPerTick) {
    violations.push({
      code: "E_WRITE_BUDGET",
      message: `tick asks for ${peak} register writes; ${script.console} allows ${spec.driver.writesPerTick}`,
      tick: peakTick,
    });
  }
  const bytes = estimatedBytes(script);
  if (bytes > spec.budgets.romBytes) {
    violations.push({
      code: "E_DATA_BUDGET",
      message: `driver data is about ${bytes} bytes; the budget is ${spec.budgets.romBytes}`,
    });
  }
}

function checkTiming(script: ChipScript, violations: AudioViolation[]): void {
  if (script.timing.accumulates) {
    violations.push({
      code: "E_TEMPO_DRIFT",
      message: "timing error accumulates: a bar boundary will not stay where it should",
    });
  }
  if (script.driver.rate.num <= 0 || script.driver.rate.den <= 0) {
    violations.push({ code: "E_DRIVER_RATE", message: "driver rate is not a positive ratio" });
  }
}

function checkLoop(script: ChipScript, violations: AudioViolation[]): void {
  if (script.loopTick < -1 || script.loopTick >= script.ticks.length) {
    violations.push({
      code: "E_LOOP_POINT",
      message: `loop point ${script.loopTick} is outside the schedule`,
    });
  }
}

/** Two bytes per write plus one per tick, the shape a row-based driver has. */
function estimatedBytes(script: ChipScript): number {
  let total = script.ticks.length;
  for (const tick of script.ticks) total += tick.writes.length * 2;
  return total;
}

function stats(script: ChipScript, spec: AudioSpec): AudioInspectResult["stats"] {
  return {
    ticks: script.ticks.length,
    seconds: (script.ticks.length * script.driver.rate.den) / script.driver.rate.num,
    writes: script.budgets.writes,
    peakWritesPerTick: script.budgets.peakWritesPerTick,
    writeBudget: spec.driver.writesPerTick,
    estimatedBytes: estimatedBytes(script),
    romBudget: spec.budgets.romBytes,
  };
}

function emptyStats(script: ChipScript): AudioInspectResult["stats"] {
  return {
    ticks: script.ticks.length,
    seconds: 0,
    writes: 0,
    peakWritesPerTick: 0,
    writeBudget: 0,
    estimatedBytes: 0,
    romBudget: 0,
  };
}
