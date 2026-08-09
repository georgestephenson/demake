---
"@demake/core": minor
"@demake/vb": minor
"@demake/demotic": minor
"demake": minor
---

`demake build -c vb` builds a playable Virtual Boy cartridge, in depth.

The sixteenth console to compile a Demotic game, and the only one that draws
every scene twice. The whole example library traces identically on it in
`@demake/vb`, in the same battery every other backend runs, at the same one frame
per tick — and `packages/demotic/test/vb-rom.test.ts` is the rendering oracle
beside it, where the things a trace cannot see are checked.

**`VB_DEPTH` is now spent rather than described.** The scenery world sits at the
display plane, every object carries `vbParallax(VB_DEPTH.object)` in its own
attribute entry, and the captions get a BGMap world of their own at the nearest
rung. The oracle reads the ladder back off the worlds, off the object table and
off the **pixels**, together — because a sign convention that was consistently
wrong would satisfy any one of the three alone and put a game's captions behind
its scenery. The three numbers themselves are still a proposal (doc 13 §Console
rollout item 9): how far in front is a value no `.dmt` says and no Demakefile
may.

Four things about the renderer are this console's rather than a predecessor's
restated.

**A scene is a display list, not a stack of layers.** Seven world entries written
once at boot — scenery, four object worlds, the caption plane, the terminator —
and what a scene costs is the worlds it uses. The four object worlds are four
rather than one because the drawing processor decides which group a world draws
by _how many object worlds came before it_, from three downward; the other three
groups are left empty by the `SPT` registers, which name a **last entry** rather
than a count, and that is also how a frame with no objects at all is expressed.

**Scrolling is two halfword stores.** The scenery world carries its own source
origin against a 64×64 map and a 48×28 window, so a scrolling scene paints its
leading edge sixteen columns off the right-hand side and neither the NES's row
pinning nor the Master System's seam mask exists.

**The HUD gets a plane of its own**, whose origin is written at boot and never
again — the WonderSwan's arrangement and the Game Boy Advance's, with a depth on
top. The sprite HUD, the second decimal renderer and the whole pixel-pinning
argument are absent rather than reimplemented, and this is the third time in the
set that can be said.

**An unaligned access is masked rather than faulted.** A V810 clears the low bits
of an address instead of raising, so an `ld.h` at an odd address reads the
halfword below it and reports nothing. The three structures that interleave a
count byte with halfword entries hit that by construction and are read a byte at
a time; the shared constant pool would hit it whenever a byte table before it
happened to be an odd length, so `CodeBuffer` grew an optional `align` and
`CtxBase.finish` calls it. Every other console in the set is simply spared this.

**A caption is chosen against the picture, not against the backdrop.** On the NES
and the PC Engine a caption's paper _is_ the shared backdrop, so the ink is picked
against that; here the caption is on a plane in front of the picture and what
shows through its paper is the picture itself. Picking against the backdrop gave
the caves title screen dark ink over a three-quarters-dark picture whose lightest
colour happened to be rare — a caption placed correctly, demade correctly and
invisible, which no register comparison can see. `vb-art.ts` counts the shades the
demade picture actually places and ramps the font the other way.

Three smaller things changed underneath.

`@demake/vb`'s frame now happens in `step` rather than in `runFrame`, because a
cartridge that waits for one by _polling_ — which this console's demade games do,
taking no interrupt anywhere — never returns to a caller stepping instructions.
And `render` keeps a buffer per eye: every other core here has one framebuffer,
so handing back the same array twice is ordinary, but a caller's whole reason to
render on this machine is to _compare_ the two.

`Packing` gained `packed2le` — a row's leftmost pixel in the **lowest** two bits
of a little-endian halfword, which is the Neo Geo Pocket's layout read the other
way round. A second packing rather than a flag, because a tile packed with the
wrong one is mirrored in place and reads as a fitter fault.

`rom.test.ts` states a sixty-second timeout for this console alone, and the
reason is hardware: 20 MHz against a 50.2 Hz frame is four hundred thousand
cycles where a Game Boy has seventy thousand, so a three-hundred-frame tape is
five times the emulated instructions with the tick filling the same small
fraction of it.
