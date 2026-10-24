---
status: historical
created: 2026-10-15
archived: 2026-10-15
reason: "Measurements behind the default discretionary target, 575 seconds, when pull requests began counting their lanes."
---

# Calibrating the lanes a pull request counts for itself

Measured on 2026-10-15. Until then a pull request's tests ran in five lanes,
the parallel jobs `tasks/ci-lane.ts` packs. The lanes placed the work the
change made mandatory first, and the tests chosen by score shared what was
left of the five lanes' budget of 230 seconds each. From this change on, a
pull request takes the fewest lanes, up to 30, that hold its mandatory work
and a target of tests chosen by score, `DISCRETIONARY_SECONDS`. This document
records how that target was set to 575 seconds, and what the change was
projected to cost.

## Method

The sample is the newest run of each of 90 pull requests run between
2026-10-10 and 2026-10-15, drawn by a seeded random choice from the 289 that
ran in that window, together with the 33 lowest-numbered of them. Every
manifest those runs read was published after the lane cost model was fitted
to what lanes spend on average, on 2026-10-09.

For each pull request the replay checked out its head commit and took its
diff against the default branch as it stood when the run was created. It
read the manifest current at that moment. The lanes read the manifest
current when the commit they test was made, and that commit is the merge
GitHub makes for the run, so the two moments are close; a manifest
published between them would make a replay differ from its run. It ran the lane count of this
change over them, at targets from 0 to 2,300 seconds. It also packed the
same work into five lanes as the lanes had before the change. One of the
90 failed because the topology code of this change looks for a package
that tree did not yet have, which leaves 89.

The replay ran the head commit rather than the merge commit GitHub tests,
so a test file that landed on the default branch after the manifest was
published is missing here where the run itself counted it as a unit no
manifest had seen.

## What five lanes did

In 36 of the 89 (40%), the mandatory work took all five lanes' room, so
nothing was chosen by score. Their mandatory work was projected at a median
of 3,127 seconds, and at least 1,180. Across all 89 the median was 900
seconds.

`deno task test-selection health` against the manifest of
2026-10-15T16:29:43Z reported that the batches of the suites carrying most
mandatory work spent 0.73 (`workspace-unit`) to 0.87 (`typecheck`) of what
they were charged, at the median. So those projections were close to what
the lanes would spend.

## The lanes each target takes

"Fit today" is the 53 pull requests whose mandatory work left room in five
lanes.

| Target (s) | All: median | All: mean | Fit today: median | Fit today: five lanes | Chose nothing: median | At the cap of 30 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 4 | 8.0 | 3 | 5 of 53 | 15.5 | 2 |
| 230 | 5 | 9.0 | 4 | 10 of 53 | 16.5 | 2 |
| 460 | 6 | 9.9 | 5 | 13 of 53 | 17.5 | 3 |
| 575 | 7 | 10.4 | 5 | 22 of 53 | 17.5 | 3 |
| 690 | 7 | 10.9 | 6 | 14 of 53 | 18.5 | 3 |
| 920 | 8 | 11.9 | 7 | 11 of 53 | 19.5 | 3 |
| 1150 | 9 | 12.8 | 8 | 0 of 53 | 20.5 | 4 |

At 575 seconds the pull requests that fit today take five lanes more often
than any other count, 22 of 53, and five at the median. Their counts were 3
lanes for 3 of them, 4 for 12, 5 for 22, 6 for 5, and 7 for 11. A change
with nothing mandatory takes three lanes, holding 575 seconds of tests
chosen by score where five lanes had held up to 1,150.

The target is what a pull request runs whatever its mandatory work, so the
36 that chose nothing take far more lanes than five: a median of 17.5 at
575 seconds, and still 15.5 at a target of nothing.

## Runner minutes

60 lanes of five-lane pull-request runs from the same week took, at the
median, 0.74 seconds of the whole job for each second of work they were
projected to take. Holding each lane's work to its plan's share, rounding
each job up to whole minutes as GitHub bills them, and charging that ratio
gives 26.2 billed lane-minutes a run for the five-lane plans. 190 five-lane
pull-request lanes measured directly took 5.2 billed minutes each, 26 a run.

The same model gives 31.1 lane-minutes a run at a target of 575 seconds,
and 23.7 at a target of nothing. The job that counts the lanes adds one
billed minute a run, so the change was projected to add about 23% to a pull
request's lane-minutes, or about 6 minutes a run. The repository ran about
200 pull-request runs a day in the sample's window.

`commonfabric/labs` is public, and its lanes run on GitHub's standard hosted
runners.

## Time added before the lanes start

Every pull request now waits for the job that counts its lanes. Over 20
runs on the default branch, the job that counted the full run's lanes took
a median of 34 seconds: 7 to check out, 10.5 to set up Deno, and 12 to
count. A pull request's count checks out the whole history, which took a
median of 17 seconds in the lanes, so the job is about 45 seconds. A lane
started a median of 3 seconds after its run was created.

Counting a pull request's lanes packs about six candidate counts through
the mandatory pass alone, which took about 0.8 seconds a count on a
workstation.

## What these figures leave out

The same day, the packer began charging each test file's setup and
teardown hooks, from a per-unit figure the publisher fits from the
lanes' records. No manifest published by the time of this measurement
carried that figure yet, so the planner charged no hook time, and the
figures above are without it. Once manifests carry about a week of hook
figures, mandatory work will be charged more, and the counts above will
rise with it.

## Reproducing this

1. List the pull-request runs of `deno.yml` in the window with
   `gh run list --workflow deno.yml --event pull_request --created
   '>=2026-10-10'`, match each run's head commit to a pull request from
   `gh pr list --state all`, and keep the newest run of each.
2. Fetch each pull request's head with `git fetch upstream
   refs/pull/<n>/head`, take the default branch's commit at the run's
   creation with `git rev-list -1 --first-parent --before=<created>
   upstream/main`, and write `git diff --name-only <that>...<head>` to a
   file.
3. Check the head out into a worktree of its own, and from a checkout of
   the code under test run `deno run -A --config deno.jsonc replay.ts
   <worktree> <created> <changed files>`, with `replay.ts` as below.

```ts
// Prints what five lanes held, and the lane count at each target.
const root = Deno.cwd();
const { planOver } = await import(`${root}/tasks/ci-lane.ts`);
const { loadTopology, capabilitiesBySuite, wholeUnits } = await import(
  `${root}/tasks/test-topology.ts`
);
const { fetchManifest } = await import(`${root}/tasks/test-selection/store.ts`);
const { census, pricedForRun } = await import(
  `${root}/tasks/test-selection/census.ts`
);
const { laneCount } = await import(`${root}/tasks/test-selection/plan.ts`);

const [tree, at, changedPath] = Deno.args;
const suites = await loadTopology(tree);
const { manifest } = await fetchManifest({ at });
const changed = new Set(
  (await Deno.readTextFile(changedPath)).split("\n").filter((l) => l !== ""),
);
const base = { suites, manifest, changed, full: false };
const sum = (laid: { lanes: { projectedSeconds: number }[] }) =>
  laid.lanes.reduce((t, l) => t + l.projectedSeconds, 0);
// The mandatory work alone in five lanes, and what five lanes chose before:
// a scale large enough that the passes get all the room there is.
const mandatory = planOver({ ...base, lanes: 5, scale: 0 }).laid;
const before = planOver({ ...base, lanes: 5, scale: 1e9 }).laid;
const seen = pricedForRun(census(suites, manifest, changed), suites, false);
const packing = {
  manifest: seen.manifest,
  mandatory: seen.mandatory,
  capabilities: capabilitiesBySuite(suites),
  wholeUnits: wholeUnits(suites),
};
const grid: Record<number, unknown> = {};
for (const target of [0, 115, 230, 345, 460, 575, 690, 805, 920, 1150]) {
  grid[target] = laneCount({ ...packing, discretionarySeconds: target });
}
console.log(JSON.stringify({
  mandatorySeconds: Math.round(sum(mandatory)),
  roomBefore: Math.round(before.discretionarySeconds),
  grid,
}));
```
