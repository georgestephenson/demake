---
"@demake/demotic": minor
---

`.test.dmt` takes a duration in seconds, and the WonderSwan Color gets a profile.

A test script's durations were in ticks, which is portable only while every
console ticks at the same rate — and one does not. The WonderSwan Color runs at
75.47 Hz, so `hold right for 42 ticks` covers three quarters of the ground there
that it covers on a Game Boy. That is the trap `speed` already avoids by being
cells per _second_ (doc 14 §3), arriving one layer up, and it stayed invisible
for as long as every profile said sixty.

`play 4 seconds` and `hold left for 5 seconds` now parse, and the runner resolves
them against the profile's `fps` — the one place a console's rate enters a
script. `ticks` stays a unit rather than becoming a deprecation: a step that
means "one more tick" should say so, and the example suites keep it for the two-
and eight-tick waits that give a rule an edge to fire on.

No cartridge's bytes change. The example library is converted and no console's
behaviour changed with it: two decimal places of seconds round-trips to the same
tick count at sixty, and every count in the library does.

The `wsc` profile lands with it — 28×18 cells, 75 fps, thirty-two objects a line
and 8×8 only — ahead of its emitter, which makes it the first console in the
table with a profile and no backend. `demake build -c wsc` refuses by name, which
is what `unsupportedFor` is for.
