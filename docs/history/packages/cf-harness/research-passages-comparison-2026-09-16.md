---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "Second matched research iteration: two uses, passage retrieval, larger reads, preserved user goals, and measured correctness and cost."
---

# Research orientation and passage retrieval: second comparison

The two-use research contract preserved indexed reuse and composition. The
composition and inbox tasks finished faster than the preceding three-mode
iteration, and the checklist follow-up needed no new research. The simple
checklist and missing-mailbox tasks became slower. Inbox token usage increased
substantially despite one fewer research call. These observations support the
simpler contract, but do not establish an overall efficiency or accuracy win.

All three resulting apps passed functional browser checks. Research still
supplied one type-invalid composition example and an unnecessarily restrictive
checklist result schema. The inbox research example passed an independent type
check; its author's later submission introduced separate component errors.

## Implemented batch

One research service supports an opening orientation and a specific question.
Both can inspect source and return optional code or a JSON invocation. There is
no separate recipe phase. Each has the same ceiling of eight model turns,
twenty-four tool calls, and 96,000 read characters; the prompt asks the
researcher to stop when it has enough evidence to help achieve the user goal.

The opening orientation can establish a concrete approach, describe current
data, and inspect useful indexed components. The current user goal is retained
separately from a narrower research or delegation request. Selected findings
survive chat turns, while old handle bindings remain historical and require
current authority. Follow-ups receive reopenable source locations rather than
old examples and bindings. Exact citation admission, syntax checks, CFC
propagation, projection, and omission provenance remain in place.

Documentation search returns matching passages with exact offsets and source
identities. A paginated outline tool exposes headings, ancestry, and section
sizes. The read tool can open up to eight chosen sections together, with an
atomic batch budget check. Individual documentation and source windows can be
32,000 characters. Passage selection preserves a paragraph or fenced code block
when it fits. The existing lexical section ranking remains unchanged.

Authoring guidance distinguishes one file per small pattern from one pattern for
an entire user goal. It recommends finding existing data and composable pieces,
then creating the smallest missing capability. Component documentation also
names the actual stack alignment and justification values. The batch adds
general retrieval tools and guidance, not a task classifier or prescribed
implementation sequence.

## Conditions and comparison

The implementation was frozen at base `59e8a2540cf212f98e19e3c9d0919f7c4b460c71`
plus working changes before any current model call. File digests were checked
again after the trials. The preceding iteration is recorded in
[the scoped-research report](targeted-research-comparison-2026-09-16.md).

All trials used the same five task texts, Sol parent/author and Luna researcher,
and the same nine-pattern public-source snapshot. The snapshot digest was
`0a89f2399381eeee2211972ca94130951c5b06771ddf6469eaf7c63afa7a60f7`. Mail was a
synthetic typed-object fixture, not a connected personal mailbox. Each creation
task used a fresh space; the checklist question followed its creation in the
same chat. No index publication changed the candidates.

Current model runs were serial, from approximately 01:59:47 to 02:06:40 UTC on
September 16. Gates, mutation tests, and browser checks ran outside that
measured window. Wall time covers the whole root task, including children; token
counts include private research and children. There is one observation per task
and variant. Several variables changed together, so these are diagnostic
comparisons, not estimates of individual causal effects or stable provider
latency.

| Task                           | Original full opening, seconds | Previous iteration, seconds / tokens | Current iteration, seconds / tokens |
| ------------------------------ | -----------------------------: | -----------------------------------: | ----------------------------------: |
| Reuse indexed checklist        |                         59.946 |                      31.739 / 24,355 |                     42.835 / 40,949 |
| Explain checklist data needs   |                         36.311 |                      33.139 / 21,078 |                       5.066 / 5,386 |
| Compose counters and checklist |                        113.531 |                    170.340 / 143,055 |                    125.387 / 96,257 |
| Render supplied mailbox        |                         94.571 |                    256.643 / 225,159 |                   214.310 / 369,428 |
| Report missing mailbox         |                         39.821 |                       11.762 / 4,996 |                     24.724 / 26,418 |

The previous follow-up row uses its corrected recheck, after the prior
iteration's duplicate-opening fix. Its original 58.388-second, 31,501-token
observation remains in the raw comparison file and previous report. The
"original" column also used research; it is not a no-research control.

Research calls fell from one to zero on the corrected follow-up, two to one for
composition, and three to two for the inbox. The two simple opening tasks still
used one each. Inbox uncached input tokens increased from 87,789 to 148,364, so
the token regression is not solely repeated cached context.

## What worked and what failed

The checklist ran the exact inspected CheckList pattern by ID. Its browser
supported adding items, checking an item, clearing completed items, and
persisting the remaining item through reload. Research supplied a result schema
containing only counts and a summary. The parent preserved that schema, and
`run_pattern` returned `status: ok` with
`valueError: additional property
addItem`. Piece execution succeeded, but the
projected result did not validate. This is a research-invocation defect, not a
clean first-time result.

The checklist follow-up correctly explained that no external database connection
was required. It reused retained context, made no new research call, and did not
modify the app.

The composition imported and invoked the exact inspected Counter and CheckList
patterns. Its opening researcher used the new outline and batch-read tools and
returned a complete example in one research call. That example invented
`cf-text size` values. The parent copied them and separately changed a numeric
interpolation to an invalid `.get()` call. Compiler diagnostics identified both;
the corrected submission retained both indexed components. Browser checks
verified two counters, their reactive sum, editable checklist state, and reload
persistence. The final observed counter values were 3 and 5, with total 8.

The inbox orientation correctly rejected the indexed month renderer because its
SQLite and single-month contract did not fit the supplied typed mailbox. It
returned useful contracts without an example. The author then requested an
answer covering filtering, sorting, reactive arrays, conditional JSX,
components, and theme usage. That answer's 1,412-character source example passed
an independent `cf check --no-run` with the checkout supplied as root. It was
not executed as a separate app. The author's larger submission added unsupported
badge, empty-state, and text properties; those produced one compiler failure
before correction. Browser checks verified sender, subject, snippet, date,
cross-month descending order, exclusion of archived/deleted messages, a reactive
empty state, and restoration through reload. The heading remained low contrast
against the shell's dark background, so functional acceptance is not visual
polish.

The missing-mailbox task correctly reported absent data and made no app. It
offered either a SQLite mailbox connection or exported messages, avoiding a
universal database requirement. Its connection advice was still more specific
than the evidence required, and it inspected a mail pattern even though there
was no mailbox input.

## Retrieval evidence and next constraint

The expensive inbox answer used all eight model turns, twenty tool calls, and
81,703 read characters: seventeen documentation searches, two batch reads, and
one handle description. Of the documentation text returned, 55,891 characters
were unique by section and range; 25,812 were repeated or overlapping. The full
private tool outputs occupied 142,237 characters including metadata. The
component index was returned six times and the text-component section four
times. The opening orientation had already read another 20,283 characters.

The new tools were used, and the researcher obtained a correct small example.
However, access to larger windows and matching passages did not make retrieval
selective. The follow-up combined several questions, lexical ranking still
returned broad sections, and overlapping passages were emitted repeatedly.

The next useful constraint is on retrieval waste: improve query relevance and
avoid returning already-read text when a source reference suffices, while
keeping an explicit read available for more context. Parent questions should
target the remaining uncertainty rather than request another whole
implementation. This does not call for restoring extra phases or forcing smaller
opening packets. The observed component-property guesses and unnecessary result
schema also provide concrete cases for evaluating whether improved retrieval
supplies the right contract. No further runtime change was made after this
measurement.

## Verification and evidence

- Harness package: 1,051 tests / 3,038 steps / zero failures.
- Typecheck: 423 paths across 46 groups. Root lint: 6,106 files. Root
  formatting: 6,439 files before this report. Documentation: 602 checked code
  blocks.
- Assertion mutations: 163 of 163 killed, zero survivors. Fourteen assertion
  failures wrapped by `HarnessResearchError` were rerun individually after the
  initial classifier recognized only `AssertionError`; their failure messages
  and logs are retained. Repository bytes were not changed by mutation tests.
- All three browser functional checks passed. The system-map research panel was
  inspected at 1440 by 1000. The inbox contrast issue is recorded above.
- Fresh opening handoffs preceded the first parent request; private attempts
  used model turn zero. The child had no opening pass. Private research records
  were absent from model-visible transcripts. AUD-20 passed for all six runs.
- The complete CFC audit was not green: 68 passes, 9 failures, 16 warnings, 20
  not applicable, and 1 inconclusive. All failures carried existing
  `knownDefect` classifications for AUD-21/CT-2175 or AUD-22/CT-2216. AUD-25 was
  inconclusive for the missing-mailbox run because no cell-label artifact
  existed. These results do not establish full CFC conformance.

Artifacts are retained under
`/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/targeted-research/iteration-2/`:
`source-manifest.json`, `source.patch`, `trial-summary.json`,
`comparison-summary.json`, `retrieval-analysis.json`, `source-reuse.json`,
`provenance-verification.json`, `audit.json`, `assertion-mutations.json`, gate
logs, browser verdicts, screenshots, and the complete console run directories.

| Trial           | Root run ID                            |
| --------------- | -------------------------------------- |
| Checklist       | `edf1f003-4b18-44fb-bd68-a1f9bec518cf` |
| Follow-up       | `7a5e03a2-9f96-437c-bd49-859f69ff31fe` |
| Composition     | `e8e93646-c9b5-4080-a58f-c81779f170c9` |
| Inbox           | `ed84c73c-038c-484d-a6a9-9eae1a5c7fb8` |
| Missing mailbox | `ed5719de-19e5-4df4-ba17-2d8850fdc60f` |

The inbox child is the root ID plus `.subagent.1`. The source and evidence
remain staged locally. No commit, push, publication, Loom pin change, or Weaver
rollout was performed. The local Loom checkout still read
`0c3b11314f9adb461edb2f58a0f6e910d2d6f93b` at the final check.
