/**
 * Console profiles — the target half of compilation.
 *
 * A profile is the *game-relevant* projection of a `ConsoleSpec`: how big the
 * playfield is in cells, how fast the logical tick runs, and what the sprite
 * hardware will tolerate. It is deliberately a separate, plain-data type rather
 * than a direct import of `@demake/core`, for two reasons: the simulator stays
 * dependency-free (so the browser preview can load `dist/` as raw ESM with no
 * bundler), and the numbers a *game* cares about are not the numbers an image
 * converter cares about. `test/profiles.test.ts` cross-checks every screen
 * dimension here against the real `ConsoleSpec`, so the two cannot drift.
 *
 * One unit is one 8×8 cell. That is the concession to hardware granularity
 * that makes `height 1` mean the same thing everywhere: cells are the natural
 * common denominator because tiles and sprites are already cell-sized, so
 * nothing has to be re-quantized per console. `screenheight` is 18 on a Game
 * Boy, 28 on a Mega Drive, and relative expressions like `screenheight - 1`
 * port for free.
 *
 * `screenWidth`/`screenHeight` are the **overscan-safe** area, not the raw
 * framebuffer. On the NES the raw frame is 256×240 but only 256×224 is
 * reliably visible on a CRT, so a paddle placed at raw `screenheight - 1` would
 * sit in the overscan. Safe-by-default is the right trade; `rawWidth`/
 * `rawHeight` are there for callers who know what they are asking for.
 */

/** Sprite hardware limits that a game can actually exceed. */
export interface SpriteLimits {
  /** Hardware sprite (OAM) entries available. */
  total: number;
  /** Sprites the video hardware will draw on a single scanline. */
  perLine: number;
  /** Whether sprite patterns can be mirrored horizontally by hardware. */
  hFlip: boolean;
}

/**
 * How the abstract `start` action reaches the hardware.
 *
 * `start` is the one button in the portable set that is not portable in
 * practice: the Master System has no Start button at all — pause is a
 * console-mounted switch wired to the CPU's non-maskable interrupt — so a
 * "press start" screen silently does nothing unless the runtime maps it there.
 * The compiler warns rather than failing, because the mapping is legitimate;
 * it just isn't a face button.
 */
export type StartMapping = "dedicated" | "pause-nmi" | "none";

/** The game-relevant projection of a console. */
export interface ConsoleProfile {
  /** Matches the `ConsoleSpec` id in `@demake/core`. */
  id: string;
  name: string;
  /** Playfield width in cells (overscan-safe). */
  screenWidth: number;
  /** Playfield height in cells (overscan-safe). */
  screenHeight: number;
  /** Raw framebuffer size in pixels, before the overscan crop. */
  rawWidth: number;
  rawHeight: number;
  /** Cell size in pixels — 8×8 across every console in scope. */
  cellSize: number;
  /** Logical ticks per second. Speeds resolve against this at compile time. */
  fps: number;
  sprites: SpriteLimits;
  /** How the abstract `start` action reaches this hardware. */
  startButton: StartMapping;
  /** True where a codegen backend, ROM harness, and emulator E2E exist today. */
  romPath: boolean;
}

/**
 * The profile table.
 *
 * Scope note: the SG-1000 is deliberately absent. Its TMS9918 allows four
 * sprites per scanline and one colour per sprite, which does not constrain the
 * language so much as distort it — every other console in the set shares a
 * multi-colour sprite model. It stays a `prep`/`inspect` target, not a game
 * target.
 *
 * Frame rates are the nominal integer rate the logical tick runs at, not the
 * exact hardware refresh (a Game Boy is 59.7275 Hz). The tick is what the
 * simulation and the console runtime agree on; matching the hardware's true
 * refresh is a rendering concern.
 */
const PROFILES: readonly ConsoleProfile[] = [
  {
    id: "gb",
    name: "Game Boy",
    screenWidth: 20,
    screenHeight: 18,
    rawWidth: 160,
    rawHeight: 144,
    cellSize: 8,
    fps: 60,
    sprites: { total: 40, perLine: 10, hFlip: true },
    startButton: "dedicated",
    romPath: true,
  },
  {
    id: "gbc",
    name: "Game Boy Color",
    screenWidth: 20,
    screenHeight: 18,
    rawWidth: 160,
    rawHeight: 144,
    cellSize: 8,
    fps: 60,
    sprites: { total: 40, perLine: 10, hFlip: true },
    startButton: "dedicated",
    romPath: true,
  },
  {
    // A Game Boy clone, and the profile says so by being identical: same
    // screen, same cell grid, same forty sprites ten to a line, same tick. What
    // differs about this console is where its registers live, which is a
    // backend fact and not a game-relevant one — so nothing here changes, and a
    // `.dmt` that fits a Game Boy fits this by construction.
    id: "megaduck",
    name: "Mega Duck",
    screenWidth: 20,
    screenHeight: 18,
    rawWidth: 160,
    rawHeight: 144,
    cellSize: 8,
    fps: 60,
    sprites: { total: 40, perLine: 10, hFlip: true },
    startButton: "dedicated",
    romPath: true,
  },
  {
    id: "nes",
    name: "Nintendo Entertainment System",
    // Raw frame is 32×30 cells; the overscan-safe rect in the ConsoleSpec
    // trims 8px top and bottom, leaving 28 usable rows.
    screenWidth: 32,
    screenHeight: 28,
    rawWidth: 256,
    rawHeight: 240,
    cellSize: 8,
    fps: 60,
    sprites: { total: 64, perLine: 8, hFlip: true },
    startButton: "dedicated",
    romPath: true,
  },
  {
    id: "sms",
    name: "Sega Master System",
    screenWidth: 32,
    screenHeight: 24,
    rawWidth: 256,
    rawHeight: 192,
    cellSize: 8,
    fps: 60,
    // Mode 4 sprites carry no flip bits — art needing a mirrored facing
    // direction must ship both patterns. The budget checker reports this.
    sprites: { total: 64, perLine: 8, hFlip: false },
    startButton: "pause-nmi",
    romPath: true,
  },
  {
    id: "gg",
    name: "Game Gear",
    screenWidth: 20,
    screenHeight: 18,
    rawWidth: 160,
    rawHeight: 144,
    cellSize: 8,
    fps: 60,
    sprites: { total: 64, perLine: 8, hFlip: false },
    startButton: "dedicated",
    romPath: true,
  },
  {
    id: "md",
    name: "Mega Drive",
    screenWidth: 40,
    screenHeight: 28,
    rawWidth: 320,
    rawHeight: 224,
    cellSize: 8,
    fps: 60,
    sprites: { total: 80, perLine: 20, hFlip: true },
    startButton: "dedicated",
    romPath: true,
  },
  {
    // Two hundred and fifty-six by two hundred and twenty-four, like the Super
    // Nintendo — and unlike every other console here, the sprites are sixteen
    // pixels square at their smallest, so an object costs a quarter of the
    // entries it costs elsewhere. That is why sixteen a line is a *more*
    // generous budget than it reads as beside a Game Boy's ten.
    id: "pce",
    name: "PC Engine",
    screenWidth: 32,
    screenHeight: 28,
    rawWidth: 256,
    rawHeight: 224,
    cellSize: 8,
    fps: 60,
    sprites: { total: 64, perLine: 16, hFlip: true },
    startButton: "dedicated",
    romPath: true,
  },
  {
    id: "snes",
    name: "Super Nintendo",
    screenWidth: 32,
    screenHeight: 28,
    rawWidth: 256,
    rawHeight: 224,
    cellSize: 8,
    fps: 60,
    sprites: { total: 128, perLine: 32, hFlip: true },
    startButton: "dedicated",
    romPath: true,
  },
  {
    // The first screen in the set with no overscan to be safe of: an LCD shows
    // every pixel the hardware draws, so the raw frame and the playfield are the
    // same thirty by twenty cells.
    id: "gba",
    name: "Game Boy Advance",
    screenWidth: 30,
    screenHeight: 20,
    rawWidth: 240,
    rawHeight: 160,
    cellSize: 8,
    fps: 60,
    // **The per-line limit here is a cycle budget, not a count**, and 128 is the
    // honest number for what a game can reason about. An object costs its width
    // in pixels on every line it covers, against 1210 cycles a line — so a row of
    // 8×8 sprites runs out of *attribute entries* long before it runs out of
    // cycles, which is the opposite of every other console in this table. That is
    // why a wide object is affordable here and `E_SPRITE_BUDGET`'s per-line
    // reasoning (AGENTS.md §Working on Demotic) stops biting.
    sprites: { total: 128, perLine: 128, hFlip: true },
    startButton: "dedicated",
    romPath: true,
  },
  {
    // The second screen is not here, and that is the profile saying what the
    // backend builds rather than what the hardware has: a game is one screen,
    // and 2D engine B draws the other. The one that is here is bigger than every
    // other console's in the set — thirty-two cells by twenty-four, with no
    // overscan to be safe of, because an LCD shows every pixel.
    id: "nds",
    name: "Nintendo DS",
    screenWidth: 32,
    screenHeight: 24,
    rawWidth: 256,
    rawHeight: 192,
    cellSize: 8,
    fps: 60,
    // The Game Boy Advance's reasoning, on the same engine: the per-line limit
    // is a *cycle* budget rather than a count, so a row of 8×8 sprites runs out
    // of attribute entries long before it runs out of cycles.
    sprites: { total: 128, perLine: 128, hFlip: true },
    startButton: "dedicated",
    romPath: true,
  },
  {
    // **The first console in the table that does not run at sixty.** This
    // display is 75.47 Hz and a tick is a frame, so a second of game is
    // seventy-five ticks — which is exactly what the relative unit system exists
    // for (doc 14 §3), and what made the `.test.dmt` suites say `play 4 seconds`
    // where they used to say `play 240 ticks`. Nominal integer rate, like every
    // other row.
    id: "wsc",
    name: "WonderSwan Color",
    screenWidth: 28,
    screenHeight: 18,
    rawWidth: 224,
    rawHeight: 144,
    cellSize: 8,
    fps: 75,
    // Thirty-two objects a line, four times what the 8-bit consoles allow and
    // the same as the Super Nintendo's — but 8×8 only, so a wide object costs
    // its width in entries here and there is no 8×16 to halve it.
    sprites: { total: 128, perLine: 32, hFlip: true },
    startButton: "dedicated",
    romPath: true,
  },
];

/*
 * The WonderSwan Color is not in that table yet, and the reason is a finding
 * rather than an omission.
 *
 * Its display runs at **75.47 Hz**, so a tick that is a frame is a tick that
 * happens seventy-five times a second — the first console in this set that does
 * not run at sixty. The language is built for exactly that (doc 14 §3): a rally
 * written in `vw` and seconds lasts as long there as it does on a Game Boy.
 * The **`.test.dmt` suites are not**, and adding this profile is what showed it:
 * every script in the example library says `play 240 ticks` and `hold right for
 * 42 ticks`, and `caves`' own comment states the assumption in as many words —
 * "an eleven-cell-a-second hero … takes the same ticks to reach the same ledge
 * on every console". A tick count is an absolute *duration* dressed as a
 * portable one, and it has been portable only because every console so far
 * shared a rate.
 *
 * Closing it is one of two things and neither is this file's: a duration unit in
 * the test-script grammar, so a suite can say `play 4 seconds` and mean it on
 * both (a language change, and therefore the maintainer's call — AGENTS.md
 * §Iron rules), or per-console scripts, which gives up what the suites are for.
 * The profile lands with the backend (doc 13 §Console rollout), by which time
 * the answer has to exist anyway.
 */

/** Every profile, in a stable order. */
export const profiles: readonly ConsoleProfile[] = PROFILES;

/** Look up a profile by console id. Returns `undefined` if unsupported. */
export function findProfile(id: string): ConsoleProfile | undefined {
  const wanted = id.toLowerCase();
  return PROFILES.find((profile) => profile.id === wanted);
}

/** Look up a profile by console id, throwing a helpful error if absent. */
export function getProfile(id: string): ConsoleProfile {
  const profile = findProfile(id);
  if (!profile) {
    throw new Error(
      `unknown console '${id}' — Demotic supports ${PROFILES.map((p) => p.id).join(", ")}`,
    );
  }
  return profile;
}
