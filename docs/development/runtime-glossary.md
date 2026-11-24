# Runtime Glossary

Storage and memory internals of the Common Fabric runtime. Pattern authors
rarely need these terms — for author-facing concepts see the
[main glossary](../common/concepts/glossary.md).

The full treatment is [the memory v2 specification](../specs/memory-v2/README.md);
this page gives the vocabulary a reader of `runtime/runner/src/storage/` needs
to follow the code.

## Entity document

The unit of storage: a JSON document naming one entity, holding the [cell]'s
payload under its `value` field. A document is addressed by an entity
identifier — a URI, usually a hash derived from the cell's creation context
with an `of:` scheme prefix — and that identifier stays stable while the
document's contents change.

## Seq

The sequence number ordering every write in a [space]: a Lamport clock, so a
higher `seq` means a later write. Reading an entity at a given `seq` gives its
state at that point in the space's history.

A document's history is keyed by branch, entity identifier and `seq`. There is
no chain of parent hashes linking one version to the next; ordering is the
sequence number alone.

## Scope

Which instances of a document exist side by side. A `space`-scoped document is
one document shared by everyone. A `user`- or `session`-scoped document exists
once per principal or per session, partitioned inside the store rather than
filtered on read, so isolation does not depend on every query remembering to
ask for it.

## Memory

The abstraction over a [space]: an information system in the style of
[The Value of Values], giving efficient access to the current state of each
entity while retaining the history that state was reached through.

New information accretes through commits, whose optimistic concurrency is
described under [confirmed and pending](#confirmed-and-pending) below.

## Link

A reference from one place in stored data to another. There is one link form,
the sigil link `{ "/": { "link@1": { … } } }`, and it always addresses a
document that exists: it carries the document's identifier, and a read or a
write through it lands there. A link whose payload sets `overwrite: "redirect"`
is a **write redirect**, meaning a write through it lands at the target rather
than replacing the link.

[Identity and References](../specs/space-model/3-identity-and-references.md)
specifies the format; `runner/src/link-types.ts` defines it.

## `$alias` Binding

A record of the form `{ "$alias": { … } }`, found inside a saved pattern node
graph. Despite the resemblance to a write redirect, this is **not a link**, and
none of the link predicates match it: an `$alias` record sitting in ordinary
data is ordinary data.

A binding carries no document identifier. It names a position that acquires a
document only when the pattern graph is instantiated — by role
(`cell: "argument"`, `cell: "result"`), by derivation (`partialCause`), or at a
nesting level not yet reached (`defer`). Instantiation resolves it into an
ordinary write-redirect link. `runner/src/alias-binding.ts` defines the form
and says why it stays separate from the link model.

## Commit

A batch of operations submitted together, carrying the operations themselves,
the set of documents the transaction read, and any preconditions that must
hold. An operation is one of `set` (replace a document), `patch` (edit one),
`delete` (write a tombstone), or `sqlite` (fold a SQLite statement into the
same transaction).

The server accepts a commit if the documents in its read set have not moved on
since the transaction read them, comparing sequence numbers. Otherwise it
rejects the commit as a conflict and the client retries against the newer
state.

## Confirmed and pending

The two tiers a client holds for each document. **Confirmed** is the state the
server has acknowledged. **Pending** is the queue of local commits applied
optimistically but not yet acknowledged, so the interface reflects a change the
moment it is made rather than a round trip later.

A read sees the pending versions layered over the confirmed one. When the
server acknowledges a commit, its pending version retires and the confirmed
state advances. When the server rejects one, the pending version is dropped
along with anything built on top of it, so nothing accumulates on state the
server refused.

[cell]: ../common/concepts/glossary.md#cell
[space]: ../common/concepts/glossary.md#space
[The Value of Values]: https://www.youtube.com/watch?v=-I-VpPMzG7c
