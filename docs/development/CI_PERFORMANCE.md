# CI Performance Policy

This repo tracks GitHub Actions wall time so CI optimization work is driven by
trend data, not one-off slow runs. Use this policy to decide whether CI's test
runs need changing, and which dial in `tasks/test-selection/policy.ts` to move.

## Current Posture

CI runs every test through lanes. `.github/workflows/deno.yml` names no suite.
Each job of its `tests` matrix is a lane and runs `tasks/ci-lane.ts`, which
reads the test topology, packs the work into lanes by what each test has cost
before, and runs its own share. A pull request runs five lanes over a
selection. A push to `main`, a pull request labelled `ci: full`, and the
tomorrow's-order run run every test over as many lanes as the full run needs.
[The test-selection
guide](test-selection.md#how-continuous-integration-runs-the-lanes) describes
the jobs.

Nobody assigns tests to lanes by hand. How the work
divides among lanes is arithmetic over costs the record store measures on every
run, and a test that gets slower moves the packing on the next publish with
nothing edited. What governs a lane's wall time is a small set of dials in
`tasks/test-selection/policy.ts`, which [every
dial](test-selection.md#every-dial) lists with the reason to move each:

- `LANES`, how many lanes a pull request takes.
- `LANE_BOUND_SECONDS` and `LANE_SAFETY_SECONDS`, which with the fixed
  prologue decide what a pull request's lane packs against.
- `FULL_LANE_BOUND_SECONDS`, the same for a lane of the full run, which decides
  how many lanes the full run needs.
- `FULL_LANES_MAX`, the most lanes the full run takes.

GitHub's Team plan allows the organization
[60 parallel hosted runners](https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners).
That capacity is shared by every workflow and repository in the organization.
Keep the first dependency-free wave of this workflow below half the limit so
two overlapping runs do not queue behind one another and later jobs can start
as soon as their dependencies finish. `FULL_LANES_MAX` holds the full run's
lanes to the same half. `tasks/ci-workflow.test.ts` checks both.

## Required Pull Request Checks

Configure merge protection to require `Status`. The GitHub web interface shows
that check as `CI / Status`, joining the workflow's name to the job's name, but
merge protection stores and matches the job's name on its own.

`Status` runs on a pull request and on a push, after `plan-full` and `tests`.
It runs after failed and skipped dependencies, and not on a cancelled run. It
fails unless every dependency succeeded or was skipped. It also fails unless
`tests` succeeded, since a run whose lanes were skipped has not passed its
tests. Its steps also hold the run's records to the topology and, on a pull
request, hold the measured sets to their baselines; either can fail it. Do not
require the lanes themselves. Each lane's name, `Tests (N/M)`, carries a lane
count, and the full run's count changes from run to run. A new kind of test is
a suite in the topology rather than a job, so `Status`'s `needs` list does not
grow.

Keep pull request path filters out of workflows that provide required checks.
GitHub leaves a required check pending when a path filter prevents its workflow
from starting.

Require checks from other GitHub Apps separately. A GitHub Actions job cannot
depend on a check produced by another app.

## Revisit Triggers

Revisit CI wall time when at least one of these holds across normal runs:

- A pull request's lanes regularly run past five minutes, setup included, the
  bound `LANE_BOUND_SECONDS` states.
- The lanes of one run finish far apart: the slowest more than 50% slower than
  the rest, and at least 30 seconds slower in absolute terms.
- The full run takes `FULL_LANES_MAX` lanes and they still run past their
  budget.
- Required checks take more than 8 minutes from first start to last completion.

## How To Respond

1. Start from the job summaries of the lanes in question. Each says what the
   lane packed, what it expected each batch to cost, and how much of that rested
   on tests nothing had measured. The job log says how far a mandatory set was
   projected past the budget.
2. Prefer repeated runs over a single outlier: the dashboard's CI view
   ([Pulling Timing Data](#pulling-timing-data)), and the test-selection
   publisher's summary.
3. Where lanes run past what they were packed against, read what the cost model
   holds before anything else. [When the cost model is
   empty](test-selection.md#when-the-cost-model-is-empty) says how to read it.
   The publisher refits these figures from each run's records; nobody edits
   them.
4. Where one test takes most of a lane's time, split the test. A single test cannot be
   split by the packer, and the sixty-second list in the test-record report
   names the candidates.
5. Move a dial only for the reason its row in [every
   dial](test-selection.md#every-dial) gives.

Good CI optimization PRs should reduce critical-path wall time without making
the workflow harder to reason about.

For the pattern integration suites specifically, the time is dominated by
per-pattern CFC compile, not by storage or sync — see [the profiling
snapshot](../history/development/performance/pattern-integration-compile-bound.md)
before optimizing there.

## Pulling Timing Data

The labs repository is public, so the GitHub Actions REST API returns run, job,
and per-step timings unauthenticated — no `gh` or token needed. Logs and
artifacts do need an admin token. Per-test timings are in the test-record store,
which is public; [test-records.md](test-records.md) says how to read it.

Jobs and steps for a run:
`GET /repos/commonfabric/labs/actions/runs/<run-id>/jobs?per_page=100` — each
job and step carries `started_at` and `completed_at`.

The team ops dashboard's `/bench?view=ci` page provides repeated-run analysis
for labs and loom. It reports overall workflow duration and individual job
duration. Matrix jobs are grouped using the trailing-parenthesis base names from
`scripts/ci-gantt.ts`, so every lane, `Tests (N/M)`, charts in one `Tests`
group, with the slowest lane tracked across runs to expose persistent
imbalance.

For a requested history window, the collector retains every successful main
push build when there are at most 200. Larger sets are sorted chronologically
and reduced to exactly 200 builds spread evenly through that run sequence,
including its oldest and newest builds.

## Step Phase Markers

`scripts/ci-gantt.ts` draws each job as a bar and splits that bar into three
segments — setup, work, and shutdown — so the shared scaffolding around a job is
visually separated from the job's own work. For the lane jobs this shows, per
lane, how much wall time is setup that every lane repeats versus the unique work
that one lane does.

When the chart contains one workflow run, it draws every execution of a rerun
job on the same row at its actual time. Each bar carries its own duration
beside it, and its tooltip names the attempt and how that attempt ended. Failed
attempts end in a red cross, and the delay before a retry stays blank. Charts
covering several workflow runs use the latest execution of each job from each
run when calculating their aggregate bars.

The chart decides a step's phase from the emoji its name starts with. The emoji
is the marker: the script never reads step wording, only the leading emoji. Every
step we control — in `.github/workflows/*` and in the composite actions under
`.github/actions/*` — must begin with a marker emoji from the table below, and
each emoji belongs to exactly one phase. When you add a step, pick an emoji whose
phase matches what the step does. When you add a genuinely new kind of step,
choose a new emoji, then add it to both this table and the `PHASE_MARKERS` array
in `tasks/ci-step-phases.ts`, keeping the one-emoji-one-phase rule.

**setup** — fetch code, install tools and dependencies, restore caches,
authenticate, and bring test servers and devices up before the real work:

| Emoji | Used for |
| --- | --- |
| 📥 | checkout, download inputs |
| 🦕 | set up Deno |
| 🔍 | verify the lock file and install, resolve refs |
| 📦 | install packages, cache dependencies |
| ♻️ | restore or save a build cache |
| 🛡️ | relax the sandbox for browser tests |
| 🔧 | enable a device |
| ⚙️ | set up an external SDK |
| 🔑 | authenticate to a cloud |
| 🔌 | start a local server for tests |
| ⏳ | wait for a service to be ready |
| 💾 | restore or save a cache |
| 🗃️ | restore a cached native library |
| 🧮 | compute a cache identity |

**work** — the job's actual purpose:

| Emoji | Used for |
| --- | --- |
| 🔎 | checks (format, type, patterns, attestations) |
| 🚧 | guard that fails the build on a banned pattern |
| 🩹 | check for unresolved merge-conflict markers |
| ✅ | validate an artifact a previous step produced |
| 🗺️ | plan a run's lanes, or what one lane runs |
| 🧪 | run tests |
| 🧩 | run integration tests |
| 🔁 | replay captured fixtures under today's source |
| 🧹 | lint |
| 🧭 | check skill facts |
| 📄 | type-check docs |
| 🏗️ | build binaries or assets |
| 🏋️ | run benchmarks |
| 📊 | produce performance metrics or status reports |
| 🧬 | combine coverage |
| 📝 | generate attestations |
| 🔐 | sign binaries |
| 🚀 | deploy |
| 💬 | post a pull-request comment |

**shutdown** — post-work reports, artifact uploads, log capture, teardown:

| Emoji | Used for |
| --- | --- |
| 🧾 | write a coverage report |
| 📤 | upload artifacts |
| 📋 | capture logs on failure |

A few markers were chosen so the phase stays unambiguous, which is worth knowing
before you "correct" a step name back to a more obvious emoji:

- 🚀 means deploy, which is work. A step that starts a local server for tests is
  setup, so it uses 🔌 instead of 🚀. A step that uploads artifacts to cloud
  storage is shutdown, so it uses 📤.
- 🔍 means verify-then-install, which is setup. Verifying binary attestations is
  work, so that step uses 🔎.
- Downloading logs after a failure is shutdown, so those steps use 📋 rather than
  the 📥 or 📦 download markers.

The steps the runner injects into every job carry no marker, so the script
classifies them by name. Current jobs use `Set up job`, `Post …`, and `Complete
job`. Retained records can also contain `Set up runner` and `Complete runner`.
The two set-up steps count as setup and the rest as shutdown. Any other step
that reaches the chart without a recognized marker is counted as "other", drawn
in gray, and listed on standard error when the script runs, so a missing marker
is easy to find and fix.

## Cache Keys And Post-Job Saves

The combined `actions/cache` action restores during setup and saves in a
post-job step. GitHub evaluates expressions in the action's inputs again for
that save. A `hashFiles()` call written directly in `with.key` therefore walks
the checkout twice: once before the work and once after it.

When a job writes a large generated tree under the checkout, that second walk
can become much more expensive than the first. The lanes are the important case
here: raw V8 coverage can contain hundreds of thousands of files by the time
post-job steps run.

Resolve any workspace-wide dependency hash in an ordinary setup step and write
it to `GITHUB_OUTPUT`. Give the cache action that step output as its key. The
post-job save can reevaluate the output reference safely because its value was
fixed before the job populated the workspace. The `deno-setup` composite action
uses this shape for the shared Deno dependency cache, and the lanes use it for
their own caches: `tasks/binary-cache-key.ts` resolves the key each built
Toolshed binary is kept under, `.ci-cache/binaries/<name>` with the exact key
`lane-binary-<name>-<binary cache key>`, and the compiler fingerprint keys the
pattern compile byte cache. Each binary has an entry of its own because a lane
builds only the ones it needs, and one entry holding both would keep whichever
the first lane to save happened to build.

### The Pattern Compile Cache Key

The lane jobs restore a pattern compile byte cache from `.ci-cache/compile` in
one `actions/cache` step, keyed `cc-lane-<fingerprint>-tests-<lane>-<hash>` with
the restore prefix `cc-lane-<fingerprint>-`, where the hash is a `hashFiles()`
over `packages/patterns` and `packages/generated-patterns`. The fingerprint is
the compiler-input fingerprint. The runtime's version axis is `cf/esm-compile/`
followed by that same fingerprint, so a compiled document is stored under
`compileCache:cf/esm-compile/<fingerprint>/<identity>`. A cache entry CI names
by the fingerprint therefore holds bytes the compiler now running emitted, and
an entry from any other compiler is one the lanes never ask for. The prefix lets
a lane restore a cache another lane or an earlier commit saved. That costs only
the restore time, because a compiled pattern is reused only where its source is
unchanged. The hash of the pattern sources is what makes a
lane that restored an older entry save a fresher one: an entry an exact key hits
is never saved again. Unlike the fingerprint, that hash is written in the key as
a `hashFiles()` call over those two trees alone, so the post-job save walks them
a second time and nothing else.

The fingerprint is not written into the workflow as a literal. The lane job
resolves it in a setup step, through the `./.github/actions/compile-cache-key`
composite action, which runs `tasks/compile-cache-key.ts` and offers the value
as its `fingerprint` output. The cache step then references that step's output.
This is the shape [Cache Keys And Post-Job Saves](#cache-keys-and-post-job-saves)
prescribes, and it buys two things here. The
post-job save re-evaluates the key without walking the fingerprinted trees a
second time. And the CI key and the runtime version become one value computed
once, rather than two descriptions of one list of inputs that can drift apart.

`COMPILE_FINGERPRINT_INPUTS` in
`packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts` is the list
being hashed, and it is the only place that list is written down. Changing what
shapes the emitted bytes means editing it there; nothing in the workflow
enumerates those inputs, so nothing in the workflow has to be changed to match.
That module's own source is in the list, so changing how the fingerprint is
computed moves it too.

Each lane records whether it found the cache restored:
`writeCompileCacheState()` in `tasks/ci-lane.ts` writes `cold` or `warm` beside
the lane's coverage reports, and
[COVERAGE.md](COVERAGE.md#compile-cache-state-and-cold-runs) says what reads it
and why a cold run's coverage differs.

What the workflow is held to is where the value comes from. "a lane keeps each
binary under an exact key and its compile cache by compiler" in
`tasks/ci-workflow.test.ts` fails when the compile cache's key or restore prefix
does not carry the action's output, or when the job resolves it after the cache
step — which would leave the key holding an empty segment and collapse entries
from different compilers onto one another. The action fails the job outright if
the script prints nothing, so an empty segment cannot reach a key.

## Step And Job Timeouts

Every work step in `.github/workflows/deno.yml` carries its own
`timeout-minutes`, and the `timeout-minutes` on the job around it is at least ten
minutes larger. The two bounds do different things when they are reached.
GitHub ends a job that runs past the bound on the job by cancelling it, so the
job's conclusion is `cancelled` — the conclusion that a run stopped by hand or
superseded by a newer push also carries, and one that reads as nobody's fault. A
step that runs past the bound on the step fails, and its job fails with it. The
headroom between the bounds is what the setup and upload steps around the work
normally need. An individual step that hangs can therefore reach its step bound
and report a failure before the outer job bound. The outer bound remains the
final limit when several steps in one job consume unusual amounts of time.

The runner enforces the step bound, so the bound holds only while the runner is
still responding. A job whose runner stops responding runs to the bound on the
job, is cancelled, and keeps no log at all. Running out of memory is one way to
get there. The runner raises the out-of-memory score of every process a step
starts, so that when memory runs out the kernel kills one of those rather than
the runner. Swap puts that kill off until the swap file is full as well, and
while it fills, the machine pages to disk and everything on it slows, the runner
included. So the `deno-setup` composite action turns swap off in every job that
uses it on a GitHub-hosted Linux runner. A job that runs out of memory there
loses a test process and fails in a step that keeps its log. The cost is the
memory the swap file added: a job that needs more than the machine has fails
rather than passing slowly. A self-hosted machine is not reconfigured, because
it outlives the job.

The minutes are written once. The top of the workflow declares them as YAML
anchors, which GitHub Actions has accepted since September 2025:

```yaml
env:
  WORK_TIMEOUT_MINUTES: &work-timeout 30
  JOB_TIMEOUT_MINUTES: &job-timeout 40
```

Every job then reads `timeout-minutes: *job-timeout` and every work step
`timeout-minutes: *work-timeout`. Changing either bound is one edit. The
environment variables are how a workflow declares a value an anchor can name;
nothing reads them, and merge keys (`<<:`) remain unsupported, so an anchor
cannot carry a block that a job then overrides.

The lanes take the same two bounds as every other bounded job, and neither is a
lane's budget. A lane packs its work against a budget derived from
`LANE_BOUND_SECONDS`, five minutes, for a pull request, and from
`FULL_LANE_BOUND_SECONDS`, ten, for the full run. The step bound only stops a
lane that hangs. A lane's mandatory work can exceed its budget, for example when
a change forces a large measured set or the full run is capped at
`FULL_LANES_MAX`. Such a lane runs long rather than being stopped with its later
batches unrun and unmeasured, and its job log says how far its plan was
projected past the budget. So moving either lane bound in `policy.ts` moves
nothing in the workflow.

A lane its step bound does stop loses little. The lane appends each batch's
records to its spool as the batch ends, and the ship step runs whatever the lane
step did. So a lane stopped by its step bound loses only the records of the
batch it was running.

The deploy jobs carry no bound at all. A deploy hands the work to a script that
lives outside this repository, and a bound here would cancel a deploy this
workflow has no way to size. `tasks/ci-workflow.test.ts` names those jobs and
asks nothing of them.

For every other job, that test fails when a work step has no bound, when a job
has none, when a bound is written as anything but an alias to an anchor, or when
fewer than ten minutes separate the step's anchor from its job's.

## Serial Test Files

A slow package may be running many independent test modules one after another.
Deno's `--parallel` mode can reduce that package's wall time, but only after
checking for tests that share process-wide state.

Deno runs each parallel test file on its own thread of a single process, so
"process-wide state" means state every file shares: environment variables,
replaced globals, and the current directory. A test that only configures a CLI
it spawns shares nothing — `cf` in `packages/cli/test/utils.ts` takes the
command's environment as an argument and gives it nothing else, so those tests
stay in the parallel group.

Among the serial CLI tests, and why each is serial:

- `test/completion-output.serial.test.ts`,
  `test/completion-providers.serial.test.ts`, `test/fuse.serial.test.ts`,
  `test/inspect-remote.serial.test.ts`, `test/log-level.serial.test.ts`,
  `test/main-command.serial.test.ts`,
  `test/test-runner-compile-byte-cache.serial.test.ts`,
  `test/test-runner-pattern-coverage.serial.test.ts`, and
  `test/wish-command.serial.test.ts` set an environment variable that the test
  process itself then reads, so another file setting the same name would
  decide what they read.
- Every `test/view-commitmsg-*.serial.test.ts` file is serial because some
  tests in the family install Git shims by changing process environment.
- `test/json-command.serial.test.ts` and
  `test/runtime-creation.serial.test.ts` replace globals — the console methods
  and runtime prototype methods.
- `test/view-mod-gate.serial.test.ts` changes into a removed directory to test
  the missing-current-directory fallback.
- `test/view-pager-pty.serial.test.ts` drives a real pseudo-terminal, spawning
  a full CLI child per test. Keystrokes are gated on observed child output
  rather than on timing, so contention slows it but does not flake it; it is
  serial to avoid stacking those children on top of the parallel files.

A serial CLI test file is named `*.serial.test.ts`. The package's `deno-test`
task passes `tasks/run-test-batches.ts` a `--serial` option naming that pattern,
so the runner runs those files after the rest, in a `deno test` without
`--parallel`, and runs the rest of the package's test modules with `--parallel`.
A lane that selects some of the CLI's files splits them the same way.
