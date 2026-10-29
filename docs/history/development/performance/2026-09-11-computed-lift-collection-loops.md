---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "E1 comparison of equivalent compiled collection loops under default lazy materialization."
---

# Computed and lift collection-loop reads

At runtime revision `94a5cf92b3e8241f222bfc745557589f88f8542d`, equivalent
`computed`, broadly typed `lift`, and narrowly typed `lift` reductions produced
identical completed action-body read counts at 32, 128, and 512 independently
linked rows. `lazyMaterialization` was left at its default and reported `true`.

## Workload and reproduction

From the repository root, run:

```sh
deno run --unsafe-proto -A packages/runner/test/collection-loop-read-counts.ts
```

The [report command](../../../../runtime/runner/test/collection-loop-read-counts.ts)
compiles three authored patterns through the runtime compiler. Each sums the
`amount` field using the same left-to-right JavaScript reduction. The computed
captures the input collection; the two module-level lifts receive it explicitly.
The broad row type declares `amount` and an unread `title`; the narrow lift
argument declares only `amount`. Inspection of emitted schemas confirmed both
fields in the computed and broad lift, and only `amount` in the narrow lift.

Each row is a distinct same-space cell. Initial amounts are the integers from
zero through N−1. The numeric result stays demanded while the final row's title
is changed, then its amount is changed from N−1 to N. The command checks the
initial sum and both subsequent results. Fresh emulated storage and a fresh
runtime isolate each form and collection size.

Read statistics are enabled immediately before the initial run. Each phase sums
`reads` from completed `scheduler.run.complete` events, counting writing runs
separately. Distinct documents are summed per action, not unioned across the
phase. These counters exclude compilation, setup outside action bodies, and
commit costs outside that boundary. This is a headless synthetic measurement;
it reports neither elapsed-time improvement nor deployed-poll behavior.

## Results

All three forms had the following identical counts. Initialization ran three
actions, one writing; an amount update ran two, one writing. A title update ran
zero actions and recorded zero reads at every size.

| Rows | Proxy accesses, initial/update | Link resolutions, initial/update | Documents, initial/update | Dependencies, initial/update |
| --- | ---: | ---: | ---: | ---: |
| 32 | 65 / 65 | 35 / 35 | 39 / 38 | 172 / 171 |
| 128 | 257 / 257 | 131 / 131 | 135 / 134 | 652 / 651 |
| 512 | 1,025 / 1,025 | 515 / 515 | 519 / 518 | 2,572 / 2,571 |

The amount update scans the collection in every form. Changing from computed
to lift, or narrowing this lift's declared argument, did not remove that scan.
The unread title did not cause invalidation even when the argument schema
included it. This agrees with lazy argument materialization registering the
paths the callback actually reads.

The result is limited to these valid, linked rows and this reduction. It does
not establish equivalence for invalid data, schema defaults, nested objects,
network subscriptions, handlers, other experimental postures, or timing.
Named incremental aggregates have separate numeric and update contracts; they
are not automatically interchangeable with an order-dependent reduction.
