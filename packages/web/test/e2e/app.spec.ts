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
  await page.goto("/");
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
  await page.setInputFiles('input[type="file"]', {
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
