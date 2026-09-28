---
status: historical
created: 2026-09-26
archived: 2026-09-26
reason: "Investigation findings: why a write changing K keys of an N-key object cost O(K × N), what removed it, and the super-linear costs found around it and left for later."
---

# A write into a large object paid for the object once per changed key

Loom's daemon keeps an identifier-to-entity map in one cell: a plain object of
6,000 to 11,000 entries, each `{ person: <link>, fallbackName: string }`,
written whole with `set()` under `editWithRetry`. Widening it from 6,263 to about
10,752 keys in one write took about two minutes of CPU on an emulated store,
where a cold write of 11,521 keys into an empty cell took 1.4 s. This pass
measured why, removed the cause, and surveyed what else on the same path grows
faster than the write.

## What was measured, against what

| | |
| --- | --- |
| labs | `a52c0faa70` (base) and the branch that fixed it |
| workload | a scratch script: one cell, `StorageManager.emulate`, `runtimePresets.unitTest`; write an `N`-key map, then one `editWithRetry` + `set()` that adds, removes or changes `K` entries, then `runtime.idle()` |
| profile | `deno run --cpu-prof` over the whole script, attributed by walking each hot frame's callers in the `.cpuprofile` |
| machine | an M-series laptop, often under load from other sessions; every figure is a single run unless it says otherwise |

## Where the time went

At base, adding 500 keys to 6,263 took 9.1 s. Its profile, share of sampled
time:

| frame | self |
| --- | ---: |
| `shallowStructureChanged` (the reactivity log's ancestor check) | 55% |
| `cloneHelper`, under `applyPatch` → `thawSpine` | 31% |

Changing the value of 1,000 of 6,263 entries, with no key added or removed,
inverted the two: `cloneHelper` 56%, `shallowStructureChanged` 29%. Value churn
was quadratic too.

Each of those frames was reached twice per commit:

- `shallowStructureChanged` ran once per written key per ancestor, and read the
  ancestor's whole key set each time. The reactivity log that called it was
  built twice before the commit reached storage — once by the CFC commit probe
  (`flowLabelWorkExists`) and once by `valueWriteTargets` under it — because a
  read between the two dropped the cached log, including a read the log itself
  ignores. The scheduler built it a third time after preparation.
- `cloneHelper` ran under `applyPatch`, whose copy-on-write descent copied every
  container on each op's spine, including the ones the previous op had just
  copied. The client's pending-layer replay and the memory engine's revision
  reconstruction both call it, so each copied the root once per op.

With those two gone, a third source showed at larger `K`: `#buildPatchOperation`
kept its patch candidates by comparing each with every candidate kept before it,
`O(K²)` in the number of written keys alone — 35% of a 6,263 + 4,489 write. A
fourth, a local read scanning every write of its document for a prefix of its
path, has the same shape and was removed alongside.

## What the fix measured

Single runs, after each of the four were removed, with a test suite sharing the
machine for some of them:

| base `N` | change | base | after |
| --- | --- | ---: | ---: |
| 6,263 | add 500 | 9.1 s | 0.37 s |
| 6,263 | add 1,000 | 12.1 s | 0.46 s |
| 6,263 | add 4,489 | ~2 min (Loom's figure) | 1.0 s |
| 11,000 | add 11,000 | — | 2.2 s |
| 6,263 | remove 1,000 | 9.4 s | 0.36 s |
| 10,000 | change 3,000 values | 47.0 s | 1.0 s |
| 10,752 | change 300 values, four writes | 5.5–8.5 s each | 0.36–0.59 s each |

Afterward the profile of an 11,000 + 11,000 write had no frame above 7% of self
time.

## A reader of the whole map, quadratic in `N` alone

A second quadratic surfaced from the same map with a reader attached: one
`cell.sink()` with no schema, and one changed value. The sink's traversal takes
the same shallow read of the map once per child, the log keeps every copy — about
`3N` of them — and validating the reader's empty re-run checked each copy by
listing the map's keys. At base: 0.54 s at 1,000 keys, 1.8 s at 2,000, 7.4 s at
4,000. Checking each distinct read once took the same cases to 0.24 s, 0.47 s
and 1.0 s, and 8,000 keys to 1.8 s.

## Ruled out

An in-transaction whole read slowing each later write was reported from the
daemon: `getRaw()` and a `valueEqual` walk over every entry inside the writing
transaction, one changed value per write, timings rising 1.4 → 1.9 → 3.3 s over
three writes. Ported to labs, five writes at base read 1.9, 2.3, 3.1, 1.0 and
1.6 s, and on the branch 1.8, 1.8, 2.5, 1.9 and 1.8 s: no growth on either
side, and no difference from the same write without the read. A single-value
write is not `K`-dependent, so it costs the same on both.

## Found and left for later

Each of these was measured or read while surveying the path, and each is its own
change:

- **Concurrent commits, server-side.** `validateConfirmedReads` →
  `findConflictSeq` in `memory/v2/engine.ts` decodes every intervening patch
  once per read being validated. Two clients committing disjoint per-key writes
  to a 10,000-key map at once: 2.7 s for 1,000 keys each, 8.2 s for 2,000,
  49.7 s for 4,000.
- **A read-then-write loop inside one transaction** re-copies the parent on
  every read, because each write drops the frozen snapshot the next read
  needs: `K` = 250, 500, 1,000, 2,000 over 8,000 keys took 3.0, 7.5, 14.9 and
  35 s. Snapshot isolation over plain objects makes each alternation cost the
  parent's size; only a persistent map would not.
- **The per-commit constant.** Each commit makes several whole-document passes
  even for one changed value: the transaction's no-op check, `differential.ts`
  comparing whole roots and then each child (the server's echo of a commit is a
  freshly decoded document, so no child is shared), the client decoding and
  walking that echo, and the engine reconstructing the head before checking
  whether a snapshot is due. One changed value under 10,752 string-valued keys
  cost about 350 ms, and about 1 s with link values.
- **A hashing cliff.** `ValueHasher`'s string cache holds 50,000 entries and
  hashes each new root by streaming every string, so a document holding more
  distinct strings than that re-hashes all of them on every commit: one changed
  value cost 200 ms at 10,000 entries and 0.9–1.0 s at 17,500.
- **CFC reads the scheduler's reactivity log for written spaces.**
  `flowLabelWorkExists`, `valueWriteTargets` and two sites in
  `extended-storage-transaction.ts` take only `.space` from the log's `writes`.
  Reading the transaction's write details instead is not a drop-in: a space
  whose writes all returned to their starting values is no CFC target today and
  would become one.
- **A refused write can still change its document.** `applyMutablePathWrite`
  creates missing parents before it validates the leaf key, so a write of `-`
  beneath a missing parent is refused and leaves `[]` behind, which the commit
  sends.
- Read from code rather than measured: the client discards its cache of
  pending-layer materializations on each server update and replays every
  pending patch on the next read (`O(P²·N)` for `P` commits in flight); the
  engine's `SELECT_LATEST_BASE` walks all history since the last `set` twice
  per commit, `O(H²)` over the life of a document that is only ever patched.
