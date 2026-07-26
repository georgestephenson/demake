/**
 * The Demotic section (doc 07 §Sections).
 *
 * These guard three things that are easy to break without noticing: the section
 * is code-split, so the art demaker never pays for the game language; the
 * simulator actually advances in the page; and the `.test.dmt` suite runs
 * against every console from the browser, with the same result the CLI gets.
 */

import { expect, test } from "@playwright/test";

/**
 * Show the interpreter.
 *
 * The pane opens on the *cartridge* — it is the artifact, and the preview is
 * what proves it right rather than the other way round — so a test about the
 * simulator has to ask for it.
 */
async function showPreview(
  page: import("@playwright/test").Page,
  mode: "preview" | "both" = "preview",
): Promise<void> {
  await page.getByTestId("view-select").selectOption(mode);
}

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
  await showPreview(page);
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
  await showPreview(page);
  await expect(page.locator(".game-status")).toContainText("20x18 cells");
  await page.getByTestId("console-select").selectOption("md");
  await expect(page.locator(".game-status")).toContainText("40x28 cells");
});

test("builds the same game as a Game Boy Color cartridge, in colour", async ({ page }) => {
  await page.goto("/#section=game");
  const canvas = page.getByTestId("rom-canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(async () => romPainted(page), { timeout: 8000 }).toBeGreaterThan(0);
  // A Game Boy shows four shades of green and nothing else.
  expect(await romColors(page)).toBeLessThanOrEqual(4);

  await page.getByTestId("console-select").selectOption("gbc");
  // Demaking a picture in colour is the whole tournament, so the pane says so
  // and the cartridge arrives after it — the first colour build is seconds.
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => romColors(page), { timeout: 60_000 }).toBeGreaterThan(4);
  // And it is a different cartridge, not a filter over the same one.
  await expect(page.getByTestId("rom-download")).toContainText(".gbc");
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
  await showPreview(page);
  await page.getByTestId("example-select").selectOption("caves");
  await expect(page.locator(".diag-error")).toHaveCount(0);

  // Past the title screen — every game opens on one, and a title screen has no
  // level to scroll. Wait for the scene rather than for a timeout: on a slow
  // engine the press can land before the first tick has run.
  await page.keyboard.press("KeyZ");
  await expect(page.locator(".game-status")).toContainText("scene play", { timeout: 8000 });

  // The canvas is not blank before anything moves: a scene with a level draws
  // its tiles, which is the whole of the background layer.
  await expect.poll(() => painted(page), { timeout: 5000 }).toBeGreaterThan(0.05);

  // Holding right moves the hero into the level, and the view has to follow —
  // the level is 60 cells wide and no console shows more than 40. Polled rather
  // than sampled after a fixed wait: how long a browser takes to run a second of
  // game is not something this test has an opinion about.
  await page.keyboard.down("ArrowRight");
  const before = await painted(page);
  await expect.poll(() => painted(page), { timeout: 8000 }).not.toBe(before);
  await page.keyboard.up("ArrowRight");
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
  await showPreview(page);
  const editor = page.getByLabel("Demotic game source");
  await editor.fill("start play\nscene play\ncreate object d (wibble 1)");
  await expect(page.locator(".diag-error")).toContainText("E_UNKNOWN_PROP");
  await expect(page.locator(".game-canvas")).toBeVisible();

  // The diagnostics wait for typing to stop along with everything else, so the
  // thing worth pinning is that they *arrive* — a debounce that swallowed the
  // last keystroke would be far worse than one that is slow — and that they go
  // again when the mistake is fixed.
  await editor.fill("start play\nscene play\ncreate object d (width 1)");
  await expect(page.locator(".diag-error")).toHaveCount(0);
});

test("colours the source, and keeps the colours under the caret", async ({ page }) => {
  await page.goto("/#section=game");
  const editor = page.locator(".source-editor");
  await expect(editor).toBeVisible();

  // The grammar is `@demake/demotic`'s, so the scopes are the ones its tests
  // pin. What this test owns is that they reach the DOM and get a colour.
  for (const scope of ["comment.line.double-dash", "storage.type", "string.quoted"]) {
    await expect(page.locator(`.source-highlight [data-scope="${scope}"]`).first()).toBeVisible();
  }
  const colours = await page
    .locator(".source-highlight [data-scope]")
    .evaluateAll((nodes) => new Set(nodes.map((n) => getComputedStyle(n).color)).size);
  expect(colours).toBeGreaterThan(3);

  // The two layers are stacked, so a difference in metrics shows up as text that
  // has slid out from under its colours. Same box, same font, same wrap points:
  // if they wrapped differently the textarea's content would be taller.
  const aligned = await editor.evaluate((element) => {
    const pre = element.querySelector(".source-highlight") as HTMLElement;
    const area = element.querySelector("textarea") as HTMLTextAreaElement;
    const a = getComputedStyle(pre);
    const b = getComputedStyle(area);
    return {
      text: pre.textContent === `${area.value}\n`,
      font: a.fontFamily === b.fontFamily && a.fontSize === b.fontSize,
      leading: a.lineHeight === b.lineHeight && a.letterSpacing === b.letterSpacing,
      wrapping: a.whiteSpace === b.whiteSpace && a.overflowWrap === b.overflowWrap,
      width: pre.clientWidth === area.clientWidth,
      height: area.scrollHeight <= pre.scrollHeight,
      // Nothing may be bolded or italicised: in most monospace families that is
      // a different advance width, and the layers would drift along the line.
      plain: [...element.querySelectorAll("[data-scope]")].every((node) => {
        const style = getComputedStyle(node);
        return style.fontStyle === "normal" && style.fontWeight === a.fontWeight;
      }),
    };
  });
  expect(aligned).toEqual({
    text: true,
    font: true,
    leading: true,
    wrapping: true,
    width: true,
    height: true,
    plain: true,
  });

  // Editing still works, and the colours follow what was typed.
  await page.getByLabel("Demotic game source").fill("start play\nscene play\n-- a note");
  await expect(
    page.locator('.source-highlight [data-scope="comment.line.double-dash"]'),
  ).toHaveText("-- a note");
});

test("waits for typing to stop before doing any work at all", async ({ page }) => {
  await page.goto("/#section=game");
  await expect(page.getByTestId("rom-canvas")).toBeVisible();
  await expect.poll(async () => romPainted(page), { timeout: 8000 }).toBeGreaterThan(0);
  await expect(page.getByTestId("rom-building")).toHaveCount(0);

  // Nothing downstream of the editor runs per keystroke — not the compile, not
  // the interpreter, not the cartridge. What a keystroke costs is a lex for the
  // colours. Appending a *comment* is what makes this observable: the program is
  // valid throughout, so the only thing that can change is when the work lands.
  const editor = page.getByLabel("Demotic game source");
  await editor.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  });
  await page.keyboard.type("\n-- a comment typed slowly", { delay: 60 });

  // Mid-typing: the pane keeps playing the cartridge it has and says a newer one
  // is coming. A screen that blanked as you typed would be worse than one that
  // is a version behind.
  await expect(page.getByTestId("rom-building")).toBeVisible();
  await expect(page.getByTestId("rom-canvas")).toBeVisible();

  // And once typing stops, everything lands together.
  await expect(page.getByTestId("rom-building")).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => romPainted(page), { timeout: 8000 }).toBeGreaterThan(0);
  await expect(page.locator(".diag-error")).toHaveCount(0);
});

test("says it is demaking when the game or the console changes", async ({ page }) => {
  await page.goto("/#section=game");
  await expect(page.getByTestId("rom-canvas")).toBeVisible();
  await expect.poll(async () => romPainted(page), { timeout: 8000 }).toBeGreaterThan(0);

  // A dropdown is one deliberate action, so it takes effect at once — but the
  // build behind it is still the whole art pipeline, and the pane has to say so.
  //
  // Watched rather than polled, and that is not a style choice: the build is
  // *synchronous*, so from the moment it starts nothing in the page answers
  // Playwright until it finishes — by which time the badge is gone. A poll can
  // only ever catch the sliver before that, so `toBeVisible` here would be a
  // coin toss. A `MutationObserver` callback is a microtask and runs the instant
  // the badge is inserted, well before the work begins, so it records what
  // happened rather than what a poll happened to see.
  const watch = () =>
    page.evaluate(() => {
      const flag = { seen: false };
      (globalThis as unknown as { __building: typeof flag }).__building = flag;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="rom-building"]')) flag.seen = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
  const sawBadge = () =>
    page.evaluate(
      () => (globalThis as unknown as { __building: { seen: boolean } }).__building.seen,
    );

  await watch();
  await page.getByTestId("example-select").selectOption("caves");
  await expect(page.getByTestId("rom-download")).toContainText("caves", { timeout: 60_000 });
  await expect(page.getByTestId("rom-building")).toHaveCount(0, { timeout: 60_000 });
  expect(await sawBadge(), "changing game").toBe(true);

  // The colour build is the slow one — the whole `prep` tournament rather than
  // the mono path — so this is the case the badge exists for.
  await watch();
  await page.getByTestId("console-select").selectOption("gbc");
  await expect(page.getByTestId("rom-download")).toContainText(".gbc", { timeout: 60_000 });
  await expect(page.getByTestId("rom-building")).toHaveCount(0, { timeout: 60_000 });
  expect(await sawBadge(), "changing console").toBe(true);
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

  await showPreview(page);
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

test("opens on the cartridge, and shows the interpreter when asked", async ({ page }) => {
  await page.goto("/#section=game");
  await expect(page.getByRole("heading", { name: "Play" })).toBeVisible();

  // The cartridge is the artifact, so it is what the pane opens on — in the
  // place the preview used to hold, not underneath it.
  await expect(page.getByTestId("rom-canvas")).toBeVisible();
  await expect(page.locator(".game-canvas")).toHaveCount(0);

  await page.getByTestId("view-select").selectOption("preview");
  await expect(page.locator(".game-canvas")).toBeVisible();
  await expect(page.getByTestId("rom-canvas")).toHaveCount(0);
  // No cartridge, no sound button: the chip is the cartridge's.
  await expect(page.getByTestId("rom-sound")).toHaveCount(0);

  await page.getByTestId("view-select").selectOption("both");
  await expect(page.locator(".game-canvas")).toBeVisible();
  await expect(page.getByTestId("rom-canvas")).toBeVisible();

  // Side by side means side by side: two columns on a desktop viewport.
  const preview = await page.locator(".game-canvas").boundingBox();
  const cartridge = await page.getByTestId("rom-canvas").boundingBox();
  expect(preview).not.toBeNull();
  expect(cartridge).not.toBeNull();
  expect((cartridge as { x: number }).x).toBeGreaterThan((preview as { x: number }).x);

  // And both are running the same input: one press starts both machines.
  await page.keyboard.press("KeyZ");
  await expect(page.locator(".game-status")).toContainText("scene play", { timeout: 5000 });
  await expect(page.getByTestId("rom-stat")).toContainText("per tick", { timeout: 8000 });
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
  await page.goto("/#section=game");
  const toggle = page.getByTestId("rom-sound");
  await expect(toggle).toHaveText("Sound off");

  // The click is the user gesture a browser wants before it will start an
  // `AudioContext`, which is the whole reason the page has a button here rather
  // than starting sound on its own.
  //
  // What the button reports is what the *listener asked for*, not whether the
  // device agreed: a browser may hold a context suspended, resolve `resume()`
  // before the state flips, or have no audio device at all — all three happen on
  // CI. The page says so separately, and the pane keeps working either way,
  // which is the part worth asserting here.
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

/**
 * Fraction of the ROM screen that is *not* its most common colour.
 *
 * Ink, in other words — used both to tell that something has been drawn at all
 * and to tell that the picture changed. It is written against the modal colour
 * rather than a brightness threshold because the screen is not grey: a Game Boy
 * shows the green LCD ramp, whose lightest shade is `(155, 188, 15)`, and a
 * Game Boy Color build shows whatever the fit chose. Any fixed channel cutoff
 * would call a whole green screen "dark" and stop distinguishing anything.
 */
/** Distinct colours on the ROM screen — four on a Game Boy, more on a CGB. */
async function romColors(page: import("@playwright/test").Page): Promise<number> {
  return page.locator(".rom-canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add(
        ((data[i] as number) << 16) | ((data[i + 1] as number) << 8) | (data[i + 2] as number),
      );
    }
    return seen.size;
  });
}

async function romPainted(page: import("@playwright/test").Page): Promise<number> {
  return page.locator(".rom-canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return 0;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key =
        ((data[i] as number) << 16) | ((data[i + 1] as number) << 8) | (data[i + 2] as number);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let background = 0;
    for (const count of counts.values()) if (count > background) background = count;
    const pixels = data.length / 4;
    return (pixels - background) / pixels;
  });
}
