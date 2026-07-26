---
"@demake/demotic": minor
---

Reject the readings Demotic used to guess between (doc 14 §The readings the
language will not guess between). Each of these parsed cleanly and produced a
program that was not the one in the file, so nothing downstream could catch
them — the game simply played wrong:

- `E_GLUED_COMMENT` — `--` must now be preceded by a space or start the line.
  It is also two minus signs, so `y as y--1` was a comment that discarded the
  rest of the statement where `y as y - -1` was meant.
- `E_UNTERMINATED_STRING` — a string with no closing quote is reported where it
  opens, rather than swallowing the line and getting a later bracket blamed.
- `E_UNKNOWN_UNIT` — a word attached to a number is a misspelled unit
  (`40vmn`), reported as one instead of surfacing as a stray token. When it
  looks like an asset (`8bit.png`), the message says to quote it instead.
- `E_DUPLICATE_PROP` — one `( … )` list may not set the same property twice, in
  either the named or the positional form.
- `E_DUPLICATE_CONTROL` — two bindings may not write one property from one
  button and mode; their `on hold` restores unwind into each other.
- `E_DUPLICATE_CAMERA` — a scene has one viewport, as it has one playfield.

`.dmtl` legends take the same space-before rule for comments, so an art filename
containing `--` is no longer truncated.

`lex()` now returns `{ tokens, notes }` rather than a bare token array, and
`Token` carries `spaceBefore`. The lexer still never fails: it records what it
finds suspicious and the parser decides, keeping error recovery in one phase.
No output bytes change — every fixture game builds to the same cartridge.
