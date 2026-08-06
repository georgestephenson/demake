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
 * The entity record keeps the interpreter's nine-property *order*, because that
 * is what lets the conformance harness read a trace straight out of work RAM
 * (doc 14 §Conformance). What it does not keep is the interpreter's fixed 36
 * bytes: a record stops at the highest slot the program can observe, so a coin
 * that never moves does not pay for a speed and two directions it cannot have
 * (see {@link entityBytes}). On a console whose cartridge adds no RAM at all
 * that is the difference between a game fitting and not.
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

import {
  GBA_AUDIO_BYTES,
  NGP_AUDIO_BYTES,
  MD_AUDIO_BYTES,
  NDS_AUDIO_BYTES,
  NES_AUDIO_BYTES,
  PCE_AUDIO_BYTES,
  SMS_AUDIO_BYTES,
  WSC_AUDIO_BYTES,
} from "@demake/audio";

import type { Program } from "../program.js";

import type { Analysis } from "./analyze.js";
import { ZP_FREE } from "./mos/zp.js";
import { DP_FREE } from "./snes/ops.js";

/**
 * Stored properties, in record order. Index × 4 is the byte offset.
 *
 * The order is load-bearing twice over. `x`, `y`, `width`, `height` lead because
 * a collision box has to be a contiguous run (see {@link BOX_SIZE}). And the
 * three movement properties trail because most objects in a game never move, and
 * a record is allocated only as far as the highest slot the program can observe
 * (see {@link entityBytes}) — so where a property sits decides what a coin costs.
 */
export const PROPS = [
  "x",
  "y",
  "width",
  "height",
  "visible",
  "value",
  "speed",
  "xdirection",
  "ydirection",
] as const;

/** One stored property name. */
export type Prop = (typeof PROPS)[number];

/** Bytes per stored property. */
export const PROP_SIZE = 4;

/** Bytes of a full record — what an object that moves and counts costs. */
export const ENTITY_SIZE = PROPS.length * PROP_SIZE;

/**
 * Bytes one entity's record actually needs.
 *
 * RAM is the scarcest thing on these machines — an NROM cartridge adds none to
 * the console's two kilobytes — and a fixed-size record spends it on absences:
 * a coin that never moves was still paying for a speed, an x-direction and a
 * y-direction it could not have.
 *
 * A property needs storage only when something can *observe* it at run time, and
 * the backend already folds the rest: `rules.ts` reads an immutable `speed` or
 * direction as a constant and drops an object that cannot move out of the
 * integrator entirely, and `visible` is only loaded where a rule can write it.
 * So the stored set is
 *
 *   - the collision box, always, because it is block-copied as a unit and every
 *     drawn object's position is read from it;
 *   - everything any rule, control or `on hold` restore can write;
 *   - `value`, for a `number`, because the digit renderer reads it;
 *   - the movement trio, for anything that can move — which is anything whose
 *     speed or direction a rule can change, plus anything that starts moving.
 *
 * The record is then allocated up to the highest slot in that set rather than
 * per property, because every emitter addresses a property as `base + slot × 4`
 * and a per-instance slot map would be a second thing to keep in step — with
 * `rom/trace.ts`, which reads either machine's table with one function.
 *
 * Conservative in the same direction as the rest of `analyze.ts`: a slot kept
 * that could have gone costs four bytes, a slot dropped that was read costs a
 * wrong game.
 */
export function entityBytes(program: Program, analysis: Analysis, id: number): number {
  const instance = program.instances[id];
  if (!instance) return ENTITY_SIZE;
  const written = analysis.writes.get(id);
  let top = PROP_SLOT["height"] as number;
  const need = (prop: string): void => {
    top = Math.max(top, PROP_SLOT[prop] as number);
  };

  if (written) for (const prop of written) if (prop in PROP_SLOT) need(prop);
  if (instance.className === "number") need("value");

  const fixed = (prop: string): number => instance.numbers[prop] ?? 0;
  const canMove =
    written !== undefined &&
    (written.has("speed") || written.has("xdirection") || written.has("ydirection"));
  if (
    canMove ||
    (fixed("speed") !== 0 && (fixed("xdirection") !== 0 || fixed("ydirection") !== 0))
  ) {
    need("ydirection");
  }

  return (top + 1) * PROP_SIZE;
}

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
   * Bytes the console's audio driver keeps its own state in, or zero.
   *
   * Zero where the driver has somewhere better to be: the Game Boy's lives in
   * high RAM, which the allocator does not hand out at all. The other two take
   * them from the same pool everything else does, for opposite reasons — the
   * NES's two stream pointers *have* to be in page zero, because `($nn),y` is the
   * only indirection that CPU has, while the Z80 makes every address the same
   * width and so gives its driver nowhere better than anywhere else. A game with
   * no audio takes none either way.
   */
  audioBytes: number;

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

  /**
   * Bytes this console's interrupt handlers own outright.
   *
   * An interrupt writes a byte in the middle of whatever the game was doing, so
   * that byte cannot be borrowed from anything a routine is using — and the
   * backend scratch blocks are all explicitly one-routine scratch. Zero on the
   * consoles whose handlers write somewhere the allocator does not hand out (the
   * Game Boy's flag is in high RAM) or a block the backend owns alone (the NES's
   * is one of its own named scratch bytes, saved and restored around the upload
   * the handler performs).
   *
   * The Sega handlers need two: the frame flag the main loop waits on, and the
   * Pause key's latch. They were in the shared scratch, and a frame interrupt
   * landing inside the modulo loop of `random()` overwrote its divisor — a draw
   * that came out wrong every few seconds, at no tick anyone could name.
   */
  interruptBytes: number;

  /**
   * Bytes the emitters that walk a *list* of entities keep their cursor in: a
   * two-byte record pointer and a one-byte index.
   *
   * Zero on a console whose backend has somewhere cheaper. The 6502 keeps both
   * in page zero (`codegen/mos/zp.ts`) because `($nn),y` is the only indirect
   * mode it has, so the pointer must live there; the Z80 reaches a record
   * through `hl`, `de` or `ix` and needs no such place — but a rule body fires
   * between one iteration and the next and may use every register there is, so
   * the cursor has to survive in memory rather than in a pair.
   *
   * Not `layout.scratch`, which is documented as valid for the length of one
   * routine and is exactly what a rule body helps itself to.
   */
  loopBytes: number;

  /**
   * Whether this machine stores a multi-byte value high half first.
   *
   * A compile-time fact about the console and nothing else — but it reaches
   * further than the emitters, because `rom/trace.ts` reads a game's 16.16 state
   * straight out of work RAM and has to know which way round it is. Three of the
   * four consoles are little-endian and the 68000 is not; a reader that assumed
   * one order would report every value byte-swapped, which looks like an
   * arithmetic bug rather than a byte-order one.
   */
  bigEndian?: boolean;

  /**
   * Bytes a multi-byte allocation is rounded up to.
   *
   * One on the three eight-bit consoles, which read a word from any address at
   * all. The 68000 does not: a word or long access to an odd address is an
   * *address error*, which on real hardware is a crash and in a forgiving core is
   * silently the wrong two bytes. So the Mega Drive's plan asks for two, and the
   * allocator pads before anything wider than a byte.
   *
   * Only multi-byte requests are aligned, so a run of flags still packs tightly
   * and the console that needs none has exactly the map it had before this
   * existed.
   */
  align?: number;
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
  audioBytes: 0,
  cellAttributes: false,
  interruptBytes: 0,
  loopBytes: 0,
};

/** The same, for a Game Boy Color: an attribute byte per queued cell. */
export const GBC_MEMORY: MemoryPlan = { ...GB_MEMORY, cellAttributes: true };

/**
 * And the Mega Duck's, which differs only in what to call it.
 *
 * The console clones the Game Boy's memory map exactly — 8 KiB of work RAM at
 * `$C000`, OAM at `$FE00`, high RAM at `$FF80` — and moves only the I/O page in
 * between. It is spelled out rather than aliased because `machine` is what a
 * program is told when it runs out of room, and "this game needs more RAM than
 * a Game Boy has" is the wrong sentence to show someone building for a Duck.
 */
export const MEGADUCK_MEMORY: MemoryPlan = { ...GB_MEMORY, machine: "Mega Duck" };

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
 * The cheap region starts above the backend's own named pointers rather than at
 * `$0000` (`codegen/mos/zp.ts` owns them, and states where the allocator may
 * begin): a routine that walks a table needs a pointer at a *fixed* address, not
 * one the allocator chose.
 */
export const NES_MEMORY: MemoryPlan = {
  machine: "NES",
  heapStart: 0x0300,
  heapEnd: 0x0800,
  fastStart: ZP_FREE,
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
  audioBytes: NES_AUDIO_BYTES,
  cellAttributes: false,
  interruptBytes: 0,
  // The 6502 backend's loops keep their cursor in page zero, which the allocator
  // never sees; see {@link MemoryPlan.loopBytes}.
  loopBytes: 0,
};

/**
 * The PC Engine's plan, which is the NES's arithmetic in a machine four times
 * the size.
 *
 * The same processor, so the same three fixed reservations shape it — the zero
 * page a pointer has to live in, the stack the hardware puts in one place, and
 * the object shadow — and every one of them lands somewhere else, because on this
 * CPU the zero page is at `$2000` and the stack at `$2100` (`asm/huc6280.ts`).
 * What is left of the 8 KiB is the heap, and it is four times an NROM
 * cartridge's whole RAM.
 *
 * Two numbers here are the *video* hardware's rather than the memory's:
 *
 *   - **The object shadow is uploaded, not transferred.** This chip fetches its
 *     sprite table out of video RAM rather than out of work RAM, so the 512 bytes
 *     below the heap are a staging buffer the runtime streams across with one
 *     block-transfer instruction. Nothing about it has to be page-aligned, which
 *     is why it sits wherever the map put it rather than at a boundary.
 *   - **A queued cell is an address and a word.** A BAT entry carries its own
 *     palette, so a cell is a tile *and* an attribute — the Sega's shape reached
 *     by different hardware — and the queue is bytes rather than entries because
 *     a scrolled column goes in as one run.
 */
export const PCE_MEMORY: MemoryPlan = {
  machine: "PC Engine",
  // Past the stack page, which the hardware fixes at `$2100`-`$21FF`, and past
  // the object staging buffer below.
  heapStart: 0x2400,
  heapEnd: 0x4000,
  // The cheap page is the CPU's own `$2000`-`$20FF`, above the bytes the
  // backend's shared routines have fixed addresses in (`codegen/mos/zp.ts`).
  // These are the machine's addresses and not operands, because an *indexed*
  // access takes them as absolute ones.
  fastStart: 0x2000 + ZP_FREE,
  fastEnd: 0x2100,
  oamShadow: 0x2200,
  oamEntries: 64,
  viewW: 32,
  viewH: 28,
  // Bytes rather than cells: the queue is a stream of runs, and a diagonal scroll
  // is a column of twenty-nine and a row of thirty-three in the same frame — 130
  // bytes of it. The count is a byte, so this cannot pass 255 whatever the plan
  // would like.
  queueMax: 50,
  plotMax: 40,
  // The driver's own state, in the CPU's cheap page for the reason every 6502
  // driver's is: `($nn),y` is the only indirection this processor has, so a
  // stream pointer has to *live* there.
  audioBytes: PCE_AUDIO_BYTES,
  // A BAT entry is a word — twelve bits of character and four of palette — so a
  // queued cell is a tile and an attribute.
  cellAttributes: true,
  // The frame flag is one of the backend's own named scratch bytes, saved and
  // restored around the upload the handler performs; the NES's arrangement, and
  // for the NES's reason.
  interruptBytes: 0,
  // The 6502 family keeps its loop cursors in the zero page, which the allocator
  // never sees; see {@link MemoryPlan.loopBytes}.
  loopBytes: 0,
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
  // A queued cell here carries its own address as well as two bytes of data, so
  // an entry is four bytes and the count of them is a *byte* — which caps the
  // queue at sixty rather than at what a blanking interval would hold. Sixty is
  // what a diagonal scroll needs: a column of twenty-five and a row of
  // thirty-three, painted in the same frame.
  queueMax: 60,
  plotMax: 40,
  // Out of the same pool as everything else, because the Z80 has no cheap region
  // to keep them in: a load and a store carry a full address wherever the byte
  // lives, so there is nothing to be economical about. Both other consoles pay
  // this reservation somewhere the allocator never sees.
  audioBytes: SMS_AUDIO_BYTES,
  // The frame flag and the Pause latch; see {@link MemoryPlan.interruptBytes}.
  interruptBytes: 2,
  // A name-table entry carries its palette-select and flip bits in a second
  // byte, so a queued cell is a tile *and* an attribute — the same shape as the
  // Game Boy Color's, reached by different hardware.
  cellAttributes: true,
  // The record pointer and index the collision, edge and movement loops walk
  // with; see {@link MemoryPlan.loopBytes}.
  loopBytes: 3,
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

/**
 * The Super Nintendo's plan, which is the roomy one for a different reason.
 *
 * This console has 128 KiB of work RAM, but only its first eight are mirrored
 * into bank zero — and that mirror is what makes the whole backend's addressing
 * work: with the data bank left at zero, every property is a plain sixteen-bit
 * absolute and the hardware registers are reachable by the same instructions.
 * Reaching the other 120 KiB would mean long addressing or a data-bank switch on
 * every access, for room no game in the library is near needing, so the plan
 * stops at the mirror. Four fixed reservations come out of it:
 *
 *   - **The direct page**, `$0000`–`$00FF`, which this CPU addresses in two bytes
 *     rather than three. `codegen/snes/ops.ts` owns the bottom of it and states
 *     where the allocator may begin.
 *   - **The stack**, below the object shadow. Native mode puts it anywhere in
 *     bank zero, unlike the 6502's fixed page one.
 *   - **The object shadow**, 544 bytes: 128 entries of four, then the two-bit
 *     table that carries each object's ninth X bit and its size.
 *   - The rest, `$0700`–`$1EFF`, is the heap.
 *
 * `queueMax` is generous because a queued cell is cheap here: the address
 * register and the two data ports are consecutive, so a cell is two sixteen-bit
 * stores rather than the NES's six writes or the Sega VDP's four.
 */
export const SNES_MEMORY: MemoryPlan = {
  machine: "Super Nintendo",
  heapStart: 0x0700,
  heapEnd: 0x1f00,
  fastStart: DP_FREE,
  fastEnd: 0x0100,
  oamShadow: 0x0400,
  oamEntries: 128,
  viewW: 32,
  viewH: 28,
  queueMax: 96,
  plotMax: 96,
  // Three bytes, and the smallest driver state of any console here — because the
  // driver is not on this processor. Everything a Game Boy or an NES keeps in
  // work RAM (order cursors, block pointers, rest counters, steal masks) lives in
  // the *sound* processor's own page zero; what the game keeps is a music
  // request, an effect request and the sequence byte that tells the other
  // computer they are new.
  audioBytes: 3,
  // A tilemap entry is a word — ten bits of tile, three of palette, two of flip
  // and one of priority — so a queued cell carries its data as two bytes, the
  // same shape the Game Boy Color's and the Sega VDP's do.
  cellAttributes: true,
  // The frame flag the main loop waits on. Its own byte for the reason the Sega
  // handlers' is: an interrupt writes it in the middle of whatever the game was
  // doing, and everything in `layout.scratch` is valid for the length of one
  // routine.
  interruptBytes: 1,
  // The loop cursor is in the direct page, which the allocator never sees; see
  // {@link MemoryPlan.loopBytes}.
  loopBytes: 0,
};

/**
 * The Mega Drive's plan, and the one number in it that is an instruction-set
 * decision rather than a hardware one.
 *
 * Sixty-four kilobytes of work RAM at `$FF0000`–`$FFFFFF`, which is eight times
 * what the roomiest console in the set has and more than any of these games
 * could spend. What is worth stating is *where* in it the heap starts: the
 * 68000's short absolute form sign-extends a word, so `$FF8000`–`$FFFFFF` — the
 * top half — is reachable in two bytes where anything below it takes four. Every
 * property read in a compiled game is an absolute access, so putting the whole
 * of a game's state above that line is worth about a fifth of the program's
 * size, and it costs nothing: the games use a couple of kilobytes.
 *
 * The rest is the VDP's:
 *
 *   - **Eighty sprite entries of eight bytes**, and the shadow is the sprite
 *     attribute table's own layout so the upload is one run.
 *   - **A 40×28 window on a 64×32 plane**, so a scrolling scene has
 *     twenty-four spare columns and four spare rows and never has to hide a
 *     seam — the thing the Master System's thirty-two-column table forces.
 *   - **A queued cell is an address and a cell word**, four bytes, because a
 *     name-table entry here carries its palette, both flip bits and an
 *     eleven-bit tile index in one word.
 */
export const MD_MEMORY: MemoryPlan = {
  machine: "Mega Drive",
  // Past the object shadow, and above the line the short absolute form reaches.
  heapStart: 0xff8400,
  heapEnd: 0xffff00,
  oamShadow: 0xff8000,
  oamEntries: 80,
  viewW: 40,
  viewH: 28,
  // A vertical blank here is about eighteen thousand CPU cycles and a queued
  // cell costs a few dozen, so the cap is what a diagonal scroll needs — a
  // column of twenty-nine and a row of forty-one — rather than what fits.
  queueMax: 96,
  plotMax: 48,
  // The PSG half of this console's sound, which is a Master System's chip at
  // `$C00011` and is what `demake build` drives. Larger than the Sega 8-bits'
  // block by ten bytes, because five of the driver's fields are longword
  // pointers into a half-megabyte cartridge rather than sixteen-bit ones.
  audioBytes: MD_AUDIO_BYTES,
  cellAttributes: true,
  // The frame flag the main loop waits on. Its own byte for the reason the Sega
  // handlers' is: an interrupt lands in the middle of whatever the game was
  // doing, and everything in `layout.scratch` is one-routine scratch.
  interruptBytes: 1,
  // A four-byte record pointer and a two-byte index. Four rather than the Sega's
  // two because an address is a long here, and in memory rather than in a
  // register for the same reason it is there: a rule body fires between one
  // iteration and the next and uses every register the machine has.
  loopBytes: 6,
  bigEndian: true,
  align: 2,
};

/**
 * The Game Boy Advance's plan: 32 KiB of internal work RAM, and none of the
 * other 256.
 *
 * Three things about this map are the machine's rather than a preference.
 *
 * **It is the *internal* RAM, not the big one.** A game's state lives at
 * `$03000000` on a 32-bit bus with no wait states, not in the 256 KiB at
 * `$02000000` on a 16-bit bus with two — which would make every property read
 * three times the price. That is the whole of why this console's plan is 32 KiB
 * rather than a quarter of a megabyte, and the trade is not close.
 *
 * **A load reaches ±4095 from a base register**, so the backend holds one at
 * `$03000000` and the first four kilobytes of this heap are a single
 * instruction each. Everything past that costs one more to materialise, which is
 * why the allocation order matters more here than anywhere else: entity records
 * come first and the hot state follows them, so a game of any size the language
 * can express keeps its whole tick inside the window.
 *
 * **The top of the RAM is not ours.** The interrupt vector the BIOS dispatcher
 * reads is at `$03007FFC` and the three stacks it left are below it, so the plan
 * stops at `$03007000` and puts the object shadow there — out of the base
 * register's window, which costs nothing because the shadow is walked
 * sequentially with a base of its own.
 */
export const GBA_MEMORY: MemoryPlan = {
  machine: "Game Boy Advance",
  heapStart: 0x03000000,
  heapEnd: 0x03007000,
  oamShadow: 0x03007000,
  oamEntries: 128,
  viewW: 30,
  viewH: 20,
  // A vertical blank here is 68 lines of 1232 cycles — some 83,000, against a
  // Game Boy's 1140 — and a queued cell is one halfword store. So the cap is
  // what a diagonal scroll needs (a column of 21 and a row of 31) with room to
  // spare, rather than what fits: nothing on this console is bounded by the
  // blanking interval.
  queueMax: 128,
  plotMax: 96,
  // The largest driver state of any console here, and by a factor of a hundred —
  // because most of it is the **mixing accumulator**, a 32-bit word per side per
  // sample of one block. This console's second sound device is software, so its
  // driver has to keep working space the way a chip-driven one never does; two
  // kilobytes of a twenty-eight-kilobyte heap is what that costs, and it buys the
  // six voices the hardware would otherwise not have at all.
  audioBytes: GBA_AUDIO_BYTES,
  // A screen entry is a halfword — ten bits of tile, one of each flip, four of
  // palette — so a queued cell carries its data as two bytes, the same shape the
  // Game Boy Color's attribute byte and the Sega VDP's second byte have.
  cellAttributes: true,
  // The frame flag the main loop waits on. Its own byte for the reason the Sega
  // handlers' is: a handler writes it in the middle of whatever the game was
  // doing, and everything in `layout.scratch` is one-routine scratch.
  interruptBytes: 1,
  // A four-byte record pointer and a two-byte index, in memory rather than in a
  // register for the reason the 68000's are: a rule body fires between one
  // iteration and the next and helps itself to every register there is.
  loopBytes: 6,
  // Little-endian, and word accesses want a word boundary — a `ldr` from an
  // unaligned address *rotates* on this core rather than faulting, which is a
  // wrong number rather than a crash and therefore worse.
  align: 4,
};

/**
 * The Nintendo DS's, which is the Game Boy Advance's plan on a bigger machine.
 *
 * Three things differ and each is the console's rather than a preference. The
 * heap is in **main RAM** rather than in a fast internal region, because the
 * program itself was copied there and there is nothing else — 64 KiB of it,
 * starting a megabyte past the program so that a build that grew a long way and
 * a heap that grew a long way would still not meet. The window is **32×24 cells**
 * against 30×20. And **no interrupt bytes**, because this backend watches the
 * beam here rather than a handler (`codegen/gba/machine.ts` §frame), so there is
 * no flag for a handler to raise.
 *
 * `audioBytes` is zero, and that is a gap rather than a decision: this console's
 * sound registers are the ARM7's and there is no driver for it yet, so a game
 * that names music builds, records what its rules asked for, and plays silently
 * — exactly the position the Game Boy Advance was in before its ARM driver
 * landed. Doc 13 §D4 is where it is tracked.
 */
export const NDS_MEMORY: MemoryPlan = {
  machine: "Nintendo DS",
  heapStart: 0x02100000,
  heapEnd: 0x02110000,
  oamShadow: 0x02110000,
  oamEntries: 128,
  viewW: 32,
  viewH: 24,
  queueMax: 128,
  plotMax: 96,
  // The *smallest* driver state of any console here, and the largest is the
  // machine this backend shares its instruction set with — because on this one
  // the driver is not in this program at all. Its cursors, its tables and its
  // schedules live in the sound processor's own memory, and what the game sets
  // aside is the two bytes it writes to ask for a track and a sound effect
  // (`audio/rom/nds-game.ts` §requests). Four, for the alignment the allocator
  // wants on a machine that faults on an odd word.
  audioBytes: NDS_AUDIO_BYTES,
  cellAttributes: true,
  interruptBytes: 0,
  loopBytes: 6,
  align: 4,
};

/**
 * The WonderSwan Color's plan, and the one console where the *picture* is in it.
 *
 * Sixty-four kilobytes at segment zero, and everything the display reads is in
 * them: there is no video memory on this machine at all, so the two screen maps,
 * the tile bank, the object table and palette RAM are addresses beside the
 * game's own variables rather than somewhere a port reaches. Three of them the
 * hardware fixes and the rest is this plan's to place:
 *
 * ```text
 *   $0000–$02FF  the processor's own interrupt vectors, which nothing uses
 *   $0300–$033F  the sound hardware's four waveforms (`WS_WAVE_BASE`)
 *   $0400–$1FFF  the heap
 *   $2000–$27FF  the first screen map, 32×32 words
 *   $2800–$2FFF  the second screen map — the HUD's plane
 *   $3000–$31FF  the object table, which port $04 addresses in units of 512
 *   $3200–$3FFF  the stack, growing down
 *   $4000–$7FFF  the tile bank: 512 tiles of 32 bytes, where the chip looks
 *   $FE00–$FFFF  palette RAM: sixteen palettes of sixteen RGB444 words
 * ```
 *
 * Two of the numbers are worth stating for what they say about the machine
 * rather than about the map. The **object table is not a shadow**: the display
 * reads it where it is, so a frame's objects are written once rather than built
 * and then uploaded, and this is the only console here where `oamShadow` names
 * the hardware's own table. And the vectors are left alone rather than handed
 * out — a demade cartridge polls the display's line counter and takes no
 * interrupt at all, and its audio driver takes none either: it reads the
 * vertical-blank timer's *counter* and pays whatever frames it finds owed
 * (`audio/src/rom/wsc-game.ts`), so the kilobyte stays the processor's.
 *
 * The sound hardware's sixty-four bytes of waveform sit at `$0300`, inside those
 * untouched vectors — the last aligned page of the kilobyte, because port `$8F`
 * carries only bits 6–13 of an address and the page has to be free on the *mono*
 * machine too, whose sixteen kilobytes have their tile bank where this one has
 * its gap. `WS_WAVE_BASE` is where that number lives.
 */
/**
 * The mono WonderSwan's plan, which is the same machine with a quarter of it.
 *
 * Sixteen kilobytes rather than sixty-four, and the top half of them is the tile
 * bank — 512 tiles of *sixteen* bytes, because a tile is planar 2bpp here. So
 * everything a game has lives in the 8 KiB below it, and every address moves:
 *
 * ```text
 *   $0000–$02FF  the processor's own interrupt vectors, which nothing uses
 *   $0300–$033F  the sound hardware's four waveforms (`WS_WAVE_BASE`)
 *   $0340–$0B3F  the heap
 *   $0B40–$0BFF  the stack, growing down from $0C00
 *   $0C00–$0DFF  the object shadow, built during the frame
 *   $0E00–$0FFF  the object table, which port $04 addresses in units of 512
 *   $1000–$17FF  the first screen map, 32×32 words
 *   $1800–$1FFF  the second screen map — the HUD's plane
 *   $2000–$3FFF  the tile bank, where the chip looks
 * ```
 *
 * The heap is 2 KiB against the colour machine's 7, which is the NES's budget on
 * a console with four times its screen — and it is the one number here that is a
 * *choice* rather than the hardware's, because the stack and the heap share what
 * the fixed structures leave. The palettes cost nothing, which is the compensation:
 * they are ports on this machine rather than five hundred and twelve bytes of RAM.
 */
export const WS_MEMORY: MemoryPlan = {
  machine: "WonderSwan",
  heapStart: 0x0340,
  heapEnd: 0x0b40,
  oamShadow: 0x0c00,
  oamEntries: 128,
  viewW: 28,
  viewH: 18,
  queueMax: 60,
  plotMax: 40,
  audioBytes: WSC_AUDIO_BYTES,
  cellAttributes: true,
  interruptBytes: 0,
  loopBytes: 3,
};

export const WSC_MEMORY: MemoryPlan = {
  machine: "WonderSwan Color",
  heapStart: 0x0400,
  heapEnd: 0x2000,
  oamShadow: 0x3000,
  oamEntries: 128,
  viewW: 28,
  viewH: 18,
  // A queued cell is an address and a word, as on the Sega and the PC Engine —
  // though here the address is the store's own operand rather than something a
  // port has to be told. Sixty is a diagonal scroll: a column of nineteen and a
  // row of twenty-nine, painted in the same frame.
  queueMax: 60,
  plotMax: 40,
  audioBytes: WSC_AUDIO_BYTES,
  // A screen entry is a word — nine bits of tile, four of palette, one of bank
  // and two of flip — so a queued cell is a tile *and* an attribute.
  cellAttributes: true,
  // No interrupts: the main loop watches the line counter, exactly as the
  // Nintendo DS's does, so no handler writes a byte behind a routine's back.
  interruptBytes: 0,
  // The record pointer and index the collision, edge and movement loops walk
  // with. In memory rather than in `bx` for the Z80's reason: a rule body fires
  // between one iteration and the next and uses every register there is.
  loopBytes: 3,
};

/**
 * The Neo Geo Pocket Color's plan: eleven kilobytes, and no video memory in it.
 *
 * The heap is `$4000` up to the boot ROM's own reservation at `$6C00`, which is
 * every byte a cartridge may have — the display controller's registers, the two
 * scroll maps, the object table, the palettes and the character bank are all
 * above `$8000` and belong to the hardware, so unlike a Game Boy's or a
 * WonderSwan's this plan competes with nothing.
 *
 * Two of its numbers are this console's rather than a restatement. **The object
 * table is the hardware's own**, at `$8800`, because the display reads it where
 * the runtime wrote it — there is no shadow and no upload, which is the
 * WonderSwan's arrangement one console along. And **there are no interrupt
 * bytes**, because the vertical-blank handler this console dispatches is reached
 * through a pointer in the boot ROM's reserved page: what the handler needs is
 * outside the allocator's reach by construction.
 */
export const NGPC_MEMORY: MemoryPlan = {
  machine: "Neo Geo Pocket Color",
  heapStart: 0x4000,
  heapEnd: 0x6c00,
  // The hardware's table, not a shadow of it: the chip reads these bytes
  // directly, so writing them belongs in the blanking interval and copying them
  // anywhere would be a second answer.
  oamShadow: 0x8800,
  oamEntries: 64,
  viewW: 20,
  viewH: 19,
  // A queued cell is an address and a word. Sixty covers a diagonal scroll: a
  // column of twenty and a row of twenty-one, painted in the same frame.
  queueMax: 60,
  plotMax: 40,
  // The TLCS-900 driver's own state: two stream positions of *longwords*, and up
  // to six bytes a channel of the copies a borrowed channel is handed back with
  // — three more than the Sega's, because a level here is two attenuators and
  // the noise generator has a divisor of its own.
  audioBytes: NGP_AUDIO_BYTES,
  // A map entry is a word — nine bits of tile, four of palette, one of mono
  // palette and two of flip — so a queued cell is a tile *and* an attribute.
  cellAttributes: true,
  // The frame flag the vertical-blank handler sets and the main loop waits on.
  // Its own byte rather than borrowed scratch, for the Sega's reason: a handler
  // writes it in the middle of whatever the game was doing, and everything in
  // `layout.scratch` is documented as valid for the length of one routine.
  interruptBytes: 1,
  // A four-byte record pointer and a two-byte index, as on the Mega Drive and
  // the Game Boy Advance: an address is twenty-four bits here, so a pointer that
  // fitted in two would have to be widened at every use. In memory rather than
  // in a register for the Z80's reason — a rule body fires between one iteration
  // and the next and helps itself to every register there is.
  loopBytes: 6,
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
  /**
   * Bytes of each instance's record, by instance id.
   *
   * Not `ENTITY_SIZE` for everything: a record is allocated only as far as the
   * highest slot the program can observe ({@link entityBytes}). Every whole-record
   * copy — the boot restore, each scene's reset, and the `Defaults_` table each
   * copies from — reads this, so the three cannot fall out of step, and so can
   * `rom/trace.ts`, which walks the same table on eight different machines.
   */
  entitySizes: readonly number[];
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
  /**
   * The audio driver's own state, or `null`.
   *
   * `null` for a game with nothing to play, and for every console whose driver
   * keeps its state somewhere the allocator does not own. Allocated last, so
   * adding it moved no other address.
   *
   * It follows what the *program* names, not which files an edge happened to
   * load: a build with the audio bytes left out reserves the same bytes and
   * therefore has the same memory map, which is what makes a silent build's
   * trace comparable with a sounding one's byte for byte.
   */
  audio: number | null;
  /**
   * Bytes the interrupt handlers own, or `null` where they need none.
   *
   * The Sega handlers' frame flag and Pause latch; see
   * {@link MemoryPlan.interruptBytes} for why they cannot be scratch.
   */
  interrupt: number | null;
  /**
   * The entity-list cursor: a two-byte record pointer, then a one-byte index.
   *
   * `null` where the backend has somewhere cheaper; see
   * {@link MemoryPlan.loopBytes}.
   */
  loop: number | null;
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
  /**
   * `on hold` snapshots: four bytes then an engaged byte, per *property* an
   * `on hold` control writes (`analyze.ts`'s `holdTargets`). Per property rather
   * than per binding because `left` and `right` write one `xdirection` between
   * them, and what a release puts back is what it held before either was down.
   */
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
    private readonly align = 1,
  ) {
    this.at = start;
  }

  take(bytes: number): number {
    // Only what is read as a word or a long has to be aligned; a run of single
    // bytes still packs tightly, which is what keeps every other console's map
    // exactly what it was.
    if (bytes > 1 && this.align > 1) {
      this.at = Math.ceil(this.at / this.align) * this.align;
    }
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
  const align = memory.align ?? 1;
  const heap = new Bump(memory.heapStart, memory.heapEnd, memory.machine, "work RAM", align);
  const quick =
    memory.fastStart !== undefined && memory.fastEnd !== undefined
      ? new Bump(memory.fastStart, memory.fastEnd, memory.machine, "page zero", align)
      : undefined;
  /** Take from the cheap region if the machine has one, the heap otherwise. */
  const fast = (bytes: number): number => (quick ?? heap).take(bytes);

  const entities: number[] = [];
  const entitySizes: number[] = [];
  for (let id = 0; id < program.instances.length; id += 1) {
    const size = entityBytes(program, analysis, id);
    entitySizes.push(size);
    entities.push(heap.take(size));
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
  // Last, deliberately: the order of these calls is the order of the addresses,
  // so anything added anywhere else would move every entity record. Which is
  // also why the interrupt bytes go after the driver's rather than beside the
  // scratch they were taken out of — a console that needs none is unchanged.
  const audio =
    memory.audioBytes > 0 && program.tracks.length + program.sounds.length > 0
      ? fast(memory.audioBytes)
      : null;
  const interrupt = memory.interruptBytes > 0 ? fast(memory.interruptBytes) : null;
  // After the interrupt bytes, for the same reason they come after the driver's:
  // a console that needs none has exactly the map it had before this existed.
  const loop = memory.loopBytes > 0 ? fast(memory.loopBytes) : null;

  return {
    memory,
    entities,
    entitySizes,
    used: heap.used,
    fastUsed: quick?.used ?? 0,
    interrupt,
    loop,
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
    audio,
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
