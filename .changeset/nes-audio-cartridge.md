---
"@demake/audio": minor
"demake": minor
---

`demake gen <schedule> -c nes --format rom` builds a cartridge.

The Game Boy has been the only console whose _standalone_ audio cartridge exists
— a ROM whose whole job is one track or one effect — while every other console
with a driver could only play one from inside a game. The NES is the second, and
the interesting thing about it is how little it needed.

**Nothing about the player moved.** `rom/mos-player.ts` belongs to the
_processor_, not to either of the machines that run it, and a game already drove
it. So `rom/nes.ts` is the three things a console decides for itself and nothing
else:

- **The clock is the picture's.** This CPU has no timer a driver can have
  without burning the DMC channel, so where `gb.ts` chooses between a timer and
  the frame, here there is nothing to choose — and a schedule fitted to anything
  else is refused by name rather than rounded to something playable.
- **There is no entry point, only a vector.** The last six bytes of the image
  are what makes the cartridge boot, stamped after assembly because they are
  addresses of labels inside it; a builder that left them zero would ship
  something that jumps into its own padding.
- **The picture hardware has to be quietened and waited for.** A cartridge whose
  only job is sound still owns the PPU, and the APU's frame counter is parked as
  well — its IRQ shares the vector this driver points at an `rti`, so leaving it
  armed would be an interrupt arriving between two writes of a tick.

The board is elastic on the game backend's terms: an NROM-128 when the schedule
fits one and an NROM-256 when it does not, so a track gets the board a track that
size shipped on.

**The proof is the Game Boy's, run in `@demake/nes`** — the same
`it.each(audioRomConsoles())` battery diffing every register write against the
`ChipScript` tick for tick with no tolerance, plus a one-shot per console,
because where a stream _ends_ is the order walk's business and that walk is the
processor's rather than the machine's.

**And which consoles do this is now derived rather than written down.**
[`console-support.md`](../docs/console-support.md) grew an **audio ROM** column
beside its in-game one, because the two are different questions with different
answers: a Master System's cartridges play music inside a game and there is no
standalone player for a Z80. The refusal says so by name — a console with a
driver but no cartridge is told what it does have.
