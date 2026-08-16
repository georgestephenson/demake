---
"@demake/audio": minor
---

Count a drum hit lost to a voice that was already ringing, and fail `--strict` on
it — the last thing the arranger dropped silently.

Two hits landing on one driver tick with one drum voice means one of them never
sounds. For most music that is most bars, since a kick under a hat is an ordinary
backbeat: the example library's overworld theme writes 96 drum notes and a Game
Boy played 64, with nothing anywhere saying so. That breaks the rule the whole
domain runs under — never lose a part silently.

The question this raised was a policy one rather than a technical one, because
`Dropped` feeds `--strict`: is a choked hi-hat a build failure, or an `info` the
way a merged voice is? **It is a failure.** A merge still plays the material on
some voice; a choked hit does not sound at all.

Three consequences, each deliberate:

- The drop carries `kind: "note"` rather than `"part"`, because the part still
  plays and only some of its hits went — so `--strict` counts parts and notes
  apart instead of calling thirty-two notes thirty-two parts.
- It has a diagnostic code of its own, `choked-note`, at `warning` rather than
  borrowing `merged-voice`'s `info`.
- It is decided in `compile.ts` rather than in the plan, because whether two hits
  collide depends on the **driver's tick grid** — so `compileScript` now returns
  `{ script, dropped }` and the tournament merges those into the winning
  candidate's plan, which is the only plan they are true of.

**No schedule changes**: this is a report about what was already happening,
verified byte for byte on all twelve consoles. A game build sets no `--strict`, so
cartridges are unaffected. And the number falls where the hardware allows — a Neo
Geo's six-voice pool drops it to zero, a Nintendo DS's two noise generators halve
it — which is the percussion pool and this reporting agreeing with each other.
