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
The envelope's version is not a change: a version-1 envelope spells the same
labels as its version-2 rewrite, so a preserved output leaves it in version 1
and the document migrates on its next authorized write.

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

## References into a sub-pattern argument

A collection builtin — `map`, `filter`, `flatMap` — instantiates one sub-pattern
per entry of the list it runs over, and stages that entry into the new piece's
argument as a link to the entry's own cell, beside a link to the list. The
builtin hands the piece a reference; it writes nothing of what the entry holds.
The runtime records each such field as a reference initialization when it stages
the argument, at the builtin's request, and only where the staged value is a
link to a cell that is not a write redirect. A field holding a value receives no
record.

Preparation permits the write on the terms above: the slot must be absent before
the transaction, and the final value must be the recorded link. A link to
another cell staged over a field that holds one is a modification and requires
the field's ordinary writer. The same link staged again, as a runtime starting a
piece it finds set up stages its argument, lands no write at the slot and is
permitted: the slot keeps its link, and no policy stored on it is disturbed.

The receiving slot's schema is the entry's own, so it can declare integrity the
entry's writer adds, such as authorship by the current principal. Staging a
link writes none of that content, so preparation mints none of that integrity
for the principal staging it: not on the slot's declared label, not on the
link's label, and not toward an integrity floor at the slot. The same holds for
a label derived for the link's source when that source is itself a reference
staged in the transaction. The link carries its source's label and the
`LinkReference` a link write mints, so a reader reaching the entry through the
link sees the entry's own authorship.

When a link's source is a reference staged in the same transaction, or a value
holding one, preparation derives that reference's labels through the recorded
chain. A reference at or above the source path supplies the label there. One
held below it supplies the labels at the matching paths beneath the link, and
none at the link itself. This does not depend on staging order or on the
references occupying different documents. Each hop retains the source's nested
labels and applies the ordinary evidence and carried-label checks. An integrity
floor uses those same derived labels, so the source's real authorship can meet
it. A chain of pending references that never reaches a value refuses label
derivation terminally. An object holding a reference back to itself or another
object is valid. Preparation expands each held reference once per branch, then
follows back-references only as far as a source path, floor, or carried view
requires. This keeps the persisted view finite; reads beyond it follow the
stored references and consume the labels at each hop. A carried view is checked
in full at the link's first occurrence, and a repeated occurrence supplies the
entries covering the requested paths.

## Setup replay over a stored argument

A runtime that starts a piece it did not create replays the setup of the
sub-pieces its pattern composes, and the replay stages each argument document
again. The slots the caller does not name are carried over from the stored
document with the bytes they hold, and the runtime records each such slot as a
replay. The record permits nothing but leaving those bytes as they are.

Preparation defers a protected field's writer requirement when the field lies
at or under a recorded replay slot and no write the transaction recorded
changes a byte at the field, at an ancestor where the difference reaches the
field, or below it. The deferred requirement is waived only when the envelope
the transaction would store leaves the field as it was too: the policy claims
and the label positions they declare are the same throughout the document,
and every label entry at the field, above it or below it is the same. The
stored schema document and envelope version are then kept, and labels
elsewhere in the document persist as for any write. An authoritative
transaction, which commits each document whole, receives no deferral. Any other
write attempt at a protected field — pattern code setting a whole document with
the field's own bytes among them — requires the field's ordinary writer.

## Attribution of an initialized value

An initialized value is the pattern's default, and the principal whose runtime
constructed the cell chose nothing of it. A claim the field's schema makes
about the current principal — `RepresentsCurrentUser`, `AuthoredByCurrentUser`
— names a principal only when the initialization is their act: the
transaction of a handler run they invoked, a piece start deferred from one,
and the transaction that brings a piece into being outside any action — a
deploy, a host creating a piece on the principal's behalf. The runtime marks
those transactions (`CfcTxState.attributedInitialization`, set through the
runtime's authorization); the piece a handler creates, its cross-space
children included, is initialized in the handler's own transaction, and a
served creation carries the requester's trust snapshot. A builtin that
instantiates a pattern from a continuation of its action declines the mark
(`attributeInitialization: false`): the piece is nobody's act.

In any other transaction — a runtime starting a piece it finds set up, a
collection builtin instantiating a sub-pattern over a new entry, a source
update installing a new field's default — the seed, the reference that
exposes it, the new field's default and the cells a setup projects result
fields to are all persisted without a claim about the current principal.
Other integrity the schema adds is minted as for any write. No owner is bound by such an initialization: the field's
`ownerPrincipal` binding is established by the first write an acting
principal makes through the field's writer, and that write mints the claim
for its actor as every handler write does.

An initialization that is nobody's act leaves the claim a stored label
already makes at its path about a principal: the claim is carried forward as
it stands. A preserved runtime output and a replayed argument slot write
nothing and are nobody's act either, so what they store equals what was
stored; a source update another principal's runtime performs re-projects the
fields and strips no owner.

A default computed at run time rather than declared — an initializer wrapped
in a lift — is seeded in the reactive pass that first serializes it, which is
no handler's transaction, so it is not attributed either. Declaring such
defaults, and settling their attribution, is open work.

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

The permission waives `writeAuthorizedBy` and a UI contract's trusted-event
requirement for that initialization, the two declarations that name who may
write a value. A stored declaration of the same kind on the field or an ancestor
refuses its waiver: a stored writer binding keeps its writer requirement, and a
stored UI contract keeps its trusted-event requirement, while a declaration the
candidate schema introduces beside it is waived. Owner binding,
represented-principal integrity, confidentiality, required integrity, schema
compatibility, and storage authorization remain enforced. Stored policy is read
and merged through ordinary CFC preparation; an unreadable envelope is never
treated as absent.

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
