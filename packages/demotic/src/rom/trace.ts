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

import { ENTITY_SIZE, PROP_IDS, PROP_SIZE, RAM } from "./format.js";

/** Reads `length` bytes of the machine's address space. */
export type MemoryReader = (address: number, length: number) => Uint8Array;

/** Properties a trace records, in order. Mirrors `trace.ts`. */
const TRACED = ["x", "y", "xdirection", "ydirection", "speed", "value"] as const;

/** The scene index the ROM is running. */
export function romScene(read: MemoryReader): number {
  return read(RAM.scene, 1)[0] as number;
}

/**
 * The runtime's tick handshake.
 *
 * A single byte, bumped *after* the sixteen-bit tick counter, so a harness that
 * watches it can never observe the counter half-updated — which is exactly what
 * happens on the 255-to-256 boundary if you watch the counter itself.
 */
export function romReady(read: MemoryReader): number {
  return read(RAM.ready, 1)[0] as number;
}

/** Ticks the ROM has completed. */
export function romTick(read: MemoryReader): number {
  const bytes = read(RAM.tick, 2);
  return (bytes[0] as number) | ((bytes[1] as number) << 8);
}

/** One stored property of one entity, as a signed 16.16 value. */
export function romProp(read: MemoryReader, instanceId: number, prop: string): number {
  const id = PROP_IDS[prop];
  if (id === undefined) throw new Error(`no runtime id for property '${prop}'`);
  const bytes = read(RAM.entities + instanceId * ENTITY_SIZE + id * PROP_SIZE, PROP_SIZE);
  const raw =
    ((bytes[0] as number) |
      ((bytes[1] as number) << 8) |
      ((bytes[2] as number) << 16) |
      ((bytes[3] as number) << 24)) >>>
    0;
  return raw >= 0x80000000 ? raw - 0x100000000 : raw;
}

/** The trace line for the tick the ROM has just finished. */
export function romTraceLine(program: Program, read: MemoryReader): string {
  const sceneIndex = romScene(read);
  const scene = program.scenes[sceneIndex];
  const entities = (scene?.instanceIds ?? [])
    .map((id) => {
      const name = program.instances[id]?.name ?? `#${id}`;
      const values = TRACED.map((prop) => romProp(read, id, prop));
      return `${name}=${values.join(",")}`;
    })
    .join(" ");
  return `${romTick(read)} ${scene?.name ?? "?"} ${entities}`;
}
