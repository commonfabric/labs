---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Three-trial checkpoint comparing original query_docs with automatic research, including syntax and CFC guards; three planned trials remain pending."
---

# Research guards and the original-tool comparison: three-trial checkpoint

The two completed guarded-research trials each produced a working composition
on their first source submission. The original-tool trial also composed the
same indexed components, but required three compiler corrections and produced
incorrect starter currency amounts. Browser interaction and persistence worked
in all three; only the research trials passed the monetary-unit check.

This is a partial comparison: A1, B1, and B2 completed; A2, A3, and B3 did not
start model calls. The planned order is A1/B1, B2/A2, A3/B3. Automatic approval
review rejected the A2 launch twice despite the earlier affirmative reply to a
question naming the payload and destination. A self-contained authorization
request naming the remaining trials, nonpublic payload, and `chatgpt.com` is
pending. The refusals are authorization events, not failed model trials.

The observations support a useful improvement on this task. They do not yet
provide three completed pairs, establish a population success rate, or isolate
the contribution of the syntax guard from the rest of the research workflow.

## What was built

The host's bounded `research` service can search the configured documentation
and skills corpus, reopen exact document sections, search the pattern index,
inspect indexed programs and files with verified identities, and describe
available handles. It returns a compact implementation kit with an approach,
confirmed patterns and inputs, steps, complete example, cited rules,
verification advice, and explicit blockers. The private transcript and exact
reads stay in artifacts; the parent receives the admitted kit and provenance.

Fresh root tasks run the same service before the parent model. Explicit focused
queries use that service too. Delegated children inherit the kit and confirmed
records; resumed runs recover the handoff without repeating opening research.
The private loop remains bounded to eight model turns and 24 tool calls. An
exact citation catalog and at most one tool-free correction preserve strict
admission without fuzzy matching or accepting unread source IDs.

The new syntax guard parses complete pattern-source examples with the cached
TypeScript compiler stack. It retains the entire example and evidence, records
structured diagnostics, and downgrades a claimed-complete kit when syntax is
invalid. Guidance directs the parent or author to fix those diagnostics without
repeating research. It does not resolve imports, check types, execute a pattern,
or run a model-driven test loop. The earlier malformed import,
`import { new Writable, pattern }`, now produces TS1003 at 1:10 and TS1005 at
1:14 in the focused regression test.

Research also joins known CFC source labels from the task, prior model context,
documentation, and exact handle-label views across every observed candidate,
including unselected sources. The full source label is diagnostic metadata;
only confidentiality propagates into the existing model-context observation
system. Operator-provisioned integrity is not conferred on generated advice.
Public results, private artifacts, durable summaries, opening recovery, and
delegated context retain the corresponding information.

The index API supplies no CFC label metadata, and its source-access contract is
restricted. Indexed metadata and source therefore produce explicit missing-label
coverage. Publication does not imply public or clean classification. Legacy
research summaries without labels and unavailable handle labels also produce
coverage gaps. This exposes the upstream classification gap; it does not invent
labels or establish complete enforcement over unclassified source influence.

## Controlled setup

Every trial received exactly:

> Make me a dinner-party preparation page with a checklist of what I need to
> prepare and a running total of ingredient costs.

| Condition | Source and behavior |
| --- | --- |
| A: original | `314e4e88621c99306b2effb6d7d2723055aa4ffb`, original `query_docs`, prompts and source access, with ordinary index search and author skills retained; no opening research. |
| B: guarded research | `af916cf0cc79377deeeb4e2707bd66794308acd8` plus frozen automatic startup, citation repair, syntax admission, and CFC propagation. |

Both conditions used parent/author `gpt-5.6-sol`, helper `gpt-5.6-luna`, the same
Fabric runtime on port 8286, and identical files in the configured corpus.
Trials ran serially in fresh sessions and isolated spaces with publication
disabled. Every initial space had zero handles because it had no default
pattern anchoring a piece registry. This task needed no external data; the
comparison did not test real connector grants.

The frozen index served 302 metadata records and 41 discoverable programs plus
their dependencies. Its isolated handler preserved captured search and source
responses; recorded usage events did not change ranking, and publication was
refused. The deployed index was not mutated. Five search responses and all 41
discoverable source responses were checked against the captured responses.

Snapshot hashes:

- Index: `d6541bb494489db175f59ebd1657477082fa47721b01fbec547a37f9114fe21e`.
- Corpus: 174 files, manifest
  `a9588f2de01aeb9d156b856b904b7f21d3c8de90239c94a6ebc3704b85b5ef46`.
- B runtime patch used by B1/B2:
  `3d348c057959835aa7515f78f53084a522a865a897b1a292414b040f0c2149f2`.

After the completed trials, lint identified one unused type-only import in the
research runner. Removing it produced byte-identical emitted JavaScript,
SHA-256 `66b7c016514a34e676ed694821ed814dbb2b37342a7c278dc3c9eb78427b967c`.
The resulting runtime patch hash is
`90d9632abd623f94d12daf3ba2728af35f9752e4392668f24468d0669a090c3f`. The
manifest records this source-only cleanup explicitly for the pending B3 trial.
No prompt, corpus, budget, or behavior was tuned between B1 and B2.

Measurement attribution was repaired before the trials: the driver binds the
console turn to its exact root run, reads complete submitted-source sidecars,
and includes opening research, private attempts, and delegated usage without
counting inherited research again. The instrumentation did not change either
condition's model inputs. An initial A1 preflight refused a mismatched default
base SHA before any model call; it is excluded and retained in the manifest.

## Trial outcomes and cost

Wall time is root creation to completion, including descendants and helper
work, and excludes the later browser checks. Total tokens include cached input;
they are not dollar-cost estimates. The provider supplied no pricing estimate.
Run timestamps fall on September 14 UTC; this report uses September 15 locally.

| Trial | Wall, seconds | Total tokens | Cached input | Uncached input | Model attempts: Sol + Luna | Compile errors / submissions | Browser result |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| A1 original | 233.978 | 221,961 | 158,080 | 54,885 | 15 + 2 | 3 / 6 | Interactions persist; currency-unit defect |
| B1 research | 97.096 | 128,070 | 74,880 | 49,488 | 3 + 8 | 0 / 1 | Pass |
| B2 research | 91.216 | 94,643 | 51,968 | 38,938 | 3 + 6 | 0 / 1 | Pass |

A has one observation: its median and range are that single result. B's median
wall time is 94.156 seconds, range 91.216–97.096; its median total tokens are
111,356.5, range 94,643–128,070. These unbalanced summaries are descriptive,
not the planned three-pair estimate. Combined observed cost was 444,674 tokens
across 37 model attempts and 422.290 seconds of run wall time.

| Helper work | A1 query_docs | B1 research | B2 research |
| --- | ---: | ---: | ---: |
| Helper tokens | 8,441 | 100,612 | 67,179 |
| Helper wall, seconds | 17.289 across two calls | 65.758 | 64.164 |
| Private model turns | 2 | 8 | 6 |
| Private tool calls | 0 | 19 | 15 |
| Exact read characters | Not comparable to research reads | 27,959 | 27,989 |
| Final research response, seconds | Not applicable | 34.875 | 39.364 |
| Direct parent and author tokens | 213,520 | 27,458 | 27,464 |

Research was more expensive than the original helper. The observed whole-task
savings came with fewer parent/author attempts and compiler corrections. Final
research synthesis alone occupied over half of each opening pass. These
measurements do not distinguish provider scheduling from model computation.

A1 delegated to an author and built intermediate pieces before the final page.
Its compiler failures concerned `completed` versus `done`, a root `$UI` declared
as `unknown` rather than `VNode`, and theme/UI attributes. Its final source was
5,693 bytes and included more elaborate styling. B1 and B2 submitted 1,816- and
1,955-byte compositions with simpler layouts. Product variation is part of this
whole-workflow observation; no particular visual design was required.

## Reuse, accuracy, and browser evidence

All three final executed sources imported and invoked the same components:

- CheckList: `dZt8I5yIWD2g6NeftbKv-3ZouzZ2LGCSEhT8ij7wGV0`.
- AmountLedger: `DRCFljoU1NSWQ8pt8dvVa-mG5cld1tj5J46iq7L7-VE`.

B1 submitted the exact research example byte for byte. B2 changed only the final
newline. Both kits were complete, syntax-valid, and compiled and executed on
their first submission. Neither required syntax repair in the live run, so the
guard's regression test, rather than these successes, proves rejection of the
earlier invalid import. The original workflow also achieved useful reuse; the
new workflow did not uniquely enable composition in this experiment.

The same browser checks added and completed “Lay out serving spoons,” added
“Extra bread” at 4.50 and “Fresh herbs” at 2.75, verified the 7.25 total increase,
and reloaded the page to check persistence. All three passed those interactions
without browser errors. Totals were:

| Trial | Initial total | After additions and reload | Accuracy |
| --- | ---: | ---: | --- |
| A1 | 10,200.00 | 10,207.25 | Incorrect starter units and cents guidance |
| B1 | 62.75 | 70.00 | Correct major-currency inputs |
| B2 | 51.80 | 59.05 | Correct major-currency inputs |

A1 instructed users to enter cents, supplied starter values 100 times their
intended amounts, and displayed a 10,200 total beside a stated 120 target.
AmountLedger takes major-currency values and converts them to cents internally.
The index description says it sums in integer cents, while `amount: number`
does not encode input units. That ambiguity is a component-contract defect worth
fixing independently; a syntax check cannot detect it.

Native checkbox state and saved counts persisted correctly. The existing
`cf-checkbox` host accessibility attribute disagreed with its native input
after reload. This was recorded separately from data persistence. A1's immediate
post-reload snapshot preceded rendering; the rendered snapshot and native
control inspection confirmed persistence.

Both B runs recorded opening attempts at `modelTurn: 0`, completed before the
first parent attempt, and inserted a host-labelled handoff immediately before
the task. Their persisted model-context observations carry the research output's
confidentiality without integrity. Raw research records remain outside the
transcript and have `/researchRecord` omission provenance. Missing index labels
remain explicit despite a complete kit. Confidential handle propagation,
recovery, and child inheritance were covered by focused tests; these zero-handle
live trials do not supply that connector evidence.

## Verification and next experiment

The completed source passed 1,033 cf-harness tests with 2,844 steps, all 46
typecheck groups covering 422 paths, repository formatting over 6,274 files,
corrected lint over 5,954 files, and 602 documentation code blocks. Package-cycle,
control-character, conflict-marker, and diff checks passed. The only final lint
failure was the unused type import described above. The runner typecheck and
focused formatting passed after its removal.

Every new syntax/CFC assertion was individually inverted: 69 of 69 failed,
zero survived. The measurement changes have a separate 17-of-17 assertion
mutation record. A focused test's earlier failure was an assertion over escaped
JSON rather than the handoff value; the corrected direct value/provenance
assertion passed. The updated system-map panel rendered correctly at 1440×1000.

Finish A2, A3, and B3 against the frozen setup before tuning research. Then test
a short orientation to canonical composition and `pattern-dev` references while
keeping the authoring/deployment workflow with the author. The skills were
searchable here, but neither B run opened `pattern-dev/SKILL.md`; availability
does not prove use. Preserve the small opening recipe and allow targeted
follow-ups for unresolved contracts rather than expanding the general task.

Separately, improve index contracts with explicit input units, writable-state
requirements, output shapes, and tested minimal compositions. The currency
defect gives a concrete acceptance case for that work. Add those contributions
after the frozen comparison, and measure their effect separately. The email
capstone still requires working grants and useful indexed email components.

## Evidence

The artifact directory is
`/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison`.

- [Experiment manifest](/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison/experiment.json)
  records conditions, hashes, order, authorization pause, and source cleanup.
- [Collected analysis](/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison/analysis.json)
  links source artifacts, helper work, and boundary observations.
- [A1 summary](/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison/a1-summary.json),
  root `806ab137-3a9b-418c-9894-a038def574b4`, includes its one child.
- [B1 summary](/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison/b1-summary.json),
  root `1c09d7a4-bb1b-4982-97ad-ed42a9ea7b68`.
- [B2 summary](/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison/b2-summary.json),
  root `d71dc9f9-3ce0-4ec6-97b8-1e996aafe1b2`.
- Browser screenshots:
  [A1](/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison/a1-reloaded.png),
  [B1](/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison/b1-reloaded.png),
  [B2](/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison/b2-reloaded.png).
- [Gate record](/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison/verification.json),
  [69-assertion record](/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-guard-cfc-assertion-mutation-record.md),
  and [lint equivalence](/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison/lint-cleanup-equivalence.json).

No commit, rebase, push, PR, deployed-index mutation, or real connector-store
write was performed for this checkpoint.
