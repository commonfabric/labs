# Content-Addressed Schema Documents

Schemas carried by links and queries become references to content-addressed
schema documents instead of inline copies. A schema is decomposed at `$defs`
granularity: each definition that stands alone becomes its own schema
document, and definitions that reference each other cyclically stay together
in one document, so the cross-document reference graph is acyclic and every
document's hash is well-founded.

## Status

Design; the readers-first resolution infrastructure (Phase 0 of
[the implementation plan](../history/plans/content-addressed-schemas-phase-0.md))
has landed, and Phases 1 and 2 ship together behind the
`contentAddressedSchemas` flag (on by default): links, `$alias`
bindings, and a result document's `schema` metadata stamp references
with commits materializing each closure into
the destination space, and a selector normalizes for the wire — the
reference form only when its whole closure is confirmed persisted in
the target space, the fully inline form (recomposed through the realm
registry when the schema itself carries references) otherwise, and a
loud server error for a selector reference nothing backs. The
connection-scoped
transport experiment (`syncSchemaCasV1`, unmerged) is not being pursued;
this design is the storage-side successor for link positions, and a
reference at rest never needs transport compression. Code documents
(§ Code documents) share the namespace and its rules: the compile cache
stores each module's text as one, and its records link to them.

## Last Updated

2026-09-10

## Motivation

A link's `schema` field (`CellLinkRefPayload`,
`packages/runner/src/sigil-types.ts`) holds a complete, self-contained JSON
Schema — including its whole `$defs` closure — inlined verbatim into the
stored document. Nothing deduplicates it at rest. The same schema is
duplicated on three surfaces:

1. **At rest, per link.** Every schema-bearing link in a stored document
   carries a full copy. Prolific writers include every rendered VDOM prop
   link (`packages/html/src/worker/reconciler.ts`), pattern bindings, and
   result links. Narrowing multiplies the problem: `schemaAtPath` re-attaches
   the reachable `$defs` closure to every narrowed variant, so N views into
   one type store N overlapping closures.
2. **Client→server, per watch.** `SpaceReplica.#refreshWatchSet()`
   (`packages/runner/src/storage/v2.ts`) sends one watch spec per (doc,
   selector), each with the full inline selector schema. No compression
   exists in this direction, and a reconnect the server cannot resume
   re-sends the entire accumulated watch set — the payload grows
   monotonically with the session's document count.
3. **Server→client, per frame.** `syncSchemaTableV2` compresses link schemas
   into a hash-keyed table, but the table is frame-local: every schema body
   re-travels on every frame that references it. The
   `v2-sync-schema-table.test.ts` fixture shows schema repetition at over
   80% of frame bytes before compression.

Transport compression can only ever address surface 3. Surfaces 1 and 2
need
durable schema identity: a name that is valid in storage, in queries, and
across sessions. The system already has the pieces:

- **Schema hashing and interning** — `internSchemaAsTaggedHashString`
  (`packages/data-model-schema/src/schema-intern.ts`) produces a
  `fid1:` tagged hash; the intern table already gives structurally equal
  schemas one identity per process.
- **Content-addressed schema documents** — CFC persists schemas as
  `cid:<taggedHash>` documents (`ensureSchemaDocument`,
  `packages/runner/src/cfc/prepare.ts`) through the shared
  schema-document staging (registration, per-transaction dedupe,
  confirmed-persistence elision), with client-side hash verification on
  read and traversal support: the server's
  graph traversal synthesizes a link from the `cfc.schemaHash` field and
  includes the schema document in query results and watch sets
  (`cfcMetaToSigilLink`, `packages/runner/src/traverse.ts`).
- **Cycle condensation** — module identity hashing already condenses
  strongly connected components so import cycles hash as a unit
  (`computeModuleHashes`, `packages/runner/src/harness/module-identity.ts`).
- **A reserved namespace** — `REQUEST_SCHEMA_CAS_REF_PREFIX`
  (`packages/memory/v2/schema-table-links.ts`) reserves `schema-cas@1:` for
  transport; the storage-side counterpart is this design.

## Design

### Schema documents

A schema document is a `cid:` document whose value is a JSON Schema:

- **Id**: `cid:<taggedHash>` where the hash is
  `internSchemaAsTaggedHashString(schema)` — the same id and content rules as
  CFC schema documents, which become a special case of this mechanism rather
  than a parallel one.
- **Content**: `{ "value": <the schema> }`, exactly the CFC schema-document
  shape.
- **Write**: idempotent blind write (no read-before-write, per the
  `ensureSchemaDocument` precedent — a read-before-write turns concurrent
  installation of the same content into a false conflict), performed in the
  same transaction as the write that references it.
- **Per space**: a schema document must exist in every space that contains a
  reference to it, written there by whichever writer first references it in
  that space. Content addressing makes concurrent installs collide
  harmlessly.
- **Space scope only, by rule**: the commit boundary rejects a `cid:`
  write at any other scope. A scoped partition could hold a divergent
  copy under one content-addressed id, and the paths that read the
  store — delivery, traversal, and commit validation — resolve `cid:`
  documents at space scope. (Direct-registry reuse across spaces is
  hash-verified, so a divergent copy could never enter it.)

### Code documents

A code document is a `cid:` document whose value is a string: the authored
source of one module, or its compiled output. It is the second kind of
content the `cid:` namespace holds, and the larger.

- **Id**: `cid:<taggedHash>` where the hash is `taggedHashStringOf(code)`,
  the general `fid1` content hash of the string itself. Nothing but the
  string enters the hash, so two modules with identical text share one
  document however many records name it.
- **Content**: `{ "value": "<code>" }` and nothing else. No filename,
  identity, imports, or source map travels inside it; those stay on the
  record that links to it, and the document says nothing about where its
  text came from.
- **Write**: the same idempotent blind write as a schema document, through
  the transaction's `stageContentAddressedDocument`, which derives the id from the
  content it is handed, so a code document can never be installed under a
  hash its content does not produce. The record that links to it is written
  in the same transaction.
- **Verification**: the commit boundary re-hashes every `cid:` set's
  content against its id and refuses a mismatch, so nothing lands in the
  namespace that a reader cannot verify; a schema document's interned hash
  is the same value, so one rule covers both kinds. A reader re-hashes the
  string it resolves against the id the record's link names, so a document
  that reached a replica by another route holding other content is refused
  at load.
- **Per space, by the writer**: the compile cache installs a code document
  into the space of every record that links to it, in the same transaction
  as the record, so a piece's code loads from the space the piece lives in
  and no other space has to be reachable for it. That is a writer's
  practice, not a reader's rule: a link that names a code document in
  another space is a valid link, and a reader that follows one verifies
  the resolved string against the linked id exactly as it does within a
  space. No same-space guard applies on the read side.
- **No envelope**: a code document carries no `cfc` metadata. It is a
  runtime surface outside labeling, like a schema document: immutable,
  named by its content, and excluded from schema write policy and the flow
  join. A link written into a labeled record that names a `cid:` document
  records no link-write policy input, since the document can carry nothing
  a label would describe. Provenance stays on the record: the compile
  cache's runtime-minted integrity atom labels the record, whose link and
  map it covers, while the hash covers the bytes.
- **Retention**: permanent, as for every `cid:` document. Every code
  version ever compiled into a space stays there.

A record written before code documents existed holds its code inline as a
string, and readers accept both forms. Nothing rewrites an existing record;
only new writes use a code document.

### Label documents

A label document is a `cid:` document whose value is one canonical CFC
label, named by a version-2 CFC envelope's `labelMap` entry in place of the
label itself. It is the third kind of content the namespace holds, under the
same identity check (the general content hash of its value), the same
immutability and space-scope rules, and the same write-side and read-side
delivery guarantees, with the traversal's `cfc` seam loading each one beside
the envelope's schema document.
[content-addressed-cfc-labels.md](content-addressed-cfc-labels.md) is the
design.

### Decomposition

Decomposition turns one self-contained schema into a set of schema documents
whose cross-references form a DAG:

1. Start from the sanitized, interned schema as it would be written today
   (after `sanitizeSchemaForLinks`; sanitization order is unchanged).
2. Build the reference graph over the schema's `$defs` entries: an edge from
   definition A to definition B when A's subtree contains a `$ref` to B.
3. Condense strongly connected components (the `computeModuleHashes`
   precedent). Each component becomes one schema document:
   - A **singleton** definition (no cycle through itself) becomes a document
     whose value is the definition's schema itself. References to it use the
     bare document id.
   - A **cyclic group** becomes a document whose value is
     `{ "$defs": { <the group's members> } }`. Within the document, members
     reference each other with ordinary local `#/$defs/<name>` refs.
     References from outside use a fragment: `cid:<hash>#/$defs/<name>`.
4. Rewrite: within each document, refs to definitions in other documents
   become external refs; the `$defs` entries they replaced are removed. A
   singleton document carries no definition name — the definition's schema
   is the document — so structurally identical standalone definitions
   deduplicate regardless of what their schemas called them. Cyclic-group
   members keep their authored names (they come from TypeScript type names
   via the schema generator, which are stable across patterns that share
   types), because the internal `#/$defs/<name>` refs need them.
5. The **root** — the original schema minus its externalized `$defs` — is
   itself a schema document, and a reference to it is what the link or
   selector carries. A root or a definition that reduces to a single
   external reference and nothing else gets no document of its own: the
   reference binds straight to the target, so a chain of pure-ref aliases
   decomposes to the same closure as a direct reference, and decomposition
   stays canonical under recomposition.
6. External refs the input already carries — the normal case once narrowed
   schemas round-trip through storage — are resolved against the documents
   at hand (hash-verified) and included, transitively, in the returned
   closure, so "every document in the closure" holds for the writer that
   persists it.

Cyclic groups must stay together because a cycle split across documents
would make each document's content hash depend on the other's — content
addressing is only well-founded over an acyclic reference graph. This is the
same reason module identity condenses import cycles.

Because the external refs are part of a document's content, the reference
closure is a Merkle DAG: the root document's hash pins the exact content of
every document reachable from it.

An embedded schema ref — a URL in the runtime's static embedded-schema
table, such as the renderer's
`https://commonfabric.org/schemas/vnode.json` — is an allowed leaf inside
a document. Every realm resolves it from the same table, so it hashes as
ordinary document content and contributes nothing to the closure. The
embedded table is transitional: the expectation is that its residents
retire in favor of ordinary `cid:` documents, at which point the table
goes with them, while documents already carrying the URLs keep resolving
until then.

Decomposition refuses input it cannot represent faithfully — a `$ref`
outside the `#/$defs/<name>`, external, and embedded vocabularies, a
dangling local ref, a `$defs` below the root (the decomposed form carries
one definition map, at the root; the runtime's resolution rule for a
nested one is in `json_schema.md`), the deprecated `definitions`
keyword, the resource-scope keywords (`$id`, `$anchor`, `$dynamicAnchor`,
`$dynamicRef`, and the 2019-09 pair `$recursiveAnchor` and
`$recursiveRef`, whose scoping the rewrite cannot preserve), and an
external
ref whose document is not at hand — and a writer falls back to carrying
such a schema inline, as today.

An external ref is a `$ref` whose value is a `cid:` URI:

```jsonc
// A singleton definition document, referenced from a root schema:
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": { "$ref": "cid:fid1:abc…" },
    },
  },
}
```

```jsonc
// A cyclic group document (two mutually recursive definitions):
{
  "$defs": {
    "Folder": {
      "type": "object",
      "properties": {
        "children": {
          "type": "array",
          "items": { "$ref": "#/$defs/Entry" },
        },
      },
    },
    "Entry": {
      "anyOf": [{ "type": "string" }, { "$ref": "#/$defs/Folder" }],
    },
  },
}
```

Decomposition is deterministic and memoized on the interned input schema, so
repeated link writes carrying the same schema cost one lookup after the
first.

### References in links

`CellLinkRefPayload.schema` remains typed `JSONSchema`; a reference is
simply a schema whose only member is an external `$ref`:

```jsonc
{
  "/": {
    "link@1": {
      "id": "of:fid1:…",
      "path": ["items", "0"],
      "space": "did:key:…",
      "schema": { "$ref": "cid:fid1:xyz…" },
    },
  },
}
```

This keeps the payload type, the three schema-position walkers
(`mapLinkSchemas`, `findSyncSchemaRef`, `containsSyncSchemaRefString` — which
must all learn the new form in one change; the walker-agreement test in
`packages/memory/test/v2-sync-schema-table.test.ts` pins that), and the
schema-combination path structurally unchanged: a reference dereferences to
exactly the schema that would have been inline.

The write path (`createSigilLinkFromParsedLink` with `includeSchema`)
sanitizes as today, then decomposes, ensures the closure's documents exist
in the target space (same transaction), and stamps the reference.

`$alias` bindings (`AliasBindingBase.schema`) are pattern-binding
vocabulary, not links; they adopt the same reference form on the same
schedule as the link flip, which retires the standing "`$alias` schemas
travel inline indefinitely" carve-out in
`packages/memory/v2/schema-table-links.ts`.

### References in result-schema metadata

A stored document's reserved root member `schema`
(`EntityDocument.schema`, [the data model](memory-v2/01-data-model.md))
carries the document's own description: the result schema a piece's setup
writes for its result document, and the shape a receipt-only handling
writes for what it stored. It is a schema position in the link spelling,
with a grammar of exactly two forms:

- **Inline**: a self-contained schema carrying no `cid:` reference.
- **Reference**: a single-member `{ "$ref": "cid:<hash>" }` root, the
  `#/$defs/<name>` fragment form included.

An omitted member or `undefined` means no schema metadata. A member holding
`null` is malformed and is refused at the same write and read boundaries.

```jsonc
{
  "value": { "items": [] },
  "schema": { "$ref": "cid:fid1:xyz…" },
}
```

There is no third form. A `cid:` reference nested inside an inline schema,
or a root reference with sibling keywords, is refused wherever the member
is written or read — at the writer (the transaction refuses the write
before it stages), at the commit boundary (a `set`'s member, and the
post-patch document of any patch sequence whose pointers reach
`/schema`), and on the read side (result assembly fails the query, arrival
validation quarantines the document) for malformed state that predates
the enforcement or was written out of band. Keeping the grammar to two
forms is what lets a reader recompose a reference without merging two
schema-resource scopes.

The writer (`writeResultSchemaMeta`, `packages/runner/src/result-schema-meta.ts`)
decomposes the schema as a link writer does, registers the closure, and
stamps the reference; the transaction's schema-document staging reads the
`schema` member of a written document — or a write made at that member —
the way it reads a link position, so the closure travels with the
reference. A trivial schema (`{}`, `true`) stays inline, as on a link, and
so does a schema decomposition refuses. Unlike a link schema, the metadata
is not sanitized: it describes the document in full, `asCell` entries
included, which is what lets a reader recover a typed handle from it.

Readers take the metadata back in the inline form every consumer walks
(`readResultSchemaMeta`), recomposed through the realm registry once the
closure is complete there; a reference whose closure is not yet at hand is
returned as stored, and the read-time resolver fails closed on it until
the documents arrive. That is the one condition a reader tolerates: a
malformed member, or a recomposition that fails over a complete closure,
is a defect and throws. The CFC commit path, which reads the member
through its own transaction, resolves each closure document space-first
with content verification, the registry supplying only what the space
does not hold — the same read policy as a stored envelope root.

Every layer that collects a document's schema-document obligations reads
this member alongside its link positions: the commit boundary, result
assembly, and arrival validation. That includes every `cid:` document.
Content addressing hashes `.value` alone, so a document's `schema` member
is immutable and first-writer-wins under the `cid:` immutability rule
without being cryptographically bound to the id, and nothing
distinguishes a schema document from a blob whose value happens to be
schema-shaped — so no layer treats one differently from the other. A
document class that needs its schema bound to its identity puts the
schema inside its hashed value. A patch BELOW `/schema` edits inside a
stored schema, the same shape as the inside-a-link gap under Resolution,
and is left to read-side assembly the same way.

### References in selectors

`SchemaPathSelector.schema` accepts the same reference form. This is what
fixes the uncompressed client→server surface: a watch spec for a document
whose schema is already persisted carries `{ "$ref": "cid:…" }` instead of
the full schema, and reconnect re-sends references, not bodies.

The server validates root selector references BEFORE traversal begins:
every referenced document, transitively through its closure, must be
stored in the requesting space with content that verifies against its
id, and the validation reads through the query's manager, so a
historical query (`atSeq`) requires the closure to exist and verify at
that same sequence. A reference that fails this validation fails the
query loudly (a QueryError), never silently as an empty match — the
lenient logged-and-selects-nothing rule is for LINK schemas inside
delivered documents, where a broken declaration is corruption to note
and read past; an unresolvable selector reference is the query's own
naming, a client bug, and matching nothing would mask it. Past validation, resolution flows through the shared traversal
with the documents already registered. What remains for clients is
the sending half: a client may send a reference only for a schema
whose documents it knows are persisted in that space — one it wrote,
or one it received by sync — and sends the schema inline otherwise,
as today.

### Resolution

Reading a reference must produce the schema synchronously wherever schemas
are consumed today (traversal, narrowing, CFC label derivation). The
mechanism is a session-lifetime strong index warmed synchronously from the
local store at the reading seams:

- A **session schema registry**: a strong `Map` from tagged hash to interned
  schema. Populated from both directions: decomposition on the write path
  registers what it writes; sync registers every schema document that
  arrives. Retention is session-scoped through leases — every
  `StorageManager` holds one for its open lifetime, and the last lease's
  release clears the registry — so memory is bounded by the distinct schema
  documents the live sessions have seen, strictly less than the duplicated
  inline copies they replace; concurrent sessions share retention for the
  union of their lifetimes. A realm that never holds a lease (the memory
  server registers through traversal without one) retains for the process
  lifetime; its entries are a cache over its own store, so a size cap there
  is safe if ever needed — an evicted document is one local read away.
- `resolveSchemaRefs` (`packages/runner/src/cfc/schema-refs.ts`) extends
  from `#/$defs/<name>`-only to `cid:` refs (with optional `#/$defs/<name>`
  fragment), resolving through the registry. An unresolvable ref keeps the
  existing fail-closed contract: `resolveSchema` returns `false`, and
  traversal treats the value as unmatched.
- A cold miss is a REGISTRY miss, never a store miss: closure documents
  travel with their referrers, so the store backs every reference of a
  readable document, and the reading seams warm the per-process registry
  from the store synchronously before walking a schema
  (`ensureExternalSchemaClosure`; `loadExternalSchemaDocs` in traversal
  contexts). A reference the store cannot back is corruption or a
  deliberately malformed declaration — logged, with the declaration
  selecting nothing (the fail-closed contract above).

Verification happens at registration: a schema document's value is
re-hashed and must match its id (the `loadSchemaDocument` precedent);
a mismatched document is rejected and never enters the registry. Because
external refs are hash-covered content, verifying each document
individually verifies the whole closure against the root reference.

Every walk over a closure is one implementation:
`walkSchemaDocumentClosure` in `@commonfabric/data-model-schema`
(`schema-closure.ts`), whose `verifySchemaDocument` is the identity check
above. The walk owns the worklist, the dedupe, the verification of a
stored value, and the following of a verified document's own refs. A
site supplies where a document comes from and what a miss means, and
nothing else: the commit boundary resolves a hash against the commit's
own sets and then the store and refuses the commit on a miss; result
assembly and selector validation read through the query's manager at
its seq and fail the query; the traversal reads through the transaction
so the dependency is recorded, reports an absent document on the
missing-target channel, and lets the schema select nothing; the replica
resolves against the arriving frame before its store; the transaction
and the registry walk the realm registry, staging a document or
memoizing completeness. A site that already holds a document verified —
the registry, or a cache keyed by the document's version — hands it over
as verified and the walk follows it without re-hashing; a site that
holds a document and everything behind it settles the hash, and the walk
stops there.

The same identity check is the class test. `cid:` holds more document
classes than schema documents — blobs among them — and a delivery site
cannot name the class of a directly pulled document, so a document is a
schema document exactly when its id is the schema interning of its
value. Anything that passes is byte-for-byte usable as the schema
document that id names; anything else is another class, not a rejection
to warn about.

Content-addressed documents are immutable at the commit boundary:
`set` is the only operation the server admits against a `cid:` id,
whatever the document's class, and it rejects a `set` that is neither
the first installation nor content-identical to the stored document
(canonical value equality, which compares special objects by content
hash) — conflicting sets of one id within a single commit included —
because a deleted or altered dependency would invalidate every document
referencing it. Admitting one operation rather than naming the ones it
refuses is what makes an operation added to the protocol refused at this
boundary until someone decides otherwise: `delete`, `patch`, `apply-op`
and `release-op-field` are each refused today without the rule naming
them. An
idempotent re-`set` of the same content is how writers install closures
and stays legal — and it applies as a semantic no-op: the immutability
comparison proves the content unchanged, so the engine writes no
revision, advances no head, and marks nothing dirty, while the commit
row and space sequence still advance (a blind closure re-install costs
watchers nothing). A sync frame's removes are watch-result removals,
not deletions.

The commit boundary also validates the closure a commit's content
references: every schema ref introduced by a set's document, a patch's
own values, an installed schema document's own refs, any document's
reserved `schema` metadata member (`cid:` documents included), or the
`cfc.schemaHash` a document's stored CFC envelope names (in a non-`cid:`
set's value, or in the post-patch document of any patch sequence whose
pointers can reach the reserved `cfc` or `schema` member — a `cid:`
document's own `cfc` member is deliberately not a metadata position and
is never collected) must be backed —
in the same commit or already stored in the space — by a document whose
content verifies against its id, transitively through the closure. A
commit that references what it does not supply, or supplies content
that does not hash to its id, is rejected. The commit API therefore
cannot create a missing or forged closure for any reference this
collection sees; a broken closure that exists anyway — the patch shape
below, out-of-band tampering, or a store that predates this validation
— is a corrupt or deliberately malformed declaration. A reader logs it
and ignores it: the declaration selects nothing, which voids only a
reader that adopted it, while a reader with a schema of its own reads
on under reader precedence
([link-schema-precedence.md](link-schema-precedence.md)). The writer's
obligation to install the closure atomically with the referrer remains
normative — the boundary is its enforcement, not a substitute for it.

One patch shape escapes the collection: an edit INSIDE an existing
link's schema (replacing a `$ref` string at a sub-path) introduces a
reference no patch value carries as a whole link, and only a scan of
the post-patch document would see it — a cost the validation
deliberately does not pay. The gap closes when links become opaque
`FabricPrimitive` Link objects instead of patchable plain JSON; until
then such a reference is caught by read-side assembly rather than at
commit time.

Resolution demands the whole closure: a registered document whose
transitive closure is not fully registered resolves as a miss, exactly
like an unregistered document. Resolving it partially would let derived
results — an IFC scan, a path narrowing — be memoized over the hole,
keyed by the root's stable identity, and the missing child's later
registration would never invalidate them. Completeness is monotonic, so
the gate opens by itself once the closure registers; caches that memoize
derived results by schema identity populate only for schemas whose
external closure is complete.

### Space boundaries

A link's schema belongs to the space holding the link declaration. When a
document in space A links to a document in space B, the schema's `cid:`
references resolve in A, including their transitive closure. Before carrying
that schema into B, traversal and link resolution recompose it into a
self-contained schema. Path narrowing, target queries, and derived Cell
handles therefore do not require B to hold A's schema documents. A schema
declared by a link inside B resolves in B when that next link is followed.

A schema document's value is space-free: content addressing makes the
bytes identical wherever they are stored, so the realm-wide registry
shares one verified object across spaces, and using a shared value can
never produce a wrong answer. Document residency determines where a missing
closure is loaded, as described above. Two delivery guarantees keep those
documents available alongside their declarations:

- **The write-side guarantee.** The client that replaces an inline schema
  with a reference created the obligation, so it discharges it: the
  decomposed closure is written into the space that will hold the
  reference, in the same transaction as the reference itself. A
  transaction commits against one space's session, so the closure reaches
  whichever server handles that space by construction. `decomposeSchema`
  refuses to emit a reference whose closure the writer does not hold,
  and the commit boundary independently enforces the same obligation for
  raw commits that never went through it.
- **The read-side guarantee.** A query result is self-sufficient: every
  schema reference embedded in delivered documents resolves within the
  delivered set. Enforcement sits at the result-assembly boundary: after
  traversal establishes the documents being delivered, the server scans
  each complete document — a link schema anywhere in its value, its
  `schema` metadata member, or a delivered schema document's own refs —
  verifies each referenced
  closure against the delivering space's own store, and joins the whole
  closure to the delivered set and watch set. A missing or forged
  closure document fails the query loudly: the write-side guarantee
  installed closures with their referrers, so a hole here is a
  consistency bug the boundary surfaces. A reader that meets one
  anyway — tampering behind the boundary, a store predating the
  validation — logs it and reads on with the declaration selecting
  nothing, per the reader rule above; the boundary's loudness is what
  keeps that leniency safe. Scans are document-granular
  (delivery is), so no selected path can shadow another, and their
  results are cached per document version, so in steady state a version
  is scanned once however many sessions or refreshes deliver it.
  Traversal keeps its own gate where a schema enters it — the selector
  and a link: a schema whose closure the declaring space does not hold selects
  nothing, since selecting by an uncollectable schema would produce a
  result whose shape the receiving client could never reproduce from
  what arrives.
- **Elision across frames is the design, not a hole** (OW61 reversal,
  RULED 2026-08-24). The delivered SET spans frames: a session's later
  frames deliberately elide `cid:` documents earlier frames already
  delivered — not retransmitting schemas is why content addressing
  exists. The client's obligation is the mirror of that: absorb every
  frame the server sends, in order, retaining delivered `cid:`
  documents for the session's life; a frame is validated against the
  prospective frame PLUS the stored replica precisely because the
  replica is expected to hold what earlier frames delivered. An
  arrival whose ref cannot resolve therefore indicates a CLIENT-side
  absorb/ordering defect (a dropped, reordered, or un-retained earlier
  delivery) — the defect class OW61's investigation owns — never a
  server obligation to re-ship unprompted. What the client CAN do is say
  what it holds: on a reconnect it declares its holdings
  (memory-v2/04-protocol.md §4.1.2), and the server diffs against that
  declaration instead of its own memory of the session, so a `cid:`
  document the client never absorbed is delivered again while every one
  it holds stays elided — the elision design kept, with the client's
  statement in the server's memory's place.

Arrival mirrors the assembly pass rather than trusting it: BEFORE a frame
applies, every schema ref its documents embed — a registered `cid:`
schema document's own refs, a link schema anywhere in an ordinary
document's value, or an ordinary document's `schema` metadata member —
must reach a document the prospective frame or the
stored replica holds whose content passes the identity check. Verified
content, never mere presence: a forged local copy fails even when the
realm registry holds a valid twin from another space, and content that
changes under a previously verified `cid:` id fails outright. A broken
ref QUARANTINES the offending document (OW61's ACKed containment,
RULED 2026-08-24): that document is dropped from the frame with a loud
per-doc diagnostic and the replica keeps whatever it already held under
its id, while the frame's other documents apply — quarantining an
in-frame schema document re-checks refs that resolved through it, so
dependents fail closed together. Fail-closed for the DOCUMENT (an
unverifiable schema document never registers; a document with
unresolvable refs never applies; a forged replacement of a stored
verified document is itself the quarantined copy), contained for the
PROCESS: this validation runs on the background consume path, where a
frame-wide throw was an unhandled rejection that killed the consuming
worker wholesale on one bad document. Quarantine is containment for a
defect, not a protocol state: the elision design means an unchanged
quarantined document may never be re-delivered mid-session (the
server's session cache rightly claims the client holds its ref), so
the heal waits for the next reconnect — whose declared holdings omit
the quarantined document, so the server re-delivers it with its
closure — or the next watch.set, whose full frame carries the whole
assembled closure; the arrival diagnostic is the loud record meanwhile,
and the underlying absorb/ordering defect is the thing to find and fix
(OW61). The repair
paths that do exist serve callers, not arrival: the traversal loader's
reads are tracked (arrival re-runs the reader), the missing-target kick
requests the fetch, and any sync of a schema document delivers its
whole closure through result assembly — never satisfied by
realm-registry presence alone.

Walking delivered values is a transitional cost: the intended end state
moves each document's embedded-ref information into a meta field
maintained at write time, so assembly consults an index instead of
scanning content, with the per-version scan cache bounding the cost
until then.

Outside a traversal — direct runtime resolution of an already-read
schema — a reader MAY reuse an identical, hash-verified schema another
synced space in the realm supplied. That is value sharing working as
intended, and it is strictly a read-side recovery: it never satisfies or
repairs the write-side guarantee, a cold realm still fails closed, and a
traversal deliberately does not take it — traversal is where the
read-side guarantee is enforced, and its strictness only ever bites where
the write-side guarantee was violated, which is exactly where a loud
signal is wanted. The commit boundary's closure validation makes the
write-side guarantee server-checked for every commit, up to the one
patch shape documented under Resolution.

### Traversal and sync

The server's shared traversal already follows the `cfc.schemaHash` seam by
synthesizing a `cid:` link and adding the document to the query result and
watch set (`cfcMetaToSigilLink` / `loadLabelSchemaDoc`). Beyond that seam,
delivery and traversal split the work in two layers:

- **Traversal** loads the closure where a schema enters it — the selector
  and a link — because resolution during the traversal needs the
  documents at hand, and its availability gate (a schema whose closure
  the declaring space does not hold selects nothing) lives on the same reads.
  Traversal does not recurse into `cid:` documents.
- **Result assembly** owns delivery: it scans every complete document the
  query delivers — link positions and the `schema` metadata member —
  verifies each referenced closure against the space's
  own store, and joins it to the delivered set and watch set — failing
  the query on a hole. A refresh revalidates the established delivery
  state too, so a corrupted dependency fails even under an unchanged
  referrer. An assembly failure means the patch shape that escapes
  commit-time validation (see Resolution), out-of-band tampering, or a
  store predating that validation — never a transient condition, since
  the commit boundary validates every closure it collects and preserves
  every installed document. A
  request-shaped evaluation (watch installation, an initial query)
  answers its caller with the diagnostic as a QueryError; the fan-out
  refresh logs the failure and skips the affected session's frame,
  leaving the connection alone — the database was altered out of band
  (or the store predates commit-time validation), and that has no
  connection-level remedy. No frame from the failed pass is delivered
  and other sessions' fan-out proceeds; the failed session's incremental
  tracking state may be partially advanced, so it is marked for a full
  re-evaluation, and its next successful pass re-diffs everything. Under
  persistent corruption its delivery is simply suspended, with the log
  as the signal.

A client that syncs a document therefore receives the schema documents for
every link it contains in the same round trip, keeping the "resolved means
locally available" property. Schema documents are immutable, so their
presence in watch sets is quiet; whether they deserve a fetch-once path
instead is an open question shared with all `cid:` documents.

Scan results are cached per document version and engine, so in steady
state a version is scanned once however many sessions deliver it, and
closure verification memoizes per version the same way. The caches hold
one version per document and are bounded with wholesale eviction, so
alternating queries over historical versions, or a working set past the
bound, can rescan.

On the wire, a reference-bearing link is already small; the sync schema
table (`schema-ref@2:`) skips reference-only schema positions. Schema
document bodies travel once, as ordinary document upserts, and benefit from
any document-level caching.

### What this does not change

- **Link identity**: `areNormalizedLinksSame` and `addressKey` exclude
  schema today and continue to.
- **Schema semantics**: combination (reader precedence at link hops,
  pseudo-intersection for compound branches), narrowing,
  `additionalProperties` handling, and the CFC `ifc` vocabulary operate on
  the dereferenced schema and behave identically. `ifc` annotations are
  ordinary schema content, covered by the hash.
- **Sanitization**: `sanitizeSchemaForLinks` runs where it runs today;
  decomposition consumes its output. Distinct sanitization variants of one
  schema are distinct documents — their shared `$defs` closures still
  deduplicate, which is most of the byte win.
- **The memory engine's storage model**: schema documents are ordinary
  documents in the revision table, like every `cid:` document today.

## Migration

Experimental flag (`contentAddressedSchemas`, registered in
`docs/development/EXPERIMENTAL_OPTIONS.md`), phased on the op-migration
playbook:

- **Phase 0 — resolution infrastructure.** Session schema registry;
  `resolveSchemaRefs` learns `cid:` refs; verification at registration;
  traversal follows external refs out of schema documents. Readers can now
  handle references that nothing yet writes. The three memory walkers learn
  reference-only schema positions in the same change.
- **Phase 0.5 — commit-boundary enforcement.** `cid:` immutability
  (`set` the only admitted operation, and no differing re-set) and
  commit-time closure
  validation (every collected reference — all but the one patch shape
  documented under Resolution — is backed, in the commit or the space's
  store, by content that verifies against its id, transitively), landed
  with the readers so no writer flag can ever produce a reference the
  boundary would not accept.
- **Phase 1 — write references on links (flag-gated).** Decomposition +
  same-transaction document installs; links carry references, and so
  does a result document's `schema` metadata. Old inline
  links keep reading forever — links rewrite on every re-instantiation, so
  inline forms age out without a data migration, and an inline `schema`
  member rewrites the next time its piece's setup runs. A canary pins the
  inline vintage.
- **Phase 2 — clients send references in selectors, and `$alias`
  bindings shed their embedded schemas.** Watch specs and one-shot
  queries carry references for persisted schemas. The server side
  already ships with Phase 0 — selector schemas resolve through the
  shared traversal, per space, under the availability scope — so the
  selector half is the client emission plus the loud protocol error for
  an unresolvable selector reference. Measured traffic puts selector
  schemas at roughly six percent of mixed pattern-test bytes with over
  seventy percent repetition, and higher in watch-heavy interactive
  sessions. The `$alias` half is not a traffic win (under half a
  percent measured) — it is a representation fix: an embedded schema
  can carry `FabricValue` defaults, which puts special objects inside
  otherwise plain binding records; a reference keeps binding objects
  plain JSON and confines schema content to schema documents. An alias
  is a binding only by CONTEXT: to the storage layer an `$alias`-shaped
  record is plain data, so no commit-boundary, materializer, arrival,
  or assembly walk treats its `schema` member as a schema position — a
  document that merely looks like a binding can neither fail a commit
  nor fail a query over a reference inside it. A binding's reference is
  emitted by the pattern serializer and resolves through the realm
  registry; a reader that cannot resolve it degrades to the schemaless
  binding it would have had before schemas were stamped at all.
- **Phase 3 — retire transport compression for link positions.**
  `syncSchemaTableV2` stops matching
  anything on link positions once reference-bearing links dominate; the
  `$alias` carve-out retires with the alias flip. Transport compression for
  inline selector schemas from old clients remains until the protocol
  version floor passes Phase 2.

## Test plan

- Decomposition: property tests that recomposition (inline expansion of the
  closure) round-trips to the sanitized input; SCC grouping pinned on
  fixtures with self-cycles, mutual cycles, and diamonds; determinism across
  key order.
- Dedup: the `v2-sync-schema-table.test.ts` fixture (256 schema copies per
  frame) rewritten against references asserts bodies travel once per
  session, not once per frame.
- Fail closed: a forged schema document (content not matching id) never
  enters the registry; a query with an unresolvable selector reference
  errors loudly; a link with an unresolvable reference is logged and its
  declaration selects nothing — voiding a reader that adopted it, while a
  reader with a schema of its own reads on under reader precedence.
- Round trip: a piece written with reference links, resumed in a fresh
  session, resolves schemas through sync alone; the same with a cold
  registry exercises the store-backed registry warming.
- Walker agreement: the existing mechanical test extended to
  reference-only schema positions.

## Open questions

1. **Small-definition threshold.** A `{ "type": "string" }` definition as
   its own document costs more in envelope and round-trip bookkeeping than
   it saves. Start with unconditional decomposition (simplest, canonical),
   measure, and only then consider an inline-below-N-bytes rule — a
   threshold changes document identity, so it must be part of the
   decomposition's versioned contract, not a tuning knob.
2. **Server-side integrity enforcement.** Resolved for content: the commit
   boundary rejects mutations of `cid:` documents, refuses every `cid:` set
   whose content does not hash to its id — a first installation nothing
   references included — and validates the referenced schema closure
   (presence, transitively) for every commit. What remains is the one
   documented patch shape: a reference introduced by a patch that edits
   inside an existing link's schema escapes commit-time collection, and
   read-side assembly is what catches it.
3. **Fetch-once for immutable documents.** Every pull is a watch add, so
   schema documents permanently grow the session watch set even though they
   can never change. Quiet but not free; a fetch-without-subscribe
   primitive for `cid:` documents would benefit blobs and module sources
   equally.
4. **Garbage collection.** Nothing collects unreferenced documents today;
   schema documents accumulate like `pattern:` and CFC `cid:` documents do.
   Net bytes still fall (each document replaces many inline copies), so
   this stays in the existing GC-design bucket rather than blocking here.
5. **Definition naming.** Singleton documents are name-free and so
   deduplicate name-independently; only cyclic-group members keep their
   authored names, so two structurally identical cyclic groups with
   different member names are different documents. Acceptable (names are
   stable per shared TypeScript type); canonical renaming inside groups
   would buy marginal dedup at real debuggability cost.
