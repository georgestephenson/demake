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
  // `=` — into the open air of row 2, column 5.
  await page.getByTestId("legend").locator("li").nth(1).locator("button").first().click();
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
