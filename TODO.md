# TODO

Deferred work we've agreed to come back to. `IMPLEMENTATION.md` is the
record of what shipped; this is what hasn't yet.

## Boot performance: `FIND`, and the cost of `NEEDS`

Booting means compiling `system.fth` (about 7 s in Node, M78), and every
`NEEDS` compiles its module the same way: `NEEDS FLOAT` takes about 7.5 s
on its own. Since M79 nothing optional loads at boot, so that cost moved
from boot to first use. `float.fth` is an eighth of `system.fth`'s size
but costs as much, because every token goes through the self-hosted
`FIND`, which walks the whole dictionary in Forth. Every number literal
(hundreds of hex constants) walks it to the end before `NUMBER` gets a
turn. Two options, not mutually exclusive:

- **Cache the boot image in the app.** Keep the booted arena in browser
  storage, keyed by a hash of `system.fth` (and of each module, for
  images that include one), and reuse it until a source changes. This is the same idea the engine tests already
  use (`test-support.ts`, `boot-image.global-setup.ts`). It needs no
  Forth changes.
- **Make `FIND` fast.** A native lookup behind `FIND` would speed up
  boot and every interpreted line. It weighs against CLAUDE.md's
  "primitives only if absolutely necessary", so it's a deliberate
  decision to make.

## Restoring a project saved without `MMAP.MAP`

Opening a project with no `MMAP.MAP` into a machine whose boot banks
are resident throws `bank name SYSV already exists`. Every content file
falls through to the fallback that creates a fresh bank, which then
collides with the resident bank of the same name.
`02-MEMORY-MODEL.md` §7 calls this case a harmless no-op. Rebel-Sim's
own `SAVE` always writes `MMAP`, so only hand-assembled or foreign
projects hit it. Found in M74.

## Rebel BASIC

`rebel-specs/08-BASIC.md`: a Sinclair-flavoured BASIC, run as an
environment, that compiles program text to Forth threaded code at
`RUN`. Everything it depends on now exists: environments (M77), floats
(M78), the bank words (M73), `NEEDS` (M79/M81), and MEMO (M80) for
editing a program, which BASIC lends to MEMO through the current page
document. It would be `NEEDS BASIC`, its source starting with
`NEEDS FLOAT`. The game work also gives it what its §16 lists as missing:
`MS@`/`MS` for `PAUSE`, `KEY-DOWN?`, and `SPRITE`/`TILE`/`PLOT`. Paused
on 2026-10-16 to do game support first.

## Think about: MEMO as a full-screen Forth environment

Oliver's idea, to think through before building anything. MEMO already
runs any line as Forth (Shift-Esc) and captures its output below it, so
it is close to a full-screen, page-oriented alternative to the
line-by-line prompt: a worksheet where commands and results live
together and can be edited and re-run, in the spirit of classic
screen-oriented Forths and notebook interfaces. Questions to settle:

- Is this MEMO with different defaults, or a separate environment built
  on MEMO's page bank and keys?
- What it would add: running a whole page or a marked block (`MEMO-LOAD`,
  M87, already runs a whole document), a scratch page that never fills up, a history, and
  error text in the status (`09-MEMO.md` §10, which needs error codes).
- How it relates to the Forth prompt (`HOME`) and to block `LOAD` and
  the classic block editor (`NEEDS EDITOR`).
- Whether it could replace the prompt as the default environment, and
  what a bare REPL would still be needed for.

