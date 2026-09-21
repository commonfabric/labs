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
`cancelled` rather than `failure`, and a wedged test then looks like a run
somebody stopped. A step that runs past the bound on the step fails, and the
job fails with it.

Both aliases point at YAML anchors declared in the `env:` block at the top of
the file, which is where the minutes themselves are written. Add a work step
and you add the alias, not a number; a job that needs its own bound adds a pair
of anchors there, as the CLI integration suites have. The deploy jobs are the
exception and carry no bound, because a deploy's duration is set by a script in
another repository. `tasks/ci-workflow.test.ts` names those and holds every
other job to the shape: it fails the `Check` job when a bound is missing, when
it is written as a number rather than an alias, or when a step's anchor is
fewer than ten minutes below its job's.

## A compile cache is keyed on a resolved fingerprint, never on `hashFiles`

A job that points the compiler at a cache file with `CF_COMPILE_CACHE_FILE`
resolves the compiler-input fingerprint first, in a setup step that uses the
`./.github/actions/compile-cache-key` composite action under the step id
`compile-cache-key`, and keys that file's `actions/cache` entry on that step's
`fingerprint` output. Enumerating the compiler's inputs in a `hashFiles(...)`
call instead puts a second description of `COMPILE_FINGERPRINT_INPUTS` in this
file, and the two drift.

"every compile byte cache is keyed on the compiler fingerprint" in
`tasks/ci-workflow.test.ts` holds all of that, including the step order: a cache
step ahead of the step that resolves the value gets an empty segment in its key,
which collapses entries from different compilers onto one another. "The Pattern
Compile Cache Key" in `docs/development/CI_PERFORMANCE.md` has the rest.

## A test job ships test records

Every job that runs tests sets `CF_TEST_RECORDS_DIR` to a workspace spool
and ends with a `📤 Ship test records` step using the
`./.github/actions/test-records-ship` composite action, `if: always()`,
with the job's display name, its matrix leg in `artifact:`, and a
`--junit` specification when the job produces JUnit XML. Command-level
steps wrap their command in `deno task run-recorded <kind> <scope> <name>
--`. The contract is `docs/specs/test-records.md`; the wiring recipe is
"Covering a new test surface" in `docs/development/test-records.md`. A job
without the ship step runs fine and records nothing — which is how a new
job silently falls out of the flake and duration history.

A job whose every test another workflow already records against the same
commit is the exception, and it records nothing: no spool directory, no
`run-recorded` wrapper, no ship step. Recording there would file each of
those tests twice against one commit. The Dashboard workflow's tests job
is the one such job, and the relay does not follow that workflow. The
exemption covers tests, not jobs, so a test that runs only in such a job
is recorded there.

A check that no lane can be asked to run is the other exception, and it
records nothing either: no spool directory, no `run-recorded` wrapper, no
ship step. `docs/specs/test-records.md` under "Recording" holds the
criterion. Three checks are of that shape. The `Coverage Check` job in
`deno.yml` reads the coverage artifacts of every test job in its own run,
the `Test Topology Store Check` job beside it reads those jobs' records,
and the CFC Property Suite's audit step reads the corpus the suite in the
step before it has just written. A gate comparing against a base ref is
not this: `check-baselines-append-only` and `check-test-aliases` each
resolve a merge base, and both record.

Which of a job's steps are wrapped is a separate question from either
exemption. A wrapper records the command under it, so it belongs on a
command that is itself the check and not on one whose own tests are the
checks — the wrapper passes recording through, so a wrapped test command
files a summary of the invocation beside whatever its tests record. The
CFC Property Suite's test step is the case to learn from: it runs
`deno test` directly, which without a `--junit-path` to ingest records
nothing, so its wrapper's line was the job's only record of a step whose
tests CI records through `workspace-unit`. That step and the audit step
together leave that workflow taking no part in test records at all.

## Before splitting or rebalancing jobs

`docs/development/CI_PERFORMANCE.md` says when that work is worth starting and,
more usefully, when to stop. Read it first; the answer is often that the jobs
are already close enough.
