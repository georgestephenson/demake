/**
 * The block editor and the suite editor (doc 19 §The block editor, §The shell).
 *
 * What is guarded here is everything about the arrangement that could look right
 * and be wrong:
 *
 * - **A `.test.dmt` opens the suite editor**, not the game demaker. It is a
 *   `.dmt` too, so the router used to hand it a console picker, a cartridge and a
 *   playable preview — around a file that builds to nothing.
 * - **Blocks are a view over the file, not a second format.** What the fields
 *   write is what the text view shows, so the two are checked against each other
 *   rather than each against itself.
 * - **Moving a row is an edit**, and it has to reach the file by all three
 *   routes, because a drag has no keyboard, does not fire on touch, and cannot
 *   reach past the bottom of a list that scrolls.
 * - **A problem is shown where it is.** Against its own row, counted above the
 *   list, and — when it names no row, which is how a suite reports a broken game
 *   — at the top rather than nowhere.
 * - **One tab stop per row, not one per control.** Every control of every row
 *   being tabbable put 352 stops in front of a seventy-line game.
 */

import { expect, test, type Page } from "@playwright/test";

/**
 * The file as text.
 *
 * There is no side-by-side any more (doc 19), so reading the source means asking
 * for the other view — which is also a check worth having on every edit below:
 * the two views are the same file, and switching between them changes nothing.
 */
async function sourceText(page: Page): Promise<string> {
  const picker = page.getByTestId("source-view-select").or(page.getByTestId("suite-view-select"));
  await picker.selectOption("text");
  const value = await page.locator(".source-input").first().inputValue();
  await picker.selectOption("blocks");
  await expect(page.getByTestId("block-editor")).toBeVisible();
  return value;
}

/**
 * Show the blocks.
 *
 * The pane opens on the **text**, because the claim the game section makes is
 * that a whole game is sixty readable lines and blocks are the alternative — so
 * a test about them has to ask, exactly as a test about the interpreter has to
 * ask for the preview.
 */
async function showBlocks(page: Page, picker = "source-view-select"): Promise<void> {
  await page.getByTestId(picker).selectOption("blocks");
  await expect(page.getByTestId("block-editor")).toBeVisible();
}

/** The file's own lines, without the empty string a terminating newline leaves. */
function lines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
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

test("offers the two views and no third", async ({ page }) => {
  await page.goto("/#section=game");
  const picker = page.getByTestId("source-view-select");
  await expect(picker.locator("option")).toHaveText(["Text", "Blocks"]);
  // Text is the default: a whole game is sixty readable lines, and somebody who
  // arrives at a form cannot see that.
  await expect(picker).toHaveValue("text");
});

test("shows a game as one block per line, with the statements the registry lists", async ({
  page,
}) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  // One row per line of the file, blank lines and comments included — that is
  // what makes the view lossless rather than a summary of the program. Counted
  // against the *text* view of the same file, which is the claim being made.
  const count = lines(await sourceText(page)).length;
  expect(count).toBeGreaterThan(20);
  await expect(page.getByTestId("block-rows").locator("> li")).toHaveCount(count);

  // The palette is generated: `create object` is in it because `STATEMENTS` has
  // it, not because the page keeps a list.
  await expect(page.getByTestId("block-palette").locator("button")).toHaveCount(13);
  await expect(
    page.getByTestId("block-palette").locator('[data-keyword="create object"]'),
  ).toBeVisible();
});

test("puts one tab stop on a row, not one on every control", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  const rows = page.getByTestId("block-rows");
  const all = await rows.locator("button, input, select, textarea").count();
  const tabbable = await rows
    .locator('[tabindex="0"], button:not([tabindex]), input:not([tabindex])')
    .count();
  // A seventy-line game has hundreds of controls; only the active row's are in
  // the tab order, so the editor can be tabbed *past*.
  expect(all).toBeGreaterThan(100);
  expect(tabbable).toBeLessThan(12);

  // The arrows walk between rows, and the row they land on is the one whose
  // controls become reachable.
  await page.getByTestId("block-row-0").locator(".block-grip").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("block-row-1")).toHaveClass(/active/);
  await expect(page.getByTestId("block-row-0")).not.toHaveClass(/active/);
});

test("writes a field straight into the file and nothing else", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  const before = await sourceText(page);
  // `start title` is the first statement in Pong, and its one slot is a scene.
  await page.locator('[data-slot="scene"]').first().selectOption("play");

  expect(await sourceText(page)).toBe(before.replace("start title", "start play"));
});

test("adds a statement where you are, not at the end", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);
  const before = lines(await sourceText(page));

  // Focusing a row is what makes it the active one, so a keyboard user can
  // choose where a statement lands without touching the mouse.
  await page.getByTestId("block-row-3").locator(".block-grip").focus();
  await page.getByTestId("block-palette").locator('[data-keyword="seed"]').click();

  const after = lines(await sourceText(page));
  expect(after.length).toBe(before.length + 1);
  expect(after[4]).toContain("seed");
  expect(after.slice(0, 4)).toEqual(before.slice(0, 4));
});

test("carries a row with the keyboard once it has been picked up", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  const before = lines(await sourceText(page));
  await page.getByTestId("block-row-0").locator(".block-grip").focus();

  // Arrows alone walk the list rather than moving anything: a row of controls is
  // expected to do that, and it is how you reach line 60 to pick it up.
  await page.keyboard.press("ArrowDown");
  expect(lines(await sourceText(page))).toEqual(before);
  await page.getByTestId("block-row-0").locator(".block-grip").focus();

  // Space picks the row up, and says so.
  await page.keyboard.press("Space");
  await expect(page.getByTestId("block-status")).toContainText("Line 1 picked up");
  await expect(page.getByTestId("block-row-0")).toHaveClass(/held/);

  // Now the arrows carry it, and the focus travels with the row it is holding.
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("block-row-1").locator(".block-grip")).toBeFocused();
  const moved = lines(await sourceText(page));
  expect(moved.slice(0, 2)).toEqual([before[1], before[0]]);
  expect(moved.slice(2)).toEqual(before.slice(2));

  // Escape puts it back where it was picked up, however far it travelled.
  await page.getByTestId("block-row-1").locator(".block-grip").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("block-status")).toContainText("Back at line");
  expect(lines(await sourceText(page))).toEqual(moved);
});

test("moves a row a long way by choosing where it goes", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  const before = lines(await sourceText(page));
  // Pong is around seventy lines and the list shows a dozen, so this is the move
  // a drag cannot make: the last row to the very top, from the keyboard.
  const last = before.length - 1;
  await page
    .getByTestId(`block-row-${String(last)}`)
    .locator(".block-grip")
    .focus();
  await page.keyboard.press("Enter");
  const chooser = page.getByTestId("block-moveto");
  await expect(chooser).toBeVisible();

  // Typing a line number filters to it; Enter takes the first match.
  await chooser.locator("input").fill("1");
  await page.keyboard.press("Enter");

  const after = lines(await sourceText(page));
  expect(after[0]).toBe(before[last]);
  expect(after.slice(1)).toEqual(before.slice(0, last));
});

test("closes a picker on Escape and gives the keyboard back", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  const grip = page.getByTestId("block-row-0").locator(".block-grip");
  await grip.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("block-moveto")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("block-moveto")).toHaveCount(0);
  // A panel you close should hand the focus back to what opened it, or the next
  // Tab starts from the top of the document.
  await expect(grip).toBeFocused();
});

test("the list scrolls itself while a drag sits near its edge", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

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

  const search = page.getByTestId("block-search");
  await search.fill("camera");
  // The chips filter to what matches, so the grid is also the search result.
  await expect(page.getByTestId("block-palette").locator("button")).toHaveCount(1);
  await page.keyboard.press("Enter");

  expect(await sourceText(page)).toContain("camera follows");
  await expect(search).toHaveValue("");
});

test("picks a sprite from the project's own pictures", async ({ page }) => {
  await page.goto("/#section=game");
  await showBlocks(page);

  const before = await sourceText(page);
  // The backdrop statement's art field, opened as a gallery of real pictures.
  await page.locator('[data-slot="art"]').first().click();
  const gallery = page.getByTestId("block-gallery");
  await expect(gallery).toBeVisible();
  const tiles = gallery.locator("button");
  expect(await tiles.count()).toBeGreaterThan(1);
  // They are the pictures themselves, drawn — not a list of filenames.
  await expect(tiles.first().locator("img")).toBeVisible();
  // The panel is inside a scrolling list, so what matters is that it is part of
  // what scrolls rather than clipped out of it: absolutely positioned, it was
  // unreachable the moment its row sat near the bottom.
  await gallery.scrollIntoViewIfNeeded();
  const cut = await gallery.evaluate((el) => {
    const list = el.closest(".block-rows") as HTMLElement;
    return el.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom;
  });
  expect(cut).toBeLessThanOrEqual(1);

  await tiles.last().click();
  expect(await sourceText(page)).not.toBe(before);
});

test("shows a problem against the row it is about", async ({ page }) => {
  await page.goto("/#section=game");
  await expect(page.locator(".source-editor")).toBeVisible();
  // Written as text so the broken line is a known one: `start` names a scene
  // that is never declared, on line 1.
  await page.getByLabel("Demotic game source").fill("start nowhere\nscene play\n");
  await showBlocks(page);

  const row = page.getByTestId("block-row-0");
  await expect(row).toHaveClass(/has-error/);
  await expect(row.locator(".diag-error")).toContainText("E_UNKNOWN_SCENE");
  // Counted above the list, with a way to the first one — a row scrolled out of
  // view is a problem you cannot see.
  await expect(page.getByTestId("block-problems")).toContainText("1 error");
  await page.getByTestId("block-goto-problem").click();
  await expect(row.locator(".block-grip")).toBeFocused();
});

test("says the game is broken when a suite could never pass", async ({ page }) => {
  await page.goto("/#file=src%2Fpong.dmt");
  await expect(page.locator(".source-editor")).toBeVisible();
  await page.getByLabel("Demotic game source").fill("start nowhere\nscene play\n");
  await expect(page.locator(".diag-error")).toBeVisible();

  // The suite names no row for this, because it is about a different file — so
  // it goes at the top of the list rather than nowhere at all.
  await page.getByTestId("explorer-file").filter({ hasText: "pong.test.dmt" }).first().click();
  await showBlocks(page, "suite-view-select");
  const loose = page.getByTestId("block-loose");
  await expect(loose).toBeVisible();
  await expect(loose).toContainText("pong.dmt");
  await expect(loose).toContainText("E_UNKNOWN_SCENE");
});

test("shows a suite's own statements, which are not a game's", async ({ page }) => {
  await page.goto("/#file=src%2Fpong.test.dmt");
  await showBlocks(page, "suite-view-select");
  const palette = page.getByTestId("block-palette");
  await expect(palette.locator("button")).toHaveCount(5);
  await expect(palette.locator('[data-keyword="expect"]')).toBeVisible();
  await expect(palette.locator('[data-keyword="create"]')).toHaveCount(0);
});
