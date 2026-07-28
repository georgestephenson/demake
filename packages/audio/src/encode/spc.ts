/**
 * `.spc` — the artifact a Super Nintendo schedule belongs in.
 *
 * Every other console demake targets exports a `.vgm`, which is a log of
 * register writes with waits between them. VGM has no block for this chip and
 * could not usefully have one: the S-DSP plays *samples*, so a write log without
 * the 64 KiB the samples live in is not a piece of music. The format the console
 * actually has is an SPC — a snapshot of the sound processor's whole RAM, its
 * DSP registers and its program counter — and that is a happy accident rather
 * than a compromise, because **an SPC is exactly what a cartridge uploads.** The
 * driver in `rom/spc-game.ts` is built either way; this just writes it out as a
 * file instead of into a game.
 *
 * So `demake arrange -c snes -o theme.spc` produces a file that plays in any
 * chip-music player, and what plays is the same driver performing the same
 * schedule the cartridge would.
 *
 * Source: the SPC700 Sound File Format (v0.30) description that ships with every
 * player and ripper, and ID666's tag layout.
 */

import { ARAM_SIZE } from "@demake/chip";

import type { ChipScript } from "../chipscript.js";
import { buildSpcGameAudio } from "../rom/spc-game.js";

/** Metadata for the file's ID666 tags. */
export interface SpcOptions {
  title?: string;
  game?: string;
  artist?: string;
  comment?: string;
}

/** The magic string, which is checked byte for byte by every player. */
const MAGIC = "SNES-SPC700 Sound File Data v0.30";

/** Header, then 64 KiB of RAM, then 128 DSP registers, then 64 spare. */
const HEADER_BYTES = 0x100;
const DSP_BYTES = 128;
const EXTRA_BYTES = 64;

/** Where the sound processor's stack pointer starts, as the boot ROM leaves it. */
const BOOT_SP = 0xef;

/** Encode a schedule as an SPC file. */
export function encodeSpc(script: ChipScript, options: SpcOptions = {}): Uint8Array {
  // One track, no effects, and the driver starts it itself: a file has no game
  // to post it a request, so `autoStart` is the whole difference between this
  // and what a cartridge embeds.
  const driver = buildSpcGameAudio({ tracks: [script], effects: [], autoStart: 1 });

  const out = new Uint8Array(HEADER_BYTES + ARAM_SIZE + DSP_BYTES + EXTRA_BYTES);
  const view = new DataView(out.buffer);
  writeAscii(out, 0x00, MAGIC, MAGIC.length);
  out[0x21] = 0x1a;
  out[0x22] = 0x1a;
  // $1A here says "the ID666 tags below are text"; $1B would say binary.
  out[0x23] = 0x1a;
  out[0x24] = 30;
  view.setUint16(0x25, driver.entry, true);
  out[0x27] = 0x00; // A
  out[0x28] = 0x00; // X
  out[0x29] = 0x00; // Y
  out[0x2a] = 0x00; // PSW
  out[0x2b] = BOOT_SP;

  writeAscii(out, 0x2e, options.title ?? "", 32);
  writeAscii(out, 0x4e, options.game ?? "", 32);
  writeAscii(out, 0x6e, "demake", 16);
  writeAscii(out, 0x7e, options.comment ?? "", 32);
  writeAscii(out, 0xb1, options.artist ?? "", 32);

  // The RAM is the state *after* the upload, which is the only state this file
  // has ever had: a cartridge hands these same bytes over four at a time.
  out.set(driver.image, HEADER_BYTES + driver.address);
  // The DSP block is left at zero deliberately. The driver initialises the chip
  // from its own table at entry, so a player that applies this block and then
  // runs gets exactly what a console would — and a block written here as well
  // would be a second answer to "how does this chip come up".
  return out;
}

/** The artifact format a console's schedules are written in. */
export function artifactFormat(chip: string | undefined): "vgm" | "spc" {
  return chip === "s-dsp" ? "spc" : "vgm";
}

function writeAscii(out: Uint8Array, at: number, text: string, length: number): void {
  for (let index = 0; index < length; index += 1) {
    const code = index < text.length ? text.charCodeAt(index) : 0;
    out[at + index] = code < 0x20 || code > 0x7e ? 0x20 : code;
  }
  // Every field is NUL-terminated when it is short enough to be.
  if (text.length < length) out[at + text.length] = 0;
}
