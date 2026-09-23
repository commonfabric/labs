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
`packages/test-support/src/records/`.

## Identity

A test's identity has three required parts, scoped within a repository:

- **kind** — the class of check: `unit`, `browser`, `pattern`,
  `integration`, `typecheck`, `lint`, `format`, `gate`.
- **scope** — the workspace member that owns the test, or `repo` for
  repository-level checks.
- **name** — the full name the test's own runner reports: the bdd describe
  chain joined with `" > "`, a `Deno.test` name, a pattern test's
  repository-root-relative file path with forward slashes, a task name, a
  script's own name (`acl.sh`), a script step (`integration.sh
  piece-values`), or a task-plus-item pair (`cfcheck <file>`,
  `pattern-compat <key>`, `pattern-vintage <testKey> <tier> <stamp>`). A
  bdd file declaring a hook outside every `describe` has a root suite
  invented for it, named `global`, and every chain that file goes on to
  run opens with that name. A suite it registers as ignored is reported
  under its bare name. The runner keeps such a suite out of the root
  suite and never runs its body. A `describe` or `it` call carrying no
  name of its own is named after the body it was given, and a name the
  call carries stands even where it is empty, so a chain can hold an
  empty element. The runner refuses an empty name for the outermost
  registration of a file, so an empty element is never the first.
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
lines, and reads as a single set of aliases. It is append-only file by file,
maps any identity at most once, must stay acyclic, and each line carries the
rename's date; readers resolve aliases transitively and apply one only to
records older than its date (`deno task check-test-aliases` enforces the
directory's shape). Alias lines name the three required identity parts and
apply the rename to every variant.

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

A record carries `outcome` (`pass`, `fail`, or `skip`), `durationMs` from
the runner's own measurement (never a clock inside the test process, which
several packages fake), and optionally `file`, the repository-relative
source path when the producer reliably knows it — metadata, not identity.
A `cfcheck` item's duration is what the batch spent on that pattern's own
files. The gate is its own runner and measures them itself: the compiler
times each file it checks and each file it emits, and the batch charges
every file to the one program that resolved it. The run's program-wide
parse and bind belongs to no pattern and is in none of them, which is why
those durations sum to less than the run takes.

A duration says how long the test takes only where the execution passed.
A failure ended where the failure was reached. Where a wait's safety net
ended it, the figure is that net's bound rather than anything about the
test. Every consumer that reports or fits a duration therefore reads
passing records alone, the selection fold's cost samples, the report's
over-sixty-seconds list and the dashboard's daily mean among them. Run,
failure and skip counts read every record, which is what those counters
are for.

For a suite ingested from a JUnit report, `file` comes from one of two
places and the second overrides the first. Deno names a case's class after
the module that registered the test, so the case a `describe` registers
carries the file of every leaf beneath it, and the report joins itself: a
leaf is named as its describe chain, and its file is the one whose
registered name is the longest prefix of that chain. What the class names
is the nearest frame of this repository's own code below the runner, so
that source holds only while nothing of ours sits between a test file and
the registrar. The `describe` and `it` the import map resolves to are
therefore the real ones wherever they would have nothing to do, and a
module that does register on a file's behalf — a fixture runner, a clock
harness — takes the class name with it.

The registration preload is such a module, and it replaces what it takes:
it writes a name-to-file map into the spool, and ingestion lays that over
what the report says. The map holds each name `Deno.test` was called with
and, for a file written with `describe` and `it`, the whole chain of each
leaf. A hook a file declares outside every `describe` has no suite to
hold it, so the bdd runner makes one named `global` and every suite that
file goes on to run sits inside it; the chain each leaf is named by opens
with that name. A suite title two files share says nothing about either
and is dropped from the merged map; a leaf's whole chain is what usually
survives that, and `global` is a title every file declaring such a hook
shares.

Every package of a workspace run writes into one spool, so each map also
names the repository-relative directory its process ran in. A caller
ingesting one package's report asks for that directory. A map naming it
belongs to that package and is read whole, whatever files it names: a
test task may name a file anywhere in the tree, and
`packages/test-support` runs `tools/write-iframe-wrapper.test.ts`, two
directories above itself. A map naming no directory at all is judged by
its files instead, and contributes only those under the directory asked
for. Either way the scope is applied before ambiguity is judged, or a
name two packages happen to share would cost each of them a file it held
unambiguously.

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
`cf test`, the type-check task, the vintage gate's replay — and each takes
the decision to record from its caller rather than from the environment
alone. The entry point asks for records; a test driving the same function
does not, because the files it hands over are that test's fixtures, and a
fixture is data rather than a test of this repository. A test that drives
such a harness as a child process hands it an empty
`CF_TEST_RECORDS_DIR`, since the child reads its own environment; an
empty value is recording off, the same as an unset one.

A check that no lane can be asked to run is not recorded. A record is one
execution of one test, and every history built from records — flake rate,
duration, and what a pull request selects — answers whether to run that
test again. A check reading what the run around it produced exists only
as part of that run, so there is nothing to select and no suite in the
test topology to claim its identity. Three checks are of this shape: the
pull request coverage gate, which reads the coverage artifacts of every
job in its own run; the store half of the test topology's drift guard,
which reads those jobs' records; and the nightly audit over the CFC
property corpus, which reads what the step before it wrote. A gate
resolving a merge base against a base ref is not, and records normally.

One thing that is not a test is recorded anyway: a lane measuring
itself. A lane measures its own setup and each of its batches through
the record machinery every test uses, so those measurements arrive as
ordinary records and travel the path a test's records travel. They are
written on kind `gate`, scope `ci`, with a name opening `ci-lane `, and
they carry no variant whatever the batch they measure carried. Nothing
enumerates them, nothing scores them, and no lane can be asked to run
one.

Their figures are not all durations. A lane writes three measurements
per batch — what the batch spent, what its own tests took between them,
and how many units it opened — and the record format carries one number
and calls it a duration, so which of the three a record holds is decided
by its name.
A batch that ended badly is written as a failure, and a test in it
failing is enough to end it badly.

A consumer that builds anything per test excludes them first: pass
rates, durations, a run's verdict per test, the sixty-second list, and
the scores a pull request selects from. `isLaneMeasurement` in
`@commonfabric/test-support/records` is what recognizes one, and it is
asked of the identity the lane wrote, before any alias is resolved, so
that a line in the alias file cannot decide whether a measurement enters
a test's history.

A test another workflow already records against the same commit is not
recorded a second time. One execution of one test is one record, so a
second workflow running those tests on that commit would give each of
them two entries in its history. The exemption covers tests rather than
jobs: a test that runs only in such a job is recorded there.

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
and duplicates never come into being.

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
repeats and has to find the same manifest. Records carry no retention and
must not acquire one.

A local object's date partition comes from its run's start. The CI relay
currently takes the date from the workflow run's `run_started_at`. That
field is the current attempt's start and GitHub advances it when another
attempt starts. Re-shipping an earlier artifact after a re-run can therefore
move it to the new attempt's date and create a second object instead of
colliding with its first shipment.

The planned relay contract puts the immutable start of the attempt that
produced an artifact inside that artifact. Its context and object name use
that value on every relay invocation. Late-shipped objects then land in
the partition where their report was produced, not where it was uploaded.
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

Two limits follow, and both are accepted rather than closed. An object
arriving for a source and date already folded from its rollup is never
counted, which needs the relay to write a partition older than the
compaction lag. And a re-run crossing a UTC midnight ships its earlier
attempt's artifacts under the later attempt's date, so the same records
reach two objects and a reader keying on object name folds both. The relay
contract above is what settles the second.

Recording the exact source object names in a rollup would let a reader
prove which raw objects overlap it and stop closing the date, at the cost
of carrying a day of object names in the manifest. That is the change to
make if a closed partition is ever shown to have lost something.

## CI movement

Test jobs hold no credentials. Each recording job — which is every job
running tests that "Recording" above does not exempt — spools records
(and its JUnit
XML: leaf cases become records, container cases — one per describe level,
with overlapping times — are dropped by a name-prefix rule) and uploads
one credential-free `test-records-<job>-a<attempt>` artifact,
`if: always()`. The artifact holds `records.ndjson` — always written,
zero records or not — and `job.json`; an artifact without a readable
`records.ndjson` is truncated, and the relay fails it visibly rather
than ship a context-only object that would read as a run with no tests.
The attempt lives in the artifact name because artifacts are scoped to
the run. The artifact also needs the immutable start of the attempt that
produced it. Under the planned relay contract, a re-run re-ships earlier
attempts' artifacts using their own attempt numbers and start times, so
those objects collide with their first shipment, while the new attempt's
artifacts create new objects. The current relay instead uses the workflow
run's mutable `run_started_at` for all of them. That can move an earlier
artifact to another date and create a second copy instead of a collision.

The shared shipping action's optional `variant` input stamps every spooled
and JUnit-derived record gathered by that job. Jobs omit it for the default
configuration.

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
take baselines from `event: "push"` runs, whose code the tree itself
carries. A
`local/<username>/` prefix attributes records to the key's named holder
under the trust of the repository's write-access group, since the minting
workflow's username input lets any member mint for any username, with the
dispatch log as the record of who minted what for whom.

A consumer that selects which tests run — a duration ratchet, sharding
weights, failure-rate-driven selection — must additionally treat an
identity it has no fresh records for as one that must run: records exist
only for tests that ran, so a selector that never re-runs the unselected
starves its own data, and a renamed test is an unknown identity until an
alias line lands.

Test selection reads `submissions/local/` as well, and weighs a failure
seen there above one seen in continuous integration. That is a deliberate
widening of the rule above, and the reason is the quality of the
evidence: somebody at a workstation, part way through writing something,
ran a test and it went red because of what they had just written. There
is no ambiguity about what changed, no shared infrastructure to blame,
and no question about whether the failure was real, because they went on
to fix it. What it costs is that a local record can now displace another
test from a budgeted run rather than only ever adding to what runs. Three
things bound that: local keys are held by people with repository write
access, which is the trust boundary the continuous-integration records
already sit inside; every manifest records the inputs behind every score,
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
