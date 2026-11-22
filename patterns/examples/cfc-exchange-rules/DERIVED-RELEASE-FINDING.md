# What a pattern derives from a released value

A brief for whoever fixes this in the runtime at large. It assumes no knowledge
of the branch it was written on. It is a local file: nothing here has been filed
as an issue, a pull request or a specs ruling.

Each claim says how it is known:

- **Ran** means a test or a command was run, and it is named.
- **Read** means it comes from reading the cited code or document.
- **Inferred** means a conclusion drawn from the others.

The specification text quoted here was read from a checkout of
`commonfabric/specs` at `main` (`f549c796`) on 2026-11-22. The labs pin is
`239fc839`. `cfc/05-policy-architecture.md` and `cfc/13-11-decisions.md` do not
differ between the two (**ran**: `git diff 239fc839 main` over them is empty).
`cfc/08-12-store-label-monotonicity.md` does, and the two sentences of §8.12.8
quoted below are in both (**ran**: a search of the file at the pin).

## The defect

A CFC exchange rule releases a confidential value when integrity evidence about
that value is present. A rule that names a function with a `TransformedBy`
pattern, as the rules in this directory do, is guarded by evidence the runtime
stamps on what that function wrote, and on nothing computed from it.

At a gate that reads the released value itself, the release works: a handler
that publishes it, a sink, or a display that shows a field of it by path. Any
value a pattern computes from it, with `computed`, a `lift`, or a handler that
writes somewhere else first, stayed sealed to everyone, including the audience
the rule released the original to.

Three separate causes produce that. The first is a defect in the runtime and is
fixed on this branch. The other two are what the runtime is designed to do
today, and each needs a decision before code.

| Cause                                                             | Affects                                                                                   | State                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------- |
| 1. The flow join joins labels as stored, with no exchange         | Every derivation of a value a value-intrinsic rule releases, on `origin/main` too         | Fixed here, separable for main   |
| 2. A path's existence label is frozen at its creation             | A derivation first computed while its input was still sealed                              | Open: needs a ruling             |
| 3. The builder declares the join of a node's inputs on its output | A list a pattern maps from a released value, and any output that stores the declared join | Open: needs a ruling or a design |

It is not specific to viewer-bound release. Cause 1 reproduces on `origin/main`
(`c672013024`) with `blessed-computation.tsx`, whose rule drops a clause for the
whole space (**ran**, below).

## The smallest reproduction

`patterns/examples/cfc-exchange-rules/derived-release.test.tsx` is one pattern
test over `blessed-computation.tsx`. It publishes, into stores that admit only
public values, a `computed` over the released tally, a module-scope `lift` over
it, a `computed` over that lift, and a `lift` that also read the unreleased
briefs.

```sh
deno task cf test patterns/examples/cfc-exchange-rules/derived-release.test.tsx
```

**Ran** on `origin/main` at `c672013024`, with the test file copied in and
nothing else changed:

```text
  ✓ assertion_1 (after action_2)
  ✗ assertion_2 (after action_3)
  ✗ assertion_3 (after action_4)
  ✗ assertion_4 (after action_5)
  ✓ assertion_5 (after action_5)
  ✓ assertion_6 (after action_6)
3 passed, 3 failed
```

with, for each of the three,

```text
CFC enforcement rejected commit: relevant transaction was not prepared: maxConfidentiality failed at /roomComputed
```

and the same for `/roomLifted` and `/roomChained`. The refusal of `/roomMixed`
is the one that should happen.

**Ran** on this branch, and on `origin/main` with the fix applied:
`6 passed, 0 failed`.

`runtime/runner/test/cfc-exchange-at-observation.test.ts` is the same defect
with no pattern: a document seeded with a sealed clause and a value stamp, one
transaction that reads it and writes another document, and the clauses the
written document's value stamp carries. Ten cases; **ran**, ten pass on this
branch and on `origin/main` with the fix applied. Its positive cases fail
without the fix (**inferred** from the pattern test failing there; the unit test
was not run against unfixed code).

## Cause 1: the flow join does no exchange

### Where

`deriveFlowJoinImpl` in `runtime/runner/src/cfc/prepare.ts`. On `origin/main` at
`c672013024` the function starts at line 5257 and the deciding statement is line
5847:

```typescript
for (const atom of joined) atoms.push(atom);
```

`joined` is the confidentiality one observation consumed, resolved from the
stored label map of the document it read. It goes into the transaction's join
unchanged, and the join is stamped on every document the transaction writes
(**read**).

The release gates do evaluate exchange. `verifyInputRequirements` and
`verifySinkRequestCeilings` in the same file, and `readRefusal` in
`runtime/html/src/worker/display-fit.ts`, run the value-intrinsic rules at each
location an access consumed, on the evidence there about the value currently at
it (`exchangeEachObservation` in `cfc/access-integrity.ts`). That is why a
direct read of the released value passes. A gate that reads a derived value
finds the clause, and beside it only the deriving function's own
`TransformedBy`, which no rule names (**ran**: the refusal the display test
printed before the fix carried the policy clause and
`TransformedBy{describeSeat}`).

### What the specification says

`cfc/05-policy-architecture.md` §5.3:

> A runtime MUST evaluate exchange wherever a label is consumed: when a value is
> observed into a computation, when a write is fitted against a store's label
> (§8.12.4), and at a release boundary.

and, of value-intrinsic rules:

> They are applied at observation, and values derived from that observation
> carry the exchanged confidentiality. This is necessary because such evidence
> [...] is value-bound, and the class-aware meet drops it at the next
> transformation, so an exchange deferred to a later boundary would find its
> evidence gone.

`cfc/13-11-decisions.md`, decision D5, ruled option C on 2026-09-25:
"Value-intrinsic general rules carry their result to derived values, recording
the satisfying integrity as a `TransformedBy` witness; boundary-scoped and
grant-guarded rules do not." Its "why it is open" paragraph describes this
defect: "If exchange runs only at the sink, any derivation in between destroys
the evidence and the relaxation can never fire."

So labs departed from §5.3 in the over-taint direction: it refused what the
specification releases, and released nothing it should not.

### The fix on this branch

In `deriveFlowJoinImpl`, `exchangedAtObservation` takes the clauses one
observation consumed and returns them as the value-intrinsic rules leave them.
It resolves the observation into locations with `consumedLocations`, the
function the gates use, and runs `exchangeEachObservation` over them with the
value-intrinsic rules only (`admitsRulesOfKind("value-intrinsic")`). What joins
is the result. A read declared onward (the list a map coordinator reads) has
both of its parts exchanged: what it consumed at the slots, and the membership
it sends to its container.

**Classification: conforming implementation** of §5.3, by
`docs/development/cfc-spec-correspondence.md`. No kernel function gains an
argument and no rule is added that the pseudocode lacks: the exchange happens
before the labels reach the default transition, which is where §5.3 puts it. The
change does alter what is stored at the strict default, in the direction of less
confidentiality, which the procedure allows a conforming implementation and not
a semantic gap. A reviewer with the specification should confirm the class
rather than trust it; if it is ruled a gap instead, the change needs a
`SPEC-PENDING` marker and a dial that defaults to off.

`docs/specs/cfc-conformance-statement.md` §4 records the four places where the
fix still over-taints or under-claims.

### Soundness conditions, and the test that pins each

All in `runtime/runner/test/cfc-exchange-at-observation.test.ts` unless another
file is named. All **ran**.

| Condition                                                                             | Test                                                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A derivation carries exactly what the rule left, and no more                          | "carries the viewer the rule added beside the sealed clause", "carries no clause where the rule dropped it"                                |
| It still does after a second derivation                                               | "carries the released clause on through a second derivation"                                                                               |
| An input no rule releases keeps its clause, whatever else was read                    | "keeps the sealed clause of an input no rule released", "keeps the sealed clause beside a clause the rule dropped"                         |
| Reading two principals' values yields one clause for each, which admits neither alone | "carries one clause for each viewer whose value it read"                                                                                   |
| Evidence naming other code releases nothing                                           | "keeps the sealed clause of a value other code wrote"                                                                                      |
| Evidence a schema declares, with no write behind it, releases nothing                 | "keeps the sealed clause where the evidence is declared, not stamped"                                                                      |
| A rule scoped to a boundary is not carried                                            | "a rule that is not value-intrinsic: leaves the sealed clause on what is derived"                                                          |
| Nothing is exchanged unless the policy-evaluation dial is `enforce`                   | "with policy evaluation at observe: leaves the sealed clause on what is derived"                                                           |
| A derivation computed for one principal is refused to every other                     | `runtime/html/test/worker-display-fit-card-table.test.ts`, "shows nobody what another's view was derived into", client and serving runtime |
| A derivation that also read the sealed state is refused to everyone                   | the same file, "shows nobody a derivation that read the state too"; `derived-release.test.tsx`, the `roomMixed` assertion                  |

Three properties rest on reading the code, with no test of their own:

- An evaluation that runs out of fuel, or cannot resolve a module's policy
  manifest, leaves the clauses as read (**read**: the `incomplete` flag in
  `exchangedAtObservation`).
- The input-witness meet, the hereditary meet and the followed-reference
  accounting still go by the label as read, so a location whose clause a rule
  released still counts as a confidential input (**read**).
- A label-metadata observation and external content join as read (**read**).

### Cutting it for `origin/main`

The fix is independent of the viewer-bound and list-release commits. It is five
paths:

- `runtime/runner/src/cfc/prepare.ts`
- `runtime/runner/test/cfc-exchange-at-observation.test.ts`
- `patterns/examples/cfc-exchange-rules/derived-release.test.tsx`
- `docs/specs/cfc-conformance-statement.md`
- `docs/plans/cfc-release-gate-integrity.md`

They are one commit on this branch, `4afac41b30` ("fix(runner): Carry a
value-intrinsic release to what is derived from the value"). **Ran**:
`git cherry-pick 4afac41b30` onto `origin/main` at `c672013024` applied with no
conflict, and there the unit test passed (10 cases), `derived-release.test.tsx`
passed (6 assertions), and the pattern tests of `blessed-computation`,
`blessed-object`, `witnessed-chain`, `direct-release`, `custody-projector`,
`custody-answer-room` and `imported-policy` passed. The unit test names a
`viewer` field on a `TransformedBy` atom as plain seeded data, which needs none
of the viewer-bound code.

What cannot be separated: the card table's cases in
`runtime/html/test/worker-display-fit-card-table.test.ts` and the derivations
added to `card-table.tsx`, which need `viewerBoundRelease`; and the paragraph in
this directory's `README.md`, which names the card table.

Not run on `origin/main`: the runner's whole CFC suite, the type check, and the
other gates. On this branch the suite's result with the fix is the same as
without it (see "What ran").

## Cause 2: a path's existence label is frozen at its creation

### What happens

A document's label map holds, for the root of a computation's result, a value
entry that every run replaces and an existence entry minted once, at the run
that created the path, with that run's join. A reader of the value consumes
both.

At the card table, the state is `null` until the first move, and a view computed
from it carries no witness that `move` wrote its input, so the rule does not
release it. A `computed` over that view is first run then, and its existence
entry takes the sealed clause. Every later run writes a value entry the rule's
exchange has released. The existence entry never changes, so the cell stays
withheld from the principal it is computed for.

**Ran** (`worker-display-fit-card-table.test.ts`, "withholds a derivation first
computed before the first move", and "shows a principal a lift of their own
view"): two principals who open the table before its setup are refused their own
`summary` and `held`; a third who opens it after the deal is shown hers, and is
shown them again after the view changes. The stored entries were printed while
tracing: the refused cell held a `derived`/`shape` entry with the bare policy
clause beside a `derived`/`value` entry with the released one.

The released view itself is not caught by this, though its own existence entry
is sealed too. At its location the sealed clause of the existence entry and of
the value entry are the same clause, and the value stamp's evidence releases it
(**read**: `exchangeEachObservation` exchanges a location's clauses together).

### Where, and what the specification says

`runtime/runner/src/cfc/prepare.ts`, the comment "Freeze-at-creation: mint the
existence entry only when the path" (line 14604 on `origin/main`), and
`docs/specs/cfc-observation-classes.md` §5.

The runtime conforms here. `cfc/08-12-store-label-monotonicity.md` §8.12.8:

> A runtime that populates per-observation-class entries for the derived
> component MUST mint the `shape` (existence) entry at the path's creation
> event, carrying the creating attempt's join.

> An overwrite of a still-existing path MUST NOT modify the existence entry —
> neither replacing it nor joining the overwriting attempt's label into it.

So this is not an implementation defect. Changing it is a **semantic gap**, and
goes through a specs pull request first.

### What a ruling could say

The question: when a reactive computation's result was created from an input a
value-intrinsic rule did not yet release, and every later run reads the input
released, what guards the fact that the result exists?

- **A. The creation event of a computation's result is its setup.** The
  existence entry at the root of a result document is minted from what the setup
  had read, as specs#88 does for a result wiring's membership, and not from the
  first run's data. The first run's data decides the value, which the value
  entry already guards.
  - _An implementer builds:_ the existence mint at a computation's result root
    taking the setup's join.
  - _Cost:_ where a first run writes `undefined` and a later one a value, the
    existing delete-and-re-create rule already re-mints; where the type of the
    value depends on sealed data, the value entry carries that, and a shallow
    read consumes less than it does today.
- **B. A recomputation re-creates.** A run of a live node that replaces its
  whole result is a creation event, so the existence entry is re-minted from
  that run's join.
  - _Cost:_ it is the replace-on-overwrite the freeze was adopted to prevent,
    limited to computation results. §8.12.8's "why freezing is sound" would need
    restating for it.
- **C. Leave it, and release from the start.** A pattern whose first view is
  already released has no sealed creation. For the card table that needs a
  labeled default the writer is credited with, which the `TODO(cfc)` on
  `StoredGame` in `card-table.tsx` records as missing.
  - _Cost:_ it fixes one pattern's first run and leaves every release whose
    evidence arrives after its consumers exist.

A is the recommendation: it says what the entry is for, and reuses a distinction
the result-wiring ruling already draws.

## Cause 3: the builder declares the join of a node's inputs on its output

### What happens

When a pattern's graph is assembled, every node's output takes the join of the
`ifc` its inputs' schemas declare (`applyInputIfcToOutput`, called at
`runtime/runner/src/builder/node-utils.ts` line 62 on `origin/main`, and
`applyArgumentIfcToResult` beside it). The join is a schema annotation, and
where a write goes through that schema it is stored as a `declared` entry.
`docs/specs/cfc-render-boundary-composition.md`, "Nested pattern outputs", says
this is intended: "No module is excused that input join", and "it mints a
`declared` entry, and a path's effective label is the join of all its
components, so the `derived` component above adds to it and never narrows it."

A declared clause is store policy. No value stamp stands behind it, and the
gates match a value-intrinsic rule only against evidence about the value
currently stored (`bindsCurrentValueEvidence` in `prepare.ts`). So a clause that
arrives by this route is released by nothing.

At the card table, `view.counts.map(...)` is reached through a document every
principal shares, holding a link to each principal's own list. **Ran**
("withholds a list mapped from a view", and the entries printed while tracing):
after the fix, every entry on the principal's list, on each item and on each
item's computed label carried the released clause; the shared document carried
one entry, `origin: "declared"` at its root, with the bare policy clause; and
the display refused the list on that clause. That the entry comes from the
build-time join, through the schema a map stamps on its result container, is
**inferred** from the entry's origin and the composition document; the other
route that writes a `declared` entry from a join
(`writer-fit(runtime-owned-store-declared)` in `prepare.ts`) was checked with a
log line and did not fire.

A `lift` or a `computed` over the same view takes the same build-time join on
its schema and was not refused for it (**ran**: the late joiner's `summary` and
`held` are shown). Their result documents held no `declared` entry. Why a map's
container stores the declaration and a lift's result does not was not traced.

Not reproduced on `origin/main`: the examples there release a string and an
object, and no test maps a released list. The builder code is the same on both
(**read**), so it is **inferred** to apply.

### What it needs

The static join cannot know what evidence a value will carry, so it cannot apply
§5.3. Two directions, neither built:

- **A design in labs**, if the specification already allows it: keep the
  build-time join out of the `declared` component where every clause it would
  add is one a module policy's value-intrinsic rule could release, and let the
  `derived` component, which the fix now exchanges, be the only carrier. The
  composition document argues the opposite today, from §8.9.1's trust gate, so
  this needs that argument answered, not skipped.
- **A ruling**, if it does not: whether a clause a store declares only because a
  build-time join put it there is store policy in §8.12.8's sense, or a
  conservative stand-in for a flow label, which §5.3 would then reach.

Until one of them lands, a pattern can show fields of a released view by path in
JSX, and can show a `computed` or a `lift` over it (subject to cause 2), and
cannot show a `.map` over a list in it.

## What else the same root cause reaches

**Read** or **inferred**; none of these was run.

- Every example here whose rule names a `TransformedBy`: `blessed-computation`,
  `blessed-object`, `witnessed-chain`, `custody-projector`,
  `custody-answer-room`, `direct-release` and `imported-policy` where their
  rules are value-intrinsic. Before the fix, each releases only what a gate
  reads directly.
- A value-intrinsic rule in an operator's policy records
  (`RuntimeOptions.cfcPolicyRecords`), for instance one guarded by
  `CaveatScreened` or `InjectionSafe`. §5.3 names these as the reason the carry
  exists. The unit test's rules are of this kind.
- The standard profile's space-reader rule is guarded by `HasRole`, which is
  minted for an access, so it is not value-intrinsic and is unaffected: it fires
  again at each gate.
- `describeSinkReleaseRefusal` in `prepare.ts`, the host's own release route,
  applies no exchange at all, as its comment and
  `docs/specs/cfc-enforcement-matrix.md` say. With the fix, a derived value's
  stored label is already exchanged, so that route now releases a derivation
  where it still refuses the original. That asymmetry is new and worth a look.
- A clause a rule rewrote is stored as an OR-clause naming a principal. Where
  the writing document is shared and not a per-principal instance, its label
  metadata then names who the value was released to.
- The pages that describe release by rule,
  `docs/specs/cfc-exchange-rules-authoring.md` and
  `docs/specs/cfc-transformed-by-input-witnesses.md`, say nothing about derived
  values either way. They want a sentence once the fix is on `main`.

## What ran, what was read, what was inferred

**Ran**, on this branch with the fix:

- `deno task cf test` on `derived-release.test.tsx`: 6 assertions pass, with
  `EXPERIMENTAL_SERVER_EXECUTION` both `true` and `false`.
- `runtime/runner/test/cfc-exchange-at-observation.test.ts`: 10 cases pass.
- `runtime/html/test/worker-display-fit-card-table.test.ts`: 8 tests, 31 steps
  pass, of which 2 tests and 9 steps are new.
- `card-table.test.tsx` (26 assertions) and `card-table-multi-user.test.tsx`
  (28), each with server execution on and off.
- The runner's CFC tests, `runtime/runner/test/cfc*.test.ts`: 309 pass and 3
  fail. The same three fail without the fix, one each in
  `cfc-asserted-root-concurrency.test.ts`, `cfc-field-anchors.test.ts` and
  `cfc-sqlite-query-control-state.test.ts`.
- The other pattern tests in this directory: `blessed-computation`,
  `blessed-object`, `witnessed-chain`, `direct-release`, `custody-projector`,
  `custody-answer-room`, `imported-policy`, `seat-views` and
  `seat-views-multi-user` all pass.
- `runtime/html`'s Deno tests, its browser-only file aside: 68 pass.
- `deno fmt --check`, `deno lint`, `deno task check` and `deno task cfcheck`
  pass. `deno task check-cfc-correspondence` fails on the same 16 citations it
  failed on before the fix, all from the list-release port, and on nothing the
  fix added.

**Ran**, on `origin/main` at `c672013024`: the pattern test without the fix (3
of 6 fail), and, with the fix cherry-picked, both new tests and the seven
example tests named under "Cutting it for `origin/main`" (all pass).

**Read**: the specification sections quoted, at the revisions named at the top;
the labs code and documents cited.

**Inferred**: the items marked so above. Chief among them, that cause 3 comes
through the map's schema stamp, and that it reaches `origin/main`.

**Not verified**: anything in a browser. The display tests call the function the
reconciler calls, with labels a runtime computed, and no page was rendered.
Whether a pattern's JSX now shows a `computed` over a released view to a
principal who opened the page after the release was not observed.
