---
"@demake/core": minor
"@demake/dmg": minor
---

Give the Game Boy a memory bank controller: MBC5 in the cartridge wrapper and in
the core.

`stampGbHeader` now takes the board from the image's own length rather than
declaring a ROM-only 32 KiB cartridge whatever it was handed. Thirty-two
kilobytes is the ROM-only board it always was, so every cartridge this project
builds today is byte-identical; anything longer declares MBC5 and one of the nine
sizes the header's size field can say, and a length no board has is refused by
name the way the Sega and NES wrappers already refuse theirs. `GB_ROM_SIZES`,
`GB_BANK_SIZE`, `GB_BANK_WINDOW`, `GB_CARTRIDGE_TYPE` and the `MBC5` register map
are `core`'s, so the builder that writes the type byte and the machine that reads
it share one declaration.

`@demake/dmg` has the controller. Bank 0 stays wired to `$0000`–`$3FFF` because
the vectors, the entry point and the header are down there — a mapper that could
page that out would be one nothing could recover from — and `$4000`–`$7FFF`
answers whichever of up to 512 banks the nine-bit register names, across `$2000`
and `$3000` as the hardware splits it. Whether there is a controller at all is
the cartridge's own type byte and never a constructor setting, which is the rule
the CGB flag already runs under: a ROM-only cartridge keeps exactly the bus it
had, writes below `$8000` and all.

Cartridge RAM at `$A000` is absent rather than half-implemented, because no board
demake produces declares any — a demade game's state is the console's own 8 KiB
on every Game Boy build. So are MBC1, MBC2 and MBC3, because nothing builds one.

The emitter does not produce a banked cartridge yet; doc 13 §Banked cartridges
records what it costs and why the Super Nintendo now comes first.
