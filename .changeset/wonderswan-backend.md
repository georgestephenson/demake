---
"@demake/demotic": minor
"@demake/web": minor
---

Compile Demotic games for the WonderSwan Color.

`demake build -c wsc` produces a real 512 KiB cartridge — V30MZ machine code
written for the game, with the art it names demade into a bank of packed 4bpp
tiles the boot code copies into the console's own RAM — and every game in the
example library traces identically there, in the same battery every other console
runs, at the same one frame per tick. The page plays it too: `@demake/wsc` joins
the seven cores already behind the ROM pane's `import()`, so a visitor still
downloads one machine.

This is the eighth backend and the first whose console has **no video memory**.
The two screen maps, the tile bank, the object table and palette RAM are
addresses in the same 64 KiB the game's variables are in, so nothing is uploaded
through a port, the object table is not a shadow the chip copies, and writing a
cell is one store. What the renderer gains from that it spends elsewhere: a table
lives in the cartridge and a variable does not, so this is the first machine here
where a read has to say which **segment** it means. `codegen/wsc/val.ts` decides
that from the reference's own type — a number is RAM, a label is cartridge —
rather than leaving each emitter to remember it.

Two things follow that no predecessor could offer. The **HUD gets a plane of its
own**: `SCR2` scrolls independently of `SCR1` and draws in front of it, so a
caption's cells are written once and its scroll registers never again, and the
sprite HUD, the second decimal renderer and the whole pixel-pinning argument
every 8-bit console needs are absent rather than reimplemented — only the Game
Boy Advance has had that before. And the **map is 32×32 against a 28×18 window**,
so a scrolling scene paints its leading edge where nobody is looking and both
wraps are powers of two: neither the NES's row pinning nor the Master System's
seam mask exists here.

There is no sound on this console yet — no chip model, no binding, no driver — so
a game that names music builds, traces and plays exactly as it does on a machine
that would play it, and nobody is listening. What closing that costs is in doc 13
§Console rollout item 4.

`packages/demotic/test/wsc-rom.test.ts` is the rendering oracle beside the trace
battery, and every case in it is something a trace cannot see: that the tile bank
and palette RAM arrived in the console's own memory, that every visible cell
matches the level's own grid before and after the camera has travelled, that a
picture went in at the hardware's thirty-two-cell row rather than the window's
twenty-eight, that both reserved palettes survived the fit, and that the HUD
plane never scrolls while the world plane does.

No existing console's output bytes change.
