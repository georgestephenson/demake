---
"@demake/demotic": minor
---

Make the top of the caves cavern reachable, and its jump the same height on
every console.

Two of the cavern's ledges — the one holding the exit and the one holding a coin
— could not be landed on. Both sat flush under the level's rock roof, and a hero
is two cells tall: the roof caps a jump at exactly the height of a ledge on that
row, so there was nowhere to be _above_ one and a landing needs the hero above
the ledge before it comes down. The nearest surface below them was six rows down
in any case, and a jump rises five. The only way up was a wall hop — a solid
ledge grants footing from its side, so a falling hero can take footing off the
face of one and jump again — which is a trick, not a route, so a third of the
cavern was decoration: unreachable exit, twelfth coin, and no way to finish the
game.

The two ledges now sit two rows lower, with the exit and the coin on them, and
the left one has moved out of the flight path between the two ledges below it,
which lowering it had blocked. Every ledge in the cavern is now reachable from
the floor and the exit can be reached from the ledge below it, checked in the
reference interpreter on a 60 Hz console, on the Mega Drive and on the
WonderSwan.

The second half is why the WonderSwan was worse than everywhere else. Gravity is
a delta a level rule adds every tick, and nothing scales what a rule adds — a
`speed` is cells per second and the compiler resolves it against the console's
rate, but `ydirection + 0.04` is an acceleration per tick, so a machine ticking
75.47 times a second falls half again as hard as one ticking 60. The hero
cleared four cells there against five everywhere else and the climb stopped two
thirds of the way up. It is written `2.4 / fps` now, which folds at compile time
to the constant the 60 Hz consoles already had — so no cartridge but the
WonderSwan's changes for that reason — and the suite gained the case that says
so, which fails on that console with the old constant.

Cartridge bytes move on every console: the level's grid changed, and with it the
packed backdrop and level tables. The caves have more room than before, not less
(Game Boy 5114 bytes free to 5961).

The platformer, quest and runner fixtures still write their gravity as a
constant and so still jump a cell short on the WonderSwan.
