# Input requirements on an endorsed computation's arguments

## Why

A policy that releases a decision because its own code computed it guards the
release on that code's `TransformedBy`. A guard on the code's identity alone
admits whatever the code was fed: other code derives a stand-in from a secret,
feeds it to the endorsed code, and learns a bit of the secret per release
([input witnesses](../specs/cfc-transformed-by-input-witnesses.md)). The
summary-form witness closes that when the endorsed code's confidential inputs
share one provenance. It cannot help a computation that reads two confidential
inputs of different provenance, because the meet of two writers' stamps is
empty. An example is a threshold that the `policySecretHash` builtin wrote,
compared with a count that the policy's commit step wrote
([policy secrets](../specs/cfc-policy-secret.md)).

The specification's answer to probing a trusted computation does not add
anything to the output's label. It requires integrity on the computation's
inputs. In §10's boundary-probing example, the trusted `to_city()` component
"requires input integrity", and a shifted location computed by untrusted code
is refused. This plan applies that answer to the code a rule endorses:

- Each argument of the endorsed code declares the integrity its value must
  carry, using the existing `RequiresIntegrity` authoring type.
- The runtime checks every declaration against the reads made through that
  argument, and refuses the commit when one fails.
- The declarations are taken from the code the identity names, not from the
  graph that wires it.

Every output carrying the code's `TransformedBy` then came from inputs that met
its declarations, whatever the code was fed. A rule that guards on the identity
alone inherits that guarantee: existing rules gain it unchanged, and new rules
need no new evidence form.

## What the specification says

- §10, "Modification Attack (Boundary Probing)": the trusted component
  "requires input integrity", and inputs computed by untrusted code are
  refused.
- §3.8.4: a derived release condition needs trusted code that evaluates the
  evidenced values directly, with evidence "on the evaluated guard values".
- §8.10.3 defines input requirements per path of an invocation's input schema:
  - each is checked against every consumed read overlapping the path, public
    reads included;
  - a consumed read that resolves to no label fails the gate;
  - satisfaction is coherent, meaning one witness shared by all of those
    reads.
- §8.10.1.1: a value materialized from several primitive observations carries
  the join of their labels. §8.2.4 says what a dereference consumes.
- §8.7.2's `verifyEndorsedTransformation` honors a schema's endorsement claim
  only for the code that ran. Nothing yet says the same of an input schema.
- §4.6.1 models a node's inputs as a map of cells, with no input schema.
- specs#51 (pending) adds to §8.7.2 that `codeHash` alone "justifies only what
  holds of every output of that code whatever it was fed". It requires a
  release that rests on what the code consumed to guard on a witness-bearing
  form. Requirements the identity binds hold of every output of the code, so
  an identity guard rests on them only if that sentence allows it.

## Classification

Under [the correspondence procedure](../development/cfc-spec-correspondence.md):

1. **An in-graph node's input schema is a semantic gap.** The open questions
   are whether §8.10.3 reads a node's argument schema, and whether that schema
   is the one bound to the code identity rather than the one in the graph's
   data. This goes to a narrow ruling pull request, independent of specs#51.
   Under the proposed answer:
   - a read is consumed at the argument path of the value it materialized
     (§8.10.1.1, §8.2.4);
   - the schema is the one the code's own module declares.
2. **An identity guard resting on bound requirements needs specs#51's §8.7.2
   paragraph to allow it.** A comment on specs#51 proposes the wording.
3. **The check itself is a conforming implementation** of §8.10.3 once
   question 1 is ruled. Until then it lands under a `SPEC-PENDING` marker, at
   `observe`. Today `verifyInputRequirements` walks only the schemas of write
   targets, and the kernel manifest marks it `missing`. Nothing reads `ifc` on
   an argument schema. A `RequiresIntegrity` on a lift argument is therefore
   accepted and ignored, which errs toward admitting more than the
   specification allows.
4. **How reads are attributed to arguments is a host arrangement.** So is the
   handling of substituted defaults, dropped reads and assembled objects below.
   The conformance statement records each.

Evaluating guards per value at the release gate is a separate change and comes
first. It has its own plan.

## Options weighed

1. **Requirements on the endorsed code's arguments, bound to its identity
   (chosen).** This adds no atom, and nothing new enters any label. It also
   protects every rule that already guards on an identity.
2. **A per-argument record on the output,
   `TransformedBy{codeHash, inputAt: {path, witness}}`, named by the rule.**
   Rejected because it is a third `TransformedBy` form, stacked on specs#51's
   unruled second form. It also puts argument paths into labels and couples
   rule text to argument names. It protects only rules rewritten to name it. If
   auditing ever needs a record of what was verified, it can be raised then.
3. **One builtin that hashes and compares.** This moves each decision shape
   into the runtime.
4. **`IntegritySummary` with `covered-by`.** This records that each input
   carried one of the members, not which input carried which, so a swap passes.
5. **No change.**

## Design

### The schema bound to the identity

A javascript node's identity comes from the verified provenance of the function
that runs (`resolvePolicyFacingImplementationIdentity`). The schema its
argument is read through comes from the node's own module data
(`#readJavaScriptArgument` in `runner.ts`). So a graph built as data that names
an endorsed function's `$implRef` with an argument schema of its own runs under
the endorsed identity with no declaration to check.

`#resolveJavaScriptFunction` already resolves the registered builder artifact
by identity and symbol. When the function resolves to a verified artifact, the
node reads its argument through that artifact's own argument schema, and checks
the requirements that schema declares. A node whose module data carries a
different schema is read as the artifact declares. A node that resolves to no
verified artifact has no identity, so no identity guard matches its output.

### Attributing reads to an argument

Every read made through an argument counts at that argument's path. A read the
runtime cannot attribute counts at every declared path. Under-attribution is
the failure to rule out. A read made through `p` but missing from `p` would let
a stand-in bypass `p`'s requirement.

There are two mechanisms, and a spike chooses between them:

- **Tagging at read time.** The view's per-field descent (`childOrAbsent` in
  `schema-view.ts`) tags each read with its argument path. This is the
  simplest to reason about. Its costs:
  - the dereference memos key on the ambient read metadata, so a per-field
    tag makes them issue every read again, unless they key on the tag;
  - a `Cell`-typed argument has to carry its tag into reads the body makes
    later.
- **Regions reconstructed at commit preparation**, from the dereference traces
  rooted at each argument's slot in the binding document. This costs nothing
  on the read path. Its soundness rests on every hop being traced, including
  hops served from `resolveLinkTracingDereferences`'s memo and from
  `traverseDAG`'s `dagMemo`.

Whichever is chosen, its tests enumerate every memo path.

### What counts as consumed at an argument

These rules follow from §8.10.3, and the conformance statement records them:

- **Every location of every read counts, public ones included.** A read with
  no label contributes empty integrity, and so fails a requirement.
  `observationInputWitnesses` and `forEachFlowObservation` do not compute this
  set: the first skips public locations, and the second drops `cid:`
  documents and a document's own members.
- **A read the flow join drops counts as unlabeled** when it carries a value.
- **A value the schema substituted counts as unlabeled.** This covers a
  `default`, flagged in traversal by `substituteCoveredMissingTarget`.
  Otherwise an absent key under a stamped container would carry its writer's
  stamp to a value the schema chose.
- **A reference followed inside an argument earns its writer's stamp only
  where that writer supplied it**, as `followedReferenceWitnesses` resolves it.
  So an object assembled from references to two stamped records fails.
- **The binding document's slot holding the argument's reference is exempt**,
  as dereference plumbing (§8.2.4). Anything else the binding document holds
  at or below that slot is an unlabeled read, a missing argument included.

### The check

A failed requirement refuses the action's commit. A new dial, registered in
[`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md), rolls the
check out through `off`, `observe` and `enforce`. Some existing lifts read
cells whose types carry a write-side `RequiresIntegrity`, and their argument
schemas carry it with them. A run of the pattern suite at `observe` lists what
the check would refuse. That list is the first deliverable, and it matters
under any option. Refusal reasons keep one spelling across the dial's
positions.

### A rule over two inputs

The endorsed function declares what each argument must carry:

```ts
// Shown for illustration only.
export const enoughGlaze = lift(
  (args: {
    threshold: RequiresIntegrity<GlazeHash, [KeyedHashStamp]>;
    tally: RequiresIntegrity<GlazeTally, [CommitStamp]>;
  }) => tallyOf(args.tally) >= thresholdOf(args.threshold),
);
```

The rule guards on the function's identity, as rules do today:

```ts
// Shown for illustration only.
export const releaseGlaze = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: [{ type: TRANSFORMED_BY, identity: ENOUGH_GLAZE }] },
  post: { dropClause: true },
});
```

### Builtins

A builtin's inputs take the same declarations. The case at hand is
`policySecretHash`, which hashes any input any code passes it, including a
value derived from the secret, and stamps the result as its own either way. A
`requiredIntegrity` on its input, naming the writer of the values a policy
hashes, refuses a hash of a derived value. An empty `maxConfidentiality`
ceiling would refuse honest hashes of confidential item ids. This is a labs#8557
follow-up.

## Parked: a per-item threshold

Requirements on arguments refuse a stand-in. They do not make a threshold
drawn from a policy key unprobe-able. Until the following hold, the release
keeps a fixed threshold:

- **Grounding the count.** Implementation identity is content-addressed, so a
  member can run their own instance of the commit step over submissions of
  their own, and earn its stamp on a count they chose. The count needs evidence
  minted where contributions enter, such as an ingest channel's, retained as a
  witness family.
- **The key's audience.** The key is plaintext to anyone who reads the space's
  storage, so a prober who can contribute needs the key kept in a space they do
  not read (specs#58).
- **Binding the two inputs to one item.** Instance-bound integrity
  (`scope.valueRef`, §4.5.1, §8.10.4) is the specification's tool for this.
- **An unchanged output** keeps an earlier run's stamp
  ([input witnesses](../specs/cfc-transformed-by-input-witnesses.md)).

## Plan

- [ ] **Per-value guard evaluation at the release gate**, under
      [its own plan](cfc-release-gate-integrity.md) and pull request. It comes
      first. The gates union integrity across everything an access consumes, so
      a document holding two outputs satisfies a guard that neither output
      satisfies alone. That bites every witness-guarded rule today.
- [ ] **Specs.**
  - A narrow ruling pull request on question 1 (classification item 1),
    independent of specs#51. Its Lean adds a `decide`-checked case: a
    stand-in at one argument fails the coherent check, while an identity guard
    holds of the honest run.
  - A comment on specs#51 proposing that §8.7.2 admit an identity guard over
    requirements the identity binds.
- [ ] **Spike.**
  - Choose the attribution mechanism.
  - Bind the argument schema to the resolved artifact.
  - Find out how trigger reads and handler state bindings attribute.
- [ ] **The check**, under a `SPEC-PENDING` marker at `observe`.
  - Unit tests, each refused except the first:
    - an honest pair passes;
    - a stand-in at either argument;
    - a literal in the wiring;
    - a substituted default;
    - an argument assembled in the wiring;
    - an argument assembled in a document of references;
    - a graph built as data that carries a weaker schema;
    - a `Cell`-typed argument;
    - two arguments wired to one document;
    - a read served from each memo.
  - Run the pattern suite at `observe` and list what the check would refuse.
- [ ] **After the ruling.**
  - Move to `enforce` and remove the marker.
  - Note in the kernel manifest that `verifyInputRequirements` also walks
    argument schemas.
  - Update the [conformance statement](../specs/cfc-conformance-statement.md).
- [ ] **Builtin input requirements** for `policySecretHash`, with labs#8557.
- [ ] **Documents.**
  - Update [input witnesses](../specs/cfc-transformed-by-input-witnesses.md)
    and [policy secrets](../specs/cfc-policy-secret.md) ("A second
    confidential input").
  - Archive this plan.
