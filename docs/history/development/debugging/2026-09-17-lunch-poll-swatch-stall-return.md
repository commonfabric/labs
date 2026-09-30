---
status: historical
created: 2026-09-17
archived: 2026-09-17
reason: "Deflaking record: the lunch-poll swatch stall on the server-execution ON arm, reproduced and characterized on main; what raises its rate, what it is not, and the measurement trap that voided a first bisect."
---

# The lunch-poll swatch stall returns on the ON arm

Deflaked by Hixie's agent, working in labs F1.

## The failure

`Pattern Integration Tests / opposite server-execution (2/10)`, job
105006239291 of run 35159260551. The failing step is

```text
lunch poll: two users vote on a shared option
  > both users' votes on the same option survive, and a second option
    tallies independently
  > "both voters' swatches visible on both browsers"
```

which ends as a 60-second `waitFor` timeout and carries nothing else. Every
earlier step passes, including "both browsers see 2 love it (merge)" at 62 ms.
The pull request that run was testing changes only the dashboard, so the
failure is not caused by the change under test, and the same job failed the
same way on main in run 35178484478.

The arm matters: `opposite` resolves to server execution ON, because the
first-party default is OFF. The default-posture twin of that job,
`Pattern Integration Tests (2/10)`, passed in the same run.

## Reproducing it

Start local dev servers under the ON posture and run the test the way the
continuous-integration job runs it:

```bash
EXPERIMENTAL_SERVER_EXECUTION=true ./scripts/start-local-dev.sh
cd packages/patterns
HEADLESS=1 EXPERIMENTAL_SERVER_EXECUTION=true API_URL=http://localhost:8000/ \
  deno test --no-check --v8-flags=--max-old-space-size=4096 --trace-leaks -A \
  ./integration/lunch-poll-vote.test.ts
```

On main at 39b369872b this stalls in roughly one run in six. The rate is not
stable across a session — see "The measurement trap" below.

## What the stalled browser holds

One browser — observed as the guest five times and as the host twice — renders
every view of the tally correctly except the per-voter swatches in the "All
options" summary, which hold zero swatch elements for the whole 60 seconds:

```text
  header       "2 joined · 1 options · 2 votes today"     current
  top choice   "Sushi Place" / "2 love it"                current
  all options  "Sushi Place" with no swatch spans         stale
```

The other browser renders both swatches. The count and the voter list come out
of one pass of `tallyOption` over the same votes, so a correct count says the
value that browser holds names both voters.

Reading that browser's own view tree through the shell's
`commonfabric.vdom.tree()` debug surface finds no swatch node in it at all:
`{"len":77227,"swatches":[]}` against `{"len":64639,"swatches":["",""]}` on the
browser that is fine. So the staleness is in the view tree, not in the
rendering of it — and the header count, which reads `todaysVotes.length`, is
current on the same browser, so the day's vote set is not what is stale.

## What heals it, and what does not

- Adding an option on the other browser — an authored, space-scoped commit that
  changes the shape of the ranked list — heals the stalled browser in about
  three seconds.
- A keystroke into the option-draft input does not. Those drafts are
  per-session cells.
- A third vote by the other browser, which changes `tally.voters` without
  changing the shape of the ranked list, does not: the top-choice line updates
  to "1 love it, 1 okay with it" in the same frame while the swatch list stays
  empty.

## What the serving loop does

Read offline with `cf inspect` and sqlite over the toolshed's space databases,
on three stalled spaces:

- The two concurrent votes arrive as adjacent authored commits, the derived
  commits that follow carry the two vote entities and the votes-list patch, and
  the watermark advances to the derived tail. W ends one below the store head,
  which is the advance-carrying bookkeeping commit itself and is residual (iii)
  of S1 rather than a freeze.
- The wave that processes the vote batch often exhausts its flush deadline, and
  so do waves in runs that pass.
- No derived commit after the votes writes a `computed:` document — and that is
  also true of runs that pass, so it does not separate the two.

## What this is not

The same step is the subject of
[`stage-c/swatch-stall-rootcause.md`](../../plans/server-execution-v2/stage-c/swatch-stall-rootcause.md),
whose class fix S1 landed and closed register row OW43. Two observations say
this is a different mechanism:

- the flicker witness `overlayCascadeEchoFlickers` is zero on both browsers in
  the failures here, and one on browsers in runs that pass;
- the watermark is not frozen below a layer's floor — it reaches the derived
  tail at quiescence, which is what S1 was built to guarantee.

## The measurement trap

The toolshed's memory store grows with every run of this test, and the failure
rate grows with it: 7.6 GB and 1826 space databases at the start of a session
gave roughly one failure in seven, and 17 GB and 3785 databases gave nearly
every run. Restarting the toolshed against the grown store does not undo it;
emptying the store does.

A first bisect over the 1249 commits between 2026-08-24 and the tip, ten runs
per candidate and no store reset, returned five clean verdicts followed by five
failing ones and named a commit. It was measuring the session. Reverting the
named commit changed nothing, and the last commit it had scored clean at ten
out of ten failed four in twenty when re-measured an hour later. Ten passing
runs against a ten-percent rate happens better than a third of the time, so no
clean verdict in that run carried weight.

Anything comparing two builds here has to empty
`packages/toolshed/cache/memory/engine-v3` before every measurement and
interleave the arms rather than running them in blocks.

## What the corrected measurements say

All of these empty the store before each block and alternate the arms.

| comparison | result | one-sided Fisher |
| --- | --- | --- |
| tip 39b369872b against 2026-08-24 c105fa3c81 | 8/30 against 0/30 | p = 0.0023 |
| tip against tip with #7586 reverted | 5/30 against 1/30 | p = 0.026 |

So it is a regression since August, and a second bisect — fifteen runs per
candidate, store emptied per point — names
`9d68a66658` (`fix(lunch-poll): the day's vote set rescans once a day`,
[#7586](https://github.com/commontoolsinc/labs/pull/7586)), with its immediate
parent `dd23b59eea` clean at fifteen runs.

That commit changes six lines of `packages/patterns/lunch-poll/main.tsx`: the
current-day vote set used to read the five-minute `#now/300` tick and rescan on
every tick, and now reads `todayKey`, the computed that coarsens the tick to a
date string, so it rescans when the day changes. The old rescan was itself a
problem — 288 scans a day, and a read-scale budget it failed intermittently.

Reverting it leaves one failure in thirty, which is the rate 2026-08-24
measured as zero in thirty and is not distinguishable from it. So #7586 is not
the defect. It removed a rescan that used to rebuild everything below the day's
vote set, and with it the repair that was keeping a pre-existing missed update
out of sight.

## Where a successor picks up

The defect to find is the missed update: one browser's "All options" swatch
subtree is derived once, before the votes, and afterwards neither the client
nor the serving loop derives it again, while the top-choice line above it —
reading the same ranked list — stays current. The two convergence paths the
server-execution design offers are a client re-run and the arrival of the
server's derived value, and on this subtree neither happens.

The cheapest next probes, in order: whether the client's tally computed is
demanded on the stalled browser at the moment the votes land; whether the
group index behind `votesByOption.index.lookup(option.id)` is still bound to
the vote group after `todaysVotes` is rewritten; and what separates the browser
that stalls from the one that does not, since the two differ only in which
identity cast which vote.

The step's failure now reports what each browser holds — the swatch nodes it
rendered, the names on them, and its participant chips — so the next
continuous-integration occurrence carries the evidence rather than a bare
timeout.

Twenty runs on 709f3dd02f, which carries strict CFC and the Deno TLS
WebSocket stall workaround among eleven commits later than the measurements
above, failed six times, so neither closed this. Every one of those six had
exactly one browser at zero swatch nodes and the other at two — the host four
times and the guest twice — and the two browsers differ only in which identity
cast which vote, so whatever decides which one stalls is not the role.

One further run, taken while the store had grown, had BOTH browsers at zero.
That is the shape a reader should expect to be rarer rather than impossible.
