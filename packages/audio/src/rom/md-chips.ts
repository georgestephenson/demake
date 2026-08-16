/**
 * What a Mega Drive's *two* chips make of the driver hand-off.
 *
 * `psg.ts` is the SN76489's side and is shared with the Sega 8-bits; this is the
 * part that only exists because a console has two devices and a driver has to
 * reach both. Three questions, and all three have answers the format was already
 * shaped for:
 *
 *   - **Where does a write go?** Five destinations: the FM chip's four bus
 *     addresses and the PSG's one. That is one byte, which is exactly what the
 *     packed data already spends on a register — so {@link mdPort} is a `port`
 *     mapping like every other console's, and the Mega Drive's driver pays
 *     nothing extra for having twice the hardware.
 *   - **Which voice does a write belong to?** Ten of them, and the run format's
 *     channel field is four bits. It does not have to hold all ten: the only
 *     thing preemption asks is "may an effect be using this voice right now",
 *     and an effect takes one voice. So {@link mdChannelTag} numbers the
 *     *stealable* voices — the handful a game's effects were placed on — and
 *     tags everything else zero, which the driver reads as "never skip this".
 *     Four bits is then more than enough, and the FM half of a track plays
 *     straight through an effect instead of ducking for it.
 *   - **When is a data byte meaningless?** Both chips latch. The PSG latches a
 *     channel in a byte with bit 7 set; the FM chip latches an *address* on one
 *     bus port and takes the datum on the next. Either way a run that was skipped
 *     must not leave the next one reading a stale latch, and
 *     {@link checkMdLatchDiscipline} refuses a schedule where that could happen
 *     rather than letting it become a note on the wrong voice.
 *
 * Sources:
 * - Sega — YM2612 application manual (bus ports, key-on, register map)
 * - SMS Power! — SN76489: https://www.smspower.org/Development/SN76489
 */

import { eaAbs, eaImm, type Asm68k } from "@demake/core";

import type { ChipScript } from "../chipscript.js";

import type { ChannelTag } from "./data.js";
import { AudioRomError } from "./gb.js";
import { psgChannelTag, psgShadowSlot, PSG_STEREO_REG } from "./psg.js";

/** The two chips, as `BoundWrite.chip` indexes them. */
export const YM_CHIP = 0;
export const PSG_CHIP = 1;

/** FM voices, which are the first six of the console's ten channels. */
export const MD_FM_CHANNELS = 6;

/** The packed byte that means "the PSG", the four below it being the FM's ports. */
export const MD_PSG_PORT = 4;

/**
 * Where a write goes, as the one byte the packed data holds.
 *
 * `0`-`3` are the FM chip's bus addresses — which is what the schedule's register
 * already *is* for that chip, so this is the identity there — and `4` is the PSG.
 * The driver turns the byte into an address with one comparison.
 */
export function mdPort(reg: number, chip: number): number {
  return chip === PSG_CHIP ? MD_PSG_PORT : reg & 3;
}

/**
 * A tag that numbers the voices an effect may take, and nothing else.
 *
 * Fresh per schedule, because both chips carry state a tag has to follow: the
 * PSG's channel latch, and the FM chip's two address latches. `data.ts` asks for
 * a factory for exactly this reason, and sharing one between two schedules would
 * read the second from the first's last write.
 *
 * `stealable` is the console channel index of each voice an effect can borrow, in
 * the order the bits are assigned — so bit 0 is `stealable[0]`. At most four,
 * which is the width of the field and more voices than a game's effects use.
 */
export function mdChannelTag(stealable: readonly number[]): () => ChannelTag {
  return (): ChannelTag => {
    const psg = psgChannelTag();
    /** The address each half of the FM bus last latched. */
    const latched: [number, number] = [-1, -1];
    return (reg: number, value: number, chip: number): number => {
      const channel =
        chip === PSG_CHIP ? psgVoice(psg(reg, value, chip)) : ymVoice(reg, value, latched);
      if (channel < 0) return 0;
      const at = stealable.indexOf(channel);
      return at < 0 ? 0 : 1 << at;
    };
  };
}

/** The PSG's own four-bit mask, as a console channel index. */
function psgVoice(mask: number): number {
  if (mask === 0) return -1;
  for (let bit = 0; bit < 4; bit += 1) {
    if ((mask & (1 << bit)) !== 0) return MD_FM_CHANNELS + bit;
  }
  return -1;
}

/**
 * Which FM voice a bus write belongs to, following the address latch.
 *
 * An address port write moves the latch and belongs to whatever it selected; a
 * data port write belongs to whatever the latch holds. Which is the same shape
 * as the PSG's latch one register file over, and the reason both live here.
 */
function ymVoice(port: number, value: number, latched: [number, number]): number {
  const half = (port >> 1) & 1;
  if ((port & 1) === 0) {
    latched[half] = value & 0xff;
    return voiceOfAddress(half, value & 0xff, -1);
  }
  return voiceOfAddress(half, latched[half] as number, value & 0xff);
}

/**
 * The voice an FM register belongs to, or `-1` for one that belongs to none.
 *
 * The key register is the exception worth naming: it lives on the first half of
 * the bus for *every* voice and carries the channel in its datum, so it is the
 * one address whose voice cannot be known until the data byte arrives. `datum`
 * is `-1` when it has not yet.
 */
function voiceOfAddress(half: number, address: number, datum: number): number {
  if (address === 0x28) {
    if (datum < 0) return -1;
    const within = datum & 0x03;
    if (within === 3) return -1;
    return ((datum & 0x04) !== 0 ? 3 : 0) + within;
  }
  if (address < 0x30) return -1; // LFO, timers, the DAC: the chip's, not a voice's
  const within = address & 3;
  if (within === 3) return -1;
  // `$A8`-`$AE` are channel 3's per-operator frequencies, which nothing here
  // writes and which do not follow the channel-in-the-low-bits rule.
  if (address >= 0xa8 && address <= 0xaf) return -1;
  return half * 3 + within;
}

/**
 * Refuse a schedule whose runs could be skipped into nonsense.
 *
 * The whole of preemption rests on a skipped run taking its own latches with it.
 * For the PSG that means every run opens with a channel latch; for the FM chip it
 * means a data byte never opens a tick without the address that gives it meaning.
 * Both are properties the bindings hold by construction — which is exactly why
 * they are *checked* rather than assumed, because if either stops being true the
 * symptom is a note on the wrong voice several ticks later.
 */
export function checkMdLatchDiscipline(script: ChipScript): void {
  for (let tick = 0; tick < script.ticks.length; tick += 1) {
    let psgLatched = false;
    const ymLatched: [boolean, boolean] = [false, false];
    for (const write of script.ticks[tick]?.writes ?? []) {
      if ((write.chip ?? 0) === PSG_CHIP) {
        if ((write.value & 0x80) !== 0) {
          psgLatched = true;
          continue;
        }
        if (!psgLatched) {
          throw new AudioRomError(
            "E_PSG_LATCH",
            `tick ${tick} of an audio schedule opens with a PSG data byte and no latch in front of it`,
            "this chip carries the channel in the latch byte, so a driver could not tell which voice the write belongs to; this is a bug in the binding, not in the track.",
          );
        }
        continue;
      }
      const half = (write.reg >> 1) & 1;
      if ((write.reg & 1) === 0) {
        ymLatched[half] = true;
        continue;
      }
      if (!ymLatched[half]) {
        throw new AudioRomError(
          "E_FM_LATCH",
          `tick ${tick} of an audio schedule writes FM data on bus half ${half} with no address in front of it`,
          "this chip latches the register address on a separate port, so a driver could not tell which register the write belongs to; this is a bug in the binding, not in the track.",
        );
      }
    }
  }
}

/** One register of a borrowable voice on this board, and where its copy lives. */
export interface MdShadowWrite {
  /**
   * What names the register.
   *
   * An FM address, for a voice on that chip: the packed byte is a *bus port* and
   * the register is whatever the address port last latched, so the port cannot
   * name one. Otherwise one of `psg.ts`'s `PSG_SHADOW` three, because the tone chip
   * has no register numbers at all.
   */
  key: number;
  /** Which half of the FM bus reaches it. Absent for a tone voice. */
  half?: number;
  slot: number;
}

/** What the music remembers about one borrowable voice on this board. */
export interface MdShadowChannel {
  /** Channel bit, as the packed run format numbers it. */
  channel: number;
  kind: "fm" | "psg";
  /** Lowest key; a copy is indexed by `key - base`. */
  base: number;
  slot: number;
  length: number;
  writes: readonly MdShadowWrite[];
}

/**
 * What the music must remember about the voices effects can borrow, on a board
 * with two chips and not one register number between them.
 *
 * `shared.ts`'s {@link shadowPlan} indexes a copy by the byte the packed data
 * carries, and neither chip here lets it: the tone chip's byte is a latch that
 * says what it is, and the FM chip's is one of four *bus ports* whose meaning is
 * whatever the address port last held. So this walks the schedules the way the
 * driver's own tag does, following both latches, and names a register by what
 * actually identifies one.
 *
 * A voice is on one chip or the other and never both, which is what lets a copy
 * be one dense window either way.
 */
export function mdShadowPlan(
  tracks: readonly ChipScript[],
  stealable: readonly number[],
): MdShadowChannel[] {
  const owned = new Map<number, { kind: "fm" | "psg"; keys: Map<number, number> }>();
  for (const script of tracks) {
    const tag = mdChannelTag(stealable)();
    const psg = psgChannelTag();
    let latched = -1;
    let half = 0;
    for (const tick of script.ticks) {
      for (const write of tick.writes) {
        const chip = write.chip ?? 0;
        const bit = tag(write.reg, write.value, chip);
        // Both latches move on *every* write, tagged or not, because the chip's
        // do: a run this stream skips still changes what comes after it.
        if (chip === PSG_CHIP) psg(write.reg, write.value, chip);
        const address = chip === PSG_CHIP || (write.reg & 1) === 0 ? -1 : latched;
        if (chip !== PSG_CHIP && (write.reg & 1) === 0) {
          latched = write.value & 0xff;
          half = (write.reg >> 1) & 1;
        }
        if (bit === 0) continue;
        const kind = chip === PSG_CHIP ? "psg" : "fm";
        let entry = owned.get(bit);
        if (!entry) owned.set(bit, (entry = { kind, keys: new Map() }));
        if (entry.kind !== kind) {
          throw new AudioRomError(
            "E_SHADOW_CHIPS",
            `voice ${bit} of this game's music is written through both of this board's sound chips`,
            "a borrowable voice's registers have to live on one device for the driver to replay them; this is a bug in the channel tag, not in the track.",
          );
        }
        if (kind === "psg") {
          if (write.reg === PSG_STEREO_REG) continue;
          entry.keys.set(psgShadowSlot(write.value), 0);
        } else if (address >= 0) {
          entry.keys.set(address, half);
        }
      }
    }
  }

  const out: MdShadowChannel[] = [];
  let bytes = 0;
  for (const channel of [...owned.keys()].sort((a, b) => a - b)) {
    const entry = owned.get(channel) as { kind: "fm" | "psg"; keys: Map<number, number> };
    const keys = [...entry.keys.keys()].sort((a, b) => a - b);
    if (keys.length === 0) continue;
    const base = keys[0] as number;
    const length = (keys[keys.length - 1] as number) - base + 1;
    out.push({
      channel,
      kind: entry.kind,
      base,
      slot: bytes,
      length,
      // Ascending, so an FM voice's key register — `$28`, the lowest address any
      // voice writes — is stated first and its frequency last.
      writes: keys.map((key) => ({
        key,
        ...(entry.kind === "fm" ? { half: entry.keys.get(key) as number } : {}),
        slot: bytes + key - base,
      })),
    });
    bytes += length;
  }
  return out;
}

/**
 * What each copied byte holds before the music has said anything.
 *
 * The chip initialisation the ROM performs at boot, read the way the run walk
 * reads the music — because that is what those registers really hold at that
 * point, and the schedules have the boot prefix stripped off their first tick.
 * A tone voice makes it matter: silence on that chip is attenuation `$F`, so a
 * copy that started at zero would replay *full volume* on a voice the music had
 * not yet touched.
 */
export function mdShadowInit(
  boot: readonly { reg: number; value: number; chip?: number }[],
  plan: readonly MdShadowChannel[],
  bytes: number,
): number[] {
  const init = new Array<number>(bytes).fill(0);
  const psg = psgChannelTag();
  let latched = -1;
  for (const write of boot) {
    const chip = write.chip ?? 0;
    if (chip === PSG_CHIP) {
      const voices = psg(write.reg, write.value, chip);
      if (write.reg === PSG_STEREO_REG) continue;
      const slot = psgShadowSlot(write.value);
      for (const channel of plan) {
        if (channel.kind !== "psg") continue;
        const at = channel.writes.find((one) => one.key === slot);
        // The tag names the console's own voice numbering and a plan entry the
        // packed run format's, so membership is asked of the *slot* the boot
        // write lands in and the voice the latch selected.
        if (at !== undefined && voices !== 0) init[at.slot] = write.value & 0xff;
      }
      continue;
    }
    if ((write.reg & 1) === 0) {
      latched = write.value & 0xff;
      continue;
    }
    for (const channel of plan) {
      if (channel.kind !== "fm") continue;
      const at = channel.writes.find((one) => one.key === latched);
      if (at !== undefined) init[at.slot] = write.value & 0xff;
    }
  }
  return init;
}

/** Bytes a plan takes, which is what the driver's allocator is told. */
export function mdShadowBytes(plan: readonly MdShadowChannel[]): number {
  return plan.reduce((sum, channel) => sum + channel.length, 0);
}

/**
 * Check that an FM data byte always follows *its own* address byte.
 *
 * The driver keeps one latch and not one per bus half, which is only sound while
 * nothing writes an address on one half between an address and its data on the
 * other. The binding writes a register as an adjacent pair, so this holds — and
 * it is checked rather than assumed because if it stops holding, a borrowed voice
 * comes back with one register's value in another register's place, which is
 * exactly the shape of the bug this whole mechanism exists to fix.
 */
export function checkMdPairDiscipline(script: ChipScript): void {
  for (let tick = 0; tick < script.ticks.length; tick += 1) {
    let pending = -1;
    for (const write of script.ticks[tick]?.writes ?? []) {
      if ((write.chip ?? 0) === PSG_CHIP) continue;
      const half = (write.reg >> 1) & 1;
      if ((write.reg & 1) === 0) {
        if (pending >= 0 && pending !== half) {
          throw new AudioRomError(
            "E_FM_PAIR",
            `tick ${tick} of an audio schedule latches an FM address on both bus halves before writing either`,
            "the driver keeps one address latch, so an address must be followed by its own data byte; this is a bug in the binding, not in the track.",
          );
        }
        pending = half;
        continue;
      }
      pending = -1;
    }
  }
}

/**
 * Silence every voice on both chips.
 *
 * Four attenuation latches for the tone half, and a key-off for each of the six
 * FM voices — which is what "stop the music" means on this console, and is a very
 * different pair of gestures for two chips on one board.
 */
export function mdSilenceWrites(): { reg: number; value: number; chip: number }[] {
  const out: { reg: number; value: number; chip: number }[] = [];
  for (let voice = 0; voice < MD_FM_CHANNELS; voice += 1) {
    const encoded = voice < 3 ? voice : voice + 1;
    out.push({ reg: 0, value: 0x28, chip: YM_CHIP }, { reg: 1, value: encoded, chip: YM_CHIP });
  }
  for (let channel = 0; channel < 4; channel += 1) {
    out.push({ reg: 0, value: 0x9f | (channel << 5), chip: PSG_CHIP });
  }
  return out;
}

/**
 * The two writes that hand this board's sound hardware to the 68000.
 *
 * **`$A11200` is the FM chip's reset as well as the Z80's**, which is the one
 * fact about this console's audio that nothing on our side of the seam can see:
 * `@demake/md` models no Z80 at all — a demade cartridge emits no program for it
 * — so writing zero there is a register store like any other in that core, and
 * the FM voices go on answering. On the board, and in a core that models the
 * line, the whole YM2612 is held in reset and every one of its writes is
 * discarded. A cartridge that did it was **perfect in a register diff and silent
 * on the hardware**, which is the failure mode AGENTS.md §Gotchas names as a
 * description that is wrong and consistent, and doc 16's Level B is what found
 * it: against genesis-plus-gx a standalone track went from 0.00046 RMS to
 * 0.28203 when the reset was released.
 *
 * So the pair is: **take the bus and keep it**, because the FM chip is decoded
 * inside the Z80's address space and a demade cartridge ships no Z80 program, so
 * a sound processor left running would be a second writer on the bus this driver
 * is about to use; and **release the reset**, because that line is the chip's.
 * Holding the bus is what makes releasing the reset safe — the Z80 cannot fetch
 * an instruction while the 68000 has its bus, so it never runs whatever powered
 * up in its RAM.
 *
 * One definition with two callers, because a game and a standalone cartridge
 * need exactly the same two stores: `md.ts` performs them in its boot and
 * `md-game.ts` at the head of `AudioInit`, so a game with no audio still emits
 * neither (AGENTS.md §Iron rules — unused features leave no trace).
 *
 * Sources:
 * - Sega — Genesis Software Manual, §bus arbitration (`$A11100`, `$A11200`).
 * - Sega — YM2612 application manual: the chip's `!IC` line is the Z80's reset.
 */
export function emitZ80Handover(asm: Asm68k): void {
  asm.move("w", eaImm(0x0100), eaAbs(MD_Z80.BUS));
  asm.move("w", eaImm(0x0100), eaAbs(MD_Z80.RESET));
}

/** The two 68000-side registers that arbitrate for the sound processor's bus. */
export const MD_Z80 = { BUS: 0xa11100, RESET: 0xa11200 } as const;
