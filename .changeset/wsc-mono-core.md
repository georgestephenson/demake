---
"@demake/wsc": minor
---

`@demake/wsc` is both WonderSwans now.

The display controller is the mono machine's too, and the difference turned out
to be two lookups rather than a second renderer: the same screen maps, the same
object table, the same entry words, the same wrapping and the same layer order.
What changes is where a pixel's _value_ comes from. A tile is **planar 2bpp** in
the top half of this machine's 16 KiB rather than packed 4bpp at `$4000`, and a
palette is **four three-bit indices into a shared eight-shade pool** held in
ports `$20`–`$3F`, whose levels are ports `$1C`–`$1F` — so a colour is two
lookups deep, and the second one is what every palette on the screen shares. The
backdrop register says a bare pool index here, because there is no palette for
it to name.

Which machine an instance is comes from the constructor, on the Mega Duck's
terms: these two consoles do not differ in anything a cartridge header could
record. Internal RAM is masked to fourteen address lines on the mono one rather
than pretending it has the other 48 KiB.

Nothing about the Color machine changes.
