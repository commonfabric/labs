# Derivation by demand on the compiled path: a design for the owner to rule on

Written 2026-11-25 against the build branch `claude/compiled-pattern-scoped-rows`
at `a04632cb2c`. Nothing in it is built and nothing in it is a ruling. Paths are
relative to the repository root at that commit. Whenever a statement is about a
per-element construct (`map`, `filter`, another), it names the case: an array of
references, an array of plain values held in place, or the result of another
construct.

## 1. What this decides

A compiled piece is derived today by one scheduler action that the serving loop
runs once for each session that demands the piece, and each run derives
everything: the part every reader shares and that session's part, in one
transaction stamped with that session's identity. The three measured problems
follow from that one fact. The shared part is derived s times for s sessions, a
write that no plan record covers takes the label of whichever session's run made
it, and a piece that has a scoped document cannot be found current at a restart.

The design replaces the one action by two.

1. A **space derivation**: one transaction per cause, with no acting principal
   and no scope key, which derives every cone instance that depends on no
   principal and no session and is the only derivation that writes documents of
   the scope `space`. A read of a scope instance inside it does not succeed.
2. A **scoped derivation**: one transaction per demanding scope key, which
   derives only the scoped places whose documents that key's sessions watch, and
   writes only documents at its own scope key.

The partition between the two is found the way today's path finds it, from what
an evaluation read, with the plan's static scopes as the starting point. Demand
comes from the registry the serving loop already keeps
(`SpaceServer.#demandersByKey`); the compiled path adds a read of that registry
and no registry of its own. The labels then follow from one rule that a store
dump can check: **a transaction of a compiled derivation writes only documents
at the scope key it runs for**.

This is what `docs/specs/compiled-pattern-language/scheduler-and-serving-loop.md`
§4 and §10.3 and `execution-and-storage.md` §1.8 already describe. The design is
the path from the adapter as built to that specification, plus the answers the
specification leaves open (the mixed constructs, how the partition is learned,
the label of writes no record covers, and Z100 for a handler).

## 2. How the code works now

Each statement is marked **[read]** (I read it at `a04632cb2c`), **[search]**
(a read-only search agent read it and I checked the names exist), **[notes]**
(stated in `base/pattern-compiler/SPEC-NOTES.md` or the handoff, not checked
against code) or **[assumed]**.

### 2.1 The compiled path

- The derivation of a piece is one scheduler action, `CompiledPiece.#derive`
  (`runtime/runner/src/compiled/piece.ts`), registered in `#subscribe()` with
  `isEffect: true` and empty reads and writes. Once the piece has named a
  document of a scope it registers again with an `observationIdentity` naming
  its result document as `pieceRootId`. **[read]**
- `#derive` raises the transaction's narrowest read scope to the narrowest scope
  the piece has ever named (`resetNarrowestReadScope`, P355), so that the
  scheduler treats the action as narrowed and runs it once per demanding
  principal or session. **[read]**
- Each run calls `Instance.settleMade()` or `Instance.settle()` and
  `Instance.relabel()` inside one transaction (`RuntimeTransactions.within`).
  `Instance.#settle()` (`base/pattern-compiler/exec/executor.ts`) evaluates
  every kept output, the result, then `#pullScoped()`, then every child instance
  that is due. So one run for one session brings the whole instance tree up to
  date, the space's entries included. **[read]**
- Which scope key a run is for comes from the transaction:
  `RuntimeTransactions.#actingIdentity()` returns the transaction's
  `scopeKeyIdentity`, and falls back to the runtime's own identity where the
  transaction carries none (`runtime/runner/src/compiled/transactions.ts`).
  **[read]** So a run nobody stamped derives the serving runtime's own scope
  instances. **[notes: 890(e), 990]**
- Whether a memo entry is of a scope is found at evaluation.
  `Instance.#ensure()` evaluates inside `scopes.framed()`, takes the narrowest
  scope the evaluation touched, records it (`scopes.narrow`), and sets
  `entry.scoped` to the acting key. An entry of another key is set aside by
  `#forActing()` and brought back when its key acts again. **[read]**
- The plan also knows some scopes statically: a state cell's declared scope, an
  operation's `scope` (`user` for a `wish` through the acting principal's home),
  and a value whose cone reads one of these (`place_scope`, `root_scope`,
  `value_scope` in `base/pattern-compiler/src/plan.rs`). The comment says what
  it does not know: "a scope the plan does not know, as of a document a link
  leads to". **[read]**
- An expression that reads a name whose place is statically of a scope is
  planned as a cone of its own (`hoisted_scope`, `eval_placed`; Z94, P451,
  P454). The cone around it holds a reference to a scoped place and stays of the
  space. **[read]** The three kinds of place: a path of the per-instance
  document of scoped outputs (`#scopedPlace`), a document per output and element
  keys (`#valuePlace`, `#valueDocument`, P455), and a document per collection
  and outer element keys for a scoped collection below a row (`#rowsPlace`,
  `#rowsDocument`, P474). Each has one stored instance per scope key. **[read]**
- To decide whether a position holds a value or a reference to a scoped place,
  the cone of the space evaluates the candidate for the acting key
  (`scopes.framed(() => this.evaluated(value)(host.context))` in
  `scopedOutput`, `scopedValue` and `#scopedRows`). So deriving the space's part
  evaluates scoped cones for whichever key the run is for. **[read]**
- `#pullScoped()` brings scoped places up to date for the acting key: for a key
  seen before, the pulls a change marked due (`#pullsDue`) and those compared on
  every pull; for a key not seen before, every registered pull. Nothing asks
  whether a reader watches the place. **[read]** A pull marked by a change of
  the space is marked due for every key ever seen (`#pullDue`, `#pullsSeen`).
  **[read]**
- An evaluation found to be of a scope after it stored what it derived in a
  document of the space is withdrawn and takes an error state
  (`#refuseStoredForEveryKey`). **[read]**
- Because the runs of one pass for several sessions read their replica before
  the commit of the run before them, `CompiledPiece.#madePending` holds every
  other run while the first derivation of an instance a handler made is
  uncommitted (P450). **[read]**
- A piece that has named a scoped document writes its basis only in a run that
  made a document (`#basisOfEveryKey`), adds a basis source that has no sequence
  number (`#sourceOfNoNumber`) so that no resume finds it current, and skips
  `PieceUnits.record`. Such a piece resumes whole. **[read]** This is the stated
  cause of Topics evaluating its whole derivation at the first edit after a
  restart. **[notes: 892, handoff "A piece loaded again in another process"]**
- A write that a plan record covers stores the label its template instantiates
  to; a write no record covers takes the flow join of its transaction.
  **[read: header of `transactions.ts`; notes 1119, 1120]** The documents
  written under no record include the basis and its parts, the minted document,
  the units and readers parts, and stream markers with no element key.
  **[notes: 1119]**
- A handler runs in the transaction the scheduler gives it, stamped as an
  event handler acting for the event's principal, and then invalidates the
  derivation (`CompiledPiece.#registerStream`). **[read]**

### 2.2 Today's path, as far as the design uses it

- The memory server holds, per session, the tracked closure of its watches: the
  watch roots and every document the schemas reach. `Server.demandForSpace`
  returns one row per demanded document and scope key, with the demanding
  principal and session and the piece root the document belongs to
  (`DemandedInstanceRow` in `runtime/memory/v2/server.ts`). **[search]**
- The serving loop folds those rows into `SpaceServer.#demandersByKey`
  (`runtime/runner/src/executor/space-server.ts`), keyed by document and scope
  key, in `#loadDemandedStructure()`. A new key calls
  `scheduler.enterDemandedEntity()`, which makes the current writers of that
  entity runnable; a departed key calls `leaveDemandedEntity()`
  (`#retireDemandKey`). **[search; names checked]**
- At a run the scheduler asks `Runtime.serverRunDemandersFor(demandRootIds)`,
  answered by `SpaceServer.#demandersFor()`: the (principal, session) pairs
  whose demand reaches the action's piece root or an ancestor root, plus the
  actor of an event queued for that piece (`transientEventDemandersFor`).
  **[read]**
- `fanOutInstances()` (`runtime/runner/src/scheduler/fan-out.ts`) turns the
  demanders and what the node's runs discovered into the runs to make: one run
  keyed `space` while no run read anything scoped, then one per demanding
  principal, or per demanding session for a principal whose run read session
  scope. The header states the rule: the node "remembers what running has
  DISCOVERED (never what a schema or a body declares)".
  `pruneFanOutInstances()` drops the state of a key no demander produces any
  more. **[read]**
- With no demander that has a principal, the action runs once with the
  wave-level identity. **[read: `run.ts`]**
- `dirtyFanOutForCause()` dirties every instance for a cause with no scope key,
  and `causesForInstance()` (`run.ts`) hands such a cause to every instance's
  run as a trigger read. **[read]** This is the defect being fixed on `main`.
- A session that disconnects stays in the memory server's registry for a time
  to live, and no demand change is signaled when it is removed; a tracked set
  shrinks only when it is evaluated again or the session closes. **[search;
  not checked by me]** Note 999 names the same thing from the compiled side.
- No existing call answers "which documents under this piece root does this
  (principal, session) demand" for a caller other than the serving loop.
  `SpaceServer.demandedIdentitiesOf(id)` answers the reverse for one document
  and is marked diagnostic. **[search]**

## 3. The design

### 3.1 The shared part is derived once

**What is shared.** A cone instance is of the space when its evaluation reads no
scope instance and uses no cone instance that does. This is the property
`Instance.#ensure()` computes already (`entry.scoped === undefined`). The shared
part of a piece is every such cone instance, in every instance of the tree, and
the documents of the scope `space` that hold what they derive: the result
documents, row documents, list documents, the argument documents of instances a
body or a handler makes, and the piece's bookkeeping (basis and parts, units and
readers parts, the minted document, outside reads, stream markers).

**Which transaction derives it.** A scheduler action of its own,
`CompiledPiece.#deriveSpace`, registered without an `observationIdentity`, so
the run supply never fans it out. Its transaction is a derivation with no acting
principal, as `stamp()` in `compiled/serving.ts` already makes for the load of a
piece. It runs behind a batch of events and behind a change of a source, as
`#derive` does now. It does what `settleMade()`, `settle()` and `relabel()` do,
for entries of no scope key only, and it alone writes the basis, the units and
the minted document's derivation-side state.

**Under which label.** A position a plan record covers takes the label its
template instantiates to, as now. A position no record covers takes the flow
join of the space derivation's transaction. That join now holds only documents
of the space and of other spaces that the shared cones read; it cannot hold a
clause that entered through a scope instance, because the transaction read none.
A `User` clause can still reach a shared document by a flow from shared data
that carries one (a profile document in another space read through a link, a
schema-declared clause). That is a flow the content has, and section 3.3 keeps
it apart from the defect.

**How it is kept from reading anything narrower.** By refusing the read, not by
trusting the partition. `RuntimeTransactions` gets a state "no scope key" that
the space derivation sets for its transaction; in it, `scopeKey(scope)` does not
fall back to the runtime's identity. A store read or write of a document named
`…~user` or `…~session` with no key then raises a typed signal that
`Instance.#ensure()` catches for the entry being evaluated. That entry:

- is recorded as of that scope (`scopes.narrow(name, scope)`),
- has its writes of this transaction withdrawn (`#withdraw`, the mechanism
  `#refuseStoredForEveryKey` uses now), and
- is replaced, at the position that wanted its value, by the reference to its
  scoped place, which is the same text for every key.

This is the counterpart of today's probe run and ratchet in `fan-out.ts`, with
one difference that matters for labels: today's probe runs with the identity of
the smallest demander, so it does read one principal's instance before it
learns to narrow. Here the first attempt reads nothing.

**How the partition is known.** In this order, and the first that answers wins:

1. *The plan.* `place_scope` already gives a scope for a state cell declared
   `PerUser` or `PerSession`, for a `wish` through the acting principal's home,
   and for every value whose cone reads one. For these the space derivation
   never attempts an evaluation; it places the reference directly. This removes
   the probing evaluations in `scopedOutput`, `scopedValue` and `#scopedRows`.
2. *What is stored.* A position of a space document that holds a link to a
   `~user` or `~session` document says the place is scoped. A row left as stored
   at a restart keeps that link, so nothing is learned again for it.
3. *The refused read.* For a scope the plan cannot see (a body that follows a
   link in data to a scoped document; an authored function the plan did not
   split), the first attempt in the space derivation is refused as above and the
   cone instance is of the scope from then on. It costs one withdrawn
   evaluation per cone instance and process lifetime.

A scope only narrows, as now. A cone instance that stops reading anything scoped
stays scoped until the pattern is updated.

*The alternative: a static partition only.* The compiler would refuse, or plan
as scoped by type, every read whose scope it cannot show. It gives a partition
that never moves and no withdrawn evaluation. It costs the reads through links
in data, which the plan cannot resolve and which real patterns have (a message
stores a link of the scope `user`, handoff round twenty-one), and it departs
from today's rule that the scope is discovered. I recommend the three sources
above: static where the plan knows, discovered otherwise, never trusted.

**A construct that mixes both.**

- *A per-element body over a shared collection that reads a per-user cell.*
  Where the read is of a name the plan sees as scoped, the expression that reads
  it is already a cone of its own per element key (P454), and the row is a row
  of the space that holds a link to the scoped value document.
  - Over **an array of references**: the row document of each element is written
    once, by the space derivation, with the link in place of the value. No scoped
    cone of any row is evaluated by the space derivation.
  - Over **an array of plain values held in place**: the same, with the row
    stored at its position of the output's document of the space, and the
    scoped value document named by the output and the element's key or index.
  - Over **the result of another construct**: the same where the upstream result
    is of the space. Where the upstream is itself scoped (a `filter` whose
    predicate reads a per-user cell, then a `map` over it), the membership
    differs per key, so the whole downstream collection is of the scope: its
    rows are stored per key in the scoped outputs document or in a scoped rows
    document (P474), and the space holds one link to it.
  Where the plan does not see the read as scoped (source 3 above), the whole
  body of the row is refused in the space derivation and the row itself becomes
  a scoped place: the list of the space holds, for that element, the link to
  the row's scoped document, in all three cases. This costs an evaluation of
  the body per demanding key, which is what today's path pays for a node that
  narrows.
- *An instance a handler makes whose body reads `wish("#profile")`.* The
  handler's transaction creates the instance's argument and its result as an
  empty record (P492), acting for the event's principal. The space derivation
  behind the batch then makes the first derivation of the instance's shared
  part, with no principal: the `wish` is of the scope `user` in the plan, so
  every value below it is a reference to a scoped place. No session's part of
  the new instance is derived at the create. A session's part is derived when
  that session's tracked set reaches one of the instance's scoped documents
  (section 3.2). `settleMade()` as a transaction of its own, and
  `#madePending`, are no longer needed: they exist because several sessions'
  runs raced to make the first derivation.

### 3.2 Each session's part is derived only on demand

**What demand is.** The rows the memory server reports for the space: a document
id, a scope key, and the (principal, session) whose tracked set holds it. A
scoped place of a compiled piece is *demanded for a key* when a row exists for
the document that stores the place at that key. Demand reaches the cones a
demanded place uses through evaluation itself: evaluating a place for a key
pulls what it uses for that key, and nothing else.

The unit is the document, not the path. The scoped outputs of one instance at
paths of its result share one document, so a session that watches one of them
derives all of that instance's root-level scoped outputs. A scoped value in a
row and a scoped collection below a row each have a document of their own. The
specification asks for demand per kept path (S&SL §4.2); that needs the watch's
schema mapped to paths and is left out here, on purpose, because the document is
what the registry holds.

**How it arrives and is withdrawn.** Through the serving loop's demand pass, and
no second mechanism:

- A second action, `CompiledPiece.#deriveScoped`, registered with the
  `observationIdentity` of the piece and not as an effect. The run supply gives
  it one run per demanding scope key, with the transaction stamped for that
  key, exactly as it does for `#derive` now. `pruneFanOutInstances()` drops a
  key that no demander produces any more.
- One addition to the runtime's surface, beside `serverRunDemandersFor`: a
  resolver the `SpaceServer` installs that answers, for a piece root and one
  (principal, session), the documents under that root that the pair demands.
  `#demandersByKey` and `#keysByRootId` hold what it needs.
  `demandedIdentitiesOf` is its diagnostic reverse.
- One addition to the demand pass: where a key that arrives or departs lies
  under the root of a compiled piece, the pass dirties that piece's
  `#deriveScoped` for the pair concerned (`dirtyFanOutKey`), as
  `rearmNotCurrentForDemander` re-arms writers on today's path. A change of
  demand is then a cause, as S&SL §4.5 says.
- The piece dirties `#deriveScoped` by key, not for every key: after a space
  derivation commits, for each key with a due pull whose document is demanded.
  That needs a targeted form of `invalidateAction`; `dirtyFanOutKey` is the
  function it calls.

*The alternative: one scheduler action per scoped place*, registered as the
writer of the place's entity. Then `enterDemandedEntity`, the fan-out and the
pruning work unchanged and nothing is added to the runtime's surface. It costs a
scheduler node and a registration per scoped place (rows times scoped
expressions), which is the per-row registration the compiled path exists to
avoid and the cost note 968 names for a wake. I recommend the one action with
the resolver.

**What a scoped run does.** For its key K: read from the resolver the documents
demanded for K; for each, bring up to date the places stored in it
(`#scopedValuesOf`, `#scopedRowsOf` and the paths of the scoped outputs document
give the place for a document); write what changed to K's instances; record K's
basis (section 3.4). It evaluates no cone instance of the space, and where it
needs one that is stale it stops and leaves the key dirty: the space derivation
runs first. It runs after the space derivation's commit has ended
(`addCommitCallback`, as `#derive` does now for a made instance), because a run
of the same pass reads the replica before that commit. **[assumed]** that this
costs one commit of latency for a session's values after an event; it is to be
measured, and a wave whose later transactions read earlier sealed writes (S&SL
§10.2) would remove it.

**An element nobody watches.**
- Its *shared* row is derived, by the space derivation, like every other shared
  row. The design does not make the shared part demand-driven per element: an
  edit already costs the same evaluations at every size, and what remains (the
  first derivation after a restart) is section 3.4's subject. The specification
  goes further (an undemanded kept output of the space is not evaluated, S&SL
  §4.6); that is a later step and not needed for the three problems.
- Its *scoped* places are not derived and not written for any key. For a key
  that has demand elsewhere in the piece, a change that reaches such a place
  marks it due and nothing more. When a session later watches it, the demand
  pass dirties the key and the next scoped run evaluates it.

This holds in the three cases alike: the place of a row over an array of
references, of a row over plain values in place, and of a row of another
construct's result are each one document per element key, demanded by itself.

**A session no client holds.** It produces no demand row, so the run supply
gives it no run, the resolver gives it no document, and nothing is derived or
written for it. Its memo entries, its set-aside tables, its copies of scoped
documents and its due marks are dropped when the fan-out prunes its key; due
marks are kept per key with demand, not per key ever seen (`#pullsSeen`
becomes the keys with demand). A key that returns is treated as a key at a
restart: its basis says what is current (section 3.4).

Two things do not follow from the design and need a decision (question 3): the
memory server keeps a disconnected session for a time to live, during which it
still demands; and with no demander at all the scheduler runs an action once
with the wave-level identity. For the second the design is firm: a scoped run
whose transaction carries no stamped scope key does nothing, so the serving
runtime's own scope instances are no longer written.

**An event, for instances nobody watches.** The handler runs once, for the
event's principal, as now. Then:

- The space derivation runs once and brings the shared part up to date,
  watched or not. A piece is loaded by demand or by an event, and a loaded
  piece keeps its shared part current, because the basis and every later read
  depend on it.
- No scoped run is made for a key without demand. The actor is a transient
  demander of the piece on today's path (`transientEventDemandersFor`); here
  the actor's key gets a run only for the scoped places the handler's own
  transaction reads, and those are brought up to date inside the handler's
  transaction before the read, as the executor does for a handler's
  dependencies now. **[assumed: `Instance.#current`, handoff round twenty-one;
  not read]**
- A handler's transaction acts for a principal, so by the rule of section 3.3
  it stores no derived value in a document of the space. What a handler needs
  of the shared part and finds stale it may evaluate for its own read; storing
  it is left to the space derivation. **[not established for the code as
  built; see section 8]**

**How this relates to today's demand passes.** It uses them. The registry, the
pass, the run supply, the fan-out's keys and their pruning are today's; the
compiled piece adds one read of the registry (documents by root and pair) and
one dirtying by key. What it does not reuse is the fan-out's rule for a cause
(`dirtyFanOutForCause`, `causesForInstance`): the piece dirties its own keys
from its own due marks, which are per key and per place, so the rule adopted on
`main` (a run takes a trigger's label only if that instance read the triggering
document) holds here by construction and does not depend on that fix landing.

### 3.3 Labels

The rules, each as a check on a store dump. "Internal document" means the basis
and its parts, the units and readers parts, the minted document, the outside
reads document and a stream marker with no element key.

**L1. Who writes where.** A commit of a compiled derivation that carries scope
key K writes only documents at K or at the `user` key of K's principal. A commit
of a compiled derivation that carries no scope key writes only documents of the
scope `space`. *Check:* for each commit of a compiled piece, compare the run
context it was stamped with against the scope key of each address it wrote; any
other pair is a violation. `RuntimeTransactions` also refuses such a write when
it is made, so the dump check should find none.

**L2. A shared document holds no clause of a run.** A document of the scope
`space` that a compiled derivation wrote carries a `User(p)` clause at a
position only where the position's record names an input that carries it, or,
for a position no record covers, where a document of scope `space` (in this
space or another) read by that space derivation carried it. *Check:* the
comparison's `foreign-clause` kind (`compare/both-paths-gate.ts`), which today
flags any `User` clause in a space document with the declared exemptions. After
the split each remaining finding must be traced to a shared input that carries
the clause; one that cannot is a defect.

**L3. A scope instance holds no other principal's clause.** A document at a key
of principal p carries `User(q)`, q ≠ p, only where a shared document its cone
read carries it. *Check:* the comparison's `crossed-clause` kind. A scoped run
reads its own key's instances, its principal's `user` instances and shared
documents; a link that names another key's instance explicitly (`scopeKey` in
`RuntimeTransactions.#address`) is refused in a derivation.

**L4. The reference to a scoped place carries no label of the value.** The
position of a shared document that holds the link to a scoped place takes no
label from what the place holds for any key (P491, narrowed as its reviewer
asked: only for the output's own scoped place, not for a link a body chose from
data). *Check:* for each link in a space document whose target is a `~user` or
`~session` document of the same piece, the position's label has no clause that
is absent from the row's own record.

**L5. Bookkeeping does not carry a label onward.** A derivation reads an
internal document with a read that adds no flow label (`labelBasisRead`, which
P493 uses for the basis's affirmation), so whatever label such a document
carries is not joined into what the run writes. This extends P493 to the minted
document, which a handler writes under its own join and every derivation reads.
*Check:* no clause of a handler's actor appears on a document that only a space
derivation writes. What label an internal document itself owes stays round
thirty's deferred question 1; with L1 it can no longer be a session's.

**L6. A handler's input (Z100).** The handler's transaction acts for the
event's principal p. The event's payload contributes no `User(p)` clause to
what the handler writes. Its reach is question 2 below. The recommended
reading: it reaches the payload and the value of a per-session or per-user cell
that p's own client wrote through a binding (a draft the user typed), and it
does not reach a value the handler reads that is labeled by its content, such
as p's profile under `OwnerPrivate`. A pattern shares such a value by storing
the link to it (P494), whose position is labeled by the choice and not by the
content, and each reader resolves the link under its own rights.

**What a session's run takes from the shared part and from another principal.**
From the shared part: the labels of the shared positions its cones read, through
its records, and nothing for a position it did not read. From another
principal's activity: nothing directly. Another principal's handler changes
shared documents; the space derivation derives from them; a scoped run that
reads a changed shared position takes that position's label. No run for q is
ever a transaction that writes p's instance (L1), and no cause is handed to a
run as a trigger read unless a place of that key read the changed document.

**Classification under `docs/development/cfc-spec-correspondence.md`.** This is
the author's classification; the procedure asks a reviewer to apply the three
tests afresh, and the specification is private, so no section is cited.

| Rule | Class | Why |
| --- | --- | --- |
| L1, the two transactions | Host arrangement | It changes which run a write belongs to, which the profile leaves to the host (S&SL §10.3 says the same of serving-loop §3c). It stores less label than the code stores now, so it is said first in any report. |
| The refused scoped read | Host arrangement | It decides which run evaluates a cone, not what a label is. |
| L2, L3 | Conforming implementation | They restate that a label comes from what a write depends on; the comparison already checks them. |
| L4 | As round thirty classified P491, once narrowed | No change here. |
| L5 | Semantic gap, unless P493's classification already covers a read that consumes no flow label for any bookkeeping document | It adds documents to the class whose reads are not consumed. Needs the reviewer's reading of P493's basis in the specification. |
| A cause as a trigger read only for a key that read it | Follows the classification of the fix on `main` | The compiled path gets the behavior by construction; the rule is `main`'s to classify. |
| L6, Z100 | Semantic gap | The plan already says so: it changes what CFC decides and goes through the specification first. |

### 3.4 Restart, takeover, update

**Restart and takeover (Z90).** The shared part gets one basis, written by the
space derivation only, with no source that has no number. Then:

- A piece with a `wish` or scoped state is found current from its basis like any
  other, where its shared sources did not change. `#sourceOfNoNumber`,
  `#basisOfEveryKey` and the rule "a piece with scoped documents resumes whole"
  (note 892, P354) go.
- A wake evaluates the units a change reaches and leaves the other shared rows
  as stored (`resumeCompiledPieceByUnits`), for a piece with scoped state too:
  `PieceUnits.record` is written by the space derivation, which is one run and
  not one per principal. This holds for rows over an array of references, which
  is what a wake by units covers today; rows over plain values in place and
  rows over another construct's result are evaluated whole at a wake, as now.
- Each scope key has a basis of its own: the scope instance, at that key, of
  one basis document of the piece. It lists the shared documents and the key's
  own documents its demanded places read, with their sequence numbers. A
  session's first demand after a restart compares it and evaluates the places
  whose sources moved; a key with no demand costs nothing at a restart.

The design removes the stated cause of the 8.5 s (the whole resume of a piece
with scoped documents). Whether the first edit then meets 2.3 s is a
measurement, not a claim of this document.

**A pattern update.** No update of a compiled piece exists yet. Under the
design an update changes the identity in the shared basis, so the shared part is
derived whole once, by the space derivation. A place that was shared and is now
scoped is handled as P458 handles it (the position of the space document takes
the link; each key stores its value on demand). A place that was scoped and is
now shared is written to the space document, and the scope instances of its old
document are left unreferenced. Each key's basis names the old identity and is
found stale at that key's next demand. Deleting unreferenced scope instances is
not designed here.

### 3.5 The stored layout, and existing pieces

Unchanged: every document of the scope `space`, the three kinds of scoped place
and their names. New: the per-key basis, as scope instances of one document
named from the result. Gone: nothing stored is removed, but the serving
runtime's own scope instances and those of sessions that left are no longer
written or read.

An existing compiled piece needs nothing. Its stored basis names the source with
no number, so its first load after the change resumes whole once and writes the
new basis. No compatibility work is proposed, by the owner's instruction.

### 3.6 What this removes from the current code

- `CompiledPiece.#madePending` and the commit callback around it (P450).
- `#basisOfEveryKey`, `#madeSinceBasis` as a guard against several writers,
  `#sourceOfNoNumber`, and the branch of `resumeCompiledPieceFromBasis` that
  resumes a scoped piece whole (P354).
- The `resetNarrowestReadScope` call in `#derive` (P355) and the registration
  that switches between a named and an unnamed action.
- The probing evaluations in `Instance.scopedOutput`, `scopedValue` and
  `#scopedRows`.
- `#pullsSeen` as "every key ever evaluated for", and the visit of every pull
  for a new key.
- `#refuseStoredForEveryKey` as an error state: the refusal becomes the normal
  way a cone instance is found to be scoped.
- The fallback of `RuntimeTransactions.#actingIdentity()` to the runtime's own
  identity inside a derivation.
- `settleMade()` as a transaction of its own.
- The guards `if (!transactions.scoped)` around `outside.flush` and
  `#units.record`.

## 4. What can be checked

n is the number of topics (or rows), s the number of sessions the server holds,
d the number of sessions with demand on the piece, w the scoped documents one
session watches.

| Claim | How to check it |
| --- | --- |
| An event's shared writes do not depend on s | `runtime/runner/test/compiled/made-session.test.ts` at 3, 5 and 9 sessions: records and derivations of a create equal at each, 0 refusals (now 197 to 1,122 records and 1 to 3 refusals). On the board: `compare/topics/scale.ts serving <n>` with `SCALE_COMMITS=1`, a create with 1 and with 9 sessions held. |
| A create writes a constant number of shared documents plus the documents of the new topic | Store dump before and after a create at n = 0, 10, 20, 40: the count of changed documents of scope `space` is the same at each n (now 132 + 5.4n in total). |
| A new session writes only its own key's documents, at most w plus its basis | Dump rule L1 over the commits that follow a session's first watch; the count against w at n = 10 and 40 with the session watching one topic. |
| A session nobody holds derives and writes nothing | After the session's rows leave `Server.demandForSpace`: zero commits stamped with its key over ten events, and `counts.scopedPulls` unchanged for its key. A counter per key is to be added to `CompiledPieceCounts`. |
| An element nobody watches has no scoped document for any key | Dump: for a row no session watched, no instance of its scoped value document exists. In the three cases: fixtures over an array of references, over plain values in place, and over a `filter`'s result. |
| L1 | A walk of the commit log: stamped run context against scope keys written. To be added to `compare/both-paths-gate.ts` as a kind of its own. |
| L2, L3 | `deno run -A --no-check base/pattern-compiler/compare/both-paths.ts <out.jsonl> --sets=hand,named,corpus`: `foreign-clause` and `crossed-clause` on the compiled path equal between two runs (they vary now) and each finding traced to a shared input. Topics: now 172 and 111. |
| L4, L5 | `runtime/runner/test/compiled/hidden-made.test.ts`, extended to walk the internal documents and to assert what the second principal reads (its reviewer's two gaps). On the 8300 board: the 34 internal documents with a session-holder's clause become 0. |
| The partition never lets a scoped read through | A test that plants a link in data to a per-user document, read in a body the plan sees as shared: the space derivation's commit holds no read of a scope instance, and the row holds a link. One fixture per case of collection. |
| Restart | `compare/topics/scale.ts serving 2000` with a takeover, first edit, against the `serving-today` arm (now 8.5 s against 2.3 s); and `compare/runner-corpus.ts run … --serving --resume`: pieces found current return to the trunk's 80 from 71. |
| Latency of a session's value after an event | Time from the event's commit to the commit of the watcher's scoped run, against today's path, in the list fixture's second-client measurement. |

## 5. Questions for the owner

1. **How the partition is known.** (a) The plan's static scopes, what is stored,
   and a refused read for the rest, as section 3.1. (b) Static only: the
   compiler refuses or over-approximates a read whose scope it cannot show.
   *Recommended: (a).* (b) forbids reads through links in data that real
   patterns have, and differs from today's discovered scope.

2. **The reach of Z100 for a handler.** (a) The event's payload only. (b) The
   payload and a per-session or per-user cell the acting user's client wrote
   through a binding. (c) Everything labeled `User(actor)` that the handler
   writes to the space. *Recommended: (b),* with a value labeled by its content
   (a profile) shared by storing its link. (a) leaves the Topics Start button's
   draft labeled if such a cell carries a clause; (c) lets any handler a user
   triggers release that user's private data into the space. This goes through
   the specification before code.

3. **When a session stops demanding.** (a) As today: when the memory server
   drops it, after its time to live. (b) At disconnect, with a re-arm when it
   returns, for both paths. *Recommended: (a) for this work,* with the ship
   criterion read as "once the registry no longer lists it"; (b) is a change to
   `main` of its own.

4. **Whether the shared part is derived for elements nobody watches.** (a) Yes:
   the space derivation keeps the whole shared part of a loaded piece current.
   (b) No: per-path demand for shared outputs too, as S&SL §4.6. *Recommended:
   (a) now.* The three measured problems do not need (b), and (b) is the larger
   change (demand counts per kept output).

5. **One scoped action with a registry resolver, or one scheduler action per
   scoped place.** *Recommended: the one action,* at the cost of two small
   additions to the runtime's surface (documents demanded by root and pair;
   dirtying an action by key). The other choice adds nothing to the surface and
   costs a scheduler node per row and scoped expression.

6. **Internal documents.** Whether a derivation's reads of the minted document
   and the other bookkeeping consume no flow label (L5), as P493 does for the
   basis. *Recommended: yes,* and what label those documents carry themselves
   stays deferred. If the answer is no, each needs a plan record.

## 6. Order of implementation

Each round is one agent, test first, and ends with the counts of section 4 it
moves.

1. **Measure, change nothing.** Add the L1 walk as a reported kind in
   `both-paths-gate.ts` and a per-key counter of evaluations and writes to
   `CompiledPieceCounts`. Report, for the corpus and the Topics board with two
   principals: how many writes of a keyed run land in documents of the space,
   which of them no record covers, and how many cone instances are found scoped
   at evaluation where the plan gave no scope. This sizes the partition and
   says whether question 1 matters in practice. No behavior changes, and every
   later round is judged by these numbers.
2. **The two transactions.** `#deriveSpace` with the "no scope key" state and
   the refused read; `#deriveScoped` run for every demander of the piece, still
   pulling everything for its key, after the space commit. Remove P450 and the
   probes. Checks: L1 at zero, `made-session` without refusals and with counts
   independent of sessions, `foreign-clause` and `crossed-clause` stable
   between runs.
3. **The mixed constructs, by case.** A fixture and a stored-labels test under
   differing clauses for each: a body over an array of references, over plain
   values in place, and over a `filter`'s result, each reading a per-user cell
   statically and through a link in data; an instance a handler makes with a
   `wish`. This is the test the ship criteria section 2 asks for.
4. **Demand for scoped places.** The resolver and the dirtying by key in
   `SpaceServer`; `#deriveScoped` derives demanded documents only; no run
   without a stamped key. Checks: the new-session and unwatched-element rows of
   section 4.
5. **Keys that leave.** Drop a pruned key's entries, tables, copies and due
   marks; due marks per key with demand. Check: memory and counts flat over
   sessions that come and go.
6. **The basis per key, and the wake by units for a piece with scoped state.**
   Remove P354's rule. Checks: the restart row of section 4, and peak memory on
   the 2,000-topic board.
7. **Labels that need a ruling:** L5 and Z100 (L6), after the specs pull
   requests. Then the update of a compiled pattern.

Rounds 2 and 3 can be reviewed without rounds 4 to 6, and already close the
label findings. Rounds 4 and 5 close "cost follows demand". Round 6 is Z90.

## 7. What it costs

- A session's values arrive one commit after the shared part's, unless the wave
  lets a later transaction read an earlier sealed one.
- A cone instance whose scope the plan cannot see is evaluated once and
  withdrawn before it is known to be scoped.
- A row whose whole body is found scoped is evaluated once per demanding key.
- Demand is per document, so one watched scoped output of an instance derives
  that instance's other root-level scoped outputs for the key.
- Two additions to the runtime outside `compiled/`, both in the serving loop's
  demand code.

## 8. What this document did not establish

- Whether a storage transaction with no `scopeKeyIdentity` can be made to
  refuse a scoped address rather than resolve it with the runtime's identity,
  without a change outside `compiled/`. `transactions.ts` line 1011 falls back
  to `runtime.scopeKeyIdentity`; I did not read the storage layer below it.
- Whether a handler's transaction stores derived values of the space today when
  it brings a dependency up to date, and so whether the rule "a handler stores
  no derived shared value" needs code. I did not read `Instance.handleEvent`.
- Whether an instance that a *scoped* cone makes has its documents at that scope
  key. L1 requires it; `execution-and-storage.md` §2.8 was not read for it.
- The memory server's retention of a disconnected session, and the absence of a
  demand signal on its removal, are a search agent's reading that I did not
  check.
- Whether the Topics board's cards link to each topic's scoped documents. If
  they do, a session that watches the whole board demands every topic's scoped
  part, as on today's path, and the fall in a create's cost comes from the
  shared part being written once and from sessions that watch less, not from
  the board's own watchers.
- That removing the whole resume brings the first edit after a restart to
  today's 2.3 s. The design removes the stated cause; no run was made.
- Which of the 34 internal documents and the 172 and 111 clause findings each
  rule removes. Round 1 of section 6 is what would say.
- The classification of each label rule against the specification's text. The
  specification repository was not read; the table in section 3.3 is the
  author's reading of the procedure and needs a reviewer.
- No experiment was run for this document. Every count in it is quoted from the
  handoff or the notes.
