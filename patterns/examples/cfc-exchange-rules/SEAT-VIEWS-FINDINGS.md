# Seat views: findings

What building `seat-views.tsx` (a card table with hidden hands, each seat's view
released to that seat's occupants) showed about releasing to a list named by a
cell. The mechanism is the ruling proposed in commonfabric/specs#59, as drafted
in labs#8608 (`alex/cfc-list-audience`), ported here onto
`fix/served-handler-write-identity` (labs#10111). The runtime is that branch
plus the port, on Deno 2.9.8, on 2026-11-21. Nothing here is merged, and the
ruling has not been made.

Each finding says how it is known:

- **Ran** means a test in the tree pins it, and the test is named.
- **Ran, not kept** means a development run showed it and no committed test pins
  it.
- **Read** means it comes from reading the cited code or document.
- **Inferred** means a conclusion drawn from the others.

The tests are `seat-views.test.tsx` and `seat-views-multi-user.test.tsx` beside
this file (pattern tests), and
`runtime/html/test/worker-display-fit-seat-views.test.ts` (the "display test"
below). The display test runs three principals, each in a runtime of their own
on one in-process memory server, and decides what each is shown the way the
reconciler does. None of its runtimes is a serving runtime. Nothing here ran in
a browser or against a toolshed.

`SEALED-STATE-MACHINE-FINDINGS.md`, on the branch
`worktree-agent-ad697e53f88bab905`, is the earlier spike this one builds on. Its
gaps A to H are cited by letter.

## The short answer

"Deal to player p" works on this branch for a player who seats themselves: the
display test shows Alice her own seat's view and not Bob's, Bob his and not
Alice's, and a watcher neither. It took two changes to the draft and five
contortions in the pattern to get there, and the result is **not safe against
the table's owner**: the owner can list themselves in another player's seat and
read that player's hand (worry c, below). A card table, an auction or a ballot
box should not ship on this mechanism until a list's writer is bound to the run
that owns the list.

The hypothesis as stated, that `move` writes each seat's occupant list, does not
hold. An entry `move` writes carries the sealed state's clause, and list
resolution counts no such entry.

## What ran

| Check                                                                 | Posture               | Result                                                                                    |
| --------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| `cf test seat-views.test.tsx`                                         | server execution off  | 29 passed                                                                                 |
| `cf test seat-views.test.tsx`                                         | server execution on   | 29 passed                                                                                 |
| `cf test seat-views-multi-user.test.tsx`                              | server execution off  | 23 passed                                                                                 |
| `cf test seat-views-multi-user.test.tsx`                              | server execution on   | 23 passed                                                                                 |
| Display test                                                          | three client runtimes | 4 tests, 13 steps, passed; run five times, three of them before the fourth test was added |
| The runner tests labs#8608 adds or extends (seven files)              | one client runtime    | 11 suites, 145 steps, passed                                                              |
| `runtime/html/test/worker-reconciler-cfc-render-policy.test.ts`       | one client runtime    | 66 steps passed, the list re-render among them                                            |
| `runtime/runner/test/executor-trust-attribution.test.ts`              | a live serving loop   | passed                                                                                    |
| `deno task cfcheck --only examples/cfc-exchange-rules/seat-views.tsx` |                       | exit 0                                                                                    |
| `deno fmt --check` on every file touched, `deno lint` repository-wide |                       | clean                                                                                     |
| `deno task check`, repository-wide                                    |                       | exit 0                                                                                    |
| `deno task check-cfc-correspondence`                                  |                       | fails, as it must: the port cites §4.9.5 and §8.7.5, which the pin has not                |

"Server execution on" is `EXPERIMENTAL_SERVER_EXECUTION` unset, which resolves
to on; "off" is the variable set to `false`.

The seven runner files are `cfc-list-membership`, `cfc-list-release-render`,
`cfc-runtime-list-membership`, `cfc-members-capture`,
`cfc-members-capture-commit`, `cfc-policy-template` and `cfc-grant-records`,
each `.test.ts` under `runtime/runner/test/`.

## The port

labs#8608 is nine commits over 29 files, cut from a main 1,346 commits behind
this branch's base. It was re-applied as one change, with its paths rewritten
for the move of `packages/` to `base/` and `runtime/`. 24 files applied cleanly
and five conflicted:

- `runtime/html/src/worker/display-fit.ts`: two import and type hunks, both
  kept.
- `runtime/runner/src/cfc/atom-classes.ts` and `label-field-classification.ts`:
  the two tables the draft extends now live in the memory package, so the
  `ListedIn` class went to `runtime/memory/v2/cfc-atom-classes.ts` and the four
  field classifications to `runtime/memory/v2/cfc-label-fields.ts`.
- `runtime/runner/src/cfc/grants.ts`: imports only.
- `runtime/runner/src/cfc/prepare.ts`: the draft's reader of a position's owner
  claims took a transaction; main's `representedPrincipalsAt()` takes a loaded
  envelope, and `membersCaptureReadsFor()` now calls that.
- `runtime/runtime-client/src/backends/runtime-processor.ts`: main configures
  the render ceiling in one method, `#configureRenderCeiling()`, so the list
  provider is built there, and is also handed to the host read gate, which the
  draft predates.

After that, four things did not compile: imports of `@commonfabric/utils`, now
`@commonfabric/js-values`; the clause helpers, now exported from
`@commonfabric/memory/v2/cfc-release-authority`; a variable the capture hunk
named that main had inlined; and one test's use of a `path` that
`StoredCfcTarget` no longer has. One import statement was merged for the lint
rule that allows one per module. Main has also gained a table that has to name
every `ifc` key, `SELECTION_IFC_KEYS` in `runtime/cli/lib/cell-selection.ts`,
which fails to type-check until the new `members` key has a row; a selection
drops it, as it drops the other keys that bind a position's writer.

**Its tests.** Six of the seven runner files and the html file passed as ported.
`cfc-members-capture-commit.test.ts` failed all four cases with
`module policy schema atoms require compiler-lowered PolicyOf`: main refuses a
module policy atom written into a schema with a concrete subject. The fixture
now names its policy as the compiler lowers `PolicyOf`, with the owning-space
placeholder and a registered manifest, and all four pass. That includes the
admitted case, which the pull request says had never passed locally.

**Port note 3: the compiler refuses `cfcPattern.members()`.** The draft adds it
to `base/api/cfc.ts` and not to the transformer, which answers
`unsupported cfcPattern.members() declaration`
(`base/ts-transformers/src/transformers/cfc-policy-authoring.ts:190`). The rule
in `seat-views.tsx` writes the `Members` pattern as a raw atom. **Ran, not
kept.**

**Not ported, because the draft does not have them:** an authoring alias for
`ifc.members` (the example writes `Cfc<T, { members: "/occupants0" }>`), and the
helper that pins a principal into an entry at a gesture.

**Two changes to the draft**, in a commit of their own and marked
`SPIKE(seat-views)`. Without them no compiled pattern passes the capture check.

1. _A bug._ The check reads whether a position "declares its writers" off the
   schema at that position, and the compiler hoists a named type into `$defs`,
   so the position holds a `$ref` with no `ifc` beside it. Both readers now
   resolve the reference (`membersCaptureReadsFor()` in
   `runtime/runner/src/cfc/prepare.ts`, `declaresWriterAt()` in
   `runtime/runner/src/cfc/runtime-list-membership.ts`).
2. _A model of a rule the draft does not state._ The draft requires the list
   position in the run's result, and the list it links to, both to be the
   actor's. A compiled pattern's result holds a link at that position, written
   when the run started, and that slot carries the declared confidentiality and
   no owner claim. The check now judges a position that holds a link at the
   link's target alone (`membersCaptureClause()` in
   `runtime/runner/src/cfc/members-capture.ts`). That is where the display
   boundary reads the entries too (`listedInReplica()`). Whether it is sound is
   a question for the ruling; it is finding 7.

## The worries

### (a) The witness

**Verdict: as specified, and the hypothesis is right about it.** A seat's view
keeps the input witness the rule names when `move` wrote both the state and the
seat's key, and loses it when another handler wrote the key.

- **Ran.** Display test, "shows each occupant their own seat's view": the
  release fires, which needs
  `TransformedBy{seatView, inputWitness: TransformedBy{move}}` on the view.
- **Ran.** Display test, "display fit of the seat views with keys another
  handler wrote". The same table with its keys written by a handler `keyer`,
  which reads the state so that its keys still pass capture: the occupant's view
  is computed, and the occupant is shown nothing.
- **Read.** `docs/specs/cfc-transformed-by-input-witnesses.md`, "Confidential
  input locations": the witness is the meet over the read's confidential
  locations, and "an observation that carries no confidentiality is a public
  input" that does not constrain it.

So a per-seat parameter has to be confidential and written by `move`, or it is
either a witness the view lacks or a public input anyone who can write it can
steer. Making setup a move is what satisfies that.

### (b) The capture check

**Verdict: reachable from a compiled pattern only with the two changes above,
and then only in one arrangement.** With them, the owner's setup move passes,
with server execution on and off.

- **Ran.** `seat-views.test.tsx`, the assertions after the first `setup`, and
  `seat-views-multi-user.test.tsx`, Alice's first two assertions: a view of each
  seat follows the setup. A key the check refused is not written, and `seatView`
  returns nothing without one, so a view means the check passed. With server
  execution on the handler's authoritative run is the serving loop's.
- **Ran.** Display test: every view's label holds
  `[User(owner) ∨ Members(list, table)]` beside the policy clause, which is what
  the release rule's precondition matches.

What the arrangement has to be:

- **"Exactly one module-policy clause."** The check counts the clauses the
  transaction's flow label carries (`membersCaptureClause()`, the `owned`
  filter). `move` reads the sealed state before it writes the keys, so the one
  clause is there. It is the transaction's label, not the key's own declared
  one: **finding 5** is the consequence.
- **"A run of the module the policy names."** The table has to be the entry
  module. **Ran, not kept:** a one-line entry module that re-exports the table
  is refused, "members requires the output to belong to a run of the module the
  policy names". This is the imported-policy question already on specs#59, with
  a smaller case than Find My's: not a shared policy module, only an
  `export default Table`. The same table run as a sub-pattern of another pattern
  passes, since the sub-pattern's run is the table module's own.
- **The acting principal solely owns the subject.** Only the owner's run can
  write a key, so the design never authors a `Members` clause anywhere else. A
  view inherits the key's clause as an input label, in whichever principal's run
  recomputes it. **Ran:** the display test deals after Bob has acted, and the
  multi-user pattern test's views update for every participant.

That answers question 2 of our comment on specs#59 for this runtime: a `Members`
clause carried in from an input does satisfy the rule's precondition, with no
capture in the run that recomputes the view.

### (c) The second run

**Verdict: the attack as we described it is stopped, by an accident. A simpler
one succeeds.** A witness or a writer bound to the instance is needed, and the
list's writer needs it as much as the state's.

**The state, as described on specs#59.** The owner starts a second run of the
table inside a pattern that hands it the live table's state, sits in a seat of
it, and reads that seat's view.

- **Ran.** Display test, "against a second run on the table's state". The second
  run's view of seat 1 holds the live table's seat-1 hand, and the owner is
  shown none of the second run's views. The live table's own views are still
  shown to Alice and Bob as before.
- **Why it is stopped.** The second run reaches the state through a link in its
  argument. Which reference sits at a slot is an input, and `move` did not write
  that slot, so the view has no witness. This is gap D of the earlier findings,
  which that document files as a missing feature for composition and proposes to
  fix by treating the runtime's own argument wiring as evidence. **Inferred:**
  that fix, made without binding the witness to an instance, opens this attack.
  The two have to be ruled together.
- **The example also stops it on its own**, by refusing a second setup
  (`applyMove()`, `if (state.ready) return undefined`): a second run gets no
  keys. The test removes that line to reach the runtime's answer. A pattern
  author should not have to know that the line is load-bearing.
- **Ran, not kept.** The host cannot start the second run directly: a run whose
  argument puts a link at a position that declares a writer is refused at its
  first commit, "writeAuthorizedBy requires a trusted verified binding identity
  at /state". A pattern that takes the state as `any` and passes it on is not
  refused, which is how the test does it.

**The list.** The owner runs a pattern of another module that imports the table
module's `seating` handler and binds it to the live table's seat-1 list, with a
phase and a roster of its own. The owner opens that seating and sits.

- **Ran.** Display test, "against a second binding of the list's writer". The
  live table's seat-1 list then holds the owner and not Bob, the live table's
  roster still says Bob, and the owner is shown seat 1's view, which is Bob's
  hand.
- **Why it works.** The list's declared writer is `seating`, a handler named by
  its module and export. `writeAuthorizedBy` admits that handler wherever it is
  bound. The capture check ran once, when the key was written. The display
  boundary checks only that the list's position declares a writer, and that the
  entry's label names the principal it pins (`listedInReplica()`,
  `listedInEntries()`); it does not ask which run wrote the entry. The entry the
  owner's run wrote is labeled for the owner, as any entry is labeled for its
  writer.
- **What does not stop it.** Keeping the lists out of the table's argument
  (finding 6) stops a second run of the table itself from being pointed at them.
  It does not stop another pattern binding the exported handler, and
  `WriteAuthorizedBy<…, typeof seating>` needs the handler to be nameable.

**Inferred, not run.** `move` has the same exposure. It reads the phase and the
roster, which are public inputs; another module's pattern can bind `move` to the
live state with a phase and a roster of its own choosing and make any move the
rules allow for them. With only `setup` and `deal` that gains nothing here. In a
game with a move such as "show seat 2 the top card", it would.

**So, to the question on specs#59:** yes. For a subject whose owner is a
custodian and not the beneficiary, every claim of the form "written by handler
H" has to mean "by H as bound in the run that owns this document". That covers
the witness on the sealed state, and the declared writer of the list and of the
key. The custody seal already names its instance; the general mechanism does
not.

## Findings that shaped the example

### 1. A list entry the sealed state's writer wrote lists nobody

**Ran, not kept** (commit `739333490a`, the example as the hypothesis states it,
with one handler writing the state, the keys and the lists). Setup passed the
capture check and every view carried the witness and the `Members` clause, and
no principal was shown any view. Each entry's label was the policy's clause
alone.

**Read.** Two rules meet. A transaction has one confidentiality join
(`runtime/runner/src/cfc/prepare.ts`, "S16 flow labels"), so everything `move`
writes carries the sealed state's clause; that is gap F. And an entry counts
only when "it has at least one clause, and every clause has a `User(principal)`
alternative" (`labelNamesPrincipal()`,
`runtime/runner/src/cfc/list-membership.ts`), judged "without exchange rules".

**Class: specification question.** The entry rule exists so that a viewer does
not learn a membership bit from data they cannot read. An entry the releasing
policy's own writer wrote, under the same subject the `Members` atom names, is
not that case. The ruling could count it, or could say that such a list is the
"computed list" it defers.

### 2. The seat binding is written twice, by a handler that is not `move`

`seating` writes a public roster and, beside it, each seat's list. The roster is
for code: `move` reads it to deal. The list is for the display boundary, which
needs entries labeled for their principals. `move` can write neither: it cannot
write anything public (gap F), and what it writes into a list lists nobody
(finding 1). `seating` cannot read the sealed state, so it cannot know whether
the cards are dealt, and a public phase, which the owner opens and closes,
stands in for that.

So seating is not a move, and the sealed state does not record who sits where.
Who sits where is public at a card table, so nothing is lost here. A game where
seating is secret has no shape that runs.

**Class: follows from finding 1 and gap F.**

### 3. Only a principal's own run can list them

**Ran.** Display test, "ignores a seat taken for somebody else" and "seats each
principal who sits for themselves"; `seat-views-multi-user.test.tsx`, Carol's
`sitForBob`.

An entry is labeled by the `CurrentPrincipal` reader, which binds to the acting
principal of the run that creates the entry's document. There is no label a
pattern can write that names another principal, so the table's owner cannot seat
a player, and the example refuses the request. The draft's answer is the gesture
helper that labels an entry `[User(p) ∨ User(owner)]`, which is not built.

Getting even the self-seating label took three tries, all **ran, not kept**:

- Entries as strings in a list whose items are `OnlyMe<string>`: the label sits
  on the list's `*` slot and was bound to the owner when the run's start seeded
  the empty list. Bob's entry was labeled for Alice, and listed nobody.
  `docs/features/current-principal.md`, "A reader named `CurrentPrincipal`": "a
  store already holding labels keeps the readers it stores".
- Entries as records in a list whose items are `OnlyMe<{ principal }>`: the
  record becomes a document labeled for Bob, and the pointer to it still carries
  the list's `*` label for Alice. The draft joins the two, so the entry had
  `[User(alice)] ∧ [User(bob)]` and listed nobody.
- What runs: the list's items carry no label, and `seating` makes the entry as a
  cell of its own, `new Writable<Occupant>({ principal: actor })`, and puts that
  in the list (`seat-views.tsx`, `seating`). The cell is a new document under a
  parent that names no reader, so it binds to the actor.

**Class: unimplemented ruling** (the helper), and the three tries are a hazard
for the next author: each compiles, runs, and silently lists nobody.

### 4. The list is named by a pointer in the schema, so the seats are fixed

`ifc.members` is a JSON pointer into the run's result, written in the type. One
seat's key therefore needs one type: `SeatKey0`, `SeatKey1`, `SeatKey2`, and
three fields of everything. A table cannot have a number of seats chosen at
setup, and an auction cannot have one list per bidder.

**Class: specification question.** The draft's Find My case has one list. A
per-recipient release needs the pointer to take a parameter from the value, or
the key to name its list by reference.

### 5. A key cannot have a default

**Ran, not kept.** With `key0: Writable<Default<SeatKey0, -1>>` the run's first
commit is refused: "members requires exactly one module-policy clause whose
subject the acting principal solely owns at /key0". The capture check runs on
every write to a position that declares `ifc.members`, the write that seeds a
default included, and that write read nothing sealed.

**Class: labs bug in the draft, or a rule to state.** The key in the example has
no default, and `seatView` treats a missing key as no view.

### 6. Putting a record in a list makes its writer a reader of the document that holds the list

**Ran, not kept.** With the lists in the table's argument, Bob's `sit` was
refused: "writer-fit confidentiality misfit" for the new entry document, naming
the policy clause and all three keys' clauses. Storing a record in a list reads
the document holding the list (the README beside this file says so of
`witnessed-chain.tsx`), and the argument holds the sealed state and the keys.

So each list is a cell of its own, made in the pattern's body (`seat-views.tsx`,
`new Writable<Occupants>([]).for("occupants0")`). The result links to it in one
hop, which is what the capture check and list resolution follow.

**Class: a consequence of the per-transaction join (gap F), surfacing somewhere
new.**

### 7. Which position has to be the owner's

**Read and ran.** With change 2 above, the capture check passes on the owner
claim at the link's target. That claim comes from `RepresentsCurrentUser` on the
list's type, minted when the owner's run first writes the list. It is not
stable: after Bob sat, the same position's label held a claim for Alice and one
for Bob (**ran, not kept**). **Inferred:** a setup made after a player sits
would be refused, since the check wants one owner. Declaring an `ownerPrincipal`
would make it stable and would refuse Bob's write, which is question 3 of our
comment on specs#59. The example orders its steps instead: the owner sets up
before seating opens.

**Class: specification question.** The ruling's "owner-bound to the actor" needs
to say which position, and whether a declared handler run by another principal
may write it.

### 8. A view with lists in it is released whole

**Ran.** Display test, "shows a hand's cards one at a time too", and every
`shown()` in it, which reads a whole view in one read. `SeatView` has a
`string[]` and a `number[]`. The rule's only integrity guard is the witnessed
`TransformedBy`, which is evidence bound to the value, so it runs at each
location a read consumed. This settles what the earlier findings left as "not
run" under gap C.

### 9. Nothing here shows a release on a served run

The display boundary's decision was tested on client runtimes only. With server
execution on, the pattern tests show that the served `move` and `seating` runs
commit, and so that capture passes there. They do not show which principal a
served `seating` run labels an entry for. **Read:**
`docs/features/current-principal.md` says the placeholder resolves to the acting
principal of the transaction's trust snapshot, which on a served run is the
event's sender.

## A design for per-recipient state, as far as this runtime goes

For an author with a sealed state and something to release to one recipient at a
time: a hand, a bidder's own bid, a voter's receipt.

1. **Seal the state under a policy-only clause, with one writer.** As in
   `sealed-state-machine.tsx`: `Confidential<T, [PolicyOf<typeof rules>]>`, one
   handler declared by `WriteAuthorizedBy`, the state one string (gap A).
2. **Give each recipient a key, written by that writer in the owner's setup.**
   The key is sealed, declares `ifc.members` for the recipient's list, and has
   no default. The setup has to read the state before it writes the key. The
   pattern has to be the entry module of its run.
3. **Project with a lift of the state and one key, and nothing else
   confidential.** The lift never reads a list.
4. **Keep each recipient's list in a cell of its own**, made in the pattern's
   body and returned in the result. Its items carry no label. Its one declared
   writer reads nothing sealed.
5. **Let recipients list themselves.** The writer makes each entry as a cell of
   its own, labeled for `CurrentPrincipal`, holding `currentPrincipal()`.
6. **Keep whatever the rules need about recipients public**, written by the
   list's writer in the same transaction, for the sealed state's writer to read.
7. **Write one rule:** under the lift's `TransformedBy` with the writer as its
   literal input witness, and a `Members` pattern on `THIS_POLICY.subject`, add
   that `Members` to the policy clause.

And the limit, which is the reason not to ship it yet: **this protects a
recipient from every principal except the subject's sole owner.** Where the
owner is entitled to the data, as in Find My, that is the right guarantee. Where
the owner is a custodian, it is not, until the ruling binds a declared writer to
its run.

## What the ruling would need to say, in the order it matters here

1. **Instance binding** (worry c). A declared writer and an input witness that
   name a handler as bound in the run that owns the document.
2. **Entries the policy's own writer wrote** (finding 1), or the gesture helper
   for an owner who seats a player (finding 3). Either lets `move` be the one
   writer again.
3. **Which position is owner-bound, and who may write it** (finding 7, and
   change 2 to the draft).
4. **A list named by the value, not by the schema** (finding 4).
5. **The run and the policy over the module graph** (worry b).
6. **Capture on a default** (finding 5).

## Draft comment for specs#59

Not posted.

> The card-table spike has run, on labs#8608 ported to current main plus
> labs#10111. Writeup:
> `patterns/examples/cfc-exchange-rules/SEAT-VIEWS-FINDINGS.md` on the spike
> branch.
>
> **What works.** A seat's view is released to that seat's occupant and to
> nobody else, the table's owner included, at the display boundary, with three
> principals in three runtimes. The label is
> `[Policy ∨ Members(L)] ∧ [User(host) ∨ Members(L)]` as predicted, and a view
> with lists in it is released whole.
>
> **Answers to my earlier questions.**
>
> - _The witness (my correction)._ Confirmed both ways. A seat key the move
>   handler wrote keeps the witness; the same key written by another handler
>   loses it.
> - _Question 2, a carried `Members` clause._ It satisfies the rule's
>   precondition. Capture runs once, in the owner's setup, and every later
>   recomputation, in whoever's run, inherits the clause from the key.
> - _Question 3, players seating themselves._ The draft admits it, and that is
>   the only seating it admits: an entry is labeled for the run that writes it,
>   so the owner cannot seat a player without the gesture helper.
>
> **What the hypothesis got wrong.** "The handler that writes the sealed state
> also writes each seat's list" does not work. Everything that handler writes
> carries the policy's clause, and resolution counts an entry only if every
> clause of its label names the principal. Seating had to move to a second
> handler that reads nothing sealed, with the roster public. Is an entry written
> under the releasing policy's own clause, for the same subject, meant to count?
>
> **The second run.** The attack as I described it is stopped today, but by
> accident: a run handed another run's state reaches it through a link slot the
> move handler did not write, so the witness is lost. That is the same behavior
> our earlier spike filed as a composition gap to be fixed. Fixing it without
> binding the witness to an instance opens the attack.
>
> A simpler one succeeds now. The list's declared writer is a handler, named by
> module and export. The owner runs another pattern that binds that same handler
> to the live table's seat list, sits, and is shown the other player's hand. A
> test pins it. Capture ran once at setup and is not consulted again; resolution
> checks that the position declares a writer and that the entry's label names
> its principal, not which run wrote the entry.
>
> So the answer to my question is yes, and more broadly than I asked: for a
> custodian owner, the witness, the list's writer and the key's writer all have
> to mean "this handler as bound in the run that owns this document".
>
> **Smaller points for the text.**
>
> - Capture as drafted is unreachable from a compiled pattern. The result holds
>   a link at the list position, and that slot has no owner claim. I judged the
>   position at the link's target to get further. Which position must be
>   owner-bound?
> - `ifc.members` is a pointer in the schema, so the number of lists is fixed in
>   the source. Per-recipient release wants the list named by the value.
> - The capture check also runs on the write that seeds a default, and refuses
>   it.
> - A one-line entry module that re-exports the pattern fails "a run of the
>   module the policy names". That is the imported-policy question with a
>   smaller case.
>
> Two labs bugs in the draft (a `$ref` not followed when reading a position's
> declared writers, and `cfcPattern.members()` missing from the compiler) are
> noted on the branch and need no ruling.

## What was not done

- No release shown on a served run, and no browser run (finding 9).
- No test of a memory server that enforces access lists. The emulated server and
  the pattern-test storage admit every write, so "a watcher at `READ` cannot
  sit" is not shown; the multi-user test's watcher holds `WRITE` and is refused
  by the rules alone.
- The second binding of `move` over a forged roster was reasoned and not run.
- The hypothesis shape (finding 1) and the three entry shapes (finding 3) were
  run and not kept as tests.
- No unseat, no second occupant of a seat, no removal: list resolution
  re-evaluating when a list changes is covered by labs#8608's own reconciler
  test and not by this example.
- The full runner suite and the browser lanes were not run on the port.
