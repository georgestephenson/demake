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
 *
 * Neither of those is a property of an instruction set, so both live in
 * {@link CtxBase} and every backend gets them. What a backend supplies is its
 * assembler — and that is the whole of the difference, which is the useful thing
 * this split says out loud: two consoles share the *reachability* rule and the
 * constant pool exactly, and share not one opcode.
 */

import { Asm, label, MBC5, type Ref } from "@demake/core";

import type { ConsoleProfile } from "../profiles.js";
import type { Program } from "../program.js";

import type { Analysis } from "./analyze.js";
import type { Layout } from "./layout.js";

/** A routine the code generator can ask for by name. */
export type HelperName = string;

/**
 * What {@link CtxBase} needs of an assembler.
 *
 * Only what the constant pool itself emits. Everything else an emitter does goes
 * through the concrete assembler, whose type the subclass fixes.
 */
export interface CodeBuffer {
  label(name: string): unknown;
  dd(value: number): unknown;
  /**
   * Pad to a boundary, on a machine that has one.
   *
   * Optional because most of the processors here have none: a 6502 or a Z80
   * reads a thirty-two-bit constant a byte at a time and does not care where it
   * starts. A V810 does — it *masks* the low bits of an unaligned word access
   * rather than faulting, so a pool that began on an odd halfword would hand
   * every constant back four bytes of somewhere else, silently.
   */
  align?(bytes: 2 | 4): unknown;
}

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
  /** Byte the driver reads for a track: the index plus one, or stop. */
  music: number;
  /** Byte the driver reads for an effect: the index plus one. */
  request: number;
  /** Work-RAM byte the trace reads: the effect index, or `$FF`. */
  trace: number | null;
  /** Driver index of each of the program's sounds; `-1` when unsupplied. */
  effects: readonly number[];
}

/** Shared state for one compilation, whatever the target. */
export abstract class CtxBase<Self, A extends CodeBuffer> {
  /** The assembler this backend emits through. */
  abstract readonly asm: A;
  /** Set when the program has audio; absent leaves every rule as it was. */
  audio: AudioHooks | undefined = undefined;
  /** 16.16 value → the label of its pooled ROM copy. */
  private readonly constants = new Map<number, string>();
  /** Helper name → its body, in request order so output stays deterministic. */
  private readonly helpers = new Map<HelperName, (ctx: Self) => void>();
  private readonly emitted = new Set<HelperName>();
  private counter = 0;
  /** Depth of the expression temp stack currently in use. */
  private depth = 0;

  constructor(
    readonly program: Program,
    readonly analysis: Analysis,
    readonly layout: Layout,
    readonly profile: ConsoleProfile,
  ) {}

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
  need(name: HelperName, body: (ctx: Self) => void): Ref {
    if (!this.helpers.has(name)) this.helpers.set(name, body);
    return label(name);
  }

  /** Whether a helper has been requested at all. */
  wants(name: HelperName): boolean {
    return this.helpers.has(name);
  }

  /**
   * Ask for a table to be emitted after the code, with the data.
   *
   * A helper is a routine and this is its argument: an emitter that loops over
   * something needs the something *somewhere*, and it cannot be in the middle of
   * the instruction stream. Queued in request order, so the output stays a
   * function of the program rather than of when the queue was drained.
   */
  data(body: (asm: A) => void): void {
    this.tables.push(body);
  }
  private readonly tables: ((asm: A) => void)[] = [];

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
        (this.helpers.get(name) as (ctx: Self) => void)(this as unknown as Self);
      }
    }
    // After the helpers, because a helper may have asked for a table of its own.
    for (const table of this.tables) table(this.asm);
    if (this.constants.size > 0) this.asm.align?.(4);
    for (const [value, name] of this.constants) {
      this.asm.label(name);
      this.asm.dd(value);
    }
  }
}

/** Emits a helper's body for the Game Boy backend. Called once, after the program. */
export type HelperBody = (ctx: Ctx) => void;

/** The Game Boy compilation context. */
export class Ctx extends CtxBase<Ctx, Asm> {
  readonly asm: Asm;

  /**
   * Which paged bank each routine outside bank zero lives in.
   *
   * Empty for a game that fits a 32 KiB ROM-only cartridge, which is every
   * example but one, and then this backend emits exactly what it always did. With
   * entries, the routines it names answer `$4000` once MBC5 has been pointed at
   * their bank — so {@link enter} is how anything reaches them (doc 13 §Banked
   * cartridges).
   *
   * A *routine*'s map rather than a scene's, because this console's window is
   * sixteen kilobytes and the library's biggest scene is twenty-seven: the units
   * are a scene's tick steps and its three other routines, as on the Sega 8-bits.
   */
  banks = new Map<string, number>();

  /**
   * Where the running bank is shadowed, or `null` when nothing pages.
   *
   * MBC5's bank register is **write-only**, so the only way to know what is in
   * the window is to have written down what was put there. That matters here and
   * not on the Sega for one reason: this console's audio driver is entered by an
   * *interrupt*, which can arrive with any bank mapped — so the handler pages the
   * audio's own bank and has to put back whatever it interrupted, and this is
   * where it reads it from.
   */
  bankShadow: number | null = null;

  /** Point the window at the bank holding `target`, when it is paged. */
  enter(target: string): void {
    const bank = this.banks.get(target);
    if (bank === undefined) return;
    this.asm.ldn("a", bank);
    if (this.bankShadow !== null) this.asm.sta(this.bankShadow);
    this.asm.sta(MBC5.romBankLow);
  }

  /** Call a routine, paging it in first if it is not in bank zero. */
  callUnit(target: string): void {
    this.enter(target);
    this.asm.call(target);
  }

  /**
   * Jump to a routine, paging it in first.
   *
   * For the dispatches that *tail* into a scene's routine: the routine's own
   * `ret` lands back at whatever called the dispatch, so a jump is a call that
   * costs nothing, banked or not.
   */
  jumpUnit(target: string): void {
    this.enter(target);
    this.asm.jp(target);
  }

  constructor(
    program: Program,
    analysis: Analysis,
    layout: Layout,
    profile: ConsoleProfile,
    origin = 0,
  ) {
    super(program, analysis, layout, profile);
    this.asm = new Asm(origin);
  }

  /**
   * Whether this build targets colour hardware.
   *
   * The one fact that changes what the renderer emits: on a Game Boy Color
   * every background cell carries an attribute byte in a second VRAM bank and
   * every object names one of eight palettes, so the cell routines, the write
   * queue and the OAM builder all have a second half. Nothing else in the
   * backend branches on the console — the machine code a rule compiles to is
   * the same on both, which is why a `gb` and a `gbc` build of one game trace
   * identically.
   */
  get color(): boolean {
    return this.profile.id === "gbc";
  }

  /**
   * Whether this build targets the Mega Duck.
   *
   * The other fact that changes what the renderer emits, and it changes far
   * less than colour does: the console is a Game Boy clone whose I/O page was
   * rewired, so the *addresses* the renderer stores to move and `LCDC`'s bits
   * are permuted. Not one instruction differs otherwise — no rule, no
   * collision, no tick — which is why `rom.test.ts` runs the whole example
   * library here and expects the Game Boy's traces byte for byte.
   */
  get duck(): boolean {
    return this.profile.id === "megaduck";
  }
}
