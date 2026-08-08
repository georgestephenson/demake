/**
 * What a YM2610 on a Z80 owns — a port map, a write, and a latched channel tag.
 *
 * `sms-driver.ts`'s counterpart for the second chip this processor drives. The
 * stream player is `z80-player.ts`'s and is shared verbatim; what a chip decides
 * is how one packed write leaves the CPU and how a run knows whose channel it is,
 * and both of those are here.
 *
 * Two things about this chip are unlike the SN76489 next door and shape the whole
 * file.
 *
 * **A write has to settle.** The hardware documentation gives the interval
 * exactly — seventeen chip cycles after an address byte and eighty-three after a
 * datum — and warns that ignoring it is why some homebrew plays in an emulator
 * and not on a board. The address-to-datum gap is paid by the fetch between them;
 * the datum-to-next gap is not, so {@link neogeoWrite} pads it. That pad is the
 * only reason this write is longer than a Sega 8-bit's, and it is why this
 * console's write budget is stated in bus writes with the arithmetic attached.
 *
 * **The register is latched, so a run must open with an address.** A packed byte
 * here is a *port*, and two of the four ports latch a register while the other
 * two write it — so which channel a byte belongs to depends on what was latched.
 * That is the SN76489's problem with a different mechanism, and it has the same
 * answer: the tag is a **factory** carrying a latch, preemption skips whole runs
 * rather than writes, and the property that makes that safe — every run opens
 * with its own address byte — is *checked* rather than assumed
 * ({@link checkAddressDiscipline}).
 *
 * The trick that keeps a run whole is worth stating, because it is not obvious:
 * an address byte is tagged with the channels of **the register it is about to
 * latch**, which is its own value. So the address and its datum carry the same
 * tag and the packer keeps them in one run — where tagging the address as
 * belonging to nobody would split every register write in half and leave a datum
 * addressed to whatever the previous run latched.
 *
 * Sources:
 * - Neo Geo Development Wiki — Z80/YM2610 interface:
 *   https://wiki.neogeodev.org/index.php?title=Z80/YM2610_interface
 * - Neo Geo Development Wiki — YM2610 registers:
 *   https://wiki.neogeodev.org/index.php?title=YM2610_registers
 */

import type { AsmZ80 } from "@demake/core";

import type { ChipScript } from "../chipscript.js";

import { AudioRomError } from "./gb.js";

/** The chip's four bus addresses, as Z80 ports. */
export const NEOGEO_PORT = { first: 0x04 } as const;

/** Ports the driver uses that are not the chip's. */
export const NEOGEO_SOUND_PORT = {
  /** Read: the byte the 68000 sent, and the acknowledge. */
  command: 0x00,
  /** Read: allow a command to raise a non-maskable interrupt. */
  enableNmi: 0x08,
  /** Write: a byte the 68000 can read back. */
  reply: 0x0c,
} as const;

/**
 * How a schedule's bus port reaches the packed data.
 *
 * A `BoundWrite.reg` on this console is already a port — 0 to 3, an address or a
 * datum on one of the two pairs — so the only thing to do is put it where the Z80
 * answers, which is `$04`. One byte either way, and the write loop pays nothing.
 */
export function neogeoPortOf(reg: number): number {
  return NEOGEO_PORT.first + (reg & 3);
}

/**
 * One packed write: the port, the value, and the time the chip needs after it.
 *
 * The pad is two `push af`/`pop af` pairs — forty-two T-states, four bytes, and
 * nothing clobbered. A delay loop would be shorter in bytes and would need a
 * register; `b` is the run counter, `d` carries the run's flags and `hl` walks the
 * data, so there is none to spare (`z80-player.ts` §The run walk).
 */
export function neogeoWrite(asm: AsmZ80): void {
  asm.ld("a", "hlp");
  asm.inc16("hl");
  asm.ld("c", "a");
  asm.ld("a", "hlp");
  asm.inc16("hl");
  // `b` rides along on A8-A15, which this board's I/O decoding ignores exactly as
  // a Sega 8-bit's does.
  asm.outC("a");
  asm.push("af");
  asm.pop("af");
  asm.push("af");
  asm.pop("af");
}

/**
 * Which spec channel a register belongs to, or `-1` for one that belongs to none.
 *
 * The channel list is squares, then FM, then the six fixed-rate sample voices,
 * then the variable-rate one — the order `neogeoAudio` declares, which puts a
 * square first so an effect lands on one.
 *
 * `$28` is deliberately nobody's. It is the FM key-on byte and the channel it
 * names is in the *datum*, which an address byte cannot know — and it does not
 * have to, because on this console an effect never takes an FM voice.
 */
export function neogeoChannelOf(half: number, register: number): number {
  if (half === 0) {
    if (register <= 0x05) return register >> 1;
    if (register >= 0x08 && register <= 0x0a) return register - 0x08;
    if (register >= 0x10 && register <= 0x1b) return 13;
    if (register >= 0x30 && register <= 0xb6) {
      const offset = register & 3;
      return offset === 1 || offset === 2 ? 3 + (offset - 1) : -1;
    }
    return -1;
  }
  if (register >= 0x08 && register <= 0x2d) {
    const voice = register & 7;
    return voice <= 5 ? 7 + voice : -1;
  }
  if (register >= 0x30 && register <= 0xb6) {
    const offset = register & 3;
    return offset === 1 || offset === 2 ? 5 + (offset - 1) : -1;
  }
  return -1;
}

/**
 * The run tag, as a factory carrying the two ports' address latches.
 *
 * `numbered` is the spec channels an effect was placed on, in the order their
 * bits appear in a run's channel field — at most four, because that field is a
 * nibble. Everything else tags zero, which is the Mega Drive's and the Nintendo
 * DS's arrangement and means a track's other thirteen voices play *through* an
 * effect rather than ducking for it.
 */
export function neogeoChannelTag(
  numbered: readonly number[],
): () => (reg: number, value: number) => number {
  return () => {
    const latched = [0, 0];
    return (reg: number, value: number): number => {
      const half = (reg >> 1) & 1;
      // An address byte is tagged by the register it is *about to* latch, which
      // is its own value — so it and its datum share a tag and stay in one run.
      const register = (reg & 1) === 0 ? value & 0xff : (latched[half] as number);
      if ((reg & 1) === 0) latched[half] = value & 0xff;
      const channel = neogeoChannelOf(half, register);
      const index = numbered.indexOf(channel);
      return index < 0 ? 0 : 1 << index;
    };
  };
}

/**
 * The tag that says which channel a write *belongs to*, rather than which run.
 *
 * `restrict` needs every channel numbered, because it keeps a write whose channel
 * is nobody's and drops one belonging to somebody else — so a tag that numbered
 * only the borrowable channels would call the other thirteen "nobody" and keep an
 * effect's whole opening statement of the chip. The run tag cannot be this one:
 * a run's channel field is a nibble and this console has fourteen voices.
 */
export function neogeoOwnerTag(): (reg: number, value: number) => number {
  const latched = [0, 0];
  return (reg: number, value: number): number => {
    const half = (reg >> 1) & 1;
    const register = (reg & 1) === 0 ? value & 0xff : (latched[half] as number);
    if ((reg & 1) === 0) latched[half] = value & 0xff;
    const channel = neogeoChannelOf(half, register);
    return channel < 0 ? 0 : 1 << channel;
  };
}

/**
 * Refuse a schedule whose runs do not each open with an address byte.
 *
 * Preemption skips a whole run, so a run that began with a datum would be written
 * against whatever register the last run that *was* written happened to latch —
 * a note on the wrong voice several ticks later, which is exactly the failure
 * `checkLatchDiscipline` exists to stop on the chip next door. The binding emits
 * an address and its datum together, so this is a check on the binding rather
 * than a constraint on the music.
 */
export function checkAddressDiscipline(script: ChipScript): void {
  for (const [index, tick] of script.ticks.entries()) {
    let previous = -1;
    for (const write of tick.writes) {
      if ((write.reg & 1) === 1 && previous !== (write.reg & ~1)) {
        throw new AudioRomError(
          "E_ADDRESS_DISCIPLINE",
          `tick ${index} writes a datum on port ${write.reg} without latching an address first`,
          "the binding must emit a register's address and its value together.",
        );
      }
      previous = write.reg;
    }
  }
}
