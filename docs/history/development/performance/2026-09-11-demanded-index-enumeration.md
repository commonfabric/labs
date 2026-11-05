---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Synthetic measurements of the demand-driven enumeration revision of PR #7323."
---

# Demand-driven index enumeration

The producer revision in [PR #7323](https://github.com/commontoolsinc/labs/pull/7323)
completed 512 independently linked rows with unique keys and with four duplicate
buckets. The comparison used the same local probe whose eager-enumeration
version exhausted the JavaScript heap at 512 unique keys. A diagnostic that
removed enumeration established the source of that growth; the measured repair
used a real, separately demanded enumeration child.

These are sums from completed `scheduler.run.complete` action bodies with read
statistics enabled. They exclude compilation, action setup outside those bodies,
and other runtime costs. Concurrent local validation makes wall-clock comparisons
inappropriate. They are not measurements of the deployed poll.

| Observed outputs | Distribution | Initial proxy reads | Unrelated key edit: runs / proxy reads | Selected key edit: runs / proxy reads |
| --- | --- | ---: | ---: | ---: |
| One lookup | 512 unique keys | 1,027 | 2 / 22 | 4 / 23 |
| One lookup | 512 rows, four buckets | 618,755 | 2 / 2,435 | 4 / 2,437 |
| Lookup and keys | 512 unique keys | 5,126 | 4 / 4,118 | 5 / 4,119 |
| Lookup and keys | 512 rows, four buckets | 618,790 | 5 / 2,476 | 6 / 2,486 |

An unrelated payload edit caused zero action runs and zero measured reads in
all four cases. Observed enumeration was checked for its initial key count and
for each newly introduced key. Each phase also checked whether the selected
lookup should remain unchanged or lose its original winner.

## Probe protocol

Each distribution used a fresh emulated storage manager and runtime. Rows were
separate Cells with `{label, title}`; the source array retained their links.
Labels were `key-i` for unique keys and `key-(i % 4)` for duplicate buckets.
Titles were `Row i`. The compiled pattern built `rows.keyBy(row => row.label)`
and returned `index.lookup("key-0")?.title`. The enumeration variant additionally
returned `index.keys()`.

After subscribing and awaiting runtime idleness, the probe identified the actual
winning source from its title. It reset counters before each transaction:

1. Change an unrelated source's title.
2. Move that source to a fresh key.
3. Move the selected winner to a different fresh key.

Each transaction committed before awaiting idleness and recording results.
Cleanup removed telemetry listeners and demand, disposed the runtime without
closing storage, then explicitly closed storage once.

## Acceptance boundaries

Demand-driven enumeration removes the repeated full occupied-key scan from
lookup-only membership maintenance. It does not eliminate affected-bucket
rebuilding: the skewed initialization remains expensive. Observing all keys
also legitimately requires enumeration work on occupancy changes.

Mixed primitive/Cell key enumeration was not accepted. A separate test found
that schema generation discarded Cell metadata from `string | Cell<string>`;
[PR #7325](https://github.com/commontoolsinc/labs/pull/7325) addresses that loss.
Preserving the metadata alone makes the runtime wrap primitive union values as
Cells too. The enumeration representation requires a separate API/runtime
decision before the producer can be declared complete.
