/**
 * The level editor (doc 19 §The level editor).
 *
 * Two claims, and both are about the *file* rather than about the UI. Opening a
 * `.dmtl` from the explorer opens an editor for it, on demand — the art demaker
 * must not carry a level editor it never shows. And painting a cell rewrites one
 * character of one line: the grid is a view over the format, so a drawn edit and
 * a typed one produce the same file, and everything the editor did not touch
 * comes back exactly as it was.
 */

import { expect, test } from "@playwright/test";

/** The one example with levels in it. */
async function openCaves(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("project-select").selectOption("caves");
  await page.getByTestId("explorer-file").filter({ hasText: "cavern.dmtl" }).click();
}

test("opens a level on demand, drawn with the project's own art", async ({ page }) => {
  const chunks: string[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith(".js")) chunks.push(r.url());
  });

  await page.goto("/");
  expect(chunks.some((url) => url.includes("LevelEditor"))).toBe(false);

  await page.getByTestId("project-select").selectOption("caves");
  await page.getByTestId("explorer-file").filter({ hasText: "cavern.dmtl" }).click();

  await expect(page.getByRole("heading", { name: "Legend" })).toBeVisible();
  expect(chunks.some((url) => url.includes("LevelEditor"))).toBe(true);

  // The legend is the file's, and its art is the project's — a dropdown of real
  // pictures rather than a typed filename.
  const rows = page.getByTestId("legend").locator("li");
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText("wall");
  await expect(rows.first().locator("select")).toHaveValue("rockwall.svg");

  // The grid is a canvas sized in whole cells: 60 wide at 16 px each.
  await expect(page.getByTestId("level-grid")).toHaveAttribute("width", "960");
});

test("painting a cell rewrites that character and nothing else", async ({ page }) => {
  await openCaves(page);

  const text = page.getByRole("textbox", { name: "Level source" });
  const before = (await text.inputValue()).split("\n");

  // Paint with the second legend entry — `ledge`, which the cavern draws with
  // `=` — into the open air of row 2, column 5. The character's own field is
  // what selects it: one box, shown and edited in the same place.
  await page.getByTestId("legend").locator("li").nth(1).locator(".legend-char").click();
  const grid = page.getByTestId("level-grid");
  const box = await grid.boundingBox();
  if (!box) throw new Error("the grid is not on screen");
  const cell = box.width / 60;
  await page.mouse.click(box.x + cell * 5.5, box.y + cell * 2.5);

  await expect.poll(async () => (await text.inputValue()).split("\n")).not.toEqual(before);
  const after = (await text.inputValue()).split("\n");

  // Exactly one line differs, by exactly one character, at the column painted.
  const changed = after
    .map((line, index) => (line === before[index] ? -1 : index))
    .filter((i) => i >= 0);
  expect(changed).toHaveLength(1);
  const line = after[changed[0] as number] as string;
  const was = before[changed[0] as number] as string;
  expect(line.length).toBe(was.length);
  expect([...line].filter((one, index) => one !== was[index])).toEqual(["="]);
});

test("changing a tile's character redraws the cells it drew", async ({ page }) => {
  await openCaves(page);

  const text = page.getByRole("textbox", { name: "Level source" });
  const before = await text.inputValue();
  const drawn = [...before.slice(before.indexOf("\nmap\n"))].filter((one) => one === "#").length;
  expect(drawn).toBeGreaterThan(0);

  // `wall` is the cavern's first entry, drawn with `#`.
  const char = page.getByTestId("legend").locator("li").first().locator(".legend-char");
  await expect(char).toHaveValue("#");
  await char.fill("W");
  await char.blur();

  await expect.poll(async () => await text.inputValue()).not.toBe(before);
  const after = await text.inputValue();
  const grid = after.slice(after.indexOf("\nmap\n"));

  // The legend says the new character and the grid is drawn with it: one tile,
  // spelled differently, rather than an entry that draws nothing and a room
  // full of cells the compiler no longer recognises.
  expect(after).toContain("tile W wall");
  expect([...grid].filter((one) => one === "W")).toHaveLength(drawn);
  expect(grid).not.toContain("#");
  await expect(page.getByTestId("legend-note")).toBeHidden();
});

test("refuses a character another tile already draws, and says why", async ({ page }) => {
  await openCaves(page);

  const text = page.getByRole("textbox", { name: "Level source" });
  const before = await text.inputValue();

  // `=` is the second entry's. Merging two tiles' cells under one character is
  // the one edit here no later edit could pick apart, so it is refused rather
  // than written and left to the compiler to report.
  const char = page.getByTestId("legend").locator("li").first().locator(".legend-char");
  await char.fill("=");
  await char.blur();

  await expect(page.getByTestId("legend-note")).toContainText("already draws ledge");
  await expect(char).toHaveValue("#");
  expect(await text.inputValue()).toBe(before);
});

test("a new tile takes the character you type, not the one suggested", async ({ page }) => {
  await openCaves(page);

  const text = page.getByRole("textbox", { name: "Level source" });
  const rows = page.getByTestId("legend").locator("li");
  await expect(rows).toHaveCount(5);

  // The suggestion is a courtesy, shown as a placeholder — and overtypable.
  const field = page.getByTestId("legend-new-char");
  await expect(field).toHaveAttribute("placeholder", /./);
  await field.fill("Z");
  await page.getByRole("button", { name: "Add tile" }).click();

  await expect(rows).toHaveCount(6);
  await expect.poll(async () => await text.inputValue()).toContain("tile Z ");
});
