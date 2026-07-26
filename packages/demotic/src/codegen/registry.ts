/**
 * Which backend builds which console.
 *
 * One list, so that "does Demotic build for this console" has a single answer and
 * every surface reads it: the CLI's console check, the web app's picker, and the
 * conformance suite's target list. A console with a backend is a console that
 * builds — there is no second list of "supported" ids to fall out of step with
 * this one.
 */

import type { Program } from "../program.js";

import { anyBackend, type AnyBackend, type BuiltRom, type BuildOptions } from "./backend.js";
import { gbBackend } from "./gb.js";
import { nesBackend } from "./nes.js";
import { smsBackend } from "./sms.js";

/** Every backend, in the order a listing shows them. */
const BACKENDS: readonly AnyBackend[] = [
  anyBackend(gbBackend),
  anyBackend(nesBackend),
  anyBackend(smsBackend),
];

/** Console ids a Demotic program can be built for. */
export const runtimeConsoles: readonly string[] = BACKENDS.flatMap((backend) => backend.consoles);

/** The codegen family a console belongs to, or `undefined` if it has no backend. */
export function familyFor(consoleId: string): string | undefined {
  return BACKENDS.find((backend) => backend.consoles.includes(consoleId))?.family;
}

/** Whether a console has a backend at all. */
export function hasRuntime(consoleId: string): boolean {
  return familyFor(consoleId) !== undefined;
}

/** The file extension a built cartridge takes for this program's console. */
export function romExtension(program: Program): string {
  const backend = BACKENDS.find((entry) => entry.consoles.includes(program.profile.id));
  return backend?.extension(program) ?? "bin";
}

/**
 * Language features the program's console has no backend for.
 *
 * A console with no backend at all is the first of them, which is why this
 * answers for any console rather than only the ones that build.
 */
export function unsupportedFor(program: Program): string[] {
  const backend = BACKENDS.find((entry) => entry.consoles.includes(program.profile.id));
  if (!backend) return [`a runtime for ${program.profile.name}`];
  return backend.unsupported(program);
}

/** Build a cartridge for whichever console the program was compiled for. */
export function buildGame(program: Program, options: BuildOptions = {}): BuiltRom {
  const backend = BACKENDS.find((entry) => entry.consoles.includes(program.profile.id));
  if (!backend) {
    throw new Error(
      `no Demotic backend for '${program.profile.id}' — try ${runtimeConsoles.join(", ")}`,
    );
  }
  return backend.build(program, options);
}
