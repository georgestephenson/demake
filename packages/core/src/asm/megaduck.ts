/**
 * The Mega Duck's I/O page: one table, three consumers.
 *
 * The console (also sold as the Cougar Boy) is a Game Boy clone whose I/O pins
 * were rewired. Everything else is the Game Boy's — the SM83, the memory map,
 * 2bpp tiles, the background maps, OAM and its DMA, the joypad, the timer, the
 * interrupt vectors at `$0040`+ — and what moved is:
 *
 *   - **Video**, from `$FF40`–`$FF4B` to `$FF10`–`$FF1B`, in an order of its own
 *     rather than at an offset.
 *   - **Sound**, from `$FF10`–`$FF26` to `$FF20`–`$FF46`, with `NR11`/`NR12`,
 *     `NR33`/`NR34`, `NR42`/`NR43` and `NR51`/`NR52` each swapped. Wave RAM
 *     stayed at `$FF30`–`$FF3F`.
 *   - **`LCDC`'s bits**, five of the eight, in a cycle (§{@link lcdcFromDuck}).
 *
 * It lives in `core` for the reason the cartridge header does (`gb-cart.ts`):
 * three things need it and a hardware fact implemented three times is a fact
 * that disagrees in one entry in one of them. The emulator needs
 * address → Game Boy register to route a write; the audio driver needs Game Boy
 * register → address to emit a store; the game backend needs the video half.
 * All three are this table, read in one direction or the other.
 *
 * There is no boot ROM and no cartridge header on this console — nothing checks
 * a logo, a checksum or a type byte — so a cartridge is 32 KiB of code that
 * begins executing at `$0000`.
 *
 * Source: SameDuck (a SameBoy fork), `Core/gb.h` and `Core/display.c`.
 */

/** Video registers, in the Mega Duck's order, starting at `$FF10`. */
const VIDEO: readonly number[] = [
  0x40, // $FF10 LCDC
  0x41, // $FF11 STAT
  0x42, // $FF12 SCY
  0x43, // $FF13 SCX
  0x48, // $FF14 OBP0
  0x49, // $FF15 OBP1
  0x4a, // $FF16 WY
  0x4b, // $FF17 WX
  0x44, // $FF18 LY
  0x45, // $FF19 LYC
  0x46, // $FF1A DMA
  0x47, // $FF1B BGP
];

/** Sound registers `NR10`–`NR34` plus the two unused slots, from `$FF20`. */
const SOUND: readonly number[] = [
  0x10, 0x12, 0x11, 0x13, 0x14, 0x16, 0x15, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1e, 0x1d, 0x1f,
];

/** `NR41`–`NR51`, from `$FF40`. Wave RAM sits between them, where it always was. */
const NOISE: readonly number[] = [0x20, 0x22, 0x21, 0x23, 0x24, 0x26, 0x25];

/** {@link MEGADUCK_TO_GB} for an offset this console has no register at. */
export const MEGADUCK_UNMAPPED = -1;

/**
 * Mega Duck I/O offset → the Game Boy register it is.
 *
 * Indexed by the low byte of an address in `$FF00`–`$FF7F`. Offsets the console
 * did not move map to themselves, so the timer, the joypad, the interrupt flag
 * and wave RAM come back unchanged.
 *
 * Offsets it has *no* register at give {@link MEGADUCK_UNMAPPED}, and that
 * matters more than it looks: the gaps the move leaves — `$1C`–`$1F` between the
 * video registers and the sound ones, `$47`–`$4B` after them — are addresses
 * that are `NR32`, `NR33`, `NR34` and the Game Boy's palette registers on the
 * *other* machine. Letting them fall through as identity would mean a Mega Duck
 * program writing an address with nothing behind it quietly changed the wave
 * channel's volume.
 */
export const MEGADUCK_TO_GB: readonly number[] = (() => {
  const map = Array.from({ length: 0x80 }, (_, at) => at);
  VIDEO.forEach((gb, index) => (map[0x10 + index] = gb));
  SOUND.forEach((gb, index) => (map[0x20 + index] = gb));
  NOISE.forEach((gb, index) => (map[0x40 + index] = gb));
  // Every Game Boy register that moved is now reachable at its new offset, so
  // wherever its *old* offset is not itself a Mega Duck register, nothing is
  // there at all.
  const moved = new Set([...VIDEO, ...SOUND, ...NOISE]);
  const duckRegisters = new Set([
    ...VIDEO.map((_, index) => 0x10 + index),
    ...SOUND.map((_, index) => 0x20 + index),
    ...NOISE.map((_, index) => 0x40 + index),
  ]);
  for (let at = 0; at < 0x80; at += 1) {
    if (!duckRegisters.has(at) && moved.has(at)) map[at] = MEGADUCK_UNMAPPED;
  }
  return map;
})();

/**
 * The inverse: a Game Boy register → where a Mega Duck program must store it.
 *
 * Built from the moved entries only, and that is load-bearing. Inverting the
 * whole 128-entry page instead would let the *identity* entries overwrite the
 * real ones — `$48` is `OBP0` on a Game Boy and is not a register this console
 * moved anything to, so its own identity entry would land on top of the `$14`
 * that belongs there, and the backend would emit a store to a byte that does
 * nothing. It did, until `megaduck.test.ts` compared this against the hardware.
 */
export const GB_TO_MEGADUCK: readonly number[] = (() => {
  const map = Array.from({ length: 0x80 }, (_, at) => at);
  const moved = (base: number, list: readonly number[]): void => {
    list.forEach((gb, index) => (map[gb] = base + index));
  };
  moved(0x10, VIDEO);
  moved(0x20, SOUND);
  moved(0x40, NOISE);
  return map;
})();

/** Where a Game Boy register lives on a Mega Duck; anything else is unchanged. */
export function megaduckRegister(gbRegister: number): number {
  return GB_TO_MEGADUCK[gbRegister & 0x7f] ?? gbRegister;
}

/**
 * A Mega Duck `LCDC` as a Game Boy one.
 *
 * Five bits moved, in a cycle: background-enable is bit 6 here rather than
 * bit 0, object-enable bit 0 rather than bit 1, object-size bit 1 rather than
 * bit 2, background-map bit 2 rather than bit 3, and window-map bit 3 rather
 * than bit 6. Tile-data select, window-enable and LCD-enable did not move, and
 * tile-data keeps the Game Boy's polarity — set still selects the unsigned
 * `$8000` block.
 */
export function lcdcFromDuck(value: number): number {
  return (
    (value & 0xb0) |
    ((value & 0x40) >> 6) |
    ((value & 0x01) << 1) |
    ((value & 0x02) << 1) |
    ((value & 0x04) << 1) |
    ((value & 0x08) << 3)
  );
}

/** The inverse, so a Mega Duck program reads back the byte it wrote. */
export function lcdcToDuck(value: number): number {
  return (
    (value & 0xb0) |
    ((value & 0x01) << 6) |
    ((value & 0x02) >> 1) |
    ((value & 0x04) >> 1) |
    ((value & 0x08) >> 1) |
    ((value & 0x40) >> 3)
  );
}

/** Bytes in a Mega Duck cartridge: the same mapper-less 32 KiB a Game Boy takes. */
export const MEGADUCK_ROM_SIZE = 0x8000;
