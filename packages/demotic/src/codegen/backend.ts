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
 *
 * ## Elastic cartridges
 *
 * A cartridge is as big as the game needs and no bigger. Every console that
 * shipped its games on more than one board picks the smallest of them that holds
 * the program — an NROM-128 rather than an NROM-256, a 32 KiB Sega cartridge
 * rather than a 48, one megabit of Mega Drive rather than four — and grows only
 * when the game does. Which boards exist is the *console's* answer and lives
 * beside its header in `core/src/asm/*-cart.ts`, because the sizes a cartridge can
 * describe itself as are a fact about the hardware; a backend's job is to pick.
 *
 * Two things follow and neither is obvious:
 *
 *   - **`capacity` is the largest board, always.** It is what
 *     {@link RomStats.free} is measured against, and a headroom figure that jumped
 *     upward when a game crossed onto a bigger board would be useless as a
 *     regression signal. What was actually written is {@link RomStats.cartridge}.
 *   - **Growing is a second assembly, not an estimate.** A backend that has to
 *     move its code — the Sega 8-bits pad across a header hole, the NES changes
 *     origin — emits the program again rather than patching the first attempt.
 *     Assembly is milliseconds against art and audio that are already demade.
 *
 * ## Cutting the music
 *
 * When a game does not fit on the biggest board its console has, **the music and
 * the effects go first** and the build says so ({@link RomStats.cut}). A track is
 * a few kilobytes of register schedule and the game around it is the game; a
 * cartridge that plays silently is something somebody can play, and a build error
 * is not. It is done by binding the audio again with no asset bytes at all, so
 * what comes out is exactly the cartridge a project with its music left out
 * already produces — the request bytes a rule writes are still there, so the trace
 * is unchanged (doc 14 §Conformance) and the only difference is that nothing is
 * listening. A game that still does not fit is refused, and told that the music
 * was already gone.
 */

import type { Executor } from "@demake/core";

import type { Program } from "../program.js";

import { analyze, type Analysis } from "./analyze.js";
import { LayoutError, planLayout, type Layout, type MemoryPlan } from "./layout.js";
import type { SceneCtx, LevelData } from "./shape.js";
import type { ArtSettings } from "./settings.js";

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
  /**
   * ROM still free — against the *largest* cartridge this console can build.
   *
   * Not against the one that shipped, which is the elastic part (§Elastic
   * cartridges): a game that grew a hundred bytes and crossed onto the next board
   * up would otherwise see this number jump by sixteen kilobytes, and a budget
   * assertion that moves in the wrong direction when a game gets bigger is not a
   * budget assertion. What it answers is "how much room is left before this game
   * stops fitting the console at all", which is the question a size regression is
   * actually about. {@link cartridge} is what was written.
   */
  free: number;
  /**
   * Bytes the cartridge image really is: the artifact's own length.
   *
   * A demade game is padded up to the smallest board its console came on that
   * holds it (§Elastic cartridges), so this is the elasticity as a number — 16 KiB
   * for an NROM-128 where a bigger game gets 32, 128 KiB for a Mega Drive where a
   * bigger one gets a megabyte.
   */
  cartridge: number;
  /**
   * What the build dropped to make the game fit, named.
   *
   * Empty in the normal case, which is every build that fit. A game that does not
   * fit loses its music and effects first and is told so, because a cartridge that
   * plays silently is a game and a build error is not (§Cutting the music).
   */
  cut: readonly string[];
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
  /**
   * Driver code and packed schedule bytes — **read after {@link buildRom} has
   * assembled, and never before.**
   *
   * A driver is emitted lazily: `@demake/audio` hands back `emitCode`/`emitData`
   * closures and only learns their sizes once the assembler has run them, which
   * happens inside `assemble` — a step *after* `bindAudio`. So a backend exposes
   * these as live queries rather than copying them out of the driver at bind
   * time, or it reports the zero they held before anything was emitted, which is
   * what `demake build` did for every cartridge it made until this became a rule.
   *
   * `helpers` is the same shape and is a query for the same reason. It would
   * survive being copied — copying an array copies its reference, and the emitter
   * pushes rather than replaces — but that is luck, not design, and it is not a
   * distinction worth asking the next backend to remember.
   *
   * Everything above these three is known when the audio is demade.
   */
  readonly code: number;
  readonly data: number;
  readonly helpers: readonly string[];
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
  /**
   * Demake the art, through the image pipeline.
   *
   * `settings` is the Demakefile's conversion cascade, per asset (doc 15
   * §Resolution) — already validated, so a backend receives typed `prep` options
   * and never a string. It is optional, and a build without it is exactly the
   * build there was before the Demakefile could say anything: what a picture is
   * fitted *into* stays the backend's arithmetic either way.
   */
  bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
    settings?: ArtSettings,
  ): Promise<BoundAssets<Art>>;

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
  /**
   * What the Demakefile said about each asset (doc 15 §Resolution, doc 19 step 6).
   *
   * Per-asset `prep` overrides keyed by resolved path, already validated. Absent —
   * which is every build with no build file — this changes nothing at all, and
   * that is the property the whole split depends on: a Demakefile may say *how* a
   * picture is demade and never what it is demade *into*.
   */
  art?: ArtSettings;
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
    backend.bindArt(program, assets, options.executor, options.art),
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

  // Assembling and refusing an overflow are one step, because a backend may find
  // the overflow itself: the Sega 8-bits and the Mega Drive discover it while
  // choosing a board, and the Super Nintendo while packing the sound processor's
  // bank. Every one of those raises `E_GAME_TOO_LARGE`, which is what makes the
  // fallback below a single `catch` rather than a check per console.
  const assembleWith = (sound: Audio): Assembled => {
    const built = backend.assemble({
      program,
      analysis,
      layout,
      art: art.emit,
      audio: sound,
      title: options.title,
    });
    if (built.code > built.capacity) {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `this game compiles to ${built.code} bytes and ${backend.cartridge} holds ${built.capacity}`,
        "fewer objects in one rule, or a smaller level; bank switching is doc 15 §Not in v1.",
      );
    }
    return built;
  };

  let sound = audio;
  let built: Assembled;
  const cut: string[] = [];
  try {
    built = assembleWith(audio.emit);
  } catch (error) {
    const overflowed =
      error instanceof BuildError && error.code === "E_GAME_TOO_LARGE" && audio.emit.present;
    if (!overflowed) throw error;

    // The music goes first. A cartridge that plays the game silently is still the
    // game; a build error is not, and on a console with no bigger board the
    // alternative is nothing at all. Rebinding with no asset bytes rather than
    // subtracting a driver from the emit options is what makes this exactly the
    // build a project with its music left out already produces — request bytes and
    // all, so the trace is unchanged (doc 14 §Conformance) and the only difference
    // is that nobody is listening.
    const silent = await backend.bindAudio(
      program,
      new Map<string, Uint8Array>(),
      layout,
      options.executor,
    );
    try {
      built = assembleWith(silent.emit);
    } catch (again) {
      if (again instanceof BuildError) {
        throw new BuildError(
          again.code,
          again.message,
          `${again.hint === undefined ? "" : `${again.hint} `}The music and effects were cut ` +
            "already and it still does not fit.",
        );
      }
      throw again;
    }
    cut.push(`${(error as BuildError).message}, so its music and effects were cut`);
    // The original `missing` rather than the silent build's, which names every
    // file: what was *not supplied* and what was *dropped to fit* are different
    // things to be told, and only the second one happened here.
    sound = { ...silent, missing: audio.missing, notes: [] };
  }

  const emitted = sound.emit;
  return {
    bytes: built.bytes,
    layout,
    analysis,
    symbols: built.symbols,
    stats: {
      bytes: built.code,
      free: built.capacity - built.code,
      cartridge: built.bytes.length,
      cut,
      ram: layout.used,
      scenes: program.scenes.length,
      instances: program.instances.length,
      rules: program.rules.length,
      helpers: built.helpers,
      artTiles: art.tiles,
      missingArt: art.missing,
      ...(emitted.present
        ? {
            audio: {
              tracks: emitted.tracks,
              effects: emitted.effects,
              code: emitted.code,
              data: emitted.data,
              helpers: emitted.helpers,
              rateHz: emitted.rateHz,
              writesRestricted: emitted.writesRestricted,
              notes: sound.notes ?? [],
            },
          }
        : {}),
      missingAudio: sound.missing,
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
