---
"@demake/demotic": patch
---

Move the 68000's value layer, expression compiler, rule bodies and tile walk out
of the Mega Drive backend and into a shared `codegen/m68k/`.

The Neo Geo is the second console in the set to run this instruction set, and
AGENTS.md is explicit about what that means: if you find yourself copying a
function from one backend into another, that function is in the wrong place —
move it, do not duplicate it. This is the same extraction `codegen/mos/` got when
the PC Engine arrived beside the NES, and it lands for the same reason and with
the same dividing line. What moved is everything that is the _processor's_; what
stayed is `md/emit.ts`, which is the renderer and the only thing a Mega Drive
backend now owns.

The five files needed no surgery to move, which is the evidence that the line was
already in the right place: none of them imported a Mega Drive address, a VDP
register or a memory plan — only the 68000 encoder, `shape.ts`, `layout.ts` and
each other. `MdCtx` is `M68kCtx` now, and its comment says the context has no
per-console question in it deliberately rather than incidentally.

No output bytes change: every fixture's Mega Drive cartridge is byte-identical
across the move, which is what was checked rather than the traces alone.
