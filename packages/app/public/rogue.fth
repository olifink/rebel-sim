\ rogue.fth -- ROGUE, a small demo game for rebel-specs 13-GAME-LOOP.md.
\ Load it with NEEDS ROGUE and play with ROGUE. The arrow keys move the
\ hero; collect the coins and keep away from the skeletons and bats.
\ Each time it is entered it waits for a key before anything moves.
\ Enter starts again after the game is over; Esc returns to the prompt.
\ The art is the reference sheet rebel-specs/references/rebel_rogue.SPR,
\ shipped beside this file as rogue.spr.

NEEDS GAME
LOAD-ASSET ROGUE.SPR

VOCABULARY ROGUE-VOCAB
ROGUE-VOCAB DEFINITIONS

\ ---- the sheet's entries ----
0 CONSTANT HERO-0      5 CONSTANT SKELETON   6 CONSTANT BAT
10 CONSTANT COIN       12 CONSTANT WALL

\ ---- the room: walls on cells 2-41 x 4-27, the floor inside ----
24 CONSTANT X-MIN   328 CONSTANT X-MAX   40 CONSTANT Y-MIN   216 CONSTANT Y-MAX
: CLAMP ( n lo hi -- n' ) ROT MIN MAX ;

\ ---- state ----
VARIABLE SCORE  VARIABLE LIVES  VARIABLE DONE  VARIABLE STARTED
VARIABLE WAITING   \ held until a key is pressed, after every entry
VARIABLE HERO  VARIABLE COINS-LEFT  VARIABLE SEED  1 SEED !
VARIABLE HERO-XT  VARIABLE ENEMY-XT  VARIABLE COIN-XT  VARIABLE ROOM-XT

\ The ZX81's generator: 0 to n-1.
: RND ( n -- r ) SEED @ 75 * 74 + 65537 MOD DUP SEED ! SWAP MOD ;

\ ---- a record: GAME's header, then these ----
: R-X ( rec -- a ) 8 + ;      : R-Y ( rec -- a ) 12 + ;
: R-VX ( rec -- a ) 16 + ;    : R-VY ( rec -- a ) 20 + ;
: R-SLOT ( rec -- a ) 24 + ;  : R-ENTRY ( rec -- a ) 28 + ;
\ Puts the record's sprite in its render slot.
: SHOW ( rec -- ) DUP R-X @ OVER R-Y @ ROT DUP R-ENTRY @ SWAP R-SLOT @ PLACE ;
\ A record spawned with an update word, a sprite entry and a slot.
: NEW-REC ( xt entry slot -- rec ) ROT SPAWN >R R@ R-SLOT ! R@ R-ENTRY ! R> ;
\ Does the record's box, size pixels square, touch the hero's?
: HERO-BOX ( -- x y w h ) HERO @ DUP R-X @ 2 + SWAP R-Y @ 2 + 12 12 ;
: TOUCHES? ( rec size -- f ) >R DUP R-X @ SWAP R-Y @ R@ R> HERO-BOX OVERLAP? ;

\ ---- the room and the display ----
: WALLS ( -- )
  42 2 DO I 4 WALL TILE  I 27 WALL TILE LOOP
  27 5 DO 2 I WALL TILE  41 I WALL TILE LOOP ;
: HUD ( -- )
  2 1 AT-XY ." ROGUE   SCORE" SPACE SCORE @ .  ." LIVES" SPACE LIVES @ .
  2 2 AT-XY ." ARROWS MOVE - ESC QUITS"
  DONE @ IF 12 15 AT-XY ." GAME OVER - PRESS ENTER" THEN
  WAITING @ IF 12 15 AT-XY ." PRESS A KEY TO START" THEN ;
: ROOM ( -- ) CLS WALLS HUD ;

\ ---- the hero ----
: START-HERO ( -- ) HERO @ 40 OVER R-X ! 48 SWAP R-Y ! ;
: MOVING? ( -- f ) 79 KEY-DOWN? 80 KEY-DOWN? OR 81 KEY-DOWN? OR 82 KEY-DOWN? OR ;
: HERO-UPDATE ( rec -- )
  DUP R-X @  80 KEY-DOWN? 2 * +  79 KEY-DOWN? 2 * -  X-MIN X-MAX 16 - CLAMP OVER R-X !
  DUP R-Y @  82 KEY-DOWN? 2 * +  81 KEY-DOWN? 2 * -  Y-MIN Y-MAX 16 - CLAMP OVER R-Y !
  MOVING? IF FRAME-COUNT @ 8 / 3 AND ELSE 0 THEN OVER R-ENTRY !
  SHOW ;
' HERO-UPDATE HERO-XT !

\ ---- enemies: bounce off the walls, cost a life on touch ----
: CAUGHT ( -- ) -1 LIVES +!  LIVES @ 0= IF -1 DONE ! THEN START-HERO ;
: STEP-X ( rec -- )
  DUP R-X @ OVER R-VX @ +
  DUP X-MIN < OVER X-MAX 16 - > OR IF DROP DUP R-VX @ NEGATE OVER R-VX ! ELSE OVER R-X ! THEN DROP ;
: STEP-Y ( rec -- )
  DUP R-Y @ OVER R-VY @ +
  DUP Y-MIN < OVER Y-MAX 16 - > OR IF DROP DUP R-VY @ NEGATE OVER R-VY ! ELSE OVER R-Y ! THEN DROP ;
: ENEMY-UPDATE ( rec -- ) DUP STEP-X DUP STEP-Y DUP SHOW 14 TOUCHES? IF CAUGHT THEN ;
' ENEMY-UPDATE ENEMY-XT !
\ Enemies start on the right half, away from the hero.
: NEW-ENEMY ( entry slot vx vy -- )
  >R >R ENEMY-XT @ -ROT NEW-REC
  120 RND 160 + OVER R-X !  Y-MAX Y-MIN - 24 - RND Y-MIN + OVER R-Y !
  R> OVER R-VX !  R> OVER R-VY !  SHOW ;

\ ---- coins: scattered five at a time, ten points each ----
: SCATTER ( rec -- )
  X-MAX X-MIN - 16 - RND X-MIN + OVER R-X !  Y-MAX Y-MIN - 16 - RND Y-MIN + SWAP R-Y ! ;
: DROP-COINS ( -- ) 5 0 DO COIN-XT @ COIN I 6 + NEW-REC DUP SCATTER SHOW LOOP  5 COINS-LEFT ! ;
: COIN-UPDATE ( rec -- )
  DUP SHOW  DUP 8 TOUCHES? IF
    10 SCORE +!  DUP R-SLOT @ UNPLACE  KILL
    -1 COINS-LEFT +!  COINS-LEFT @ 0= IF DROP-COINS THEN
  ELSE DROP THEN ;
' COIN-UPDATE COIN-XT !
' ROOM ROOM-XT !

\ ---- a game, and a frame of it ----
: NEW-GAME ( -- )
  16 32 NEW-ENTITIES  16 NEW-SLOTS  1 0 LAYER!
  0 SCORE !  3 LIVES !  0 DONE !
  HERO-XT @ HERO-0 0 NEW-REC HERO !  START-HERO  HERO @ SHOW
  SKELETON 1 1 1 NEW-ENEMY  SKELETON 2 -1 1 NEW-ENEMY  SKELETON 3 1 -1 NEW-ENEMY
  BAT 4 2 1 NEW-ENEMY  BAT 5 -1 2 NEW-ENEMY
  DROP-COINS
  ROOM-XT @ BACKGROUND !
  -1 STARTED ! ;
\ The keys are polled with KEY-DOWN?, so queued events are dropped.
\ Any key press but Esc ends the wait to start.
: DRAIN ( -- )
  BEGIN EKEY? WHILE EKEY 255 AND 41 <> IF 0 WAITING ! THEN REPEAT ;
: QUIT-GAME ( -- ) 500 REPEAT-DELAY !  CURSEN  HOME ;
: ROGUE-STEP ( -- )
  ENV-REASON @  ENV-STEP ENV-REASON !
  \ Entered or recovered: this game's sheet, no key repeat, no cursor.
  ENV-STEP = 0= IF
    BANK@ ROGUE SPRITE-BASE !  0 REPEAT-DELAY !  CURSDIS
    STARTED @ 0= IF NEW-GAME THEN
    -1 WAITING !   \ a fighting chance: nothing moves until a key
  THEN
  DRAIN
  41 KEY-DOWN? IF QUIT-GAME THEN
  DONE @ IF 40 KEY-DOWN? IF NEW-GAME THEN ELSE
    WAITING @ 0= IF RUN-ENTITIES THEN
  THEN
  RENDER VSYNC ;
' ROGUE-STEP CONSTANT ROGUE-STEP-XT

FORTH DEFINITIONS ROGUE-VOCAB
ROGUE-STEP-XT ENVIRONMENT ROGUE
FORTH
