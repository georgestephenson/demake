/**
 * How Demotic compiles, as an interface — and the two places that order matters.
 *
 * Doc 14 §Runtime model says a backend is the only thing that knows an opcode,
 * and doc 14 §Conformance says two backends must produce the same game. Those
 * pull in opposite directions unless the *shape* of a build is written down
 * somewhere neither console owns, which is what this file is. A console supplies
 * six answers — where state goes, what it cannot compile, how its art and its
 * audio are demade, how many tiles it has, and how to turn a plan into a
 * cartridge — and everything between those answers happens here, once.
 *
 * Two orders are load-bearing enough to be code rather than prose:
 *
 *   - **The build's.** {@link buildRom} is the whole of `demake build` below the
 *     edges: refuse what cannot be compiled, plan the RAM, demake the art, check
 *     it fits, demake the audio, emit, size-check, stamp. A backend that ran
 *     these in a different order would, for instance, plan RAM against an art
 *     binding that had not happened yet — and the failure would surface as a
 *     wrong address rather than as a missing step.
 *   - **The tick's.** {@link emitTickSteps} calls doc 14's seven steps in doc
 *     14's order. That order *is* the specification: "a backend that reorders
 *     these diverges within seconds". Written once, with each console supplying
 *     the instructions for a step and none of them supplying the sequence, it
 *     cannot be reordered by accident — which is worth more than the handful of
 *     lines it saves.
 *
 * What deliberately is *not* here: anything that emits an instruction. The hooks
 * below return numbers, tables and bytes; the code that implements a step lives
 * in the backend, because a shared instruction layer would be a fake common
 * denominator between a machine with seven registers and one with three.
 */

import type { Executor } from "@demake/core";

import type { Program } from "../program.js";

import { analyze, type Analysis } from "./analyze.js";
import { LayoutError, planLayout, type Layout, type MemoryPlan } from "./layout.js";
import type { SceneCtx, LevelData } from "./shape.js";

/** Raised when a game cannot be built for this console. */
export class BuildError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "BuildError";
  }
}

/** What a bound-asset pass hands back, whatever the console. */
export interface BoundAssets<Options> {
  /** The options the emitter needs — the console's own shape. */
  emit: Options;
  /** Tiles the conversion added to the built-in bank. */
  tiles: number;
  /** Files the program names that no bytes were supplied for. */
  missing: readonly string[];
  /** What the demakers reported: dropped parts, gestures, merged channels. */
  notes?: readonly string[];
}

/** What a build produced, and what it cost. */
export interface RomStats {
  /** Bytes of code and data emitted, before padding. */
  bytes: number;
  /** ROM still free. */
  free: number;
  /** Work RAM in use. */
  ram: number;
  scenes: number;
  instances: number;
  rules: number;
  /** Runtime helpers the program actually pulled in. */
  helpers: readonly string[];
  /** Tiles the art conversion added to the built-in bank. */
  artTiles: number;
  /** Art the program names that no bytes were supplied for. */
  missingArt: readonly string[];
  /** Tracks and effects the game plays, and what they cost. */
  audio?: {
    tracks: number;
    effects: number;
    /** Driver code bytes. */
    code: number;
    /** Packed schedule bytes. */
    data: number;
    /** Driver routines this game pulled in. */
    helpers: readonly string[];
    /** The tick rate the ROM's audio really runs at, in Hz. */
    rateHz: number;
    /** Writes an effect could not keep, because it borrows one channel. */
    writesRestricted: number;
    /** What the demakers reported: dropped parts, gestures, channels. */
    notes: readonly string[];
  };
  /** Music and sound files the program names that no bytes were supplied for. */
  missingAudio: readonly string[];
}

/** A built ROM, with the map a harness needs to read its state. */
export interface BuiltRom {
  bytes: Uint8Array;
  layout: Layout;
  analysis: Analysis;
  symbols: ReadonlyMap<string, number>;
  stats: RomStats;
}

/** What the emitter produced, before it becomes a cartridge. */
export interface Assembled {
  /** The finished cartridge, header and padding included. */
  bytes: Uint8Array;
  /** Bytes of code and data the program compiled to, before padding. */
  code: number;
  /** Bytes the cartridge holds, so "free" means something. */
  capacity: number;
  symbols: ReadonlyMap<string, number>;
  /** Runtime helpers the program pulled in. */
  helpers: readonly string[];
}

/** Raw bytes of the assets a program names, keyed by the file name it wrote. */
export type AssetBytes = ReadonlyMap<string, Uint8Array>;

/**
 * What every console's audio binding has in common.
 *
 * `code` and `data` are only known once the driver has been *emitted*, which
 * happens inside `assemble` — long after a binding hands this back — so a backend
 * exposes them as getters over the driver's own stats rather than copying the
 * numbers out early. `helpers` reads correctly either way because it is the
 * driver's own array, filled in by reference as routines are pulled.
 */
export interface BoundAudioShape {
  /** Absent for a game with no `music` and no `sound`. */
  present: boolean;
  tracks: number;
  effects: number;
  /** Driver code bytes. Read after `assemble`, never before. */
  readonly code: number;
  /** Packed schedule bytes, tables included. Read after `assemble`. */
  readonly data: number;
  helpers: readonly string[];
  rateHz: number;
  writesRestricted: number;
}

/**
 * One console's implementation of the build.
 *
 * `Art` and `Audio` are the console's own binding types: the hooks that produce
 * them and the hook that consumes them are all this console's, so nothing has to
 * pretend a Game Boy Color palette block and an NES attribute table are the same
 * object.
 */
export interface Backend<Art, Audio extends BoundAudioShape> {
  /** The codegen family, as doc 06 names it. */
  readonly family: string;
  /** Console ids this backend builds for. */
  readonly consoles: readonly string[];
  /** What to call the cartridge in a message. */
  readonly cartridge: string;
  /** The file extension a built cartridge takes, which the console decides. */
  extension(program: Program): string;

  /**
   * Language features this backend does not implement, named.
   *
   * A gap is a build error, never a silent difference (doc 14 §Runtime model): a
   * cartridge that played a different game from the preview would make the trace
   * oracle report a divergence three layers from its cause.
   */
  unsupported(program: Program): string[];

  /** Where this machine's state goes. */
  memory(program: Program): MemoryPlan;

  /**
   * Demake the art the program names, through the image engine.
   *
   * `async` because the image engine's tournament may be spread over cores, and
   * the `executor` is where the edge said to spread it (doc 04 §Running the
   * tournament). A backend passes it through and never inspects it: which
   * threads ran a fit cannot change what the fit produced, and a backend that
   * behaved differently with one would have broken that guarantee.
   */
  bindArt(program: Program, assets: AssetBytes, executor?: Executor): Promise<BoundAssets<Art>>;

  /**
   * Demake the music and effects, through the audio engine.
   *
   * The layout is an argument because a driver has to be told where its state
   * lives, and that is a plan the build has already made: the Game Boy's is at a
   * fixed high-RAM address the allocator never hands out, the NES's is page-zero
   * bytes the allocator chose.
   *
   * `async` for the same reason `bindArt` is: an effect's gesture families are a
   * tournament, and `executor` is where the edge said to run one.
   */
  bindAudio(
    program: Program,
    assets: AssetBytes,
    layout: Layout,
    executor?: Executor,
  ): Promise<BoundAssets<Audio>>;

  /**
   * Refuse a game whose art does not fit the tile hardware.
   *
   * Separate from `bindArt` because the budget is the console's and the
   * conversion is the engine's: what fits is a hardware fact, and the message has
   * to name the machine.
   */
  checkTiles(program: Program, art: BoundAssets<Art>): void;

  /** Compile the program and wrap it in a cartridge. */
  assemble(input: {
    program: Program;
    analysis: Analysis;
    layout: Layout;
    art: Art;
    audio: Audio;
    title: string | undefined;
  }): Assembled;
}

/**
 * A backend with its binding types erased.
 *
 * `Backend` is generic in what a console's art and audio bindings *are*, which is
 * what lets a Game Boy Color palette block and an NES attribute table both be
 * "the art" without either pretending to be the other. A registry cannot be
 * generic in two things at once, and does not need to be: what it deals in is the
 * contract — build this, for that console, into a file with this extension.
 */
export interface AnyBackend {
  readonly family: string;
  readonly consoles: readonly string[];
  extension(program: Program): string;
  unsupported(program: Program): string[];
  build(program: Program, options: BuildOptions): Promise<BuiltRom>;
}

/** Erase a backend's binding types, keeping the contract. */
export function anyBackend<Art, Audio extends BoundAudioShape>(
  backend: Backend<Art, Audio>,
): AnyBackend {
  return {
    family: backend.family,
    consoles: backend.consoles,
    extension: (program) => backend.extension(program),
    unsupported: (program) => backend.unsupported(program),
    build: (program, options) => buildRom(program, backend, options),
  };
}

/** Options every backend's build accepts. */
export interface BuildOptions {
  /** Cartridge title, as far as the header has room for one. */
  title?: string;
  /**
   * Raw bytes of the assets the program names, keyed by the file name it wrote.
   *
   * Converting inside the build rather than at the edges is what makes the browser
   * and the CLI produce identical cartridges: both hand over the same source bytes,
   * and every decision from rasterising to tile dedup happens in one place.
   */
  assets?: AssetBytes;
  /**
   * Where the art and audio tournaments run (doc 04 §Running the tournament).
   *
   * A build is mostly tournaments — a colour backdrop is around seventy per cent
   * of one — and their candidates cannot see each other, so an edge with threads
   * to spare hands one in: the CLI's runs on `worker_threads`, the page's on Web
   * Workers. Omitted, everything runs on this thread, and the cartridge is the
   * same bytes either way.
   */
  executor?: Executor;
}

/**
 * Build a cartridge: the whole of `demake build` below the edges.
 *
 * Every step that is not a hook is the same on every console, including the error
 * codes — because they describe the same failures. What changes is the number in
 * the message and the machine's name.
 */
export async function buildRom<Art, Audio extends BoundAudioShape>(
  program: Program,
  backend: Backend<Art, Audio>,
  options: BuildOptions = {},
): Promise<BuiltRom> {
  const missing = backend.unsupported(program);
  if (missing.length > 0) {
    throw new BuildError(
      "E_RUNTIME_UNSUPPORTED",
      `the ${backend.family} backend cannot build ${missing.join(" or ")}`,
      "the preview runs it; the ROM would play a different game, so the build stops here",
    );
  }

  const analysis = analyze(program);
  let layout: Layout;
  try {
    layout = planLayout(program, analysis, backend.memory(program));
  } catch (error) {
    if (error instanceof LayoutError) throw new BuildError(error.code, error.message, error.hint);
    throw error;
  }

  const assets = options.assets ?? new Map<string, Uint8Array>();

  // Art and audio have nothing to say to each other, so they are demade at the
  // same time: on a game with a colour backdrop the art is most of the build and
  // the effects are most of the rest, and running them in sequence left whichever
  // lanes the shorter one was not using idle.
  //
  // Settled rather than raced, because *which* failure a build reports must not
  // depend on which demaker happened to fail first in wall-clock terms. Art is
  // checked first, exactly as it was when the two ran in order.
  const [artResult, audioResult] = await Promise.allSettled([
    backend.bindArt(program, assets, options.executor),
    backend.bindAudio(program, assets, layout, options.executor),
  ]);

  if (artResult.status === "rejected") throw artResult.reason;
  const art = artResult.value;
  backend.checkTiles(program, art);

  if (audioResult.status === "rejected") {
    throw new BuildError(
      "E_AUDIO",
      `this game's audio could not be demade: ${(audioResult.reason as Error).message}`,
      "the track or the effect is what to look at; `demake arrange` and `demake sfx` report the same failure on their own",
    );
  }
  const audio = audioResult.value;

  const built = backend.assemble({
    program,
    analysis,
    layout,
    art: art.emit,
    audio: audio.emit,
    title: options.title,
  });

  if (built.code > built.capacity) {
    throw new BuildError(
      "E_GAME_TOO_LARGE",
      `this game compiles to ${built.code} bytes and ${backend.cartridge} holds ${built.capacity}`,
      "fewer objects in one rule, or a smaller level; bank switching is doc 15 §Not in v1.",
    );
  }

  const sound = audio.emit;
  return {
    bytes: built.bytes,
    layout,
    analysis,
    symbols: built.symbols,
    stats: {
      bytes: built.code,
      free: built.capacity - built.code,
      ram: layout.used,
      scenes: program.scenes.length,
      instances: program.instances.length,
      rules: program.rules.length,
      helpers: built.helpers,
      artTiles: art.tiles,
      missingArt: art.missing,
      ...(sound.present
        ? {
            audio: {
              tracks: sound.tracks,
              effects: sound.effects,
              code: sound.code,
              data: sound.data,
              helpers: sound.helpers,
              rateHz: sound.rateHz,
              writesRestricted: sound.writesRestricted,
              notes: audio.notes ?? [],
            },
          }
        : {}),
      missingAudio: audio.missing,
    },
  };
}

/**
 * The seven steps of a tick, and the bookkeeping between them.
 *
 * One method per step of doc 14 §Runtime model's list, in that list's numbering.
 * A console implements the instructions; it does not get a say in the order.
 */
export interface TickSteps {
  /** 2. Apply `control` bindings. (1, the input edges, is once per tick.) */
  controls(scene: SceneCtx): void;
  /** 3. Apply level-triggered rules. */
  levelRules(scene: SceneCtx): void;
  /** 4. Integrate positions: `direction × speed ÷ fps`, floored, in that order. */
  integrate(scene: SceneCtx): void;
  /** Start this tick's contact set; last tick's is what `hits` tests against. */
  beginContacts(): void;
  /** 5. Detect collisions, fire `hits` rules on entry, then separate. */
  collisions(scene: SceneCtx): void;
  /** Keep this tick's contacts as the history the next one compares against. */
  endContacts(): void;
  /** 6. Tile rules, then tile separation — only where the scene has a level. */
  tileRules(scene: SceneCtx, level: LevelData): void;
  /** 7. Fire edge-triggered rules. */
  edgeRules(scene: SceneCtx): void;
  /** 8. Move the camera, which is the last thing a tick does. */
  camera(scene: SceneCtx): void;
}

/**
 * Emit one scene's tick in the order the interpreter runs it.
 *
 * The order is the specification (doc 14 §Runtime model): a backend that reorders
 * these diverges within seconds, and the trace oracle exists to prove it did not.
 * Having exactly one copy of the sequence is how "the NES does it in the same
 * order" stops being a claim about two files and becomes a property of one.
 */
export function emitTickSteps(steps: TickSteps, scene: SceneCtx, level: LevelData | undefined) {
  steps.controls(scene);
  steps.levelRules(scene);
  steps.integrate(scene);
  steps.beginContacts();
  steps.collisions(scene);
  steps.endContacts();
  if (level) steps.tileRules(scene, level);
  steps.edgeRules(scene);
  steps.camera(scene);
}
