---
"@demake/core": patch
---

Web app: a section whose chunk will not load now says so, and the art demaker's
size control says what it is.

Every editor but the art demaker loads on demand, and a rejected `import()` was
dropped on the floor — so the page sat on "Loading…" for ever with no message
and no way out, while the art demaker went on working because it is in the entry
chunk. Opening a `.wav` did nothing and explained nothing. The cause is ordinary:
a tab left open across a deploy holds a shell naming hashed chunks the server has
replaced, so the first lazy section it asks for 404s. The failure is now shown,
with a reload — and only a reload, because asking for the same module again in
the same document is answered from the browser's module map, which is holding the
failure.

The size box is labelled **Output size**, its placeholder carries what `auto`
resolved to rather than the word "auto", and there are presets for the console's
screen and the source's own size. A source smaller than the screen is kept at its
own size, so a 64×64 drawing demakes to a 64×64 corner of a Game Boy — correct,
surprising, and invisible while the only thing the box said was "auto". The
source pane reports the format and the raster the **engine** decoded, rather than
what the browser measured off an `<img>`, and says when a source is vector.

No CLI output bytes change.
