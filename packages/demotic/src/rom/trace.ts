/**
 * Reading a trace out of a running ROM.
 *
 * The oracle in doc 14 §Conformance is state-trace equality: same input tape,
 * identical fixed-point state per tick. This is the half that lives on the
 * hardware side of that comparison — it reconstructs `traceLine`'s exact text
 * from the runtime's work RAM, so proving a port is a `diff` and not a
 * judgement call.
 *
 * It takes a reader rather than a machine so the same function serves the
 * headless `@demake/dmg` harness in the unit suite and a real emulator's memory
 * dump in the E2E, without `@demake/demotic` learning about either.
 */

import type { Program } from "../program.js";
import { tracesAudio } from "../trace.js";

import { PROP_SLOT, PROP_SIZE, type Layout } from "../codegen/layout.js";

/** Reads `length` bytes of the machine's address space. */
export type MemoryReader = (address: number, length: number) => Uint8Array;

/** Properties a trace records, in order. Mirrors `trace.ts`. */
const TRACED = ["x", "y", "xdirection", "ydirection", "speed", "value"] as const;

/** The scene index the ROM is running. */
export function romScene(layout: Layout, read: MemoryReader): number {
  return read(layout.scene, 1)[0] as number;
}

/**
 * The runtime's tick handshake.
 *
 * A single byte, bumped *after* the sixteen-bit tick counter, so a harness that
 * watches it can never observe the counter half-updated — which is exactly what
 * happens on the 255-to-256 boundary if you watch the counter itself.
 */
export function romReady(layout: Layout, read: MemoryReader): number {
  return read(layout.ready, 1)[0] as number;
}

/** Ticks the ROM has completed. */
export function romTick(layout: Layout, read: MemoryReader): number {
  const bytes = read(layout.tick, 2);
  return (bytes[0] as number) | ((bytes[1] as number) << 8);
}

/** One stored property of one entity, as a signed 16.16 value. */
export function romProp(
  layout: Layout,
  read: MemoryReader,
  instanceId: number,
  prop: string,
): number {
  const slot = PROP_SLOT[prop];
  if (slot === undefined) throw new Error(`'${prop}' is not a stored property`);
  const base = layout.entities[instanceId];
  if (base === undefined) throw new Error(`no entity ${instanceId}`);
  const bytes = read(base + slot * PROP_SIZE, PROP_SIZE);
  const raw =
    ((bytes[0] as number) |
      ((bytes[1] as number) << 8) |
      ((bytes[2] as number) << 16) |
      ((bytes[3] as number) << 24)) >>>
    0;
  return raw >= 0x80000000 ? raw - 0x100000000 : raw;
}

/**
 * The audio field: the track the running scene asks for, and this tick's effect.
 *
 * The track is *derived* from the scene rather than stored, exactly as the
 * simulator derives it — a scene and its music cannot disagree if only one of
 * them is written down. Only the effect needs a byte, because "a rule fired on
 * this tick" is not recoverable from anything else.
 */
function romAudio(
  program: Program,
  layout: Layout,
  read: MemoryReader,
  sceneIndex: number,
): string {
  const file = program.scenes[sceneIndex]?.music;
  const track = file === undefined ? -1 : program.tracks.indexOf(file);
  const raw = layout.sound === null ? 0xff : (read(layout.sound, 1)[0] as number);
  return ` audio=${track},${raw === 0xff ? -1 : raw}`;
}

/** The trace line for the tick the ROM has just finished. */
export function romTraceLine(program: Program, layout: Layout, read: MemoryReader): string {
  const sceneIndex = romScene(layout, read);
  const scene = program.scenes[sceneIndex];
  const entities = (scene?.instanceIds ?? [])
    .map((id) => {
      const name = program.instances[id]?.name ?? `#${id}`;
      const values = TRACED.map((prop) => romProp(layout, read, id, prop));
      return `${name}=${values.join(",")}`;
    })
    .join(" ");
  const audio = tracesAudio(program) ? romAudio(program, layout, read, sceneIndex) : "";
  return `${romTick(layout, read)} ${scene?.name ?? "?"} ${entities}${audio}`;
}
