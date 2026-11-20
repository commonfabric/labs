----------------------- MODULE LocalSessionDocuments -----------------------
(***************************************************************************)
(* A bounded model of local session documents: a client that keeps its     *)
(* own session-scoped document in its replica and never sends it           *)
(* (docs/specs/memory-v2/03-commit-model.md section 3.2, the               *)
(* localSessionDocuments flag under client execution).  It extends         *)
(* PendingStacks.tla with the client-side machinery that mode adds, and    *)
(* takes the server's admission rule from that module unchanged: the       *)
(* server is given no session read, write or dependency, so HasDeadDep     *)
(* and HasConflict here are the operators the pending-stack rows certify.  *)
(*                                                                         *)
(* What the model adds:                                                    *)
(*                                                                         *)
(*   - A second document per session, whose leaf paths are LocalPaths.     *)
(*     Only its own session reads or writes it.  Its confirmed tier        *)
(*     (lval, lcs) lives on the client, and a write to it is confirmed     *)
(*     under its commit's localSeq rather than a server seq.               *)
(*                                                                         *)
(*   - Dependency arrays per document.  A read of the shared document      *)
(*     names the pending layers that wrote the shared document, and a      *)
(*     read of the local document names the pending layers that wrote the  *)
(*     local one.  A commit that wrote only the local document is          *)
(*     therefore never named to the server, which holds no commit row for  *)
(*     it.                                                                 *)
(*                                                                         *)
(*   - Three dispositions of a built commit.  One that touched nothing     *)
(*     shared settles on the client.  One that wrote or read the shared    *)
(*     document travels with its local reads and writes removed: a mixed   *)
(*     commit carries its shared writes, and a commit whose writes are     *)
(*     all local travels with none, for validation of its shared reads.    *)
(*     Either way the verdict decides the local writes too: an accept      *)
(*     promotes them when the commit integrates, and a rejection drops     *)
(*     the whole layer.                                                    *)
(*                                                                         *)
(*   - The hold.  Before a commit is sent or settled it waits for every    *)
(*     pending layer of the local document that stood beneath it, when it  *)
(*     read the local document (the server cannot refuse it for a          *)
(*     rejected local dependency) or wrote it (promotion order).  A held   *)
(*     commit is sent after later commits that were not held, so the       *)
(*     server no longer admits a session's commits in localSeq order:      *)
(*     the queue of sent commits (sendq) replaces the FIFO-by-construction *)
(*     admission of PendingStacks.tla, and INV-5 becomes a checked         *)
(*     property rather than a structural one.                              *)
(*                                                                         *)
(*   - The client's cascade over local dependencies.  A processed          *)
(*     rejection drops every standing commit that read either document     *)
(*     through the rejected layer.                                         *)
(*                                                                         *)
(* Abstractions beyond those of PendingStacks.tla:                         *)
(*                                                                         *)
(*   - The shipped shapes only: full-stack dependency recording, the       *)
(*     confirmed staleness basis, delayed verdict delivery, no identity    *)
(*     elision, the replay view.  The ASSUME below pins them.              *)
(*                                                                         *)
(*   - A commit that is not held is sent, or settled, in the action that   *)
(*     builds it.  The implementation reaches the wire a few microtask     *)
(*     turns after the build, in build order, so no commit is built in     *)
(*     between that a held commit could not also precede.                  *)
(*                                                                         *)
(*   - The client processes verdicts in the order the server decided       *)
(*     them (vq), which is the order of PendingStacks.tla's Deliver        *)
(*     wherever sends are in localSeq order.                               *)
(*                                                                         *)
(*   - No commit preconditions, so the origin-committed guard and its      *)
(*     local check are out of scope, as are route replacement and          *)
(*     explicitly named foreign session instances, which the server        *)
(*     admits like any shared document.                                    *)
(*                                                                         *)
(* HoldMode selects which clauses of the hold are in force:                *)
(*                                                                         *)
(*   "shipped"       both clauses.                                         *)
(*   "noWriteOrder"  a commit that wrote the local document does not wait  *)
(*                   for the layers beneath it.  A local-only write then   *)
(*                   confirms over a mixed commit still awaiting its       *)
(*                   verdict, and that commit's promotion finds a          *)
(*                   confirmed seq above its own and is skipped.           *)
(*   "noReadHold"    a commit that read the local document does not wait   *)
(*                   for the layers it read through.  It reaches a server  *)
(*                   that cannot see the dependency, which accepts what    *)
(*                   the client goes on to drop.                           *)
(***************************************************************************)
EXTENDS PendingStacks

CONSTANTS
  LocalPaths,   \* leaf paths of a session's own local document, e.g. {"q"}
  HoldMode      \* "shipped" | "noWriteOrder" | "noReadHold"

ASSUME LocalPaths \cap Paths = {}
ASSUME HoldMode \in {"shipped", "noWriteOrder", "noReadHold"}
ASSUME /\ DepMode = "fullstack"
       /\ BasisMode = "confirmed"
       /\ DeliveryMode = "channel"
       /\ IdentityMode = "none"
       /\ ViewMode = "replay"

VARIABLES
  phase,      \* per session, per localSeq: where the client has taken the
              \* commit - "none" (not built), "held" (waiting on the hold),
              \* "sent" (handed to the server), "local" (settled on the
              \* client, accepted), "dead" (dropped while held, never sent)
  sendq,      \* per session: the commits sent and not yet decided, in send
              \* order, as the wire carries them (shared reads and writes)
  vq,         \* per session: localSeqs the server has decided whose verdict
              \* the client has not processed, in decision order
  lval,       \* per session, per local path: the localSeqs whose writes the
              \* local document's confirmed tier holds
  lcs,        \* per session: the local document's confirmed seq, which is
              \* the localSeq of the last commit promoted into it
  meta,       \* per session, per localSeq: the local half of the commit -
              \* the local paths it wrote (lw), its local read records (lr),
              \* and the layers its hold waits for (hold).  History: kept
              \* after the commit leaves the stack, for the invariants.
  heldRefused \* whether the server has refused a commit whose only
              \* unresolved dependencies were commits the client was holding

lvars == <<phase, sendq, vq, lval, lcs, meta, heldRefused>>

(***************************************************************************)
(* The client's view of each document at build time.                       *)
(***************************************************************************)

LW(s, l) == meta[s][l].lw

(* The pending layers of each document: a layer belongs to a document's
   stack when its commit wrote that document. *)
SharedLayers(s) ==
  {pend[s][j].lseq : j \in {i \in StackIdx(s) : pend[s][i].writes # {}}}
LocalLayers(s) ==
  {pend[s][j].lseq : j \in {i \in StackIdx(s) : LW(s, pend[s][i].lseq) # {}}}

(* The read record for a shared path, in the shipped shape of
   PendingStacks.tla's ReadRecord with the stack narrowed to the shared
   document's own layers. *)
SharedRead(s, p) ==
  LET stack == SharedLayers(s)
  IN [path |-> p,
      kind |-> IF stack # {} THEN "pending" ELSE "confirmed",
      deps |-> stack,
      cbasis |-> csn[s],
      obsC |-> ObsConfirmed(s, p),
      obsP |-> ObsPending(s, p)]

(* The read record for a local path.  It never reaches the wire: the
   client's cascade and the hold are what act on its dependency set. *)
LocalRead(s, q) ==
  [path |-> q,
   deps |-> LocalLayers(s),
   obsC |-> lval[s][q],
   obsP |-> {l \in LocalLayers(s) : q \in LW(s, l)}]

(* The layers a commit waits for before it is sent or settled. *)
HoldDeps(s, LR, LWr) ==
  IF \/ (LR # {} /\ HoldMode # "noReadHold")
     \/ (LWr # {} /\ HoldMode # "noWriteOrder")
  THEN LocalLayers(s)
  ELSE {}

(* Promotion of a commit's local writes into the confirmed tier.  The
   guard is the replica's: a document's confirmed version is replaced only
   by one with a higher seq, and for the local document that seq is the
   commit's localSeq.  A commit promoted beneath a later one therefore
   leaves no write behind - which the hold's write clause exists to make
   unreachable. *)
PromoteLocal(s, l, lw) ==
  IF lw # {} /\ lcs[s] < l
  THEN /\ lval' = [lval EXCEPT ![s] =
                     [q \in LocalPaths |->
                        IF q \in lw THEN lval[s][q] \cup {l} ELSE lval[s][q]]]
       /\ lcs' = [lcs EXCEPT ![s] = l]
  ELSE UNCHANGED <<lval, lcs>>

Layer(s, l) == pend[s][CHOOSE j \in StackIdx(s) : pend[s][j].lseq = l]

WithoutLayers(s, D) ==
  [pend EXCEPT ![s] = SelectSeq(@, LAMBDA e : e.lseq \notin D)]

(***************************************************************************)
(* Build.  One atomic action against the client's snapshot of both         *)
(* documents.  A commit with no hold is dispatched here: settled when      *)
(* nothing it touched is shared, sent otherwise.                           *)
(***************************************************************************)

LocalBuild(s, R, W, LR, LWr, v) ==
  /\ built < MaxTotal
  /\ W \cup LWr # {}
  /\ LET l == nextLocal[s]
         c == [lseq |-> l, writes |-> W, val |-> v,
               reads |-> {SharedRead(s, p) : p \in R}]
         hold == HoldDeps(s, LR, LWr)
     IN /\ meta' = [meta EXCEPT ![s][l] =
                      [lw |-> LWr,
                       lr |-> {LocalRead(s, q) : q \in LR},
                       hold |-> hold]]
        /\ IF hold # {}
           THEN /\ pend' = [pend EXCEPT ![s] = Append(@, c)]
                /\ phase' = [phase EXCEPT ![s][l] = "held"]
                /\ UNCHANGED <<sendq, known, lval, lcs>>
           ELSE IF W = {} /\ R = {}
           THEN /\ PromoteLocal(s, l, LWr)
                /\ phase' = [phase EXCEPT ![s][l] = "local"]
                /\ known' = [known EXCEPT ![s][l] = "acc"]
                /\ UNCHANGED <<pend, sendq>>
           ELSE /\ pend' = [pend EXCEPT ![s] = Append(@, c)]
                /\ phase' = [phase EXCEPT ![s][l] = "sent"]
                /\ sendq' = [sendq EXCEPT ![s] = Append(@, c)]
                /\ UNCHANGED <<known, lval, lcs>>
  /\ nextLocal' = [nextLocal EXCEPT ![s] = @ + 1]
  /\ built' = built + 1
  /\ UNCHANGED <<log, res, localrej, csn, vq, heldRefused>>

(***************************************************************************)
(* Release.  Every layer a held commit waited for has left the stack:      *)
(* promoted, or dropped.  A commit that read through a dropped layer was   *)
(* dropped with it and is "dead", so what is released here stands on       *)
(* accepted local state.                                                   *)
(***************************************************************************)

LocalRelease(s, l) ==
  /\ phase[s][l] = "held"
  /\ meta[s][l].hold \cap StackLseqs(s) = {}
  /\ LET c == Layer(s, l)
     IN IF c.writes = {} /\ c.reads = {}
        THEN /\ PromoteLocal(s, l, LW(s, l))
             /\ pend' = WithoutLayers(s, {l})
             /\ phase' = [phase EXCEPT ![s][l] = "local"]
             /\ known' = [known EXCEPT ![s][l] = "acc"]
             /\ UNCHANGED sendq
        ELSE /\ phase' = [phase EXCEPT ![s][l] = "sent"]
             /\ sendq' = [sendq EXCEPT ![s] = Append(@, c)]
             /\ UNCHANGED <<pend, known, lval, lcs>>
  /\ UNCHANGED <<log, res, localrej, nextLocal, csn, built, vq, meta,
                 heldRefused>>

(***************************************************************************)
(* Server admission, in the order commits were sent.  The rule is          *)
(* PendingStacks.tla's: a dependency without an accepted commit row        *)
(* refuses the commit, then the staleness scan decides.  A dependency the  *)
(* client is still holding has no row either, and refuses its reader the   *)
(* same way; heldRefused records that such a refusal happened.             *)
(***************************************************************************)

Unaccepted(s, c) == {d \in DepsOf(c) : res[s][d].st # "acc"}

LocalProcess(s) ==
  /\ sendq[s] # <<>>
  /\ LET c == Head(sendq[s])
         k == Len(log) + 1
     IN /\ IF HasDeadDep(s, c) \/ HasConflict(s, c, k)
           THEN /\ res' = [res EXCEPT ![s][c.lseq] = [st |-> "rej", seq |-> 0]]
                /\ UNCHANGED log
           ELSE /\ log' = Append(log, [sess |-> s, lseq |-> c.lseq,
                                       writes |-> c.writes, elided |-> {},
                                       val |-> c.val, reads |-> c.reads])
                /\ res' = [res EXCEPT ![s][c.lseq] = [st |-> "acc", seq |-> k]]
        /\ heldRefused' =
             (heldRefused \/
                (/\ HasDeadDep(s, c)
                 /\ \A d \in Unaccepted(s, c) : phase[s][d] = "held"))
        /\ vq' = [vq EXCEPT ![s] = Append(@, c.lseq)]
  /\ sendq' = [sendq EXCEPT ![s] = Tail(@)]
  /\ UNCHANGED <<pend, known, localrej, nextLocal, csn, built, phase, lval,
                 lcs, meta>>

(***************************************************************************)
(* Verdict processing.  An accept only records knowledge; the promotion    *)
(* of both documents waits for Integrate.  A rejection drops the layer     *)
(* and, transitively, every standing commit that read either document      *)
(* through a dropped layer; a victim still held is never sent.  A verdict  *)
(* for a commit the client already dropped is consumed and ignored.        *)
(***************************************************************************)

AllDepsOf(s, e) == DepsOf(e) \cup UNION {r.deps : r \in meta[s][e.lseq].lr}

RECURSIVE LocalDoomed(_, _)
LocalDoomed(s, D) ==
  LET more == {pend[s][j].lseq : j \in {i \in StackIdx(s) :
                 /\ pend[s][i].lseq \notin D
                 /\ AllDepsOf(s, pend[s][i]) \cap D # {}}}
  IN IF more = {} THEN D ELSE LocalDoomed(s, D \cup more)

LocalDeliver(s) ==
  /\ vq[s] # <<>>
  /\ LET l == Head(vq[s])
     IN IF known[s][l] # "none"
        THEN UNCHANGED <<known, localrej, pend, phase>>
        ELSE IF res[s][l].st = "acc"
        THEN /\ known' = [known EXCEPT ![s][l] = "acc"]
             /\ UNCHANGED <<localrej, pend, phase>>
        ELSE LET D == LocalDoomed(s, {l})
             IN /\ known' = [known EXCEPT ![s] =
                               [m \in LSeqs |->
                                  IF m \in D THEN "rej" ELSE known[s][m]]]
                /\ localrej' = [localrej EXCEPT ![s] = @ \cup (D \ {l})]
                /\ pend' = WithoutLayers(s, D)
                /\ phase' = [phase EXCEPT ![s] =
                               [m \in LSeqs |->
                                  IF m \in D /\ phase[s][m] = "held"
                                  THEN "dead" ELSE phase[s][m]]]
  /\ vq' = [vq EXCEPT ![s] = Tail(@)]
  /\ UNCHANGED <<log, res, nextLocal, csn, built, sendq, lval, lcs, meta,
                 heldRefused>>

(***************************************************************************)
(* Integration.  As in PendingStacks.tla, with the local half of an own    *)
(* accepted commit promoted in the same step as its shared half: the       *)
(* replica confirms every document a commit touched together.              *)
(***************************************************************************)

LocalIntegrate(s) ==
  /\ csn[s] < Len(log)
  /\ LET e == log[csn[s] + 1]
         own == e.sess = s
     IN /\ own => (known[s][e.lseq] = "acc")
        /\ pend' = IF own THEN WithoutLayers(s, {e.lseq}) ELSE pend
        /\ IF own /\ e.lseq \in StackLseqs(s)
           THEN PromoteLocal(s, e.lseq, LW(s, e.lseq))
           ELSE UNCHANGED <<lval, lcs>>
  /\ csn' = [csn EXCEPT ![s] = @ + 1]
  /\ UNCHANGED <<log, res, known, localrej, nextLocal, built, phase, sendq,
                 vq, meta, heldRefused>>

(***************************************************************************)
(* Specification.                                                          *)
(***************************************************************************)

SharedWriteChoices == SUBSET Paths
LocalReadChoices == {{}} \cup {{q} : q \in LocalPaths}
LocalWriteChoices == SUBSET LocalPaths

LocalInit ==
  /\ Init
  /\ phase = [s \in Sessions |-> [l \in LSeqs |-> "none"]]
  /\ sendq = [s \in Sessions |-> <<>>]
  /\ vq = [s \in Sessions |-> <<>>]
  /\ lval = [s \in Sessions |-> [q \in LocalPaths |-> {}]]
  /\ lcs = [s \in Sessions |-> 0]
  /\ meta = [s \in Sessions |->
               [l \in LSeqs |-> [lw |-> {}, lr |-> {}, hold |-> {}]]]
  /\ heldRefused = FALSE

LocalNext ==
  \/ \E s \in Sessions : \E R \in ReadChoices : \E W \in SharedWriteChoices :
       \E LR \in LocalReadChoices : \E LWr \in LocalWriteChoices :
         \E v \in Values : LocalBuild(s, R, W, LR, LWr, v)
  \/ \E s \in Sessions : \E l \in LSeqs : LocalRelease(s, l)
  \/ \E s \in Sessions : LocalProcess(s)
  \/ \E s \in Sessions : LocalDeliver(s)
  \/ \E s \in Sessions : LocalIntegrate(s)

LocalSpec == LocalInit /\ [][LocalNext]_<<vars, lvars>>

(***************************************************************************)
(* Invariants.  ReadCoherence, CascadeTotality, MonotonicResolution and    *)
(* AcceptedVersusDropped are PendingStacks.tla's, over the same log and    *)
(* verdicts.  The ones below state the same things for the document the    *)
(* server never holds.                                                     *)
(***************************************************************************)

BuiltSeqs(s) == 1..(nextLocal[s] - 1)

(* A commit's fate is final acceptance once the server accepted it or the
   client settled it locally. *)
FinalAccepted(s, l) == res[s][l].st = "acc" \/ phase[s][l] = "local"

(* INV-1 for the local document.  What an accepted commit observed at a
   local path - the confirmed writes plus the layers it read through - is
   exactly the accepted writes to that path beneath it.  A layer read
   through and later rolled back is a phantom; an accepted write the
   observation lacks is a lost one. *)
LocalReadCoherence ==
  \A s \in Sessions : \A l \in BuiltSeqs(s) :
    FinalAccepted(s, l) =>
      \A r \in meta[s][l].lr :
        r.obsC \cup r.obsP =
          {d \in 1..(l - 1) : FinalAccepted(s, d) /\ r.path \in LW(s, d)}

(* INV-8 across the two documents.  The local document's confirmed tier
   holds exactly the local writes of the accepted commits that have left
   the stack: the session write of a rejected commit never stays, and that
   of an accepted commit is never lost. *)
LocalConfirmedExact ==
  \A s \in Sessions : \A q \in LocalPaths :
    lval[s][q] = {d \in BuiltSeqs(s) :
                    /\ FinalAccepted(s, d)
                    /\ d \notin StackLseqs(s)
                    /\ q \in LW(s, d)}

(* The view's order.  Every pending layer of the local document is above
   its confirmed tier, so folding confirmed state and then the layers in
   localSeq order replays the writes in the order they were made. *)
LocalStackAboveConfirmed ==
  \A s \in Sessions : \A j \in StackIdx(s) :
    LW(s, pend[s][j].lseq) # {} => pend[s][j].lseq > lcs[s]

(* Not a safety property: the server never refuses a commit only because
   the client was still holding a commit it named.  Checked as a witness
   of what the hold costs. *)
NoRefusalOnHeldDependency == ~heldRefused

LocalTypeOK ==
  /\ TypeOK
  /\ \A s \in Sessions : \A l \in LSeqs :
       phase[s][l] \in {"none", "held", "sent", "local", "dead"}
  /\ \A s \in Sessions : lcs[s] \in 0..MaxTotal
  /\ \A s \in Sessions : \A q \in LocalPaths : lval[s][q] \subseteq LSeqs
  /\ heldRefused \in BOOLEAN

=============================================================================
