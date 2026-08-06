/**
 * Functional flows for the web app (doc 07 §UX, doc 10 §Surface tests).
 *
 * These drive the page exactly as a person would — load the demo, change the
 * console, open the advanced panel, export a file — and assert the things the
 * UX spec promises: a rendered result, a palette strip, a tournament
 * scoreboard, and an equivalent command line that matches the settings.
 */

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // The art demaker with no file open. A bare URL opens the project's game now
  // (doc 07 §Sections) — the section tabs are gone, so an art file in the
  // explorer or a `#section=` is how you get here, and `#section=` is what every
  // option permalink shared before the site held projects already carries.
  await page.goto("/#section=art");
});

test("converts the bundled demo image and shows the result", async ({ page }) => {
  await page.getByTestId("load-demo").click();

  const canvas = page.getByTestId("result-canvas");
  await expect(canvas).toBeVisible();
  // The default console is the GBC: 160×144, and the canvas is drawn 1:1.
  await expect.poll(async () => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBe(160);
  await expect.poll(async () => canvas.evaluate((c: HTMLCanvasElement) => c.height)).toBe(144);

  // The canvas must actually hold pixels, not an empty surface.
  const nonBlank = await canvas.evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext("2d");
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const first = `${data[0]},${data[1]},${data[2]}`;
    for (let i = 4; i < data.length; i += 4) {
      if (`${data[i]},${data[i + 1]},${data[i + 2]}` !== first) return true;
    }
    return false;
  });
  expect(nonBlank).toBe(true);

  await expect(page.getByTestId("palette-strip").locator(".swatch").first()).toBeVisible();
  await expect(page.getByTestId("scoreboard")).toBeVisible();
  await expect(page.getByTestId("stats")).toContainText("Unique tiles");
});

test("switching console re-converts at that console's resolution", async ({ page }) => {
  await page.getByTestId("load-demo").click();
  const canvas = page.getByTestId("result-canvas");
  await expect.poll(async () => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBe(160);

  await page.getByTestId("console-select").selectOption("nes");
  await expect(page.getByTestId("console-summary")).toContainText("16×16 attribute cells");
  await expect.poll(async () => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBe(256);
});

test("the equivalent command tracks the options and the permalink", async ({ page }) => {
  const command = page.getByTestId("equivalent-command");
  await expect(command).toHaveText(/^demake prep image\.png -c gbc$/);

  await page.getByTestId("console-select").selectOption("snes");
  await page.getByTestId("dither-select").selectOption("bayer4");
  await expect(command).toHaveText(/-c snes --dither bayer4/);

  // Options — never the image — live in the URL hash, so the link is shareable.
  await expect.poll(async () => page.evaluate(() => location.hash)).toContain("console=snes");
  await expect.poll(async () => page.evaluate(() => location.hash)).toContain("dither=bayer4");

  await page.reload();
  await expect(page.getByTestId("console-select")).toHaveValue("snes");
  await expect(page.getByTestId("dither-select")).toHaveValue("bayer4");
});

test("exports the compliant PNG", async ({ page }) => {
  await page.getByTestId("load-demo").click();
  await expect(page.getByTestId("export-png")).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-png").click(),
  ]);
  expect(download.suggestedFilename()).toBe("demo-scene.gbc.png");
  const path = await download.path();
  expect(path).toBeTruthy();
});

test("shows the engine's own error for an unusable input", async ({ page }) => {
  // The art demaker's own input, by its accessible name: the page is a
  // workspace now and the explorer has a file input of its own (doc 19), so a
  // bare `input[type=file]` would hand this text file to the zip importer.
  await page.getByLabel("Choose an image file to convert").setInputFiles({
    name: "not-an-image.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("this is not an image"),
  });
  const error = page.getByTestId("error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("E_");
});

test("is keyboard operable and labels its controls", async ({ page }) => {
  // Every form control the page exposes carries an accessible name.
  const unnamed = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("select, input, button")];
    return controls.filter((el) => {
      const element = el as HTMLElement;
      if (element.classList.contains("visually-hidden")) return false;
      const label = element.closest("label")?.textContent?.trim();
      const text = element.textContent?.trim();
      return (
        !label && !text && !element.getAttribute("aria-label") && !element.getAttribute("title")
      );
    }).length;
  });
  expect(unnamed).toBe(0);

  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? "");
  expect(["BUTTON", "SELECT", "INPUT", "A"]).toContain(focused);
});

test("the size control says what it is, what auto chose, and how to change it", async ({
  page,
}) => {
  // An SVG from the project, because a drawing is the case this row exists for:
  // it has no pixels of its own, so a size is a *choice* and the box is the only
  // place that choice is made.
  await page.goto("/#file=art%2Fball.svg");

  // What `auto` resolved to, in the box that changes it. A source smaller than
  // the screen is kept at its own size, so this drawing demakes to a 64×64
  // corner of a Game Boy — correct, surprising, and unfindable while the only
  // thing this box said was "auto".
  await expect(page.getByTestId("size-input")).toHaveAttribute("placeholder", "auto — 64×64");
  await expect(page.getByTestId("source-format")).toHaveText("svg");
  await expect(page.getByTestId("source-size")).toContainText("64×64");
  await expect(page.getByTestId("source-size")).toContainText("vector");
  // And no "source size" preset for a drawing: what the engine reports there is
  // the raster it was asked for, so the button would move whenever the box did.
  await expect(page.getByTestId("size-source")).toHaveCount(0);

  await page.getByTestId("size-screen").click();
  await expect(page.getByTestId("size-input")).toHaveValue("160x144");

  // Both of these wait on a whole second conversion, and it is a far bigger one
  // than the first: 160×144 against a Game Boy Color's lattice is the full
  // tournament where 64×64 was a corner of it. The default expect timeout is
  // enough on a quiet machine and was not on a loaded CI runner in WebKit, which
  // is a slow assertion rather than a wrong one — so it is given room rather
  // than left to flake.
  const canvas = page.getByTestId("result-canvas");
  await expect
    .poll(async () => canvas.evaluate((c: HTMLCanvasElement) => c.width), { timeout: 90_000 })
    .toBe(160);
  // The drawing was *re-rasterised* rather than blown up: the raster the engine
  // fitted from now covers the target instead of being the file's declared 64.
  await expect(page.getByTestId("source-size")).toContainText("160×160", { timeout: 90_000 });

  await page.getByTestId("size-auto").click();
  await expect(page.getByTestId("size-input")).toHaveValue("");
});

test("demakes a JPEG, which the browser never decodes", async ({ page }) => {
  // The engine's own decoder, in the worker, and that is the whole point: JPEG
  // is lossy and specified only to a tolerance, so a `<canvas>` decode here and
  // libjpeg on the command line would be two different demakes of one
  // photograph (doc 02 §Image codecs).
  await page.goto("/#section=art");
  // By its accessible name: the explorer has a file input of its own, and a
  // bare `input[type=file]` would hand this to the zip importer.
  // The engine's own fixture rather than a copy of it: a second copy is a
  // second answer to what the bytes are, and this one is checked against a
  // browser's decode over there.
  await page
    .getByLabel("Choose an image file to convert")
    .setInputFiles("../core/test/fixtures/pattern-q90.jpg");

  await expect(page.getByTestId("source-format")).toHaveText("jpeg");
  await expect(page.getByTestId("source-size")).toContainText("24×16");
  await expect(page.getByTestId("error")).toHaveCount(0);
  await expect(page.getByTestId("result-canvas")).toBeVisible();
});
