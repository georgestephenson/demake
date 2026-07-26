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

/**
 * Whether a program's traces carry an audio field.
 *
 * A game with no music and no effects traces exactly as it did before audio
 * existed, which keeps every golden trace of one meaningful rather than
 * re-baselined for a column of nothing.
 */
export function tracesAudio(program: Program): boolean {
  return program.tracks.length > 0 || program.sounds.length > 0;
}

/**
 * One tick of a trace.
 *
 * The audio field is `audio=<track>,<effect>`: the track the running scene asks
 * for, and the effect a rule asked for on this tick (`-1` for neither). It is
 * what the *game* requested, not what the chip did — doc 17 §Demotic requires
 * audio events in the trace so the ROM and the interpreter cannot disagree about
 * when a sound fires, and channel arbitration is no more the language's business
 * than sprite priority is.
 */
export function traceLine(sim: Sim): string {
  const entities = sim
    .entities()
    .map((entity) => {
      const values = TRACED_PROPS.map((prop) => (entity.numbers[prop] ?? 0) as Fixed);
      return `${entity.name}=${values.join(",")}`;
    })
    .join(" ");
  const audio = tracesAudio(sim.program) ? ` audio=${sim.music},${sim.sound}` : "";
  return `${sim.tick} ${sim.scene} ${entities}${audio}`;
}

/**
 * The header lines a trace opens with.
 *
 * Shared with the ROM-side reader, because a header written twice is a header
 * that disagrees in one line and turns a passing conformance run into a
 * mysterious one-line diff.
 */
export function traceHeader(program: Program): string[] {
  const lines = [
    `# demake-game trace v1 console=${program.profile.id}`,
    `# props=${TRACED_PROPS.join(",")} units=16.16`,
  ];
  if (tracesAudio(program)) lines.push("# audio=track,effect");
  return lines;
}

/** Run a tape and return the full trace, one line per tick, plus a header. */
export function trace(sim: Sim, tape: InputTape): string {
  const lines: string[] = traceHeader(sim.program);
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
