# The changes projection

Companion to [`README.md`](./README.md) (the attention-system spec), split
out because it is **independently approvable**: a small, general, read-only
memory-v2 query primitive that the attention system consumes but does not
own. The memory owner can evaluate this file without adopting any attention
theory; the attention spec's phase 0 depends on it and nothing else here.
Section references (§n) refer to the main spec.

## Status

Proposed; net-new runtime surface (main spec §10.1). This is a **security
surface**, not just a feature: it exposes entity-change observability to
pattern-space, reversing a deliberate prior decision (`Cell` exposes no
version), and it adds an enumeration read ("which of these entities
changed"). It needs framework-author sign-off on the confidentiality story
below, not just implementation review. Revised after external security
review (PR #4691 feedback): version and author exposure are now **opaque
tokens**, the basis cursor no longer samples the space's commit clock, and
unauthorized entries are specified indistinguishable from unchanged ones.

## The primitive

One read-only, one-shot, session-independent query:

```text
changes(roots, branch, sinceBasis?, attribution?)
  → { basis, entries: [{id, version, deleted?, author?}] }
```

(The receiver/verb name is a placeholder — this belongs to the memory-v2
query layer, named in that spec's §5 style, not to a `graph` object that
doesn't exist.)

Three modes, one shape:

1. **Single root, no basis** → a **non-reactive head read**: the entity's
   current `version`. One-shot query, not a watch — re-renders never
   re-fire, which is the property the seen-store's write discipline
   requires (main spec §4.5, §5).
2. **Root set + basis** → the **changed-since enumeration**: entries whose
   head has advanced past the basis, plus a returned `basis` cursor for
   the next call. This is "while you were away" in one call.
3. **`attribution: true`** → each entry carries an **author token**:
   session-grain, server-asserted, **equality-comparable** attribution
   ("these changes came from the same session") — which is all run-grouping
   (main spec §5) needs. Resolving a token to an identity is a separate,
   gated step; see the confidentiality story.

## Token opacity — what the caller can and cannot learn

- **`version` is an opaque per-entity token.** The runtime provides
  ordering *within one entity* (`isAfter(a, b)`) and equality; tokens from
  different entities are not comparable, and the encoding is explicitly
  not part of the contract. Internally a token encodes the space's commit
  clock — opaquely, **precisely so the space-global clock never becomes a
  pattern-readable traffic oracle**: a caller holding one readable entity
  in a busy shared space must not be able to sample total commit activity
  across everything else in it ("this space got 40 commits at 2am").
  Consumers need exactly two properties — per-entity ordering and a
  restartable basis — and the tokens grant exactly those.
- **`basis` is an opaque cursor**, defined as *max(request basis, max
  version among returned entries)* — never the branch head. Two
  consequences, both deliberate: an empty result returns the caller's own
  basis unchanged (no clock sample through empty polls), and an entity
  that was unreadable at read time but becomes readable later is **not
  silently skipped** — the basis never advanced past it, so it appears on
  the next call.
- **`author` is an opaque token, stable within (space, session).**
  Equality is the contract; identity is not. This keeps raw session ids
  from becoming a cross-entity linkability primitive and keeps DIDs (a
  protected field class) out of the default read path.

## Why this is small

Every load-bearing piece is shipped, not specced:

- Head versions already cross the wire in every query result
  (`FactEntry.seq`, memory-v2 §5.7.1) — this contract *narrows* what that
  exposes, not widens it.
- Changed-since-a-basis is precisely the session catch-up computation
  (memory-v2 §5.4.2; `SessionSync.fromSeq/toSeq`, §4.2.3) — re-exposed
  one-shot, session-independent, payload-free.
- Attribution tokens derive from `CommitLogEntry.sessionId` (memory-v2
  §3.7.2), already persisted; `invocationRef`/`authorizationRef` are
  reserved there for the later signed-write pass, and identity-grade
  attribution upgrades in place when it lands.
- Implementation: one composite `(branch, seq)` index on the `head` table
  (only `idx_head_branch` exists today), token encode/decode, and the wire
  verb.

It is the entity-grain, payload-free member of the projection family
memory-v2 §07 sketches. It is deliberately **not** built on §07's
annotations plane — annotations are range-anchored collaborative-field
machinery, self-declared future work, and the one annotation prototype's
review (PR #4132) documents why storage-side reverse indexes invisible to
the reactive graph are the wrong shape.

## Confidentiality / read-authority story

**An entity may appear in a changes result iff the caller may read the
entity itself on that branch** — strictly less information than a
materialized read reveals, and never cheaper to obtain: a changes entry
("entity X changed, roughly when, by same-session-as-Y") is a new
**observation class**, distinct from `value`/`shape` reads, and each
entry's presence carries the subject entity's effective confidentiality —
so entries participate in flow joins the same way label metadata does
(staged in, per the label-metadata confidentiality treatment) rather than
slipping past them.

**Unauthorized ≡ nonexistent ≡ unchanged.** An entity the caller may not
read produces no entry, no error, and no per-root status — a denied root
is indistinguishable from an unchanged one, and (per the basis rule above)
is replayed rather than skipped if authority is later granted. v1 enforces
space-level ACLs (matching memory-v2 §5.6's current posture); when
label-based redaction lands, changes entries redact wherever the
materialized read would.

**Attribution visibility** is bounded the same way: author tokens appear
only on entries the caller could read anyway, equality is the only
operation, and resolving a token to a principal is a separate step gated
by the same disclosure posture that governs shared attention state (main
spec §8). Whether members of a space *should* see each other's write
attribution by default is that space's call, not this primitive's.

Branch scope: v1 serves the default branch only, matching the main spec's
same-space version-comparability rule (child-branch head inheritance is
the known hard part — PR #4132's blocker).

## Consumers beyond attention

The generality test, so this earns its place as a platform primitive rather
than an attention hook: offline catch-up UIs ("what changed while this
device was closed" without holding a session watch open); activity/audit
views ("what happened in this space this week, by whom" — the
state-inspector hand-rolls offline versions of these reads today);
incremental derived indexes (a basis cursor turns recompute-the-world into
process-the-delta); retention/GC watermarks (reap at or below a held
basis).

## What the attention system builds on it

- `unseen(entity)` = `changes([entity], sinceBasis: seenMark.basis)`
  non-empty → change dots (main spec §5).
- "While you were away" = one `changes(watchSet, basis, attribution: true)`
  call, grouped by author-token equality then space (main spec §5).
- Watchers (main spec §5.1) read through it to derive notices from entity
  changes; the steward stamps `subjectVersion` tokens at admission for the
  generic seen watcher to compare against seen marks.
