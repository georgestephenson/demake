---
"@demake/core": minor
---

Add the `AudioSpec` schema and specs for the Game Boy, NES and SN76489 consoles
(doc 16). Data only: the console specs now describe their sound hardware —
channel kinds, pitch and volume lattices, driver clocks and budgets — so the
audio demakers can stay generic over consoles the way the image pipeline is.
