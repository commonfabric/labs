# Per-input records for an endorsed computation

## Why

A policy that releases a decision because its own code computed it guards the
release on that code's `TransformedBy`. A guard on the code's identity alone
admits whatever the code was fed: other code derives a stand-in from a secret,
feeds it to the endorsed code, and learns a bit of the secret per release
([input witnesses](../specs/cfc-transformed-by-input-witnesses.md)). The
summary-form witness closes that when the endorsed code's confidential inputs
share one provenance. A rule requires `TransformedBy{identity, inputWitness:
W}`, which the runtime mints only when every confidential input the
transaction read carried `W`.

A computation that reads two confidential inputs of different provenance gets
no such witness, because the meet of two writers' stamps is empty. The case
that needs one is a release that fires once enough people contributed an item,
at a threshold drawn per item from a policy key
([policy secrets](../specs/cfc-policy-secret.md), labs#8557):

- The threshold is a keyed hash that the `policySecretHash` builtin wrote.
- The count is a confidential value that the policy's own commit step wrote.

The rule can therefore guard only on the comparing function's identity, so a
stand-in that selects the outcome by one bit of the hash passes.

This plan scopes how a rule can require a different provenance for each
argument of the code it endorses:

- A lift's argument declares, per field, the integrity its value must carry,
  using the existing `RequiresIntegrity` authoring type.
- The runtime checks each declaration against the reads made through that
  field.
- The runtime records each verified declaration on the output, in a form the
  rule names.

This is necessary for an unprobe-able threshold, and not sufficient. "What a
robust per-item threshold still needs" lists the rest.

## What the specification says

- §8.7.1 and §15.4 register a per-input form of `TransformedBy`,
  `inputs: Array<{ ref, witnesses? }>`. A rule cannot use it to tell inputs
  apart, for two reasons:
  - Entries are keyed by a value reference (§8.9.3 mints
    `refer(getValueAtPath(handler.input, p))`), not by argument, so swapping
    two inputs yields the same entries.
  - §4.4.5's patterns match `witnesses` elementwise at equal length.
- specs#51 (pending) registers the summary form this runtime mints. It adds to
  §8.7.2 that a release justified by what an endorsed transformer consumed
  guards on a witness-bearing form, not on `codeHash` alone. With two
  provenances, no summary-form guard exists.
- §8.10.3 defines input requirements per path of an invocation's input schema:
  - Each requirement is checked against every consumed read that overlaps its
    path. Coherent satisfaction means one witness shared by all of those
    reads.
  - Its last bullet contemplates recording a successful verification in
    downstream witness-bearing integrity, "for example
    `TransformedBy.inputs[*].witnesses`", with the concrete atoms matched.
  - It registers no form a rule can match per input.
- §3.8.4 lets trusted code evaluate a derived release condition directly over
  evidenced values, with evidence "on the evaluated guard values". A
  comparison of a threshold with a count evaluates two such values.
- §18.6.1: "The normative chapters assume boundary verification on every
  commit". A transaction is label-relevant when a schema with `ifc` governs a
  consumed input.
- §8.2.6 maps a write-side floor at a reference's slot onto the linked contents:
  "If a floor at `A.selected/x` governs linked contents, map it to
  `B.item/x`". It has no consume-side counterpart.

## Classification

Under [the correspondence procedure](../development/cfc-spec-correspondence.md)
the change has two semantic gaps and one conforming part:

1. **Input coordinates for an in-graph node are a semantic gap.** Two things
   are unanswered:
   - whether a lift's argument schema is the input schema §8.10.3 reads;
   - how a read of a wired document maps to an argument path, which is the
     consume-side counterpart of §8.2.6.

   §8.10.1.1 roots read paths at the payload of the document read, so under
   the pseudocode as written, a root read of any wired document overlaps every
   declared path. This becomes ruling question 1. The check that depends on it
   lands ahead of the ruling under a `SPEC-PENDING` marker, at `observe`.
2. **Recording a verified requirement in a form a rule reads is a semantic
   gap.** This becomes ruling question 2, stacked on specs#51, since it needs
   that ruling's two forms and its §8.7.2 paragraph.
3. **Checking the declared requirements, once question 1 is ruled, is a
   conforming implementation** of §8.10.3. Today `verifyInputRequirements`
   walks only the schemas of write targets, and the kernel manifest marks it
   `missing` for that reason. Nothing reads `ifc` on an argument schema, so a
   `RequiresIntegrity` on a lift argument is accepted and ignored. That errs
   toward admitting: a declared requirement does not hold.

## Options the ruling offers

1. **A per-argument record (proposed).** Beside its other `TransformedBy`
   atoms, the computation mints one record per verified requirement and
   matched atom: `TransformedBy{codeHash, inputAt: {path: p, witness: m}}`.
   `p` is the schema path declaring the requirement. `m` is a concrete atom
   that matches it and that every consumed read at `p` carried. The record
   needs a field of its own. Atom patterns match records by subset
   (`atom-pattern.ts`: fields a pattern does not name are unconstrained), so a
   record spelled with `inputWitness` would satisfy every summary-form guard
   while speaking for one argument only.
2. **A guard on the identity rests on the computation's declared
   requirements.** This needs no new atom, and §3.8.4's "trusted code evaluate
   the evidenced value directly" reads naturally this way. It changes
   specs#51's sub-choice (iii), and it holds only where the runtime binds the
   argument schema to the code identity. This runtime does not bind them:
   - A javascript node's identity comes from the verified provenance of the
     function that runs (`resolvePolicyFacingImplementationIdentity`).
   - The schema its argument is read through comes from the node's own module
     data (`#readJavaScriptArgument` in `runner.ts`).
   - So a graph built as data that names the endorsed function's `$implRef`
     with an argument schema of its own runs under the endorsed identity with
     no declaration to check.

   Under this option, labs takes the argument schema from the artifact the
   `$implRef` resolves to. The owner decides between options 1 and 2. Option 1
   holds whether or not the schema is bound, because a graph that drops the
   declaration also drops the record.
3. **One builtin that hashes and compares.** The count would then be the only
   confidential input besides the key, so the summary form would serve, if the
   key's read stayed out of the witness meet, which it does not today. It also
   moves each decision shape into the runtime.
4. **`IntegritySummary` with `covered-by` over both provenances.** This says
   that every input carried one of the members, not which input carried which,
   so a swap passes.
5. **No change.** The threshold stays fixed.

## How it would work here

The atoms here use this runtime's spelling of `codeHash`, `identity`, which is
specs#43's question.

### Attributing a read to an argument

A javascript node reads its argument from a `data:` binding document whose
fields hold links to the cells wired to it (`#bindNodeIO`). The argument is
materialized lazily, as the body touches each field. No read records which
field it was made through. Every read through a field, though, is reached from
a dereference trace whose source is that field's slot in the binding document
(`dereferenceTraces`), or from a probed link there for a `Cell`-typed field.
Attribution runs at commit preparation, and only when the argument schema
declares a requirement:

- **A region per declared path.** A declared path's region is every location
  reachable from its slot in the binding document, by trace or probed link,
  followed transitively. When the declared path lies below a linked slot, the
  region is the part of the target beneath the remaining path.
- **Reads inside regions.** A read inside a region counts toward that region's
  path, and toward every declared path whose region also holds it.
- **Reads inside no region.** Such a read counts toward every declared path.
  Reads of the binding document above its slots observe only which fields are
  wired, and are not attributed.
- **Completeness is what soundness rests on.** A read made through `p`'s slot
  lies in `p`'s region only if every hop of it was traced, including hops served
  from a memo:
  - `resolveLinkTracingDereferences` replays its traces on a memo hit.
  - `traverseDAG`'s `dagMemo` is the other memo to cover.

  An attacker who declares extra paths cannot then remove a read from `p`.

Nothing is recorded on the read path. The dereference memos are left alone:
they key on the ambient read metadata, and a per-field tag would make them
issue every read again.

### What counts as a consumed read at `p`

Every read in `p`'s region counts, public ones included, as §8.10.3 has it. A
read with no label contributes an empty integrity and so fails the
requirement. The flow join's helpers do not compute this.
`observationInputWitnesses` returns nothing for a read with no confidential
location and skips public locations. `forEachFlowObservation` drops `cid:`
documents and a document's own members. The check resolves every location of
every read itself, under these rules:

- **A read the flow join drops** counts as unlabeled when it carries a value.
- **A value the schema substituted** (a `default`, flagged in traversal by
  `substituteCoveredMissingTarget`) counts as unlabeled. Otherwise an absent
  key under a stamped container would carry its writer's stamp to a value the
  schema chose.
- **Every reference followed inside a region** is resolved as
  `followedReferenceWitnesses` resolves it. A reference earns its writer's
  stamp only where that writer supplied it, so an object assembled from
  references to two stamped records fails.
- **The binding document's slot at exactly `p`** is the only pointer exempt as
  dereference plumbing (§8.2.4). Anything else the binding document holds at or
  below `p` is an unlabeled read.
- **A declared path with no consumed read** verifies nothing.

### The check

A failed requirement refuses the action's commit. A new dial, registered in
[`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md), rolls the
check out through `off`, `observe` and `enforce`. Some existing lifts read
cells whose types carry a write-side `RequiresIntegrity`, and their argument
schemas carry it with them. `observe` measures what the check would refuse
before it refuses anything.

The declaration comes from the node's data, so a graph built as data can omit
it and skip the check. The check protects the honest graph. The record is what
a rule relies on.

### The record

When the check at `p` passes, the transformation mints
`TransformedBy{identity, inputAt: {path: p, witness: m}}` for each concrete atom
`m` that matched a pattern of the requirement and that every consumed read at
`p` carried.

- `p` is the schema path as declared, never a path through data, so the record
  carries no read path.
- Only declared paths are recorded. A transformation whose argument declares
  nothing stores exactly what it stores today.
- A record is a `TransformedBy` atom, so a later step that reads the output
  retains it as a summary witness.
- `INPUT_WITNESS_MAX_DEPTH` counts the nesting through `inputAt.witness` as it
  counts the nesting through `inputWitness`.

### A rule over two inputs

The comparing function declares what each argument must carry:

```ts
// Shown for illustration only.
export const enoughGlaze = lift(
  (args: {
    threshold: RequiresIntegrity<GlazeHash, [KeyedHashStamp]>;
    tally: RequiresIntegrity<GlazeTally, [CommitStamp]>;
  }) => tallyOf(args.tally) >= thresholdOf(args.threshold),
);
```

The rule names one record per argument, and needs both:

```ts
// Shown for illustration only.
export const releaseGlaze = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: {
    integrity: [
      {
        type: TRANSFORMED_BY,
        identity: ENOUGH_GLAZE,
        inputAt: { path: "/threshold", witness: KEYED_HASH_STAMP },
      },
      {
        type: TRANSFORMED_BY,
        identity: ENOUGH_GLAZE,
        inputAt: { path: "/tally", witness: COMMIT_STAMP },
      },
    ],
  },
  post: { dropClause: true },
});
```

## What a robust per-item threshold still needs

The record lets a rule require both provenances, which refuses a stand-in
derived from the hash. Each of the following still lets a member who runs code
in the space learn a threshold, and each is a change of its own:

1. **Guards evaluated per value.** The release gate unions integrity across
   everything one read consumes. A document holding two outputs therefore
   satisfies a two-record rule: one output that was fed an honest threshold,
   and one that was fed an honest tally. The fix is the one the
   [input witnesses](../specs/cfc-transformed-by-input-witnesses.md) document
   already names, evaluating guards per consumed entry. A writer policy on the
   endorsed output does not help when the member builds the graph and so
   chooses where the output goes.
2. **What the keyed hash was computed over.** `policySecretHash` hashes any
   input any code passes it, a value derived from the secret included, and the
   result carries the builtin's stamp either way. A rule that names the
   builtin as the threshold's witness accepts a hash of a secret-dependent
   choice. The builtin could refuse a confidential input, or the rule could
   pin one level deeper, to the provenance of what was hashed.
3. **Where the count came from.** Implementation identity is
   content-addressed, so a member can run their own instance of the commit step
   over submissions of their own and earn its stamp on a count they chose. The
   count needs grounding where contributions enter, such as evidence an ingest
   channel mints, retained as a witness family.
4. **Two inputs about one item.** A record says who wrote each input, not that
   the inputs belong together. Pairing one item's threshold with another item's
   count, both honestly written, reveals the first threshold. The endorsed
   function can refuse a pair that names two items only where each input
   carries its item inside the location its writer stamped. The region rules
   above refuse an argument assembled from parts. Instance-bound integrity
   (`scope.valueRef`, §4.5.1, §8.10.4) is the specification's own tool for
   this. The check means little until items 2 and 3 hold.
5. **An unchanged output, and storage below the runtime.** These stand as the
   input witnesses and policy secrets documents describe them.

## Plan

- [ ] **Stage 0: the specs ruling.** A ruling-form pull request stacked on
      specs#51, with two questions:
  - **Question 1, input coordinates for an in-graph node:**
    - a node's argument schema is its input schema;
    - a read made through a reference held at `p` is consumed at `p`;
    - the binding's own structure is not consumed.
  - **Question 2, the record:** with options 1–5 above, and option 1 applied.
  - **Lean:**
    - the record atom;
    - the record minted only from a passing input-requirement check in the
      boundary model;
    - proofs that a record implies every consumed read at `p` carried `m`, that
      no consumed read means no record, and that the guard is sound.
  - **`decide`-checked cases:**
    - an identity guard admits the stand-in;
    - the summary guard refuses the honest two-provenance computation;
    - `covered-by` admits a swap;
    - a summary guard refuses a record;
    - a substituted default yields no record;
    - the record guards admit the honest computation and refuse the stand-in.
  - **specs#58's `FUTURE-SPEC-WORK.md` entry** then points at this ruling
    rather than listing the work as a runtime task.
- [ ] **Stage 1: attribution and the check.** Lands under a `SPEC-PENDING`
      marker naming the ruling, at `observe`, and persists nothing new.
  - Regions, and consumed reads as above.
  - Find out how trigger reads and handler state bindings fall into regions.
  - Unit tests, each refused except the first:
    - an honest pair passes;
    - a stand-in at either argument;
    - a literal in the wiring;
    - a substituted default;
    - an argument assembled in the wiring;
    - an argument assembled in a document of references;
    - a `Cell`-typed argument;
    - two arguments wired to one document;
    - a read served from each memo.
  - Run the pattern suite at `observe` and list what the check would refuse.
- [ ] **Stage 2: the record.** This stores something new, so it lands after
      the ruling merges, at the new pin.
  - Mint the records in `deriveFlowJoinImpl` beside `mintTransformedBy`'s
    atoms.
  - Add a kernel manifest row for the new function.
  - Remove the marker.
  - Compiled-pattern tests:
    - a two-record rule releases the honest computation;
    - it refuses a stand-in at either argument;
    - it refuses a graph built as data without the declaration;
    - a summary-form rule does not match a record.
- [ ] **Stage 3: guards evaluated per value** (item 1 above), classified on its
      own.
- [ ] **Stage 4: the per-item threshold.** Items 2–4 above, designed with
      labs#8557, followed by the witnessed release and its tests.
- [ ] **Stage 5: documents.**
  - Add the record to
    [input witnesses](../specs/cfc-transformed-by-input-witnesses.md).
  - Update "A second confidential input" in
    [policy secrets](../specs/cfc-policy-secret.md).
  - State §8.10.3 for argument schemas and the record form in the
    [conformance statement](../specs/cfc-conformance-statement.md).
  - Archive this plan.

## Open questions

1. Should the ruling present option 2 as the alternative? If it is chosen, the
   runtime has to take a node's argument schema from the artifact its
   `$implRef` resolves to.
2. Should per-value guard evaluation (Stage 3) wait for this plan, or go first?
   It narrows a gap that existing single-witness rules already have.
3. Should a per-item threshold wait for items 2–4? The record alone does not
   make the threshold unprobe-able for a member who runs code in the space.
