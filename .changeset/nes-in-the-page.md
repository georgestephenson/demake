---
"@demake/web": minor
---

Play NES cartridges in the page. The game section's console selector now changes
the cartridge for the NES as well as the two Game Boys: the browser compiles the
`.dmt` to 6502, demakes its art for that machine and boots the result in
`@demake/nes`, with the bytes pinned byte-identical to `demake build -c nes` by
the determinism spec. The pane follows the cartridge rather than the picker — it
clears while a new console demakes, sizes its canvas to the machine it is showing
and names the CPU its frames-per-tick figure was measured on — and the sound
button is disabled on a console whose driver is not written yet rather than being
a switch that turns on nothing.
