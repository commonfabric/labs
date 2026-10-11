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
compared with a count that the policy's commit step wrote (the policy-secret
design in labs#8557).

The specification's answer to probing a trusted computation does not add
anything to the output's label. It requires integrity on the computation's
inputs. In §10's boundary-probing example, the trusted `to_city()` component
requires integrity on its input, and a shifted location computed by untrusted
code is refused. This plan applies that answer to the code a rule endorses:

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

- §10, the boundary-probing attack: the trusted component requires integrity
  on its input, and inputs computed by untrusted code are refused.
- §3.8.4: a derived release condition needs trusted code that evaluates the
  evidenced values directly, with the evidence on the guard values it
  evaluates.
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
- specs#51 (pending) adds to §8.7.2 that `codeHash` alone justifies only what
  holds of every output of the code, whatever it was fed. It requires a
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
   - the schema is the one the code's own module declares; the graph's may add
     requirements and cannot remove one.
2. **An identity guard resting on bound requirements needs specs#51's §8.7.2
   paragraph to allow it.** A comment on specs#51 proposes the wording.
3. **The check itself is a conforming implementation** of §8.9 ("Input
   contract checks … MUST be enforced before commit", for every node) and
   §8.10.3, so it runs at the strict default with no dial: it only refuses
   more. Only which schema's requirements apply is marked `SPEC-PENDING`
   (commonfabric/specs#62). It covers lifts, computed nodes and handlers
   (`cfc/node-input-requirements.ts`). Before it, `verifyInputRequirements`
   walked only the schemas of write targets (the kernel manifest still marks
   row 8.10.3 `missing` until the re-pin), so a `RequiresIntegrity` on a
   node's input was accepted and ignored.
4. **How reads are attributed to arguments is a host arrangement.** So is the
   handling of substituted defaults, dropped reads and assembled objects below.
   The conformance statement records each.

Evaluating guards per value at the release gate is a separate change and comes
first. It has its own plan.

## Options weighed

1. **Requirements on the endorsed code's arguments, bound to its identity
   (chosen).** This adds no atom, and nothing new enters any label. It also
   protects every rule that already guards on an identity, once the endorsed
   code declares what its arguments require; until it does, an identity guard
   is as exposed to a stand-in as it is today.
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

As landed, the check takes the requirements of the argument schema of the
artifact indexed under the identity the run is stamped with, together with the
requirements of the node's module data, so a graph built as data can add a
requirement and cannot remove one. A verified identity with no indexed artifact
is refused. The node still reads its argument through its module data's
schema; reading it through the artifact's is not done here. A node whose
function has no verified provenance has no identity, so no identity guard
matches its output.

### Attributing reads to an argument

Every read made through an argument counts at that argument's path. A read the
runtime cannot attribute counts at every declared path. Under-attribution is
the failure to rule out. A read made through `p` but missing from `p` would let
a stand-in bypass `p`'s requirement.

The spike chose neither of the two mechanisms below (see the Plan): the check
follows the binding instead. They are kept for the record.

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
- **A path read and found absent is a `shape` observation** (§4.6.3) of the
  position it is absent from, labeled as that position is: absent from
  settings the owner wrote, it carries the owner's stamp; absent from a
  document no one stamped, it carries nothing. A `default` that a schema other
  than the code's (one a reference carries, or the graph's where it is not the
  code's) would supply there is a value written in the wiring and fails.
- **A reference supplies its target's integrity; its slot contributes
  confidentiality only** (§8.2.4, as the dereference join does). References
  on the way to a declared path and inside the value reached are followed; a
  reference's confidentiality is never removed, and it is not checked here.
- **A value the binding document holds itself is a public read**; the
  binding's references are followed like any other.

### The check

A failed requirement refuses the node's commit, at the strict default and
with no dial: the check only refuses more, which
[the correspondence procedure](../development/cfc-spec-correspondence.md)
(step 4) allows marked code to do. Some existing patterns read cells whose
types carry a `RequiresIntegrity`, and their nodes' schemas carry it with
them; the full CI run measures which of them the check refuses, and each is
fixed to satisfy its declaration.

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

- [x] **Per-value guard evaluation at the release gate**, under
      [its own plan](cfc-release-gate-integrity.md) and pull request. It comes
      first. The gates evaluate value-intrinsic rules at each location an
      access consumed and the other rules over the join, so a document
      holding two outputs no longer satisfies a guard neither output
      satisfies alone.
- [ ] **Specs.**
  - A narrow ruling pull request on question 1 (classification item 1),
    independent of specs#51. Its Lean adds a `decide`-checked case: a
    stand-in at one argument fails the coherent check, while an identity guard
    holds of the honest run.
  - A comment on specs#51 proposing that §8.7.2 admit an identity guard over
    requirements the identity binds.
- [x] **Spike.**
  - Attribution: the check follows the node's binding to what its code can
    reach at each declared path, before the code runs. This is a host
    arrangement that over-taints, recorded in the
    [conformance statement](../specs/cfc-conformance-statement.md) with the
    read-log gaps it stands in for (lazy materialization, memoized hops,
    `Cell`-typed inputs read later), each a follow-up.
  - The schema bound to the identity: the artifact indexed under the
    identity the run is stamped with, together with the graph's own schema;
    an identity with no indexed artifact is refused.
- [x] **The check**, enforced at the default, for lifts, computed nodes and
      handlers, with one `SPEC-PENDING` marker on the identity binding.
      `maxConfidentiality` on inputs and builtins' inputs are recorded gaps.
  - Tests (`cfc-node-input-requirements.test.ts`): §10's `to_city` first (a
    measured location passes; a shifted or forged one is refused), then a
    window gate (a viewer's assembly, a literal in the wiring, a gate other
    code wrote or computed, a reference cycle, an absent gate where no stamp
    vouches for it are refused; the owner's gate, and a gate absent from
    settings the owner wrote, pass), and a handler.
  - Measure the pattern suite through CI and fix each refused pattern.
- [ ] **After the ruling.**
  - Remove the marker.
  - Note in the kernel manifest that `verifyInputRequirements` also walks
    argument schemas.
  - Update the [conformance statement](../specs/cfc-conformance-statement.md)
    when the read-log gaps close.
- [ ] **Builtin input requirements** for `policySecretHash`, with labs#8557.
- [ ] **Documents.**
  - Update [input witnesses](../specs/cfc-transformed-by-input-witnesses.md)
    and, once labs#8557 lands, the policy-secret design ("A second
    confidential input").
  - Archive this plan.
