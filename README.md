# demake

> Convert any image into hardware-compliant art — and displayable code — for the
> 8/16-bit-era consoles and handhelds, up to and including the Nintendo DS.

`demake` takes an ordinary modern image and produces art that a real retro
console could actually display, plus the data and source code to display it:
palettes, tile maps, and assembly/C/binary — verified on emulated hardware, not
merely asserted.

## Why

One of the main motivations for this tool is enabling a fully AI-agent-driven
retro game workflow. Coding agents can already write code for retro consoles,
and image models can generate art — but art that fits precise hardware
constraints (master palettes, per-tile color limits, attribute grids, tile
budgets) has been the missing piece. `demake` closes that gap, so an AI agent
can create a retro game end to end: generate art, convert it into
hardware-compliant data and display code, and build a running ROM.

> **Status: Phase 0 (foundations).** The repository is being scaffolded. The
> conversion engine (`prep`) and code generator (`gen`) land in Phase 1+. The
> full design lives in [`docs/`](docs/README.md); the milestone plan is
> [`docs/13-roadmap.md`](docs/13-roadmap.md).

## Packages

| Package                         | What                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| [`@demake/core`](packages/core) | The engine. Zero platform deps, ESM, ships types (doc 09). |
| [`demake`](packages/cli)        | The CLI wrapper (doc 05). Re-exports core for scripting.   |

## Develop

Requires Node ≥ 20 and [pnpm](https://pnpm.io) (pinned via `packageManager`).

```sh
pnpm install     # install workspace deps
pnpm build       # typecheck + build all packages (project references)
pnpm test        # unit tests (Vitest)
pnpm lint        # ESLint (incl. custom core rules) + Prettier check
pnpm lint:fix    # autofix
```

Run the stub CLI from source after building:

```sh
pnpm cli -- --version
pnpm cli -- --help
```

See [`AGENTS.md`](AGENTS.md) for the full contributor contract and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for setup details.

## License

[MIT](LICENSE) © georgestephenson
