---
status: historical
created: 2026-09-19
archived: 2026-09-19
reason: "Closeout of the default-on lazy-materialization investigation and measurement follow-up, with explicit deferrals and measurement limits."
---

# Lazy materialization fast-follow closeout

The fast-follow completed its default-on evidence and guidance work. Handler
lazy materialization remained deferred under its reviewed contract decision;
rollout-switch retirement remained optional owner-led work. This closeout
changed no runtime behavior and authorized no live-space update.

## Measurement matrix

| Surface                 | Evidence                                                              | Outcome and boundary                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handler reads and graph | [Raw final counts](2026-09-19-lazy-fast-follow-closeout.results.json) | All 18 workload/size cases matched the earlier default-on baseline's count fields; one scheduler node before and after every dispatch.                                     |
| Collection loops        | Same raw final counts                                                 | All nine cases and their 27 phases matched the earlier baseline exactly, including zero reruns for unread-field edits and full traversal for changed reduction inputs.     |
| Handler timing          | [Handler report](2026-09-18-default-on-handler/README.md)             | Eighteen cases with accounting disabled, eight timed samples each, and separate phase records. No matched before/after latency claim.                                      |
| Mounted browser         | [Browser matrix](2026-09-18-default-on-browser/README.md)             | Three vote-list sizes, both profile locations, five diagnostic and four timed samples per case. Same-space and cross-space reactive counts matched at each size.           |
| Timing confounds        | [Fresh-store pair](2026-09-18-default-on-fresh-store/README.md)       | Both locations could be slow at 1,184 votes; stable read counts did not explain wall-clock variation.                                                                      |
| Headless fixtures       | Browser matrix's linked headless results                              | Nine tests passed at the same revision. Render/rematerialization windows differ from continuously mounted browser updates and are not treated as equivalent count windows. |
| Retained heap           | Raw final counts                                                      | The cold-runtime probe remained inconclusive: deltas ranged from -1,776,576 to +310,144 bytes. It does not qualify retention or allocation improvements.                   |

The final count pass used revision
[`f3494fe9547d6589dad8e382e2392f14b8e0cebf`](https://github.com/commonfabric/labs/tree/f3494fe9547d6589dad8e382e2392f14b8e0cebf),
the same revision as the browser and handler timing records, with Deno 2.9.4 on
macOS Apple silicon. Counts were compared against the baseline arm at
[`ccc751b2d4b19005e6a9ef1503a8e94ccc466022`](https://github.com/commonfabric/labs/tree/ccc751b2d4b19005e6a9ef1503a8e94ccc466022)
in the [paired count record](2026-09-16-lazy-retirement-counts.md). Only
deterministic handler count fields were compared: size, workload, node counts,
read-attempt fields, and preflight skipped/read/shallow-read fields. Handler
phase durations and heap deltas were excluded from equality checks. All
collection-record fields were compared. This uses the default-on baseline, not
the optional retirement candidate, as the reference.

Reproduction from the pinned revision:

```sh
HANDLER_DISPATCH_COUNTS=1 deno bench --frozen -A \
  --v8-flags=--expose-gc --filter '__counts_only__' --json \
  packages/runner/test/handler-dispatch-cost.bench.ts

deno run --frozen -A packages/runner/test/collection-loop-read-counts.ts
```

The handler diagnostic pass runs during module loading. The filter deliberately
selects no timed benchmarks, keeping this accounting pass separate from timing.
Capture its JSON diagnostic lines from stderr. The collection probe emits
`LOOP_SCALE=` records. A fresh isolated Deno cache was used after the previous
cache was found to contain missing npm package files; the lockfile and source
revision were unchanged.

## Decisions and consequences

The evidence supports the default-on behavior and its stated read boundaries. It
does not support advertising a general latency improvement, constant-time
whole-list updates, lower retained memory, or an eager-mode rollback guarantee.
Those claims require their own experiments; they are not inferred from a lower
or stable read count. The existing collection and read-accounting guidance
continues to distinguish reactive maintenance, handler work, and elapsed time.
Benchmark guidance additionally requires recording observed sample counts and
the actual timer boundary rather than assuming the requested iteration count or
an internal phase timer defines the reported statistic.

The handler deferral is unchanged. Its read log is also its commit conflict set;
narrowing materialization changes which concurrent writes a handler rejects. The
[handler investigation](2026-09-11-lazy-handler-context-prototype.md) retains
the owner decision and unverified cases required before reopening that work. The
three deferred acceptance bullets were not relabeled as passing tests.

The flag owner may retain, repair, or retire the switch independently. The
[reload diagnosis](2026-09-15-lazy-reload-diagnosis.md) still prevents treating
flag-off as a qualified rollback. This arc neither approves that operational
choice nor drives the retirement proposal's merge.

## What would reopen measurement work

A materialization behavior change requires a new pinned comparison with matched
inputs and demand. A latency claim requires repeated interleaved arms, fresh
stores, an unchanged control, and attribution across handler, commit, and render
phases. A retention claim requires a warmed runtime and repeated post-GC
measurements that separate setup garbage from surviving state. These are
conditions for future claims, not conclusions supplied by this closeout.
