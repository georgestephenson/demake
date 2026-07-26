/**
 * Compile-time RAM allocation.
 *
 * This is where the backend earns most of its speed, and it is worth being
 * explicit about why. A game's objects are known when it is compiled, so every
 * entity gets a *fixed address*, and therefore every property read is an
 * absolute load rather than a base-plus-index computation. The old interpreter
 * spent about a quarter of every tick turning an entity id into a pointer and
 * copying four bytes out of it; that work does not exist here.
 *
 * The allocator is a bump pointer with no free list, because nothing is ever
 * freed: a game's state is exactly as large as the game. A program that does
 * not use the camera has no camera variables; one that never divides has no
 * remainder; one with no `hold` bindings has no snapshots.
 *
 * The entity record keeps the interpreter's nine-property, 36-byte shape. That
 * is not laziness — it is what lets the conformance harness read a trace
 * straight out of work RAM (doc 14 §Conformance), and the alternative saves
 * bytes only for objects that would still need somewhere to put them.
 */

import type { Program } from "../program.js";

import type { Analysis } from "./analyze.js";

/** Stored properties, in record order. Index × 4 is the byte offset. */
export const PROPS = [
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
export type Prop = (typeof PROPS)[number];

/** Bytes per stored property. */
export const PROP_SIZE = 4;

/** Bytes per entity record. */
export const ENTITY_SIZE = PROPS.length * PROP_SIZE;

/**
 * Bytes of an entity record that make up its collision box.
 *
 * `x`, `y`, `width`, `height` are the first four slots by construction, so a box
 * is a contiguous run and staging one is a single block copy. The order in
 * {@link PROPS} is therefore load-bearing, not alphabetical.
 */
export const BOX_SIZE = 4 * PROP_SIZE;

/** Derived properties, computed on read. */
export const DERIVED = ["centerx", "centery", "left", "right", "top", "bottom"] as const;

/** Property name → record slot, for the stored nine. */
export const PROP_SLOT: Readonly<Record<string, number>> = Object.fromEntries(
  PROPS.map((name, index) => [name, index]),
);

/** Where the OAM shadow lives. The DMA source must be page-aligned. */
export const OAM_SHADOW = 0xc000;

/** First byte the allocator may hand out. */
const HEAP_START = 0xc0a0;

/** Last byte of work RAM, minus the stack we reserve at the top. */
const HEAP_END = 0xdf00;

/** Visible tilemap window, in cells. */
export const VIEW_W = 20;
export const VIEW_H = 18;

/** Most background cells the renderer will queue in one VBlank. */
export const QUEUE_MAX = 192;

/** Most background cells `number` and `text` objects may occupy at once. */
export const PLOT_MAX = 96;

/** Raised when a game needs more state than the machine has. */
export class LayoutError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "LayoutError";
  }
}

/** A `hits` rule's contact slots, numbered at compile time. */
export interface ContactRange {
  /** First bit index this rule owns. */
  base: number;
  /** Bits per subject — one per edge plus one per other object. */
  stride: number;
}

/** Where everything lives. */
export interface Layout {
  /** Base address of each instance's record, by instance id. */
  entities: readonly number[];
  /** Bytes of work RAM in use. */
  used: number;

  // --- always present -------------------------------------------------------
  tick: number;
  scene: number;
  pending: number;
  ready: number;
  booted: number;
  held: number;
  pressed: number;
  released: number;
  /** Non-zero when the whole background must be rebuilt before the next frame. */
  redraw: number;
  /** Scratch the emitters use for pointers and counters. */
  scratch: number;
  /** The multiply/divide helpers' operands and workspace. */
  mathA: number;
  mathB: number;
  mathWork: number;

  // --- expression machinery -------------------------------------------------
  /** Four-byte temporaries, `analysis.maxDepth` of them. */
  temps: readonly number[];
  /** Four-byte staging slots for a rule's simultaneous writes. */
  staging: readonly number[];

  // --- conditional ----------------------------------------------------------
  /** The generator's state; absent when nothing draws from it. */
  rng: number | null;
  /** Camera position in 16.16 cells; absent when no scene follows anything. */
  camera: number | null;
  /** Level cell coordinates currently at the tilemap's origin. */
  mapOrigin: number | null;
  /** Pointer to the entity a looped rule is bound to. */
  self: number | null;
  /** Pointer to the entity it collided with. */
  other: number | null;
  /**
   * The effect a rule asked for this tick, or `$FF`; absent without sounds.
   *
   * Separate from the byte the driver reads, and deliberately so: the driver
   * *consumes* its request, and a trace has to be able to read what the game
   * asked for after the interrupt has already acted on it.
   */
  sound: number | null;

  // --- bookkeeping ----------------------------------------------------------
  /** Contact bitfields: this tick's, then last tick's. */
  contacts: number;
  contactsPrev: number;
  contactBytes: number;
  /** Per-rule contact numbering. */
  contactRanges: ReadonlyMap<number, ContactRange>;
  /** `on hold` snapshots: four bytes then a validity byte, per binding slot. */
  holdValues: number;
  holdFlags: number;
  /** `reaches` history: four bytes then a validity byte, per rule that needs it. */
  reachValues: number;
  reachFlags: number;
  /** Which reach slot each rule owns. */
  reachSlots: ReadonlyMap<number, number>;
  /** Tile contact lists: a count byte then cell ids, per (rule, subject) pair. */
  tileContacts: number;
  tileContactStride: number;
  tileContactSlots: ReadonlyMap<string, number>;
  /** Where this tick's tile contacts are built before replacing the stored list. */
  tileScratch: number;
  /** The tile walker's cursor into the grid, kept out of the register file
   * because the rule bodies it runs use every register there is. */
  tilePtr: number;
  /**
   * The cells one object overlaps, walked once and read by every tile rule.
   *
   * A count byte then `column`, `row`, `legend` per cell. An object standing
   * still overlaps the same handful of cells every tick, and a game with four
   * tile rules and a separation pass used to walk the grid for all five —
   * multiply, bounds-check and all — to reach the same answer each time. The
   * list is only used where no tile rule can move its subject, so that "the same
   * answer" is a compile-time fact rather than a hope.
   */
  tileCells: number;
  tileCellStride: number;
  tileCellSlots: ReadonlyMap<number, number>;
  /**
   * Staging for the two boxes of an object-versus-object contact, and the
   * workspace the shared overlap and separation routines use.
   *
   * `x`, `y`, `width` and `height` are the first four slots of an entity record,
   * so a box is one sixteen-byte copy. That is what lets the arithmetic be a
   * *routine* rather than a copy of itself per pair — and with a bullet against
   * nine aliens costing twenty-seven pairs, the difference is the whole
   * cartridge. Absent unless some rule can put two objects in contact.
   */
  pairA: number | null;
  pairB: number | null;
  pairWork: number | null;
  /**
   * Two bytes the cheap "is it anywhere near" tests keep an entity pointer in.
   *
   * Both of them — the OAM cull and the collision pre-test — need the base
   * address across arithmetic that wants every register, and both run often
   * enough that a stack round trip is worth avoiding.
   */
  cull: number;

  // --- rendering ------------------------------------------------------------
  /** Pending VRAM writes: address low, address high, tile. */
  queue: number;
  queueCount: number;
  /** Cells the HUD occupied last frame and this one, as 16-bit indices. */
  plot: number;
  plotPrev: number;
  plotCount: number;
  plotPrevCount: number;
  /** OAM entries used this frame, and last frame. */
  oamCount: number;
  oamPrev: number;
  /**
   * Sixteen 16-bit scratch words the renderer and the tile walker index by
   * name. Cheaper than a field each, and they are all short-lived.
   */
  words: number;
}

/** Named slots in `Layout.words`, two bytes apart. */
export const W = {
  tileCol: 0,
  tileRow: 1,
  firstCol: 2,
  lastCol: 3,
  firstRow: 4,
  lastRow: 5,
  cell: 6,
  scrollX: 7,
  scrollY: 8,
  mapCol: 9,
  mapRow: 10,
  target: 11,
  count: 12,
  camX: 13,
  camY: 14,
  temp: 15,
} as const;

/** Most cells an object can overlap, which bounds a tile contact list. */
export const TILE_CONTACT_MAX = 16;

class Bump {
  private at = HEAP_START;

  take(bytes: number): number {
    const address = this.at;
    this.at += bytes;
    if (this.at > HEAP_END) {
      throw new LayoutError(
        "E_GAME_TOO_LARGE",
        `this game needs ${this.at - HEAP_START} bytes of work RAM and the Game Boy has ` +
          `${HEAP_END - HEAP_START}`,
        "fewer objects, or a smaller level; the limit is the machine's, not a policy.",
      );
    }
    return address;
  }

  get used(): number {
    return this.at - HEAP_START;
  }
}

/**
 * Number every contact a `hits` rule can make.
 *
 * The interpreter keeps a set of `(rule, subject, target)` keys and scans it;
 * here every possible key is a *bit index known at compile time*, so testing
 * one is a `bit n, [hl]` against a constant address. That is the difference
 * between a linear scan per contact per tick and three cycles.
 */
function numberContacts(program: Program): { ranges: Map<number, ContactRange>; total: number } {
  const ranges = new Map<number, ContactRange>();
  let total = 0;
  for (const rule of program.rules) {
    if (rule.event.kind !== "hits") continue;
    const stride = rule.event.edges.length + rule.event.others.length;
    if (stride === 0 || rule.event.subjects.length === 0) continue;
    ranges.set(rule.id, { base: total, stride });
    total += stride * rule.event.subjects.length;
  }
  return { ranges, total };
}

/** Allocate every byte the program needs. */
export function planLayout(program: Program, analysis: Analysis): Layout {
  const heap = new Bump();

  const entities: number[] = [];
  for (let id = 0; id < program.instances.length; id += 1) {
    entities.push(heap.take(ENTITY_SIZE));
  }

  const tick = heap.take(2);
  const scene = heap.take(1);
  const pending = heap.take(1);
  const ready = heap.take(1);
  const booted = heap.take(1);
  const held = heap.take(1);
  const pressed = heap.take(1);
  const released = heap.take(1);
  const redraw = heap.take(1);
  const scratch = heap.take(8);
  const mathA = heap.take(PROP_SIZE);
  const mathB = heap.take(PROP_SIZE);
  // Seven bytes of product plus five of remainder: the multiply's accumulator
  // has to hold 2^52 exactly, which is what the clamped operand range implies.
  const mathWork = heap.take(24);

  const temps: number[] = [];
  // Six beyond the deepest expression: the collision and camera emitters
  // borrow temporaries for their own intermediate boxes.
  for (let index = 0; index < analysis.maxDepth + 6; index += 1) temps.push(heap.take(PROP_SIZE));
  const staging: number[] = [];
  for (let index = 0; index < Math.max(1, analysis.maxAssignments); index += 1) {
    staging.push(heap.take(PROP_SIZE));
  }

  const sound = program.sounds.length > 0 ? heap.take(1) : null;
  const rng = analysis.usesRandom ? heap.take(4) : null;
  const camera = analysis.usesCamera || analysis.readsCamera ? heap.take(8) : null;
  const mapOrigin = analysis.usesLevels ? heap.take(4) : null;
  const self = heap.take(2);
  const other = heap.take(2);

  const { ranges, total } = numberContacts(program);
  const contactBytes = Math.max(1, Math.ceil(total / 8));
  const contacts = heap.take(contactBytes);
  const contactsPrev = heap.take(contactBytes);

  const holdCount = Math.max(1, analysis.holdSlots);
  const holdValues = heap.take(holdCount * PROP_SIZE);
  const holdFlags = heap.take(holdCount);

  const reachSlots = new Map<number, number>();
  for (const rule of program.rules) {
    if (rule.event.kind === "reaches") reachSlots.set(rule.id, reachSlots.size);
  }
  const reachCount = Math.max(1, reachSlots.size);
  const reachValues = heap.take(reachCount * PROP_SIZE);
  const reachFlags = heap.take(reachCount);

  // One list per (tile rule, subject) pair, and only where tiles are used.
  const tileContactSlots = new Map<string, number>();
  if (analysis.usesTiles) {
    for (const rule of program.rules) {
      if (rule.event.kind !== "hits" || rule.event.tiles.length === 0) continue;
      for (const subject of rule.event.subjects) {
        tileContactSlots.set(`${rule.id}:${subject}`, tileContactSlots.size);
      }
    }
  }
  const tileContactStride = 1 + TILE_CONTACT_MAX * 2;
  const tileContacts = analysis.usesTiles
    ? heap.take(Math.max(1, tileContactSlots.size) * tileContactStride)
    : 0;
  // This tick's list is built here and copied over the stored one at the end
  // of the pair, so the comparison is never against a half-overwritten list.
  const tileScratch = analysis.usesTiles ? heap.take(tileContactStride) : 0;
  const tilePtr = analysis.usesLevels ? heap.take(2) : 0;

  // One cell list per object any tile rule names as a subject.
  const tileCellSlots = new Map<number, number>();
  if (analysis.usesTiles) {
    for (const rule of program.rules) {
      if (rule.event.kind !== "hits" || rule.event.tiles.length === 0) continue;
      for (const subject of rule.event.subjects) {
        if (!tileCellSlots.has(subject)) tileCellSlots.set(subject, tileCellSlots.size);
      }
    }
  }
  const tileCellStride = 1 + TILE_CONTACT_MAX * 5;
  const tileCells = analysis.usesTiles
    ? heap.take(Math.max(1, tileCellSlots.size) * tileCellStride)
    : 0;

  // Only games where two objects can meet pay for the pair staging.
  const usesPairs = program.rules.some(
    (rule) => rule.event.kind === "hits" && rule.event.others.length > 0,
  );
  const pairA = usesPairs ? heap.take(BOX_SIZE) : null;
  const pairB = usesPairs ? heap.take(BOX_SIZE) : null;
  const pairWork = usesPairs ? heap.take(4 * PROP_SIZE) : null;
  const cull = heap.take(2);

  const queue = heap.take(QUEUE_MAX * 3);
  const queueCount = heap.take(1);
  const plot = heap.take(PLOT_MAX * 2);
  const plotPrev = heap.take(PLOT_MAX * 2);
  const plotCount = heap.take(1);
  const plotPrevCount = heap.take(1);
  const oamCount = heap.take(1);
  const oamPrev = heap.take(1);
  const words = heap.take(16 * 2);

  return {
    entities,
    used: heap.used,
    tick,
    scene,
    pending,
    ready,
    booted,
    held,
    pressed,
    released,
    redraw,
    scratch,
    mathA,
    mathB,
    mathWork,
    temps,
    staging,
    sound,
    rng,
    camera,
    mapOrigin,
    self,
    other,
    contacts,
    contactsPrev,
    contactBytes,
    contactRanges: ranges,
    holdValues,
    holdFlags,
    reachValues,
    reachFlags,
    reachSlots,
    tileContacts,
    tileContactStride,
    tileContactSlots,
    tileScratch,
    tilePtr,
    tileCells,
    tileCellStride,
    tileCellSlots,
    pairA,
    pairB,
    pairWork,
    cull,
    queue,
    queueCount,
    plot,
    plotPrev,
    plotCount,
    plotPrevCount,
    oamCount,
    oamPrev,
    words,
  };
}

/** Address of a stored property of a known instance. */
export function propAddress(layout: Layout, entityId: number, prop: string): number {
  const slot = PROP_SLOT[prop];
  if (slot === undefined) throw new LayoutError("E_INTERNAL", `'${prop}' is not a stored property`);
  const base = layout.entities[entityId];
  if (base === undefined) throw new LayoutError("E_INTERNAL", `no entity ${entityId}`);
  return base + slot * PROP_SIZE;
}
