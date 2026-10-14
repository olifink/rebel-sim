\ memo.fth -- MEMO, the full-screen page editor, rebel-specs 09-MEMO.md.
\ A source module: load it with MODULE MEMO, enter it with MEMO.
\
\ A document is a page bank, section 3, or a BLKS block bank edited as
\ 64 x 16 pages, 3.4. While a page is shown the screen IS the working
\ copy: keys edit the CHAR bank directly, and COMMIT copies it back to
\ the document before anything else is shown or run. Shift-Esc runs the
\ line under the cursor as Forth, section 6 -- the whole command system.
\
\ Internal words live in the MEMO-VOCAB vocabulary; MEMO, MEMO-OPEN,
\ (MEMO-OPEN) and EDIT go in FORTH. A command line runs with the
\ caller's search order unchanged, not MEMO-VOCAB first as 6.3 says:
\ with branching vocabularies, MEMO-VOCAB first would hide every FORTH
\ word defined after MEMO was loaded, the user's own words included.

VOCABULARY MEMO-VOCAB
MEMO-VOCAB DEFINITIONS

\ ---- screen geometry and the cursor, from the sysvars ----
: SCOLS ( -- n ) BANK@ SYSV 80 + @ ;
: SROWS ( -- n ) BANK@ SYSV 84 + @ ;
: SCR-LINE ( row -- addr ) SCOLS * BANK@ CHAR + ;
: CX ( -- x ) BANK@ SYSV 16 + @ ;
: CY ( -- y ) BANK@ SYSV 20 + @ ;

\ ---- keys: raw usage codes, EKEY section 6.9 ----
HEX
4F CONSTANT K-RIGHT  50 CONSTANT K-LEFT  51 CONSTANT K-DOWN  52 CONSTANT K-UP
28 CONSTANT K-ENTER  29 CONSTANT K-ESC   2A CONSTANT K-BS    2C CONSTANT K-SPACE
4A CONSTANT K-HOME   4C CONSTANT K-DEL   4D CONSTANT K-END
534B4C42 CONSTANT TAG-BLKS   \ the tag cell of a BLKS bank, little-endian
DECIMAL

\ ---- the current document ----
VARIABLE D-SLOT                  \ its MMAP slot
VARIABLE D-BLK                   \ true for a block bank
VARIABLE D-COLS  VARIABLE D-ROWS
VARIABLE BLK-PAGE  VARIABLE BLK-CX  VARIABLE BLK-CY   \ a block bank's place
VARIABLE DIRTY                   \ the shown page was edited
VARIABLE SHOWN                   \ the screen holds the page right now

: D-BASE ( -- addr ) D-SLOT @ 12 + @ ;
: D-SIZE ( -- n ) D-SLOT @ 16 + @ ;
: PG-HDR ( offset -- addr ) D-BASE + ;
: PAGE-SIZE ( -- n ) D-COLS @ D-ROWS @ * ;
: PAGES ( -- n ) D-BLK @ IF D-SIZE 1024 / ELSE 12 PG-HDR @ THEN ;
: PAGES! ( n -- ) 12 PG-HDR ! ;
: CAPACITY ( -- n ) D-BLK @ IF PAGES ELSE D-SIZE 32 - PAGE-SIZE / THEN ;
: PAGE# ( -- n ) D-BLK @ IF BLK-PAGE @ ELSE 20 PG-HDR @ THEN ;
: PAGE#! ( n -- ) D-BLK @ IF BLK-PAGE ! ELSE 20 PG-HDR ! THEN ;
: CX@ ( -- x ) D-BLK @ IF BLK-CX @ ELSE 24 PG-HDR @ THEN ;
: CY@ ( -- y ) D-BLK @ IF BLK-CY @ ELSE 28 PG-HDR @ THEN ;
: CX! ( x -- ) D-BLK @ IF BLK-CX ! ELSE 24 PG-HDR ! THEN ;
: CY! ( y -- ) D-BLK @ IF BLK-CY ! ELSE 28 PG-HDR ! THEN ;
: REVISE ( -- ) D-BLK @ 0= IF 1 16 PG-HDR +! THEN ;

: DOC! ( slot -- )
  DUP D-SLOT !
  DUP @ TAG-BLKS = DUP D-BLK !
  IF DROP 64 D-COLS ! 16 D-ROWS !
  ELSE 12 + @ DUP 4 + @ D-COLS ! 8 + @ D-ROWS ! THEN ;

\ The bank BLOCK serves -- the first BLKS-tagged one, named BLKS -- is
\ read and written through BLOCK, UPDATE and FLUSH so MEMO and the
\ buffer pool never disagree, 3.4. Any other bank is addressed directly.
: POOL? ( -- f ) D-BLK @ IF S" BLKS" (BANK-FIND) D-SLOT @ = ELSE 0 THEN ;
: PAGE-ADDR ( n -- addr )
  D-BLK @ IF POOL? IF BLOCK ELSE 1024 * D-BASE + THEN
  ELSE PAGE-SIZE * 32 + D-BASE + THEN ;
: PAGE-WRITTEN ( -- ) POOL? IF UPDATE FLUSH THEN ;
: PAGE-BYTES ( n -- addr ) PAGE-SIZE * 32 + D-BASE + ;   \ page banks only

\ ---- text helpers ----
\ The column after the last character above a space, 0 if blank. Bytes
\ below 0x20 count as spaces, 3.2.
: TEXT-END ( addr -- n )
  0 SWAP D-COLS @ 0 DO DUP I + C@ 32 > IF SWAP DROP I 1+ SWAP THEN LOOP DROP ;
: LINE ( y -- addr ) SCR-LINE ;
: LINE-END ( y -- n ) LINE TEXT-END ;
: BLANK? ( y -- f ) LINE-END 0= ;
: PAGE-BLANK? ( -- f ) -1 D-ROWS @ 0 DO I BLANK? AND LOOP ;
: ROW>ROW ( from to -- ) SWAP LINE SWAP LINE D-COLS @ CMOVE ;
: CLEAR-ROW ( y -- ) LINE D-COLS @ BLANKS ;
\ A high-to-low copy, for moving text right within a line.
: CMOVE> ( src dst len -- )
  BEGIN DUP WHILE 1- >R OVER R@ + C@ OVER R@ + C! R> REPEAT DROP 2DROP ;
: CHANGED ( -- ) -1 DIRTY ! ;

\ ---- show and commit, 2.1 ----
: .DOC-NAME ( -- ) D-SLOT @ 4 + 8 0 DO DUP I + C@ ?DUP IF EMIT THEN LOOP DROP ;
\ The status row: only when the page leaves a row free below it.
: STATUS-ROW ( -- )
  D-ROWS @ SROWS < IF
    0 D-ROWS @ AT-XY .DOC-NAME SPACE SPACE
    D-BLK @ IF PAGE# . ELSE PAGE# 1+ . ." of" SPACE PAGES . THEN
  THEN ;
: SHOW ( -- )
  CLS
  PAGE# PAGE-ADDR
  D-ROWS @ 0 DO DUP I D-COLS @ * + I SCR-LINE D-COLS @ CMOVE LOOP DROP
  STATUS-ROW
  CX@ D-COLS @ 1- MIN  CY@ D-ROWS @ 1- MIN  AT-XY
  REDRAW CURSEN
  0 DIRTY !  -1 SHOWN ! ;
: COMMIT ( -- )
  SHOWN @ IF
    PAGE# PAGE-ADDR
    D-ROWS @ 0 DO I SCR-LINE OVER I D-COLS @ * + D-COLS @ CMOVE LOOP DROP
    PAGE-WRITTEN
    CX CX! CY CY!
    DIRTY @ IF REVISE 0 DIRTY ! THEN
  THEN ;

\ ---- editing one line, 4 ----
: TYPE-CHAR ( c -- ) >R CX CY R> CHAR! CHANGED  CX 1+ D-COLS @ 1- MIN CY AT-XY ;
: BACKSPACE ( -- ) CX IF CX 1- CY 2DUP AT-XY BL CHAR! CHANGED CX CY AT-XY THEN ;
: DELETE-CHAR ( -- )
  CY LINE CX + DUP 1+ SWAP D-COLS @ CX - 1- CMOVE
  BL CY LINE D-COLS @ 1- + C!  CHANGED REDRAW ;
: INSERT-SPACE ( -- )
  CY LINE CX + DUP 1+ D-COLS @ CX - 1- CMOVE>
  BL CY LINE CX + C!  CHANGED REDRAW ;
\ Shift-Enter, 4.4: the text from the cursor moves to a new line below.
: SPLIT-LINE ( -- )
  CY D-ROWS @ 1- = IF
    CY LINE CX + D-COLS @ CX - BLANKS CHANGED REDRAW EXIT
  THEN
  D-ROWS @ 2 - BEGIN DUP CY > WHILE DUP DUP 1+ ROW>ROW 1- REPEAT DROP
  CY 1+ CLEAR-ROW
  CY LINE CX +  CY 1+ LINE  D-COLS @ CX - CMOVE
  CY LINE CX + D-COLS @ CX - BLANKS
  0 CY 1+ AT-XY CHANGED REDRAW ;

\ ---- pages, 5 ----
: GO-PAGE ( n -- ) PAGE#! SHOW ;
: BLANK-PAGE ( n -- ) PAGE-BYTES PAGE-SIZE BLANKS ;
: NEXT-PAGE ( -- )
  COMMIT
  PAGE# PAGES 1- < IF PAGE# 1+ GO-PAGE EXIT THEN
  D-BLK @ IF EXIT THEN
  PAGE-BLANK? IF EXIT THEN
  PAGES CAPACITY < 0= IF EXIT THEN
  PAGES DUP BLANK-PAGE 1+ PAGES! REVISE
  PAGE# 1+ GO-PAGE ;
: PREV-PAGE ( -- )
  COMMIT
  PAGE# 0= IF EXIT THEN
  D-BLK @ 0= IF
    PAGE# PAGES 1- = PAGE-BLANK? AND IF PAGES 1- PAGES! REVISE THEN
  THEN
  PAGE# 1- GO-PAGE ;
\ Shift-Space on a blank line, 5.2: the lines below it start a new page.
: SPLIT-PAGE ( -- )
  D-BLK @ IF EXIT THEN
  PAGES CAPACITY < 0= IF EXIT THEN
  COMMIT
  PAGES 1- BEGIN DUP PAGE# > WHILE
    DUP PAGE-BYTES OVER 1+ PAGE-BYTES PAGE-SIZE CMOVE 1-
  REPEAT DROP
  PAGE# 1+ BLANK-PAGE
  D-ROWS @ CY - 1-
  PAGE# PAGE-BYTES CY 1+ D-COLS @ * +  PAGE# 1+ PAGE-BYTES  ROT D-COLS @ * CMOVE
  PAGE# PAGE-BYTES CY 1+ D-COLS @ * +  D-ROWS @ CY - 1- D-COLS @ * BLANKS
  PAGES 1+ PAGES! REVISE
  SHOW ;
\ Lines on page n up to and including its last non-blank one.
: PAGE-LINES ( n -- k )
  0 D-ROWS @ 0 DO OVER PAGE-BYTES I D-COLS @ * + TEXT-END IF DROP I 1+ THEN LOOP NIP ;
\ Shift-Backspace at the top left, 5.3: this page joins the previous one.
: JOIN-PAGE ( -- )
  D-BLK @ PAGE# 0= OR IF EXIT THEN
  COMMIT
  PAGE# 1- PAGE-LINES
  DUP D-ROWS @ = IF DROP EXIT THEN
  PAGE# PAGE-BYTES  PAGE# 1- PAGE-BYTES 2 PICK D-COLS @ * +  D-ROWS @ 3 PICK - D-COLS @ * CMOVE
  PAGE# 1+ BEGIN DUP PAGES < WHILE
    DUP PAGE-BYTES OVER 1- PAGE-BYTES PAGE-SIZE CMOVE 1+
  REPEAT DROP
  PAGES 1- PAGES! REVISE
  0 CX! CY!
  PAGE# 1- GO-PAGE ;
\ Shift-Backspace at column 0, 4.4: this line joins the one above.
: JOIN-LINE ( -- )
  CY 0= IF JOIN-PAGE EXIT THEN
  CY 1- LINE-END
  DUP D-COLS @ = IF DROP EXIT THEN
  CY LINE  OVER CY 1- LINE +  D-COLS @ 3 PICK - CMOVE
  CY 1+ BEGIN DUP D-ROWS @ < WHILE DUP DUP 1- ROW>ROW 1+ REPEAT DROP
  D-ROWS @ 1- CLEAR-ROW
  CY 1- AT-XY CHANGED REDRAW ;

\ ---- executing a line, 6 ----
CREATE CMD-BUF 256 ALLOT
VARIABLE CMD-LEN  VARIABLE CMD-ACTIVE
VARIABLE CMD-SLOT  VARIABLE CMD-PAGE  VARIABLE CMD-Y
VARIABLE ST-LINE  VARIABLE ST-COL
VARIABLE CC-LINE  VARIABLE CC-FOUND

\ Is the character at column i a \ standing alone as a word?
: STANDALONE? ( i -- f )
  CC-LINE @ OVER + C@ 92 = 0= IF DROP 0 EXIT THEN
  DUP 0= IF -1 ELSE CC-LINE @ OVER 1- + C@ 32 > 0= THEN
  SWAP 1+ DUP D-COLS @ = IF DROP -1 ELSE CC-LINE @ + C@ 32 > 0= THEN AND ;
\ Where the status goes, 6.2: over the line's last standalone \
\ comment if it has one, otherwise one space after the command.
: COMMENT-COL ( line -- col )
  CC-LINE !  -1 CC-FOUND !
  CC-LINE @ TEXT-END
  0 BEGIN 2DUP > WHILE DUP STANDALONE? IF DUP CC-FOUND ! THEN 1+ REPEAT DROP
  CC-FOUND @ 0< IF DUP IF 1+ THEN ELSE DROP CC-FOUND @ THEN ;
\ Step 4: the scratch screen's rows, through the cursor's row -- or the
\ row above if the cursor ended at column 0 -- below the command line.
: CAPTURE ( -- )
  CY CX IF 1+ THEN
  D-ROWS @ CMD-Y @ - 1- MIN 0 MAX
  CMD-PAGE @ PAGE-ADDR CMD-Y @ 1+ D-COLS @ * +
  SWAP DUP IF
    0 DO I SCR-LINE OVER I D-COLS @ * + D-COLS @ CMOVE LOOP
  ELSE DROP THEN DROP ;
\ Step 5: the status on the command's own line, cut at the margin.
: STATUS ( error? -- )
  CMD-PAGE @ PAGE-ADDR CMD-Y @ D-COLS @ * + ST-LINE !
  ST-LINE @ COMMENT-COL ST-COL !
  ST-COL @ D-COLS @ < IF
    ST-LINE @ ST-COL @ + D-COLS @ ST-COL @ - BLANKS
    IF S" \ error" ELSE S" \ ok" THEN
    D-COLS @ ST-COL @ - MIN
    ST-LINE @ ST-COL @ + SWAP CMOVE
  ELSE DROP THEN ;
\ Steps 4 to 6, into the document the command was in -- which need not
\ be the current one any more, 6.4 -- then show the current one.
: FINISH-COMMAND ( error? -- )
  0 CMD-ACTIVE !
  D-SLOT @ >R  CMD-SLOT @ DOC!
  CAPTURE STATUS PAGE-WRITTEN REVISE
  R> DOC!  SHOW ;
\ Shift-Esc, 6.3. Steps 1 to 3; a line that aborts is finished by the
\ step word on recovery, and one that switches environment never
\ returns at all.
: EXECUTE-LINE ( -- )
  COMMIT
  D-SLOT @ CMD-SLOT !  PAGE# CMD-PAGE !  CY CMD-Y !
  CY LINE CMD-BUF D-COLS @ CMOVE
  CMD-BUF TEXT-END CMD-LEN !
  -1 CMD-ACTIVE !  0 SHOWN !
  CLS
  CMD-BUF CMD-LEN @ EVALUATE
  0 FINISH-COMMAND ;

\ ---- dispatching a key ----
VARIABLE KU  VARIABLE KS  VARIABLE KC
: DECODE ( event -- )
  DUP 255 AND KU !  DUP 256 / 34 AND 0= 0= KS !  65536 / 255 AND KC ! ;
: IS? ( usage -- f ) KU @ = ;
: SHIFTED-KEY ( -- handled? )
  K-DOWN IS? IF NEXT-PAGE -1 EXIT THEN
  K-UP IS? IF PREV-PAGE -1 EXIT THEN
  K-SPACE IS? IF CY BLANK? IF SPLIT-PAGE ELSE INSERT-SPACE THEN -1 EXIT THEN
  K-ENTER IS? IF SPLIT-LINE -1 EXIT THEN
  K-BS IS? IF CX IF DELETE-CHAR ELSE JOIN-LINE THEN -1 EXIT THEN
  K-ESC IS? IF EXECUTE-LINE -1 EXIT THEN
  0 ;
: PLAIN-KEY ( -- )
  K-LEFT IS? IF CX 1- 0 MAX CY AT-XY EXIT THEN
  K-RIGHT IS? IF CX 1+ D-COLS @ 1- MIN CY AT-XY EXIT THEN
  K-UP IS? IF CX CY 1- 0 MAX AT-XY EXIT THEN
  K-DOWN IS? IF CX CY 1+ D-ROWS @ 1- MIN AT-XY EXIT THEN
  K-HOME IS? IF 0 CY AT-XY EXIT THEN
  K-END IS? IF CY LINE-END D-COLS @ 1- MIN CY AT-XY EXIT THEN
  K-ENTER IS? IF 0 CY 1+ D-ROWS @ 1- MIN AT-XY EXIT THEN
  K-BS IS? IF BACKSPACE EXIT THEN
  K-DEL IS? IF DELETE-CHAR EXIT THEN
  KC @ 32 < KC @ 127 = OR IF EXIT THEN
  KC @ TYPE-CHAR ;
: DO-KEY ( event -- )
  DECODE
  KS @ IF SHIFTED-KEY IF EXIT THEN THEN
  PLAIN-KEY ;

\ ---- the environment, 8 ----
: MEMO-STEP ( -- )
  ENV-REASON @  ENV-STEP ENV-REASON !
  DUP ENV-ENTER = IF 0 CMD-ACTIVE ! SHOW THEN
  ENV-RECOVER = IF CMD-ACTIVE @ IF -1 FINISH-COMMAND ELSE SHOW THEN THEN
  EKEY DO-KEY ;
' MEMO-STEP CONSTANT MEMO-STEP-XT

\ ---- opening documents, 7.1 ----
: FITS? ( cols rows -- f ) SROWS > 0= SWAP SCOLS > 0= AND ;
: PAGE-BANK? ( slot -- f )
  12 + @ DUP C@ 80 = OVER 1+ C@ 71 = AND SWAP 2 + C@ 1 = AND ;
\ A new document: one blank page in this screen's geometry.
: NEW-DOC ( slot -- )
  12 + @
  80 OVER C!  71 OVER 1+ C!  1 OVER 2 + C!
  SCOLS OVER 4 + !  SROWS OVER 8 + !  1 OVER 12 + !
  32 + SCOLS SROWS * BLANKS ;
: OPEN-SLOT ( addr len -- slot | 0 )
  2DUP (BANK-FIND) ?DUP 0= IF
    S" MEMO" 16384 (BANK-CREATE) DUP IF DUP NEW-DOC THEN
  ELSE NIP NIP THEN ;
: OPENABLE? ( slot -- f )
  DUP @ TAG-BLKS = IF DROP SCOLS 63 > SROWS 15 > AND EXIT THEN
  DUP PAGE-BANK? 0= IF DROP 0 EXIT THEN
  12 + @ DUP 4 + @ SWAP 8 + @ FITS? ;

\ The implementations stay here; the public words below are thin
\ wrappers, because once FORTH is CURRENT again, words found through
\ MEMO-VOCAB cannot see what is added to FORTH afterwards.
: OPEN-DOC ( addr len -- flag )
  OPEN-SLOT DUP 0= IF EXIT THEN
  DUP OPENABLE? 0= IF DROP 0 EXIT THEN
  DOC! -1 ;
VARIABLE MEMO-XT   \ MEMO itself, for EDIT -- set once MEMO exists
: EDIT-BLOCK ( n -- )
  S" BLKS" OPEN-DOC 0= IF ." no BLKS bank, or a screen smaller than 64 x 16" ABORT THEN
  DUP 0 PAGES WITHIN 0= IF . ." - no such block" ABORT THEN
  BLK-PAGE !  0 BLK-CX !  0 BLK-CY !
  MEMO-XT @ EXECUTE ;

FORTH DEFINITIONS MEMO-VOCAB

\ ---- the public words, in FORTH ----
MEMO-STEP-XT ENVIRONMENT MEMO
' MEMO MEMO-XT !
: (MEMO-OPEN) ( addr len -- flag ) OPEN-DOC ;
: MEMO-OPEN ( "name" -- )
  BL WORD 2DUP OPEN-DOC IF 2DROP ELSE TYPE SPACE ." - cannot open" ABORT THEN ;
: EDIT ( n -- ) EDIT-BLOCK ;

S" NOTES" OPEN-DOC DROP
FORTH
