---
"@demake/demotic": minor
---

A `.dmt` can be dragged instead of typed, and a `.test.dmt` gets an editor of its
own.

**Blocks are a third view on a game** (doc 19 §The block editor), beside the text
and the cartridge, and the text is still the default — the claim the game section
makes is that a whole game is sixty readable lines, and a visitor who arrives at a
form cannot see it. One block is one line: a symbol for the statement, a field for
each part of it you might change, a grip to move it with, and its diagnostics
underneath. There are no wires, no nesting and no canvas, because the language is
flat and the moment a block could express something no line can, the file would
have stopped being the model.

**Every edit is a splice.** Setting a field rewrites the bytes of one slot;
dragging a row moves one line. Nothing is re-emitted from a parsed model, so a row
nobody touched comes back byte-identical because nothing rewrote it rather than
because something was careful — which is what makes the editor safe to open a
hand-written game with. It cannot reformat, requote, reorder or re-space anything
it was not asked to, and a line it cannot read is shown as the text it could not
read rather than rewritten.

**Where the parts of a statement are is the parser's answer, not the page's.**
`parse()` and `parseTests()` now carry a `spans` side channel (`lang/slots.ts`):
the keyword the registry spells it with, the statement's extent, and a slot per
editable part saying what may go in it — a scene, a picture, a button, a compass
heading, an expression. It is the lexer's own habit one phase along, where comment
ranges the parser has no use for are kept so the highlighter needs no second
scanner. Two properties hold it up and are checked against every `.dmt` in the
repository: slots are in source order and never overlap, and a statement
reassembled from its slots and the text between them is byte-identical.

**Every list is generated.** The palette is `STATEMENTS`, so a statement added to
the registry appears the day it lands; the closed sets are `BUTTONS`, `SIDES`,
`DIRECTIONS` and a new `SLOT_CHOICES`, every word of which is checked against
`KEYWORDS`; the properties are `PROPERTIES`, filtered by what it already declares
about them. The project supplies the rest — scenes and objects from the program's
own lines, tiles from its levels' legends, and **art picked as art**: a gallery of
the project's own pictures, written back as the shortest name that identifies one.
The page's only contribution is the symbols, and a test fails when a statement has
none or when one is drawn for a keyword no registry lists.

**A drag is an edit.** Objects live in declaration order, which decides what is
drawn over what and which sprite the hardware drops first past its per-scanline
budget, so nothing here sorts, groups or tidies a file on its own. Rows also move
from the keyboard, because native drag-and-drop has none.

**And a `.test.dmt` no longer opens the game demaker.** It is a `.dmt`, and the
router asked no further question — so a file that builds to nothing arrived with a
console picker, a cartridge and a playable preview around it. It opens the suite
editor now: the same two views over the file, the game it is about named and
linked, and the run — every case on every console at once, which is what makes a
suite a balance check rather than a mechanical one. `gameFor` is the pairing, and
the `.test.dmt` grammar gets a registry of its own (`testing/spec.ts`) rather than
being folded into the language reference, where it would document statements no
game may use.
