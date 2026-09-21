# Protected initialization

CFC's `writeAuthorizedBy` declaration gates modification. Trusted runtime
initialization may install a new protected value without executing the field's
edit handler (normative CFC §8.15.4). This permission is local to one transaction,
one storage address, and one exact value. It grants no authority to adopt an
existing unprotected value.

## New cells

When the runtime serializes a constructed cell with a default, it materializes
the seed and records the cell's complete schema for CFC preparation. The value,
schema document, and CFC envelope commit together. Failure aborts the operation.
The reference that exposes the cell requires its own protection: changing that
reference must not provide an alternative way to replace the protected value.

When a generated initializer returns the same protected cell again, its changed
default does not replace an existing backing value. The runtime may record a
private claim for an unchanged ordinary root output reference with no carried
labels. Preparation permits that single attempt only when its final reference
and complete stored CFC envelope remain unchanged. Extra attempts, applied
writes, and changed policy require ordinary writer authorization. This cannot
adopt an unprotected reference. Streams retain their ordinary declaration path.

Lowering preserves authored writer-binding syntax through a cell constructor,
its `.for()` call, and stable local bindings. Generated lift-result and inferred
pattern-result schemas retain the same `writeAuthorizedBy` identity as the
constructed cell. A structural function type cannot substitute for `typeof`
writer identity.

## New fields during a source update

Verified pattern setup may initialize a concrete, newly declared protected
argument field from its schema default. It uses the candidate schema's ordinary
default extraction and argument validation. The prior argument schema must be
known and must not already declare the field. The argument document must be
readable. Paths containing `*` (including a literal property with that name)
and ambiguous previous declarations do not receive this permission. CFC's
schema-entry paths do not distinguish literal `*` properties from wildcards.

The setup records the permission alongside the candidate argument schema and
source transition. Preparation requires the field to be absent and the final
transaction value to equal the extracted default. Supplied nondefault values,
explicit `undefined`, `null`, and other existing values are not initialization.
An existing policy on the field or an ancestor remains effective.

The source pointer, argument update, merged CFC policy, and setup receipt share
one commit. A failed validation or authorization leaves the prior state intact.
Source-update delegations continue to use `PreparedSourceUpdate`; initialization
neither replaces that authority nor authorizes ordinary input rebinding.

## Authorization and transaction evidence

An initialization policy input is authoritative only when the runtime records it
with its private authorization mark. A record submitted through the public
transaction interface has no initialization authority.

Overlapping writes can record different intermediate snapshots. Every covering
write snapshot must support absence: a snapshot showing an existing value, an
unreadable path, a redirect, or unknown presence prevents initialization. A
whole-object deletion followed by a child write cannot turn an existing field
into a new field. The exact-value check reads the transaction's final value,
rather than reconstructing it from overlapping write details.

The permission waives only `writeAuthorizedBy` for that initialization. Owner
binding, represented-principal integrity, confidentiality, required integrity,
schema compatibility, and storage authorization remain enforced. Stored policy
is read and merged through ordinary CFC preparation; an unreadable envelope is
never treated as absent.

## Existing unprotected values

Source following preserves existing state. Installing a new source does not
prove who wrote an old value or permit silently accepting it as a trusted seed.
Repairing such state requires an explicit owner-authorized adoption operation
that preserves the value and installs its policy in the same commit.

The profile-name repair is one such operation. Its host-only adoption input is
private, exact-address, and exact-value. Preparation treats it as a policy
attempt even when the value write would be a no-op, so the normal requirement
gates and envelope persistence run. Only the writer-binding gate receives the
adoption permission. No raw CFC metadata is installed by the repair caller.

The operation reads the durable represented principal from declared stored
labels and checks that the actor matches it. A schema's current-principal
placeholder alone cannot establish ownership. It supports only the field-local
owner, represented-principal, and writer-binding policy; additional provenance
claims or ancestor policies are refused. Owner acceptance cannot confer an
`authored-by` claim on an old value.

An inspection receipt binds the profile's verified pattern identity and setup,
name projection, stored policies, and exact name-chain values. Application
revalidates them on one transaction, including ordinary concurrency reads of
policy metadata. Missing protection commits atomically across the supported
chain. Existing protection is never replaced or weakened. The CLI surface is
[`cf profile repair-name-protection`](../../packages/cli/README.md#repairing-profile-name-protection).
