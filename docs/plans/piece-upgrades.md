# Piece upgrades from first principles

A design for changing a piece's source and data shape without breaking the
piece, its consumers, or its producers. It starts from the problem rather than
from the mechanisms the repository has accumulated, and only then asks what can
be kept. It is written to be confirmed. Each decision is a numbered proposal
for the person whose region it changes, assigned by `git blame` over that
region rather than by who touched the file last: the transaction layers on
both sides and the compatibility checker's policy are Bernhard's; the
retained-link proof that calls the checker over a piece's own list entries is
Robin's; the setup validation and the Topics state version are Gideon's;
anything landing in `packages/memory/v2` also routes through danfuzz, who
gates that package; and the pacing and the design calls are Mike's. Nothing
here is implemented; the retrofit section says what would change and in what
order.

The design covers the state half of the problem: what a piece stores and how it
gets there. The interface half — verbs, demands, versioned interfaces, and how a
deliberate break is made visible — is designed in
[Designing verbs so they can change](verb-evolution.md), and this document takes
its rules as given where the two meet.

## Why now

The 2026-09-15 Topics rollout on Estuary updated the board and all 301 existing
Topics, and every one of the 302 source updates needed
`--dangerously-allow-incompatible-schema`. Two of the four refusal kinds were
predicted in writing and were a one-time cost of a reviewed change. The other
two — `comments[].editedAt` on 256 Topics and `links[].removedAt` on two — were
not predicted, come from one mechanism, and will recur for any optional field
added to the element type of a stored list. An earlier candidate had already
been refused the same way on `authorName?: string`, and the 2026-09-14 naming
experiment met the same refusal on `shortName`. Three fields refused by one
rule is a mechanism, not a run of bad luck.

Each mechanism involved was added for a reason. A structural check of the
pattern's declared contracts, a check of every link the piece retains, a
validation of the stored argument at setup, a global override, two CI gates,
a ledger of accepted breaks, and a hand-rolled state version inside one
pattern. Together they produce a system where the common case — adding a field
— forces the operator to turn every protection off on every piece, and where
the check that fires in production is the one no gate runs before merge.

## The problem

A piece is a running copy of a pattern over stored state, linked to other
pieces in both directions. Changing its code can break three parties:

1. **The piece itself.** Its new code reads state its old code wrote.
2. **Its consumers.** Other pieces read its output under the contract it
   published, and some hold writable handles into it.
3. **Its producers.** It reads other pieces' output under the demands it
   declared.

A fourth party, verbs and their callers, is the subject of
[verb-evolution.md](verb-evolution.md). A fifth complicates all of them: during
a rollout, old and new code write the same state at once. One measured board
update left the two writing to the same space at 96% of commits.

The three parties are different problems. The piece's own state is written by
code that reads the piece's own schema: its own pattern, and a consumer holding
a writable handle into it, which the write-back proof holds to that schema. Two
writers escape that: a raw cell write (`cf cell set`, `setRawUntyped`), which
reads no schema, and a client still running an older version of the pattern,
which reads an older one. So the state is knowable up to those two, and the
design has to say what it does about each (D2, and proposal T3). A consumer's
contract is a promise the piece made to code it cannot see. A producer's
contract is a promise made to the piece by code it does not control. One
instrument, schema comparison, is used for all three today, and that is the
root of the trouble.

## What the design rests on

These are measured, not assumed. Each names where it was measured.

1. **A schema proof and the real question have different quantifiers.** The
   checker proves "the new schema accepts every value the old schema admits."
   The question is "does the new code work over the values that exist and the
   values that will be written." An open object admits any value at an
   undeclared field, so a demand for `number` there is a narrowing, and the
   proof refuses it, whether or not anything ever wrote a non-number. Every
   refusal in the Topics rollout other than `asCell changed` was of this kind.
2. **Undeclared fields reach storage.** A probe on current main wrote `{ a,
   b }` where the type declared `{ a }` through all three paths a pattern
   writes: the result body, a handler `push` into a `Writable` list, and a
   handler `set` on a `Writable` object. All three stored `b`. A typed read
   strips it; the raw document keeps it. So "an undeclared field is never
   written" is not a property the runtime provides, and a proof that assumes
   it is unsound. TypeScript's excess-property check covers object literals
   only; a value passed through a variable, a spread, or a cast carries
   whatever it carries. Two things bound what such a value can do, both
   measured by a second probe that stored `shortName: 42` under a pattern
   later declaring `shortName?: string`. At upgrade time, setup validation
   refuses a readable wrong-typed value ("value does not match type string"),
   and the global flag does not waive it. After the upgrade, a wrong-typed
   value at an optional declared path reads as absent: a lift over the rows
   and a typed read of the result both returned the row without `shortName`.
   So an optional typed demand over an undeclared field is safe in effect,
   which is the position the retained-link proof's author takes: the field's
   present wrong-typed value is left off the read, and the result is what it
   would be had the field not been there.
3. **Every entry of a stored list is its own document, with no schema of its
   own.** The same probe showed this for `push` and for `set([...])` alike.
   The retained-link check therefore sees a piece's own list entries as
   foreign linked documents. For a document with no schema metadata it uses
   the previous pattern's schema at that path as the source contract
   (`resolveDurableSource`, `packages/piece/src/ops/piece-controller.ts`) and
   proves subset with `allowEvolutionPolicy: false`. The pattern-level check
   proves the same change with the policy on. One change, two verdicts: the
   pattern check accepts `editedAt?: number`; the link check refuses it the
   moment the list has one entry.
4. **The `asCell` marker is not a runtime gate.** The record in
   [topics-mentionable-readonly-break.md](../history/topics-mentionable-readonly-break.md)
   measured a `Writable` and a `ReadonlyCell` declaration over the same list
   and found the two indistinguishable at write time. The checker compares the
   marker for exact equality, so a consumer giving up write access is refused
   as a break.
5. **Setup validates the stored value against the new schema**, inside the
   setup transaction, and refuses a readable wrong-typed value
   (`packages/runner/src/stored-argument-validation.ts`; the test "refuses a
   readable wrong-typed value inside a linked row" in
   `packages/piece/test/ops/piece-source-input-validation.test.ts`). Two cases
   defer: a link that cannot be dereferenced in that transaction, and a root
   with no setup-completion marker. This check reaches linked list entries.
6. **Neither CI gate runs the check that fires in production.**
   `deno task pattern-compat` runs the pattern-level check against recorded
   baselines. `deno task pattern-vintage` replays captured stores through
   `runtime.runSynced` (`materializeOnCell`,
   `packages/piece/test/state-continuity-harness.ts`), which never runs the
   retained-link check. Only `setsrc` against a populated piece runs it.
7. **The override is global.** `dangerouslyAllowIncompatibleSchema` turns off
   both checks for the whole update. Accepting one reviewed break on one path
   silences every other finding on that piece, and `--check` can no longer
   tell a safe update from an unsafe one for any piece updated that way. The
   Topics operator built a driver that runs the unwaived checks, accepts only
   reviewed reasons, and stops on an unrecognized one. That driver is the
   missing feature.
8. **A pattern-owned state version works, up to a boundary the pattern cannot
   cross.** Topics stamps `topicStateVersion`, runs ordered upgrade steps from
   a lift and from every durable handler, and refuses durable mutations at a
   future version
   ([state-upgrades.md](../../packages/patterns/topics/state-upgrades.md)).
   Its own design notes the limit: it "cannot constrain code that predates
   the guard, already-running legacy clients, or writes made directly to
   stored cells." Those are the runtime's to constrain.

## Principles

- **P1. Own state is migrated, never proved.** The piece's old code was the
   only writer, and after the update its new code is the only writer. The
   right operation is code that converts version N to N+1. Compatibility is the
   trivial migration, not a property to prove. No schema-subset proof runs over
   a piece's own state. What replaces the proof is not trust in a single
   writer but two checks that look at values rather than schemas: setup
   validates what is stored (fact 5), and the writer-version guard (D2) keeps
   an older writer from adding to it afterward.
- **P2. Contracts between pieces are checked three times, at different
   strengths.** A demand is proved against the producer's declared contract, a
   universal claim over what the producer promises; the values currently
   linked are validated, a claim about now; and a typed read checks what
   arrives, a claim about each value as it is used. Fact 2 is why the first
   cannot stand alone.
- **P3. Capabilities are not shapes.** Readable versus writable is a
   capability. A consumer giving one up is always safe. Taking one requires
   the producer's proof.
- **P4. A break is acknowledged by name and recorded where it happened.**
   There is no global off switch on a piece whose pattern loads. An
   acknowledgment names a path, carries a reason, and rides the piece's
   revision record so that a later reader can find it.
- **P5. The version is a declared integer, separate from the pattern
   identity.** The identity changes on every edit; the version changes when
   the stored shape changes. Absent means zero.
- **P6. Common needs are automatic; rare needs are declared; the rarest are
   coordinated.** An author adding an optional field writes nothing. An author
   changing a shape writes a step. An operator moving two pieces whose
   contracts change together runs a named operation. Every case in the use
   case table below has a path; the cost rises with rarity.

## The design

### D1. A runtime-owned state version and upgrade steps

A pattern declares its state version and an ordered list of upgrade steps,
one per version increment. The runtime stores the version as metadata on the
piece's root document beside `patternSetupIdentity`; a document with no stamp
is at version 0. At setup — the same transaction that re-points the stored
argument at the new schema — the runtime reads the stored version, runs each
step from there to the declared version in order, stamps the result, and then
validates the stored argument against the new schema (fact 5, unchanged). A
step that cannot complete fails the transaction, and a failed setup transaction
costs the piece nothing (the lifecycle spec's
[compatibility policy](../specs/piece-source-lifecycle.md#compatibility-policy)
already guarantees that).

A step is pattern code with the contract Topics already uses: deterministic,
no clock, idempotent over an already-upgraded target, reads everything it
needs before its first write, reaches list entries through their links, and
keeps legacy storage keys permanent. What changes is who calls it. The runtime
calls it once, at setup; handlers no longer carry an upgrade binding, because
no handler of the new version runs before setup has committed.

The unit is one piece and one transaction, in which code and data move
together. That unit holds at any pace. What "eager" or "lazy" decides is only
what fires it, and the two are separable: a migration that runs whole in its
transaction can be fired now, on demand, or in the background.

#### What fires a migration

Three triggers, in the order they take a piece:

1. **Explicit.** `setsrc`, or a D7 manifest. The operator sets the pace, as the
   Topics rollout did, serially.
2. **On touch.** When a piece starts. A piece following an origin already
   adopts the candidate at load
   ([Reconciliation when a piece loads](../specs/piece-source-lifecycle.md#reconciliation-when-a-piece-loads)),
   so the pieces someone is using move first, which is the order that matters.
3. **Background sweep.** The serving runtime walks the pieces behind their
   pattern's declared version at a budgeted rate — so many per interval, or
   only while load is under a threshold — and fires each one's setup. The
   sweep is what makes the steady state "everything is current" rather than
   "everything touched is current". The serving loop can carry it; the
   cadence declaration in
   [Scheduled Work in the Server](scheduled-work-in-the-server.md) is the
   natural home once that exists.

Until one of these fires, the piece runs its **old code**. Pieces already work
this way: each pins its pattern identity, and every version is
content-addressed and loadable beside every other. So no version of the code
has to read two shapes, which is the cost the Topics design pays with an
upgrade binding in every durable handler.

The price is a longer mixed population. A serial rollout has one anyway (301
Topics took hours); the sweep lengthens the window, so the contracts between a
collection and its members are stated for the mix, which is the D7 ordering
rule held for longer. The population is observable: the cohort survey bulk
operations already compute, per pattern identity and now per version, is the
progress meter, and it is what says when the sweep has drained.

A piece's state is bounded by its own document and the entries it links, so
one migration is bounded work, paid once. The Topics rollout measured 6.4
seconds of `setsrc` per Topic, a rollout cost, not a runtime cost. Three
situations do not fit that bound, and each has a form:

- **A collection whose demand tolerates unmigrated members.** The board over
  old Topics: `shortName?` is optional, so the index is correct for migrated
  members and reads the rest as absent. Automatic, and the common case.
- **A collection that needs every member migrated first.** The manifest
  states a **precondition**: the collection's own migration fires only once
  every member is at or above the version it needs, and the sweep takes those
  members first. The collection runs its old code until then, which is
  coherent rather than partial. This is the ordering rule with the wait made
  explicit.
- **A migration that belongs to the collection and reaches every member.**
  `backfillNames` in the naming arc was one. Over a large collection such a
  step is **resumable**: it returns "more" with a cursor, the transaction
  commits the slice, and the sweep fires it again. This is the one place the
  unit above is not one transaction, and it needs its own rules, which are
  these. The first slice's transaction writes an in-progress marker beside the
  version, holding the step's identifier and the cursor; the last slice's
  transaction clears it, stamps the new version, and switches the code. While
  the marker is set the document is at the old version, and the writer guard
  (D2) refuses writes from every version, old and new alike, so no writer of
  either shape lands on a half-migrated document. The piece is unavailable for
  writes for the span of its slices, which is the cost of not fitting one
  transaction, and the marker is what makes the span visible and resumable
  after a crash. Rare, and the one place the step contract grows.

**Proposal for Mike (M1).** The three triggers, with the sweep's budget an
operator setting. The alternative at either end — every piece at deploy, or
only on touch — is a special case of this with one trigger removed.

### D2. A writer whose version is older than the document's is refused

A write carries the state version its writer's pattern declares. The
transaction refuses a write to a document whose stored version is newer. This
is what handles the fifth party: an old browser tab, a stale server worker, a
client that loaded last week's code. Its writes fail with a conflict the
client already knows how to handle — reload and retry — rather than landing
old-shaped records over new-shaped state.

The Topics design runs this guard in pattern code and says what it cannot
reach. Runtime ownership reaches all three: pre-guard code carries no version
and is refused as version 0 against a stamped document; a running legacy
client's writes carry its version; a direct cell write with no writer version
is either refused against a stamped document or admitted as unversioned, which
is proposal T3 below.

**Proposals for Bernhard, gated by danfuzz where they land in
`packages/memory/v2`.**

- **T1.** Where the writer's version rides. The candidates are transaction
  metadata alongside the CFC write-policy inputs, or the setup identity the
  runner already stamps. The rule needs the version at commit time for the
  root document and for every entry document the write reaches.
- **T2.** What the refusal is. A conflict, so that existing retry and reload
  paths handle it, or a distinct error a client can name.
- **T3.** Whether an unversioned raw write (`cf cell set`, `setRawUntyped`) is
  refused on a stamped document or admitted. Refusing protects the stamp;
  admitting keeps operator repair possible. A middle path admits it with an
  explicit flag naming the version it claims.
- **T4.** Whether a step may wait. A step that needs a document not yet synced
  either fails the transaction, to be retried when the data arrives, or the
  runtime syncs the documents the step names before opening the transaction.
  Topics' lift suspends and re-runs; a setup transaction cannot.
- **T5.** What "touch" is. A start is the natural trigger, and is where an
  origin-following piece reconciles today. A read that fires a migration is a
  read that commits, which crosses read accounting and lazy materialization;
  whether a read counts is for the memory side to say.

### D3. Own-state compatibility is a lookup plus a validation

At upgrade time, the check over the piece's own state is:

1. Does the candidate declare a version at or above the stored one, with a
   step for every increment between? A lookup.
2. After the steps run, does the stored value validate against the new schema?
   Fact 5, already built.

The pattern-level argument proof is kept, in one role: it tells an author in
CI that a change is not subset-compatible. Under this design that finding has
one remedy, a version bump with a step, and the gate's rule becomes: **the
argument contract is subset-compatible with every recorded baseline under the
evolution policy, or the version was bumped and a step declared.** A break in
own state without a bump fails CI. A bump without a break is allowed and
harmless. This replaces the accepted-breaks ledger for own-state paths: the
version is the acknowledgment.

**Proposal for Bernhard and Robin (R1).** The link check's fallback path (fact
3) is the piece's own contract at that path, not a foreign producer's. Under P1
it should not run at all over own entries; if it keeps running in the interim,
it runs with the evolution policy on, the same as the pattern check. This one
change removes 258 of the 302 overrides in the Topics rollout and the
`authorName` workaround. The fallback is Robin's; the policy flag it passes is
Bernhard's. Robin's position, on the Topics refusals: the fields do not satisfy
the constraint the proof states, but they match in the way that matters, since
a wrong-typed value at an optional path is left off the read, and that is
accepted. Fact 2 measures the read behavior that position rests on. What
remains for Bernhard is the checker-side change.

### D4. Cross-piece links are proved against declarations and checked twice more

A consumer's demand is proved against the producer's declared contract, the
schema the producer's pattern published at its version, with the evolution
policy on: a new optional typed demand over an undeclared producer field is
accepted. Fact 2 says the proof cannot guarantee that field's type, so two
more checks bound what the proof cannot:

- The values currently linked are validated at setup (fact 5), and a readable
  wrong-typed value refuses the update, flag or no flag.
- A typed read of an optional declared path drops a wrong-typed value and
  reads it as absent (fact 2). For an optional demand this is the whole of the
  reader-side check the lifecycle spec asks for, and it exists.

**Proposal for Bernhard (R2).** What a typed read does with a wrong-typed
value at a **required** declared path, which the probes did not measure. For
an optional path the answer is measured above. If a required path's read
fails or drops the record, D4 rests on what exists; if the value passes
through, that one case still needs the reader-side check.

On the producer side, when a piece's published contract changes, the runtime
enumerates the consumers that link into it, within the horizon the
verb-evolution design describes (its own space completely, spaces the
deployment can read by scan, and nothing beyond), and checks each consumer's
recorded demand against the new contract. A refusal names the consumers.
This replaces "check against every contract ever published" for a deployed
piece; the baseline ledger remains the CI check for a pattern that has no
deployment to enumerate.

**Proposal for Bernhard (R3).** Whether a demand is proved against the
producer's declared contract only, or against declared-plus-observed. Fact 2
argues that observed values are evidence about the producer's code, not its
contract, and that a demand accepted on observed values alone is accepted on
luck.

### D5. Capability narrowing is free

A consumer declaring `ReadonlyCell` where it declared `Writable` gives up the
write-back leg of the proof and nothing else. The checker accepts it without
a finding. `ReadonlyCell` to `Writable` runs the write-back proof as today.
Stream to cell and cell to stream remain breaks. In the Topics rollout this
removes the only finding on 43 Topics and one of two on the other 258, and it
retires the accepted-break entry that covers the change.

**Proposal for Bernhard (R4).** Confirm that `asCell` comparison can be made
directional without loosening the other semantic-extension keys (`ifc`,
`scope`, `readOnly`, `writeOnly`), which stay exact.

### D6. Scoped acknowledgment on `setsrc`

`setsrc` accepts one or more acknowledgments, each naming a path the check
reports and carrying a reason. The update proceeds only if every finding is
acknowledged by name; an unacknowledged finding refuses as today. The
acknowledgments are written into the piece's source-transition record beside
the revision, so the record survives with the piece. The global flag remains
for one case only: a piece whose current pattern cannot load, where there is
no contract to report findings against.

This is the `setsrc` half of the "break is acknowledged one at a time"
mechanism verb-evolution designs for CI, and it is the driver the Topics
operator wrote by hand.

### D7. Coordinated migrations are a named operation

When a consumer's new demand needs a producer's new output, the producer moves
first; when a producer withdraws something, the consumers move first. Both
sides' updates are ordinary D1 updates. What is new is the plan that sequences
them: a manifest listing the pieces, their order, and the acknowledgment each
step carries, run by the bulk operations that already exist
([piece-bulk-operations.md](piece-bulk-operations.md)), which record a receipt
per piece and stop on an unexpected finding. The board-first ordering in the
Topics rollout is this operation, done by hand.

#### Cycles

Two pieces can depend on each other, and the main case does: a Topic demands
`boardCrossrefs`, `boardNames`, and `mentionable` of its board, and the board
demands `title`, `shortName`, and `createdAt` of each Topic. When both sides
raise a demand in one change, no order satisfies the check: whichever moves
first is proved against the other's old contract. The Topics rollout met no
cycle only because its new demands were optional, which is the phasing below,
done by hand.

The runtime cannot phase the code on the author's behalf. A pattern is one
artifact, and installing it with an unmet demand marked pending would run new
code against the contract the demand exists to rule out. So a cycle has three
answers, offered in this order:

1. **Detect it.** The planner runs each side's check against the other's
   contract in both orders; no order passing is the diagnosis, and the report
   names the demand on each side that closes the cycle. This is the check
   already being run, applied twice.
2. **Apply the set atomically.** Both setups run in one transaction, and each
   new demand is proved against the other's contract as it stands after the
   step. No window, no intermediate version, and the code as written runs.
   This holds only for pieces in one space, since a transaction spans one,
   and only for a set that fits one transaction, so it suits a parent and a
   few children and not a collection of hundreds (S14). A set applied this way
   is not paced by the D1 sweep.
3. **The author phases it.** Version N+1 publishes the new outputs and keeps
   its new demands optional; version N+2 makes them required. Two deploys,
   the guarantee held throughout, and the report from (1) says which demands
   to loosen.

**Proposal for Mike (M2).** Whether (2) is worth building, given (1) and (3)
cover every case at the cost of a second deploy. **Proposal for Bernhard
(T6).** Whether two pieces' setups can share one transaction, so that (2) is
possible at all.

### D8. CI runs what production runs

`pattern-compat` gains the version rule of D3. `pattern-vintage` runs the
candidate through the same setup path `setsrc` uses — steps, then validation,
then the retained-link check — over every captured fixture, so a step is
tested against real prior state before it ships, and a refusal that would
fire in production fires in CI. The pinned Topics fixtures hold comment and
link writes, so the `editedAt` refusal would have fired there.

## Use cases

Each row is a kind of change an author or operator wants to make. "Today"
is the outcome on current main; "cost" is the tier under this design:
**automatic** (write nothing), **declared** (bump the version and write a
step), **coordinated** (a D7 manifest), or **acknowledged** (a D6
acknowledgment on a reviewed break). Every row has a path; none needs the
global flag.

### Own state

| Change                                                           | Today                                                                          | Design                                                                                                   | Cost         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------ |
| S1. Add an optional field to a stored object or list element     | Refused once the list has an entry (258 Topics)                                | Old records lack it; typed reads return absent                                                           | automatic    |
| S2. Add a required field with a default                          | Accepted; default materializes                                                 | Same                                                                                                     | automatic    |
| S3. Add a required field computed from existing data             | Refused; override                                                              | Step computes it per record                                                                              | declared     |
| S4. Rename a field, or move it (`authorName` to `author.name`)   | Not a schema break; old data goes unreachable; only Tier 2 replay sees it      | Step copies; the old key stays as a permanent storage key. #7345 is this case                            | declared     |
| S5. Change a field's type (`string` to `{ name, kind }`)         | Refused; override                                                              | Step converts; a value that cannot convert is the author's decision, written in the step                 | declared     |
| S6. Remove a field the pattern no longer reads                   | Accepted on the argument side                                                  | Same; the data stays in the document unless a step deletes it                                            | automatic    |
| S7. Restructure a collection (list to keyed map, split a record) | Refused; override                                                              | Step rewrites, reaching entries through their links                                                      | declared     |
| S8. Change a default's value                                     | Refused; defaults are compared                                                 | Two meanings, made explicit: a new default for new records is automatic; a new meaning for existing absent values is a step | automatic or declared |
| S9. Narrow a legacy `unknown` to a type                          | Refused; override                                                              | Step reads the actual values and converts or defaults; the same as S5                                    | declared     |
| S10. Clean up values the old code wrote wrongly                  | Setup refuses a readable wrong-typed value; undeclared fields are stripped on read | Step cleans; undeclared fields stay ignored                                                            | declared     |
| S11. Roll the code back after a migration                        | Old code runs; no guard                                                        | D2 refuses the old code's writes; old code reads what it can. No down-migrations: restore from a snapshot | operator     |
| S12. Old clients still running during the rollout                | Both versions write; measured at 96% of commits                                | D2 refuses the old writes as conflicts                                                                   | automatic    |
| S13. A step needs a document not yet synced                      | Topics' lift suspends and re-runs; handlers defer                              | Proposal T4: fail and retry, or sync first                                                               | automatic    |
| S14. A migration too large for one transaction                   | One transaction or nothing                                                     | A resumable step: commit a slice, keep a cursor, the sweep fires it again                                | declared     |
| S15. Thousands of pieces behind after a deploy                   | Each migrates on load, all at once if all are opened; or serial by hand        | On touch for the pieces in use, the sweep for the rest, at a budgeted rate                               | automatic    |

**Proposal for Bernhard (R5).** S8. Whether the checker can distinguish a
default that applies at creation from one that gives meaning to an existing
absent value. If it cannot, every default change is declared.

### Outward: the piece's consumers

| Change                                                  | Today                                                          | Design                                                                                                              | Cost                      |
| ------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| C1. Add a result field or a verb                        | Accepted; a holder embedding the full output type is refused   | Accepted; holders demand narrowly (verb-evolution)                                                                  | automatic                 |
| C2. Remove or rename a result field                     | Refused                                                        | D4 enumerates consumers; each moves its demand (an I3 or I4 update), then the producer moves                        | coordinated               |
| C3. Change a result field's type                        | Refused                                                        | Same as C2                                                                                                          | coordinated               |
| C4. Make a required result field optional               | Refused                                                        | Same as C2                                                                                                          | coordinated               |
| C5. Stop offering write access to a result              | Refused                                                        | Consumers holding writable handles move first (I5); then the producer                                               | coordinated               |
| C6. Break a consumer beyond the horizon, or on purpose  | Global override                                                | Acknowledge by name; the reader's own check (D4) is what the consumer has                                           | acknowledged              |
| C7. Change a verb's input or output                     | verb-evolution rules                                           | Unchanged: widen freely, otherwise a new name                                                                       | automatic or new name     |

### Inward: the piece's producers

| Change                                                        | Today                                                     | Design                                                                                     | Cost         |
| ------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------ |
| I1. Demand a new optional typed field the producer does not declare (`shortName`) | Refused; override                     | Accepted under the evolution policy; current values validated; typed reads check           | automatic    |
| I2. Demand a new required field                               | Refused                                                   | Producer adds it first (its own S1 to S3), then the consumer                                | coordinated  |
| I3. Drop a demand                                             | Accepted                                                  | Same                                                                                       | automatic    |
| I4. Narrow a demand's type                                    | Refused                                                   | Optional: as I1. Required: as I2                                                           | automatic or coordinated |
| I5. Give up write access (`mentionable`)                      | Refused (301 Topics)                                      | D5: free                                                                                   | automatic    |
| I6. Take write access                                         | Write-back proof                                          | Same                                                                                       | automatic if it proves, else coordinated |
| I7. Link to a different producer                              | `cf piece link`, not an update                            | Same                                                                                       | operator     |

### Cross-cutting

| Situation                                                  | Today                                              | Design                                                                                   | Cost         |
| ---------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------ |
| X1. Two sides change together (board and its Topics)       | By hand, board first, each with the global flag    | D7 manifest, each step with its own acknowledgment, receipts per piece                   | coordinated  |
| X2. The piece's current pattern cannot load                | Global flag                                        | Global flag, the one case it keeps                                                       | acknowledged |
| X3. The same update over many pieces                       | Bulk retarget with `allowIncompatible` per row     | Bulk retarget with per-row acknowledgments                                               | as the row   |
| X4. A reviewed break with a record                         | A `docs/history` record written by hand            | The acknowledgment is the record, on the piece; a history document where the reasoning needs prose | acknowledged |
| X5. A pattern's first migration on a piece with no stamp   | n/a                                                | Absent means version 0; the first step runs                                              | automatic    |
| X6. A collection needs every member migrated before it moves | By hand: members first, then the collection       | A precondition in the manifest; the collection runs old code until its members are there | coordinated  |
| X7. Two pieces raise demands on each other in one change   | Refused in every order; override                   | The planner names the cycle; a small same-space set applies atomically, otherwise the author ships the tolerant version first | coordinated, or declared twice |

The Topics rollout, replayed under this design: `mentionable` is I5 and free;
`editedAt` and `removedAt` are S1 and free; the board's `shortName` demand on
its Topics is I1 and free; the Topics' own `shortName` demand on the mention
universe is cleared by updating the board first, which is D7. The author
migration is S4, declared, and its step is the one Topics already has. Zero
overrides.

## Retrofit

What exists already matches the design in the places that matter for existing
data. Absent stamp means version 0 is the convention Topics uses. The step
contract is Topics' contract. The checker code stays; its policy changes. The
baseline ledger stays as the record of published contracts. Bulk operations stay
as the D7 runner.

Existing Topics carry `topicStateVersion: 1` in a stored input field the
runtime does not read. Topics adopts the runtime version by declaring version
1 with one step, the author migration it already has, which is idempotent over
an already-migrated Topic and so completes at once on every migrated piece.
The pattern-owned field then stops being written and stays as a permanent
storage key.

**Proposal for Gideon (G1).** That adoption, and whether the handler-side
upgrade bindings are removed in the same change or after the runtime guard
lands.

In order, with what each unblocks:

1. **R1 and R4**, the two policy changes to the checker. Days. Together they
   make every override in the Topics rollout except `shortName`
   unnecessary, and `shortName` was a coordination, not a break.
2. **D8**, CI runs the retained-link check inside `pattern-vintage`. Days.
   Makes the production refusal a CI refusal.
3. **D6**, scoped acknowledgment on `setsrc`. Retires the global flag for
   loadable pieces.
4. **D1 and D3**, runtime-owned version and steps, and the CI version rule.
   The design work, with T4 settled first.
5. **D2**, the writer guard, on T1 to T3. The transaction change.
6. **D4's consumer enumeration and D7's manifest**, on the demand recording
   the verb-evolution arc's [#5746] prototypes.

Steps 1 to 3 are independent of one another and of the rest. Steps 4 and 5
are the runtime work and need the proposals confirmed first.

## What this does not settle

- Down-migrations. The design provides none; a rollback after a migration is
  a snapshot restore, with the loss of later edits that implies. Whether any
  use case needs one is a question to hold until one appears.
- Verb evolution, versioned interfaces, and the blast-radius report are
  [verb-evolution.md](verb-evolution.md)'s. D4 and D7 depend on demand
  recording from that arc and say so.
- The reader-side check (R2). If it does not exist, D4 is weaker than stated
  until it is built, and I1 is accepted on the current values alone.
- Whether the state version is per pattern or per exported symbol, for a
  source that exports several.

## References

- [verb-evolution.md](verb-evolution.md) — the interface half.
- [piece-source-lifecycle.md](../specs/piece-source-lifecycle.md) — the
  compatibility policy and the transition guarantees D1 relies on.
- [pattern-update-testing.md](../specs/pattern-update-testing.md) — the two CI
  tiers D8 changes.
- [state-upgrades.md](../../packages/patterns/topics/state-upgrades.md) — the
  pattern-owned version this design hoists.
- [topics-mentionable-readonly-break.md](../history/topics-mentionable-readonly-break.md)
  — the measurement behind D5.
- [collection-naming-topics.md](collection-naming-topics.md) — the predicted
  `shortName` refusal and the board-first ordering.
- [piece-bulk-operations.md](piece-bulk-operations.md) — the runner D7 uses.

[#5746]: https://github.com/commontoolsinc/labs/pull/5746
