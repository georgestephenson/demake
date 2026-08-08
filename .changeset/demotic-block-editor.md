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

**And a statement's arity is editable, not just its parts.** A slot describes a
statement of fixed shape and half the grammar is not that shape: `when ball hits
paddle1, paddle2` has as many targets as the author wrote, a property list as many
entries, a `stream` as many chunks. Drawing only the parts already in the file is
an editor in which a rule's arity was decided by whoever typed the line first, so
`spans` carry a `SourceList` per repeating clause and each one gets a ⊕ at its end
and a ⊖ after every item it may lose. Four things about it are the design (doc 19
§A statement's arity is editable too). A list _contains_ slots rather than
replacing them, so the tiling property above is untouched. An **absent** clause is
a list with no items rather than no list, so a rule with no `from` can still be
narrowed to a side and a `create` with no brackets can still be given a property —
the opener brings the word or the brackets with it, and dropping the last item
takes them back out. The strings are the **grammar's**, because ` from above` is
the language's spelling of that edit and a page that spelled it itself would be a
second statement of the syntax — and a property list's template is computed from
the list it is going into, since `E_DUPLICATE_PROP` makes a fixed one an error on
the row it was just added to. And the positional `(x, y) as (8, 4)` is **one** list
written as two halves that the language refuses to let drift apart (`E_ARITY`), so
one press grows both.

**Every list is generated.** The palette is `STATEMENTS`, so a statement added to
the registry appears the day it lands; the closed sets are `BUTTONS`, `SIDES`,
`DIRECTIONS` and a new `SLOT_CHOICES`, every word of which is checked against
`KEYWORDS`; the properties are `PROPERTIES`, filtered by what it already declares
about them. The project supplies the rest — scenes and objects from the program's
own lines, tiles from its levels' legends, and **art picked as art**: a gallery of
the project's own pictures, written back as the shortest name that identifies one.
The page's only contribution is the symbols, and a test fails when a statement has
none or when one is drawn for a keyword no registry lists.

**Moving a row is an edit**, so nothing here sorts, groups or tidies a file on its
own: objects live in declaration order, which decides what is drawn over what and
which sprite the hardware drops first past its per-scanline budget.

**And a row moves three ways, because a drag alone is the weakest of them.**
Demotic is flat, so a drag expresses one number — which index — rather than a
nesting the way it does in a language with sockets; it is O(distance) in a list
that scrolls, it has no keyboard, and native drag-and-drop does not fire on touch
at all. So the list **scrolls itself** when a drag nears an edge, without which a
move past the visible dozen rows was impossible _with a mouse_; `Space` on the
grip **picks a row up** for the arrows to carry, `Escape` puts it back where it
started, and every step is announced through a live region; and `Enter` on the
grip **chooses a destination** from a filtered list, which reaches line 3 from
line 60 in two keystrokes where dragging is O(distance) and the arrows are
O(rows). The palette is a grid of chips and a search box for the same reason: the
grid is how you learn what the statements are called, the box is how somebody who
knows adds a `when` without reaching for the mouse.

**One tab stop per row, not one per control.** A row of fields per line is a tab
stop per field unless something stops it, and Pong came to 352 of them — a worse
barrier for a keyboard than the drag those keyboard moves were added to replace.
Rows are a roving-tabindex list now: Tab reaches the row you were last on, the
arrows walk between rows, and only that row puts its fields in the tab order. Any
focus inside a row makes it the active one, which is also what decides where a new
statement lands — before, a keyboard could move a row precisely and could not
choose where an added one went.

**A problem is shown where it is.** Against its own row and under its fields, with
the row marked down its left edge; counted above the list with a button to the
first, because a row scrolled out of view is a problem you cannot see; and, when
it names no row at all, at the top of the list rather than nowhere — which is how
the suite editor reports that the _game_ under it will not compile. That last one
was silently dropped, so a suite that could never pass showed nothing anywhere
saying why. A list of line numbers under the editor is the text view's answer; a
graphical view that borrowed it would be asking you to count lines in a thing that
has none to count.

**There is no side-by-side.** Two views of one file earn a split screen when they
show different things, the way the level editor's map does beside the legend that
names its tiles. These two show the same thing twice, in a pane that also holds a
console — so the split bought a second copy of the source at half the width and
doubled the controls between the reader and the rest of the page.

**And a `.test.dmt` no longer opens the game demaker.** It is a `.dmt`, and the
router asked no further question — so a file that builds to nothing arrived with a
console picker, a cartridge and a playable preview around it. It opens the suite
editor now: the same two views over the file, the game it is about named and
linked, and the run — every case on every console at once, which is what makes a
suite a balance check rather than a mechanical one. `gameFor` is the pairing, and
the `.test.dmt` grammar gets a registry of its own (`testing/spec.ts`) rather than
being folded into the language reference, where it would document statements no
game may use.
