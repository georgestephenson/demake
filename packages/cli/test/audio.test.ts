/**
 * `demake arrange`, `demake sfx` and `demake render` through the CLI (doc 05).
 *
 * Exercises the surface a user actually touches: the prime directive (one input,
 * one artifact), the JSON report an agent reads, `--strict`, and the chain that
 * matters most — arrange, keep the schedule, render it back, and get audio.
 */

import { describe, expect, it } from "vitest";

import { encodeWav } from "@demake/audio";
import { math } from "@demake/core";

import { run } from "../src/run.js";
import type { CliEnv } from "../src/env.js";

/** A CliEnv backed by an in-memory filesystem. */
function makeEnv(files: Record<string, Uint8Array>): CliEnv & {
  stdout: string;
  stderr: string;
  written: Record<string, Uint8Array>;
} {
  const written: Record<string, Uint8Array> = {};
  const env = {
    stdout: "",
    stderr: "",
    written,
    out(text: string) {
      env.stdout += text;
    },
    errOut(text: string) {
      env.stderr += text;
    },
    writeStdout() {
      throw new Error("binary to stdout is not exercised here");
    },
    readFile(path: string): Uint8Array {
      const bytes = files[path] ?? written[path];
      if (!bytes) throw new Error(`ENOENT ${path}`);
      return bytes;
    },
    writeFileAtomic(path: string, bytes: Uint8Array) {
      written[path] = bytes;
    },
    readStdin: () => null,
    stdoutIsTTY: () => true,
    stdinIsTTY: () => true,
    env: {},
    which: () => null,
    run: () => ({ code: 1, stdout: "", stderr: "" }),
    makeTempDir: () => "/tmp/none",
    removeDir: () => {},
    harnessDir: () => null,
  };
  return env as CliEnv & { stdout: string; stderr: string; written: Record<string, Uint8Array> };
}

/** A four-bar MIDI: bass, chords, melody and drums. */
function bandMidi(bpm = 140): Uint8Array {
  const ppq = 480;
  const events: { tick: number; bytes: number[] }[] = [];
  const note = (channel: number, pitch: number, tick: number, length: number, velocity = 100) => {
    events.push({ tick, bytes: [0x90 | channel, pitch, velocity] });
    events.push({ tick: tick + length, bytes: [0x80 | channel, pitch, 0] });
  };
  for (let bar = 0; bar < 4; bar += 1) {
    const base = bar * ppq * 4;
    for (let beat = 0; beat < 4; beat += 1) note(1, 36, base + beat * ppq, ppq - 20, 110);
    for (const pitch of [60, 64, 67]) note(2, pitch, base, ppq * 4 - 20, 70);
    [72, 74, 76, 74, 77, 76, 74, 72].forEach((pitch, i) =>
      note(3, pitch, base + (i * ppq) / 2, ppq / 2 - 10, 100),
    );
    for (let eighth = 0; eighth < 8; eighth += 1) {
      note(9, 42, base + (eighth * ppq) / 2, 10, 70);
      if (eighth % 4 === 0) note(9, 36, base + (eighth * ppq) / 2, 10, 120);
    }
  }
  const us = Math.round(60000000 / bpm);
  events.unshift({
    tick: 0,
    bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff],
  });
  events.sort((a, b) => a.tick - b.tick);

  const varint = (value: number): number[] => {
    if (value === 0) return [0];
    const bytes: number[] = [];
    let rest = value;
    while (rest > 0) {
      bytes.unshift(rest & 0x7f);
      rest >>= 7;
    }
    for (let i = 0; i < bytes.length - 1; i += 1) bytes[i]! |= 0x80;
    return bytes;
  };
  const track: number[] = [];
  let previous = 0;
  for (const event of events) {
    track.push(...varint(event.tick - previous), ...event.bytes);
    previous = event.tick;
  }
  track.push(0, 0xff, 0x2f, 0x00);
  return Uint8Array.from([
    0x4d,
    0x54,
    0x68,
    0x64,
    0,
    0,
    0,
    6,
    0,
    0,
    0,
    1,
    (ppq >> 8) & 0xff,
    ppq & 0xff,
    0x4d,
    0x54,
    0x72,
    0x6b,
    (track.length >> 24) & 0xff,
    (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff,
    track.length & 0xff,
    ...track,
  ]);
}

/** A short rising sweep, as a WAV. */
function sweepWav(): Uint8Array {
  const rate = 48000;
  const length = Math.floor(0.3 * rate);
  const samples = new Float32Array(length);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const position = i / length;
    phase += (2 * 3.141592653589793 * (300 + 1100 * position)) / rate;
    samples[i] = math.sin(phase) * (1 - position);
  }
  return encodeWav({ sampleRate: rate, channels: [samples] });
}

describe("demake arrange", () => {
  it("writes one artifact, a preview and a manifest", async () => {
    const env = makeEnv({ "band.mid": bandMidi() });
    const code = await run(
      [
        "arrange",
        "band.mid",
        "-c",
        "gb",
        "-o",
        "song.vgm",
        "--preview",
        "song.wav",
        "--emit-manifest",
        "song.json",
      ],
      env,
    );
    expect(code).toBe(0);
    expect(env.written["song.vgm"]!.length).toBeGreaterThan(64);
    // VGM identifies itself, so the artifact is playable in existing tools.
    expect(String.fromCharCode(...env.written["song.vgm"]!.slice(0, 4))).toBe("Vgm ");
    expect(String.fromCharCode(...env.written["song.wav"]!.slice(0, 4))).toBe("RIFF");
    expect(env.written["song.json"]).toBeDefined();
  });

  it("reports the plan an agent needs, in --json", async () => {
    const env = makeEnv({ "band.mid": bandMidi() });
    const code = await run(["arrange", "band.mid", "-c", "gb", "-o", "song.vgm", "--json"], env);
    expect(code).toBe(0);
    const report = JSON.parse(env.stdout) as {
      timing: { achievedBpm: number; accumulates: boolean; ppmError: number };
      parts: { role: string; roleConfidence: number }[];
      channels: { channelId: string; partId: string }[];
      tournament: { winner: string; candidates: unknown[] };
    };
    expect(report.timing.accumulates).toBe(false);
    expect(report.timing.achievedBpm).toBeCloseTo(140, 0);
    expect(report.parts.map((part) => part.role)).toContain("percussion");
    expect(report.channels.length).toBeGreaterThan(0);
    expect(report.tournament.candidates.length).toBeGreaterThan(1);
  });

  it("lists its candidates without needing input", async () => {
    const env = makeEnv({});
    const code = await run(["arrange", "-c", "gb", "--strategy", "list"], env);
    expect(code).toBe(0);
    expect(env.stdout).toContain("full-band");
  });

  it("fails usefully without a console", async () => {
    const env = makeEnv({ "band.mid": bandMidi() });
    const code = await run(["arrange", "band.mid", "-o", "x.vgm"], env);
    expect(code).not.toBe(0);
    expect(env.stderr).toContain("--console");
  });

  it("refuses to drop parts under --strict", async () => {
    const env = makeEnv({ "band.mid": bandMidi() });
    const code = await run(
      ["arrange", "band.mid", "-c", "gb", "--channels", "2", "--strict", "-o", "x.vgm"],
      env,
    );
    expect(code).not.toBe(0);
    expect(env.stderr).toMatch(/could not be kept/);
  });

  it("takes a repeated --role", async () => {
    const env = makeEnv({ "band.mid": bandMidi() });
    const code = await run(
      [
        "arrange",
        "band.mid",
        "-c",
        "gb",
        "--role",
        "t0c2=lead",
        "--role",
        "t0c3=pad",
        "-o",
        "x.vgm",
        "--json",
      ],
      env,
    );
    expect(code).toBe(0);
    const report = JSON.parse(env.stdout) as { parts: { id: string; role: string }[] };
    const byId = new Map(report.parts.map((part) => [part.id, part.role]));
    // Both overrides must land: a flag documented as repeatable that keeps only
    // the last occurrence is worse than one that rejects the second.
    expect(byId.get("t0c2")).toBe("lead");
    expect(byId.get("t0c3")).toBe("pad");
  });
});

describe("demake sfx", () => {
  it("demakes a sound and reports where it wants to sit", async () => {
    const env = makeEnv({ "coin.wav": sweepWav() });
    const code = await run(["sfx", "coin.wav", "-c", "gb", "-o", "coin.vgm", "--json"], env);
    expect(code).toBe(0);
    const report = JSON.parse(env.stdout) as {
      soundClass: string;
      placement: { channelId: string; priority: number };
      tournament: { winner: string };
    };
    expect(report.soundClass).toBe("swept");
    expect(report.tournament.winner).toBe("sweep-up");
    expect(report.placement.priority).toBeGreaterThan(0);
    expect(env.written["coin.vgm"]).toBeDefined();
  });

  it("says what it cannot decode", async () => {
    const env = makeEnv({ "song.mp3": new Uint8Array([0xff, 0xfb, 0x00, 0x00]) });
    const code = await run(["sfx", "song.mp3", "-c", "gb", "-o", "x.vgm"], env);
    expect(code).not.toBe(0);
    expect(env.stderr).toMatch(/only WAV input/);
  });
});

describe("demake render", () => {
  it("renders the schedule a previous run wrote", async () => {
    const env = makeEnv({ "band.mid": bandMidi() });
    await run(
      [
        "arrange",
        "band.mid",
        "-c",
        "gb",
        "-o",
        "song.vgm",
        "--emit-manifest",
        "song.json",
        "--preview",
        "direct.wav",
      ],
      env,
    );
    const code = await run(["render", "song.json", "-o", "again.wav"], env);
    expect(code).toBe(0);
    // Rendering the schedule reproduces the preview exactly: same models, same
    // schedule, same bytes. That is doc 16 §Claim 3 in one assertion.
    expect(env.written["again.wav"]).toEqual(env.written["direct.wav"]);
  });

  it("refuses an artifact it cannot read as a schedule", async () => {
    const env = makeEnv({ "song.vgm": new Uint8Array([0x56, 0x67, 0x6d, 0x20, 1, 2, 3]) });
    const code = await run(["render", "song.vgm", "-o", "x.wav"], env);
    expect(code).not.toBe(0);
    expect(env.stderr).toMatch(/cannot render/);
  });
});
