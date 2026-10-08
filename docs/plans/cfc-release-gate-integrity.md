# Release gates without an integrity union

## Why

An exchange rule releases a clause when the integrity it requires is present,
and that integrity has to describe the value the clause came from. Pooled
across everything an access consumed, one value's evidence releases another
value's clause: a document holding an endorsed output beside a value other code
wrote releases both. The write input gate, sink egress and the display's read
fit now evaluate each observation, then the join ("How the gates evaluate").
What remains is the specification ruling on the looser variants, and the
display's fit of a cell's stored label, which still pools.
[Input requirements on arguments](cfc-argument-input-requirements.md) depends
on the gates holding.

## What the specification says

- **§5.3:** "For each access, the runtime takes the label that access consumes
  (for an observation, the effective label of §8.12.8) and evaluates every
  applicable rule to fixpoint".
- **§8.12.8:** the effective label for an observation joins the applicable
  components; "Integrity MUST NOT be unioned across components: where a single
  integrity set is needed for the materialized value, the class-aware join of
  §3.1.6.2 applies".
- **§8.10.1.1:** a value materialized from several primitive observations
  carries the join of their labels.
- **§3.1.6.2:** the join keeps the hereditary atoms present in every input.
  Value-bound atoms, `TransformedBy` among them (§15.4), drop.
- **§5.3, on value-intrinsic rules:** a rule whose guard is satisfied by
  value-bound claims "in the consumed label" is applied at observation, and
  values derived from that observation carry the exchanged confidentiality.
  This is how evidence that a later join drops still releases what it vouched
  for.

## What still pools

- A cell's stored label at the display (`cellLabelRefusal`) is fitted on the
  integrity at its root, every entry's clauses included. A label view carries
  no origin and folds an ancestor's entry in beside a narrower cell's own, so
  it cannot be resolved location by location until views carry origins.
- Within one location, `labelForEntriesAtPath` unions integrity across
  components. The component that declares the store's policy carries none in
  practice, so the union there equals the one component that carries any. The
  question is what §8.12.8's join means when a component makes no integrity
  claim. Read literally, the join would drop every per-value claim wherever a
  policy is declared. That reading needs a ruling before anything changes.

## Classification

Removing the union is a **conforming implementation**. Berni's 2026-09-25
review of D5 (`cfc/13-11-decisions.md` in the specs repository) states the
rule: an exchanged label wherever a label is consumed, carried forward by rule
kind. §5.3 applies a value-intrinsic rule at observation, and §4.6.3 makes a
whole read a traversal over primitive observations whose labels are joined.
The gates take the literal form of each step, which refuses at least as much
as any ruling that loosens it, and they store nothing new.

Three looser variants go to a specs ruling as proposals: one stamp speaking
for every location it resolves at, a join over the confidential locations
only, and a floor that counts each location as an observation. The join
within one location is the separate gap above.

## How the gates evaluate

At the write input gate, at sink egress, and for the reads behind a rendered
value:

1. The access is resolved into the locations it consumed: each read's own
   path and, for a recursive read, the path of every entry beneath it, each
   resolved over the entries that resolve there, as the input witnesses
   resolve them. A link probe observes the slot it probes, and two
   observations of one location are one.
2. At each location, the value-intrinsic rules (`isValueIntrinsicExchangeRule`)
   run over that location's own clauses, matched against the integrity of the
   entries there that bind the current value: flow stamps and the writer's
   own stamps, not existence stamps, declared policy, link copies, or ingest
   marks.
3. The results are joined. A clause no location resolved stays as it was
   read. The integrity is §3.1.6.2's class-aware join of every location:
   hereditary atoms every location carries, and anything else only where the
   access observed one location.
4. Every rule then runs over the joined label, with the gate's boundary
   context, and the ceiling is fitted.

The `requiredIntegrity` floor needs a witness that the join of each gated
read's locations keeps. A cell's stored label at the display is still fitted
on its root's integrity: a label view carries no origin, so it cannot be
resolved location by location yet.

## Related leaks the gates do not close

Adversarial review found integrity vouching across values outside the three
gates. Each is a separate change; none is fixed here.

- **The flow join's hereditary meet** meets each observation's union across
  locations, so a value derived from `{a: PolicyCertified, b: uncertified}`
  read whole is stamped `PolicyCertified`. A later single-location access then
  releases it, so no gate fix reaches it. The meet wants the per-location
  resolution the input witnesses use (§8.9.3: "MUST NOT attach unioned input
  integrity").
- **`carriedStampLabel` keeps an ancestor stamp's hereditary atoms** after
  another writer writes beneath it; it withdraws only `TransformedBy`. At the
  display, `rebaseCfcLabelView` folds the ancestor's entry in beside a child's
  own, so a child cell inherits it too.
- **An `ExternalIngest` mark survives an overwrite** by a writer that is not
  an ingest. Nothing verifies its `valueDigest`.
- **A wildcard `requiredIntegrity` floor goes unchecked on the write side**
  (`verifyWriteFloor` skips `*` entries), and the read gate hands an empty
  read prefix to it, so a literal written into a floored list passes.
- **A link written at a payload field named `internal`** leaves the root
  stamp's `TransformedBy` in place.

## Plan

- [x] Write the regression tests: the composition case, with the document
      existing before the endorsed write; the across-reads cases at sink
      egress and display; and the honest shapes the join keeps.
- [x] Measure what a per-access join would refuse, at `observe` and
      `enforce` (the
      [measurement](../history/plans/cfc-release-gate-integrity-measurement-2026-10-08.md)).
- [x] Switch the three gates to exchange each observation, then join,
      unconditionally, with the value-intrinsic rule classifier copied from
      labs#8531.
- [ ] File the specs ruling: the looser variants above as proposals, the
      pseudocode that leaves out the observation step, and the within-location
      component join. Mark the deciding site with `SPEC-PENDING` naming it.
- [ ] Resolve a cell's stored label at the display location by location, once
      label views carry each entry's origin.
- [ ] Archive this plan.
