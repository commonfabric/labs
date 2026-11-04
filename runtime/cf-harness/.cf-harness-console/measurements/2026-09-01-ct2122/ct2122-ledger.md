# CT-2122 item-4 analysis ledger — 2026-09-01

Kept by the analysis thread, continuing the practice of
`../2026-09-02-round4/round4-ledger.md`: append-only, one section per cell,
absences recorded as absences, and a count that cannot be derived written "not
read" rather than `0`.

Held in its own file rather than appended to the round-4 ledger. That ledger is
committed and under review in PR #6686, and this is a different measurement with
different conditions; appending would churn a reviewed file with unrelated
content. Say the word and it moves.

## Cell — CT-2122 re-measure, composition suite

Report: `remeasure-composition/report.json`, artifact root
`.cf-harness-console-ct2122/runs`, console `:8130`, space `ct2122-probe`,
toolshed `:8063`. Ran 08:25:55Z to 08:54:44Z. Four tasks, four `turn_completed`.

Comparator is round-4 cell 3 (`p-cand-composition`): same suite, same model,
same parent prompt, same child bullets.

### Verification

The cell-spec pre-flight (#6685) enforced the prompt mechanically:
`systemPromptSha256: a2dd4986575b751280ca8f773bcc3d06ae14941f8dec7a0d43010af30103c44c`,
which is the candidate prompt byte-for-byte. It also pinned `requiredToolIds`,
`forbiddenToolIds: ["acquire_skill"]`,
`requiredSubagentProfiles: ["pattern-author"]` and the fabric space. **Every
batch run today carried a cell-spec.** This supersedes the marker check this
thread derived by hand for round 4; the marker check was re-run anyway and
agrees — candidate marker present in all four parents, historic absent, child
bullets present in all four children.

Corpus 29/135 → 29/141; discoverable held at 29. Fabric
`gitSha 180d006f872ea9ad8b727eeda6cbb9824beb361b`, ancestor of `origin/main`.

### The three deliberate differences

1. New main, carrying #6683 (honest turn timing) and #6684 (diagnostic
   collapse).
2. `runsc-cfc` transport registered — the first mediating configuration in this
   programme.
3. `docs/common` copied into the console workspace, so a child's `read_file` on
   `/workspace/docs/common/*` succeeds.

Everything else held.

### Counts

| Task           | searches | run_pattern | source | composing | outcomes              |       read_file |     bash |
| -------------- | -------: | ----------: | -----: | --------: | --------------------- | --------------: | -------: |
| dice-tally     |        6 |           4 |      4 |     **0** | 2 ok, 2 ce            |     5 ok, 2 err |     1 ok |
| party-prep     |        5 |           2 |      2 |         2 | 1 ok, 1 ce            |               — |        — |
| team-picker    |        5 |           4 |      4 |     **0** | 1 ok, 3 ce            |     4 ok, 1 err |     1 ok |
| workout-streak |        5 |           6 |      6 |         6 | 2 ok, 3 ce, 1 err     |               — |     3 ok |
| **cell**       |   **21** |      **16** | **16** |     **8** | **6 ok, 9 ce, 1 err** | **9 ok, 3 err** | **5 ok** |

Zero by-id runs, no re-exports, no bare imports. All four delegations carried
`patternRefs` — 7 entries, no refusals — and the shapes crossed on 6 of 7; the
seventh is the `DRCFljoU` rank case again, reaching its child with both shapes
`Not available.` and being composed anyway.

### (1) Per-task composing — 2 of 4, and the docs alignment

**dice-tally and team-picker composed nothing**, each having been handed two
refs with full shapes. party-prep composed both its refs; workout-streak
composed its one ref six times.

So against round-4 cell 3: **tasks composing 4 of 4 → 2 of 4**, and at attempt
level **26 of 27 (96%) → 8 of 16 (50%)**. That is a real drop, not an artifact
of fewer attempts.

The alignment the operator suspected is exact in this cell:

| Task           | docs read | chars of docs | composing |
| -------------- | --------: | ------------: | --------: |
| dice-tally     |         5 |        57,787 |         0 |
| team-picker    |         4 |        54,335 |         0 |
| party-prep     |         0 |             0 |         2 |
| workout-streak |         0 |             0 |         6 |

Every child that read docs composed nothing; every child that read none composed
everything it was given. The documents read are authoring guides —
`ai/pattern-development-guide.md`, `concepts/reactivity.md`,
`patterns/new-cells.md`, `components/COMPONENTS.md`, `patterns/style.md` — that
is, material teaching a child how to build, not how to compose.

**This is suggestive and not established, and the distinction matters.** With
four tasks split two-and-two, a perfect alignment arises by chance about one
time in six under a null. The mechanism is plausible and the direction is what
the operator predicted, but n=4 with p≈0.17 is a hypothesis worth a designed
cell — docs on and off with composition held — not a finding to carry. Recorded
as: **consistent with docs competing with composition, unestablished by this
cell.**

What the cell does establish is narrower and still useful: the refs material was
present and complete in all four delegations, so whatever made two children
build from scratch acted on the child's disposition, not on what it was given.
That is the same shape as the round-4 Block-2 result.

### (2) Compile-error accounting — which readings carry weight

| Reading                              | round-4 cell 3 |  this cell | direction  |
| ------------------------------------ | -------------: | ---------: | ---------- |
| compile errors per suite             |             21 |          9 | −57%       |
| compile errors per attempt           |    21/27 = 78% | 9/16 = 56% | −22 points |
| compile errors per composing task    |           5.25 |       4.50 | −14%       |
| compile errors on composing attempts |   ≈21/26 = 81% |  4/8 = 50% | −31 points |
| `ok` per attempt                     |     6/27 = 22% | 6/16 = 38% | +16 points |

**Supports "the condition cut the error rate":** the per-attempt reading, and
the within-composing-attempts reading, which is the closest thing here to a
like-for-like comparison since it holds the kind of work fixed.

**Does not support it:** the per-suite count. It falls mostly because the cell
made 16 attempts instead of 27, and it made fewer attempts largely because it
composed less. Composition is where round 4's compile errors concentrated, so a
cell that composes less has fewer compile errors whatever the docs did. Citing
21 → 9 as an error-rate improvement would be reading a composition effect as a
quality effect.

**Near-flat:** per composing task, where the denominator also changed meaning
(four composing tasks against two).

n=1 cell; the within-composing reading rests on 8 attempts. No claim beyond
"consistent with, at this size".

### (3) The CT-2158 falsifier — **not met**

The falsifier was: post-failure turns return toward the floor, with the `ok`
rate holding. The `ok` rate held and improved, 22% → 38%. The turns did not
return to the floor.

On the round-4 measure, so the two cells are compared like for like:

|                |   clean turn | post-failure turn |     ratio |
| -------------- | -----------: | ----------------: | --------: |
| round-4 cell 3 | 11.6s (n=32) |      73.1s (n=23) | **6.28×** |
| this cell      | 18.0s (n=26) |      57.9s (n=17) | **3.22×** |

On the honest instrument #6683 added, available only here:

| prior failures                    |     0 |     1 |     2 |     3 |     4 |
| --------------------------------- | ----: | ----: | ----: | ----: | ----: |
| mean `responseCompleteDurationMs` | 35.6s | 53.1s | 64.3s | 55.2s | 39.8s |
| n                                 |    13 |     9 |     4 |     4 |     2 |

Clean 35.6s against post-failure 54.5s — **1.53×**.

So cost still rises with accumulated failures, and CT-2158 stands. The climb is
smaller than round 4 reported, and part of that difference is a defect in how
round 4 measured it.

**Methodological correction, which the new field exposes.** The round-4 curve
paired each _tool call_ with a gap, because `durationMs` timed only the response
start. A model turn that emits several tool calls at once yields several gaps,
all but the first near zero. Clean early turns emit parallel searches;
post-failure turns emit a single `run_pattern`. So the clean-turn mean was
deflated by intra-turn calls and the 4× jump round 4 reported overstates the
effect. `responseCompleteDurationMs` has no such problem, and on it the same
cell reads 1.53×. Round 4 cannot be recomputed this way — its reports predate
the field.

**Confounds, named rather than resolved:**

- #6683 and #6684 landed together, so the instrument change and the treatment
  cannot be separated within this cell.
- The docs condition changed too. Its direction can be bounded, though: doc
  reading children carried roughly 55,000 extra characters of context, and their
  clean turns cost 35.0s against 36.4s for children that read none —
  indistinguishable at this n. So the docs condition did not measurably inflate
  turn cost here, which limits how much of the improvement it can explain.
- Per-bucket n is tiny — two to nine samples above the clean bucket — and
  per-task variance is large (party-prep clean 56.2s on n=2; team-picker
  post-failure 90.6s on n=4).

### (4) The read_file releases — corroborated at suite scale, with one caveat

**9 released, 3 refused.** All three refusals are `file_not_found` for paths
absent from the workspace copy (`patterns/dev/catalog/stories/…` twice,
`docs/common/concepts/lift.md` once) — not policy denials. **Not one release in
this cell was denied for observability**, against every prior cell in this
programme where every `read_file` failed that way.

`bash` likewise: 5 calls, all `exitCode 0`, none denied. First cell in the
programme where it runs.

**Every one of the 9 released reads carries a `cfcResult`. Zero released without
one.** That corroborates probe-4 at suite scale.

One distinction to carry to CT-2122 rather than blur. The two tools' envelopes
differ:

- `bash` releases carry `policy: "opaque"` with a populated label — a
  `label.confidentiality` entry of type `…/PromptSlotInfluence`, carrying
  `kernelName: "cf-harness"`, `role: "direct-command"` and
  `surface: "console-web"`.
- `read_file` releases carry `policy: "observed"` with **`label: {}`** — an
  empty label — and the content in `segments`.

So "released with CFC labels attached" is true of the envelope in both cases,
and the label itself is populated for `bash` and empty for `read_file`. An empty
label may well be correct for a workspace document that nothing confidential
influenced; this thread cannot settle that and does not assert it. It is
recorded because "labels attached" is the property under test and the two tools
answer it differently.

Incidental: `COMPONENTS.md` was released at 21,942 characters to one child and
29,904 to another, so the two reads of that path were not identical.

### Provenance

Model `gpt-5.6-sol`; skills root scanned, 26 skills, no run without a registry;
CFC `enforce-explicit` with the same dials as round 4. Console commit still not
recorded in any artifact — the gap named in the round-4 record is unchanged.

### Context, not conclusions

`probe-run`, `probe2-run`, `probe3-run` and `probe4-run` sit under this
directory, n=1 each, and are summarized on CT-2122. They are referenced here as
the context in which this cell was configured; nothing in this section is
derived from them.
