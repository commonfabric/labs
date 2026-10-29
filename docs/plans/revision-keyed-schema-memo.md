# Revision-keyed schema memo

A cross-evaluation, per-document memo of schema-walk computation on the
memory server, keyed by each document's revision, sitting underneath the
query evaluation cache. It makes the first evaluation after a commit — and
every evaluation of a query shape the evaluation cache has not seen — cost
roughly what changed, instead of the whole corpus.

## Problem

Evaluating a graph query walks every reachable document against its schema
selector, and the walk is essentially the entire cost. On the estuary board
corpus (Aug-18 clone, 113 topics, 6,112 reachable documents, measured
2026-08-28 at the `trackGraph` level): a cold evaluation is ~1.4 s, and it
is still ~1.4 s when every document's decoded form is already cached —
schema narrowing dominates (~1.1 s inside the traverser), not decoding.

The query evaluation cache (`QueryEvaluationCache`,
`runtime/memory/v2/query.ts`) removes that cost for one shape of repeat:
the same query, unchanged corpus, between two commits — a hit is ~2.5 ms at
the same measurement level. Any commit rotates it, different query shapes
share nothing through it, and the per-session refresh and extension paths
sit outside it. That leaves two classes of repeated walk: whole evaluations
(the first evaluation after a commit, overlapping queries with different
roots, new-branch watch establishment, and full watch-set re-establishment)
and the stateful incremental extension/dirty-refresh paths. Stages 1–2 of
this plan target the first class; the second remains canonical-graph work.

## The design in one paragraph

Memoize the per-document schema-walk computation in a per-engine store,
keyed by (branch, scope instance, id, document path, document revision,
interned schema selector). Validity is by key construction: the revision is
part of the key, so an entry for a superseded revision is simply never
matched again — no invalidation graph, no rotation, no write hooks;
retention is access-order LRU plus an entry-count budget. An entry carries
the narrowed result and a manifest of the traversal's direct effects; a hit
replays the manifest through the current walk's own bookkeeping —
re-deriving registrations under the current identity, never replaying
another traversal's recorded effects.

## What the engine already provides

- **The revision is known at load time.** Every read resolves a row
  carrying `row.seq` (and `op_index`) — the revision of the document's
  current state (`readState` → `readRowForBranch`,
  `runtime/memory/v2/engine.ts`). No watermark bookkeeping needs to be
  added for the consult: the load the walk performs anyway supplies the
  key component.
- **Revision-keyed caching at this seam has working precedent.** The
  engine's `documentCache` already keys each document's decoded form by
  (branch, id, scope key, `row.seq`, `op_index`, …). This memo is the same
  idea one level up: the narrowing computed from that decoded form.
- **The generic traversal has a single choke point.** Its schema narrowing
  funnels through one memo consult in `traverseWithSchema`
  (`runtime/runner/src/traverse.ts`), today keyed by document address
  plus schema hash and scoped to a single traversal. The cross-evaluation
  layer is consulted at the same point. The schema-typed traversal is a
  separate path and does not pass this seam; Study 3 in #6473 found that it
  is the dominant board path, so covering it is an explicit stage below
  rather than an assumed property of the first implementation.
- **The walk visits roots; the traverser crosses documents.** The server
  walk (`GraphQueryWalk`) visits query roots, and the traverser's own
  recursion reaches the rest of the graph, registering reach (tracker
  entries, absent-link misses) as side effects of first computation. The
  memo therefore slots in without restructuring traversal.

## Why entries must carry their effects

A traversal's registrations — which watchers to notify when a document
changes — happen as side effects of computing a subtree, and an
already-covered (document, selector) skips its subtree including those
registrations. The existing memo's own comment states the consequence: an
entry living past its traversal would answer a later traversal that never
recorded its reads. Measured concretely: injecting one evaluation's warm
memo into a fresh evaluation returns in ~17 ms but registers and delivers
23 of 6,112 documents. A cross-evaluation entry is therefore not a bare
value: it must carry what its computation *did*, and a hit must re-derive
those effects in the current walk. Re-derivation is cheap — replaying the
full board reach (8,524 registration pairs) costs ~2 ms.

## Design decisions

1. **Key**:
   `(branch, scope_key, id, document path, revision, interned schema)`,
   where `revision` is the row's `(seq, op_index)`. The document path is
   separate from the schema: two walks may narrow different addressed
   subtrees of the same document revision under the same schema. The scope
   component is the resolved instance, never the scope name — identity-safe
   by construction (`key-vocabulary.md` §5's vocabulary). For this layer,
   instance keys replace the single-identity tripwire that guards today's
   shared memos (`assertSchemaMemoIdentity`); the tripwire's job — making
   cross-identity sharing loud — is done here by keys that cannot collide
   across instances. The §5 inventory gains this entry when the
   implementation lands.
2. **Entry value**: the narrowed result (parents compose their own
   narrowing from child results) plus a **direct-effects manifest**: the
   registrations this document's own traversal makes, links out with the
   selector each carries, absent-link misses — all in scope-unresolved
   form (scope + id, not instance) — and the direct children with the
   revision each was read at.
3. **Hit protocol**: recursive. Validate children by re-reading their
   revisions and consulting their entries; replay manifests into the
   current walk's tracker and miss recorder, resolving scopes under the
   current identity. A changed document invalidates, through revision
   mismatch, exactly the ancestor chain from it to the root; the rest of
   the graph serves from entries. Replaying a closure also promotes the
   whole closure in access order, child-first and root-last, so a hot parent
   is not retained after the dependencies needed to validate it are evicted.
4. **Scoped reach**: an entry whose own subtree crosses a user- or
   session-scoped link, or records a scoped miss, is keyed with an identity
   suffix and serves only its identity. Taint climbs only the ancestor chain
   of the scoped link, so the cross-identity recompute is bounded to those
   chains (the board corpus has four, shallow). Absence is a revision state
   of its own: validation re-reads it, a creation strands the old key, and a
   scoped absence stays identity-tainted while a space-scoped absence may
   be shared.
5. **Storage**: per-engine, beside `documentCache`; access-order LRU with a
   non-negative entry-count budget (initially 32,768). No rotation —
   revision keys strand superseded entries and LRU retires them.
6. **Recipient-blindness**: sharing narrowing across identities rests on
   the same invariant the evaluation cache documents — evaluation is
   recipient-blind, and a per-recipient filter inside evaluation (CFC
   label enforcement, say) must key or bypass this memo too
   (`key-vocabulary.md` §5).

## Composition

The memo sits **under** the evaluation cache; the two answer different
questions. The evaluation cache answers "may I hand this identity the
whole result computed for another ask" — one clone serves a reconnect
stampede of N clients at ~2.5 ms each, with scope purity and
absent-residue rules deciding who may share. The memo answers "how much of
this walk changed since something last walked it" — it survives commits to
unrelated documents and serves across query shapes on the whole-evaluation
paths named above. Stages 1–2 do not accelerate `extendTrackedGraph` or a
session's dirty `watch.refresh`; both mutate per-session tracker state and
remain outside this shared memo. A realistic memo hit on the board corpus
is the ~17 ms floor plus producing 6,112 entity snapshots (~200–300 ms
today); a **per-revision snapshot cache** — the serving-layer sibling of
`documentCache`, staged below — brings that to tens of milliseconds.
Whether the evaluation cache still earns its keep once this layer is warm
is a question the evaluation cache's per-class diagnostics counters answer
with production numbers, not one this plan pre-judges.

## Measured baseline (2026-08-28)

Board clone, `trackGraph` level, five iterations, medians:

| Arm | Meaning | Median |
| --- | --- | --- |
| A | Cold evaluation, fresh engine | ~1.4 s |
| B | Re-evaluation, decoded forms cached, fresh memo | ~1.4 s |
| C | Fully warm injected memo (floor; under-registers) | ~17 ms |
| D | Evaluation-cache hit | ~2.5 ms |
| E | Re-registering all 8,524 reach pairs (replay cost) | ~2 ms |

A realistic memo hit lands between C+E and B: ~250 ms dominated by
snapshot production, or tens of milliseconds with the snapshot-cache
stage.

## Stages

Status on 2026-08-31: #6473 implements the generic-traversal portions of
Stages 1–2 behind an off-by-default server flag. Its Study 3 measurement
found no hits on the dominant board query because that query takes the
schema-typed path, which is why Stage 3 is a shipping prerequisite rather
than optional follow-up work.

- [ ] **Stage 1 — memo store and capture.** Per-engine store, key,
  manifest capture during traversal, behind an experimental flag
  (registered in `docs/development/EXPERIMENTAL_OPTIONS.md`); no serving
  yet. Pins: capture is effect-complete (manifest replays to the same
  tracker and miss state a fresh walk produces).
- [ ] **Stage 2 — hit protocol.** Recursive validation and replay; scoped
  taint keying; wired into the generic whole-evaluation server walk. Pins:
  delivery liveness through a memo-served walk; a child revision change
  re-computes exactly the ancestor chain; scoped-tainted entries never
  cross identities; full-suite parity between flag-on and flag-off
  evaluation results.
- [ ] **Stage 3 — schema-typed traversal coverage.** Extend the capture,
  validation, and replay seam to the schema-typed path without changing
  its narrowing or tracker effects. Pins: the estuary-shaped query records
  cross-traversal hits, the generic and typed paths produce identical
  reach with the flag off/on, and incremental extension/dirty refresh
  remain explicitly out of scope rather than being enabled accidentally.
- [ ] **Stage 4 — per-revision snapshot cache.** Entity snapshots keyed
  by document revision, so memo-served evaluations stop re-assembling
  unchanged documents.
- [ ] **Stage 5 — default-on and measurement.** Estuary A/B with the
  evaluation cache's diagnostics; revisit evaluation-cache retention with
  those numbers.

## What stages 1–2 do not reach

The memo is consulted where a whole evaluation begins: new-branch watch
establishment, full watch-set re-establishment, and one-shot graph
queries. `extendTrackedGraph` and the per-session dirty-refresh paths are
excluded, exactly as they are from the query evaluation cache — their
effects entangle with per-session tracker state, and sharing them is the
canonical-graph work. So extending an already-tracked branch or refreshing
an established session walks its affected reach unmemoized, and a space
whose sessions mostly extend or refresh rather than establish sees
correspondingly less of the benefit.

Two other boundaries worth stating, both enforced in code: an evaluation
whose query names an explicit scope instance (a lease-holder read)
bypasses the memo entirely, because memo keys resolve their instance from
the evaluating identity; and while a walk is capturing, coverage skips
and cross-frame reuse of the traverser's own DAG memo are disabled, since
either would make a frame's recorded effects depend on what the rest of
the walk covered first.

## Non-goals

- **Scope-frontier stitching** (a shared walk prefix with per-identity
  scoped subtrees stitched at serve time): a later phase that would build
  on this layer's entries; tracked in the Discord design thread, not
  here.
- **Write-time link extraction** (persisting each document's outgoing
  links with their paths at commit time): the storage-side attack on the
  same cost, strongest for wide-open (`schema: true`) selectors, and the
  path to reverse-link lookups. Separate justification, separate plan.

## Open questions

- The exact capture seam for the schema-typed traversal: it must expose the
  same direct effects without routing typed reads through the generic
  materialization path.
- Budget tuning after real-corpus measurement. The implementation starts at
  32,768 entries, but the right bound depends on typed-path entry count and
  closure-retention behavior.
- Whether the per-revision snapshot cache still pays for itself once the
  typed path is memo-served; decide from the staged measurement rather than
  carrying the original estimate as a conclusion.
