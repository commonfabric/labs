# The stored CFC envelope

A document carries its Contextual Flow Control labels in an envelope stored
at a reserved member of the document root, `["cfc"]`, beside the `value` the
document holds. The envelope names the schema its labels were derived
against and carries a label map: one entry per labeled path, each entry
holding the path and the label that applies there. Its stored shapes are
`StoredCfcMetadata` in
[types.ts](../../packages/runner/src/cfc/types.ts), and version 2's
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

[metadata.ts](../../packages/runner/src/cfc/metadata.ts) is the only module
that produces labels from what stands at `["cfc"]`. Its
`interpretStoredEnvelope` is the one place that decides which of three
outcomes a stored value gets:

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

## What each consumer owes the rule

Reading an envelope happens on many paths, and the ones that swallow other
read failures must let this one through. Every consumer below rethrows or
converts a `StoredCfcMetadataError`, and none of them reads the document as
unlabeled:

| Consumer | What it does |
|---|---|
| The prepare pass ([prepare.ts](../../packages/runner/src/cfc/prepare.ts)) | Propagates out of `prepareCfc()`, so the boundary verification fails loudly rather than deriving a join from labels it never read |
| `loadStoredCfcEnvelope` (same file) | Converts to `{status: "unreadable"}`, which the commit boundary records as a reason and rejects in enforcing modes |
| `storedCfcMetadataAppliesToPath` | Reports that policy applies, so the write it gates reaches the same envelope at prepare time |
| The dereference label view ([label-view-state.ts](../../packages/runner/src/cfc/label-view-state.ts)) | Rethrows where every other failure yields no view, because this view feeds the flow join |
| The link-write merge ([data-updating.ts](../../packages/runner/src/data-updating.ts)) | Keeps the write CFC-relevant, routing it to prepare |
| The stored-schema lookup ([cell.ts](../../packages/runner/src/cell.ts)) | Propagates, so the write throws where it is made rather than serving the document schemaless. This is the arm that catches a write no other gate would: a transaction writing through a cell whose schema declares no policy is CFC-relevant only because the document's stored envelope says so, and an envelope no reader can interpret answers that question by failing |
| The compilation cache ([cell-cache.ts](../../packages/runner/src/compilation-cache/cell-cache.ts)), the pattern manager ([pattern-manager.ts](../../packages/runner/src/pattern-manager.ts)), and the agent connector's graph ([fabric-graph.ts](../../packages/connectors/agents/connector/src/fabric-graph.ts)) | Propagate |
| The display label view ([label-view.ts](../../packages/runner/src/cfc/label-view.ts)) | Records the read as failed; the fail-closed variant merges a blocking entry into the view it hands back |
| The label-introspection builtin ([label-introspection.ts](../../packages/runner/src/cfc/label-introspection.ts)) | Declines to answer, the same as for a target it cannot observe — it discloses a label rather than reading a payload, so declining is the refusal, and a write the caller then makes still reaches the envelope at the gates above |
| The label-erasure guard ([extended-storage-transaction.ts](../../packages/runner/src/storage/extended-storage-transaction.ts)) | Counts an uninterpretable envelope as a label map, so a root write replacing one with nothing records as an erasure |

Other code looks at the reserved position for purposes that produce no
labels, and the rule does not reach it. The delivery seams read the
documents an envelope names rather than the labels it carries —
`loadLabelSchemaDoc` ([traverse.ts](../../packages/runner/src/traverse.ts))
follows the schema document and the label documents into the query result
and watch set, over `cfcEnvelopeLabelDocumentHashes`
([label-documents.ts](../../packages/runner/src/cfc/label-documents.ts)),
the one scan every seam applies — and the prepare pass's
self-minted-document scan asks only whether a write carried a `cfc` member
at all. An envelope those walks cannot make sense of delivers nothing extra,
and the reader that goes on to want its labels fails closed.

A new consumer adopts the rule by leaving `StoredCfcMetadataError` alone.

## Recovery

Two of the three errors are permanent for the stored bytes: an unknown
version and an unwalkable label map are properties of the document, and
reading again gives the same result until the document is rewritten or the
build advances. `UnresolvableCfcLabelDocumentError` is not, because the
label document it names may arrive by sync, so that failure is never
memoized and the read succeeds once the document lands. Resolution results
are memoized by the identity of the stored label map, never failures.

## Where this is pinned

- [cfc-envelope-version-guard.test.ts](../../packages/runner/test/cfc-envelope-version-guard.test.ts)
  — every reader refuses the same stored values, across the shapes an
  envelope can be damaged or postdated in;
  the commit path rejects a write whose target or read source carries one; a
  document storing nothing at the reserved position reads as unlabeled.
- [cfc-content-addressed-labels.test.ts](../../packages/runner/test/cfc-content-addressed-labels.test.ts)
  — a version-2 entry naming a label document nothing backs, one naming a
  document that does not hold a label, one whose content does not hash to
  its id, and a reference in a version-1 envelope.
- [cfc/verifier-metadata.test.ts](../../packages/runner/test/cfc/verifier-metadata.test.ts)
  — a transaction that consumed an uninterpretable envelope is refused even
  when its write target declares no gate.
