---
status: historical
created: 2026-10-13
archived: 2026-10-13
reason: "PR feedback corrections and measurements after integrating main."
validation: "https://github.com/commonfabric/labs/pull/8814"
---

# Immutable cell feedback: ownership, events, and measurement correction

This record covers the feedback changes to PR #8814, integrating main at
`676e4cae1b` with the native snapshot implementation at `1e2f2e317f`.
The live contract is [Immutable cell identifiers](../../../../features/immutable-cell-identifiers.md).

## Corrections

Stores acquire nested snapshots in ordinary values, codec state, schema
closures, and saved origins. Incomplete closures remain available to the
normal schema loader. A registry notification lets waiting stores acquire
newly visible defaults before the registering caller can dispose their source.
Expired snapshot reads return an attestation error rather than throwing past
that API. Mapping codec state isolates mutable caller-owned references before
freezing the result.

Local events retain immutable links, matching main's array identity contract.
Durable events and their client echoes carry portable data-URI links. Link
equality compares canonical content across native and portable forms, while
retaining the address's space, scope, and path. Content hash caches omit
incomplete schema resolutions and clear with the schema registry.

Shared-graph storage traversal memoizes completed nodes by context. Conversion
uses operation-local caches for failed frozen and Fabric-membership checks,
so a frozen chain ending in one mutable or non-Fabric value is not repeatedly
scanned. The LLM traversal already used ancestor-local sets; its shared-child
regression passed before any algorithm change.

## Corrected measurement probe

The original report's `sharesFrozenGraph` field checked a separate frozen seed.
It did not describe the mutable inputs being timed. This run records
`sharesMeasuredInput` from each native result and its actual timed input,
outside the timed interval. Mutable input is not retained by identity.
Fresh frozen inputs also report false here: each case has already registered
an equal seed, so content deduplication returns that existing frozen graph.
Reused frozen inputs report true. The separate semantic preflight checks that
an empty store retains frozen input by identity and preserves relative links.
The original historical report is retained unchanged as required by the
repository's documentation policy; this record corrects its interpretation.

Command: `deno run -A packages/runner/test/immutable-cell-measure.ts`.
Deno 2.9.4, V8 15.0.245.2-rusty, TypeScript 6.0.3. Each case excludes two
warm-up pairs, records seven pairs, and alternates arm order. Reused cases
perform ten iterations per sample; fresh cases perform one. Fixture creation
and semantic checks are outside timing. [Raw pairs](paired.json) accompany
these medians.

| Schema | Rows | Input | Legacy median ms | Native median ms | Measured input reused |
| --- | ---: | --- | ---: | ---: | --- |
| inline | 100 | fresh frozen | 15.674 | 169.569 | false |
| inline | 100 | fresh mutable | 520.820 | 518.078 | false |
| inline | 100 | reused frozen | 40.683 | 0.003 | true |
| inline | 1000 | fresh frozen | 97.159 | 416.580 | false |
| inline | 1000 | fresh mutable | 1990.238 | 1136.156 | false |
| inline | 1000 | reused frozen | 80.664 | 0.003 | true |
| reference | 100 | fresh frozen | 1.267 | 14.959 | false |
| reference | 100 | fresh mutable | 1.179 | 1.709 | false |
| reference | 100 | reused frozen | 4.354 | 0.003 | true |
| reference | 1000 | fresh frozen | 102.966 | 246.294 | false |
| reference | 1000 | fresh mutable | 95.992 | 132.499 | false |
| reference | 1000 | reused frozen | 64.165 | 0.003 | true |

This was a contended local run, not an isolated benchmark: runner/data-model
package tests, the workspace type-check, a main comparison, and the original
integration run were active. The [host receipt](host.txt) recorded load averages
270.71 / 224.49 / 221.64, 49.85% CPU idle, about 121 GB physical memory used,
and about 6 GB unused. Those concurrent jobs include both client-side and
served-runtime tests; this harness itself performs no network operations.
Fresh-input timings are mixed and often slower on the native arm; they do not
establish a cold-creation speedup. The reused graph's roughly 0.003 ms medians
and bounded 96-character identifiers demonstrate the intended fast path,
without implying an end-to-end pattern latency gain.

## Validation limits at measurement time

The targeted ownership, portable event, and shared-graph tests passed, including
late schema registration and recovery from an initially incomplete content hash.
The local pattern lane passed all assertions for amount-ledger, check-list, and
card-piles. The actual served lane used `EXPERIMENTAL_SERVER_EXECUTION=true
deno task cf test` because the integration runner forces its in-process
`pattern-tests` lane off regardless of that environment variable.

The served three-pattern run reported 96 assertions passing and 6 failures on
the branch, versus 82 passing and 20 failures on main at `676e4cae1b`.
[The failure lists](served-pattern-comparison.json) show two branch-only
amount-ledger assertions at the first action; four failures matched main.
Isolating amount-ledger produced 28 passing / 11 failing on the branch and
33 passing / 6 failing on main, with different failing assertion sets and
values frequently lagging the preceding action. Both arms ran under shared
host contention. These runs establish neither a clean served suite nor proof
that every branch failure is pre-existing; served pattern validation remains
inconclusive. The deterministic portable append/echo and identity regressions
passed. The full data-model package suite passed 83 suites / 4,233 steps.
Full runner results are reported separately with the PR validation.
