# Test-run records

The contract of the test-run record system: what a test's identity is, what
a record and a run context contain, how records move from a producer to the
store, and what the store guarantees. This is the normative description of
the shipped system; [the operating
guide](../development/test-records.md) says how to use it, and
[the adoption guide](../development/test-records-adoption.md) how another
repository joins it. [The plan this system came
from](../history/plans/test-run-telemetry.md) is archived, and carries the
reasoning that shaped what follows. The shared implementation is
`base/test-support/src/records/`.

## Identity

A test's identity has three required parts, scoped within a repository:

- **kind** — the class of check: `unit`, `browser`, `pattern`,
  `integration`, `typecheck`, `lint`, `format`, `gate`.
- **scope** — the workspace member that owns the test, or `repo` for
  repository-level checks.
- **name** — the full name the test's own runner reports: for a test
  registered through `@commonfabric/test-support/test`, the names of the
  `describe`s enclosing it and its own, joined with `" > "`, and for a step
  a test runs, the test's name and the step's joined the same way; a
  pattern test's repository-root-relative file path with forward slashes, a
  task name, a script's own name (`acl.sh`), a script step
  (`integration.sh piece-values`), or a task-plus-item pair
  (`cfcheck <file>`, `pattern-compat <key>`,
  `pattern-vintage <testKey> <tier> <stamp>`). A name a call carries stands
  even where it is empty, so a chain can hold an empty element. Deno
  refuses an empty name for the outermost registration of a file, so an
  empty element is never the first.
- **variant**, when present — a stable name for a non-default configuration
  that runs the same test. The default configuration has no variant. The
  server-execution deployed-topology lanes have stable `default` and
  `opposite` roles. `default` follows the first-party constant and remains
  unmarked; `opposite` receives the marker for the posture it actually runs:
  `server-execution` for ON or `server-execution-off` for OFF. Which
  posture is unmarked follows the constant (the registry's summary table
  states it); each marker is the continuous history of its posture whenever
  that posture is not the default, across flips in either direction. The
  claim is
  deliberately narrow: the
  single-process default jobs (the unit suites, `cf test`, the no-server
  pattern-unit lane — the `patternTest` / `unitTest` presets) never read
  the first-party default and stay ambient-OFF by construction, so they
  are unmarked because the flip does not reach them, not because they run
  ON.

Identity survives moving a test between files, splitting or renaming test
files, reformatting, editing bodies, and resharding — shard and slice
labels, and the section that dispatched a script step, are run context and
never identity. A configuration is a variant only when its results need a
separate history. Identity does not survive a change to the reported name; a
rename splits history, and a line appended under
`tasks/test-identity-aliases/` bridges a split worth bridging. That
directory holds files named after test files — by last path segment, so test
files of one name share a file — plus `whole-scope.jsonl` for whole-scope
lines and `moved-paths.jsonl` for moved-path lines, and reads as a single set
of aliases. A moved-path line maps the repository-relative path of a directory
or a file to the path it moved to. It renames that path wherever an identity's
name holds it as a path of its own, in every kind and scope. Moving a directory
therefore takes one line, however many names spell its path. When two moved
paths both occur in a name, the longer one applies. A moved path applies to a
given name at most once. The directory is append-only file by file. It maps any
identity at most once, holds no cycles, and never moves a path into a path that
contains it. Each line carries the rename's date. Readers resolve aliases
transitively, and apply each one only to records older than its date.
`deno task check-test-aliases` enforces the directory's shape. Alias lines
other than moved-path lines name the three required identity parts, and every
line applies its rename to every variant.

A task-level record may coexist with the per-item records of the same run
(`pattern-compat` beside `pattern-compat <key>`, `integration.sh` beside
`integration.sh <step>`); the item records carry the task name as a
prefix, and the two are distinct identities. The task name is the task's
own, never the label of the slice or section CI dispatched — a task-level
record that took its name from the dispatch would both rename itself
whenever the work is re-sliced and, where a section and an item share a
label, report under that item's identity.

## Records and contexts

An uploaded object is gzip-encoded NDJSON (`Content-Encoding: gzip`, so a
plain HTTPS reader receives text): one context line, then one record line
per test execution. A rollup shard concatenates a share of a day's such
reports; in every object, a context line opens a report and each record
line belongs to the report whose context most recently preceded it, which
is how per-report provenance — the fork flag among it — survives
compaction.

```json
{ "line": "record", "test": { "k": "unit", "s": "bakery", "n": "glaze > thickens when heated" }, "outcome": "pass", "durationMs": 12 }
```

The compact identity fields are `k`, `s`, `n`, and optional `v`. Omitting
`v` means the default configuration. Readers retain the existing
`[k,s,n]` grouping key for unmarked records and append `v` as a fourth part
only when it is present.

A record carries `outcome` (`pass`, `fail`, or `skip`), `durationMs` from the
runner's own measurement (never a clock a test can replace: several packages
fake the clock inside the test process, and the test module reads the real one
before any test runs), and optionally `file`, the repository-relative source
path when the producer reliably knows it — metadata, not identity. A reader
drops a record whose `file`, or whose name where the kind is `pattern`, is
absolute or climbs above the repository root. Such a path names a file outside
the repository, and no test of the repository lives there. A `cfcheck` item's
duration is what the batch spent on that pattern's own files. The gate is its
own runner and measures them itself: the compiler times each file it checks and
each file it emits, and the batch charges every file to the one program that
resolved it. The run's program-wide parse and bind belongs to no pattern and is
in none of them, which is why those durations sum to less than the run takes.

A duration says how long the test takes only where the execution passed.
A failure ended where the failure was reached. Where a wait's safety net
ended it, the figure is that net's bound rather than anything about the
test. Every consumer that reports or fits a duration therefore reads
passing records alone, the selection fold's cost samples, the report's
over-sixty-seconds list and the dashboard's daily mean among them. Run,
failure and skip counts read every record, which is what those counters
are for.

A test registered through `@commonfabric/test-support/test` takes its `file`
from that module, which knows the test file its realm runs: Deno runs each test
file in a realm of its own, with that file as `Deno.mainModule`, and the module
names it relative to the repository the module belongs to. A file that
registers its cases through a shared module is therefore the file its records
carry, and the file its skip list is keyed by. A test file outside the
repository, such as a fixture a test wrote to a temporary directory, records
nothing.

The module does not write records, since it knows neither the kind nor the
scope its run records under. It writes what it knows into the spool as it
goes, in a file of its own for each test file, named `results-<ulid>.ndjson`.
Once the test file has loaded, a `registered` line lists every test and group
the file registered, each as the names enclosing it, outermost first:

```json
{ "line": "registered", "file": "base/bakery/test/glaze.test.ts", "names": [["glaze"], ["glaze", "thickens when heated"]] }
```

As each test or group finishes, a `result` line says how it went. A group is a
`describe`, or a test that ran steps, and carries `"container": true`. A
failure carries what it threw:

```json
{ "line": "result", "file": "base/bakery/test/glaze.test.ts", "name": ["glaze", "thickens when heated"], "outcome": "pass", "durationMs": 12 }
```

A skip the file's skip list caused carries `"listed": true`, and
`readResults` returns it apart from the records: a skip of the run's share
says nothing about the test, and only the run that wrote the list knows which
of its entries are its share. A step the list names still runs where its test
does, since the steps before it may have set up what it reads, and its result
carries `"listed": true` in the same way.

A group's outcome is `fail` only where it failed on its own account: one of
its hooks threw, or the test running steps threw. A group whose only failures
are those of what it holds passed. Its duration runs from the start of its
hooks to their end, everything inside it included.

Some failures happen outside any one test's body, and each still reaches a
`fail`:

- What a test package runs around each suite (`wrapSuites`) throwing, such as
  a guard that finds a production backstop fired, fails that suite on its own
  account, and so does a wrapper that does not run the suite exactly once.
- A file's own hooks, those declared outside every `describe`, are written as a
  group whose name is the file's repository-relative path. Its time is what
  those hooks took, and a failure is its own. Since hooks that never settle end
  the file with no event to write it from, it is written as failed before each
  run of those hooks, as it stands once they finish, and again as the file
  unloads, and a reader takes a process's last line for the group. A signal that
  cuts those hooks off therefore leaves the group failed. The file's `beforeAll`
  hooks run before its first test, with the file's own permissions, and only
  where the skip list leaves the file a test to run. Where they throw, Deno runs
  none of the file's tests and fails the file, and the file's group is the one
  record of it. A filter, which the module cannot see, does not stop them
  running. A suite that ignores every test it holds writes their skips whether
  or not a filter chose it, since those skips are the tests' own.
- An error a test leaves uncaught, such as a promise it rejects without
  awaiting, reaches the file in the turn of the event loop after the test
  returns, which the module waits for before it writes the test's result, so
  that error fails the test that left it. Otherwise an error fails the
  innermost test or group running when it arrives — a `describe` while its
  own hooks run — and, where none runs, such as during the file's own hooks
  or after the file unloads, the file's group. An error a timer throws after
  its test returned is charged by when it arrives, and so may fail the test
  running then. One the file's own listeners handle fails nothing. A test
  Deno gave up on, whose promise never settled, is written as a failure when
  the next suite starts, so that nothing later is charged to it.
- A test that returns while a step it started is still running fails.
- A test or group still running when its file ends — a test whose promise
  never settles, so that the event loop runs dry, or one an uncaught error
  ends — is written as it stands as the file unloads: a test as a failure,
  since it never finished, and a group on its own account. The tests the file
  never reached write nothing, and neither does a test a signal cut off,
  which neither passed nor failed.

Deno's sanitizers judge a test only after it has returned, out of the
module's sight, so the module refuses a test or step that turns one on. It
also refuses a test, group or step whose full name another of its file has,
since the two would be one identity, and a name holding the separator ` > `.

A run's owner reads those lines back with the kind and scope the invocation
ran under (`readResults` in `@commonfabric/test-support/records`). Every test
becomes a record. A group becomes one only where it says something its tests do
not, which [CI movement](#ci-movement) sets out, and it then takes the time it
spent outside the groups and tests directly inside it. What each outermost
group spent beyond the records inside it is what its hooks took, or for a
test that runs steps, its own work around them, which a lane measures, and
which is never a record of a test.

The `registered` line is also a statement of what a file holds, which a lane
reads to tell a test the tree no longer holds from one a batch never reached.
The module writes it from the file's first `beforeAll`, which Deno runs once
the module has finished loading and before any of its tests, whether or not
any of them runs. A module that stopped part way through loading therefore
names nothing, and a unit that recorded nothing fails the run.

The browser test runner writes no results, and makes the same statement for the
whole of a run with a mark named `whole-run-<uuid>.json`.
The mark holds a JSON object with the `kind` and `scope` the run's records carry
and `tests`, every test's name by the repository-relative file that registered
it. The runner writes one only when it loaded every file it was handed and every
test returned a result, so a run that stopped part way leaves none. No mark
reaches the store: a spool shipped as a run ships only its records.

The context line carries `schema` (this document describes version 1, the
`v1` in object paths), a per-object ULID `reportId`, the canonical `repo`
name (a constant owned by the repository's tooling, never derived from git
remotes), the `commit` the tests ran against, a `dirty` flag, an optional
`branch`, `env` (`ci` or `local`), the machine facts (`os`, `arch`,
`denoVersion`), an ISO 8601 `startedAt` from the run's start, an optional
opaque `agent` label — `CF_TEST_AGENT`, or the name of the harness the
run was started under when that variable is unset — and for CI runs a
`ci` block:
`workflowRunId`, `runAttempt` (the attempt that produced the records),
`workflow`, `job` (display name with matrix leg), optional `shard`,
optional `headCommit` (the pull request's head; `commit` is the ephemeral
merge commit), and the provenance pair `event` and `fork`, stamped from
the trusted `workflow_run` payload.

A context also carries `shuffleSeed`, the seed the run's test runners shuffled
their order by, where they shuffled; a context without one records a run whose
tests ran in declaration order. Two contexts at one commit describe the same
order exactly when this field agrees, which is what a consumer comparing
outcomes needs to know
([test selection](test-selection.md#two-runs-under-the-same-conditions)). A
value that is not a non-negative integer makes the line malformed.

Every value is public-repository material. Records and contexts never
carry usernames, hostnames, tokens, or log text; branch names, agent
labels, and file paths are world-readable and accepted as such. Failure
detail is deliberately absent — the commit and run identifiers reach the
full log.

Readers treat every line as untrusted: malformed lines are dropped at
every read boundary (`parseRecordLine`, `parseContextLine`).

## Recording

Producers append record lines to their own ULID-named fragment file inside
the directory named by `CF_TEST_RECORDS_DIR`; an unset variable disables
recording everywhere, and that is the entire opt-out.

Producers append line by line as results arrive, never share files, create
the directory if it does not exist, and on any write failure warn once and
stop; recording never fails a run.

A producer records the run it was asked for. Several are also libraries
that this repository's own tests drive — the pattern runner behind
`cf test`, the workspace runner behind `deno task test`, the type-check
task, the vintage gate's replay — and each takes the decision to record
from its caller rather than from the environment alone. The entry point
asks for records; a test driving the same function does not, because the
files it hands over are that test's fixtures, and a fixture is data
rather than a test of this repository. A test that drives such a harness
as a child process hands it an empty `CF_TEST_RECORDS_DIR`, since the
child reads its own environment; an empty value is recording off, the
same as an unset one.

A file no repository holds is no test of one. The pattern runner and the
browser harness, which name each test by its file or record the file
alongside it, record nothing for a file outside every repository. A
fixture a test writes to a temporary directory is such a file, so either
harness run over one records nothing even where the run inherited a spool.

A check that nothing can be asked to run is not recorded. A record is one
execution of one test, and every history built from records — flake rate,
duration, and what a pull request selects — answers whether to run that
test again. A check reading what the run around it produced exists only
as part of that run, so there is nothing to select and no suite in the
test topology to claim its identity. Two checks are of this shape: the
store half of the test topology's drift guard, which reads the records of
every lane in its own run, and the CFC Property Suite's audit step, which
reads the corpus the step before it wrote. The first is a step of `Status`,
the job in `deno.yml` that waits for every lane. A gate resolving a merge base
against a base ref is not, and records normally.

The coverage gates read what the lanes produced as well, and are recorded
all the same. A plan runs one by choosing to run every unit of its measured
set, which gives selection something to choose, and the topology holds the
gates as a suite of their own whose units are verdicts rather than anything
a lane runs, which claims their identities
([test selection](test-selection.md#a-gate-is-a-test)). `Status` reaches
the verdict of each gate the run chose and records it on kind `gate`,
scoped to the member whose lines it counts and named `coverage-gate
<suite>`: a failure for a rise no acceptance covers, a pass for a
comparison that found none, and a skip for any other verdict, an
accepted rise among them. Its duration is what reaching the verdict took.

One thing that is not a test is recorded anyway: a lane measuring
itself. A lane measures its own setup and each of its batches through
the record machinery every test uses, so those measurements arrive as
ordinary records and travel the path a test's records travel. They are
written on kind `gate`, scope `ci`, with a name opening `ci-lane `, and
they carry no variant whatever the batch they measure carried. Nothing
enumerates them, nothing scores them, and no lane can be asked to run
one.

Their figures are not all durations. A lane writes four measurements per
batch — what the batch spent, what the tests of its units took between them,
how many times its passes opened a unit, and how many passes it made — and a
fifth, what the packer charged the lane for the batch. It writes three more
once its batches have run, about its work as a whole: what that work took, what
it was projected to take, and the most it could take inside the lane's bound.
The record format carries one number and calls it a duration, so which of these
a record holds is decided by its name. No name starts the way the name of
another kind does, so a reader that predates a kind reads a record of that
kind as no measurement at all rather than as one it knows.
A batch that ended badly is written as a failure, and a test in it
failing is enough to end it badly. A lane with a batch that ended badly
writes its three as failures too.

`Status` writes what a push run's tests covered the same way, in the step that
reports the run's coverage. That step is a check nothing can be asked to run,
since it reads what every lane produced, so it records no test; what it writes
are measurements, like a lane's, rather than records of a check. Each figure is
a record named `ci-lane coverage group <group>` or `ci-lane coverage set
<suite>/<member>` whose `durationMs` holds a count of uncovered lines, and a run
whose pattern compile cache was not restored also carries `ci-lane coverage
cold`. Only a push writes them, and `Status` ships them beside its gates'
records under the artifact suffix `coverage` (`COVERAGE_ARTIFACT`), which the
shipping action uploads as `test-records-coverage-a<attempt>`, so that a reader
finds a day's figures by listing for the objects the relay names after it. A
reader of figures takes them from a push to the default branch alone.
`coverageRecords` and `coverageFiguresOf` in
`@commonfabric/test-support/records` write and read them.

A consumer that builds anything per test excludes them first: pass
rates, durations, a run's verdict per test, the sixty-second list, and
the scores a pull request selects from. `isLaneMeasurement` in
`@commonfabric/test-support/records` is what recognizes one, and it is
asked of the identity the lane wrote, before any alias is resolved, so
that a line in the alias file cannot decide whether a measurement enters
a test's history.

A test another workflow already records against the same commit in the
same order is not recorded a second time. One execution of one test is
one record, so a second workflow running those tests on that commit in
that order would give each of them two entries in its history. The
exemption covers tests rather than jobs: a test that runs only in such a
job is recorded there. A run in another order is a different execution
and is recorded. The daily run of every suite at the head of `main`
under the next day's seed
([TESTING.md](../development/TESTING.md#tomorrows-seed-run-a-day-ahead))
is such a run, and its contexts' `shuffleSeed` is what tells its records
apart from those of the commit's own run.

`run-recorded` records the command it wraps, as one line carrying the
identity the wrapper was given. It is therefore for a command that is
itself the check — a formatter, a linter, a gate. A command whose own
tests are the checks is not wrapped: its tests record through their own
runner, and the wrapper's line would summarize an invocation beside
them rather than record one execution of one test. The wrapper passes
recording through to what it runs either way, so wrapping such a
command adds that summary without changing what the tests below it
record.

A run's owner — locally `deno task test`, `deno task integration`, or
`deno task run-recorded` when a personal key is present — creates the
spool under the per-user spool root (`CF_TEST_RECORDS_SPOOL_ROOT`, or the
user cache directory; not the temporary directory, which a reboot
clears), stamps the context file at start while its facts are certainly
true, exports the variable to its producers, and holds an advisory file
lock the kernel releases on any process death. The spool is built under a
`staging-` name and renamed into place only after the lock is held and
the context is stamped — the lock lives on the open file handle, so it
survives the rename — which is what keeps a concurrent sweep from
adopting a spool whose owner has not locked it yet. An entry point that
finds the variable already set joins the enclosing run as a producer.
Shipping consumes exactly one spool directory and deletes it afterward;
fragments are read line by line and a torn final line is dropped with a
warning. Every opted-in run also sweeps the spool root, adopting any
directory whose owner's lock is free — liveness is a kernel-reported
fact, never a timestamp guess — and ships it under its own stamped
context; an abandoned staging directory never had producers and is
deleted.

Every shipper makes exactly one attempt, and object names are
deterministic, so re-shipping collides on create (which is not overwrite)
rather than writing a second copy. The CI area nonetheless holds second
copies of some earlier reports, written before the relay took each
object's date from the attempt that produced it; [discovery](#the-store)
says what they are and how a reader recognizes one.

## The store

The store is the `cf-ci-metadata` bucket's `<repo>/test-records/` dataset
area, managed by the infra repository's `tofu/test-records` root:

```
<repo>/test-records/submissions/ci/v1/<yyyy>/<mm>/<dd>/run-<runId>-<artifact>.ndjson
<repo>/test-records/submissions/local/<username>/v1/<yyyy>/<mm>/<dd>/<reportId>-<slug>.ndjson
<repo>/test-records/aggregated/ci/v1/<yyyy>/<mm>/<dd>/partition.json
<repo>/test-records/aggregated/ci/v1/<yyyy>/<mm>/<dd>/0003-of-0017.ndjson
<repo>/test-records/aggregated/ci/v1/<yyyy>/<mm>/<dd>/rollup.json
```

One further dataset area sits beside it and is written by the
test-selection publisher rather than by anything recording:

```
<repo>/test-selection/v1/manifest-<ISO 8601 timestamp>-<ULID>.json.gz
<repo>/test-selection/v1/state/<yyyy-mm-dd>-<ULID>.json.gz
```

The segment between the two names the area rather than the shape of what
is stored there, and does not move when that shape changes: a reader
reads an older shape forward, and the state a moved area would leave
behind holds history no window of records could give back.

The timestamp leading a manifest's name is the moment its publisher
generated it, which keeps a listing chronologically readable but is not
what a reader compares. A publisher names its manifest when it starts and
creates the object when it finishes, so a reader takes the newest object
the store had created at or before the moment it is resolving for, using
the full object name to break a tie between two created in the same
instant. There is no object name meaning "the current one": writers hold
create and nothing else, so nothing can be overwritten, and that is the
property the whole store rests on.
[The selection spec](test-selection.md#determinism) says which moment a
consumer resolves for and why.

The selection area is the one part of this store that expires. A bucket
lifecycle rule deletes its objects at a fixed age, and that age has to
exceed the window in which a continuous-integration run may still be
re-run, because a re-run resolves the same moment as the attempt it
repeats and has to find the same manifest. It also has to exceed the
longest the publisher may stop for: every run writes a new aggregate that
carries each new real test failure forward, so an aggregate expiring costs
nothing while a newer one exists. Records carry no retention and must not
acquire one, since they are what a fold of the whole history reads.

A local object's date partition comes from its run's start. A CI
object's comes from the start of the attempt that produced it. Each
attempt's completion triggers a relay of its own, which ships that
attempt's artifacts and no other's, and the `workflow_run` payload it
receives carries that attempt's `run_started_at`. GitHub reports a later
start for the run once another attempt starts, but never changes the
start an earlier attempt's payload carries. Every relay of one attempt —
the first, a rerun of it, or a dispatch naming the run and the attempt —
therefore computes the same name for each of its artifacts, and a re-ship
collides with the first shipment. A late-shipped object lands in the
partition where its report was produced, not where it was uploaded.
A trailing window can make late arrivals likely to be found, but cannot
make discovery exact; what listing does and does not settle is described
below. The whole dataset is readable by `allUsers`. Writers hold
`roles/storage.objectCreator` pinned to their own folder. That
identity-specific writer grant cannot overwrite or delete, while the public
reader grant separately lets every principal read and list. Nothing already
stored can be modified by any append credential, which is why the area a
reader lists is named rather than numbered: what is stored cannot be moved
to a differently named one.

Four writer principals exist, three of them recording. The **relay** —
the only one that writes what CI produced — holds create on
`submissions/ci/` through a Workload Identity provider pinned to one
workflow file on the default branch, with the impersonation binding keyed
to that exact workflow ref. **People** hold per-person service accounts
(`test-records-gh-<username>`, the login lowercased)
with create on their own `submissions/local/<username>/` folders, minted
by a dispatch-gated workflow and delivered sealed to a
requester-generated X25519 identity. Minting revokes the account's
previous keys before the new one exists — a person holds one live key,
never two, and re-requesting is how a lost or compromised key is
rotated — and a daily
janitor disables accounts after a month without pull-request activity
and re-enables them on return. The **compactor** holds create on
`aggregated/` through a provider pinned to its own daily workflow file,
the relay's arrangement again, and rewrites each closed day of raw
records — after a seven-day late-arrival lag — as validated rollup shards
that keep each report's context line ahead of its records; a day with
no records stays open, since a write-once rollup would permanently
exclude late arrivals. A rollup covers one source and date: today's
rollups cover CI, and say nothing about local submissions with the same
date. Rollups are a read optimization, and full-fidelity readers list the
raw area. The **publisher** holds create on `test-selection/` through a
provider pinned to its own workflow file on the default branch, on the
relay's pattern and for the relay's reason.

A day is several shards. A busy day is over a gigabyte of NDJSON, against
V8's maximum string length of about half that, and an object has to fit in
a string at both ends: the compactor builds one, and a reader fetches one.
Each shard is sized for a few tens of megabytes of text, so a day of tens
of thousands of raw objects becomes tens of shards.

Which shard a raw object's reports go into is a hash of the object's name
taken modulo the shard count, so the partition is a property of each
object rather than of the order the compactor read them in. How many
shards there are is fixed by `partition.json`, written before any shard of
the day under the same create-only precondition as everything else here,
so a day is partitioned once however many runs reach it: the write that
loses reads the count that won and works to that one. A run that finds a
day part way through finishes it in the partition claimed for it, writing
the shards that are missing and leaving the rest alone, so no run leaves
shards of a partition nothing names and no record reaches two shards. The
count is in every shard's name as well, so a shard says which partition it
belongs to. What a partition does not fix is which raw objects it covers:
an object arriving between two runs is in the rollup when its shard is one
of the ones still to be written, and in the raw area only otherwise, the
same as any arrival after a day is compacted. The `rollup.json` manifest
names the day's shards and is written after all of them, so a day counts
as compacted when its manifest exists. This means that every named shard
exists, not that the shards are one atomic snapshot or that no more objects
can arrive for that source and date. A reader that finds no manifest reads
the raw area for that source and date. So does a reader that cannot read a
shard the manifest names, as long as it has folded nothing of that rollup:
a rollup holds nothing its day's raw area does not, so giving that rollup
up costs the reader the time of reading the day the long way. A reader
that has already folded part of the rollup cannot go that way, because
nothing in the rollup says which raw objects it has counted.

The rollup manifest records neither the source object names it contains
nor a point through which it is complete. A reader cannot combine one with
raw objects from the same source and date: it cannot tell whether a raw
object is a later arrival or is already in a shard. Folding it may count it
twice, while suppressing it may lose it. A reader that folds a rollup
therefore closes that source and date to later raw arrivals and records a
receipt saying so. The receipt is scoped by source as well as by date, so a
receipt for the continuous-integration area cannot suppress that day's
local submissions.

Discovery is by listing. A reader names the source-and-date partitions of
the window it reads, lists each one, and folds the objects it has not
folded already, identified by object name. That costs what the window holds
rather than what arrived in it. A reader sees every object that arrives for
a partition while that partition is still inside its window; an object
arriving after that is not found until something reads a wider one.

One limit follows, and it is accepted rather than closed. An object
arriving for a source and date already folded from its rollup is never
counted, which needs the relay to write a partition older than the
compaction lag.

The CI area also holds second copies that a reader keying on object name
folds twice. A relay once shipped every attempt's artifacts and dated
them all by the latest attempt's start, so a run re-run on a later UTC
day had its earlier attempts' artifacts stored again under the later
day. Measured on 2026-10-01, 1,334 object names from 26 runs each appear
under two dates in this way. A second copy carries the same run id,
artifact name, `ci.runAttempt`, `ci.job` and `ci.shard` as the first, a
`reportId` of its own, and the later attempt's start as its `startedAt`.
Among raw objects the two share a name below the date; in a rollup, which
keeps no object names, they share those context fields. The copy under
the earlier date is the original.

Recording the exact source object names in a rollup would let a reader
prove which raw objects overlap it and stop closing the date, at the cost
of carrying a day of object names in the manifest. That is the change to
make if a closed partition is ever shown to have lost something.

## CI movement

Test jobs hold no record-store credential. Each recording job — which is every
job running tests that "Recording" above does not exempt — spools records
and uploads one credential-free `test-records-<job>-a<attempt>` artifact, `if:
always()`. The results a test file writes become records as they are gathered:
every test becomes a record, and a group is recorded only where it says
something the tests inside it do not.

A group that failed on its own account is recorded as a failure. A group whose
only failure is that a test inside it failed is not recorded for that failure,
since that test carries it. A recorded group takes the time it spent outside the
groups and tests directly inside it, since theirs is in their own records.

A group the lane's manifest holds, as an identity in the unit that ran it, is
recorded on every run with its outcome on its own account: a pass where it
failed only through the tests inside it. Its history then holds its passes as
well as its failures, which is what the publisher judges flakiness, new real
test failures, and the default branch's latest outcome by. The manifest holds a
group once a run has recorded it, so a group becomes an identity of its own the
first time it fails on its own account, and every `describe` does not. Until the
manifest holds it, a rerun of its unit records nothing for it. Outside a lane,
nothing is known, and a group is recorded only when it fails on its own
account.

In `deno.yml` the recording jobs are the lanes of the `tests` job. Each lane
ships one artifact, `test-records-tests-<lane>-a<attempt>`, and its shipping
step names no variant. The lane runner (`tasks/ci-lane.ts`) gathers each batch's
records and its tests' results into the lane's spool as the batch finishes,
marking each with its suite's variant. A lane that opens a test file for some of
its tests registers the rest as ignored, through the skip list it hands the
file's process, whose results mark those skips as listed, and ships no record of
them: each is another lane's share, or one the plan did not select, and the
lane's skip says nothing about the test itself. A skip a test registers for
itself is recorded, and so is one a configuration declares, by the lane the plan
gave that test to. Each suite declares in the topology what its tests' results
are recorded as, so the lane knows without the workflow saying. A lane that ran
default and non-default batches therefore ships records the job-wide inputs
could not have described. `Status` ships one more artifact,
`test-records-coverage-a<attempt>`, from every run: the record of each coverage
gate it judged, and from a push the coverage measurements it writes as well. The
artifact holds `records.ndjson` — always written, zero records or not — and
`job.json`; an artifact without a readable `records.ndjson` is truncated, and
the relay fails it visibly rather than ship a context-only object that would
read as a run with no tests. The attempt lives in the artifact name because
artifacts are scoped to the run. A relay ships only the artifacts whose name
carries the attempt that triggered it, and dates and names them by that
attempt's start, so a re-run's new jobs create new objects and nothing an
earlier attempt produced is shipped again.

The shared shipping action's optional `variant` input stamps every spooled
record gathered by that job. A job that gathers its own records, as a lane
does, passes none, and so does a job running only the default configuration.

The relay checks out its implementation from the default branch, not from
the triggering test run. A new optional record field therefore rolls out in
two changes. Its parser, relay, readers, and shipping-action support land
first. Test workflows start emitting the field only after that support is on
the default branch. Otherwise the old relay drops the field before writing a
create-only object that cannot be repaired in place.

The relay workflow follows the completion of every workflow that records
tests — success, failure, cancellation, and timeout alike — and follows
no workflow that "Recording" above leaves recording nothing. The relay
ships a same-repository run unconditionally, since only write access creates
one, and a fork run only when the run's actor — read from the trusted
payload — is on the team member list (`TEST_RECORDS_MEMBER_ACTOR_IDS`,
an infra-managed variable of numeric actor ids): team members work from
personal forks, so this keeps the team's own fork data while the
public, immutable store accepts nothing authored by anyone else. A fork
run by an unlisted actor, a fork run with no readable actor, and any
fork run under an empty or missing list ship nothing. A run is a fork run
when the payload names both repositories and they differ, and when the
payload names fewer than both, so a run this relay cannot place is gated
as a fork and carries the flag that keeps it out of a consumer's
baselines. For runs that do ship, the relay composes each artifact's
context (run identity and
provenance from the trusted event payload; the checked-out commit, job
display name, shuffle seed, and machine facts from the artifact's own
`job.json`, which the payload does not carry) and creates one object per
artifact.

## Trust boundaries for consumers

Write attribution and content trust are different properties. Objects
under `submissions/ci/` were written by the relay, but the record lines
and job facts inside them were authored by the run's own jobs — for a
fork pull request, by the fork. The member gate above means every
object in the store was authored under the write-access group's trust;
`fork: true` now marks a team member's fork run, whose content is
trusted the same way a same-repository branch's is, and what the flag
still tells a consumer is that the run executed unmerged pull-request
code. Consumers that feed decisions read `submissions/ci/` only, and
take baselines from runs of the head of `main` — `event` `"push"`,
`"schedule"`, `"workflow_dispatch"` or `"workflow_run"` on branch `main` —
whose code the tree itself carries. A
`local/<username>/` prefix attributes records to the key's named holder
under the trust of the repository's write-access group, since the minting
workflow's username input lets any member mint for any username, with the
dispatch log as the record of who minted what for whom.

A consumer that selects which tests run — a duration ratchet, sharding
weights, failure-rate-driven selection — must additionally see that an
identity it has no fresh records for runs: records exist only for tests
that ran, so a selector that never re-runs the unselected starves its own
data, and a renamed test is an unknown identity until an alias line lands.
A consumer whose own runs on `main` run every identity meets this there
for anything `main` already holds, and need only force in elsewhere what
`main` does not.

Test selection reads `submissions/local/` as well, and weighs a failure
seen there above one seen in continuous integration. That is a deliberate
widening of the rule above, and the reason is the quality of the
evidence: somebody at a workstation, part way through writing something,
ran a test and it went red because of what they had just written. There
is no ambiguity about what changed, no shared infrastructure to blame,
and no question about whether the failure was real, because they went on
to fix it. What it costs is that a local record can now displace another
test from a budgeted run rather than only ever adding to what runs. Three
things bound that: every local key was minted by someone with repository
write access, for themselves or for a person they chose to mint for,
which is the trust boundary the continuous-integration records already
sit inside; every manifest records the inputs behind every score,
so a strange selection traces back to the records that produced it; and
the worst outcome is a pull request that ran a less useful set of tests,
which the full run on the default branch catches.

## The sixty-second rule

Every test completes within 60 seconds in CI, not counting setup; most
take milliseconds. Anything that cannot is a container to split into the
tests it actually contains. `tasks/test-records-report.ts` lists the
identities over the rule from their passing executions, and its `--gate`
flag is the ratchet, advisory until the list is short enough to enforce.
A window the report could not read in full is neither a pass nor a
failure of the rule, and the ratchet says so with a status of its own:
the objects a report left out are the ones nothing has been established
about, and a ratchet that passed on a window read in part would report
it clean on the strength of what arrived. The list is over tests: a
lane's measurement of one of its batches is not one, however long that
batch ran. A test that wedges rather than finishing slowly records no
duration; wedges surface through job failures, and the incremental
producers bound what a wedged job loses to its unflushed lines. An
identity with no passing execution in the window has no duration either,
and is absent from the list for the same reason. A test that fails every
time it runs surfaces through the job it fails.
