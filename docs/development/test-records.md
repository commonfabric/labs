# Test-run records

When recording is enabled, a top-level test run produces one record per test.
Each record contains the test's identity, outcome, and duration. The run ships
those records with its context to a public store. A repository test that drives
a harness as a library over fixture files produces its own record, not records
for the fixture runs.
[The spec](../specs/test-records.md) is the contract (identity
rules, line formats, store guarantees, trust boundaries), and the
reasoning that produced it is in [the archived
plan](../history/plans/test-run-telemetry.md). This document is how the
running system is operated: what gets recorded, the environment surface,
how to opt a workstation in, and how to read the data.

## What a record is

A test's identity has three required parts: **kind** (`unit`, `browser`,
`pattern`, `integration`, `typecheck`, `lint`, `format`, `gate`), **scope**
(the owning workspace member, or `repo`), and **name** (whatever the test's
own runner reports — a bdd describe chain, a pattern file path, a task name,
a script step). An optional **variant** separates the same test running
in a non-default configuration. The default configuration is unmarked. The
server-execution deployed-topology lanes use stable `default` and `opposite`
roles. `default` follows the first-party constant and stays unmarked;
`opposite` uses `server-execution` when it resolves ON and
`server-execution-off` when it resolves OFF. Which posture is unmarked
follows the constant (the registry's summary table states it); each marker
is the continuous history of its posture whenever that posture is not the
default, across flips in either direction. The single-process default suites
(the unit suites, `cf test`, the no-server `pattern-unit` suite) never read that
default and stay ambient-OFF, so they are unmarked for the older reason: the
flip does not reach them (`docs/specs/test-records.md`). One record is one JSON
line; one uploaded object is a run's context line followed by its record lines.
The schema, the line codecs, and their validators live in
`packages/test-support/src/records/`.

Records carry only public-repository material: names, hashes, durations. No
usernames, hostnames, tokens, or log text — that discipline is what makes
the store publicly readable, and the schema validators drop anything else
at every read boundary. Publicly readable means the whole internet:
branch names, agent labels, and repository-relative test file paths in
records are world-visible, the same as the repository itself. A branch
whose name should not be public should not report from a workstation.

Renaming a test renames its identity and splits its history. When the
continuity matters, append a line mapping the old identity to the new one
with the date. The line goes in `tasks/test-identity-aliases/`, in the file
named after the test file that holds the test: a rename in
`packages/runner/test/link-utils.test.ts` is a line in
`link-utils.test.ts.jsonl`, and a test file with no alias file yet gets a
new one. Only the last path segment names the file,
so test files of one name share one, and a test file that moves keeps the
one it has. A line mapping a whole scope, for a package rename, goes in
`whole-scope.jsonl`. Every reader takes the directory as a single set of
aliases, so which file holds a line changes nothing about what it means;
the division keeps two changes that rename tests in different test files
from appending to the same file, and so from conflicting when they merge.
`deno task check-test-aliases` holds the directory to append-only,
no-double-mapping, acyclic rules: each file only ever grows, none goes
away, and no identity is mapped twice across all of them. It also fails a
line that does not parse, naming the file and line, and anything no reader
would load: an entry of the directory other than a `.jsonl` file directly
inside it, or a `test-identity-aliases.jsonl` beside the directory, whose
lines belong in the files inside. The same rename applies to every variant.

## The environment surface

- `CF_TEST_RECORDS_DIR` — the active run's spool directory. Producers
  append record fragments here; when it is unset, recording is off
  everywhere. A CI lane job sets it to a workspace directory, and the lane gives
  each batch execution a spool of its own in the lane's working directory; local
  entry points set it themselves when they own a run. Never point two concurrent
  runs at one directory by hand — each run owns its own spool.
- `CF_TEST_RECORDS_KEY_FILE` — a personal reporting key (see below), put in
  the shell's profile and in each agent harness's configuration by `deno
  task test-records-key setup`. Its presence is the local opt-in: with it,
  `deno task test`, `deno task integration`, and `deno task run-recorded`
  stamp a spool, ship it when the run ends, and sweep any orphaned spools a
  killed run left behind. It has to reach shells nobody is typing into,
  since that is what an agent's run is, so the export goes in `.zshenv`
  rather than `.zshrc`. A harness that runs its commands through no shell at
  all is covered by its own configuration instead, which the setup command
  writes; the harnesses it knows are listed in
  `tasks/test-records-agent-config.ts`, and one whose directory is not
  there is left alone. Anything else — a bash workstation whose agents run
  non-interactive shells, a harness nothing here knows — puts the variable
  in whatever starts the agent.
- `CF_TEST_SKIP_LIST` — a file naming the tests this invocation is not to
  run, keyed by test file and by name. The registration preload
  reads it and registers a listed test as ignored rather than dropping it,
  so a skipped test appears in the report as skipped instead of
  disappearing. An identity the file does not name runs, so a test added
  or renamed since the list was built runs. A file that is missing or
  malformed runs everything.
- `CF_TEST_AGENT` — an opaque label for the operating agent, recorded
  verbatim in the run context. Set it to tell one agent from another, or
  one checkout of a fleet from the next; it is never required. Left
  unset, a run started by an agent is still labeled, by the harness that
  started it — `claude-code`, `cursor`, `codex`, or `agent` for anything
  that announces itself only as one. A person's own terminal carries
  none of those, so their runs stay unlabeled, and a consumer that wants
  human runs alone reads the ones with no `agent` field.
- `CF_TEST_RECORDS_SPOOL_ROOT` — overrides the per-user spool root, which
  is otherwise under the user cache directory
  (`~/.cache/common-fabric/test-records`). The root is deliberately not in
  the temporary directory: a spool must survive a reboot to be swept.
- `TEST_RECORDS_BUCKET` / `TEST_RECORDS_PREFIX` — the store coordinates,
  defaulting to the infra-managed `cf-ci-metadata` bucket and this
  repository's `labs/test-records` dataset. The workflows read them from
  Actions variables managed by the infra repository.

## Getting a key

A key is what lets a person's local runs report. Everyone who works in
this repository regularly is encouraged to set one up; it takes a
couple of minutes, and every run it records makes the shared history
more useful to everyone. A key stays active while its holder has recent
pull-request activity (see below), so it fits best once you are
contributing regularly. There is no need to set one up for a first
change or an occasional fix: local tests run identically without a key,
and you are welcome to set one up whenever it suits you.

With commit access the whole path is self-service. Without it, the path
is the same command plus one workflow run that a team member will start
for you, described below. If you don't have commit access, CI does not
record your pull requests' runs, so a key is how your runs join the
history.

A key takes only a GitHub identity, and one command:

```
deno task test-records-key setup
```

generates a delivery identity, dispatches the minting workflow, watches
until the run delivers, installs the key file with owner-only
permissions, and puts `CF_TEST_RECORDS_KEY_FILE` where the things that
run tests will find it: the shell's profile, and the configuration of
every agent harness installed here, since an agent that runs its
commands without a shell is reached only by telling its harness to
carry the variable. Every shell opened after that records, and so does
every agent. A profile that
already sets the variable is reported and left alone, whether it points
somewhere else or sets it without exporting it, and so is a login
profile that does not exist yet, since creating one is what stops a
login shell reading the file it falls back to. Rerun the command and it
takes up whatever run is already minting for you rather than starting a
second one, which is what makes an interrupted setup resume.

The dispatch is the authorization check, which is why it takes
repository write access.
With a token that can only read, the command prints the workflow page to
open in a browser and the recipient string to paste into it, then keeps
watching for the run that click starts. The wait has no bound, since a
run takes as long as it takes; Ctrl-C stops watching and running the
command again picks up where it left off. Run it on a workstation that
already holds a key and it re-checks the shell profile rather than
minting a second one — unless a run is already minting for you, which it
takes up, because the key that run delivers is the one replacing what is
installed.

Starting the workflow takes write access, so for someone without commit
access a team member starts it for them. The person signs in with `gh auth login`
(setup needs a GitHub login before it does anything else), runs `deno
task test-records-key setup`, and sends a team member their GitHub login
and the `cfr1...` recipient string the command prints. The string is a
public key, so any channel will do. The team member opens the workflow
page, chooses "Run workflow", and fills in the recipient string and, as
the username, the person's login. Minting revokes every key that login
already holds, so the team member checks the login before running it.
The person's waiting command finds the run by the recipient in its name,
checks that the key was minted for their own login, and installs it. The
dispatch log records who minted for whom.

`request` and `collect` are the same path in two invocations, for
somewhere a watching command is unwanted — a shell without a terminal to
interrupt, or a delivery collected on a different day than it was asked
for:

```
deno task test-records-key request
deno task test-records-key collect
```

The key travels sealed. The delivery identity is an X25519 key pair whose
public half is the `cfr1...` recipient string the tool prints and the
workflow takes as its input; the private half stays in
`~/.config/common-fabric/test-records-identity.json` and never leaves the
workstation. The workflow seals the minted key to that recipient —
ephemeral-sender X25519, HKDF-SHA256, AES-256-GCM, with both public keys
bound into the derivation — and publishes the box as a workflow artifact
named by the recipient's fingerprint. Everyone who can read the
repository's artifacts, GitHub included, holds a box that only the
requester's stored identity opens. What comes out is then checked
against the collector's own GitHub login, so a key minted for one person
does not install for another.

Keys stay valid while you stay active: a daily janitor disables the
accounts of people with no pull-request activity for a month and
re-enables them when they return — the same key file simply starts
working again.

You hold one live key: minting revokes the previous ones before it
creates the new one, so `deno task test-records-key setup --rotate` is
how a lost or leaked key is rotated, and a second machine gets the
existing key file copied to it rather than a fresh mint that would kill
the first machine's. A mint that fails after the revocation leaves you
with no key rather than two; the next run says so, and running setup
again mints one.

A key file on disk is not the same thing as a key that works, so setup
asks whether the one installed here is still accepted before it stands
down. A key that has been revoked — by a rotation from another machine,
or by a mint that failed after revoking the key it was replacing — is
replaced rather than mistaken for a working one, and no flag is needed
to recover. Where the question cannot be put at all, setup says so and
leaves the key alone.

## Taking it off a workstation

```
deno task test-records-key uninstall
```

removes what setup put there — the key file, the delivery identity, the
export it added, and the entry in each harness's configuration —
leaving any line or value a person set themselves alone.

Both commands write a profile the way a profile should be written. A
profile that is a symbolic link, which is what a dotfiles repository
leaves behind, is followed: the link stays a link and the file it points
at is what changes. A file's permissions carry over, so one kept
readable only by its owner comes back that way, and a file either of
them creates is readable only by its owner. Each replacement happens in
one step, because a shell startup file left half written is a shell that
will not start. And a file whose state cannot be read — permissions
withdrawn, a directory closed off — is reported and left alone rather
than guessed at.
Records that were spooled and never shipped stay where they are, since a
later key ships them; the command says where they sit and what removing
them would throw away.

Two things it deliberately does not do. The service account and its key
still exist, so a key that has leaked is made useless by minting a
replacement, from this machine or any other, and not by uninstalling.
And records already in the store stay there: they carry no personal
material, and no key this tool installs can change or remove anything
that is already stored.

## How records move

Locally, the entry point that owns the run stamps the spool with the
context at start (commit, branch, dirty flag, machine, agent label), holds
an advisory file lock the kernel releases on any process death, and ships
one gzipped object at the end — exactly one attempt, warning and moving on
if it fails. Every opted-in run also sweeps the spool root and ships any
spool whose owner's lock is free. Object names are deterministic, so
shipping twice collides on create and duplicates never come into being.

In CI, jobs hold no record-store credential. A lane gathers each batch's records
and JUnit reports into its spool as the batch finishes, marking each record with
its suite's variant. Each suite declares its JUnit outputs in the topology, so
the lane finds them itself, and its ship step names no JUnit files. The lane
ends with that credential-free step, which packs the spool into a
`test-records-tests-<lane>-a<attempt>` artifact. The Test Records Relay
workflow — the only CI principal that can write to the store — composes each
artifact's context from the trusted event payload and creates one object per
artifact.
Same-repository runs always ship. A fork run ships only when its actor is on the
infra-managed team member list, which is what lets team members' personal-fork
pull requests report while the store accepts nothing authored by anyone else;
other fork runs still run their tests normally and ship no records. Re-running
the relay, or dispatching it with a run id, re-ships idempotently.

The shared `test-records-ship` action accepts an optional `variant` input and
also reads the CI-only `CF_TEST_RECORDS_VARIANT` fallback. An explicit input
wins. This lets a workflow resolve a stable role to a variant once at job scope
without duplicating that expression at every shipping step. The action applies
the resolved value to every spooled and JUnit-derived record in that job; leave
both surfaces unset for the default configuration. The lanes set neither, since
a lane's batches can run in different configurations and the lane has already
marked each one.

The relay runs its parser from the default branch. Land parser, relay, reader,
and action support for a new optional record field before any test workflow
starts emitting it. Enabling a field in the same change makes the old relay
drop it from that change's pull-request artifacts before writing them to the
create-only store.

## Reading the data

Everything under the dataset is publicly readable:

```
https://storage.googleapis.com/storage/v1/b/cf-ci-metadata/o?prefix=labs/test-records/
```

Objects are gzip-encoded NDJSON served with transcoding, so a plain fetch
receives text. `packages/test-support/src/records/store-reader.ts` is the
validating reader; the readers built on it:

- `tasks/test-records-report.ts` — collisions, high-churn identity
  families, and the over-sixty-seconds list (`--gate` turns that list into
  the ratchet's exit status). A single day holds tens of thousands of
  objects, so it reads them several at a time, and a day it cannot list or
  an object it cannot read is left out rather than ending the run. Every
  such day is named on the standard error stream, as are the first fifty
  such objects, after which one line says the rest are not named. The
  printed report counts the objects it could not read, however many were
  named, and the days it could not list, whose objects it has no count of;
  every figure under those counts is over the objects that were read. A
  gated run exits 1 for a test over the rule, which is work to do, and 3
  for a window read in part, which is a ratchet that could not check
  rather than one that failed. It is run by hand: no workflow and no
  `deno task` entry invokes it.
- `tasks/test-records-compact.ts` — rewrites each closed day of raw
  records as a manifest and a few tens of rollup shards under
  `aggregated/`, sized so that a shard is a string a reader can hold;
  `--plan` reads the listing alone and shows what it would do without
  credentials. It writes from `.github/workflows/test-records-compact.yml`
  on a daily schedule, which is the only place its identity can be
  assumed; there is no key for it and no way to run the writing half by
  hand.
- `packages/dashboard/test-records-history.ts` — the dashboard's collector:
  cached per-identity daily series shaped for `trend.ts`.

Readers that join history across renames apply the alias file through
`loadAliasResolver` in `@commonfabric/test-support/records`, which the
report tool and the dashboard collector already do. A duration a consumer
reports or fits comes from passing records alone, for the reason the
specification gives; run, failure and skip counts come from every record.

Not every record in the store is a test. A lane measures its own setup
and each of its batches through the same machinery, so those
measurements sit alongside the tests, on kind `gate` and scope `ci` with
a name opening `ci-lane `. A consumer building anything per test leaves
them out: `isLaneMeasurement` from `@commonfabric/test-support/records`
recognizes one, and it is asked of `record.test` before any alias is
resolved. The report tool, the dashboard collector, the test-selection
fold and the topology check all do this. Leaving them in does more than
add an identity to the output. The figures are not all durations: of the
three a lane writes per batch, one says what the batch was packed to
spend and one counts the units it opened, so a sum over them is a number
that means nothing. `Status`, the job that scores a push run's coverage, writes
its figures as measurements too, named `ci-lane coverage …`, each holding a
count of uncovered lines, and three things read them back: the test-selection
publisher's coverage baselines, the dashboard's coverage debt tile, and the
report a `main` run posts on its pull request. ["Coverage figures in the record
store"](COVERAGE.md#coverage-figures-in-the-record-store) says how.
`tasks/lane-measurement.ts` composes the lane's names this recognizes. The
normative account is ["Recording" in the
specification](../specs/test-records.md#recording).

Consumers that feed decisions read only `submissions/ci/`, whose writer
credential never exists as key material. The relay's member gate means
everything stored was authored under the write-access group's trust —
`ci.fork` marks a team member's fork run — so the only distinction left
for a decision consumer is code provenance, not author trust:
pull-request runs execute unmerged code, and failure-rate or duration
baselines come from `ci.event` `"push"` runs, whose code the tree itself
carries. Both fields are stamped from the trusted event payload. A fork
run and a same-repository run of a pull request are therefore read
alike, and what `ci.fork` keeps a run out of is a baseline rather than
the data. It is set for a payload that did not name both repositories as
well, so a run the relay could not place is never taken for one of this
repository's own pushes.

Two attribution facts worth knowing when reading `local/` prefixes: the
minting workflow takes a username input, so anyone with repository write
access can mint a key for any username. A `local/<username>/` prefix
therefore attributes records to the key's named holder under the trust
of the whole write-access group, and the minting workflow's dispatch log
is the record of who minted what for whom.

## Covering a new test surface

A new test surface is a suite of the test topology, `tasks/test-topology.ts` and
the modules under `tasks/test-topology/`, and never a new job: the lanes run
what the topology declares and ship its records. A suite whose runner emits
JUnit declares each report, with its kind, scope and file prefix, in the
invocations its `command()` returns, and passes a `--preload` naming
`packages/test-support/src/records/preload.ts` where the surface is `deno test`.
`preloadArgument()` from `@commonfabric/test-support/records` returns that flag;
Deno resolves `--preload` as a path rather than through the import map, so it
must be absolute and no caller writes it out.

The preload does two things, and it only installs itself when it has one
of them to do: it captures the test file each test belongs to and
leaves the map in the spool, and it applies `CF_TEST_SKIP_LIST`. Wrapping
`Deno.test` costs a JUnit report the file attribution it carries on its
own, so a process with nothing to skip and no spool it may write leaves
`Deno.test` alone and the report's own class names are read instead.

Both of those need permissions. Reading `CF_TEST_RECORDS_DIR` and
`CF_TEST_SKIP_LIST` needs `--allow-env`, and that one the test task
grants: a task naming a restricted list of variables names those two
among them — `readEnv` swallows the refusal, so a task that leaves them
out records nothing and skips nothing, silently.

Writing the map needs `--allow-write` covering the directory the run
owner put the spool in, and that one the task cannot grant, because it
cannot name the path: `deno task` expands `$VAR` but not
`${VAR:-default}`, `--allow-write=` with an unset variable ends the run
with `Empty values are not allowed`, and a `$` costs its member the file
granularity `tasks/test-topology/deno-task.ts` reads its task for —
every `$` but the one command substitution that file resolves, which is
the `deno eval` naming the executable that several tasks already carry.
So the caller that appends the preload appends the permission beside it.
`spoolWriteArgument()` from
`@commonfabric/test-support/records` builds that argument, and it builds
none for an invocation already permitted to write everywhere. Deno merges
two `--allow-write` path lists, so an invocation naming a list of its own
takes the spool on top of it. A blanket grant is the one that cannot take
a list beside it: `-A` and `--allow-all` refuse the combination outright,
ending the run with `the argument '--allow-all...' cannot be used with
'--allow-write[=<PATH>...]'`, and a bare `--allow-write` or `-W` is cut
down to whatever list joins it. Short flags cluster, so `-RW` is a
blanket grant of both, and `-A` is one of everything.

It builds none for an invocation that cannot read the filesystem either,
and that is the case to hold on to. A writable spool is what makes the
preload wrap `Deno.test`, and wrapping is what costs the report the class
names ingestion reads each case's file from; the files that replace them
come from climbing to the directory holding `.git`, which needs read
permission. So the write and the read go together, and an invocation
granted one without the other records no file for any of its tests.
`tasks/test-topology/package-integration.ts` holds a part in that shape,
with `--allow-env` and no `--allow-read`.

Four callers append the preload, and three of them append the write
beside it. `tasks/workspace-tests.ts` appends both to each member's
`deno task test`, taking the write from `spoolWriteArgument()` directly.
The two topology suites append both to each invocation a batch runs —
`fileSuite` in `tasks/test-topology/suite.ts` and `unitSuite` in
`tasks/test-topology/unit.ts` — through `recordingArguments()`, which is
where the helper is called for them. The fourth, `tasks/integration.ts`,
appends the preload alone, because every invocation it builds runs under
`-A` and the helper would build nothing for any of them. A task there
that ever narrows its permissions needs the argument too.

A test task naming its own `--import-map` does not take the preload. That
map governs every module of the invocation, the preload included, so a
specifier the preload needs and the map does not carry fails the whole
run rather than the preload alone. Such a member keeps its JUnit path,
and its files come from the report's own class names instead — from the
ones that are a relative source path, joined onto the directory the
caller names, since a runtime or remote class name resolves to no file
and a report ingested without that directory records none.

What a class name reaches is the test file that registered the test
itself. A module of ours that registers on a file's behalf — a fixture
runner handed a directory of cases, a harness that replaces `Deno.test`
to give each test a clock — is the nearest frame below the runner, so
the class names it instead. Such a module's path tail goes in
`MACHINERY_MODULE_SUFFIXES`, so ingestion declines the class name rather
than recording the module as every test's file, and takes the file from
the preload's map. A surface that registers this way and cannot write a
map records no file.

The map needs nothing from such a module, or from any other helper that
registers tests. Deno runs each test file in a realm of its own with
that file as `Deno.mainModule`, and the preload names every test the
process registers after it, whichever module made the call. So, in a
run that takes the preload, a file that registers its cases through a
shared module is the file its records carry and the file its skip list
is keyed by, which is the path the command named and the one a topology
suite knows as its unit.

A harness with per-result callbacks
appends records through `FragmentWriter` (see the hooks in
`packages/cli/lib/test-runner.ts` and `packages/deno-web-test/runner.ts`).
Anything else wraps its command:

```
deno task run-recorded <kind> <scope> <name> -- <command...>
```

A wrapped command runs in a suite of the test topology, never in a workflow
step. The lanes run every test and gate the topology declares, so a step that
records by hand either records a check a suite already runs a second time
against one commit, or records one no lane will ever run or select. `deno task
check-test-topology` fails every such step, and says which of the two it is, on
the pull request that adds it. A command with no suite to register it under is
one to leave unwrapped: ["Recording" in the
specification](../specs/test-records.md#recording) says that a check no lane can
be asked to run is not recorded.

A harness that is also a library — one this repository's own tests drive
over fixture files — takes the decision to record from its caller, not
from the environment alone. Its entry point asks for records; a test
driving the same function does not, since the files it hands over are that
test's fixtures. `recordsSpooledBy` from
`@commonfabric/test-support/records` pins both halves of that: it points
recording at a fresh spool, runs the function, and hands back every record
the function left there.

A harness a test drives as a child process takes it the other way round,
since the child reads its own environment: the test hands the child an
empty `CF_TEST_RECORDS_DIR`, which is recording off. `tasks/integration.ts`
does that for the `cf` children whose files it times itself, and
`packages/deno-web-test/test/utils.ts` for the fixture projects it runs the
browser harness over.

The child inherits every variable the test's own process carries, so a
test that starts one names each recording variable it cares about,
including the ones the child is meant not to have. `CF_TEST_SKIP_LIST` is
the one to name deliberately. A lane runs a package's tests with a skip
list naming everything inside it that lane did not select, so a child
started from such a run is handed a skip list nobody asked it to carry.
Two things then follow from a list the child's own test never wrote. The
preload wraps `Deno.test` for a child whose test set up a run that wraps
nothing. And where the bdd re-export loaded before the preload, a skip
list is what makes the preload end the run rather than warn and carry on.
An empty value is unset for that variable too, so naming it beside
`CF_TEST_RECORDS_DIR` is the whole of it.
`packages/test-support/test/records/preload.test.ts` starts a recording
child on purpose, and names both.

Every test must finish within sixty seconds in CI, not counting setup; a
check that cannot is a container to split, and the report's over-60s list
is the work queue for that. The list is built from passing executions, so
a failure that a wait's safety net ended at its bound does not put a test
on it.
