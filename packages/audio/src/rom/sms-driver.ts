/**
 * What an SN76489 on a Z80 owns — which is a port and a shadow, and nothing else.
 *
 * The stream player moved to `z80-player.ts` when a second console started
 * driving one, on `mos-player.ts`'s terms: the walk belongs to the *processor*,
 * and what a chip decides is how a write leaves the CPU and how a borrowed
 * channel is remembered. Those two are here, and they are the whole of what a
 * Sega 8-bit adds to the shared walk.
 *
 * Sources:
 * - SMS Power! — SN76489: https://www.smspower.org/Development/SN76489
 * - SMS Power! — Z80 I/O port decoding: https://www.smspower.org/Development/Ports
 */

import type { AsmZ80 } from "@demake/core";

import { PSG_SHADOW, PSG_STEREO_REG } from "./psg.js";
import type { Z80ShadowChannel } from "./z80-player.js";

/**
 * The chip's one write port, and the Game Gear's stereo latch beside it.
 *
 * Here rather than in `psg.ts` because a *port* is this processor's business:
 * the same chip on a Mega Drive is an address in the 68000's memory map, so
 * nothing about these two numbers is the SN76489's. The sound chip answers on
 * either half of `$40`-`$7F`; `$7F` is what the Sega 8-bit game backend's own
 * boot code uses and what every published example uses, so the driver uses it
 * too. The stereo latch is a separate device at `$06` and only exists on the
 * handheld.
 */
export const PSG_PORT = { psg: 0x7f, stereo: 0x06 } as const;

/**
 * How a schedule's register number reaches the packed data.
 *
 * The port, because a Z80 writes a chip with `out (c), a` and the packed byte is
 * what lands in `c`. One byte either way — the same one the Game Boy spends on a
 * high-RAM offset — and the write loop pays nothing to translate.
 *
 * One definition with two callers, on the one-declaration rule: a game's driver
 * (`sms-game.ts`) and a standalone cartridge (`sms.ts`) pack the same schedules
 * for the same write loop, and a second copy is a cartridge whose stereo image
 * is written to the sound chip.
 */
export function psgPortOf(reg: number): number {
  return reg === PSG_STEREO_REG ? PSG_PORT.stereo : PSG_PORT.psg;
}

/**
 * One packed write: the port, then the value, straight out to the chip.
 *
 * The whole of what this chip costs the shared walk. A Neo Geo's is four
 * instructions longer, because a YM2610 has to be given time to settle.
 */
export function psgWrite(asm: AsmZ80): void {
  asm.ld("a", "hlp");
  asm.inc16("hl");
  asm.ld("c", "a");
  asm.ld("a", "hlp");
  asm.inc16("hl");
  asm.outC("a"); // `b` rides along on A8–A15, which nothing on this bus decodes
}

/**
 * Put the byte in `a` into whichever of a channel's three copies it is.
 *
 * Three constant addresses and two bit tests, because this chip's byte says what
 * it is: bit 7 separates a latch from the data that continues it, and bit 4
 * separates a tone latch from an attenuation one ({@link psgShadowSlot}). Only
 * the bytes the music really writes get a branch — the noise channel has no data
 * byte, so its copy is two bytes and one test.
 */
export function psgRecord(asm: AsmZ80, name: string, entry: Z80ShadowChannel): void {
  const has = (slot: number): boolean => entry.slots.includes(slot);
  const done = `${name}Kept`;
  if (has(PSG_SHADOW.DATA)) {
    asm.bit(7, "a");
    asm.jr(`${name}Data`, "z");
  }
  if (has(PSG_SHADOW.LEVEL) && has(PSG_SHADOW.TONE)) {
    asm.bit(4, "a");
    asm.jr(`${name}Level`, "nz");
  }
  if (has(PSG_SHADOW.TONE)) {
    asm.sta(entry.at + PSG_SHADOW.TONE);
    if (has(PSG_SHADOW.LEVEL) || has(PSG_SHADOW.DATA)) asm.jr(done);
  }
  if (has(PSG_SHADOW.LEVEL)) {
    if (has(PSG_SHADOW.TONE)) asm.label(`${name}Level`);
    asm.sta(entry.at + PSG_SHADOW.LEVEL);
    if (has(PSG_SHADOW.DATA)) asm.jr(done);
  }
  if (has(PSG_SHADOW.DATA)) {
    asm.label(`${name}Data`);
    asm.sta(entry.at + PSG_SHADOW.DATA);
  }
  asm.label(done);
}
