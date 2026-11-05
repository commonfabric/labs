# Content-Addressed CFC Labels

A labeled document's stored CFC envelope names each label it carries by
content hash instead of copying the label inline: every `labelMap` entry
keeps its `path`, `origin`, and `observes` inline and holds its `label`
either as the label itself or as a reference to an immutable `cid:` label
document that any number of entries, maps, and tables share.

## Status

Design and implementation, behind the `cfcContentAddressedLabels` runtime
flag (off by default). Readers interpret both envelope versions; the flag
decides only which spelling the persist path writes.

## Last Updated

2026-09-15

## Motivation

Every labeled entity document stores its whole CFC envelope
`{ version, schemaHash, labelMap }` at its reserved `cfc` member, and every
revision row copies it again. In one real store the envelopes of chat-row
entities dominate the bytes:

| Measured on 196k labeled entities (latest 200k head rows) | |
|---|---|
| value bytes per entity | ~465 |
| envelope bytes per entity | ~5.2 KB (p50 4.9 KB, max 5.8 KB) |
| envelope share of live JSON | ~93% |
| `labelMap.entries` per map | 1–9 (5, 8, or 9 for message-row tables) |
| bytes per entry | ~790, of which `path`+`origin`+`observes` ~25 and `label` ~620 |
| distinct envelopes / labels / clauses across the sample | 11 / 6 / 7 |

Each `label` is `{ confidentiality: [3–4 clauses], integrity: undefined }`
and each clause is 58–317 bytes. The same six label values recur across
196k documents. The schema half of the envelope is already content
addressed (`schemaHash` names a `cid:` schema document,
[content-addressed-schemas.md](content-addressed-schemas.md)); the label
half is what remains inline.

## Granularity

Four candidate granularities, measured on a fixture built to the shape
above: 8 entries, 6 distinct labels drawn from 7 distinct clauses
(117–258 bytes each), labels of 562–729 bytes, one 414-byte value. A
`cid:` reference is 63 bytes (`{"$ref":"cid:fid1:<43 chars>"}`), and each
stored `cid:` document is charged ~120 bytes of row overhead beside its
content. Store-wide totals extrapolate to 196k entities sharing 11 maps
and 6 labels, as measured.

| Option | Envelope bytes per entity | Shared documents, once per space | Store total |
|---|---|---|---|
| inline (today) | 5588 | 0 | 1095 MB |
| (a) whole map by reference | 152 | 11 maps, 62 KB | 30 MB |
| (b) inline map, labels by reference | 1132 | 6 labels, 4.2 KB | 222 MB |
| (c) inline map, clauses by reference | 2765 | 7 clauses, 2.0 KB | 542 MB |
| (m) map by reference, map references labels | 152 | 11 maps + 6 labels, 17 KB | 30 MB |

What the numbers say:

- **Clause-level references lose.** A clause is 60–260 bytes, so
  replacing one with a 63-byte reference saves little, and a label of four
  references costs 274 bytes of references plus its own object framing.
  Option (c) keeps 2.5× the bytes of (b) while adding a resolution hop
  per clause. A Merkle variant in which label documents reference clause
  documents saves 2 KB of shared bytes per space and nothing per entity;
  it is not worth a third document class.
- **Label-level references remove 80% of envelope bytes** and are the
  unit that reuse actually happens at: 6 label values serve 196k
  documents across several tables, and a map that introduces one new
  label writes one new ~600-byte document while every other entry keeps
  its existing reference. Paths and origins stay readable without
  resolving anything, and the applies-to-path probe that runs on every
  write reads only them (`readStoredCfcLabelPaths`), so the hot path pays
  no label-document read; consumers that need the labels themselves
  resolve them once per distinct document.
- **Map-level references are 7× smaller again at rest**, because the
  measured store repeats 11 maps across 196k entities. They cost a second
  reference level on every seam (commit validation, traversal, client
  sync, and every metadata read), a two-hop cold sync (the map document
  must arrive before its label references are known), and their saving
  depends on whole-map repetition, which per-document flow labels erode
  while label-level sharing survives it.

The choice is **(b)**: the map stays inline and labels are referenced.
Option (m) is a pure addition on top of it — a later envelope version
whose `labelMap` is a reference to a document holding exactly the (b)
map — and is the follow-on to measure once (b) has landed and the
residual is known; nothing in (b) is wasted by it.

### The inline threshold

Not every label earns a reference. A label whose canonical JSON is short —
`{ "confidentiality": ["secret"] }` is 30 bytes — costs more as a
reference (63 bytes plus a document) than inline. A label is stored by
reference when its canonical serialization exceeds
`CFC_LABEL_INLINE_LIMIT` (128 bytes: two references' worth, above which
the saving is at least half the label) and inline otherwise. Inline and
referenced labels coexist in one map, which is exactly the "new small
label beside existing referenced ones" case.

The rule is canonical by construction: it is a pure function of the
label's canonical content and the format version, so the same label takes
the same form wherever it is written and hashes to the same document.
Correctness does not depend on that — a reader accepts either form for
any label, and the idempotence check compares resolved labels — but
deduplication does: two spellings of one label would be two forms in the
store rather than one document. The limit is therefore part of the
versioned envelope contract, not a tuning knob.

## Design

### Envelope version 2

```jsonc
{
  "version": 2,
  "schemaHash": "fid1:…",
  "labelMap": {
    "version": 1,
    "entries": [
      {
        "path": ["messages", "*", "text"],
        "origin": "declared",
        "label": { "$ref": "cid:fid1:…" },
      },
      {
        "path": ["title"],
        "origin": "derived",
        "label": { "confidentiality": ["room-title"] },
      },
    ],
  },
}
```

Version 1 is the fully inline form. Version 2 differs in one respect: an
entry's `label` is either an inline label or a single-member
`{ "$ref": "cid:<hash>" }` reference. A reference has no sibling keys and
an inline label never carries `$ref`, so the two are told apart by the
key alone. `version` is the gate: a build that predates version 2 fails
closed on it through `UnknownCfcMetadataVersionError`, which is the
behavior the version field exists for, and why the writer is flagged
rather than flipped.

### Label documents

A label document is a `cid:` document whose value is one canonical label:

- **Id**: `cid:<taggedHashStringOf(label)>`, the general content hash the
  commit boundary verifies every `cid:` set against. Nothing but the label
  enters the hash.
- **Content**: `{ "value": <label> }`, the shape every `cid:` document has.
  The label is canonical: `confidentiality` clauses normalized
  (`canonicalizeCfcLabel`), members that are `undefined` dropped, and
  nothing else — so a label with `integrity: undefined` and one without
  the member are one document.
- **Write**: staged through `stageContentAddressedDocument` in the same
  transaction as the envelope that references it, which derives the id
  from the content (a document can never be installed under a hash its
  content does not produce), dedupes per transaction, and elides a
  document the space's server has confirmed.
- **Per space**: a label document exists in every space holding an
  envelope that references it, installed by the first writer to reference
  it there. Space scope only, as for every `cid:` document.
- **Immutable and permanent**: the `cid:` rules apply unchanged. Nothing
  collects unreferenced label documents; there are as many as there are
  distinct labels, which is what the measurement shows to be small.
- **No envelope of its own**: like a schema or code document, a label
  document is a runtime surface outside labeling.

### Resolution

Every consumer of a stored envelope works on the resolved form — the
version-1 shape, labels inline — so the merge and join paths
(`data-updating.ts`, `cfc.ts`, the prepare merge loop) are unchanged.
`readStoredCfcMetadata` and the prepare path's `storedMetadataFor` return
resolved metadata; the stored spelling is visible only to the persist
loop, which needs to know which version a document holds.

Resolving an entry's reference reads `cid:<hash>` at space scope through
the same transaction, records the read as an internal verifier read (the
policy the `cfc` read itself follows), verifies the value's content hash
against the id, and registers the verified label in a realm-wide label
registry. A document the replica does not hold resolves through the
registry, which holds only content verified at registration, so a
registered copy is the stored document; the registry shares the schema
registry's lease-scoped retention. A reference that neither the space nor
the registry can back throws `UnresolvableCfcLabelDocumentError`.

Resolved metadata is memoized by the identity of the stored `labelMap`
object: content addressing makes a resolution result permanent for the
bytes it was computed from, and a failure is never memoized.

### Fail-closed

Every reader fails closed on an unresolvable label the way it fails
closed on an unknown version; [the stored CFC
envelope](cfc-stored-envelope.md) states that rule in general. The three
stored-envelope errors —
`UnknownCfcMetadataVersionError`, `UnreadableCfcMetadataError`, and
`UnresolvableCfcLabelDocumentError` — share the base
`StoredCfcMetadataError`, and each consumer that rethrows the version
error rethrows the base: the applies-to-path probe reports that policy
applies, the dereference label view throws rather than serving an
unlabeled view, a link write from such a source stays CFC-relevant and
is refused at prepare, and the commit path classifies the envelope as
`unreadable` and rejects the write in enforcing modes.

The commit boundary makes the write-side obligation server-checked: a
commit whose envelope references a label document that is neither
included in the commit nor stored in the space, or whose content does not
hash to its id, is refused with a protocol error, exactly as a dangling
`schemaHash` is. The reference is collected on the same scan that collects
the schema reference: from a non-`cid:` set's `cfc` member, and from the
post-patch document of any non-`cid:` patch that can reach it. A `cid:`
document's own `cfc` member is not a metadata position, as for the schema
reference.

### Availability wherever the entity is

A label document must be at hand wherever its envelope is read, and the
read must be synchronous, so the document travels with the entity:

- **Traversal.** The shared traversal's `cfc` seam, which loads the
  schema document an envelope names into the query result and watch set,
  loads every label document the envelope references the same way: each
  enters the schema tracker (so an absent one is delivered when written)
  and is read through the transaction. A client that syncs a labeled
  document through a query receives its label documents in the same round
  trip.
- **Direct loads.** A `syncCell` load, which pulls the envelope's schema
  document after the document arrives, pulls its label documents too, in
  parallel with the schema document.
- **Arrivals.** A frame that delivers a document's envelope without a
  document it names — a label the writer introduced to the space in the
  same commit — kicks a pull of that document, exactly as the arrival
  hydration does for the schema document, so a reader that fails closed on
  the first read resolves once it arrives.
- **Writers.** The persist loop stages every referenced label document
  into the transaction that writes the envelope, so the commit carries
  what it references, and the boundary refuses it otherwise.
- **Same-session reads.** The label registry supplies a document this
  session verified — wrote, or received by sync — when the replica does
  not hold it, which is the same read policy the schema registry gives
  `schemaHash`.

### Idempotence and the merge loop

The persist loop's idempotence check compares the canonical form of the
re-derived metadata with the canonical form of the resolved stored
metadata, so a rerun that derives the same labels writes nothing whatever
spelling the document holds. Canonicalization drops `undefined` label
members so that a label resolved from a document (which never carries
them) compares equal to a freshly derived one (which may).

One exception to "equal means skip", in one direction: when the flag
selects version 2 and the stored envelope is version 1, the envelope is
rewritten in version 2 even though its labels are unchanged. That is how
an existing store migrates — each document rewrites at most once, on its
next persist — without a data migration. A stored version 2 is left alone
by a writer with the flag off, so writers on either setting that share a
document do not rewrite it at each other.

## Migration

- **Readers first.** Both versions read; an envelope of either version
  resolves to the same metadata. Ships regardless of the flag.
- **Writers behind `cfcContentAddressedLabels`** (registered in
  [EXPERIMENTAL_OPTIONS.md](../development/EXPERIMENTAL_OPTIONS.md)). Off,
  the persist path writes version 1 and leaves a stored version 2 as it
  is. On, it writes version 2, stages the label documents, and rewrites a
  version-1 envelope it would otherwise leave alone. The flip is gated on deployment reach: a reader that
  predates version 2 fails closed on a version-2 envelope, which is
  correct and also unusable, so every deployed reader must interpret
  version 2 before any space sees one.
- **No data migration.** Version-1 envelopes read forever and age out as
  documents persist.

## Test plan

- Bytes per labeled entity, before and after, on the fixture above:
  the stored version-2 envelope is a fraction of the version-1 envelope,
  and the label documents it references total the distinct labels.
- Round trip: a version-2 envelope written by the persist loop resolves
  through `readStoredCfcMetadata` to the same metadata the version-1
  writer produces; a second document sharing the labels stages no new
  documents.
- Threshold: a short label stays inline in a version-2 map beside
  referenced long ones.
- Fail closed: a version-2 envelope whose label document is absent throws
  from the reader, reports applies-to-path, fails the dereference view,
  and rejects an enforcing write; the commit boundary refuses a commit
  referencing an absent or forged label document.
- Flag off keeps version 1; flag on rewrites a stored version-1 envelope
  on its next persist and then holds still.
- Traversal: a labeled document's label documents enter the schema
  tracker beside its schema document.

## Follow-on

The map-level reference (option (m)) as a version-3 envelope whose
`labelMap` is `{ "$ref": "cid:…" }` naming a document that holds the
version-2 map. Measure the residual envelope bytes after (b) is deployed
and the revision-row multiplier before deciding; the commit boundary,
traversal, and client sync each gain one more level of the same walk.
