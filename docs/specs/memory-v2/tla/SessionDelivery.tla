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
(* Abstractions:                                                           *)
(*                                                                         *)
(*   - One session, one watch union: a variable subset of Docs, initially  *)
(*     all of it, that Unwatch SHRINKS — possibly to empty, which is the   *)
(*     zero-watch reconnect (a resumed declaration onto a session with no  *)
(*     watches must be retracted, not left as demand).  The union is what  *)
(*     the watches REACH, so Unwatch stands for the two ways it shrinks:   *)
(*     a watch removed, and a refresh whose re-walk no longer reaches a    *)
(*     document (04-protocol.md section 4.6.3); either sends a removal     *)
(*     frame the client may lose.  Growth is not                           *)
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
(*   - A frame can be HELD (HoldMode): delivery of `cid:` schema documents *)
(*     by reference (docs/specs/content-addressed-schemas.md, "Delivery by *)
(*     reference") names a body without sending it, and a frame naming a   *)
(*     body the client's registry lacks waits for a fetch in a queue in    *)
(*     front of the replica, bounded by MaxHeld.  The server has already   *)
(*     recorded it as delivered.  Drain is the fetch answered: a verified  *)
(*     body applies the frame at the head, and a body that could not be    *)
(*     fetched drops it, which the model counts as a loss, as the client   *)
(*     discards its delivery baseline.  A disconnect discards the queue.   *)
(*     A removal names no body, so it is held only behind another frame.   *)
(*       "none"    no frame is held: the design without references;        *)
(*       "inorder" a frame arriving while any is held queues behind it,    *)
(*                 as every later sync of a held session does (shipped);   *)
(*       "bypass"  a frame that names no missing body applies at once,     *)
(*                 ahead of the frames held before it.                     *)
(*     The replica applies a push only when it advances the document's     *)
(*     seq, the monotonic guard 09-invariants.md INV-14 states, so a held  *)
(*     push that reaches it late cannot move a document backwards; a       *)
(*     removal is not a seq, and nothing guards it.                        *)
(*                                                                         *)
(* Scope of the certification — what "holdings" mode assumes:              *)
(*                                                                         *)
(*   - The declaration IS the replica, exactly.  What the model certifies  *)
(*     is the SERVER's diff rule against a truthful declaration; the       *)
(*     CLIENT's construction of that declaration is an assumed input, and  *)
(*     each of its obligations is enforced by a unit test, not by TLC:     *)
(*     deriving it from delivered frames only — never a locally promoted   *)
(*     confirmed seq, whose claim would elide the authoritative snapshot   *)
(*     (runtime/runner/test/memory-v2-reconnect-holdings.test.ts);        *)
(*     carrying branch identity, which the seq-only document state here    *)
(*     cannot represent (runtime/memory/test/v2-session-holdings.test.ts, *)
(*     the cross-branch case); and the wire parse failing malformed        *)
(*     holdings rather than degrading (same file).  A client declaring     *)
(*     documents it does not hold is outside the model, as a client        *)
(*     fabricating reads is outside PendingStacks.                         *)
(*                                                                         *)
(*   - The replica advances only by absorbed delivery, reconnect, and      *)
(*     removal.  Local writes and their promotion are the commit model's   *)
(*     subject (PendingStacks.tla); they enter this model only as the      *)
(*     rule above — a promotion never enters the declaration — which is    *)
(*     what keeps the delivered-state abstraction faithful.  Commit        *)
(*     verdicts are not frames and are never held: a verdict processed     *)
(*     while the frames before it are held is PendingStacks.tla's channel  *)
(*     delivery, where Deliver and Integrate run independently.            *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
  Docs,        \* every document ever watched, e.g. {"d1", "d2"}
  MaxWrites,   \* bound on writes
  MaxLoss,     \* bound on frames the client fails to absorb
  AllowReset,  \* whether the replica may be wiped under a live session
  Mode,        \* "memory" | "holdings"
  HoldMode,    \* "none" | "inorder" | "bypass"
  MaxHeld      \* bound on the frames held for a body at once

ASSUME Mode \in {"memory", "holdings"}
ASSUME HoldMode \in {"none", "inorder", "bypass"}
ASSUME MaxHeld \in Nat
ASSUME (HoldMode = "none") => (MaxHeld = 0)
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
  redundant,       \* some reconnect delivered a document the client held
  held,            \* frames waiting for a body, oldest first: [d, s]
  behind           \* a frame was lost or dropped, or the replica wiped,
                   \* since the last reconnect

vars == <<seq, ver, union, mem, rep, connected, alive, losses, resets,
          justReconnected, redundant, held, behind>>

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
  /\ held = <<>>
  /\ behind = FALSE

(* A frame names one document: a push at seq s >= 1 (a tombstone is a seq
   like any other), or its removal at s = 0.  Absorbing a push the replica
   already holds at that seq or later is a no-op. *)
Absorb(r, f) ==
  [r EXCEPT ![f.d] = IF f.s = 0 THEN 0 ELSE IF f.s > @ THEN f.s ELSE @]

(* The client's handling of frame f, which the server has recorded as
   delivered: it absorbs f, loses it, or holds it for a body.  Under
   "inorder" a frame arriving while any is held queues behind the held
   ones. *)
Receive(f) ==
  IF HoldMode = "inorder" /\ held # <<>>
  THEN /\ held' = Append(held, f)
       /\ UNCHANGED <<rep, losses, behind>>
  ELSE \/ /\ rep' = Absorb(rep, f)
          /\ UNCHANGED <<held, losses, behind>>
       \/ /\ losses < MaxLoss
          /\ losses' = losses + 1
          /\ behind' = TRUE
          /\ UNCHANGED <<rep, held>>
       \/ /\ f.s # 0
          /\ Len(held) < MaxHeld
          /\ held' = Append(held, f)
          /\ UNCHANGED <<rep, losses, behind>>

(* A write lands on the server.  Covered, connected, and alive, the push
   frame is recorded as delivered and the client receives it; uncovered,
   nothing is pushed. *)
Write(d) ==
  /\ seq < MaxWrites
  /\ seq' = seq + 1
  /\ ver' = [ver EXCEPT ![d] = seq + 1]
  /\ IF connected /\ alive /\ d \in union
     THEN /\ mem' = [mem EXCEPT ![d] = seq + 1]
          /\ Receive([d |-> d, s |-> seq + 1])
     ELSE UNCHANGED <<mem, rep, losses, held, behind>>
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<union, connected, alive, resets, redundant>>

(* The client drops a document from its watch set (`session.watch.set`
   over a live session).  The server applies the change and answers with
   the removal, which the client receives like a push — the lossy path is
   how the union empties while the replica still holds a document. *)
Unwatch(d) ==
  /\ connected
  /\ alive
  /\ d \in union
  /\ union' = union \ {d}
  /\ mem' = [mem EXCEPT ![d] = 0]
  /\ Receive([d |-> d, s |-> 0])
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<seq, ver, connected, alive, resets, redundant>>

(* The fetch the frame at the head of the queue waits for is answered.  A
   verified body applies the frame.  A body that could not be fetched drops
   it: the document is not held, and the client discards its delivery
   baseline, so only a reconnect restores it. *)
Drain ==
  /\ connected
  /\ held # <<>>
  /\ \/ /\ rep' = Absorb(rep, Head(held))
        /\ UNCHANGED <<losses, behind>>
     \/ /\ Head(held).s # 0
        /\ losses < MaxLoss
        /\ losses' = losses + 1
        /\ behind' = TRUE
        /\ UNCHANGED rep
  /\ held' = Tail(held)
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<seq, ver, union, mem, connected, alive, resets, redundant>>

(* The connection drops, discarding every held frame: the server recorded
   them as delivered, and the replica never absorbed them.  Nothing marks
   the session behind for it, since SteadyConverges asks nothing of a
   disconnected session and the reconnect that follows restores it. *)
Disconnect ==
  /\ connected
  /\ connected' = FALSE
  /\ held' = <<>>
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<seq, ver, union, mem, rep, alive, losses, resets, redundant,
                 behind>>

(* The session lapses while the client is away: the server forgets it. *)
Expire ==
  /\ ~connected
  /\ alive
  /\ alive' = FALSE
  /\ mem' = Nothing
  /\ UNCHANGED <<seq, ver, union, rep, connected, losses, resets,
                 justReconnected, redundant, held, behind>>

(* A replaced replica: the client's state is wiped, the session is not. *)
Reset ==
  /\ AllowReset
  /\ resets < 1
  /\ rep' = Nothing
  /\ resets' = resets + 1
  /\ behind' = TRUE
  /\ justReconnected' = FALSE
  /\ UNCHANGED <<seq, ver, union, mem, connected, alive, losses, redundant,
                 held>>

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
  /\ behind' = FALSE
  /\ UNCHANGED <<seq, ver, union, losses, resets, held>>

Next ==
  \/ \E d \in Docs : Write(d)
  \/ \E d \in Docs : Unwatch(d)
  \/ Drain
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
  /\ held \in Seq([d : Docs, s : 0..MaxWrites])
  /\ (~connected) => (held = <<>>)
  /\ behind \in BOOLEAN

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

(* Between reconnects, a session whose frames have all arrived is current:
   with nothing held, and nothing lost, dropped or wiped since the last
   reconnect, the replica holds every covered document at its current seq
   and no uncovered one.  ReconnectConverges checks only the reconnect;
   this is the same statement for every quiet point between. *)
SteadyConverges ==
  (connected /\ held = <<>> /\ ~behind) =>
    \A d \in Docs : rep[d] = (IF d \in union THEN ver[d] ELSE 0)

=============================================================================
