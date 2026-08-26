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
( FILL/CMOVE: char/addr2 parked on the data stack underneath the )
( DO loop's own return-stack-resident index/limit, not the return )
( stack itself -- DO/LOOP never touch the data stack, so whatever )
( sits there when DO runs is exactly what the loop body sees on )
( every iteration, undisturbed. Both also need TYPE's own guard )
( below -- a zero len still ran the body once, writing/copying )
( one stray byte instead of staying a true no-op. )
: FILL ( addr len char -- ) >R DUP 0= IF 2DROP R> DROP EXIT THEN R> -ROT OVER + SWAP DO DUP I C! LOOP DROP ;
: CMOVE ( addr1 addr2 len -- ) DUP 0= IF 2DROP DROP EXIT THEN 0 DO 2DUP SWAP I + C@ SWAP I + C! LOOP 2DROP ;
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
( spec/00-OVERVIEW.md. Header is 28 bytes (M63: grew from 16 once )
( Personality -- PERSONALITY/SCREEN-COLS/SCREEN-ROWS -- was added )
( ahead of the slot table); each of the 64 fixed slots is 24 bytes )
( -- tag 4 + name 8 + base/size/flags cells; the name field starts )
( 4 bytes into a slot, NUL-padded to 8; ACTIVE is flags bit 4, value )
( 16. A name shorter than 8 bytes only ever has *trailing* NUL )
( padding, never an embedded gap, so skipping zero bytes while still )
( emitting every nonzero one preserves order correctly -- no need )
( for LEAVE, which doesn't exist yet anyway, see spec/04-FORTH-CORE.md )
( section 9. )
28 CONSTANT MMAP-HDR
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
: XT-NAME >R LATEST BEGIN DUP WHILE DUP >CFA R@ = IF DUP 4 + C@ 31 AND OVER 5 + SWAP TYPE DROP R> DROP EXIT THEN @ REPEAT DROP R> DROP 63 EMIT ;

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

( SEE -- SEE <name>: decompiles a colon-definition back to )
( source-ish form. Only DOCOL-coded words are supported for )
( this pass -- CONSTANT/VARIABLE/DOES>'d words print )
( "not supported" rather than guessing wrong. BRANCH/0BRANCH )
( targets print as a bare placeholder rather than reconstructing )
( IF/THEN structure -- a real decompile, not a polished one, )
( same "minimum real mechanism first" discipline as everywhere )
( else in this project. )
: SEE
  '
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
: HIDE
  '
  >R
  LATEST
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
( itself touch disk -- SAVE and BSAVE, already built in M5/M33, )
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

( FIND uses two scratch variables rather than juggling addr/len on )
( the data or return stack across the whole chain-walk -- simpler to )
( get right than deep PICK arithmetic or R-stack parking, and this )
( isn't a hot path. Hidden below, once FIND itself no longer needs )
( to find them by name. )
VARIABLE FIND-ADDR
VARIABLE FIND-LEN

( FIND addr len -- entry-addr flag : chain-walk from the current )
( search context toward 0, skipping HIDDEN entries, comparing each )
( candidate's already-uppercase stored name against addr len )
( case-insensitively. entry-addr is 0 when flag is 0 -- meaningless )
( either way, per spec's own contract. The per-character comparison )
( uppercases the *input* byte only, since a stored name is already )
( uppercase -- written that way at definition time -- lowercase )
( a-z, ASCII 97-122, shift down by 32. )
( Walks CONTEXT's own target -- not the bare LATEST compile-chain )
( pointer this used before CONTEXT existed. Ordinary interpreted/ )
( compiled word dispatch, INTERPRET below, always wants what's )
( currently visible while browsing, which is exactly CONTEXT's own )
( job -- not what's currently being compiled into, which stays )
( LATEST's job alone, untouched here -- compileCell/CREATE/etc. )
( still act on it directly, unrelated to this search. )
( Same LATEST-vs-stored-position check WORDS above already needs: )
( a vocabulary's own remembered cell only gets refreshed when )
( DEFINITIONS switches away from it, not continuously as new words )
( compile in, so browsing whatever you're also compiling into has )
( to read LATEST directly to see the live picture -- CONTEXT's own )
( stored position is only accurate for some other, dormant )
( vocabulary nothing is currently compiling into. )
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
HIDE FIND-ADDR
HIDE FIND-LEN

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

( LOAD-ADDR/LOAD-CONTEXT -- found live, Oliver, spreading a colon- )
( definition across several block lines instead of one: the block's )
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
VARIABLE LOAD-ADDR
VARIABLE LOAD-CONTEXT
: LOAD ( n -- )
  CONTEXT @ LOAD-CONTEXT !
  CURRENT-VOCAB @ CONTEXT !
  BLOCK LOAD-ADDR !
  L/SCR 0 DO
    LOAD-ADDR @ I C/L * + C/L (SET-INPUT)
    INTERPRET
  LOOP
  LOAD-CONTEXT @ CONTEXT !
;
HIDE LOAD-ADDR
HIDE LOAD-CONTEXT

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
( LIST and a no-argument L. CLS first, Oliver: so the listing owns )
( the whole display, same as a real screen editor commandeering the )
( terminal, instead of appending after whatever REPL output -- prior )
( ok prompts, command echoes -- was already on screen. )
: L ( -- ) CLS SCR @ LIST ;

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

( The actual capture -- LATEST/HERE at this exact point already )
( include EMPTY's own just-closed definition, per the ordering note )
( above. )
LATEST BOOT-LATEST !
HERE BOOT-HERE !

( BOOT-LATEST/BOOT-HERE are internal plumbing from here on -- hidden )
( the same way FIND-ADDR/NUM-ADDR already are. Safe after the fact: )
( HIDE only flips a flag on an existing entry, it doesn't grow HERE, )
( so hiding them here can't disturb the values just captured. EMPTY )
( itself stays visible -- it's the public word this is all for. )
HIDE BOOT-LATEST
HIDE BOOT-HERE
