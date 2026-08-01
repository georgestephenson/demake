---
"@demake/demotic": minor
"@demake/web": patch
---

The site becomes a window: a title bar, menus, a file tree you can edit, and no
section tabs.

**The tabs are gone**, and their going is the point rather than a tidy-up. A tab
and a file selection were two answers to "what is on screen", and the file is the
better one because it is the thing the project actually contains — clicking
`ball.svg` opens the art demaker because a `.svg` _is_ art, not because a nav link
was set to a matching value. What the tabs were also carrying was the commands,
and those are the **menu bar**'s now: File, Edit, View, Go and Help, with their
accelerators, plus go-to-file on `Ctrl+P`. A menu entry and its keybinding are one
declaration — the same array is what is drawn and what is bound — so a menu cannot
advertise a shortcut nothing listens for.

**A bare URL opens the project's game**, chosen by doc 19's entry-point rule. The
art demaker was the landing page only because it was the first section written,
and a visitor arriving at a tool that turns a game into cartridges should be
looking at the game. `#section=` still reads, so every option permalink shared
before the site held projects opens exactly what it used to.

**The explorer manages files.** Add, rename, move and delete — with a move and a
rename being one gesture, because a project is a flat map from path to bytes and a
folder is a convention in the names, so typing `sprites/ball.svg` over
`art/ball.svg` moves it and so does dragging it onto another folder. Doc 19
originally listed a file manager under Not-in-v1; §A file manager, after all
records why the answer changed. Nothing is replaced silently: a rename onto an
occupied path and a path that climbs out of the project with `..` are both refused
out loud, and the editor follows the file it had open rather than going blank.

**And the window uses the whole window.** Flush panels with a hairline between
them instead of rounded blocks inset in a page, each scrolling on its own, with
the project picker and the dirty marker in a status bar. The title bar names what
this tool does with the file you have open, and the browser tab says the same
thing from the same string.

**A plain text editor**, and a **Demakefile lexer** to go in it. Doc 19 promised
the build file was "also just a file in the explorer", which was not true while
nothing opened one; now any file in the project that no demaker demakes — the
Demakefile, a `.md`, a golden `.trace` — opens in a textarea over the project's own
text. The Demakefile gets colours, and they are the engine's:
`highlightDemakefile()` joins `highlight()` in `@demake/demotic`, built on the
parser's own directive lists (`SINGLE_DIRECTIVES`, `BLOCK_DIRECTIVES`,
`TARGET_FIELDS`) and its own comment rule, so a directive added to the format is
coloured the day it is added and a file is never coloured differently from how it
is read. A file the engine has no grammar for is drawn plain rather than
approximated with a regular expression in the page.

**SVGs display in the art demaker again.** Its source pane built a blob URL with
no media type, and a browser believes a blob's type and does not sniff for SVG —
so every drawing in every project was a broken image _beside a demade result that
had come out perfectly_, because the engine reads the bytes and never the URL. One
media-type table now serves both callers.

**And the service worker's stale-shell fix is finished.** The shell was already
fetched network-first, and the browser's own HTTP cache was answering it: Pages
sends `max-age=600` on `index.html`, so "network-first" meant "up to ten minutes
behind". It is fetched with `cache: "no-store"` now, only `assets/` — where Vite
writes content-hashed output — is cached for ever, and three things outside the
worker finish the job: the registration asks for `updateViaCache: "none"` so
`sw.js` itself is never HTTP-cached, the page checks for an update on load and on
becoming visible again rather than only on navigation, and a page an old worker
was running reloads once when a new one claims it.
