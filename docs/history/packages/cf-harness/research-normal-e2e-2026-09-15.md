---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Normal task verification of automatic opening research, indexed composition, compiler recovery, and browser persistence."
---

# Automatic research: normal composition and browser verification

A bare dinner-page request produced a working composition of the indexed
CheckList and AmountLedger components. Automatic opening research returned a
complete kit on its first invocation. The kit contained an invalid import; the
parent corrected that single line after the compiler rejected it, then executed
the composition and assigned its slug. Browser editing, cost arithmetic, and
reload persistence passed. A checkbox accessibility mismatch remained.

The preceding attempt failed before compilation because its Fabric session
returned `Broken pipe`. Both attempts are retained. This checkpoint establishes
useful indexed composition on synthetic data, not successful email grants, inbox
correctness, or a controlled speed improvement.

## Task and source snapshot

The exact task contained no research or index instruction:

> Make me a dinner-party preparation page with a checklist of what I need to
> prepare and a running total of ingredient costs.

The source was `af916cf0cc79377deeeb4e2707bd66794308acd8` plus the frozen
`research-startup-final.patch`, SHA-256
`ccc1f4fe8e9286c7e15d7fc4eb89cf1e9736861a3450f6d39811d1242dba3925`. No source
changed between the attempts. The owned console ran on port 8187 with parent
`gpt-5.6-sol` and private research `gpt-5.6-luna`, against the isolated Fabric
on port 8286 and space `research-demo-2026-09-14`. Model transfer was
authorized. Publication was disabled, and the discoverable index retained 41
entries. No existing connector store was changed.

The first console's Fabric initialization failed on every execution attempt.
After that run ended, the console was restarted with stdout and stderr directed
to a durable log file. A fresh CLI Fabric session succeeded, and the repeated
task executed. The restart resolved the failure; the observation does not
establish the precise origin of the broken pipe.

## Execution and cost

Run times below use the root report's creation and completion times, excluding
later human-driven browser verification. The recorded run timestamps are on
September 14 UTC; this report uses September 15 in the operator's local time.

| Measurement                         | First family                           | Successful repeat                      |
| ----------------------------------- | -------------------------------------- | -------------------------------------- |
| Root run                            | `5d31ebcc-f1af-401f-ba04-df9cc30f2a90` | `876a814f-bee6-4b40-9495-353f8cc025d7` |
| Wall time                           | 176.821 seconds                        | 106.219 seconds                        |
| Model attempts                      | 16                                     | 9                                      |
| Total tokens                        | 179,993                                | 89,008                                 |
| Opening research tokens             | 74,943                                 | 55,520                                 |
| Direct parent tokens                | 33,374                                 | 33,488                                 |
| Delegated child tokens              | 71,676                                 | 0                                      |
| Cached input tokens                 | 102,272                                | 53,248                                 |
| Opening research time               | 63.158 seconds                         | 63.789 seconds                         |
| Private research turns / tool calls | 8 / 15                                 | 5 / 18                                 |
| Exact source reads / characters     | 11 / 38,142                            | 10 / 30,610                            |
| `run_pattern` attempts              | 5, all session errors                  | 2: compile error, then success         |
| Result                              | No execution                           | Rendered and persisted composition     |

The combined cost was 269,001 tokens across 25 model attempts. These are not
comparable speed measurements against the earlier explicitly research-only
probes: the task instructions, execution path, and environment differ.

In the successful repeat, research completed at `2026-09-14T21:08:21.161Z`; the
first parent attempt started at `21:08:21.173Z`. All five private attempts had
`modelTurn: 0`. The parent received the admitted kit directly before the task
and used it without another research call or delegation.

## Actual component reuse and recipe defect

Both kits selected these exact entries after verifying their published source
identities:

| Component    | Pattern ID                                    | Published entry                 | Recorded quality |
| ------------ | --------------------------------------------- | ------------------------------- | ---------------- |
| CheckList    | `dZt8I5yIWD2g6NeftbKv-3ZouzZ2LGCSEhT8ij7wGV0` | `/primitives/check-list.tsx`    | Proven           |
| AmountLedger | `DRCFljoU1NSWQ8pt8dvVa-mG5cld1tj5J46iq7L7-VE` | `/primitives/amount-ledger.tsx` | Unproven         |

The successful source imported both through `cf:pattern:` and invoked both as
JSX components with writable cells. Their exact read IDs were
`pattern-source:871c36db41fdbe94` and `pattern-source:b977a6491e25d31d`.
Research also confirmed trip-budget
`RaBFRX7tuzcMcWwQ4UguqwFK5tJwxYWJECEWXU_11l8`, but did not select it. That
inspected lead is not counted as executed reuse.

The admitted kit's first line was
`import { new Writable, pattern } from "commonfabric";`. The parent's first
submission preserved it. Relative to the kit, that submission only added a
`$NAME` and two margin styles. The compiler rejected the import. The second
submission changed exactly that line to
`import { Writable, pattern } from "commonfabric";` and succeeded. This is a
research recipe defect recovered by the normal compiler loop, with no manual
source correction. Evidence admission did not guarantee compilable syntax.

The resulting piece was `fid1:dlPt3pT5s-zXvUCbJmKZkpZdqYXlO7oW7uC6lw-FjPg`,
assigned slug `dinner-party-preparation` in the owned space.

## Browser behavior and persistence

The page was opened at
`http://localhost:8286/research-demo-2026-09-14/dinner-party-preparation` in a
1440-by-1000 browser using the same identity as the demo CLI. All changes below
used rendered controls. Browser errors remained empty.

| Check                               | Observed result                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| Complete the first preparation item | One done, five left                                                                |
| Rename that item                    | `Confirm guests and dietary needs`                                                 |
| Add a preparation item              | `Lay out serving spoons`; one done, six left                                       |
| Initial five ingredient entries     | Total `$86.00`                                                                     |
| Add Extra bread, `$4.50`            | Total `$90.50`                                                                     |
| Add Fresh herbs, `$2.75`            | Total `$93.25`                                                                     |
| Reload the page                     | Edited label, added task, checked native input, both costs, and `$93.25` persisted |

After reload, the first native checkbox's `checked` property remained `true` and
its rendered checkmark agreed with the completed count. Its enclosing
`cf-checkbox` instead exposed `aria-checked="false"`, so the accessibility
snapshot reported unchecked. This is an observed accessibility mismatch, not
lost completion data. It remains a separate quality finding.

## Handoff, provenance, and accounting

Opening research preceded the first parent turn in both attempts. Its activity
and policy records identified `origin: "opening-research"`; the host supplied a
user-context handoff rather than fabricating an assistant/tool pair.

The first attempt delegated once to `pattern-author`. The child inherited the
exact research kit and all three confirmed records, had no opening checkpoint,
and performed no research call. Its three execution attempts failed with the
same session error as the parent's two. None reached compilation, so those
errors establish neither validity nor invalidity of their source.

Each opening handoff retained its exact call/tool/output provenance. Its
omission record pointed to `/researchRecord` in the raw artifact. Neither root
transcript nor the child transcript contained the private record. Authored
source artifacts carried the corresponding research-run ID. These are local
derivation records; no deployed index association API was exercised.

The batch task matcher expected the task to be the first user message and missed
roots preceded by host context, producing unusable zero-run totals. Explicit
run-ID measurement recovered the tool outcomes: five session errors, one compile
error, one successful execution, one delegation, and one slug. Its
transcript-only source counts still miss some collapsed submissions, and its
outer search count does not describe the private research loop. The component
and research counts in this report come from complete source sidecars, run-state
records, and model/tool activity. The original batch reports remain unchanged as
evidence of the measurement gap.

## Gates and artifacts

The frozen implementation passed 1,033 cf-harness tests / 2,840 steps, the
422-path / 46-group typecheck, repository format and lint, documentation and
static gates, and 77 of 77 assertion mutations. These gates do not replace the
compiler and browser findings above.

Artifacts were retained under
`/Users/ben/.bb/thread-storage/thr_udpzyv6iqn/ct-2319/`:

- `research-normal-suite.json`, `research-normal-cell-spec.json`, and
  `research-startup-final.patch`: exact task, configuration, and source.
- `research-normal-live-2026-09-15/` and
  `research-normal-live-2026-09-15-console-repair/`: original batch reports and
  before/after index inventories.
- `research-normal-explicit-run-measurements.json`: explicit family selection
  through the repository's read-only measurement command.
- `research-demo-console/runs/<root-run>/`: complete root reports, transcripts,
  state, research artifacts, omissions, and submitted-source sidecars. The first
  family's child is in `<root-run>.subagent.1/`.
- `research-normal-browser-verification.json`,
  `research-normal-before-reload.txt`, and `research-normal-after-reload.txt`:
  browser actions and observed state.
- `research-normal-after-reload.png` and
  `research-normal-costs-after-reload.png`: reviewed screenshots of persisted
  checklist state and ingredient totals.

The next capability checkpoint is a bare inbox request with working email grants
and tested indexed email components. Recipe syntax reliability, the measurement
matcher, and checkbox accessibility are concrete follow-ups; this run does not
justify another general prompt expansion or a claimed performance improvement.
