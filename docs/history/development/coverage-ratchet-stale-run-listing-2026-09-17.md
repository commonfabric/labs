---
status: historical
created: 2026-09-17
archived: 2026-09-17
reason: "Investigation record: why the Coverage Check job passed four pull request runs on 2026-09-15 and 2026-09-17 while gating no source group. The date in the filename is the day the investigation was made."
---

# The run listing that stopped in August, September 2026

## Conclusion

Four Coverage Check jobs, on two days, passed while holding no source group
against a baseline. Each logged the same five lines, shown here as the three
jobs of 2026-09-17 logged them; the job of 2026-09-15 named `cbeb9d92` in place
of `c4a5de33`:

```text
This run merges the pull request into base-branch commit c4a5de33.
No `main` run has measured base-branch commit c4a5de33 or any of its ancestors.
Not gated, because no baseline counts the same base-branch code as this run does: <all 39 groups>
## Coverage debt metrics  (39 total — OVER: 0, OK: 0, ovrd: 0, excl: 39, n/a: 0)
Coverage debt within the ratchet for every changed group.
```

In every one of them a successful `main` run for the exact base-branch commit
existed, had finished, and was the newest successful `main` run there was. The
ratchet did not find it because GitHub's response to the listing request was a
window of runs that ended on 2026-08-22, weeks earlier, returned with a success
status and nothing to mark it. None of the twenty runs in that window was an
ancestor within reach of the base-branch commit, so the walk read no run at
all, every group came out `excl`, and the job passed.

The request was
`GET /repos/{repo}/actions/workflows/deno.yml/runs?branch=main&status=success&event=push&per_page=20`.
The two other causes considered — a scan depth of twenty runs being too
shallow, and cold runs being skipped as baselines — are ruled out for these
instances by the same fact: the walk never reached the point of reading a run.

## The instances

| When (UTC) | Pull request | Run, attempt | Newest run the listing named | Outcome |
| --- | --- | --- | --- | --- |
| 2026-09-15 21:47:32 | #7514 | 35026480095, 1 | 35024516711 (2026-09-15T21:15:08Z), the base-branch commit's own | gated: `OVER: 1, OK: 2, excl: 36` |
| 2026-09-15 21:50:32 | #7514 | 35026480095, 2 | 32577018558 (2026-08-22T13:52:12Z) | not gated: `excl: 39` |
| 2026-09-17 18:07:42 | #7658 | 35254926993, 1 | 32577018558 (2026-08-22T13:52:12Z) | not gated: `excl: 39` |
| 2026-09-17 19:17:47 | #7659 | 35263129242, 1 | 32577018558 (2026-08-22T13:52:12Z) | not gated: `excl: 39` |
| 2026-09-17 19:32:40 | #7658 | 35263520215, 1 | 32577018558 (2026-08-22T13:52:12Z) | not gated: `excl: 39` |
| 2026-09-17 20:03:37 | #7663 | 35265514747, 2 | 35265577111 (2026-09-17T19:33:21Z) | gated: `OK: 1, excl: 38` |

The first two rows are the same job of the same run, re-run three minutes
apart, merging the same base-branch commit `cbeb9d92`. The first attempt got a
current listing, found that commit's own run at the head of it, and failed the
pull request on `packages/runner`. The second got the August window and passed.
Nothing else differed between them, which is what isolates the listing.

What `main` actually held at those moments, read from each run directly by its
id:

- `cbeb9d92`: run 35024516711, `push` to `main`, success, created
  2026-09-15T21:15:08Z, finished 21:31:16Z — nineteen minutes before the
  ungated attempt. No successful `main` run was newer. Twenty-four of that
  commit's nearest twenty-five ancestors had a successful run as well.
- `c4a5de33`: run 35243456780, `push` to `main`, success, created
  2026-09-17T15:56:24Z, finished 16:27:13Z — an hour and forty minutes before
  the earliest of the three ungated jobs. No successful `main` run was newer at
  any of the three.

Between run 32577018558 and those moments `main` had more than a thousand newer
successful push runs. That run is otherwise ordinary: the same workflow id
(147950565), the same repository id, and unremarkable neighbors a few minutes
either side of it.

## What the stale response is

The same run heads the stale window on both days, although by the second day it
had sixty-seven more successful runs ahead of it. A lagging index would have
moved; this reads as a copy that stopped updating around 2026-08-22T14:00Z and
is still served to some requests. The repository was renamed between the two
days, from `commontoolsinc/labs` to `commonfabric/labs`, and the stale window
came back under both names, so the rename is not the cause. The workflow has a
single record, which rules out a second workflow of the same file name.

GitHub's documentation says a listing that carries one of the `actor`,
`branch`, `check_suite_id`, `created`, `event`, `head_sha` or `status`
parameters "will return up to 1,000 results for each search". That cap is
observable: page eleven of the filtered listing at a hundred runs to the page is
empty with a `total_count` of `0`, while page eleven of the unfiltered listing
is full. The two are served by different machinery, and only the filtered one
has been seen to go stale.

It could not be reproduced on demand. Twenty requests with a user token on
2026-09-17 around 20:45Z, across both repository names and both ways of naming
the workflow, all returned the current listing. The jobs use the workflow's own
token, and the only observations of the stale window are theirs. Earlier the
same day a local `gh run list --branch main --workflow CI` — a filtered listing
too — returned the August run as newest, and a direct request minutes later did
not.

## Why nobody saw it

The job's log did carry a warning in the stale cases:

```text
Warning: newest successful baseline run is not for the current main head.
  Warning: Newest successful baseline run 32577018558 (2026-08-22T13:52:12Z) is for 872ef3e5…, but current main is c4a5de33….
```

The same warning is printed on nearly every healthy run, because the run for
the newest commit on `main` has rarely finished when a pull request's job asks,
so it carried no signal. Everything after it read as a pass: a green job, the
closing line "Coverage debt within the ratchet for every changed group.", no
annotation, no comment on the pull request. The one place that said otherwise
was the header of a collapsed table.

On #7514 the consequence was concrete. The author had added an
`ACCEPT_COVERAGE_DEBT` line and re-run the job to have it take effect, and the
pass that followed was read as the acceptance working. It had not been
exercised at all.

## What the listing can be checked against

An unfiltered listing includes the run that is asking, since that run exists
before its Coverage Check job starts. Across six consecutive pages read on
2026-09-17 — six hundred runs, about two days — the listing was strictly
newest first by id and never out of order by `created_at`, and a re-run stayed
at its original position. So a listing can be held to a simple test that needs
no clock: it shows the asking run ahead of every run with a smaller id. A
listing that stopped in August fails that test on its first page.

The same six pages give the cost of reading the listing unfiltered. A hundred
runs span between two and eighteen hours depending on the time of day, between
eight and twenty-three of them are pushes to `main`, and a page with the pull
request details left out is about 1.3 MB.

## Evidence

The job logs quoted above are those of the runs and attempts named in the
table. Each `main` run's state was read with
`GET /repos/commonfabric/labs/actions/runs/{id}`, which is not a listing.
