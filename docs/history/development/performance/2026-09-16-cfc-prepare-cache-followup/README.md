---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "Follow-up cache measurements and review findings for CFC preparation PR 7604."
---

# CFC preparation cache follow-up

This records the follow-up to the
[round-two investigation](../2026-09-16-cfc-commit-preparation-round2/README.md)
in [PR 7604](https://github.com/commontoolsinc/labs/pull/7604). The baseline is
the initial PR after merging main, `6fca211368ffc829ee99d8fe0d24c7dcb5acfd3f`.
The measured candidate is that commit plus [measured.patch](measured.patch). Its
`prepare.ts` SHA-256 is
`25f978edb699d478aa2a052246c5e3b7b3900aad02f4c273109d0e9274b4c62e`. This
snapshot precedes the three additional cold-path indexes and schema admission
correction described below; these timings do not measure those later edits.

## Identity and cache lifetime

The V2 store deeply freezes returned values and caches read values by path.
Unchanged data therefore retains identity; changed values receive new
identities. The preparation-local resolver caches source labels by validated
metadata identity and exact logical path, including absent labels. It already
indexed the metadata, but repeated source-path queries still joined overlapping
labels. The result cache removes that repeated join without a process-global
join interner.

Metadata address lookup uses nested space/scope/document/media-type maps. Read
labels capture paths only when a target has an input gate or provenance
measurement is enabled. Every source envelope is still validated on an ungated
target, and every target still inspects the live read journal. Those records
have a different contract from stored values: ordinary read records remain
mutable, and an extension getter can expose writes or change classification
between inspections. A journal-length cache would therefore be unsound.

Writes invalidate metadata-derived label, view, index, and cover caches. A
backend without write inspection clears all of them before each target. Two
regressions use an extension backend that mutates and returns the same metadata
object, with and without write inspection; both fail on the baseline and pass
with the invalidation change. A separate regression mutates a caller-owned read
path during metadata lookup and verifies that gated reads retain the captured
path and refuse as required.

## Paired browser observations

The fixture, completion event, counters, and full label comparison are those of
the original actual-SQL browser ladder. This follow-up measures only N=100,
three repetitions, ordered B1/F1/F2/B2/B3/F3. Each observation uses a fresh
worker and piece. [Raw evidence](browser.json) retains source and fixture
hashes, loads, all six observations, sampled function buckets, and comparison
hashes. Machine load varied considerably; no local full test suite ran during
this lane.

| Observation | Baseline visible ms | Candidate visible ms | Baseline verifier sampled ms | Candidate verifier sampled ms |
| ----------- | ------------------: | -------------------: | ---------------------------: | ----------------------------: |
| 1           |              2895.0 |               3062.3 |                        768.4 |                         431.7 |
| 2           |              1918.4 |               2032.6 |                        545.3 |                         272.3 |
| 3           |              2736.9 |               1780.6 |                        858.5 |                         262.5 |

Visible medians are 2736.9 ms and 2032.6 ms, but paired changes are +5.8%,
+6.0%, and -34.9%. That does not establish a reliable elapsed-time improvement.
Verifier samples decline in all three pairs; their medians are 768.4 ms and
272.3 ms. Total CFC sampled medians decline 1209.7 ms to 643.2 ms; median CFC
profile share declines 38.6% to 27.2%. Sampling covers the whole open, rather
than isolating the instantiation commit. The run neither measures a scaling
slope nor establishes low-N non-regression.

All three pairs preserve all 100 rendered elements, complete label snapshots,
and exact strict-refusal text. Each run prepares 104 commits, issues zero
wildcard queries and one cover call, and mints 600 templates in 200 containers.
The comparator now requires exactly one harness space and renames only `of:` IDs
in addresses belonging to that space. Unexpected cross-space data fails closed;
repeated reference identities must still match throughout the snapshot. All
twelve original browser pairs also pass this stricter comparison
([hashes](original-browser-equivalence.json)).

## Unit observations

The complete 27-point exact R/P/E grid uses the same benchmark and alternating
B/F, F/B, B/F order. [unit.json](unit.json) retains raw process p75 values,
loads, medians, and all additive and product fits. The
[stdlib fitting script](../2026-09-16-cfc-commit-preparation-round2/fit.py)
reproduces the fits.

At R=800, P=200, E=300, preparation is 23.217 ms baseline and 24.302 ms
candidate; flow is 2.513 ms and 2.423 ms; digest is 7.288 ms and 6.779 ms. This
grid does not demonstrate a preparation improvement from the follow-up. Additive
prepare RMSE is 0.757 ms baseline and 1.629 ms candidate. Neither a globally
additive bound nor the literal absence of fitted interaction terms is
established. The browser profiles, rather than this synthetic grid, support the
verifier-allocation change.

## Additional audit and review changes

These changes follow the measured cache snapshot and carry semantic tests rather
than a separate timing claim:

| Step                                  | Indexed behavior and invariant                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema claims overlapping link writes | One path index per target replaces the schema-entry × target-path Boolean scan. Ancestor and descendant matches use the same symmetric wildcard predicate; schema entries still merge in their original order. Concrete query cost depends on path depth and wildcard-source candidates along that branch; wildcard queries retain a scan fallback.                                                                         |
| Authoring identity for a schema field | A map retains the first identity at each exact logical path, then queries deepest ancestors. An explicitly absent deeper identity shadows an attributed ancestor; literal segments and first-input precedence are preserved. Construction is linear in input bytes; lookup depends on path depth rather than the number of policy inputs.                                                                                   |
| Forged reserved-document detection    | A set records every slash-delimited prefix of recorded writes. Each reserved document lookup is constant time; slashes inside document IDs retain the original `startsWith(id + "/")` behavior.                                                                                                                                                                                                                             |
| Combinator callback admission         | Full remaining paths are tested against both eager shallow branch projection and lazy schema combination. Mixed outer type arrays retain branch-only paths; outer-only paths remain admitted when lazy callbacks can read them. Each projected schema is checked against the complete remaining path without merging those alternatives; nested admission remains conservative. Runtime projection semantics are unchanged. |
| Evidence tooling                      | Text files explicitly use UTF-8; JSON streams close through context managers. ASCII-locale fitting/comparison and synthetic identity-reuse/cross-space checks pass.                                                                                                                                                                                                                                                         |

The generated prefix corpus compares both directional prefix and symmetric
overlap answers against the linear predicate, including wildcard queries and
sources. Identity tests cover the deepest unattributed input and conflicting
later inputs at the same path. The forged-grant test includes a slash-containing
document ID. Schema tests inspect actual eager and lazy reads for anyOf, oneOf,
allOf, mixed types, and nested properties, alongside existing reference and
Boolean cases.

## Remaining acceptance limits

The original audit remains a record of the initial implementation. The three
table rows above and source-label memoization close additional avoidable scans.
Live read-journal inspection, per-policy input gates, temporal write-prefix
bounds, schema-envelope accumulation, and several migration/recreation candidate
scans remain. Distinct policies and materialized label bytes can require work
proportional to matches or output, but that is not a justification for every
remaining Boolean scan. A whole-pass additive complexity guarantee remains
unestablished; the strict original unit-fit acceptance criterion is not claimed
complete. The initial four-size browser ladder established near-linear scaling
and minority CFC share for its recorded source snapshot. This follow-up adds
narrower cache evidence and preserved outcomes, not another four-size acceptance
run.

The unannotated SQLite packed-column propagation gap recorded in the original
report also remains separate: both baseline and candidate fixtures require an
explicit parser input policy to preserve the expected label.

## Validation

The full runner suite passed 1,433 tests and 10,150 steps with no failures
(24m15s). The patterns package passed 66 ordinary unit tests with 280 steps,
both source-coverage tests, and its browser case. The focused follow-up run
passed seven suites with 134 steps. Root type-check, repository formatting/lint,
documentation/history-index, conflict-marker, and control-character checks
passed. Independent read-only review found and corrected an invalid keyword
argument in the instrumentation script, then found no further production issues.
The instrumentation script successfully rewrote a disposable source copy under
an ASCII locale.

CI on the baseline checkpoint reported one intermittently uncovered line in
Battleship ship placement. A standalone deterministic test forces a second
candidate to overlap the first ship, then checks the complete nonoverlapping
fleet. Its isolated V8 coverage records `DA:79,1` for
`packages/patterns/battleship/shared/game-logic.tsx`. It runs in the
workspace-resolved source-coverage lane because importing the TSX helper
requires the workspace JSX environment. No production Battleship behavior or
coverage threshold changes.
