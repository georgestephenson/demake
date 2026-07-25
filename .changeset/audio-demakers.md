---
"@demake/core": minor
---

Audio: two new packages and three new commands. `@demake/chip` models the Game
Boy APU, the SN76489 and the NES 2A03 as register-driven state machines;
`@demake/audio` turns a MIDI track into chip music (`arrange`) and a WAV into a
chip sound effect (`sfx`), and `render` plays either back as exactly what the
hardware will produce. Six consoles: dmg, gbc, nes, sms, gg, sg1000.
