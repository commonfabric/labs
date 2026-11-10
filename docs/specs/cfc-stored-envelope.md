# The stored CFC envelope

A document carries its Contextual Flow Control labels in an envelope stored
at a reserved member of the document root, `["cfc"]`, beside the `value` the
document holds. The envelope names the schema its labels were derived
against and carries a label map: one entry per labeled path, each entry
holding the path and the label that applies there. Its stored shapes are
`StoredCfcMetadata` in
[types.ts](../../runtime/runner/src/cfc/types.ts), and version 2's
content-addressed labels are
[content-addressed-cfc-labels.md](content-addressed-cfc-labels.md).

This document says what a reader of that envelope does with a value it
cannot interpret.

## The rule

**A transaction that consumed a document whose stored envelope this build
cannot interpret fails closed.**

Failing closed means the read raises a `StoredCfcMetadataError` rather than
producing labels, and every consumer of that error refuses rather than
continuing. The reading it rules out is the one a labeled document must
never get: the document read as an unlabeled one, its confidentiality
absent from the flow join that decides what the transaction may write.

The rule is about what this build can interpret rather than about what is
wrong with the stored value, and those differ. An envelope written by a
later build, whose format is correct and whose version this build does not
know, is as uninterpretable here as a corrupted one. So is an envelope whose
labels live in documents this replica does not hold. Neither is damage, and
both fail closed.

The rule does not reach a document that stores no envelope: nothing stands
at the reserved position, the document carries no labels, and reading it as
unlabeled is correct. What separates that case from the others is the whole
of the classification below.

## Reading the reserved position

[metadata.ts](../../runtime/runner/src/cfc/metadata.ts) is the only module
in the runner that produces labels from what stands at `["cfc"]`. Its
`interpretStoredEnvelope` is the one place that decides which of three
outcomes a stored value gets. Which envelopes it reads is decided by the
checks of
[cfc-stored-envelope.ts](../../runtime/memory/v2/cfc-stored-envelope.ts) in
Memory, the one definition of a readable envelope. The store's labeling of
the anchors an edit moves
([cfc-anchors-label.ts](../../runtime/memory/v2/cfc-anchors-label.ts)) reads
a field's envelope through the same checks, so it reads the envelopes the
runner reads and refuses the edit for every other one.

- **Nothing stored.** The position holds `null`, a scalar, or nothing at
  all. The reader returns `undefined` and the document carries no labels.
- **An envelope.** The position holds a record whose `version` this build
  interprets, holding a label map of the one map version there is, whose
  every entry carries a path of strings and a label a consumer can read
  clauses out of. The reader resolves the labels and returns them. Both
  versions are checked: the envelope's and the label map's own, which the
  format carries so the map can rev on its own.
- **Fail closed.** Everything else, as a `StoredCfcMetadataError`:
  `UnknownCfcMetadataVersionError` for a `version` outside the list this
  build knows, `UnreadableCfcMetadataError` for a label map it cannot walk,
  and `UnresolvableCfcLabelDocumentError` for a version-2 entry naming a
  label document nothing can back.

Three consequences of that classification are worth stating, because each
one is a place a looser reader would read a labeled document as unlabeled:

- **The position qualifies a value, not its field names.** Any record a
  document stores at `["cfc"]` is an envelope for the purpose of this rule,
  including one carrying no `version` and one carrying none of today's
  members. A future format may rename every member; requiring today's names
  would read exactly those envelopes as unlabeled. `cfcMetadataPresent()`
  is this half of the classification on its own, which is what the
  label-map-erasure guard below asks.
- **One entry decides the whole envelope.** An entry no label can be
  produced from makes the envelope unreadable rather than being walked
  past. A reader that skipped it would drop that path's policy while
  reporting the document as labeled, which is the same under-labeling one
  path at a time.
- **A label carrying a member this build does not know is not a label.**
  Every label this build writes carries `confidentiality` and `integrity`
  alone, so a third member is a format this build postdates, and reading
  the two it knows would drop whatever the third carries. A version-2 label
  document is held to the same shape for a second reason: its content hash
  is its identity, so the shape check is what stops a record that merely
  hashes correctly from registering as a label.
- **A label is a plain object.** A stored value can decode to a class
  instance, such as `FabricBytes` or `FabricEpochNsec`, and one keeps its
  state in private fields, so it shows no members of its own. A check of
  members alone would read one at a label position as a label with no
  clauses. So a label, inline or in a label document, is refused unless its
  prototype is `Object.prototype` or `null`, and the store refuses a commit
  naming a label document that is not one. The other records an envelope
  holds each need a member of their own (`version`, `entries`, `path`,
  `$ref`), so no instance passes there, and their prototypes are not
  checked.
- **A template-origin entry that is not keyed and classed as a template is
  not an entry.** The `label-metadata` origin marks an entry as keyed
  against the stored document rather than against `value`, and a reader
  decodes every entry of that origin out of the payload entries (spec
  §4.6.4). An entry of that origin keyed outside `["cfc", "labels"]`, or one
  whose observation class a payload read consumes, would be a payload label
  that decoding drops, so it makes the envelope unreadable.

The levels enclosing the label go the other way. An envelope, its label map,
and an entry may each carry a member this build does not read, and the
envelope stays readable. The version is how the format announces content
this build does not interpret, and a member appearing without a version
change carries nothing this build would have acted on: the CFC
specification leaves a migrating writer free to keep a legacy field beside
the ones the profile defines, and gives an entry view-specific refinements
beside its label (spec §4.6.4). Refusing those would read a labeled document
as unreadable with its labels sitting right there, which costs availability
and buys no confidentiality.

`stampPlacement` is such a member, and the reason it is one. An envelope
carrying `stampPlacement: "committed"` says that each writer's stamp at a
slot holding a reference was persisted beside the reference its attempt
placed, which is what lets such a stamp count as an input witness
(`cfc-transformed-by-input-witnesses.md`). A reader that predates the member
reads the envelope and its labels as it always did. A writer that predates it
rewrites the envelope without it, and the envelope then says nothing of its
stamps, which is the conservative reading. A version of its own would have
made every document carrying it unreadable to those builds for the sake of a
statement they lose nothing by ignoring.

A member this build does not read is also one the resolved envelope does not
carry. The reader builds its answer from the members it validated, so a
stored label map's own `documentEntries` member, which no stored format
defines, never stands in for the templates the reader decodes out of
`entries`.

## What each consumer owes the rule

Reading an envelope happens on many paths, and the ones that swallow other
read failures must let this one through. Every consumer below rethrows or
converts a `StoredCfcMetadataError`, and none of them reads the document as
unlabeled:

| Consumer | What it does |
|---|---|
| The prepare pass ([prepare.ts](../../runtime/runner/src/cfc/prepare.ts)) | Propagates out of `prepareCfc()`, so the boundary verification fails loudly rather than deriving a join from labels it never read |
| `loadStoredCfcEnvelope` (same file) | Converts to `{status: "unreadable"}`, which the commit boundary records as a reason and rejects in enforcing modes |
| `storedCfcMetadataAppliesToPath` | Reports that policy applies, so the write it gates reaches the same envelope at prepare time |
| The dereference label view ([label-view-state.ts](../../runtime/runner/src/cfc/label-view-state.ts)) | Rethrows where every other failure yields no view, because this view feeds the flow join |
| The link-write merge ([data-updating.ts](../../runtime/runner/src/data-updating.ts)) | Keeps the write CFC-relevant, routing it to prepare |
| The stored-schema lookup ([cell.ts](../../runtime/runner/src/cell.ts)) | Propagates, so the write throws where it is made rather than serving the document schemaless. This is the arm that catches a write no other gate would: a transaction writing through a cell whose schema declares no policy is CFC-relevant only because the document's stored envelope says so, and an envelope no reader can interpret answers that question by failing |
| The compilation cache ([cell-cache.ts](../../runtime/runner/src/compilation-cache/cell-cache.ts)), the pattern manager ([pattern-manager.ts](../../runtime/runner/src/pattern-manager.ts)), and the agent connector's graph ([fabric-graph.ts](../../connectors/agents/connector/src/fabric-graph.ts)) | Propagate |
| The display label view ([label-view.ts](../../runtime/runner/src/cfc/label-view.ts)) | Records the read as failed; the fail-closed variant merges a blocking entry into the view it hands back |
| The label-introspection builtin ([label-introspection.ts](../../runtime/runner/src/cfc/label-introspection.ts)) | Declines to answer, the same as for a target it cannot observe — it discloses a label rather than reading a payload, so declining is the refusal, and a write the caller then makes still reaches the envelope at the gates above |
| The label-erasure guard ([extended-storage-transaction.ts](../../runtime/runner/src/storage/extended-storage-transaction.ts)) | Counts an uninterpretable envelope as a label map, so a root write replacing one with nothing records as an erasure |

Other code looks at the reserved position for purposes that produce no
labels, and the rule does not reach it. The delivery seams read the
documents an envelope names rather than the labels it carries —
`loadLabelSchemaDoc` ([traverse.ts](../../runtime/runner/src/traverse.ts))
follows the schema document and the label documents into the query result
and watch set, over `cfcEnvelopeLabelDocumentHashes`
([label-documents.ts](../../runtime/runner/src/cfc/label-documents.ts)),
the one scan every seam applies — and the prepare pass's
self-minted-document scan asks only whether a write carried a `cfc` member
at all. An envelope those walks cannot make sense of delivers nothing extra,
and the reader that goes on to want its labels fails closed.

A new consumer adopts the rule by leaving `StoredCfcMetadataError` alone.

## What the store refuses of a handed envelope

The rule above is the reader's. The store that receives an envelope has a
check of its own, because a writer can hand it an envelope the runtime never
derived: a client that skips its runtime's label machinery and writes the
reserved position itself. Specification §8.12.8 makes the declared
component, the store policy, monotone, so the store can judge it against
what it already holds without re-deriving anything.

The memory engine refuses a commit that leaves a path whose stored declared
entries (`origin: "declared"`) hold a confidentiality clause with no
declared entry at that path, the whole `cfc` member erased included
([envelope-admission.ts](../../runtime/memory/v2/envelope-admission.ts),
called from `applyCommitTransaction` in
[engine.ts](../../runtime/memory/v2/engine.ts)). The runtime writes that
shape only in the two owner releases of
[confidentiality-release.ts](../../runtime/runner/src/cfc/confidentiality-release.ts).
In the first, §8.12.7 route 2c, a commit the space's owner signs, every clause
of whose dropped entries is the owner's alone to release, is admitted. That
decision is `clauseReleasableBy()`, which the runtime's release makes too
and which lives in the memory package
([cfc-release-authority.ts](../../runtime/memory/v2/cfc-release-authority.ts))
so that both read it. A label held by reference is read from the label
document the space stores; one that doesn't resolve can't be released. A
commit leaving the document deleted is admitted, and a later commit writing
it is a creation; a commit that deletes the document and writes it again is
judged by what it writes.

In the second, a release by intent (§8.12.7 route 2d), the dropped clauses
need not be the owner's alone, and the store admits the drop on the record the
commit creates beside it
([cfc-owner-release-by-intent.ts](../../runtime/memory/v2/cfc-owner-release-by-intent.ts)).
The record holds the request the space's owner signed, and the store verifies
it at the commit: the signature, that the signer is the owner the space's
access list names, that the request names this space and a document the commit
writes an envelope of, that the stored envelope's digest is the one the
request names, that every clause it releases is stored at its path and gone
from it afterwards while every other clause there stays, in an entry of the
same component and class, that the record's stored label holds a declared
`User(owner)` clause at its root, and that its record is new, at the id the
document's id and the request's digest derive. A dropped declared path that
such a release names is admitted. Any write to an id under the record scheme
other than that one creation is refused, so a record is never forged, altered
or removed by a commit.

This is the interim rule of
[specs#89](https://github.com/commonfabric/specs/pull/89), which this
runtime implements ahead of the ruling. The rule that pull request proposes
also refuses a lowering that keeps a declared entry at the path, and a
change to a still-existing path's existence entry. Those are left to the
runtime here until its own declared-monotonicity gate
([`cfcDeclaredMonotonicity`](../development/EXPERIMENTAL_OPTIONS.md#cfcdeclaredmonotonicity))
runs at `enforce`. The derived and link-carried components are the
runtime's to get right under either rule, since judging them means
re-deriving them.

## Recovery

Two of the three errors are permanent for the stored bytes: an unknown
version and an unwalkable label map are properties of the document, and
reading again gives the same result until the document is rewritten or the
build advances. `UnresolvableCfcLabelDocumentError` is not, because the
label document it names may arrive by sync, so that failure is never
memoized and the read succeeds once the document lands. Resolution results
are memoized by the identity of the stored label map, never failures.

## Where this is pinned

- [cfc-envelope-version-guard.test.ts](../../runtime/runner/test/cfc-envelope-version-guard.test.ts)
  — every reader refuses the same stored values, across the shapes an
  envelope can be damaged or postdated in;
  the commit path rejects a write whose target or read source carries one; a
  document storing nothing at the reserved position reads as unlabeled.
- [cfc-content-addressed-labels.test.ts](../../runtime/runner/test/cfc-content-addressed-labels.test.ts)
  — a version-2 entry naming a label document nothing backs, one naming a
  document that does not hold a label, one whose content does not hash to
  its id, and a reference in a version-1 envelope.
- [v2-envelope-admission.test.ts](../../runtime/memory/test/v2-envelope-admission.test.ts)
  — the store refuses a commit dropping another principal's declared label,
  by erasure, by a rewrite or patch leaving its entry out, or through a
  label held by reference, and admits the space owner's drop of their own
  clause, a lowering that keeps the entry, and a delete.
- [cfc/verifier-metadata.test.ts](../../runtime/runner/test/cfc/verifier-metadata.test.ts)
  — a transaction that consumed an uninterpretable envelope is refused even
  when its write target declares no gate.
