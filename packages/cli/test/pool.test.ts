/**
 * The thread pool (doc 04 §Running the tournament).
 *
 * `packages/core/test/parallel.test.ts` pins the property that matters — a
 * tournament's answer does not depend on the order its candidates finish in —
 * using executors that only pretend to be concurrent. This is the other half:
 * real threads, real structured clones, and the things only a real pool can get
 * wrong. A lane that dies, a pool closed with work outstanding, two callers
 * sharing the lanes, and the bytes at the end of it all.
 *
 * Run against the *built* pool, because a lane is a real worker thread and a
 * worker thread cannot be started on a `.ts` file. Like `binary.test.ts`, this
 * skips when `dist` is absent — a bare `vitest run` with no prior build — and
 * always executes in CI, which builds first.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { demakeSfx } from "@demake/audio";
import { encodeRgbaPng, prep, type Job } from "@demake/core";

import type * as PoolModule from "../src/parallel/pool.js";

const poolPath = fileURLToPath(new URL("../dist/parallel/pool.js", import.meta.url));
const built = existsSync(poolPath);
const pool: typeof PoolModule = built
  ? ((await import(poolPath)) as typeof PoolModule)
  : ({} as typeof PoolModule);
const { JobPool, parseJobs, withPool } = pool;

/** A source with enough going on that the candidates disagree about it. */
function image(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  let state = 0xc0ffee;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = (y * size + x) * 4;
      rgba[o] = Math.round((x / (size - 1)) * 255);
      rgba[o + 1] = Math.round((y / (size - 1)) * 255);
      rgba[o + 2] = Math.round(next() * 140 + 40);
      rgba[o + 3] = 255;
      if (x > size * 0.6 && y > size * 0.25 && y < size * 0.5) rgba[o + 1] = 20;
    }
  }
  return encodeRgbaPng(size, size, rgba);
}

/** A short decaying blip: enough for the gesture families to disagree. */
function sound(): Uint8Array {
  const rate = 22050;
  const samples = Math.floor(rate * 0.25);
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    const envelope = Math.exp(-14 * t);
    const wave = Math.sin(2 * Math.PI * 900 * t) + 0.4 * Math.sin(2 * Math.PI * 1800 * t);
    pcm[i] = Math.round(Math.max(-1, Math.min(1, wave * envelope)) * 30000);
  }
  const header = 44;
  const bytes = new Uint8Array(header + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(header + i * 2, pcm[i] as number, true);
  return bytes;
}

describe.skipIf(!built)("--jobs", () => {
  it("reads a number, and auto as one lane per core", () => {
    expect(parseJobs("4")).toBe(4);
    expect(parseJobs("0")).toBe(0);
    expect(parseJobs("auto")).toBeGreaterThanOrEqual(1);
    expect(parseJobs(undefined)).toBe(parseJobs("auto"));
  });

  it("refuses anything else rather than guessing a lane count", () => {
    expect(() => parseJobs("many")).toThrow(/whole number or 'auto'/);
    expect(() => parseJobs("-2")).toThrow(/whole number or 'auto'/);
    expect(() => parseJobs("2.5")).toThrow(/whole number or 'auto'/);
  });

  it("runs on this thread below two lanes, rather than through one worker", async () => {
    expect(await withPool(0, async (executor) => executor)).toBeUndefined();
    expect(await withPool(1, async (executor) => executor)).toBeUndefined();
  });
});

describe.skipIf(!built)("the job pool", () => {
  it("gives prep the bytes the inline path gives", async () => {
    const source = image(64);
    const alone = await prep(source, { console: "gbc" });
    const pooled = await withPool(4, (executor) =>
      prep(source, { console: "gbc", ...(executor ? { executor } : {}) }),
    );
    expect(pooled.png).toEqual(alone.png);
    expect(pooled.tournament).toEqual(alone.tournament);
  }, 120_000);

  it("gives sfx the schedule the inline path gives", async () => {
    const source = sound();
    const alone = await demakeSfx(source, { console: "dmg" });
    const pooled = await withPool(4, (executor) =>
      demakeSfx(source, { console: "dmg", ...(executor ? { executor } : {}) }),
    );
    expect(pooled.artifact).toEqual(alone.artifact);
    expect(pooled.tournament.winner).toBe(alone.tournament.winner);
  }, 120_000);

  it("serves two tournaments over the same lanes at once", async () => {
    // What `demake build` does: art and audio demade together, sharing the pool.
    const picture = image(48);
    const effect = sound();
    const [expectedImage, expectedSound] = [
      await prep(picture, { console: "nes" }),
      await demakeSfx(effect, { console: "dmg" }),
    ];

    const pool = new JobPool(3);
    try {
      const executor = pool.executor();
      const [gotImage, gotSound] = await Promise.all([
        prep(picture, { console: "nes", executor }),
        demakeSfx(effect, { console: "dmg", executor }),
      ]);
      expect(gotImage.png).toEqual(expectedImage.png);
      expect(gotSound.artifact).toEqual(expectedSound.artifact);
    } finally {
      await pool.close();
    }
  }, 120_000);

  it("answers one outcome per job, in the order the jobs were given", async () => {
    const pool = new JobPool(3);
    try {
      // Nothing handles this kind, so every lane reports the same failure — which
      // is enough to see that the answers line up with the questions.
      const jobs: Job[] = Array.from({ length: 12 }, (_, index) => ({
        kind: "test.unhandled",
        payload: index,
      }));
      const finished: number[] = [];
      const outcomes = await pool.executor()(jobs, (index) => finished.push(index));
      expect(outcomes).toHaveLength(jobs.length);
      expect(finished.slice().sort((a, b) => a - b)).toEqual(jobs.map((_, index) => index));
      for (const outcome of outcomes) {
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.error.code).toBe("E_INTERNAL");
      }
    } finally {
      await pool.close();
    }
  }, 60_000);

  it("settles outstanding work when it is closed, rather than hanging", async () => {
    const pool = new JobPool(1);
    const jobs: Job[] = Array.from({ length: 8 }, (_, index) => ({
      kind: "test.unhandled",
      payload: index,
    }));
    const running = pool.executor()(jobs);
    await pool.close();
    const outcomes = await running;
    expect(outcomes).toHaveLength(jobs.length);
    expect(outcomes.every((outcome) => outcome.ok === false)).toBe(true);
  }, 60_000);

  it("closes cleanly when it was never asked for anything", async () => {
    const pool = new JobPool(4);
    await expect(pool.close()).resolves.toBeUndefined();
    await expect(pool.close()).resolves.toBeUndefined();
  });
});
