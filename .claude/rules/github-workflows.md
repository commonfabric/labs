---
paths:
  - ".github/workflows/**"
---

# Editing a CI workflow

## A deploy step has a counterpart outside this repository

The deploy jobs open an SSH connection to the bastion and run one script there.
That script belongs to the infra repository, not this one, so a change to what
a job passes it only works once the matching infra change has landed and been
deployed. `docs/development/deploying.md` describes which jobs deploy where and
what the wrapper accepts.

The staging deploy jobs trigger on pushes to `main`, so a change to one of them
cannot be exercised on a branch. Reason it through before merging rather than
after.

## Step names carry a phase marker

A step is placed into a phase — setup, build, test, upload — by the marker
emoji its name begins with. The vocabulary is defined in
`docs/development/CI_PERFORMANCE.md` under "Step phase markers" and mirrored in
`PHASE_MARKERS` in `tasks/ci-step-phases.ts`. A step whose name starts with a
marker that is in neither list is silently charted as "other", which is how
setup time disappears from the timings people use to decide what to optimize.
Adding a marker means editing the document and the module together.

## A work step carries its own timeout

In `.github/workflows/deno.yml`, every step whose marker puts it in the work
phase carries `timeout-minutes: *work-timeout`, and its job carries
`timeout-minutes: *job-timeout`, which is the ten minutes longer. GitHub
cancels a job that runs past the bound on the job, so that job's conclusion is
`cancelled` rather than `failure`, and a test that hangs then looks like a run
somebody stopped. A step that runs past the bound on the step fails, and the
job fails with it.

Both aliases point at YAML anchors declared in the `env:` block at the top of
the file, which is where the minutes themselves are written. Add a work step
and you add the alias, not a number; a job that needs its own bound adds a pair
of anchors there. The deploy jobs are the exception and carry no bound, because
a deploy's duration is set by a script in another repository.
`tasks/ci-workflow.test.ts` names those and holds every other job to the shape:
it fails when a bound is missing, when it is written as a number rather than an
alias, or when a step's anchor is fewer than ten minutes below its job's.

The `tests` job takes the same two aliases: 30 minutes for the lane step and 40
for its job. Neither is a lane's budget. A lane packs its work against a budget
`tasks/test-selection/policy.ts` derives from `LANE_BOUND_SECONDS` or
`FULL_LANE_BOUND_SECONDS`. Those are what a lane is packed to finish inside, not
bounds it is stopped at. The step bound only stops a lane that hangs. A lane
whose mandatory work passes its budget runs long and says by how much in its
job log, rather than being stopped with its later batches unrun. Changing a lane
bound in `policy.ts` changes no timeout in `deno.yml`.

## A compile cache is keyed on a resolved fingerprint, not on the compiler's inputs listed in `hashFiles`

The `tests` job keeps the pattern compile byte cache under `.ci-cache/compile`.
It resolves the compiler-input fingerprint first, in a setup step that uses the
`./.github/actions/compile-cache-key` composite action under the step id
`compile-cache-key`, and key that directory's `actions/cache` entry, and its
restore prefix, on that step's `fingerprint` output. Enumerating the compiler's
inputs in a `hashFiles(...)` call instead puts a second description of
`COMPILE_FINGERPRINT_INPUTS` in this file, and the two drift. The key also
carries a `hashFiles()` over the pattern sources, so that a lane that restored
an older entry saves a fresher one. Each built Toolshed binary is kept under
`.ci-cache/binaries/<name>`, keyed on what `tasks/binary-cache-key.ts` prints in
a step of its own, under an exact key with no restore prefix.

"a lane keeps each binary under an exact key and its compile cache by compiler"
in `tasks/ci-workflow.test.ts` holds all of that, including the step order: a
cache step ahead of the step that resolves the value gets an empty segment in
its key, which collapses entries from different compilers onto one another. "The
Pattern Compile Cache Key" in `docs/development/CI_PERFORMANCE.md` has the rest.

## Tests are suites of the topology, not jobs

`deno.yml` names no test. Every test, and every repository gate a lane can run,
is a suite of the test topology, `tasks/test-topology.ts` and the modules under
`tasks/test-topology/`, and the `tests` job runs them through
`tasks/ci-lane.ts`. Adding a test, a kind of test, or a configuration of
existing tests is a change to the topology and never a new job or step here. The
wiring recipe is "Covering a new test surface" in
`docs/development/test-records.md`, and the jobs are described in "How
continuous integration runs the lanes" in `docs/development/test-selection.md`.

The lanes ship the records. Each lane gathers and marks its batches' records
itself and ends with a `📤 Ship test records` step using the
`./.github/actions/test-records-ship` composite action, `if: always()`, with no
`variant` and no `junit` input. The contract is `docs/specs/test-records.md`.

No workflow step records a test by hand. A step that wraps a command in `deno
task run-recorded <kind> <scope> <name>` records one of two things. Either it
records a check a suite already runs, so that check is recorded twice against
one commit, or it records a check no lane will ever run or select. The workflow
half of `deno task check-test-topology` fails on every identity such a step
records, and says which of the two it is.

A job whose every test another workflow already records against the same
commit records nothing: no spool directory, no `run-recorded` wrapper, no ship
step. Recording there would file each of those tests twice against one commit.
The Dashboard workflow's tests job is the one such job, and the test-records
relay (`.github/workflows/test-records-relay.yml`) does not follow that
workflow.

A check that no lane can be asked to run records nothing either.
`docs/specs/test-records.md` under "Recording" holds the criterion. Three checks
are of that shape. Two are steps of `Status` in `deno.yml`: the coverage gate,
which reads the coverage artifacts of every lane in its own run, and the store
half of the topology's drift guard, which reads those lanes' records. The third
is the CFC Property Suite's audit step, which reads the corpus the suite in the
step before it has just written. `Status` ships only the coverage measurements a
push run writes, which are measurements rather than records of a check. A gate
comparing against a base ref is not this: `check-baselines-append-only` and
`check-test-aliases` each resolve a merge base, and both run in a lane and
record.

Outside the workflows, `deno task run-recorded` belongs on a command that is
itself the check, and not on one whose own tests are the checks. A gate that a
suite of the topology runs is one such command, and so is a local `deno task`
run of a check. A wrapper records the command under it and passes recording
through, so a wrapped test command files a summary of the invocation beside
whatever its tests record. The CFC Property Suite's test step runs `deno test`
directly and unwrapped, since `workspace-unit` records those tests; it and the
audit step leave that workflow taking no part in test records at all.

## Before changing how the lanes are sized

There are no jobs to split or rebalance by hand: the lanes pack every test by
its measured cost. What decides a lane's wall time is the lane dials in
`tasks/test-selection/policy.ts` — `LANES`, `LANE_BOUND_SECONDS`,
`LANE_SAFETY_SECONDS`, `FULL_LANE_BOUND_SECONDS` and `FULL_LANES_MAX` — and
"Every dial" in `docs/development/test-selection.md` gives the reason to move
each. `docs/development/CI_PERFORMANCE.md` says when changing them is worth
starting. Read it first.
