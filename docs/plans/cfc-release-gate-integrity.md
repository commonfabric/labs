# Release gates without an integrity union

## Why

An exchange rule releases a clause when the integrity it requires is present,
and that integrity has to describe the value the clause came from. Pooled
across everything an access consumed, one value's evidence releases another
value's clause: a document holding an endorsed output beside a value other code
wrote releases both. The write input gate, sink egress and the display's read
fit now evaluate each observation, then the join ("How the gates evaluate").
What remains is a specification ruling on the join within one location, and
the display's fit of a cell's stored label, which still pools.
[Input requirements on a node's inputs](cfc-node-input-requirements.md) depends
on the gates holding.

## What the specification says

- **§5.3:** each access evaluates every applicable rule to fixpoint over the
  label that access consumes, which for an observation is §8.12.8's effective
  label.
- **§8.12.8:** the effective label for an observation joins the applicable
  components, and integrity is never unioned across them: where one integrity
  set is needed, §3.1.6.2's class-aware join applies.
- **§8.10.1.1:** a value materialized from several primitive observations
  carries the join of their labels.
- **§3.1.6.2:** the join keeps the hereditary atoms present in every input.
  Value-bound atoms, `TransformedBy` among them (§15.4), drop.
- **§5.3, on value-intrinsic rules:** a rule that only claims bound to the
  current value can satisfy runs where that value is observed, and whatever
  is derived from the observation keeps the confidentiality the rule left.
  This is how evidence that a later join drops still releases what it vouched
  for.

## What still pools

- A cell's stored label at the display (`cellLabelRefusal`) is fitted on the
  integrity at its root, every entry's clauses included. A label view carries
  no origin and folds an ancestor's entry in beside a narrower cell's own, so
  it cannot be resolved location by location until views carry origins.
- Within one location, `labelForEntriesAtPath` unions integrity across
  components. The declared component carries integrity where a write's
  schema mints it (`addIntegrity`) or carries it (`exactCopyOf`, a
  projection), beside the derived and minted components' stamps. The
  question is what §8.12.8's join means when a component makes no integrity
  claim. Read literally, the join drops every per-value claim wherever a
  policy is declared, and the formal model behind §8.12.8 gives every path a
  declared component, so there it drops them everywhere and no
  integrity-guarded rule fires on a stored value. Against that reading this
  runtime over-claims integrity. That needs a ruling before anything changes.

## Classification

Removing the union is a **conforming implementation**. §5.3 has every label
that is consumed exchanged where it is consumed, each kind of rule's result
carried forward as that kind allows, and a value-intrinsic rule evaluated
where the value is observed. §4.6.3 makes a whole read a traversal over
primitive observations, and §8.10.1.1 joins their labels. The ceilings follow
each step and store nothing new. They depart from it in one direction, as the
pooled code did: an observation that consumed no label (a document with no
CFC metadata, or a location no entry labels) never enters the join, so a
hereditary atom every labeled location carries survives a join §3.1.6.2 would
empty. That over-claims integrity, and the conformance statement records it.

The `requiredIntegrity` floor is conforming as well. §8.10.3 checks an input
requirement on what the consumed observations' labels say, and §8.8's summary
of the annotation makes an object path's requirement coherent across its
consumed descendants: one witness, by key, for each required pattern. A whole
read is a traversal over primitive observations (§4.6.3), so each location a
gated read consumed is one of those labels. §3.1.6.2's class-aware join governs the label
of a derived output, not an input check. The write side's own floor,
§8.12.4.1, checks each write against the declared patterns.

The join within one location (above) is the one question the specification
leaves open, and it goes to a ruling.

## How the gates evaluate

At the write input gate, at sink egress, and for the reads behind a rendered
value:

1. The access is resolved into the locations it consumed: each read's own
   path and, for a recursive read, the path of every entry beneath it, each
   resolved over the entries that resolve there, as the input witnesses
   resolve them. A link probe observes the slot it probes, and two
   observations of one location that consumed the same clauses, integrity
   and evidence are one.
2. At each location, the value-intrinsic rules (`isValueIntrinsicExchangeRule`)
   run over that location's own clauses, matched against the integrity of the
   entries there that bind the current value: flow stamps and the writer's
   own stamps, not existence stamps, declared policy, link copies, or ingest
   marks. A location with no such evidence keeps its clauses as read. An
   exact copy's carried integrity is in the declared component, which no
   later write withdraws, so a value-intrinsic rule does not see it either.
3. The results are joined. A clause no location resolved stays as it was
   read. The integrity is §3.1.6.2's class-aware join of every location:
   hereditary atoms every location carries, and anything else only where the
   access observed one location.
4. The other rules then run over the joined label, with the gate's boundary
   context, and the ceiling is fitted.

So a rule that is not value-intrinsic and guards on a value-bound or
provenance atom never fires on an access that consumed two or more locations,
since the join keeps only hereditary atoms. The standard profile's influence
discharges, which guard on `DisclosureRendered` and `DisclosureAcknowledged`,
are such rules. A value-intrinsic rule runs only at observation, so no rule
the join stage fires can enable one.

The `requiredIntegrity` floor needs one witness key shared by every location
each gated read consumed and by the read's own label. A cell's stored label at
the display is still fitted on its root's integrity: a label view carries no
origin, so it cannot be resolved location by location yet.

## Related leaks the gates do not close

Adversarial review found integrity vouching across values outside the three
gates. Each is a separate change; none is fixed here.

- **The flow join's hereditary meet** meets each observation's union across
  locations, so a value derived from `{a: PolicyCertified, b: uncertified}`
  read whole is stamped `PolicyCertified`. A later single-location access then
  releases it, so no gate fix reaches it. The meet wants the per-location
  resolution the input witnesses use, since §8.9.3 forbids attaching input
  integrity unioned across inputs.
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
- **A schema's `addIntegrity` at a container mints at every position a write
  landed inside**, the container's own included, so its stamp resolves as
  current-value evidence at a sibling another writer wrote.

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
- [ ] File the specs ruling on the within-location component join.
- [ ] Resolve a cell's stored label at the display location by location, once
      label views carry each entry's origin.
- [ ] Archive this plan.
