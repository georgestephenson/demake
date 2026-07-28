---
"@demake/core": minor
"@demake/audio": minor
"@demake/demotic": minor
"demake": minor
---

Run the tournaments in parallel: a colour cartridge builds in about a third of
the time.

A tournament is a set of candidates that cannot see each other, so it is the one
place in the engine where work spreads across cores for free — and it turns out
to be where a build's time actually goes. Profiled, `demake build caves.dmt -c
gbc` spent **70% of nine seconds inside one `prepSync` call**: a single backdrop.
The sprite bank, which converts every object in the game at once, was 1.5%.
Emitting the machine code was 0.2%.

**The seam.** `@demake/core` has no threads and must never learn about any, so it
describes independent work as jobs — `{ kind, payload }`, both halves
structured-cloneable — and takes an `Executor` from whoever is calling. The CLI's
runs on `worker_threads`, the web app's on Web Workers, and with none supplied
they run inline, in order. That inline path is the specification rather than a
fallback: it is the answer every other executor has to reproduce byte for byte.
The scheduling itself is platform-pure and lives in core (`poolExecutor`), shared
by both edges, because the ordering rules a fan-out depends on are the same
wherever the lanes are.

**What it buys**, measured on four cores:

|                                  | one lane | `--jobs auto` |
| -------------------------------- | -------- | ------------- |
| `demake prep` (384×336, gbc)     | 5.96 s   | 2.95 s        |
| `demake build caves -c gbc`      | 8.3 s    | 4.7 s         |
| `demake build platformer -c nes` | 14.7 s   | 7.9 s         |

`--jobs <n>` is new on `prep`, `gen`, `build` and `sfx`; `auto` is one lane per
core minus one, which measured faster than one per core because the thread
coordinating a build is doing real work between fan-outs.

**The bytes do not move.** How many cores ran a tournament is not an input: the
winner is reduced in _portfolio_ order, so `--jobs 1` and `--jobs 16` write the
same file, and lane count appears in no manifest and no `--json`. Four suites say
so — ordering rules under executors that run jobs backwards, a real thread pool,
whole cartridges across the example library, and the page's cartridge against the
CLI's. Every existing golden is unchanged. The k-means restart loop inside a
single fit shares one PRNG stream and is deliberately _not_ parallelised:
spreading it would change the draw order, which would be an output-byte change
rather than a speed-up.

**Breaking, and deliberately so.** `buildGame` / `buildGbRom` / `buildNesRom` /
`buildSmsRom`, `Backend.bindArt` / `bindAudio` and `demakeSfx` are now `async`;
`prepSync` is gone and `prep` is the only entry point. There was a choice between an async
sibling and one path, and one path won — two entry points that must produce
identical bytes are two entry points that can drift.

Two things fell out of the restructuring:

- **A build demakes its art and its audio at the same time** (`allSettled`, so
  art's failure still takes precedence exactly as it did when they ran in
  sequence), and the Game Boy converts a scene's backdrops concurrently — while
  still _interning_ them in scene order, because a tile's number is where it
  landed. The NES keeps converting its backdrops one at a time, because what a
  picture may spend is what the ones before it left.
- **The page fans out through the worker that already builds there.** A lane is
  another instance of `core.worker.ts`, which holds both engines because it
  compiles cartridges — so the browser has the chunk cached and starting six of
  them downloads nothing. Each gets one end of a `MessageChannel` whose other end
  goes to the engine worker, so candidates travel directly between them: the page
  does not relay them, and no worker spawns a worker.

The whole change costs 3.3 KB gzipped on the site, nearly all of it the seam
inside `@demake/core` rather than anything the page added — a lane is another
instance of `core.worker.ts`, so the pool itself downloads nothing. The site
budget goes from 300 KB to 310: main was already sitting 36 bytes under the old
ceiling once the Sega vertical and its Z80 driver had landed, which is a
coincidence rather than room, and doc 07 §Quality bar records the arithmetic. The
alternative was built and measured first — a purpose-built lane worker gets its
own module graph and re-ships a whole engine, 41 KB.
