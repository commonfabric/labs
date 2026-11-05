# Terra vs. Sol, pre-registration

Written 2026-08-31 before any Phase 2 provider turn. This is a 2×2 comparison of
`gpt-5.6-terra` and `gpt-5.6-sol` under two console configurations. Each cell
runs the standing six-task suite for discovery/reuse and the four-task
composition suite for composition. A separate console and an admissibility read
occur before every batch.

## Fixed conditions and provenance

- Console source: `origin/main` at `5f406cd608e735ab39bec53b61559b287c26e3f6`
  (CT-2138 merge).
- Fabric: the brief's `http://127.0.0.1:8060` was checked before setup and had
  no listener. It is not substituted for or treated as a measurement server.
- Toolshed: this experiment deliberately starts an isolated current-main
  toolshed on `http://127.0.0.1:8061`. Its fresh store is the CT-2146 fork: it
  uses the same requested space name but initializes on demand, so it is a
  deliberate corpus fork rather than a continuation of any old server. Its
  `/api/meta` reports `gitSha` `5f406cd608e735ab39bec53b61559b287c26e3f6`,
  supplied through `TOOLSHED_GIT_SHA` for this raw source run. That is
  operator-supplied source-run metadata, not a build-time define; the value is
  nevertheless checked with `--expect-git-sha` on every batch.
- The V2 prompt is `parent-composition-prompt.txt`, copied byte-for-byte from
  `/Users/ben/.bb/worktrees/env_7qpzey268d/labs/runtime/cf-harness/.cf-harness-console/measurements/2026-08-28-thread-i-incentive/parent-composition-prompt.txt`.
  SHA-256: `8397301c2d057d1c325164f30435fe382fec38781da6519673fe2ade3fadb219`.
  It is 13 lines; this artifact is now committed with this measurement.
- Publication regime: this is the first measurement after recorded-only
  publishing became the default (#6598). Searches are therefore expected **not**
  to see output from earlier cells; per-cell before/after corpus snapshots are
  still recorded rather than assumed equal.

## Variants

| Variant | Parent prompt          | Child composition guidance | Flags                                                                                |
| ------- | ---------------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| V0      | absent                 | default                    | none                                                                                 |
| V2      | copied historic prompt | withheld                   | `--system-prompt-file=parent-composition-prompt.txt --no-child-composition-guidance` |

The models are `gpt-5.6-terra` and `gpt-5.6-sol`, supplied explicitly with
`--model`. Every cell records console commit, fabric meta/git SHA, model, flags,
and index corpus readings before and after both batches.

## Predictions and falsifiers

| Cell     | Prediction                                                                           | Falsifier                                                             |
| -------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| terra/V0 | Mostly source authoring, low spontaneous composition; by-id reuse may occur.         | ≥2 distinct tasks import distinct atoms, or a task is answered whole. |
| terra/V2 | Parent guidance raises parent searches and reaches the composition bar.              | Fewer than 2 distinct composing tasks/atoms.                          |
| sol/V0   | Sol may change authoring/error mix, but V0 remains below the composition bar.        | ≥2 distinct composing tasks/atoms.                                    |
| sol/V2   | Sol with V2 has at least as much composition as terra/V2, with fewer compile errors. | It misses the bar, or has more compile errors than terra/V2.          |

The traps are fixed before results: `run_pattern` **by id is reuse, not
composition**. The composition bar is **at least two distinct tasks importing
distinct atoms**, and applies **only to composition-suite cells**; repeated
calls by one task do not clear it.

## Per-cell ledger

No cell has run. Before every batch this table receives the live admissibility
read and full provenance; after it, extractor counts (searches/hits,
`run_pattern` by id/source/composing, outcomes, distinct composing tasks) and
anomalies. A provider error stops the experiment; it is never retried.

| Cell     | Suite            | Admissibility / corpus before | Corpus after | Extractor counts / anomalies |
| -------- | ---------------- | ----------------------------- | ------------ | ---------------------------- |
| terra/V0 | standing six     | not yet read                  | not yet read | not run                      |
| terra/V0 | composition four | not yet read                  | not yet read | not run                      |
| terra/V2 | standing six     | not yet read                  | not yet read | not run                      |
| terra/V2 | composition four | not yet read                  | not yet read | not run                      |
| sol/V0   | standing six     | not yet read                  | not yet read | not run                      |
| sol/V0   | composition four | not yet read                  | not yet read | not run                      |
| sol/V2   | standing six     | not yet read                  | not yet read | not run                      |
| sol/V2   | composition four | not yet read                  | not yet read | not run                      |

### Terra/V0 reuse result

The completed standing-suite reuse cell used `--base=origin/main`: the local
`main` ref was `bc1ac33434cb4b61ab6c428200353821c35b5cea` and did not contain
the fabric SHA, while `origin/main` was
`5f406cd608e735ab39bec53b61559b287c26e3f6` and did. Its ancestry reading was
therefore `ancestor`. Counts: 7 searches, 7 hits; 8 `run_pattern` calls (5 by
id, 3 source, 0 composing); 6 `ok`. This **falsifies** the pre-registered
Terra/V0 standing-suite prediction: it rebuilt whole-answered tasks from source
and fell below the historical 6/6 by-id baseline. It remains a valid recorded
reuse-cell outcome.

The first composition invocation used the default `--base=main` and refused
before a task or provider turn for that stale-ref reason. It is not a cell
result and is rerun with `--base=origin/main`; no `--allow-diverged` is used.

### Terra/V0 composition rerun: substrate-invalid

Do not count this cell. The reuse cell was healthy at 17:40; by 18:33–18:36 the
substrate was dead, and Docker was up again by 18:51. Its artifacts show every
`bash`/`read_file` failing with `Cannot connect to the Docker daemon` and every
`run_pattern` failing with
`fabric session unavailable: Broken pipe (os
error 32)`. The report's 35 errors
honestly describes the outage, not model behavior. This directory remains
preserved; the next attempt uses a fresh suffix.

### Machine preflight before every remaining provider batch

Immediately before each batch, record: (a) `docker info` exit status; (b)
toolshed `/api/meta` response and expected SHA; and (c) a cheap no-provider
fabric round trip if the harness exposes one, otherwise the console's own
health/status immediately before launch. A nonzero or unread reading stops the
batch. The cell preamble records all three readings. The console is restarted
before the rerun if its next session reports the dead fabric session.

Rerun preamble: Docker `info` exited 0; toolshed `/api/meta` answered with
`5f406cd608e735ab39bec53b61559b287c26e3f6`; console `/api/status` answered with
an absolute artifact root and idle sessions. The harness has no cheap
no-provider fabric round trip, so console health is the third reading.

### Terra/V0 composition rerun-2: substrate-invalid

Do not count this cell. It completed at 19:08 with 33 `run_pattern` errors,
every one `fabric session unavailable: Broken pipe (os error 32)`. The machine
preflight passed, but it was insufficient: the console process had survived the
18:30 Docker outage and every new console session inherited its dead fabric
session. `party-prep` authored source importing both seeded atoms
(`composing=2`) under V0; that is observed under invalid substrate, not an
experimental result. The console is restarted before rerun-3, which gets its own
directory and a fresh admissibility read.

The console restarted at 19:43 AEST after PID 9393 was stopped. Source
inspection found no no-provider route that reaches the cached fabric session:
`/api/status` and `/api/sessions` are metadata, and `/api/index/call` exercises
only the index signer. A single explicit, non-cell provider probe is therefore
priced and recorded before rerun-3; it must successfully reach `run_pattern`
before the measurement batch is allowed to start.

The sacrificial probe completed at 19:44 AEST: `run_pattern` returned `ok` for
run `bbeaf65a`. This is a substrate reading, not a grid result.

### Terra/V0 composition rerun-3: valid

Valid control result: all 4 tasks measured; 16 `run_pattern` calls, 0 by id, 16
source, 0 composing; outcomes 11 compile-error and 5 ok. It replicates the
2026-08-29 V0 control on current main.

### Terra/V2 reuse: valid; flag check passed

All six parent transcripts contain
`You are working in a Common Fabric harness
console.` Every child lacks
`A search hit is a component to wire, not a
specification to rebuild.` and
retains the normal progressive-search guidance. Corpus was 29 discoverable
entries before and after. Counts: 18 searches, all hits; 17 `run_pattern` calls
(3 by id, 14 source, 12 composing); outcomes 8 ok, 3 compile-error, 6 error.
Four distinct tasks composed four distinct pre-existing entries. V2 therefore
changed the whole-answer reuse suite from running wholes by id toward wrapping
them as imported components; this is not the composition-suite bar.
`friends-birthdays` imported the static-mockup birthday app six times, a picture
wrapped as a component; this belongs beside the render-gate limitation rather
than as evidence of working composition.

### Terra/V2 composition: valid; flag check passed

All four parent transcripts contain the parent prompt marker; every child lacks
the withheld composition bullet and retains progressive-search guidance. Corpus
was 29 before and after. Counts: 16 searches, all hits; 18 `run_pattern` calls
(1 by id, 17 source, 17 composing); outcomes 7 ok, 9 compile-error, 2 error. All
four tasks composed: `party-prep` both seeded atoms, `team-picker` seeded
dice-roller, `workout-streak` seeded check-list, and `dice-tally` a pre-existing
entry. This is the symmetric comparison unavailable on 2026-08-29: the same four
tasks as today's valid Terra/V0 control went from zero composing tasks to four.
The task-set confound is removed; on Terra this confirms H1's placement
prediction.

### Sol/V0 reuse: valid

Corpus was 29 before and after; all 6 tasks measured. Counts: 15 searches, all
hits; 16 `run_pattern` calls (6 by id, 10 source, 0 composing); outcomes 8 ok, 5
compile-error, 3 error. Under unchanged V0, Sol authored more source than Terra
(10 versus 3) while its by-id reuse was similar (6 versus 5). Model strength
therefore does not substitute for parent guidance by simply producing more whole
reuse.

### Sol/V0 composition: valid

Corpus was 29 before and after; all 4 tasks measured. Counts: 12 searches, all
hits; 21 `run_pattern` calls (0 by id, 21 source, 0 composing); outcomes 5 ok,
15 compile-error, 1 error. This is the V0 control replication across model
tiers: Terra/V0 and Sol/V0 both compose zero tasks, while Sol burns more compile
errors (15 versus 11). Model quality does not substitute for the parent prompt;
H1 holds across these tiers.

### Sol/V2 reuse: valid; flag check passed

All six parent transcripts contain the parent prompt marker; every child lacks
the withheld composition bullet and retains progressive-search guidance. Corpus
was 29 before and after; all 6 tasks measured. Counts: 24 searches, all hits; 7
`run_pattern` calls (1 by id, 6 source, 6 composing); outcomes 6 ok and 1
compile-error. The composition calls map to `counter`, `reading-list`,
`project-notes`, and `trip-timeline` once each and `monthly-expenses` twice;
`friends-birthdays` did not compose. As with Terra/V2, the condition wraps whole
applications (including `trip-timeline` importing `2h0TVvTM…`), but Sol does it
at roughly one clean call per task instead of Terra's 17 calls and nine
failures. The tier changes composition cost, not whether V2 induces it.

### Sol/V2 composition: valid; flag check passed

All V2 parent markers were present; every child lacked the composition bullet
and retained search guidance. Corpus was 29 before and after; all 4 tasks
measured. Counts: 37 searches (33 hits, 4 empty); 32 source `run_pattern` calls,
17 composing across all four tasks; 9 ok, 22 compile-error, 1 error. The
composition bar is met, but the pre-registered Sol/V2 prediction is
**falsified** on errors: 22 compile errors exceeds Terra/V2's 9. The cost story
is task-dependent rather than tier-ordered.

## Amendment before the first provider turn: standing-suite purpose

The first admissibility read found whole answers for all six standing tasks.
That disqualifies them from composition measurement, but not from the other half
of this A/B: discovery and whole-reuse under the corpus's permanent whole-answer
condition. The cells are reinstated before any provider turn with this purpose:
searches per task, by-id rate, first-try success, source rebuilds despite a
whole answer, and compile-error burn. The known terra baseline is the 2026-08-29
V0 control: six of six by id, zero source, zero compile errors.

For standing-suite cells, Terra/V0 predicts that baseline shape; Sol cells
predict either the same shape or fewer searches/errors. A standing-suite cell is
falsified by source rebuilding of a whole-answered task, a lower by-id rate, or
greater search/error burn than the terra baseline. It is never scored against
the composition bar.

## Admissibility read, before the first provider turn

Read through the current-main console's read-only index proxy against the
deployed index. Every standing task has a single whole application in its
top-five result set. That is recorded as the condition of its reuse cells, not
as a composition claim.

| Whole-answered reuse-cell id | Answering pattern                             |
| ---------------------------- | --------------------------------------------- |
| `counter`                    | `U5g1VlAb1uFmmec7D-fzPXZy0erldi7inqmXN8j7Vi0` |
| `reading-list`               | `FimzoBmTy8QTJQOjaKpsHPjmyMCUJFAGCXoO2vKJMDc` |
| `friends-birthdays`          | `2QGxpAuh-TxmV1Em462NcFiWDa9AnBjrJpBZbSnmZS0` |
| `project-notes`              | `GWkpTfEhKE5hScyU_ddiKVPmUlZw7xm5pbFyl6-yCDA` |
| `trip-timeline`              | `2h0TVvTMdhGlcFhGubyLvQ1IZhSF5FS5QkgM10aQQTc` |
| `monthly-expenses`           | `DWl3kXPQc1qRvGZaG_rkLEkpOuea6oh2k_CIm62Rf6c` |

The composition suite remains admissible in this read: `dice-tally`,
`party-prep`, `team-picker`, and `workout-streak` each have separate relevant
parts or only partial applications; no result answers the whole task. This does
not authorize a later batch without repeating the same read immediately before
it.
