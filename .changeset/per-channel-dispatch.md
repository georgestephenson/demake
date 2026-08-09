---
"@demake/audio": minor
---

Route a run to the body of the channel it actually named.

Every stream player emits one recording body per borrowable channel and dispatches
on the run's channel bits, testing one channel fewer than it has and letting the
remaining one fall through. Which one falls through is the whole question, because
the bodies are laid out in index order directly below the tests — and all eight
players tested channels `0..n-2`, so the fall-through landed on the **first**
body and the **last** channel's was unreachable. A run naming the last channel
was recorded into the first channel's copy, and the release then handed a
borrowed channel back holding another channel's registers.

Nothing in the shared game-audio battery could see it: that battery builds a
program with one sound effect, and with one borrowable channel a dispatch has no
tests at all. `quest` is the example game that reaches it — its smash lands on
the noise channel and its other seven effects on the first pitched one — so the
fault was in shipped cartridges on every console with two or more effect
channels.

The fix is the same one line in each: test `1..n-1` and let the first channel
fall through. `gb-branches.test.ts`, which already builds the widest shape a Game
Boy can ask for because the example library cannot reach it, now also asserts
that every body of the dispatch is reachable.

Cartridge bytes move only for a game whose effects land on more than one channel;
a one-channel build emits no test either way and is byte-identical.
