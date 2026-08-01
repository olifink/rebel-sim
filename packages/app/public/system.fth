( Rebel-Sim system vocabulary. DEVELOPING.md section 6: an interim )
( host-text-file resource loaded once at boot, before screens or )
( carts exist to hold it properly. Every word here is buildable )
( from the core vocabulary alone -- nothing in packages/engine )
( knows this file exists. )

( Note for anyone editing this file: ( doesn't nest -- the first )
( closing paren always ends a comment, so never write an embedded )
( closing paren inside comment text, even a decorative one. )

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
( that precondition was met back in M8. >CFA/XT-NAME/the -XT )
( constants below are pure internal plumbing for SEE -- HIDden )
( further down, once nothing later still needs to find them by )
( name during its own compilation (SEE itself does, right up )
( until its own closing semicolon, so hiding has to wait until )
( after that, not happen inline right after each one). )

( >CFA entry-addr -- cfa: same header-layout math WORDS already )
( walks -- flags-byte low five bits are the name length, the )
( Code Field sits right after the name, cell-aligned. )
: >CFA DUP 4 + C@ 31 AND SWAP 5 + + 3 + -4 AND ;

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

( A VOCABULARY-based split was considered instead of HIDE and )
( rejected: branching chains only let a *later* vocabulary see an )
( *earlier* one, never the reverse, and visibility/WORDS-listing )
( are the same underlying chain-walk -- there's no way to make )
( something callable-but-unlisted with vocabularies alone. HIDE is )
( the actual right-sized tool for this specific job -- VOCABULARY )
( and USE stay reserved for their own real use case, project and )
( cart isolation, once that's a concrete need, not this one. )
HIDE >CFA
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
