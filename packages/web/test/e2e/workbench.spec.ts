/**
 * The workbench (doc 07 §The workbench, doc 19 §A file manager, after all).
 *
 * What the section tabs used to do is now split between two things — the
 * explorer decides what is open, and the menu bar carries the commands — so
 * these cover the joins: a bare URL lands on the project's game, the menus'
 * accelerators do what the menus say they do, and the file operations reach the
 * project rather than only the tree.
 *
 * The text editor is here rather than in a file of its own because it exists for
 * one file in particular: doc 19 promises the Demakefile is "also just a file in
 * the explorer", and that was not true while nothing opened one.
 */

import { expect, test } from "@playwright/test";

/** The modifier this platform's accelerators use — the menus say the same. */
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test("a bare URL opens the project's own game", async ({ page }) => {
  await page.goto("/");
  // Doc 19's entry-point rule: the single `.dmt` in `src/`. The art demaker used
  // to be the landing page, and it was only ever that because it was written
  // first.
  await expect(page.getByTestId("open-game")).toHaveText("pong.dmt");
  await expect.poll(async () => page.evaluate(() => location.hash)).toContain("pong.dmt");
  await expect(page.getByRole("heading", { name: "Play" })).toBeVisible();

  // The window says what it is, and so does the tab — one string, two places.
  await expect(page.getByTestId("window-title")).toContainText(
    "one source project, ROMs for every game console",
  );
  expect(await page.title()).toBe("demake — one source project, ROMs for every game console");

  // And there is no section nav left to disagree with the open file.
  await expect(page.locator(".section-link")).toHaveCount(0);
});

test("a hash with nothing in it is a bare URL too", async ({ page }) => {
  // `#` rather than no hash at all, which is what a `href="#"` and a stripped
  // query leave behind — and what a spec building a hash out of only-default
  // options produces. That is not hypothetical: `determinism.spec.ts` built
  // exactly this string for its default case and landed on a game where it
  // wanted the art demaker, and no test said so until CI did.
  await page.goto("/#");
  await expect(page.getByTestId("open-game")).toHaveText("pong.dmt");
});

test("the title bar's tagline follows the file that is open", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("explorer-file").filter({ hasText: "ball.svg" }).first().click();
  await expect(page.getByTestId("window-title")).toContainText("hardware-compliant console art");
  expect(await page.title()).toContain("hardware-compliant console art");
});

test("an option permalink still opens the art demaker", async ({ page }) => {
  // The compatibility promise: a hash with anything in it is a link somebody
  // shared, even when it names neither a file nor a section.
  await page.goto("/#console=snes&dither=bayer4");
  await expect(page.getByTestId("console-select")).toHaveValue("snes");
  await expect(page.getByTestId("dither-select")).toHaveValue("bayer4");
});

test("the menu bar runs its commands, and its keys do the same thing", async ({ page }) => {
  await page.goto("/");

  // A menu opens, shows its accelerators, and closes on Escape.
  await page.getByTestId("menu-view").click();
  const explorerItem = page.getByTestId("toggle-explorer");
  await expect(explorerItem).toBeVisible();
  await expect(explorerItem.locator("kbd")).toHaveText(MOD === "Meta" ? "⌘B" : "Ctrl+B");
  await page.keyboard.press("Escape");
  await expect(explorerItem).toBeHidden();

  // The entry and the key are one declaration, so they must agree.
  await expect(page.locator(".explorer")).toBeVisible();
  await page.keyboard.press(`${MOD}+b`);
  await expect(page.locator(".explorer")).toBeHidden();
  await page.getByTestId("menu-view").click();
  await page.getByTestId("toggle-explorer").click();
  await expect(page.locator(".explorer")).toBeVisible();
});

test("one tap switches between open menus", async ({ browser }) => {
  // A finger has no hover, so the `pointerenter` a tap fires is the first half
  // of that tap and not a movement of its own. Acting on it opened the menu the
  // tap then closed again — every switch took two taps, and only on a
  // touchscreen, which is why this test has a context of its own.
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  await page.goto("/");

  await page.getByTestId("menu-file").tap();
  await expect(page.getByRole("menu", { name: "File" })).toBeVisible();
  await page.getByTestId("menu-view").tap();
  await expect(page.getByRole("menu", { name: "View" })).toBeVisible();
  await expect(page.getByRole("menu", { name: "File" })).toBeHidden();

  // And a tap on the menu that is already open still closes it.
  await page.getByTestId("menu-view").tap();
  await expect(page.getByRole("menu", { name: "View" })).toBeHidden();
  await context.close();
});

test("a mouse switches menus by pointing, and the click that follows keeps it", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("menu-file").click();
  // Pointing at another title switches to it — the interaction that makes a
  // menu bar feel like a menu bar.
  await page.getByTestId("menu-view").hover();
  await expect(page.getByRole("menu", { name: "View" })).toBeVisible();
  // Clicking the title the pointer just switched to is the same gesture, not a
  // second one, so it does not close what it opened.
  await page.getByTestId("menu-view").click();
  await expect(page.getByRole("menu", { name: "View" })).toBeVisible();
  // A second click is a second gesture, and closes it.
  await page.getByTestId("menu-view").click();
  await expect(page.getByRole("menu", { name: "View" })).toBeHidden();
});

test("go to file opens a file by typing at it", async ({ page }) => {
  await page.goto("/");
  // Wait for the app before pressing a key at it. `goto` resolves on the
  // document, and the accelerators are bound by an effect after the first
  // render — so on a loaded CI runner the keystroke arrived first, nothing
  // listened, and the browser's own print dialog got it instead. Every other
  // test here starts with a click, which auto-waits and hid this.
  await expect(page.getByTestId("open-game")).toBeVisible();
  await page.keyboard.press(`${MOD}+p`);
  await expect(page.getByTestId("quick-open")).toBeVisible();
  await page.keyboard.type("rally");
  await page.keyboard.press("Enter");
  // A `.mid` opens the music demaker because it is a track, not because a nav
  // link was set to a matching value.
  await expect(page.getByRole("heading", { name: "Arrangement" })).toBeVisible({ timeout: 60_000 });
});

test("adds, renames, moves and deletes a file", async ({ page }) => {
  await page.goto("/");
  const files = () =>
    page
      .getByTestId("explorer-file")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset["path"] ?? ""));

  // Add. Naming it into a folder that does not exist creates the folder,
  // because the folder was never a thing — it is a prefix.
  await page.getByTestId("new-file").click();
  await page.getByTestId("explorer-rename").fill("notes/todo.md");
  await page.getByTestId("explorer-rename").press("Enter");
  await expect.poll(files).toContain("notes/todo.md");
  // It opens, in the text editor, because that is what a `.md` is.
  await expect(page.getByRole("heading", { name: "notes/todo.md" })).toBeVisible();

  // Type into it, and the project has it: the editor is the project's, not a
  // scratch buffer beside it.
  await page.getByLabel("todo.md source").fill("remember the milk");
  await expect(page.getByTestId("project-dirty")).toHaveText("unsaved changes");

  // Rename, which is also a move — and the editor follows the file it had open.
  await page.getByTestId("rename-file").and(page.locator('[data-path="notes/todo.md"]')).click();
  await page.getByTestId("explorer-rename").fill("src/todo.md");
  await page.getByTestId("explorer-rename").press("Enter");
  await expect.poll(files).toContain("src/todo.md");
  await expect.poll(files).not.toContain("notes/todo.md");
  await expect(page.getByRole("heading", { name: "src/todo.md" })).toBeVisible();
  await expect(page.getByLabel("todo.md source")).toHaveValue("remember the milk");

  // A rename onto an occupied path is refused out loud rather than performed.
  await page.getByTestId("rename-file").and(page.locator('[data-path="src/todo.md"]')).click();
  await page.getByTestId("explorer-rename").fill("src/pong.dmt");
  await page.getByTestId("explorer-rename").press("Enter");
  await expect(page.getByTestId("project-notice")).toContainText("already exists");
  await expect.poll(files).toContain("src/todo.md");

  // Delete, and the editor falls back to the project's game rather than blanking.
  await page.getByTestId("delete-file").and(page.locator('[data-path="src/todo.md"]')).click();
  await expect.poll(files).not.toContain("src/todo.md");
  await expect(page.getByTestId("open-game")).toHaveText("pong.dmt");
});

test("the text editor colours a Demakefile with the format's own grammar", async ({ page }) => {
  await page.goto("/");

  // Pong ships without a build file, so make the one doc 19 says appears on the
  // first changed option — by hand here, which is the same file.
  await page.getByTestId("new-file").click();
  await page.getByTestId("explorer-rename").fill("Demakefile");
  await page.getByTestId("explorer-rename").press("Enter");

  const box = page.getByLabel("Demakefile source");
  await expect(box).toBeVisible();
  await box.fill("project pong\n  title Pong\n\ntargets gb nes\n\nart ball.svg  # the ball\n");

  // The scopes are `@demake/demotic`'s, from the parser's own word lists. What
  // this test owns is that they reach the DOM: a page-side lexer would be doc
  // 07's forbidden second implementation.
  for (const scope of ["storage.type", "keyword.other", "comment.line.number-sign"]) {
    await expect(page.locator(`.source-highlight [data-scope="${scope}"]`).first()).toBeVisible();
  }

  // And a file the engine has no grammar for is drawn plain rather than
  // approximated — nothing here guesses at Markdown.
  await page.getByTestId("new-file").click();
  await page.getByTestId("explorer-rename").fill("README.md");
  await page.getByTestId("explorer-rename").press("Enter");
  await page.getByLabel("README.md source").fill("# A heading\n\nsome *text*.\n");
  await expect(page.locator(".source-highlight [data-scope]")).toHaveCount(0);
});
