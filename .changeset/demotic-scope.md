---
---

demake is now four demakers, not one tool with an extra page: art, Demotic games,
and (planned) music and sound. The web app grows a section per demaker with the
art demaker as the unmarked default, so existing option permalinks are unchanged.

Demotic gains `.test.dmt` — assertions written in the game's own expression
language, run against every console at once — compile-time diagnostics for the
hardware traps the cell/tick model makes easy to write (tunnelling, sub-tick
speeds, sprite budgets, offscreen starts, size rounding), and `min`/`max`/`clamp`
plus `always`, which together let a follow rule be proportional rather than
on/off.

Golden traces are re-baselined. No release: `@demake/demotic` is unpublished and
no published package's bytes change.
