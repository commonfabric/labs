--------------------------- MODULE PendingStacks ---------------------------
(***************************************************************************)
(* A bounded model of the Memory v2 pending-stack commit protocol          *)
(* (docs/specs/memory-v2/03-commit-model.md sections 3.3-3.6), built to    *)
(* check the invariant catalog (09-invariants.md) over all small           *)
(* interleavings for each dependency-recording and staleness-basis         *)
(* variant.                                                                *)
(*                                                                         *)
(* Abstractions (see tla/README.md for the full argument):                 *)
(*                                                                         *)
(*   - One space, one branch, one scope, one document whose leaf paths     *)
(*     are the constant set Paths.  Overlap collapses to path equality;    *)
(*     the Tier-1 path-blind set/delete check and the ancestor/descendant  *)
(*     structure of real paths are not modeled (they only widen conflict   *)
(*     detection, i.e. move within INV-2's safe direction).                *)
(*                                                                         *)
(*   - Every write is an append: the value of a path is the SET of         *)
(*     accepted commits that wrote it.  A read's observation is recorded   *)
(*     as its contributor sets (confirmed seqs + pending localSeqs), and   *)
(*     coherence is set equality against durable history at the reader's   *)
(*     resolution seq.  This models mergeable/blind writes directly and    *)
(*     makes both failure directions of INV-1 visible: a phantom           *)
(*     contributor (CT-1872 "1c") and a missed concurrent write            *)
(*     (CT-1910).                                                          *)
(*                                                                         *)
(*   - Each commit carries one value from the constant set Values, which   *)
(*     every path it writes receives.  A path's CONTENT is the set of      *)
(*     values its accepted writes carried, so writing a value the path     *)
(*     already holds changes nothing: that is the identity commit of       *)
(*     03-commit-model.md section 3.6.1 in this abstraction, and the       *)
(*     set-union fold is the idempotence its patch rule requires.  A       *)
(*     single value already makes a stale re-write of it an identity;      *)
(*     the second value is what exercises the other side, a write the      *)
(*     proof must refuse, and IdentityMode is what turns elision on.       *)
(*                                                                         *)
(*   - All modeled reads project explicitly elidable document-only        *)
(*     dependencies. Required validation classes and external effects are  *)
(*     outside this model; their staleness is never waived by the engine.  *)
(*                                                                         *)
(*   - Verdict delivery is a mode (DeliveryMode below).  "atomic" fuses    *)
(*     the server's verdict with the client's mirrored effects, the       *)
(*     original abstraction; "channel" splits them: the server decides,    *)
(*     and the client PROCESSES each verdict later by an explicit Deliver  *)
(*     step (in submission order) - for a rejection, the drop and the      *)
(*     transitive cascade.  Deliver models the processing point, not the   *)
(*     transact response's arrival: the implementation holds a rejection's *)
(*     drop for the covering fan-out frame (the read-repair gate), so the  *)
(*     revert and the winning data land as one visible transition and      *)
(*     re-run actions read repaired state.  The window between the         *)
(*     response and that processing is deliberately collapsed into the     *)
(*     Deliver step: a commit built there records the same dependency      *)
(*     array as one built before the response (the layer stands either     *)
(*     way), so the extra interleavings add no observably distinct         *)
(*     states, and the model covers verdict-time and frame-time drop       *)
(*     policies alike.  The channel mode is what brings INV-6              *)
(*     (accepted-versus-dropped agreement) and the                         *)
(*     decided-but-not-yet-applied window of CT-1927 verdict parking into  *)
(*     scope, and it is where sparse dependency arrays                     *)
(*     (03-commit-model.md section 3.5) earn their keep: a commit built    *)
(*     after a processed rejection's drop records only the surviving       *)
(*     layers.                                                             *)
(*                                                                         *)
(*   - Per-session server processing is FIFO, which is INV-5 by            *)
(*     construction (the current implementation rejects rather than        *)
(*     holds, preserving the same order).                                  *)
(*                                                                         *)
(* Modes:                                                                  *)
(*                                                                         *)
(*   DepMode - how a commit that reads path p through the pending stack    *)
(*     records its dependency set (INV-3):                                 *)
(*       "fullstack" shipped #4606 shape: every pending layer of the       *)
(*                   reader's view.                                        *)
(*       "filtered"  proposed CT-1872 refinement: layers whose footprint   *)
(*                   overlaps p, plus always the top-of-stack layer.       *)
(*                                                                         *)
(*   BasisMode - where the staleness scan for a pending read starts:       *)
(*       "maxdep"    legacy: served only to pending reads that carry no    *)
(*                   basisSeq; scans from the resolution seq of the        *)
(*                   highest recorded dependency (CT-1910's over-advance). *)
(*       "confirmed" CT-1910 repair, shipped: clients declare basisSeq     *)
(*                   and the scan runs from that confirmed basis with the  *)
(*                   reader's own session excluded.                        *)
(*                                                                         *)
(*   DeliveryMode - when the client PROCESSES a verdict (see above):        *)
(*       "atomic"    verdict and mirrored client effects in one action.    *)
(*       "channel"   verdicts processed later, in order, by Deliver.       *)
(*                                                                         *)
(*   IdentityMode - what a staleness refusal does with a commit whose      *)
(*     writes would change nothing (03-commit-model.md section 3.6.1):     *)
(*       "none"      refuse it, like any stale commit.                     *)
(*       "elide"     shipped: prove the identity against the stored        *)
(*                   content and the content at the reader's basis, and   *)
(*                   accept the commit with every write elided - it takes  *)
(*                   a seq and resolves its localSeq but appends nothing   *)
(*                   to any path's content.  The proof runs only on a      *)
(*                   staleness refusal; a dead dependency still refuses.   *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Sessions,     \* logical sessions, e.g. {"s1", "s2"}
  Paths,        \* leaf paths of the single modeled document, e.g. {"p1", "p2"}
  Values,       \* values a commit may write, e.g. {"a", "b"}
  MaxTotal,     \* bound on the total number of commits built, all sessions
  DepMode,      \* "fullstack" | "filtered"
  BasisMode,    \* "maxdep" | "confirmed"
  DeliveryMode, \* "atomic" | "channel"
  IdentityMode  \* "none" | "elide"

ASSUME DepMode \in {"fullstack", "filtered"}
ASSUME BasisMode \in {"maxdep", "confirmed"}
ASSUME DeliveryMode \in {"atomic", "channel"}
ASSUME IdentityMode \in {"none", "elide"}
ASSUME Values # {}
ASSUME MaxTotal \in Nat \ {0}

VARIABLES
  log,        \* accepted commit log; seq n is log[n]
  pend,       \* per session: the pending stack (layers the client's view
              \* still sits on: undecided, decided-but-unprocessed, and
              \* accepted-not-yet-integrated commits, in localSeq order)
  res,        \* per session, per localSeq: SERVER verdict [st, seq]
              \* st \in {"none", "acc", "rej"}; seq is 0 unless st = "acc"
  known,      \* per session, per localSeq: the fate the client has
              \* PROCESSED ("none" | "acc" | "rej"); trails res in channel
              \* mode, mirrors it in atomic mode.  Processing is asymmetric
              \* by fate: for an accept it is mere receipt (promotion still
              \* parks until Integrate), while for a rejection it is
              \* APPLICATION - the drop and cascade - which the
              \* implementation defers to the covering frame even though
              \* the verdict itself is known at the transact response
              \* (fate callbacks fire there).  That receipt-to-application
              \* gap is the collapsed window argued in the header.  A
              \* cascade victim's "rej" is fabricated locally, possibly
              \* before its server verdict.
  localrej,   \* per session: localSeqs the client rejected locally (cascade
              \* victims of a processed rejection) - the INV-6 witness set
  nextLocal,  \* per session: next localSeq to assign
  csn,        \* per session: confirmed seq (integrated log prefix length)
  built       \* total commits built (bound: MaxTotal)

vars == <<log, pend, res, known, localrej, nextLocal, csn, built>>

LSeqs == 1..MaxTotal

Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Min(S) == CHOOSE x \in S : \A y \in S : x <= y

(***************************************************************************)
(* Client-side view at build time (single-snapshot rule: Build is one      *)
(* atomic action against csn[s] plus the current pending stack).           *)
(***************************************************************************)

StackIdx(s) == DOMAIN pend[s]
StackLseqs(s) == {pend[s][j].lseq : j \in StackIdx(s)}
LayersWriting(s, p) ==
  {pend[s][j].lseq : j \in {i \in StackIdx(s) : p \in pend[s][i].writes}}
ObsConfirmed(s, p) == {i \in 1..csn[s] : p \in log[i].writes}

(* The read record a client produces for path p: kind, recorded dependency
   set (per DepMode), the confirmed basis at build time, and the observed
   contributor sets that ReadCoherence later checks.  The recorded set is
   drawn from the CURRENT stack, so in channel mode a build after a
   delivered rejection's drop is sparse relative to session history -
   exactly the view-relative completeness of 03-commit-model.md section
   3.5. *)
ReadRecord(s, p) ==
  LET stack == StackLseqs(s)
      wl == LayersWriting(s, p)
      isPending == stack # {}
      deps ==
        CASE DepMode = "fullstack" -> stack
          [] DepMode = "filtered" ->
               wl \cup (IF stack # {} THEN {Max(stack)} ELSE {})
  IN [path |-> p,
      kind |-> IF isPending THEN "pending" ELSE "confirmed",
      deps |-> IF isPending THEN deps ELSE {},
      cbasis |-> csn[s],
      obsC |-> ObsConfirmed(s, p),
      obsP |-> wl]

Build(s, R, W, v) ==
  /\ built < MaxTotal
  /\ LET c == [lseq |-> nextLocal[s],
               writes |-> W,
               val |-> v,
               reads |-> {ReadRecord(s, p) : p \in R}]
     IN pend' = [pend EXCEPT ![s] = Append(@, c)]
  /\ nextLocal' = [nextLocal EXCEPT ![s] = @ + 1]
  /\ built' = built + 1
  /\ UNCHANGED <<log, res, known, localrej, csn>>

(***************************************************************************)
(* Server admission (FIFO within a session).  In atomic mode the client's  *)
(* mirrored drop cascade is fused into rejection; in channel mode          *)
(* rejection is server-side only and the client's effects wait for         *)
(* Deliver.                                                                *)
(***************************************************************************)

Unresolved(s) == {j \in StackIdx(s) : res[s][pend[s][j].lseq].st = "none"}

ScanBasis(s, r) ==
  IF r.kind = "confirmed" THEN r.cbasis
  ELSE IF BasisMode = "maxdep" THEN res[s][Max(r.deps)].seq
  ELSE r.cbasis

(* A write at log index i invalidates read r of session s when it touches
   the read path inside the scan interval -- except that the "confirmed"
   basis mode excludes the reader's own resolved session stack from the
   pending-read scan (the CT-1910 repair). *)
InvalidatedBy(s, r, i, k) ==
  /\ i > ScanBasis(s, r)
  /\ i < k
  /\ r.path \in log[i].writes
  /\ ((BasisMode = "confirmed" /\ r.kind = "pending") => log[i].sess # s)

HasConflict(s, c, k) ==
  \E r \in c.reads : \E i \in DOMAIN log : InvalidatedBy(s, r, i, k)

DepsOf(c) == UNION {r.deps : r \in c.reads}

(* A named dependency that is not accepted at processing time can never
   resolve: FIFO decides lower localSeqs first, so a dependency still
   marked "none" is one the client dropped from its stack before the
   server ever decided it.  Mirrors resolvePendingReads' "pending
   dependency not resolved" rejection.  In atomic mode this predicate is
   unreachable (a dead layer leaves every stack in the same action that
   rejects it), which is exactly why the fused abstraction could omit it. *)
HasDeadDep(s, c) == \E d \in DepsOf(c) : res[s][d].st # "acc"

(* Transitive client-side cascade: dropping localSeq set D also drops every
   stacked commit whose recorded dependency set names a member of D. *)
RECURSIVE Doomed(_, _)
Doomed(s, D) ==
  LET more == {pend[s][j].lseq : j \in {i \in StackIdx(s) :
                 /\ pend[s][i].lseq \notin D
                 /\ DepsOf(pend[s][i]) \cap D # {}}}
  IN IF more = {} THEN D ELSE Doomed(s, D \cup more)

(* Atomic-mode rejection: the server verdict, the client's drop of every
   doomed layer, and the client's knowledge of all of it, in one action.
   Cascade victims are marked rejected in res as well - the fused
   abstraction does not distinguish a server dep-edge rejection from a
   local one. *)
AtomicReject(s, c) ==
  LET D == Doomed(s, {c.lseq})
  IN /\ res' = [res EXCEPT ![s] =
                  [l \in LSeqs |->
                     IF l \in D THEN [st |-> "rej", seq |-> 0]
                     ELSE res[s][l]]]
     /\ known' = [known EXCEPT ![s] =
                    [l \in LSeqs |-> IF l \in D THEN "rej" ELSE known[s][l]]]
     /\ pend' = [pend EXCEPT ![s] = SelectSeq(@, LAMBDA e : e.lseq \notin D)]
     /\ UNCHANGED <<log, localrej, csn, nextLocal, built>>

(* Channel-mode rejection: the verdict alone.  The layer stands in pend -
   visible to dependency recording - until Deliver runs the drop. *)
ChannelReject(s, c) ==
  /\ res' = [res EXCEPT ![s][c.lseq] = [st |-> "rej", seq |-> 0]]
  /\ UNCHANGED <<log, pend, known, localrej, csn, nextLocal, built>>

(* Content: the set of values the accepted writes to a path carried.
   ContentBelow(p, k) is the content a commit admitted at seq k finds
   stored; ContentAt(p, n) is the content at seq n inclusive, which is what
   a reader whose basis is n saw. *)
DurableWriters(p, k) == {i \in 1..(k - 1) : p \in log[i].writes}
ContentBelow(p, k) == {log[i].val : i \in DurableWriters(p, k)}
ContentAt(p, n) == ContentBelow(p, n + 1)

(* The content the reader SAW at p, reconstructed from the commit's own
   read of p as the engine's basisOf does: a confirmed read's content at
   its basis; a pending read's content at its confirmed basis plus the
   values the own layers it names wrote to p - an elided layer's included,
   since the client folded that write whether or not the server recorded
   a revision for it; and the stored content itself when the commit did
   not read p (a write with no read is an identity only where it is
   idempotent).  What this is NOT is the durable content at a named
   layer's resolution: that carries every foreign write that landed
   before the layer, which the reader had not integrated, and judging
   from it accepts a write the reader's own view would not have produced
   (the reviewed defect this definition replaced). *)
LayerVal(s, d) ==
  IF res[s][d].st = "acc" THEN {log[res[s][d].seq].val} ELSE {}
LayerWrote(s, d, p) ==
  /\ res[s][d].st = "acc"
  /\ p \in log[res[s][d].seq].writes \cup log[res[s][d].seq].elided
ObservedContent(s, c, p, k) ==
  IF \E r \in c.reads : r.path = p
  THEN LET r == CHOOSE r \in c.reads : r.path = p
       IN ContentAt(p, r.cbasis) \cup
            UNION {LayerVal(s, d) : d \in {d \in r.deps : LayerWrote(s, d, p)}}
  ELSE ContentBelow(p, k)

(* The identity proof of 03-commit-model.md section 3.6.1 over content:
   for every path the commit writes, folding its value onto the content
   the reader saw yields the stored content, and folding it onto the
   stored content leaves that unchanged.  Under the set-union fold the
   second half is membership and the first says nothing but the commit's
   own value landed on the path since the reader's view.  Only reachable
   from a staleness refusal; HasDeadDep is decided first. *)
IsIdentity(s, c, k) ==
  /\ IdentityMode = "elide"
  /\ \A p \in c.writes :
       /\ c.val \in ContentBelow(p, k)
       /\ ContentBelow(p, k) \subseteq ObservedContent(s, c, p, k) \cup {c.val}

(* An elided acceptance appends an entry with no writes: the commit takes
   seq k and resolves its localSeq like any accepted commit, and records
   what it would have written under `elided` for the invariants below. *)
Accept(s, c, k, elide) ==
  /\ log' = Append(log, [sess |-> s, lseq |-> c.lseq,
                         writes |-> IF elide THEN {} ELSE c.writes,
                         elided |-> IF elide THEN c.writes ELSE {},
                         val |-> c.val, reads |-> c.reads])
  /\ res' = [res EXCEPT ![s][c.lseq] = [st |-> "acc", seq |-> k]]
  /\ known' = IF DeliveryMode = "atomic"
              THEN [known EXCEPT ![s][c.lseq] = "acc"]
              ELSE known
  /\ UNCHANGED <<pend, localrej, csn, nextLocal, built>>

Reject(s, c) ==
  IF DeliveryMode = "atomic" THEN AtomicReject(s, c) ELSE ChannelReject(s, c)

Process(s) ==
  /\ Unresolved(s) # {}
  /\ LET c == pend[s][Min(Unresolved(s))]
         k == Len(log) + 1
     IN IF HasDeadDep(s, c)
        THEN Reject(s, c)
        ELSE IF HasConflict(s, c, k)
             THEN IF IsIdentity(s, c, k)
                  THEN Accept(s, c, k, TRUE)
                  ELSE Reject(s, c)
             ELSE Accept(s, c, k, FALSE)

(***************************************************************************)
(* Verdict processing (channel mode).  Deliver is the point where the      *)
(* client PROCESSES a verdict, in submission order; per the header, the    *)
(* implementation's processing point for a rejection is the covering       *)
(* fan-out frame (the read-repair gate), and the window between the        *)
(* transact response and that processing is collapsed into this step.      *)
(* Processing an accept only records knowledge (promotion still waits for  *)
(* Integrate, the CT-1927 parking); processing a rejection runs the drop   *)
(* and the transitive cascade, fabricating local rejections for the        *)
(* victims (recorded in localrej - the INV-6 witness).  A verdict for a    *)
(* localSeq the client already rejected locally is never processed: known  *)
(* is already set, which is the model's suppressed-late-verdict.           *)
(***************************************************************************)

Unprocessed(s) == {l \in LSeqs : res[s][l].st # "none" /\ known[s][l] = "none"}

Deliver(s) ==
  /\ DeliveryMode = "channel"
  /\ Unprocessed(s) # {}
  /\ LET l == Min(Unprocessed(s))
     IN IF res[s][l].st = "acc"
        THEN /\ known' = [known EXCEPT ![s][l] = "acc"]
             /\ UNCHANGED <<pend, localrej>>
        ELSE LET D == Doomed(s, {l})
             IN /\ known' = [known EXCEPT ![s] =
                               [m \in LSeqs |->
                                  IF m \in D THEN "rej" ELSE known[s][m]]]
                /\ localrej' = [localrej EXCEPT ![s] = @ \cup (D \ {l})]
                /\ pend' = [pend EXCEPT ![s] =
                              SelectSeq(@, LAMBDA e : e.lseq \notin D)]
  /\ UNCHANGED <<log, res, csn, nextLocal, built>>

(***************************************************************************)
(* Integration: the client advances its confirmed view one log entry at a  *)
(* time; integrating its own accepted commit removes that pending layer -  *)
(* the parked promotion.  The guard on own entries models the section      *)
(* 4.11 server obligation that a commit's transact response is sent        *)
(* before any frame whose marker covers it: the covering frame cannot      *)
(* arrive ahead of the verdict.                                            *)
(***************************************************************************)

Integrate(s) ==
  /\ csn[s] < Len(log)
  /\ LET e == log[csn[s] + 1]
     IN /\ (e.sess = s) => (known[s][e.lseq] = "acc")
        /\ pend' = IF e.sess = s
                   THEN [pend EXCEPT ![s] =
                           SelectSeq(@, LAMBDA x : x.lseq # e.lseq)]
                   ELSE pend
  /\ csn' = [csn EXCEPT ![s] = @ + 1]
  /\ UNCHANGED <<log, res, known, localrej, nextLocal, built>>

(***************************************************************************)
(* Specification.                                                          *)
(***************************************************************************)

ReadChoices == {{}} \cup {{p} : p \in Paths}
WriteChoices == (SUBSET Paths) \ {{}}

(* Override target for deeper bounded runs (see PendingStacks_Filtered5.cfg):
   restricting builds to single-path writes keeps MaxTotal = 5 tractable. *)
SingletonWrites == {{p} : p \in Paths}

Init ==
  /\ log = <<>>
  /\ pend = [s \in Sessions |-> <<>>]
  /\ res = [s \in Sessions |-> [l \in LSeqs |-> [st |-> "none", seq |-> 0]]]
  /\ known = [s \in Sessions |-> [l \in LSeqs |-> "none"]]
  /\ localrej = [s \in Sessions |-> {}]
  /\ nextLocal = [s \in Sessions |-> 1]
  /\ csn = [s \in Sessions |-> 0]
  /\ built = 0

Next ==
  \/ \E s \in Sessions : \E R \in ReadChoices : \E W \in WriteChoices :
       \E v \in Values : Build(s, R, W, v)
  \/ \E s \in Sessions : Process(s)
  \/ \E s \in Sessions : Deliver(s)
  \/ \E s \in Sessions : Integrate(s)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants (IDs from docs/specs/memory-v2/09-invariants.md).            *)
(***************************************************************************)

(* INV-1.  The contributor set a read observed, mapped through resolution
   (a rejected or unresolved pending contributor maps to 0, which is never
   durable), equals the set of accepted writes to that path below the
   reader's own seq.  This is the writer-set form: it is the invariant
   whenever IdentityMode is "none", and it is deliberately NOT the
   statement under "elide".  An elided commit's own observation is stale
   by construction, which is the exemption 09-invariants.md records under
   INV-1; and even restricted to commits that wrote something
   (ReadCoherenceOfWrites) the writer-set form fails, because an elided
   layer stays in its session's stack and is observed there as a
   contributor while durable history holds the foreign write that carried
   the same value instead, so the writer sets differ where the content
   does not.  ContentCoherence below is the form that mode is held to. *)
MappedObs(s, r) == r.obsC \cup {res[s][d].seq : d \in r.obsP}

ReadCoherence ==
  \A k \in DOMAIN log :
    \A r \in log[k].reads :
      MappedObs(log[k].sess, r) = DurableWriters(r.path, k)

ReadCoherenceOfWrites ==
  \A k \in DOMAIN log :
    log[k].writes # {} =>
      \A r \in log[k].reads :
        MappedObs(log[k].sess, r) = DurableWriters(r.path, k)

(* INV-1 over content.  The content a read observed - the values of its
   confirmed contributors plus the values its pending layers carried, an
   elided layer's included, since the client's view folds its own pending
   write whether or not the server recorded a revision for it - equals the
   content durable below the reader's own seq.  Every accepted commit that
   wrote something is held to it; an elided commit is the deviation
   09-invariants.md records under INV-1: its observation may be stale, and
   it produced no write for that staleness to have misled. *)
ObsContent(s, r) ==
  {log[i].val : i \in r.obsC} \cup UNION {LayerVal(s, d) : d \in r.obsP}

ContentCoherence ==
  \A k \in DOMAIN log :
    log[k].writes # {} =>
      \A r \in log[k].reads :
        ObsContent(log[k].sess, r) = ContentBelow(r.path, k)

(* An elided commit changed nothing: every path it would have written
   already held its value at its resolution point. *)
ElidedUnchanged ==
  \A k \in DOMAIN log :
    \A p \in log[k].elided : log[k].val \in ContentBelow(p, k)

(* INV-4 (with INV-3(a)): no accepted commit names a dependency that did
   not itself resolve to acceptance. *)
CascadeTotality ==
  \A k \in DOMAIN log :
    \A r \in log[k].reads :
      \A d \in r.deps : res[log[k].sess][d].st = "acc"

(* INV-5: within a session, resolution seq is monotonic in localSeq. *)
MonotonicResolution ==
  \A s \in Sessions : \A l1, l2 \in LSeqs :
    (l1 < l2 /\ res[s][l1].st = "acc" /\ res[s][l2].st = "acc")
      => res[s][l1].seq < res[s][l2].seq

(* INV-6: server and client never disagree about a commit's fate - a
   commit the client rejected locally (a cascade victim, dropped ahead of
   or instead of its own server verdict) is never durably accepted.  In
   the model this rests on FIFO plus the dead-dependency admission rule;
   the invariant is what makes that reasoning checked rather than
   assumed. *)
AcceptedVersusDropped ==
  \A s \in Sessions : \A l \in LSeqs :
    l \in localrej[s] => res[s][l].st # "acc"

TypeOK ==
  /\ built \in 0..MaxTotal
  /\ Len(log) <= built
  /\ \A s \in Sessions : csn[s] <= Len(log)
  /\ \A s \in Sessions : \A l \in LSeqs :
       known[s][l] \in {"none", "acc", "rej"}
  /\ \A s \in Sessions : localrej[s] \subseteq LSeqs

=============================================================================
