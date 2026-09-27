---
status: historical
created: 2026-09-26
archived: 2026-09-26
reason: "Investigation findings: which whole-document passes a one-value commit to a large document paid, what removing them measured, and the two fixes ruled out."
---

# Whole-document passes on a one-value commit

A commit that changes one value inside a large document cost time in
proportion to the document, with a large constant, and jumped three- to
five-fold past roughly 16,700 entries. This pass attributed that cost to the
passes a commit makes over the whole document, removed the ones that were
redundant, and recorded what is left. It takes up two items that
[the write-cost investigation of the same map](2026-09-26-large-object-write-cost.md)
left for later: the per-commit constant, and the hashing cliff. The numbers
below were taken before that investigation's change landed; a one-value
commit writes one key, which is where that change costs the same as before.

## What was measured, against what

| | |
| --- | --- |
| labs | `a52c0faa70` (main) and this change |
| workload | a scratch script: one cell holding a map of `N` entries `{ person, fallbackName }`, `person` either a string or a link to a distinct cell, rewritten whole by `cell.withTx(tx).set(map)` under `runtime.editWithRetry()` with one entry's `fallbackName` changed, on `StorageManager.emulate()` and `runtimePresets.unitTest` |
| profile | `deno run --cpu-prof`, twelve commits at `N` = 10,752 with link values, attributed by caller chain from the `.cpuprofile` |
| timing | process CPU time per commit (`process.cpuUsage()`), which includes the in-process emulated server; base and change interleaved over three rounds, first commit of each run dropped, median of fifteen commits |
| machine | an M-series laptop at a load average of 55 to 90 from other work throughout; wall-clock was unusable and is not reported |

## Where a commit's time went

The profile at 10,752 link entries, per commit, before the change:

| pass | cost | what it did |
| --- | --- | --- |
| `normalizeAndDiff()` | ~300 ms | diffs the caller's whole new map against the stored one; per entry it resolves the link and opens a read transaction through the cell's `schema` getter |
| `getNativeCommit()` no-op check | ~90 ms | `valueEqual()` of the mutable working root against the start root, which hashes the working root whole |
| differential, local commit | ~240 ms | `valueEqual()` of both roots, then again of each container on the way down; nothing below the root had a cached hash, so each level hashed the document again |
| differential, echo | ~140 ms | the same against the server's echo, a freshly decoded copy |
| client decode of the echo | ~120 ms | parse, decode and deep-freeze of the whole document the server sends back for the writer's own patch |
| server snapshot check | ~100 ms | reconstructs the head (resume from cache, replay one patch) and encodes it whole to weigh the cache entry |
| server encode of the echo | ~85 ms | the frame carrying the whole document |

A counter of containers fed to the hasher, run through a real emulated
replica with the document watched, put the hashing at `10N + 12` containers
per commit: about five whole-document hashes.

The jump past ~16,700 entries is the hasher's string-representation cache.
It holds 50,000 entries and 8 MB, and each whole-document hash feeds every
string in the document through it. At three strings per entry, a document
past about 16,700 entries holds more distinct strings than the cache, and
least-recently-used eviction under a cyclic walk evicts each string just
before it is needed again, so every hash re-encodes every string.

## What changed, and what it measured

- The no-op check compares by walking the two roots in step, which settles
  every subtree a copy-on-write edit shares by identity: `valueEqualByWalk()`.
- The differential compares by its own walk alone. A root check by identity,
  and no `valueEqual()` per level. A special object is compared by content at
  its own position. A pair that is not two arrays or two plain records goes
  to `valueEqual()`, and so does a pair whose `after` container repeats on
  the walk's path.
- The server weighs a replayed revision from the revision it resumed, plus
  what each patch grew it by, measured by a walk in step that encodes only
  what the patch replaced, added or removed. The encoding composes exactly
  through records with no `/`-prefixed key and arrays with no hole, which is
  all the walk descends through, so the weight stays exact. An array is
  trimmed of the elements it shares with its counterpart at either end before
  it is walked, and past 64 encoded pieces a patch gives up and the result is
  encoded whole. A piece of a revision the replay only passes through may be
  one the codec refuses, a reserved key a later patch removes, and then too
  only the result is encoded.
- The commit after a snapshot resumes from the cached revision the snapshot
  was written from, rather than decoding the snapshot row, and takes its
  weight from the snapshot row's length, which re-anchors the carried weight
  at every snapshot.

Containers hashed per one-entry commit went from `10N + 12` to 0 at every
size tested. CPU per commit:

| entries | values | main | change |
| ---: | --- | ---: | ---: |
| 10,752 | string | 362 ms | 255 ms |
| 10,752 | link | 873 ms | 525 ms |
| 17,500 | string | 1,226 ms | 368 ms |
| 17,500 | link | 2,459 ms | 836 ms |

From 10,752 to 17,500 entries, 1.6 times the data, main's cost rose 3.4-fold
and the change's 1.44-fold: no whole-document hash is left on the commit path
to thrash the string cache.

## Ruled out

**Reusing a child's cached hash inside its parent's.** The content hash is
one SHA-256 stream over the whole value (`2-hash-byte-format.md`), not a
Merkle tree; only a string longer than 64 bytes is sub-hashed. A hash state
cannot be spliced in at an offset, and a cycle is encoded relative to where
the hash began, so a subtree's bytes depend on its position. A Merkle format
would change every content-addressed identity: entity ids, `cid:` ids,
slugs, signed invocation bytes. Equality, which is all these passes needed,
does not need a hash at all.

**Checking the snapshot count before reconstructing the head.** The
reconstruction is not wasted. It stages the head in the document cache, and
two readers take it from there: the server building the echo, and the next
commit's resume. Deferring it moves the same work onto them, and where
neither reads, the next commit's resume misses and replays from the last
snapshot. What was wasted was the encode that weighed the entry.

**Weighing pieces with no bound.** An array compared position by position,
with no trimming and no bound on pieces encoded, weighed the removal of the
first entry of a 2,000-entry list by encoding every entry it moved: five to
eight times the cost of the single encode it replaced. Encoding the removed
member of a revision the replay only passed through also threw on a reserved
key that a later patch removed, where encoding only the result did not.

**A bare identity walk in the differential.** Dropping the per-level
`valueEqual()` without the two guards above made two equal cyclic subtrees
that branch take time exponential in the depth cap, and read a `Date` as an
empty record. No stored document can be cyclic or hold a `Date`, since the
codec refuses both, but the guards cost about 10 to 15 ms of the echo walk at
10,752 link entries and keep the behavior the walk had.

## What is left

- `normalizeAndDiff()` over the caller's whole map, about 300 ms per commit
  at 10,752 link entries: a per-entry read transaction and link resolution,
  which a caller rewriting one entry through the whole map pays for every
  entry.
- The echo. The server sends the writer's own patch commit back as the whole
  document, which the server encodes and the client decodes and deep-freezes,
  about 200 ms together at 10,752 link entries. The echo is there because the
  applied document can hold merged content the writer's ops cannot
  reproduce, so eliding it needs the server to show the pre-apply head was
  the writer's base.
- The spine of a flat map. A copy-on-write edit shallow-copies the map
  itself, which is linear in its keys however small the edit.
