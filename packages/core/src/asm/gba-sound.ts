/**
 * The Game Boy Advance's sound page: one table, two consumers.
 *
 * This console carries a Game Boy's four channels verbatim — the same pulses,
 * the same wave RAM, the same envelopes, the same `NR51` — at addresses of its
 * own, with gaps where the Game Boy has none. That is a *machine description*
 * rather than a second chip, exactly as the Mega Duck's is (`megaduck.ts`), and
 * it lives here for the reason that one does: two things need it, in opposite
 * directions, and a hardware fact implemented twice is a fact that disagrees in
 * one entry in one of them.
 *
 *   - `@demake/gba` needs **address → register** to route a store into
 *     `@demake/chip`'s `GbApu` and to report it to the conformance tap in the
 *     numbering a `ChipScript` holds.
 *   - `@demake/audio`'s ARM driver needs **register → address** to emit that
 *     store in the first place.
 *
 * The Mega Duck learned twice over what happens when those two are separate
 * tables (AGENTS.md §Gotchas): a description that is wrong and *consistent*
 * passes every test there is, because the cartridge and the core cancel each
 * other's error out. So there is one table, it is inverted here rather than
 * transcribed, and an offset with no register behind it is
 * {@link GBA_SOUND_UNMAPPED} rather than falling through as identity — the gaps
 * are real on this console, and a write into one must not become a write to the
 * music.
 *
 * Source: GBATEK — *GBA Sound Controller* (https://problemkaputt.de/gbatek.htm).
 */

/** Where this console's sound registers begin, as an I/O-page offset. */
export const GBA_SOUND_BASE = 0x060;

/** Where the four Game Boy channels answer, as a full address. */
export const GBA_SOUND_ADDRESS = 0x04000000 + GBA_SOUND_BASE;

/** {@link GBA_SOUND_TO_GB} for an offset this console has no register at. */
export const GBA_SOUND_UNMAPPED = -1;

/**
 * The channel and control registers, as `[offset, Game Boy register]` pairs.
 *
 * Written out rather than derived from a stride: this console spaces the four
 * channels on a four-byte grid and the Game Boy spaces them on a five-byte one,
 * so every arrangement that looks like an offset is a coincidence that stops
 * holding at the wave channel.
 */
const REGISTERS: readonly (readonly [number, number])[] = [
  [0x060, 0x10], // NR10 — sweep
  [0x062, 0x11], // NR11 — duty and length
  [0x063, 0x12], // NR12 — envelope
  [0x064, 0x13], // NR13 — frequency low
  [0x065, 0x14], // NR14 — frequency high and trigger
  [0x068, 0x16], // NR21
  [0x069, 0x17], // NR22
  [0x06c, 0x18], // NR23
  [0x06d, 0x19], // NR24
  [0x070, 0x1a], // NR30 — the wave channel's DAC
  [0x072, 0x1b], // NR31
  [0x073, 0x1c], // NR32
  [0x074, 0x1d], // NR33
  [0x075, 0x1e], // NR34
  [0x078, 0x20], // NR41
  [0x079, 0x21], // NR42
  [0x07c, 0x22], // NR43
  [0x07d, 0x23], // NR44
  [0x080, 0x24], // NR50 — master volume
  [0x081, 0x25], // NR51 — panning
  [0x084, 0x26], // NR52 — power
];

/** Where wave RAM sits on this console, and where it sits on a Game Boy. */
const WAVE_BASE = 0x090;
const GB_WAVE_BASE = 0x30;
/** Bytes of it. Sixteen here as well, though the hardware banks two of them. */
const WAVE_BYTES = 16;

/**
 * Game Boy register → this console's I/O-page offset, or
 * {@link GBA_SOUND_UNMAPPED}.
 *
 * Indexed by the register number a `ChipScript` holds, which is a Game Boy's
 * `$10`–`$3F`.
 */
export const GB_TO_GBA_SOUND: readonly number[] = (() => {
  const map = new Array<number>(0x40).fill(GBA_SOUND_UNMAPPED);
  for (const [offset, register] of REGISTERS) map[register] = offset;
  for (let index = 0; index < WAVE_BYTES; index += 1) {
    map[GB_WAVE_BASE + index] = WAVE_BASE + index;
  }
  return map;
})();

/**
 * This console's I/O-page offset → the Game Boy register it is.
 *
 * Inverted from {@link GB_TO_GBA_SOUND} rather than written out a second time.
 * Only the entries that exist are filled: `$4000061`, `$4000066`, `$4000067` and
 * the rest of the holes have no register behind them, and a core that let them
 * fall through as identity would let a write to an empty address change the
 * music — which is the Mega Duck's bug, restated on a bigger machine.
 */
export const GBA_SOUND_TO_GB: readonly number[] = (() => {
  const map = new Array<number>(0x50).fill(GBA_SOUND_UNMAPPED);
  for (let register = 0; register < GB_TO_GBA_SOUND.length; register += 1) {
    const offset = GB_TO_GBA_SOUND[register] as number;
    if (offset !== GBA_SOUND_UNMAPPED) map[offset - GBA_SOUND_BASE] = register;
  }
  return map;
})();

/**
 * The address a Game Boy sound register answers at on this console.
 *
 * Throws rather than returning a plausible address: every register the binding
 * emits is one this console has, so a miss is a bug in the driver and not
 * something a cartridge should discover by writing somewhere harmless.
 */
export function gbaSoundAddress(gbRegister: number): number {
  const offset = GB_TO_GBA_SOUND[gbRegister];
  if (offset === undefined || offset === GBA_SOUND_UNMAPPED) {
    throw new Error(`this console has no sound register $${gbRegister.toString(16)}`);
  }
  return 0x04000000 + offset;
}

/** The Game Boy register at a sound-page offset, or {@link GBA_SOUND_UNMAPPED}. */
export function gbaSoundRegister(offset: number): number {
  const at = offset - GBA_SOUND_BASE;
  if (at < 0 || at >= GBA_SOUND_TO_GB.length) return GBA_SOUND_UNMAPPED;
  return GBA_SOUND_TO_GB[at] as number;
}
