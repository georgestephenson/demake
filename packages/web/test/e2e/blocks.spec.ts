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
 *   what, so a reorder has to reach the file — by all three routes, because a
 *   drag has no keyboard, does not fire on touch, and cannot reach past the
 *   bottom of a list that scrolls.
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

test("carries a row with the keyboard once it has been picked up", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  const before = (await sourceText(page)).split("\n");
  const grip = page.getByTestId("block-row-0").locator(".block-grip");
  await grip.focus();

  // Arrows alone walk the list rather than moving anything: a row of controls
  // is expected to do that, and it is how you reach line 60 to pick it up.
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => sourceText(page)).toBe(before.join("\n"));
  await expect(page.getByTestId("block-row-1").locator(".block-grip")).toBeFocused();

  // Space picks the row up, and says so.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("block-status")).toContainText("Line 1 picked up");
  await expect(page.getByTestId("block-row-0")).toHaveClass(/held/);

  // Now the arrows carry it, and the focus travels with the row it is holding.
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(async () => (await sourceText(page)).split("\n").slice(0, 2))
    .toEqual([before[1], before[0]]);
  await expect
    .poll(async () => (await sourceText(page)).split("\n").slice(2))
    .toEqual(before.slice(2));
  await expect(page.getByTestId("block-row-1").locator(".block-grip")).toBeFocused();

  // Escape puts it back where it was picked up, however far it travelled.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect.poll(async () => sourceText(page)).toBe(before.join("\n"));
  await expect(page.getByTestId("block-status")).toContainText("Back at line 1");
});

test("moves a row a long way by choosing where it goes", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  // The file's own lines, without the empty string its terminating newline
  // leaves behind — that one is the newline, not a row.
  const before = (await sourceText(page)).replace(/\n$/, "").split("\n");
  // Pong is around seventy lines and the list shows a dozen, so this is the move
  // a drag cannot make: the last row to the very top, in two keystrokes.
  const last = before.length - 1;
  await page
    .getByTestId(`block-row-${String(last)}`)
    .locator(".block-grip")
    .click();
  const chooser = page.getByTestId("block-moveto");
  await expect(chooser).toBeVisible();

  // Typing a line number filters to it; Enter takes the first match.
  await chooser.locator("input").fill("1");
  await page.keyboard.press("Enter");

  const after = async (): Promise<string[]> =>
    (await sourceText(page)).replace(/\n$/, "").split("\n");
  await expect.poll(async () => (await after())[0]).toBe(before[last]);
  await expect.poll(async () => (await after()).slice(1)).toEqual(before.slice(0, last));
});

test("the list scrolls itself while a drag sits near its edge", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page, "source-view-select", "blocks");

  const rows = page.getByTestId("block-rows");
  // The list is a fixed-height scroller, which is the whole reason this matters:
  // without the edge scrolling a drag could only ever reach the rows already on
  // screen — with a mouse, so this was never only an accessibility gap.
  expect(await rows.evaluate((el) => el.scrollHeight > el.clientHeight + 40)).toBe(true);

  // The drag events are dispatched rather than performed, and that is deliberate:
  // starting a *native* drag from synthesised mouse input works in Chromium and
  // not in the other two engines, so driving it that way would test Playwright's
  // input synthesis rather than the page. What is ours is the handler and the
  // frame loop it starts, and that is what runs here — in all three engines.
  await rows.evaluate((el) => {
    const grip = el.querySelector(".block-grip") as HTMLElement;
    grip.dispatchEvent(new DragEvent("dragstart", { bubbles: true }));
  });
  // A separate call, so the row list has re-rendered with a drag in progress
  // before the next event arrives — dispatched back to back in one evaluate, the
  // `dragover` handler would still be the closure that thinks nothing is moving.
  await rows.evaluate((el) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientY: box.bottom - 6,
        clientX: box.left + box.width / 2,
      }),
    );
  });

  // It keeps going while the pointer stays there, because it is a frame loop
  // rather than a reaction to movement — a pointer held perfectly still at the
  // edge stops producing drag events in some browsers.
  await expect
    .poll(async () => rows.evaluate((el) => el.scrollTop), { timeout: 5000 })
    .toBeGreaterThan(0);

  await rows.evaluate((el) => {
    el.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
  });
  const stopped = await rows.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(300);
  expect(await rows.evaluate((el) => el.scrollTop)).toBe(stopped);
});

test("finds a statement by typing at the palette", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  const before = await sourceText(page);
  const search = page.getByTestId("block-search");
  await search.fill("camera");
  // The chips filter to what matches, so the grid is also the search result.
  await expect(page.getByTestId("block-palette").locator("button")).toHaveCount(1);
  await page.keyboard.press("Enter");

  await expect.poll(async () => sourceText(page)).not.toBe(before);
  await expect.poll(async () => sourceText(page)).toContain("camera follows");
  await expect(search).toHaveValue("");
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
