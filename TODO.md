# TODO

Deferred work we've agreed to come back to. `IMPLEMENTATION.md` is the
record of what shipped; this is what hasn't yet.

## Boot performance: `float.fth` and `FIND`

The app now takes about 15 s to boot. `system.fth` takes about 7 s
and `float.fth` another 7.5 s (measured in Node, 2026-10-14; M78).
`float.fth` is an eighth of the size but costs as much, because every
token goes through the self-hosted `FIND`, which walks the whole
dictionary in Forth. Every number literal (hundreds of hex constants)
walks it to the end before `NUMBER` gets a turn. Two options, not
mutually exclusive:

- **Cache the boot image in the app.** Keep the booted arena in browser
  storage, keyed by a hash of `system.fth` + `float.fth`, and reuse it
  until either changes. This is the same idea the engine tests already
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
