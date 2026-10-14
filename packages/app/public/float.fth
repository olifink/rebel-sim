\ 07-FLOATING-POINT.fth -- version 1.1, draft. Reference source for the
\ float wordset's Forth-source layer (07-FLOATING-POINT.md sections 5, 6).
\ Normative: a target's results must be bit-identical to these.
\ Needs the eight KERNEL float words (section 4) and the core words.
\ Every constant is the exact binary32 bit pattern, in hex. A pattern
\ with bit 31 set is read as a negative cell, which is the same bits.

HEX
3F800000 CONSTANT F1          \ 1.0
3F000000 CONSTANT F0.5        \ 0.5
42000000 CONSTANT F32         \ 32.0
4B800000 CONSTANT TWO24       \ 16777216.0 = 2^24
7FC00000 CONSTANT FNAN        \ the one NaN (section 3, rule 6)
7F800000 CONSTANT F+INF
FF800000 CONSTANT F-INF
80000000 CONSTANT SIGN-BIT
3FB8AA3B CONSTANT INVLN2      \ 1/ln 2
3F317200 CONSTANT LN2HI       \ ln 2, high part (16 bits)
35BFBE8E CONSTANT LN2LO       \ ln 2 - LN2HI
42B17218 CONSTANT EXP-MAX     \ above this e^x overflows
C2CFF1B4 CONSTANT EXP-MIN     \ below this e^x underflows to 0
3FB504F3 CONSTANT SQRT2
3F22F983 CONSTANT TWO/PI
3FC90000 CONSTANT PI/2HI      \ pi/2, high part (9 bits)
39FDAA22 CONSTANT PI/2LO      \ pi/2 - PI/2HI
3F490FDB CONSTANT PI/4
3FC90FDB CONSTANT PI/2
3ED413CD CONSTANT TAN-PI/8
DECIMAL

\ ---- 5.1 derived arithmetic and tests ----

: FNAN?    ( r -- flag )  DUP F= 0= ;
: FINITE?  ( r -- flag )  SIGN-BIT INVERT AND  F+INF < ;
: FNEGATE  ( r -- -r )    DUP FNAN? IF DROP FNAN EXIT THEN  SIGN-BIT XOR ;
: FABS     ( r -- |r| )   DUP FNAN? IF DROP FNAN EXIT THEN  SIGN-BIT INVERT AND ;
: F-       ( r1 r2 -- r3 ) FNEGATE F+ ;
: F0=      ( r -- flag )  FABS 0= ;
: F0<      ( r -- flag )  0 F< ;
: F>       ( r1 r2 -- flag ) SWAP F< ;
: FMIN     ( r1 r2 -- r3 )
  OVER FNAN? OVER FNAN? OR IF 2DROP FNAN EXIT THEN
  2DUP F< IF DROP ELSE NIP THEN ;
: FMAX     ( r1 r2 -- r3 )
  OVER FNAN? OVER FNAN? OR IF 2DROP FNAN EXIT THEN
  2DUP F< IF NIP ELSE DROP THEN ;
: FTRUNC   ( r -- r' )    \ toward zero; |r| >= 2^24, infinities unchanged
  DUP FNAN? IF DROP FNAN EXIT THEN
  DUP FABS TWO24 F< IF F>S S>F THEN ;
: FLOOR    ( r -- r' )    DUP FTRUNC TUCK F< IF F1 F- THEN ;

\ ---- helpers ----

\ Horner's rule: n coefficients at addr, highest power first.
VARIABLE PZ
: POLY  ( z addr n -- r )
  ROT PZ !  OVER @ -ROT
  1 DO  CELL+ SWAP PZ @ F* OVER @ F+ SWAP  LOOP  DROP ;

\ 2^n as a float, for -126 <= n <= 127.
: 2^N   ( n -- r )  127 + 8388608 * ;

\ ---- 5.2 elementary functions ----

\ e^x: x = k ln2 + r with |r| <= ln2/2, e^r by Taylor series to r^7,
\ then scaled by 2^k in two halves so each factor is a normal number.
CREATE EXP-C  HEX
  39500D01 , 3AB60B61 , 3C088889 , 3D2AAAAB ,   \ 1/7! 1/6! 1/5! 1/4!
  3E2AAAAB , 3F000000 , 3F800000 , 3F800000 ,   \ 1/3! 1/2! 1 1
DECIMAL
: FEXP  ( r -- e^r )
  DUP FNAN? IF DROP FNAN EXIT THEN
  DUP EXP-MAX F> IF DROP F+INF EXIT THEN
  DUP EXP-MIN F< IF DROP 0 EXIT THEN
  DUP INVLN2 F*  OVER F0< IF F0.5 F- ELSE F0.5 F+ THEN  F>S   ( x k )
  DUP >R S>F  TUCK LN2HI F* F-  SWAP LN2LO F* F-              ( r )
  EXP-C 8 POLY
  R> DUP 2/ TUCK -  >R 2^N F*  R> 2^N F* ;

\ ln x: x = 2^k m with sqrt(1/2) < m <= sqrt(2); ln m = 2 atanh s,
\ s = (m-1)/(m+1), by its series to s^9; plus k ln2.
CREATE LN-C  HEX
  3DE38E39 , 3E124925 , 3E4CCCCD , 3EAAAAAB , 3F800000 ,  \ 1/9 1/7 1/5 1/3 1
DECIMAL
: FLN  ( r -- ln r )
  DUP FNAN? IF DROP FNAN EXIT THEN
  DUP F0< IF DROP FNAN EXIT THEN
  DUP F0= IF DROP F-INF EXIT THEN
  DUP F+INF = IF EXIT THEN
  0 >R
  DUP 8388608 < IF  TWO24 F*  R> 24 - >R  THEN      \ subnormal
  DUP 8388608 / 127 -  R> + >R                       \ exponent
  8388607 AND F1 OR                                  \ m in [1,2)
  DUP SQRT2 F> IF  F0.5 F*  R> 1+ >R  THEN
  DUP F1 F- SWAP F1 F+ F/                            ( s )
  DUP DUP F* LN-C 5 POLY  SWAP DUP F+ F*             ( ln m )
  R> S>F  DUP LN2LO F* ROT F+  SWAP LN2HI F* F+ ;

\ sin and cos: |x| = n pi/2 + y with |y| <= pi/4, then a Taylor
\ series for sin y (to y^9) or cos y (to y^10) chosen by n mod 4.
CREATE SIN-C  HEX
  3638EF1D , B9500D01 , 3C088889 , BE2AAAAB , 3F800000 ,  \ 1/9! -1/7! 1/5! -1/3! 1
DECIMAL
CREATE COS-C  HEX
  B493F27E , 37D00D01 , BAB60B61 , 3D2AAAAB , BF000000 , 3F800000 ,
DECIMAL                       \ -1/10! 1/8! -1/6! 1/4! -1/2 1
: KSIN  ( y -- sin y )  DUP DUP F* SIN-C 5 POLY F* ;
: KCOS  ( y -- cos y )  DUP F* COS-C 6 POLY ;
: FREDUCE  ( a -- y q )       \ a >= 0, finite
  DUP TWO/PI F* F0.5 F+ F>S  DUP >R  S>F
  TUCK PI/2HI F* F-  SWAP PI/2LO F* F-  R> 3 AND ;
: FSIN  ( r -- sin r )
  DUP FINITE? 0= IF DROP FNAN EXIT THEN
  DUP F0< >R  FABS FREDUCE
  DUP 1 AND IF SWAP KCOS ELSE SWAP KSIN THEN
  SWAP 2 AND IF FNEGATE THEN
  R> IF FNEGATE THEN ;
: FCOS  ( r -- cos r )
  DUP FINITE? 0= IF DROP FNAN EXIT THEN
  FABS FREDUCE
  DUP 1 AND IF SWAP KSIN ELSE SWAP KCOS THEN
  SWAP 1+ 2 AND IF FNEGATE THEN ;
: FTAN  ( r -- tan r )  DUP FSIN SWAP FCOS F/ ;

\ atan x: |x| > 1 uses pi/2 - atan(1/|x|); then |x| > tan(pi/8) uses
\ pi/4 + atan((x-1)/(x+1)); the rest by the Taylor series to x^15.
CREATE ATAN-C  HEX
  BD888889 , 3D9D89D9 , BDBA2E8C , 3DE38E39 ,   \ -1/15 1/13 -1/11 1/9
  BE124925 , 3E4CCCCD , BEAAAAAB , 3F800000 ,   \ -1/7 1/5 -1/3 1
DECIMAL
VARIABLE AINV  VARIABLE AOFF
: FATAN  ( r -- atan r )
  DUP FNAN? IF DROP FNAN EXIT THEN
  DUP F0< >R  FABS
  DUP F1 F> DUP AINV !  IF F1 SWAP F/ THEN
  0 AOFF !
  DUP TAN-PI/8 F> IF  DUP F1 F- SWAP F1 F+ F/  PI/4 AOFF !  THEN
  DUP DUP F* ATAN-C 8 POLY F*  AOFF @ F+
  AINV @ IF PI/2 SWAP F- THEN
  R> IF FNEGATE THEN ;

\ x^n for an integer n, by repeated squaring.
: F**N  ( r n -- r' )
  DUP 0< >R ABS  F1 -ROT
  BEGIN DUP WHILE
    DUP 1 AND IF  ROT 2 PICK F* -ROT  THEN
    SWAP DUP F* SWAP 2/
  REPEAT 2DROP
  R> IF F1 SWAP F/ THEN ;

\ x^y: y = 0 gives 1; an integral |y| <= 32 uses F**N; a negative x
\ needs an integral y, its sign from y's parity; otherwise e^(y ln x).
: FINTEGRAL?  ( r -- flag )  DUP FTRUNC F= ;
: F**  ( x y -- x^y )
  DUP F0= IF 2DROP F1 EXIT THEN
  DUP FINTEGRAL? IF  DUP FABS F32 F> 0= IF F>S F**N EXIT THEN  THEN
  OVER F0< IF
    DUP FINTEGRAL? 0= IF 2DROP FNAN EXIT THEN
    DUP FABS TWO24 F< IF DUP F>S 1 AND ELSE 0 THEN >R
    SWAP FABS FLN F* FEXP  R> IF FNEGATE THEN EXIT
  THEN
  SWAP FLN F* FEXP ;

\ ---- 5.3 conversion to and from text ----

CREATE P10  HEX                       \ 10^0 .. 10^10, all exact
  3F800000 , 41200000 , 42C80000 , 447A0000 , 461C4000 , 47C35000 ,
  49742400 , 4B189680 , 4CBEBC20 , 4E6E6B28 , 501502F9 ,
DECIMAL
: 10^  ( n -- r )  CELLS P10 + @ ;    \ 0 <= n <= 10

\ r times 10^k, using exact powers of ten at most 10^10 at a time.
: FSCALE10  ( r k -- r' )
  BEGIN DUP 10 > WHILE   SWAP 10 10^ F* SWAP 10 -  REPEAT
  BEGIN DUP -10 < WHILE  SWAP 10 10^ F/ SWAP 10 +  REPEAT
  DUP 0< IF NEGATE 10^ F/ ELSE 10^ F* THEN ;

\ >FLOAT: up to 9 significant digits are accumulated as an integer,
\ which is converted and then scaled by the decimal exponent.
VARIABLE FP  VARIABLE FL                      \ text cursor
VARIABLE FM  VARIABLE FD  VARIABLE FNDIG  VARIABLE FX
: PEEK   ( -- c )  FL @ IF FP @ C@ ELSE 0 THEN ;   \ 0 at the end
: SKIP1  ( -- )    1 FP +!  -1 FL +! ;
: DIGIT?  ( c -- n TRUE | FALSE )
  48 -  DUP 0 10 WITHIN IF -1 ELSE DROP 0 THEN ;
: SIGN?  ( -- neg? )        \ consumes an optional + or -
  PEEK 45 = IF SKIP1 -1 EXIT THEN  PEEK 43 = IF SKIP1 THEN 0 ;
: MDIGITS  ( frac? -- )     \ mantissa digits; frac? after the point
  BEGIN PEEK DIGIT? WHILE
    SKIP1  1 FNDIG +!
    FM @ 100000000 < IF  FM @ 10 * + FM !  DUP IF -1 FD +! THEN
    ELSE  DROP  DUP 0= IF 1 FD +! THEN  THEN
  REPEAT DROP ;
: >FLOAT  ( addr len -- r TRUE | FALSE )
  FL ! FP !  0 FM !  0 FD !  0 FNDIG !
  SIGN? >R
  0 MDIGITS
  PEEK 46 = IF SKIP1 -1 MDIGITS THEN
  FNDIG @ 0= IF R> DROP 0 EXIT THEN
  PEEK 32 OR 101 = IF                         \ E or e
    SKIP1  SIGN?  0 FX !  0
    BEGIN PEEK DIGIT? WHILE
      SKIP1  FX @ DUP 1000 < IF 10 * + ELSE NIP THEN FX !  1+
    REPEAT
    0= IF DROP R> DROP 0 EXIT THEN
    IF FX @ NEGATE ELSE FX @ THEN  FD +!
  THEN
  FL @ IF R> DROP 0 EXIT THEN                 \ anything left over
  FM @ S>F  FD @ FSCALE10
  R> IF FNEGATE THEN  -1 ;

\ (F.): seven significant digits, rounded; plain notation from 1E-5
\ up to 1E+7, exponent notation outside it.
CREATE FBUF 24 ALLOT  VARIABLE FBL   \ (F.)'s result, until the next call
CREATE FDIG 8 ALLOT   VARIABLE FE
: +C  ( c -- )  FBUF FBL @ + C!  1 FBL +! ;
: DIG  ( i -- )  FDIG + C@ +C ;
: DIGS  ( from to -- )  BEGIN 2DUP > 0= WHILE OVER DIG SWAP 1+ SWAP REPEAT 2DROP ;
: LASTNZ  ( -- i )  6 BEGIN DUP FDIG + C@ 48 = WHILE 1- REPEAT ;
: >DIGITS  ( n -- )  7 0 DO  10 /MOD SWAP 48 + FDIG 6 I - + C!  LOOP DROP ;
: FESTIMATE  ( a -- e )  8388608 / 127 -  77 * 256 / ;  \ about log10 a
\ Nearest integer to m >= 0, m below 2^24 (where F>S and S>F are exact).
: FROUND  ( m -- n )  DUP F>S  TUCK S>F F-  F0.5 F< 0= IF 1+ THEN ;

\ The exact product a*b as p + err (Dekker): p = a*b rounded, err exact.
HEX 45801000 CONSTANT F4097  BF000000 CONSTANT F-0.5  DECIMAL
: FSPLIT  ( a -- hi lo )  DUP F4097 F*  DUP 2 PICK F- F-  TUCK F- ;
VARIABLE TPP  VARIABLE TAH  VARIABLE TAL  VARIABLE TBH  VARIABLE TBL
: TWOPROD  ( a b -- p err )
  2DUP F* TPP !  FSPLIT TBL ! TBH !  FSPLIT TAL ! TAH !
  TAH @ TBH @ F* TPP @ F-  TAH @ TBL @ F* F+
  TAL @ TBH @ F* F+  TAL @ TBL @ F* F+  TPP @ SWAP ;

\ Nearest integer to p + err, p >= 0 below 2^24, |err| small.
: FROUND2  ( p err -- n )
  >R DUP F>S  TUCK S>F F-  R> F+
  DUP F0.5 F< 0= IF DROP 1+ ELSE F-0.5 F< IF 1- THEN THEN ;

\ Nearest integer to a * 10^k. Exact when one multiplication or
\ division by an exact power of ten does it (-10 <= k <= 10).
VARIABLE TA  VARIABLE TD  VARIABLE TQ
: FSCALED  ( a k -- n )
  DUP 0 11 WITHIN IF  10^ TWOPROD FROUND2  EXIT THEN
  DUP -10 0 WITHIN IF
    NEGATE 10^ TD !  TA !  TA @ TD @ F/ TQ !          \ q = a / D
    TQ @ TD @ TWOPROD  >R TA @ SWAP F-  R> F-  TD @ F/  \ (a - q*D) / D
    TQ @ SWAP FROUND2  EXIT
  THEN
  FSCALE10 FROUND ;
: F>DIG7  ( a -- n )         \ a > 0; n in 1000000..9999999, sets FE
  DUP FESTIMATE FE !
  BEGIN
    DUP 6 FE @ - FSCALED
    DUP 10000000 < 0= IF  DROP 1 FE +! 0  ELSE
    DUP 1000000 < IF  DROP -1 FE +! 0  ELSE -1 THEN THEN
  UNTIL NIP ;
: (F.)  ( r -- addr len )
  0 FBL !
  DUP FNAN? IF DROP 78 +C 65 +C 78 +C  FBUF FBL @ EXIT THEN
  DUP F0< IF 45 +C THEN  FABS
  DUP F+INF = IF DROP 73 +C 78 +C 70 +C  FBUF FBL @ EXIT THEN
  DUP F0= IF DROP 48 +C  FBUF FBL @ EXIT THEN
  F>DIG7 >DIGITS  FE @
  DUP -5 < OVER 6 > OR IF                        \ d.ddddddE+nn
    0 DIG  LASTNZ DUP 0> IF 46 +C 1 SWAP DIGS ELSE DROP THEN
    69 +C  DUP 0< IF 45 +C NEGATE ELSE 43 +C THEN
    DUP 10 / 48 + +C  10 MOD 48 + +C
  ELSE DUP 0< IF                                 \ 0.000ddd
    48 +C 46 +C  NEGATE 1- BEGIN DUP WHILE 48 +C 1- REPEAT DROP
    0 LASTNZ DIGS
  ELSE                                           \ ddd.ddd
    0 OVER DIGS  LASTNZ 2DUP < IF 46 +C SWAP 1+ SWAP DIGS ELSE 2DROP THEN
  THEN THEN
  FBUF FBL @ ;
: F.  ( r -- )  (F.) TYPE SPACE ;

\ F# (section 6): a float literal, pushed or compiled.
: F#  ( "number" -- r )
  BL WORD >FLOAT 0= IF ABORT THEN
  STATE @ IF LIT-XT , , THEN ; IMMEDIATE
