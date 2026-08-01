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
( that precondition was met back in M8. )

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
