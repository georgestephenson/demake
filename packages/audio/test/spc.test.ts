/**
 * The proof, on the console whose driver is a whole second program.
 *
 * `rom.test.ts` boots a Game Boy cartridge and diffs the register stream its APU
 * receives against the `ChipScript`. This does the same one machine over, and the
 * machine is the interesting part: the driver here does not run on the console's
 * processor at all, so what is booted is the *sound processor* — its own upload
 * handshake, its own timer, its own program — and the writes compared are the
 * ones the S-DSP receives from it.
 *
 * It is deliberately below `packages/demotic/test/audio.test.ts`, which proves
 * the same driver inside a game. A failure here names the driver; a failure there
 * could be the driver, the cartridge's upload, or the game's request protocol.
 */

import { Smp } from "@demake/snes";
import { describe, expect, it } from "vitest";

import { arrangeScore } from "../src/arrange/index.js";
import type { ChipScript } from "../src/chipscript.js";
import { encodeSpc } from "../src/encode/spc.js";
import { encodeWav } from "../src/encode/wav.js";
import { parseMidi } from "../src/score/midi.js";
import { buildSpcGameAudio, SPC_PORT, STOP as SPC_STOP } from "../src/rom/spc-game.js";
import { demakeSfx } from "../src/sfx/index.js";
import { bandFixture } from "./_fixtures.js";

/** Ticks each case is proven over; long enough to cross many blocks. */
const TICKS = 400;

/** Master cycles per SPC700 cycle, near enough for a harness. */
const MASTER_PER_SPC = 21;

function track(): ChipScript {
  return arrangeScore(parseMidi(bandFixture()), { console: "snes", driverHz: 125 }).script;
}

/** A short decaying blip, as a WAV — the sound demaker's input. */
function blipWav(): Uint8Array {
  const rate = 48000;
  const samples = new Float32Array(Math.floor(rate * 0.25));
  let phase = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const position = i / samples.length;
    phase += (2 * 3.141592653589793 * 880) / rate;
    const wrapped = phase % (2 * 3.141592653589793);
    const triangle =
      wrapped < 3.141592653589793 ? wrapped / 3.141592653589793 : 2 - wrapped / 3.141592653589793;
    samples[i] = (triangle * 2 - 1) * (1 - position) * (1 - position);
  }
  return encodeWav({ sampleRate: rate, channels: [samples] });
}

/** The main CPU's half of the upload handshake, driven directly. */
function upload(smp: Smp, address: number, data: Uint8Array, entry: number): void {
  const settle = (): void => smp.run(200 * MASTER_PER_SPC);
  let guard = 0;
  const wait = (want: number): void => {
    while (smp.readPort(0) !== want) {
      settle();
      if ((guard += 1) > 100000) throw new Error("spc: the boot ROM never answered");
    }
  };
  while (smp.readPort(0) !== 0xaa || smp.readPort(1) !== 0xbb) settle();
  smp.writePort(2, address & 0xff);
  smp.writePort(3, (address >> 8) & 0xff);
  smp.writePort(1, 0x01);
  smp.writePort(0, 0xcc);
  wait(0xcc);
  let counter = 0;
  for (const byte of data) {
    smp.writePort(1, byte);
    smp.writePort(0, counter);
    wait(counter);
    counter = (counter + 1) & 0xff;
  }
  smp.writePort(2, entry & 0xff);
  smp.writePort(3, (entry >> 8) & 0xff);
  smp.writePort(1, 0x00);
  smp.writePort(0, (counter + 1) & 0xff);
  settle();
}

/** One tick's worth of register writes, as the chip received them. */
type Writes = { reg: number; value: number }[];

/**
 * Boot a driver and collect the writes it performs, tick by tick.
 *
 * Ticks are attributed by *program counter* — the `AudioTick` symbol from the
 * build's own symbol table — so nothing is added to the driver to make it
 * observable, exactly as the Game Boy harness does it.
 */
function capture(
  driver: ReturnType<typeof buildSpcGameAudio>,
  ticks: number,
  post?: { music?: number; sfx?: number; atTick?: number },
): Writes[] {
  const smp = new Smp();
  upload(smp, driver.address, driver.image, driver.entry);

  const tickPc = driver.symbols.get("AudioTick") as number;
  const out: Writes[] = [];
  let current: Writes | undefined;
  let sequence = 0;
  let posted = post === undefined;

  smp.dspTap = (reg, value) => current?.push({ reg, value });

  // Step the processor one instruction at a time so a tick boundary can be seen
  // the instant it happens.
  let guard = 0;
  while (out.length < ticks) {
    if (smp.pc === tickPc) {
      if (current !== undefined) out.push(current);
      current = [];
      if (!posted && out.length >= (post?.atTick ?? 0)) {
        smp.writePort(SPC_PORT.music, post?.music ?? 0);
        smp.writePort(SPC_PORT.sfx, post?.sfx ?? 0);
        sequence = (sequence + 1) & 0xff;
        smp.writePort(SPC_PORT.sequence, sequence);
        posted = true;
      }
    }
    smp.run(MASTER_PER_SPC);
    if ((guard += 1) > 40_000_000) throw new Error("spc: the driver stopped ticking");
  }
  return out;
}

/** Where two write streams first differ, as a readable message. */
function firstDivergence(got: Writes[], want: Writes[], from = 0): string | undefined {
  for (let tick = from; tick < want.length && tick < got.length; tick += 1) {
    const a = got[tick] as Writes;
    const b = want[tick] as Writes;
    if (a.length !== b.length) {
      return `tick ${tick}: ${a.length} writes, expected ${b.length}`;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (a[index]!.reg !== b[index]!.reg || a[index]!.value !== b[index]!.value) {
        return `tick ${tick} write ${index}: ${hex(a[index]!)} expected ${hex(b[index]!)}`;
      }
    }
  }
  return undefined;
}

function hex(write: { reg: number; value: number }): string {
  return `$${write.reg.toString(16).padStart(2, "0")}=$${write.value.toString(16).padStart(2, "0")}`;
}

describe("the SPC700 driver", () => {
  it("performs a track's schedule tick for tick", () => {
    const driver = buildSpcGameAudio({ tracks: [track()], effects: [], autoStart: 1 });
    const performed = driver.performed.tracks[0] as ChipScript;
    const got = capture(driver, TICKS);
    const want = performed.ticks.slice(0, TICKS).map((tick) => [...tick.writes]);
    expect(firstDivergence(got, want)).toBeUndefined();
  });

  it("starts a track when the game posts a request", () => {
    const driver = buildSpcGameAudio({ tracks: [track()], effects: [] });
    const performed = driver.performed.tracks[0] as ChipScript;
    // No `autoStart`, so the first ticks are silent and the schedule begins when
    // the request lands — which is what a scene change looks like.
    const got = capture(driver, 120, { music: 1, atTick: 8 });
    expect(got.slice(0, 8).every((tick) => tick.length === 0)).toBe(true);
    const started = got.findIndex((tick) => tick.length > 0);
    expect(started).toBeGreaterThan(0);
    const want = performed.ticks.slice(0, 60).map((tick) => [...tick.writes]);
    expect(firstDivergence(got.slice(started), want.slice(0, 40))).toBeUndefined();
  });

  it("stops the music and silences every voice", () => {
    const driver = buildSpcGameAudio({ tracks: [track()], effects: [], autoStart: 1 });
    const got = capture(driver, 80, { music: SPC_STOP, atTick: 20 });
    const after = got.slice(30).flat();
    expect(after).toHaveLength(0);
    // The silence pass writes one `GAIN` per voice, all zero — eight of them,
    // in the tick the request landed on, after whatever the music was mid-way
    // through saying.
    const silencing = got
      .slice(20, 30)
      .flat()
      .filter((write) => (write.reg & 0x0f) === 0x07 && write.value === 0);
    expect(silencing).toHaveLength(8);
  });

  it("lets an effect borrow a voice and gives it back", async () => {
    const music = track();
    const effect = await demakeSfx(blipWav(), { console: "snes", rateHz: 125 });
    const driver = buildSpcGameAudio({
      tracks: [music],
      effects: [{ script: effect.script, channel: 0, priority: 8 }],
    });
    const got = capture(driver, 200, { music: 1, sfx: 1, atTick: 4 });
    const voice0 = got.flat().filter((write) => write.reg < 0x0a);
    expect(voice0.length).toBeGreaterThan(0);
    // The release writes the borrowed voice's `GAIN` to zero exactly once the
    // effect's order list runs out.
    const released = got.findIndex((tick) =>
      tick.some((write) => write.reg === 0x07 && write.value === 0),
    );
    expect(released).toBeGreaterThan(4);
  });

  it("writes an SPC file a player can load", () => {
    const bytes = encodeSpc(track(), { title: "BAND" });
    expect(bytes.length).toBe(0x100 + 0x10000 + 128 + 64);
    expect(String.fromCharCode(...bytes.subarray(0, 33))).toBe("SNES-SPC700 Sound File Data v0.30");
    expect(bytes[0x21]).toBe(0x1a);
    expect(bytes[0x22]).toBe(0x1a);
    // The program counter is where the driver was assembled, and the RAM under
    // it is the block a cartridge would have uploaded.
    const pc = (bytes[0x25] as number) | ((bytes[0x26] as number) << 8);
    expect(pc).toBe(0x0300);
    expect(bytes[0x100 + 0x0300]).not.toBe(0);
  });
});
