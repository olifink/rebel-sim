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
: DEPTH SP0 SP@ - 4 / ;
: PICK CELLS SP@ + @ ;
( 2OVER: same "the stack is memory" technique PICK itself uses -- )
( 3 PICK reaches the deeper of the two cells 2OVER needs to copy, )
( twice, once the first copy has shifted everything up by one. )
: 2OVER 3 PICK 3 PICK ;
: /MOD 2DUP MOD -ROT / ;
: <> = INVERT ;
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
: WARM SP0 SP! RP0 RP! ;

( Batch 5 -- needs Batch 3/4 already loaded. )
: ?DUP DUP IF DUP THEN ;
: ABS DUP 0< IF NEGATE THEN ;
( FILL/CMOVE: char/addr2 parked on the data stack underneath the )
( DO loop's own return-stack-resident index/limit, not the return )
( stack itself -- DO/LOOP never touch the data stack, so whatever )
( sits there when DO runs is exactly what the loop body sees on )
( every iteration, undisturbed. )
: FILL ( addr len char -- ) -ROT OVER + SWAP DO DUP I C! LOOP DROP ;
: CMOVE ( addr1 addr2 len -- ) 0 DO 2DUP SWAP I + C@ SWAP I + C! LOOP 2DROP ;
( TYPE: classic DO/LOOP still runs its body once even when )
( index = limit at entry -- guarded so a zero-length TYPE stays a )
( true no-op, matching the native behavior this replaces exactly. )
: TYPE ( addr len -- ) DUP 0= IF 2DROP EXIT THEN OVER + SWAP DO I C@ EMIT LOOP ;
( .S: reuses the still-native . for formatting, so its output is )
( guaranteed identical by construction rather than by re-deriving )
( digit formatting a second time. Bottom-to-top, matching the )
( print order this replaces. )
: .S DEPTH 0 DO DEPTH 1- I - PICK . LOOP ;

( ---------------------------------------------------------------- )

( WORDS -- lists every defined word name, most-recently-defined )
( first. CORE-VOCABULARY.md section 12's own worked example, )
( ported in verbatim, with one real fix: that doc writes 1F AND, )
( a hex literal, but BASE defaults to 10 decimal, where 1F isn't )
( a valid number at all. 31 is 1F's decimal value -- same mask, )
( NAME_LEN_MASK, same five low bits either way. )
: WORDS
  LATEST
  BEGIN
    DUP
  WHILE
    DUP 4 + C@ 31 AND
    OVER 5 +
    SWAP TYPE  32 EMIT
    @
  REPEAT
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

( VOCABULARY/USE, DEVELOPING.md section 8: branching dictionary )
( chains, not independent chains plus a search order -- each )
( vocabulary remembers its own LATEST position, starting as a )
( continuation of whatever chain was current, not empty, so )
( switching into one never loses access to words that already )
( existed before the branch point. )

( Ordinary VARIABLE, not a sysvar -- just needs plain read/write, )
( holding the address of whichever vocabulary's own cell USE )
( should save the outgoing chain position back into next. )
VARIABLE CURRENT-VOCAB

( VOCABULARY name -- creates a new vocabulary, its own CREATEd )
( cell capturing the CURRENT chain position at creation time, not )
( zero. LATEST must run before CREATE: CREATE itself becomes the )
( new LATEST the instant it links its own header in, so capturing )
( the old value has to happen first. )
: VOCABULARY LATEST CREATE , ;

( Everything defined above this point becomes the root vocabulary. )
VOCABULARY FORTH
' FORTH 8 + CURRENT-VOCAB !

( USE name -- switches which chain new definitions extend and )
( lookups walk. Saves the outgoing chain's current position back )
( into its own remembered cell, then loads the target's remembered )
( position into LATEST itself. The +8 skips the target's Code )
( Field and CREATE's reserved does-pointer cell -- the same offset )
( executeXT's own DOVAR dispatch already uses to reach a CREATEd )
( word's actual data. )
: USE
  ' 8 +
  LATEST-ADDR @ CURRENT-VOCAB @ !
  DUP @ LATEST-ADDR !
  CURRENT-VOCAB !
;

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

( FIND addr len -- entry-addr flag : chain-walk from LATEST toward 0, )
( skipping HIDDEN entries, comparing each candidate's already-uppercase )
( stored name against addr len case-insensitively. entry-addr is 0 )
( when flag is 0 -- meaningless either way, per spec's own contract. )
( The per-character comparison uppercases the *input* byte only, )
( since a stored name is already uppercase -- written that way at )
( definition time -- lowercase a-z, ASCII 97-122, shift down by 32. )
: FIND ( addr len -- entry-addr flag )
  FIND-LEN ! FIND-ADDR !
  LATEST
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
