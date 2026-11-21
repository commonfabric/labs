# Releasing a projection to a principal the sealed state names

A proposal for `commonfabric/specs`, written in the ruling form of
`cfc/13-11-decisions.md` as `docs/development/cfc-spec-correspondence.md`
("Filing a gap") asks. It is a draft: no specs pull request has been opened for
it, and nothing here is ruled. It is meant to be filed as a specs pull request
of its own and as a follow-up comment on commonfabric/specs#59, the list
release. The labs code it describes is on the branch that holds this file,
behind the `viewerBoundRelease` experimental option, which is off by default.

Each claim about the runtime says how it is known:

- **Ran** means a test in the tree pins it, and the test is named.
- **Read** means it comes from reading the cited code or document.
- **Inferred** means a conclusion drawn from the others.

The specification text quoted here was read from a checkout of
`commonfabric/specs` at its `main` branch on 2026-11-21. The labs pin is
`239fc839`, the head of specs#88. The quoted sections (§5.3, §8.9.3, §8.9.4,
§15's `TransformedBy` row) were not compared between the two, so a reviewer with
the pin checked out should confirm them there.

## The case

A card table is one space. Its whole state, who sits where, the deck and every
hand, is one record sealed to the module's own policy
(`Confidential<T, [PolicyOf<typeof rules>]>`), a clause that admits no
principal, the space's owner included. One handler, `move`, is the record's
declared writer. A blessed function projects what one seat's occupant may see.
That projection has to reach the occupant and nobody else. The table's owner is
a custodian of the state and is not entitled to a hand.

A sealed-bid auction and a ballot box have the same shape: a record nobody
reads, one writer, and a per-principal projection that the record itself decides
the audience of.

`SEAT-VIEWS-FINDINGS.md` beside this file records the attempt to build this on
the list release of specs#59. It ended with a second handler, a public roster, a
sealed key per seat, fixed seat counts, and an owner who could still read any
hand by binding the list's writer from another module.

## Q1 · How a module releases a projection to a principal its own state names

**Question.** When the audience of a blessed computation's output is a fact
inside the sealed state the computation read, what evidence lets an exchange
rule add that principal to the policy's clause?

**Why it is open.**

- §4.3.6 gives a module one subject-independent policy template, so a principal
  cannot be written into it.
- §4.9.3 mints access facts only from space membership: "the trusted runtime
  generates `HasRole` integrity facts for the acting user from **verified space
  membership**". A seat is not a role in a space.
- specs#59 adds a list a cell holds, and resolves it at display by the labels of
  the list's entries. Its entries are written by a declared writer, and an entry
  counts only when its own label names the principal. The sealed state's writer
  cannot write such an entry: everything it writes carries the policy's clause
  (one confidentiality join per transaction, §8.9.2 and §8.9.3 as labs stages
  them). specs#59 defers "computed lists" to `notes/FUTURE-SPEC-WORK.md`.
- §15's `TransformedBy` row records which code ran and which witnesses it
  consumed. It records nothing about which principal the attempt ran for, so a
  rule has nothing to bind an audience from.

**Options.**

- **A. A list per recipient (specs#59 option E, as it stands).** Each recipient
  has a list cell; a key document names it; the rule moves a `Members`
  alternative into the policy clause.
  - _An implementer builds:_ specs#59.
  - _Cost:_ the audience is held outside the sealed state, by a second writer,
    so it protects a recipient from every principal except the subject's sole
    owner (`SEAT-VIEWS-FINDINGS.md`, worry c, pinned by a test). It needs a
    ruling that binds a declared writer to the run that owns the document, and
    one that names a list by the value and not by the schema.
- **B. Count the releasing policy's own writer's entries.** As A, with list
  resolution counting an entry written under the releasing policy's clause for
  the same subject.
  - _An implementer builds:_ specs#59 and an exception in entry resolution.
  - _Cost:_ still a list per recipient in a cell of its own, and still the
    second-binding question for every such list. It removes the second handler
    and not the per-recipient machinery.
- **C. An audience the output names (data-named).** The blessed function's
  output holds the principal at a path, and the flow stage, when it stamps the
  output whole, mints `TransformedBy{identity, inputWitness, audience}` with the
  value found at a path the output's schema declares. A rule binds the `User`
  alternative it adds from `audience`.
  - _An implementer builds:_ a schema key naming the path, a read of the written
    value at stamping, one atom field, no change to the rule calculus.
  - _Cost:_ three, all found by argument and none by test, since this option was
    not built.
    - The pattern materializes one output per recipient, per seat or per bidder,
      on every change of the state, whether or not anyone is looking.
    - The stored label of each output names its recipient. A principal who can
      read label metadata of the shared outputs learns who holds which seat, so
      the seating is not secret.
    - Computing it once per viewer instead needs a parameter saying who the
      viewer is. A public parameter is a caller's to choose (labs
      `cfc-transformed-by-input-witnesses.md`, "Public parameters"), and a
      caller who passes another principal's identifier learns from the minted
      atom whether that principal is in the state: a membership bit.
- **D. The viewer of the computation (applied).** A reactive computation may ask
  the runtime who it is computed for. The runtime answers with the principal
  whose instance the run writes, and the flow stage mints
  `TransformedBy{identity, inputWitness, viewer}` on what the run writes. A rule
  binds the `User` alternative it adds from `viewer`.
  - _An implementer builds:_ the question a computation may ask, one field on an
    atom the flow stage already mints, and nothing in the rule calculus or at
    any gate.
  - _Cost:_ a computation's instance per viewer who is looking, which the
    scoped-instance machinery already provides.
- **E. A `User` clause carried on the output.** The runtime labels what a
  computation writes after asking for its viewer with `[User(viewer)]`, and a
  rule moves that alternative into the policy clause when the output carries the
  witness.
  - _An implementer builds:_ a confidentiality clause on a value the runtime
    supplies, and a rule over existing atoms.
  - _Cost:_ unsound as a general rule shape. A `User(p)` clause on an output
    says that something the computation read was labeled for `p`, not that the
    computation ran for `p`. Any confidential input the endorsed writer wrote
    under a `User(p)` clause satisfies it, so the release is steered by whoever
    can get such an input read. It holds today only where the sealed store's
    ceiling refuses every such input.

**Applied: D.**

- **The audience is not an input.** The blessed function takes the state and
  nothing else. There is no seat index, no key and no list for a caller to
  choose. Which principal the run is for is the runtime's to say.
- **The state decides who sees what.** The function finds its viewer's seat in
  the state it read. Sitting, leaving and being dealt to are writes inside the
  sealed record, and no label changes.
- **No instance binding is needed for this shape.** Binding the writer in
  another module runs the same rules over the same record for the same proposer.
  Running the blessed function anywhere, over any record its writer wrote,
  yields the caller's own view of that record, released to the caller.
- **The claim is one atom.** `TransformedBy{identity, inputWitness, viewer}`
  says "this code wrote this value in an attempt computed for this principal,
  and every confidential input it read carried this witness". The three facts
  are about one attempt, so a rule cannot pair one attempt's code with another
  attempt's viewer.
- **It is value-intrinsic (§5.3).** The rule's only precondition is an integrity
  claim "bound to the exact current value and present in the consumed label", so
  it is "applied at observation, and values derived from that observation carry
  the exchanged confidentiality". A viewer's own derivations of their view stay
  theirs.
- **Nothing is stored per recipient.** One computation node, one instance for
  each principal who looks, and the label of an instance names only the
  principal whose instance it is.

### Proposed text

**§15, the `TransformedBy` row.** Add a field: `viewer?: DID`. Add to the
description: "`viewer`, where present, is the principal the attempt was computed
for, as the runtime told the implementation. The runtime mints it for one
attempt, beside the same atom without it, and only when the implementation asked
for its viewer in that attempt."

**§8.9.3, after the paragraph on retained witnesses.** "An attempt whose
implementation asked the runtime for its viewer has exactly one viewer, the
principal the runtime answered with. For such an attempt the runtime mints each
`TransformedBy` atom a second time carrying that principal as `viewer`. An
attempt that did not ask, an attempt the runtime answered with no principal, and
an attempt whose runs were answered with more than one mint no such atom. A
`viewer`-bearing atom is never retained as an input witness: it states who one
attempt was for, which is no fact about an attempt that reads its output."

**§8.7, a new subsection, "Release to the viewer of a computation".** "A module
policy MAY release the output of an endorsed computation to the principal the
computation was computed for, with a rule whose integrity precondition is a
`TransformedBy` pattern naming the computation, carrying a literal
`inputWitness`, and binding a variable from `viewer`, and whose postcondition
adds `User` of that variable. The rule is value-intrinsic (§5.3). The audience
of such an output is whatever principal the runtime supplied to the attempt; the
computation decides, from its inputs, what that principal's output holds."

**§18, the reactive-runtime profile.** "A computation's viewer is the principal
whose scope instance the run reads and writes. A runtime that computes for one
principal answers with that principal. A runtime that computes for many answers
with the principal whose authenticated demand supplied the run's identity, and
answers with no principal for a run no principal demanded. It MUST NOT answer
with its own service identity, and MUST NOT take the answer from any value a
caller of the computation supplies."

### Pseudocode delta

```typescript
// Shown for illustration only.
function deriveTransformedLabel(
  inputLabels: Map<string, Label>,
  handler: Handler,
  viewer?: DID, // the principal the runtime told this attempt it runs for
): Label {
  const base = transformedByAtoms(handler, inputLabels); // as today
  const forViewer = viewer === undefined
    ? []
    : base.map((atom) => ({ ...atom, viewer }));
  return {
    confidentiality: concatClauses(/* as today */),
    integrity: [...base, ...forViewer, ...hereditary(inputLabels)],
  };
}

function retainedWitnesses(integrity: Atom[]): Atom[] {
  return integrity.filter((atom) =>
    atom.type === TRANSFORMED_BY && atom.viewer === undefined
    // and the depth bound, as today
  );
}
```

A change that gives `deriveTransformedLabel` an argument is a semantic gap by
the procedure's own test, which is why this is filed as one.

### What the Lean development would have to prove

The model: an attempt carries an optional viewer; `transformedFrom` in
`formal/Cfc/LabelTransitions.lean` takes it and emits the `viewer`-bearing
atoms; `Atom.propagationClass` classes them value-bound, as the atom is today.
`formal/Cfc/EntryWitness.lean` already carries the obligation that the atom is
minted for one attempt and by nothing else.

Theorems:

1. **Release names the attempt's viewer.** If the viewer rule, evaluated on a
   location's label, adds `User(q)` to the policy clause, then the label
   resolved at that location holds a `TransformedBy` atom minted by an attempt
   whose viewer is `q`, whose identity is the one the rule names, and whose
   every confidential input carried the witness the rule names. This is one
   atom's content, so the proof is the mint's definition and
   `resolvedWitnesses_from_attemptStamp`.
2. **Noninterference for another principal.** For two states that agree on
   `f(state, q)`, the observations of `q` at a boundary whose ceiling is
   `User(q)` are equal, where `f` is the endorsed computation and every instance
   is stamped by the mint. A principal learns the function's value at their own
   identity and nothing else of the state.
3. **The viewer does not survive derivation.** For any attempt that reads a
   `viewer`-bearing output, no atom it mints carries that `viewer` unless the
   runtime supplied the same principal to it. This is `retainedWitnesses`
   leaving the atom out, plus the meet.
4. **Leaving the atom out of the witnesses under-claims.** Every atom the
   reading attempt mints holds with the `viewer`-bearing atoms removed from its
   inputs' integrity.

A hypothesis, stated as prose beside an abstracted definition and not as a
theorem: the principal the runtime supplies to an attempt is the principal whose
instance the attempt writes, and comes from an authenticated demand. That is the
trusted runtime's word, as `HasRole`'s space membership is.

Rejected variants, as `decide`-checked counterexamples in the examples module:

- **Option E.** An endorsed writer's output labeled `[Policy] ∧ [User(a)]`, read
  by the endorsed computation in an attempt for nobody, releases to `a`.
- **Two atoms in place of one.** With the viewer in an atom of its own,
  `ComputedFor{q}`, a location whose resolution joins two stamps pairs one
  attempt's code and witness with another attempt's viewer.
- **The viewer as a parameter.** With the viewer taken from a public input, an
  attempt run by `a` over `q`'s identifier is stamped for `q` or released to
  `a`, according to which of the two the atom records, and neither is sound.
- **Retaining the viewer as a witness.** A reader of `q`'s output mints an atom
  nesting `viewer: q`, which a rule pinning two levels then matches for an
  attempt that ran for somebody else.

If the model for an attempt's viewer does not exist when this is filed, the
deferral is an entry in `cfc/notes/FUTURE-SPEC-WORK.md`, "Viewer Release
Follow-Ups", with the four theorems under `### Formal proof tasks`.

### Conformance statement

- **Under the current text.** The labs runtime conforms: with the experimental
  option off it mints no `viewer` and a computation cannot ask for one. It
  neither over-taints nor under-taints.
- **Under option D.** The branch implements it behind `viewerBoundRelease`, off
  by default, with the deciding site marked `SPEC-PENDING`. The marker names
  specs#59, since no pull request exists for this proposal; it should name this
  proposal's own request once one is open. With the option on the runtime stores
  a new field on an existing atom, in the instance of the principal the field
  names, and releases more than the pin does. That is why it waits behind the
  option (the procedure's step 4).
- **A labs code change follows** only to remove the option and repin.

### Cases determined

All **ran**, in `runtime/html/test/worker-display-fit-card-table.test.ts` (three
principals, each in a client runtime of their own on one memory server) unless
another file is named.

| Case                                                                                        | Outcome                                                                                                                |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A player reads their own instance of the view                                               | Released, the hand and each card of it                                                                                 |
| A watcher reads their own instance                                                          | Released, and it holds no hand                                                                                         |
| Any principal's ceiling against another principal's instance                                | Refused                                                                                                                |
| The table's owner, with no seat                                                             | Their own instance holds no hand; a player's instance is refused them                                                  |
| A request to sit that names another principal                                               | Seats the sender                                                                                                       |
| The owner binds `move` from another module over the live state                              | Makes the owner's own moves; the witness holds; the owner is shown no hand                                             |
| The owner runs the module a second time over the live state                                 | Computes the owner's own view again, and shows none of it                                                              |
| Another module's handler writes the state                                                   | Refused at commit, "writeAuthorizedBy requires a trusted verified binding identity"                                    |
| A player leaves their seat                                                                  | Their instance holds no hand at its next computation                                                                   |
| The state, and a function of it no rule names                                               | Refused to everyone                                                                                                    |
| The serving loop computes the view for two demanders (`executor-fan-out.test.ts`, case (q)) | Each instance holds its own principal's value, stamped with that principal and the writer's witness                    |
| The same table with a serving runtime running its handlers and computations                 | The memory server stores each principal's instance stamped with them; each is shown their own, and refused the other's |

| Ruling | Ruled by | Date | Notes |
| ------ | -------- | ---- | ----- |
|        |          |      |       |

## What this leaves open

- **A client runtime is trusted for its own user.** With server execution off,
  each client computes its own instance from a replica of the sealed state, and
  the runtime that stamps the viewer is the viewer's own. A modified client is
  outside this, as it is outside every display-boundary check. The serving loop
  supplies the viewer from the authenticated demand (**ran**, case (q), and the
  display test's serving case). In that serving case the display decision is
  made in a client runtime over the labels its replica holds; that those are the
  serving runtime's labels and not the client's own speculation is **inferred**
  from the stored instance carrying the same stamp, and no browser ran.
- **An instance outlives its relevance.** A principal's instance is computed on
  their demand. One who leaves a seat and stops looking keeps, in their own
  instance, the last view computed for them, which is a view they were shown.
  They get no later state. (**Inferred** from scopes.md §2; the case that
  **ran** is a player who is still looking, whose instance loses its hand at
  once.)
- **Scope is not the protection.** `docs/specs/server-side-execution/scopes.md`
  says scope "keys INSTANCES; it NEVER keys authority". The release does not
  rest on where an instance is stored: an instance written anywhere is released
  only to the principal its stamp names. (**Ran**: every "another principal's
  instance" case fits one principal's ceiling against an instance another
  runtime holds.)
- **The label names the viewer.** An instance's stored label holds its viewer's
  identifier, in a document already keyed by that principal. The shared
  documents hold no viewer (**ran**, case (q)).
- **A lift's output through a link is still unwitnessed.** A second run handed
  the state through a link computes the caller's own view and is shown none of
  it (labs gap D). That is fail-closed, and nothing in this proposal needs it
  changed. A ruling that lets argument wiring count as evidence would let a
  pattern compose a table from another pattern's state; under this shape that
  would release to each caller their own view, so it could be ruled without an
  instance binding.
- **Handlers.** Only a reactive computation records a viewer. A handler's actor
  is a different fact (the event's sender, who may act on another principal's
  instance), and stamping it on shared documents would publish who triggered
  each write.
- **The first move.** The witness needs the writer's first write to be
  attributed, so the state needs a labeled default the writer reads. Run over an
  argument cell another transaction filled without the schema, the first move
  reads nothing labeled and its write names no writer (**ran, not kept**: the
  first form of case (q)). That is the pinned "unattributed input" rule.

## Two labs changes classed as conforming

Both are on the branch, each in a commit of its own with a test. They are
recorded here so that a reviewer with the specification can check the class.

**A record its writer reads and sets keeps the writer's stamp.** §8.9.3 gives
the output of an attempt one label, and §15 classes `TransformedBy` as a
"production claim about the exact current value". Labs stamps a `set`
destination whole only under conditions
(`docs/specs/cfc-transformed-by-input-witnesses.md`, "What the endorsed writer's
stamp covers"), one of which refused every destination the writer had read. The
change admits a destination the writer read when every value the write left in
place is one the same writer wrote before, and read in this attempt. The claim
the stamp makes is then true of every position, which is §8.9.3's "do not
overstate what is true of the whole output". Tests:
`runtime/runner/test/cfc-transformed-by-input-witness-state.test.ts`.

**A computation's result is stamped as the run that wrote it.** §8.9.4: "When a
live reactive node recomputes, the new attempt's journal sees the source's
_current_ labels, and the output's derived component is replaced with the
refreshed join". Labs replaced it only at the paths whose value changed, so a
field equal before and after kept the stamp of an earlier run. The change
records an action's result write as a whole-value destination, as `Cell.set` is.
Test: the same file, "a projection computed before the writer's first move".

If either is ruled a semantic gap instead, it needs a marker and the option's
gate, and the text above is the proposal.

## The six refusals, classified

| Refusal                                                                  | Class                                                                                           | Needed by the applied shape                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1. An entry the sealed state's writer wrote lists nobody                 | Semantic gap in specs#59 (a question for its ruling)                                            | No: there is no list                         |
| 2. The one writer can write nothing public (gap F)                       | Conforming, staged: one join per transaction over-taints, and a finer join is §8.9.2's own text | No: everything public is a field of the view |
| 3. A record read and then set loses its witness (gap A)                  | Conforming implementation of §8.9.3, fixed                                                      | Yes: the state is a record                   |
| 4. A projection of a state reached through a link has no witness (gap D) | Intended, fail-closed; composing it needs a ruling                                              | No                                           |
| 5. A declared writer and a witness name a handler, not a run             | Semantic gap (instance binding), not filed here                                                 | No: see "No instance binding is needed"      |
| 6a. The list is named by a pointer in the schema, so seats are fixed     | Semantic gap in specs#59                                                                        | No: the seat count is a number in the state  |
| 6b. `cfcPattern.members()` is in the API and the transformer refuses it  | Labs bug in the specs#59 draft port, not fixed here                                             | No                                           |

A seventh, met while building: a computation's unchanged output keeps an earlier
run's stamp (gap B). Conforming implementation of §8.9.4, fixed.

## What the pattern no longer computes or stores

Compared with `seat-views.tsx`, by reading the two sources. No timing was
measured.

| Per-seat list release (`seat-views.tsx`)                                  | Viewer release (`card-table.tsx`)                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------- |
| One view cell per seat, computed and stored on every move                 | One view node; an instance per principal who is looking |
| One sealed key per seat, written at setup                                 | None                                                    |
| One occupant list per seat, each a cell of its own, and an entry document | None                                                    |
| A public roster and a public phase, written by a second handler           | None; both are fields of the sealed record              |
| Two handlers, `move` and `seating`                                        | One, `move`                                             |
| Seat count fixed in the types (`key0`, `key1`, `key2`)                    | A number the setup move chooses                         |
| A capture check at commit, and a list resolution at each display          | Neither; the gate reads the label it already reads      |

A move at a table of `n` seats with `k` principals looking recomputes `k` views
here, where the per-seat shape recomputes `n` whoever is looking. A data-named
audience (option C) would also recompute `n`.

## Draft comment for specs#59

Not posted.

> A follow-up to the card-table case. The spike on the list release is written
> up in `SEAT-VIEWS-FINDINGS.md`; this is what we built instead, and what it
> means for this ruling.
>
> **We no longer need the list release for this case.** The table now has one
> sealed record, one writer, and one blessed function that takes the record and
> asks the runtime who it is computed for. The flow stage stamps what that
> function writes with the principal it ran for, as a field on the
> `TransformedBy` atom it already mints, and one value-intrinsic rule adds
> `User(viewer)` to the policy clause. The proposal, in ruling form with the
> pseudocode delta and the theorems it needs, is
> `MODULE-NAMED-AUDIENCE-PROPOSAL.md` on the same branch.
>
> **What that withdraws from this thread.** For the custodian-owner case, my
> questions about a carried `Members` clause, about players seating themselves,
> about a list named by the value, and about entries the policy's own writer
> wrote. None of them arises without a list.
>
> **What it leaves standing.** The second-binding hole is still in the draft: a
> list's declared writer names a handler and not the run that owns the list, and
> a test pins the owner reading another player's hand through it. Find My is not
> affected, because its owner is entitled to the data. Any other custodian case
> built on a list is.
>
> **A suggestion for the text.** §8.7.5 could say which case a list is for: an
> audience its owner curates, for data the owner is entitled to. An audience
> that is a fact inside sealed state wants the release bound to the
> computation's viewer, not to a second document.
