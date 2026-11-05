---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "Matched read-count evidence for lift-switch retirement before owner approval."
---

# Lift-switch retirement: matched read counts

The retirement candidate and its exact pre-retirement parent produced identical
handler read counts in all 18 cases and identical collection-loop counts in all
nine cases (27 phase records). This is evidence of unchanged work in those
fixtures, not a latency improvement or completion of the fast-follow matrix.

## Revisions and method

- Baseline: `ccc751b2d4b19005e6a9ef1503a8e94ccc466022`, with lazy lifts enabled
  by default.
- Candidate: `91139fd3aa266f646ec593692b9ce26f547e126f`, with lift
  materialization unconditional.
- Machine and Deno version, plus both complete count sets:
  [results](2026-09-16-lazy-retirement-counts.results.json).

Each command ran once per checkout. The handler runs were sequential, baseline
then candidate. Their diagnostic counts came from separate fresh-runtime passes;
the benchmark also emitted timings with accounting disabled. Those timings are
not compared here: a single ordered pair cannot separate machine drift from a
change in cost. The benchmark's cold heap deltas are not retention evidence.

```sh
HANDLER_DISPATCH_COUNTS=1 deno bench -A --v8-flags=--expose-gc packages/runner/test/handler-dispatch-cost.bench.ts
deno run -A packages/runner/test/collection-loop-read-counts.ts
```

## Handler coverage

At 74, 296, and 1,184 rows, each of `scalarKey`, `scalarGet`, `walk`, `mutate`,
`plainScalar`, and `plainWalk` matched exactly on:

- Preflight read count, shallow read count, and skipped/executed status.
- Per-attempt proxy accesses and link resolutions for preflight, presync, and
  event execution.
- Scheduler node counts before and after dispatch.

This supports retaining eager handler semantics while retiring the lift switch.
It does not qualify lazy handler contexts, cross-space handler conflict sets,
receipt behavior, or external effects.

## Collection coverage

At 32, 128, and 512 rows, `computed`, `lift-wide`, and `lift-narrow` matched on
initialization, an unread title update, and a read amount update. The comparison
covers run counts, writing runs, proxy accesses, link resolutions, distinct
documents, and registered dependencies. All nine unread-title updates caused
zero reactive runs and zero measured reads.

The output's `lazyMaterialization: true` is behavior metadata. The candidate
retains that output field for comparisons; it is no longer a runtime option.

## Remaining work

The [fast-follow plan](../../plans/lazy-materialization-fast-follow.md) still
requires matched timings, mounted browser/headless measurements, same-space and
cross-space comparisons, and a report of their limitations. These synthetic
fixtures do not reproduce the copied lunch poll's current-day filtering or
linked-profile limitations. No live poll or piece was written. Owner approval
and the retirement PR's final CI/review remain separate merge gates.
