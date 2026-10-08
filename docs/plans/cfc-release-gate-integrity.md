# Release gates without an integrity union

## Why

An exchange rule releases a clause when the integrity it requires is present.
The release gates here assemble that integrity as a union. Whatever any
consumed value carries counts as evidence for every clause the access consumed.
So one value's evidence can release a clause that came from another value.

[Input witnesses](../specs/cfc-transformed-by-input-witnesses.md) records the
form of this exposure that sits within one read, under "Composition at the
release gate". A document that holds an endorsed output beside a value other
code wrote releases both.

The sink and display gates union across every read of the transaction too, not
only within one. Every rule guarded on a value-bound atom is exposed, and
[input requirements on arguments](cfc-argument-input-requirements.md) depends
on closing it.

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

## Where this runtime unions integrity

| Gate | What the rule's integrity pool is today |
| --- | --- |
| Write input gate (`verifyInputRequirements`) | per gated read, the union over the entries the read consumes (`labelForConsumedEntries`) |
| Sink egress (`verifySinkRequestCeilings`) | the union over every entry of every read in the transaction (`collectConsumedLabel`) |
| Display (`display-fit.ts`) | for reads, the union over the transaction's reads; for a cell's stored label, every entry's confidentiality fitted against the root's integrity |
| Custody seal (`releasedToSeal`) | one scalar location, so already per value |

Within one location, `labelForEntriesAtPath` also unions integrity across
components. The component that declares the store's policy carries none in
practice, so the union there equals the one component that carries any. The
question is what §8.12.8's join means when a component makes no integrity
claim. Read literally, the join would drop every per-value claim wherever a
policy is declared. That reading needs a ruling before anything changes.

The standard prompt-caveat profile rides the sink's union too. Its rules bind
a screening record to the caveat's source, which keeps one source's evidence
off another source's caveat, but two items from one source carry the same
caveat: sent together, the screened item's `CaveatScreened` discharges the
unscreened item's caveat.

## Classification

Removing the union across entries and across reads moves the gates toward
§5.3, §8.12.8 and §8.10.1.1, and refuses more while persisting nothing. The
join as built is not the literal one, though. Three of its rules are cases the
specification lacks: a `TransformedBy` one stamp supplies at several
locations survives, locations with no confidentiality stay out of the join,
and the floor counts each location as an observation. Each keeps more than the
literal join and less than the union. By the correspondence procedure that
makes the `enforce` rung a **semantic gap**: it waits on a ruling, and the
dial rests at `observe`, which decides as before.

Taken alone it would also refuse honest releases that depend on the union
today. One example is an endorsed output whose fields are read through one
aggregate read. The specification keeps those releases through §5.3's
value-intrinsic carry: the rule fires at the observation that consumed the
evidence, and the derived value carries the result. labs#8531 implements that
carry. It is a draft, and lands only with its owner's approval.

The join within one location is a **semantic gap** (see above), and stays as
it is until ruled.

## The per-access join as built

The `cfcReleaseGateIntegrity` dial (`off`, `observe`, `enforce`) chooses the
integrity each gate matches rule guards against. `access-integrity.ts` holds
the join; `prepare.ts` resolves what an access consumed into locations.

- **Locations.** A read's locations are its own path and, for a recursive
  read, the path of every label-map entry beneath it, each resolved over the
  entries that resolve there, as the input witnesses already resolve them.
  Existence stamps are not evidence. A `*` template's integrity counts at a
  gate, where the template's clause and its integrity are one stamp's claims,
  though it witnesses nothing for the input witnesses.
- **The join.** Over the access's confidential locations, a hereditary atom
  survives when every location carries it. Any other atom survives where only
  one location is observed (a link probe observes the slot it probes), and a
  `TransformedBy` also where one derived or structure stamp supplies it at
  every location. Locations resolving one such stamp are parts of the one
  value it labels: `carriedStampLabel` withdraws the stamp's `TransformedBy`
  once another writer writes at, above or below it, and withdraws nothing
  else, which is why no other atom gets the exception. Without it, any read
  spanning a stamped value's children would drop the stamp.
- **`requiredIntegrity` at the write input gate.** The floor needs a witness
  every labeled location of every gated read carries, which is §8.10.3's
  "shared witness key across all consumed observation labels", and the pooled
  witness as well, so the join refuses only more. A location that is
  provenance plumbing is exempt, as a read that is.
- **Sink egress and display.** The locations of every read behind the
  request, or behind the rendered value, are one access. A cell's stored
  label is fitted pooled at every rung: a label view carries no origin, folds
  an ancestor's entry in beside a narrower cell's own, and merges a linked
  target's view into the slot's, so a join over it would claim too much in
  one case and too little in another.
- **Other observations.** A label-metadata observation is a confidential
  location with no integrity. An external content observation carries the
  locations its reads consumed.
- **Under `observe`**, a release the union admits and the join would refuse
  is recorded as a `release-gate-integrity(observe)` diagnostic. The
  diagnostic also says whether evaluating each confidential location on its
  own integrity would admit it: per-location evaluation rescues the release
  that value-intrinsic exchange at observation would preserve, and does not
  rescue one value's evidence vouching for another. Its evaluations answer
  grant lookups from the decision's own, so `observe` reads, records and
  stages nothing the decision did not. At the display it computes the join
  only for a host that listens, and no shipped host does, so display
  divergences are unmeasured.

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

## Approach

1. **Observe.** Each gate computes, beside its current decision, the decision
   the per-access rule gives:
   - integrity is the class-aware join of the access's locations, or of its
     reads at a sink;
   - each location resolves as `entriesResolvingAtLocation` resolves it, with
     its components as today;
   - a location with no confidentiality has no clause to release.

   A diagnostic records each divergence. The pattern suite, run under that dial
   position, lists which honest releases the union carries today.
2. **Carry.** The releases the list names move to observation-time evaluation
   through labs#8531's carry.
3. **Enforce.** Enforce gate by gate, from the cleanest to the widest: the
   write input gate first, then display, then sink egress. At sink egress,
   grant consumption and fuel are spent per evaluation, which needs its own
   look at single-use grants.

## Plan

- [x] Write the regression tests:
  - the documented composition case, with the document existing before the
    endorsed write so that no root stamp masks it;
  - the across-reads cases at sink egress and display;
  - each asserts today's release, marked as the behavior to remove.
- [x] Add a dial (`off`, `observe`, `enforce`) in
      [`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md).
      Implement the observe arm at the three gates, and the enforce arm
      beside it. The dial rests at `observe`.
- [x] Run the pattern suite at `observe`, and list the divergences. The
      record is
      [the measurement](../history/plans/cfc-release-gate-integrity-measurement-2026-10-08.md):
      no divergence in the pattern suite or the runner's CFC tests at
      `observe`, and no failure at `enforce`, but honest shapes neither suite
      exercises (a pushed list, a `lift`'s object at a sink) are refused at
      `enforce` and admitted per location.
- [ ] Before any gate's `enforce` lands as more than an opt-in rung: file the
      ruling below, and mark the deciding sites (`accessIntegrity` and the
      floor's per-location witness in `verifyInputRequirements`) with
      `SPEC-PENDING` naming it, as the correspondence procedure requires of gap
      code.
- [ ] Decide with labs#8531's owner whether its carry lands first, or this
      lands first at `enforce` and accepts the refusals. The carry rescues a
      value derived from an endorsed output, never a direct read of it, so
      keeping those shapes at a gate means evaluating value-intrinsic rules
      per location there as well.
- [ ] Enforce gate by gate. Update
      [input witnesses](../specs/cfc-transformed-by-input-witnesses.md) and the
      [conformance statement](../specs/cfc-conformance-statement.md).
- [ ] File the specs ruling questions (drafted, not filed): what the join
      across components within one location keeps; what counts as one
      observation, and whether locations resolving one stamp are one input;
      whether a location with nothing to release enters the join, or, more
      narrowly, whether the join need span only the locations carrying the
      clause a rule rewrites, so an input whose clause fits the ceiling does
      not veto another's release.
- [ ] Archive this plan.
