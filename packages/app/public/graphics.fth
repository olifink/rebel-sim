\ graphics.fth -- the GRAPHICS vocabulary, a source module: load it with
\ NEEDS GRAPHICS, then USE GRAPHICS. Moved out of system.fth in M82.
\ PLOT and POINT, its two primitives, are native and always present.

\ ---------------------------------------------------------------- \
\ GRAPHICS -- M68. PLOT, token 148, and POINT, token 149, are the
\ only two new primitives this needed -- Screen.plot in engine
\ terms, spec 01-HAL.md section 3.4's hal_draw_pixel, is the single
\ point of contact with a raw framebuffer pixel anything in this
\ engine has, the same "primitives only if absolutely necessary"
\ reasoning EMIT/CLS already follow -- nothing below this point is
\ a primitive. POINT is PLOT's read-side counterpart, hal_read_pixel,
\ completing the classic PLOT/POINT pairing. Both use pixel-space
\ coordinates, SCREEN-WIDTH/SCREEN-HEIGHT, not the character-cell
\ grid, and both silently clip out-of-range x/y instead of throwing
\ -- every word below inherits that clipping for free by going
\ through PLOT, never checking bounds itself.
\
\ PLOT takes no color argument -- like EMIT/CHAR!, it always uses
\ the current INK sysvar, resolved through the active palette, same
\ as Screen.plot's own doc comment explains, so n INK ! before
\ drawing (M71: INK/PAPER are real variables now, read with @ and
\ written with !, not a color-consuming store word) is GRAPHICS'
\ whole color model. There is no PAPER equivalent for pixel ops --
\ nothing to fill "behind" a single pixel.
\
\ LINE/RECT/CIRCLE are all pure Forth, built on PLOT alone -- no
\ hal_draw_line/rect exist anywhere in this codebase, spec section
\ 01-HAL.md 3.4 names them as an optional target-side acceleration
\ path, never a requirement, so nothing here assumes they might.
\ LINE-WIDTH is Forth-side state, an ordinary VARIABLE, not a
\ sysvar, purely because it's GRAPHICS' own drawing-style setting,
\ not portable interpreter state anything else reads.
\
\ ARC and any rotation/angle math are deliberately NOT here yet --
\ unlike LINE/RECT/CIRCLE, pure integer, no trig needed: the
\ midpoint circle algorithm below never calls SQRT or any
\ trigonometric function, testing whether a point falls inside an
\ angular range needs at least a small MATH vocabulary, a fixed-
\ point SIN/COS table. That's real, separate design work, deferred
\ to its own pass rather than gold-plating this one -- see this
\ session's own scope discussion, not written down anywhere else
\ yet.
\
( One more thing worth naming plainly: a comment word like this one )
( consumes input up to the next token that merely ends in a close- )
( paren -- not up to a standalone close-paren token. A stray, )
( unspaced trailing paren anywhere inside a comment -- e.g. writing )
( a token id as "148 close-paren" glued onto the digits -- closes )
( the comment early and dumps the rest of the sentence into the )
( dictionary as real code. Every comment below stays deliberately )
( flat -- no parenthetical asides -- to avoid exactly that. )
VOCABULARY GRAPHICS
GRAPHICS DEFINITIONS

( Stroke width for LINE, and, since RECT is built from four LINEs, )
( RECT's outline too. An ordinary VARIABLE, read fresh by LINE on )
( every call -- changing it never affects anything already drawn. )
VARIABLE LINE-WIDTH
1 LINE-WIDTH !

( ---- LINE1: a single-pixel-wide line, Bresenham's algorithm ---- )
( The classic integer-only, all-octants formulation, dx/dy/sx/sy/ )
( err -- no multiplication or division by anything but 2, and that )
( 2* is a shift, so it's exact for every slope, including the )
( horizontal/vertical cases, dx or dy zero, with no special-casing )
( needed. Named LINE1, not LINE, because LINE, below, is the )
( width-aware entry point everything else should call; LINE1 stays )
( visible since it's a genuinely useful single-pixel-wide primitive )
( in its own right, not just plumbing. )
VARIABLE LX1  VARIABLE LY1  VARIABLE LX2  VARIABLE LY2
VARIABLE LDX  VARIABLE LDY  VARIABLE LSX  VARIABLE LSY  VARIABLE LERR

: LINE1 ( x1 y1 x2 y2 -- )
  LY2 ! LX2 ! LY1 ! LX1 !
  LX2 @ LX1 @ - ABS LDX !
  LY2 @ LY1 @ - ABS NEGATE LDY !
  LX1 @ LX2 @ < IF 1 ELSE -1 THEN LSX !
  LY1 @ LY2 @ < IF 1 ELSE -1 THEN LSY !
  LDX @ LDY @ + LERR !
  BEGIN
    LX1 @ LY1 @ PLOT
    LX1 @ LX2 @ = LY1 @ LY2 @ = AND 0=
  WHILE
    LERR @ 2*
    DUP LDY @ < 0= IF LERR @ LDY @ + LERR ! LX1 @ LSX @ + LX1 ! THEN
    DUP LDX @ > 0= IF LERR @ LDX @ + LERR ! LY1 @ LSY @ + LY1 ! THEN
    DROP
  REPEAT
;

( ---- LINE: LINE1, repeated LINE-WIDTH times, offset a pixel at a )
( time along whichever axis the line is *least* aligned with, its )
( own more-horizontal-than-vertical test below -- a cheap, sqrt-free )
( approximation of a thick stroke, not a true perpendicular-offset )
( polygon. Good enough for a first pass; a real thick-line fill is )
( named as a possible follow-up, not built here. The default width )
( of 1 costs exactly one LINE1 call, same as calling it directly. )
VARIABLE LWX1  VARIABLE LWY1  VARIABLE LWX2  VARIABLE LWY2  VARIABLE LOFS

: LINE ( x1 y1 x2 y2 -- )
  LWY2 ! LWX2 ! LWY1 ! LWX1 !
  LINE-WIDTH @ 1 MAX 0 DO
    I LINE-WIDTH @ 1 - 2/ - LOFS !
    LWX2 @ LWX1 @ - ABS LWY2 @ LWY1 @ - ABS < 0=
    IF ( more horizontal than vertical -- offset in Y )
      LWX1 @ LWY1 @ LOFS @ + LWX2 @ LWY2 @ LOFS @ + LINE1
    ELSE ( more vertical -- offset in X )
      LWX1 @ LOFS @ + LWY1 @ LWX2 @ LOFS @ + LWY2 @ LINE1
    THEN
  LOOP
;

( ---- HLINE: a filled horizontal span, x1 to x2 inclusive -- the )
( building block RECT-FILL/CIRCLE-FILL share below. Assumes x1<=x2, )
( both callers already guarantee it -- not a general-purpose word, )
( kept visible anyway since "draw a horizontal run of pixels" is )
( genuinely useful on its own. )
VARIABLE HX1  VARIABLE HX2  VARIABLE HY

: HLINE ( x1 x2 y -- )
  HY ! HX2 ! HX1 !
  HX2 @ 1+ HX1 @ DO I HY @ PLOT LOOP
;

( ---- RECT / RECT-FILL: always axis-aligned, so these never need )
( Bresenham themselves -- RECT is exactly four LINE calls, which is )
( also how it inherits LINE-WIDTH for free, and RECT-FILL is HLINE )
( repeated once per row. )
VARIABLE RX  VARIABLE RY  VARIABLE RW  VARIABLE RH

: RECT ( x y w h -- )
  RH ! RW ! RY ! RX !
  RX @           RY @           RX @ RW @ + 1-  RY @           LINE ( top )
  RX @           RY @ RH @ + 1- RX @ RW @ + 1-  RY @ RH @ + 1- LINE ( bottom )
  RX @           RY @           RX @            RY @ RH @ + 1- LINE ( left )
  RX @ RW @ + 1- RY @           RX @ RW @ + 1-  RY @ RH @ + 1- LINE ( right )
;

: RECT-FILL ( x y w h -- )
  RH ! RW ! RY ! RX !
  RH @ 0 DO
    RX @ RX @ RW @ + 1- RY @ I + HLINE
  LOOP
;

( ---- CIRCLE / CIRCLE-FILL: the midpoint circle algorithm -- pure )
( integer arithmetic, plus/minus/one 2* shift/comparisons, no SQRT )
( and no trigonometry anywhere. This is why CIRCLE doesn't need the )
( MATH vocabulary ARC will -- see this section's own opening comment )
( -- a circle's outline never needs an actual angle, only symmetry. )
( CCX/CCY are the fixed center; CX/CY are the swept offset from it; )
( CERR is the decision variable. CIRCLE-FILL repeats the same sweep, )
( deliberately duplicated, not factored through a shared word with )
( an EXECUTE'd action -- two ~10-line loops are clearer than that )
( indirection -- but plots four filled spans per step instead of )
( eight single pixels. )
VARIABLE CCX  VARIABLE CCY
VARIABLE CX   VARIABLE CY   VARIABLE CERR

: C8 ( -- ) ( plots the 8-way symmetric points for the current sweep )
  CCX @ CX @ + CCY @ CY @ + PLOT
  CCX @ CX @ - CCY @ CY @ + PLOT
  CCX @ CX @ + CCY @ CY @ - PLOT
  CCX @ CX @ - CCY @ CY @ - PLOT
  CCX @ CY @ + CCY @ CX @ + PLOT
  CCX @ CY @ - CCY @ CX @ + PLOT
  CCX @ CY @ + CCY @ CX @ - PLOT
  CCX @ CY @ - CCY @ CX @ - PLOT
;

: CIRCLE ( cx cy r -- )
  CX ! CCY ! CCX !
  0 CY ! 0 CERR !
  BEGIN
    C8
    CY @ 1+ CY !
    CERR @ 1 + CY @ 2* + CERR !
    CERR @ CX @ - 2* 1+ 0>
    IF CX @ 1- CX ! CERR @ 1 + CX @ 2* - CERR ! THEN
    CX @ CY @ <
  UNTIL
;

: CF4 ( -- ) ( the filled-span equivalent of C8, four spans not eight points )
  CCX @ CX @ - CCX @ CX @ + CCY @ CY @ + HLINE
  CCX @ CX @ - CCX @ CX @ + CCY @ CY @ - HLINE
  CCX @ CY @ - CCX @ CY @ + CCY @ CX @ + HLINE
  CCX @ CY @ - CCX @ CY @ + CCY @ CX @ - HLINE
;

: CIRCLE-FILL ( cx cy r -- )
  CX ! CCY ! CCX !
  0 CY ! 0 CERR !
  BEGIN
    CF4
    CY @ 1+ CY !
    CERR @ 1 + CY @ 2* + CERR !
    CERR @ CX @ - 2* 1+ 0>
    IF CX @ 1- CX ! CERR @ 1 + CX @ 2* - CERR ! THEN
    CX @ CY @ <
  UNTIL
;

( Back to plain FORTH -- GRAPHICS stays reachable via USE GRAPHICS/ )
( GRAPHICS DEFINITIONS, same as EDITOR above, never automatically )
( in scope. )
FORTH DEFINITIONS
