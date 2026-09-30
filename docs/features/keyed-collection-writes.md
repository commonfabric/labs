# Keyed-collection mergeable writes

Status: implemented. This extends the whole-value mergeable ops (append,
add-unique, increment, remove-by-value — see `mergeable-collection-writes.md`) to
the read-then-write patterns those ops do not cover on their own: insert a record
if its key is new, set my per-key value, edit a field of the record with a given
key, delete the record with a given key. The driving example is the lunch poll,
whose handlers are almost entirely keyed mutations of lists of records; it is
migrated to this approach as the worked example.

For how to change an existing handler over to keyed addressing, and the mistakes
that make such a migration look finished while it is not, see
[migrating-collection-writes.md](./migrating-collection-writes.md).

## The lunch poll's read-then-write inventory

Every list-mutating handler in `packages/patterns/lunch-poll`, by what it
mutates and the form it uses. The poll is the worked example because a lunch
decision is the contended case: everyone votes at once, on the same list.

| Handler | What it mutates | Form |
| --- | --- | --- |
| `addOption` | insert an option if its id is new | set the option entity by id, `addUnique` it |
| `setOptionImage` | edit one field of the option with a given id | edit the field on the option entity addressed by `id` |
| `removeOption` | remove an option, then its votes | `removeByValue` the option by id; cascade `removeByValue` each vote by its key |
| `castVote` | upsert by `(voter, option)`, with toggle-off | read/edit the vote entity by key; `addUnique` on the cast that first stores a vote, `removeByValue` on the toggle-off |
| `clearMyVote` | remove by `(voter, option)` | `removeByValue` the vote by key, then clear its entity |
| `resetVotes` | clear every vote (host only) | clear each vote entity, then `set([])` — an intentional overwrite |
| `logVisit` | append a visit, then cap the log | one read-modify-write `set` — the cap is derived from the list |

The bulk are **keyed** mutations of a list of records: insert-if-new, set my
value, edit a record's field, delete a record. Written as read-whole-list,
find-by-a-field, splice/replace-by-position, write-the-whole-list-back, they
false-conflict and clobber under the concurrency a shared multi-user poll has,
and the positional `key(idx)` is fragile: the index is resolved against the
reader's snapshot, so a concurrent insert or remove shifts it and the wrong
record is edited.

A vote's key is `(the voter's profile entity, the option id)`, minted by
`voteKeyFor` in the poll's `main.tsx`. Identity there is a profile CELL rather
than a name, and a cell is not a string, so the key takes the entity the cell
points at. That keeps the key computable from the event alone, which is the
property the whole scheme rests on: a handler that had to search the list for
its voter would put the list back in its conflict set and give up the merge.

`packages/patterns/integration/lunch-poll-keyed-votes.test.ts` holds the poll
to this. It has one session read another session's vote at that address, which
only succeeds if the vote was stored as a keyed element — the tally reads the
same either way, so nothing lighter than an address can tell the two apart.

## The model: a keyed element is a separately-addressed entity

A list element that is an object becomes its own entity (the array holds a link to
it). The key idea is to make that entity's address **deterministic and
content-only**, derived from a key the handler can compute without reading the
list:

- `arrayCell.elementById(idKey)` returns a cell for the entity derived from the
  array and `idKey`. The derivation is `createRef({ id: idKey }, { parent: <the
  array's entity>, path: <the array's path> })` — it folds in no per-event cause,
  so the same `idKey` resolves to the same entity in any session, at any time.

Given a stable address, the keyed mutations decompose into the whole-value
mergeable ops plus plain entity edits:

- **Insert-if-new** — `set` the entity's content, then `array.addUnique(entity)`.
  `addUnique` dedups by link, so re-adding the same key is a no-op and concurrent
  adds of the same key resolve to one membership entry; adds of different keys
  merge.
- **Set my value** — the same: `set` the entity (last-writer-wins per key), then
  `addUnique` to ensure membership.
- **Edit a field** — `array.elementById(key).key("field").set(value)`. This writes
  the *entity's* document, not the array, so it never touches the list. Two edits
  to different fields of the same record merge (path-scoped conflict detection);
  same field resolves last-writer-wins; edits to different records never interact.
- **Delete** — `array.removeByValue(array.elementById(key))`. `removeByValue`
  matches the membership entry by link and is idempotent, so concurrent deletes of
  distinct keys merge. It stays mergeable as long as the removals are the
  transaction's only change to *that array* — editing a keyed element writes the
  entity document, so it does not count, but rewriting the list in the same
  handler falls the path back to a whole-array diff (see
  `mergeable-collection-writes.md`).

The lunch poll derives a vote's key from the voter's profile entity and the
option id, and an option's key from its generated `id`; castVote, clearMyVote,
and the removeOption cascade all recompute the same key through `voteKeyFor`,
so they reach the same entity without scanning the list.

## Why this instead of server-side keyed ops

An earlier design added four key-aware server ops — `insert-unique`, `upsert`,
`set-by-key`, `remove-by-key` — each carrying a list of key field paths the server
would extract and compare. Deterministic addressing makes that machinery
unnecessary:

- The identity lives in the **link** (the deterministic entity id), so the
  server's existing value-equality `add-unique` and `remove-by-value` already
  dedup and remove *by identity* when the value is a link — no key extraction on
  the server, no new op kinds.
- "Set my value" and "edit a field" become plain writes to the keyed entity's
  document. Path-overlap conflict detection already merges concurrent writes to
  different fields and resolves same-field writes last-writer-wins, so there is
  nothing to add for the update case.
- Removal by a non-identity field (the removeOption → votes cascade, "remove every
  vote for this option") is the one shape deterministic addressing does not turn
  into a single op. It is handled by reading the list to enumerate the matching
  keys and issuing one `removeByValue` per key. That read is retained in the
  conflict set, so a concurrent change to the vote list makes the cascade conflict
  and retry — catching a vote cast for the option after the read.

The cost is that the key must be derivable by the handler (it is, for the poll),
and that two different real-world entities must not collide on a key (the poll's
keys — a vote's `(voter, option)` and an option's generated id — do not).

## Conflict and merge semantics

| Concurrent pair (same key) | Result |
| --- | --- |
| addUnique / addUnique | one membership entry (dedup by link) |
| entity set / entity set, different fields | both fields set (merge) |
| entity set / entity set, same field | last applied wins |
| removeByValue / removeByValue | removed once (idempotent) |
| addUnique (or set) / removeByValue | server-arrival order — the later op wins |

The last row carries the add-wins-after-delete tension documented for `append`: a
remove and a concurrent stale add resolve by arrival, so an add that lands after a
remove resurrects the key. This is the price of never conflicting; a handler that
needs delete to win must keep a read-modify-write `set`.

Like the whole-value ops, a keyed op drops only the reads its own write issues
(the list value and the `["cfc"]` policy label), so operations on different keys
do not false-conflict. The op's touched path for *other* readers stays the array
path, so a reader of the whole list is still invalidated.

### What a keyed operation reads besides the record it writes

A keyed edit that changes no membership writes fields inside the record's own
document, and two such edits to different records never interact. It is not
free of the collection, though: three reads ride along, and each is a way for a
keyed operation to be refused.

**The collection's own link, under every keyed access.** `elementById` derives
its address by resolving the collection's link, and the sigil probe that
resolution makes — `resolveLinkTracingDereferences` in
`packages/runner/src/link-resolution.ts`, tagged `linkResolutionProbe` — is
recorded as a read at the collection's path plus the probe's sub-path. So even
a bare `elementById(key).set(...)` — no `addUnique`, no scan, nothing that
touches membership — commits against the collection. Its conflict set is three
addresses, one of them `<collection>/value/<member>///link@1`.

The probe is a shape observation of link topology, and both of its other
consumers treat it as one: flow-label derivation classifies it as a `followRef`
that consumes the pointer's own label and never the target's content label, and
reactivity deliberately keeps it a content read so a link appearing later
re-resolves. The commit's conflict set is the third consumer and reads it
strongly, which nothing chose.

Nothing chose it is not nothing depends on it, and the difference is a path.
Whether the collection's own slot holds a link does not depend on how many
members the collection has, so a probe there survives any membership change
intact — that is the case `elementById` makes and the one worth narrowing. A
probe at an indexed slot beneath it is a different matter: `removeByValue`
writes the filtered array, so every element after the removed one shifts down
and the link at a given index is not the link that was there. A resolution
that followed such a slot has an address that really did depend on the
collection's content, and the strong read is what would catch a concurrent
change to it. Narrowing every probe by its observation class alone would take
that away with it.

Any write that changes the collection's membership refuses that commit, in
either direction and mergeable or not: an `addUnique` that adds, a
`removeByValue` that removes, a whole-list `set`. A write that only replaces
one member's value does not. So keyed addressing narrows what a write depends
on, and it does not take the collection out of the picture: two people writing
different records still contend whenever a third adds or removes one.

**Every element's link.** `addUnique` and `removeByValue` match candidates with
`areLinksSame`, resolving each element's link, and resolving one reads that
element's document at its link path. Those reads are on the element documents
rather than on the array, so the array-read exclusion above does not cover
them. A write inside an element document sits below the link path and does not
disturb them; replacing an element document's whole value — `set(undefined)`
when clearing a removed record, per the section on that below — sits at it and
refuses every commit holding one. So two removals in flight at once collide on
the records they both scanned, and the record being cleared need not be one
either of them was removing.

**The array, when `addUnique` has nothing to add.** `addUnique` reads the array
first, finds its candidate already present, and returns before
`recordMergeableOp`. The exclusion above drops a read only for an entity
carrying a recorded op, so that read stays. An upsert of a record already in
the collection therefore commits against the whole collection, and any write of
the collection document — a `removeByValue`, an `addUnique` that does add, a
whole-list `set` — refuses it, while the commit that made the membership
change is not refused on this account, its own array read having been dropped.

`packages/patterns/integration/lunch-poll-keyed-votes.test.ts` pins the free
case and the boundary either mechanism crosses. Its burst recasts only, holds
the collection's membership still through every round, and requires that no
commit refused while it ran wrote the collection — the question a count of
rolled-back writes cannot answer, since that count is every write a session
threw away, whatever refused it.
`docs/history/features/keyed-collection-contention-2026-09-01.md` records what
bursts that do change membership cost, which mechanism each one exercised, and
what none of them measured.

A reader of the collection is not part of this, and is measured separately in
`mergeable-collection-writes.md`, where it turns out to be the whole cost of a
collection whose writes already merge. Deriving a value from the whole
collection does put the collection in a conflict set. The conflict set it lands
in belongs to the commit that writes the derived result, not to the commits
that write the collection it derives from. The runner opens one transaction per
event dispatch and another per reactive run, which is the reason, though it
has not been established directly that a keyed write and a derivation never
share a commit. What has been measured is that no refused commit in those runs
wrote a derived document. The derived commit is a compare-and-set over the whole collection and
contends with every element write, a cost belonging to the reader.

## Clear-and-reseed commits as a plain overwrite

Replacing a list's whole membership in one handler — `list.set([])`, then
`elementById(id).set(record)` and `addUnique(elementById(id))` per record, the
shape that seeds records the runtime can address by key — mixes a whole-value
overwrite with mergeable adds at the same path. The overwrite wins: because the
transaction changed the array's length ahead of the recorded tail, the commit
abandons the mergeable intent and sends the plain whole-array diff, so the
durable list holds exactly the reseeded members. That transaction forfeits
merge-friendliness for the list (it can false-conflict with a concurrent add),
which is the right trade — replacing a list wholesale is not an operation that
should merge with a concurrent append. See "Mixed ops on one path fall back to
the whole-array diff" in `mergeable-collection-writes.md`. The reseeded entity
documents themselves are ordinary writes and are unaffected.

## The entity outlives its link: clear on remove

A keyed element is two things — a membership link in the array, and the entity
document the link points at. `removeByValue` (and a whole-list `set([])`) drops
the link but does not delete the entity document; there is no orphan-entity
collection. So a handler that decides anything by reading the entity (the
castVote toggle reads "do I already have this vote?") must clear the entity when
it removes the membership, or a later read returns the removed value's stale
content. The lunch poll pairs every vote removal — toggle-off, clearMyVote, the
removeOption cascade, and resetVotes — with a `set(undefined)` of the entity. The
alternative, deciding membership by reading the array, would reintroduce the
whole-list read this design exists to avoid.

The clear is what a concurrent keyed operation is most likely to be refused
over; the section on concurrency costs above says why.

## Back-compatibility: addressing scheme changes

A keyed entity's id comes from its key alone. An appended one's comes from a
per-frame counter folded together with the event cause, and a record written as
part of a whole-list value gets an id minted from that write. None of those
derivations coincide, so a collection that moves to keyed addressing leaves
every record already in it unreachable from the new handlers:
`options.elementById(id).get()` and `votes.elementById(key).get()` read
undefined for such a record. Editing or removing an old option then silently
no-ops, and casting over an old vote adds a second, keyed vote beside it, so the
voter counts twice.

There is no data migration for pattern instances, and no per-handler legacy
fallback either — `migrating-collection-writes.md` says why the fallback costs
more than it looks. A populated instance is recreated, or repaired once by a
handler that already rewrites the whole collection. The poll has one: `resetVotes`
is a whole-list overwrite, so it reaches rows no key can name, and a host
clearing the board is the repair for a poll carrying votes from before its
votes were keyed. Options have no such handler; a poll whose options predate
their keyed addressing is recreated.

## The danger with `push`, and making it safe

Making `push` mergeable created a hazard for a **conditional** append — one whose
correctness depends on first reading the list, like "append only if this name is
absent." See `mergeable-collection-writes.md` ("Danger: a conditional push") for
the full treatment. Two responses are implemented:

1. **Address by identity where the condition is uniqueness.** A uniqueness
   condition becomes "add this entity, deduped by its link" — `elementById` then
   `addUnique` — which the server enforces against durable state with no retry.

2. **Keep the conflict net for other conditions automatically.** The
   incidental-read drop drops only the reads the op itself issues, not the
   handler's own explicit `.get()`. So a handler that reads the list and then
   writes still records that read and conflicts-and-retries.

The lunch poll's participant join (`addUser`) is deliberately left as a
read-then-push: its condition is not a simple key-uniqueness but "do not let a
second person take a name already in use," whose correctness needs the abort, not
a dedup. Response 2 keeps it safe — concurrent same-name joins conflict on the
retained read and one retries and bails. A third response, a build-time diagnostic
that flags read-then-mergeable-push and points at the identity-addressed
`addUnique`, is not yet built.

## Generality

A keyed list of records is one of the most common shapes; this approach applies
beyond the poll:

- **Membership / join lists** — `addUnique` an entity addressed by a member id or
  name (room participants, collaborators, attendees).
- **Per-key user state** — address by `(user, target)` and set the entity: votes,
  reactions, RSVPs, read-receipts, ratings, per-row selection.
- **Record editing** — `elementById(id).key("field").set(...)`: toggling a todo's
  done flag, editing a row's title, any "edit field F of row K" in a table.
- **Deletion** — `removeByValue(elementById(id))`: deleting a row, removing my
  entry; cascade deletes enumerate the foreign key and remove each match.
