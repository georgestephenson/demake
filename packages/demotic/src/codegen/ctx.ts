/**
 * The compilation context: everything an emitter needs, and the two registries
 * that make dead code impossible rather than merely unlikely.
 *
 * **Constants are pooled.** A 16.16 literal is four ROM bytes, addressed, so an
 * operation can take it as a source operand directly instead of materialising
 * it into RAM first. Identical literals share bytes, which matters more than it
 * sounds: a game generated from a template repeats the same numbers everywhere.
 *
 * **Helpers are pulled, never pushed.** A routine exists in the ROM if and only
 * if something asked for it while emitting. That is the mechanism behind "a
 * game that never divides has no divider": there is no list of routines to
 * prune, because nothing was ever added.
 */

import { Asm, label, type Ref } from "@demake/core";

import type { ConsoleProfile } from "../profiles.js";
import type { Program } from "../program.js";

import type { Analysis } from "./analyze.js";
import type { Layout } from "./layout.js";

/** A routine the code generator can ask for by name. */
export type HelperName = string;

/** Emits a helper's body. Called once, after the main program. */
export type HelperBody = (ctx: Ctx) => void;

/**
 * What a rule needs to fire a sound.
 *
 * Two bytes, and they are deliberately not the same one. The driver *consumes*
 * its request on the next interrupt, and a trace has to be able to read what the
 * game asked for after that has happened — so the request and the record of it
 * are written separately (doc 17 §Demotic).
 */
export interface AudioHooks {
  /**
   * Whether this build embedded a driver at all.
   *
   * A game whose edge did not supply its music and effects still records what it
   * *asked* for, so its trace is the same one it would produce with the audio in
   * — which is what lets the conformance suite run without loading a byte of it.
   */
  driver: boolean;
  /** High-RAM byte the driver reads for a track: the index plus one, or stop. */
  music: number;
  /** High-RAM byte the driver reads for an effect: the index plus one. */
  request: number;
  /** Work-RAM byte the trace reads: the effect index, or `$FF`. */
  trace: number | null;
  /** Driver index of each of the program's sounds; `-1` when unsupplied. */
  effects: readonly number[];
}

/** Shared state for one compilation. */
export class Ctx {
  readonly asm: Asm;
  /** Set when the program has audio; absent leaves every rule as it was. */
  audio: AudioHooks | undefined = undefined;
  /** 16.16 value → the label of its pooled ROM copy. */
  private readonly constants = new Map<number, string>();
  /** Helper name → its body, in request order so output stays deterministic. */
  private readonly helpers = new Map<HelperName, HelperBody>();
  private readonly emitted = new Set<HelperName>();
  private counter = 0;
  /** Depth of the expression temp stack currently in use. */
  private depth = 0;

  constructor(
    readonly program: Program,
    readonly analysis: Analysis,
    readonly layout: Layout,
    readonly profile: ConsoleProfile,
    origin = 0,
  ) {
    this.asm = new Asm(origin);
  }

  /** A label nobody else will use. */
  unique(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  /** Reference a pooled 16.16 constant; emits it once, at the end. */
  constant(value: number): Ref {
    const key = value | 0;
    let name = this.constants.get(key);
    if (name === undefined) {
      name = `K_${(key >>> 0).toString(16)}`;
      this.constants.set(key, name);
    }
    return label(name);
  }

  /** Ask for a helper routine, and get the label to call. */
  need(name: HelperName, body: HelperBody): Ref {
    if (!this.helpers.has(name)) this.helpers.set(name, body);
    return label(name);
  }

  /** Whether a helper has been requested at all. */
  wants(name: HelperName): boolean {
    return this.helpers.has(name);
  }

  /** Every helper the program pulled in — what the build report shows. */
  helperNames(): readonly string[] {
    return [...this.helpers.keys()];
  }

  // --- expression temporaries ------------------------------------------------

  /** Claim the next temporary; the caller must release it. */
  pushTemp(): number {
    const address = this.layout.temps[this.depth];
    if (address === undefined) {
      throw new Error(`expression nesting exceeded ${this.layout.temps.length} temporaries`);
    }
    this.depth += 1;
    return address;
  }

  /** Release the most recently claimed temporary. */
  popTemp(): void {
    this.depth -= 1;
  }

  /** Run `body` with the temp stack restored afterwards. */
  scoped<T>(body: () => T): T {
    const mark = this.depth;
    const result = body();
    this.depth = mark;
    return result;
  }

  // --- finishing -------------------------------------------------------------

  /**
   * Emit every requested helper, then the constant pool.
   *
   * Helpers may request other helpers while being emitted, so this drains the
   * queue rather than iterating it once — the reachability closure, computed
   * the simplest way that terminates.
   */
  finish(): void {
    for (;;) {
      const pending = [...this.helpers.keys()].filter((name) => !this.emitted.has(name));
      if (pending.length === 0) break;
      for (const name of pending) {
        this.emitted.add(name);
        this.asm.label(name);
        (this.helpers.get(name) as HelperBody)(this);
      }
    }
    for (const [value, name] of this.constants) {
      this.asm.label(name).dd(value);
    }
  }
}
