---
"@demake/demotic": minor
"@demake/sms": minor
---

Fix what a Sega 8-bit cartridge draws, and make the whole example library fit
on one.

Every example game traced correctly on both machines and none of them looked
right. Everything here sits between the state and the screen, which is exactly
the layer a trace cannot see — the same shape as the Game Gear/NES pass one
release ago, one console further in.

- **Flip bits reached the fitter and not the cartridge.** A Sega name-table entry
  is two bytes and the second carries H/V flip, so the tiled fitter stores one
  tile for up to four orientations and says which one a cell wants. The tile pool
  kept the number and dropped the bits, so every mirrored cell was drawn
  unflipped: the right-hand end of each brick, ledge and letter. It costs no
  tiles to carry them, because it is the same tile either way.

- **The background layer is opaque, and `@demake/sms` was drawing it as if colour
  zero were transparent.** On this hardware transparency belongs to the sprites;
  register 7's backdrop fills the border and the masked left column and never a
  cell of the picture. The core showed the border colour through every flat area
  a demade picture has — the platformer's sky was black. Two consequences are the
  cartridge's rather than the core's: a caption now has paper, so the sprite
  bank's colour zero is pinned to black (no sprite can render it, because it is
  their transparency slot), and a cell's palette-select bit means what it always
  did.

- **The vertical scroll register wraps at 224, not 256.** The name table is
  twenty-eight rows, and reducing `camY + bias` in the accumulator loses
  thirty-two pixels every time the sum passes 255. On a Game Gear that put the
  caves four rows out of step with the rows the redraw had painted, so the top of
  the level wore the title screen.

- **A scene with no picture uploads the build's palette.** It used to upload
  nothing and inherit the last scene's, so the caves and the runner played in
  their own title screen's colours. The boot upload also counted thirty-two
  _colours_ into a Game Gear's sixty-four bytes of colour RAM, leaving the whole
  sprite bank unwritten; there is one uploader now and it counts bytes.

- **The full redraw runs with interrupts off.** Acknowledging the frame interrupt
  means reading the control port, which resets its half-written state — so a
  handler landing between the two bytes of a VRAM address leaves one cell written
  somewhere else entirely. Nothing else needed it: `UploadFrame` runs a few
  instructions after the interrupt it waited for.

- **A picture is fitted to the tiles it asks for.** The bank was divided evenly
  among a game's backdrops before any of them had been demade, so breakout's
  Master System title screen was starved of sixty-eight tiles to reserve seventy
  its court never wanted. A conversion reports its demand as well as its cost, so
  the bank is now shared out max-min fair on what the pictures actually ask for,
  and a picture is demade twice only where its share would change the fit.

And then the cartridge, because the shooter did not fit on either machine — 34.6
KiB against 32.7. Three changes, all of them work the NES had already had:

- **The name tables are packed** — literals and runs of whole _cells_, because an
  entry here is two bytes and a run of identical cells contains no byte runs at
  all. About 1.5 KiB a game. The encoding is not the contract: what is guaranteed
  is the bytes that reach the VDP, and `sms-rom.test.ts` checks those.

- **Collision pairs are a loop, not a copy each.** A bullet against nine aliens is
  twenty-seven pairs and each pair's code — the near test, the staging, the
  overlap, the rule body, the separation, the contact bit — was about 350 bytes.
  The other object's record goes in a memory pointer and the body is emitted once
  against `EntityAddr`'s `ptr` case, which `expr.ts` has implemented all along, so
  a rule body needed no special handling: 9.3 KiB of collision code became under
  one. Rules that meet only the screen's edges are looped over their subjects the
  same way. A loop is taken only where the objects agree about what an unrolled
  copy would have baked in — the near margins, whether `visible` can change, their
  size — and never below three.

- **And the integrator groups by what it would have compiled to.** `moveShape` is
  every compile-time question `emitAxis` asks, so nine aliens that move the same
  way share one body rather than nine copies of two hundred bytes.

The shooter is 25.6 KiB now and every example game builds on both machines with at
least 3 KiB free, so the suite's over-budget list and the Sega's 512-byte headroom
exception are both gone. Sega cartridge bytes change for every game.
