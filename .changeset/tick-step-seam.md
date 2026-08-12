---
"@demake/demotic": patch
---

Name the seam inside a tick, and measure whether it is where a bank can be cut.

A LoROM bank is thirty-two kilobytes and a Game Boy's is sixteen, so the Super
Nintendo takes a whole scene per bank and the 8-bit consoles cannot — three of
`quest`'s seven scenes overrun a 16 KiB window and its worst `SceneTick` overruns
it on its own. Cutting a tick smaller than a routine is the answer, and there is
exactly one place it can be cut: a step boundary is the only point inside a tick
at which nothing is live, because the steps hand work to each other through the
entity records and the contact bitfield and never through a register.

`TickSteps.boundary` is that point, named. `emitTickSteps` calls it before each
step, so the order it reports is doc 14's order by construction; a backend that
does not want the seam leaves it unimplemented and nothing changes. The Game Boy
backend implements it as a label, which emits no bytes — every cartridge is
byte-identical — and makes a profile bucketed by symbol name the _step_ rather
than the whole tick, which is the workflow AGENTS.md already describes on that
console.

What it bought immediately is the measurement the plan was missing: `quest`'s
largest step is 9694 bytes against a 16 KiB window, so cutting a tick at its
steps **is** enough and the granularity does not have to go lower.
`tick-steps.test.ts` pins both halves — the boundaries exist in order for every
scene, and no step of any example reaches a window.

Doc 13 now records what the real remaining blocker is, with numbers: the fixed
bank rather than the window. About 30 KiB of `quest` wants to be always mapped
against a Game Boy's 16 and a Sega 8-bit's 32, which is why the Sega is the next
console to bank and why the Game Boy needs its audio schedules paged by the
driver first.
