---
---

Five maintainer-approved language changes: `start` replaces `loop`; `when` rules
now read `when <trigger> [if <expr>] then <assignments> [else <assignments>]`;
brackets are optional around a single `name as value`; and a level rule naming a
class runs once per object of it, with that object bound as its subject.

`if` closes the "an input edge cannot be conditioned on state" gap — the shooter
now reloads rather than restarting mid-flight. The class-bound level rule closes
the "a level rule cannot address a class" gap — six recycling rules in Dodger
became one.

Golden traces are re-baselined and every example, suite and generated reference
page is migrated. No release: `@demake/demotic` is unpublished.
