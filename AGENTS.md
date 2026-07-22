# AGENTS.md — working in this repository

Guidance for coding agents (and humans) contributing to demake.
This file is the canonical project-memory file; `CLAUDE.md` is a one-line import
shim so Claude Code reads the same instructions. Keep all guidance here — never
add content to `CLAUDE.md` directly.

## What this is

A tool that converts any image into hardware-compliant art — and displayable
code — for 8/16-bit-era consoles and handhelds up to the Nintendo DS. The
project is currently in the **planning stage**: the complete plan lives in
[`docs/`](docs/README.md), and `docs/12-repo-standards.md` specifies what this
file must grow into once implementation starts.

## Commit rules

- **No AI attribution of any kind in commits**: no `Co-Authored-By` trailers, no
  `Generated with` lines, no session links, no model names — in commit messages,
  PR titles/bodies, or code comments.
- **Do not mention other repositories or prior personal projects by name in
  commit messages** (e.g. the projects this tool's design originated from).
  Design provenance belongs in `docs/`, not in git history.
- Write commit messages about the change itself: imperative subject ≤ 72 chars,
  body explaining what and why.
- Develop on the designated feature branch; never push to `main` directly.

## Documentation rules

- `docs/` is the source of truth for design. If you change a decision, update
  every doc that states it (they cross-reference each other by number).
- Keep this file current: any workflow or convention you introduce that an agent
  needs on day one gets a line here, in the same PR.
