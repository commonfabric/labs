# The commands behind every figure

Machine: Apple silicon macOS (Darwin 27.0.0), Deno 2.9.4, in-process memory
server (`newLoopbackServer`), no toolshed and no browser. Every run records its
commit, its resolved experimental options and its arguments in its own
`*.result.json`.

The rig is `packages/patterns/own-entry/measure-start.ts`; its module comment
defines every phase and every count. The arms are
`packages/patterns/own-entry/arms.ts` and the generated boards under
`packages/patterns/own-entry/arms/`, written by
`packages/patterns/own-entry/make-arms.ts`.

## Generating the arms

```
deno run -A packages/patterns/own-entry/make-arms.ts
deno task cf check packages/patterns/own-entry/arms/<arm>/main.tsx --no-run
```

Each arm type-checks under `cf check`, which is the pattern type-check
environment (`AGENTS.md` § Automated gates).

## The ladder (`experiment-output/runs/`)

Every arm at N = 4, 10, 40:

```
for n in 4 10 40; do
  for a in current q2-unread q2-read-one q3-index q4-handed q6-copies \
           q7-board-name; do
    CF_MEMORY_FRAME_LOG=$PWD/experiment-output/runs/live-$a-$n.jsonl \
      deno run -A packages/patterns/own-entry/measure-start.ts \
        --arm=$a --n=$n --d=2 --out=experiment-output/runs \
        >/dev/null 2>experiment-output/runs/$a-N$n.stderr.txt
  done
done
```

The larger sizes, with the board's outputs demanded once at the end of the
build rather than throughout (`--defer-demand=true`; the figures it produces
are byte-identical, shown below):

```
CF_MEMORY_FRAME_LOG=$PWD/experiment-output/runs/live-q3-index-100.jsonl \
  deno run -A packages/patterns/own-entry/measure-start.ts \
    --arm=q3-index --n=100 --d=2 --defer-demand=true \
    --out=experiment-output/runs
CF_MEMORY_FRAME_LOG=$PWD/experiment-output/runs/live-q4-handed-100.jsonl \
  deno run -A packages/patterns/own-entry/measure-start.ts \
    --arm=q4-handed --n=100 --d=2 --defer-demand=true \
    --out=experiment-output/runs
CF_MEMORY_FRAME_LOG=$PWD/experiment-output/runs/live-q3-index-200.jsonl \
  deno run -A packages/patterns/own-entry/measure-start.ts \
    --arm=q3-index --n=200 --d=2 --defer-demand=true \
    --out=experiment-output/runs
CF_MEMORY_FRAME_LOG=$PWD/experiment-output/runs/live-q4-handed-200.jsonl \
  deno run -A packages/patterns/own-entry/measure-start.ts \
    --arm=q4-handed --n=200 --d=2 --defer-demand=true \
    --out=experiment-output/runs
CF_MEMORY_FRAME_LOG=$PWD/experiment-output/runs/live-q6-copies-200.jsonl \
  deno run -A packages/patterns/own-entry/measure-start.ts \
    --arm=q6-copies --n=200 --d=2 --defer-demand=true \
    --out=experiment-output/runs
```

Wall clock for those five, as the shell measured them: 67 s, 55 s, 379 s,
294 s, 287 s.

## Deferred demand against demand held throughout

`experiment-output/defer-check/` holds the pair at N = 40 for two arms:

```
CF_MEMORY_FRAME_LOG=$PWD/experiment-output/defer-check/live.jsonl \
  deno run -A packages/patterns/own-entry/measure-start.ts \
    --arm=q4-handed --n=40 --d=2 --defer-demand=true \
    --out=experiment-output/defer-check
CF_MEMORY_FRAME_LOG=$PWD/experiment-output/defer-check/live.jsonl \
  deno run -A packages/patterns/own-entry/measure-start.ts \
    --arm=q3-index --n=40 --d=2 --defer-demand=true \
    --out=experiment-output/defer-check
```

Against `experiment-output/runs/{q4-handed,q3-index}-N40.result.json`: the
`start` phase's documents, other-topic documents and bytes are equal; only
`ms.build` differs (q3-index 21,385 ms held live against 9,948 ms deferred).

## A move that leaves a forwarding link

`--forward=true` rewrites the board's list entry for topic 0 to a document
whose only content is a link to topic 0, so the board holds an address that
forwards to the topic.

```
for a in current q3-index q4-handed q6-copies q7-board-name; do
  CF_MEMORY_FRAME_LOG=$PWD/experiment-output/forward-resolved/live-$a.jsonl \
    deno run -A packages/patterns/own-entry/measure-start.ts \
      --arm=$a --n=4 --d=2 --forward=true \
      --out=experiment-output/forward-resolved \
      >/dev/null 2>experiment-output/forward-resolved/$a-N4.stderr.txt
done
```

`experiment-output/forward/` holds the same five runs taken BEFORE the arms'
boards resolved a member's link before taking its entity id — the arm boards
then lost the entry after the move, which is what sent me to
`resolveAsCell()`. `experiment-output/runs-resolved/` holds N = 4, 10, 40 for
the four entry arms after that change, and its `start` figures equal the
ladder's to the byte.

## The tables

```
deno run -A packages/patterns/own-entry/summarize.ts experiment-output/runs \
  > experiment-output/summary-ladder.txt
deno run -A packages/patterns/own-entry/summarize.ts \
  experiment-output/forward-resolved > experiment-output/summary-forward.txt
deno run -A packages/patterns/own-entry/summarize.ts \
  experiment-output/runs-resolved \
  > experiment-output/summary-runs-resolved.txt
deno run -A packages/patterns/own-entry/summarize.ts experiment-output/forward \
  > experiment-output/summary-forward-unresolved.txt
for f in current-N10 q2-unread-N10 q4-handed-N10 q6-copies-N10; do
  deno run -A packages/patterns/own-entry/show-frames.ts \
    experiment-output/runs/$f.start.jsonl --selectors=3 \
    > experiment-output/frames-$f-start.txt
done
```

## What each file is

- `runs/<arm>-N<n>.result.json` — one run's record: every count, every timing,
  the commit it ran at, and the checks the topic passed.
- `runs/<arm>-N<n>.<phase>.jsonl` — the memory frames of that phase, as
  `CF_MEMORY_FRAME_LOG` wrote them (gzipped where large). `start` is the one
  the report's figures come from; `op-add` and `op-mention` are the board's
  costs; `replay-*` are the #7439 queries.
- `runs/<arm>-N<n>.stderr.txt` — the run's own log, including the stage
  markers naming which phase each figure came from.
- `summary-*.txt`, `frames-*.txt` — the tables above, regenerable from the
  records by the two commands listed.

## The run that did not finish

```
CF_MEMORY_FRAME_LOG=$PWD/experiment-output/runs/live-q7-board-name-200.jsonl \
  deno run -A packages/patterns/own-entry/measure-start.ts \
    --arm=q7-board-name --n=200 --d=2 --defer-demand=true \
    --out=experiment-output/runs
```

**Broken: stopped by me after 25 minutes, still inside its build phase.** Its
only output is `runs/q7-board-name-N200.stderr.txt`, which carries the build
stage marker and nothing after it; there is no result record, and no figure in
the report comes from it. The reason is the arm itself: filing topics into the
board that passes itself into every child cost 89 s at N=40 against 21 s for
the same board without that reference (`runs/q7-board-name-N40.result.json`
against `runs/q6-copies-N40.result.json`, `ms.build`), and N=200 did not
finish. That build cost is unattributed. The arm's N = 4, 10 and 40 runs
completed and are what § 7 of the report uses; its sibling `q6-copies`, which
differs only by that reference, has an N=200 run.

## One thing the records do not say

The rig began recording `deferDemand`, `forward` and `movedTo` in its result
file only after the N = 100 and N = 200 runs were taken, so those records read
`"deferDemand": null`. They were invoked with `--defer-demand=true`, as the
commands above show, and their `ms.build` is consistent with it (q3-index:
21,385 ms at N=40 with the demand held throughout against 9,948 ms deferred, in
`defer-check/`). Every run under `forward/`, `forward-resolved/` and
`runs-resolved/` records all three fields.
