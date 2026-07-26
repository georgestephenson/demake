/**
 * VGM encoding — the primary artifact (doc 16 §Artifacts).
 *
 * VGM *is* a timestamped register log, so this is a format match rather than an
 * export: a `ChipScript` and a `.vgm` are the same idea, and the file plays in
 * every chip-music player that exists. A demade track is therefore listenable by
 * people who have never installed demake, and inspectable by anyone who wants to
 * check what the hardware was actually told to do.
 *
 * The one rounding caveat doc 16 records lives here. VGM measures time in
 * 1/44100 s units, and a driver tick rarely lands on a whole number of them —
 * a Game Boy frame is 738.35. Waits are therefore computed from each tick's
 * *absolute* position rather than accumulated, so the error stays under half a
 * sample (≈11 µs) forever instead of compounding. Exact tick timing travels in
 * the manifest, which is what `gen` reads.
 *
 * Reference: VGM specification 1.71 — https://vgmrips.net/wiki/VGM_Specification
 */

import type { ChipScript } from "../chipscript.js";

/** VGM's fixed timebase, in samples per second. */
const VGM_RATE = 44100;

export interface VgmOptions {
  /** GD3 track title. */
  title?: string;
  /** GD3 system name; defaults to the console id. */
  system?: string;
  /** GD3 author/notes line. */
  notes?: string;
}

/** Encode a script as a VGM 1.71 file. */
export function encodeVgm(script: ChipScript, options: VgmOptions = {}): Uint8Array {
  const chip = script.chips[0];
  const emit = commandWriter(chip);
  if (!emit) throw new Error(`no VGM chip command for '${String(chip)}'`);

  const data: number[] = [];
  let loopOffset = -1;
  let emittedSamples = 0;

  for (let tick = 0; tick < script.ticks.length; tick += 1) {
    if (tick === script.loopTick) loopOffset = data.length;
    for (const write of script.ticks[tick]!.writes) emit(data, write.reg, write.value);
    // Absolute placement: this tick ends at `sampleAt(tick + 1)`, so any
    // rounding is against the ideal position rather than against the last wait.
    const target = sampleAt(script, tick + 1);
    pushWait(data, target - emittedSamples);
    emittedSamples = target;
  }
  data.push(0x66); // end of sound data

  const totalSamples = emittedSamples;
  const gd3 = encodeGd3(script, options);
  const headerSize = 0x100;
  const gd3Offset = gd3.length > 0 ? headerSize + data.length : 0;

  const out = new Uint8Array(headerSize + data.length + gd3.length);
  const view = new DataView(out.buffer);
  writeAscii(out, 0, "Vgm ");
  view.setUint32(0x04, out.length - 4, true); // EOF offset
  view.setUint32(0x08, 0x171, true); // version 1.71
  view.setUint32(0x14, gd3Offset === 0 ? 0 : gd3Offset - 0x14, true);
  view.setUint32(0x18, totalSamples, true);
  if (loopOffset >= 0) {
    view.setUint32(0x1c, headerSize + loopOffset - 0x1c, true);
    view.setUint32(0x20, totalSamples - sampleAt(script, script.loopTick), true);
  }
  view.setUint32(0x24, Math.round(script.driver.rate.num / script.driver.rate.den), true);
  view.setUint32(0x34, headerSize - 0x34, true); // data offset
  writeClock(view, chip);

  out.set(Uint8Array.from(data), headerSize);
  if (gd3.length > 0) out.set(gd3, headerSize + data.length);
  return out;
}

/** Absolute VGM sample position of a driver tick. */
function sampleAt(script: ChipScript, tick: number): number {
  const { num, den } = script.driver.rate;
  return Math.round((tick * VGM_RATE * den) / num);
}

/** Emit wait commands totalling `samples`. */
function pushWait(data: number[], samples: number): void {
  let remaining = samples;
  while (remaining > 65535) {
    data.push(0x61, 0xff, 0xff);
    remaining -= 65535;
  }
  if (remaining <= 0) return;
  if (remaining <= 16) {
    data.push(0x70 + (remaining - 1));
    return;
  }
  data.push(0x61, remaining & 0xff, (remaining >> 8) & 0xff);
}

/** The per-chip command encoder, or `undefined` for a chip VGM cannot carry. */
function commandWriter(
  chip: string | undefined,
): ((data: number[], reg: number, value: number) => void) | undefined {
  switch (chip) {
    case "gb-apu":
      // 0xB3: Game Boy DMG, register offset from $FF10; wave RAM is 0x20–0x2F.
      return (data, reg, value) => {
        const address = reg >= 0x30 ? 0x20 + (reg - 0x30) : reg - 0x10;
        data.push(0xb3, address & 0xff, value & 0xff);
      };
    case "sn76489":
      // 0x50 is the data port; 0x4F is the Game Gear stereo latch.
      return (data, reg, value) => {
        data.push(reg === 0x06 ? 0x4f : 0x50, value & 0xff);
      };
    case "nes-apu":
      // 0xB4: NES APU, register offset from $4000.
      return (data, reg, value) => {
        data.push(0xb4, reg & 0xff, value & 0xff);
      };
    default:
      return undefined;
  }
}

/** Fill in the header's chip-clock field, which selects the chip on playback. */
function writeClock(view: DataView, chip: string | undefined): void {
  switch (chip) {
    case "gb-apu":
      view.setUint32(0x80, 4194304, true);
      break;
    case "sn76489":
      view.setUint32(0x0c, 3579545, true);
      break;
    case "nes-apu":
      view.setUint32(0x84, 1789773, true);
      break;
    default:
      break;
  }
}

/** GD3 metadata: UTF-16LE, eleven NUL-terminated fields. */
function encodeGd3(script: ChipScript, options: VgmOptions): Uint8Array {
  const fields = [
    options.title ?? "",
    "",
    "",
    "",
    options.system ?? script.console,
    "",
    "",
    "",
    "",
    "demake",
    options.notes ?? "",
  ];
  const body: number[] = [];
  for (const field of fields) {
    for (let i = 0; i < field.length; i += 1) {
      const code = field.charCodeAt(i);
      body.push(code & 0xff, (code >> 8) & 0xff);
    }
    body.push(0, 0);
  }
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  writeAscii(out, 0, "Gd3 ");
  view.setUint32(4, 0x100, true);
  view.setUint32(8, body.length, true);
  out.set(Uint8Array.from(body), 12);
  return out;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
}
