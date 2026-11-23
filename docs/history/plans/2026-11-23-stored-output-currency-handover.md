---
status: historical
created: 2026-11-23
archived: 2026-11-23
reason: "Handover of the currency index work as of labs #10143: what was built and why, what was tried and set aside, what the benchmarks showed, where roots are still refused, and the open work in the order it was understood then."
---

# The currency index: handover, November 2026

This is a record of where the work on the currency index stood on
2026-11-23, written for whoever continues it. It says what the index is for,
what was built in the last stretch and why, what was tried and dropped, what
was measured, and what is open. It is a record of that day: the live
description of the index is
[the plan](../../plans/stored-output-currency.md), its continuation
[across spaces](../../plans/stored-output-currency-across-spaces.md), and
[`serving-loop.md`](../../specs/server-side-execution/serving-loop.md) §1,
§3b and §3e. Where this record and those disagree, they are right.

## What the index is for

A serving loop starts a piece when a session's demand reaches one of its
documents, and a start runs every demanded computation of the piece again
("What a start does", below). The store already holds what those
computations wrote. The currency index is a durable record, in the space's
store, of which stored outputs are current, so the loop can leave a piece
unstarted while everything a session demands of it is proved current.

The rule that governs every decision in it: a start that was not needed is
acceptable, and a stored value served as current when it is not is the
failure to design out. Every case the record cannot decide starts the piece.

It runs in three modes, set by `SERVER_EXECUTION_CURRENCY_INDEX` on a
toolshed:

- `off`: no index.
- `record`: records and judges, starts everything, and counts what it would
  have served (`currency.servable`) and what it would have got wrong
  (`currency.falseClean`).
- `skip` (a toolshed's default): acts on the judgment.

## What a start does

A start is not incremental. Nothing a runtime resumes from is kept between
runtimes: the persisted scheduler state that once let one resume was
retired ([its specification](../specs/persistent-scheduler-state.md) is
archived), and the basis rows a wave writes (`scheduler_basis`) are read at
activation only for a count. So a fresh serving runtime that starts a
piece:

- loads and evaluates the piece's program, and instantiates its graph,
  nested pieces included;
- pre-syncs the piece's inputs;
- runs every computation of the piece that a demand reaches, once. A
  computation that reads something narrower than the space runs once for
  each viewer who demands the piece at that moment, and for no viewer who is
  absent. A computation nothing demands does not run.

What the run saves is on the write side. A computation that derives the
value the store already holds writes nothing, so no revision is made, no
client is sent anything, and nothing downstream is woken by it. The compute,
the reads and the program load are paid all the same.

Once a piece runs, it is incremental: a change reruns only the computations
that read it, and for a per-viewer computation only the instances of the
viewers whose input changed.

Two things avoid a start altogether. A runtime kept across an idle park
(up to ten minutes by default) is taken as it stands by the next tenure,
with no restart of anything. And the currency index leaves a piece
unstarted while its record proves what is demanded current.

The index is all-or-nothing for a piece. If one demanded instance is not
vouched for, or one slice in the demander's chain is marked, the whole piece
starts and runs every demanded computation, not only the stale one.

## Vocabulary

- **Slice**: what a piece's computations did at one scope key: `space` for
  runs every viewer shares, a user's key or a session's key for runs made
  for that viewer. A record of a piece is a set of slices.
- **Mark**: `0` clean; `1` an input is stale; `2` one of the slice's own
  rows is behind, or the slice was not vouched for, or it expired.
- **Vouch**: a slice answers for the instance, at its own key, of a document
  one of its clean computations wrote.
- **Decide**: a slice answers for an instance at another key that its run
  wrote, as the redirect a session's run leaves at the user's and the
  space's key. A decide row that names the instance as **superseded** is
  stored behind the instance's head and answers for nothing.
- **Demand row**: one document instance a session's query reaches, with the
  session that demands it.
- **Judgment**: the memory server's answer for a set of roots against the
  demand rows: `servable`, `held` (stale only through something upstream,
  which the loop then starts), or refused with a reason.
- **Refusal reasons**: `no-record` (the root leads to no recorded piece),
  `marked` (the root piece's `space` slice is not clean), `unvouched-instance`
  (a demanded instance nothing answers for, for this viewer),
  `owner-not-clean` (the slice that owns a demanded instance, or one above
  it in the viewer's chain, is marked), `absent-owned` (a cell the piece
  owns holds no value for the viewer), `other-epoch`.

## What was merged

| Change | What it did |
| --- | --- |
| labs #10041 | The index, the `record` and `skip` modes |
| labs #10056 | A record kept in slices, one for each viewer |
| labs #10071, #10093, #10106 | Reads of another space, a clock's expiry, demand carried across spaces, a computed document as a demanded root |
| labs #10115 | Starting what is stale upstream within a space; a slot filed under the slice of the run that wrote it (`currency_decide`); the cost of the new filing rule brought back to that of `main` |
| labs #10133 | Every derived write names the action whose run made it |
| labs #10143 | Source origins, shared instances, and pieces with a per-viewer root |

The last three are this stretch. What each decided, and why:

### A slot is filed under the slice of the run that wrote it (#10115)

A row for a shared slot filed under the slice at the slot's own key had the
`space` slice vouch for a document none of its reads decide. FabriChat showed
that as six false cleans. Filing the row under the writer's slice fixed it.

The first version of that rule made the FabriChat journey about 40% slower
(14.4 s against 10 s). Two changes brought it back: an import entry equal to
the stored row is skipped (`applyCurrencyImports()`), and the check for a
stale input stops at the first input that decides it (`hasStaleInput()`). A
set-based SQL rewrite of `staleInputsOf()` was tried first, gained nothing
over 145,000 calls, duplicated the rule in SQL, and was reverted.

### The action id on derived writes (#10133)

`DerivedWriteAnnotation.action` names the action whose run made a write, on
every write of a scheduler run and of the loop's direct commit. Nothing reads
it yet. It was added so that a stored write can be joined to the run that
made it, which the offline analysis below used. `protocol.md` §1 and §7
define it.

### Source origins (#10143, first commit)

A piece created from a pattern source was never vouched for, because a start
is where its origin is followed. Now the record says whether the piece
records an origin (`currency_origin`), the judgment names the origin pieces
a servable root rests on, and the loop follows each once per tenure through
the same path a start uses (`#originFollowed`, `#originMoved` in
`space-server.ts`). A root whose piece adopted new source is loaded at the
next pass.

### Which run wrote a shared instance (#10143, second commit)

Two viewers' runs can write the same shared instance. A snapshot named it
for both slices, so both rows stood at its head and the index could not say
whose write it held.

The store cannot decide this. A write that changes nothing leaves no
revision, so the store cannot tell "wrote the same value" from "has not run
since". A store-side table of the latest writer was built first and made the
two-viewer end-to-end tests run away: a viewer whose run wrote the slot the
same as another's was refused forever.

The scheduler decides it. For each node that runs once for each viewer
(`FanOutNodeState` in `fan-out.ts`) it keeps the latest change to each
instance of a document the node writes, and the run that made it, from the
changes the replica reports (`noteFanOutChanges()` in `invalidation.ts`). An
instance holds a run's write while that run made the latest change, or
nothing has changed it since the run handed its writes over
(`fanOutHoldsSlot()`). Details that matter:

- **The handover mark is sound because a seal validates reads.** A run that
  hands over a write equal to what the instance held leaves a read of it,
  and `#validateBranch` in `v2-transaction.ts` refuses a seal whose reads the
  replica no longer bears out. A refused run's instance is dirtied, and a
  slice that is not clean names no slot.
- **A change is attributed to the key its run was recorded under at the
  handover.** A run's change arrives after another run has opened in about
  5% of cases in `executor-fan-out.test.ts`, so the ratchet can move in
  between.
- **A superseded slot is recorded, not left out.** Its row is stored behind
  the slot's head. Such a row marks no slice and counts as current for
  nothing. What it does is refuse a root to a viewer of that slice's own
  chain who demands the slot, and it does so also where a broader slice of
  the same chain holds a row at the head: at the granularity of a document
  the index cannot tell whether the broader run's write covers what the
  narrower run would write. One start clears it. A review thread on #10143
  argues for passing the root in that case, and was left open. Leaving the
  row out instead lets the judgment take the slot for one the slice's runs
  never wrote, which the slice at the slot's own key can answer for. One
  FabriChat run of that variant left 50 roots unstarted against 0 to 27 in
  16 earlier runs. Whether those were wrong servings was not confirmed.
- **Granularity is the document instance, not the path.** Two computations
  that write different paths of one document supersede each other. Within
  one slice that does not matter, since a slot one computation of the slice
  holds is the slice's. Across a viewer's own chain it costs one start,
  after which both rows stand at the head.

### Pieces with a per-viewer root (#10143, third commit)

A pattern instantiated with `asScope("user")` or `asScope("session")` has a
result document narrower than the space. Every record of such a piece was
stored as not vouched for. The serving runtime already runs one program for
each pattern pointer the viewers' instances hold (`#startScopedPrograms` in
`runner.ts`), so the piece's slices are what a snapshot takes of any piece.
The change reports the root's scope in the snapshot, has the runner answer
for the piece over every viewer's instance (`pieceCurrencyFacts()`), and
keeps one exception: a piece one of whose instances records a source origin
is not vouched for (`scoped-origin`).

The false-clean check needed one case. A piece does not run for a viewer who
holds no instance of its result document, so the write that makes one, by
whoever instantiates the piece, counts as a changed input. Without it a
FabriChat run reported 50 false cleans, all this case.

Judging a per-viewer root itself, where a client watches it directly, was
tried and is not needed: such a root is loaded as before, and the load does
not start the enclosing piece.

## What was tried and set aside

- **Read rows for each run.** The idea was an index by run instead of by
  slice, built from the `scheduler_basis` rows and the write annotations. It
  cannot be done as first described: a run that writes nothing hands the
  store nothing, so only the scheduler's settled state knows its reads are
  current. An offline emulation on a Topics board store also showed it would
  not raise the hit rate there: where the index says clean, 1,038 of 1,039
  runs are clean; where a slice is behind, 286 of 319 runs truly read
  something that moved; and the 295 slices waiting on a stale input belong
  almost entirely to sessions that had left.
- **A latest-writer table in the store.** Described above. It is not in the
  tree.
- **A slot left out of the record when superseded.** Described above.
- **Asking the index about a root of any scope.** Described above.

## What the benchmarks showed

Method: a local toolshed with `EXPERIMENTAL_SERVER_EXECUTION=true` and the
mode under test, a fresh store for each run, then
`patterns/integration/fabrichat-room.bench.ts` with
`CF_FABRICHAT_MEMBERS=4 CF_FABRICHAT_MESSAGES=16` or
`patterns/integration/topic-board-navigation.bench.ts`, and the counters read
from `/api/health/stats`. The appendix has the script. One run each on a
4-core machine unless a spread is given.

| | Before #10143 | After #10143 |
| --- | --- | --- |
| Topics navigation, roots served from the store | 0 | 61 |
| Topics navigation, journey | 6.3 s | 6.8 s |
| FabriChat room, roots served from the store | 0 | 5 |
| FabriChat room, journey | 9.7 s | 10.9 s |
| FabriChat room, false cleans under `record` | not run | 0 |

Read these with care:

- **The count of served roots is noise at this size.** On one build Topics
  has read 0 or about 60, and FabriChat 0 to 27 over 16 runs.
- **The journey times are inside the run-to-run spread**, 9.3 to 10.9 s for
  FabriChat. A run taken while anything else uses the machine reads about a
  second slower; two of the runs behind an earlier draft of these numbers
  did.
- **The server-side costs did not move**: in FabriChat about 46 ms to store
  a batch of records, 25 ms for a judgment, and 18 ms for a wave commit, per
  call, before and after.
- **`record` on FabriChat counts no false clean** on the merged code.

The conclusion that matters: none of the three changes in #10143 makes
these benchmarks faster. They remove wrong or needless refusals, and the
roots are then refused for the reasons below.

## Where roots are still refused

A FabriChat run under `skip` on the merged code judged 15,978 roots:

| Outcome | Judgments |
| --- | --- |
| `marked` | 6,267 |
| `no-record` | 5,046 |
| `unvouched-instance` | 2,243 |
| `owner-not-clean` | 1,577 |
| servable | 5 |

A Topics run judged 8,596: `no-record` 6,348, `unvouched-instance` 266,
`owner-not-clean` 151, `marked` 64, servable 1,457 (61 roots left unstarted,
each judged many times).

What is known about each:

- **Sessions bound FabriChat.** In a room space, 51 of 67 recorded pieces
  hold a slice for a session, and the benchmark's four members opened 26
  sessions. A session that has just opened holds no instance of what a
  per-session computation writes, so every piece with one runs for it. No
  rule of the index changes that. The per-session state in FabriChat is
  small interface state (`Writable.perSession` in `room.tsx` and
  `message-row.tsx`: a picker open, a files panel open, a send-to-main
  toggle).
- **`no-record` is mostly documents that are no piece.** A session's watch
  roots include pattern source documents, argument documents and plain data.
  Two kinds of piece are among them. One has no computation of its own: a
  pattern that only instantiates others registers no computation under its
  own result document. In each of two Topics spaces 12 documents with a
  pattern pointer, of 76 and of 115, have no record, and in the larger
  space, the one looked at, none of the 12 declares a computed cell. The
  other kind is not explained: in each of two FabriChat room spaces 4 of
  about 70 such documents have no record, and in the one looked at all 4
  declare computed cells and enclose recorded pieces.
- **Slices of sessions that ended stay.** Nothing removes them. At the end
  of one FabriChat run, 21 of 67 `space` slices in one room space and 28 of
  65 in another were marked `1`, stale through an input, with no read of
  their own behind. The likely cause is a slot a departed session's marked
  slice still holds at its head, which a reader at the `space` key is stale
  through. That was not traced.
- **A viewer who returns in the same session** is the case the index serves
  today. The benchmarks have little of it.

## Open work, in the order it was understood

1. **What a new session costs.** This is what bounds FabriChat, and it is a
   design question, not a rule of the index. Three directions were named and
   none was examined: derive a fresh session's outputs from one stored set
   that holds for any session with default state; keep per-session interface
   state on the client and out of the served graph; or make the first run
   for a session cheap enough not to matter. Start by measuring what the
   per-session runs of one message row cost.
2. **Pieces with no record.** Record a piece that has no computation of its
   own, and find why the four FabriChat pieces with computed cells have none.
3. **Slices of ended sessions.** Remove a session's slices, and its basis
   rows, with its documents. Then check whether the `space` slices marked `1`
   clear.
4. **A running piece that is refused for good.** When every record of a
   running piece leaves it stale with nothing upstream to start, the loop
   judges and gives up on a timer, again and again. The latest-writer attempt
   exposed it; nothing on `main` is known to trigger it. It is in the
   upstream-start logic of #10115 (`#releaseStalledUpstream`,
   `#releaseStuckUpstream` in `space-server.ts`).
5. **The source origin of a piece with a per-viewer root.** Such a piece
   always starts where any instance records an origin. Following an origin
   through each viewer's instance would lift that. The runner's half of the
   rule, noting that an instance records an origin, has no test: building
   such an instance needs the runner's internal write authorization.
6. **The false-clean check reads instances at a slice's own key alone.** A
   wrong judgment about a decided slot is not counted.
7. **Three review threads on #10143 were answered and left open** for a
   person to close: the empty `currency_origin` table on a store written by
   earlier code, keeping `source` on an `integrate` notification, and a
   superseded row beside a head row.
8. **labs #9911 proposes removing `scheduler_basis`.** The read rows for
   each run would have built on that table. With that idea set aside, the
   reason to hold #9911 is only the offline analysis, which reads those rows.
9. **Not measured at all:** a deployed space, the production Topics board,
   and stage 5 of the plan.

## How to work on it

- **Read first**: `docs/development/DEVELOPMENT.md`,
  `docs/development/code-comment-style.md`, the plan, and `serving-loop.md`
  §1 and §3b. A change to what the index decides changes those documents in
  the same commit.
- **Code map**: the index and its judgment are
  `runtime/memory/v2/currency-index.ts`, with tables in `engine.ts`. The
  loop's side is `runtime/runner/src/executor/store-currency.ts` and the
  demand pass in `space-server.ts`. The snapshot is
  `runtime/runner/src/scheduler/piece-currency.ts`, and the per-viewer run
  state is `fan-out.ts` beside it.
- **Runner tests need the clock preload**:
  `cd runtime/runner && ENV=test deno test --no-check --preload=test/clock-preload.ts -A <files>`.
  `--filter` does not reach a nested `it()`, so run the file. The end-to-end
  cases are `test/executor/space-server-currency*.test.ts`.
- **Memory tests**: `cd runtime/memory && deno task test`. In a container
  that runs as root, the `offline-store` permission case fails; nothing else
  should.
- **Before a push**: `deno fmt --check`, `deno lint`, `deno task check` and
  `deno task check-docs`, each by exit code.
- **Check a rule against a real workload before trusting it.** Run FabriChat
  under `record` and read `currency.falseClean`. That is what caught both
  defects found in #10143 after the unit tests passed.
- **Use an end-to-end test as the witness for wiring.** Disable the new path
  and see the test fail. Both the attribution of a change to its run and the
  per-viewer root were checked that way.
- **Probes that exist**: `skills/perf-investigation/scripts/` has
  `currency-profile-probe.ts`, `currency-carried-probe.ts` and
  `currency-worker-probe.ts`, and `profile-toolshed.ts` for a CPU profile of
  a serving toolshed.
- **Continuous integration**: the pull requests carried the `ci: full` label,
  under which a run is 40 test lanes and takes 40 to 55 minutes; a push
  cancels the run in progress. Cubic and Codex review each push within a few
  minutes. The coverage gate measures `runtime/memory`, so a new branch in
  `currency-index.ts` needs a test.

## Appendix: the scripts

These lived outside the repository and are reproduced so they can be
rebuilt. Adjust the paths.

### One benchmark run against a fresh store

```bash
#!/usr/bin/env bash
# Usage: run-arm.sh <label> <off|skip|record> <bench file> [deno bench args]
set -u
LABEL=$1; ARM=$2; BENCH=$3; shift 3
S=/path/to/scratch
REPO=${REPO:-/path/to/labs}
OUT=$S/runs/$LABEL
mkdir -p "$OUT"
cd "$REPO"
./scripts/stop-local-dev.sh > "$OUT/stop.log" 2>&1
rm -rf "$S/mem/$LABEL"; mkdir -p "$S/mem/$LABEL"
# start-local-dev.sh sometimes hangs in its bind wait with both servers
# up, so bound each try and retry after a stop.
rc=1
for try in 1 2 3; do
  EXPERIMENTAL_SERVER_EXECUTION=true SERVER_EXECUTION_CURRENCY_INDEX=$ARM \
    MEMORY_DIR="file://$S/mem/$LABEL/" \
    timeout 180 ./scripts/start-local-dev.sh > "$OUT/start-try$try.log" 2>&1
  rc=$?
  [[ $rc -eq 0 ]] && break
  ./scripts/stop-local-dev.sh >> "$OUT/stop.log" 2>&1
  rm -rf "$S/mem/$LABEL"; mkdir -p "$S/mem/$LABEL"
done
if [[ $rc -ne 0 ]]; then echo "start failed $rc"; exit 1; fi
env EXPERIMENTAL_SERVER_EXECUTION=true \
  API_URL=http://localhost:8000/ FRONTEND_URL=http://localhost:5173/ \
  CF_LOG_LEVEL=silent \
  deno bench --json -A --v8-flags=--expose-gc "$@" "$BENCH" \
  > "$OUT/bench.json" 2> "$OUT/bench.stderr"
# Kept past the cleanup below, which would otherwise decide the exit status.
brc=$?
curl -s localhost:8000/api/health/stats > "$OUT/stats-after.json"
cp runtime/toolshed/local-dev-toolshed.log "$OUT/toolshed.log"
./scripts/stop-local-dev.sh >> "$OUT/stop.log" 2>&1
echo "bench exit $brc" | tee "$OUT/timing.txt"
exit $brc
```

The script does not use `set -e`: the start is retried on a failure, and the
counters and logs are collected whether or not the benchmark passed.

The counters are `.servingLoop.currency` in `stats-after.json`, and the cost
of each request to the memory server is under `.timingStats.executor`. A
false clean is logged as `currency-false-clean` with the pieces. The store of
each space is `mem/<label>/engine-v3/engine-v3/<space>.sqlite`.

Do not edit source files while a run is in progress: a serving worker loads
its modules when its space is first served.

### Reading a store offline

Run from `runtime/memory` with
`deno run -A --config <repo>/deno.jsonc <script> <store.sqlite>`. Which
viewers' slices each recorded piece holds, and how they are marked:

```ts
import { Database } from "jsr:@db/sqlite@0.13.0";
const db = new Database(Deno.args[0], { readonly: true });
const all = (sql: string) => db.prepare(sql).all() as Record<string, any>[];
const pieces = all(`
  SELECT piece, GROUP_CONCAT(DISTINCT substr(slice, 1, 4)) kinds,
    MAX(CASE WHEN slice = 'space' THEN mark END) spacemark
  FROM currency_slice GROUP BY piece`);
const nested = new Set(
  all(`SELECT DISTINCT piece FROM currency_under`).map((row) => row.piece),
);
const tally: Record<string, number> = {};
for (const piece of pieces) {
  const key = `${nested.has(piece.piece) ? "nested" : "root"} | ` +
    `${piece.kinds.split(",").sort().join("+")} | space ${piece.spacemark}`;
  tally[key] = (tally[key] ?? 0) + 1;
}
console.log(tally);
```

The documents that hold a pattern pointer and have no record:

```ts
import { Database } from "jsr:@db/sqlite@0.13.0";
const db = new Database(Deno.args[0], { readonly: true });
const all = (sql: string) => db.prepare(sql).all() as Record<string, any>[];
const pointed = new Set(
  all(`
    SELECT h.id id FROM head h JOIN revision r
      ON r.branch = h.branch AND r.id = h.id AND r.scope_key = h.scope_key
      AND r.seq = h.seq AND r.op_index = h.op_index
    WHERE CAST(r.data AS TEXT) LIKE '%"patternIdentity"%'`)
    .map((row) => row.id),
);
const recorded = new Set(
  all(`SELECT DISTINCT piece FROM currency_slice`).map((row) => row.piece),
);
console.log(
  "with a pattern pointer:", pointed.size,
  "without a record:", [...pointed].filter((id) => !recorded.has(id)).length,
);
```
