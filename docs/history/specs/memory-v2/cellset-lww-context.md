---
status: historical
created: 2026-07-01
archived: 2026-07-08
reason: "Working context for a merged fix (PR #4245)."
---

# Cellset last-write-wins for scalar `$value` writes — context & status

**PR:** [#4245](https://github.com/commontoolsinc/labs/pull/4245) (draft) ·
**branch:** `fix/cellset-blind-leaf-write` ·
**supersedes:** #4126 (closed), #4196 (closed)

This is a working-context document for picking the PR back up cold. It records
the bug, the fix, *why the fix is shaped the way it is*, how it's verified, how
it relates to the conflict-handling work that landed while it was parked, and
the open questions for the area owner (Robin / ubik2).

---

## TL;DR

A `$value`/`$checked` UI write was committed as a **compare-and-set** (the diff
read of the write target became a commit precondition), so under concurrent
same-user edits it lost an own-write race, was rejected and rolled back, and the
edit silently vanished — the `cfc-group-chat-demo` "Name not set" flake.

**The fix (as landed):** decide blind-vs-CAS by **method**, not value type. A
`CellHandle.set` → `CellSet` is a **blind last-write-wins** write (any value
type); a `CellHandle.push` → new `CellPush` → `handleCellPush` keeps
**compare-and-set**. A blind `set` carries no value-equality precondition — in its
place `handleCellSet` threads **one structural precondition at the cell's parent**,
so a concurrent whole-doc delete *or ancestor reshape* is a clean `ConflictError`
rather than a raw "not traversable" throw. Verified headless (multi-runtime +
engine-level) and green in regression.

> **Reading this doc:** §§1–4 and §6 trace how the fix got here and describe its
> two *earlier* forms — a precondition-free scalar blind write (value-type
> narrowing), then an entity-root structural read. The design evolved twice:
> value-type → **method-based** (per Robin's review) and entity-root → **parent**.
> Each mechanism section below is written in the current form; **§5** records the
> investigation and **§5.3 is the authoritative account of the landed design.**

---

## 1. The bug

The `cfc-group-chat-demo` two-browser CI flake — a user's profile name stays
**"Name not set"** under contention — had two independent mechanisms:

1. **Handler-delivery** (lost trusted click / cross-thread handler retirement) —
   fixed separately in **#4146**. Not this PR.
2. **Cell-write drop** — this PR.

**Mechanism #2, root cause.** Writing a scalar `$value` goes
`UI → CellHandle.set → CellSet IPC → RuntimeProcessor.handleCellSet → Cell.set →
diffAndUpdate → normalizeAndDiff`. To diff, `normalizeAndDiff` **reads the write
target** (`packages/runner/src/data-updating.ts`, the `tx.readValueOrThrow(link)`
on the value being written). That read is recorded as a **commit precondition**
two ways:

- engine side — it becomes a `reads.confirmed` entry (via `buildReads` in
  `packages/runner/src/storage/v2.ts`), checked by `validateConfirmedReads` →
  `findConflictSeq` in `packages/memory/v2/engine.ts`;
- client side — `V2StorageTransaction.read()` marks the doc `validated`, which
  `validate()` turns into a compare-and-swap `claim()`.

So a `$value` write is "only apply if the target is unchanged since I read it."
Under an **own-write race** — two sessions/tabs of one user sharing the PerUser
`profileDraft`, **or** the typed `$value` set racing the save handler's own
`nameDraft.set` ([`trusted.tsx:533`](../../../../patterns/examples/cfc-group-chat-demo/trusted.tsx))
— the write-target read is baselined at a stale seq and loses:
`ConflictError: stale confirmed read: <id> at seq N conflicted with seq M`. The
write is **rejected and rolled back**, the draft reverts, and the save handler
(`commitTrustedProfileSave`, which reads
[`draftText(nameDraft)` at `trusted.tsx:530`](../../../../patterns/examples/cfc-group-chat-demo/trusted.tsx))
reads the wrong/empty draft → the typed name is lost.

**The conflict is tier-2 (patch path-overlap) on the *same* leaf path**
`["value","profileDraft"]` — both writers patch the same leaf. (An early model
called it tier-1 path-blind; instrumentation on the multi-runtime probe corrected
that — it's same-leaf tier-2.)

---

## 2. The fix

The blind-vs-compare-and-set decision is made by **method** (which request type
the client sent), not by the value's shape. Both handlers share `applyCellWrite`.

- **`CellHandle.set` → `CellSet` → `RuntimeProcessor.handleCellSet`**
  ([`runtime-processor.ts`](../../../../packages/runtime-client/backends/runtime-processor.ts))
  is a **blind last-write-wins** write (any value type). It marks its transaction
  as a blind-leaf-write **around the `cell.set()` call only** (cleared before
  `prepareTxForCommit`). While marked, `V2StorageTransaction.read()`
  ([`v2-transaction.ts`](../../../../runtime/runner/src/storage/v2-transaction.ts))
  tags every read `ignoreReadForCommit` and **skips `doc.validated`**, so the leaf
  carries no value-equality precondition. In its place, `handleCellSet` threads
  the cell's resolved **parent** address (`setBlindStructuralTarget`, via
  `resolveAsCell().getAsNormalizedFullLink()`), and `buildReads`
  ([`v2.ts`](../../../../runtime/runner/src/storage/v2.ts)) emits **one
  `nonRecursive` read at that parent** — catching a concurrent whole-doc delete or
  ancestor reshape as a clean `ConflictError` (see §5.3).
- **`CellHandle.push` → `CellPush` → `handleCellPush`** is read-modify-write: it
  is *not* marked blind, so the read of the current value stays a commit
  precondition (compare-and-set) and a concurrent push aborts rather than being
  clobbered.

The marker registry lives in
[`reactivity-log.ts`](../../../../runtime/runner/src/storage/reactivity-log.ts):
`markUiInputBlindWriteTx` / `unmark` / `is` + the `ignoreReadForCommit` marker,
plus `setBlindStructuralTarget` / `getBlindStructuralTarget` (the parent target
threaded from `handleCellSet` to `buildReads`). The mark walks the tx wrapper
chain so both the `ExtendedStorageTransaction` and the inner
`V2StorageTransaction` are covered.

### Why it's shaped this way (the load-bearing decisions)

- **By method, not value type.** `CellHandle.set` is the sole `CellSet` sender,
  but read-modify-write ops (`CellHandle.push`, `cf-autocomplete` multi-select,
  `ArrayCellController`) also route through it. The *earlier* form partitioned by
  value type (scalar → blind, array/object → CAS) as a proxy for "RMW". Per
  Robin's review this is now explicit: `push` is its own request type (keeps CAS),
  and `set` is always blind. Trade-off: an array *overwrite* via `set` is now
  blind, where the value-type form kept it on CAS — the concurrency-safe path for
  list mutations is `push` (or the deferred server-side mergeable-op work).
- **Around `set()` only, not the whole tx.** `prepareTxForCommit → prepareCfc →
  prepareBoundaryCommit` persists CFC label / `cid:` schema docs as
  **read-then-write in the same tx**. Marking the whole tx would strip *those*
  preconditions too, letting a concurrent label/classification change be
  clobbered. Unmarking before `prepareTxForCommit` keeps them.
- **Preserved invariants (verified):** CFC enforcement rides `attemptedWrites`
  (the `markReadAsAttemptedWrite` read, kept) — not `reads.confirmed`/`validated`
  — so it's intact. Reactivity/subscriptions ride `ignoreReadForScheduling`,
  which the fix never sets, so the self-subscription is intact.

### Things tried and dropped

- **No-op-suppression bypass / force-write** (making a same-value re-set still
  send). Dropped: precondition removal *alone* fixes the real data loss (a
  genuine concurrent edit has a delta and now commits); a same-value *echo* of
  the stale local value is not data loss, and forcing it is both a debatable
  policy and blocked by a third commit-assembly delta gate.
- **Whole-transaction blind write** — blocked by the audit (see above).

---

## 3. Coverage / verification

**Regression test:** `packages/patterns/integration/cellset-lww.test.ts`
(headless multi-runtime: Deno workers + in-process `StandaloneMemoryServer`, no
browser, CI-ready). Four steps:

1. concurrent same-user scalar sets → **0 conflicts** (blind);
2. a structured (array) set → **also 0 conflicts** (the trigger is the method, not
   the value type);
3. concurrent `push`es → **still compare-and-set** (guards the method split);
4. e2e — a typed name survives the own-write race **through `saveProfile`** (the
   actual symptom).

**Ancestor-reshape guarantee:**
`packages/memory/test/cellset-structural-precondition-test.ts` (engine-level) pins
that a precondition-free nested patch on a retyped ancestor throws raw "not
traversable"; an **entity-root** structural read still throws raw (insufficient);
the **parent** read converts it to a clean `ConflictError`. (The in-process
harness can't reproduce this end to end — synchronous propagation, no
stale-but-navigable replica — hence the engine test.)

The harness mirrors `handleCellSet`/`handleCellPush` with `set` (always blind) and
`push` (CAS) commands (`multi-runtime-{worker,harness}.ts`) — reusable infra.

**Production-fidelity (earlier form):** the real two-browser integration
(`deno task integration patterns two-browsers`, real chromium) ran **13/13 PASS,
`commitRejected=0`** on the original scalar-blind branch. The method-based redesign
has not been re-run under two-browser locally; the full pattern-integration suite
runs it in CI.

---

## 4. The "new world" — landed conflict-handling PRs and how ours relates

The branch is rebased onto main as of late June 2026, which includes:

- **#4220** *(conflict-granularity)* — the closest neighbor. It built a
  conflict-read filtering system in `buildReads`: an `excludeReadFromConflict`
  marker (**nonRecursive-gated** — drops reference/topology reads like asCell
  shape resolution), a "mergeable op" concept, CFC-label-path dropping, and a
  **leaf-only conflict matcher**. **Complementary, not redundant:** the leaf-only
  matcher *preserves* same-leaf conflicts (our race is same-leaf), and
  `excludeReadFromConflict` is nonRecursive-only while our write-target read is
  **recursive (by-value)** — so #4220 never drops it. Our blind reads are the
  *first* filter in that same `buildReads` loop; they are dropped and replaced by
  one structural **parent** read (§5.3), sitting alongside #4220's filters.
- **#4210** *(reactive computes don't re-queue on commit conflict)* and
  **#4343** *(re-queue reactive computes stranded by a commit conflict — Hixie's
  fix for the #4210 strand)*. Both live in `scheduler/action-run.ts` +
  `storage/rejection.ts` — the **reactive compute** recovery path, **orthogonal**
  to the `handleCellSet` `$value` write (which is a single un-retried commit, not
  a reactive compute). See the `reference_reactive_conflict_strand_repro` note
  (the #4210/#4343 strand only reproduces under real async load).
- **#4366** *(VDOM list child settling)* and **#4367** *(reload churn read
  resume)* — rendering/reload level, orthogonal to the cellset write path.

**Rebase mechanics:** one trivial conflict (an import block in `v2.ts`, both
#4220 and we import from `reactivity-log.ts`); everything else auto-merged,
including `v2-transaction.ts read()` and `reactivity-log.ts`. Post-rebase:
type-check clean, `cellset-lww` 3/3, 47 conflict/commit/storage/runtime-processor
regression tests green.

**Still adds value — confirmed empirically.** With the fix disabled on the *new*
base (which already includes all five PRs), the own-write race still fails
identically (`stale confirmed read … conflicted`), and the e2e still drops the
typed name. None of the landed work addresses the scalar `$value` own-write race.

---

## 5. Open questions for Robin (ubik2) — investigated 2026-06-29

Both questions from the PR body were dug into directly (engine-level repros +
load-bearing reads). The original framing, then what we found.

### 5.1 Q1 — Patch-replay edge: **verified real, bounded, with a tested mitigation**

> *Original:* a nested scalar `$value` set emits a *patch* op; precondition-free,
> a patch whose ancestor path was concurrently removed (a whole-doc delete racing
> a `$value` set — rare, **not** the PerUser own-write race) would throw at
> read-materialization rather than be rejected at commit. Keep a structural
> (entity/parent-present) precondition even when dropping the value-equality one?

**Reproduced at the engine level** (crafted set→delete→blind-patch commits via
`applyCommit`, mirroring `packages/memory/test/v2-commit-preconditions-test.ts`):

- **The edge is real.** A precondition-free nested-scalar `replace` patch whose
  doc was concurrently whole-doc-deleted throws **`Error: missing path
  /value/profileDraft`**. `reconstructPatchedDocument`
  ([engine.ts:4147](../../../../runtime/memory/v2/engine.ts)) reads the delete as
  its base (`SELECT_LATEST_BASE` is `op IN ('set','delete')`), so the doc is
  `emptyEntityDocument() = {}`, and `replaceAtPath` → `thawSpine`
  ([patch.ts:107](../../../../runtime/memory/v2/patch.ts)) can't descend.
- **Why the fix exposes it.** Same scenario *pre-fix* (compare-and-set) is caught
  cleanly as `ConflictError: stale confirmed read … conflicted with seq 2` — the
  concurrent delete fires **TIER-1 (set/delete), which is path-blind**, and the
  value-equality precondition we drop was the *only* carrier of that catch. The
  engine has **no `entity-present` precondition** at all — only
  `origin-committed` / `receipt-exists` / `entity-absent`
  ([engine.ts:3446](../../../../runtime/memory/v2/engine.ts)).
- **Blast radius is bounded.** The throw fires inside commit-time
  `materializeSnapshots` (calls `readStateForScopeKey` unconditionally), which is
  inside `engine.database.transaction(applyCommitTransaction).immediate(...)`
  ([engine.ts:1542](../../../../runtime/memory/v2/engine.ts)) → **the commit rolls
  back**; the doc is **not** durably poisoned (observed `read = null` after). The
  harm is a *raw `Error` instead of a `ConflictError`* — ungraceful failure, not
  corruption or silent loss. (A blind **`add`** of a fresh key instead silently
  *resurrects* the doc — manifestation is op-shape-dependent.)
- **End-to-end reachability** is rarer than the own-write race: it needs a real
  flow that whole-doc-deletes a draft doc concurrent with a scalar set. The
  *engine* mechanism is verified; an end-to-end pattern repro was not built.

**Mitigation (prototype — uncommitted on the working tree; see §5.3).** Instead
of dropping every blind read, `buildReads` **downgrades** each to a single
`nonRecursive` existence read at the **entity root**
([v2.ts:2165](../../../../runtime/runner/src/storage/v2.ts)). TIER-1 is path-blind
→ a concurrent whole-doc delete/replace still yields a clean `ConflictError`;
TIER-2 `nonRecursive` overlap fires only at-or-above the read path
(`patchOverlapsNonRecursiveRead`, [engine.ts:3914](../../../../runtime/memory/v2/engine.ts)),
and the dropped leaf value read sits strictly **below** the root, so the same-leaf
own-write race stays conflict-free. Verified:

- engine probes — structural-read + delete → `ConflictError` (graceful); structural
  read + same-leaf race → no conflict;
- `cellset-lww` **3/3** (own-write race preserved through the real stack);
- conflict/commit/runtime-processor/precondition regression **34 tests / 63 steps**;
- the downgrade is **live, not a no-op** — observed 314× on the real blind-set
  path (gated `CSPROBE_STRUCT` instrumentation, since removed);
- type-check clean.

**Tradeoff (observed).** The mitigation re-introduces a *narrow* conflict class:
a scalar `$value` set now conflicts with a concurrent **whole-doc set or delete
of the same entity**. Behavior becomes **uniform** — both whole-doc races yield a
clean `ConflictError` (which conflict-recovery already handles) instead of the
current split (silent apply-on-top for a whole-doc set; raw throw for a delete).
The same-leaf own-write race is untouched. Whether that uniformity is worth the
extra conflicts is **Robin's call**.

**Pre-land gaps for the mitigation:** (a) no single end-to-end delete-race test
(harness has no whole-doc-delete primitive — established by composition: observed
emission + proven engine semantics); (b) broad pattern-integration suites (68 +
147) not run — the proportionate gate, since a scalar UI write now pins entity-root
existence for every pattern; (c) client-side `validated` left unchanged
(engine-authoritative); (d) root `[]` vs immediate-parent granularity is a design
choice.

### 5.2 Q2 — Trigger shape / #4220 unification: distinct today; Q1 points at the seam

> *Original:* value-type heuristic (scalar → blind) vs an explicit signal — and
> whether the blind-leaf-write belongs expressed in #4220's "mergeable op /
> `excludeReadFromConflict`" vocabulary. Possible unification.

The three drop-from-conflict filters now sit as siblings in one `buildReads` loop
([v2.ts:2157](../../../../runtime/runner/src/storage/v2.ts)), at **three different
granularities**:

| Filter | Owner | Granularity | Keeps |
|---|---|---|---|
| `isReadIgnoredForCommit` | #4245 (ours) | **tx-wide**, unconditional | (now) a structural root read |
| `isReadExcludedFromConflict && nonRecursive` | #4220 | **per-read**, nonRecursive-gated | recursive value reads |
| mergeable-op block | #4220 | **per-op/entity** | recursive read *at* the op path |

Neither #4220 marker can absorb ours as-is: `excludeReadFromConflict` is
`nonRecursive`-gated but our write-target read is **recursive** (by-value,
[data-updating.ts:666](../../../../runtime/runner/src/data-updating.ts)) — confirmed
by code *and* empirically (with #4220 present, disabling our fix still fails the
race); `mergeableOpRead` *deliberately keeps* the recursive read at the op path
(so conditional mergeable writes still conflict) — exactly the read we must drop —
and a mergeable op is apply-on-top *merge*, not LWW *overwrite*. The reason they
differ: #4220's markers serve txs that **mix** droppable machinery reads with kept
handler reads (so they're per-read); `handleCellSet`'s tx is **single-purpose**,
which is what justifies the tx-wide approach.

**Synthesis — Q1 and Q2 share one lever: granularity.** The tx-wide "drop
everything" is precisely what *creates* the Q1 edge (it discards the structural
delete-catcher with the value-equality precondition). The §5.1 mitigation — drop
the leaf value read, **keep a structural parent/root read** — closes Q1 *and*
moves the trigger toward #4220's **per-read** vocabulary, partially answering the
unification question. The two questions are not independent.

### 5.3 Redesign after Robin's review (2026-06-30) — LANDED

Robin reviewed the entity-root form and endorsed the "semi-blind write" direction
(value-blind + a structural precondition), with two changes now on
`fix/cellset-blind-leaf-write`. Both **supersede** the "value-type narrowing" /
"entity-root" framing in §§2/4/7 and the §5.1 mitigation.

1. **Trigger by METHOD, not value type.** The scalar-vs-structured heuristic is
   replaced by an explicit request type: `CellHandle.set` → `CellSet` → always a
   blind last-write-wins write (any value type); `CellHandle.push` → new
   **`CellPush`** → `handleCellPush` → read-modify-write that keeps
   compare-and-set. The value-type check in `handleCellSet` is gone; both handlers
   share `applyCellWrite(request, blind)`. Intent-explicit, and it lets an array
   *overwrite* be blind while an array *push* captures reads. (Robin: push stays
   CAS-retry at the browser→worker seam; a mergeable `append` is a deferred larger
   change — index-shift surprises.) Files: `protocol/types.ts` (CellPush +
   Commands), `runtime-processor.ts`, `cell-handle.ts`. Test: `cellset-lww.test.ts`
   now covers scalar-set-blind, array-set-blind (trigger is the method),
   push-keeps-CAS, and the e2e save.

2. **Structural read anchored at the cell's PARENT, not the entity root.** Robin
   wanted a write to `["notes","today"]` to fail if someone wrote `false` to
   `["notes"]` (an ancestor *reshape*, à la Ian's
   [#4406](https://github.com/commontoolsinc/labs/pull/4406)). The entity-root read
   only caught a whole-doc delete (TIER-1); an intermediate-ancestor reshape (a
   TIER-2 patch) slipped past and threw a raw "not traversable" at
   commit-materialization. Now `handleCellSet` threads the cell's resolved PARENT
   address (`setBlindStructuralTarget`, via
   `resolveAsCell().getAsNormalizedFullLink()` — the logical write path is known
   only there; `buildReads` sees the optimized element-level diff), and
   `buildReads` emits one nonRecursive read at that parent. A concurrent ancestor
   reshape is now a clean ConflictError; a same-/sibling-leaf value write (below
   the parent) stays conflict-free; array element writes (below the parent) keep
   array-set blind. For a linked/scalar cell the parent *is* the entity root, so
   this reduces to the earlier form. Files: `reactivity-log.ts` (persistent target
   registry), `runtime-processor.ts`, `index.ts`, `v2.ts`.

**Verification.** cellset-lww 4/4; conflict/commit/runtime-processor/precondition
regression + broader sweep green (109 tests); fmt/lint/type-check clean. The
ancestor-reshape guarantee is a dedicated ENGINE-level test,
`packages/memory/test/cellset-structural-precondition-test.ts`: precondition-free →
raw throw; entity-root read → *still* raw throw (root is insufficient); PARENT read
→ clean ConflictError. The in-process multi-runtime harness can't reproduce this
end to end — it propagates shared state synchronously, so a session can't hold a
*stale-but-navigable* replica (navigation into a retyped ancestor fails locally
before any commit) — hence the engine-level test.

**Not merged**; still PR [#4245](https://github.com/commontoolsinc/labs/pull/4245)
for Robin's review. The array-CAS drop (a `set` of an array is now blind, unlike
the old value-type form) is the one behavior change to flag to him explicitly.

---

This supersedes the **recovery**-based approaches (#4196 per-key commit queue,
#4126 reapply-latest) by removing the conflict at the source (**prevention**).

---

## 6. Repro & commands

```bash
# Worktree / branch
cd labs/.claude/worktrees/cellset-probe            # branch: fix/cellset-blind-leaf-write

# Regression test (fast, headless) — should be 4/4
deno test -A packages/patterns/integration/cellset-lww.test.ts

# Ancestor-reshape guarantee (engine-level structural precondition)
deno test -A packages/memory/test/cellset-structural-precondition-test.ts

# See the flake: disable the blind path and re-run → steps 1/2/4 fail with
# "stale confirmed read … conflicted". In multi-runtime-worker.ts set(), remove
# the markUiInputBlindWriteTx / setBlindStructuralTarget calls, run, then revert.

# Conflict/commit regression (coexistence with #4220/#4210/#4343)
deno test -A \
  packages/runner/test/conflict-repro.test.ts \
  packages/runner/test/compute-conflict-recovery.test.ts \
  packages/runner/test/effect-conflict-recovery.test.ts \
  packages/runtime-client/backends/runtime-processor.test.ts
```

The original instrumented prototype (env-gated `CSPROBE` probes that confirmed
the mechanism) is preserved on `origin/scratch/cellset-conflict-probe`.

---

## 7. Key files (with the fix)

| File | Role |
|------|------|
| `packages/runtime-client/protocol/types.ts` | `CellPush` request type + `Commands` entry |
| `packages/runtime-client/backends/runtime-processor.ts` | `handleCellSet` (blind) / `handleCellPush` (CAS) → shared `applyCellWrite`; threads the parent via `setBlindStructuralTarget` |
| `packages/runtime-client/cell-handle.ts` | `push` emits `CellPush` (shared `#applyLocalAndSend`) |
| `packages/runner/src/storage/reactivity-log.ts` | blind-write marker + `ignoreReadForCommit` + `setBlindStructuralTarget` / `getBlindStructuralTarget` (parent-target registry) |
| `packages/runner/src/storage/v2-transaction.ts` | `read()` tags reads + skips `doc.validated` when blind |
| `packages/runner/src/storage/v2.ts` | `buildReads` drops blind reads, emits one `nonRecursive` read at the threaded **parent** (§5.3) |
| `packages/runner/src/index.ts` | exports the marker + structural-target fns |
| `packages/patterns/integration/cellset-lww.test.ts` | regression test (4 steps: scalar/array blind, push CAS, e2e) |
| `packages/memory/test/cellset-structural-precondition-test.ts` | engine-level ancestor-reshape guarantee (parent vs root) |
| `packages/patterns/integration/multi-runtime-{worker,harness}.ts` | `set` (blind) + `push` (CAS) harness commands |

---

## 8. Status & handoff (2026-07-01, session end)

**PR:** [#4245](https://github.com/commontoolsinc/labs/pull/4245), branch
`fix/cellset-blind-leaf-write`, worktree `labs/.claude/worktrees/cellset-probe`.
Rebased onto latest main; HEAD `405c07dbd`, 11 ahead / 0 behind. The full design
is §5.3; §§1–7 describe it in the landed (method-based + parent) form.

### Robin's review
He **endorsed the direction** on Discord (method-based trigger + a structural
precondition), is **OK with the array-CAS drop** (a `set` of an array is now blind
— flagged explicitly; concurrency-safe list edits go through `push` or the
deferred mergeable-op work), and tagged **Ben** for a second opinion. His **formal
PR re-review is pending** — that's the next inbound. When it lands, respond on the
PR (findings-to-chat-first if it's a discussion; direct if it's a code nit).

### CI — one open failure: runner coverage-debt (+2)
Everything else is green (Runner/Pattern/Generated/CFC/Package integration, Check,
Test, wall-time). The **Performance Check** fails only on the coverage-debt
ratchet: `packages/runner` **7864 → 7866 (+2)**. memory (−4) and runtime-client
(−3) are OK (fixed by the rebase catching up to main's coverage).

**The puzzle to resolve next session:** the `+2` is the new structural-target
registry — `setBlindStructuralTarget` / `getBlindStructuralTarget`
([reactivity-log.ts](../../../../runtime/runner/src/storage/reactivity-log.ts) 160–176)
and the `buildReads` emission block
([v2.ts](../../../../runtime/runner/src/storage/v2.ts) ~2315–2345) — uncovered
because runner's own suite never marks a tx blind. I added
`packages/runner/test/blind-write-structural-precondition.test.ts`, and it
**covers those exact lines locally** (verified DA hits: 160–167, 173, 2317–2340 all
>0). **But CI still reports +2 on `405c07dbd` (the run that includes the test).**
So the test's coverage isn't reaching the runner coverage-debt metric. Likely
causes to check:
1. **Which job/shard collects `packages/runner` coverage** — see
   [docs/development/COVERAGE.md](../../../development/COVERAGE.md). If my test file
   isn't in that job's run (or its V8 coverage lands in a shard whose LCOV isn't
   the runner-debt source), it won't count. Confirm the test is actually executed
   *by the coverage-collecting runner job*.
2. **Whether the +2 is different lines** than I covered — run the *full* runner
   suite locally with `--coverage` and list the still-uncovered new lines in
   `reactivity-log.ts` / `v2.ts` (my local check ran only the one test file).
   There may be ~2 uncovered new lines elsewhere (e.g. the `pending`-branch of the
   emission block, or a `getBlindStructuralTarget` chain edge).

**Fallback if it's genuinely not coverable by the runner job:** the sanctioned
override — the perf log emits the exact marker
`NEW_PERF_BASELINE: coverage-debt: packages/runner uncovered lines = 7866 lines`
(placed per [CI_PERFORMANCE.md](../../../development/CI_PERFORMANCE.md) §"Coverage Debt
Baselines"). Prefer real coverage; use the marker only if (1)/(2) show the lines
can't be reached from the runner coverage job.

### Deferred / follow-ups (not this PR)
- **Mergeable-op array RMW** (Robin's idea): `ArrayCellController.remove/update`
  route through `set` and are now blind; the concurrency-safe fix is server-side
  `remove-by-value`/`splice` mergeable ops. Larger, separate change.
- **Two-browser** integration not re-run locally on the method-based form (CI
  covers it).

### Pick-up commands
```bash
cd labs/.claude/worktrees/cellset-probe      # branch fix/cellset-blind-leaf-write
git fetch origin && git log --oneline -3     # confirm HEAD vs origin
gh pr view 4245 --json state,reviewDecision  # Robin's review state
gh pr checks 4245                            # CI (Performance Check = the open one)
gh pr view 4245 --comments                   # cubic / bot / review comments
# reproduce the runner coverage question:
deno test --coverage=/tmp/cov -A packages/runner/test/   # full runner suite
deno coverage /tmp/cov --lcov | awk '/reactivity-log|storage\/v2\.ts/'  # inspect DA
```
