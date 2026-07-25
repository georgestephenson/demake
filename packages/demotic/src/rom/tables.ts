/**
 * The table emitter: a compiled {@link Program} becomes the byte blob a console
 * runtime executes.
 *
 * This is the second half of doc 14 §2. The compiler already resolved names to
 * indices, screen constants to numbers and every literal to 16.16 fixed point;
 * all that is left is to lay those tables out so a machine with no index
 * registers can walk them. Nothing here is a *translation* of the language —
 * there is no code generation, no per-console special case, and the same blob
 * would serve a 6502 runtime unchanged.
 *
 * Determinism is a hard requirement, not a nicety: the blob is output bytes
 * under doc 09 §Stability, and the browser and the CLI must produce the same
 * ROM for the same source. So every table is emitted in a fixed order, the
 * expression pool deduplicates by first appearance rather than by hash order,
 * and nothing consults a `Map` iteration order that source order did not fix.
 */

import type { LevelFile } from "../level/parse.js";
import type { CAssignment, CExpr, Program, RuleDef } from "../program.js";
import { ACTIONS, EDGES } from "../program.js";

import {
  ASSIGN_KIND,
  BINARY_OPS,
  BUILTIN_OPS,
  CONTROL_MODE,
  DATA_BASE,
  DATA_SIZE,
  FORMAT_VERSION,
  GRID_EMPTY,
  HEADER,
  INSTANCE_KIND,
  MAGIC,
  NONE,
  OP,
  REF,
  RULE_KIND,
  STORED_PROPS,
  TILE_SOLID,
  propId,
} from "./format.js";
import { BUILTIN_TILES, builtinTiles, glyphTile, patternTile } from "./graphics.js";

/** What an emitted blob turned out to contain, for `--json` and diagnostics. */
export interface TableStats {
  /** Total bytes, including the header. */
  bytes: number;
  /** Bytes still free in the ROM's data window. */
  free: number;
  scenes: number;
  instances: number;
  controls: number;
  rules: number;
  levels: number;
  /** Bytes of expression bytecode, after deduplication. */
  code: number;
  tiles: number;
}

/** An emitted program, ready to be patched into a ROM. */
export interface EmittedTables {
  bytes: Uint8Array;
  stats: TableStats;
}

/** Raised when a game does not fit the runtime's fixed limits. */
export class TableError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "TableError";
  }
}

/**
 * Runtime capacities.
 *
 * They are fixed because the runtime's state lives in statically allocated
 * work RAM: a Game Boy has 8 KiB and no allocator worth the bytes it would
 * cost. Exceeding one is a build error naming the limit, which is the same
 * bargain the compiler's hardware diagnostics strike (doc 14 §Diagnostics) —
 * knowable from the numbers, so say so rather than let it be found in an
 * emulator.
 */
export const LIMITS = {
  instances: 64,
  scenes: 16,
  rules: 128,
  controls: 32,
  levels: 8,
  strings: 32,
  /** Live collision contacts tracked for `hits` edge triggering. */
  contacts: 96,
  /** `on hold` snapshots. */
  holdSlots: 64,
} as const;

/** A growable little-endian byte writer. */
class Writer {
  private buffer = new Uint8Array(1024);
  private length = 0;

  get size(): number {
    return this.length;
  }

  private room(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < this.length + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  u8(value: number): void {
    this.room(1);
    this.buffer[this.length++] = value & 0xff;
  }

  u16(value: number): void {
    this.u8(value);
    this.u8(value >> 8);
  }

  i32(value: number): void {
    this.u16(value);
    this.u16(value >> 16);
  }

  bytes(values: Uint8Array): void {
    this.room(values.length);
    this.buffer.set(values, this.length);
    this.length += values.length;
  }

  /** Overwrite a `u16` already written, for header back-patching. */
  patch16(at: number, value: number): void {
    this.buffer[at] = value & 0xff;
    this.buffer[at + 1] = (value >> 8) & 0xff;
  }

  patch8(at: number, value: number): void {
    this.buffer[at] = value & 0xff;
  }

  /** Pad to a two-byte boundary so every table starts aligned. */
  align(): void {
    if (this.length & 1) this.u8(0);
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/**
 * Emit the program tables.
 *
 * `base` is the address the blob will live at; addresses inside it are absolute
 * so the runtime can load a pointer without adding a base (see
 * {@link module:rom/format}).
 */
export function emitTables(program: Program, base: number = DATA_BASE): EmittedTables {
  return new Emitter(program, base).run();
}

class Emitter {
  private readonly out = new Writer();
  /** Deduplicated expression bytecode: encoded bytes → address. */
  private readonly codePool = new Map<string, number>();
  /** Tile legend names, numbered by first appearance. */
  private readonly tileNames = new Map<string, number>();
  /** Levels, numbered by first appearance; a scene's `level` is a reference. */
  private readonly levelIndex = new Map<LevelFile, number>();
  private readonly levels: LevelFile[] = [];
  /** `text` values, numbered by first appearance. */
  private readonly strings: string[] = [];
  private codeBytes = 0;
  private holdSlots = 0;

  constructor(
    private readonly program: Program,
    private readonly base: number,
  ) {}

  private at(): number {
    return this.base + this.out.size;
  }

  run(): EmittedTables {
    this.checkLimits();
    this.collect();

    // Header first, back-patched once the tables below have addresses.
    for (const byte of MAGIC) this.out.u8(byte);
    this.out.u8(FORMAT_VERSION);
    this.out.u8(this.program.profile.fps);
    this.out.u8(this.program.profile.screenWidth);
    this.out.u8(this.program.profile.screenHeight);
    this.out.i32(this.program.seed | 0);
    this.out.u8(this.sceneIndex(this.program.entryScene));
    this.out.u8(this.program.scenes.length);
    this.out.u8(this.program.instances.length);
    this.out.u8(this.program.controls.length);
    this.out.u8(this.program.rules.length);
    this.out.u8(this.levels.length);
    this.out.u8(this.strings.length);
    this.out.u8(0); // flags — reserved
    while (this.out.size < HEADER.size) this.out.u8(0);

    const tilesAt = this.at();
    this.out.bytes(builtinTiles());

    const stringsAt = this.emitStrings();
    const levelsAt = this.emitLevels();

    // Expressions before anything that points at them: assignment lists, rule
    // payloads and rule records all carry code addresses, and a single forward
    // pass beats a fixup table.
    const controlLists = this.program.controls.map((control) =>
      this.emitAssignments(control.assignments),
    );
    const ruleLists = this.program.rules.map((rule) => ({
      guard: rule.guard ? this.emitExpression(rule.guard) : 0,
      assignments: this.emitAssignments(rule.assignments),
      otherwise: rule.otherwise ? this.emitAssignments(rule.otherwise) : 0,
      subjects: rule.subjects ? this.emitIdList(rule.subjects) : 0,
      payload: this.emitTrigger(rule),
    }));

    const sceneInstancesAt = this.emitSceneInstances();
    const scenesAt = this.emitScenes();
    const instancesAt = this.emitInstances();
    const controlsAt = this.emitControls(controlLists);
    const rulesAt = this.emitRules(ruleLists);

    this.out.patch16(HEADER.scenes, scenesAt);
    this.out.patch16(HEADER.sceneInstances, sceneInstancesAt);
    this.out.patch16(HEADER.instances, instancesAt);
    this.out.patch16(HEADER.controls, controlsAt);
    this.out.patch16(HEADER.rules, rulesAt);
    this.out.patch16(HEADER.levels, levelsAt);
    this.out.patch16(HEADER.strings, stringsAt);
    this.out.patch16(HEADER.tiles, tilesAt);
    this.out.patch16(HEADER.tileCount, BUILTIN_TILES);
    this.out.patch16(HEADER.holdSlots, this.holdSlots);
    this.out.patch16(HEADER.end, this.at());

    const bytes = this.out.finish();
    if (bytes.length > DATA_SIZE) {
      throw new TableError(
        "E_GAME_TOO_LARGE",
        `the program tables need ${bytes.length} bytes and the ROM's data window holds ${DATA_SIZE}`,
        "shrink a level, or wait for bank switching (doc 15 §Not in v1)",
      );
    }
    return {
      bytes,
      stats: {
        bytes: bytes.length,
        free: DATA_SIZE - bytes.length,
        scenes: this.program.scenes.length,
        instances: this.program.instances.length,
        controls: this.program.controls.length,
        rules: this.program.rules.length,
        levels: this.levels.length,
        code: this.codeBytes,
        tiles: BUILTIN_TILES,
      },
    };
  }

  private checkLimits(): void {
    const check = (count: number, limit: number, what: string): void => {
      if (count > limit) {
        throw new TableError(
          "E_RUNTIME_LIMIT",
          `this game has ${count} ${what} and the runtime holds ${limit}`,
          `the limit is fixed work RAM, not an arbitrary cap — see LIMITS in rom/tables.ts`,
        );
      }
    };
    check(this.program.instances.length, LIMITS.instances, "objects");
    check(this.program.scenes.length, LIMITS.scenes, "scenes");
    check(this.program.rules.length, LIMITS.rules, "rules");
    check(this.program.controls.length, LIMITS.controls, "control bindings");
  }

  /** Register levels, tile names and strings before any address is assigned. */
  private collect(): void {
    for (const scene of this.program.scenes) {
      if (!scene.level) continue;
      if (!this.levelIndex.has(scene.level)) {
        this.levelIndex.set(scene.level, this.levels.length);
        this.levels.push(scene.level);
        for (const tile of scene.level.tiles) this.tileNameId(tile.name);
      }
    }
    for (const rule of this.program.rules) {
      if (rule.event.kind === "hits") {
        for (const name of rule.event.tiles) this.tileNameId(name);
      }
    }
    for (const instance of this.program.instances) {
      const text = instance.strings["text"];
      if (text !== undefined && !this.strings.includes(text)) this.strings.push(text);
    }
    if (this.levels.length > LIMITS.levels) {
      throw new TableError(
        "E_RUNTIME_LIMIT",
        `this game has ${this.levels.length} levels and the runtime holds ${LIMITS.levels}`,
      );
    }
    if (this.strings.length > LIMITS.strings) {
      throw new TableError(
        "E_RUNTIME_LIMIT",
        `this game has ${this.strings.length} text strings and the runtime holds ${LIMITS.strings}`,
      );
    }
  }

  private tileNameId(name: string): number {
    const existing = this.tileNames.get(name);
    if (existing !== undefined) return existing;
    const id = this.tileNames.size;
    this.tileNames.set(name, id);
    return id;
  }

  private sceneIndex(name: string): number {
    const index = this.program.scenes.findIndex((scene) => scene.name === name);
    return index < 0 ? 0 : index;
  }

  // --- expressions -----------------------------------------------------------

  /**
   * Encode one expression into the pool and return its address.
   *
   * Identical expressions share bytes. That is worth doing not for the kilobyte
   * it saves but because games generated from a template — every alien in a
   * formation carrying the same rule — otherwise pay linearly for a repetition
   * the compiler already knows about.
   */
  private emitExpression(expr: CExpr): number {
    const code = new Writer();
    encodeExpr(expr, code);
    code.u8(OP.END);
    const bytes = code.finish();
    const key = hex(bytes);
    const existing = this.codePool.get(key);
    if (existing !== undefined) return existing;
    const address = this.at();
    this.out.bytes(bytes);
    this.codeBytes += bytes.length;
    this.codePool.set(key, address);
    return address;
  }

  /** A `u8` count followed by instance ids. Zero means "absent", never "empty". */
  private emitIdList(ids: readonly number[]): number {
    const address = this.at();
    this.out.u8(ids.length);
    for (const id of ids) this.out.u8(id);
    return address;
  }

  private emitAssignments(assignments: readonly CAssignment[]): number {
    if (assignments.length === 0) return 0;
    // Values first: an assignment record points at its expression, and the pool
    // has to exist before the record that names it.
    const values = assignments.map((assignment) =>
      assignment.target.kind === "scene" || assignment.value.kind === "flip"
        ? 0
        : this.emitExpression(assignment.value),
    );
    const address = this.at();
    this.out.u8(assignments.length);
    for (const [index, assignment] of assignments.entries()) {
      if (assignment.target.kind === "scene") {
        this.out.u8(ASSIGN_KIND.scene);
        this.out.u8(0);
        this.out.u8(0);
        this.out.u8(
          assignment.value.kind === "scene" ? this.sceneIndex(assignment.value.scene) : 0,
        );
        this.out.u16(0);
        continue;
      }
      const flip = assignment.value.kind === "flip";
      this.out.u8(flip ? ASSIGN_KIND.flip : ASSIGN_KIND.prop);
      this.out.u8(REF[assignment.target.entity.kind]);
      this.out.u8(assignment.target.entity.kind === "instance" ? assignment.target.entity.id : 0);
      this.out.u8(propId(assignment.target.prop));
      this.out.u16(values[index] as number);
    }
    return address;
  }

  // --- triggers --------------------------------------------------------------

  /** Emit whatever a trigger needs beyond its rule record, as its `a`/`b` fields. */
  private emitTrigger(rule: RuleDef): { a: number; b: number } {
    switch (rule.event.kind) {
      case "hits": {
        const address = this.at();
        this.out.u8(rule.event.subjects.length);
        for (const id of rule.event.subjects) this.out.u8(id);
        this.out.u8(rule.event.others.length);
        for (const id of rule.event.others) this.out.u8(id);
        // Edges keep the order the rule wrote them in, not a bit mask: the
        // interpreter tests them in that order, and which one separates first
        // is observable when an object is in a corner.
        this.out.u8(rule.event.edges.length);
        for (const edge of rule.event.edges) this.out.u8(EDGES.indexOf(edge));
        this.out.u8(rule.event.tiles.length);
        for (const name of rule.event.tiles) this.out.u8(this.tileNameId(name));
        return { a: address, b: rule.event.level ? 1 : 0 };
      }
      case "reaches":
        // Left before right, so the pool sees them in evaluation order.
        return {
          a: this.emitExpression(rule.event.left),
          b: this.emitExpression(rule.event.right),
        };
      case "predicate":
        return { a: this.emitExpression(rule.event.test), b: 0 };
      case "input":
        return {
          a: ACTIONS.indexOf(rule.event.action),
          b: rule.event.edge === "pressed" ? 0 : 1,
        };
    }
  }

  // --- tables ----------------------------------------------------------------

  private emitStrings(): number {
    const bodies = this.strings.map((text) => {
      const address = this.at();
      const clipped = [...text].slice(0, 255);
      this.out.u8(clipped.length);
      for (const character of clipped) this.out.u8(glyphTile(character));
      return address;
    });
    this.out.align();
    const table = this.at();
    for (const address of bodies) this.out.u16(address);
    return table;
  }

  private emitLevels(): number {
    const bodies = this.levels.map((level) => {
      const address = this.at();
      this.out.u16(level.width);
      this.out.u8(level.height);
      this.out.u8(level.tiles.length);
      for (const [index, tile] of level.tiles.entries()) {
        this.out.u8(this.tileNameId(tile.name));
        this.out.u8(tile.solid ? TILE_SOLID : 0);
        this.out.u8(patternTile(index, tile.solid));
      }
      // The grid, row by row, one byte per cell: a legend index or "empty".
      // Literal, like the `.dmtl` it came from — the runtime indexes it with
      // `row * width + column` and never has to decode anything.
      for (let row = 0; row < level.height; row += 1) {
        const line = level.rows[row] ?? "";
        for (let column = 0; column < level.width; column += 1) {
          const character = line[column] ?? " ";
          const legend = level.tiles.findIndex((tile) => tile.char === character);
          this.out.u8(legend < 0 ? GRID_EMPTY : legend);
        }
      }
      this.out.align();
      return address;
    });
    const table = this.at();
    for (const address of bodies) this.out.u16(address);
    return table;
  }

  private emitSceneInstances(): number {
    const address = this.at();
    for (const scene of this.program.scenes) {
      for (const id of scene.instanceIds) this.out.u8(id);
    }
    this.out.align();
    return address;
  }

  private emitScenes(): number {
    const address = this.at();
    let first = 0;
    for (const scene of this.program.scenes) {
      this.out.u8(first);
      this.out.u8(scene.instanceIds.length);
      this.out.u16(scene.bounds.width);
      this.out.u8(scene.bounds.height);
      this.out.u8(scene.cameraTarget ?? NONE);
      this.out.u8(scene.level ? (this.levelIndex.get(scene.level) as number) : NONE);
      this.out.u8(0);
      first += scene.instanceIds.length;
    }
    return address;
  }

  private emitInstances(): number {
    const address = this.at();
    for (const instance of this.program.instances) {
      const hasSprite = instance.strings["sprite"] !== undefined;
      const kind =
        instance.className === "number"
          ? INSTANCE_KIND.number
          : instance.className === "text"
            ? INSTANCE_KIND.text
            : hasSprite
              ? INSTANCE_KIND.sprite
              : INSTANCE_KIND.plain;
      const text = instance.strings["text"];
      this.out.u8(this.sceneIndex(instance.scene));
      this.out.u8(kind);
      // Art binding lands here (doc 15 §The conversion path); until then every
      // object draws as the built-in block, which `NONE` selects.
      this.out.u8(NONE);
      this.out.u8(text === undefined ? NONE : this.strings.indexOf(text));
      for (const prop of STORED_PROPS) this.out.i32(instance.numbers[prop] ?? 0);
    }
    return address;
  }

  private emitControls(lists: readonly number[]): number {
    const address = this.at();
    for (const [index, control] of this.program.controls.entries()) {
      this.out.u8(control.instanceId);
      this.out.u8(ACTIONS.indexOf(control.action));
      this.out.u8(CONTROL_MODE[control.mode]);
      this.out.u8(this.holdSlots);
      this.out.u16(lists[index] as number);
      this.out.u16(0);
      this.holdSlots += control.assignments.filter(
        (assignment) => assignment.target.kind === "prop",
      ).length;
    }
    if (this.holdSlots > LIMITS.holdSlots) {
      throw new TableError(
        "E_RUNTIME_LIMIT",
        `this game needs ${this.holdSlots} 'on hold' snapshots and the runtime holds ${LIMITS.holdSlots}`,
      );
    }
    return address;
  }

  private emitRules(
    lists: readonly {
      guard: number;
      assignments: number;
      otherwise: number;
      subjects: number;
      payload: { a: number; b: number };
    }[],
  ): number {
    const address = this.at();
    for (const [index, rule] of this.program.rules.entries()) {
      const list = lists[index] as (typeof lists)[number];
      this.out.u8(RULE_KIND[rule.event.kind]);
      this.out.u8(rule.scene === undefined ? NONE : this.sceneIndex(rule.scene));
      this.out.u16(list.guard);
      this.out.u16(list.assignments);
      this.out.u16(list.otherwise);
      this.out.u16(list.subjects);
      this.out.u16(list.payload.a);
      this.out.u16(list.payload.b);
      this.out.u16(0);
    }
    return address;
  }
}

/** Encode an expression in postfix, operands in evaluation order. */
function encodeExpr(expr: CExpr, out: Writer): void {
  switch (expr.kind) {
    case "const":
      out.u8(OP.CONST);
      out.i32(expr.value);
      return;
    case "read":
      out.u8(OP.READ);
      out.u8(REF[expr.entity.kind]);
      out.u8(expr.entity.kind === "instance" ? expr.entity.id : 0);
      out.u8(propId(expr.prop));
      return;
    case "camera":
      out.u8(OP.CAMERA);
      out.u8(expr.axis === "x" ? 0 : 1);
      return;
    case "neg":
      encodeExpr(expr.operand, out);
      out.u8(OP.NEG);
      return;
    case "binary":
      encodeExpr(expr.left, out);
      encodeExpr(expr.right, out);
      out.u8(BINARY_OPS[expr.op] as number);
      return;
    case "call":
      for (const arg of expr.args) encodeExpr(arg, out);
      out.u8(BUILTIN_OPS[expr.fn] as number);
      return;
    // `flip` and `scene` are assignment *kinds*, not values; the simulator
    // evaluates them to zero anywhere else, and so does the runtime.
    case "flip":
    case "scene":
      out.u8(OP.CONST);
      out.i32(0);
      return;
  }
}

function hex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}
