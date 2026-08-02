/**
 * Which backend builds which console.
 *
 * One list, so that "does Demotic build for this console" has a single answer and
 * every surface reads it: the CLI's console check, the web app's picker, and the
 * conformance suite's target list. A console with a backend is a console that
 * builds — there is no second list of "supported" ids to fall out of step with
 * this one.
 *
 * **The list is descriptions, and the backends behind it are loaded on demand.**
 * Which consoles a family covers, what a cartridge is called and what the family
 * cannot do are a few lines each; an emitter and its assembler are a hundred
 * kilobytes. Naming them in one static table made every surface that only wanted
 * to *ask* a question pull in all five — which on the command line costs nothing
 * and in a browser is five consoles' machine code downloaded by a visitor
 * building for one (doc 07 §Quality bar, and the split
 * `tools/ci/check-web-budget.mjs` asks for in its own header).
 *
 * So the questions stay synchronous and answer from the descriptions, and
 * `buildGame` — which was always `async` — awaits the one family it needs. A
 * bundler splits on the `import()` without being told anything, and Node treats
 * it as an ordinary lazy require.
 */

import type { Program } from "../program.js";

import { anyBackend, type AnyBackend, type BuiltRom, type BuildOptions } from "./backend.js";

/**
 * What a family says about itself without being loaded.
 *
 * Everything here has to be answerable from a console id and a profile, because
 * that is the price of not loading the emitter. Each of these is the backend's
 * own method with its body inlined, and `registry.test.ts` checks the two agree
 * — a description that drifted from its backend would be a page offering a
 * console the build then refuses.
 */
interface FamilyDescriptor {
  family: string;
  consoles: readonly string[];
  /** The cartridge's file extension, given the console it was built for. */
  extension: (consoleId: string) => string;
  /** The module that actually emits, fetched only when something builds. */
  load: () => Promise<AnyBackend>;
}

const FAMILIES: readonly FamilyDescriptor[] = [
  {
    family: "gb",
    consoles: ["gb", "gbc", "megaduck"],
    // The Mega Duck's own extension in every emulator that knows the console.
    extension: (id) => (id === "gbc" ? "gbc" : id === "megaduck" ? "duck" : "gb"),
    load: async () => anyBackend((await import("./gb.js")).gbBackend),
  },
  {
    family: "nes",
    consoles: ["nes"],
    extension: () => "nes",
    load: async () => anyBackend((await import("./nes.js")).nesBackend),
  },
  {
    family: "sms",
    consoles: ["sms", "gg"],
    extension: (id) => (id === "gg" ? "gg" : "sms"),
    load: async () => anyBackend((await import("./sms.js")).smsBackend),
  },
  {
    family: "snes",
    consoles: ["snes"],
    extension: () => "sfc",
    load: async () => anyBackend((await import("./snes.js")).snesBackend),
  },
  {
    family: "md",
    consoles: ["md"],
    extension: () => "md",
    load: async () => anyBackend((await import("./md.js")).mdBackend),
  },
  {
    family: "gba",
    consoles: ["gba"],
    extension: () => "gba",
    load: async () => anyBackend((await import("./gba.js")).gbaBackend),
  },
];

function descriptorFor(consoleId: string): FamilyDescriptor | undefined {
  return FAMILIES.find((entry) => entry.consoles.includes(consoleId));
}

/** Console ids a Demotic program can be built for. */
export const runtimeConsoles: readonly string[] = FAMILIES.flatMap((entry) => entry.consoles);

/** Every family, for a surface that wants to list them rather than ask about one. */
export const runtimeFamilies: readonly string[] = FAMILIES.map((entry) => entry.family);

/** The codegen family a console belongs to, or `undefined` if it has no backend. */
export function familyFor(consoleId: string): string | undefined {
  return descriptorFor(consoleId)?.family;
}

/** Whether a console has a backend at all. */
export function hasRuntime(consoleId: string): boolean {
  return familyFor(consoleId) !== undefined;
}

/** The file extension a built cartridge takes for this program's console. */
export function romExtension(program: Program): string {
  return descriptorFor(program.profile.id)?.extension(program.profile.id) ?? "bin";
}

/**
 * Language features the program's console has no backend for.
 *
 * A console with no backend at all is the first of them, which is why this
 * answers for any console rather than only the ones that build. Every family's
 * list is otherwise empty and has been since the Game Boy landed — a gap that
 * changed what a *trace* says is the one that must be named here, and none of
 * the five has one. The day a family does, this grows a field beside
 * `extension` rather than loading an emitter to ask.
 */
export function unsupportedFor(program: Program): string[] {
  if (!descriptorFor(program.profile.id)) return [`a runtime for ${program.profile.name}`];
  // `from above` is in the language and in the interpreter; no backend emits the
  // side test yet. Named here rather than in each family because none of them
  // has it — this is a gap in the emitters as a group, not a difference between
  // them, and it needs no backend loaded to answer. A cartridge that ignored the
  // clause would play a *different game* from the preview and the trace oracle
  // would report the divergence three layers from its cause, which is the whole
  // reason gaps are named (AGENTS.md §Iron rules).
  if (program.rules.some((rule) => rule.event.kind === "hits" && rule.event.sides.length > 0)) {
    return ["`from <side>` on a collision trigger"];
  }
  return [];
}

/**
 * Build a cartridge for whichever console the program was compiled for.
 *
 * The one function that loads an emitter, and the only place a family's module
 * is reached from. It was already `async`, so nothing above it changed shape.
 */
export async function buildGame(program: Program, options: BuildOptions = {}): Promise<BuiltRom> {
  const descriptor = descriptorFor(program.profile.id);
  if (!descriptor) {
    throw new Error(
      `no Demotic backend for '${program.profile.id}' — try ${runtimeConsoles.join(", ")}`,
    );
  }
  const backend = await descriptor.load();
  return backend.build(program, options);
}
