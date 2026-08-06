/**
 * The block editor and the suite editor (doc 19 §The block editor, §The shell).
 *
 * Three things are guarded here and each is a way the arrangement could look
 * right and be wrong:
 *
 * - **A `.test.dmt` opens the suite editor**, not the game demaker. It is a
 *   `.dmt` too, so the router used to hand it a console picker, a cartridge and a
 *   playable preview — around a file that builds to nothing.
 * - **Blocks are a view over the file, not a second format.** What the fields
 *   write is what the text view shows, so the two are checked against each other
 *   rather than each against itself.
 * - **Moving a row is an edit.** Declaration order decides what is drawn over
 *   what, so a reorder has to reach the file — and it has to be reachable from
 *   the keyboard, because a drag is a mouse.
 */

import { expect, test } from "@playwright/test";

/** The source, as the text view has it. */
async function sourceText(page: import("@playwright/test").Page): Promise<string> {
  return page.locator(".source-input").first().inputValue();
}

/**
 * Show the blocks.
 *
 * The pane opens on the **text**, because the claim the game section makes is
 * that a whole game is sixty readable lines and blocks are the alternative — so
 * a test about them has to ask, exactly as a test about the interpreter has to
 * ask for the preview.
 */
async function showBlocks(
  page: import("@playwright/test").Page,
  picker = "source-view-select",
  mode: "blocks" | "both" = "both",
): Promise<void> {
  await page.getByTestId(picker).selectOption(mode);
  await expect(page.getByTestId("block-editor")).toBeVisible();
}

test("opens a suite in the suite editor rather than the game player", async ({ page }) => {
  await page.goto("/#section=game");
  await expect(page.getByRole("heading", { name: "Play" })).toBeVisible();

  await page.getByTestId("explorer-file").filter({ hasText: "pong.test.dmt" }).first().click();

  await expect(page.getByTestId("open-suite")).toHaveText("pong.test.dmt");
  await expect(page.getByRole("heading", { name: "Suite" })).toBeVisible();
  // The player is gone with it: no console picker, no cartridge, no preview.
  await expect(page.getByTestId("console-select")).toHaveCount(0);
  await expect(page.getByTestId("rom-canvas")).toHaveCount(0);
  // And it says which game its claims are about.
  await expect(page.locator(".game-toolbar").getByRole("link")).toHaveText("src/pong.dmt");
});

test("runs a suite on every console from its own editor", async ({ page }) => {
  await page.goto("/#file=src%2Fpong.test.dmt");
  await expect(page.getByTestId("suite-idle")).toBeVisible();
  await page.getByTestId("run-suite").click();
  await expect(page.getByTestId("suite-summary")).toContainText(
    /\d+\/\d+ cases passed across \d+ consoles/,
  );
  await expect(page.getByTestId("suite-report")).not.toContainText("FAIL");
});

test("shows a game as one block per line, with the statements the registry lists", async ({
  page,
}) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  // One row per line of the file, blank lines and comments included — that is
  // what makes the view lossless rather than a summary of the program. Counted
  // against the *text* view of the same file, which is the claim being made.
  const lines = (await sourceText(page)).replace(/\n$/, "").split("\n").length;
  expect(lines).toBeGreaterThan(20);
  await expect(page.getByTestId("block-rows").locator("> li")).toHaveCount(lines);

  // The palette is generated: `create object` is in it because `STATEMENTS` has
  // it, not because the page keeps a list.
  await expect(page.getByTestId("block-palette").locator("button")).toHaveCount(13);
  await expect(
    page.getByTestId("block-palette").locator('[data-keyword="create object"]'),
  ).toBeVisible();
});

test("writes a field straight into the file and nothing else", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  const before = await sourceText(page);
  // `start title` is the first statement in Pong, and its one slot is a scene.
  const scene = page.locator('[data-slot="scene"]').first();
  await scene.selectOption("play");

  await expect.poll(async () => sourceText(page)).toBe(before.replace("start title", "start play"));
});

test("moves a row with the keyboard, because a drag is a mouse", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  const before = (await sourceText(page)).split("\n");
  // The first row is a comment in every example game; moving it down swaps it
  // with the line under it and leaves the rest of the file alone.
  await page.getByTestId("block-row-0").locator(".block-grip").focus();
  await page.keyboard.press("ArrowDown");

  await expect
    .poll(async () => (await sourceText(page)).split("\n").slice(0, 2))
    .toEqual([before[1], before[0]]);
  await expect
    .poll(async () => (await sourceText(page)).split("\n").slice(2))
    .toEqual(before.slice(2));
});

test("picks a sprite from the project's own pictures", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  // The backdrop statement's art field, opened as a gallery of real pictures.
  await page.locator('[data-slot="art"]').first().click();
  const gallery = page.getByTestId("block-gallery");
  await expect(gallery).toBeVisible();
  const tiles = gallery.locator("button");
  expect(await tiles.count()).toBeGreaterThan(1);
  // They are the pictures themselves, drawn — not a list of filenames.
  await expect(tiles.first().locator("img")).toBeVisible();

  const before = await sourceText(page);
  await tiles.last().click();
  await expect.poll(async () => sourceText(page)).not.toBe(before);
});

test("shows a suite's own statements, which are not a game's", async ({ page }) => {
  await page.goto("/#file=src%2Fpong.test.dmt");
  await showBlocks(page, "suite-view-select");
  const palette = page.getByTestId("block-palette");
  await expect(palette.locator("button")).toHaveCount(5);
  await expect(palette.locator('[data-keyword="expect"]')).toBeVisible();
  await expect(palette.locator('[data-keyword="create"]')).toHaveCount(0);
});
