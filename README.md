# Rebel-Sim

Rebel-Sim is the browser-based (TypeScript/Angular) simulator for
**Rebel**, a bare-metal "keyboard computer." It's a Forth interpreter
built in TypeScript, mirroring the same memory-and-dispatch model that
Rebel's real bare-metal firmware (Rebel-ROM, C++) uses — an arena of
memory divided into banks, sysvars, and a token-threaded dictionary of
words — so that identical Forth source can eventually run unmodified on
both the simulator and the real hardware targets.

Its purpose is to let Forth engine design happen at browser-refresh
speed instead of flash-a-device speed: new primitives and mechanisms get
designed and proven here first, and the hardware targets catch up to
what's already been validated in Rebel-Sim.

The repo is an npm workspace with two packages:

- **`packages/engine`** — the Forth interpreter itself. Plain
  TypeScript, zero Angular dependencies (arena/bank memory, sysvars,
  dictionary, inner/outer interpreter).
- **`packages/app`** — a thin Angular shell (canvas rendering, keyboard
  input, storage) around the engine.

For the full picture, see:

- `FORTH-ARCHITECTURE.md` — the cross-target Forth engine spec (cell
  width, memory/bank layout, sysvars, threading model, HAL contract).
- `PORTING-WEB.md` — the web-specific companion (Angular project shape,
  canvas rendering, browser storage, PWA packaging).
- `IMPLEMENTATION.md` — a living reference for how the built engine
  actually works, concept by concept.
- `PLAN.md` — the decision/build log: what shipped, when, and why.
- `HAL.md` — the concrete, code-checked HAL contract shared with the
  `rebel-rom` (Rebel's bare-metal C++ firmware) sibling repo.

## Requirements

- Node.js and npm (developed against Node 24, npm 12).

## Setup

This is an npm workspaces project (`packages/engine` and
`packages/app`). Install once from the repo root — this hoists shared
dependencies and links `@rebel-sim/engine` into `packages/app`:

```bash
npm install
```

Don't run `npm install` separately inside each package; the workspace
link between `packages/app` and `@rebel-sim/engine` is set up by the
root install.

## Build

The engine must be built before the app can resolve `@rebel-sim/engine`
(the app imports its compiled `dist/` output). From the repo root:

```bash
npm run build
```

This builds `packages/engine` (via `tsc`) and then `packages/app` (via
`ng build`), in that order. If you only need the engine's `dist/`
output refreshed:

```bash
npm run build --workspace=packages/engine
```

## Run the dev server

```bash
npm run start
```

Runs `ng serve` for `packages/app` at `http://localhost:4200/`. Note
that this does **not** build the engine first — if `packages/engine`
has never been built (no `packages/engine/dist/`), run
`npm run build --workspace=packages/engine` once beforehand, or the app
build will fail with `Cannot find module '@rebel-sim/engine'`.

## Test

```bash
npm run test       # engine unit tests (vitest)
npm run test:app   # app tests
```
