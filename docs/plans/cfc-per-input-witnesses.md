# Per-input witnesses for an endorsed computation

## Why

A policy that releases a decision because its own code computed it guards the
release on that code's `TransformedBy`. A guard on the code's identity alone
admits whatever the code was fed: other code derives a stand-in from a secret,
feeds it to the endorsed code, and learns a bit of the secret per release
([input witnesses](../specs/cfc-transformed-by-input-witnesses.md)). The input
witness closes that when the endorsed code's confidential inputs share one
provenance. A rule requires `TransformedBy{identity, inputWitness: W}`, which
the runtime mints only when every confidential input the transaction read
carried `W`.

A computation that reads two confidential inputs of different provenance gets
no such witness, because the meet of two writers' stamps is empty. The case
that needs one is a release that fires once enough people contributed an item,
at a threshold drawn per item from a policy key
([policy secrets](../specs/cfc-policy-secret.md), labs#8557). The threshold is
a keyed hash that the `policySecretHash` builtin wrote. The count is a
confidential value that the policy's own commit step wrote. A rule can guard
only on the comparing function's identity. A stand-in that selects the outcome
by one bit of the hash therefore passes, and the release keeps a fixed, probe-able
threshold until a rule can require both provenances.

This plan scopes that change. A lift's argument declares, per field, the
integrity its value must carry, using the existing `RequiresIntegrity`
authoring type. The runtime checks each declaration against the reads made
through that field and records each verified declaration on the output, so the
rule names one record per argument.

## What the specification says

- §8.7.1 and §15.4 register a per-input form of `TransformedBy`,
  `inputs: Array<{ ref, witnesses? }>`. A rule cannot read it. §4.4.5's
  patterns match an array elementwise at equal length, with no quantifier and
  no selector. An entry also names its input by a value reference, which no
  static rule can name.
- specs#51 (pending) registers the summary form this runtime mints,
  `TransformedBy{codeHash, inputWitness: W}`, read as "every confidential input
  carried `W`". It also adds to §8.7.2 that a release justified by what an
  endorsed transformer consumed guards on a witness-bearing form, not on
  `codeHash` alone. When two inputs have different provenances, no summary
  witness exists, so under that text such a release has no guard that
  conforms.
- §8.10.3 defines input requirements per path of an invocation's input schema.
  Each is checked against every consumed read that overlaps its path, and
  satisfaction is coherent: one witness shared by all of those reads. Its last
  bullet contemplates recording a successful verification in
  `TransformedBy`'s witnesses, with the concrete atoms matched, and names only
  the per-input form as the place to record it.
- §3.8.4 lets trusted code evaluate a derived release condition directly over
  evidenced values, and requires the evidence "on the evaluated guard values".
  A comparison of a threshold with a count evaluates two such values.
- §4.6.1 applies the default transition to `lift()` and `computed()` with the
  node's code as the handler, so a lift's argument schema is the input schema
  §8.10.3 reads. §18.6.1 likewise makes a reactive transaction label-relevant
  when a schema with `ifc` governs a consumed input.
- specs#58 lists per-input requirements on lift arguments as a runtime
  follow-up of policy keys.

## Classification

Under [the correspondence procedure](../development/cfc-spec-correspondence.md)
the change has three parts, each classified on its own:

1. **Checking a lift argument's `requiredIntegrity` against the reads made
   through that argument is a conforming implementation** of §8.10.3, read
   with §4.6.1. Today `verifyInputRequirements` walks only the schemas of
   write targets, which is why the kernel manifest marks §8.10.3's
   `verifyInputRequirements` `missing`. Nothing reads `ifc` on an argument
   schema. A `RequiresIntegrity` on a lift argument is accepted and ignored.
2. **Attributing a read to the argument it was made through is a host
   arrangement.** §8.10.1.1 and §8.2.4 say what a materialized input consumes,
   and §18 leaves the read bookkeeping to the profile.
3. **Recording a verified requirement in a form a rule reads is a semantic
   gap.** No registered form names the input it is about. This part goes to a
   specs ruling pull request first, stacked on specs#51.

## Options weighed

1. **Record the verified requirement as
   `TransformedBy{codeHash, input: p, inputWitness: m}` (proposed).** `p` is
   the schema path that declares the requirement. `m` is a concrete atom that
   matches it and that every consumed read overlapping `p` carried. The rule
   names one record per argument.
2. **Let a guard on the identity rest on the code's declared requirements.**
   This needs no new atom. It is rejected because the guard would then mean
   something its label does not show. It would also hold only where a runtime
   binds the argument schema to the code identity, and this runtime does not:
   - A javascript node's identity comes from the verified provenance of the
     function that runs (`resolvePolicyFacingImplementationIdentity`).
   - The schema its argument is read through comes from the node's own module
     data (`#readJavaScriptArgument` in `runner.ts`).
   - So a graph built as data that names the endorsed function's `$implRef`
     with an argument schema of its own runs the endorsed code under the
     endorsed identity, with no declaration to check.
3. **A selector or quantifier over the per-input form in §4.4.5.** Rejected
   for the reasons specs#51 gives: it extends every matcher, and the per-input
   form persists input references.
4. **`IntegritySummary` with `covered-by` over both provenances.** It says
   that every input carried one of the members, not which input carried
   which. A swap therefore passes: a value the commit step wrote fed in the
   threshold's place, and a hash fed in the count's.
5. **No change.** The threshold stays fixed.

Option 1 holds against option 2's forged graph. A graph that drops the
declaration also drops the record, and a rule that requires the record
refuses.

## How it works here

### Attributing a read to an argument

A javascript node reads its argument from a `data:` binding document whose
fields hold links to the cells wired to it (`#bindNodeIO`). The argument is
materialized lazily, as the body touches each field. No read records which
field it was made through. Every read through a field, though, is reached from
a dereference trace whose source is that field's slot in the binding document
(`dereferenceTraces`). For a `Cell`-typed field, it is reached from a link
probe at that slot.

Attribution runs after the action, at commit preparation, and only when the
argument schema declares a requirement:

- A declared path's region is every location reachable from its slot in the
  binding document, by trace or by probed link, followed transitively.
- A read inside a region counts toward that region's path, and toward every
  declared path whose region also holds it.
- A read inside no region counts toward every declared path. Reads that §18.6.2
  excludes (verifier-internal, write-destination, result plumbing) are not
  consumed and count toward none.

Attribution can therefore only add reads to a path, and an added read can only
withhold a verification. Nothing is recorded on the read path. The dereference
memos are left alone too: they key on the ambient read metadata, so a per-field
tag would make them issue every read again.

Within the binding document, the slot at a declared path holds the pointer of
a dereference, which the dereference accounts for (§8.2.4). Anything else the
binding document holds at or below that slot is a consumed read of a document
that carries no label, and so fails the requirement. This refuses an argument
assembled in the wiring, such as an object whose fields link to parts of two
different records, each stamped by the right writer.

### The check

Commit preparation checks each `requiredIntegrity` that the argument schema
declares (`cfcSchemaEntries`) against the reads attributed to its path:

- The predicate is the shared one, `cfcIntegritySatisfiesFloorCoherently`,
  applied to each read's per-location witnesses (`observationInputWitnesses`).
  A read whose value two writers wrote therefore vouches for neither.
- Every consumed read counts, public ones included, as §8.10.3 has it.
- A declared path with no consumed read verifies nothing.
- A failed check refuses the action's commit.

The declaration comes from the node's data, so a graph built as data can omit
it, and the check is then skipped. The check guards the honest graph and tells
its author what went wrong. The record is what a rule relies on.

Some existing lifts read cells whose types carry a write-side
`RequiresIntegrity`, and their argument schemas carry it with them. A new dial
rolls the check out through `off`, `observe` and `enforce`. It starts at
`observe`, to measure which existing lifts it would refuse.

### The record

When the check at `p` passes, the transformation also mints records beside its
other `TransformedBy` atoms: one `TransformedBy{identity, input: p,
inputWitness: m}` for each concrete atom `m` that matched a pattern of the
requirement and that every attributed read carried.

- `p` is the schema path as declared, a JSON Pointer into the argument. It is
  never a path through data, so the record carries no read path.
- Only declared paths are recorded. A transformation whose argument declares
  nothing stores exactly what it stores today.
- `INPUT_WITNESS_MAX_DEPTH` bounds the nesting, as it does for the summary
  form.

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
        input: "/threshold",
        inputWitness: { type: TRANSFORMED_BY, identity: KEYED_HASH },
      },
      {
        type: TRANSFORMED_BY,
        identity: ENOUGH_GLAZE,
        input: "/tally",
        inputWitness: { type: TRANSFORMED_BY, identity: COMMIT_GLAZE },
      },
    ],
  },
  post: { dropClause: true },
});
```

## What this does not cover

- **Binding two inputs to one item.** A record says who wrote each input. It
  does not say that the inputs belong together. A member who can run the
  endorsed function can feed it one item's threshold and another item's count,
  both honestly written. By moving the second count with accounts of their
  own, they learn the first threshold. To refuse that, the endorsed function
  has to check that both inputs name the same item. Each input then has to
  carry its item inside the location its writer stamped:
  - a keyed hash that names its input, which changes the result shape of
    labs#8557's builtin;
  - a count record that the commit step writes whole.
- **Arguments the rule does not pin.** The rule has to pin every argument the
  endorsed function reads that could carry a secret. Nothing records that
  there were no other inputs.
- **The bottom of a chain.** As with the summary form, the innermost step a
  rule pins is trusted on its own inputs. To guard further down, nest the
  record one more level, or declare requirements on that step's arguments as
  well.
- **An unchanged output, composition at the release gate, and storage below
  the runtime.** These stand as
  [input witnesses](../specs/cfc-transformed-by-input-witnesses.md) and
  [policy secrets](../specs/cfc-policy-secret.md) describe them.

## Plan

- [ ] **Stage 0: the specs ruling.** A ruling-form pull request stacked on
      specs#51, which registers the record form. It carries:
  - **Prose.** The §15.4 row, the §8.7.1 type, and §8.10.3's recording bullet,
    which gains a pseudocode function that mints the record. specs#51's §8.7.2
    paragraph gains the case of a release over inputs with different
    provenances. §4.6.1 gains a sentence saying that a node's input schema is
    its argument schema, and that a value materialized through a reference
    held at `p` is consumed at `p`.
  - **Lean.**
    - The record atom.
    - The record minted from the boundary model's input-requirement check.
    - Proofs that a record implies every consumed read at `p` carried `m`,
      that no consumed read means no record, and that the guard is sound.
    - `decide`-checked cases:
      - an identity guard admits the stand-in;
      - the summary guard refuses the honest two-provenance computation;
      - `covered-by` admits the swap;
      - the record guards admit the honest computation and refuse both the
        stand-in and the swap.
- [ ] **Stage 1: attribution and the check.** This is a conforming
      implementation that refuses more and persists nothing new, so it can land
      before the ruling.
  - Attribute reads to argument regions at commit preparation.
  - Check argument-schema requirements behind a new dial, starting at
    `observe`, registered in
    [`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md).
  - Find out how trigger reads and handler state bindings fall into regions.
  - Unit tests:
    - an honest pair passes;
    - a stand-in at either argument is refused;
    - a literal in the wiring is refused;
    - an argument assembled from two records is refused;
    - a `Cell`-typed argument is attributed;
    - two arguments wired to one document are each checked.
  - Run the pattern suite in `observe` and list what the check would refuse.
- [ ] **Stage 2: the record.** This stores something new, so it lands after
      the ruling merges, at the new pin.
  - Mint the records in `deriveFlowJoinImpl` beside `mintTransformedBy`'s
    atoms.
  - Add a kernel manifest row for the new function.
  - Compiled-pattern tests:
    - a two-record rule releases the honest computation;
    - it refuses a stand-in at either argument;
    - it refuses a graph built as data without the declaration;
    - it refuses an argument assembled in the wiring.
- [ ] **Stage 3: a witnessed per-item release.** This follows labs#8557, which
      waits on specs#58.
  - Bind each input to its item (see above).
  - Tests: the honest release, a stand-in, and another item's count are each
    refused or released as the rule intends.
- [ ] **Stage 4: documents.**
  - Add the record to
    [input witnesses](../specs/cfc-transformed-by-input-witnesses.md).
  - Close "A second confidential input" in
    [policy secrets](../specs/cfc-policy-secret.md).
  - State §8.10.3 for argument schemas and the record form in the
    [conformance statement](../specs/cfc-conformance-statement.md).
  - Archive this plan.

## Open questions

1. Should the record be stacked on specs#51 as its own ruling, or folded into
   specs#51 while that is still open?
2. Should the record quantify over every consumed read at `p`, as §8.10.3's
   check does and as proposed? The alternative is only the confidential reads,
   as specs#51's summary does, which lets a caller-chosen public value sit
   inside a pinned argument.
3. Should the runtime also take a node's argument schema from the artifact its
   `$implRef` resolves to, rather than from the node's data? That host change
   would make the check itself unforgeable. The record does not need it.
