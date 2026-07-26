/**
 * The Demotic section (doc 07 §Sections).
 *
 * These guard three things that are easy to break without noticing: the section
 * is code-split, so the art demaker never pays for the game language; the
 * simulator actually advances in the page; and the `.test.dmt` suite runs
 * against every console from the browser, with the same result the CLI gets.
 */

import { expect, test } from "@playwright/test";

test("loads the game demaker on demand and plays", async ({ page }) => {
  const chunks: string[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith(".js")) chunks.push(r.url());
  });

  await page.goto("/");
  // The art demaker is the default, and must not have pulled the game chunk in.
  await expect(page.getByTestId("source-dropzone").or(page.locator(".dropzone"))).toBeVisible();
  expect(chunks.some((url) => url.includes("GameDemaker"))).toBe(false);

  await page.getByRole("link", { name: /demotic game demaker/i }).click();
  await expect(page.getByRole("heading", { name: "Play" })).toBeVisible();
  expect(chunks.some((url) => url.includes("GameDemaker"))).toBe(true);

  // Enter play, then let the simulation run: the tick counter must advance.
  await page.keyboard.press("KeyZ");
  await expect(page.locator(".game-status")).toContainText("scene play", { timeout: 5000 });
  const first = await readTick(page);
  await page.waitForTimeout(500);
  expect(await readTick(page)).toBeGreaterThan(first);
});

test("runs the .test.dmt suite against every console", async ({ page }) => {
  await page.goto("/#section=game");
  await page.getByRole("button", { name: "Run tests" }).click();
  // Same tally the CLI prints — one suite, seven playfields.
  await expect(page.locator(".game-status").last()).toContainText(
    /\d+\/\d+ cases passed across \d+ consoles/,
  );
  await expect(page.locator(".game-status").last()).not.toContainText("FAIL");
});

test("retargets the game at another console", async ({ page }) => {
  await page.goto("/#section=game");
  await expect(page.locator(".game-status")).toContainText("20x18 cells");
  await page.getByTestId("console-select").selectOption("md");
  await expect(page.locator(".game-status")).toContainText("40x28 cells");
});

test("every bundled example loads, compiles and passes its suite", async ({ page }) => {
  await page.goto("/#section=game");
  // The section is code-split, so wait for it to arrive before reading its DOM.
  await expect(page.getByRole("heading", { name: "Play" })).toBeVisible();
  const picker = page.getByTestId("example-select");
  const ids = await picker.evaluate((el) =>
    [...(el as HTMLSelectElement).options].map((option) => option.value),
  );
  expect(ids.length).toBeGreaterThanOrEqual(5);

  for (const id of ids) {
    await picker.selectOption(id);
    // Compiling is synchronous, so a clean diagnostics pane means it compiled.
    await expect(page.locator(".diag-error")).toHaveCount(0);
    await page.getByRole("button", { name: "Run tests" }).click();
    const report = page.locator(".game-status").last();
    await expect(report, id).toContainText(/cases passed across \d+ consoles/);
    await expect(report, id).not.toContainText("FAIL");
  }
});

test("scrolls a level bigger than the screen, and draws its tiles", async ({ page }) => {
  await page.goto("/#section=game");
  await expect(page.getByRole("heading", { name: "Play" })).toBeVisible();
  await page.getByTestId("example-select").selectOption("caves");
  await expect(page.locator(".diag-error")).toHaveCount(0);

  // Past the title screen — every game opens on one, and a title screen has no
  // level to scroll.
  await page.keyboard.press("KeyZ");

  // The canvas is not blank before anything moves: a scene with a level draws
  // its tiles, which is the whole of the background layer.
  await expect.poll(() => painted(page), { timeout: 5000 }).toBeGreaterThan(0.05);

  // Holding right moves the hero into the level, and the view has to follow —
  // the level is 60 cells wide and no console shows more than 40.
  await page.keyboard.down("ArrowRight");
  const before = await painted(page);
  await page.waitForTimeout(1200);
  const after = await painted(page);
  await page.keyboard.up("ArrowRight");
  expect(after).not.toBe(before);
});

/** Fraction of the canvas that is not the background colour. */
async function painted(page: import("@playwright/test").Page): Promise<number> {
  return page.locator(".game-canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i] as number) + (data[i + 1] as number) + (data[i + 2] as number) > 60) lit += 1;
    }
    return lit / (data.length / 4);
  });
}

test("reports a source error without blanking the preview", async ({ page }) => {
  await page.goto("/#section=game");
  await page
    .getByLabel("Demotic game source")
    .fill("start play\nscene play\ncreate object d (wibble 1)");
  await expect(page.locator(".diag-error")).toContainText("E_UNKNOWN_PROP");
  await expect(page.locator(".game-canvas")).toBeVisible();
});

test("drives the game from the on-screen pad on a touch device", async ({ browser }) => {
  // A phone has no keyboard, so the pad is the only way in. It appears behind a
  // `(pointer: coarse)` media query, which is what `isMobile` sets here.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto("/#section=game");
  await expect(page.getByRole("heading", { name: "Play" })).toBeVisible();

  const pad = page.getByLabel("On-screen controls");
  await expect(pad).toBeVisible();
  await expect(page.locator(".keyboard-hint")).toBeHidden();

  // What this test owns is that the pad reaches the same input path the keyboard
  // does — tapping A must start the game. That the held direction then moves the
  // paddle is the simulator's business, and `.test.dmt` asserts it on every
  // console.
  await expect(page.locator(".game-status")).toContainText("scene title");
  await page.getByRole("button", { name: "A", exact: true }).tap();
  await expect(page.locator(".game-status")).toContainText("scene play", { timeout: 5000 });

  await context.close();
});

test("renders the language reference from the registry", async ({ page }) => {
  const chunks: string[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith(".js")) chunks.push(r.url());
  });

  await page.goto("/");
  expect(chunks.some((url) => url.includes("LanguageDocs"))).toBe(false);

  await page.getByRole("link", { name: /demotic reference/i }).click();
  await expect(page.getByRole("heading", { name: "Statements" })).toBeVisible();
  expect(chunks.some((url) => url.includes("LanguageDocs"))).toBe(true);

  // Every statement keyword the compiler knows is documented here.
  const statements = page.locator(".doc-body");
  for (const keyword of ["start", "scene", "create object", "control", "when"]) {
    await expect(statements).toContainText(keyword);
  }

  await page.getByRole("button", { name: "Diagnostics" }).click();
  await expect(page.locator(".doc-body")).toContainText("E_SPRITE_BUDGET");
  await expect(page.locator(".doc-body")).toContainText("W_TUNNELLING");

  await page.getByRole("button", { name: "Triggers" }).click();
  await expect(page.locator(".doc-body")).toContainText("touches");
});

test("announces the sections that are not built yet", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /music demaker/i }).click();
  await expect(page.getByRole("heading", { name: "Coming soon" })).toBeVisible();
});

async function readTick(page: import("@playwright/test").Page): Promise<number> {
  const text = (await page.locator(".game-status").first().textContent()) ?? "";
  return Number(/tick (\d+)/.exec(text)?.[1] ?? 0);
}

test("builds and plays a real Game Boy ROM in the page", async ({ page }) => {
  await page.goto("/#section=game");

  // The cartridge is compiled in the page — our assembler, our rasteriser — so
  // it is there the moment the game compiles: no toolchain, no worker round
  // trip, and no host renderer between the source art and the tile bytes.
  const canvas = page.getByTestId("rom-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId("rom-stat")).toContainText("32 KiB");

  // It boots to the title screen, which means the runtime read the tables,
  // uploaded its tiles, and is drawing text from the background layer.
  await expect.poll(async () => romPainted(page), { timeout: 8000 }).toBeGreaterThan(0);

  // Pressing A starts the game, and the picture changes: paddles and a ball
  // instead of a line of text.
  const title = await romPainted(page);
  await page.locator(".rom-canvas").click();
  await page.keyboard.press("KeyZ");
  await expect.poll(async () => romPainted(page), { timeout: 8000 }).not.toBe(title);

  // Once a tick has completed the pane reports what the runtime actually cost.
  await expect(page.getByTestId("rom-stat")).toContainText("per tick");
});

test("plays the cartridge's own APU through Web Audio", async ({ page }) => {
  // Doc 07 §The audio sections: Web Audio is a playback device here, never a
  // synthesizer. Recording the constructors before the app loads is the only
  // way to assert that from outside — an `OscillatorNode` anywhere in the graph
  // would be a second implementation of the hardware, and it would *sound*
  // fine, which is exactly why it needs a test rather than a review.
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
  await page.goto("/#section=game");
  const toggle = page.getByTestId("rom-sound");
  await expect(toggle).toHaveText("Sound off");

  // The click is the user gesture a browser wants before it will start an
  // `AudioContext`, which is the whole reason the page has a button here rather
  // than starting sound on its own.
  await toggle.click();
  await expect(toggle).toHaveText("Sound on");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // With sound on the audio device is what clocks the emulator, so the thing to
  // check is that the game is still *running* — a mistake here stops it dead
  // rather than making it quiet.
  await expect.poll(async () => romPainted(page), { timeout: 8000 }).toBeGreaterThan(0);
  await page.locator(".rom-canvas").click();
  await page.keyboard.press("KeyZ");
  await expect(page.getByTestId("rom-stat")).toContainText("per tick", { timeout: 8000 });

  // Nothing but a buffer source was ever built.
  const synth = await page.evaluate(() => (globalThis as unknown as { __synth: string[] }).__synth);
  expect(synth).toEqual([]);

  await toggle.click();
  await expect(toggle).toHaveText("Sound off");
});

test("builds a level game with a camera, which the fixed engine could not", async ({ page }) => {
  await page.goto("/#section=game");
  await page.getByTestId("example-select").selectOption("caves");
  // A hand-drawn level, tile collision and a scrolling camera all compile now,
  // and the level's own art is demade into the tile bank on the way.
  await expect(page.getByTestId("rom-canvas")).toBeVisible();
  await expect.poll(async () => romPainted(page), { timeout: 8000 }).toBeGreaterThan(0);
});

/** Fraction of the ROM screen that is not the lightest shade. */
async function romPainted(page: import("@playwright/test").Page): Promise<number> {
  return page.locator(".rom-canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if ((data[i] as number) < 0xd0) dark += 1;
    return dark / (data.length / 4);
  });
}
