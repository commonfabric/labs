---
status: historical
created: 2026-10-15
archived: 2026-10-15
reason: "Replays of pull-request runs measuring the change that stopped forcing test files the default branch gained after a manifest."
---

# Test files that landed on `main` after a manifest

A pull request's continuous-integration run chooses which tests to run
from a **manifest**: a file published every four hours that gives each
test a score and a cost. A test **unit**, usually one test file, that the
manifest has never seen was always forced into the run, and charged a
**stand-in** cost guessed from the other units of its suite. GitHub tests
a pull request merged into the current default branch, so every test file
that landed on `main` after the newest manifest was forced into every
pull request tested before the next one. That work came out of the same
budget the tests chosen by score are paid from.

The change measured here stops forcing a unit when it is a file the
default branch gained after the commit the manifest was published from
and before the pull request branched off. The full run on `main` runs
every unit, so the records such a unit lacks in the manifest are already
being gathered. The unit keeps its stand-in at the lowest score, and the
exploration pass, which spends part of the budget on tests that have not
run, takes it first. A unit the pull request adds, a unit that is not a
file (a repository gate, a type-check group), a unit the manifest's own
commit already held, and every unit when there is no manifest, are still
forced in.

## Findings

Everything below comes from replaying pull-request runs with and without
the change, as described under [Method](#method).

Over the 938 runs:

| | Forcing every unseen unit | Leaving units new on `main` to the score |
| --- | --- | --- |
| Runs that chose no test by score | 348 (37.1%) | 301 (32.1%) |
| Runs whose forced work alone put a lane past its budget | 367 | 319 |
| Runs charged for forced stand-ins | 819 | 603 |
| Seconds charged to forced stand-ins | 167,606 (9.1% of projected time) | 39,482 (2.2%) |
| Placements of the 10 highest-scoring tests | 5,422 of 9,380 | 6,185 of 9,380 |
| Placements of the 50 highest-scoring tests | 14,767 of 46,900 | 16,064 of 46,900 |
| Sum of the scores of the tests chosen by score | 137,602 | 152,134 |

- 641 of the 938 runs (68.3%) held at least one unit the change stops
  forcing. Such a run held a median of 5 of them, with a ninetieth
  percentile of 11 and a maximum of 34. Of the 3,891 such units, 1,407
  were `workspace-unit` files, 1,223 `runner-unit` files, 675
  `pattern-unit` files, 522 pattern integration files (261 under each of
  the two server-execution settings), and 64 `cfcheck` patterns.
- In those 641 runs, forced stand-ins were charged a median of 184
  seconds before the change and 10 after, with a ninetieth percentile of
  488 seconds before. A run's budget is 1,150 seconds.
- 47 runs that chose no test by score before the change chose some after
  it, and no run went the other way. Those 47 runs held a median of 11
  units new on `main`, whose stand-ins had been charged a median of 485
  seconds. They placed 35 of their 470 top-ten tests before the change
  and 393 after it.
- 214 runs placed more of the ten highest-scoring tests after the change,
  and 1 placed fewer. In that one run, the change moved which lane each
  test went in, and the run placed 8 of the top ten rather than 9 while
  the scores of what it chose rose from 208 to 260 in total.
- 251 runs placed more of the fifty highest-scoring tests and 98 placed
  fewer. 178 runs chose tests whose scores sum to less. Checking one such
  run by hand showed the mechanism: before the change, a forced stand-in
  opened `workspace-unit` in a lane, which made that suite's low-scoring
  tests cheap to add there. Without it, that room went to fewer tests
  with higher scores in other suites.
- Of the units the change stops forcing, 258 of 3,891 were still placed
  by the exploration pass.

The same replay, read before the change only, gives the figures the
investigation of 2026-10-01 reported for the week to that date. Stand-ins
were 7.5% of the projected time of the 348 runs that chose nothing by
score, where it found 7.7%. 56 of those 348 runs would have fit inside
the budget without any stand-in, where it found 26 of 195.

## After a run's lanes were counted from its work

From #9018 on, a pull request no longer runs in five lanes. It takes the
fewest lanes, up to 30, that hold its forced work and 575 seconds of
tests chosen by score, so forced stand-ins no longer crowd out the tests
chosen by score. They buy lanes instead. A third of the runs above,
every third head commit in creation order, were replayed again on that
code, both arms counting their own lanes. 312 replayed, and one did not
merge cleanly.

| | Forcing every unseen unit | Leaving units new on `main` to the score |
| --- | --- | --- |
| Lanes | 2,370 | 2,121 |
| Projected test time, in seconds | 571,552 | 514,538 |
| Share of it charged to forced stand-ins | 9.2% | 2.3% |
| Placements of the 10 highest-scoring tests | 2,816 of 3,120 | 2,802 of 3,120 |
| Placements of the 50 highest-scoring tests | 6,930 of 15,600 | 6,605 of 15,600 |

- 153 runs took fewer lanes, by a median of 1 and at most 4, and none
  took more. In the 211 runs holding a unit the change stops forcing,
  lanes fell from 1,597 to 1,348, and forced stand-ins were charged a
  median of 184 seconds before and 11 after.
- Both arms spent the full 575 seconds on tests chosen by score in all
  but the same 8 runs, and 9 runs in each arm needed more than the 30
  lanes allowed.
- Fewer of the highest-scoring tests were placed. I'd guess this is the
  mechanism seen above: a forced stand-in pays its suite's fixed charge,
  so that suite's other tests cost less to add within the 575 seconds.
  This was not checked run by run.

## Method

The runs were the 1,000 most recent pull-request runs of the `deno.yml`
workflow created after the cost-model refit of #8613, which is as many as
GitHub's listing returns. They were created between 2026-10-10T00:45Z and
2026-10-15T20:23Z, and held 938 distinct head commits. The first run of
each head commit was replayed.

For each run:

1. The base is the newest first-parent commit of `main` created before
   the run, and the tree is the pull request's head merged into it, as
   GitHub builds the merge commit it tests.
2. The manifest is the newest one the store created at or before the
   run's creation.
3. The tree is read with the topology code of the branch that carries the
   change, not the code each run had.
4. Both arms pack five lanes with `planOver()` from the same tree,
   manifest and diff, or, for the replay on the code of #9018, as many
   lanes as each arm counts for itself. One passes no files as landed, which is the
   behavior before the change. The other passes what `landedFiles()`
   lists.

Runs labelled `ci: full` ran every test over as many lanes as the full
run needs, but are replayed like any other pull request.

The replay of the arm before the change was checked against the lanes'
own logs, which say how many units each lane charged a stand-in for and
how many seconds that came to. For runs 38623118800, 38125742569,
38188965567 and 38199146142, the replay's count of forced stand-ins and
their seconds equal the sum of the five lanes' figures (7 and 345, 1 and
11, 15 and 392, 9 and 96), and its projected time is within 8 seconds of
theirs. A fifth run sampled, 38796336088, ran no lanes. A sixth,
38449121665, carried the `ci: full` label: its lanes charged 9 stand-ins,
the replay's count.

## Reproducing this

The replay reads public objects and needs a GitHub token able to list
runs. From a checkout of the branch carrying the change, with
`upstream/main` fetched and every head commit present:

1. List the runs:
   `gh api --paginate -X GET repos/commonfabric/labs/actions/workflows/deno.yml/runs -f event=pull_request -f created='>=2026-10-09T08:00:00Z' -f per_page=100 -q '.workflow_runs[] | {id, head_sha, created_at}' > runs.jsonl`
2. Create one detached scratch worktree per worker, outside the checkout.
3. Save the script below as `replay.ts` outside the checkout, and run it
   once per worker from the checkout's root:
   `deno run -A --config=deno.jsonc replay.ts "$PWD" <worktree> runs.jsonl out-<n>.jsonl <n> <workers>`.
   Each line of output is one run, with an `old` and a `new` object
   holding the measures above. For the replay on the code of #9018,
   remove `lanes: 5` from the `planOver()` call and record
   `laid.lanes.length`.

```ts
// Replays pull-request lane plans with and without leaving units the
// default branch gained after the manifest's commit to the score.
const [labs, worktree, runsPath, outPath, workerText, workersText] = Deno.args;
const worker = Number(workerText);
const workers = Number(workersText);

const { planOver, changedFiles, landedFiles } = await import(
  `file://${labs}/tasks/ci-lane.ts`
);
const { loadTopology } = await import(`file://${labs}/tasks/test-topology.ts`);
const { isStandIn } = await import(
  `file://${labs}/tasks/test-selection/census.ts`
);
const { placedOnlyMandatory, suiteLoad } = await import(
  `file://${labs}/tasks/test-selection/plan.ts`
);
const { newestFirstAtOrBefore } = await import(
  `file://${labs}/tasks/test-selection/store.ts`
);
const { listObjectTimes, objectUrl, parseManifest, testIdentityKey } =
  await import("@commonfabric/test-support/records");

const BUCKET = "cf-ci-metadata";
const PREFIX = "labs/test-selection/v1";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

const objects = await listObjectTimes({ bucket: BUCKET, prefix: `${PREFIX}/` });
const manifests = new Map<string, unknown>();
async function manifestAt(at: string) {
  const name = newestFirstAtOrBefore(objects, at)
    .find((n: string) => n.includes("/manifest-"));
  if (name === undefined) return undefined;
  if (!manifests.has(name)) {
    const text = await (await fetch(objectUrl(BUCKET, name))).text();
    manifests.set(name, parseManifest(JSON.parse(text)));
  }
  return { name, manifest: manifests.get(name) };
}

const runs = (await Deno.readTextFile(runsPath)).split("\n").filter(Boolean)
  .map((line) => JSON.parse(line));
const byHead = new Map<string, any>();
for (const run of runs) {
  const seen = byHead.get(run.head_sha);
  if (seen === undefined || run.created_at < seen.created_at) {
    byHead.set(run.head_sha, run);
  }
}
const mine = [...byHead.values()]
  .sort((a, b) => a.created_at.localeCompare(b.created_at))
  .filter((_, i) => i % workers === worker);

for (const run of mine) {
  const row: Record<string, unknown> = { run: run.id, at: run.created_at };
  const base = (await git(labs, "rev-list", "-1", "--first-parent",
    `--before=${run.created_at}`, "upstream/main")).trim();
  await git(worktree, "checkout", "-q", "-f", "--detach", base);
  await git(worktree, "clean", "-q", "-fdx");
  try {
    await git(worktree, "-c", "user.name=replay", "-c",
      "user.email=replay@example.com", "merge", "-q", "--no-ff", "--no-edit",
      run.head_sha);
  } catch {
    // The head does not merge cleanly: record it and go on to the next.
    await new Deno.Command("git", { args: ["merge", "--abort"], cwd: worktree })
      .output();
    row.skipped = "merge conflict";
    await Deno.writeTextFile(outPath, JSON.stringify(row) + "\n", { append: true });
    continue;
  }
  const resolved = await manifestAt(run.created_at);
  const manifest = resolved?.manifest as any;
  row.manifest = resolved?.name;
  const changed = await changedFiles(worktree, base);
  const landed = await landedFiles(worktree, base, manifest?.commit);
  const suites = await loadTopology(worktree);
  const arm = (given: ReadonlySet<string>) => {
    const { seen, laid } = planOver({
      suites, manifest, changed, landed: given, full: false, lanes: 5,
    });
    const reasons: Record<string, number> = {};
    let forcedStandIns = 0;
    let forcedStandInSeconds = 0;
    const placed = new Set<string>();
    let chosenScore = 0;
    for (const lane of laid.lanes) {
      for (const s of lane.selections) {
        reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
        placed.add(testIdentityKey(s.entry.test));
        if (["value", "density", "exploration"].includes(s.reason)) {
          chosenScore += s.entry.score;
        }
      }
      for (const [suite, held] of Map.groupBy(
        lane.selections, (s: any) => s.entry.suite,
      ) as Map<string, any[]>) {
        const forced = held.filter((s) =>
          isStandIn(s.entry) && seen.mandatory.has(testIdentityKey(s.entry.test))
        );
        forcedStandIns += forced.length;
        forcedStandInSeconds += suiteLoad(seen.manifest, suite, held) -
          suiteLoad(seen.manifest, suite, held.filter((s) => !forced.includes(s)));
      }
    }
    const top = [...seen.manifest.entries]
      .filter((e: any) => !isStandIn(e))
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 50);
    return {
      chosenScore,
      top10Placed: top.slice(0, 10)
        .filter((e: any) => placed.has(testIdentityKey(e.test))).length,
      top50Placed: top.filter((e: any) => placed.has(testIdentityKey(e.test)))
        .length,
      forcedStandIns,
      forcedStandInSeconds,
      onlyMandatory: placedOnlyMandatory(laid),
      overBudget: laid.overBudgetSeconds,
      projected: laid.lanes.reduce((t: number, l: any) => t + l.projectedSeconds, 0),
      reasons,
    };
  };
  row.old = arm(new Set());
  row.new = arm(landed);
  await Deno.writeTextFile(outPath, JSON.stringify(row) + "\n", { append: true });
}
```
