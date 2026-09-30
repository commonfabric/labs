---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Live probe of exact citation selectors, synthesis catalogs, and one bounded repair turn before automatic root research."
---

# Citation correction probe

The dinner research task returned a complete kit after two research invocations.
It used fewer tokens than the
[preceding probe](research-corrected-probes-2026-09-14.md) but took longer. The
first invocation exercised the new citation correction turn and repeated its
invalid ID; strict admission correctly kept that kit incomplete. The final kit's
source failed compilation on an action input-type mismatch. This run therefore
did not establish reliable single-pass research or a working application.

## Setup and result

The task and console configuration matched the preceding dinner probe: explicit
research-only instructions, parent `gpt-5.6-sol`, private `gpt-5.6-luna`, owned
console `8186`, Ben's toolshed `8001`, and publication disabled. The
discoverable index remained at 41 entries. No pattern was executed, published,
or assigned a slug by the live task.

The source snapshot was `af916cf0cc79377deeeb4e2707bd66794308acd8` plus the
runner and focused-test diff saved as `research-citation-live.patch`. It echoed
`sectionId` on documentation reads, distinguished selector/citation/binding
namespaces, included exact current sources at forced synthesis, and allowed one
tool-free citation correction within the existing eight-turn budget. The runner
was frozen during this live invocation.

| Measurement                | This probe                             | Preceding dinner probe                 |
| -------------------------- | -------------------------------------- | -------------------------------------- |
| Root run                   | `09375ce3-a3c7-492a-b85f-d0b5b05ca162` | `89a8e0ee-8a6a-4e8b-a265-42afe0a5addf` |
| Whole turn                 | 314.704 seconds                        | 289.340 seconds                        |
| Total tokens               | 258,469                                | 321,565                                |
| Parent tokens              | 24,921                                 | 42,310                                 |
| Private tokens             | 233,548                                | 279,255                                |
| Cached input tokens        | 135,040                                | 98,688                                 |
| Parent model turns         | 3                                      | 4                                      |
| Research invocations       | 2                                      | 3                                      |
| Private model turns        | 14                                     | 16                                     |
| Private tool calls         | 46                                     | 63                                     |
| Final kit                  | Complete                               | Complete                               |
| Unchanged example compiles | No                                     | Yes                                    |

The first research call took 139.973 seconds and used seven model turns, 22
private calls, and 54,030 exact read characters. It opened the amount-ledger
source with ID `pattern-source:b977a6491e25d31d` and omitted the final `d` in
its answer. The correction prompt included both the invalid ID and the exact
source catalog. The model repeated the invalid ID. No alias or approximate match
was admitted, and no additional reads occurred during correction.

The second call took 105.567 seconds and used seven model turns, 24 calls, and
31,652 read characters. It returned a complete kit without a correction turn. It
reused the indexed checklist and proposed a custom ingredient editor because the
indexed amount ledger did not edit existing amounts. That adds an editing
requirement beyond the task's explicit request for a running total, so its
different implementation limits comparison with the two-component preceding
recipe.

## Compilation and next step

The final source imported the checklist under its verified identity. The
isolated compile-only probe failed because its output interface declared
`addIngredient` as `Stream<{ label: string; cost: number }>` while the
implementation's parameterless `action(() => ...)` returned `Stream<void>`. No
source was corrected for the probe, and no rendering result is claimed. Kit
admission established recorded evidence and identity, not successful
compilation.

The next test is automatic research followed by an actual pattern author and
compiler on the ordinary dinner-page request. That tests the handoff's intended
consumer and records whether the compiler needs corrections. It runs against a
separate local Fabric store, where browser editing and persistence can be
checked without changing Ben's existing stores.

## Artifacts

All paths below were under
`/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/` on the test host:

- `research-citation-suite.json` and `research-citation-live.patch`: exact task
  and measured source changes.
- `research-citation-live/`: batch preflight, unchanged index inventory, and
  explicit run-ID measurements. The known grant-message matching defect made the
  batch's automatically attributed counts unusable.
- `research-console/runs/09375ce3-a3c7-492a-b85f-d0b5b05ca162/`: full run
  report, parent transcript, and both private research artifacts.
- `research-citation-composition.tsx` and `.check.json`: unchanged final source
  and compiler diagnostic.
