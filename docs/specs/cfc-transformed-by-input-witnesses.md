# Input-witnessed `TransformedBy`

`TransformedBy` records the exact operation that produced a value and the
content references that operation consumed. It has the specification's single
shape (§8.7.1 and §15):

```text
interface TransformationIntegrity {
  type: "https://commonfabric.org/cfc/atom/TransformedBy";
  codeHash: string;
  operation?: string;
  inputs: Array<{
    ref: { space: string; id: string; path: string[] };
    witnesses?: Atom[];
  }>;
}
```

The mint lives in `deriveFlowJoinImpl` and `observationInputWitnesses`
(`packages/runner/src/cfc/prepare.ts`) over the helpers in
`packages/runner/src/cfc/input-witness.ts`. The executable cases are in
`packages/runner/test/cfc-transformed-by-input-witness.test.ts`.

## Operation identity

For verified module code, `codeHash` is the content-addressed module identity
and `operation` is its exact registered export or binding symbol. A verified
identity without a module identity mints no `TransformedBy`; an internal hash
of `Function.prototype.toString` is not an artifact identity and cannot stand
in for one.

A builtin has no separately stored source bundle. Its `codeHash` is therefore
the canonical digest of this versioned builtin-registry entry:

```text
{ format: "commonfabric/cfc/builtin-registry/v1", operation: builtinId }
```

The builtin id is also the atom's `operation`. This identity is deterministic
across bundling, minification, and process restarts. Changing the registry
format is an explicit artifact-identity version change.

The runtime mints one atom when every non-privileged write in the transaction
has the same defined operation identity. Mixed or unattributed writes mint no
atom. The flow must also carry confidentiality or hereditary integrity, which
keeps attribution on the same minting boundary as the flow label it describes.

## Input records

Every consumed content observation contributes a reference. Public inputs are
included and simply omit `witnesses`. Host-admitted external content contributes
the receipt's source reference. Two observation classes are not content inputs:

- `followRef` observes pointer topology. Its confidentiality still joins, but
  its integrity evidence remains on the `LinkReference` chain.
- label-metadata introspection observes label metadata. Its confidentiality
  still joins, but it does not invent a content reference.

Repeated observations of the same `{space,id,path}` collapse to one input. The
runtime sorts input references and witness arrays by canonical hash, so read
order cannot change the atom's bytes.

Within one input reference, witnesses are what holds of the whole value read.
A recursive read can consume several label locations; retaining the union would
let evidence on one child vouch for an unwitnessed sibling. The runtime instead
takes the structural-equality meet over those locations:

- A location is the read path and, for a recursive read, every consumed entry
  beneath it.
- Each location resolves integrity from its own most-specific entries, joined
  across origin components.
- A `*` entry resolves only for the children it covers. A concrete sibling's
  evidence does not fill an unwitnessed wildcard slot.
- Runtime-minted membership templates contribute no witnesses. They describe
  container structure rather than a written value.

When the same reference is observed more than once, its observations meet in
the same way. Distinct references never meet with one another: each retains its
own witness set. This is the important difference between per-input evidence
and a transaction-wide witness summary.

Only `TransformedBy` witnesses are retained today. It is value-bound evidence
that the default transition does not otherwise carry forward. Hereditary atoms
already survive through their class-aware meet; another family can join the
retained set when a policy needs it.

Witnesses can themselves be `TransformedBy` atoms, recording a chain of
endorsed operations. `INPUT_WITNESS_MAX_DEPTH` bounds that nesting at three.
At the boundary, deeper nested witnesses are pruned while the witnessed
operation and its input references remain, so the next mint stays at the cap
without losing the immediate producer.

## Rule matching

Atom record patterns use subset semantics, so a rule that cares only which
operation ran leaves `inputs` unconstrained:

```text
const tallyGuard = {
  type: TRANSFORMED_BY,
  codeHash: THIS_POLICY.moduleIdentity,
  operation: "tallyBallot",
};
```

This continues to match every exact atom for that operation. A rule that also
cares about inputs supplies the complete canonical input array because arrays
match positionally at equal length:

```text
const witnessedTallyGuard = {
  ...tallyGuard,
  inputs: [{
    ref: committedBallots,
    witnesses: [{
      type: TRANSFORMED_BY,
      codeHash: THIS_POLICY.moduleIdentity,
      operation: "commitBallots",
    }],
  }],
};
```

The nested witness is still a record pattern: leaving out its `inputs` trusts
the commit operation regardless of what it consumed. A rule pins the nested
chain as deeply as its policy requires.

Input references are source topology. Cross-space label persistence commits
each `inputs[].ref`, while `codeHash` and `operation` remain public trust
anchors. A rule that requires a concrete input reference therefore evaluates
only where that reference remains in plaintext; a rule that cannot inspect a
committed reference fails closed.

## Structure stamps and custody seals

A structure stamp survives some writes beneath its path. When a later write
names the same `codeHash` and `operation`, the stamp receives that later
transaction's exact atom rather than retaining the prior atom with stale
inputs. A different or unattributed writer removes the `TransformedBy` evidence.
This preserves operation-level policy behavior while keeping every surviving
atom truthful about the current write.

The custody seal follows the same rule. Its anchor may carry only the seal
operation's own `TransformedBy`; foreign integrity still makes the anchor
invalid. Every box location carries the seal operation, and a projector that
reads the box records the box reference with the seal atom in that input's
`witnesses`. Reading another value adds another input instead of erasing the
box's evidence, so a policy that requires the exact box-only input list stays
closed.

## Fail-closed cases

- A transaction with mixed or missing writer identity mints no
  `TransformedBy`.
- An input location without a witness leaves that input's `witnesses` absent;
  it cannot borrow evidence from another reference.
- A concrete value and an unwitnessed sibling in one recursive input meet to no
  witness for that reference.
- A selection expressed through references carries pointer provenance rather
  than pretending the selected content wrote the reference slot.
- A cross-space rule that requires plaintext inside a committed input reference
  cannot match it.

`TransformedBy` says which artifact operation ran, which content it consumed,
and which concrete input evidence the runtime retained. It does not say the
operation is trustworthy, that its output inherits its inputs' integrity, or
that an operation-only guard constrains the caller's choice of inputs. Those
remain policy decisions.
