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

/**
 * Read a run of bytes as one unsigned integer, in the machine's own order.
 *
 * The one place the trace reader knows a console apart. Three of the four store
 * the low byte first and the 68000 stores the high byte first, and a reader that
 * assumed either would report every value in a Mega Drive's work RAM
 * byte-swapped — which reads as an arithmetic bug three layers from its cause.
 */
function readInt(layout: Layout, bytes: Uint8Array): number {
  let value = 0;
  if (layout.memory.bigEndian === true) {
    for (const byte of bytes) value = (value * 256 + byte) >>> 0;
    return value >>> 0;
  }
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value * 256 + (bytes[index] as number)) >>> 0;
  }
  return value >>> 0;
}

/** Ticks the ROM has completed. */
export function romTick(layout: Layout, read: MemoryReader): number {
  return readInt(layout, read(layout.tick, 2));
}

/**
 * One property of one entity, as a signed 16.16 value.
 *
 * Not always a read. A record stops at the highest slot the program can observe
 * (`codegen/layout.ts` §entityBytes), so a coin that never moves has no
 * `xdirection` in RAM at all — and the bytes at that offset belong to the next
 * object. What the oracle wants is the *state*, and the state of a property
 * nothing can write is the value it was declared with, which is exactly what the
 * emitted code folds into its instructions. So the fallback is not an
 * approximation: it is where that number lives on this machine.
 */
export function romProp(
  program: Program,
  layout: Layout,
  read: MemoryReader,
  instanceId: number,
  prop: string,
): number {
  const slot = PROP_SLOT[prop];
  if (slot === undefined) throw new Error(`'${prop}' is not a stored property`);
  const base = layout.entities[instanceId];
  if (base === undefined) throw new Error(`no entity ${instanceId}`);
  const stored = layout.entitySizes[instanceId] ?? 0;
  if (slot * PROP_SIZE >= stored) {
    return program.instances[instanceId]?.numbers[prop] ?? 0;
  }
  const raw = readInt(layout, read(base + slot * PROP_SIZE, PROP_SIZE));
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
      const values = TRACED.map((prop) => romProp(program, layout, read, id, prop));
      return `${name}=${values.join(",")}`;
    })
    .join(" ");
  const audio = tracesAudio(program) ? romAudio(program, layout, read, sceneIndex) : "";
  return `${romTick(layout, read)} ${scene?.name ?? "?"} ${entities}${audio}`;
}
