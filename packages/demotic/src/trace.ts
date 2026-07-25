/**
 * State traces — the cross-implementation oracle.
 *
 * A trace is the exact fixed-point state of every entity, per tick, as text.
 * Two implementations of the language agree if and only if their traces for the
 * same input tape are byte-identical, which makes conformance a `diff` rather
 * than a judgement call.
 *
 * Values are emitted as *raw* 16.16 integers, not decimals. That is
 * deliberate: a decimal rendering would hide a one-bit disagreement, and a
 * one-bit disagreement in a velocity is exactly what compounds into a visibly
 * different game a thousand ticks later.
 *
 * The intended use is the same shape as the existing pixel-perfect emulator
 * E2E, one layer down: boot the ROM, feed the tape, dump the runtime's entity
 * table each tick, and compare to the trace this produces. Framebuffer
 * comparison then tests only rendering, because the logic has already been
 * proven equal.
 */

import type { Fixed } from "./fixed.js";
import type { Program } from "./program.js";
import type { InputState, InputTape, Sim } from "./sim.js";
import { ACTIONS } from "./program.js";

/** Properties recorded per entity, in this order. Stable across versions. */
const TRACED_PROPS = ["x", "y", "xdirection", "ydirection", "speed", "value"] as const;

/** One tick of a trace. */
export function traceLine(sim: Sim): string {
  const entities = sim
    .entities()
    .map((entity) => {
      const values = TRACED_PROPS.map((prop) => (entity.numbers[prop] ?? 0) as Fixed);
      return `${entity.name}=${values.join(",")}`;
    })
    .join(" ");
  return `${sim.tick} ${sim.scene} ${entities}`;
}

/** Run a tape and return the full trace, one line per tick, plus a header. */
export function trace(sim: Sim, tape: InputTape): string {
  const lines: string[] = [`# demake-game trace v1 console=${sim.program.profile.id}`];
  lines.push(`# props=${TRACED_PROPS.join(",")} units=16.16`);
  for (const frame of tape) {
    sim.step(frame);
    lines.push(traceLine(sim));
  }
  return lines.join("\n");
}

/**
 * Build an input tape from a compact script: `"30:,20:left,40:right"` means
 * 30 ticks of nothing, 20 holding left, 40 holding right. Multiple buttons in
 * one segment are joined with `+`, e.g. `10:left+a`.
 */
export function tape(script: string): InputTape {
  const frames: InputState[] = [];
  for (const segment of script.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const [countText, buttonsText = ""] = trimmed.split(":");
    const count = Number(countText);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`bad tape segment '${segment}' — expected '<ticks>:<buttons>'`);
    }
    const state: InputState = {};
    for (const button of buttonsText.split("+")) {
      const name = button.trim().toLowerCase();
      if (!name) continue;
      if (!(ACTIONS as readonly string[]).includes(name)) {
        throw new Error(`bad tape segment '${segment}' — '${name}' is not a button`);
      }
      state[name as (typeof ACTIONS)[number]] = true;
    }
    for (let i = 0; i < count; i += 1) frames.push(state);
  }
  return frames;
}

/** A one-line summary of a compiled program, for CLI and preview headers. */
export function describeProgram(program: Program): string {
  const { profile, budget } = program;
  return [
    `${profile.name} (${profile.id})`,
    `${profile.screenWidth}x${profile.screenHeight} cells @ ${profile.fps}Hz`,
    `${program.scenes.length} scene(s), ${program.instances.length} object(s), ${program.rules.length} rule(s)`,
    `sprites ${budget.peakSprites}/${budget.spriteLimit}, ${budget.perLineLimit}/line`,
  ].join(" · ");
}
