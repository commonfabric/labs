# Input requirements on a node's inputs

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

- Each input of the endorsed code declares the integrity its value must
  carry, using the existing `RequiresIntegrity` authoring type.
- The runtime checks every declaration against the values read there, and refuses the commit when one fails.
- The declarations are taken from the code the identity names, not from the
  graph that wires it.

Every output carrying the code's `TransformedBy` then came from inputs that met
its declarations, whatever the code was fed. A rule that guards on the identity
alone inherits that guarantee: existing rules gain it unchanged, and new rules
need no new evidence form.

## What the specification says

- §8.9 holds every lift and computed node to its input contract: "Input
  contract checks (`requiredIntegrity`, `maxConfidentiality`) are part of
  boundary validation (§8.10.3) and MUST be enforced before commit." §4.6.1
  gives a node its input cells.
- §8.10.3 checks each requirement against every consumed read overlapping its
  path, public reads included, coherently; a read that resolves to no label
  fails it. §4.6.3 counts a presence probe as a consumed `shape` read.
- §3.8.4: a parameter that shapes whether, what, where or to whom data is
  released is integrity-sensitive, and low-integrity values MUST NOT
  determine it. §10's `to_city()` requires integrity on its input.
- §8.2.4: a dereference's integrity is the target's together with the
  reference's, and the reference's confidentiality is never removed.
- §8.7.2 binds an endorsement claim to "the actual code that ran". Nothing yet
  says the same of an input schema.

## Classification

Under [the correspondence procedure](../development/cfc-spec-correspondence.md):

1. **The check is a conforming implementation** of §8.9 and §8.10.3. It only
   refuses more than the runtime did, so it runs at the strict default with no
   dial (step 4).
2. **Which schema's requirements apply is a semantic gap**, ruled in
   commonfabric/specs#62: the schema bound to the code identity that ran, to
   which a caller's schema can add requirements and from which it can remove
   none. The labs site carries the one `SPEC-PENDING` marker.
3. **An identity guard resting on bound requirements** needs specs#51's
   §8.7.2 paragraph to allow it. A comment on specs#51 proposes the wording.
4. **How the reads are found is a host arrangement**: the runner follows the
   node's binding before the code runs rather than reading the attempt's log.
   It over-taints, and the
   [conformance statement](../specs/cfc-conformance-statement.md) records it
   with the read-log gaps it stands in for.

## Design

`cfc/node-input-requirements.ts` holds the check; the runner calls it before a
lift's, a computed node's or a handler's code runs, and the boundary pass
turns each failure into a reason. The module comment states what each
observation carries: a reference supplies its target's integrity and its slot
confidentiality only; a value in the wiring carries no evidence; a path read
and found absent carries only the evidence its container holds about its own
current value; a default a schema other than the code's would supply carries
none.

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
      [its own plan](cfc-release-gate-integrity.md) (labs#8607).
- [ ] **Specs.** commonfabric/specs#62, the identity-binding ruling; a comment
      on specs#51 proposing that §8.7.2 admit an identity guard over
      requirements the identity binds.
- [x] **The check** (labs#8670), at the strict default, for lifts, computed
      nodes and handlers, with tests that lead with §10's `to_city`.
  - Fix each existing pattern the full CI run shows refused, so its honest
    data satisfies its declaration.
- [ ] **After the ruling.**
  - Remove the marker and re-pin the spec snapshot.
  - Add a kernel manifest row for `verifyBoundInputRequirements`.
  - Update the conformance statement.
- [ ] **Read-log gaps**, each a follow-up the conformance statement names:
      lazy materialization, memoized hops, and `Cell`-typed inputs read
      later. When the log records them, the check can take its observations
      from the log.
- [ ] **`maxConfidentiality` on inputs and builtins' inputs**, including
      `policySecretHash` with labs#8557.
- [ ] **Documents.** Update
      [input witnesses](../specs/cfc-transformed-by-input-witnesses.md), and
      archive this plan.
