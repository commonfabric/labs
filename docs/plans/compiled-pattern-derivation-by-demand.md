# Derivation by demand on the compiled path: a design for the owner to rule on

Written 2026-11-25 against the build branch
`claude/compiled-pattern-scoped-rows` at `a04632cb2c` and the measuring round
(round thirty-four, branch `claude/compiled-pattern-derivation-split` at
`6743be8f25`, notes 1190 to 1207 of `base/pattern-compiler/SPEC-NOTES.md`
there; on `claude/compiled-pattern-rounds-38-39-merge` notes 1200 to 1211 are
numbered 1340 to 1351, and a note cited here by a number from 1200 is the note
140 higher there). Nothing in it is built beyond that round's instruments, and
nothing in it is a ruling. Paths are relative to the repository root. Whenever a statement
is about a per-element construct (`map`, `filter`, another), it names the case:
an array of references, an array of plain values held in place, or the result
of another construct.

## 1. What this decides

A compiled piece is derived today by one scheduler action, which the scheduler
fans out as it does any action of today's path: one run keyed `space` until a
run read something scoped, then one run per demanding principal where the
narrowest scope read is `user`, or per demanding session where it is `session`
(section 2.2). A piece that has named a document of a scope raises its
narrowest read scope to that scope (section 2.1), so a piece with a
`session`-scoped document, as the board is, runs once for each session that
demands it. Each run is one transaction stamped with its fan-out instance's
identity, and it is allowed to write anything the piece owns. Measured on the real Topics board (note 1198):

- The first run of a pass evaluates the shared part and the later runs find it
  current, so the shared evaluations do not multiply. The **transactions** do,
  and the later runs commit from a view the first run's commit replaced: 18
  transactions of which 4 fail with 3 sessions, 114 of which 35 fail with 9.
- A session's run **writes shared documents**: 756 value writes of keyed
  derivations landed in documents of the space over the corpus, 604 of them
  under no plan record, 544 of those into the piece's bookkeeping. 182 of 187
  `User` clauses found in shared documents sit where a keyed run wrote.
- Each session's run derives that session's whole part, watched or not: the
  evaluations of the scope `session` for a create at 10 topics are 39, 153, 281
  and 585 at 1, 3, 5 and 9 sessions, and grow with the topics.
- A piece with a scoped document is never found current at a restart.

The design replaces the one action by two.

1. A **space derivation**: one transaction per cause, with no acting principal
   and no scope key, which derives every cone instance that depends on no
   principal and no session and is the only derivation that writes documents of
   the scope `space`. A read of a scope instance inside it does not succeed.
2. A **scoped derivation**: one transaction per demanding scope key, behind the
   space derivation's commit, which derives only the scoped places whose
   documents that key's sessions watch, and writes only documents at its own
   scope key or at the `user` key of that key's principal.

The partition between the two is found from what an evaluation read, as today's
path finds it, with the plan's static scopes used where the plan has them.
Demand comes from the registry the serving loop already keeps
(`SpaceServer.#demandersByKey`). The labels follow from one rule a store dump
can check: **a transaction of a compiled derivation writes only documents at
the scope key it runs for, and a keyed run may also write at the `user` key of
its key's principal** (L1, section 3.3). The built-ins' own actions, the `wish` first, are
actions of today's path and outside the split, and L1 is not a rule for them.
#10262 on `main` changes which fan-out instances a cause reaches as a trigger
read; it enforces nothing about where an action writes (section 3.3, question
7).

This is what `docs/specs/compiled-pattern-language/scheduler-and-serving-loop.md`
§4 and §10.3 and `execution-and-storage.md` §1.8 describe. The design is the
path from the adapter as built to that specification, plus the answers the
specification leaves open.

## 2. How the code works now

Each statement is marked **[read]** (I read it, at `a04632cb2c` or
`6743be8f25`), **[r34]** (the measuring round read or measured it, with the
note; I checked the names), **[search]** (a read-only search agent read it),
**[notes]** (stated in the notes or the handoff) or **[assumed]**.

### 2.1 The compiled path

- The derivation of a piece is one scheduler action, `CompiledPiece.#derive`
  (`runtime/runner/src/compiled/piece.ts`), registered in `#subscribe()` with
  `isEffect: true` and empty reads and writes. Once the piece has named a
  document of a scope it registers again with an `observationIdentity` naming
  its result document as `pieceRootId`. **[read]**
- `#derive` raises the transaction's narrowest read scope to the narrowest scope
  the piece has named (`resetNarrowestReadScope`, P355). The piece holds its
  scope instances in memory and reads none through the transaction, so without
  this the scheduler would see a run that read nothing scoped and would give
  one run keyed `space` with the smallest demander's identity
  (`fanOutInstances`). **[read]**
- Each run calls `Instance.settleMade()` or `Instance.settle()` and
  `Instance.relabel()` inside one transaction. `Instance.#settle()`
  (`base/pattern-compiler/exec/executor.ts`) evaluates every kept output, the
  result, then `#pullScoped()`, then every child instance that is due.
  **[read]** The entries of the space that an earlier run of the pass evaluated
  are current for the later runs: a create evaluates 31 of them at every number
  of sessions. **[r34: 1198]**
- Which scope key a run is for comes from the transaction.
  `RuntimeTransactions.#actingIdentity()` falls back to the runtime's own
  identity where the transaction carries none. **[read]** A derivation with no
  key therefore writes scope instances at the serving runtime's own key: 199
  such writes in the 32 scenarios with a scoped document, and in the scenarios
  traced 79 of 84 are of the transaction of the load. **[r34: 1190 (f)]**
- A storage transaction with no `scopeKeyIdentity` cannot be made to refuse a
  scoped address: the setter ignores `undefined`, the replica resolves its own
  identity, and the wave resolves a scoped write under its own. The compiled
  path resolves every scoped name through `RuntimeTransactions.scopeKey()`,
  `#address()` and `#readStored()`, so it can refuse in its own code.
  **[r34: 1200]**
- Whether a memo entry is of a scope is found at evaluation
  (`Instance.#ensure()`, `scopes.framed()`, `scopes.narrow`). **[read]**
- The crate knows some scopes statically (`place_scope`, `root_scope`,
  `value_scope` in `base/pattern-compiler/src/plan.rs`) and uses them to plan a
  scoped expression as a cone of its own (`hoisted_scope`; Z94, P451, P454).
  **[read]** The artifact the executor is given holds a scope for a state cell
  and for an operation, and none for a cone or a value. **[r34: 1193, 1206]**
- Of 257 cone instances that evaluation found scoped over the corpus, the plan's
  rule gives 151 a scope and 106 none. 71 of the 106 are bodies of a `map` over
  plain values that an output gives, where the array is the result of a scoped
  `computed` and the body reads its element alone. 29 are cones that write the
  request of a `wish` of the scope `user` and read nothing. 6 are two outputs
  of a topic that the plan holds nothing about. None is a body over an array of
  references or over the result of another construct. **[r34: 1197]**
- To decide whether a position holds a value or a reference to a scoped place,
  the cone of the space evaluates the candidate for the acting key
  (`scopedOutput`, `scopedValue`, `#scopedRows`). **[read]**
- `#pullScoped()` brings every scoped place up to date for the acting key,
  watched or not, and a pull marked by a change of the space is due for every
  key ever seen (`#pullsSeen`). **[read]**
- An evaluation found to be of a scope after it stored what it derived in a
  document of the space is withdrawn and takes an error state
  (`#refuseStoredForEveryKey`). **[read]** An instance that a scoped cone makes
  has its argument and result documents in the space, so making one is such an
  evaluation. **[r34: 1202]**
- A run behind another's commit in one pass cannot read the sealed write: the
  seal is asynchronous and the scheduler does not await it between runs. The
  piece waits with a commit callback (`#madePending`, P450). **[read; r34:
  1205]**
- A piece that has named a scoped document adds a basis source with no sequence
  number (`#sourceOfNoNumber`) and skips `PieceUnits.record`, so it resumes
  whole. **[read]**
- A write a plan record covers stores the label its template instantiates to; a
  write no record covers takes the flow join of its transaction. **[read]**
- A handler's transaction acts for the event's principal and writes documents of
  the space: 864 writes over the corpus (receipts, arguments, the counts) and
  17 at its principal's key. **[r34: 1195]** Before its body it can evaluate
  derived values and store them in that transaction (`Instance.#attempt`:
  `#evaluateStoredRows`, `Host.demand`, `host.output`). On the corpus it stored
  none. **[r34: 1201]**
- The `wish` of a compiled piece is answered by the runtime's own `wish` as a
  separate scheduler action, an effect registered with the piece's
  `observationIdentity` (`RuntimeWishes.answer` in
  `runtime/runner/src/compiled/wish.ts`). The scheduler fans it out per
  demander as it does any action of today's path. The four fetch effects are
  registered the same way. **[read]**

### 2.2 Today's path, as far as the design uses it

- The memory server reports one row per demanded document and scope key, with
  the demanding principal and session, whether the row is a watch root, and
  whether its document is one of a piece's values (`Server.demandForSpace`,
  `DemandedInstanceRow` in `runtime/memory/v2/server.ts`). The row does not
  name the piece root the document belongs to: the serving loop resolves it and
  keeps two indexes, `#keysByRootId` (the keys whose id is that root) and
  `#keysByResolvedRoot` (the keys resolved to a root, and to the roots of the
  pieces enclosing it). **[search; the type and the indexes read]** On the board, a session that holds
  the rendered tree as a renderer does demands 54 shared documents and 6 scope
  instances at every size; a session with a sink on the whole result demands 22
  scope instances for each topic. **[r34: 1199, 1204]**
- The serving loop folds the rows into `SpaceServer.#demandersByKey` in
  `#loadDemandedStructure()`; a new key calls `scheduler.enterDemandedEntity()`
  and a departed one `leaveDemandedEntity()` (`#retireDemandKey`). **[search;
  names checked]**
- A node carries demand on its own only as an effect, a materializer, a node
  with provisional demand, or a writer of a demanded entity (`isDemandRoot` in
  `runtime/runner/src/scheduler/dependency-graph.ts`). **[read]**
- At a run the scheduler asks `Runtime.serverRunDemandersFor(demandRootIds)`
  for the pairs whose demand reaches the action's piece root, and
  `fanOutInstances()` gives one run keyed `space` until a run read something
  scoped, then one per demanding principal or session.
  `pruneFanOutInstances()` drops a departed key's state at the action's next
  run. With no demander that has a principal the action runs once with the
  wave-level identity. **[read]**
- `dirtyFanOutForCause()` dirties every instance for a cause with no scope key,
  and `causesForInstance()` hands that cause to every instance's run as a
  trigger read. **[read]** #10262, open against `main`, changes both so that
  such a cause reaches only the instances whose last run read its document.
- A disconnected session is kept for 30 seconds (`SessionRegistry`, `ttlMs`)
  and removed when a later read of the registry prunes it, not by a timer. The
  serving host installs `demandChanged` and no `sessionChanged`, so the loop
  learns of the removal at the next demand pass another cause starts.
  **[r34: 1203; the two observer names and the default checked]**

## 3. The design

### 3.1 The shared part is derived by one run

**What is shared.** A cone instance is of the space when its evaluation reads no
scope instance and uses no cone instance that does (`entry.scoped ===
undefined` in `Instance.#ensure()`). The shared part of a piece is every such
cone instance, in every instance of the tree, and the documents of the scope
`space` that hold what they derive, the piece's bookkeeping among them (basis
and parts, units and readers parts, the minted document, outside reads, stream
markers).

**Which transaction derives it.** A scheduler action of its own,
`CompiledPiece.#deriveSpace`, an effect registered without an
`observationIdentity`, so the run supply never fans it out. Its transaction is a
derivation with no acting principal. It runs behind a batch of events and behind
a change of a source. It does what `settleMade()`, `settle()` and `relabel()`
do for entries of no scope key, and it alone writes the basis, the units and
the other bookkeeping a derivation writes.

**The load is a space derivation.** The transaction that starts or resumes a
piece (`start()` in `compiled/serving.ts`, `resumeCompiledPiece`) is a
derivation with no key and is the source of most writes at the serving
runtime's own key. It runs under the refusal below from the first
implementation round, before anything else of the design exists.

**Under which label.** A position a plan record covers takes its template's
label. A position no record covers takes the flow join of the space
derivation's transaction, which read no scope instance. A `User` clause can
still reach a shared document from shared data that carries one, and section
3.3 keeps that apart from the defect.

**How it is kept from reading anything narrower.** By refusing the read in the
compiled path's own code (note 1200); no change of the storage, the scheduler
or the wave. `RuntimeTransactions` gets a state "no scope key" that the piece
sets for a space derivation. In it `scopeKey()` throws a typed signal and
`#address()` and `#readStored()` refuse a name of a scope, where today
`#actingIdentity()` falls back to the runtime's identity. In the executor,
`Instance.#ensure()` catches the signal for the entry being evaluated
(`#ensureOne` lets it through, since it is no failure of the cone), and the
places that ask for a key outside an evaluation (`#forActing`, `takeBack`,
`#pullScoped`) do not ask in that state. The entry then:

- is recorded as of that scope (`scopes.narrow`),
- has its writes of this transaction withdrawn (`#withdraw`), and
- is replaced, at the position that wanted its value, by the reference to its
  scoped place, which is the same text for every key.

Today's probe run on `main` runs with the smallest demander's identity and reads
that principal's instance before the node narrows. Here the first attempt reads
nothing.

**How the partition is known.** Three sources, tried in this order.

1. *The plan, once it reaches the executor.* It does not today. The crate emits
   a scope for each cone (`Output.scope` in `execution-and-storage.md` §1.8),
   computed by `place_scope` extended with the two rules the measuring round
   found missing:
   - *the element rule:* the body of a per-element construct has the scope of
     what the construct iterates. This is the case of a `map` over **plain
     values that a scoped `computed` gives**; it was not needed for a body over
     an array of references or over another construct's result in the corpus,
     and the rule is stated for all three alike.
   - *the request rule:* a cone that writes the request of an operation has
     the operation's scope, though it reads nothing.
   The alternative is to compute the scope in the executor from the artifact,
   as the instrument `planScopeOfCone` (`exec/scope-counts.ts`) does. I
   recommend the crate: one rule in one place, with the instrument kept as the
   check that the two agree. With the scope in the artifact the space
   derivation places the reference without attempting the evaluation, and the
   probing evaluations in `scopedOutput`, `scopedValue` and `#scopedRows` go.
2. *What is stored.* A position of a shared document that holds a link to a
   `~user` or `~session` document says the place is scoped.
3. *The refused read,* for whatever the first two do not answer.

Until source 1 is built, source 3 is how every scoped cone instance is found,
and the probes stay as the attempt that is refused. That is acceptable for the
rounds before it: over the whole corpus 257 cone instances are found scoped, so
the cost is 257 withdrawn evaluations. With source 1 and its two rules, six
remain for the refusal, all of one pattern. A scope only narrows.

*The alternative: a static partition only.* The compiler refuses, or plans as
scoped, every read whose scope it cannot show. The measurement speaks for it:
the two rules leave 6 of 257. It still fails
for those six and for any read through a link in data, and it differs from
today's discovered scope. I keep the recommendation: static where the plan
knows, the refusal otherwise, and the refusal always on, so that a wrong static
scope cannot let a scoped read through.

**A construct that mixes both.**

- *A per-element body over a shared collection that reads a per-user cell.*
  Where the plan sees the read as scoped, the expression is a cone of its own
  per element key (P454) and the row holds a link to its scoped value document.
  - Over **an array of references**: each row document is written once, by the
    space derivation, with the link in place of the value.
  - Over **an array of plain values held in place**: the same, with the row at
    its position of the output's shared document.
  - Over **the result of another construct**: the same where the upstream
    result is shared. Where the upstream is scoped (a `filter` whose predicate
    reads a per-user cell, then a `map` over it), the whole downstream
    collection is of the scope, stored per key (P474), and the space holds one
    link to it. The element rule is what tells the space derivation so without
    an attempt.
  Where the plan does not see the read as scoped, the body of the row is refused
  in the space derivation and the row becomes a scoped place, in all three
  cases. That costs an evaluation of the body per demanding key, as a node that
  narrows costs on today's path.
- *An instance a handler makes whose body reads `wish("#profile")`.* The
  handler's transaction creates the instance's argument and its empty result
  (P492). The space derivation behind the batch makes the first derivation of
  its shared part. No session's part is derived at the create.
  `settleMade()` as a transaction of its own and `#madePending` go.
- *An instance a scoped cone makes.* Two cases.
  - The instantiation is shared and only its argument holds scoped values
    (`<Row name={perUserValue} />`): the scoped value is a hoisted cone, the
    argument holds the reference, and the instance is of the space. Nothing new
    is needed.
  - Whether the instance exists depends on a scoped value (an instantiation in
    the body of a scoped collection or under a scoped condition). The instance's
    argument and result documents are of the space today, so L1 cannot hold for
    it. The choices are an instance per scope key, with every document of the
    child at the key, or a stated refusal. I recommend the refusal for now: the
    evaluation takes the error state it takes today
    (`#refuseStoredForEveryKey`), with a message that names the construct, and
    the compiler reports it where the scope is static. An instance per key is a
    design of its own (its streams, its handlers, its basis) and is question 8.
    How many corpus patterns hit the refusal is not counted (section 8).

### 3.2 Each session's part is derived only on demand

**What demand is.** The rows the memory server reports: a document id, a scope
key, and the (principal, session) whose tracked set holds it. A scoped place is
*demanded for a key* when a row exists for the document that stores it at that
key. Evaluating a demanded place pulls what it uses for that key and nothing
else.

The unit is the document, not the path. The scoped outputs of one instance at
paths of its result share one document; a scoped value in a row and a scoped
collection below a row each have their own. Demand per kept path (S&SL §4.2) is
left out, because the document is what the registry holds.

**The scoped action.** `CompiledPiece.#deriveScoped`, registered with the
`observationIdentity` of the piece, **as an effect**. An action that is not an effect carries no
demand (`isDemandRoot`) and would not run. As an effect it is always live, the
run supply gives it one run per demander of the piece root, and each run asks
what its key demands. A run whose key demands nothing derives nothing and writes
nothing; it costs one empty transaction. The action keeps P355's
`resetNarrowestReadScope`, for the reason in section 2.1: it is what tells the
scheduler the action is narrowed.

The alternative is to register each scoped document as a write of the action, so
that `enterDemandedEntity` makes it runnable by entity. That is a registration
per scoped place, which the compiled path exists to avoid. I recommend the
effect with the resolver.

**What the runtime's surface gains.** Two things, both in the serving loop's
demand code:

- A resolver the `SpaceServer` installs beside `runDemanderResolver`: for a
  piece root and one (principal, session), the documents under that root the
  pair demands. It reads `#demandersByKey` through both root indexes,
  `#keysByRootId` and `#keysByResolvedRoot`, as `#demandersFor` does: the keys
  that name the root and the keys resolved to it, which include the keys of
  pieces nested in it. With the direct index alone, a piece nested in a
  watched piece would have no demanded document and would stay underived.
- A callback from the demand pass to a compiled piece: where a key that arrives
  or departs lies under the piece's root, the pass tells the piece the pair and
  which. On an arrival the piece dirties `#deriveScoped` for that key
  (`dirtyFanOutKey`). On a departure that leaves the pair with no key under the
  root, the piece drops the pair's state.

The piece also dirties `#deriveScoped` by key, after a space derivation commits,
for each key with a due pull whose document is demanded. This needs a targeted
form of `invalidateAction`.

**What a scoped run does.** For its key K: read from the resolver the documents
demanded for K; bring the places stored in them up to date; write what changed
to K's instances; record K's basis. It evaluates no cone instance of the space;
where it needs one that is stale it leaves the key dirty. It runs after the
space derivation's commit has ended, by a commit callback, because a run of the
same pass cannot read the sealed write (note 1205). A session's values
therefore arrive one commit after the shared part's.

**An element nobody watches.** Its shared row is derived by the space
derivation like every other; an edit already costs the same evaluations at
every size. Its scoped places are not derived and not written for any key. For a
key with demand elsewhere in the piece, a change that reaches such a place marks
it due and nothing more. This holds alike for the place of a row over an array
of references, over plain values in place, and over another construct's result.

**A session no client holds, and the trigger for dropping its state.** A
session produces demand rows until the memory server prunes it,
30 seconds after it disconnects and then at the next read of the registry, and
nobody is told. The serving loop sees the keys gone at the next demand pass that
another cause starts. Dropping a key's state when the fan-out prunes its key
would need a run of the action that nothing causes. The trigger is instead the
demand pass's callback above: when `#retireDemandKey`
retires the pair's last key under the piece's root, the piece drops that pair's
memo entries, set-aside tables, copies of scoped documents, due marks and
counts, in memory, with no transaction. Due marks are kept per key with demand
(`#pullsSeen` becomes that set). A key that returns is treated as a key at a
restart.

So a session nobody holds derives and writes nothing from the demand pass that
follows its pruning. Between its disconnect and that pass it is still a
demander. Whether to shorten that by installing `sessionChanged` in the serving
host is question 3.

A scoped run whose transaction carries no stamped scope key does nothing, so the
serving runtime's own scope instances are no longer written by a derivation.

**An event, for instances nobody watches.** The handler runs once, for the
event's principal. The space derivation then brings the shared part up to date,
watched or not. No scoped run is made for a key without demand. A handler's own
reads of scoped places are brought up to date inside its transaction, as now
(`Instance.#attempt`).

**How this relates to today's demand passes.** It uses them: the registry, the
pass, the run supply, the fan-out's keys. It adds the resolver and the callback.

### 3.3 Labels

"Internal document" means the basis and its parts, the units and readers parts,
the minted document, the outside reads document and a stream marker with no
element key.

**L1. Which derivation writes where.** A commit of a compiled *derivation* that
carries scope key K writes only documents at K or at the `user` key of K's
principal. A commit of a compiled derivation that carries no scope key writes
only documents of the scope `space`. `RuntimeTransactions` refuses any other
write of a derivation when it is made. *Check:* the kind
`write-outside-run-key` of `compare/both-paths-gate.ts`, built by the measuring
round, at 0 (now 756 `keyed-into-space` and 199 `unkeyed-into-scope`).

L1 is not a rule for a handler. A handler's transaction acts for a principal and
writes shared documents by design: the state it sets, the argument of an
instance it makes, its receipt, the counts. What it may *not* store is a derived
value under its own join. The code allows that and the corpus never does it (0
in 278 scenarios). I recommend not building a deferral for a case that does not
occur, and making the instrument `derivedInHandler` a gate that fails above 0.

**L2. A shared document holds no clause of a run.** A document of the scope
`space` that a compiled derivation wrote carries `User(p)` at a position only
where the position's record names an input that carries it or, with no record,
where a shared document that space derivation read carried it. *Check:*
`foreign-clause` with the source `keyed-write` at 0 (now 182 of 187).

**L3. A scope instance holds no other principal's clause.** A document at a key
of principal p carries `User(q)`, q ≠ p, only where a shared document its cone
read carries it. *Check:* `crossed-clause`. The split removes the source
`read-keyed-space` (42 of 228). It does not remove the 156 in documents no
compiled transaction wrote or the 30 that follow from them
(`read-labeled-instance`): those come from the `wish` action.

**The `wish` action.** The runtime's `wish` runs as an
action of today's path, fanned out per demander, and a change to one
principal's home or profile, a document of the scope `space` in another space,
is handed to every instance's run as a trigger read. That is the crossing on
`main`, and the compiled piece inherits it through this action. The
compiled path gets the trigger rule by construction for the piece's own
actions and not for this one. Two ways
to close it:

- *(a) Depend on #10262.* The `wish` stays the runtime's action. With #10262 a
  cause that names no instance reaches only the instances whose last run read
  its document, so B's run is neither made nor handed A's home as a trigger.
  Cost on the compiled side: none beyond having the fix on the build branch.
  Cost in dependence: L3 is not met until #10262 is merged, and it is open. The
  action stays an effect per `wish` and per demander of the piece; for a key
  whose request was never written it reads the request, finds none and returns,
  which is one empty run per `wish` and demander and no write.
- *(b) Answer the `wish` inside the scoped derivation's transaction.* The piece
  calls the runtime's resolution in K's scoped run. Then no separately fanned
  out action exists. It costs more than it appears to: the resolution is
  asynchronous in some branches and a derivation transaction is not; the
  resolution's reads would have to wake the scoped action, and if they are
  registered with the scheduler the same fan-out hands them to every key again,
  so (b) needs #10262 as well or a tracker of its own beside the scheduler's
  (`OutsideReads` does this for a resume only). The four fetch effects are
  registered the same way and cannot move into a derivation at all.

I recommend (a). It fixes the defect where it is, for both paths, and (b) either
depends on the same fix or builds a second dependency tracker. The dependence is
stated in the order of work: the round that claims L3 comes after #10262 is on
the build branch.

**L4. The reference to a scoped place carries no label of the value** (P491,
narrowed to the output's own scoped place as its reviewer asked).

**L5. Bookkeeping does not carry a label onward.** A derivation reads an
internal document with a read that adds no flow label (`labelBasisRead`, as
P493 does for the basis). This matters most for the minted document, which a
handler writes under its own join and a derivation reads. *Check:* no clause of
a handler's actor on a document that only a space derivation writes; the
positions a handler itself wrote are exempt. What label an internal document
itself owes stays round thirty's deferred question 1. After L1 it is not a
session's: 544 of the 604 uncovered keyed writes are bookkeeping, and all move
to the space derivation.

**L6. A handler's input (Z100).** The event's payload contributes no `User(p)`
clause of the acting principal p to what the handler writes. The five
`handler-write` findings that remain after the split are this case (one corpus
module, a handler that writes its payload into a cell). Its reach is question 2.

**The receipt.** With one session held, the third headless create and each
after it is refused: the receipt's writer fit does not admit the acting
principal's `User` clause (note 1190 (b)). The clause is on shared documents the
handler read, put there by a keyed run. With L1 the handler reads no such
clause, so the refusal is expected to go; it is a check of the split's round and
not a rule of its own.

**Classification under `docs/development/cfc-spec-correspondence.md`.** The
author's classification, for a reviewer to apply the three tests to afresh; the
specification is private and no section is cited.

| Rule | Class | Why |
| --- | --- | --- |
| L1, the two transactions, the refusal | Host arrangement | Which run a write belongs to and which run evaluates a cone are the host's. It stores less label than the code stores now, so it is said first in any report. |
| L2, L3 | Conforming implementation | A label comes from what a write depends on. |
| The `wish` action under #10262 | As #10262 is classified on `main` | Nothing is decided on the compiled side. |
| L4 | As round thirty classified P491, once narrowed | No change here. |
| L5 | Semantic gap, unless P493's classification covers every bookkeeping document | It adds documents whose reads are not consumed. |
| The refusal of an instance made by a scoped cone | Host arrangement | It refuses an evaluation; it decides no label. |
| L6, Z100 | Semantic gap | The plan says so already. |

### 3.4 Restart, takeover, update

**Restart and takeover (Z90).** The shared part gets one basis, written by the
space derivation only, with no source that has no number.

- A piece with a `wish` or scoped state is found current from its basis where
  its shared sources did not change. `#sourceOfNoNumber`, `#basisOfEveryKey`
  and the rule "a piece with scoped documents resumes whole" (P354) go.
- A wake evaluates the units a change reaches and leaves the other shared rows
  as stored, for a piece with scoped state too. This covers rows over an array
  of references, as a wake by units does today; rows over plain values in place
  and over another construct's result are evaluated whole at a wake.
- Each scope key has a basis of its own, the scope instance at that key of one
  basis document. A session's first demand after a restart compares it; a key
  with no demand costs nothing.

The design removes the stated cause of the 8.5 s. Whether the first edit then
meets 2.3 s is a measurement.

**A pattern update.** No update of a compiled piece exists. Under the design an
update changes the identity in the shared basis, so the shared part is derived
whole once; each key's basis is found stale at that key's next demand; a place
that moved from shared to scoped is handled as P458 handles it; scope instances
of a place that moved the other way are left unreferenced.

### 3.5 The stored layout, and existing pieces

Unchanged: every shared document and the three kinds of scoped place. New: the
per-key basis. No longer written: the serving runtime's own scope instances.
An existing compiled piece resumes whole once and writes the new basis. No
compatibility work is proposed.

### 3.6 What this removes from the current code

- `CompiledPiece.#madePending` (P450) and `settleMade()` as a transaction of its
  own.
- `#basisOfEveryKey`, `#sourceOfNoNumber`, and the whole resume of a scoped
  piece (P354); the guards `if (!transactions.scoped)` around `outside.flush`
  and `#units.record`.
- The fallback of `RuntimeTransactions.#actingIdentity()` to the runtime's own
  identity inside a derivation.
- `#pullsSeen` as every key ever evaluated for, and the visit of every pull for
  a new key.
- The probing evaluations in `scopedOutput`, `scopedValue` and `#scopedRows`,
  once the crate emits a scope per cone, and not before.

It does not remove `resetNarrowestReadScope` (P355), which moves to the scoped
action, or `#refuseStoredForEveryKey`, which stays as the refusal of an instance
a scoped cone makes.

## 4. What can be checked

Baselines are the measuring round's, on the code at `429f0c6a86`. "The board" is
`compare/topics/held-sessions.ts`, a create from the composer; s is the number
of sessions held. "The corpus" is
`deno run -A --no-check base/pattern-compiler/compare/both-paths.ts <out.jsonl> --sets=hand,named,corpus`
(421 scenarios, 278 ran).

| Claim | Check | Now | After |
| --- | --- | --- | --- |
| A derivation with no key writes no scope instance | Corpus, `write-outside-run-key`, landing `unkeyed-into-scope` | 199 | 0 |
| A keyed derivation writes no shared document | Corpus, landing `keyed-into-space` | 756 (604 under no record) | 0 |
| A create's transactions grow by at most one per scope key | Board, transactions of the piece per create at s = 1, 3, 5, 9 | 4, 18, 31, 114 | handler + space derivations + at most one per demanding key |
| No commit of a pass fails against another run of the pass | Board, failed commits per create at s = 1, 3, 5, 9 | 0, 4, 10, 35 | 0 at each |
| The shared part stays as cheap as it is | Board, evaluations of the space per create; shared documents written | 31; 74 to 88 | not above these |
| A headless create commits at every size | Board, events to `addTopic` with one session held | refused from the third | all commit |
| No clause of a run in a shared document | Corpus, `foreign-clause` by source | 187: 182 `keyed-write`, 5 `handler-write` | 5, until Z100 is built |
| The same on the board at 40 topics | Board, `foreign-clause` at s = 1, 3, 9 | 3,350; 3,328; 3,337 | 0 beyond any handler writes |
| No crossed clause from a keyed run's shared write | Corpus, `crossed-clause`, source `read-keyed-space` | 42 | 0 |
| No crossed clause from the `wish` action | Corpus, `crossed-clause` in documents no compiled transaction wrote, and `read-labeled-instance`; board at 40 topics | 156 and 30; 480 | 0, with #10262 |
| The plan's scope reaches the executor | Corpus, `foundScoped` with no plan scope | 106 of 257 | 6 |
| A handler stores no derived value | Corpus, `derivedInHandler` | 0 | 0, as a failing gate |
| A session derives what it demands | Board at 10 topics, evaluations of the scope `session` per create at s = 1, 3, 5, 9, with sessions that hold the rendered tree | 39, 153, 281, 585, growing by 2, 4 and 10 a topic at s = 1, 3, 9 | no growth with topics; scope instances written per create bounded by those demanded (6 board-level for each such session) |
| A session nobody holds derives and writes nothing | Board: after the demand pass that follows the session's pruning, commits stamped with its key over ten creates; its entries in the piece's counts | derived at every change | 0 commits; no entry |
| An element nobody watches has no scoped document | Store dump, one fixture per case: over an array of references, over plain values in place, over a `filter`'s result | one per row and key | none for an unwatched row |
| A scoped read cannot pass the partition | A fixture with a link in data to a per-user document, read in a body the plan gives no scope, per case of collection: the space derivation's commit lists no read of a scope instance | not tested | holds |
| Restart | `compare/topics/scale.ts serving 2000` with a takeover against `serving-today`; `compare/runner-corpus.ts … --serving --resume` | 8.5 s against 2.3 s; 71 pieces found current | no slower than today's; 80 |
| Latency of a session's value | Time from the event's commit to the watcher's scoped commit, against today's path | not measured | reported |

Clause counts varied between the measuring round's runs (`foreign-clause` 187 to
207, `crossed-clause` 137 to 408). A check that reaches 0 is not affected; a
check against a nonzero baseline is taken over several runs.

## 5. Questions for the owner

1. **How the partition is known.** (a) The plan's scope where it has one, what
   is stored, and the refused read for the rest. (b) Static only.
   *Recommended: (a),* with the refusal always on. The two static rules leave 6
   of 257 cone instances to the refusal on the corpus.

2. **The reach of Z100 for a handler.** (a) The event's payload only. (b) The
   payload and a per-session or per-user cell the acting user's client wrote
   through a binding. (c) Everything labeled `User(actor)` the handler writes
   to the space. *Recommended: (b),* with a value labeled by its content, such
   as a profile, shared by storing its link. The five handler findings are a
   payload written to a cell, which (a) already covers. Goes through the
   specification before code.

3. **When a session stops demanding.** (a) As today: the demand pass that
   follows the memory server's pruning, at least 30 seconds after the
   disconnect and later if nothing reads the registry. (b) Install
   `sessionChanged` in the serving host so that the removal starts a demand
   pass, for both paths. (c) End demand at disconnect. *Recommended: (a) for
   this work,* with the ship criterion read as "once the demand pass has
   retired its keys". (b) is small and a change to `main` of its own.

4. **Whether the shared part is derived for elements nobody watches.** (a) Yes.
   (b) No: per-path demand for shared outputs, as S&SL §4.6. *Recommended: (a).*
   The measurement supports it: the shared part of a create costs the same at
   every size and number of sessions.

5. **One scoped effect with a registry resolver, or each scoped document
   registered as a write.** *Recommended: the one effect,* at the cost of the
   resolver, the demand pass's callback and an empty run for a demander whose
   key demands nothing.

6. **Internal documents.** Whether a derivation's reads of the minted document
   and the other bookkeeping consume no flow label (L5). *Recommended: yes;*
   what label they carry themselves stays deferred.

7. **The `wish` action.** (a) Depend on #10262 and keep the runtime's action.
   (b) Answer the `wish` inside the scoped derivation's transaction.
   *Recommended: (a).* It needs #10262 merged and on the build branch before
   L3 can be claimed.

8. **An instance whose existence depends on a scoped value.** (a) Refused, with
   a message that names the construct, as the code does now. (b) An instance
   per scope key. *Recommended: (a) now,* and count the corpus patterns it
   refuses before deciding on (b).

9. **Where the plan's scope is computed.** (a) The crate emits a scope per cone.
   (b) The executor computes it from the artifact. *Recommended: (a).*

## 6. Order of implementation

Round 1 was the measuring round and is done. Each later round is one agent, test
first, and is accepted on the number it names, taken with the instruments of
round 1.

2. **The refusal, under the load alone.** The "no scope key" state of
   `RuntimeTransactions`, the catch in `Instance.#ensure()`, and the load and
   every derivation the scheduler runs with no key set to it. `#derive` stays
   one fanned-out action. Changes `compiled/` and `exec/` only. *Must move:*
   `unkeyed-into-scope` from 199 to 0, with the values the comparison reads
   unchanged in the 32 scenarios that have a scoped document. *What it tells:*
   whether the refusal and the reference in its place work across the corpus,
   which every later round stands on, and how many evaluations are withdrawn
   (expected near 257).
3. **#10262 onto the build branch,** when it is merged. A merge, not a design
   round. *Must move:* `crossed-clause` in documents no compiled transaction
   wrote from 156 to 0 and `read-labeled-instance` from 30 to 0; on the board
   at 40 topics, the 480. If they do not move, the `wish` action has a second
   cause and question 7 is open again. It can run beside rounds 2 and 4.
4. **The two actions.** `#deriveSpace` under the refusal, owning every shared
   write and the bookkeeping; `#deriveScoped` as an effect with P355's reset,
   behind the space commit, still deriving everything for its key; L1 refused
   at the write. Remove P450. *Must move:* `keyed-into-space` from 756 to 0;
   failed commits per create from 0, 4, 10, 35 to 0; transactions per create
   from 4, 18, 31, 114 to at most one per key beyond the handler and the space
   derivations; `foreign-clause` from 187 to the 5 handler writes;
   `read-keyed-space` from 42 to 0; the headless create commits. *Must not
   move:* 31 shared evaluations and 74 to 88 shared documents per create.
5. **The mixed constructs, by case.** A fixture and a stored-labels test under
   differing clauses for a body over an array of references, over plain values
   in place and over a `filter`'s result, each reading a per-user cell
   statically and through a link in data; an instance a handler makes with a
   `wish`; an instance under a scoped condition, refused. This is the test the
   ship criteria's section 2 asks for. *Must move:* the "scoped read cannot
   pass" row from untested to holding.
6. **The plan's scope in the artifact,** with the element rule and the request
   rule. Remove the probes. *Must move:* cone instances found scoped with no
   plan scope from 106 to 6, and withdrawn evaluations to the same 6.
7. **Demand for scoped places.** The resolver and the demand pass's callback;
   `#deriveScoped` derives demanded documents only; no scoped run without a
   stamped key. *Must move:* on the board with sessions that hold the rendered
   tree, evaluations of the scope `session` per create stop growing with the
   topics (now 2, 4 and 10 a topic at 1, 3 and 9 sessions), and scope instances
   written per create fall from 12, 33, 45, 69 to those demanded.
8. **Keys that leave.** The piece drops a pair's state on the callback. *Must
   move:* the counts and the memory of a piece flat over sessions that come and
   go; zero commits for a pruned session's key.
9. **The basis per key, and the wake by units for a piece with scoped state.**
   *Must move:* 8.5 s toward 2.3 s, and 71 pieces found current to 80; peak
   memory on the 2,000-topic board reported.
10. **Labels that need a ruling:** L5 and Z100, after the specs pull requests.
    *Must move:* the 5 handler writes to 0. Then the update of a compiled
    pattern.

Round 2 is the smallest change that tests the mechanism the design rests on.
Rounds 2 to 5 close the label findings; 7 and 8 close "cost follows demand"; 9
is Z90. Round 6 can move later without blocking 7.

## 7. What it costs

- A session's values arrive one commit after the shared part's.
- Until the plan's scope reaches the executor, each scoped cone instance is
  evaluated once and withdrawn before it is known to be scoped; afterwards, the
  few the plan cannot see.
- A row whose whole body is found scoped is evaluated once per demanding key.
- Demand is per document.
- An empty scoped run for each demander whose key demands nothing, and an empty
  `wish` run per `wish` and demander whose request was never written.
- L3 waits on a pull request against `main` that is open.
- Two additions to the runtime outside `compiled/`, both in the serving loop's
  demand code.

## 8. What this document did not establish

Scaling findings first.

- **The bytes a create writes grow with the topics held:** 130 kB at 0 topics
  and 871 kB at 40 with one session, 430 kB to 2,612 kB with nine. The number
  of shared documents does not grow, so some documents grow with the board.
  The measuring round does not say which. The design does not address this, and
  it is a defect by the ship criteria's section 3 whatever the split does.
- **The time of a create grows with the topics held:** 4.3 s at 10 topics and
  29 s at 40 with one session, clients included. Where it goes is not known.
  The design removes failed commits and repeated transactions, which are per
  session, not per topic, so it does not explain this either.
- The handoff's "a create writes about 132 + 5.4n documents" was taken on a
  toolshed with other sessions; the measuring round's in-process figure is 74
  to 88 shared documents and a constant number of scope instances at each
  number of sessions. The two are not reconciled; the 5.4 a topic is consistent
  with a session that demands 22 scope instances a topic, and that is a guess.

The rest.

- Whether two different actions of one settle pass see each other's sealed
  writes was not tested. The design assumes not and uses the commit callback.
- How many corpus patterns make an instance under a scoped value and would be
  refused under question 8 (a).
- That #10262 removes all 156 and 30 crossed clauses. The ones the measuring
  round traced are the `wish` action's; the rest are inferred to be.
- The six cone instances the two static rules do not cover were not traced to
  the link they read through.
- The headless create's refusal was not checked at `a04632cb2c` without the
  instruments, and that it goes with the split is an inference from the
  clause's source.
- A session that holds the rendered tree stands in for a browser in the
  demand figures and is not one.
- That removing the whole resume brings the first edit after a restart to
  2.3 s.
- The classification of each label rule against the specification's text.
- Notes 1200 to 1204 are the source of the remaining statements of section 2;
  I read the code for `isDemandRoot`, the fan-out,
  P355's reset, the `wish` registration, the observer the serving host installs
  and the session time to live, and took the rest from the round's notes.
- No experiment was run for this document.
