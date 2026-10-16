( Rebel-Sim system vocabulary. DEVELOPING.md section 6: an interim )
( host-text-file resource loaded once at boot, before screens or )
( carts exist to hold it properly. Every word here is buildable )
( from the core vocabulary alone -- nothing in packages/engine )
( knows this file exists. )

( Note for anyone editing this file: ( doesn't nest -- the first )
( closing paren always ends a comment, so never write an embedded )
( closing paren inside comment text, even a decorative one. )

( ---------------------------------------------------------------- )
( spec/04-FORTH-CORE.md section 6 bootstrap layer (M42): every word )
( below was a native primitives.ts dispatch case through M41 -- )
( moved here per the spec's own KERNEL/BOOTSTRAP classification: a )
( word stays native only if it mutates the inner interpreter's IP, )
( needs raw-token/compiler-state access no stack-effect primitive )
( exposes, or is a true minimal orthogonal basis nothing smaller )
( derives it from. Everything else belongs here instead, so its )
( correctness contract is a portable Forth-source definition every )
( target can share, not per-target native code to reimplement and )
( re-verify from scratch. Order below follows real dependencies -- )
( see PLAN.md's M42 entry for the full batch-by-batch reasoning; a )
( forward reference here fails loudly at load time, not silently. )

( Batch 1 -- defining words. CREATE/DOES>/,/@ all stay native )
( (section 6.6): the true irreducible basis these two build on. )
( CONSTANT no longer uses a dedicated DOCON Code-Field sentinel -- )
( removed from the engine entirely, M42 -- executing a CONSTANT )
( now threads through DODOES exactly like any other DOES>'d word, )
( at the cost of one extra step per read versus a dedicated )
( sentinel, which section 4.1 judges well worth a smaller kernel. )
: VARIABLE CREATE 0 , ;
: CONSTANT CREATE , DOES> @ ;

( Batch 2 -- small zero-dependency words needed by later batches. )
( >CFA relocated here from further down -- was defined next to WORDS )
( since section 6.5's RECURSE, below, needs it too -- same )
( header-layout math WORDS itself walks: the flags byte's low five )
( bits are the name length, the Code Field sits right after the )
( name, cell-aligned. CELLS/CELL+ relocated similarly since J, )
( below, needs CELL+ before section 6's own Batch 4 grouping would )
( otherwise define it. )
: >CFA DUP 4 + C@ 31 AND SWAP 5 + + 3 + -4 AND ;
: CELLS 4 * ;
: CELL+ 4 + ;

( Batch 3 -- the control-flow compiler, section 6.5's flagship )
( reduction: BRANCH, 0BRANCH, and the DO/LOOP/+LOOP runtime helpers )
( below are the only genuinely native control-flow primitives left; )
( every compile-time control-flow word a Forth programmer actually )
( types is fully expressible in terms of them. Each native word a )
( control-flow word needs to compile a call to is resolved once, )
( here, at the top level, into a named CONSTANT -- not looked up by )
( name inside each IMMEDIATE word's own body, which would need ' to )
( be IMMEDIATE itself and break SEE/HIDE/FORGET's own use of ' as a )
( deferred reference resolving their own caller's argument. )
' BRANCH   CONSTANT BRANCH-XT
' 0BRANCH  CONSTANT 0BRANCH-XT
' (DO)     CONSTANT (DO)-XT
' (LOOP)   CONSTANT (LOOP)-XT
' (+LOOP)  CONSTANT (+LOOP)-XT

: IF     0BRANCH-XT , HERE 0 ,                 ; IMMEDIATE COMPILE-ONLY
: ELSE   BRANCH-XT , HERE 0 , SWAP HERE SWAP ! ; IMMEDIATE COMPILE-ONLY
: THEN   HERE SWAP !                           ; IMMEDIATE COMPILE-ONLY
: BEGIN  HERE                                  ; IMMEDIATE COMPILE-ONLY
: UNTIL  0BRANCH-XT , ,                        ; IMMEDIATE COMPILE-ONLY
: WHILE  0BRANCH-XT , HERE 0 ,                 ; IMMEDIATE COMPILE-ONLY
: REPEAT BRANCH-XT , SWAP , HERE SWAP !        ; IMMEDIATE COMPILE-ONLY
: DO     (DO)-XT , HERE                        ; IMMEDIATE COMPILE-ONLY
: LOOP   (LOOP)-XT , 0BRANCH-XT , ,            ; IMMEDIATE COMPILE-ONLY
: +LOOP  (+LOOP)-XT , 0BRANCH-XT , ,           ; IMMEDIATE COMPILE-ONLY
( I/J call RP@ from inside their own colon-definition body -- unlike )
( the primitive I/J this replaces, calling I/J at all pushes one more )
( return address onto RSTK first (DOCOL's own entry, threadFrom), so )
( the loop-control cells sit one cell deeper than a top-level RP@ )
( would suggest -- the extra CELL+ skips I/J's own return address. )
: I      RP@ CELL+ @                           ;
: J      RP@ CELL+ CELL+ CELL+ @               ;
: RECURSE LATEST >CFA ,                        ; IMMEDIATE COMPILE-ONLY

( Batch 4 -- words with no control-flow dependency of their own. )
: OVER >R DUP R> SWAP ;
: ROT >R SWAP R> SWAP ;
: -ROT ROT ROT ;
: 2DUP OVER OVER ;
: 2DROP DROP DROP ;
: NIP SWAP DROP ;

( backslash -- rest-of-line comment, spec/04-FORTH-CORE.md section 9's )
( own "not specified here either; added only if a real need surfaces" )
( item, now specified for real in section 6.7 -- the real need was )
( this very file: the paren comment word above has independently )
( bitten M46, M48, and M68's own GRAPHICS section, each time from a )
( nested closing paren glued onto a word inside a long descriptive )
( comment, closing it early and leaking the rest of the sentence into )
( the dictionary as live code. A rest-of-line comment has no closing )
( token to glue anything onto in the first place, so it cannot suffer )
( that failure mode at all -- built entirely from WORD, already )
( native, section 6.13, looping until a line is exhausted, which WORD )
( returning a zero length already signals on its own -- no new )
( primitive needed. Carries IMMEDIATE for the same reason the paren )
( comment word does: written inside another colon-definition, it )
( must discard its text at that definition's own compile time, not )
( deferred to whenever the definition later runs. )
: \ BEGIN BL WORD NIP 0= UNTIL ; IMMEDIATE

: TUCK SWAP OVER ;
: 2SWAP ROT >R ROT R> ;
( SP@ must run first, before DEPTH pushes anything else of its own -- )
( pushing SP0 before SP@ made SP@ read the pointer with SP0's own push )
( already counted, over-stating every DEPTH result by 1. )
: DEPTH SP@ SP0 SWAP - 4 / ;
( n's own slot sits between SP@'s reading point and the item PICK )
( wants, so must be counted too -- 1+ before CELLS, or PICK reads )
( one cell too shallow: 0 PICK collides with its own argument slot, )
( self-referential garbage, and every other index is off by one. )
: PICK 1+ CELLS SP@ + @ ;
( 2OVER: same "the stack is memory" technique PICK itself uses -- )
( 3 PICK reaches the deeper of the two cells 2OVER needs to copy, )
( twice, once the first copy has shifted everything up by one. )
: 2OVER 3 PICK 3 PICK ;
: /MOD 2DUP MOD -ROT / ;
: <> = INVERT ;
( >= was missing for a while, worked around at each call site with )
( plain < 0= -- WRAP-R#'s own BLOCK-SIZE check, M55, and TS's own )
( BLOCK-SIZE guard, M57, hit the same gap independently. Adding it )
( for real now: two genuinely separate bugs from the same missing )
( word is exactly the "wait for a real need" signal CLAUDE.md asks )
( for, not premature machinery. )
: >= < 0= ;
: 0< 0 < ;
: 0> 0 > ;
: 1+ 1 + ;
: 1- 1 - ;
: 2+ 2 + ;
: 2- 2 - ;
: 2* DUP + ;
: NEGATE 0 SWAP - ;
: MIN 2DUP > IF SWAP THEN DROP ;
: MAX 2DUP < IF SWAP THEN DROP ;
: WITHIN OVER - >R - R> U< ;
: +! DUP @ ROT + SWAP ! ;
32 CONSTANT BL
: SPACE BL EMIT ;
: HEX 16 BASE ! ;
: DECIMAL 10 BASE ! ;
( WARM stays native (rebel-opcodes.json 131), same category as COLD/ )
( ABORT/EXECUTE/ACCEPT below -- it can't be safely self-hosted as an )
( ordinary colon word. DOCOL pushes a word's own return address onto )
( RSTK on entry and ; compiles a pop of that address to get back to )
( the caller; a colon-word body that resets RP to empty via RP0 RP! )
( destroys its own return address before ; ever runs, so the return )
( itself underflows. The native primitive clears both stacks as a )
( single atomic dispatch with no RSTK-based call/return of its own, )
( so it has no such return address to lose. )

( Batch 5 -- needs Batch 3/4 already loaded. )
: ?DUP DUP IF DUP THEN ;
: ABS DUP 0< IF NEGATE THEN ;
( FILL/CMOVE are deliberately NOT redefined here: they stay native, )
( rebel-opcodes.json 107/108, routed through the HAL's bulk memory )
( operations per spec 01-HAL.md section 9 and 04-FORTH-CORE.md )
( section 6.3. The reference DO/LOOP definitions in that spec still )
( fix their behavior: zero len is a no-op, and a CMOVE whose )
( destination starts inside its source propagates the pattern. )
( TYPE: classic DO/LOOP still runs its body once even when )
( index = limit at entry -- guarded so a zero-length TYPE stays a )
( true no-op, matching the native behavior this replaces exactly. )
: TYPE ( addr len -- ) DUP 0= IF 2DROP EXIT THEN OVER + SWAP DO I C@ EMIT LOOP ;
( .S: reuses the still-native . for formatting, so its output is )
( guaranteed identical by construction rather than by re-deriving )
( digit formatting a second time. Bottom-to-top, matching the )
( print order this replaces. Same zero-length DO/LOOP guard TYPE )
( needs above -- an empty stack, DEPTH zero, must skip the loop )
( entirely, or the one spurious iteration computes -1 PICK and )
( prints a garbage address instead of nothing. )
: .S DEPTH DUP 0= IF DROP EXIT THEN 0 DO DEPTH 1- I - PICK . LOOP ;

( ---------------------------------------------------------------- )

( CONTEXT/CURRENT-VOCAB declared early, on their own, purely as )
( forward references: WORDS below needs to compile calls against )
( both, and a colon-definition's own compiled reference has to )
( resolve to a real dictionary entry at compile time, not just )
( eventually. Both stay genuinely unused, holding nothing )
( meaningful, until VOCABULARY/DEFINITIONS -- far below, past SEE/ )
( HIDE/FORGET -- actually initialize and start writing to them; )
( that section has the full story of what they are and why they )
( exist. Nothing between here and there ever executes WORDS or FIND )
( for real (the native fallback tokenizer, not this self-hosted )
( FIND, still handles every line until INTERPRET itself is defined, )
( much later still), so uninitialized cells during this stretch are )
( never actually read. )
VARIABLE CONTEXT
VARIABLE CURRENT-VOCAB

( WORDS -- lists every word visible in the current search context, )
( most-recently-defined first. CORE-VOCABULARY.md section 12's own )
( worked example, ported in verbatim, with two real fixes: that doc )
( writes 1F AND, a hex literal, but BASE defaults to 10 decimal, )
( where 1F isn't a valid number at all -- 31 is 1F's decimal value, )
( same mask, NAME_LEN_MASK, same five low bits either way. And it )
( walked LATEST directly, before CONTEXT existed to separate )
( browsing from compiling. )
( Still walks LATEST directly when CONTEXT and CURRENT-VOCAB name )
( the same vocabulary -- the common case, browsing whatever you're )
( also compiling into -- since a vocabulary's own remembered cell )
( only gets refreshed when DEFINITIONS switches *away* from it, not )
( continuously as new words compile in; LATEST is the only thing )
( that's actually live while it's the active compile target. Only )
( walks CONTEXT's own stored position when browsing some *other*, )
( currently-dormant vocabulary, where that stored position is )
( correctly accurate precisely because nothing is compiling into it )
( right now. )
( Skips FLAG_HIDDEN, value 64, same guard FIND uses below -- a real )
( bug, found by Oliver: this loop used to print every name in the )
( chain unconditionally, so HIDEd plumbing words -- NUM-LEN, )
( CURRENT-SLOT, INIT-BUFFERS, and others -- still showed up here even )
( though FIND already refused to find them, giving the misleading )
( appearance that a listed word should be callable when it isn't. )
: WORDS
  CONTEXT @ CURRENT-VOCAB @ = IF LATEST ELSE CONTEXT @ @ THEN
  BEGIN
    DUP
  WHILE
    DUP 4 + C@
    DUP 64 AND 0= IF
      31 AND OVER 5 + SWAP TYPE 32 EMIT
    ELSE
      DROP
    THEN
    @
  REPEAT
  DROP
;

\ SEARCH-ROOT -- addr : the exact one-line rule WORDS above and FIND
\ below both already inline -- pulled out as its own word here (M70)
\ specifically so SEE/HIDE's own fixes, further down, can share it
\ instead of a fourth copy. WORDS/FIND themselves are left calling
\ their own existing inline copies, untouched -- they already work,
\ and duplicating one line three times over is the ordinary case this
\ project's own "three similar lines beats a premature abstraction"
\ rule is about, not a defect to clean up while fixing something else.
: SEARCH-ROOT ( -- addr )
  CONTEXT @ CURRENT-VOCAB @ = IF LATEST ELSE CONTEXT @ @ THEN
;

\ FIND relocated here from much further down in this file (M70) --
\ moved, not rewritten: SEE/HIDE's own fix (further down) needs FIND
\ already defined at their own compile time, and FIND has no real
\ dependency standing in the way of moving it this early -- just
\ CONTEXT/CURRENT-VOCAB (declared above, right before WORDS) and
\ ordinary Batch 1-4 stack/control-flow words, all long since
\ available by here. Only HIDE FIND-ADDR/HIDE FIND-LEN, which used to
\ immediately follow FIND's own definition, couldn't come along --
\ HIDE itself doesn't exist yet this early. They now run later,
\ folded into the cleanup batch right after HIDE's own definition,
\ where they belong once HIDE actually exists to call.
\
\ FIND uses two scratch variables rather than juggling addr/len on
\ the data or return stack across the whole chain-walk -- simpler to
\ get right than deep PICK arithmetic or R-stack parking, and this
\ isn't a hot path. Hidden below, once FIND itself no longer needs
\ to find them by name.
VARIABLE FIND-ADDR
VARIABLE FIND-LEN

\ FIND addr len -- entry-addr flag : chain-walk from the current
\ search context toward 0, skipping HIDDEN entries, comparing each
\ candidate's already-uppercase stored name against addr len
\ case-insensitively. entry-addr is 0 when flag is 0 -- meaningless
\ either way, per spec's own contract. The per-character comparison
\ uppercases the *input* byte only, since a stored name is already
\ uppercase -- written that way at definition time -- lowercase
\ a-z, ASCII 97-122, shift down by 32.
\ Walks CONTEXT's own target -- not the bare LATEST compile-chain
\ pointer this used before CONTEXT existed. Ordinary interpreted/
\ compiled word dispatch, INTERPRET below, always wants what's
\ currently visible while browsing, which is exactly CONTEXT's own
\ job -- not what's currently being compiled into, which stays
\ LATEST's job alone, untouched here -- compileCell/CREATE/etc.
\ still act on it directly, unrelated to this search.
\ Same LATEST-vs-stored-position check WORDS above already needs:
\ a vocabulary's own remembered cell only gets refreshed when
\ DEFINITIONS switches away from it, not continuously as new words
\ compile in, so browsing whatever you're also compiling into has
\ to read LATEST directly to see the live picture -- CONTEXT's own
\ stored position is only accurate for some other, dormant
\ vocabulary nothing is currently compiling into.
: FIND ( addr len -- entry-addr flag )
  FIND-LEN ! FIND-ADDR !
  CONTEXT @ CURRENT-VOCAB @ = IF LATEST ELSE CONTEXT @ @ THEN
  BEGIN
    DUP
  WHILE
    DUP 4 + C@
    DUP 64 AND
    IF
      DROP
    ELSE
      31 AND FIND-LEN @ =
      IF
        DUP 5 +
        -1
        FIND-LEN @ 0 DO
          OVER I + C@
          FIND-ADDR @ I + C@
          DUP 96 > OVER 123 < AND IF 32 - THEN
          =
          AND
        LOOP
        IF
          DROP -1 EXIT
        THEN
        DROP
      THEN
    THEN
    @
  REPEAT
  DROP
  0 0
;

( BANKS, M51: dev-ergonomics sibling to WORDS above, requested by )
( Oliver -- lists every active bank's name, space separated, same )
( "browse what actually exists right now" motivation as WORDS. Walks )
( MMAP's own fixed-stride slot table directly from Forth, since it's )
( just an ordinary arena-resident structure like anything else -- no )
( BANK@ MMAP needed to find it, since MMAP is always bank 0 at )
( absolute base 0, mmap.ts's own documented invariant, and unlike )
( BANK@/PROJECT -- whose name argument is a *live* input token, )
( consumed at the moment they run -- MMAP is a fixed, structural )
( fact, not something to parse, so it's a plain literal 0 below, not )
( a call. Layout mirrors mmap.ts's real constants exactly, kept in )
( sync by hand -- nothing generates these yet, a known gap, see )
( spec/00-OVERVIEW.md. Header is 36 bytes (M63: grew from 16 once )
( Personality -- PERSONALITY/SCREEN-COLS/SCREEN-ROWS -- was added )
( ahead of the slot table; M66: grew again, 28 -> 36, for )
( Personality's INK/PAPER); each of the 64 fixed slots is 24 bytes )
( -- tag 4 + name 8 + base/size/flags cells; the name field starts )
( 4 bytes into a slot, NUL-padded to 8; ACTIVE is flags bit 4, value )
( 16. A name shorter than 8 bytes only ever has *trailing* NUL )
( padding, never an embedded gap, so skipping zero bytes while still )
( emitting every nonzero one preserves order correctly -- no need )
( for LEAVE, which doesn't exist yet anyway, see spec/04-FORTH-CORE.md )
( section 9. )
36 CONSTANT MMAP-HDR
24 CONSTANT MMAP-SLOT
4  CONSTANT MMAP-NAME
8  CONSTANT MMAP-NAME-LEN
20 CONSTANT MMAP-FLAGS
16 CONSTANT MMAP-ACTIVE
64 CONSTANT MMAP-SLOTS

: BANKS
  MMAP-SLOTS 0 DO
    I MMAP-SLOT * MMAP-HDR +
    DUP MMAP-FLAGS + @ MMAP-ACTIVE AND IF
      DUP MMAP-NAME +
      MMAP-NAME-LEN 0 DO
        DUP I + C@ DUP IF EMIT ELSE DROP THEN
      LOOP
      DROP BL EMIT
    THEN
    DROP
  LOOP
;

( BANK-FIND, M73, spec 04-FORTH-CORE.md section 6.14: the name-on- )
( the-stack bank lookup, BOOTSTRAP -- the same MMAP slot walk BANKS )
( makes, comparing each active slot's NUL-padded name field with the )
( given name folded to upper case. Returns the slot's address, which )
( holds tag +0, name +4, base +12, size +16, flags +20; 0 if no )
( active bank has that name, or the name is empty or longer than 8. )
( No slot sits at address 0, MMAP's header does, so 0 means none. )
( BF-ADDR/BF-LEN carry the name through the loop instead of the data )
( stack, the same scratch-variable convention LOAD-BLK uses. )
( UPCHAR folds one character a-z to upper case. NAME8= compares an )
( 8-byte NUL-padded name field with addr len folded to upper case -- )
( shared with the environments' ESCR slot names, M77, so both are )
( left visible. )
VARIABLE BF-ADDR
VARIABLE BF-LEN
VARIABLE N8-ADDR
VARIABLE N8-LEN
: UPCHAR ( c -- c' ) DUP 97 123 WITHIN IF 32 - THEN ;
: NAME8= ( field addr len -- flag )
  N8-LEN ! N8-ADDR !
  -1 SWAP
  MMAP-NAME-LEN 0 DO
    DUP I + C@
    I N8-LEN @ < IF N8-ADDR @ I + C@ UPCHAR ELSE 0 THEN
    <> IF NIP 0 SWAP THEN
  LOOP
  DROP ;
: (BANK-FIND) ( addr len -- slot | 0 )
  DUP 1 MMAP-NAME-LEN 1+ WITHIN 0= IF 2DROP 0 EXIT THEN
  BF-LEN ! BF-ADDR !
  0
  MMAP-SLOTS 0 DO
    I MMAP-SLOT * MMAP-HDR +
    DUP MMAP-FLAGS + @ MMAP-ACTIVE AND IF
      DUP MMAP-NAME + BF-ADDR @ BF-LEN @ NAME8= IF NIP ELSE DROP THEN
    ELSE
      DROP
    THEN
  LOOP ;

( BANK-REMOVE, M74, spec 02-MEMORY-MODEL.md section 4.9 and )
( 04-FORTH-CORE.md section 6.14: marks a bank for removal by setting )
( REMOVED, flags bit 5, in its slot. Nothing changes this session -- )
( the bank stays resident, findable and its name taken -- but SAVE )
( no longer writes it and the next project load does not bring it )
( back. Clearing the bit by hand undoes it. MMAP itself, always the )
( slot at MMAP-HDR, and an EXTERNAL bank, flags bit 1, are refused. )
( The non-parsing form returns a flag, the parsing form ABORTs with )
( the bad name printed first, the same convention tick follows. )
32 CONSTANT MMAP-REMOVED
2  CONSTANT MMAP-EXTERNAL
: (BANK-REMOVE) ( addr len -- flag )
  (BANK-FIND) DUP 0= IF EXIT THEN
  DUP MMAP-HDR = IF DROP 0 EXIT THEN
  MMAP-FLAGS +
  DUP @ MMAP-EXTERNAL AND IF DROP 0 EXIT THEN
  DUP @ MMAP-REMOVED OR SWAP !
  -1 ;
: BANK-REMOVE ( "name" -- )
  BL WORD 2DUP (BANK-REMOVE)
  IF 2DROP ELSE TYPE SPACE ABORT THEN ;

( PALETTE-BASE, M62 follow-up, Oliver's request: direct read/write )
( access to the indexed-color-palette sysvar, spec/01-HAL.md 3.6, )
( spec/02-MEMORY-MODEL.md 4.6 -- PALETTE-BASE @ reads it, addr )
( PALETTE-BASE ! writes it, e.g. BANK@ PAL PALETTE-BASE ! enables )
( the default palette. No native primitive needed for this, unlike )
( BASE/STATE/HERE-ADDR/LATEST-ADDR -- those exist natively because )
( something has to bootstrap the very mechanism, self-hosted )
( INTERPRET, VARIABLE/CONSTANT, and so on -- this word is just an )
( ordinary *user* of: BANK@'s own note already describes exactly )
( this pattern, BANK@ SYSV offset + @ reaches any sysvar from pure )
( Forth source. BANK@ is IMMEDIATE, so SYSV's address bakes in here )
( as a plain LIT, same as BANKS' own MMAP-HDR-style constants -- the )
( +100 is SCREEN's sysvarGroups baseOffset 64 plus PALETTE-BASE's )
( own field offset 36, kept in sync by hand with rebel-opcodes.json )
( -- nothing generates these yet, see spec/00-OVERVIEW.md. )
: PALETTE-BASE BANK@ SYSV 100 + ;

( PALETTE, M62 follow-up 2, Oliver's request: n PALETTE selects PAL's )
( n'th map as the active palette in one word, instead of writing out )
( the n 64 * BANK@ PAL + PALETTE-BASE ! arithmetic by hand each time. )
( 0 PALETTE selects the default map -- no special-casing needed, map )
( 0 already sits at PAL's own base address. Disabling the palette )
( entirely needs no word here either -- 0 PALETTE-BASE ! already )
( does that directly, PALETTE-BASE's own 0-means-disabled convention, )
( so PALETTE only ever has to handle picking a real map. No bounds )
( check on n, same trust-the-caller convention AT-XY already uses -- )
( an out-of-range n lands somewhere else inside PAL's own allocated )
( bank, not memory-unsafe, just a meaningless palette until corrected. )
: PALETTE ( n -- ) 64 * BANK@ PAL + PALETTE-BASE ! ;

( DUMP, M51: a classic hex dump, requested alongside BANKS -- 16 rows )
( of 8 bytes each, 128 bytes total starting at the given address. Row )
( shape: an 8-digit hex address, 8 space-separated 2-digit hex bytes, )
( then those same 8 bytes again as characters, with anything below BL )
( -- a non-printable control code -- shown as a dot instead. Deliberately )
( fixed-size, no length argument -- classic Forth DUMP takes one, but )
( nothing here needs a variable-length dump yet, and one screenful is )
( plenty for now. No bounds checking against the arena's real extent, )
( same trust-the-caller precedent raw @/C@ and BANK@ already have. )
( Leads with a CR, found by Oliver: without it the first row starts )
( mid-line, right after whatever was already on the current line -- )
( DUMP itself included, since it echoes back before running -- so )
( every row but the first looked misaligned against it. )

( DUMP-NEXT, M61 -- Oliver's idea: an address-less DUMP continues )
( right where the last one left off, monitor-style paging -- plain )
( DUMP alone shows the next 128 bytes, no need to track/retype an )
( address by hand. An ordinary visible VARIABLE, not hidden internal )
( plumbing like HEX8's own scratch words -- poking it directly to )
( jump elsewhere works exactly as well as giving DUMP an explicit )
( address does, both update it the same way. Detects "no address )
( given" via DEPTH rather than a sentinel value, since any real cell )
( value is a legitimate address to dump -- a real limitation, not )
( just a theoretical one: called from inside another word with an )
( unrelated value already on the stack, DEPTH can't tell that value )
( apart from a deliberately-supplied address. Fine for what DUMP )
( actually is -- an interactive top-level inspection word, always )
( typed directly, never a building block other definitions call. )
VARIABLE DUMP-NEXT
0 DUMP-NEXT !

( HEXDIGIT n -- : prints one hex digit for 0..15. )
: HEXDIGIT DUP 10 < IF 48 + ELSE 10 - 65 + THEN EMIT ;

( HEX2 byte -- : prints a byte as two hex digits, high nibble first. )
: HEX2 DUP 16 / HEXDIGIT 16 MOD HEXDIGIT ;

( HEX8 n -- : prints a cell as eight hex digits, most significant )
( first. Extracts nibbles low to high via repeated 16 MOD / 16 / and )
( leaves them stacked lowest-first, so popping straight back off with )
( HEXDIGIT after dropping the always-zero ninth remainder naturally )
( prints most-significant-first -- no separate reversal step needed. )
: HEX8
  8 0 DO DUP 16 MOD SWAP 16 / LOOP
  DROP
  HEXDIGIT HEXDIGIT HEXDIGIT HEXDIGIT
  HEXDIGIT HEXDIGIT HEXDIGIT HEXDIGIT
;

: DUMP ( addr | -- )
  DEPTH 0= IF DUMP-NEXT @ THEN
  DUP 128 + DUMP-NEXT !
  CR
  16 0 DO
    DUP I 8 * +
    DUP HEX8 BL EMIT
    8 0 DO DUP I + C@ HEX2 BL EMIT LOOP
    8 0 DO
      DUP I + C@
      DUP BL < IF DROP 46 THEN
      EMIT
    LOOP
    DROP CR
  LOOP
  DROP
;

( SEE support, DEVELOPING.md section 3: decompiling a definition. )
( CORE-VOCABULARY.md section 12 itself flagged SEE as the natural )
( next step once WORDS proved the chain-walk mechanics work -- )
( that precondition was met back in M8. >CFA -- moved up into the )
( bootstrap block above (M42), since RECURSE needs it too -- and )
( XT-NAME/the -XT constants below are pure internal plumbing for SEE, )
( HIDden further down, once nothing later still needs to find them )
( by name during its own compilation (SEE itself does, right up )
( until its own closing semicolon, so hiding has to wait until )
( after that, not happen inline right after each one). )

( XT-NAME xt -- : reverse of what WORDS does -- given a code )
( field address, print the dictionary entry whose own >CFA )
( matches it. Prints a bare question mark for an xt with no )
( matching entry, though that should not arise in practice -- )
( every xt SEE ever passes in came from a real compiled call. )
\ Walks from SEARCH-ROOT (M70), not raw LATEST as this used to --
\ LATEST alone only ever sees whatever's currently CURRENT-VOCAB, so
\ decompiling a word that calls into some other, merely-browsed
\ vocabulary's own helper used to print a bare "?" for it instead of
\ its real name.
: XT-NAME >R SEARCH-ROOT BEGIN DUP WHILE DUP >CFA R@ = IF DUP 4 + C@ 31 AND OVER 5 + SWAP TYPE DROP R> DROP EXIT THEN @ REPEAT DROP R> DROP 63 EMIT ;

( Named constants for the inline-data tokens SEE must special )
( case while walking a Parameter Field -- LIT's literal, )
( BRANCH and 0BRANCH's jump target, and SLIT's inline string )
( all store raw data immediately after the call cell itself, )
( not a further call to decompile. )
' LIT CONSTANT LIT-XT
' EXIT CONSTANT EXIT-XT
' BRANCH CONSTANT BRANCH-XT
' 0BRANCH CONSTANT 0BRANCH-XT
' (SLIT) CONSTANT SLIT-XT

\ (TICK) "name" -- xt : SEE/HIDE's own context-aware replacement for
\ native ' (token 94, M6), used only by the two of them (M70). Native
\ ' resolves via the engine's own findWord(), which walks the raw
\ LATEST sysvar directly -- it predates VOCABULARY entirely and was
\ never taught about CONTEXT once vocabularies could branch, so it
\ silently misses any word in a vocabulary that's merely being
\ browsed (USE) rather than currently compiled into (DEFINITIONS).
\ FIND (above, M70: moved here specifically so this could reuse it)
\ already gets this right; (TICK) is just FIND plus >CFA, with the
\ same "print the bad token, then ABORT" error convention NUMBER's
\ own fallback already uses below, rather than trying to reproduce
\ native tick's own distinct "unrecognized word: NAME" wording.
: (TICK) ( "name" -- xt )
  BL WORD 2DUP FIND
  IF
    NIP NIP >CFA
  ELSE
    DROP TYPE SPACE ABORT
  THEN
;

( SEE -- SEE <name>: decompiles a colon-definition back to )
( source-ish form. Only DOCOL-coded words are supported for )
( this pass -- CONSTANT/VARIABLE/DOES>'d words print )
( "not supported" rather than guessing wrong. BRANCH/0BRANCH )
( targets print as a bare placeholder rather than reconstructing )
( IF/THEN structure -- a real decompile, not a polished one, )
( same "minimum real mechanism first" discipline as everywhere )
( else in this project. )
: SEE
  (TICK)
  DUP @ 0=
  IF
    ." :" 32 EMIT DUP XT-NAME 32 EMIT
    4 +
    BEGIN
      DUP @ EXIT-XT <>
    WHILE
      DUP @ DUP LIT-XT =
      IF
        DROP 4 + DUP @ . 4 +
      ELSE
        DUP SLIT-XT =
        IF
          DROP 4 + DUP @ 34 EMIT OVER 4 + SWAP TYPE 34 EMIT
          32 EMIT DUP @ 4 + + 3 + -4 AND
        ELSE
          DUP BRANCH-XT = OVER 0BRANCH-XT = OR
          IF
            DROP ." <branch>" 32 EMIT 4 + 4 +
          ELSE
            XT-NAME 32 EMIT 4 +
          THEN
        THEN
      THEN
    REPEAT
    DROP ." ;"
  ELSE
    DROP ." (not supported)"
  THEN
;

( HIDE name -- marks an already-defined word hidden, using exactly )
( the FLAG_HIDDEN bit, value 64, that findWord/WORDS already skip )
( over for a colon-definition mid-compilation -- reused here for )
( the same invisible-to-lookup-and-listing effect after the fact. )
( Pure Forth, no engine change -- the same reverse chain-walk )
( XT-NAME already does, given an xt, find the entry whose own )
( >CFA matches it, just setting a flag instead of printing a name. )
( Already-compiled callers are unaffected by hiding a word they )
( call -- compiled calls are raw addresses, not names to )
( re-resolve -- only future name lookup and WORDS listings change, )
( which is exactly why this has to run after SEE, not inline right )
( after each helper: SEE itself still needs to find XT-NAME and )
( the -XT constants by name, right up until its own closing )
( semicolon. )
\ Both ' and LATEST below were the raw-LATEST-rooted native/inline
\ forms this used before M70 -- neither saw a merely-browsed (USE,
\ not DEFINITIONS) vocabulary's own words at all, so HIDEing one threw
\ "unrecognized word" for the initial lookup, and even resolving the
\ xt some other way still would not have found its entry from here,
\ since this walk started from LATEST too. (TICK)/SEARCH-ROOT fix
\ both halves the same way FIND/XT-NAME's own fixes just did, above.
: HIDE
  (TICK)
  >R
  SEARCH-ROOT
  BEGIN
    DUP
  WHILE
    DUP >CFA R@ =
    IF
      4 + DUP C@ 64 OR SWAP C!
      R> DROP
      EXIT
    THEN
    @
  REPEAT
  DROP R> DROP
;

( FORGET name -- removes a word and everything defined after it, )
( reclaiming its DICT space. DEVELOPING.md section 8.6: the piece )
( VOCABULARY/USE's own exploration left as a dropped/open item -- )
( HERE/LATEST were read-only from Forth, the same gap LATEST-ADDR )
( fixed for LATEST specifically; HERE-ADDR, primitive 125, fixes )
( the other half FORGET actually needs. Reuses the exact reverse )
( chain-walk HIDE already does -- find the entry whose own >CFA )
( matches the target xt -- only the found-branch differs: instead )
( of setting FLAG_HIDDEN, LATEST is rolled back to the found )
( entry's own link, the word defined right before it, and HERE is )
( rolled back to the found entry's own address, exactly what )
( dictionary.ts's abortDefinition already does for a half-built )
( definition on a compile error, just reachable here for any named )
( word instead of only the current LATEST. Defined here, before )
( the HIDE >CFA block below, so it can still call >CFA by name -- )
( same sequencing constraint SEE itself has. )
( Known, deliberately unaddressed limitation, matching the open )
( question already on record: forgetting a word another )
( vocabulary's own branch point depends on leaves that )
( vocabulary's chain corrupted -- not designed, since neither )
( feature needs it yet in practice. )
: FORGET
  '
  >R
  LATEST
  BEGIN
    DUP
  WHILE
    DUP >CFA R@ =
    IF
      DUP @ LATEST-ADDR !
      HERE-ADDR !
      R> DROP
      EXIT
    THEN
    @
  REPEAT
  DROP R> DROP
;

( A VOCABULARY-based split was considered instead of HIDE and )
( rejected: branching chains only let a *later* vocabulary see an )
( *earlier* one, never the reverse, and visibility/WORDS-listing )
( are the same underlying chain-walk -- there's no way to make )
( something callable-but-unlisted with vocabularies alone. HIDE is )
( the actual right-sized tool for this specific job -- VOCABULARY )
( and USE stay reserved for their own real use case, project and )
( cart isolation, once that's a concrete need, not this one. )
( >CFA deliberately NOT hidden here (M43, unlike XT-NAME/the -XT )
( constants below, which really are SEE-only plumbing): INTERPRET, )
( defined further down, needs to look it up by name on every single )
( token it dispatches, not just once at some other word's own )
( compile time the way RECURSE's compiled reference to it does. )
HIDE XT-NAME
HIDE LIT-XT
HIDE EXIT-XT
HIDE BRANCH-XT
HIDE 0BRANCH-XT
HIDE SLIT-XT
HIDE (TICK)
\ BF-ADDR/BF-LEN and NAME8='s N8-ADDR/N8-LEN are (BANK-FIND)'s plumbing, M73,
\ hidden here because HIDE does not exist yet where they are defined.
HIDE BF-ADDR
HIDE BF-LEN
HIDE N8-ADDR
HIDE N8-LEN
\ SEARCH-ROOT/FIND-ADDR/FIND-LEN (M70) join the same cleanup batch --
\ SEARCH-ROOT is plumbing FIND/XT-NAME/HIDE's own bodies already
\ compiled a direct call to by now, same "hiding never disturbs an
\ already-compiled caller" rule this whole batch already relies on.
\ FIND-ADDR/FIND-LEN moved here from right after FIND's own old
\ location, since HIDE -- needed to hide them at all -- did not exist
\ yet back there.
HIDE SEARCH-ROOT
HIDE FIND-ADDR
HIDE FIND-LEN

( VOCABULARY/USE/DEFINITIONS, DEVELOPING.md section 8, revised for )
( the real classic CONTEXT/CURRENT split. Browsing a vocabulary )
( search-wise must never redirect where new words actually compile )
( to, or a screen LOADed while merely looking around in EDITOR )
( would land its own new words inside EDITOR instead of plain )
( FORTH -- the original single-pointer USE this replaces did )
( exactly that, found the hard way once the Screen Editor's own )
( vocabulary existed to expose it. Branching dictionary chains )
( still, not independent chains plus a search order -- each )
( vocabulary remembers its own LATEST position, starting as a )
( continuation of whatever chain was current, not empty, so )
( switching into one never loses access to words that already )
( existed before the branch point. )

( CONTEXT is which vocabulary FIND and WORDS search -- browsing, )
( changed freely, any time, with no side effect on anything else. )
( CURRENT-VOCAB is which vocabulary new definitions actually )
( extend -- compiling, changed only by DEFINITIONS, deliberately. )
( Both declared far above, near WORDS, purely as forward )
( references -- this is where they actually start being used for )
( real. Both are ordinary VARIABLEs holding the address of a )
( vocabulary's own remembered-position cell, not a snapshotted )
( value, so a later definition added to whichever vocabulary either )
( currently names is visible immediately, via FIND/WORDS' own )
( LATEST-vs-stored-position check just above -- not through this )
( indirection alone. )

( VOCABULARY name -- creates a new vocabulary. Its own CREATEd cell )
( captures the CURRENT chain position at creation time, not zero -- )
( LATEST must run before CREATE, since CREATE itself becomes the )
( new LATEST the instant it links its own header in, so capturing )
( the old value has to happen first. DOES> gives every vocabulary a )
( real runtime action now, not just a bare CREATEd value: naming a )
( vocabulary switches CONTEXT to it directly -- the actual classic )
( idiom, and what makes DEFINITIONS below able to just read CONTEXT )
( rather than needing its own separate name-parsing step. )
: VOCABULARY LATEST CREATE , DOES> CONTEXT ! ;

( Everything defined above this point becomes the root vocabulary. )
( Naming FORTH sets CONTEXT via its own new DOES> action just )
( described; CURRENT-VOCAB is set to match by hand here, once, )
( since nothing earlier has established it yet the way a later )
( DEFINITIONS call normally would. )
VOCABULARY FORTH
FORTH
CONTEXT @ CURRENT-VOCAB !

( DEFINITIONS -- : promotes whatever CONTEXT currently names to )
( also be the compile target -- saves the outgoing compile chain's )
( current position back into its own remembered cell, then loads )
( the target's remembered position into LATEST itself. The classic )
( two-step idiom in full: EDITOR DEFINITIONS means "look here, and )
( start compiling here too," as two separate, explicit actions )
( rather than one combined one. )
: DEFINITIONS
  CONTEXT @
  LATEST CURRENT-VOCAB @ !
  DUP @ LATEST-ADDR !
  CURRENT-VOCAB !
;

( USE name -- kept as a synonym for the classic bare-name idiom, )
( since every existing caller already spells it this way: parses )
( the next token and EXECUTEs it, which for a vocabulary word runs )
( VOCABULARY's own DOES> action above, setting CONTEXT. Browsing )
( only -- USE alone never touches CURRENT-VOCAB or LATEST, unlike )
( the single combined pointer this replaces; pair it with )
( DEFINITIONS when compiling into the target is actually wanted. )
: USE ' EXECUTE ;

( ---------------------------------------------------------------- )
( BLOCK/BUFFER/UPDATE/FLUSH -- FORTH-ARCHITECTURE.md section 7, the )
( portable half of the classic Forth block-buffer mechanism. The )
( native primitives BLOCK-READ and BLOCK-WRITE, tokens 140/141, are )
( the only native pieces -- they move exactly 1024 bytes between the )
( resident BLKS bank and RAM, bounds-checked, no caching. Everything )
( below is identical Forth source any target shares: a small fixed )
( 4-slot buffer pool, round-robin eviction -- the oldest-assigned )
( slot is always the next victim, not a true recency-tracked LRU -- )
( sized for a real multi-block word like the reference editor's COPY )
( per the spec note, without needing a more elaborate cache -- and )
( one dirty flag per slot. )

( No LEAVE/UNLOOP exists yet, per spec/04-FORTH-CORE.md section 9's )
( own explicitly-cut-for-now list -- EXIT from inside a DO loop would )
( corrupt control flow, since nothing pops the loop-control cells a )
( DO left behind and I/J's own CELL+ offset trick only works because )
( of that. So every loop below runs a full, unconditional scan and )
( accumulates its answer in a scratch variable instead of exiting )
( early -- the same no-shortcuts-DO/LOOP-cant-safely-take discipline, )
( not an oversight. )

4 CONSTANT #BUFFERS
1024 CONSTANT BLOCK-SIZE

( Parallel arrays, one entry per buffer slot. BUF-BLOCK# holds the )
( block number resident in that slot, -1 meaning empty or unused -- a )
( safe sentinel since real block numbers are never negative. )
( BUF-DIRTY is a HAL-convention flag, TRUE is -1, FALSE is 0. )
( BUF-DATA is the actual BLOCK-SIZE-byte backing RAM for every slot, )
( back to back. )
CREATE BUF-BLOCK# #BUFFERS CELLS ALLOT
CREATE BUF-DIRTY  #BUFFERS CELLS ALLOT
CREATE BUF-DATA   #BUFFERS BLOCK-SIZE * ALLOT

( NEXT-SLOT is the round-robin eviction pointer. CURRENT-SLOT is the )
( slot most recently returned by BLOCK/BUFFER -- what UPDATE marks )
( dirty. REQ-BLOCK#, SCAN-RESULT, and SLOT# are scratch variables )
( threading a value through a word instead of deep stack juggling -- )
( the same convention FIND-ADDR/FIND-LEN and NUM-ADDR/NUM-LEN already )
( established. )
VARIABLE NEXT-SLOT
VARIABLE CURRENT-SLOT
VARIABLE REQ-BLOCK#
VARIABLE SCAN-RESULT
VARIABLE SLOT#

( Every slot starts empty and clean -- BUF-BLOCK#'s bytes would )
( otherwise default to 0, since a fresh DICT bank reads as all-zero, )
( which would misread as "slot already holds block 0" the moment )
( anything asked for block 0, before a single native block read ever )
( ran. DO/LOOP are compile-only -- section 6.5's control-flow words )
( only work inside a colon-definition -- so this one-shot setup runs )
( as a tiny word called immediately, not bare top-level code. )
: INIT-BUFFERS
  #BUFFERS 0 DO
    -1 I CELLS BUF-BLOCK# + !
     0 I CELLS BUF-DIRTY  + !
  LOOP
  0 NEXT-SLOT !
  -1 CURRENT-SLOT !
;
INIT-BUFFERS

: BUF-ADDR ( slot -- addr ) BLOCK-SIZE * BUF-DATA + ;

( FIND-BUFFER, given a block number, reports which slot if any )
( already holds it. A full unconditional scan, per the no-EXIT-in- )
( DO-LOOP note above -- at most one slot can ever match, since a )
( block number is only ever resident in one slot at a time, so scan )
( order doesn't matter. Reports slot -1 and flag false on a miss. )
: FIND-BUFFER ( n -- slot flag )
  -1 SCAN-RESULT !
  #BUFFERS 0 DO
    DUP I CELLS BUF-BLOCK# + @ = IF I SCAN-RESULT ! THEN
  LOOP
  DROP
  SCAN-RESULT @ DUP -1 <>
;

( EVICT-SLOT makes a slot ready for reuse -- writes its content back )
( via a native block write first if dirty, then clears dirty. A )
( no-op on an empty or already-clean slot. Also FLUSH's own per-slot )
( step, called directly on every slot rather than duplicating the )
( dirty-check-and-write-back logic a second time. )
: EVICT-SLOT ( slot -- )
  SLOT# !
  SLOT# @ CELLS BUF-DIRTY + @
  IF
    SLOT# @ BUF-ADDR SLOT# @ CELLS BUF-BLOCK# + @ (BLOCK-WRITE)
    0 SLOT# @ CELLS BUF-DIRTY + !
  THEN
;

( LOAD-SLOT claims a slot for a given block number, evicting whatever )
( it held first, then reads that block's real content into it via a )
( native block read -- the BLOCK word's own miss path. )
: LOAD-SLOT ( n slot -- addr )
  DUP EVICT-SLOT
  SLOT# !
  DUP SLOT# @ CELLS BUF-BLOCK# + !
  0 SLOT# @ CELLS BUF-DIRTY + !
  SLOT# @ BUF-ADDR SWAP (BLOCK-READ)
  SLOT# @ BUF-ADDR
;

( CLAIM-SLOT is the same as LOAD-SLOT but skips the read -- BUFFER's )
( own miss path, for a block about to be fully overwritten, where )
( reading its old content first would be wasted work. Matches )
( classic fig-FORTH's own BUFFER/BLOCK split. )
: CLAIM-SLOT ( n slot -- addr )
  DUP EVICT-SLOT
  SLOT# !
  SLOT# @ CELLS BUF-BLOCK# + !
  0 SLOT# @ CELLS BUF-DIRTY + !
  SLOT# @ BUF-ADDR
;

( PICK-SLOT reports the next eviction victim, round-robin -- returns )
( the current pointer and advances it, wrapping mod #BUFFERS. Only )
( ever called on a miss, since FIND-BUFFER already found nothing, so )
( which slot it names doesn't matter beyond it not being one )
( something else is still using. )
: PICK-SLOT ( -- slot )
  NEXT-SLOT @
  DUP 1+ #BUFFERS MOD NEXT-SLOT !
;

( BLOCK is the classic word. A hit returns the existing slot's )
( address with no I/O at all; a miss picks a victim slot and loads )
( the real content into it. Either way, remembers the slot in )
( CURRENT-SLOT so a following UPDATE knows what to mark dirty. )
: BLOCK ( n -- addr )
  REQ-BLOCK# !
  REQ-BLOCK# @ FIND-BUFFER
  IF
    DUP CURRENT-SLOT ! BUF-ADDR
  ELSE
    DROP
    PICK-SLOT DUP CURRENT-SLOT !
    REQ-BLOCK# @ SWAP LOAD-SLOT
  THEN
;

( BUFFER is BLOCK's counterpart for a block about to be fully )
( overwritten -- a hit still returns the existing, already correct, )
( content, but a miss claims a slot without reading, since every )
( byte is about to be replaced anyway. )
: BUFFER ( n -- addr )
  REQ-BLOCK# !
  REQ-BLOCK# @ FIND-BUFFER
  IF
    DUP CURRENT-SLOT ! BUF-ADDR
  ELSE
    DROP
    PICK-SLOT DUP CURRENT-SLOT !
    REQ-BLOCK# @ SWAP CLAIM-SLOT
  THEN
;

( UPDATE marks the buffer BLOCK/BUFFER most recently returned dirty, )
( so FLUSH or a later eviction writes it back instead of silently )
( dropping the change. Behavior is undefined, not guarded, if called )
( before BLOCK/BUFFER ever ran once -- the same caller's- )
( responsibility footgun PAD's own reentrancy contract already )
( documents. )
: UPDATE ( -- ) -1 CURRENT-SLOT @ CELLS BUF-DIRTY + ! ;

( FLUSH writes every dirty slot back via a native block write and )
( clears its dirty flag -- EVICT-SLOT's own logic, run unconditionally )
( across all #BUFFERS slots rather than duplicated here. Does not )
( itself touch disk -- SAVE and BANK-SAVE, built in M5/M33, )
( persist the whole BLKS bank separately, at project-save time. )
: FLUSH ( -- ) #BUFFERS 0 DO I EVICT-SLOT LOOP ;

( Everything above BLOCK/BUFFER/UPDATE/FLUSH themselves is internal )
( plumbing -- hidden the same way FIND-ADDR/FIND-LEN and NUM-ADDR/ )
( NUM-LEN/NUM-ABORT already are, now that nothing later needs any of )
( it by name: FLUSH just above is the last consumer of EVICT-SLOT, )
( and BLOCK/BUFFER are the last consumers of everything else. Hiding )
( doesn't affect BLOCK/BUFFER/UPDATE/FLUSH's own already-compiled )
( calls into them -- only future name lookup and WORDS listings. )
HIDE INIT-BUFFERS
HIDE BUF-BLOCK#
HIDE BUF-DIRTY
HIDE BUF-DATA
HIDE NEXT-SLOT
HIDE CURRENT-SLOT
HIDE REQ-BLOCK#
HIDE SCAN-RESULT
HIDE SLOT#
HIDE BUF-ADDR
HIDE FIND-BUFFER
HIDE EVICT-SLOT
HIDE LOAD-SLOT
HIDE CLAIM-SLOT
HIDE PICK-SLOT

( ---------------------------------------------------------------- )
( spec/04-FORTH-CORE.md section 6.13 (M43): the self-hosted outer )
( interpreter itself. WORD/STATE/:/;/IMMEDIATE/COMPILE-ONLY are all )
( native primitives now -- repl.ts, primitives.ts -- FIND, NUMBER, )
( the two mode-switch words, and INTERPRET are Forth source, built )
( from them plus everything above. INTERPRET MUST load last of all -- )
( it is the first point where the driving loop can switch from the )
( native fallback tokenizer to this real self-hosted one. )

\ FIND itself now lives much further up this file (M70, right after
\ WORDS) -- SEE/HIDE's own fix needed it defined at their own compile
\ time, well before this point, and it had no real dependency standing
\ in the way of moving it there. Nothing here calls it any differently
\ for that -- INTERPRET, below, finds it by name exactly as before.

( NUMBER's own error path echoes the token that failed to parse -- the )
( classic fig-Forth/Forth-79 "TOKEN ?" convention -- neither had THROW )
( or CATCH, that's an ANS Forth invention; ABORT plus printing the bad )
( token was the whole error-reporting mechanism. Composes for free )
( with reportError's own generic "? ABORT" tail in repl.ts to reproduce )
( that output cheaply: TYPE the original token, a space, then ABORT -- )
( no message-carrying THROW needed. Scratch variables hold the )
( original addr len since NUMBER's own sign-stripping has already )
( changed them by the time a validation guard can fail. )
VARIABLE NUM-ADDR
VARIABLE NUM-LEN

: NUM-ABORT ( -- )
  NUM-ADDR @ NUM-LEN @ TYPE SPACE ABORT
;

( NUMBER addr len -- n : converts addr len to a signed cell in the )
( current BASE. Validates every character against '0'-'9'/'A'-'Z', )
( after the same uppercase-fold FIND uses, and against the current )
( BASE, and rejects a lone '-' with no digits at all -- all three )
( call NUM-ABORT rather than silently accepting a typo as some )
( number. See 04-FORTH-CORE.md section 6.13's revised reference )
( definition. )
: NUMBER ( addr len -- n )
  2DUP NUM-LEN ! NUM-ADDR !
  DUP 0= IF 2DROP 0 EXIT THEN
  OVER C@ 45 = >R
  R@ IF 1 - SWAP 1 + SWAP THEN
  DUP 0= IF NUM-ABORT THEN
  0 -ROT
  OVER + SWAP
  DO
    I C@
    DUP 96 > OVER 123 < AND IF 32 - THEN
    DUP 48 58 WITHIN OVER 65 91 WITHIN OR 0= IF NUM-ABORT THEN
    DUP 57 > IF 55 - ELSE 48 - THEN
    DUP BASE @ < INVERT IF NUM-ABORT THEN
    SWAP BASE @ * +
  LOOP
  R> IF NEGATE THEN
;
HIDE NUM-ADDR
HIDE NUM-LEN
HIDE NUM-ABORT

( LIT's own xt, resolved once here rather than by INTERPRET calling )
( ' at every compile step -- the same pattern section 6.5's )
( control-flow block already established for BRANCH-XT/etc. )
' LIT CONSTANT LIT-XT

( [ / ] : the ordinary mode-switch words. [ must be IMMEDIATE so it )
( takes effect while compiling; the literal STATE values match )
( 03-SYSVARS.md's encoding, already used throughout this engine: )
( 0 = interpreting, -1 = compiling. )
: [ 0 STATE ! ; IMMEDIATE
: ] -1 STATE ! ;

( INTERPRET -- : tokenizes and dispatches one line, per )
( spec/04-FORTH-CORE.md section 5.1-5.4's contract exactly. A found )
( word EXECUTEs -- interpreting, unless COMPILE-ONLY -- ABORT -- or, )
( while compiling, EXECUTEs if IMMEDIATE else compiles a call via )
( comma. A token that isn't a defined word falls through to NUMBER; )
( the result is pushed while interpreting or compiled as LIT plus )
( its literal cell while compiling. )
: INTERPRET ( -- )
  BEGIN
    BL WORD
    DUP
  WHILE
    2DUP FIND
    IF
      NIP NIP
      DUP >CFA
      STATE @
      IF
        OVER 4 + C@ 128 AND
        IF NIP EXECUTE ELSE NIP , THEN
      ELSE
        OVER 4 + C@ 32 AND
        IF ABORT ELSE NIP EXECUTE THEN
      THEN
    ELSE
      DROP
      NUMBER
      STATE @
      IF
        LIT-XT , ,
      THEN
    THEN
  REPEAT
  2DROP
;

( ---------------------------------------------------------------- )
( EMPTY -- FORTH-ARCHITECTURE.md section 7 follow-up, spec'd ahead )
( of the Screen Editor work: resets the dictionary chain back to )
( exactly the state COLD produces -- the full system.fth vocabulary, )
( nothing user-defined -- without COLD's own full machine rebuild )
( (fresh arena, cleared stacks, a fresh REPL session). Editing and )
( reloading screen source repeatedly is expected to want a clean )
( vocabulary far more often than a genuinely fresh machine. )

( Placed after INTERPRET on purpose, not before: "the state COLD )
( produces" means the complete post-boot vocabulary, and INTERPRET )
( is the last word system.fth previously defined. Appending here )
( doesn't conflict with INTERPRET's own "must load last of all" )
( requirement -- that rule is about nothing being able to call )
( INTERPRET before it exists, not about nothing being definable )
( after it. From this point on, dispatchLine's switchover already )
( means every following line -- these included -- loads through the )
( real self-hosted INTERPRET, not the native fallback, exactly like )
( any ordinary REPL line after boot. )

( BOOT-LATEST/BOOT-HERE capture LATEST/HERE once, right after EMPTY )
( itself is fully defined -- not as CONSTANTs baked in at the point )
( they're declared, which would be too early: LATEST/HERE keep )
( growing while BOOT-LATEST, BOOT-HERE, and EMPTY are themselves )
( still being defined. Reading them fresh from VARIABLEs, then )
( capturing the real values only after EMPTY's closing semicolon, )
( makes EMPTY's own reset point include EMPTY itself -- so calling )
( EMPTY never forgets EMPTY, and it stays callable repeatedly. )
VARIABLE BOOT-LATEST
VARIABLE BOOT-HERE

( EMPTY -- : same LATEST-ADDR/HERE-ADDR write-back FORGET already )
( uses (DEVELOPING.md section 8.6), just to a fixed captured point )
( instead of a chain-walk to a named word -- reclaims every byte of )
( DICT space anything defined after the boot marker used, the same )
( way FORGETting the very first post-boot word would, without )
( needing to know that word's name. )

( Also forces both CURRENT-VOCAB and CONTEXT back to FORTH's own )
( cell -- not just LATEST/HERE. Found the hard way, before CONTEXT )
( existed: EMPTY only ever reset the GLOBAL LATEST cell, with no )
( idea what CURRENT-VOCAB currently pointed at. Calling EMPTY while )
( some other vocabulary -- EDITOR, below -- was still the compile )
( target left CURRENT-VOCAB still aimed at that vocabulary's own )
( remembered-position cell. The next DEFINITIONS-equivalent switch )
( then did its ordinary "save the outgoing chain's tip into )
( CURRENT-VOCAB's cell" step -- which saved the now-reset, )
( boot-marker LATEST value directly into that OTHER vocabulary's own )
( cell, permanently overwriting its real chain tip. The vocabulary's )
( own marker word survived, reachable from FORTH same as always, )
( but every word actually defined inside it became permanently )
( unreachable, even though the underlying bytes were never touched. )
( CONTEXT needs the identical treatment now that it's a real, )
( separate pointer too -- leaving it aimed at a vocabulary whose )
( memory EMPTY just made reclaimable, then compiling enough new )
( code to actually grow back into that space, would have CONTEXT )
( walking straight into overwritten, unrelated bytes. Forcing both )
( to FORTH here closes the gap completely: EMPTY now always leaves )
( the machine in a clean, known FORTH state, matching a fresh COLD )
( boot exactly, no matter which vocabulary was active or being )
( browsed when it was called. )

( FORTH, executed here, runs VOCABULARY's own DOES> action -- sets )
( CONTEXT to FORTH's own cell directly, no name-parsing needed )
( since FORTH is the literal word being called, not a runtime )
( argument. CURRENT-VOCAB is then set to match by hand, the exact )
( same one-line mirror the boot-time setup above already uses. )
: EMPTY
  BOOT-LATEST @ LATEST-ADDR !
  BOOT-HERE @ HERE-ADDR !
  FORTH
  CONTEXT @ CURRENT-VOCAB !
;

( SEAL-BOOT, M78: records the current LATEST/HERE as the point EMPTY )
( resets to. Run once at the very end of this file, and run again by )
( the host after it loads anything else that belongs to the boot )
( dictionary -- the float wordset's float.fth today -- so EMPTY keeps )
( that too. Visible, since the host calls it by name. )
: SEAL-BOOT ( -- ) LATEST BOOT-LATEST ! HERE BOOT-HERE ! ;

( ---------------------------------------------------------------- )
( Screen Editor -- FORTH-ARCHITECTURE.md section 7 follow-up, )
( inspiration Starting-FORTH.pdf chapter 3, and )
( inspiration figforth_editor_screens.txt. One screen is one BLKS )
( block -- sixteen lines of sixty-four characters, matching classic )
( Forth's own fixed 1024-byte screen layout exactly, and matching )
( this project's own screen width of sixty-four character columns )
( -- not a coincidence either. )

( C/L is the classic name, characters per line. L/SCR is this )
( project's own name, lines per screen, no classic precedent found )
( for it. Both are fixed architectural constants, not queried from )
( BLKS at runtime -- the 1024-byte block size they multiply out to )
( is BLOCK-SIZE itself, already a fixed constant from the )
( BLOCK/BUFFER section above. )
64 CONSTANT C/L
16 CONSTANT L/SCR

: BLANKS ( addr len -- ) BL FILL ;

( LOAD interprets screen n as Forth source, one line at a time. )
( BLOCK gets the resident buffer; each line's own sixty-four bytes )
( get pointed to directly via the new native SET-INPUT primitive, )
( the one thing no earlier milestone needed, since every previous )
( consumer of the shared input cursor only ever pointed it at the )
( TIB. From there, INTERPRET reads exactly the way it reads any )
( typed line, with zero awareness that its source is a block )
( instead of a keystroke. )

( Aligns CONTEXT with CURRENT-VOCAB for its own duration, restoring )
( whatever CONTEXT was on the way out -- found necessary, not just )
( tidy, by an actual failing case: a screen whose second line calls )
( a word its first line just defined, LOADed while merely browsing )
( some other vocabulary. FIND and WORDS only read LATEST directly )
( when CONTEXT and CURRENT-VOCAB already agree -- otherwise CONTEXT )
( names some other, dormant vocabulary's own frozen position, which )
( can never see words compiled moments ago by *this* LOAD call. )
( Without this, LOAD's own compile target was always right, but a )
( multi-line screen referencing its own earlier definitions could )
( fail to compile at all depending on what the caller happened to )
( be browsing at the time -- purely accidental, not something a )
( screen's own author has any control over. )

( LOAD-ADDR, now LOAD-BLK, and LOAD-CONTEXT -- found live, Oliver, )
( spreading a colon-definition across several block lines instead )
( of one: the block's )
( base address and the saved CONTEXT used to live on the data stack )
( itself, under whatever the interpreted lines pushed -- exactly the )
( kind of thing this file's own R#/SCR/T-LINE/TEXT-LEN scratch )
( variables already exist to avoid. Fine as long as every interpreted )
( line balanced its own stack effect back to empty, which most do -- )
( but a bare number, or DO -- compile-time, pushes its own backpatch )
( address -- on one line with its matching LOOP on a later one, )
( leaves something sitting there. The next iteration's DUP then )
( re-fetches that leftover instead of the real block address, )
( computes a garbage line address, and INTERPRET reads whatever )
( unrelated arena memory happens to be there as if it were Forth )
( source -- usually non-text bytes, which fail NUMBER's validation )
( and ABORT, TYPEing the bad token first, hence the big gap of )
( invisible characters before the printed ABORT. Isolated directly: )
( a colon-definition header on one block line and a DO on the next )
( reproduces it with no LOOP/I involved yet; two bare numbers on )
( separate lines, no colon-def at all, reproduce the identical )
( ABORT -- confirming this was never actually about DO/LOOP )
( specifically, just the first construct naturally likely to span )
( two lines while still leaving something on the stack in between. )
( EVALUATE, M75, spec 04-FORTH-CORE.md section 6.15: interprets )
( len characters at addr as if typed as one line, then puts back the )
( input line and cursor it found, so the rest of its caller's line )
( carries on. Only the redirection is native -- the GET-INPUT and )
( SET-INPUT primitives -- which 6.15 permits; the saved cursor waits )
( on the return stack, so EVALUATE nests. STATE is left alone, and an )
( error inside abandons the saved line along with everything else. )
: EVALUATE ( addr len -- )
  (GET-INPUT) >R >R
  (SET-INPUT) INTERPRET
  R> R> (SET-INPUT) ;

\ EVALUATE-LINES, M79, spec 04-FORTH-CORE.md section 6.16: interprets
\ a block of source text one line at a time, the way this file itself
\ is loaded -- lines end at LF, and a CR before it is dropped. STATE
\ carries over between lines, so a definition may span several. The
\ cursor variables are saved on the return stack, so a module that
\ loads another module, nested EVALUATE-LINES, is fine.
VARIABLE EL-ADDR
VARIABLE EL-END
: EVALUATE-LINES ( addr len -- )
  EL-ADDR @ >R  EL-END @ >R
  OVER + EL-END !  EL-ADDR !
  BEGIN EL-ADDR @ EL-END @ < WHILE
    EL-ADDR @ DUP
    BEGIN DUP EL-END @ < IF DUP C@ 10 <> ELSE 0 THEN WHILE 1+ REPEAT
    DUP 1+ EL-ADDR !
    OVER -
    DUP IF 2DUP + 1- C@ 13 = IF 1- THEN THEN
    EVALUATE
  REPEAT
  R> EL-END !  R> EL-ADDR ! ;

\ NEEDS, M79, spec 04-FORTH-CORE.md section 6.16 -- NEEDS FLOAT loads
\ the target's source module FLOAT, float.fth beside system.fth here,
\ unless it is already loaded -- vForth's NEEDS, REQUIRE in other Forths.
\ Loading ends by defining the marker word FLOAT.FTH, and a module is
\ loaded when its marker can be
\ found, so EMPTY or FORGET, which remove the marker along with the
\ module's words, make it loadable again. A load that aborts defines no
\ marker. The module's words compile into CURRENT, read with CONTEXT
\ aligned to it, as LOAD does. The name is 1 to 8 characters; the name
\ itself stays readable in the line that called NEEDS throughout, so
\ it is kept as addr len on the return stack rather than copied.
CREATE MOD-LINE 24 ALLOT
: MOD-MARKER ( addr len -- line len' ) \ "CREATE NAME.FTH" in MOD-LINE
  S" CREATE" MOD-LINE SWAP CMOVE  BL MOD-LINE 6 + C!  \ a compiled S" drops a trailing space
  DUP >R  0 DO DUP I + C@ UPCHAR MOD-LINE 7 + I + C! LOOP DROP
  S" .FTH" MOD-LINE 7 + R@ + SWAP CMOVE
  MOD-LINE R> 11 + ;
: NEEDS ( "name" -- )
  BL WORD
  DUP 1 9 WITHIN 0= IF TYPE SPACE ." - module name must be 1-8 characters" ABORT THEN
  2DUP MOD-MARKER SWAP 7 + SWAP 7 - FIND NIP IF 2DROP EXIT THEN
  2DUP >R >R
  (MODULE-READ)
  DUP 0= IF 2DROP R> R> TYPE SPACE ." - no such module" ABORT THEN
  CONTEXT @ >R  CURRENT-VOCAB @ CONTEXT !
  EVALUATE-LINES
  R> CONTEXT !
  R> R> MOD-MARKER EVALUATE ;
HIDE EL-ADDR
HIDE EL-END

( M75: LOAD evaluates each line through EVALUATE now, so it hands )
( the caller's input line back too -- before, anything typed after )
( n LOAD on the same line was silently dropped. LOAD-BLK and )
( LOAD-CONTEXT are saved on the return stack across the call and )
( restored at the end, and BLOCK is re-fetched for every line rather )
( than once, so a screen that LOADs another screen -- the classic )
( chaining idiom -- leaves its own load intact when control returns. )
VARIABLE LOAD-BLK
VARIABLE LOAD-CONTEXT
: LOAD ( n -- )
  LOAD-BLK @ >R  LOAD-CONTEXT @ >R
  LOAD-BLK !
  CONTEXT @ LOAD-CONTEXT !
  CURRENT-VOCAB @ CONTEXT !
  L/SCR 0 DO
    LOAD-BLK @ BLOCK I C/L * + C/L EVALUATE
  LOOP
  LOAD-CONTEXT @ CONTEXT !
  R> LOAD-CONTEXT !  R> LOAD-BLK !
;
HIDE LOAD-BLK
HIDE LOAD-CONTEXT

\ ---- Environments, M77, spec 06-ENVIRONMENTS.md ----
\ Other interactive programs -- MEMO, BASIC -- take over the screen and
\ keyboard as peers of this Forth prompt. The native side is only the
\ ENV sysvar group and one branch in repl.ts's driving loop: while
\ ENV-ENTRY is non-zero the loop EXECUTEs it instead of reading a line.
\ Everything below -- the saved-screen bank's header, claiming a slot,
\ the switch itself -- is portable source and must stay that way, 6.

\ The ENV group, 03-SYSVARS.md section 12, base 0x1C0 = 448 in SYSV.
BANK@ SYSV 448 + CONSTANT ENV-ENTRY
BANK@ SYSV 452 + CONSTANT ENV-REASON
BANK@ SYSV 456 + CONSTANT ENV-CURRENT
0 CONSTANT ENV-STEP
1 CONSTANT ENV-ENTER
2 CONSTANT ENV-RECOVER

\ ESCR, 06 section 7: a 16-byte header -- slot count, slot size -- then
\ 8 fixed slots. A slot is the name, 8 bytes NUL-padded, all zero =
\ free; a valid flag at +8; six screen sysvars at +16; then copies of
\ the CHAR grid and the ATTR grid from +48. The bank itself is created
\ zeroed by repl.ts, so every slot starts free; only the header needs
\ writing, and it must be written before HOME claims slot 0.
: ESCR-GRID ( -- n ) BANK@ SYSV 80 + @ BANK@ SYSV 84 + @ * ;
8 BANK@ ESCR !
ESCR-GRID 2* 48 + 3 + -4 AND BANK@ ESCR 4 + !
: ESCR-SLOT ( i -- slot ) BANK@ ESCR 4 + @ * BANK@ ESCR 16 + + ;

\ The six saved sysvars, as offsets into SYSV: CURSOR-X, CURSOR-Y, then
\ INK, PAPER, CURSOR-VISIBLE, PALETTE-BASE.
: ESCR-VAR ( i -- sysv-addr )
  DUP 2 < IF CELLS 16 + ELSE 2 - CELLS 88 + THEN BANK@ SYSV + ;

\ Save copies the screen into a slot and marks it valid; restore copies
\ it back and repaints from CHAR -- REDRAW also redraws the cursor from
\ the restored CURSOR-VISIBLE.
: ESCR-SAVE ( slot -- )
  6 0 DO I ESCR-VAR @ OVER 16 + I CELLS + ! LOOP
  BANK@ CHAR OVER 48 + ESCR-GRID CMOVE
  BANK@ ATTR OVER 48 + ESCR-GRID + ESCR-GRID CMOVE
  -1 SWAP 8 + ! ;
: ESCR-RESTORE ( slot -- )
  6 0 DO DUP 16 + I CELLS + @ I ESCR-VAR ! LOOP
  DUP 48 + BANK@ CHAR ESCR-GRID CMOVE
  48 + ESCR-GRID + BANK@ ATTR ESCR-GRID CMOVE
  REDRAW ;

\ Claiming a slot, 7.1: one that already carries the name is adopted as
\ it stands, saved screen included -- how an environment reloaded after
\ FORGET gets its screen back. Otherwise the first free slot is taken,
\ named, and marked not valid. None free ABORTs.
VARIABLE ENV-FOUND
VARIABLE ENV-FREE
: ESCR-FREE? ( slot -- flag ) DUP @ 0= SWAP CELL+ @ 0= AND ;
: ESCR-SET-NAME ( addr len slot -- )
  DUP 12 0 FILL
  SWAP 0 DO OVER I + C@ UPCHAR OVER I + C! LOOP
  2DROP ;
: ESCR-CLAIM ( addr len -- slot )
  0 ENV-FOUND !  0 ENV-FREE !
  8 0 DO
    I ESCR-SLOT
    DUP ESCR-FREE? IF
      ENV-FREE @ IF DROP ELSE ENV-FREE ! THEN
    ELSE
      DUP 2OVER NAME8= IF ENV-FOUND ! ELSE DROP THEN
    THEN
  LOOP
  ENV-FOUND @ ?DUP IF NIP NIP EXIT THEN
  ENV-FREE @ ?DUP 0= IF TYPE SPACE ." - no free ESCR slot" ABORT THEN
  DUP >R ESCR-SET-NAME R> ;

\ The switch, 6: save the outgoing screen into the active environment's
\ slot, repoint ENV-CURRENT and ENV-ENTRY, restore the incoming screen
\ or clear it if it was never saved, mark ENV-ENTER, then WARM -- which
\ discards both stacks and the rest of the line, so a switch never
\ returns and the driving loop picks up ENV-ENTRY afresh.
: ENV-SWITCH ( record -- )
  ENV-CURRENT @ CELL+ @ ESCR-SAVE
  DUP ENV-CURRENT !
  DUP @ ENV-ENTRY !
  CELL+ @ DUP 8 + @ IF ESCR-RESTORE ELSE DROP CLS THEN
  ENV-ENTER ENV-REASON !
  WARM ;

\ ENVIRONMENT -- xt ENVIRONMENT name -- defines name as the word that
\ switches into the environment whose step word is xt. The record is
\ two cells, step xt then ESCR slot. The name is peeked first with
\ WORD and the input cursor put back, so the slot can be claimed before
\ CREATE consumes the name; it must be 1 to 8 characters, the slot's
\ name field. A step xt of 0 is the home record, which ENV-CURRENT
\ starts out pointing at.
: ENVIRONMENT ( xt "name" -- )
  (GET-INPUT) >R >R
  BL WORD
  DUP 1 9 WITHIN 0= IF TYPE SPACE ." - environment name must be 1-8 characters" ABORT THEN
  ESCR-CLAIM
  R> R> (SET-INPUT)
  CREATE HERE >R SWAP DUP >R , ,
  R> 0= IF R@ ENV-CURRENT ! THEN R> DROP
  DOES> ENV-SWITCH ;

\ HOME, 7.2 / 06 section 4: the Forth prompt as an environment, slot 0.
0 ENVIRONMENT HOME

HIDE ENV-FOUND
HIDE ENV-FREE
HIDE ESCR-FREE?
HIDE ESCR-SET-NAME

\ ---- Frames, time and held keys, M83, spec 13-GAME-LOOP.md 3-5 ----
\ VSYNC and MS@ are native; these are the portable words around them.
\ FRAME-COUNT is SCREEN offset 40 and KEYS-DOWN, 256 bits, is KEYBOARD
\ offset 8 -- SYSV 64 + 40 and SYSV 128 + 8.
BANK@ SYSV 104 + CONSTANT FRAME-COUNT
BANK@ SYSV 136 + CONSTANT KEYS-DOWN

\ KEY-DOWN? -- TRUE while the key with that usage code is held. A bit
\ test on KEYS-DOWN: byte u/8, bit u mod 8.
: KEY-DOWN? ( usage -- flag )
  255 AND DUP 8 / KEYS-DOWN + C@
  SWAP 7 AND 1 SWAP BEGIN DUP WHILE SWAP 2* SWAP 1- REPEAT DROP
  AND 0= 0= ;

\ MS -- waits at least n milliseconds, calling VSYNC while it waits so
\ the machine stays responsive. The difference is compared as a signed
\ cell, so it is safe across MS@ wrapping.
: MS ( n -- ) MS@ + BEGIN DUP MS@ - 0> WHILE VSYNC REPEAT DROP ;

\ ---- Sprites and tiles, M84, spec 13-GAME-LOOP.md 6 ----
\ SPRITE is native: x y n SPRITE draws entry n of the active sprite bank
\ at pixel x y. SPRITE-BASE, SPRITE offset 0 = SYSV 256, holds that
\ bank's base -- BANK@ SHIPS SPRITE-BASE ! makes SHIPS active.
BANK@ SYSV 256 + CONSTANT SPRITE-BASE

\ TILE -- SPRITE at a character cell, CHAR-CELL-W and CHAR-CELL-H being
\ SCREEN offsets 8 and 12, SYSV 72 and 76.
: TILE ( col row n -- )
  >R  BANK@ SYSV 76 + @ *  SWAP BANK@ SYSV 72 + @ *  SWAP  R> SPRITE ;




( The actual capture -- LATEST/HERE at this exact point already )
( include EMPTY's own just-closed definition, per the ordering note )
( above. The host repeats it after loading float.fth, M78. )
SEAL-BOOT

( BOOT-LATEST/BOOT-HERE are internal plumbing from here on -- hidden )
( the same way FIND-ADDR/NUM-ADDR already are. Safe after the fact: )
( HIDE only flips a flag on an existing entry, it doesn't grow HERE, )
( so hiding them here can't disturb the values just captured. EMPTY )
( itself stays visible -- it's the public word this is all for. )
HIDE BOOT-LATEST
HIDE BOOT-HERE
