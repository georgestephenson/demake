/**
 * Compile-time RAM allocation, for every console the backends target.
 *
 * This is where a backend earns most of its speed, and it is worth being
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
 *
 * **One allocator, one plan per machine.** What a game needs is a property of the
 * game; where it goes is a property of the console, and the difference between
 * them is exactly a {@link MemoryPlan}. That is not a convenience: the two
 * machines differ by a factor of six in how much RAM they have — a Game Boy has
 * 8 KiB of work RAM and an NROM cartridge has the console's 2 KiB and nothing
 * else — so *which* things fit is a per-console fact while *what* they are is
 * not. Sharing the allocator is what keeps the trace reader (`rom/trace.ts`)
 * able to read either machine's entity table with one function.
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

/**
 * Where a console's state goes, and how much of it there is.
 *
 * Everything here is a hardware fact rather than a policy, and the two that look
 * like policies are not:
 *
 *   - `queueMax` is what fits in a VBlank. A Game Boy's is 1140 machine cycles
 *     wide and an NES's is about 2270 CPU cycles, of which an object DMA takes
 *     513 — and the per-cell cost differs too, because one writes a byte into
 *     memory-mapped VRAM and the other writes an address and a byte through two
 *     registers. Anything over the cap spills to the next frame rather than
 *     being written outside the window, which would tear.
 *   - `fast` is the region the machine addresses more cheaply, when it has one.
 *     On the 6502 that is page zero: two bytes and three cycles instead of three
 *     and four, and — the part that is not an optimisation — the only place a
 *     pointer can live at all, because `($nn),y` is the CPU's one indirect mode.
 *     A machine without such a region leaves it unset and everything comes from
 *     the one heap, in the same order, at the same addresses.
 */
export interface MemoryPlan {
  /** What to call the machine when it runs out of room. */
  machine: string;
  /** First and last byte of the general heap. */
  heapStart: number;
  heapEnd: number;
  /** The cheaply-addressed region, if the machine has one. */
  fastStart?: number;
  fastEnd?: number;
  /** Where the object shadow lives; the DMA source must be page-aligned. */
  oamShadow: number;
  /** Hardware object entries the shadow covers. */
  oamEntries: number;
  /** Visible tilemap window, in cells. */
  viewW: number;
  viewH: number;
  /** Cells the renderer will queue for one vertical blank. */
  queueMax: number;
  /** Background cells `number` and `text` objects may occupy at once. */
  plotMax: number;
  /**
   * Whether a queued cell carries an attribute byte alongside its tile.
   *
   * True only where the hardware attributes a cell at a time: a Game Boy Color
   * has a palette per 8×8 cell in its second VRAM bank, so the queue carries it.
   * The NES attributes a 16×16 block through a packed table that a scene uploads
   * whole, so a queued cell there is a tile and nothing else — which is why this
   * is a plan field and not a colour flag.
   */
  cellAttributes: boolean;
}

/**
 * The Game Boy's plan: 8 KiB of work RAM, and room to be generous with it.
 *
 * The heap starts past the object shadow's page because the DMA source has to be
 * page-aligned, and stops short of `$DFFF` to leave the stack the top of RAM.
 */
export const GB_MEMORY: MemoryPlan = {
  machine: "Game Boy",
  heapStart: 0xc0a0,
  heapEnd: 0xdf00,
  oamShadow: 0xc000,
  oamEntries: 40,
  viewW: 20,
  viewH: 18,
  queueMax: 192,
  plotMax: 96,
  cellAttributes: false,
};

/** The same, for a Game Boy Color: an attribute byte per queued cell. */
export const GBC_MEMORY: MemoryPlan = { ...GB_MEMORY, cellAttributes: true };

/**
 * The NES's plan, and every number in it is smaller for a reason.
 *
 * The console has 2 KiB of RAM and an NROM cartridge adds none, so the same games
 * that use a fifth of a Game Boy's work RAM use most of this. Three fixed
 * reservations come out of it first: page zero, which the 6502 addresses in two
 * bytes and is the only place a pointer can live; the stack, which the hardware
 * puts at `$0100` and nowhere else; and the object shadow, which has to be a
 * whole aligned page because that is what `$4014` transfers. What is left —
 * `$0300`–`$07FF` — is the heap.
 *
 * `queueMax` is larger than the Game Boy's per byte of VBlank and much smaller in
 * absolute terms: an NES VBlank is about 2270 CPU cycles, an object DMA eats 513
 * of them, and a queued cell costs more here because the address goes out through
 * a register rather than being the store's own operand.
 *
 * The cheap region starts at `$0010` rather than `$0000` because the backend keeps
 * a handful of named pointers of its own below it (`codegen/nes/zp.ts`): a routine
 * that walks a table needs a pointer at a *fixed* address, not one the allocator
 * chose, and sixteen bytes is what the routines between them use.
 */
export const NES_MEMORY: MemoryPlan = {
  machine: "NES",
  heapStart: 0x0300,
  heapEnd: 0x0800,
  fastStart: 0x0010,
  fastEnd: 0x0100,
  oamShadow: 0x0200,
  oamEntries: 64,
  viewW: 32,
  viewH: 30,
  queueMax: 48,
  // Sixteen rather than the Game Boy's ninety-six, and it is not a quarter of the
  // budget: the list holds the cells a *dynamic* HUD occupies — a counter's digits —
  // and not its captions, which are painted once with the background they sit on.
  // Two counters of five digits is ten.
  plotMax: 16,
  cellAttributes: false,
};

/**
 * The Master System's plan, which is the roomy one again.
 *
 * Eight kilobytes of work RAM, like the Game Boy's, and the same freedom with
 * it. Three things about the range are the hardware's rather than a choice:
 *
 *   - It starts at `$C000` and is mirrored at `$E000`, so an address above
 *     `$E000` is the same byte seen twice and there is nothing to gain from it.
 *   - The **mapper's four control registers are decoded out of the mirror**, at
 *     `$FFFC`–`$FFFF` — which is `$DFFC`–`$DFFF` in real RAM. A game that stored
 *     state there would page a ROM bank out from under itself, so the heap stops
 *     short of them and the stack sits below.
 *   - There is **no cheaply-addressed region**, because this CPU does not have
 *     one. The 6502's page zero and the Game Boy's high RAM both make some
 *     addresses shorter to reach; the Z80 makes every address the same width and
 *     puts its cheapness in the register file instead. So no `fastStart`, and the
 *     allocator hands everything out of one pool.
 *
 * The object shadow is a plain RAM copy of the sprite attribute table, uploaded
 * through the data port in the blanking window. There is no DMA on this machine
 * to align it for — unlike both other consoles — but keeping it at the bottom of
 * the heap costs nothing and keeps one upload contiguous.
 */
export const SMS_MEMORY: MemoryPlan = {
  machine: "Master System",
  heapStart: 0xc100,
  heapEnd: 0xdf00,
  oamShadow: 0xc000,
  oamEntries: 64,
  viewW: 32,
  viewH: 24,
  // A blanking interval here is about 2900 CPU cycles and a queued cell is two
  // bytes through one port, so the budget is between the Game Boy's and the
  // NES's — and the *cells* are twice as expensive, because a name-table entry
  // is two bytes rather than one.
  queueMax: 96,
  plotMax: 48,
  // A name-table entry carries its palette-select and flip bits in a second
  // byte, so a queued cell is a tile *and* an attribute — the same shape as the
  // Game Boy Color's, reached by different hardware.
  cellAttributes: true,
};

/**
 * The same, for a Game Gear: a 160×144 window on the identical VDP.
 *
 * The chip renders the whole 256×192 frame either way and the LCD shows the
 * middle of it, so what changes is how much of the name table a game may treat
 * as visible — twenty by eighteen cells rather than thirty-two by twenty-four.
 * Nothing about the memory map differs, because nothing about the memory map is
 * different.
 */
export const GG_MEMORY: MemoryPlan = {
  ...SMS_MEMORY,
  machine: "Game Gear",
  viewW: 20,
  viewH: 18,
};

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
  /** The machine this plan was made for. */
  memory: MemoryPlan;
  /** Base address of each instance's record, by instance id. */
  entities: readonly number[];
  /** Bytes of work RAM in use. */
  used: number;
  /** Bytes of the cheaply-addressed region in use; zero where there is none. */
  fastUsed: number;

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
  /** Pending VRAM writes: address low, address high, tile, and — on the Game
   * Boy Color, where every background cell also carries a palette — its
   * attribute byte. */
  queue: number;
  queueStride: number;
  queueCount: number;
  /**
   * The attribute byte that belongs with the tile a cell routine just produced.
   *
   * Zero on a monochrome build, which has no attributes at all. It is a byte of
   * RAM rather than a register because the routines that produce a tile already
   * use every register there is, and the queue reads it one call later.
   */
  attr: number;
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
  private at: number;

  constructor(
    private readonly start: number,
    private readonly end: number,
    private readonly machine: string,
    private readonly what: string,
  ) {
    this.at = start;
  }

  take(bytes: number): number {
    const address = this.at;
    this.at += bytes;
    if (this.at > this.end) {
      throw new LayoutError(
        "E_GAME_TOO_LARGE",
        `this game needs ${this.at - this.start} bytes of ${this.what} and the ` +
          `${this.machine} has ${this.end - this.start}`,
        "fewer objects, or a smaller level; the limit is the machine's, not a policy.",
      );
    }
    return address;
  }

  get used(): number {
    return this.at - this.start;
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

/**
 * Allocate every byte the program needs.
 *
 * The order of the calls below is the order of the addresses, so it is part of
 * what a golden trace pins: reordering two of them moves every entity record and
 * re-baselines every checked-in trace for no gain. `fast` hands out the machine's
 * cheap region where it has one and falls through to the same heap in the same
 * order where it does not, which is why adding it changed no Game Boy address.
 */
export function planLayout(program: Program, analysis: Analysis, memory: MemoryPlan): Layout {
  const heap = new Bump(memory.heapStart, memory.heapEnd, memory.machine, "work RAM");
  const quick =
    memory.fastStart !== undefined && memory.fastEnd !== undefined
      ? new Bump(memory.fastStart, memory.fastEnd, memory.machine, "page zero")
      : undefined;
  /** Take from the cheap region if the machine has one, the heap otherwise. */
  const fast = (bytes: number): number => (quick ?? heap).take(bytes);

  const entities: number[] = [];
  for (let id = 0; id < program.instances.length; id += 1) {
    entities.push(heap.take(ENTITY_SIZE));
  }

  const tick = fast(2);
  const scene = fast(1);
  const pending = fast(1);
  const ready = fast(1);
  const booted = fast(1);
  const held = fast(1);
  const pressed = fast(1);
  const released = fast(1);
  const redraw = fast(1);
  const scratch = fast(8);
  const mathA = fast(PROP_SIZE);
  const mathB = fast(PROP_SIZE);
  // Seven bytes of product plus five of remainder: the multiply's accumulator
  // has to hold 2^52 exactly, which is what the clamped operand range implies.
  const mathWork = fast(24);

  const temps: number[] = [];
  // Six beyond the deepest expression: the collision and camera emitters
  // borrow temporaries for their own intermediate boxes.
  for (let index = 0; index < analysis.maxDepth + 6; index += 1) temps.push(fast(PROP_SIZE));
  const staging: number[] = [];
  for (let index = 0; index < Math.max(1, analysis.maxAssignments); index += 1) {
    staging.push(fast(PROP_SIZE));
  }

  const sound = program.sounds.length > 0 ? fast(1) : null;
  const rng = analysis.usesRandom ? fast(4) : null;
  const camera = analysis.usesCamera || analysis.readsCamera ? fast(8) : null;
  const mapOrigin = analysis.usesLevels ? fast(4) : null;
  // These two are pointers, and on the 6502 a pointer that is not in page zero
  // cannot be dereferenced at all — `($nn),y` is the only indirect mode there is.
  const self = fast(2);
  const other = fast(2);

  const { ranges, total } = numberContacts(program);
  const contactBytes = Math.max(1, Math.ceil(total / 8));
  const contacts = fast(contactBytes);
  const contactsPrev = fast(contactBytes);

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
  const tilePtr = analysis.usesLevels ? fast(2) : 0;

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
  const cull = fast(2);

  // Hardware that attributes one cell at a time carries the attribute byte
  // alongside every queued tile; hardware that does not allocates neither the
  // fourth byte nor the scratch, so its work-RAM usage is exactly what it was
  // before colour existed.
  const queueStride = memory.cellAttributes ? 4 : 3;
  const queue = heap.take(memory.queueMax * queueStride);
  const queueCount = fast(1);
  const attr = memory.cellAttributes ? fast(1) : 0;
  const plot = heap.take(memory.plotMax * 2);
  const plotPrev = heap.take(memory.plotMax * 2);
  const plotCount = fast(1);
  const plotPrevCount = fast(1);
  const oamCount = fast(1);
  const oamPrev = fast(1);
  const words = fast(16 * 2);

  return {
    memory,
    entities,
    used: heap.used,
    fastUsed: quick?.used ?? 0,
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
    queueStride,
    queueCount,
    attr,
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
