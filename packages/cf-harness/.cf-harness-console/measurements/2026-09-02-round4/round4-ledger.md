# Round 4 analysis ledger — append-only, one section per cell

Kept by the analysis thread (Thread W). The supervising thread runs every
batch and hands over report paths; nothing in this file is written from a
console, a batch, or a corpus this thread touched.

Append only. A cell already written here is never edited, including a cell
this file records as void. A count this thread could not derive from an
artifact is written "not read" and never written `0`.

## Method fixed before the first cell

### Flag-check markers (derived here, uniqueness verified across both files)

The two parent prompts share their opening line, so the opener is not a
marker. Each marker below occurs once in its own file and not at all in the
other, checked on whitespace-normalized text (the candidate file is hard
wrapped and the historic one is not, so normalization is what makes a marker
comparable between them):

| Condition | Marker | Occurrences: historic / candidate |
| --- | --- | ---: |
| P-hist | `the one move that makes the index worth nothing` | 1 / 0 |
| P-cand | `attach them to your delegation as patternRefs` | 0 / 1 |

Prompt files as handed over, by SHA-256:

- `parent-historic.txt` —
  `8397301c2d057d1c325164f30435fe382fec38781da6519673fe2ade3fadb219`
- `parent-default-candidate.txt` —
  `a2dd4986575b751280ca8f773bcc3d06ae14941f8dec7a0d43010af30103c44c`

Both agree with the prefixes named in the analysis brief. `parent-historic.txt`
is byte-identical to
`2026-08-31-terra-vs-sol-2x2/parent-composition-prompt.txt`, and the candidate
file matches the text blockquoted in `predictions.md` word for word.

The child-guidance marker is the composition bullet
`A search hit is a component to wire, not a specification to rebuild.`
(`packages/cf-harness/src/prompt-loop.ts:1327`), which
`--no-child-composition-guidance` is what removes
(`packages/cf-harness/console/server.ts:593`; `src/prompt-loop.ts:1322`).

### Where each check reads from

- **Parent prompt.** The console passes `--system-prompt-file` through as the
  run's system message (`console/server.ts:590-591,1477-1478`;
  `src/prompt-loop.ts:2676-2677`), so it is message 0 of the parent's own
  `transcript.json`. Both directions are read there: the intended marker
  present, the other absent. A cell whose parent transcript carries no system
  message is P-none; one carrying the wrong marker is **void**.
- **Child bullets.** The pattern-author system prompt is message 0 of each
  `<parentRunId>.subagent.N/transcript.json`.
- **patternRefs block.** The generated child block opens
  `Published pattern references selected by the parent:`
  (`src/prompt-loop.ts:1405-1407`) and reaches the child as part of its
  delegated user message (`:1432-1440`), so it is read from the child
  transcript's user messages, not inferred from the parent's call.
- **Per-entry refusals.** `patternRefRefusals` on the `delegate_task` tool
  result, reason `not-searched-by-parent`
  (`src/contracts/subagent.ts:596-598,625`; `src/prompt-loop.ts:3115-3124`).

### Delegation census, counted as section 4.2 of the prompt-stack audit counts

Exact string inclusion of each trusted search record's `description`,
`importHint`, `argumentType`, and `resultType` in the delegation's `goal` plus
`context`. Round 4 counts that same quantity a second way — inclusion in the
child's received user text — so the free-text channel and the structural
channel are separated rather than summed. The 2026-08-31 V2 baseline this is
compared against is: 24 delegations, 22 naming a prior hit, 4 carrying the
exact description, 8 the exact import hint, 1 an exact argument shape, 0 an
exact result shape.

The extractor's own counters (searches/hits, `run_pattern` by id/source/
composing, outcomes, distinct composing tasks) are taken from the batch's
`report.json` totals, which are the committed `measure-runs.ts` algebra, not a
re-derivation by this thread.

## Cells

### Cell 1 — P-none, composition suite

Report: `p-none-composition/report.json`. Ran 2026-09-01T02:10:46Z to
02:51:37Z. Four tasks, four `turn_completed`.

#### Flag check — PASSES, both directions

| Check | Expected | Read from artifacts |
| --- | --- | --- |
| Parent system message | absent | absent in all 4 parent transcripts (0 messages, 0 chars) |
| Historic marker | absent | absent |
| Candidate marker | absent | absent |
| Child composition bullet | present | present in all 6 pattern-author children |
| patternRefs child block | absent | absent in all 6 children |

The cell is valid. Numbers follow.

#### Extractor counts (`report.json` totals, `measure-runs.ts` algebra)

| Task | searches (hits/empty) | run_pattern | by id | source | composing | outcomes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| dice-tally | 6 (5/1) | 7 | 0 | 7 | 0 | 2 ok, 5 compile-error |
| party-prep | 3 (2/1) | 13 | 0 | 13 | 2 | 3 ok, 7 compile-error, 3 error |
| team-picker | 3 (2/1) | 6 | 0 | 6 | 0 | 1 ok, 5 compile-error |
| workout-streak | 5 (2/3) | 13 | 0 | 13 | 0 | 1 ok, 8 compile-error, 4 error |
| **cell** | **17 (11/6)** | **39** | **0** | **39** | **2** | **7 ok, 25 compile-error, 7 error** |

Distinct composing tasks: **1 of 4** (party-prep). Distinct composed pattern
ids: 1 — `dZt8I5yIWD2g6NeftbKv-3ZouzZ2LGCSEhT8ij7wGV0`, which the index
answered as `kind: "part"`, `quality: "proven"`: a titled-checklist part, not
a whole application. Two composing calls against it, one `compile-error` and
one `ok`. No re-exports and no bare imports; the two importing calls are both
real composition.

Delegations: 5, every one `pattern-author`. One child failed
(`dice-tally .subagent.1`, four searches and no `run_pattern`); the parent
re-delegated and the second child answered.

#### Where the work happened

**Every search and every `run_pattern` in this cell is a child's.** All four
parents searched zero times, ran zero patterns, and delegated immediately.
The composition that occurred was authored by the party-prep child off its own
search, with no id, description, or shape supplied by its parent.

#### Corpus

| | discoverable | non-discoverable | total |
| --- | ---: | ---: | ---: |
| before | 29 | 76 | 105 |
| after | 29 | 83 | 112 |

Discoverable held at 29 as pre-registered. The seven added entries are
recorded-only, so no later search in this round sees them.

#### Provenance

- Model: `gpt-5.6-sol` on every session.
- Fabric server: `gitSha ce372de43f9b244fadb5186ca8be30100fe6f1a0`, read
  `ancestor` of `origin/main`.
- CFC: `enforce-explicit`; `flowLabels`, `writeFloor`, `policyEvaluation`,
  `labelMetadataProtection`, `declaredMonotonicity` all off;
  `triggerReadGating` and `decomposedEnvelopes` false; no policy digest.
- Skills: `/Users/ben/.bb/worktrees/env_m69fg39nps/labs/skills`, 26 skills, 0
  runs in any family without a registry.
- Console: `http://127.0.0.1:8124`. Index pre-flight answered, 0 results over
  105 candidates.
- Console commit: **not read.** See the instrument gaps section below.

#### New counters — patternRefs

- **(a) Usage: 0 of 5 delegations carried `patternRefs`; 0 entries.** The
  generated child block is absent from all six children, read from the
  children's own received text and not inferred from the parent's call.
- **(b) Shapes reaching the child: undefined for this cell, not zero.** The
  §4.2 census is defined over delegations that follow a parent index search,
  and no parent in this cell searched. The census denominator is 0, so this
  cell contributes nothing to the flip the round is testing.
- **(c) Per-entry refusals: none.** `patternRefRefusals` is absent from all
  five `delegate_task` results.

A mechanism note that governs how the other Block-1 cells read: refs
rehydrate only from *this parent's own* prior `search_patterns` records
(`src/prompt-loop.ts:3115-3124`). A parent that never searches cannot carry a
ref at all. So 0 here is structural unavailability, not a model declining an
offered channel, and the pre-registered "surprise" threshold of >2 spontaneous
uses was unreachable in this cell.

#### Judgement against the pre-registered P-none prediction

Prediction: *"composition ~0 (replicates); patternRefs unused or nearly (the
field is schema-visible — spontaneous use >2 delegations would be a real
surprise worth its own note)."*

- **patternRefs half: held.** Zero uses. Held for a reason weaker than the
  prediction implies, per the mechanism note above.
- **Composition half: held in direction, not as "replicates".** Sol/V0 on
  2026-08-31 composed 0 on this suite; this cell composed 2 calls across 1 of
  4 tasks. That is far below the V2 bar of 4/4 tasks, so the finding that a
  parent without a prompt does not drive composition stands. But it is not
  zero, and the exact replication the prediction claimed did not occur. The
  composition present is child-driven, in a cell where the child bullets are
  present — which is Block 2's variable appearing in Block 1.

#### Anomalies

- `bash` denied 11 times, all in children, every one
  `cf-harness.observation-denied` / `not-observable`: "bash output did not
  include trusted CFC mediation metadata". `read_file` failed 10 times, all in
  children: "read_file failed: filesystem status not observable under CFC
  policy". This is the standing posture of the machine, not a condition of
  this cell: it holds on the 2026-08-31 rounds as well, because no runsc-cfc
  sidecar transport is registered here and the CT-2116 enforcement denies the
  observation. It is re-read per cell so that a cell where it differs is not
  silently compared against one where it did not.
- Compile burn re-baselines upward against 2026-08-31 Sol/V0 on the same
  suite and tier: 21 `run_pattern` and 5 `ok` then, 39 and 7 now. The system
  under measurement changed, which is why this round re-baselines; the
  comparison is recorded, not explained.
- Search results now carry `kind` and `quality` (observed on the composed
  entry: `part` / `proven`). The audit recorded the harness dropping both.
  The field the candidate prompt speaks in is present in tool output.

## Operational record — the 02:52Z shared-store collision

Recorded here because it decides what may be counted, and from which root.
Times are the artifacts' own UTC `createdAt`, not the operator's local clock.

Block 1 was parallelized across three consoles at about 02:52Z. All three
defaulted to one `CF_HARNESS_CONSOLE_DIR`, so they shared a session store and
an artifact root. The p-cand console returned 500s on
`chat_event.sequence` UNIQUE collisions and completed no task; the p-hist
console reached one task before being stopped. Both were relaunched against
isolated roots, `.cf-harness-console-phist/runs` and
`.cf-harness-console-pcand/runs`.

Rulings carried into every later count:

- **p-cand attempt 1: substrate-invalid, zero completed tasks.** Not counted.
- **p-hist attempt 1: VOID.** Not counted.
- Valid p-hist and p-cand runs live only in the isolated roots. Anything in
  the shared root carrying a parent prompt marker is attempt-1 debris.

### The debris, enumerated

Root runs in the shared root created after cell 1 ended at 02:51:37Z:

| run | createdAt | parent prompt | first message | status |
| --- | --- | --- | --- | --- |
| `823b9697` | 02:51:43Z | none | counter, increment and reset (reuse suite) | completed |
| `7e8e69ca` | 02:52:08Z | none | books with star ratings (reuse suite) | **failed** |
| `ee0e17ea` | 02:55:02Z | **historic** | dice tally (composition suite) | completed, `tool_completed`, three searches and no `run_pattern` |

`ee0e17ea` is the whole of p-hist attempt 1's footprint in the shared root.
Because a batch matches candidate runs on the first user message, and that
message is a composition-suite task, it cannot be absorbed into a reuse-suite
batch scanning the same root. The debris is contained.

**Cell 1 predates all three** and is unaffected: it ended at 02:51:37Z, six
seconds before the first of them was created.

### The collision reached the p-none reuse batch

`7e8e69ca` is not debris. It is the p-none reuse batch's own second task,
running on the original console against the shared store, and it failed inside
the collision window with terminal reason `prompt_loop_error` and these
failure records:

- `harness_error`, from `delegate_task`: `subagent
  7e8e69ca-ae11-4ec9-9b6b-5a36e800ce25.subagent.1 failed: Subagent failed:
  UNIQUE constraint failed: chat_event.sequence` (02:55:23Z)
- `run_error`: `UNIQUE constraint failed: chat_event.sequence` (02:55:23Z)

So the p-none reuse cell carries at least one substrate-failed task. Under the
pre-registration's own stop rule — substrate failure invalidates the cell and
is never counted — that task is excluded at minimum. Whether the surviving
tasks stand as a cell is the operator's ruling and is recorded here when
made; this thread's position is that a batch that ran through the collision
window is not cleanly comparable with cell 1, which ran before it.

The isolated roots read correctly in both directions: the first p-hist run
(`c6fcf3b8`, 02:57:15Z) carries the historic marker and not the candidate one,
and the first p-cand run (`9c1e9356`, 02:57:26Z) carries the candidate marker
and not the historic one.

## Instrument gaps noted once

- **No console commit in any artifact.** Every report records the fabric
  server's `gitSha` and its ancestry against `origin/main`; nothing records
  the commit the console itself was built from. Two batches can therefore
  differ in the code under measurement with no artifact saying so. Adjacent to
  CT-2120.
- **The index pre-flight does not exercise retrieval.** The query is the
  literal string `pattern` (`scripts/run-measurement-batch.ts`
  `PREFLIGHT_QUERY`), and against this corpus the endpoint answered 0 results
  while reporting 105 candidates. An answer of no results is a pass by
  design — the pre-flight asks whether the endpoint answers, not whether it
  retrieves — so with the current matcher it no longer distinguishes a
  healthy index from one that has stopped matching. Informational; the corpus
  readings that gate each cell come from the listing, not from this query.

## Operator rulings, recorded as made

### On the p-none reuse attempt of 02:51Z — VOID, whole attempt

The operator ruled the entire attempt void rather than excluding its one
failed task: the collision window overlapped the batch, and the original
console's shared store carries three writers' interleaved sequences, so even
the tasks that completed are not cleanly attributable to the condition. The
attempt is kept and never counted.

This thread can see no `p-none-reuse-void-attempt1` report directory —
nothing named `*void*` exists anywhere under `packages/cf-harness` to a depth
of four — which is consistent with a batch stopped before it wrote its report.
The void attempt is therefore recorded here by run id, since those directories
are its only durable trace:

- `823b9697-f697-471c-86d9-69ac08b5dd2f`, created 02:51:43Z, completed
- `7e8e69ca-ae11-4ec9-9b6b-5a36e800ce25`, created 02:52:08Z, failed on
  `UNIQUE constraint failed: chat_event.sequence`

Both are in the shared root, `.cf-harness-console/runs`. Neither is counted in
any cell.

### Cell 1 stands

`p-none-composition` ended at 02:51:37Z, before the first write of any
parallel console. Confirmed independently here from run `createdAt` stamps:
the earliest run outside that batch is 02:51:43Z. Cell 1 is unaffected and
remains valid.

### Store isolation, and where each condition is now read from

All four conditions now run on their own store and artifact root. Later cells
are scoped to these roots and no other:

| Condition | Artifact root |
| --- | --- |
| P-none (re-run) | `.cf-harness-console-pnone/runs` |
| P-hist | `.cf-harness-console-phist/runs` |
| P-cand | `.cf-harness-console-pcand/runs` |
| Cell 1, already counted | `.cf-harness-console/runs` |

The re-run p-none reuse batch reads correctly at its first run:
`ae9a2bcb`, created 03:01:26Z, carries no system message — neither marker
present, as P-none requires.

The concurrent-console defect is filed as CT-2156.

### Cell 2 — P-none, reuse suite (the clean re-run)

Report: `p-none-reuse/report.json`, artifact root
`.cf-harness-console-pnone/runs`. Ran 03:01:21Z to 03:36:34Z. Six tasks, six
`turn_completed`.

#### Flag check — PASSES

| Check | Expected | Read from artifacts |
| --- | --- | --- |
| Parent system message | absent | absent in all 6 parents |
| Either marker | absent | absent |
| Child composition bullet | present | present in 4 of 5 children — see below |
| patternRefs child block | absent | absent in all 5 children |

The one child without the bullet, `a4cc1d35` under trip-timeline, ran on the
**`default` profile** because its parent asked for that profile, not because
guidance was withheld. The `default` profile carries no pattern-author
composition guidance at all, so its absence is the parent's routing decision
showing through, not a flag failure. The cell is valid.

#### Extractor counts

| Task | searches (hits/empty) | run_pattern | by id | source | composing | outcomes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| counter | 1 (1/0) | 1 | 1 | 0 | 0 | 1 ok |
| reading-list | 4 (2/2) | 8 | 1 | 7 | 1 | 2 ok, 5 compile-error, 1 error |
| friends-birthdays | 5 (4/1) | 11 | 0 | 11 | 0 | 2 ok, 8 compile-error, 1 error |
| project-notes | 3 (3/0) | 5 | 2 | 3 | 0 | 2 ok, 3 compile-error |
| trip-timeline | 1 (1/0) | 1 | 1 | 0 | 0 | 1 ok |
| monthly-expenses | 2 (2/0) | 1 | 1 | 0 | 0 | 1 ok |
| **cell** | **16 (13/3)** | **27** | **6** | **21** | **1** | **9 ok, 16 compile-error, 2 error** |

Distinct composing tasks: **1 of 6** (reading-list, one call against
`iw8VA9pQCUJBat1pwoAdSQzPVejFGLqLqgc3LAEb1Wg`; that entry's `kind` is **not
read** — it does not appear in any search result this thread could parse from
the family's transcripts). Delegations: 5, four `pattern-author` and one
`default`. No re-exports, no bare imports.

#### Over-fire baseline, which is what this suite is for

**Zero whole-application wraps.** The two canaries both stayed clean:
friends-birthdays ran eleven `run_pattern` calls, every one from source with
no import at all — it built from scratch rather than wrapping a mockup — and
trip-timeline reused by id. Six by-id executions against one composing call is
the shape a reuse suite should have. This is the number P-cand's over-fire
prediction must be read against.

`monthly-expenses` is the extreme case and worth naming: the parent **did not
delegate at all**. It searched twice, ran the answer by id, assigned a slug,
and finished in 30 seconds.

#### Corpus

| | discoverable | non-discoverable | total |
| --- | ---: | ---: | ---: |
| before | 29 | 84 | 113 |
| after | 29 | 97 | 126 |

Discoverable held at 29. This report also carries `supersededVisibility`, and
every superseded seed in it reads `false` — the superseded copies were
withheld from search for the whole cell.

#### Provenance

Model `gpt-5.6-sol`; fabric `gitSha ce372de43f…`, `ancestor` of `origin/main`;
CFC `enforce-explicit` with the same dials as cell 1; skills root scanned, 26
skills; console `http://127.0.0.1:8124` writing to
`.cf-harness-console-pnone/runs`. One family reports
`runsWithoutSkillRegistry: 1` — the `default`-profile child of trip-timeline.
Console commit not read, as before.

#### New counters — patternRefs

- **(a) 0 of 5 delegations carried `patternRefs`; 0 entries;** block absent
  from all five children.
- **(b) Census denominator is 1, and it carried nothing.** Unlike cell 1, two
  parents here did search (trip-timeline once, monthly-expenses twice), but
  monthly-expenses never delegated, and trip-timeline's delegation named no
  prior hit in its prose. So one delegation followed a parent search and
  carried no id, description, import hint, or shape.
- **(c) No refusals.**

#### Judgement against the pre-registered P-none prediction

Held on both halves, and more cleanly than cell 1: composition is 1 composing
call across 1 of 6 tasks, and `patternRefs` is unused with zero refusals. The
reuse suite adds the over-fire baseline the prediction did not itself name:
zero whole-wraps, six by-id reuses.

#### Anomalies

- **The `default`-profile child burned 452 seconds producing nothing.** Under
  trip-timeline the parent delegated to `default`; that child made eight
  calls, every one denied or errored (`bash` ×6, `read_file`, `write_file`),
  ran no `run_pattern`, and returned. The parent then searched once, ran the
  answer by id itself, and completed. Seven and a half minutes of a
  thirty-five minute cell spent on a profile that cannot author patterns.
- `assign_slug` refused once under counter before succeeding.
- The denial posture holds as in cell 1: `bash` denied 18 times, `read_file`
  errored 3 times, `write_file` once, all with the same CFC observation
  reasons. Comparable with cell 1.

### Cell 3 — P-cand, composition suite

Report: `p-cand-composition/report.json`, artifact root
`.cf-harness-console-pcand/runs`. Ran 02:57:24Z to 03:37:07Z. Four tasks, four
`turn_completed`.

#### Flag check — PASSES, both directions

| Check | Expected | Read from artifacts |
| --- | --- | --- |
| Candidate marker | present | present in all 4 parents (1032-char system message) |
| Historic marker | absent | absent in all 4 parents |
| Child composition bullet | present | present in all 5 children |
| patternRefs child block | present where refs attached | present in all 5 children |

#### Extractor counts

| Task | searches (hits/empty) | run_pattern | by id | source | composing | outcomes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| dice-tally | 3 (3/0) | 10 | 0 | 10 | 10 | 2 ok, 8 compile-error |
| party-prep | 5 (5/0) | 2 | 0 | 2 | 2 | 1 ok, 1 compile-error |
| team-picker | 7 (7/0) | 6 | 0 | 6 | 6 | 1 ok, 5 compile-error |
| workout-streak | 5 (4/1) | 9 | 0 | 9 | 8 | 2 ok, 7 compile-error |
| **cell** | **20 (19/1)** | **27** | **0** | **27** | **26** | **6 ok, 21 compile-error** |

Distinct composing tasks: **4 of 4.** Twenty-six of twenty-seven
`run_pattern` calls compose an imported pattern. No re-exports, no bare
imports, and no `error` outcomes at all.

#### The parent now does the retrieval

Every parent searched: 2, 2, 3 and 3 searches, against **0, 0, 0, 0** in cell
1 on the same suite. Distinct hits seen per parent: 6, 9, 15, 10.

#### New counters — patternRefs. This is the flip.

- **(a) Usage: 5 of 5 delegations carried `patternRefs`** — 8 entries in all
  (2, 2, 2, 1, 1), and **every entry carried a parent-authored `note`**. The
  generated child block is present in all five children, read from the
  children's own received text.
- **(b) Shapes reached the child, in full, on every entry.** For all 8
  entries the child's received text contains the trusted record's exact
  `description`, `importHint`, `argumentType` **and** `resultType` — 8 of 8 on
  each of the four fields.
- **(c) Per-entry refusals: none.** `patternRefRefusals` absent from all five
  results; no `not-searched-by-parent` occurred.

**The free-text channel went silent.** In all five delegations, `goal` plus
`context` contain **no** prior-hit pattern id at all, and none of the four
metadata fields. The parent stopped retyping and let the structure carry it.

Against the 2026-08-31 V2 census, per delegation:

| Handoff fact | V2, 2026-08-31 | P-cand, this cell |
| --- | ---: | ---: |
| Delegations | 24 | 5 |
| Naming a prior hit in prose | 22 | 0 |
| Carrying exact description | 4 | 0 in prose, 8 structurally |
| Carrying exact import hint | 8 | 0 in prose, 8 structurally |
| Carrying exact argument shape | 1 | 0 in prose, 8 structurally |
| Carrying exact result shape | **0** | 0 in prose, **8 structurally** |

The audit's census question flips as expected: the shape that never once
crossed in prose now crosses on every entry.

#### Every attachment was a part, not an app

Four distinct ids were attached, and the index classified all four as
`kind: "part"` (two `proven`, two `unproven`). Every id composed in source had
first been attached as a ref; nothing was imported that the parent had not
chosen. No whole application was wrapped.

#### Corpus

| | discoverable | non-discoverable | total |
| --- | ---: | ---: | ---: |
| before | 29 | 83 | 112 |
| after | 29 | 99 | 128 |

#### Provenance

Model `gpt-5.6-sol`; fabric `gitSha ce372de43f…`, `ancestor` of `origin/main`;
same CFC dials; 26 skills, no run without a registry; console
`http://127.0.0.1:8126` writing to `.cf-harness-console-pcand/runs`. Console
commit not read.

#### Judgement against the pre-registered P-cand prediction

The prediction has four conjuncts. Three can be judged now; one cannot.

1. **"Composes at >= P-hist rate" — not judgeable yet.** P-hist has not
   landed. Against the other landed cell, composition rises from 1 of 4 tasks
   to **4 of 4**, and against the 2026-08-31 Sol/V2 cell on this suite it
   matches 4 of 4.
2. **">= half of composing delegations carry patternRefs" — met, at 5 of 5.**
   This is the conjunct the round most needed and it is met without
   qualification.
3. **"Over-fire drops" — no over-fire to drop in this cell, and none
   created.** All four attachments were parts; no whole application was
   wrapped. The real test is P-cand on the reuse suite, where cell 2 set the
   baseline at zero whole-wraps; a cell that stays at zero cannot show a drop
   but can show the prompt does no harm.
4. **"Compile burn per composing task drops >= 30% vs P-hist" — not judgeable
   yet, and the interim read is unfavourable.** This cell spent 21
   compile-errors over 4 composing tasks, 5.25 each. The 2026-08-31 Sol/V2
   cell — historic prompt, same suite, same tier — spent 22 over 4, 5.5 each.
   That is a 4.5% reduction, far short of 30%. If P-hist lands near its own
   historic figure, **this conjunct falsifies**, and the pre-registration is
   explicit about what that means: the shapes crossing did not buy cheaper
   compilation, which is a finding rather than a failure.

So the structural channel demonstrably works — it is used, unrefused, and
lossless — while the cost claim made for it is, on the evidence so far, not
supported.

#### Anomalies

- One child failed under party-prep (`.subagent.1`) and the parent
  re-delegated with the same two refs; the second child completed. Both
  children received the full block.
- Denial posture unchanged: `bash` denied 11, `read_file` errored 7.
- `dice-tally` is the burn outlier: 10 composing calls against one `unproven`
  part for 8 compile-errors. `party-prep` is the opposite: 2 calls, 2 parts,
  done.

## Thrash analysis — the pre-stated hypothesis does not survive

The duty named a hypothesis to test: that the observation-denial posture
starves children of every reference surface, so they iterate blind, and that
this shows up as repeated same-class error loops. Measured across the three
landed cells, **it does not.** What the artifacts show instead is a different
and larger cost.

### Errors do not repeat

Consecutive `run_pattern` failures were classified by their compiler
diagnostics, with identifiers and line numbers normalized away so that "the
same error again" is a property of the diagnostic rather than its wording:

| Cell | failures | identical class | overlapping class | new class |
| --- | ---: | ---: | ---: | ---: |
| 1 — P-none composition | 32 | 1 | 1 | 24 |
| 2 — P-none reuse | 18 | 2 | 1 | 10 |
| 3 — P-cand composition | 21 | 0 | 1 | 14 |

The longest same-class streak anywhere is 2. Children move to a new diagnostic
almost every iteration: this is progress-shaped iteration through a long tail
of distinct type errors, not a loop.

The correlation the hypothesis asked for cannot be computed: across all three
cells there are 6 repeat-class gaps in total, and 2 of them contain a denied
or errored reference call. At that n the answer is **not derivable**, and it is
recorded as not derivable rather than as no correlation.

The denied calls also cost almost no wall time — each denial returns in under
a second — and they cluster **before** the first `run_pattern`, not between
failures. Children ask for documentation once at the start, are refused, and
then never ask again. Whether that refusal raises the *initial* error rate is
a real question this round cannot answer: it would need a cell where the reads
succeed, and no such cell exists.

### Where the evening actually goes

`modelAttempts[].durationMs` measures time to the provider's response start on
a streaming call, not generation, so it understates model time roughly
tenfold; the figures below instead measure the gaps between tool calls, which
are the model turns.

| Cell | child wall | in model turns | in tool execution | turns | mean turn |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 2332s | 2284s (98%) | 48s | 82 | 28s |
| 2 | 1934s | 1849s (96%) | 84s | 64 | 29s |
| 3 | 2175s | 2087s (96%) | 88s | 60 | 35s |

Tool execution is 2-4% of a child's life. `run_pattern` itself usually returns
in under a second. The harness is not slow; the model turns are long, and
there are many of them.

### The compile loop is superlinear, and that is the cost driver

Pairing every model turn with the number of `run_pattern` failures that
preceded it, over all child runs in all three cells:

| prior failures | mean turn cost | n |
| ---: | ---: | ---: |
| 0 | 13.9s | 108 |
| 1 | 48.3s | 12 |
| 2 | 46.5s | 12 |
| 3 | 47.1s | 12 |
| 4 | 67.3s | 11 |
| 5 | 76.3s | 10 |
| 6+ | 53.7s | 26 |

A turn before the first failure averages 13.9s; a turn after any failure
averages 55.5s — four times as expensive — and the cost keeps climbing as
failures accumulate. The mechanism visible in the artifacts is context growth:
each failed attempt appends a large diagnostic, often with source excerpts,
and every later turn re-reads all of them. The individual turn traces show it
plainly — team-picker's child in cell 1 runs 7, 0, 0, 13, 0, 0, 7 seconds
through its search phase and then 118, 108, 87, 88, 98, 88 through its compile
phase.

**So the operational finding is not that children thrash. It is that the
n-th compile attempt costs several times the first, so the price of a task is
superlinear in how many attempts it takes.** Anything that reduces attempts —
better first-attempt source, cheaper diagnostics, or dropping superseded
diagnostics from context — attacks the cost directly, while anything that
merely makes each attempt smarter does not.

This bears on P-cand's cost claim. Its structural channel did reduce
`run_pattern` calls per composing task against the same-suite historic
baseline (27 over 4 composing tasks against 32 over 4), but not compile errors
per composing task (5.25 against 5.5). Since cost is driven by attempt count
after the first failure, a channel that improves what the child is told but
not how many attempts it needs will not show up as a materially cheaper cell —
which is what the interim burn read shows.

### Cell 4 — P-cand, reuse suite

Report: `p-cand-reuse/report.json`, artifact root
`.cf-harness-console-pcand/runs`. Ran 03:37:07Z to 03:39:36Z — **149 seconds for
six tasks.** Six `turn_completed`.

#### Flag check — PASSES, both directions

Candidate marker present in all six parents (1032-char system message),
historic marker absent. No child transcripts exist to check the composition
bullet against, because **no task delegated at all**; that absence is itself
the result, recorded below rather than as a missing reading.

#### Extractor counts

| Task | searches (hits/empty) | run_pattern | by id | source | composing | outcomes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| counter | 1 (1/0) | 1 | 1 | 0 | 0 | 1 ok |
| reading-list | 1 (1/0) | 1 | 1 | 0 | 0 | 1 ok |
| friends-birthdays | 2 (1/1) | 1 | 1 | 0 | 0 | 1 ok |
| project-notes | 2 (2/0) | 1 | 1 | 0 | 0 | 1 ok |
| trip-timeline | 2 (2/0) | 1 | 1 | 0 | 0 | 1 ok |
| monthly-expenses | 3 (2/1) | 1 | 1 | 0 | 0 | 1 ok |
| **cell** | **11 (9/2)** | **6** | **6** | **0** | **0** | **6 ok, no errors** |

Zero delegations, zero authored source, zero compile errors. Corpus before and
after are identical at 29 discoverable and 99 non-discoverable: a cell that
authors nothing publishes nothing.

#### Admissibility cross-check — is 6 of 6 honest?

Yes, on the instrument's own record, with one caveat that limits what "ok"
means.

**The suite is documented as whole-answerable.** The composition suite exists
precisely because the standing six stopped being a composition measure:
`scripts/pattern-index-composition-suite.json` records that by 2026-08-29 the
corpus held "a whole published answer to every one of them — five published by
the 2026-08-28 batch itself — so a run answered each by calling one pattern by
identifier and authored no source at all." A task on this suite that is
answered whole by id is therefore the behavior the corpus affords, not a
parent under-building.

**Every entry run was an app, and its description matches the request.** Read
from each parent's own search records:

| Task | entry | kind / quality | match | description |
| --- | --- | --- | ---: | --- |
| counter | `U5g1VlAb1uFmme…` | app / proven | 4/4 | reactive counter with Increment and Reset buttons |
| reading-list | `FimzoBmTy8QTJQ…` | app / proven | 7/10 | reading tracker, add/remove books, one-to-five star ratings |
| friends-birthdays | `2QGxpAuh-TxmV1…` | app / proven | 5/7 | birthday tracker, chronological upcoming list, days-away |
| project-notes | `GWkpTfEhKE5hSc…` | app / proven | 4/6 | notes dashboard, labeled notes, filter to one label, search |
| trip-timeline | `2h0TVvTMdhGlcF…` | app / proven | 6/8 | multi-day trip itinerary, chronological cards, day navigation |
| monthly-expenses | `DWl3kXPQc1qRvG…` | app / proven | 3/5 | expense tracker, adds categorized expenses, totals, sorts by amount |

Six for six the parent ran an entry the index classifies as a finished
application, not a part, which is exactly what the candidate prompt's
"if one entry answers the whole request, run it by patternId" instructs.

**The caveat, stated plainly.** `ok` means the pattern compiled and matched
its schema. Nothing here renders a piece or opens one. So this cell's success
rests entirely on descriptions — and those descriptions were written by the
runs that published these entries in earlier batches, not by an independent
observer. Five of the six say "polished". A whole-answer that is wrong in the
same way its description is wrong would read `ok` here. The admissibility
check confirms the parent picked an entry that *claims* to answer the task; it
cannot confirm the entry *does*. That is what Block 4's browser verification
is for, and until it runs, "6 of 6" is a retrieval-and-execution result, not a
working-software result.

#### patternRefs counters

- **(a) 0 of 0 delegations carried refs — there were no delegations.** Not a
  disuse of the channel: the decision policy's other branch fired, and a
  whole-answer run by id has no child to attach anything to.
- **(b) Not applicable; no delegation crossed.**
- **(c) No refusals.**

#### The decision policy, read across cells 3 and 4

One prompt, unchanged between them, produced opposite behavior on the two
suites, and the right one on each:

| | composition suite (cell 3) | reuse suite (cell 4) |
| --- | ---: | ---: |
| by-id runs | 0 | 6 |
| source runs | 27 | 0 |
| composing | 26 | 0 |
| delegations | 5, all carrying refs | 0 |
| compile errors | 21 | 0 |
| wall clock | ~40 min | 149 s |

Where no single entry answered, it decomposed, attached parts, and composed
them; where one entry answered, it ran that entry and stopped. That is the
candidate prompt's two branches firing on the right inputs.

**The historic over-firing is gone.** On 2026-08-31 the historic prompt on
this same reuse suite produced 1 by-id run against 6 from source and 6
composing calls across 5 tasks, and both tiers wrapped an already-whole
application — Terra's birthday app repeatedly, Sol's trip timeline. Under the
candidate prompt the same six tasks produce 6 by-id runs, 0 source, and 0
wraps. The blanket "import what you find" instruction was what manufactured
the wrapping, and replacing it with a decision policy removed it without
costing the composition lift, which cell 3 shows intact at 4 of 4.

Against P-none on the same suite (cell 2), the gain is cost rather than
correctness: P-none also reached 6 by-id runs, but spent 21 source runs, 16
compile errors and 35 minutes doing it, against 0, 0 and 149 seconds here.

#### Timing

Every task is parent-only, 19-27 seconds each, 83-92% of it model turn time,
4-6 turns, slowest single turn 8 seconds. There is no compile loop, so the
superlinear cost described above never starts. This is the cheapest cell of
the round by more than an order of magnitude, and it is cheap for a structural
reason: no failed attempt ever entered a context.

### Cell 5 — P-hist, composition suite

Report: `p-hist-composition/report.json`, artifact root
`.cf-harness-console-phist/runs`. Ran 02:57:14Z to 03:54:11Z, 3417 seconds.
Four tasks, four `turn_completed`.

#### Flag check — PASSES, both directions

Historic marker present in all four parents (1795-char system message),
candidate marker absent. Child composition bullet present in all twelve
children. Valid.

#### Extractor counts

| Task | searches (hits/empty) | run_pattern | by id | source | composing | outcomes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| dice-tally | 11 (11/0) | 16 | 0 | 16 | 6 | 3 ok, 11 compile-error, 2 error |
| party-prep | 9 (6/3) | 5 | 0 | 5 | 5 | 3 ok, 2 compile-error |
| team-picker | 13 (7/6) | 18 | 0 | 18 | 5 | 3 ok, 7 compile-error, 8 error |
| workout-streak | 20 (6/14) | 8 | 0 | 8 | 2 | 3 ok, 5 compile-error |
| **cell** | **53 (30/23)** | **47** | **0** | **47** | **18** | **12 ok, 25 compile-error, 10 error** |

Distinct composing tasks: **4 of 4**, replicating V2. Delegations: **12**, all
`pattern-author` — three per task against P-cand's 1.25. Corpus 29/83 before,
29/104 after; discoverable held at 29.

#### The pre-registered P-hist prediction — two halves falsified

Prediction: *"composes (replicates V2) but through prose handoff; refs unused;
compile burn comparable to 2026-08-31 V2 (9-22 per composing cell)."*

- **"Composes (replicates V2)" — held.** 4 of 4 tasks, 18 composing calls
  against Sol/V2's 17 on the same suite.
- **"Through prose handoff" — FALSIFIED.** Not one of the twelve delegations
  names a prior hit in `goal` or `context`, and none carries a description,
  import hint, or shape in prose. The behavior the audit measured on
  2026-08-31 — 22 of 24 delegations retyping an id into free text — has
  disappeared under the same prompt.
- **"Refs unused" — FALSIFIED, and this is the round's biggest surprise.**
  **7 of 12 delegations carried `patternRefs`**, 9 entries in all, every entry
  with a parent-authored note, zero refusals. The historic prompt never
  mentions `patternRefs`; the field is visible in the `delegate_task` schema
  and the parent found it there.
- **"Compile burn 9-22 per composing cell" — marginally outside.** 25
  compile-errors, just above the band, at the Sol end of it.

#### patternRefs counters

- **(a) 7 of 12 delegations, 9 entries.** Block present in the 7 corresponding
  children and absent in the other 5, read from the children's own text.
- **(b) All 9 entries delivered all four fields** — exact `description`,
  `importHint`, `argumentType` and `resultType` — to their children. Same
  lossless crossing as cell 3.
- **(c) No refusals.**

#### The three prompt conditions, as one series

The refs channel is not created by the candidate prompt. It is created by the
parent searching at all, and the candidate prompt makes its use universal:

| Condition | parents that searched | delegations | carrying refs |
| --- | ---: | ---: | ---: |
| P-none (cells 1, 2) | 2 of 10 | 10 | **0** |
| P-hist (cell 5) | 4 of 4 | 12 | **7** |
| P-cand (cell 3) | 4 of 4 | 5 | **5** |

Under no prompt the parent never searches, so refs are structurally
impossible. Under the historic prompt the parent searches and discovers the
field unaided. Under the candidate prompt every delegation carries it, and
there are fewer than half as many delegations.

#### (3) What the ten `error` outcomes actually are

Read from the `run_pattern` tool outputs, three signatures:

| n | signature | task |
| ---: | --- | --- |
| 6 | `run_pattern input "core" does not match the pattern's argument schema: value does not match type object` | team-picker |
| 2 | `run_pattern input "die" does not match the pattern's argument schema: roll: value does not match type object` | dice-tally |
| 2 | `the pattern ran but a computation attributed to the created piece failed while settling and the result never landed` (failure text withheld under CFC, retained in the artifact) | team-picker |

So **8 of the 10 are argument-schema mismatches**: the child wired a value into
an imported pattern's input and the value did not match that input's declared
shape. The other 2 are runtime settle failures. For contrast, all 7 `error`
outcomes in cell 1 are the runtime settle class and none is a schema mismatch —
because P-none's children barely composed, so they never wired a supplied
shape at all.

#### The within-cell control this cell accidentally provides

Because P-hist attached refs to some delegations and not others, one prompt and
one task set split its own children into two arms:

| Arm | children | run_pattern | ok | compile-error | error | of which argument-schema |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| received refs | 7 | 18 | 7 | 11 | **0** | **0** |
| received none | 5 | 29 | 5 | 14 | **10** | **8** |

**Every argument-schema mismatch in this cell is in a child that was not given
the shapes.** Children that received them made none, across 18 attempts here
and 27 more in cell 3 — 45 composing attempts with zero shape mismatches.

This is the round's clearest causal evidence, and it is stronger than the
between-cell comparison because prompt, suite, model and corpus are held
fixed: the variable is whether the shapes crossed. It is what the audit's
disposition predicted the structural attachment would fix, and it is fixed.

#### (2) The burn conjunct — FALSIFIED on the pre-registered metric

Both cells composed on 4 of 4 tasks, so the denominators match.

The pre-registration's own gloss fixes the meaning of "compile burn": it
calibrates against "2026-08-31 V2 (9-22 per composing cell)", and 9 and 22 are
the **compile-error** counts of the Terra/V2 and Sol/V2 composition cells. So
the metric is compile-errors divided by composing tasks.

| | compile errors | composing tasks | per task |
| --- | ---: | ---: | ---: |
| P-hist | 25 | 4 | 6.25 |
| P-cand | 21 | 4 | 5.25 |

Drop = (6.25 − 5.25) / 6.25 = **16.0%**, against a required ≥30%.

**The conjunct is falsified.** The pre-registration says what that means, and
it is worth quoting rather than softening: falsified by "burn not dropping"
makes this "a finding, not a failure" — the shapes crossing did not buy
proportionally cheaper compilation.

Two adjacent readings clear the bar, and are recorded so the picture is whole
rather than to rescue the conjunct:

| Reading | P-hist per task | P-cand per task | drop |
| --- | ---: | ---: | ---: |
| compile errors **(pre-registered)** | 6.25 | 5.25 | **16.0%** |
| all failed attempts (compile-error + error) | 8.75 | 5.25 | 40.0% |
| all `run_pattern` attempts | 11.75 | 6.75 | 42.6% |

The gap between the first row and the other two is the `error` class, which
P-cand eliminated entirely (10 → 0) by the mechanism in the within-cell
control above. So the honest statement is: **the structural channel removed a
whole error class, and did not materially reduce compile errors.** The
pre-registered metric measured only the half it did not move.

Cost followed the same shape: P-hist spent 3417 seconds and 12 delegations on
these four tasks, P-cand 2383 seconds and 5.

#### Method correction made while reading this cell

The first pass of this thread's extractor built its trusted-record map from
every search in a parent transcript at once, and kept the first sighting of an
id. The harness keeps the **last** sighting at the moment of the call
(`#trustedPatternSearchRecords.set`, `src/prompt-loop.ts:3095-3103`), and only
searches that already happened. The two disagree whenever a parent sees one id
at different ranks, because the endpoint returns argument and result shapes
only for the leading hits — one `party-prep` id appeared at rank 10 with no
shapes and at ranks 1 and 3 with them.

The extractor now walks the transcript in order and compares each delegation
against what the parent had searched by then. Under the corrected method the
count above is 9 of 9 entries crossing all four fields; the uncorrected pass
had reported one of them as carrying no shapes. Cells 1-4 were re-derived and
are unchanged.

The underlying system property is worth keeping: **whether shapes reach a
child depends on the rank at which the parent last saw that entry.** A parent
whose final sighting of an id is outside the shape-bearing leading hits
attaches a ref whose block reads "Not available." for both shapes. No cell in
this round hit that case, but nothing prevents it.

### Cell 6 — P-hist, reuse suite

Report: `p-hist-reuse/report.json`, artifact root
`.cf-harness-console-phist/runs`. Ran 03:54:11Z to 04:08:51Z, 880 seconds. Six
tasks, six `turn_completed`.

#### Flag check — PASSES, both directions

Historic marker present in all six parents (1795-char system message),
candidate marker absent; child composition bullet present in all eight
children. Valid.

#### Extractor counts

| Task | searches (hits/empty) | run_pattern | by id | source | composing | outcomes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| counter | 3 (3/0) | 1 | 1 | 0 | 0 | 1 ok |
| reading-list | 11 (7/4) | 10 | 0 | 10 | 4 | 4 ok, 6 compile-error |
| friends-birthdays | 4 (4/0) | 1 | 1 | 0 | 0 | 1 ok |
| project-notes | 4 (4/0) | 1 | 0 | 1 | 1 | 1 ok |
| trip-timeline | 4 (3/1) | 1 | 0 | 1 | 1 | 1 ok |
| monthly-expenses | 4 (2/2) | 2 | 1 | 1 | 1 | 2 ok |
| **cell** | **30 (23/7)** | **16** | **3** | **13** | **7** | **10 ok, 6 compile-error** |

Delegations: 8, all `pattern-author`; 7 of 8 carried `patternRefs`, no
refusals. Corpus 29/104 → 29/111, discoverable held at 29.

#### (2) The over-fire, entry by entry

Seven refs were attached across the six tasks, and **six of the seven are
`kind: "app"`** — finished applications, not parts. What each task then did
with its app is the whole result:

| Task | attached | what happened | over-fire? |
| --- | --- | --- | --- |
| counter | app `U5g1VlAb…` | ran by id | no |
| friends-birthdays | app `2QGxpAuh…` | ran by id | **no — canary did not fire** |
| reading-list | app `FimzoBmTy8QT…` + part `dZt8…` | wrapped the app in new source, 10 attempts, 6 compile-errors | **yes** |
| project-notes | app `GWkpTfEhKE5h…` | wrapped the app in new source | **yes** |
| trip-timeline | app `2h0TVvTMdhGl…` | wrapped the app in new source | **yes — canary fired** |
| monthly-expenses | app `DWl3kXPQc1qR…` | ran by id **and** wrapped it in source | **yes** |

**Four of six tasks wrapped a whole application in new source.** The four apps
wrapped here — reading tracker, notes dashboard, trip itinerary, expense
tracker — are the very entries P-cand ran by id in cell 4.

On the pre-registered canaries: **trip-timeline fired**, replicating Sol/V2's
trip-timeline wrap from 2026-08-31; **friends-birthdays did not**, running its
app by id instead. The prediction named two canaries and the cell produced
four over-fires, two of them — project-notes and monthly-expenses — outside
the named set. So the canary list under-counted the failure mode rather than
over-counting it.

#### The mechanism, which the round did not predict

In every one of these four cases the parent **attached the whole application
as a `patternRef`**, and the child dutifully wired it as a component. The
structural channel did not cause the over-fire, but it does amplify it: the
parent now hands the child an app complete with its argument and result
shapes, which is exactly what makes wrapping easy and plausible.

This is the sharpest available evidence about what the candidate prompt
actually contributes. P-hist and P-cand use the channel at comparable rates
(7 of 8 delegations here, 5 of 5 in cell 3); they differ in whether the prompt
tells the parent to distinguish a whole answer from a part. With that
sentence, four apps are run by id; without it, four apps are wrapped.

#### Cost of the over-fire

Wrapping cost 13 source runs and 6 compile-errors to reach the same six
answers P-cand reached with 6 by-id runs and no errors, in 880 seconds against
149. `reading-list` alone spent 10 attempts and 3 delegations wrapping an app
that answers the task whole.

## Block 1 closeout

### The three conditions, side by side

Composition suite (four tasks):

| | P-none | P-hist | P-cand |
| --- | ---: | ---: | ---: |
| parents that searched | 0 of 4 | 4 of 4 | 4 of 4 |
| delegations | 5 | 12 | 5 |
| delegations carrying refs | 0 | 7 | 5 |
| run_pattern | 39 | 47 | 27 |
| composing calls | 2 | 18 | 26 |
| composing tasks | 1 of 4 | 4 of 4 | 4 of 4 |
| ok | 7 | 12 | 6 |
| compile-error | 25 | 25 | 21 |
| error | 7 | 10 | **0** |
| wall | ~2500s | 3417s | 2383s |

Reuse suite (six tasks):

| | P-none | P-hist | P-cand |
| --- | ---: | ---: | ---: |
| run_pattern | 27 | 16 | **6** |
| by id | 6 | 3 | **6** |
| from source | 21 | 13 | **0** |
| composing | 1 | 7 | 0 |
| **whole apps wrapped** | **0** | **4** | **0** |
| compile-error | 16 | 6 | **0** |
| delegations | 5 | 8 | **0** |
| wall | 2113s | 880s | **149s** |

### The pre-registered P-cand conjuncts, all four now judgeable

1. **"Composes at >= P-hist rate" — HELD.** 4 of 4 tasks against 4 of 4, with
   26 composing calls against 18.
2. **">= half of composing delegations carry patternRefs" — HELD**, at 5 of 5.
3. **"Over-fire drops" — HELD, decisively.** P-hist wrapped four whole
   applications across four of six reuse tasks; P-cand wrapped none and ran
   all six by id. This supersedes the interim note in cell 4, which had no
   baseline to measure against and said so.
4. **"Compile burn per composing task drops >= 30% vs P-hist" — FALSIFIED**,
   at 16.0% on the pre-registered metric (6.25 → 5.25 compile-errors per
   composing task). Adjacent readings clear the bar (40.0% on all failed
   attempts, 42.6% on all attempts) because P-cand eliminated the `error`
   class entirely, but the metric as written did not move enough.

By the letter of the pre-registration, which lists "burn not dropping" among
the falsifiers, the P-cand prediction **as a conjunction is falsified**. Three
of its four parts held, and the falsified one is the cost claim, not the
behavior claim.

### The refs control, folded in

The strongest causal result of Block 1 is not a between-condition comparison
at all. P-hist attached refs to some delegations and not others, splitting its
own composition cell into two arms under one prompt, one suite, one model and
one corpus:

| Arm | children | run_pattern | ok | compile-error | error | argument-schema |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| received refs | 7 | 18 | 7 | 11 | **0** | **0** |
| received none | 5 | 29 | 5 | 14 | **10** | **8** |

Every argument-schema mismatch in Block 1 occurred in a child that was not
given the shapes. Children that received them made none, across 45 composing
attempts in two cells. The structural channel does not make compilation
cheaper; it removes one specific failure — wiring a value into an input whose
shape the child was guessing.

### Winner: P-cand. No P-hist result counts as a reversing surprise.

Two P-hist findings are genuine surprises against the pre-registration, and
neither favours P-hist:

- **Refs are used without being taught** (7 of 12 composition delegations, 7
  of 8 reuse), falsifying "refs unused". This narrows P-cand's unique
  contribution: it is not that the candidate prompt unlocks the channel, but
  that it makes its use universal and, far more importantly, tells the parent
  when *not* to compose.
- **The prose handoff has vanished** under the historic prompt too, falsifying
  "through prose handoff" and superseding the audit's 22-of-24 census.

Neither is a reason to prefer P-hist. On the decision Block 1 exists to make,
P-cand wins on every behavioral axis and on cost: identical composition rate,
four whole-app wraps eliminated, the argument-schema error class eliminated,
a quarter of the delegations, and a reuse suite answered in 149 seconds
against 880.

The one honest qualification: **P-cand's compile-error rate per attempt is
higher** — 21 of 27 attempts (78%) against P-hist's 25 of 47 (53%). It makes
far fewer attempts and a larger fraction of them fail to compile. Its total
cost is lower on every measure, but nothing here shows it authoring more
compilable source, and the falsified burn conjunct is the same fact seen from
another side.

**Block 2 should run under P-cand.**

## Block 2 — V1: the child's composition bullets

### Cell 7 — P-cand parent, child bullets withheld, composition suite

Report: `v1-nobullets-composition/report.json`, artifact root
`.cf-harness-console-pcand-nobullets/runs`, console `:8127`, space
`round4-v1-nobullets`. Ran 04:12:41Z to 05:03:40Z, 3059 seconds. Four tasks,
four `turn_completed`. Comparator is cell 3, the same parent prompt with the
bullets present.

#### Pre-flight deviation, recorded

The sacrificial model probe was not run for this cell. `/api/task` refused the
operator's unsigned `curl`, which is the endpoint behaving correctly rather
than a substrate fault. Substrate evidence offered in its place: docker up
with runsc-cfc, toolshed sha matching, and the p-hist batch completing on the
same substrate minutes earlier. This cell therefore rests on inherited
substrate evidence rather than its own probe. Nothing in its artifacts
suggests a substrate fault — no `fabric session unavailable`, no run without a
skill registry, 35 `run_pattern` calls all answered — so it is counted, with
the deviation on the record.

#### Flag check — PASSES, both directions, and the variable is confirmed

| Check | Expected | Read from artifacts |
| --- | --- | --- |
| Candidate marker | present | present in all 4 parents (1032-char system message) |
| Historic marker | absent | absent |
| **Child composition bullet** | **absent** | **absent in all 6 children** |
| patternRefs child block | present | present in all 6 children |

Checked in the children's own transcripts, not from the invocation. The
variable is isolated: same parent prompt as cell 3, same suite, same model,
bullets gone, refs block still delivered.

#### Extractor counts

| Task | searches (hits/empty) | run_pattern | source | composing | outcomes |
| --- | --- | ---: | ---: | ---: | --- |
| dice-tally | 2 (2/0) | 6 | 6 | 4 | 3 ok, 3 compile-error |
| party-prep | 6 (6/0) | 2 | 2 | 2 | 1 ok, 1 compile-error |
| team-picker | 6 (4/2) | 7 | 7 | **0** | 3 ok, 4 compile-error |
| workout-streak | 9 (8/1) | 20 | 20 | 7 | 4 ok, 16 compile-error |
| **cell** | **23 (20/3)** | **35** | **35** | **13** | **11 ok, 24 compile-error, 0 error** |

**Tasks composing: 3 of 4.** No by-id runs, no re-exports, no bare imports.
Corpus 29/111 → 29/122, discoverable held at 29. Two of the three
workout-streak children failed before a third completed.

#### (3) The refs channel is untouched — and that is the point

| | cell 3, bullets present | cell 7, bullets withheld |
| --- | ---: | ---: |
| delegations | 5 | 6 |
| carrying `patternRefs` | 5 of 5 | **6 of 6** |
| ref entries | 8 | **9** |
| entries with a parent note | 8 | 9 |
| refusals | 0 | 0 |
| block present in children | 5 of 5 | **6 of 6** |
| entries delivering both shapes | 8 of 8 | **8 of 9** |

The parent behaved identically: it searched, chose parts, attached them with
notes, and the harness delivered the block to every child. **What changed is
what the child did with it.**

The clearest single case is `team-picker`. Its child received **three** refs —
dice-roller, counter and check-list — with kind, quality, description, import
hint and both shapes for all three. It then wrote seven patterns from source
and composed **none of them**. In cell 3 the same task composed on six of six
attempts.

Per task, composing calls as a fraction of attempts:

| Task | bullets present | bullets withheld |
| --- | ---: | ---: |
| dice-tally | 10/10 | 4/6 |
| party-prep | 2/2 | 2/2 |
| team-picker | 6/6 | **0/7** |
| workout-streak | 8/9 | 7/20 |
| **cell** | **26/27 (96%)** | **13/35 (37%)** |

#### The observed "Not available." case

One of the nine entries — `DRCFljoU…` under party-prep — reached its child
with `Argument shape: Not available.` and `Result shape: Not available.`,
because the parent's last sighting of that id was outside the shape-bearing
leading hits. This is the failure mode cell 5 recorded as possible but unhit;
**it is now observed.** The task composed that entry anyway and reached `ok`,
so it cost nothing here, but the channel's completeness depends on search rank
and it is not guaranteed.

#### (2) Verdict against the Block-2 pre-registration

Prediction: *"no significant difference (audit hypothesis: the bullets are
dead weight once the parent decides)."* Falsifier: *"composition rate or burn
moves materially with bullets withheld — then they stay."*

Both named quantities moved, and materially:

| Measure | bullets present | bullets withheld | change |
| --- | ---: | ---: | ---: |
| tasks composing | 4 of 4 | 3 of 4 | −1 task |
| composing share of attempts | 96% | 37% | −59 points |
| compile-errors per composing task | 5.25 | 8.00 | +52% |
| `run_pattern` per composing task | 6.75 | 11.67 | +73% |
| wall clock | 2383s | 3059s | +28% |

**The prediction is falsified and the falsifier is met.** By the
pre-registration's own rule — "then they stay" — **the four child composition
bullets are kept.** The audit's hypothesis that they are dead weight once the
parent decides is wrong: the parent deciding is necessary and not sufficient.

One counter-reading, stated so it is not mistaken for support: the withheld
arm produced **more** `ok` outcomes, 11 against 6. That is not a quality
signal. It ran 35 attempts against 27 and authoring from scratch yields more
intermediate successes; `ok` still means compiled and schema-matched, not
working. The composing and burn measures are the ones the prediction named.

#### What the bullets license, precisely

The generated refs block is deliberately neutral: it says these records "are
available for this delegated task" and mandates nothing — the wording is
documented in the source as presenting material and mandating nothing
(`src/prompt-loop.ts:1396-1407`). It supplies **material**. The four child
bullets supply the **instruction** — that a search hit is a component to wire
rather than a specification to rebuild, and that calling an import places its
result in a field or renders its UI (`src/prompt-loop.ts:1322-1327`).

So the two surfaces divide cleanly, and Block 1 and Block 2 together establish
each half:

- Without the parent's attachment, a child that composes guesses shapes and
  produces argument-schema mismatches — Block 1's within-cell control, 8 such
  errors in no-refs children and 0 in refs-given children.
- Without the child's bullets, a child holding correct shapes largely does not
  compose at all — this cell, 96% to 37%, and `team-picker` holding three
  complete records and composing none.

**Neither surface substitutes for the other. Keep both.**

## Block 3 — the skill cell

### Cell 8 — innocuous skill task, n=1

Report: `skill-swot/report.json`, artifact root
`.cf-harness-console-skill/runs`, console `:8128`, space `round4-skill`, P-cand
parent prompt with child bullets present,
`CF_HARNESS_SKILLS_REGISTRY_URL=https://skills.sh` (banner-verified by the
operator). Ran 05:05:26Z to 05:16:15Z. One task, `turn_completed`, piece
`small-bakery-swot-worksheet`.

**This is n=1, smoke-plus-provenance as pre-registered. No rate is stated and
none should be read from it.**

#### Flag check — PASSES, both directions

Candidate marker present in the parent (1032-char system message), historic
absent, child composition bullet present, `patternRefs` block absent — the
last consistent with the parent having nothing to attach.

#### (1) `search_skills` — offered, never called

The parent's model requests carried **13 tools against 12 in every other
Round-4 cell**, read from `modelAttempts[].request.toolCount`. That one extra
tool is `search_skills`, so the registry was configured and the tool reached
the model.

**The session never called it.** The parent called `search_patterns` twice,
`delegate_task` once, `assign_slug` once; the child called `search_patterns`
twice, `bash` three times, `read_file` once and `run_pattern` six times. There
is no `search_skills` call and no `search_skills` tool output in either run.
There is therefore no query to report.

#### (2) Acquisition — not refused, not attempted: **not offered**

No skill was acquired, and the whitelist path was not exercised in either
direction. The reason is not model behavior:

`consoleChatPolicy` (`packages/cf-harness/console/server.ts:602-613`) extends
the console's allowed tool ids with `search_skills` alone when skills.sh is
configured. **`acquire_skill` is not in the console's allowlist at all.** It is
gated separately in the prompt loop
(`SKILLS_SH_ACQUISITION_TOOL_IDS`, `src/prompt-loop.ts:960-962`) and reachable
from the CLI (`--allow-tool acquire_skill` with `--skills-registry-url`,
`src/cli.ts:501-503`), but a console session cannot call it however the
registry is configured. The +1 tool-count delta is the direct evidence: one
tool was added, not two.

So neither the `phuryn` accept nor the `deanpeters` refuse-with-reason could
have occurred here. Recording this as "the model chose not to acquire" would
be false.

#### (3) Custody — nothing to trace, and the profile skills are not it

The single `delegate_task` call carried keys `context`, `goal`,
`maxModelTurns`, `profile` — **no `skillHandle`**. The child's context shows no
acquired-skill text, no pinned-fetch provenance mark, and no `ExternalIngest`
stamp; the strings `pinned`, `skills.sh` and `ExternalIngest` appear nowhere in
it.

The child *does* carry a "Configured skills context" block with
`<skill_context>` entries, and its system prompt names "Subagent profile
skills: pattern-dev, pattern-schema, pattern-ui". That is the **local
profile-skill injection present in every cell of this round**, read from the
repo skills tree, and it is a different mechanism from registry acquisition. It
must not be mistaken for evidence that the registry pipeline ran.

The custody property the cell was to check — parent never sees skill text —
is therefore **untested**, not confirmed.

#### (4) Did the worksheet use index parts? No, and the index is why

Six `run_pattern` calls, all from source, **0 importing and 0 composing**;
outcomes 1 ok, 4 compile-error, 1 error. The error is the session-only pointer
guard: "the harness detected a session-only pattern pointer in the created
piece's graph… Return a durable result object directly."

All four `search_patterns` calls across parent and child returned **zero
results**:

| Run | query |
| --- | --- |
| parent | `edit SWOT quadrant worksheet cards` + tags `swot`, `worksheet` |
| parent | `add remove editable items four quadrant board` + tags `quadrant`, `editable` |
| child | `editable SWOT worksheet quadrant board add edit remove items` |
| child | `crud list add remove edit toggle` + tag `crud-list` |

The corpus holds nothing this task could compose — note the fourth query is a
generic `crud-list` search that also answered empty, while the same tag
returned hits in earlier cells. So building from scratch was the only branch
available, and the P-cand prompt's "building from scratch is the fallback when
the index answers nothing" fired correctly.

#### (5) The skills-root line, and what this cell is valid for

The report's `Skills root: /Users/…/labs/skills (26 skills)` is the **local
profile-skill tree**, configured by `--skills-root` /
`CF_HARNESS_CONSOLE_SKILLS_ROOT` and defaulting to the repository's `skills/`
directory (`console/server.ts:531-534`). It is a separate mechanism from
`--skills-registry-url`, and the batch report has no field for the registry
URL at all. So that line is **not** evidence that the registry was
misconfigured — the tool-count delta is positive evidence it *was* configured.

What the cell is valid for, stated exactly:

- **Valid**: an n=1 observation that a session with `search_skills` on its tool
  surface, given a task whose wording never mentions skills, did not reach for
  the registry, and answered the task by authoring from scratch against an
  index that held nothing relevant.
- **Valid, and the more useful finding**: **the console cannot exercise
  acquisition.** `acquire_skill` is absent from `consoleChatPolicy`, so the
  pre-registered end-to-end pipeline — search, acquire, delegate with
  `skillHandle`, produce a pattern — is not runnable through the console as
  configured. The pre-registration assumed it was.
- **Not valid**: as a test of the acquisition path, the whitelist behavior, the
  `ExternalIngest` stamp, or `skillHandle` custody. None of those machinery
  properties was on the tool surface, so this cell says nothing about them
  either way.

Block 3's pre-registered success condition — "the pipeline exercised end to end
with the refusal/custody properties visible in artifacts" — was **not met, and
could not have been met in this configuration**. That is a finding about the
instrument rather than about the model, and it is the one to carry forward:
re-running Block 3 needs the CLI path, or a console policy that admits
`acquire_skill`.

### Block 3 amendment — moving the cell to the CLI surface

**Amendment reason:** the pre-registration assumed a console surface that
structurally cannot acquire a skill. The instrument was corrected; no
prediction was changed. The console finding above stands as cell 8 and is
filed as CT-2160.

#### Cell 8b — CLI attempt 2, VOID for parity, mined for what it shows

Artifacts under `packages/cf-harness/.cf-harness-skill-cli/{runs,cfc}`, space
`round4-skill-cli`, run `447e7108`. Parent 05:23:14Z to 05:36:09Z; child
05:24:10Z to 05:35:51Z, 21 model turns.

**Void for parity**, on the operator's ruling: the invocation omitted
`--allow-subagent-profile`, so the run is not comparable with the console
cells. It completed and produced a working piece, `small-bakery-swot`, and the
facts below are read from its artifacts rather than discarded with it.

##### (a) `acquire_skill` was on the offered tool surface — the CLI path works

This is what the amendment turned on, and the artifact settles it directly.
`policy-snapshot.json` records:

```
parentTools.allowance = "all-builtins"
parentTools.allowedToolIds = [ …, "run_pattern", "assign_slug",
  "acquire_skill", "search_patterns", "record_feedback", "search_skills" ]
```

Both skills.sh tools are present. The parent's model requests carried **14
tools**, against 13 in the console skill cell and 12 in every other Round-4
cell — the two-tool delta the console's one-tool delta was missing.

The same snapshot records `subagents.allowedProfiles = ["default"]`, which is
the artifact-level cause of the `pattern-author` denial below. Both facts come
from one file; neither is inferred.

##### (b) `search_skills` was called once, and what it asked for

Query: **`Common Fabric pattern author TypeScript JSX`**. It is an
authoring-help query, not a SWOT-content query, and its position in the run
explains it. The parent's call order was:

1. `search_patterns` ×2 — both empty, as in cell 8
2. `delegate_task(profile: "pattern-author")` — **denied, not-run**
3. `bash` — `find /opt/skills -maxdepth 2 -type f -name 'SKILL.md'` — denied
4. `search_skills` — the query above
5. `delegate_task(profile: "default")` — allowed
6. `describe_handle`, `assign_slug`

So the registry search is a **recovery move**: having lost the pattern-author
profile and been refused a look at the local skills tree, the parent went to
skills.sh looking for the pattern-authoring guidance it no longer had. That is
a coherent and rather good response to the denial, and it is the only
`search_skills` call this round has produced.

The registry answered `status: ok` with sixteen hits, none SWOT-related:
`presentation-creator` (2198 installs), `tscircuit`, three separate `fabric`
skills belonging to other projects, `ts-sdk-author`, `create-interface-skill`,
`accessibility-audit`, `performance-audit`, `authoring-typescript` and
`authoring-patterns` (nvidia, 2 and 1 installs), `reatom-jsx`,
`jsx-conventions`, `ast-grep-typescript-react`, and —
**`commonfabric/labs/lit-component`, this repository's own skill, 65
installs**.

Two things worth carrying: the query "Common Fabric" retrieves three unrelated
`fabric` skills, a live name collision in the registry's namespace; and this
repository already publishes into the registry the session was searching.

**The model did not react by acquiring.** No `acquire_skill` call followed,
though the tool was available. It went straight to a `default`-profile
delegation. Whether that is the model declining a poor hit list or not
connecting the tool to the need is not derivable from one run.

##### (c) The bash denial, with its actual cause

The CLI artifact carries a more specific message than the console cells do.
`policyDecision: denied`, and the tool output holds:

```
stderr: refusing to start a container under cfc enforcement mode
'enforce-explicit': the 'runsc-cfc' docker runtime is not registered with
--cfc-invocation-context-dir=<…>/.cf-harness-skill-cli/cfc/invocation-context,
so this invocation's CFC input labels would be written and never read
exitCode: 125
```

So the refusal is not "no sidecar exists" but "`runsc-cfc` is not registered
against *this invocation's* context directory" — a per-invocation registration
mismatch, named actionably by the message. The console cells' wording, "bash
output did not include trusted CFC mediation metadata", is the same family
seen from the observation side. Live evidence for the CT-2122 lane, and the
CLI's message is the one that says what to fix.

##### (d) Instrument note — the CLI help omits `pattern-author`

`src/cli.ts:505` documents the flag as:

```
--allow-subagent-profile <p>  Authorize delegate_task to spawn a profile
                              (repeatable: default | browser | web_fetch |
                              web_search)
```

`pattern-author` is absent from that enumeration and is nonetheless accepted.
An operator reading the help would not know to pass the value this cell needed,
which is exactly how attempt 2 came to be void. A help-text defect, one line.

##### What the void run still produced

The `default`-profile child — carrying no pattern skills — authored the
worksheet from scratch across 19 `run_pattern` calls: **2 ok, 14
compile-error, 3 error**, dominated by 21 instances of `Type 'X' is not
assignable to type 'X'`, plus a module-resolution failure and a missing
export. It reached a working piece in 21 model turns and about 12 minutes.
Not a comparable measurement, but a data point that the pattern-author profile
is a cost lever rather than a precondition.

A placeholder stood here while attempt 3 was still running, recording only
that the cell had been announced and not yet read. It is collapsed to this
line: it carried no reading, so keeping it as a second section titled
"Cell 8c" would leave two sections with one title and no second cell.

#### Cell 8c — CLI attempt 3, full authority. The Block-3 cell.

Artifacts under `packages/cf-harness/.cf-harness-skill-cli2/{runs,cfc}`, space
`round4-skill-cli2`, run `ece6ca2a`. Completed; piece
`small-bakery-swot-worksheet` produced and slugged.

##### (1) The machinery was on the surface, both directions

From this run's own `policy-snapshot.json`:

| Property | Value |
| --- | --- |
| `parentTools.allowance` | `all-builtins` |
| `acquire_skill` in `allowedToolIds` | **yes** |
| `search_skills` in `allowedToolIds` | **yes** |
| `subagents.allowedProfiles` | **`["default", "pattern-author"]`** |

Parent model requests carried 14 tools. So both skills.sh tools were offered
*and* the pattern-author profile was authorized — the two conditions cells 8
and 8b each lacked one of.

**The parent called neither skill tool.** Its five turns are
`search_patterns` ×2, `delegate_task(pattern-author)` — allowed, no denial —
`describe_handle`, `assign_slug`. Zero `search_skills`, zero `acquire_skill`,
no denial anywhere in the parent run.

This is the cell's validity: the machinery was available and went unused **by
choice**, not by absence.

##### (2) Flag checks

| Check | Read from artifacts |
| --- | --- |
| Candidate marker | **present** |
| Historic marker | absent |
| Child composition bullet | **present** |
| patternRefs block | absent — the parent attached no refs |
| Acquired-skill text in child | **absent** (`ExternalIngest`, `skills.sh`, `pinned` all absent) |
| Child profile skills | `pattern-dev, pattern-schema, pattern-ui` — the local injection, as in every cell |

**Parity caveat, recorded rather than waved past.** The CLI parent's system
message is **3340 characters against the console cells' 1032**. The candidate
prompt is present in full and byte-identical, starting at offset 2309; ahead of
it sits the CLI's own 2309-character parent preamble ("You are cf-harness, an
autonomous agent harness for Common Fabric work…"), which the audit inventories
at §1.3 and which no console cell carries. So cell 8c answers Block 3's own
question but is **not prompt-parity with cells 1-7**, and no number from it
should be compared against them.

##### (3) `run_pattern` accounting for the child

The child ran 13 model turns: three `search_patterns`, three `bash` (all
denied), four `read_file` (all denied), then eight `run_pattern`:

| Outcome | n |
| --- | ---: |
| compile-error | 7 |
| ok | 1 |
| error | 0 |

**By id: 0. Importing: 0.** The worksheet was authored entirely from scratch;
nothing in the index was composed, consistent with cell 8 where every SWOT
query answered empty. Leading diagnostics: 22 × `Type 'X' is not assignable to
type 'X'`, 8 × `Object literal may only specify known properties`, 5 ×
`Binding element 'X' implicitly has an 'X' type`. The denial posture is the
standing one.

### Block 3 close-out

#### The pre-registered success condition was not met in any cell

Block 3 asked whether the session would "search_skills, acquire (expect:
phuryn accepted OR deanpeters refused-with-reason), delegate with the
skillHandle, and produce a pattern", with success defined as "the pipeline
exercised end to end with the refusal/custody properties visible in
artifacts". Across three cells:

| Cell | surface | `search_skills` offered | `acquire_skill` offered | searched | acquired |
| --- | --- | --- | --- | --- | --- |
| 8 | console | yes | **no — structural** | no | could not |
| 8b | CLI, no pattern-author | yes | yes | **yes, once** | no |
| 8c | CLI, full authority | yes | yes | **no** | no |

Each cell fails the condition for a different reason, and only the first is
about the instrument: the console cannot offer `acquire_skill` at all
(CT-2160). The two CLI cells could have acquired and did not.

#### The honest n=3 conclusion

**The acquisition machinery is reachable and unexercised.** A task that never
mentions skills — which is the wording rule the measurement protocol imposes,
and rightly — does not elicit acquisition from this model against this corpus.

The one time the model reached for the registry at all is the telling case.
In cell 8b it searched only *after* `delegate_task(pattern-author)` was denied
and a look at the local skills tree was refused, and what it searched for was
`Common Fabric pattern author TypeScript JSX` — authoring help to replace the
capability it had just lost, not content for the user's SWOT worksheet. Give
the same parent its authoring authority back, as cell 8c does, and the
registry is never touched. **Registry search appeared here as gap-recovery
behavior, not as task-solving behavior.**

So exercising the pipeline end to end needs one of two things this round did
not supply: a task whose gap the model recognizes as skill-shaped, or explicit
guidance naming the registry. **This is a finding about elicitation, not about
machinery.**

#### What therefore remains untested

None of these was observed in any cell, and each is recorded as untested
rather than as working:

- the whitelist accept path (`phuryn/pm-skills/swot-analysis`) and the
  refuse-with-reason path (`deanpeters/…`), which the pre-registration
  expected to demonstrate the filter in both directions;
- the `ExternalIngest` stamp on a created skill cell;
- `skillHandle` custody — that the handle crosses only via `delegate_task` and
  that no skill text reaches a parent-facing surface;
- the child-return scrub against injected skill text.

The one machinery property this round did establish is negative and useful:
`acquire_skill` is absent from `consoleChatPolicy`, so no console session can
exercise any of the above.

#### Incidental findings carried out of Block 3

- **CT-2160** — the console cannot offer `acquire_skill`.
- **CT-2122 lane** — the CLI's bash refusal names its cause actionably:
  `runsc-cfc` not registered against *this invocation's*
  `--cfc-invocation-context-dir`.
- **Help-text defect** — `src/cli.ts:505` omits `pattern-author` from the
  `--allow-subagent-profile` enumeration while accepting it; this is what made
  attempt 2 void.
- **Registry namespace collision** — a "Common Fabric" query returns three
  unrelated `fabric` skills, and this repository's own
  `commonfabric/labs/lit-component` is published there with 65 installs.

Block 3 is complete.

## Block 4 — demo dry-runs through the landed contract

### Cell 9 — the five demo phrases

Report: `demo-dryrun/report.json`, artifact root
`.cf-harness-console-demo/runs`. Ran 05:17:05Z to 06:06:09Z. Five phrases, five
`turn_completed`, five pieces. Candidate marker present in all five parents,
historic absent, child bullets present in all five children. Corpus 29/123 →
29/131, discoverable held at 29.

Cell aggregate: **28 `run_pattern`, 0 by id, 0 composing, 23 compile-error,
5 ok.** Five from-scratch builds.

#### (2) The falsifier — did not fire

The pre-registered falsifier is "any completed turn whose piece exists in
artifacts but is absent from `result.pieces`". For each of the five turns,
every successful `assign_slug` recorded in the transcript and in
`tool-outputs/` also appears in the result derived from those artifacts, one
piece per turn:

| Phrase | piece | in artifacts | in `result.pieces` |
| --- | --- | :-: | :-: |
| poll | `dinner-vote` | yes | yes |
| rsvp | `dinner-party-rsvp` | yes | yes |
| emails | `latest-emails` | yes | yes |
| research | `three-gifts-for-a-gardener` | yes | yes |
| budget | `budget-dashboard` | yes | yes |

`turnId` equals `runId` in every case and `finalAssistantText` is present in
every run report, so no turn resolves to an undefined result.

**Method caveat, stated because it bounds the claim.** No
`GET /api/turns/<id>/result` payloads were saved to disk, and the result is
not stored durably — `console/turn-result.ts` derives it on read from
`transcript.json` plus the `run-report.json` timeline boundary. This check
re-derived each result from those same inputs, applying the same run-boundary
and `assign_slug` extraction rules. It is faithful to the function's inputs
and is **not** an observation of the served HTTP response.

#### (1) Per-phrase verdicts, browser-verified by the operator

Verification was done by hand against the shell dev server on `:5173`. The
recorded piece URLs 404 against toolshed `:8062` directly because that
toolshed runs without `SHELL_URL` — an operations detail of the rig, not a
piece defect.

| Phrase | verdict | what was seen |
| --- | --- | --- |
| poll | **FAIL — interactivity** | Renders well, but typing a name into the name field instantly cast a vote for Pizza with no Vote click: tally 1, "You already voted". A choice the user never made. `round4-demo-poll-autovote-defect.png`. **Must-pass phrase; the round's headline product gap.** |
| rsvp | **PASS, clean** | Name + radio + dietary submitted; tallies updated live (1/1/0); entry listed with dietary note and a Remove control. `round4-demo-rsvp-pass.png`. The other must-pass phrase. |
| emails | expected-partial, **honest stop** | Gmail-labelled inbox frame with an explicit "Unable to load your inbox. Check the Gmail connection" alert. Needs a connected Gmail source in the space. No fabricated placeholder data — the right failure shape. |
| research | **PASS, above prediction** | Parent delegated to a `web_search` subagent (visible in the report trace as a second delegation with profile `web_search`); piece carries three real products with real source URLs — FELCO 2, Barebones hori hori, Gardener's Supply grow lights — a working budget filter (Under-$50 narrows to one card), a decision rule and an at-a-glance table. **The pre-registered "no web search" gap did not materialize.** |
| budget | **PARTIAL** | Six seeded transactions, category breakdown, CSV import; reactivity real (add-transaction moved count 6→7 and added a category chip instantly). Defect: the new row's amount holds no committed value, so "Remaining" renders `$NaN.undefined`, persisting after blur, while "Total spent" excludes the row. An undefined amount should coerce to 0. `round4-demo-budget-nan-defect.png`. Known gaps stand: no Plaid data (seeded sample instead), CSV import the only ingest. |

#### Why budget authored from source despite hits

The budget parent searched twice, saw six distinct hits, and **did attach two
`patternRefs`** — `DRCFljoU…`, an amount-ledger part that "keeps a list of
labeled amounts, sums them in integer cents, and shows the formatted running
total", and `M4P9ijx47oHL…`, the sortable-table part. Both are `kind: "part"`.
Both delivered description, import hint, argument shape and result shape into
the child in full (2 of 2 on each field).

**The child composed neither.** Six `run_pattern` calls, all from source, zero
importing.

Two things follow. First, this is the Block-2 phenomenon appearing inside
Block 4: material delivered, bullets present, and the child still authoring
from scratch — the same shape as `team-picker` in cell 7, and evidence that
the bullets raise the composition rate without guaranteeing it. Second, the
piece hand-rolled the money arithmetic that the attached amount-ledger part
exists to do, and the `$NaN.undefined` defect is in that rebuilt arithmetic.
The attached part is `quality: unproven`, so this is not a claim that
composing it would have been correct; it is the observation that the rebuild
happened and the rebuild is where the defect is.

The other four phrases attached no refs, consistent with their searches: poll,
rsvp and emails each saw one distinct hit across their parent searches, and
research saw none.

Block 4 is complete.

### Correction — cell 9, the poll phrase

Appended rather than edited into the table above, because this file is
append-only and the contaminated observation is part of the record.

**The poll verdict changes from FAIL to PASS clean.** The "auto-vote on
typing a name" behavior recorded above was **not a piece defect**. The
operator disclosed that he most likely clicked the Vote button himself as the
headed browser window popped up during the first test.

The clean retest: a fresh load shows an empty name field with every Vote
button disabled; typing a fresh name (`Alice`) only **enables** the buttons and
casts nothing; clicking Vote Tacos records exactly one vote, giving a total of
two and the label "tie: Pizza & Tacos"; the state persists across reload.

`round4-demo-poll-autovote-defect.png` **documents the contaminated
observation, not a piece behavior.** It should not be cited as evidence of a
defect.

Consequences for what this round concludes:

- **Both must-pass phrases pass.** poll and rsvp are clean.
- Round 4 has **no headline product gap**. The remaining Block-4 defect is
  budget's `$NaN.undefined` on an uncommitted amount, which stands as recorded
  and is a genuine defect in a piece whose `run_pattern` outcome was `ok`.
- The demo gap list is now: emails needs a connected Gmail source; budget has
  the uncommitted-amount defect and its known Plaid/CSV limits. research and
  the two must-pass phrases carry no gap.

#### Method note — browser verification on a shared headed browser

The incident is worth keeping as a method fact rather than only as a corrected
number. **Browser verification performed on a headed browser the operator is
also using is vulnerable to stray operator input**, and a stray click is
indistinguishable in the resulting screenshot from the behavior under test.
The failure mode is silent and produces a confident, wrong finding — this one
survived long enough to be written into a ledger as the round's headline
product gap.

What would have caught it, in order of cost: retesting a failure from a fresh
load before recording it (which is what corrected it here), and driving
verification through a browser instance no human shares.

This bears on every browser-verified verdict in Block 4, not only the poll.
The other four verdicts were not retested under that discipline, so they
carry the same exposure at unknown probability — though only poll showed a
behavior that a stray click could plausibly manufacture.

The ledger is closed.
