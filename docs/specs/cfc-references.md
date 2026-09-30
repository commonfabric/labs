# CFC references

The reference profile implements
[CFC §8.2](https://github.com/commontoolsinc/specs/blob/ca3b3e6cdac99a7b14951f48cec63949b39eaaa9/cfc/08-02-pass-through-via-references.md)
with independently labeled reference bindings. It is enabled by
`cfcFlowLabels: "persist"`; rejection follows the configured enforcement mode.

## Reference and content subjects

Writing `A.selected → B.item` writes A. A's reference entry records the complete
binding and the confidentiality of acquiring, selecting, and exposing it. B's
content labels remain on B. A public, independently acquired reference to secret
content can stay public. A private selection among public items produces a
private reference.

An application dereference consumes the reference restrictions at every hop and
the current target labels for the observation it makes. Holding a Cell across
transactions, narrowing its path or schema, recovering it from a query result,
and serializing it through a supported Runtime boundary preserve the acquisition
history. Immutable containers retain the trusted acquisitions of their reference
slots before encoding; decoding an address alone cannot restore that history.
Cells supplied to precise immutable construction retain their effective follow
scope in an inline scope-only schema; their reader value projections do not
change immutable identity. Raw schema-bearing references retain their supplied
schemas, with external references inlined for the immutable document. A
materialized handle writes to its selected storage instance. Its serialized
follow cap does not redeclare that instance's scope. The Runtime retains its
mutation declaration through path projection and transaction rebinding; an
explicit schema change supplies a new declaration. Worker reference tokens
distinguish these mutation semantics and preserve them when the client echoes
the issued schema. Eager and lazy schema reads that box inline array objects
capture references at their original slots and rebase inherited scope caps onto
the immutable result. A later target-label change is resolved on the next
content observation. Raw reads acquire nested references from their exact stored
slots and isolate the returned carriers from other reads. Replaying a partial
argument update therefore retains the acquisition history of every untouched
reference slot. Collection removals capture surviving references at their
original slots before compacting indices; neither nested references nor their
selection history become raw, unauthenticated links during that move.

Precise immutable construction, raw reads and writes, and pattern result
projection preserve link-free instance values through their canonical codecs,
including native Error causes and extra properties. References inside opaque
instance state are unsupported and fail closed. General Cell-to-link and IPC
conversion retain their instance refusal.

The transaction records explicit identity and dereference observations alongside
its journal. A later covering trace cannot erase an earlier identity comparison.
Generic reference and container writes use the conservative observation/control
join, including triggers. Trusted coordinator bookkeeping may mark its own reads
as machinery; merely writing links or restamping membership proves no isolation.
Per-element execution can keep content computations pointwise while a shared
coordinator reference retains broader selection history from its creation or
reconciliation. Dereferencing through that coordinator still consumes its
history.

Authenticated reference acquisition also retains the input witnesses of the
exact source slot's selection. The slot's value stamp must describe the actual
reference stored there. This evidence participates only in the input-witness
meet for the reference choice; it neither endorses target contents nor satisfies
a target integrity floor. Unknown selectors and handwritten observation records
retain no such evidence. Live view copies and verified event receipts preserve
it independently of serialized display labels.

Static runtime bindings replay their captured acquisitions pointwise, so reading
one sibling does not retroactively change another sibling's selection history.
Only the runtime can mark those exact immutable slots as transport. Ordinary
application selection, event payloads, and pending writes include the current
control flow when acquiring a reference; the transport marker is not exported
through event receipts.

Setup discovers dependency chains through redirect probes. Terminal values and
their nested references are consumed only when the action reads them, so merely
installing sibling nodes does not add their stored contents to an input's
acquisition history.

Setup compares stored result bytes only to elide an unchanged projection write;
that comparison retains its conflict dependency without consuming content
labels. Preserving a stored name is a separate content copy whose read
contributes the name's confidentiality, including a covering label or labeled
absence.

The Runtime admits an unchanged root Cell output as a repeated projection. It
marks the exact comparison activities and binds their evidence to the stored
revision. This exception to `writeAuthorizedBy` covers only those runtime
comparisons: an ordinary no-op attempt or an overlapping payload write in the
same transaction still requires the declared writer. Reference confidentiality
and linked content floors remain independent checks.

`LinkReference` integrity records a relationship. It does not endorse B's
contents. A receiver's `addIntegrity` declaration cannot satisfy a floor on a
different content subject. The schema attached to a handle is a read projection;
it is not proof that the target currently satisfies a content assertion.
Declared receiving policies apply to the reference slot and projected paths
structurally. Merely declaring confidentiality there does not inspect the
target's type or contents.

Writer and UI authorization on an explicit `asCell` handle governs the reference
binding without inspecting the target projection. This remains true when the
handle field sits under a containing union: the applicable handle writer claims
are conservatively conjoined. The runtime does not use a foreign target's shape
to choose among those writers. Content integrity floors and confidentiality
screens retain their separate applicability checks.

Stored policies that condition a write on its value retain that condition and
its schema definition scope when a reference is written. Independent union
branch policies are checked separately; a writer requirement for one message
kind does not govern a distinct untrusted import kind.

Runtime-minted integrity from a schema, such as `LlmDerived` or `InjectionSafe`,
certifies the concrete value written by its authenticated builtin. Wildcard
schemas expand only over written inline slots; they do not endorse later array
members or follow passive references. These attestations persist as derived
value entries, separately from ordinary declared confidentiality and integrity.
An overlapping value replacement or deletion invalidates them, including when
flow labeling is off. Each write captures its author independently of subsequent
identity changes in the transaction. An existing wildcard runtime attestation
cannot prove which concrete values were certified and is not carried forward.
Branch-local `addIntegrity` declarations containing only `LlmDerived` and
`InjectionSafe` are supported as value evidence even in overlapping unions;
confidentiality, writer policy, and ordinary endorsements retain the
divergent-policy guard. `InjectionSafe` additionally requires the concrete
inline value to satisfy the sanitizer's branch schema, including its
closed-object rules. A branch that certifies numbers cannot certify a different
branch's free-form text.

A stored stream binding retains its own CFC declarations. Child schemas under
the stream wrapper describe future event payloads, so publishing that binding
does not inspect or declare those children as stored stream contents. The
unwrapped event schema retains its payload policies for event processing.
Sending through a stored stream reference validates every traversed slot before
local queuing or durable append. The dispatch consumes the selected stream's
reference confidentiality, including a held Cell's history, even when its event
payload is a primitive. Handler dispatch records that restriction before running
the handler, so its writes and cascades retain the selection context.

## Verification before storage submission

Runtime checks explicit content floors and copy requirements against the current
scoped target, using the shared link resolver. Nested requirements map through
the receiving binding. Supported wildcard floors enumerate concrete
contributions and verify each; unresolved evidence rejects. Reference exact-copy
compares the complete binding, while a claim about a linked descendant resolves
that content. Reference serialization consults the handle's carried schema. It
does not resolve the target merely to discover a schema or populate reference
labels. Canonical handle materialization and resolution retain inherited scope
caps in the handle's schema so ordinary forwarding preserves them durably. An
explicit later schema projection that widens those caps remains ineligible for
storage. Generated scope redirects retain these caps in a scope-only schema,
including an intermediate user hop. A same-binding write can remain a no-op only
when the stored reference already enforces the newly required scope restriction.
An alias may project a field within an already-held scoped document while
retaining that field's outgoing follow cap. That cap still governs links
followed from the field; it does not reject the scope of its existing container.

A content assertion can itself reveal protected information through success or
failure. Its evidence, including traversed bindings and protected metadata, must
fit confidentiality the attempt already carries. Otherwise it returns the common
unavailable-evidence refusal. This guard applies to content assertions; ordinary
reference forwarding does not inspect or import target content labels.

A loaded envelope can prove that its value root or an optional descendant is
absent. A parent shape check distinguishes a missing final field from a present
field containing `undefined`. Applicability checks protect parent shape
observations in both the present and absent cases, without consuming unrelated
sibling contents. This absence remains bound to the source revision and supplies
no positive endorsement or copy evidence. An unavailable document or a
scope-blocked reference cannot prove absence.

Verification reads carry authorization dependencies separately from application
taint. Internal verifier reads also leave an action's input scope unchanged:
replaying a user-scoped trigger's metadata does not make a public input a
user-scoped payload read. Trigger confidentiality still joins the flow, and an
ordinary user-scoped payload observation still narrows the action's input scope.
Storage checks ordinary document revisions, including the confirmed and pending
revision basis captured with the read. CFC metadata, schema, binding, and value
changes cannot disappear through internal-read or mergeable-write conflict
filters. These dependencies use Memory's generic `required` validation class, so
an identical output cannot waive stale evidence. When a storage commit is
submitted, transactions releasing queued effects or processing durable events
also require their retained read dependencies. This marker does not cause a
read-only transaction with no document operations to submit a storage commit.
Storage does not interpret CFC policy and verification does not write B.

When an array edit changes its document's CFC metadata, Runtime retains the
authored array layout in the pending view. A peer update cannot move references
away from the slot labels that accompany them. Admission validates the retained
dependencies before accepting the edit. Array edits with unchanged metadata
retain their mergeable operations.

Worker cell appends use Runtime's conflict-retry path. Each attempt retains the
same operation cause and member identities while re-deriving reference metadata
against the refreshed array. A confirmed append reports success only after an
attempt commits; terminal refusals still reach its caller.

Local confirmation retains every accepted contribution when several sealed
writes share a wave commit sequence. An arriving full document supplies the
complete committed value and supersedes that local reconstruction.

Mutable content assertions across spaces are rejected when their evidence cannot
be bound atomically to A's commit. Reference-only forwarding does not require a
content assertion. The implementation has no persistent target-evidence cache.

## Transport and disclosure

Runtime owns reference provenance through private associations with live
carriers. A serialized label view cannot mint it. In the precise profile,
RuntimeProcessor exports opaque `cfcReferenceToken` values scoped to its fixed
authenticated security context and lifetime. Import restores the original
carrier, permits descendant paths, and preserves scope restrictions. Rebinding
identity, space, scope, or overwrite mode rejects. Persistence rejects a schema
projection that cannot encode the acquisition's retained scope caps. Stripped,
stale, or foreign tokens cannot recreate trusted acquisition through arbitrary
CellRef operations. Generated durable schemas enforce the narrowest retained
scope cap at every hop; they can reject a projection earlier than the live
handle. The stored link format cannot represent inherited cap positions, so
serialization preserves the restriction conservatively.

Subscriptions and cached values are keyed by acquisition token as well as
address and projection, so identical reference bytes with different private
histories remain separate. Cycle backlinks exported from a read carry an
absolute acquired reference to their ancestor. A backlink issued for an acquired
subtree retains that subtree's path boundary.

Resolving a slug for `piece:get` retains the stored reference's acquisition
history. When the slug names a path inside a piece, the returned handle keeps
the redirect's scope restrictions while adopting the schema along that path. The
piece document's root sync covers this lookup without loading the returned
value's descendants.

Durable events carry an optional opaque `runtimeReferenceContext` outside the
application payload. The sending Runtime captures authenticated acquisitions at
exact payload slots, binds the context to the canonical payload hash and full
reference bindings, and joins the sending attempt's confidentiality. Context
version 2 additionally binds the dispatch to its selected stream and carries
that selection and sending flow into the handler. The serving Runtime validates
completeness and restores confidentiality, scope caps, and private immutable
reference tables onto an isolated payload before dispatch. This conveys no
target-content integrity. The handler owns value projection; links carry only an
inline scope restriction needed to retain their caps. Converter-generated cycles
retain a proof bound to their ancestor path inside the exact immutable payload.
Their reference table includes every payload slot, so following a cycle retains
the acquisitions reachable through that ancestor. Raw relative links cannot
claim that cycle proof.

The context has the same admitted producer trust as renderer and
runtime-injected event attestations. It is not a signature, and a payload field
cannot mint it. Memory validates the optional field's shape and retains it
through same-space emission, cross-space outbox delivery, restart, and explicit
Retry; it does not interpret CFC policy. An invalid context is a terminal event
refusal. Without a context, ordinary precise reference-acquisition checks still
apply, so decoded reference bytes cannot become public acquisitions. A primitive
event's dispatch can still require context for the stream-selection history.

Memory advertises opaque context preservation through the `eventContext`
capability. Clients require it for declared event appends and Retry requests and
recheck it before sending after reconnect. This transport guarantee is
independent of the deployment requirement that every participating Runtime
support context version 2; an older Runtime must not author or dispatch events
in that cohort.

Explicit host acquisition APIs, including `GetCell(cause)`,
`RuntimeClient.acquireCell(address)`,
`Runtime.acquireExternalInput(space, data)`, and piece/home/slug loaders, remain
trusted entry points. The shell inspector and string-link components acquire
their independently selected addresses through that host operation. Ordinary
CellRef operations require the issued token. Address-only wire strings cannot
encode historical selection provenance. Metadata projections retain the
requesting handle's restrictions, including references returned in internal
manifests.

CLI callable arguments use external-input acquisition after address
normalization and handler input validation. An independently supplied address
must name a document; its omitted space is the invocation's space. Existing
private carriers retain their acquisition history. This operation observes no
target contents and grants no target-content integrity. A relative raw reference
without a source is refused, and an opaque immutable document still needs
authenticated acquisition history for references inside it.

Display views preserve held-reference confidentiality as covering restrictions
under the existing view format. Inbound display fields are stripped. Render and
LLM observation gates therefore retain reference restrictions without treating
the view as authority to create references or endorse content.

Label introspection also observes metadata shape. Templates protect presence,
type, kind, count, order, and empty query results for derived labels and precise
reference labels. A public field classification adds no field-specific
restriction but cannot erase the selection context. A normalized denial retains
the observations used to decide it. When flow labels cannot carry a protected
query result, introspection returns the common unavailable result.

## Format and rollout

The [precise reference rollout plan](../plans/cfc-precise-reference-rollout.md)
allows the intended deployment activation to precede the existing-Home
migration. An activation that includes this reference profile admits only fresh
or verified ready Homes and their participating reference graph; unresolved
Homes remain on a compatible deployment until migration. The Home contract
transition requires a state-preserving migration and compatibility replay. A
global flag change alone cannot establish readiness or waive that gate.

CFC envelope version 3 supports precise reference entries. Each stored reference
slot requires its own complete entry; upgrading one slot does not authenticate
untouched legacy references. An entry with `origin: "link"`,
`observes: "followRef"`, and `referenceAcquisition: "complete"` attests that
this slot's acquisition restrictions are accounted for. The runtime may account
for an unresolved acquisition by stamping unavailable confidentiality; this
preserves diagnostics while protected uses remain fail-closed. An unmarked entry
remains incomplete even inside a version-3 envelope. The reference entry carries
reference confidentiality; content is resolved independently. Other label
components retain their existing update disciplines. Readers accept versions 1,
2, and 3 and reject unknown versions at protected reads. A metadata retrieval
failure propagates as a failure; it cannot establish that a reference or its
contents are unrestricted. Protected assertions normalize unreadable or
unsupported metadata to unavailable evidence, while unexpected storage failures
remain operational errors. Deploy compatible Runtime, worker, and boundary
readers before enabling precise writes; older readers that reject version 3
cannot participate in that profile. Cooperating reference writers must also
persist complete per-slot acquisition history before precise readers consume
their output. The shell, deployed CLI, production server preset, and serving
Runtime persist this history. Embedding controllers must select persistence when
writing for these readers; a flow-off writer can produce references they refuse.
Reader compatibility alone does not establish writer provenance.

Versions 1 and 2 remain available to the legacy profile. Missing envelopes and
slots without complete reference entries also have unresolved acquisition
history. Keeping recorded restrictions does not reconstruct selection
dependencies that its writer omitted. Precise acquisition or traversal of a
legacy stored reference therefore requires trusted re-acquisition; unresolved
history fails closed. No bulk rewrite or automatic removal of legacy
confidentiality is performed. Direct, independently authorized acquisition of a
document address is a separate operation.

Diagnostic or disabled settings do not establish enforcement guarantees.
`enforce-strict`, persistent flow labels, enforcing floors, and enabled trigger
gating remain separate deployment choices described in the
[enforcement matrix](cfc-enforcement-matrix.md).

Legacy aggregate combine states encode selected addresses as ordinary data. The
non-precise profile resolves those addresses for `minBy` and `maxBy`. Before
enabling precise CFC, those states must be recomputed into acquired reference
slots; the precise profile refuses an unproven legacy address.
