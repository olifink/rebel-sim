\ editor.fth -- the classic block screen editor, a source module: load it
\ with NEEDS EDITOR, then USE EDITOR. Moved out of system.fth in M82;
\ the block words it is built on -- BLOCK, BUFFER, UPDATE, FLUSH, LOAD,
\ C/L, L/SCR -- stay in system.fth, since LOAD and MEMO need them too.
\ MEMO, NEEDS MEMO, is the full-screen alternative for the same screens.

( The interactive editor commands live in their own vocabulary, not )
( plain FORTH's -- single-letter names collide too easily with )
( ordinary user code, I most of all, since it would shadow the )
( loop-index word every DO/LOOP body depends on. VOCABULARY/ )
( DEFINITIONS already exist for exactly this, DEVELOPING.md section )
( 8: EDITOR's own chain branches from FORTH's current position, so )
( every word defined above, LOAD included, stays reachable from )
( inside EDITOR, but EDITOR's own L/T/TOP/CLEAR stay invisible once )
( back in plain FORTH. DEFINITIONS here, not just EDITOR alone: )
( these words need to actually compile into EDITOR, not just be )
( visible while it's the search context. )
VOCABULARY EDITOR
EDITOR DEFINITIONS

( SCR is the screen number every editor command below acts on by )
( default, the same role classic Forth's own SCR variable plays. )
VARIABLE SCR

( LINE computes the address of line# within the current screen, )
( bounds-checked -- the one piece of address arithmetic T, below, )
( M, -MOVE, H, E, S and D all need. Classic fig-FORTH's own LINE, )
( figforth_editor_screens.txt screen 1, bounds-checks against a )
( numbered ?ERROR table this project has no equivalent of; adapted )
( to this file's own inline message-then-ABORT convention instead, )
( the same style FIND-ADDR further up this file already uses. )
: LINE ( line# -- addr )
  DUP 0 L/SCR WITHIN 0= IF ." line out of range" ABORT THEN
  SCR @ BLOCK SWAP C/L * +
;

( LIST sets SCR and displays screen n, a header line then sixteen )
( numbered lines of C/L characters each. Relies on every byte in a )
( screen always being real text or a space, never a raw NUL byte -- )
( true by construction, since CLEAR and T below both always blank )
( before writing, and every screen gets CLEARed once at boot, )
( further down. )
: LIST ( n -- )
  DUP SCR !
  CR ." SCR #" SPACE DUP . CR
  BLOCK
  L/SCR 0 DO
    I . DUP I C/L * + C/L TYPE CR
  LOOP
  DROP
;

( L redisplays the current screen without changing which one that )
( is -- classic Forth's own split between a screen-number-taking )
( LIST and a no-argument L. No CLS: the display is tall enough for )
( a whole listing, so L just appends it after whatever REPL output )
( is already on screen, the same as LIST, and earlier output stays )
( visible above it. )
: L ( -- ) SCR @ LIST ;

( T-LINE is a scratch variable threading a computed line address )
( through T, the same convention every other scratch variable in )
( this file already established. Hidden below, once T no longer )
( needs to find it by name. )
VARIABLE T-LINE

( ---------------------------------------------------------------- )
( Cursor tracking, classic R#, and the remaining core editor )
( commands -- figforth_editor_screens.txt screens 2-6, ported: line )
( editing here, search/replace and COPY further below, M55 follow- )
( up. R# is classic Forth's own cursor: an absolute byte offset )
( within the current screen, 0..1023, that M and everything below it )
( navigates relative to -- name kept faithfully. )
VARIABLE R#
0 R# !

( #LOCATE splits R# into column and line# -- the byte offset within )
( its own line, and which line that is. Classic's own /MOD leaves )
( exactly this order, remainder then quotient, no reordering needed. )
: #LOCATE ( -- col line# ) R# @ C/L /MOD ;

( #LEAD is the text already on the current line before the cursor -- )
( the addr/len pair TYPE needs to print it. )
: #LEAD ( -- addr len ) #LOCATE LINE SWAP ;

( #LAG is the remaining text on the current line, from the cursor to )
( the line's end. )
: #LAG ( -- addr len ) #LEAD DUP >R + C/L R> - ;

( M moves the cursor by n -- 0 to redisplay in place, negative to )
( move backward -- and redraws the current line with an underscore )
( marking exactly where the cursor now sits -- classic Forth's live )
( you-are-here feedback for every cursor-moving command below. 95 is )
( the underscore's ASCII code, matching HEXDIGIT's own established )
( convention, further up this file, of literal ASCII codes over a )
( character-literal syntax this Forth doesn't have. )
: M ( n -- )
  R# +!
  CR SPACE #LEAD TYPE 95 EMIT #LAG TYPE
  #LOCATE . DROP
;

( T positions the cursor at the start of line# -- so subsequent )
( cursor-relative commands act from there -- and replaces that line )
( with the rest of the current input line's own text, blanked first )
( and then truncated or padded to exactly C/L characters. The )
( delimiter-one WORD call is the classic fig-FORTH TEXT idiom: a )
( delimiter byte that can never occur in typed input, since one is )
( not a printable character, makes the scan run to the end of the )
( line instead of stopping at the next space -- capturing everything )
( after the line number as one span of raw text. M55 follow-up: now )
( goes through the shared LINE word, bounds-checked, unlike this )
( word's own original inline address arithmetic, and sets R# first, )
( so a T immediately followed by a cursor-relative command like F/N )
( below acts on the line just typed rather than wherever the cursor )
( last happened to be. )
: T ( line# -- )
  DUP C/L * R# !
  LINE T-LINE !
  T-LINE @ C/L BLANKS
  1 WORD C/L MIN
  T-LINE @ SWAP CMOVE
  UPDATE
;

( TEXT-LEN records how many real, non-padded characters TEXT below )
( actually reads -- this file's addr/len PAD convention has no count )
( byte for the search words further down to read the pattern's own )
( length from the way classic fig-FORTH's own PAD-count-byte-based )
( TEXT does, so TEXT sets this explicitly alongside its main job. )
( Declared here, ahead of TEXT's own definition, since Forth can't )
( reference a variable that doesn't exist yet. )
VARIABLE TEXT-LEN

( TEXT reads the rest of the current input line -- T's own )
( delimiter-one WORD idiom above -- into PAD, blanked first and )
( truncated or padded to exactly C/L characters, leaving nothing on )
( the stack. The shared scratch buffer every text-taking command )
( below reads new text through: exactly PAD's own documented no- )
( reentrancy, overwritten-unconditionally-on-next-use contract )
( already accepts, rebel-opcodes.json's own PAD note -- classic )
( fig-FORTH's TEXT used PAD the same shared, single-purpose way. )
: TEXT ( -- )
  PAD C/L BLANKS
  1 WORD C/L MIN
  DUP TEXT-LEN !
  PAD SWAP CMOVE
;

( -MOVE copies C/L bytes from addr into line# 's own line and marks )
( the screen dirty -- the shift-one-line-into-place primitive S and )
( D both build on. )
: -MOVE ( addr line# -- ) LINE C/L CMOVE UPDATE ;

( H, hold, copies line# 's own C/L bytes into PAD -- classic H )
( exactly, screen 2, reused by D below as a cut side effect: the )
( line about to be deleted lands in PAD first, so a following P can )
( paste it elsewhere. Classic's own PAD held a counted string, a )
( leading length byte; this file's own convention is addr/len pairs )
( throughout, T's own comment above already established this, so )
( there's no count byte to write -- just the C/L content bytes. )
: H ( line# -- ) LINE PAD C/L CMOVE ;

( E blanks line# entirely and marks the screen dirty. )
: E ( line# -- ) LINE C/L BLANKS UPDATE ;

( S scrolls lines line#..14 down into line#+1..15 -- line 15's own )
( old content is discarded, a fixed sixteen-line screen has nowhere )
( further to push it -- and blanks line# itself, opening a gap at )
( line# for I, insert, below to fill. Classic fig-FORTH exactly, )
( screen 2, decimal instead of hex: 14 is L/SCR minus 2, the second- )
( to-last line. )
: S ( line# -- )
  DUP 1- 14 DO
    I LINE I 1+ -MOVE
  -1 +LOOP
  E
;

( D deletes line#: shifts lines line#+1..15 up into line#..14, then )
( blanks line 15, now the vacated, freed-up line. H first holds )
( line# 's own about-to-be-overwritten content in PAD, so it's still )
( available via P immediately afterward -- classic fig-FORTH's own )
( delete-doubles-as-cut behavior, screen 2, decimal instead of hex. )
: D ( line# -- )
  DUP H
  15 DUP ROT DO
    I 1+ LINE I -MOVE
  LOOP
  E
;

( R replaces line# wholesale with whatever's currently held in PAD -- )
( freshly typed text via TEXT, or a just-deleted line via D's own H )
( call, being pasted elsewhere. Classic R exactly, screen 3, adapted )
( for this file's addr/len PAD convention: no leading count byte to )
( skip. )
: R ( line# -- ) PAD SWAP -MOVE ;

( P reads a new line of typed text and replaces line# with it -- the )
( everyday retype-this-line command, classic P exactly, screen 3: )
( TEXT then R. )
: P ( line# -- ) TEXT R ;

( I inserts a blank-ish line at line#: S opens a gap there, then R )
( fills it with whatever's currently in PAD -- classic I exactly, )
( screen 3, kept as classic's own single-letter name: it collides )
( with DO/LOOP's own loop index, the reason EDITOR has its own )
( vocabulary in the first place, comment further up this file, but )
( every EDITOR word defined above this point that needs a loop index, )
( S and D, is already compiled, so their own already-baked-in I means )
( loop index regardless of what this definition adds from here on. )
( Nothing defined after this point may write a bare DO...I...LOOP )
( inside EDITOR -- COPY above is ordered before this exact line for )
( that reason; everything below uses BEGIN/WHILE or an explicit )
( counter instead of DO/LOOP, so this is the last constraint of its )
( kind in this file. If nothing was typed via TEXT/P first, this pastes )
( whatever PAD last held, classic fig-FORTH's own behavior, not a )
( bug -- typically blank, since PAD gets a one-time space-fill of )
( its own further below, right after CLEAR's definition. )

( COPY duplicates source screen's whole content into target screen. )
( Classic COPY's own buffers-per-screen-scaled machinery, screen 3, )
( doesn't apply here, since this project's BLOCK-SIZE already )
( matches one screen to one buffer exactly -- so this reduces to a )
( single BLOCK-SIZE CMOVE between the two screens' own resident )
( buffers, no DO/LOOP needed at all, UPDATE to mark the target )
( dirty, then FLUSH to persist both back to BLKS immediately, )
( matching classic COPY's own leave-nothing-pending-in-the-buffer- )
( pool contract. )
: COPY ( source target -- )
  SWAP BLOCK SWAP BLOCK BLOCK-SIZE CMOVE UPDATE FLUSH
;

: I ( line# -- ) DUP S R ;

( ---------------------------------------------------------------- )
( Search and replace -- figforth_editor_screens.txt screens 4-6. )
( TEXT-LEN, declared alongside TEXT itself above, is what makes )
( 1LINE below possible without a PAD count byte to read from. )

( -TEXT compares len bytes starting at addr1 against len bytes )
( starting at addr2, TRUE if they match exactly. Classic fig-FORTH's )
( own -TEXT name kept, reimplemented with named scratch variables and )
( a plain BEGIN/WHILE loop rather than classic's own dense DO-loop- )
( plus-LEAVE stack-shuffle -- this project has no LEAVE, spec/04- )
( FORTH-CORE.md section 9 -- and with a clearer addr1/addr2/len )
( signature instead of classic's own harder-to-reconstruct exact )
( stack order. )
VARIABLE -TEXT-A1
VARIABLE -TEXT-A2
VARIABLE -TEXT-LEN
VARIABLE -TEXT-I
: -TEXT ( addr1 addr2 len -- flag )
  -TEXT-LEN ! -TEXT-A2 ! -TEXT-A1 !
  0 -TEXT-I !
  BEGIN
    -TEXT-I @ -TEXT-LEN @ <
  WHILE
    -TEXT-A1 @ -TEXT-I @ + C@
    -TEXT-A2 @ -TEXT-I @ + C@
    <>
    IF 0 EXIT THEN
    1 -TEXT-I +!
  REPEAT
  -1
;

( 1LINE searches from the cursor to the end of the current line for )
( the TEXT-LEN bytes of pattern held in PAD. If found, advances R# )
( to just past the match and leaves TRUE; otherwise advances R# to )
( the end of the line and leaves FALSE. Classic 1LINE plus MATCH, )
( screen 4, fused into one word and reimplemented with named scratch )
( variables and a BEGIN/WHILE loop rather than their own dense stack )
( code, for the same no-LEAVE reason -TEXT above already explains. )
VARIABLE LINE-ADDR
VARIABLE LINE-LEN
VARIABLE TRY-POS
: 1LINE ( -- flag )
  #LAG LINE-LEN ! LINE-ADDR !
  0 TRY-POS !
  BEGIN
    LINE-LEN @ TEXT-LEN @ - TRY-POS @ >
  WHILE
    LINE-ADDR @ TRY-POS @ + PAD TEXT-LEN @ -TEXT
    IF
      TRY-POS @ TEXT-LEN @ + R# +!
      -1 EXIT
    THEN
    1 TRY-POS +!
  REPEAT
  LINE-LEN @ R# +!
  0
;

( WRAP-R# resets the cursor to the very start of the screen once it )
( runs off the end -- the boundary case both FIND's own loop and its )
( early give-up path below need to apply identically, or a not-found )
( search can leave R# sitting one past the last valid byte, which )
( LINE, and so #LOCATE/#LEAD/#LAG/M, would then reject. )
: WRAP-R# ( -- ) R# @ BLOCK-SIZE >= IF 0 R# ! THEN ;

( FIND searches the current screen for the pattern held in PAD, )
( starting from the cursor and trying at most L/SCR lines -- one )
( full pass -- before giving up. Classic FIND, screen 4, kept )
( bounded rather than looping forever if the text genuinely isn't on )
( the screen: a real usability risk in an interactive tool that )
( classic's own unconditional retry loop doesn't guard against. )
VARIABLE TRIES
: FIND ( -- flag )
  L/SCR TRIES !
  BEGIN
    WRAP-R#
    1LINE 0=
  WHILE
    TRIES @ 1- DUP TRIES !
    0= IF WRAP-R# 0 EXIT THEN
  REPEAT
  -1
;

( DELETE removes n characters starting at the cursor, shifting )
( everything after them left within the flat screen buffer -- spans )
( line boundaries freely, matching the block's own flat 1024-byte )
( layout, not the sixteen-line display grid. Classic DELETE, screen )
( 5, reimplemented with named scratch instead of its own dense stack )
( code. Leaves R# untouched -- the caller's job, via M, to redisplay )
( wherever the cursor ends up. )
VARIABLE DEL-N
VARIABLE CURSOR-ADDR
VARIABLE TAIL-LEN
: DELETE ( n -- )
  DEL-N !
  SCR @ BLOCK R# @ + CURSOR-ADDR !
  BLOCK-SIZE R# @ - DEL-N @ - TAIL-LEN !
  CURSOR-ADDR @ DEL-N @ + CURSOR-ADDR @ TAIL-LEN @ CMOVE
  CURSOR-ADDR @ TAIL-LEN @ + DEL-N @ BLANKS
  UPDATE
;

( N searches forward from the cursor for whatever search pattern was )
( most recently typed via F/X/TILL/C below, redisplaying wherever )
( the search landed. Classic N, screen 5: FIND's own found/not-found )
( flag is dropped here, not consumed by M, which takes a cursor )
( delta, not a flag. )
: N ( -- ) FIND DROP 0 M ;

( F reads a new search pattern via TEXT and searches forward for it )
( from the cursor. Classic F, screen 5, exactly: TEXT then N. )
: F ( -- ) TEXT N ;

( B moves the cursor backward by the most recent search pattern's )
( own length -- classic B, screen 5, exactly: undoes exactly one )
( N/F's own past-the-match advance. )
: B ( -- ) TEXT-LEN @ NEGATE M ;

( X reads a new search pattern, finds its next occurrence, and )
( deletes it. Classic X, screen 5: since 1LINE above lands the )
( cursor just past a match, not at its start, this backs up by )
( TEXT-LEN first -- the same adjustment B makes -- before deleting. )
: X ( -- )
  TEXT FIND
  IF TEXT-LEN @ NEGATE R# +! TEXT-LEN @ DELETE THEN
  0 M
;

( TILL deletes everything from the cursor up to and including the )
( next occurrence, on the current line only, of a newly typed search )
( pattern. Classic TILL, screen 5, reimplemented: records the )
( cursor's starting position, searches forward within the current )
( line via 1LINE -- not FIND, which would also search later lines -- )
( then deletes the whole span between them. )
VARIABLE TILL-START
: TILL ( -- )
  R# @ TILL-START !
  TEXT 1LINE 0= IF ." text not found" ABORT THEN
  R# @ TILL-START @ - TILL-START @ R# ! DELETE
  0 M
;

( C reads new text and overwrites the current line from the cursor )
( onward with it, up to whatever room remains on the line, then )
( advances the cursor past what was written. Classic C, screen 6, )
( reimplemented with named scratch instead of its own dense stack )
( code. )
VARIABLE C-ADDR
VARIABLE C-LEN
: C ( -- )
  TEXT
  #LAG SWAP C-ADDR !
  TEXT-LEN @ MIN C-LEN !
  PAD C-ADDR @ C-LEN @ CMOVE
  C-LEN @ M
;

( TS, classic's interactive multi-line entry screen 6, rebuilt from )
( scratch rather than ported literally: classic's own T, screen 2, )
( never actually reads anything -- it just repositions the cursor and )
( redraws, relying on the terminal's own hardware to echo keystrokes )
( straight into the display at a hardware cursor, a model this )
( project's own CHAR-bank-backed screen doesn't have. FORTH- )
( ARCHITECTURE.md section 9 item 17 records that finding. The actual )
( gap turned out not to need engine changes at all: KEY -- already )
( blocking, inner.ts -- suspends correctly through any depth of colon- )
( word/loop nesting, since dispatch/executeXT/threadFrom all delegate )
( via `yield*` -- so a plain Forth BEGIN loop around KEY gets the same )
( suspend/resume ACCEPT gets, for free. What TS actually needed )
( instead was its own positioned-write loop: EMIT/TYPE's free-running )
( stream cursor doesn't line up with block-line boundaries, since C/L )
( -- 64 -- doesn't evenly divide this project's 80-column physical )
( screen, so every character here is drawn with AT-XY/CHAR! at an )
( explicitly computed column/row instead. )

( TS-ROW walks the initial full-screen draw. Can't use a bare )
( DO...I...LOOP for it -- I is EDITOR's own insert-line command by )
( this point in the file, same constraint noted above I's own )
( definition -- so this uses the same named-counter BEGIN/WHILE shape )
( as -TEXT/1LINE further up. )
VARIABLE TS-ROW
: TS ( -- )
  CLS
  0 TS-ROW !
  BEGIN TS-ROW @ L/SCR < WHILE
    0 TS-ROW @ AT-XY
    TS-ROW @ LINE C/L TYPE
    1 TS-ROW +!
  REPEAT
  0 R# !
  0 0 AT-XY CURSEN
  ( No AGAIN in this dialect -- only BEGIN/UNTIL and BEGIN/WHILE/REPEAT )
  ( are defined, further up this file -- so 0 UNTIL loops unconditionally, )
  ( same as classic AGAIN would, since 0 is FALSE and UNTIL branches )
  ( back on FALSE. Every exit from here on is an explicit EXIT. )
  BEGIN
    KEY
    DUP 27 = IF ( Esc: stop, keep whatever's already been typed, and )
      ( leave the cursor showing right where typing left off, rather )
      ( than blanking it -- unlike the two BLOCK-SIZE-overflow exits )
      ( below, which really are "nothing left to point at." )
      DROP UPDATE EXIT
    THEN
    DUP 10 = IF ( Enter: advance to the next line's start; landing )
      ( past the last line, BLOCK-SIZE, ends the session exactly like )
      ( Esc, so pressing Enter on line 15 needs no special-casing. )
      DROP
      #LOCATE NIP 1+ C/L * R# !
      R# @ BLOCK-SIZE >= IF WRAP-R# CURSDIS UPDATE EXIT THEN
      #LOCATE AT-XY
    ELSE DUP 8 = IF ( Backspace: step back one, blank that cell -- )
      ( nothing stops it walking back over already-there content, )
      ( same as the cursor keys just below: this screen's whole )
      ( buffer is fair game, not just what was typed this session. )
      DROP
      R# @ 0 > IF
        -1 R# +!
        BL SCR @ BLOCK R# @ + C!
        #LOCATE BL CHAR!
        #LOCATE AT-XY
      THEN
    ELSE DUP 2 = IF ( Up: move one line up, same column, no edit. )
      DROP
      R# @ C/L >= IF C/L NEGATE R# +! #LOCATE AT-XY THEN
    ELSE DUP 3 = IF ( Down: move one line down, same column. )
      DROP
      R# @ C/L + BLOCK-SIZE < IF C/L R# +! #LOCATE AT-XY THEN
    ELSE DUP 4 = IF ( Right: move one column right, same line. )
      DROP
      R# @ 1+ BLOCK-SIZE < IF 1 R# +! #LOCATE AT-XY THEN
    ELSE DUP 5 = IF ( Left: move one column left, same line. )
      DROP
      R# @ 0 > IF -1 R# +! #LOCATE AT-XY THEN
    ELSE ( an ordinary character: write it into the block, draw it, )
      ( advance -- crossing a line boundary here auto-advances to the )
      ( next line with no Enter needed, the same BLOCK-SIZE guard as )
      ( Enter's own end-of-screen case. )
      DUP SCR @ BLOCK R# @ + C!
      #LOCATE ROT CHAR!
      1 R# +!
      R# @ BLOCK-SIZE >= IF WRAP-R# CURSDIS UPDATE EXIT THEN
      #LOCATE AT-XY
    THEN THEN THEN THEN THEN THEN
  0 UNTIL
;

( TOP jumps to and displays the very first screen -- this project's )
( own reading of classic TOP's idea of a known starting point, )
( adapted since nothing here tracks a persistent character-level )
( cursor position the way classic R# did. )
: TOP ( -- ) 0 LIST ;

( CLEAR blanks screen n's entire content and marks it dirty -- for )
( re-blanking a screen while editing. Every screen already starts )
( genuinely blank, space-filled, not the zero-filled bytes a raw )
( bank would otherwise hold: repl.ts fills the whole BLKS bank with )
( spaces natively the moment it's created, before system.fth ever )
( runs, since NUL is not BL and would make INTERPRET's own BL WORD )
( scan read a run of raw NUL bytes as one long unrecognized token )
( and ABORT the instant LOAD or LIST first touched an untouched )
( screen. Simpler than classic fig-FORTH's own line-by-line erase )
( loop: BLOCK already hands back one flat BLOCK-SIZE buffer here, )
( not sixteen separately-addressed lines, so one BLANKS call does )
( the whole screen in a single pass. )
: CLEAR ( n -- ) DUP SCR ! BLOCK BLOCK-SIZE BLANKS UPDATE ;

( PAD itself starts as raw, un-space-filled bytes -- unlike BLKS, )
( nothing native pre-fills it. I above can copy PAD's own content )
( into a screen line without ever calling TEXT first, classic fig- )
( FORTH's own paste-whatever-was-last-held behavior -- so this one- )
( time BLANKS call, run once here at definition time rather than on )
( every boot, makes sure that first-ever paste is real spaces, not )
( whatever raw bytes PAD's own arena bytes started as. )
PAD C/L BLANKS

HIDE T-LINE

( Switching back means compiling here again too, not just looking )
( here -- FORTH DEFINITIONS, matching the EDITOR DEFINITIONS this )
( section opened with. )
FORTH DEFINITIONS
