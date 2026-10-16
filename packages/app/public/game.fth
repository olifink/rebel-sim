\ game.fth -- the GAME engine module, rebel-specs 13-GAME-LOOP.md 7. Load
\ it with NEEDS GAME. A game is an environment whose step word draws one
\ frame, section 2; this module is the convenience layer for that frame:
\ an entity table, a render list kept separate from it, and collision.
\ Everything lives in banks, so a paused or saved game keeps its state.
\
\   count size NEW-ENTITIES     the table: size bytes per record
\   xt SPAWN ( -- rec | 0 )     an active record whose update word is xt
\   rec KILL                    frees the record
\   RUN-ENTITIES                calls every active update word, ( rec -- )
\   count NEW-SLOTS             the render list
\   x y entry i PLACE           slot i draws that sprite entry at x y
\   i UNPLACE                   slot i draws nothing
\   layer i LAYER!              layer 0 to 3, drawn lowest first
\   RENDER                      background, then every slot, by layer
\   FRAME                       RUN-ENTITIES RENDER VSYNC
\   x1 y1 w1 h1 x2 y2 w2 h2 OVERLAP?   axis-aligned box overlap
\
\ A record is a flags cell, active when non-zero, then the update word's
\ xt, then the game's own data from offset 8 -- REC-DATA. A slot is four
\ cells: flags -- bit 0 active, bits 1-2 the layer -- then x, y and the
\ sprite entry. BACKGROUND holds the xt RENDER runs first, CLS unless the
\ game stores its own, typically a room of tiles.

\ ---- banks ----
\ Finds the named bank, or creates it as DATA, then zeroes it. A bank
\ left from an earlier, smaller table is too small and ABORTs.
: GAME-BANK ( name-a name-l size -- base )
  >R 2DUP (BANK-FIND) ?DUP IF NIP NIP ELSE S" DATA" R@ (BANK-CREATE) THEN
  DUP 0= IF R> DROP ." no room for a game bank" ABORT THEN
  DUP 16 + @ R@ < IF R> 2DROP ." game bank too small" ABORT THEN
  12 + @ DUP R> 0 FILL ;

\ ---- entities ----
VARIABLE E-BASE  VARIABLE E-COUNT  VARIABLE E-SIZE
8 CONSTANT REC-DATA
: NEW-ENTITIES ( count size -- )
  8 MAX E-SIZE !  E-COUNT !
  S" ENTITIES" E-COUNT @ E-SIZE @ * GAME-BANK E-BASE ! ;
: ENTITY ( i -- rec ) E-SIZE @ * E-BASE @ + ;
: KILL ( rec -- ) 0 SWAP ! ;
\ The first free record becomes active with update word xt, its data
\ zeroed; 0 if the table is full.
: SPAWN ( xt -- rec | 0 )
  0  E-COUNT @ 0 DO
    DUP 0= IF I ENTITY @ 0= IF DROP I ENTITY THEN THEN
  LOOP
  DUP 0= IF NIP EXIT THEN
  DUP E-SIZE @ 0 FILL
  -1 OVER !  TUCK CELL+ ! ;
: RUN-ENTITIES ( -- )
  E-COUNT @ 0 DO I ENTITY DUP @ IF DUP CELL+ @ EXECUTE ELSE DROP THEN LOOP ;

\ ---- the render list ----
VARIABLE S-BASE  VARIABLE S-COUNT
: NEW-SLOTS ( count -- ) DUP S-COUNT !  S" RENDER" ROT 16 * GAME-BANK S-BASE ! ;
: SLOT ( i -- addr ) 16 * S-BASE @ + ;
: PLACE ( x y entry i -- )
  SLOT >R  R@ 12 + !  R@ 8 + !  R@ 4 + !  R@ @ 1 OR R> ! ;
: UNPLACE ( i -- ) SLOT DUP @ -2 AND SWAP ! ;
: LAYER! ( layer i -- ) SLOT >R  3 AND 2*  R@ @ -7 AND OR R> ! ;
' CLS VARIABLE BACKGROUND  BACKGROUND !
: DRAW-LAYER ( layer -- )
  S-COUNT @ 0 DO
    I SLOT @ DUP 1 AND IF 2/ 3 AND OVER = IF I SLOT 4 + DUP @ SWAP 4 + DUP @ SWAP 4 + @ SPRITE THEN ELSE DROP THEN
  LOOP DROP ;
: RENDER ( -- ) BACKGROUND @ EXECUTE  4 0 DO I DRAW-LAYER LOOP ;
: FRAME ( -- ) RUN-ENTITIES RENDER VSYNC ;

\ ---- collision, 7.3 ----
VARIABLE OX1  VARIABLE OY1  VARIABLE OW1  VARIABLE OH1
VARIABLE OX2  VARIABLE OY2  VARIABLE OW2  VARIABLE OH2
: OVERLAP? ( x1 y1 w1 h1 x2 y2 w2 h2 -- flag )
  OH2 ! OW2 ! OY2 ! OX2 !  OH1 ! OW1 ! OY1 ! OX1 !
  OX1 @ OX2 @ OW2 @ + <   OX2 @ OX1 @ OW1 @ + <  AND
  OY1 @ OY2 @ OH2 @ + <   OY2 @ OY1 @ OH1 @ + <  AND  AND ;

HIDE GAME-BANK
HIDE DRAW-LAYER
HIDE E-BASE
HIDE E-COUNT
HIDE E-SIZE
HIDE S-BASE
HIDE S-COUNT
HIDE OX1
HIDE OY1
HIDE OW1
HIDE OH1
HIDE OX2
HIDE OY2
HIDE OW2
HIDE OH2
