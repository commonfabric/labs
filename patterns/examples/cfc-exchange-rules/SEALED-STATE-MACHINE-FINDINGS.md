# Sealed state machine: findings

What building `sealed-state-machine.tsx` (Memory, with a sealed state, one
writer and one released projection) showed about the runtime. The runtime is the
one at commit `7be4b18d9b`, 2026-11-21, on Deno 2.9.8, the version the
repository pins.

Each finding says how it is known:

- **Ran** means a test in the tree pins it, and the test is cited.
- **Ran, not kept** means a development run showed it and no committed test pins
  it.
- **Read** means it comes from reading the cited code or document, and nothing
  here ran it.
- **Inferred** means a conclusion drawn from the others.

The tests are `sealed-state-machine.test.tsx` and
`sealed-state-machine-multi-user.test.tsx` beside this file (pattern tests),
`runtime/runner/test/cfc-transformed-by-input-witness-state-machine.test.ts`
(the "state probe" below), and
`runtime/html/test/worker-display-fit-sealed-state-machine.test.ts` (the
"display test" below). The state probe and the display test each run one client
runtime over emulated storage. Nothing here ran in a browser or against a
toolshed.

## What ran, and on which Deno

Everything was first run on Deno 2.5.6 and then again on 2.9.8. On 2.9.8:

| Check                                                                           | Result                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------- |
| `cf test sealed-state-machine.test.tsx`                                         | 42 passed, with server execution off and on |
| `cf test sealed-state-machine-multi-user.test.tsx`                              | 81 passed, off and on                       |
| Display test                                                                    | 3 tests, 27 steps, passed                   |
| State probe                                                                     | 10 steps passed, 4 runs of 4                |
| `deno task cfcheck --only examples/cfc-exchange-rules/sealed-state-machine.tsx` | exit 0                                      |
| `deno fmt --check`, `deno lint`, `deno task check`, repository-wide             | each exit 0                                 |

What 2.5.6 got wrong, all of it the old Deno and none of it the tree:
`deno fmt --check` panicked, `deno lint` failed every file in its self-import
plugin, `deno check` reported nine errors in `base/`, and the runner's
compiled-pattern CFC tests failed on a leaked timer with every step passing.
None of that happens on 2.9.8.

What did not change: every behavior finding below reproduced on 2.9.8, finding 2
included.

## The findings that decide the design

### 1. The witnessed release fires on the first move, at the display boundary

**Ran.** After the table's first move, every field of the observer view fits the
ceiling a render gives a reader of the table's space (display test, "releases
the fields of the first move"), and again after the deal and after a later move.
A principal who reads no space, or another space, is refused. The sealed state
itself, and what `peek`, a function no rule names, computes from it, are refused
to a reader.

The inductor pool's snag 6 (`patterns/showcase/inductor/pool/README.md:329`,
top/3226) is that a witness naming a handler that read nothing confidential does
not match. It does not arise here, for a reason worth copying: the state has a
sealed default (`Default<StoredGame, "">`), and `move` reads the state before it
writes it, so its first run reads something labeled and is attributed
(`docs/specs/cfc-transformed-by-input-witnesses.md:330`, "An unattributed
input"). The state probe shows the same for a public release at a write gate
("releases a projection of a scalar the writer read and set, from its first
write", line 379). This does not say the pool's case is fixed: the pool's writer
pushes to a list, and this one sets a scalar.

### 2. A served handler's writes carry no `TransformedBy`, so no witnessed release fires with server execution on

This is a runtime bug. "Bug report: served handlers are attributed to nobody",
below, is written to stand alone. In short: with server execution on, the
first-party default, the serving loop writes the event's processed claim into
the handler's own transaction under no identity, the transaction then counts as
one of mixed authorship, and nothing the handler writes is stamped
`TransformedBy`. A rule whose input witness names a handler can never match. CI
runs the pattern tests with server execution off only, so nothing reported it. A
candidate fix and a test that fails without it are on this branch in a commit of
their own.

### 3. A mutable state must be one scalar, or the witness is lost

**Ran** (state probe). A handler that reads its state and then sets it keeps the
witness when the state is a scalar (line 379), and loses it when the state is a
record, whether the set changes one field (line 409) or every field (line 418).
A record the writer sets whole without reading it is witnessed, and stops being
witnessed at the first read-then-set (line 428).

So `StoredGame` is the state's JSON form in one string
(`sealed-state-machine.tsx:129`), parsed by a total parser (line 146). Gap A
below is the report.

**Ran** (state probe, line 443). The other shape that works keeps records: two
record stores and a scalar cursor, where each move reads the current record and
sets the other one whole.

### 4. Under the table's rule, only scalar fields of the projection are released, each read on its own

**Ran** (display test, "has one read of the whole view refused"). One read of
the whole view record is refused, while each of its eight scalar fields is
released.

**Ran, not kept.** An earlier view had `players: string[]`, `scores: number[]`
and `slots: ObserverSlot[]`. A read of a non-empty list was refused, and so was
a read of one slot object; a scalar reached through them was released.

So `ObserverView` is flat, and lists are strings
(`sealed-state-machine.tsx:328`). Gap C below is the report, and it has a
resolution that needs no runtime change: a rule in two steps releases the whole
view in one read (display test, "under a two-step rule").

### 5. A projection run before the first move leaves the fields that do not change sealed

**Ran** (display test, "projecting before its first move"). With `observe`
returning a view of the default state, the first move's view has `phase`,
`board`, `owners`, `turn` and `faceUpCount` refused, the deal's has
`faceUpCount` refused, and only the reveal after it releases every field.

So `observe` returns `undefined` until the state is non-empty
(`sealed-state-machine.tsx:401`). Gap B below is the report.

### 6. Lending the table its state from another pattern strips the witness

**Ran** (display test, "refuses every field of a table lent its state"). A table
given its `state` by the pattern around it plays normally, and every field of
its view is refused. Gap D below is the report.

A consequence for tests: a test can reach the sealed state only by lending it,
which is how `sealed-state-machine.test.tsx` probes the raw state (line 236) and
a forged write (line 241), and a lent table is not a released one.

## Bug report: served handlers are attributed to nobody

**Summary.** On a serving runtime, no write an event handler makes is stamped
`TransformedBy`. Every exchange rule whose `inputWitness` names a handler is
therefore unsatisfiable with server execution on. Lifts are unaffected, so a
rule naming only a lift keeps working, which is why this has gone unnoticed.

**Expected.** `docs/specs/cfc-transformed-by-input-witnesses.md:40`: "When the
flow stage attributes a transaction to an identity, it mints
`TransformedBy{identity}`", and line 330: `TransformedBy` "is minted only when
every write in the transaction came from one identity and the transaction's join
is nonempty". A handler transaction whose pattern-visible writes all come from
the handler meets that on a client, and nothing in the specification or in
`docs/specs/server-side-execution/` says a served run is attributed differently.
`patterns/examples/cfc-exchange-rules/README.md` documents `witnessed-chain.tsx`
as releasing the honest chain, with no posture caveat.

**Actual.**
`deno task cf test patterns/examples/cfc-exchange-rules/witnessed-chain.test.tsx`,
unmodified, at `7be4b18d9b`:

| `EXPERIMENTAL_SERVER_EXECUTION`                                            | Runs | Result                       |
| -------------------------------------------------------------------------- | ---- | ---------------------------- |
| `false`                                                                    | 3    | 8 passed, 0 failed, each run |
| unset (resolves to on, `runtime/memory/v2/server-execution-default.ts:46`) | 3    | 7 passed, 1 failed, each run |

The failing assertion is the honest chain's publish: "CFC enforcement rejected
commit: ... maxConfidentiality failed at /roomTally", from the serving loop.
`blessed-computation.test.tsx`, whose rule names a lift and no witness, passes 4
of 4 both ways. The same split held on Deno 2.5.6.

**Why CI is green.** `tasks/integration.ts:71` puts `pattern-tests` in
`PACKAGES_WITHOUT_SERVER`, and line 798 runs those with
`EXPERIMENTAL_SERVER_EXECUTION: "false"`. No lane runs a `cf test` pattern test
with server execution on.

**Minimal repro.** `runtime/runner/test/executor-trust-attribution.test.ts`,
"names the handler on what a served run writes after reading something labeled"
(line 641). A probe handler on a live serving loop sets a verified
implementation identity, reads a labeled document and sets it, twice, and the
test reads the stored record's label map. Without the fix it holds no
`TransformedBy` atom; with it, one naming the handler.

**Code path** (line numbers at `7be4b18d9b`).

1. `runtime/runner/src/executor/space-server.ts:3272`. Before the handler runs,
   the serving loop calls `writeProcessedClaim()` on the handler's own
   transaction. Its comment says "Written BEFORE the handler runs".
2. `runtime/runner/src/executor/processed-claim.ts:60`. The claim is an ordinary
   `Cell.set` at `entries/<n>/consequenced` of the stream's entries document,
   made while the transaction has no implementation identity.
3. `runtime/runner/src/storage/extended-storage-transaction.ts:1959`,
   `#noteWriteIdentity()`. That write is the transaction's first, so the
   write-identity summary records `identity: undefined` (line 1987). The
   handler's first write then arrives under the handler's identity, the two
   differ, and the summary becomes `multiple` (line 1990).
4. `runtime/runner/src/cfc/prepare.ts:5336`. The flow join takes
   `identity = writeIdentity.multiple ? undefined : ...`, so the mint at line
   6100 is skipped. `writersRecordedRoots()` (line 4319) requires
   `!writeIdentity.multiple` too, so the whole-value stamps a witness needs are
   dropped as well.

The prepare gate already knows the claim is not the handler's: it leaves the
claim's path out of the join's stamp and out of the store measurement
(`isProcessedClaimPath()`, `prepare.ts:1569` and `:13409`). The write-identity
summary is the one place that was not told.

**How it was found.** Temporary logging in `deriveFlowJoinImpl()` and
`#noteWriteIdentity()`, run under `witnessed-chain.test.tsx` with server
execution on. Every handler join attributed to an identity came from a client's
speculative run, whose labels go to the overlay and are never committed. All 24
served handler transactions logged `multiple: true`, and each flip was logged
with its first write at `of:stream-events:.../entries/<n>/consequenced` under no
identity and its second under the handler's. The stored label map of the
argument document then held only `declared` and `structure` entries where the
same run with server execution off held `derived` value stamps naming `submit`
and `commit`.

**Cause, and confidence.** The processed claim is counted as an authored write.
Confidence is high: the logging shows the flip at that write on every served
handler run, and leaving the claim out of the summary makes
`witnessed-chain.test.tsx` pass 8 of 8 with server execution on, three runs of
three, and still 8 of 8 with it off.

**Candidate fix.** On this branch, in a commit of its own:
`#noteWriteIdentity()` skips a path that a marker the runtime authorized named a
processed claim on the same transaction (`#isProcessedClaimWrite()`), which is
the test the prepare gate applies. With it, the 137 runner test files that
mention a served run, a processed claim, the write identity or `TransformedBy`
pass, as do every example under `patterns/examples/cfc-exchange-rules/` with
server execution on and off, and four served multi-runtime integration tests
under `patterns/integration/` (`owner-private-inbox`, `cfc-group-chat-demo`,
`fabrichat-labeled-inbox`, `drafted-chat-chained-event-gate`). The runner's
whole suite, about an hour here, was not run to the end, and no browser lane was
run. It is small, but it changes who a served transaction is attributed to, so
it wants a review by whoever owns the CFC specification correspondence
(`docs/development/cfc-spec-correspondence.md`). I classed it a conforming
implementation, on the sentence in `processed-claim.ts` that §6.2.2 claims the
processed cell apart from the handler. A stricter alternative is to key the skip
on the value written as well, as `isProcessedClaimPath()` does.

**Not shown.** That a release at the display boundary fires on a served run. The
display test runs a client runtime. With the fix the write-gate release of
`witnessed-chain.tsx` fires on served runs, which is the same evidence at a
different gate.

## Runtime gaps, as bug reports

The example's four contortions (state as one JSON string, a view of flat
scalars, 24 fixed buttons, `observe` returning nothing before the first move)
each answer one of these. They are ranked by how much each distorts a mutable
state machine with projections, most first. The served-attribution bug above
ranks ahead of all of them, since with it nothing is released at all on the
default posture.

### A. A handler that reads a record and then sets it loses its input witness

**Distortion.** The largest. The state cannot be a record with fields, a list of
cards, or a history list. It has to be one scalar, so the example stores JSON in
a string, and every reader parses it.

**Repro.** State probe, "refuses a projection of a record the writer read and
set in part" (line 409) and "... with every field changed" (line 418). The
control beside them is the scalar (line 379).

**What the documents say.** This is the rule as written.
`docs/specs/cfc-transformed-by-input-witnesses.md:165` to 197: a `Cell.set`
destination is stamped as written only when "the transaction created the
destination, or read no content at or beneath it", because "a writer that read
its destination can carry a value it found there into what it sets, and the diff
leaves that value in place". A container a `Default` put in place "keeps no
writer at all" (line 169), and a write beneath a stamped destination withdraws
the overlapping stamp (line 175).

**Bug, missing feature, or intended.** Intended, and fail-closed for a good
reason, but a missing feature for this shape. The reason does not apply when
everything the writer found at the destination was itself written by that
writer: carrying its own earlier output forward launders nothing. A state
machine is exactly that case, and the example declares it:
`WriteAuthorizedBy<..., typeof move>` already confines every write of the store
to `move`. Two ways the rule could admit it: stamp the destination whole when
every location beneath it carried the same writer's stamp before the write, or
when the store's declared `writeAuthorizedBy` names only the writing identity.
Either is a change to what the witness claims, so it goes through the
specification.

### B. An output that does not change keeps the stamp of the run that last changed it

**Distortion.** Large, and it is a correctness trap, not only an inconvenience.
A projector that runs before the state has a witnessed writer leaves every field
whose value the first move does not change sealed, with nothing to tell the
author why. The example dodges it by returning `undefined` until the first move,
which makes "no table yet" a different type from "an empty table".

**Repro.** Display test, "display fit of the sealed state machine projecting
before its first move": the expected refused fields are
`phase, board, owners, turn, faceUpCount` after the first move and `faceUpCount`
after the deal.

**What the documents say.**
`docs/specs/cfc-transformed-by-input-witnesses.md:417`, "An output that does not
change", lists this under what the witness does not cover: "A stamp is replaced
when its value is written." It is described there as letting an earlier release
stand. This is the same mechanism failing in the other direction: an earlier
refusal stands.

**Bug, missing feature, or intended.** A known limitation that behaves as a bug
here. The stamp on a field describes the inputs of a run that is no longer the
run that produced the current view. Re-stamping a location when a run writes an
equal value would fix both directions; the transaction layer already treats an
unchanged write as an attempted write (the comment in `writeValuesOrThrow()` of
`runtime/runner/src/storage/extended-storage-transaction.ts` cites §8.10.1 for
that).

### C. A rule that mixes a `TransformedBy` guard with `HasRole` does not release a read that covers a record

**Distortion.** Large as first met, small once understood. Under the rule the
example ships, the view has to be flat scalars, each read on its own.

**Repro.** Display test, "has one read of the whole view refused", against
"display fit of the sealed state machine under a two-step rule", where the same
read is released.

**What the documents say.**
`docs/specs/cfc-transformed-by-input-witnesses.md:389`, "Composition at the
release gate": "A gate runs a value-intrinsic rule at each location an access
consumed, on that location's own evidence." A rule is value-intrinsic only when
every guard is evidence bound to the value; `HasRole` is evidence of the access
(`runtime/runner/src/cfc/exchange-eval.ts:223` to 243). So the example's rule
runs once over the join of a read's locations
(`runtime/runner/src/cfc/prepare.ts:11980`), and a record read spans several.
Which location of the record lacks the atom was not identified.

**Bug, missing feature, or intended.** Probably intended, and the example's rule
is the unidiomatic thing. The two-step form is: the module's rule is guarded by
the witnessed `TransformedBy` alone and adds `Space(THIS_POLICY.subject)` to the
clause, and the display boundary's standard rule
(`STANDARD_RENDER_EXCHANGE_RULES`,
`runtime/runner/src/cfc/render-ceiling.ts:73`) admits a reader of that space.
Run that way the whole view is released in one read, and a stranger, a reader of
another space, the sealed state, `peek` and a lent table are all still refused.
Two things are missing all the same. `cfcPattern` has no `space()` constructor,
so the alternative is written as a raw atom. And nothing says that mixing the
two guards in one rule quietly changes where the rule is evaluated; the compiler
could say so.

One difference to weigh before adopting it: `Space(table)` is a wider release
than `User(reader)` at a display. A value so labeled also fits any store whose
ceiling admits the table's space.

**Not run.** Whether a list or a list of records in the view is released under
the two-step rule. The view under test has only scalars.

### D. A projection of a state reached through a link carries no witness

**Distortion.** Medium. The table cannot be composed: a lobby cannot create a
state and hand it to a table, and a test cannot hand a table a state it also
holds. The state has to be the table's own default.

**Repro.** Display test, "refuses every field of a table lent its state".

**What the documents say.**
`docs/specs/cfc-transformed-by-input-witnesses.md:337`: "A reference stored any
way other than by anchoring an object the writer put in an array ... earns its
slot no value stamp". The link from the table's argument to the outer cell is
such a reference.

**Bug, missing feature, or intended.** Intended: which document a reader reads
is an input, and the caller chose it. A missing feature for composition. The
runtime's own argument wiring could be evidence, as the custody seal's link is
(`CfcAssertedValueRoot.reference`, same document, line 150).

### E. A public store that holds one release refuses the next

**Distortion.** Medium, and larger than it looks, because a stored release is
the idiomatic way out of gap C's other half: anything derived from the view by
code the rule does not name is sealed again, so a UI cannot `.map()` the view or
compute from it. Copying each release into a store whose ceiling is the
release's audience would give the UI plain data. That copy works once.

**Repro.** State probe, "refuses a second release into a store that holds the
first, a known gap" (line 394). The same release lands in a store that has taken
none (line 379).

**What the documents say.** Nothing found that allows it. The pool reports
neighbors of it: a public array of objects refused beside a labeled sibling
(top/3205) and its "Workaround: the release is not stored"
(`patterns/showcase/inductor/pool/README.md:217`).

**Bug, missing feature, or intended.** A bug, cause not found. A hypothesis, low
confidence: the publishing transaction's diff reads the destination's current
value, whose stored label still carries the policy's clause with the publisher's
own `TransformedBy` as evidence, and the join then holds a clause no rule
releases.

### F. The one writer can write nothing public

**Distortion.** Small. `move` cannot publish "that move was illegal", a turn
counter, or a clock; a refused move is visible only as `version` not advancing.
The idiom is clean, though: everything public about the table is a field of the
released projection.

**Repro.** State probe, "refuses a move that also writes a public store"
(line 455) and "refuses the writer's public write in a run whose handler reads
nothing sealed" (line 467).

**What the documents say.** The comment above the flow-label stage in
`runtime/runner/src/cfc/prepare.ts` ("S16 flow labels"): "one conservative
confidentiality join per transaction — everything the transaction observed
taints everything it wrote (§8.9.2/§8.9.3 collapsed to tx granularity)".

**Bug, missing feature, or intended.** Intended as a staged approximation. The
second case is the surprising one: the handler's body reads nothing sealed, and
the write is refused because its binding names the sealed stores. A join per
write, or a join over what the body read, would admit it.

### G. A label on a value sent in an event payload is not tracked

**Distortion.** None; this one is a hole, not a contortion. A handler that read
a value labeled by another policy can send it to `move` in a payload, and on a
client runtime the state takes it and the projection is released.

**Repro.** State probe, "releases a projection of a scalar the writer set from a
payload that carried a value another policy labels, a known gap" (line 487). Its
control is the bound input, which is refused (line 477).

**What the documents say.** The pool README records it as top/3175
(`patterns/showcase/inductor/pool/README.md:30`): "with server execution off a
receiver can publish the payload directly".

**Bug, missing feature, or intended.** A known bug. Not run with server
execution on.

### H. A value labeled for one player cannot enter the sealed state

**Distortion.** None for Memory, and large for the next game. A handler bound to
a value another clause labels is refused every write of the sealed store,
"writer-fit confidentiality misfit ... (canWrite, §8.12.4)", whether or not the
handler uses the value. A game with hands needs a player's private choice to
reach the state.

**Repro.** State probe, "refuses every write of a writer bound to a value
another policy labels" (line 477).

**What the documents say.** `docs/features/current-principal.md`, "A reader
named `CurrentPrincipal`": moving data labeled for another reader into a store
"still needs a declassification".

**Bug, missing feature, or intended.** Intended. The missing piece is the idiom:
a rule by which a player's clause is released into the table's policy when
`move` is the writer.

## The questions the brief asked

### Does the witnessed release fire on the first deal?

Yes at the display boundary on a client runtime (finding 1). With server
execution on, not until the served-attribution bug is fixed.

### How does "one flow label per transaction" constrain the handler? Can it write anything public?

No (gap F).

### Does an input labeled to one user contaminate projections?

A bound input cannot reach the state at all (gap H). A payload can, untracked,
on a client runtime (gap G).

### What does the projector do when it is re-run?

Gaps B and E.

### What does a handler run do on a client and on the server?

**Read.** With server execution off, the client runs the handler and commits its
writes. With it on, the client commits only the event; it also runs the handler
as speculation whose writes go to a memory-only overlay, and the server's run is
the authoritative one (`docs/specs/server-side-execution/README.md:208` and 320
to 331). A speculative run "may diverge from the authoritative one (clock,
randomness)" (line 328), and `docs/common/concepts/handler.md:109` says the same
of `Math.random()`.

**Ran, not kept.** The logging used for the bug report above showed both runs:
each handler joined once on the client and once on the serving loop.

**Inferred** for this pattern. `move` draws randomness only for `setup`
(`sealed-state-machine.tsx:313`), so the dealing client's echo holds a different
layout from the server's until the server's arrives. The view of a fresh deal is
all `?` under either layout, so the divergence is not visible, and no other move
draws randomness. `eventKey()` is not needed: the handler creates no record
named by the event.

**Inferred**, and the largest caveat on "no person can read it". With server
execution off, each player's runtime runs `move` over its own replica of the
sealed state, so every player's machine holds the whole layout. The seal is
enforced by each client's runtime at its display boundary and write gates, not
by the server withholding the bytes. The pool README says the same of its secret
(`patterns/showcase/inductor/pool/README.md:261`). Whether a client receives the
sealed document with server execution on was not looked at.

### Is the proposer a handler sees stamped by the memory server, or can a client set it?

**Read.** It depends on where the handler runs.

- `currentPrincipal()` is a frame check in front of
  `Runtime.actingPrincipalFor()` (`runtime/runner/src/runtime.ts:5032`). On a
  client it returns the runtime's own identity (line 5033). On a serving runtime
  it returns the actor of the run's wave context (line 5034, `waveRunActorOf()`
  at `runtime/runner/src/executor/wave.ts:386`).
- The serving loop takes that actor from the event's `firedAt.user`
  (`runtime/runner/src/scheduler/events.ts:2635`).
- The memory server writes `firedAt` when it admits the event append. For an
  ordinary client append it is `{ user: principal, session: sessionId }`, where
  `principal` is the session's authenticated principal
  (`runtime/memory/v2/engine.ts:4088`), an append with no authenticated
  principal is refused (line 4082), and a client-supplied `firedAt` that
  disagrees is rejected, not corrected (lines 4096 to 4104). The session's
  principal comes from the signed `session.open` the server verified
  (`runtime/memory/v2/server.ts:7175`). `clientSeq` is the only part of
  `firedAt` a client mints (`docs/specs/server-side-execution/events.md:48` to
  63).
- No field of the payload is consulted (`docs/features/current-principal.md`,
  "Where it does not come from").

So with server execution on, the proposer is the server's stamp from the
authenticated session and a client cannot set it. With it off, the handler runs
on the proposer's own client and the value is that client's word; a modified
client could return anything, though it could as easily write the state directly
(`docs/features/current-principal.md:74`). A table that has to hold against a
modified client has to run served.

**Ran.** A reveal whose payload names the player whose turn it is, as `proposer`
and as `acting`, sent by the other player, is refused
(`sealed-state-machine-multi-user.test.tsx:210` and 239), with server execution
on and off. A deal by a player who does not own the table is refused (line 226),
and so is every move by a principal with no seat (line 264).

## Against the inductor pool's snags

| Pool snag (`pool/README.md:284`)                                                | Here                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Public array of objects beside a labeled sibling (top/3205)                  | Not reached: the table has no public store. Gap E may be related.                                                                                                                                                                                         |
| 2. Confidential default beside a public field fails the start commit (top/3102) | Not reached: the table's only input is the sealed state, and a sealed default with no public sibling starts cleanly.                                                                                                                                      |
| 3. `principalOf` after an in-place set                                          | Not used: the state holds players' DIDs as `move` read them from `currentPrincipal()`.                                                                                                                                                                    |
| 4. A ceiling naming a `PolicyOf` atom refuses every write (top/3207)            | Not used. A `Confidential` store already refuses a foreign clause (gap H).                                                                                                                                                                                |
| 5. A ceiling binds only a writer that repeats it (top/3219)                     | Not re-tested. Every probe here types its destination with the ceiling.                                                                                                                                                                                   |
| 6. The witnessed release is refused (top/3226)                                  | Avoided here by the sealed default the writer reads (finding 1). The pool's refusal is not the served-attribution bug: with that fix applied, `inductor-pool-multi-user.test.tsx` still asserts the refusal and passes, with server execution on and off. |

## Smaller snags

- **A labeled scalar is not a `string` to the type checker.** `state.get()` on
  `Writable<StoredGame>` is `Readonly<StoredGame>`, which a `string` parameter
  refuses, so `move` wraps it in `String()` (`sealed-state-machine.tsx:309`).
  **Ran** (the compiler's error).
- **`cf test` has no display boundary.** `HasRole` is minted only in
  `runtime/runner/src/cfc/render-ceiling.ts:268` and 314; the write gate
  (`runtime/runner/src/cfc/prepare.ts:11898`) passes none. So a rule that
  releases to readers cannot be shown firing in a pattern test, and a pattern
  test can show only that a public store refuses the view
  (`sealed-state-machine.test.tsx:226`). **Ran and read.**
- **The policy's identity covers the view.** The rule names
  `THIS_POLICY.moduleIdentity`, and the pattern and its JSX are in the policy's
  module, because the brief asked for one file. An edit to the UI changes the
  identity, and a table dealt before the edit is not released after it. The pool
  keeps its policy in a module of its own for this reason
  (`patterns/showcase/inductor/pool/pool-policy.tsx:14`). **Read.**
- **A watcher can try to sit.** Carol, at `READ`, is refused only because the
  deal has happened (`sealed-state-machine-multi-user.test.tsx:264`). Before the
  deal anyone who can send an event can take a seat. The pattern test's access
  list is not enforced by its storage
  (`docs/common/workflows/pattern-testing.md:141`), so nothing here shows what a
  server in `enforce` mode would refuse. **Read.**
- **The first seat is not the owner's by rule.** The owner deals; anyone seated
  plays. The tests seat the owner first by ordering their steps.

## What was not done

- No run shows a display-boundary release on a served run.
- No browser run, so nothing shows the UI rendering the released fields, or a
  button click reaching `move` as a trusted gesture.
- No test of a concurrent move by two players.
- The multi-user test's two players and watcher assert the same view at the
  markers they share; nothing compares two principals' display decisions,
  because the display test has one runtime.
- No test that a forged state (written by other code into a table that holds its
  own state) is refused release: the only way a test reaches the state is to
  lend it, and a lent table is already not released (gap D). The forged write
  itself is refused by `WriteAuthorizedBy`
  (`sealed-state-machine.test.tsx:241`).
- The example was not rewritten into the idiomatic shape. Doing that means a
  record state (gap A), a view with lists that is released whole (gap C, by the
  two-step rule), a projection of the empty table (gap B), and a UI that maps
  the view (gap E, or a rule naming the UI's own derivations).
