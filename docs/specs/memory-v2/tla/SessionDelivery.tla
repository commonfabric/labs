-------------------------- MODULE SessionDelivery --------------------------
(***************************************************************************)
(* A bounded model of ONE session's watch-delivery state across a          *)
(* reconnect (docs/specs/memory-v2/04-protocol.md sections 4.1.2, 4.3.5,   *)
(* 4.6): the server's per-session delivery memory, the client's replica,   *)
(* and what a reconnect's catch-up frame is diffed against.  It exists to  *)
(* check the property the pending-stack model (PendingStacks.tla) leaves   *)
(* out of scope — connection loss — for the delivery side: that a          *)
(* reconnect brings the replica to the watch union's current state (an     *)
(* uncovered document removed), and does so without re-delivering what     *)
(* the replica already holds.                                              *)
(*                                                                         *)
(* Scope: rep and its declaration describe delivered revisions, not       *)
(* locally visible values. A local fold can retain different content at   *)
(* the same seq. LocalFolds.tla checks that content's frame transitions;   *)
(* ReconnectConverges here proves only delivered-revision convergence.    *)
(*                                                                         *)
(* Abstractions:                                                           *)
(*                                                                         *)
(*   - One session, one watch union: a variable subset of Docs, initially  *)
(*     all of it, that Unwatch SHRINKS — possibly to empty, which is the   *)
(*     zero-watch reconnect (a resumed declaration onto a session with no  *)
(*     watches must be retracted, not left as demand).  Growth is not      *)
(*     modeled: a grown union's never-held documents are ordinary          *)
(*     deliveries, indistinguishable from initial delivery.  A document's  *)
(*     state is the seq of its latest write (0 = never written), which is  *)
(*     what the server's delivery diff compares (`sameSnapshot` in         *)
(*     server-sync.ts: id, instance, seq, deletedness; a tombstone is a    *)
(*     seq like any other here).                                           *)
(*                                                                         *)
(*   - A push while connected is one frame: the server records it as       *)
(*     delivered (`session.entities`), and the client either ABSORBS it or *)
(*     LOSES it — the client-side absorb defect class OW61 owns            *)
(*     (verification-coverage.md), bounded by MaxLoss.  An Unwatch's       *)
(*     removal frame is lossy the same way (the connection can drop        *)
(*     between the server applying the watch change and the client         *)
(*     processing the response), which is how a session reaches zero       *)
(*     watches while the client still holds — and declares — a document.   *)
(*     A push while disconnected is not recorded: the implementation       *)
(*     rolls a frame that failed to send back out of its delivery memory.  *)
(*                                                                         *)
(*   - A reconnect either RESUMES (the server still holds the session) or  *)
(*     RE-ESTABLISHES it (the session expired while disconnected).  Its    *)
(*     frame delivers every covered document whose current seq differs     *)
(*     from the diff BASE, removes every base entry the union no longer    *)
(*     covers, and elides the rest.  Mode chooses the base:                *)
(*       "memory"   the server's own delivery memory on resume, and        *)
(*                  nothing on re-establishment (full delivery) — the      *)
(*                  design before client-declared holdings;                *)
(*       "holdings" the client's declaration of what it holds, on both.    *)
(*     Catch-up frames are absorbed: the pre-watch loss they were subject  *)
(*     to is fixed and pinned separately (#6292); the residual loss class  *)
(*     is the steady-state push, which is what MaxLoss models.             *)
(*                                                                         *)
(*   - Reset models a replaced replica (`SpaceReplica.reset()` under route *)
(*     replacement): the client's state is wiped while the server session  *)
(*     survives.                                                           *)
(*                                                                         *)
(* Scope of the certification — what "holdings" mode assumes:              *)
(*                                                                         *)
(*   - The declaration IS the replica, exactly.  What the model certifies  *)
(*     is the SERVER's diff rule against a truthful declaration; the       *)
(*     CLIENT's construction of that declaration is an assumed input, and  *)
(*     each of its obligations is enforced by a unit test, not by TLC:     *)
(*     deriving it from delivered frames only — never a locally promoted   *)
(*     confirmed seq, whose claim would elide the authoritative snapshot   *)
(*     (packages/runner/test/memory-v2-reconnect-holdings.test.ts);        *)
(*     carrying branch identity, which the seq-only document state here    *)
(*     cannot represent (packages/memory/test/v2-session-holdings.test.ts, *)
(*     the cross-branch case); and the wire parse failing malformed        *)
(*     holdings rather than degrading (same file).  A client declaring     *)
(*     documents it does not hold is outside the model, as a client        *)
(*     fabricating reads is outside PendingStacks.                         *)
(*                                                                         *)
(*   - The replica advances only by absorbed delivery, reconnect, and      *)
(*     removal.  Local writes and their promotion are the commit model's   *)
(*     subject (PendingStacks.tla); they enter this model only as the      *)
(*     rule above — a promotion never enters the declaration — which is    *)
(*     what keeps the delivered-state abstraction faithful.                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Docs,        \* every document ever watched, e.g. {"d1", "d2"}
  MaxWrites,   \* bound on writes
  MaxLoss,     \* bound on frames the client fails to absorb
  AllowReset,  \* whether the replica may be wiped under a live session
  Mode         \* "memory" | "holdings"

ASSUME Mode \in {"memory", "holdings"}
ASSUME MaxWrites \in Nat \ {0}
ASSUME MaxLoss \in Nat
ASSUME AllowReset \in BOOLEAN

VARIABLES
  seq,             \* the server's current seq
  ver,             \* per document: seq of its latest write (0 = none)
  union,           \* the watch union: the documents the session covers
  mem,             \* the server's memory of what it delivered this session
  rep,             \* the client's replica: the seq it holds each doc at
  connected,       \* transport up
  alive,           \* the server still holds the session (resume possible)
  losses,          \* frames lost so far
  resets,          \* replica wipes so far
  justReconnected, \* the last step was a reconnect (the check point)
  redundant        \* some reconnect delivered a document the client held

vars == <<seq, ver, union, mem, rep, connected, alive, losses, resets,
          justReconnected, redundant>>

Nothing == [d \in Docs |-> 0]

Init ==
  /\ seq = 0
  /\ ver = Nothing
  /\ union = Docs
  /\ mem = Nothing
  /\ rep = Nothing
  /\ connected = TRUE
  /\ alive = TRUE
  /\ losses = 0
  /\ resets = 0
  /\ justReconnected = FALSE
  /\ redundant = FALSE

(* A write lands on the server.  Covered, connected, and alive, the push
   frame is recorded as delivered and the client absorbs it or loses it;
   uncovered, nothing is pushed. *)
Write(d) ==
  /\ seq < MaxWrites
  /\ seq' = seq + 1
  /\ ver' = [ver EXCEPT ![d] = seq + 1]
  /\ IF connected /\ alive /\ d \in union
     THEN /\ mem' = [mem EXCEPT ![d] = seq + 1]
          /\ \/ /\ rep' = [rep EXCEPT ![d] = seq + 1]
                /\ UNCHANGED losses
             \/ /\ losses < MaxLoss
                /\ UNCHANGED rep
                /\ losses' = losses + 1
     ELSE UNCHANGED <<mem, rep, losses>>
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<union, connected, alive, resets, redundant>>

(* The client drops a document from its watch set (`session.watch.set`
   over a live session).  The server applies the change and answers with
   the removal; the client absorbs it or loses it — the lossy path is how
   the union empties while the replica still holds a document. *)
Unwatch(d) ==
  /\ connected
  /\ alive
  /\ d \in union
  /\ union' = union \ {d}
  /\ mem' = [mem EXCEPT ![d] = 0]
  /\ \/ /\ rep' = [rep EXCEPT ![d] = 0]
        /\ UNCHANGED losses
     \/ /\ losses < MaxLoss
        /\ UNCHANGED rep
        /\ losses' = losses + 1
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<seq, ver, connected, alive, resets, redundant>>

Disconnect ==
  /\ connected
  /\ connected' = FALSE
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<seq, ver, union, mem, rep, alive, losses, resets, redundant>>

(* The session lapses while the client is away: the server forgets it. *)
Expire ==
  /\ ~connected
  /\ alive
  /\ alive' = FALSE
  /\ mem' = Nothing
  /\ UNCHANGED <<seq, ver, union, rep, connected, losses, resets,
                 justReconnected, redundant>>

(* A replaced replica: the client's state is wiped, the session is not. *)
Reset ==
  /\ AllowReset
  /\ resets < 1
  /\ rep' = Nothing
  /\ resets' = resets + 1
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<seq, ver, union, mem, connected, alive, losses, redundant>>

(* The diff base a reconnect's frame is computed against. *)
Base ==
  IF Mode = "holdings" THEN rep
  ELSE IF alive THEN mem
  ELSE Nothing

(* A reconnect's frame: every covered document whose current seq differs
   from the base is delivered, every base entry outside the union is
   removed (the zero-watch reconcile is this with union = {}), and the
   rest is elided.  Under "memory" a removal the client lost is invisible
   to the base — the server believes it absorbed — so the stale document
   is never retracted; under "holdings" the client's statement names it
   and the removal comes. *)
Reconnect ==
  /\ ~connected
  /\ connected' = TRUE
  /\ alive' = TRUE
  /\ LET base == Base
         delivered == {d \in union : ver[d] # base[d]}
         removed == {d \in Docs \ union : base[d] # 0}
     IN /\ rep' = [d \in Docs |->
                     IF d \in delivered THEN ver[d]
                     ELSE IF d \in removed THEN 0
                     ELSE rep[d]]
        /\ redundant' = (redundant \/ (\E d \in delivered : rep[d] = ver[d]))
  /\ mem' = [d \in Docs |-> IF d \in union THEN ver[d] ELSE 0]
  /\ justReconnected' = TRUE
  /\ UNCHANGED <<seq, ver, union, losses, resets>>

Next ==
  \/ \E d \in Docs : Write(d)
  \/ \E d \in Docs : Unwatch(d)
  \/ Disconnect
  \/ Expire
  \/ Reset
  \/ Reconnect

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Properties.                                                             *)
(***************************************************************************)

TypeOK ==
  /\ \A d \in Docs : rep[d] <= ver[d] /\ mem[d] <= ver[d]
  /\ losses <= MaxLoss

(* A reconnect brings the replica to the union's current state: whatever
   was lost, wiped, or written while away is held afterwards at its
   current seq, and a document the union no longer covers is not held at
   all (INV-14's uncovered-document clause).  Under "memory", a document
   the server remembers delivering but the client lost is elided forever
   on resume — the schema-doc quarantine residual — and a removal the
   client lost is never retracted; under "holdings" the client's
   statement is the base and both come back right. *)
ReconnectConverges ==
  justReconnected =>
    \A d \in Docs : rep[d] = (IF d \in union THEN ver[d] ELSE 0)

(* A reconnect never re-delivers what the client already holds.  Under
   "memory" a re-established session is delivered in full; under
   "holdings" the base is the replica on both paths. *)
NoRedundantDelivery == ~redundant

=============================================================================
