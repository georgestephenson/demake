/**
 * The program-table binary format — the hand-off from the compiler to a console
 * runtime.
 *
 * Doc 14 §2 is the decision this file implements: **compile to data, not to
 * assembly**. A runtime is one fixed engine per CPU family that consumes these
 * tables, so a new language feature is a new opcode in each runtime rather than
 * a new code path in each code generator — N + M work instead of N × M.
 *
 * Everything here is a plain byte layout with no platform dependency. The
 * emitter ({@link module:rom/tables}) turns a {@link Program} into one blob; the
 * SM83 runtime in `runtime-harness/gb/main.asm` reads exactly these offsets.
 * The two are a contract, so the constants live in one place and both sides
 * cite it: change a field here and the runtime's matching `DEF` changes in the
 * same commit.
 *
 * ## Why absolute addresses
 *
 * Offsets inside the blob are stored as absolute Game Boy addresses, not as
 * deltas from the blob's start. The blob is patched into a fixed ROM window
 * ({@link DATA_BASE}), so an absolute address is a pointer the runtime can load
 * straight into `hl` — no base-relative arithmetic in the hot path of a machine
 * with no index registers. The emitter takes the base as a parameter so the
 * choice is stated rather than baked in.
 *
 * ## Why fixed-width records
 *
 * Every table is an array of same-size records. Indexing is then a shift-and-add
 * instead of a walk, which matters because the collision pass touches instance
 * records O(rules × subjects × others) times per tick.
 */

/** Magic at the head of every blob: "DMT1". */
export const MAGIC = [0x44, 0x4d, 0x54, 0x31] as const;

/** Format version. Bumped whenever a record layout changes. */
export const FORMAT_VERSION = 1;

/**
 * Where the blob is patched into a `gb` ROM.
 *
 * The bottom 16 KiB holds the runtime; the top 16 KiB is the game. A 32 KiB
 * cartridge needs no mapper, so nothing in the runtime has to know about banks
 * until a game outgrows this — at which point the limit is a diagnostic, not a
 * silent truncation (see `E_GAME_TOO_LARGE`).
 */
export const DATA_BASE = 0x4000;

/** Bytes available to the tables. */
export const DATA_SIZE = 0x4000;

// --- properties --------------------------------------------------------------

/**
 * The nine stored numeric properties, in slot order.
 *
 * This *is* the entity record: nine 16.16 values, and nothing else varies per
 * object. Keeping the order fixed lets the runtime address a property with
 * `entity + prop * 4` and lets a trace dump be a straight memory copy.
 */
export const STORED_PROPS = [
  "x",
  "y",
  "width",
  "height",
  "speed",
  "xdirection",
  "ydirection",
  "visible",
  "value",
] as const;

/** One stored property name. */
export type StoredProp = (typeof STORED_PROPS)[number];

/** Bytes per stored property. */
export const PROP_SIZE = 4;

/** Stored properties per entity. */
export const PROP_COUNT = STORED_PROPS.length;

/**
 * Derived properties, numbered after the stored ones.
 *
 * They are computed on read and rejected on write by the compiler, so the
 * runtime needs a read path only — which is why they can live in the same
 * numbering rather than in a separate namespace.
 */
export const DERIVED_PROPS = ["centerx", "centery", "left", "right", "top", "bottom"] as const;

/** Every readable property, stored first. */
export const PROP_IDS: Readonly<Record<string, number>> = Object.fromEntries(
  [...STORED_PROPS, ...DERIVED_PROPS].map((name, index) => [name, index]),
);

/** Resolve a property name to its runtime id. */
export function propId(name: string): number {
  const id = PROP_IDS[name];
  if (id === undefined) throw new Error(`no runtime id for property '${name}'`);
  return id;
}

// --- expression bytecode -----------------------------------------------------

/**
 * The expression VM's instruction set — a postfix stack machine.
 *
 * Postfix, not a tree walk, because the runtime has no recursion budget worth
 * spending: a linear pass over bytes with an explicit 16-deep stack in RAM is
 * both smaller and bounded. Operand order is preserved exactly as
 * {@link module:sim} evaluates it (left before right, arguments left to right),
 * which matters for `random`: drawing advances the generator, so *when* a draw
 * happens is part of the game's behaviour.
 */
export const OP = {
  END: 0x00,
  /** `<i32 le>` — push a folded constant. */
  CONST: 0x01,
  /** `<refkind> <entity> <prop>` — push a property of an entity. */
  READ: 0x02,
  /** `<axis>` — push `camera.x` or `camera.y`. */
  CAMERA: 0x03,
  NEG: 0x04,
  ADD: 0x05,
  SUB: 0x06,
  MUL: 0x07,
  DIV: 0x08,
  LT: 0x09,
  GT: 0x0a,
  LE: 0x0b,
  GE: 0x0c,
  EQ: 0x0d,
  NE: 0x0e,
  ABS: 0x0f,
  MIN: 0x10,
  MAX: 0x11,
  CLAMP: 0x12,
  RANDOM: 0x13,
} as const;

/** Binary operator → opcode. Mirrors `applyBinary` one for one. */
export const BINARY_OPS: Readonly<Record<string, number>> = {
  "+": OP.ADD,
  "-": OP.SUB,
  "*": OP.MUL,
  "/": OP.DIV,
  "<": OP.LT,
  ">": OP.GT,
  "<=": OP.LE,
  ">=": OP.GE,
  "=": OP.EQ,
  "!=": OP.NE,
};

/** Builtin → opcode. Mirrors `applyBuiltin`, plus `random` from `rng.ts`. */
export const BUILTIN_OPS: Readonly<Record<string, number>> = {
  abs: OP.ABS,
  min: OP.MIN,
  max: OP.MAX,
  clamp: OP.CLAMP,
  random: OP.RANDOM,
};

/** How an {@link EntityRef} is encoded in `READ` and in assignment records. */
export const REF = { instance: 0, subject: 1, other: 2 } as const;

// --- record layouts ----------------------------------------------------------

/** Header field offsets, from the start of the blob. */
export const HEADER = {
  magic: 0,
  version: 4,
  fps: 5,
  screenWidth: 6,
  screenHeight: 7,
  seed: 8,
  entryScene: 12,
  sceneCount: 13,
  instanceCount: 14,
  controlCount: 15,
  ruleCount: 16,
  levelCount: 17,
  stringCount: 18,
  flags: 19,
  scenes: 20,
  sceneInstances: 22,
  instances: 24,
  controls: 26,
  rules: 28,
  levels: 30,
  strings: 32,
  tiles: 34,
  tileCount: 36,
  holdSlots: 38,
  end: 40,
  size: 44,
} as const;

/** Scene record: 8 bytes. */
export const SCENE = {
  firstInstance: 0,
  instanceCount: 1,
  boundsWidth: 2,
  boundsHeight: 4,
  cameraTarget: 5,
  level: 6,
  size: 8,
} as const;

/** Instance record: a 4-byte head then the nine stored properties. */
export const INSTANCE = {
  scene: 0,
  kind: 1,
  tile: 2,
  text: 3,
  values: 4,
  size: 4 + PROP_COUNT * PROP_SIZE,
} as const;

/** How an instance draws itself. */
export const INSTANCE_KIND = { plain: 0, sprite: 1, number: 2, text: 3 } as const;

/** Control record: 8 bytes. */
export const CONTROL = {
  instance: 0,
  action: 1,
  mode: 2,
  holdBase: 3,
  assignments: 4,
  size: 8,
} as const;

/** `control … on <mode>`. */
export const CONTROL_MODE = { hold: 0, press: 1, release: 2 } as const;

/** Rule record: 16 bytes. `a`/`b`/`c` are kind-specific (see {@link RULE_KIND}). */
export const RULE = {
  kind: 0,
  scene: 1,
  guard: 2,
  assignments: 4,
  otherwise: 6,
  subjects: 8,
  a: 10,
  b: 12,
  c: 14,
  size: 16,
} as const;

/**
 * Trigger kinds and what their `a`/`b` fields hold.
 *
 * - `hits`  — `a` = address of the collision payload, `b` = 1 for `touches`
 * - `input` — `a` = action id, `b` = 0 for `pressed`, 1 for `released`
 * - `reaches` — `a` = left expression address, `b` = right expression address
 * - `predicate` — `a` = test expression address
 */
export const RULE_KIND = { hits: 0, input: 1, reaches: 2, predicate: 3 } as const;

/** Assignment record: 6 bytes, packed back to back after a `u8` count. */
export const ASSIGN = {
  kind: 0,
  ref: 1,
  entity: 2,
  prop: 3,
  value: 4,
  size: 6,
} as const;

/**
 * What an assignment writes.
 *
 * `flip` is a *kind* rather than an expression because it negates the target's
 * current value, which the expression VM cannot see: by the time a value is on
 * the stack the target is no longer identified. Making it a kind keeps the VM
 * free of a back-channel.
 */
export const ASSIGN_KIND = { prop: 0, scene: 1, flip: 2 } as const;

/**
 * Screen edges in a `hits` payload, in {@link EDGES} order.
 *
 * The payload carries a *list*, not a mask, because the interpreter tests a
 * rule's edges in the order the rule named them and separates against each in
 * turn — which one wins is observable for an object in a corner.
 */
export const EDGE_IDS = {
  screenleft: 0,
  screenright: 1,
  screentop: 2,
  screenbottom: 3,
} as const;

/** Level record: a 4-byte head, then the legend, then the grid. */
export const LEVEL = {
  width: 0,
  height: 2,
  legendCount: 3,
  legend: 4,
  /** Legend entry: name id, flags, background tile. */
  legendSize: 3,
} as const;

/** Legend flag bits. */
export const TILE_SOLID = 1;

/** The empty cell in an emitted grid. */
export const GRID_EMPTY = 0xff;

/** "No index" in any `u8` slot that can be absent. */
export const NONE = 0xff;

/**
 * Where the runtime keeps its live state, in work RAM.
 *
 * These are fixed addresses in `runtime-harness/gb/main.asm` on purpose: the
 * conformance harness reads the entity table straight out of memory, so a
 * trace costs the runtime nothing at all (doc 14 §Conformance). A serial
 * protocol would have made the ROM under test different from the ROM shipped.
 */
export const RAM = {
  /** OAM shadow, DMA-aligned. */
  oam: 0xc000,
  /** Entity records, `instanceId * ENTITY_SIZE` apart, in stored-property order. */
  entities: 0xc0a0,
  /** Ticks completed, `u16`. */
  tick: 0xc9a0,
  /** Running scene index. */
  scene: 0xc9a2,
  /** Pending scene change, or {@link NONE}. */
  pending: 0xc9a3,
  /** The game's generator state, `u32`. */
  rng: 0xc9a4,
  /** Buttons held, in {@link ACTIONS} bit order. */
  held: 0xc9a8,
  /** Bumped once per completed tick — the harness's handshake. */
  ready: 0xc9ab,
  /** Set once initialisation is done and the loop is reading input. */
  booted: 0xc9ac,
} as const;

/** Bytes per live entity record. */
export const ENTITY_SIZE = PROP_COUNT * PROP_SIZE;
