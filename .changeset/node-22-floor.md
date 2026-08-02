---
"@demake/cli-spec": minor
"@demake/demotic": minor
"@demake/audio": minor
"@demake/chip": minor
"@demake/core": minor
"@demake/snes": minor
"@demake/dmg": minor
"@demake/nes": minor
"@demake/sms": minor
"@demake/md": minor
"demake": minor
---

Require Node 22 or newer.

Node 20 reached end-of-life on 2026-04-30, so the `engines` floor moves from
`>=20` to `>=22` and CI tests Node 22 (maintenance LTS) and 24 (active LTS)
instead of 20 and 22. No output bytes change: every cartridge, PNG, `.vgm` and
manifest this release produces is byte-identical to the last one's.
