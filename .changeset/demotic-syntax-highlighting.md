---
"@demake/demotic": minor
---

Syntax colouring for Demotic, and example games you can read at a glance.

`@demake/demotic` now exports `highlight()`, which scopes source with **TextMate
scope names** — `keyword.control`, `string.quoted`, `constant.numeric`, the
convention every editor and every theme already speaks. A theme matches on scope
prefixes, so a consumer that knows nothing about this language can colour it
correctly, and a future `.tmLanguage` file is a translation of one table rather
than a second grammar.

**It is generated from the language registry, and runs on the lexer.** Every word
it knows comes from `spec.ts` and every token boundary comes from `lex()`, so a
keyword added to the registry is coloured the day it is added — and the one thing
a regular-expression highlighter always gets wrong here has exactly one answer:
`y--1` is a comment and `y - -1` is not, decided in `lex.ts` and nowhere else.
It is deliberately lexical, so it colours a program that does not parse, which is
the state an editor spends most of its time in. Where a word's meaning depends on
position rather than spelling — `start` is a statement and a button, `scene` is a
statement and an assignment target, `left` is a button and a derived property —
it reads the token before it and no further.

Three things moved into the registry to make that possible, since the highlighter
must not be a second description of the language: the **clause keywords** (`in`,
`from`, `then`, `hits`, `reaches`, …), which were literals in the parser; the
**compass directions**, which were a table in the compiler; and `flip`. A test
checks the keyword table against the syntax lines of the statements and triggers
that use it, in both directions, so a keyword cannot be added to the grammar
without appearing there — and the generated reference gained a clause-keyword
table and a compass-direction table it never had.

**The web app colours its editor with it** (doc 07). The grammar is the engine's;
the colours are the stylesheet's — the conventional ones, comments green,
keywords blue, control flow magenta, strings red-brown, numbers pale green — and
the engine never names a colour. It is still an ordinary `<textarea>` with a
`<pre>` of colours stacked underneath, so native editing, selection, mobile
keyboards and the accessibility tree all survive.

**The cartridge is now rebuilt when typing stops, not per keystroke.** Compiling
stays live, because the diagnostics and the preview have to answer as you type,
but a cartridge is the art demade, the audio demade and a whole assembly. The ROM
pane keeps playing the one it has and shows a _demaking…_ badge while a newer one
is coming: a screen that blanked as you typed would be worse than one that is a
version behind.

**And the example games lost their essays.** The page shows a game's source
beside the cartridge it built, and the claim being made there is that a whole game
is sixty lines — an example whose commentary outweighs its code argues the
opposite, however good the commentary is. Pong is 69 lines where it was 149. A
comment earns its place only where the line above it cannot be read without one:
tick order, an absolute unit chosen over a relative one, a rule that is `touches`
where `hits` looks right. The rationale that used to sit in the fixtures is in
doc 14 and `AGENTS.md`, where it can be longer and is read by the people it is
for. Section rules are short enough not to wrap in the editor. No game's
behaviour changed — every trace is byte-identical.
