/**
 * The proof: a ROM built from a schedule writes that schedule (doc 16 §The proof).
 *
 * This is the audio counterpart of the image path's pixel-perfect emulator E2E,
 * and of `packages/demotic/test/rom.test.ts` for games — the same relationship,
 * one domain over. Where the image path compares a core's framebuffer against
 * `DAC(compliantImage)`, this compares the register stream an emulated APU
 * actually receives against the `ChipScript` itself. There is no tolerance and
 * no metric in it, because there does not need to be: the artifact *is* a timed
 * register-write schedule, so equality is the whole claim.
 *
 * Both demakers are here. A track and a sound effect stress different halves of
 * the driver — one loops and is thousands of ticks long, the other is a one-shot
 * that has to end in silence rather than repeat — and a suite that ran only the
 * first would pass with the stop path broken.
 */

import { describe, expect, it } from "vitest";

import {
  GBA_CHECK_END,
  GBA_CHECK_OFFSET,
  GBA_CHECK_START,
  GB_HEADER_OFFSETS,
  GB_ROM_SIZE,
  NES_CHR_SIZE,
  NES_HEADER_SIZE,
  NES_PRG_SIZES,
  mdChecksum,
  MD_CHECKSUM_START,
  MD_ROM_SIZES,
  PCE_BANK_SIZE,
  PCE_ROM_SIZES,
  segaChecksum,
  SMS_FLAT_ROM_SIZES,
  SMS_HEADER_OFFSET,
  SMS_HEADER_SIZE,
  SMS_IRQ_VECTOR,
  SMS_NMI_VECTOR,
  SMS_ROM_SIZE,
  WS_CODE_SIZE,
  WS_FOOTER_OFFSET,
  WS_ROM_SIZE,
} from "@demake/core";
import { GbaPcm } from "@demake/chip";
import { Gba } from "@demake/gba";
import { FRAME_CYCLES, Sms } from "@demake/sms";
import { CPU_HZ as WS_CPU_HZ } from "@demake/wsc";

import { arrangeScore } from "../src/arrange/index.js";
import { bindingFor } from "../src/binding/registry.js";
import { GBA_BLOCK_SAMPLES } from "../src/binding/gba.js";
import { sampleBank as gbaSampleBank } from "../src/binding/gba-bank.js";
import { WS_BANK_BYTES, WS_WAVE_BASE, wsWaveBank } from "../src/binding/wsc-bank.js";
import { wsWaveforms } from "../src/binding/wsc.js";
import type { ChipScript } from "../src/chipscript.js";
import { parseMidi } from "../src/score/midi.js";
import { demakeSfx } from "../src/sfx/index.js";
import { encodeWav } from "../src/encode/wav.js";
import { audioRomConsoles, buildAudioRom, packScript } from "../src/rom/index.js";
import { bandFixture, scaleFixture } from "./_fixtures.js";
import {
  AudioRomRunner,
  captureAgainstRom,
  captureRomWrites,
  firstDivergence,
} from "./_rom-harness.js";

/**
 * Ticks each case is proven over.
 *
 * Long enough to cross many block boundaries and every kind of opcode, short
 * enough that the whole suite stays inside `pnpm test`'s budget. The loop test
 * below is what covers the rest of the timeline, since a driver that is right
 * for six hundred ticks and wrong at tick 4000 would have to be wrong about the
 * order walk — which is exactly what looping exercises.
 */
const TICKS = 600;

/**
 * The 68000's clock, which is the master clock over seven.
 *
 * Here rather than imported because `@demake/md` exposes a frame's worth of
 * cycles and not the rate itself, and the one case that needs it is measuring a
 * timer period in CPU cycles.
 */
const MD_CPU_HZ = 53693175 / 7;

/** A short decaying blip, as a WAV — the sound demaker's input. */
function blipWav(): Uint8Array {
  const rate = 48000;
  const samples = new Float32Array(Math.floor(rate * 0.25));
  let phase = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const position = i / samples.length;
    phase += (2 * 3.141592653589793 * 880) / rate;
    // A plain triangle from the phase, so no transcendental is needed here.
    const wrapped = phase % (2 * 3.141592653589793);
    const triangle =
      wrapped < 3.141592653589793 ? wrapped / 3.141592653589793 : 2 - wrapped / 3.141592653589793;
    samples[i] = (triangle * 2 - 1) * (1 - position) * (1 - position);
  }
  return encodeWav({ sampleRate: rate, channels: [samples] });
}

function trackFor(consoleId: string): ChipScript {
  return arrangeScore(parseMidi(bandFixture()), { console: consoleId }).script;
}

describe("gb audio cartridge", () => {
  it("is a valid 32 KiB cartridge with correct checksums", async () => {
    const { bytes } = await buildAudioRom(trackFor("dmg"), { title: "BAND" });
    expect(bytes.length).toBe(GB_ROM_SIZE);
    let header = 0;
    for (let at = 0x0134; at <= 0x014c; at += 1) {
      header = (header - (bytes[at] as number) - 1) & 0xff;
    }
    expect(bytes[GB_HEADER_OFFSETS.headerChecksum]).toBe(header);
    expect(bytes[GB_HEADER_OFFSETS.cartridgeType]).toBe(0x00);
    expect(String.fromCharCode(...bytes.subarray(0x134, 0x138))).toBe("BAND");
    // The entry point is `nop; jp Start`, and the boot logo area stays zero
    // because we ship no copyrighted data.
    expect(bytes[0x0100]).toBe(0x00);
    expect(bytes[0x0101]).toBe(0xc3);
    expect(bytes.subarray(0x0104, 0x0134).every((byte) => byte === 0)).toBe(true);
  });

  it("refuses a console it has no driver for, rather than shipping silence", async () => {
    // A Super Nintendo has a driver *inside a game* and none of its own, which
    // is the distinction this refusal exists to keep: `demake build -c snes`
    // puts music in a cartridge and `demake gen --format rom` cannot, and a
    // builder that fell back to silence would make the two look the same. It is
    // also the near miss — `demake arrange -c snes` writes an `.spc`, which is
    // the same driver and the same schedule in a RAM image rather than a board.
    const script = arrangeScore(parseMidi(bandFixture()), { console: "snes" }).script;
    await expect(buildAudioRom(script)).rejects.toThrow(/no standalone audio driver backend/);
  });

  it("names the consoles it can build for", async () => {
    expect(audioRomConsoles()).toEqual(
      expect.arrayContaining(["dmg", "gbc", "nes", "pce", "sms", "gg", "md", "gba", "wsc", "ws"]),
    );
  });
});

describe("nes audio cartridge", () => {
  const built = () => buildAudioRom(trackFor("nes"));

  it("is an NROM cartridge on the smallest board that holds the track", async () => {
    const { bytes, stats, family, suffix } = await built();
    expect(family).toBe("nes");
    expect(suffix).toBe(".nes");
    expect(String.fromCharCode(...bytes.subarray(0, 3))).toBe("NES");
    expect(bytes[3]).toBe(0x1a);
    // Mapper zero, and the program on one of the two boards NROM shipped as.
    expect(bytes[7]! & 0xf0).toBe(0);
    expect(bytes[6]! & 0xf0).toBe(0);
    const prg = (bytes[4] as number) * 0x4000;
    expect(NES_PRG_SIZES).toContain(prg);
    expect(bytes.length).toBe(NES_HEADER_SIZE + prg + NES_CHR_SIZE);
    expect(stats.free).toBeGreaterThanOrEqual(0);
  });

  it("boots from a vector rather than an entry point", async () => {
    // There is no fixed entry address on this CPU, so the last six bytes of the
    // image are what makes the cartridge run at all — and a builder that left
    // them zero would produce something that jumps into the padding.
    const { bytes, symbols } = await built();
    const prg = (bytes[4] as number) * 0x4000;
    const at = NES_HEADER_SIZE + prg - 6;
    const read = (index: number) =>
      (bytes[at + index * 2] as number) | ((bytes[at + index * 2 + 1] as number) << 8);
    expect(read(0)).toBe(symbols.get("Nmi"));
    expect(read(1)).toBe(symbols.get("Reset"));
    expect(read(2)).toBe(symbols.get("Irq"));
    // Every vector inside the window the board is mapped at, which is what says
    // the small board's program was assembled at the origin its mirror needs.
    for (const index of [0, 1, 2]) expect(read(index)).toBeGreaterThanOrEqual(0x8000);
  });

  it("refuses a schedule whose clock is not the frame", async () => {
    // This CPU has no timer a driver can have without burning the DMC channel,
    // so a schedule fitted to anything else is a bug in the timing fit and is
    // named rather than rounded to something playable.
    const script = trackFor("nes");
    const timed = { ...script, driver: { ...script.driver, source: "timer" as const } };
    await expect(buildAudioRom(timed)).rejects.toThrow(/has no 'timer' clock/);
  });
});

describe("pce audio cartridge", () => {
  const built = () => buildAudioRom(trackFor("pce"));

  it("is a HuCard whose boot bank is the one reset maps", async () => {
    const { bytes, family, suffix } = await built();
    expect(family).toBe("pce");
    expect(suffix).toBe(".pce");
    expect(PCE_ROM_SIZES).toContain(bytes.length);
    // Reset takes its address from the last two bytes of bank 0, and the boot
    // stub is assembled at `$E000` — so a build that wrote the window's halves
    // in the obvious order would point this into the packed schedule.
    const reset =
      (bytes[PCE_BANK_SIZE - 2] as number) | ((bytes[PCE_BANK_SIZE - 1] as number) << 8);
    expect(reset).toBe(0xe000 + 0); // the first instruction of the boot stub
  });

  it("uploads the waveforms before the clock starts", async () => {
    // The failure this exists to catch is a cartridge that is perfect in a
    // register diff and silent on the machine: this chip's wave RAM is only
    // reachable through the register port, so a build that skipped the boot
    // table would play every note through an empty wavetable.
    const script = trackFor("pce");
    const boot = (await AudioRomRunner.create(script)).captureBoot();
    expect(boot).toEqual(
      bindingFor("pce")
        .init()
        .map((write) => ({ reg: write.reg, value: write.value, chip: write.chip ?? 0 })),
    );
    // And the schedule the ROM promises is the one with those writes taken off.
    expect(script.ticks[0]!.writes.length).toBeGreaterThan(boot.length);
  });

  it("refuses a schedule whose clock is not the timer", async () => {
    const script = trackFor("pce");
    const framed = { ...script, driver: { ...script.driver, source: "vblank" as const } };
    await expect(buildAudioRom(framed)).rejects.toThrow(/has no 'vblank' clock/);
  });
});

describe("sms audio cartridge", () => {
  it("stamps a header inside the image rather than around it", async () => {
    const { bytes, family, suffix } = await buildAudioRom(trackFor("sms"));
    expect(family).toBe("sms");
    expect(suffix).toBe(".sms");
    expect(SMS_FLAT_ROM_SIZES).toContain(bytes.length);
    expect(String.fromCharCode(...bytes.subarray(SMS_HEADER_OFFSET, SMS_HEADER_OFFSET + 8))).toBe(
      "TMR SEGA",
    );
    // The checksum covers everything *before* the header, which is what lets it
    // be written into the region it does not cover — so a builder that stamped
    // it first, or appended the header instead of overwriting, fails here.
    const sum = segaChecksum(bytes);
    expect(bytes[SMS_HEADER_OFFSET + 10]).toBe(sum & 0xff);
    expect(bytes[SMS_HEADER_OFFSET + 11]).toBe((sum >> 8) & 0xff);
  });

  it("declares which of the two machines it is", async () => {
    // Not decoration: `@demake/sms` reads this nibble to decide whether it is a
    // Game Gear, exactly as `@demake/dmg` reads the CGB flag — so a Game Gear
    // cartridge stamped as a Master System would pass the tick diff below while
    // playing on the wrong console, with its stereo latch reaching nothing.
    const region = async (script: ChipScript): Promise<number> =>
      ((await buildAudioRom(script)).bytes[SMS_HEADER_OFFSET + 15] as number) >> 4;
    expect(await region(trackFor("sms"))).toBe(4); // an exported Master System
    expect(await region(trackFor("gg"))).toBe(7); // an international Game Gear
    expect(new Sms((await buildAudioRom(trackFor("gg"))).bytes).gameGear).toBe(true);
  });

  it("places its handlers at the addresses the CPU goes to", async () => {
    // There is no vector table on this machine: the Z80 resets to `$0000` and
    // takes a maskable interrupt to `$0038` in mode 1, so these three routines
    // are not pointed at — they are *placed*, by padding the image out to them.
    // A build that emitted them in a different order would still assemble.
    const { bytes, symbols } = await buildAudioRom(trackFor("sms"));
    expect(symbols.get("Boot")).toBe(0);
    expect(symbols.get("Irq")).toBe(SMS_IRQ_VECTOR);
    expect(symbols.get("Nmi")).toBe(SMS_NMI_VECTOR);
    // `$0066` is the Pause button's, and this cartridge has nothing to do with
    // it — but padding there would be *run* the first time somebody pressed it.
    expect(bytes[SMS_NMI_VECTOR]).toBe(0xed);
    expect(bytes[SMS_NMI_VECTOR + 1]).toBe(0x45); // retn
  });

  it("ticks once a frame, which is what acknowledging the interrupt buys", async () => {
    // The failure this exists to catch is invisible to a register diff: a
    // handler that did not read the VDP's status byte would leave the interrupt
    // pending, re-enter the moment `ei` ran, and perform the whole schedule in a
    // few frames — every write correct, in order, and at ten thousand times the
    // tempo. So the assertion is about the *spacing*, in CPU cycles.
    const script = trackFor("sms");
    const built = await buildAudioRom(script);
    const machine = new Sms(built.bytes);
    const at = built.symbols.get("Tick") as number;
    const spans: number[] = [];
    let cycles = 0;
    while (spans.length < 12) {
      cycles += machine.stepInstruction();
      if (machine.cpu.pc === at) {
        spans.push(cycles);
        cycles = 0;
      }
    }
    // The first span is the boot, which is shorter; every one after it is a
    // frame, to within the instruction the interrupt happened to land on.
    for (const span of spans.slice(2)) expect(Math.abs(span - FRAME_CYCLES)).toBeLessThan(200);
  });

  it("refuses a schedule whose clock is not the frame", async () => {
    // This VDP reloads its line counter outside the active display, so the rates
    // its line interrupt appears to offer are not a tempo a driver can hold.
    const script = trackFor("sms");
    const timed = { ...script, driver: { ...script.driver, source: "timer" as const } };
    await expect(buildAudioRom(timed)).rejects.toThrow(/has no 'timer' clock/);
  });

  it("takes the larger board by stepping the data over the header", async () => {
    // The elastic-cartridge rule, and on this console it needs a mechanism: the
    // header is sixteen bytes *inside* the address space, so a schedule too big
    // for 32 KiB has to lay its blocks either side of the hole. Padding the
    // whole data section past `$7FF0` instead — which is what the game backend
    // does, because there the code is what fills that region — would throw away
    // thirty-two kilobytes and make the larger board unreachable: every schedule
    // big enough to need it would also be too big for what was left.
    let seed = 1;
    const draw = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16;
    const dense: ChipScript = {
      ...trackFor("sms"),
      // Distinct writes every tick, so nothing rests and nothing dedups.
      ticks: Array.from({ length: 9000 }, () => ({
        writes: [
          { reg: 0, value: 0x90 | (draw() & 0x0f) },
          { reg: 0, value: draw() & 0x3f },
        ],
      })),
      loopTick: 0,
    };
    const built = await buildAudioRom(dense);
    expect(built.bytes.length).toBeGreaterThan(SMS_ROM_SIZE);
    expect(SMS_FLAT_ROM_SIZES).toContain(built.bytes.length);
    expect(built.stats.free).toBeGreaterThanOrEqual(0);

    // No block may overlap the header, or `packSegaRom` stamps eight bytes of
    // "TMR SEGA" into the middle of the music.
    const data = packScript(dense, { port: () => 0x7f });
    for (let block = 0; block < data.blocks.length; block += 1) {
      const at = built.symbols.get(`Block0_${block}`) as number;
      const end = at + (data.blocks[block] as Uint8Array).length;
      const clear = end <= SMS_HEADER_OFFSET || at >= SMS_HEADER_OFFSET + SMS_HEADER_SIZE;
      expect(`block ${block} at $${at.toString(16)}..$${end.toString(16)}: ${clear}`).toContain(
        "true",
      );
    }
    // And it still plays, which is the half a layout check cannot see.
    const { expected, actual } = await captureAgainstRom(dense, 120);
    expect(firstDivergence(expected, actual)).toBeNull();
  });
});

describe("md audio cartridge", () => {
  const built = () => buildAudioRom(trackFor("md"));

  it("is a cartridge on the smallest board this console shipped that holds it", async () => {
    const { bytes, stats, family, suffix } = await built();
    expect(family).toBe("md");
    expect(suffix).toBe(".md");
    expect(MD_ROM_SIZES).toContain(bytes.length);
    expect(String.fromCharCode(...bytes.subarray(0x100, 0x110))).toBe("SEGA MEGA DRIVE ");
    expect(stats.free).toBeGreaterThanOrEqual(0);
    // The checksum covers everything from `$200`, so it can only be computed
    // once the image exists — and a builder that wrote it first would leave a
    // cartridge the boot ROM rejects.
    const sum = ((bytes[0x18e] as number) << 8) | (bytes[0x18f] as number);
    expect(sum).toBe(mdChecksum(bytes));
  });

  it("assembles where the cartridge puts it, not at zero", async () => {
    // Every absolute reference in this program — the order list, the boot table,
    // each `jsr` — is resolved at assembly time, and the code does not start at
    // the origin: the vectors and the header come first. A build assembled at
    // zero has a perfect symbol table and jumps two hundred bytes short of
    // everything, which is a cartridge that boots and executes its own title.
    const { bytes, symbols } = await built();
    const long = (at: number): number =>
      (((bytes[at] as number) << 24) |
        ((bytes[at + 1] as number) << 16) |
        ((bytes[at + 2] as number) << 8) |
        (bytes[at + 3] as number)) >>>
      0;
    const reset = symbols.get("Reset") as number;
    expect(reset).toBe(MD_CHECKSUM_START);
    // The first two longs of the image are the only part of a cartridge the
    // hardware reads without being asked: the stack, then where to start.
    expect(long(0)).toBe(0xfffffe);
    expect(long(4)).toBe(reset);
    expect(symbols.get("AudioBoot")).toBeGreaterThan(reset);
  });

  it("performs the chip's initialisation before it starts the clock", async () => {
    // Two claims in one, and the second is this console's alone. The chip's own
    // initialisation is performed from a table at boot — so the schedule the ROM
    // promises is shorter than the one it was handed — and it *has* to be,
    // because that initialisation writes `$27`, which is the timer control
    // register the driver's clock lives in. Left at the head of the stream, tick
    // 0 would stop the timer that was about to deliver tick 1.
    const script = trackFor("md");
    const runner = await AudioRomRunner.create(script);
    const boot = runner.captureBoot();
    const init = bindingFor("md").init();
    expect(boot.slice(0, init.length)).toEqual(
      init.map((write) => ({ reg: write.reg, value: write.value, chip: write.chip ?? 0 })),
    );
    // The timer is programmed after the table, and nothing else follows it.
    const after = boot.slice(init.length).filter((write) => write.chip === 0);
    expect(after.map((write) => write.value)).toEqual([
      0x24,
      (73 >> 2) & 0xff,
      0x25,
      73 & 0x03,
      0x27,
      0x05,
      0x27,
      0x15,
    ]);
    // And no tick may touch `$27` again, which is what the strip buys.
    for (const tick of runner.performed.ticks) {
      let latched = -1;
      for (const write of tick.writes) {
        if ((write.chip ?? 0) !== 0) continue;
        if ((write.reg & 1) === 0) latched = write.value;
        else expect(latched).not.toBe(0x27);
      }
    }
  });

  it("keeps the timer's rate rather than the loop's", async () => {
    // The claim this console's whole clock rests on, and the one a register diff
    // cannot make: a *game* here can only ride the frame, because polling the FM
    // chip's timer from a loop that is also running a game gives the loop's
    // rate. A cartridge whose loop does nothing else polls every few
    // microseconds, so what it keeps is the timer's — measured in CPU cycles,
    // against the period the schedule's own reload asks for.
    const script = trackFor("md");
    const runner = await AudioRomRunner.create(script);
    const at = (runner as unknown as { tickAddress: number }).tickAddress;
    const machine = runner.machine as unknown as { stepInstruction(): number; cpu: { pc: number } };
    const spans: number[] = [];
    let cycles = 0;
    while (spans.length < 12) {
      cycles += machine.stepInstruction();
      if (machine.cpu.pc === at) {
        spans.push(cycles);
        cycles = 0;
      }
    }
    const period = MD_CPU_HZ / (script.driver.rate.num / script.driver.rate.den);
    // Everything after the boot span is a timer period, to within one poll of
    // the status byte — which is what "the drift is bounded by one poll" means.
    for (const span of spans.slice(2)) expect(Math.abs(span - period)).toBeLessThan(200);
  });

  it("refuses a schedule whose clock is not the timer", async () => {
    const script = trackFor("md");
    const framed = { ...script, driver: { ...script.driver, source: "vblank" as const } };
    await expect(buildAudioRom(framed)).rejects.toThrow(/has no 'vblank' clock/);
  });
});

describe("wsc audio cartridge", () => {
  it("copies its waveforms into RAM before it plays a note", async () => {
    // The half no tick diff can see. This chip reads its tables out of the
    // console's own memory rather than a register file, so a cartridge that
    // skipped the copy would write every register of the schedule exactly and
    // play four channels of whatever powered up at `$0300` (`binding/wsc-bank.ts`).
    const script = trackFor("wsc");
    const runner = await AudioRomRunner.create(script);
    runner.captureBoot();
    const ram = (runner.machine as unknown as { ram: Uint8Array }).ram;
    const shapes = wsWaveforms(bindingFor("wsc").spec);
    expect([...ram.subarray(WS_WAVE_BASE, WS_WAVE_BASE + WS_BANK_BYTES)]).toEqual([
      ...wsWaveBank(shapes),
    ]);
  });

  it("says which of the two machines will run it", async () => {
    // These consoles differ in nothing a cartridge could otherwise record — same
    // CPU, same chip, same ports — so the footer's minimum-system byte is the
    // whole distinction, and a mono build stamped `1` is a cartridge the machine
    // it was arranged for refuses. `@demake/dmg`'s CGB flag inverted.
    const system = async (id: string): Promise<number> =>
      (await buildAudioRom(trackFor(id))).bytes[
        WS_ROM_SIZE - 64 * 1024 + WS_FOOTER_OFFSET + 1
      ] as number;
    expect(await system("ws")).toBe(0);
    expect(await system("wsc")).toBe(1);
  });

  it("takes the frame, and keeps it", async () => {
    // The clock this cartridge rests on, and the one a register diff cannot
    // check: the idle loop reads the vertical-blank timer's *counter* rather
    // than taking an interrupt, so a tally that read the wrong port, subtracted
    // the wrong way round or never saw the timer move would still perform every
    // write in order — at whatever rate the loop happened to run at.
    const script = trackFor("wsc");
    const runner = await AudioRomRunner.create(script);
    const machine = runner.machine as unknown as { stepInstruction(): number; cpu: { ip: number } };
    const at = (runner as unknown as { tickAddress: number }).tickAddress;
    const spans: number[] = [];
    let cycles = 0;
    while (spans.length < 8) {
      cycles += machine.stepInstruction();
      if (machine.cpu.ip === at) {
        spans.push(cycles);
        cycles = 0;
      }
    }
    const period = WS_CPU_HZ / (script.driver.rate.num / script.driver.rate.den);
    // Everything after the boot span is a frame, to within one pass of a loop
    // that does nothing but poll — which is what makes this cartridge's drift
    // smaller than a game's on the same hardware without being a finer rate.
    for (const span of spans.slice(2)) expect(Math.abs(span - period)).toBeLessThan(period / 20);
  });

  it("leaves the program inside the bank the reset jump points at", async () => {
    const { bytes, family, suffix } = await buildAudioRom(trackFor("wsc"));
    expect(family).toBe("wsc");
    expect(suffix).toBe(".wsc");
    expect(bytes.length).toBe(WS_ROM_SIZE);
    // `packWsRom` puts `jmp $F000:$0000` at `$FFF0` of the last bank, so a build
    // that ran past `$FFF0` would have its own code overwritten by the entry.
    const bank = WS_ROM_SIZE - 64 * 1024;
    expect(bytes[bank + WS_CODE_SIZE]).toBe(0xea);
  });
});

describe("gba audio cartridge", () => {
  it("is a bootable cartridge whose first word branches over the header", async () => {
    const { bytes, family, suffix } = await buildAudioRom(trackFor("gba"));
    expect(family).toBe("gba");
    expect(suffix).toBe(".gba");
    // A cartridge is at least one 32 KiB block and this one fits in it.
    expect(bytes.length % 0x8000).toBe(0);
    // `b` in ARM: condition `al`, and bits 27–25 are `101`.
    expect(bytes[3]).toBe(0xea);
    // The fixed byte the BIOS checks even on a direct boot, and the complement
    // of the header it checks with it.
    expect(bytes[0xb2]).toBe(0x96);
    let sum = 0;
    for (let at = GBA_CHECK_START; at <= GBA_CHECK_END; at += 1)
      sum = (sum - (bytes[at] as number)) & 0xff;
    expect(bytes[GBA_CHECK_OFFSET]).toBe((sum - 0x19) & 0xff);
    // The Nintendo logo area stays zero: we ship no copyrighted data, and a
    // direct boot never looks at it.
    expect(bytes.subarray(0x04, 0xa0).every((byte) => byte === 0)).toBe(true);
  });

  it("takes the transfer's clock, which is the only rate this console has", async () => {
    // The one `fitRate` in the set that does not search, and the reason is the
    // mixer: a driver tick *is* a block of samples the processor computes, and
    // a block is what the sample transfer's interrupt counts out. So a schedule
    // fitted for this console is at 128 Hz whatever tempo asked for, and a
    // cartridge that rode a timer instead would perform every write correctly
    // and compute every mixer sample for the wrong moment.
    const binding = bindingFor("gba");
    for (const asked of [40, 56, 120, 128, 240, 600]) {
      const fit = binding.fitRate(asked);
      expect(fit.rate.num / fit.rate.den).toBe(128);
    }
    const script = trackFor("gba");
    expect(script.driver.rate.num / script.driver.rate.den).toBe(128);
    const built = await buildAudioRom(script);
    expect(built.stats.ratePpmError).toBe(0);
  });

  it("delivers exactly the samples the mixer model renders", async () => {
    // The half no register diff can see, and the sharper of this console's two
    // proofs. Six of its ten voices are `@demake/chip`'s `GbaPcm` — a register
    // file in work RAM that crosses no bus — so what the driver owes there is
    // the *samples*, byte for byte, against what the model renders from the same
    // schedule (doc 16 §The proof, for a mixer console). It is the game
    // driver's proof (`demotic/test/audio-gba.test.ts`) for the cartridge that
    // has no game in it.
    const script = trackFor("gba");
    const runner = await AudioRomRunner.create(script);
    const machine = new Gba(runner.rom);
    // Both sides, because they are two transfers rather than one signal split —
    // the only way a driver can get them out of step is by re-pointing one at a
    // block boundary the other has not reached, which a one-sided test misses.
    const heard: [number[], number[]] = [[], []];
    machine.fifoTap = (channel, byte) => {
      (heard[channel] as number[]).push(byte);
    };
    for (let frame = 0; frame < 120; frame += 1) machine.runFrame();

    // The boot writes are performed once by the ROM rather than at the head of
    // the stream, so they go into the model first — `runner.performed` is the
    // schedule with them taken off, and with the mixer's own writes filtered out
    // of the register half, which is why the chip-1 stream is read off the
    // *input* schedule here.
    const model = new GbaPcm({ bank: gbaSampleBank() });
    for (const write of bindingFor("gba").init()) {
      if ((write.chip ?? 0) === 1) model.write(write.reg, write.value);
    }
    const want: [number[], number[]] = [[], []];
    const blocks = 60;
    for (let index = 0; index < blocks; index += 1) {
      for (const write of script.ticks[index]?.writes ?? []) {
        if ((write.chip ?? 0) === 1) model.write(write.reg, write.value);
      }
      // The converter takes a signed byte and the queue reports what crossed it,
      // which is the same byte read unsigned.
      for (let sample = 0; sample < GBA_BLOCK_SAMPLES; sample += 1) {
        const { left, right } = model.mix();
        want[0].push(left & 0xff);
        want[1].push(right & 0xff);
      }
    }
    // Not silence, or this compares nothing with nothing: the arranger gives
    // each part the channel that serves it best, and a track whose parts all
    // landed on the Game Boy half would pass here on a driver that never mixed.
    expect(want[0].some((value) => value !== 0x80 && value !== 0)).toBe(true);

    // Where the driver's own first block landed. A whole number of blocks in by
    // construction — a transfer is re-pointed on a block boundary and nowhere
    // else — so this is a search over blocks rather than samples, and that it
    // *is* one is part of what this asserts. The same offset has to serve both
    // sides, which is the other half of it.
    const left = heard[0] as number[];
    let offset = -1;
    for (
      let block = 0;
      (block + 1) * GBA_BLOCK_SAMPLES <= left.length - want[0].length;
      block += 1
    ) {
      const at = block * GBA_BLOCK_SAMPLES;
      if (left.slice(at, at + GBA_BLOCK_SAMPLES * 4).every((value, i) => value === want[0][i])) {
        offset = at;
        break;
      }
    }
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(left.slice(offset, offset + want[0].length)).toEqual(want[0]);
    expect((heard[1] as number[]).slice(offset, offset + want[1].length)).toEqual(want[1]);
  });
});

describe("Level A — the ROM writes exactly the schedule", async () => {
  it.each(audioRomConsoles())("plays an arranged track tick for tick on %s", async (consoleId) => {
    const script = trackFor(consoleId);
    const wanted = Math.min(TICKS, script.ticks.length);
    // Against what the ROM *promises* rather than what it was handed, which is
    // the same distinction every game driver's `performed` makes: a console that
    // uploads its waveforms at boot has a shorter tick 0 than the demaker gave
    // it, and the writes are not missing — they happened before the clock did.
    const { expected, actual } = await captureAgainstRom(script, wanted);
    expect(firstDivergence(expected, actual)).toBeNull();
  });

  it("plays a monophonic track tick for tick", async () => {
    const script = arrangeScore(parseMidi(scaleFixture()), { console: "dmg" }).script;
    const wanted = Math.min(TICKS, script.ticks.length);
    expect(
      firstDivergence(script.ticks.slice(0, wanted), await captureRomWrites(script, wanted)),
    ).toBeNull();
  });

  it.each(audioRomConsoles())(
    "plays a demade sound effect tick for tick on %s, and then stops",
    async (consoleId) => {
      // The other half of the driver, and worth having per console rather than
      // once: a one-shot has to end in silence rather than repeat, and where a
      // stream *ends* is the order walk's business — which is the processor's,
      // so two consoles sharing a player still have their own boot and clock in
      // front of it. A suite that ran only tracks would pass with the stop path
      // broken on any of them.
      const script = (await demakeSfx(blipWav(), { console: consoleId })).script;
      expect(script.loopTick).toBe(-1);
      const runner = await AudioRomRunner.create(script);
      const captured = runner.capture(runner.performed.ticks.length + 20);
      const total = runner.performed.ticks.length;
      expect(firstDivergence(runner.performed.ticks, captured.slice(0, total))).toBeNull();
      expect(captured.slice(total + 1).flatMap((tick) => tick.writes)).toEqual([]);
    },
  );

  it("returns to the loop point instead of running off the end", async () => {
    const script = arrangeScore(parseMidi(scaleFixture()), { console: "dmg" }).script;
    const total = script.ticks.length;
    // Two ticks past the end is enough: the order list runs out exactly there,
    // and where it resumes is the only thing looping can get wrong.
    const captured = await captureRomWrites(script, total + 3);
    const after = captured.slice(total);
    const expected = script.ticks.slice(script.loopTick, script.loopTick + after.length);
    expect(firstDivergence(expected, after)).toBeNull();
  });

  it("a one-shot ends in silence and stays there", async () => {
    const script = (await demakeSfx(blipWav(), { console: "dmg" })).script;
    const total = script.ticks.length;
    const captured = await captureRomWrites(script, total + 40);
    // The stop block powers every DAC down once, then rests forever. Whatever
    // it writes, nothing may sound again — a note-on after the effect ended
    // would be the failure this exists to catch.
    const trailing = captured.slice(total + 1).flatMap((tick) => tick.writes);
    expect(trailing).toEqual([]);
    const silence = captured[total]!.writes;
    expect(silence.length).toBeGreaterThan(0);
    for (const write of silence) expect(write.value & 0xf8).toBe(0);
  });
});

describe("the packed schedule", () => {
  it("deduplicates repeated blocks and stays inside the cartridge", async () => {
    const script = trackFor("dmg");
    const data = packScript(script);
    expect(data.blocks.length).toBeLessThanOrEqual(data.order.length);
    expect(data.ticks).toBe(script.ticks.length);
    const built = await buildAudioRom(script);
    expect(built.stats.code + built.stats.data).toBeLessThanOrEqual(GB_ROM_SIZE);
    expect(built.stats.free).toBeGreaterThan(0);
    // Silence is where the format earns its keep: a bar of nothing is two bytes.
    expect(built.stats.data).toBeLessThan(script.budgets.writes * 2 + script.ticks.length);
  });

  it("emits no rest handling for a schedule that never rests", async () => {
    const dense: ChipScript = {
      ...trackFor("dmg"),
      ticks: Array.from({ length: 8 }, () => ({ writes: [{ reg: 0x12, value: 0xf0 }] })),
      loopTick: 0,
    };
    const built = await buildAudioRom(dense);
    expect(built.stats.helpers).not.toContain("rests");
    expect(built.symbols.has("TickRest")).toBe(false);
    // And it still plays: the pull is an optimisation, not a behaviour change.
    expect(
      firstDivergence(dense.ticks, await captureRomWrites(dense, dense.ticks.length)),
    ).toBeNull();
  });

  it("runs the driver on the timer the schedule asked for", async () => {
    const script = trackFor("dmg");
    const built = await buildAudioRom(script);
    expect(built.stats.ratePpmError).toBe(0);
    expect(built.stats.helpers).toContain(
      script.driver.source === "timer" ? "timer-clock" : "vblank-clock",
    );
  });

  it("keeps ticking after the driver has been running for a while", async () => {
    // A regression net for the one thing a short capture cannot see: state that
    // drifts. The runner asserts progress itself by refusing to stop early.
    const script = trackFor("dmg");
    const runner = await AudioRomRunner.create(script);
    const captured = runner.capture(Math.min(script.ticks.length, 1200));
    expect(captured.length).toBe(Math.min(script.ticks.length, 1200));
  });
});
