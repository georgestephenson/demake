---
"@demake/web": minor
---

Play NES cartridges in the page. The game section's console selector now changes
the cartridge for the NES as well as the two Game Boys: the browser compiles the
`.dmt` to 6502, demakes its art for that machine and boots the result in
`@demake/nes`, with the bytes pinned byte-identical to `demake build -c nes` by
the determinism spec. The pane follows the cartridge rather than the picker —
while a new console demakes it keeps playing the one it has, and the machine's
name, the canvas shape, the download's extension and the CPU its frames-per-tick
figure was measured on all describe that ROM rather than the selector — and the sound
button is disabled on a console whose driver is not written yet rather than being
a switch that turns on nothing. The whole second console costs 4.6 KB gzipped and
the site stays inside its budget.
