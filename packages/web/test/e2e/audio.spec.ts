/**
 * The two audio sections (doc 07 §The audio sections).
 *
 * These guard the things that are easy to break without noticing: the sections
 * are code-split, so the art demaker never pays for the chip models; the CLI's
 * whole option surface is really reachable from the page; the artifacts the
 * buttons hand you are the artifacts the CLI writes; and — the one that would
 * *sound* fine while being wrong — nothing but an `AudioBufferSourceNode` is
 * ever constructed.
 */

import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

/** Record every Web Audio constructor before the app has a chance to load. */
async function recordSynthesis(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const record = (globalThis as unknown as { __synth: string[] }).__synth ?? [];
    (globalThis as unknown as { __synth: string[] }).__synth = record;
    for (const name of ["OscillatorNode", "BiquadFilterNode", "AudioWorkletNode", "GainNode"]) {
      const original = (globalThis as unknown as Record<string, unknown>)[name];
      if (typeof original !== "function") continue;
      (globalThis as unknown as Record<string, unknown>)[name] = new Proxy(original, {
        construct(target, args, newTarget) {
          record.push(name);
          return Reflect.construct(target as never, args, newTarget);
        },
      });
    }
    if (typeof AudioContext !== "function") return;
    for (const name of ["createOscillator", "createBiquadFilter", "createGain"] as const) {
      const proto = AudioContext.prototype as unknown as Record<string, unknown>;
      const original = proto[name];
      if (typeof original !== "function") continue;
      proto[name] = function patched(this: AudioContext, ...args: unknown[]) {
        record.push(name);
        return (original as (...rest: unknown[]) => unknown).apply(this, args);
      };
    }
  });
}

/** The bytes behind a download button. */
async function save(page: Page, testId: string): Promise<Uint8Array> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId(testId).click(),
  ]);
  const path = await download.path();
  expect(path).toBeTruthy();
  return new Uint8Array(await readFile(path as string));
}

test("loads the music demaker on demand and arranges the bundled track", async ({ page }) => {
  const chunks: string[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith(".js")) chunks.push(response.url());
  });

  // The art demaker is what a bare `#section=` lands on, and it must not have
  // pulled the audio engine in.
  await page.goto("/#section=art");
  await expect(page.getByTestId("console-summary")).toBeVisible();
  expect(chunks.some((url) => url.includes("MusicDemaker"))).toBe(false);
  expect(chunks.some((url) => url.includes("audio.worker"))).toBe(false);

  // Opening a track in the explorer is what fetches it — the section tabs are
  // gone, and a `.mid` opens the music demaker because it is a track (doc 19).
  await page.getByTestId("explorer-file").filter({ hasText: "rally.mid" }).first().click();
  await expect(page.getByRole("heading", { name: "Arrangement" })).toBeVisible();
  expect(chunks.some((url) => url.includes("MusicDemaker"))).toBe(true);

  // The section demos itself: the first bundled track arrives and is arranged.
  await expect(page.getByTestId("channel-plan")).toBeVisible();
  await expect(page.getByTestId("track-facts")).toContainText("BPM");
  await expect(page.getByTestId("timing-facts")).toContainText("ppm");
  await expect(page.getByTestId("parts-table")).toContainText("bass");

  // Doc 17's tempo guarantee, reported rather than assumed: the driver's rate is
  // fitted to the track's, and the error must not accumulate.
  await expect(page.getByTestId("timing-facts")).toContainText("none");

  // A four-part MIDI on a four-channel chip has something to say about drops.
  await expect(page.getByTestId("audio-scoreboard")).toBeVisible();
  await expect(page.getByTestId("equivalent-command")).toContainText("demake arrange");
});

test("carries the arrange flag surface, and says what it would type", async ({ page }) => {
  await page.goto("/#section=music");
  await expect(page.getByTestId("channel-plan")).toBeVisible();
  const command = page.getByTestId("equivalent-command");

  // Every one of these is a `demake arrange` flag reaching the engine, and the
  // command line is how the page proves it ran what it says it ran.
  await page.getByTestId("console-select").selectOption("nes");
  await expect(command).toContainText("-c nes");
  await expect(page.getByTestId("console-summary")).toContainText("nes-apu");

  await page.getByTestId("bpm-input").fill("128");
  await expect(command).toContainText("--bpm 128");

  await page.getByRole("checkbox", { name: /keep /i }).first().uncheck();
  await expect(command).toContainText("--drop ");

  await page
    .getByRole("combobox", { name: /role for /i })
    .first()
    .selectOption("pad");
  await expect(command).toContainText("=pad");

  await page.getByRole("radio", { name: "fast" }).check();
  await expect(command).toContainText("--effort fast");

  // The arrangement follows the flags: a new console means new lanes.
  await expect(page.getByTestId("channel-plan")).toContainText("triangle");
});

test("pins a strategy from the tournament scoreboard", async ({ page }) => {
  await page.goto("/#section=music");
  await expect(page.getByTestId("audio-scoreboard")).toBeVisible();

  await page.getByTestId("audio-scoreboard").getByRole("button", { name: "pin" }).first().click();
  await expect(page.getByTestId("equivalent-command")).toContainText("--strategy");
  // Pinning one candidate collapses the portfolio to it, as `--strategy` does.
  await expect(page.getByTestId("audio-scoreboard").locator("tbody tr")).toHaveCount(1);
});

test("demakes a recorded sound and shows the shape it fitted", async ({ page }) => {
  await page.goto("/#section=sound");
  await expect(page.getByRole("heading", { name: "The fit" })).toBeVisible();

  await expect(page.getByTestId("sound-class")).not.toBeEmpty();
  await expect(page.getByTestId("envelope")).toBeVisible();
  await expect(page.getByTestId("fit-facts")).toContainText("a tick");
  await expect(page.getByTestId("equivalent-command")).toContainText("demake sfx");

  // The class gate is the sound demaker's own decision, and the gesture picker
  // only ever offers what survived it.
  const gestures = await page.getByTestId("strategy-select").locator("option").count();
  expect(gestures).toBeGreaterThan(1);

  await page.getByTestId("max-length").fill("1.5");
  await expect(page.getByTestId("equivalent-command")).toContainText("--max-length 1.5");
});

test("hands over the same artifacts the CLI writes", async ({ page }) => {
  await page.goto("/#section=music");
  await expect(page.getByTestId("channel-plan")).toBeVisible();

  const vgm = await save(page, "export-vgm");
  expect(new TextDecoder().decode(vgm.subarray(0, 4))).toBe("Vgm ");

  const wav = await save(page, "export-wav");
  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");

  const manifest = await save(page, "export-manifest");
  const sidecar = JSON.parse(new TextDecoder().decode(manifest)) as {
    schemaVersion: number;
    script: { console: string; ticks: unknown[] };
  };
  expect(sidecar.schemaVersion).toBe(1);
  expect(sidecar.script.console).toBe("dmg");
  expect(sidecar.script.ticks.length).toBeGreaterThan(0);

  // A real cartridge, assembled in the page: 32 KiB, and the header's own
  // checksum agrees — which is the same thing the game section promises.
  const rom = await save(page, "export-rom");
  expect(rom.length).toBe(32768);
  let checksum = 0;
  for (let at = 0x134; at <= 0x14c; at += 1) checksum = (checksum - rom[at]! - 1) & 0xff;
  expect(rom[0x14d]).toBe(checksum);
});

test("plays the render through Web Audio without synthesizing anything", async ({ page }) => {
  await recordSynthesis(page);
  await page.goto("/#section=sound");
  await expect(page.getByTestId("envelope")).toBeVisible();

  // Both sides of the A/B: the recording as `@demake/audio` decoded it, and the
  // chip's own output. Neither is computed by the page.
  const result = page.getByTestId("play-result");
  await expect(result).toHaveText("Play the result");
  await result.click();
  await expect(page.getByTestId("play-source")).toBeVisible();
  await page.getByTestId("play-source").click();

  // The rate the device actually gave is reported rather than assumed.
  await expect(page.getByTestId("listen-stat")).toContainText("Hz");

  const synth = await page.evaluate(() => (globalThis as unknown as { __synth: string[] }).__synth);
  expect(synth).toEqual([]);
});
