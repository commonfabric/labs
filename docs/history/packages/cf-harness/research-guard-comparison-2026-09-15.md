---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Completed six-trial comparison of the original documentation helper and automatic indexed-source research on the same dinner-page task."
---

# Original documentation helper versus automatic research

All three guarded-research trials composed CheckList and AmountLedger from the
index, compiled their first submission, and passed the browser checks. The
original workflow also achieved composition, but less consistently: one trial
used both components, one used neither, and one used CheckList alone. Its three
pages had a currency-unit defect, broken checklist bindings, and nonpersistent
cost edits respectively.

Median whole-task time was 97.096 seconds with research versus 255.183 seconds
with the original workflow, a 62% reduction. Median total tokens were 94,643
versus 278,581, a 66% reduction. Research itself remained expensive: its opening
passes took 58–66 seconds and 41,301–100,612 tokens. The savings came with much
less parent and author work, rather than a cheaper documentation helper.

This completes the three matched pairs begun in the
[partial checkpoint](research-guard-comparison-checkpoint-2026-09-15.md).
It supports this complete workflow on this task; it does not establish a
population success rate, real inbox correctness, or the independent effect of
automatic startup, source access, citation repair, syntax checking, or CFC
propagation.

## Controlled setup

Every trial received exactly:

> Make me a dinner-party preparation page with a checklist of what I need to
> prepare and a running total of ingredient costs.

Condition A used the original harness at
`314e4e88621c99306b2effb6d7d2723055aa4ffb`: its real `query_docs` service,
original prompts and source access, ordinary index search, and author skills,
with no opening research. Condition B used
`af916cf0cc79377deeeb4e2707bd66794308acd8` plus the frozen opening research,
citation, syntax, and CFC changes. Withholding research on the new build would
not reproduce condition A.

Trials ran serially in the planned order A1/B1, B2/A2, A3/B3. Each had a new
session and empty synthetic space. Parent and author models were
`gpt-5.6-sol`; the helper was `gpt-5.6-luna`. Both conditions used the same
Fabric server revision, corpus files, index snapshot, publication policy, and
model configuration. Each condition retained its own corpus selection behavior.
Tests and mutation checks were paused during timed runs. There was no model
advice, prompt tuning, new skill preload, or index contribution between trials.

The index snapshot contained 302 metadata records and 41 discoverable programs
plus dependencies. Five search responses and all 41 discoverable source
responses were verified against captured responses. Usage events did not alter
rankings, and publication was refused. All initial spaces had zero handles
because they lacked a default pattern anchoring a piece registry. No external
data was required, so these trials do not test connector grants.

The manifest records these identities:

- Index SHA-256:
  `d6541bb494489db175f59ebd1657477082fa47721b01fbec547a37f9114fe21e`.
- Corpus: 174 identical files, manifest SHA-256
  `a9588f2de01aeb9d156b856b904b7f21d3c8de90239c94a6ebc3704b85b5ef46`.
- B1/B2 runtime patch SHA-256:
  `3d348c057959835aa7515f78f53084a522a865a897b1a292414b040f0c2149f2`.
- B3 runtime patch SHA-256:
  `90d9632abd623f94d12daf3ba2728af35f9752e4392668f24468d0669a090c3f`.
  Its only intervening source change removed an unused type import. The emitted
  JavaScript was byte-identical, SHA-256
  `66b7c016514a34e676ed694821ed814dbb2b37342a7c278dc3c9eb78427b967c`.

Measurement used exact console turn/root identities, full submitted-source
artifacts, and private and delegated model accounting. It did not infer the
task from the first user message or count inherited research twice. An initial
A1 preflight rejected a base-revision mismatch before any model call. A2's two
authorization refusals also preceded model calls; automatic review subsequently
accepted the remaining invocations. These events are retained and excluded from
the six model trials.

## Outcomes and cost

Wall time is root creation to completion, including helper and descendant work;
browser acceptance happened afterwards. Total tokens include cached input and
are not a dollar-cost estimate. The provider supplied no pricing estimate.

| Trial | Wall, seconds | Total tokens | Cached input | Uncached input | Sol + Luna attempts | Compile errors / submissions | Executed indexed components | Browser result |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| A1 original | 233.978 | 221,961 | 158,080 | 54,885 | 15 + 2 | 3 / 6 | CheckList, AmountLedger | Interactions pass; currency-unit defect |
| B1 research | 97.096 | 128,070 | 74,880 | 49,488 | 3 + 8 | 0 / 1 | CheckList, AmountLedger | Pass |
| B2 research | 91.216 | 94,643 | 51,968 | 38,938 | 3 + 6 | 0 / 1 | CheckList, AmountLedger | Pass |
| A2 original | 255.183 | 326,852 | 214,272 | 102,068 | 16 + 3 | 4 / 8 | None | Checklist labels and completion fail |
| A3 original | 304.583 | 278,581 | 171,136 | 95,357 | 16 + 6 | 6 / 9 | CheckList | Cost edits and total fail |
| B3 research | 102.167 | 71,513 | 40,192 | 27,701 | 3 + 5 | 0 / 1 | CheckList, AmountLedger | Pass |

| Measure | A median (range) | B median (range) |
| --- | --- | --- |
| Wall, seconds | 255.183 (233.978–304.583) | 97.096 (91.216–102.167) |
| Total tokens | 278,581 (221,961–326,852) | 94,643 (71,513–128,070) |
| Uncached input tokens | 95,357 (54,885–102,068) | 38,938 (27,701–49,488) |
| Model attempts | 19 (17–22) | 9 (8–11) |
| Compile errors | 4 (3–6) | 0 (0–0) |

The six trials consumed 1,121,620 tokens and 86 model attempts. Their run wall
times sum to 1,084.223 seconds. Every B trial was faster and used fewer total
tokens than its paired A trial. The samples are small, provider cache behavior
was observed rather than controlled, and the designs differed: A produced more
elaborate pages and intermediate pieces; B produced smaller compositions. These
are whole-workflow observations, not equal-source microbenchmarks.

## Research quality and remaining expense

| Research work | B1 | B2 | B3 |
| --- | ---: | ---: | ---: |
| Opening seconds | 65.758 | 64.164 | 58.473 |
| Helper tokens | 100,612 | 67,179 | 41,301 |
| Private turns / tools | 8 / 19 | 6 / 15 | 5 / 11 |
| Exact source reads | 12 | 10 | 7 |
| Read characters | 27,959 | 27,989 | 22,058 |
| Final response seconds | 34.875 | 39.364 | 41.283 |
| Direct parent/author tokens | 27,458 | 27,464 | 30,212 |

Each B run returned one complete, syntax-valid kit. B1 and B3 submitted the
example byte for byte; B2 removed only its final newline. All executed without
compiler correction. This is stronger evidence than a cited recipe alone:
the unchanged advice produced the requested persistent behavior in the browser.

The original helper used 8,441, 10,975, and 27,088 tokens across two, three,
and six calls. Those calls totaled 17.289, 37.546, and 71.299 seconds
respectively; calls within a turn can overlap. Original parent/author tokens
were 213,520, 315,877, and 251,493. Moving work into research increased helper
cost while reducing the rest of the task substantially.

Final synthesis occupied over half of each B opening pass. The durations do not
separate provider scheduling from model computation. None of these three live
kits needed the syntax guard to reject an example; the focused malformed-import
regression proves that guard, not the successful live samples. Syntax acceptance
does not establish types, dependency resolution, compilation, or behavior.

All B runs opened the exact CheckList and AmountLedger source and relevant
composition documentation. None opened `pattern-dev/SKILL.md`; B2 did open the
Key Patterns section of `pattern-implement/SKILL.md`. The skills were searchable,
but availability and reading are different conditions. A short orientation to
canonical references remains an experiment, not an explanation of these results.

## Browser findings and useful reuse

The common acceptance sequence added and completed “Lay out serving spoons,”
added “Extra bread” at 4.50 and “Fresh herbs” at 2.75, checked a 7.25 increase,
and reloaded to verify names, completion, cost values, and total persistence.
Different sensible starter data was permitted.

| Trial | Initial total | After edits | After reload | Finding |
| --- | ---: | ---: | ---: | --- |
| A1 | 10,200.00 | 10,207.25 | 10,207.25 | Inputs persist, but starter amounts and cents guidance use the wrong units |
| B1 | 62.75 | 70.00 | 70.00 | Pass |
| B2 | 51.80 | 59.05 | 59.05 | Pass |
| A2 | 100.50 | 107.75 | 107.75 | Total persists, but item labels are blank and completion does not persist |
| A3 | 90.00 | 90.00 | 90.00 | Added labels and task completion persist; numeric costs revert to blank |
| B3 | 53.97 | 61.22 | 61.22 | Pass |

A1 used AmountLedger's `amount` as cents, supplied values 100 times their
intended amounts, and displayed a 10,200 total beside a stated 120 target.
AmountLedger accepts major-currency values and converts internally to cents.
Its description about summing integer cents and an unqualified `amount: number`
leave the input unit too easy to misread.

A2 authored its checklist and ledger. Existing and newly added checklist and
ingredient labels appeared blank. Clicking the new checkbox changed its local
appearance but not the completed count; all eight native checkboxes were false
after reload. The submitted source rebuilt row bindings through numeric-index
`key()` calls inside `.get().map()`. The artifacts identify that code, but this
comparison did not diagnose the transformer or runtime cause.

A3 used indexed CheckList successfully and authored the cost tracker. The new
task persisted with a completed count of three out of fourteen. Keyboard
activation added both ingredient rows after a host click did not. Their names
persisted, but numeric costs entered through the ordinary inputs did not change
the total and reloaded blank. Low-contrast headings were a separate visual
defect. No page was repaired during acceptance.

All B sources imported and invoked:

- CheckList: `dZt8I5yIWD2g6NeftbKv-3ZouzZ2LGCSEhT8ij7wGV0`.
- AmountLedger: `DRCFljoU1NSWQ8pt8dvVa-mG5cld1tj5J46iq7L7-VE`.

The browser checks exercised their reused behavior. A1 also used both, so
research did not uniquely enable composition. Its gain here was reliable
selection and correct wiring with less new code and fewer corrections.
The final B sources were 1,816–1,955 bytes; A's final sources were
3,195–5,693 bytes, excluding separately authored intermediate pieces.

The original A2/A3 attempts also submitted collapsed-source notices as code.
Their compiler diagnostics and exact source artifacts establish that failure;
it is a separate continuation defect to investigate. The shared checkbox host
accessibility attribute could disagree with its native input after reload, so
acceptance used native state and persisted counts. No browser errors were
reported on the tested pages. B3's initial navigation used an assumed slug;
acceptance began at the actual returned URL, without another model invocation.

## Boundaries, verification, and next work

All three B opening passes completed at `modelTurn: 0` before the first parent
attempt. Each host handoff appeared immediately before the task and carried
tool/output provenance. Persisted CFC observations propagated output
confidentiality without source integrity. Private research records remained in
artifacts, with `/researchRecord` omission provenance and no private record in
the transcript. Each complete kit retained incomplete classification coverage:
the upstream index supplies no labels. This does not establish enforcement over
unclassified influence. Confidential handle admission, recovery, and child
inheritance have focused tests; these zero-handle runs are not live evidence for
those cases.

The measured implementation passed 1,033 package tests / 2,844 steps, all 46
typecheck groups / 422 paths, repository formatting and lint, and 602 checked
documentation blocks. All 69 new syntax/CFC assertion matchers and 17 measurement
assertion matchers were individually inverted and caused failures. These are
assertion-sensitivity checks, not production-code mutation coverage. The system
map was rendered and inspected at 1440×1000.

PR preparation used a separate checkout. Its additional source-free error
projection, error-class encapsulation, and file-header cleanup were not part of
the timed B snapshot. Rebased-head gates belong to the PR's validation record;
they must not be conflated with these measured-source results.

The next experiments should preserve this baseline and change one factor at a
time: a smaller opening orientation with targeted follow-ups, a short set of
canonical composition references, and then better indexed component contracts.
Explicit amount units, writable input requirements, output shapes, and tested
minimal examples are concrete index improvements. Opening-only versus
callable-only research can measure startup separately. Add a direct-reuse task
and the inbox capstone after grants work, and add email components in a distinct
library experiment. Do not inflate the small research model's task into
authoring, deploying, and iterating on a whole application.

## Evidence

Raw artifacts remain local under
`/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/research-comparison`.
They include `experiment.json`, `analysis.json`, one summary per trial,
`*-before.txt`, `*-after.txt`, `*-reloaded.txt`, native control values,
screenshots, full source sidecars, and private research records. They are not
included in the repository changeset.

| Trial | Root run ID |
| --- | --- |
| A1 | `806ab137-3a9b-418c-9894-a038def574b4` |
| B1 | `1c09d7a4-bb1b-4982-97ad-ed42a9ea7b68` |
| B2 | `d71dc9f9-3ce0-4ec6-97b8-1e996aafe1b2` |
| A2 | `bd5e78f4-141e-47a6-a636-de0dde5b5f48` |
| A3 | `e3dd2209-a23f-45bc-b5f1-607ef3278a63` |
| B3 | `4e93521b-6c28-4bf7-af91-0c1e14d58bc6` |

Each A root includes its `.subagent.1` family member. B roots had no delegated
children. No deployed index, existing connector store, or real-data piece was
changed by these trials.
