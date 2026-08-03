---
"@demake/core": minor
"@demake/demotic": minor
"@demake/web": minor
---

Cartridges are elastic: a game gets the smallest board its console shipped on.

A demade game is twenty-odd kilobytes, and until now four of the six consoles
padded that out to a board chosen once and written down. Now every console that
came on more than one board takes the smallest that holds the program and grows
only when the game does. **Which boards exist is the console's answer** and lives
beside its header in `core/src/asm/*-cart.ts`; a backend's job is to pick, and no
size is offered that the hardware did not ship.

- **NES** — NROM-128 as well as NROM-256. The two boards differ only in where the
  program is assembled: a 16 KiB image is mapped at `$C000` and mirrored at
  `$8000`, so its vectors sit at the top of its own image and nothing else about
  the build changes. Four of the seven example games fit it. `packInesRom` takes
  either length and the header's bank count follows it, so a board cannot
  misdescribe itself; `nesChrOffset` replaces the `NES_CHR_OFFSET` constant,
  because where the characters start is now the header's answer rather than a
  number.
- **Mega Drive** — `MD_ROM_SIZES` starts at 128 KiB rather than 512. One megabit
  is what the early cartridges of this console were, and it is six times the
  biggest example game; half a megabyte was four hundred and eighty kilobytes of
  zeros.
- **Super Nintendo** — two banks rather than four when there is no music to
  upload. Bank zero and bank one are always spoken for (a program, and the tile
  art it draws with) and bank two is the sound processor's image, so a silent
  cartridge is 64 KiB. `packSnesRom` takes either and the size code follows the
  length.
- **Master System / Game Gear, Game Boy Advance, Nintendo DS** — already elastic,
  and unchanged.
- **Game Boy / Color / Mega Duck** — 32 KiB, and it cannot move in either
  direction: the header's smallest size code _is_ 32 KiB and every code above it
  names a mapper. Documented rather than left looking like an oversight.

**`free` now means headroom against the largest board**, not against the one that
shipped. It is the budget-regression signal, and measured against the chosen
board a game that grew a byte past a boundary would have seen its headroom jump
by sixteen kilobytes — a game getting bigger must never look like a game with
more room. `RomStats.cartridge` is what was actually written, and `demake build`
prints it (`code 13096 bytes in a 24 KiB cartridge`).

**And a game that will not fit loses its music first.** `RomStats.cut` names what
was dropped; the CLI prints a `warning:` line and the page puts a note under the
cartridge. It is done by binding the audio again with no asset bytes at all, so
what ships is exactly the cartridge a project with its music left out already
produces — the request bytes a rule writes are still there, so the trace is
unchanged and only the listening differs. A game that still does not fit is
refused, and told the music was already gone.

**Output bytes change** for every NES, Mega Drive and Super Nintendo cartridge:
the code is identical on the boards that did not move, but the file is shorter
and — on an NROM-128 — assembled at a different origin. Game Boy, Master System
and Game Gear cartridges are byte-identical.
