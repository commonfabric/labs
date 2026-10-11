----------------------------- MODULE LocalFolds -----------------------------
(***************************************************************************)
(* A bounded model of a refused derived write kept by one replica, and a  *)
(* later whole-document publication (03-commit-model.md section 3.8.3).    *)
(* Durable history, the local value, and delivered holdings are distinct. *)
(*                                                                         *)
(* One document has two or more independent fields. One write is refused, *)
(* as either a derivation or a handler; after its refusal is processed,   *)
(* WRITE may be granted and one field edit may publish the folded value. *)
(* Foreign field writes and frame delivery interleave with these steps.  *)
(* The refusal's arrival and its processing are separate actions.        *)
(*                                                                         *)
(* Mode selects the shipped rule or one deliberately unsafe variant:     *)
(* safe: whole-document validation, unchanged-base fold, same-seq keep;   *)
(* pathOnly: validates only the field the later edit originally touched; *)
(* staleFold: folds even when a newer confirmed revision arrived;        *)
(* overwriteReplay: a same-seq frame overwrites the retained local value. *)
(*                                                                         *)
(* Bounds: one pending write at a time, one refusal, one publication, and *)
(* MaxForeign foreign writes. Seq 0 is a genesis document, not absence.  *)
(* Values are replacements, not the append abstraction of PendingStacks.*)
(* Pending cascades, multiple documents/scopes, deletes, read compaction, *)
(* mergeable operations, identity elision, and scheduler liveness remain *)
(* outside this model. It does not certify composition with those paths. *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Paths, Values, InitialValue, MaxForeign, Mode
ASSUME Paths # {}
ASSUME InitialValue \in Values
ASSUME MaxForeign \in Nat
ASSUME Mode \in {"safe", "pathOnly", "staleFold", "overwriteReplay"}

VARIABLES history, confirmedSeq, localValue, localFold, deliveredSeq,
          phase, pending, mayWrite, foreignWrites,
          lastRefusal, lastDelivery, lastPublication

vars == <<history, confirmedSeq, localValue, localFold, deliveredSeq,
          phase, pending, mayWrite, foreignWrites,
          lastRefusal, lastDelivery, lastPublication>>

Genesis == [p \in Paths |-> InitialValue]
At(n) == IF n = 0 THEN Genesis ELSE history[n].value
Stored == At(Len(history))

(* The optimistic pending layer is visible until its refusal is processed.
   A local fold remains visible after that layer leaves the stack. *)
Visible == IF phase \in {"pending", "denied", "publishing"}
           THEN pending.value ELSE localValue

Init ==
  /\ history = <<>>
  /\ confirmedSeq = 0
  /\ localValue = Genesis
  /\ localFold = FALSE
  /\ deliveredSeq = 0
  /\ phase = "ready"
  /\ pending = [base |-> 0, value |-> Genesis, reads |-> {}, derived |-> FALSE]
  /\ mayWrite = FALSE
  /\ foreignWrites = 0
  /\ lastRefusal = [kept |-> FALSE, base |-> 0, current |-> 0,
                     derived |-> FALSE, before |-> Genesis, after |-> Genesis]
  /\ lastDelivery = [folded |-> FALSE, oldSeq |-> 0, seq |-> 0,
                      before |-> Genesis, after |-> Genesis]
  /\ lastPublication = [accepted |-> FALSE, base |-> 0, server |-> 0]

(* A full-document computation is enough to expose a stale-base fold.
   The derived choice distinguishes a computation from an event handler. *)
Begin(v, derived) ==
  /\ phase = "ready"
  /\ v # localValue
  /\ pending' = [base |-> confirmedSeq, value |-> v, reads |-> Paths,
                  derived |-> derived]
  /\ phase' = "pending"
  /\ UNCHANGED <<history, confirmedSeq, localValue, localFold, deliveredSeq,
                  mayWrite, foreignWrites, lastRefusal, lastDelivery,
                  lastPublication>>

Deny ==
  /\ phase = "pending"
  /\ phase' = "denied"
  /\ UNCHANGED <<history, confirmedSeq, localValue, localFold, deliveredSeq,
                  pending, mayWrite, foreignWrites, lastRefusal, lastDelivery,
                  lastPublication>>

HandleRefusal ==
  /\ phase = "denied"
  /\ LET keep == pending.derived /\
                   (Mode = "staleFold" \/ pending.base = confirmedSeq)
         value == IF keep THEN pending.value ELSE localValue
     IN /\ localValue' = value
        /\ localFold' = keep
        /\ lastRefusal' = [kept |-> keep, base |-> pending.base,
                            current |-> confirmedSeq,
                            derived |-> pending.derived,
                            before |-> Visible, after |-> value]
  /\ phase' = "settled"
  /\ UNCHANGED <<history, confirmedSeq, deliveredSeq, pending, mayWrite,
                  foreignWrites, lastDelivery, lastPublication>>

Grant ==
  /\ phase = "settled"
  /\ ~mayWrite
  /\ mayWrite' = TRUE
  /\ UNCHANGED <<history, confirmedSeq, localValue, localFold, deliveredSeq,
                  phase, pending, foreignWrites, lastRefusal, lastDelivery,
                  lastPublication>>

(* Build and submit are one action: the snapshot check passes before the
   send, and a frame may arrive while its server verdict is outstanding. *)
Publish(p, v) ==
  /\ phase = "settled"
  /\ mayWrite /\ localFold
  /\ v # localValue[p]
  /\ pending' = [base |-> confirmedSeq,
                  value |-> [localValue EXCEPT ![p] = v],
                  reads |-> IF Mode = "pathOnly" THEN {p} ELSE Paths,
                  derived |-> FALSE]
  /\ phase' = "publishing"
  /\ UNCHANGED <<history, confirmedSeq, localValue, localFold, deliveredSeq,
                  mayWrite, foreignWrites, lastRefusal, lastDelivery,
                  lastPublication>>

(* Per-field history scanning is the two-leaf abstraction of overlap.
   Validation and storage are atomic. Identity elision is not modeled:
   even a stale replacement equal to Stored is conservatively rejected. *)
Decide ==
  /\ phase = "publishing"
  /\ LET conflict == \E n \in (pending.base + 1)..Len(history) :
                       history[n].changed \cap pending.reads # {}
     IN /\ lastPublication' = [accepted |-> ~conflict,
                                base |-> pending.base, server |-> Len(history)]
        /\ IF conflict
           THEN /\ phase' = "conflict"
                /\ UNCHANGED <<history, confirmedSeq, localValue, localFold>>
           ELSE /\ phase' = "accepted"
                /\ history' = Append(history,
                     [value |-> pending.value,
                      changed |-> {p \in Paths : pending.value[p] # Stored[p]}])
                /\ confirmedSeq' = Len(history) + 1
                /\ localValue' = pending.value
                /\ localFold' = FALSE
  /\ UNCHANGED <<deliveredSeq, pending, mayWrite, foreignWrites,
                  lastRefusal, lastDelivery>>

ForeignWrite(p, v) ==
  /\ foreignWrites < MaxForeign
  /\ v # Stored[p]
  /\ history' = Append(history,
       [value |-> [Stored EXCEPT ![p] = v], changed |-> {p}])
  /\ foreignWrites' = foreignWrites + 1
  /\ UNCHANGED <<confirmedSeq, localValue, localFold, deliveredSeq,
                  phase, pending, mayWrite, lastRefusal, lastDelivery,
                  lastPublication>>

(* Same-seq replays still advance delivery bookkeeping after a promotion.
   A forward frame replaces the fold, independently of pending visibility. *)
Receive(n) ==
  /\ n \in confirmedSeq..Len(history)
  /\ LET keep == localFold /\ n = confirmedSeq /\ Mode # "overwriteReplay"
         value == IF keep THEN localValue ELSE At(n)
     IN /\ localValue' = value
        /\ localFold' = keep
        /\ lastDelivery' = [folded |-> localFold, oldSeq |-> confirmedSeq,
                             seq |-> n, before |-> localValue, after |-> value]
  /\ confirmedSeq' = n
  /\ deliveredSeq' = n
  /\ UNCHANGED <<history, phase, pending, mayWrite, foreignWrites,
                  lastRefusal, lastPublication>>

Next ==
  \/ \E v \in [Paths -> Values], derived \in BOOLEAN : Begin(v, derived)
  \/ Deny
  \/ HandleRefusal
  \/ Grant
  \/ \E p \in Paths, v \in Values : Publish(p, v)
  \/ Decide
  \/ \E p \in Paths, v \in Values : ForeignWrite(p, v)
  \/ \E n \in 0..Len(history) : Receive(n)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ confirmedSeq \in 0..Len(history)
  /\ deliveredSeq \in 0..confirmedSeq
  /\ localValue \in [Paths -> Values]
  /\ localFold \in BOOLEAN
  /\ foreignWrites \in 0..MaxForeign
  /\ Len(history) <= MaxForeign + 1
  /\ phase \in {"ready", "pending", "denied", "settled", "publishing",
                 "accepted", "conflict"}

DurableBaseMatchesLog == ~localFold => localValue = At(confirmedSeq)
FoldUsesUnchangedBase == lastRefusal.kept => lastRefusal.base = lastRefusal.current
OnlyDerivationsFold == lastRefusal.kept => lastRefusal.derived
FoldKeepsVisibleValue == lastRefusal.kept => lastRefusal.before = lastRefusal.after
FoldSurvivesReplay ==
  (lastDelivery.folded /\ lastDelivery.seq = lastDelivery.oldSeq) =>
    lastDelivery.before = lastDelivery.after
NewerFrameReplacesFold ==
  lastDelivery.seq > lastDelivery.oldSeq => lastDelivery.after = At(lastDelivery.seq)
WholePublicationChecksBase ==
  lastPublication.accepted => lastPublication.base = lastPublication.server
=============================================================================
