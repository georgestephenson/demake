---
"@demake/demotic": minor
"@demake/web": patch
---

Fix four things a game got wrong away from the Game Boy: an invisible object on
the NES, an unplayable Game Gear, a draw that came out wrong on the Sega
consoles, and the last cartridge's sound over the next one's in the page.

- **The Game Gear put every object 48 pixels left and 24 up.** Sprite
  coordinates are frame coordinates and that machine's LCD shows the middle
  160×144 of a 256×192 frame, so the window's origin has to go on. The
  background already carried it in the scroll registers; sprites did not, which
  put pong's opponent above the window and everything else off its mark. It goes
  on in `PushSprite`, the one door every object cell and HUD glyph passes
  through — and before the entry count is loaded, because that count is in `a`
  from the room check all the way into the address arithmetic.

- **The NES dropped any object whose top row was the screen's first line.** The
  PPU draws an object on the line _after_ its Y, so a cell at line zero would
  need a shadow of minus one; the bounds test rejected it and the object simply
  was not there. Pong's opponent sits at `y 0` for the whole game. It is drawn a
  line low instead, which is three instructions a cell and the difference
  between a two-player game and a one-player one.

- **The NES fitted its backdrops to the raster rather than to the game's
  screen.** The profile's screen is the overscan-safe 28 rows, so a picture
  demade at 30 had edges that were not the game's: pong's scoreboard band landed
  below the HUD written on it, and the court's rails did not line up with the
  walls the ball bounces off. Backdrops are now demade at 32×28 and the two
  overscan rows repeat the last one — with their attributes, since a palette
  covers a 16×16 block. Backdrop bytes change on this console.

- **The Sega frame interrupt kept its flag in shared scratch.** `layout.scratch`
  is documented as valid for the length of one routine, and the handler's "a
  frame happened" byte is `Mod16`'s divisor — so a frame boundary inside the
  sixteen-iteration loop of `random()` produced a draw outside its own bounds,
  every few seconds, at no tick anyone could name. The handlers get their own
  bytes (`MemoryPlan.interruptBytes`), allocated last so no other console moves.

- **The Master System uploaded 192 sprite bytes a frame whatever was on
  screen.** The list terminates at the first parked entry, so only the entries in
  use need sending, and `otir` sends each run in one instruction: 35 bytes
  instead of 192 for a game showing eleven sprites. Pong went from 1.24 frames
  per tick to 1.16, and the Game Gear from 1.10 to 1.05.

- **The web app played the old cartridge over the new one.** The player schedules
  a tenth of a second ahead, so a rebuild — a keystroke, a console change,
  Restart — always left audio queued that belonged to the machine being thrown
  away, and a started buffer plays regardless of what produced it. The queue is
  stopped now rather than abandoned.
