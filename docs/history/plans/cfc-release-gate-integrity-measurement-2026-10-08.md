---
status: historical
created: 2026-10-08
archived: 2026-10-08
reason: "Measurement of the per-access integrity join at the release gates, and of what it would refuse, taken before deciding where to enforce it."
---

# Release-gate integrity: what the per-access join changes

[Release gates without an integrity union](../../plans/cfc-release-gate-integrity.md)
moves three release gates from matching exchange-rule guards against integrity
pooled across an access to the per-access join of §5.3, §8.12.8 and §8.10.1.1.
Before choosing where to enforce it, its plan asks which honest releases ride
the union today. This record is that measurement, taken on 2026-10-08 against
the `cfcReleaseGateIntegrity` dial as first built, with what review of it found.

## How it was measured

The dial's `observe` rung records a `release-gate-integrity(observe)`
diagnostic wherever the pooled integrity admits a release the join would
refuse. For the measurement, an uncommitted hook appended each one to a file
with the test that produced it. A second run flipped the default to `enforce`
and recorded what failed.

| Suite | `observe`: divergences | `enforce`: failures |
| --- | --- | --- |
| Runner CFC tests: `test/cfc*.test.ts` and `test/cfc/` (276 files); at `enforce`, with `test/external-content-observation.test.ts` and `test/builtins/` too (302 files) | none outside the leak's own regression tests, once template evidence counted (below) | 0 |
| Pattern unit tests, `deno task integration pattern-tests` (212 files) | 0 | 0 |

The first `observe` run found one honest divergence besides the leak's own
regression tests: `cfc-structure-stamp-attribution.test.ts` releases an object a
function wrote field by field through the `*` structure templates' integrity,
which the join's first form did not count. Counting it removed the divergence.
Review found two more the suites did not reach at `observe`: an external
content observation entered the join without the value-bound evidence its
reads held (`external-content-observation.test.ts` fails at `enforce`), and the
`observe` check evaluated where a single-use grant cannot resolve, so it would
have reported every release made through one. Both were fixed before the
`enforce` run, and the two suites now run their gated cases at `enforce`.

A second review then found that `observe` was not free of effects (its extra
evaluations read and recorded grant documents the decision never consulted,
which changes the prepared digest), that it cost about 2.5 times the input
gate on a large document, that the floor under the join could pass where the
pooled floor failed, that a stamp vouched for atoms `carriedStampLabel` never
withdraws, and that a cell's stored label at the display cannot be joined over
its label view. After those were fixed the `enforce` run was taken again, with
the same result: no failure in either suite.
The pattern suite's zero is real (a hook in every `cf test` child recorded
other diagnostics), and it is also narrow: every release the suite makes reads
an endorsed value through a schema traversal, one shallow read per node, so no
gated access there consumes more than one confidential location.

## Honest releases the join refuses

None of these appear in either suite. Each was built by hand, by the author or
by an adversarial reviewer, and each is admitted under the union, refused by
the join at `enforce`, and admitted when each confidential location is
evaluated on its own integrity.

| Shape | Why the join refuses |
| --- | --- |
| A list the endorsed function appended one element to, read whole | the append stamps the element and the list's `length` apart |
| An object a compiled `lift` returned, read at a sink | the runtime stamps each field apart and the root not at all |
| Fields of one object written in one transaction, or in several, by the endorsed function, read whole | one stamp per field |
| A whole write followed by the same function rewriting one field (a diff-based rerun) | the rewritten field takes a stamp of its own |
| Two documents the endorsed function wrote, sent in one request | two stamps |
| The above at the display, through a cell's stored label | label views carry no origin, so the most specific entry wins whatever its component |

#8531's value-intrinsic carry rescues none of these where the gate reads the
endorsed value directly. It applies value-intrinsic rules at each location an
observation consumes and carries the result to what is derived, so it rescues a
value computed from the endorsed output, never a read of the output itself.
Copying the output through any transformation therefore launders past a strict
gate: for value-intrinsic rules the join adds friction, not protection, until
the gate evaluates them per location too.

A rule that also carries a boundary guard (a sink, a sink class) is not
value-intrinsic, is never carried, and is evaluated only on the access's joined
label. Under the join such a rule can never release an object a `lift`
computed.

## Integrity vouching across values outside the gates

Adversarial review confirmed each of these with a probe. None is changed by the
dial.

- The flow join's hereditary meet meets a per-read union across locations, so a
  value derived from a whole read of one certified and one uncertified field is
  stamped `PolicyCertified`; a later single-location access releases it.
- `carriedStampLabel` withdraws only `TransformedBy` from an ancestor stamp when
  another writer writes beneath it, so the stamp's hereditary atoms stay.
  `rebaseCfcLabelView` folds that ancestor entry beside a child cell's own.
- An `ExternalIngest` mark survives an overwrite by a writer that is not an
  ingest; its `valueDigest` is never checked.
- A wildcard `requiredIntegrity` floor goes unchecked on the write side, and the
  read gate hands an empty read prefix to it, so a literal written into a
  floored list passes.
- A link written at a payload field named `internal` leaves the root stamp's
  `TransformedBy` in place.
- The standard prompt-caveat profile's source binding does not keep a screened
  item's `CaveatScreened` off an unscreened item from the same source when the
  two are sent together.

## Questions for the specification

- What counts as one observation: §5.3 evaluates "for an observation, the
  effective label", and §8.10.1.1 joins the observations behind one
  materialized value. Evaluating value-intrinsic rules at each location before
  the join keeps every honest shape above and refuses every leak; joining first
  refuses both.
- Whether locations resolving one stamp are one input of the join. The dial
  counts them as one, which a child read of a stamped value needs.
- What §8.12.8's join across components keeps when a component states no
  integrity (drafted in ruling form, not filed).
