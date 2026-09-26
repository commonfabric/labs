# Choosing which tests a pull request runs

Status: in progress. All three parts are built, and `deno.yml` runs the lanes.
What remains is the proof that needs a pushed branch: `plan --verify` against a
`main` run, a green `ci: full` run on the branch, and `plan --dry-run` over the
reference records. Then the plan is archived. [The work](#the-work) carries the
detail. The record store this plan consumes is live and holds the data the
design needs, apart from what [What the store is
missing](#what-the-store-is-missing) names.

In the reference build this plan measures against, continuous integration for a
pull request ran 67 jobs and every test in the repository. This plan replaces
that with five jobs that run a chosen subset, chosen from what the test-record
store already knows about which tests have caught real regressions, refreshed
every few hours, and packed so that each of the five jobs finishes in about the
same time and within five minutes. A push to `main` still runs everything, and a
label on a pull request runs everything there too.

Selecting a subset breaks two things that depend on running the whole
suite, so the plan carries their replacements rather than leaving them
broken. Coverage becomes a trend somebody can act on rather than a gate,
except in the one place where a pull request can still measure the whole
of something and compare it honestly. And a regression that only `main`
catches gets reported back to the change that introduced it,
automatically, addressed at the change and never at a person.

The design is written so that adding a test, a new kind of test, or a new
configuration of existing tests is a change to one repository module and
never a change to the continuous-integration configuration. That property
is the point of the whole exercise: a selection system that has to be
rewired every time somebody adds a test surface costs more than it saves.

It should land in one pull request, with no flags and nothing to flip: it
is live the moment it merges. [The work](#the-work) sets out the three
parts it is built in, and why none of them needs a pull request of its
own.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent checkbox complete only after all its children pass. Keep
this plan current in the same commits as the implementation. Once the work
has landed, archive it under
`docs/history/plans/` following
[`../README.md`](../README.md).

## The vocabulary, briefly

- An **identity** is the durable name of a test: the three required parts
  kind, scope, and name, plus an optional variant for a non-default
  configuration, defined by [the test-record
  spec](../specs/test-records.md). Everything here is built on the complete
  identity.
- An **item** is the smallest thing a runner can be asked to run on its
  own. It holds one identity or many, depending on the suite. For a
  pattern test the item is one file and the file supplies the name, so the
  two coincide. For a unit test the item is usually the file, and every
  `Deno.test` in it is a separate identity, which is where almost all of
  the repository's identities live. For the command-line integration
  script the item is a single-step dispatch arm, which records the one
  identity named for its step. [Selecting one test rather than one
  file](#selecting-one-test-rather-than-one-file) specifies how the item
  stops being the unit of selection.
- A **suite** is a named group of tests that share one runner and one
  environment: the workspace unit tests, the pattern integration tests,
  the pattern integration tests under the server-execution flag, and so
  on. A suite knows how to list its items and how to run a subset of
  them.
- A **capability** is one piece of environment setup: the Deno toolchain,
  a FUSE package, a running Toolshed server, a browser sandbox
  adjustment. A suite declares the capabilities it needs.
- A **batch** is the items of one suite that have been scheduled into one
  job.
- A **lane** is one of the five pull-request jobs. A lane runs several
  batches in sequence.
- The **topology** is the repository module that declares every suite and
  every capability. It is the single place a new test surface is
  registered.
- The **manifest** is the published selection data: every known item, its
  score, its estimated cost, and a reference packing into lanes. It lives
  in the record store, not in git.
- The **publisher** is the scheduled workflow that reads the store, scores
  every item-level identity, and writes a manifest.
- The **lane runner** is the repository script the five pull-request jobs
  all run, differing only in which lane number they are given.
- A **catch** is one occasion on which a test failed and the evidence
  points at a change rather than at the test or the machine. Catches are
  what makes a test worth running; the whole score is built on them.
- A **flake** is a test that disagrees with itself: it passed and failed
  at the same commit, in the same order, with nothing between the two runs
  but chance. A run that shuffles its tests does so by a seed fixed for the
  commit, and a run that does not keeps them in declaration order, so the
  order is part of what "the same" means here; see
  [Flakes and repeats](#flakes-and-repeats).
- A **repeat** is running one item more than once inside a lane, to raise
  the chance of catching something intermittent.

## The problem

The record store measures everything this design needs. The reference
build is the workflow this design replaced, and it ran every test on every
pull request whatever that data said.

A successful `deno.yml` push build on 2026-08-25, [run
32899488580](https://github.com/commonfabric/labs/actions/runs/32899488580)
at commit `c8893b3a8`, is the reference throughout this plan. Its workflow
contained 67 jobs. 66 ran and the pull-request `Status` job skipped. The
jobs consumed 181 minutes of runner time and took 15 minutes and 23
seconds of wall time from first start to last finish. Under that workflow,
every pull request paid nearly all of that, and paid it again on every push
to the branch.

The same build's 59 stored test-record objects describe the recorded test
work. They hold 17,999 test executions under 17,995 distinct complete
identities. The runners' own measurements of those executions add up to
166 minutes and two seconds. The distribution is extremely skewed:

| Executions | Count | Share of executions | Summed duration | Share of summed duration |
| --- | --- | --- | --- | --- |
| Over 60 seconds | 15 | 0.08% | 30.2 minutes | 18% |
| Over 10 seconds | 163 | 0.9% | 78.0 minutes | 47% |
| Over 1 second | 1,831 | 10% | 148.6 minutes | 89% |
| Under 100 milliseconds | 14,032 | 78% | 2.6 minutes | 1.6% |

This was the latest successful `main` run when the census was taken. It
includes the server-execution record marking. The `server-execution`
variant contributes 386 executions under the same number of distinct
identities and 10 minutes and 32 seconds of measured time. The remaining
17,613 executions, under 17,609 identities, are the unmarked default
history. The census groups identities with the canonical three- or
four-part key and applies the duration thresholds to individual record
executions. It includes deliberately overlapping records such as an
`integration.sh` invocation and the steps inside it, so summed record
duration is not unique wall time and cannot be added directly into item
cost. None of these counts becomes a policy constant.

Both share columns are against the run's whole 17,999 executions, and the
first three rows nest: every execution over 60 seconds is also one
over 10. Read down the two together and the skew is the gap between them.
A tenth of the executions hold nine tenths of the time. Just under four
fifths finish in under a tenth of a second and hold one and a half
percent of it, which is 2 minutes and 35 seconds across all of them.

That skew is what makes this cheap. The objective is to run the tests that
find things, and those are few. What the skew adds is a bonus: the cheap
tail costs so little per test that a run can carry a large part of it as
well, so a pull request spends a small fraction of the time and still runs
most of the tests. Running the valuable tests is the requirement and
carrying the tail is the bonus. [What the census can
project](#what-the-census-can-project) treats them that way.

The second half of the problem is that the reference build's jobs were
wired by hand. Its 67 jobs came from about 18 job definitions in
`deno.yml`, each with its own setup steps, its own sharding scheme, its own
artifact names, and its own entry in three `needs:` lists. Adding a test
surface to that workflow meant editing the workflow, the `Status` job's
dependency list, the coverage gate's dependency list, and often a sharding
weight table. That cost is what led people to put a new test in an
existing job where it did not belong.

## What the design must satisfy

1. Pull-request continuous integration is exactly five jobs. Nothing else
   runs on a pull request, unless somebody asks for the full run by
   labelling the pull request, in which case the five do not run and the
   full run does. One or the other, never both.
2. Each of the five finishes within five minutes, setup included, and the
   five finish at about the same time as one another.
3. Selection is driven by three signals from the record store: how
   recently a test last failed, how many distinct sources have reported it
   failing, and what fraction of its runs fail.
4. A small share of each job runs tests drawn from outside the
   high-value set, so the unselected corpus keeps producing data and keeps
   being covered.
5. Tests that need the same setup are grouped so the setup is paid once
   for the group.
6. A push to `main` still runs every test, and every failure fails the
   run, apart from the tests measurement has shown too noisy to judge a
   change by, which report rather than fail. Those of them that can be
   run without their neighbours run there more often than anywhere else,
   which is what keeps their measurement going.
7. Selection is recomputed every few hours, and what it produces is not
   stored in git.
8. Adding a test, a kind of test, or a configuration of existing tests
   does not change the continuous-integration configuration, and the
   addition is picked up both by the full run on `main` and by
   pull-request selection.
9. Coverage keeps going up. It stops being a gate on `main`, where a
   landed change that adds one uncovered line must not turn anything
   red, and on pull requests for everything a pull request cannot
   measure whole. It keeps gating the one thing a pull request can still
   measure whole: a package whose own unit tests are what cover it,
   scored over its own source by those tests alone.
10. A regression that reaches `main` is reported back to the change that
    introduced it, without turning that into a record of who broke what.
11. Flaky tests are found, and the finding is used: to run intermittent
    things more often where that catches more, and to keep tests too
    noisy to judge from blocking anybody. A test kept out of pull
    requests for being flaky goes on being measured on `main`, and where
    it can be run without its neighbours it is measured there often
    enough that its share can rise as well as fall.
12. Every dial is in one documented place, and a pull request can opt out
    of selection entirely and run everything.

Requirement 8 is the one that shapes the architecture. Requirements 1
through 7 could be met by a script that hard-codes today's 18 job
definitions; requirement 8 cannot. Requirements 9 through 11 are what a
subset costs, paid for rather than written off.

## The shape of the system

Five pieces, with one direction of dependency between them.

**The topology** lives in the repository, at `tasks/test-topology.ts` and
the modules it pulls in. It declares each suite: what capabilities the
suite needs, how to list the suite's items from the working tree, how to
classify a record identity as belonging to an item or to the suite, and what
command runs a given set of items. It is the only place a new test surface
is registered.

**The publisher** is a scheduled workflow. Every four hours it reads the
record store, folds the new records into a rolling per-day aggregate,
scores every item-level identity, estimates every item's cost, packs the
result into five lanes, and writes one manifest object into the store. It
writes nothing into git.

**The lane runner** is `tasks/ci-lane.ts`. The five pull-request jobs all
run it, passing their lane number. It resolves the manifest from the date
on the commit it has checked out, reads the working tree through the
topology, adjusts the plan for what this particular pull request changed,
works out which batches belong to its own
lane, sets up the capabilities those batches need, runs them, and records
the results the same way every other job in this repository does.

**The full run** on `main` uses the same topology and the same lane
runner, with selection switched off. Its job matrix is computed from the
topology rather than written out in the workflow, so a new suite appears
in the full run without a workflow edit. A pull request labelled
`ci: full` gets the same job, so opting out of selection is one click and
runs exactly what `main` runs.

**The reporter** follows every `main` run to completion, works out what
that run learned that the pull request behind it did not, and says so on
that pull request. A test that failed for the first time at this commit,
a coverage debt increase, a new test that turned out to be flaky: all
things the change's author wants to know and nobody currently tells
them.

The dependency direction matters: the publisher and the lane runner both
depend on the topology, and neither depends on the other's internals. The
manifest is the only thing that passes between them, and it is a validated
data format rather than a shared code path.

## The topology

A suite is a value with the following shape. This is the whole interface
that a new test surface has to implement.

```typescript
// Shown for illustration only.
interface Suite {
  /** Stable identifier. Appears in manifests, logs, and timing records. */
  id: string;

  /** Every kind and scope this suite's records may carry. */
  recordSurfaces: Array<{ kind: string; scope: string }>;

  /** The non-default configuration in which every item runs. */
  variant?: string;

  /** Setup this suite needs before it can run. */
  needs: CapabilityRequest[];

  /** Environment variables its commands run with. */
  env?: Record<string, string>;

  /** Every available item and every configured unavailability. */
  enumerate(): Promise<{
    items: Item[];
    unavailable: Array<{
      item: Item;
      leafName?: string;
      phase?: string;
      reason: string;
    }>;
  }>;

  /** Whether a recorded identity belongs to an item or to the suite. */
  locate(identity: TestIdentity):
    | { level: "item"; item: Item }
    | { level: "suite" }
    | undefined;

  /** The command and typed JUnit outputs for exactly these items. */
  command(items: Item[], output: OutputPaths): {
    run: Command;
    junit: Array<{
      path: string;
      kind: string;
      scope: string;
      filePrefix?: string;
    }>;
  };
}
```

The identity and execution members carry most of the design.

`recordSurfaces` lists the kinds and scopes a suite can emit. It is a list
because one runner does not imply one scope: `workspace-unit` spans every
workspace package, and the package integration command spans `runner`,
`runtime-client`, and `shell`. The optional `variant` is suite-wide because
the suite declares the configuration in which every one of its items runs.
Default suites omit it. The server-execution `opposite` suites derive their
variant from the posture they actually exercise: `server-execution` for ON or
`server-execution-off` for OFF. The registry's summary table states the
current default; the opposite suites' variant follows it.

`enumerate()` is what makes a new test visible without a workflow edit. It
reads the working tree — usually a file glob, sometimes a list parsed out
of a script — and returns the items that are available right now, plus any
item or exact leaf deliberately unavailable in this configuration. A test
file added by a pull request appears in `enumerate()` on that pull
request's own checkout, which is how a brand-new test gets run before any
record of it exists.

`locate()` is the bridge from history to execution. The store speaks in
identities; the runners take file paths and section names. For a pattern
test the identity name is its path, while the suite supplies its record
surface and variant. For a unit test `locate()` needs the file the identity
came from, which the record carries as metadata; [the test-record
spec](../specs/test-records.md) says where a producer gets it.

Most identities locate to an item and take part in scoring and item cost.
An overlapping task-level record locates only to the suite. For example,
`integration.sh` records the whole invocation in addition to its step
records, and the same task identity appears for several dispatch sections.
It proves that the topology knows the record surface, but it cannot identify
one item and must not be summed with its own steps. Suite-level records stay
available to reports. The lane runner's non-overlapping batch timing records
provide the cost calibration after lanes exist.

One identity locates to at most one item, even where several ways of
running it exist. The command-line script's dispatch table overlaps on
purpose: the `all` arm, the grouped arms, and the single-step arms each
begin some of the same recorded steps, so the step named `integration.sh
piece-values` is reachable from four different arms. Exactly one of those
arms is that step's item. The suite decides which by what `enumerate()`
returns, and it returns only the arms it means as items, so the arms that
exist for people running the script by hand never become items and never
make an identity ambiguous.

`locate()` accepts an identity only when its kind and scope are one of the
suite's declared record surfaces and its variant exactly matches the
suite's variant. This applies to both item and suite locations. An unmarked
record therefore maps only to a default suite, and a marked record maps only
to the matching non-default suite. The same source item may appear once in
a default suite and once in a variant suite; those are independently
selectable items with separate histories.

`command()` describes each JUnit output separately because one command may
produce reports for several record surfaces. Its descriptors supply the
kind, scope, and optional file prefix used to ingest each report. The
suite supplies the variant shared by all of them. Direct records already
carry their kind, scope, and name; the runner checks their record surface
against the suite before applying that same variant.

No suite exempts itself from selection. An item runs because the change
touches what it covers, because nothing has a record of it, or because it
is worth what running it costs, and a repository gate is held to those
rules the way a unit test is. `deno fmt --check` earns its place from the
failures it has caught; a suite that could declare itself exempt would be
a suite whose worth nothing measures.

Answering "what does this item cover" belongs to the suite, because a
unit that is not a path is one only its suite can map a diff onto. A
suite whose units are files needs to say nothing: the diff naming the
file is the whole of the question. A suite whose units are type-check
groups, gate names, or binaries maps the diff itself, and a suite that
maps it wrongly runs too much or too little rather than reporting
anything, so the answer errs toward running.

### The reference build's jobs as suites

The reference build's `deno.yml` held 18 job definitions. This table maps each
to the suite that runs its tests, and it is the migration's checklist.

| Suite | Reference build's jobs | Record variant | Capabilities |
| --- | --- | --- | --- |
| `repo-gates` | `Check` (all but the type check) | — | `deno`, `github-api` |
| `repo-history-gates` | the two append-only gates in `Pattern Update State and Baseline Integrity` | — | `deno`, `git-history` |
| `typecheck` | `Check` (the type check) | — | `deno` |
| `workspace-unit` | `Test (1..8)` | — | `deno`, `fuse`, `browser` |
| `runner-unit` | `Runner Tests (1..8)` | — | `deno` |
| `cfcheck` | `CFC Pattern Check` | — | `deno` |
| `pattern-compat` | `Pattern Update Compatibility (1..3)` | — | `deno` |
| `pattern-vintage` | `Pattern Update State and Baseline Integrity` | — | `deno`, `git-history` |
| `generated-patterns` | `Generated Patterns Integration Tests (1..2)` | — | `deno`, `compile-cache` |
| `package-integration` | `Package Integration Tests (3 suites)` | — | `deno`, `toolshed-baked`, `browser` |
| `package-integration-opposite` | the posture opposite the server-execution default | resolved arm variant | `deno`, `toolshed-baked-opposite`, `browser` |
| `deployed-topology` | the cf-harness default-posture gate | — | `deno`, `toolshed` |
| `cli-core` | `CLI Integration Tests (3 suites)` | — | `deno`, `toolshed`, `cf`, `jq` |
| `cli-fuse` | the FUSE steps of the third CLI suite | — | `deno`, `toolshed`, `cf`, `fuse` |
| `cli-deno` | the Deno-based CLI integration step | — | `deno`, `toolshed`, `cf` |
| `pattern-integration` | `Pattern Integration Tests (1..10)` | — | `deno`, `toolshed-baked`, `browser`, `compile-cache` |
| `pattern-integration-opposite` | the posture opposite the server-execution default | resolved arm variant | `deno`, `toolshed-baked-opposite`, `browser`, `compile-cache` |
| `pattern-reload` | `Pattern Reload Integration Tests` | — | `deno`, `local-dev-servers`, `browser` |
| `pattern-unit` | `Pattern Unit Tests (1..4)` | — | `deno`, `cf`, `compile-cache` |
| `binaries` | the compiles inside `Build Binary (toolshed)` and `Build Binary (cf)` | — | `deno` |
| `binaries-opposite` | the toolshed compile whose shell is opposite the server-execution default | resolved arm variant | `deno` |

The server-execution suites now keep stable `default` and `opposite` roles.
`default` follows the one first-party constant without changing its unmarked
record identity. `opposite` explicitly selects the inverse, and its record
marker names that actual posture. No identity alias joins these histories: the
unmarked default continues by construction, and each non-default posture keeps
its own marker.

### Declared unavailable tests

A configuration-specific skip is neither an unknown test nor evidence that
the topology missed a surface. Whichever role resolves the server-execution ON
posture reads `tasks/server-execution-on-skips.ts` as part of its topology;
the role that resolves OFF runs every file. The skip registry remains the
single source of truth for the phase and reason; the selection system does not
grow a second list.

A whole-file entry removes that file from the variant suite's enumerated
items. The manifest reports it as unavailable under that suite and variant,
with the registry's phase and reason. A step-level entry leaves the file
item in the suite because every other step still runs. It marks only the
skipped leaf identity unavailable, so that leaf is excluded from the
unknown-identity rule while the rest of the file's identities behave
normally.

Removing either kind of skip makes the file or leaf ordinary topology
again. Until a full `main` run records it, it is unknown and therefore
mandatory. This gives removing a skip the same safe rollout behavior as
adding a new test. The existing rule that the skip registry must be empty
when server execution becomes the default remains unchanged.

The build jobs (`Build Binary (toolshed)` and the two beside it) do not
become suites for the reason they exist today. They are not tests; they
are setup, and as setup they become capability providers.

They do become suites for a different reason. A pull request runs its
servers and its command line from source and compiles nothing, so a
compile that breaks would be found on `main`, after the change that broke
it has merged — where today it is caught before it lands. So `binaries`
makes each shipped binary a unit whose test is that it still compiles,
and `binaries-opposite` does the same for the toolshed under the define
opposite the default, which is the same build in a different configuration and
therefore a variant of it rather than a second test.

Every one of those builds passes `--no-check`, so this is not a second
type check: `deno task check` owns that. What a compile catches that
nothing else does is resolving the whole import graph from an entry
point, bundling the browser shell, and embedding each `--include`d asset
from a path that has to still exist.

Nothing forces a build to run. A binary the store has never seen is
unknown and therefore mandatory, so each is built once; after that it
sits at the value floor until it catches something. When a compile does
break, `main` catches it, and a `main` catch is weighted half again for
being exactly the escape this system exists to stop — one of them lifts a
build from the floor to several times it, which is enough to be chosen
against a corpus where almost nothing has ever failed.

The alternative was a map from changed paths to the binaries they can
break. It is the kind of transcribed table [sharding stops being written
down](#sharding-stops-being-written-down) exists to delete: a compile
reaches the whole import graph from an entry point, no short list
describes that, and the list would go stale the first time an import
moved. The cost of leaving it out is that the first compile to break
reaches `main`, which is the trade this design makes everywhere else and
is what the feedback loop then closes. The deploy and attestation jobs stay exactly as they
are, since they only ever ran on `main`.

**`cli-fuse` carries the fine granularity the rest of this depends on.**
`packages/cli/integration/fuse-exec.sh` records an identity for each phase
it goes through, through the `cf_test_step_begin` markers `integration.sh`
also uses. Its 23 phases record under 25 names, because one of them
announces under one of three sentences depending on how deeply it probes,
and each of those is an identity of its own. Each marker leads the phase
it names, so a phase that fails is the record that carries the failure,
and the two phases that bring the mount up and wait for it to hydrate
record like the rest, so a mount that never comes up is reported as the
mount. Scoring, the flake rate and the 60-second ratchet each get a
number per phase where they had one covering a FUSE mount, a Toolshed
server and everything the script does with them.

The script also takes a section, so a lane can be pointed at part of it.
Which phases can stand alone was a question about the script rather than
about selection — the same independence question [asked of unit
tests](#skipping-assumes-tests-do-not-lean-on-each-other) — and the answer
is four sections rather than one per phase. A section is a group of phases over one
mount rather than a phase on its own, because the mount, the daemon and
the piece cost more than every phase together and each section needs all
three. Four phases therefore run whichever section was asked for, and are
not selectable. A fifth is not selectable for the same reason without
being in that group: the phase that puts the callable files in place is a
precondition of three of the four sections, so each of those runs it
first. The rule the topology applies covers both — a phase more than one
section runs names no single section, so it is a suite-level record
rather than one belonging to a unit.

Two dependencies decide where the boundaries fall, and both are about
state a phase leaves behind. The handler phases assert `messageCount` as
an absolute count up from the piece's initial zero, so they stay together
and in order. The source update ends by asserting `lastMessage` is the
empty string the truncate phase left, so it sits in the section holding
that phase. A third ordering is why the entity listing is one of the
phases that always runs: its assertion is that no entity payload has
crossed the memory proxy, read from a trace that accumulates over the
whole run, so nothing may hydrate the piece before it.

`packages/cli/test/fuse-sections.test.ts` holds the dispatch table to
those orderings, and to every phase being reachable — from `all`, from a
section smaller than `all`, and from what the workflow dispatches.

`pattern-reload` is one unit, the reload directory, and its suite lists that
unit in `whole`. `packages/patterns/integration/reload/` holds a single file
with a single `it()`, so the unit holds one identity and there is nothing inside
it to leave out. The task cannot be pointed at part of the directory:
`packages/patterns`' `integration:reload` task hard-codes its glob, and
`tasks/integration.ts` dispatches `patterns-reload` in a branch ahead of the one
honoring the name filter, so a filter handed to that target is dropped. A second
reload case would still run with the first. Giving the suite one unit per file
would need both of those changed.

`pattern-reload` also shows why capabilities are named rather than
implied. It needs a server, but not the one the other integration suites
need: its job downloads no binary and starts nothing, because
`deno task integration` brings up the whole local dev stack itself on a
chosen port offset. Calling that `toolshed` would be wrong, and a lane
that opened a Toolshed server for it would have paid for the wrong thing
and still failed.

### What a workspace member's own task decides

A member's test task cannot be handed a subset of its own files: almost
every one of them lists its own paths, so appending more would add to
what runs rather than restrict it. What the task does carry is everything
else a run needs — the permissions, `--no-check`, a fake-clock preload,
an `ENV` assignment in front — so the topology reads the task for those
and replaces its paths with the chosen ones.

Most of the forty-seven members are readable that way, and nearly every
unit the topology holds is one test file. The rest are one unit each and
run whole. Three task shapes are still read a file at a time. A task written as
a dependency list is read through to the `deno test` it depends on. The one
command substitution the workspace writes, which names the running Deno in an
`--allow-run` list, is resolved rather than treated as a shell metacharacter. A
task that runs the batch runner `tasks/run-test-batches.ts` is read as the `deno
test` that runner runs. The directory the runner walks gives the paths to
enumerate, and the flags after its `--` are the flags the tests run under. The
runner exists for the members, `cli` and `dashboard`, that have files needing
flags of their own: its `--serial` and `--all-access` options name those files,
and the topology gives each of them the flags the runner would.

Two things a member's own `deno test` would apply are applied during
enumeration instead: the task's `--ignore` globs and the member's
`exclude` list. Deno filters discovered modules through both and an
explicit path through neither, so a file arriving as a positional
argument would otherwise run in spite of being excluded.

### Sharding stops being written down

A job can be given a slice of work only by somebody deciding in advance what the
slices are, and the reference build decided at two levels. Inside the workspace
job, `INTERNALLY_SHARDED_PACKAGES` split `agents-host` three ways, `cli` ten,
`piece` three, and `tasks` three, and `packages/runner` ran apart from the
workspace as eight `Runner Tests` jobs, chosen by
`tasks/select-runner-test-files.ts`. A table of numbers somebody transcribed
from a green build balanced each split: `tasks/test-timing-weights.ts` held five
of them, 164 lines of relative costs that go stale the moment a test gets
slower. One level up, the shard matrices in `deno.yml` — eight for the workspace
tests, ten for the pattern integration tests, three, four and two for the rest —
were the same decision written in a different file.

None of it survives the topology. An item's cost comes from the record
store, measured on every run rather than transcribed from one, and the
packer distributes items by that cost. A package with 675 test files is
675 items, and where they land is arithmetic. Nothing in the tree is a timing
table, a per-suite file selector, a shard parser, or a shard or disabled-package
variable, and `packages/runner` is the `runner-unit` suite like any other. The
packer in `tasks/test-selection/plan.ts` does its own longest-processing-time
packing. The full run's job matrix is computed from the topology.

That is the deletion the topology buys, and it is worth naming separately
from the selection it enables. A repository that shards by hand pays a
maintenance cost every time a test's cost changes, and pays it in a file
nobody thinks about until a shard runs long. Nothing outside the machinery
listed here reads those tables, so the deletion is clean.

## Selecting one test rather than one file

The store scores identities and the packer chooses items, and for the unit
suites those are not the same size. A unit-test file holds many
identities, so choosing one test with a record of catching things drags in
every test beside it, and skipping one expensive test means skipping its
whole file. Almost all of the repository's identities sit behind that gap.

Closing it does not need a single test file edited. This section specifies
how, and says where the gain is real and where it is not.

### Why `deno test --filter` is not the mechanism

The obvious tool does not do the job. `--filter` takes a substring, or a
pattern between slashes which Deno compiles with Rust's regular expression
crate. That crate has no lookaround, so "run everything except these
names" cannot be written at all.

It fails in the worst available way. On Deno 2.9.4 a pattern the crate
cannot compile does not error: every test is filtered out and the run
exits zero. A malformed filter is a green run of nothing, which is the one
result continuous integration must never produce quietly.

Inclusion patterns do compile, and they are the wrong shape anyway: a
filter listing the tests to run silently drops a test the pull request
just added, because its name is not on a list built from records that
predate it.

### Most tests are not registered where you would think

A test's identity is the name its runner reports, which for a file written
with `describe` and `it` is [the describe chain joined with `" > "`
](../specs/test-records.md#identity). Deno reports the container as a
testcase too, and `dropContainerCases` in
`packages/test-support/src/records/junit.ts` throws it away, so what
reaches the store is one identity per `it`.

Registration does not follow that shape. `describe` registers one
`Deno.test` and every `it` inside it is a step within that one test. So an
interception on `Deno.test` sees the container and never the leaves, and
the two granularities come apart exactly where the tests are: 1,283 test
files use `describe` and `it`, 85 percent of those hold exactly one
top-level `describe`, and between them those files hold 15,191 `it`
blocks. For 1,096 files, skipping the registered `Deno.test` is skipping
the whole file, which is what items already do.

Reaching an `it` therefore needs a second interception, and both are
available without editing a test file.

### Two interception points, and no test file changed

The first is the preload
[part one](#part-one--the-data-and-what-it-already-tells-us) already adds
to `@commonfabric/test-support`, which wraps every `Deno.test` to capture
the module that registered it. It gains the skip list, and that reaches
every bare `Deno.test` — 511 files' worth.

The second is a line in the import map. `@std/testing/bdd` resolves to a
module in `@commonfabric/test-support` that re-exports the real one under
another specifier, tracks the enclosing `describe` chain, and registers a
listed `it` through `it.ignore` instead of `it`. Every file keeps its own
`import { describe, it } from "@std/testing/bdd"` unchanged; what that
specifier means changes once, centrally.

Neither interception needs anything from the layers between the workflow
and the test. The import map is repository-wide, and the skip list's
environment variable is inherited by whatever a task spawns, so a suite
reached through `tasks/integration.ts` or a package's own runner is
reached without those learning a new flag. `--filter` would have needed
every one of them to pass it along, and at least one does not:
`tasks/integration.ts` dispatches `patterns-reload` in a branch that sits ahead
of the one honoring the name filter, so a filter handed to that target is
dropped without a word. That suite takes no skip list either, because it runs
whole.

One more thing recommends routing it through a module of ours.
`@std/testing/bdd` is deprecated: its own documentation says it will be
removed at 2.0.0, points at `node:test` instead, and describes the
migration as mostly a matter of changing the import. That specifier in
1,283 files has to change anyway. Sending it through one module now turns
that migration into an edit of one file rather than of all of them.

Both consult the same **skip list**: the identities this invocation is not
to run. A listed test is registered as ignored rather than dropped, so it
appears in the run's output and in its JUnit report as skipped, and the
store learns it was deliberately not run instead of watching the identity
disappear.

Four properties come from intercepting at registration rather than on the
command line. The list is a file named by an environment variable, so
nothing is bounded by argument length. Names match exactly, so nothing
needs escaping. The list is keyed by test file and name together,
because the same test name occurs in more than one file and the preload
already computes the file for its attribution work. And no test file
changes at all: a suite that already passes `--preload` takes a second
one, since repeating the flag works where the comma-separated form does
not, and the import map is one line.

One consequence is worth stating because it looks like a bug when first
seen. Wrapping `Deno.test` moves Deno's own JUnit `classname` from the
test's file to the preload, for skipped and unskipped tests alike. That is
already why `ingestJUnit` joins on the preload's name-to-file map rather
than on `classname`, and it is a reason the two features belong in one
module rather than two.

### The list says what not to run, never what to run

An identity the store has never seen is not on the skip list, so it runs.
A test the pull request just added runs. A renamed test runs, because the
new name is not the old one. A test whose file moved runs.

This is [an identity with no records must
run](#two-rules-that-force-a-test-in) enforced by construction rather than
by a rule the packer has to remember, and it is the whole reason the
mechanism is a skip list rather than a selection list.

### Every invocation unit, and the identities inside it

Most invocation units hold one identity. The skip list exists for the kinds that
hold more. One of those kinds holds almost everything: the workspace and runner
unit shards carry 15,997 of the reference build's 17,999 executions.

The topology records which units a lane may hand a subset to. Each suite lists
in `whole` the units whose runner runs every identity in them, whatever it is
asked. `tasks/test-topology.test.ts` requires every other unit to be a test file
in the tree, because the registration preload reads a skip list under that
file's path. A unit that is neither would get a skip list that matches nothing,
and its lane would run every test in it while being charged for one.

| Invocation unit | Suites | Identities inside it | Reaching one of them |
| --- | --- | --- | --- |
| A `deno test` file | `workspace-unit`, `runner-unit`, `pattern-integration` and its ON arm, `package-integration` and its ON arm, `generated-patterns`, `cli-deno` | Every bare `Deno.test` in the file, and every `it`, named as its describe chain joined with `" > "`. The container testcase Deno also reports is dropped at ingestion, so a `describe` is not an identity | The skip list, through the preload for a bare `Deno.test` and through the remapped `describe`/`it` for the rest. This is the row the whole section is about. |
| A workspace member whose test task takes no file list | `workspace-unit` | Every test of the member's Deno-only half | Nothing to reach. The skip list is keyed by the file that registered a test, and this unit is the member's directory, so the member runs whole. |
| A member's browser half | `workspace-unit` | Every test the browser harness runs for that member | Nothing to reach. The harness runs the files its own task names, and this unit is the whole half rather than a file. |
| A pattern file run by `cf test` | `pattern-unit` | One. The runner writes one record per pattern file | Nothing to reach: the file is the identity. |
| A pattern file checked by the compatibility gate | `pattern-compat` | One, named `pattern-compat <key>`, which the task appends itself as each file's verdict is known | Nothing to reach. The task already takes `--only` to restrict which files it reads. |
| A pattern file type-checked by `cfcheck` | `cfcheck` | One, named `cfcheck <path>`, carrying what the batch spent on that pattern's own files | Nothing to reach. The task takes `--only` the same way, and the unit is the path the diff names. |
| A single-step arm of `integration.sh` | `cli-core` | One, named for its step | Nothing to reach. The script's own whole-invocation record is suite-level and belongs to no invocation unit at all. |
| One gate command | `repo-gates`, `repo-history-gates` | One, named for the gate that ran | Nothing to reach. |
| One binary build | `binaries`, `binaries-opposite` | One, named `build-binary <name>` | Nothing to reach. |
| One `deno check` invocation | `typecheck` | One, named for the path group it checked, which the task records itself | Nothing to reach. |
| The reload suite's directory | `pattern-reload` | Every test under it | Nothing to reach. The task always runs the same directory and starts the local development stack around it, so a lane runs the whole suite or none of it. |
| One committed vintage fixture | `pattern-vintage` | One, named for the fixture's test key, tier and capture stamp | Nothing to reach. The task takes `--only` to choose which fixtures to replay, and the unit is the fixture's path. The replay's record for the whole run belongs to the suite, not to a unit. |
| A section of `fuse-exec.sh` | `cli-fuse` | The phases that section alone selects. The phases more than one section runs record against the suite instead, since they name no single section | Nothing to reach below the section. A mount comes up for the section, not for the phase, so its phases run or are skipped together. |

Most of the rows are one identity per invocation, which is why this
change is smaller than removing a concept sounds. The topology does not
gain a mechanism for them; they simply stop being described as items
holding one identity each and start being described as identities.

Four rows hold more than one identity and offer nothing finer to reach: a member
that runs whole, a member's browser half, the reload directory, and a
`fuse-exec.sh` section. These are the units in `whole` that cost something, and
the last column of the table says why each is there.

A member is in that group because of its test task. It leaves the group when the
topology can point that task at files. Two members, `cli` and `dashboard`, are
read a file at a time through the batch runner rather than through a plain `deno
test`.

### What it reaches, and what it does not

The identity is the floor, and with both interceptions in place the floor
is reached everywhere the store has an identity to score. What is left
below it is a `t.step` inside a bare `Deno.test`, which the store does not
name separately either, so nothing is lost that selection could have used.

The module still loads. Skipping a test inside a file does not avoid
importing that file, and for some suites the import is most of the cost:
the reference build's eight runner unit shards hold 1,120 seconds of
measured tests inside 1,583 seconds of test steps, and the difference is
largely module loading. So what this buys is the tests' own time and not
the file's.

That is exactly where the time is. 1,831 executions run for over a second
and hold 148.6 minutes between them, and they are scattered through files
whose other tests are cheap. Being able to leave the slow ones out of a
file the lane is running anyway is the lever the item granularity was
hiding.

### Skipping assumes tests do not lean on each other

Not every identity can run on its own, and the mechanism does not make it
so. It stops the other tests running; it does nothing about what this one
needed them for.

Setup and teardown are not the problem. `beforeAll` and `afterAll` belong
to the `describe`, which still registers and still runs when some of its
`it`s are ignored, and `beforeEach` and `afterEach` run around each `it`
that survives. A test that gets everything it needs from those is
unaffected.

The problem is a test that reads what a sibling wrote.

The interface says that is not what an `it` is for. `@std/testing/bdd`
documents `it` as registering "an individual test case", and offers
`it.only`, `it.skip` and `it.ignore`, none of which means anything unless
one case can run without its siblings. Jasmine, Jest and Mocha use the
same vocabulary, and parts of that family shuffle declaration order by
default to keep the claim honest.

Nothing here enforces it. The module says nothing about ordering, and Deno
runs the cases in the order they were declared. Every test run in this
repository now shuffles its order, but `deno test --shuffle` reorders files
and each file's top-level registrations, not the `it`s inside one, so the
cases of one `describe` still run in declaration order. A dependence between two
cases is therefore not something anybody would have been told about, and
the reasonable prior is that some exist.

A scan finds over a hundred files in which one `it` assigns a binding
another `it` reads. It cannot tell a real dependence from a `beforeEach`
that resets the binding first, which is why that number is a suspicion
rather than a count.

Nothing establishes that a particular identity stands alone before a lane
skips its siblings. A test that did lean on one fails, or waits for state
nothing established until its job's step is killed, and that is the first
evidence anybody has that the dependence is there. `main` is no refuge
from it: the full run selects every identity, but the packer places each
identity on its own, so one unit's identities can land in different lanes
and each lane invokes that unit with the identities the other lanes took
registered as ignored.

### `granularity` goes with it

The `Suite` interface declared `granularity`, `"item"` or `"whole"`, so a
runner that could not be handed a subset could say so and the packer could
charge it for everything whenever anything in it was picked. Both halves
move one level down, to `Suite.whole`.

The packer charges a whole unit for all of its identities.
[`unitOverhead`](#what-it-costs-to-run-one-test) charges a lane for opening a
unit and then for each identity the lane chose. That is correct for a unit that
can skip the rest. It is too little for a unit that cannot, because a lane
taking one test of a whole unit runs all of them. `plan()` therefore merges each
unit in `whole` into one choice before it packs. That choice costs what all its
identities cost together, and it is held back when any of them is. The plan
lists the identities again in its place. The merge exists only inside the
packer. The manifest and the records name identities, so every reader that
matches a record to an entry or to a plan finds it by its own name.

The declaration moves with it. Whether the identities inside an invocation unit
can be skipped is a property of that unit, not of the suite around it.
`cli-fuse` shows this. Its phases record separately, and a section holding four
of them cannot skip one of the four. A `deno test` file with four tests can skip
one. Both suites would have carried the same value of the old field, yet they
behave differently, so the field was in the wrong place.

A unit that runs whole has to be declared, because its shape does not show it.
The skip list the preload reads is keyed by the repository-relative file that
registered a test. No skip list can name anything inside a unit that is not such
a file. A suite that neither declared such a unit nor made it a file would give
its lane a skip list that matches nothing. A run would not show the problem:
every test of the unit passes, and the lane reports a pass while running longer
than the packer planned. `tasks/test-topology.test.ts` therefore checks the
declaration: every unit outside `whole` has to be a test file in the tree.

### What replaces the item

The item was doing two jobs, and they separate cleanly.

The **selection unit** becomes the identity. Scores, costs, the two
exclusion rules, the two mandatory rules, repeats and the manifest all key
on the complete identity, which is what the store has always spoken in.

The **invocation unit** stays what it was: a file, a script arm, whatever
the suite's runner can be pointed at. It has to, because identities cannot
be enumerated from a working tree. Learning a test's name means running the
file that registers it, so a tree walk can only find containers. That is
also what keeps a brand-new file discoverable, and it is why `enumerate()`
survives this change unaltered.

So the topology contract moves by less than the vocabulary does.
`enumerate()` keeps its job and `locate()` keeps its job. What changes is
that `command()` takes identities rather than items, and returns one
invocation per file carrying that file's skip list, with a file whose every
identity is skipped not invoked at all.

### What it costs to run one test

The cost model gains one term:

```text
invocationCost(unit) = unitOverhead(suite)
                     + sum over the identities not skipped of cost(identity)
```

`unitOverhead` is fitted per suite from the lane runner's own records,
exactly as `suiteOverhead` and `correction` are, and is measured rather
than chosen. Per suite rather than per unit because that is the grain the
measurement supports: a lane times a whole batch, so what a batch says is
one equation over the units it opened, and a figure for each unit
separately is not in it. It is charged per unit all the same, once for
each unit a lane opens.

The packer changes shape because of it. An identity's cost now depends on
whether its unit is already being invoked: the first identity chosen from
a file pays the overhead and every later one pays only itself. So the
density pass sorts by marginal cost rather than by cost: choosing one test
from a file makes its siblings cheaper to add, and moves them up the
ordering. That is a
better model of the machine than per-file items ever were, and it falls
out rather than being imposed.

### What does not change

- A measured set runs whole, so the invocations of a set the coverage
  gate is scoring carry no skip list.
- Suites that are not `deno test` need no mechanism. Every one of their
  invocation units holds a single identity, so skipping it is declining to
  invoke it.
- Skipping does not reach the drift guard.
- A repeat names an identity and invokes its file with every other
  identity in that file skipped.

### What the specifier resolves to when the module goes away

Sending the specifier through one module of ours turns the migration off
a deprecated `@std/testing/bdd` into an edit of one file, as
[two interception points](#two-interception-points-and-no-test-file-changed)
says. What that file should become is a `describe` and `it` written
here, which build the chain themselves and register under it, keeping
one `Deno.test` per suite with a step for each leaf. Nothing a test file
written in the bdd style has to change: the import map already resolves
the specifier to our module, and this is a change behind it. What that
buys, beyond the identity faults below, is a registrar the rest of the
test machinery can hook into instead of replacing `Deno.test` behind
each other's backs.

#### What it fixes

Every fault the re-export has produced is a recorded name disagreeing
with a reported name. A wrapper with nothing to do stood between the
test file and the registrar and took the class name, so almost no record
carried a file (#7126). The leaves of a file declaring a hook outside
every `describe` carried none, since the runner reports those beneath a
root suite it invents while the tracked chain opened at the file's own
outermost `describe` (#7173). A leaf whose call names its suite by
handle was the same shape (#7184), and a leaf named after its body was
the same again (#7195).

The name map is a join, and a join fails on a wrong key whatever carries
the key. Each of those entries was written and filed under a name no
leaf had. A module that builds the chain and registers under it is
handed both halves of what the runner will report, so there is no rule
left for it to predict and no name for it to get wrong. That is the
whole of what this changes and the whole of what has been going wrong.

The clock harness gains the same thing. `installFakeClock` replaces
`Deno.test` as well, and tells a test that wants the real clock from one
that wants the fake one by asking whether a stack string contains any of
twenty-four file basenames. A registrar of ours is handed the file and
the leaf already, so that choice becomes an option on the `describe`
making it, and the twenty-four names and the reasons recorded beside
them move to the tests they are about. Nothing currently checks that
such a name still matches a file, and a rename would quietly move a test
onto the fake clock. What this does not reach is the harness's other
reader, which classifies who armed a `setTimeout` on every timer and
needs a stack because that caller is arbitrary source; auto-advance
rests on it and it stays as it is.

#### Why this shape and not another

The deprecation notice points at `node:test`, which cannot carry this
tree's tests: a `node:test` suite takes no `sanitizeOps`,
`sanitizeResources` or `permissions`, and the tree passes those 109
times.

Registering each leaf as its own `Deno.test` fails on group teardown.
Measured against Deno 2.9.4, `Deno.test.beforeAll` and its siblings take
the module as their scope and do not nest, the scope is not positional,
and a call inside a test body is accepted and then never runs. The
runner brackets its own hooks around whatever a filter leaves, and
around a file whose every test is ignored, but it never says which leaf
runs last and `afterEach` takes no argument naming one. So a module
holding a nested group's `afterAll` would have nothing to trigger it on.
One `Deno.test` per suite makes that hook ordinary code in the group's
body, owing the runner nothing.

Nothing is lost by putting the leaves in steps. `t.step` takes `ignore`,
reports an ignored step as a case carrying `<skipped/>` under its full
joined name, which is what the skip list asks for, and takes the
sanitizer options per step, defaulting to the enclosing test's.

Letting each test file call `Deno.test` itself was measured and
rejected. A case's class name follows the lexical call site, so a helper
may compute `ignore` and may even build the whole `TestDefinition` while
the report still names the test file; that would free the file
attribution and retire the name map, the spool and the container case
with it. It costs a line in each of 2,241 test files, and
a file missing that line runs no tests and reports none. Trading a
silent green run of nothing, in the system whose whole purpose is to
notice, against the deletion of machinery that works and has caused none
of the faults, is the wrong way round.

#### Nothing else needs to replace `Deno.test`

Three things sit between a test file and the registrar, and each got
there by replacing or shadowing `Deno.test`, because a global is the
only thing there is to reach for. The records preload replaces it to
apply the skip list and to capture which file a registration came from.
The fake-clock harness replaces it to wrap each body in `freezeAround`,
and to decide per test whether to wrap at all. The fixture runner does
not replace it, but stands between the file and the registrar lexically,
which costs the same class name and puts it on the same list.

Four things a registrar of ours can offer are the whole of what those
three do. A callback told of each leaf as it registers, with its file
and its identity. A predicate consulted at registration, so that a
listed leaf registers as ignored. Options carried from a `describe` or
an `it` through to the test. And a wrapper a suite installs once and the
registrar runs around every leaf's body.

That holds only while the registrar is the only caller of `Deno.test`,
which it is not today: 553 test files call it directly, at 7,327 sites.
Every one of those is the plain entry point, since `Deno.test.only`,
`Deno.test.ignore` and `Deno.test.each` appear nowhere in the tree, so
each site is a rename onto the registrar's own `test`. A file the rename
misses keeps its tests and keeps its file, since nothing wraps
`Deno.test` any more and a class name names the file that called it;
what it loses is its skippability, which is the direction to fail in. A
lint rule of the kind the tree already carries for self-imports holds
the invariant afterwards.

What goes with the replacements is the machinery for seeing around them,
which is a registry of the modules in the way, kept by hand.
`MACHINERY_MODULE_SUFFIXES` is an array of path tails that ingestion
reads to refuse a class name naming machinery rather than a test file,
and one registrar leaves it nothing to name.

The file itself needs none of this. Deno runs each test file in a realm
of its own with that file as `Deno.mainModule`, and that is where the
preload takes a test's file from, so a test a helper module registers
belongs to the file that imported the helper, and the path is the one
the command named and the skip list is keyed by.

The name map stays, because the file has to reach the process that
writes the record and that is not the process that knows it. A record's
file is what the topology places it by, and an identity the topology
cannot place is one the publisher leaves out of the manifest, which
makes every lane run it forever and score it never: of the 3,660
identities one reproduction of the publisher could not claim, 3,648 had
no file at all. A class name names whichever module called `Deno.test`,
so a bdd leaf's names the runner's own module and reaches a file only
through the case its `describe` registered; once a registrar of ours
stands there, that case names the registrar and the report carries
nothing. The registrar knows the file and does not write the record;
`ingestJUnit` writes it in another process after `deno test` has exited.
The map is what passes between the two.

What does get simpler is the lookup. `fileForName` walks the whole map
for each leaf and takes the longest registered name that leaf's own name
extends, because a bare `Deno.test` registers a container and its leaves
extend that container's name with the separator. A registrar writes an
entry per leaf under the whole identity, so the lookup is an exact one.
A name two files both register stops being two files that share a
top-level `describe` title and becomes two tests holding one identity,
which the store cannot tell apart either, so dropping it is then the
right answer rather than a loss.

#### What it leaves standing

The reconstruction goes: the root suite the runner invents, the suite a
call names by handle, the name a body carries, and the overload sniffing
that feeds them. Everything else stays as it is, that being the name
map, the spool, the preload's wrapper for a bare `Deno.test`, the JUnit
ingestion and the skip list.

One thing this does not reach is worth naming so it is not mistaken for
solved. A run killed at its bound writes no JUnit report at all, so
every case it had already passed is lost, which the specification's
claim that a killed run's records are worth reading does not currently
hold for.

Not measured: `it.only`, parallel execution, a step inside a leaf, and
what a `beforeAll` that throws should do to the rest of its group.

### The work this adds

- [x] The preload reads a skip list keyed by test file and name,
      and registers a listed bare `Deno.test` as ignored rather than
      dropping it.
- [x] `@commonfabric/test-support` gains a `describe` and `it` that
      re-export the real ones, track the enclosing describe chain, and
      route a listed `it` through `it.ignore`. The root import map points
      `@std/testing/bdd` at it and the real module at a second specifier.
      No test file's own import changes. A frame between the test file
      and `describe` moves the JUnit class name onto the re-export, the
      same consequence wrapping `Deno.test` already has, so ingestion
      declines a class name ending in either module and takes the file
      from the preload's name map.
- [x] Every `deno test` suite in the topology passes the preload, appended
      the way `--junit-path` already is.
- [x] `cost` and the packing passes key on identities, with
      `unitOverhead(suite)` fitted from the lane runner's records and
      charged for each unit a lane opens.
- [x] The density pass sorting by marginal cost, so that choosing one test
      from a file moves its siblings up the ordering rather than leaving
      them where their own cost puts them.
- [x] `command()` returns one invocation per file with its skip list, and
      omits a file whose every identity is skipped. A suite's runner takes
      several files at once, so the skip list is per file and the
      invocation is per package; module load is charged per unit either
      way, which is what `unitOverhead` measures.
- [x] A fixture proving the four properties that make this safe: an
      unlisted new test runs, a renamed test runs, a listed test is
      reported as skipped rather than missing, and two files holding the
      same test name skip independently.
- [x] Every unit a lane may hand a subset to is a test file the preload can key
      a skip list on. A unit whose runner runs it whole is listed in
      `Suite.whole` and gets no skip list.

### The drift guard

The topology is only worth having if it stays complete. A new test surface
that nobody registers would silently vanish from the full run, which is a
far worse failure than the workflow edit it replaced.

`deno task check-test-topology` closes that. A surface goes missing in
three ways, and the guard answers each.

The **tree half** needs no store, and is a unit of the `repo-gates` suite.
It walks the tree for things that look like tests — `*.test.ts`,
`*.test.tsx`, the integration directories, the shell scripts under
`packages/cli/integration/` — and fails if any of them is claimed by no
suite's `enumerate()`, or more than once under the same record surface and
variant. A default suite and a non-default suite may claim the same source
item because they are distinct execution surfaces. This is the half that
catches a pull request adding a test surface nobody registered, and it is
selected the way everything else is: a pull request that does not draw it
leaves the unregistered surface to the full run on `main`, which is where
the record of what this guard catches comes from. An entry in a
configuration's declared skip registry accounts for its unavailable file or
leaf without pretending it ran.

The **workflow half** runs beside it, on the checkout alone, over the
step definitions under `.github` — the workflows and the composite
actions alike. A step can wrap a command in `deno task run-recorded
<kind> <scope> <name>`. Those three words are the command's identity, and
every record the command writes carries that identity. The lanes run every test
and gate the topology declares, so a step that records by hand is one of two
things. Either a suite already holds the identity, and the step records that
check a second time against one commit, or no suite holds it, and it is a check
no lane will ever run or select. The half fails every such step, and its message
says which of the two it is: take the step out, or declare the check in the
topology and then take the step out. Nothing in the tree carries such an
identity, which is what puts it out of the tree half's reach.

The half admits no exceptions, because there is nothing for one to
cover. `docs/specs/test-records.md` says under "Recording" that a check
no lane can be asked to run is not recorded. The workflows record nothing by
hand, so the half passes, and it fails the first change that adds a recording
step.

The **store half** runs after a run's tests have finished, over that
run's own records, on a pull request and on `main` alike. It fails if any recorded identity is one that no
suite's `locate()` claims, or that more than one suite claims. A claim names
either one item or the suite-level measurement set. The match uses the
complete identity, including an optional variant. This catches the subtler
case: a surface that is registered and whose files enumerate, but whose
recorded names or configuration do not map back to the topology — which
would leave those tests running in the full run and never selectable on a
pull request.

The records have to be the ones this tree produced, and the half is given
the commit to hold them to: records from another commit are refused
rather than judged. A tree read against an earlier build's records
disagrees with them over every test the change between the two deleted,
because the topology has no unit for a test the tree no longer holds. The
same goes for a rename, since an alias applies to records from days
strictly before its date and the earlier build's records are from today.
Both are the repository working as intended, so a half that read them as
disagreements would fail `main` for deleting a test. That is also why the
half runs after the lanes rather than inside one: a gate running in a lane
cannot see the records of the run it is part of, because they have not
shipped yet.

The reverse direction is reported rather than failed: an available item
that `enumerate()` returns and that no run has ever produced a record for
is either a test that never runs or a mapping that is wrong, and both are
worth knowing about without blocking anybody. Entries in its unavailable
list are reported separately and do not count as missing records.

Together these are what make "no continuous-integration change needed" a
checked property rather than a hope.

The failure they guard against is not hypothetical either. Until
2026-08-21 the two server-execution ON jobs were the only test jobs in
`deno.yml` with no spool directory and no ship step, so their failures
reached no report and no dashboard, and a census of 25 flakes in that lane
had to be reconstructed from raw Actions logs. The fix added a
workflow-shape invariant to `tasks/ci-workflow.test.ts` — every job
writing a JUnit file must spool and ship. Under this design that invariant
mostly stops being needed, because there is one ship step in one job
rather than one per suite, and a suite cannot be added without going
through the topology that the drift guard checks. The one ship step does
not assign identity: the lane runner stamps each batch's records before it
combines them, as described under [The lane job](#the-lane-job).

## Capabilities and setup

A capability is a named piece of setup with an implementation that is
idempotent and that measures itself. The lane runner computes the union of
the capabilities its batches need, runs each one once, and then runs the
batches.

| Capability | What it does | Measured cost |
| --- | --- | --- |
| `deno` | Toolchain and dependency install | 7–14 seconds, always paid |
| `fuse` | `pkg-config gcc libfuse3-dev fuse3` | 2 seconds warm, about 15 cold |
| `jq` | `jq` | about 2 seconds |
| `browser` | Relaxes the AppArmor user-namespace restriction | under a second |
| `git-history` | Unshallows the checkout | 3–10 seconds |
| `github-api` | Exports the GitHub token the runner is holding, to the suites that declared it | under a second |
| `toolshed` | A Toolshed server listening on an allocated port | see below |
| `local-dev-servers` | The whole local dev stack, brought up by `deno task integration` on a chosen port offset | 15–20 seconds |
| `toolshed-baked` | The same, from a compiled binary, whose baked shell a browser can drive | 42 seconds to build, or 17 to restore |
| `toolshed-baked-opposite` | The same, from a binary whose shell carries the server-execution define opposite the default | 42 seconds to build, or 17 to restore |
| `cf` | The `cf` command-line tool on the path | as above |
| `compile-cache` | Restores a pattern compile byte cache | 3 seconds |

The three ways of providing a Toolshed server are worth explaining,
because the choice made among them is what keeps the five-minute budget
reachable.

**`toolshed` runs from source.** A server from a compiled binary built by a
separate job costs that build job on the critical path — 58 seconds in the
reference build, including its own setup — plus 17 seconds of download in each
consumer. Running the server from source with `deno run` skips both. The
dependency graph is already in the Deno cache that the `deno` capability
restores, so starting from source costs a few seconds. The full run on `main`
starts it the same way. The baked servers its lanes start are built by the lanes
from the same sources and the same build task as the release binaries, without
the commit and the shell endpoints the release binaries carry; the release
binaries are built by jobs of their own, beside the lanes, whose steps check
what those add. A suite that only talks to the server's API takes this one,
which is why the CLI suites and the deployed-topology gate do.

**The baked capabilities cannot.** The browser shell is a bundle compiled
into the binary, so a server run from source answers the API and serves no
shell, and a suite that drives a browser at one is told the shell app is
not available. `toolshed-baked` is the server for the default arm.
`toolshed-baked-opposite` is the server for the other arm, whose posture is
a compile-time define baked into that same shell whichever way it goes.
Both have a different provider: restore the binary from the Actions cache
if the key hits, and build it in place if it does not. The lane workflow
carries a fixed `actions/cache` step for each of the two binaries, covering
`.ci-cache/binaries/<name>` under the exact key `lane-binary-<name>-<binary
cache key>` with no restore prefix. Each binary has an entry of its own because
a lane builds only the ones it needs, and one entry holding both would keep
whichever the first lane to save happened to build. A capability that finds a
binary there uses it without asking what it was built from, so the key has to
change whenever anything a binary is built from does.
`tasks/binary-cache-key.ts` computes it as a digest of the git object id of
every tracked file under `BINARY_SOURCES` in `tasks/build-binaries.ts`. The
tests in `tasks/build-binaries.test.ts` hold the list to every path the build
reads and to every local module the binaries' import graphs reach. A change to
the shell's service worker, to the Deno release that `mise.toml` pins, or to a
JSON file an import reaches therefore moves the key like a change to any other
source. Those graphs start from each entry point and from each module in a path
the compile embeds with `--include`, because `deno compile` follows the imports
of both. The toolshed binary leaves out the files in the pattern trees that it
never serves: the integration tests, the recorded compatibility baselines,
every other test file, and every iframe guest source. The modules only those
files import are not embedded either.

A binary is also made from the environment it is built in, because the
shell bundle bakes environment variables in as compile-time defines. So a
capability that builds a binary it caches runs the build with a cleared
environment. It passes through only `BUILD_HOST_VARIABLES` in
`tasks/build-binaries.ts`, the variables the build needs from the machine,
such as `PATH` and `DENO_DIR`. A test fails if the shell's configuration
reads one of them, so none reaches a binary. The build is given only the
other variables that `cachedBinaries()` in `tasks/ci-capabilities.ts` names
for that binary, and every other variable it reads is unset. The key covers
that table as well as the sources, so a change to what a cached binary's
build is given moves the key even where no source changes, as when
`tasks/server-execution-ci.ts` changes which define the opposite arm is
given. A variable set in the lane's own environment cannot reach a cached
binary. Nothing sets `COMMIT_SHA` in a cached build, because a binary built
at one commit serves every later commit with the same sources.

Everything a lane wants to keep between runs sits under `.ci-cache`, with a
cache step for each thing kept, because they want different keys. The built
binaries are under `.ci-cache/binaries`, keyed by the binary cache key. The
pattern compile byte cache is under `.ci-cache/compile`, keyed
`cc-lane-<fingerprint>-<job>-<lane>-<hash of the pattern sources>` with the
restore prefix `cc-lane-<fingerprint>-`, where the fingerprint is the compiler's
own (`tasks/compile-cache-key.ts`). A compiled pattern is reused only where its
source is unchanged, so a cache another lane or an earlier commit left costs
nothing but the time to restore it, and the prefix lets a lane take any of them.
The hash of the pattern sources is what makes a lane that restored an older
entry save a fresher one, since an entry an exact key hits is never saved again.
Every cache step runs whatever the lane turns out to need, which is what keeps
the workflow independent of it. They are in the workflow rather than in the
runner because the cache service is only reachable through the action, and they
are written once and never touched again.

That split is the argument for having capabilities at all. Three ways of
providing "a Toolshed server" coexist, suites say which one they need, and
neither the workflow nor the other suites know the difference.

### What stays in the workflow

The lane job's steps are fixed and do not vary with what the lane runs:

1. Check out the repository at full depth.
2. Set up Deno.
3. Verify the lock file and install dependencies.
4. Plan the lane: `deno run -A tasks/ci-lane.ts` with the lane's arguments and
   `--dry-run`, which prints the lane's share, what it is projected to take,
   and what was withheld.
5. Resolve the binary cache key and the compiler fingerprint.
6. Restore the two built binaries and the pattern compile byte cache.
7. Run the lane: the same command with `--described`, which packs the same plan
   again, names it in one line, and runs it.
8. Upload what a failing lane left behind.
9. Upload the lane's coverage reports.
10. Ship test records.

Everything conditional happens inside steps 4 and 7. That is what makes the
workflow independent of the topology. The one cost is that a capability which
genuinely needs a GitHub Action — the two caches are the only ones that do — has
to be represented by a fixed step that runs unconditionally and cheaply.

Step 8 uploads what a lane leaves behind for somebody to read. A lane that
failed keeps its own working directory, where a server's log is, and that
directory sits under the job's temporary directory so the upload can reach it; a
lane that passed removes it. Step 7 also runs with `ulimit -c unlimited` and
puts the core of any process in the lane that crashes natively under
`$RUNNER_TEMP/ci-lane-cores`, which the same upload carries.

Step 9 uploads the lane's coverage directory without its raw profiles, as
`lane-coverage-<job>-<lane>`. An artifact is rooted at the directory its paths
share, and the readers find a set's report by its place under that directory, at
`lcov/sets/<suite>/<member>/coverage.lcov`, so the upload names the coverage
directory rather than the reports' own. A measured set the lane saw fail is
marked by a file beside its report, and the file saying whether the compile
cache was restored sits beside the reports, and a glob over one extension would
drop both. A re-run of the lane overwrites what the attempt before it uploaded,
so `Status` reads each lane once.

## What the store gives us and what it is missing

The store gives, for every execution it records: the identity, the
outcome, the runner's own duration measurement, the commit, the branch,
the workflow run and job, whether the run was a push or a pull request,
whether it came from a fork, and for local runs the reporting person. That
is everything the scoring needs.

The identity already carries an optional variant. Unmarked records made
before a non-default arm acquired a marker stay in the default history;
the publisher does not infer identity from a historical job name. The
`server-execution` histories therefore begin when those jobs started
emitting the marker. This loses the older ON arm's attribution but avoids
inventing an identity that the stored record did not carry.

The volume is real. The store took 11,432 objects on 2026-08-20, from 251
workflow runs, of which about one in six was a push to `main`. Even a
three-week read is about 250,000 objects. Nothing can afford that
on every publisher run, which is why the publisher keeps a rolling
aggregate; see [The publisher](#the-publisher). How far back each part of
the score reaches, and what a longer reach would cost, is [its own
section](#how-far-back-each-term-looks).

### What the store is missing

**The workspace runner records nothing for a test task it cannot read.**
It hands a `--junit-path` to a member's Deno-only half where it can read
a `deno test` in the member's `test` task, or where the member is one of
the few runner scripts listed as forwarding the flag to the one
`deno test` underneath. A member it can read neither way produces no
report for that half. What its tests reach the store by then is a
harness of the member's own — the browser runner, or the pattern test
runner — and a half with neither is not recorded at all.

The two readers of a task disagree about which members those are. The
topology reads whichever half a member declares, and then the tasks that
half names as its own dependencies, taking the first that reads as a
single `deno test`; a `deno test` any deeper than that it does not
reach. The runner reads only the `test` task's own command. Every member
whose `test` task is written as the list of tasks it depends on falls in
that gap: the topology enumerates it a file at a time, and no report
those files could be recorded in is ever produced. The store half of
[the drift guard](#the-drift-guard) is where those items are reported.

What that costs is an item scored at the floor rather than a selection
that cannot run. `locate()` places a unit record on an item by its file,
so a member with no records has no identity landing on any of its files.
Each of them is then an item no manifest knows, and [an identity with no
records must run](#two-rules-that-force-a-test-in) makes every one of
them mandatory, so all of them run, on a stand-in entry rather than on
anything measured about them. It also holds the full run short of the
precondition this design sets itself: a successful run whose records
account for every item the topology enumerates, with no absences but the
ones a skip registry declares. Closing it reaches the members' tasks and
the runner that reads them rather than the store.

**Compaction is live.** The compactor's identity was provisioned on
2026-08-31 and its daily workflow has rolled up every day from 2026-08-19
up to the newest day it has reached. The floor is where the store's
records begin. The ceiling moves with the daily run, which only touches
days that closed a week ago. Compaction collapses a day of raw records
into a manifest and a few tens of shards, which is the difference between
reading 15,000 objects for a historical day and reading a manifest and
seventeen shards. A day is a manifest and shards rather than a single
object: a day of records is over a gigabyte of NDJSON, against a maximum
string length of about half that, and an object has to fit in a string
both to be written and to be read.

**A re-run's earlier attempts can be stored a second time.** An object's
day partition comes from the run's start time, and GitHub reports that
per attempt rather than per run: across four re-run builds in this
repository every one reported a later start for its second attempt, one
of them nearly six hours later. Artifacts are scoped to the run rather
than to the attempt, so a later attempt's relay re-ships the earlier
attempts' as well as its own. Where two attempts fall either side of a
UTC midnight their partitions differ, so the re-shipped records are
written as a second object under the later day rather than colliding with
the first, and the publisher folds both because it keys on the object
name. A survey of five days of the store, 68,822 objects, found no run
identifier written into two partitions, so this has not happened yet.

What it would distort is narrower than it first looks, and the rest of
this paragraph is inference rather than measurement. Catches are safe by
construction, because each is attributed to the pair of the commit and
the source that saw it. Costs are a percentile over many observations and
would barely move. Duplicating a report doubles its failures and its runs
together, so a ratio over both is largely unmoved — but the report that
gets duplicated is the earlier attempt's, which is the one somebody
re-ran because it failed, so `churn` would carry those failures twice
against run counts that are only partly duplicated.

Fixing it means settling something this plan should not settle on its
own. The partition wants to be stable across attempts, while a record's
context honestly wants the attempt's own start, and one field is doing
both jobs today. The change reaches `ciObjectName`, the compactor, and
[the record spec](../specs/test-records.md), so it belongs to the store
rather than to selection, and it is its own piece of work.

## Scoring

### What the score is trying to measure

A test earns its place in a pull request by having caught real breakage
before. That is a property of the test, not a symptom of a problem: a test
that found a regression once sits somewhere in the code where mistakes get
made, and it will find the next one. Somebody running it locally, finding
it red because of what they were writing, and fixing it, is the clearest
possible evidence — and it says the next person writing similar code
should have that test run for them in continuous integration, whether or
not they thought to run it themselves.

That is a different quantity from "this test is currently flaky", and
scoring the two together was the mistake worth avoiding. A test failing 30
percent of the time carries almost no information per failure. A test that
has failed four times in two years, each time because somebody broke
something, carries a great deal. Flakiness is dealt with separately, in
[Flakes and repeats](#flakes-and-repeats), where it belongs.

So the score is built on **catches**, and it decays slowly. A test that
caught something two years ago has probably not stopped being a good test.
It might have — the code it guards may have been rewritten, or nobody may
work in that area any more — so the decay is not zero. But it is measured
in months, not days.

### What a catch is

For every failing record, the publisher asks whether the failure says
something about a change or something about the test.

A failure is a **catch** unless one of these holds:

- The identity also failed in the most recent `main` run at or before that
  commit. The test was already broken; this run learned nothing.
- The identity both passed and failed at the same commit. That is a flake
  observation, and it is recorded as one.
- The identity failed across many unrelated branches within the same short
  window. That is the environment or a dependency, not any one change.

What is left is a test that went red where its neighbours were green, and
that is the thing worth counting. Each catch is attributed to the pair of
the commit and the source that saw it, so re-running the same broken
commit ten times counts once.

### Where a catch happened changes what it means

A catch is always a point in the test's favor, and the place it happened
says something further. The three places are worth keeping apart, because
they answer different questions.

A **local catch** is somebody at a workstation, part way through writing
something, running a test and finding it red. It is the highest-quality
evidence this system can receive: no ambiguity about what changed, no
shared infrastructure to blame, and the person went on to fix it. It also
answers the question the score exists to answer — the next person writing
similar code, who will not think to run that test, should have it run for
them. It counts double.

A **pull-request catch** is the test going red on a change before it
landed. That is continuous integration doing its job, and each one is a
measured instance of the selector's own objective being met.

A **main catch** is the test going red on a change after it landed. It is
still a point in the test's favor — the test found something real — but it
is also a record of an escape: this test would have prevented a red `main`
if it had run on that pull request, and it did not. For selecting what to
run on the *next* change, that is the most directly relevant fact there
is, so a main catch is not discounted for having come late.

The distinction that matters most is what repetition means, and it depends
entirely on which of the three is repeating.

A test with a dozen local and pull-request catches over a year is not a
problem. It is one of the best tests in the repository: it keeps finding
things, each time before they reached anybody else, and every one of those
is an argument for running it more widely.

A test with a dozen `main` catches over a year is a different thing. Some
of it is the same fact — the test keeps finding real breakage — but the
pattern also says the same class of mistake keeps reaching `main`, and
either the test is not being run early enough or something about that area
invites the mistake. The first of those is this system's job to fix, and
it fixes it automatically, because main catches raise the score that gets
the test selected.

### The inputs

For each complete identity that the topology locates to an item, the
publisher computes:

- `catches` — how many catches it has, over all of history, weighted by
  where each happened.
- `lastCatch` — when the most recent one was.
- `sources` — how many distinct sources are among those catches. A source
  is the branch for a continuous-integration run and the reporting
  person's login for a local one, so a test that has caught things on five
  branches and for two people has seven.
- `churn` — recent failures over recent runs, with each day's counts
  halved every 14 days as they age.
- `flakeRate` — how often it disagrees with itself; see
  [Flakes and repeats](#flakes-and-repeats).
- `cost` — the ninetieth percentile of its passing durations on the
  worst of the last seven days. The ninetieth percentile rather than the
  maximum, because one unlucky runner should not permanently inflate an
  estimate, and rather than the mean, because a cost model that
  under-estimates blows the time budget. A day is held as its slowest
  executions and the count of all of them, so that the parts a day
  arrives in combine into the percentile of the whole. Only passing
  executions are measured: a failure ended where the failure was
  reached, and where a wait's safety net ended it, its duration is that
  net's bound. Only executions on continuous-integration runners are
  measured, too: a workstation is another machine, faster or slower by
  however it differs from a lane's runner, so its records count as
  evidence about the test and not about its cost. A day records the set of cost rules that sealed it, or
  carries no record where it was sealed before any were kept, and a day
  an earlier set sealed answers only until the rules in force have
  sealed one for that test.

Variants never fold into one another for scoring. A default test and its
`server-execution` counterpart have independent catches, flake rates, and
costs. They may both be selected when their own records justify it.
History from one configuration does not make an unseen configuration look
established.

### The formula

```text
catches   = 2.0 * localCatches + 1.0 * prCatches + 1.5 * mainCatches

if catches == 0:
    record = 0                       # no lastCatch exists to measure from
else:
    proven    = 1 - 0.5 ** (catches / 2)
    freshness = 0.3 + 0.7 * 0.5 ** (daysSinceLastCatch / 120)
    record    = proven * freshness

value = 0.05 + 0.55 * record + 0.25 * breadth + 0.15 * churn

breadth = 1 - 0.5 ** (sources / 2)   # sources counted among catches, so 0 here
```

The no-catch branch is not decoration. A test with no catches has no
`lastCatch`, so `daysSinceLastCatch` does not exist, and an implementation
that reaches for it anyway gets a missing value rather than a large one.
Multiplying `proven`, which is zero, by a missing number yields a missing
number and not zero, and a missing score sorts unpredictably against real
ones. The branch has to be written, not left to the algebra.

What it guarantees is worth stating exactly, because "scores the floor" is
close to true but not true:

- A test that has **never failed anywhere** scores exactly
  `VALUE_FLOOR`. Every other term is zero by construction: no catches, no
  sources among catches, no recent failures.
- A test with **no catches but recent failures** — every one of them
  classified as flake evidence, or as a continuation of an already-red
  `main` — scores `VALUE_FLOOR + 0.15 * churn`. That is intended, not a
  leak: `churn` is the "something is going wrong right now" term and is
  deliberately independent of whether the failures were catches.

Both are worth a test, and the second one more than the first, since it is
the case where a plausible implementation quietly produces a missing
value.

The three catch weights say what the section above argued. A local catch
counts double for the quality of its evidence. A main catch counts one and
a half times, not because a late catch is better than an early one, but
because it is a recorded instance of exactly the mistake this system
exists to stop making: a test that would have caught something on a pull
request and was not run there. Weighting it up is the feedback loop that
fixes that on its own.

`proven` saturates: one pull-request catch is 0.29, two are 0.50, four are
0.75, and no number of them reaches one. A test that has caught four
separate things is already known to be a good test and a fifth catch
should not let it crowd out everything else.

`freshness` multiplies `proven` rather than adding to it, which is what
makes the decay slow and bounded. A catch last week keeps essentially all
of its value; one from four months ago keeps two thirds; one from two
years ago keeps a little over the floor of 0.3. A proven test never falls
back to being an unproven one, and that is deliberate.

`breadth` is the same saturating shape over distinct sources. Several
people and several branches independently hitting the same test is the
difference between "this test guards something one person touches" and
"this test guards something the team walks into".

`churn` is the only fast-moving term and it carries the least weight. It
is there so that something visibly going wrong right now gets attention
before the slow terms have caught up.

`0.05` is a floor under everything. A test that has never caught anything
scores exactly the floor, and without one its value-per-second would be
zero and it would only ever run through the exploration draw. With it, a
50-millisecond test that has never failed has a value-per-second of one,
which beats a 100-second integration test scoring 0.9 by a factor
of 100. That is the right answer, and it is what points the density pass
at the cheap tail before anything else.

### How far back each term looks

There is no single window. Each input looks back as far as it stays
meaningful and no further, because they want very different horizons and
one number damages most of them.

| Input | Horizon | Why |
| --- | --- | --- |
| `catches`, `lastCatch` | unbounded | The point of the reframing. A catch is a permanent fact about a test; `freshness` does the discounting, and it does it gently. Cost is a counter and a timestamp per identity. |
| `sources` | unbounded, alongside `catches` | Counted only over catches, so it does not saturate the way a count over all failures would. |
| `churn` | decayed, 14-day half-life, read over 60 days | Wants "is this going wrong now". A long undecayed window inverts it; see below. |
| `flakeRate` | 60 days | Flakiness is a property of the test as it stands, and tests get fixed. |
| `cost` | 7 days | Durations drift with the code and the runner image. |

The counts behind `churn` are decayed rather than cut off. That removes
the cliff a hard window has, where a failure on day 21 counts fully and
one on day 22 counts not at all, and it makes the read window a
performance choice rather than a policy one — past 60 days the weight is
under one part in 16.

**Why `churn` must decay.** An identity in the full matrix executes about
250 times a day. Take two tests: A started failing three days ago and has
failed every run since; B was broken for a week eight months ago, failing
about 60 percent of its runs that week, and has been green since.

| Window | A, failing now | B, fixed eight months ago |
| --- | --- | --- |
| 21 days, undecayed | 750 / 5,260 = **0.143** | 0 / 5,260 = **0.000** |
| 365 days, undecayed | 750 / 91,260 = **0.008** | 1,050 / 91,260 = **0.012** |

Over a long undecayed window the long-dead outage outranks the live
breakage, because a ratio over a long window measures total historical
brokenness rather than the current rate. Decay fixes it without a cut-off:
B's week contributes about one part in 5,000 after eight months. Note that
B still scores well overall — its catches are permanent — which is exactly
the intended behavior. What decays is the claim that something is wrong
*now*, not the claim that the test is good.

### The rule that keeps a test out

This is a subtraction from the selectable set, and it makes pull requests
less red rather than more.

**A test whose flake rate is above the threshold is not selected.** It is
too noisy to judge a change by. `main` still runs it, the dashboard still
shows it, and it appears on a work queue. This replaces the usual
quarantine list, and it is better than one in three ways: it is derived
from measurement rather than from somebody's judgement at one moment, it
needs no owner or expiry to stop it rotting, and it reverses on its own as
the test goes back to passing. That last property is the one the exclusion
would otherwise take away from itself, since a test it holds out of pull
requests is left with runs that can only lower its share; [An excluded test
still runs on `main`](#an-excluded-test-still-runs-on-main) is what keeps
it. The exception is a change that edits the test itself, or that the
test's suite maps onto its unit, which is very likely a fix and has to be
allowed to prove itself.

**The rule reaches a repository gate as well.** Formatting, linting and
the drift guard are tests of the tree, and the rule says nothing about
one of them that it does not say about a unit test. A gate above the
flake threshold leaves the selectable set, and appears on the dashboard
as the defect in the gate that it is.

The exception the rule carries reaches a gate through the paths the gate
declares a change reaches it by. A gate's unit is the name of a gate
rather than a path, so the suite maps a change onto its units from a list
each gate carries: `check-test-aliases` names
`tasks/test-identity-aliases/`, `check-action-pins` names
`.github/`, and a change touching one of those makes that gate mandatory.
The pull request that fixes a gate too flaky to judge by therefore runs
it, which is what the exception is for.

What a gate declares is bounded rather than exhaustive, and two bounds
are what keep this a fraction of what a lane runs rather than the bulk of
it. No one gate may be reached by a significant share of the tree, and no
one file may reach more than a few gates. So a gate whose input is a
large part of the repository names the small and specific part of it —
`check-docs` names the documents holding the code blocks, and not the
modules those blocks compile against — or names nothing at all, which is
what formatting, linting, the drift guard and the cycle check get. A gate
naming nothing reaches a lane on what it is worth or because nothing has
a record of it, so a flaky one stays out of pull requests until it stops
disagreeing with itself.

The asymmetry is what makes those bounds affordable. A gate named by too
little is decided by the score, which is the same decision every test
gets. A gate named by too much takes its share of every lane's budget
forever, on the strength of a declaration rather than of anything
measured, which is what the removed exemption did.

What the lane owes people in exchange is clarity about whose problem it
is. The job summary names what was withheld and why, and says of each
whether it ran anyway because the change reaches it, so nobody spends time
looking for a pre-existing failure in their own diff.

### Two rules that force a test in

**An identity with no records must run.** This is not a preference; [the
test-record spec](../specs/test-records.md#trust-boundaries-for-consumers)
requires it of any consumer that selects which tests run, on the grounds
that a selector which never runs the unselected starves its own data and
that a renamed test is an unknown identity until an alias lands. The lane
runner enforces it at item granularity: an available item that
`enumerate()` returns and that no known identity with the same variant
locates to at item level is mandatory. A suite-level measurement does not
make any item known. An identity explicitly declared unavailable by that
variant's skip registry is not unknown. History from the default
configuration does not satisfy this rule for a new variant. A newly marked
suite therefore runs in full, apart from its declared unavailable tests,
until a successful `main` run has produced records for it.

**What the change touches must run.** A pull request that edits a test and
does not run it is not something this repository should permit, so a
changed test file's items are mandatory. A unit that is not a file, such
as a type-check group or a binary, is one its suite maps the change onto,
since only the suite knows what its unit covers. A changed *source* file
forces nothing else in, apart from the whole of a [measured
set](#the-measured-set) the change reaches. What runs for it otherwise is
what the score chose, which is the trade named under [consequences we are
choosing](#consequences-we-are-choosing).

### Renames, and the alias file

Renaming a test used to cost a little history. Under this design it costs
all of it, and the cost falls in the worst possible place.

`catches` accumulates over unbounded history and is the whole of what
makes a test worth running. Rename the test and the store's records still
sit under the old identity, the new name has none, and the best test in
that area drops to the floor — at the exact moment somebody is working
there, since renaming it is what they were doing. A test with four
catches, worth 0.75 on `proven`, becomes worth 0.05. It will still run,
because an unknown identity is mandatory, but only once, and then it
disappears into the tail.

`tasks/test-identity-aliases/` already solves this and the mechanism
needs no changes. The directory holds one file of lines per test-file
name and reads as a single set. A line maps an old identity, or a whole scope for a
package rename, to its replacement with the date of the rename. Readers
resolve transitively, prefer a full-identity mapping over a whole-scope
one, and apply an alias only to records from days strictly before its
date, so the two halves of a test's history join under today's name.
`deno task check-test-aliases` holds each file to append-only, and the
directory as a whole to at most one mapping per identity and to acyclic. The scope form matters more here than
it looks: the topology maps records by kind, scope, and optional variant,
so a package rename without one orphans every configuration of the suite
at once.

Alias declarations name the three required identity parts and apply to
every variant. Resolution preserves the record's variant, so one rename
bridges the default and every non-default history without joining those
histories to each other.

The mechanism is there and so, by now, is the practice: as of this
writing the directory holds 2168 lines across 24 dates, so renames are being bridged as they happen
rather than swept up once. What the reporter's suggestion adds is the
case nobody notices — a rename whose author had no reason to think the
history mattered.

Three things follow.

**The publisher resolves through `loadAliasResolver`.** The report tool
and the dashboard collector already do, and the publisher does. Without
it the file accomplishes nothing for selection.

**The tooling writes the line for you.** Everything needed to spot a
rename is already computed: the drift guard knows which identities the
tree produces and which the store knows, so an identity that vanished from
a file at the same moment an unknown one appeared in it is a rename with
very high confidence. The reporter says so on the pull request, with the
exact line to append, the date filled in, and how many catches it would
preserve. `--explain` answers the same question from the other end: this
identity has no history, and six catches sit under a name that left the
same file in this change.

**Nothing is inferred.** The publisher never bridges a rename on its own,
however confident the evidence looks. A wrong bridge silently credits one
test with another's record, and since the whole score rests on catch
attribution there is no downstream check that would notice. Append-only,
human-authored, dated, and gated on shape is the right shape for a file
whose bad entries are invisible; suggesting a line is help, writing it
unasked is not.

Whether an unbridged rename should ever *fail* a pull request is a dial,
`ALIAS_GATE_MIN_CATCHES`, and it starts switched off. Most renames cost
nothing, because most tests have never caught anything, so a gate that
fired on every rename would be noise nobody reads. A gate that fires only
when real history is about to be discarded would be rare and
proportionate — but it is still a new way to be red, and the honest order
is to see how well the suggestion works before reaching for one.

### Removals, and what the aggregate forgets

A deletion is not a rename with a missing half. Nothing has to be
declared for one, and nothing should be: what says a test is gone is the
tree not holding it, which is the same thing that says where every other
test runs. An alias would be wrong — there is no name for the history to
join to, and a bridge to another test's name would credit that test with
a record it did not earn.

Nothing selects a deleted test. No suite claims its identity, so the
publisher leaves it out of the manifest, and a manifest published before
the deletion is reconciled against the tree before anything is packed,
which drops the entry there too. The suggestion the reporter makes for a
rename is not made for a deleted file either: a departing identity is
only paired with an arriving one when the unit it lived in produced
records in this run, and a deleted file's unit produces none. One `it`
deleted from a file that still runs is not covered by that, and is held
instead by what a suggestion costs when it is wrong, which is nothing:
nobody appends the line.

What is left is the publisher's rolling aggregate, which reads the store
and the store keeps every record forever. Without a rule for forgetting,
a test deleted three years ago still has its state read, scored and
written back on every run, and still counts against the identities the
topology has no unit for — which is the count that says a surface is
recording without saying where it runs, and a count polluted by every
test ever deleted is one nobody can read.

So an identity leaves the aggregate on two conditions together. No suite
claims it. And no run of it has been recorded inside the longest window a
state keeps counters for, which is `lastRun` having no answer. The
default branch runs every test the tree holds, so a test that is still
there and still runs records inside that window whether or not a change
selects it.

Neither condition is enough alone, and requiring both is what makes this
safe. A suite whose units are files places a record by the file the
record names, so an identity whose records never name one is claimed by
nobody and is running every day; dropping it would throw away the history
of a live test and hide the wiring defect that is worth acting on. A
suite whose units are not files reads the recorded name instead and is
untouched by that. A topology that misreads the tree — a suite whose
scope was renamed without the alias that bridges it — stops claiming
tests that are running, whichever kind of suite it is, and every one of
those is held by the second condition.

An identity more than one suite claims is not a departure at all. The
tree holds that test twice over, which is a defect in the topology rather
than in the tree, and the drift guard is what fails on it; dropping its
history would answer a defect by discarding the evidence. So the two are
counted apart, and only the unclaimed one is a candidate for leaving.

A unit a configuration declares unavailable is kept, under the variant
that declared it, for the same reason the drift guard and `plan --verify`
both pass over one: the declaration is the tree saying the test is there
and does not run in this configuration. The exemption is read a unit at a
time. A declaration naming one leaf inside a unit leaves that unit
enumerated and running, so its identities are placed by their file and
never reach this.

A skip is the one outcome a state records nothing for, so a test the tree
holds that nothing ever runs meets the second condition as well. Where
nothing claims it either, it is dropped like a deleted one; what that
costs is catches from before the window, since every counter inside it is
empty either way. Most skipped tests are in neither position: a whole
unit declared unavailable is exempt, a declared leaf leaves its unit
enumerated and placed, and a test skipped inside a unit some suite claims
is claimed with it.

The longest window is the longer of `CHURN_WINDOW_DAYS` and
`FLAKE_WINDOW_DAYS`, sixty days today, so that is how long a deletion
takes to settle. Until then the deleted test is counted with the identities that
have no unit and have run, which is right: it did run inside the window.
The two counts are reported separately, so the one that stays large run
after run is a suite that has stopped recording rather than a set of
tests somebody deleted.

### The exploration draw

15 percent of each lane's budget is reserved for items that the value
ordering did not pick. The draw is weighted toward items that have gone
longest without running, with random tie-breaking seeded from an
identifier carried in the manifest, so the whole corpus is swept over time
rather than sampled with replacement forever. Preferring the
least-recently-run also means the draw automatically covers whatever the
value model is currently blind to.

The draw prefers items in environments the lane has already opened, so
that exploration is nearly free, and spends a small part of its budget
crossing into an environment nobody opened, so that an entire suite cannot
go unexercised because its setup is expensive.

### Trust, and why local records now matter more

[The spec](../specs/test-records.md#trust-boundaries-for-consumers) says a
decision consumer reads `submissions/ci/` only. This design reads
`submissions/local/` as well, and weighs a local catch double, so the
spec has to be amended in the same change and the reasoning has to be
better than "it seemed useful".

It is this. A local catch is the highest-quality evidence available about
whether a test is worth running. The person was writing code, ran a test,
and it went red because of what they had just written. There is no
ambiguity about what changed, no shared infrastructure to blame, and no
question about whether the failure was real, because they went on to fix
it. Everything the score is trying to measure, that observation measures
directly.

What this costs is that a local record can now displace another test from
a budgeted lane, rather than only ever adding to what runs. Three things
bound that. Every local key was minted by someone with repository write
access, for themselves or for a person they chose to mint for, which is the
trust boundary the continuous-integration records already sit inside.
Every manifest records the inputs behind every score, so a strange
selection can be traced back to the records that produced it. And the
worst outcome is a pull request that ran a less useful set of tests, which
`main` catches within about 15 minutes and reports back.

Worth knowing while reading this: `submissions/local/` is empty today.
Nobody has set up a key, so the strongest signal in the design is
currently contributing nothing. `deno task test-records-key setup` is the
whole of what it takes, and this plan is the reason to bother.

### Flakes and repeats

A flake is a test that disagrees with itself. Sometimes that is directly
observable: the same identity, the same commit, one pass and one failure.
The store carries the commit on every context line, so those are found
without any inference at all.

That test misses the case that matters most, though, and missing it would
corrupt the catch count. Every push to `main` is a distinct commit with
one run, so a test that is flaky *on `main`* never produces two
observations at one commit — and every one of its spurious failures would
be counted as a catch. A test failing on `main` a dozen times a year would
then look like one of the most valuable tests in the repository while
being one of the least.

The second rule is the same distinction stated as a question about what
came next. **A failure on `main` is judged by the next
`main` run that passed.** At the same commit the test disagreed with
itself, so the failure is a flake observation. The two runs can arrive in
separate batches, which is why this is a rule of its own rather than the
directly observable case above. At a later commit the failure counts as a
catch. Both hold only when the two runs used the same shuffle seed; a pass
under another seed ends the failure without judging it, for the reason
given under "Both rules compare runs in the same order" below.

A run of failures ended by one pass counts one catch, dated to the first
of them, so a week of `main` being red is worth one catch and not seven.

That narrows the hole rather than closing it. Nothing separates a failure
a change fixed from one that healed itself, so a flaky test collects
catches on `main` it did not earn. The same test runs on pull requests as
well, where repeats and re-runs put several observations at one commit,
and a test that disagrees with itself there is seen doing it. I would
expect that to bound the over-crediting, because a test flaky enough on
`main` to matter is being run far more often on pull requests, but nothing
here measures it.

`flakeRate` is how often a test was seen falling under either rule, as a
share of the runs it took part in rather than of the failures among them.
What the rate decides is whether running the test once fails somebody's
change for something its author cannot act on, and that is a chance per
run: a test that failed once in ten thousand runs and passed on the rerun
has every one of its failures a flake, and a share of failures would read
it as wholly unreliable. Counting runs is also what lets an exclusion
reverse, since a run that does not disagree lowers the share.

Nothing is charged against the count. A disagreement is a proof rather
than a sample, since a deterministic test cannot pass and fail at one
commit, so shrinking the share toward zero would shrink it toward what
the observation has already ruled out. A test seen twice that disagreed once
reads a half; one that disagreed once in ten thousand runs reads a
ten-thousandth. What separates them is how much each has been run.

A disagreement's weight halves every `FLAKE_HALF_LIFE_RUNS` runs that
follow it. A test that disagreed twice and then passed two hundred times
has settled; one that passed two hundred times and then disagreed twice
has just started. Those are the same counts and not the same test, and a
flat sum over the window gives them the same number. Runs rather than
days, because what shows a test has settled is running without
disagreeing, and a test left untouched for three weeks has shown nothing.

Both counts are published beside the share. A share cannot be weighed
without them, and everything that shows a person this figure — the
dashboard and the report a red `main` leaves — shows the counts with it.
They are counted flat, so they are not what the share divides.

Two things follow from knowing it.

**Too flaky to judge by, so not selected.** Above the threshold, an item
leaves the pull-request selectable set entirely, for the reason in [The
rule that keeps a test out](#the-rule-that-keeps-a-test-out). It keeps
running on `main`, repeated there and unable to turn the run red, and it
keeps appearing on the deflake work queue until somebody fixes it. [An
excluded test still runs on `main`](#an-excluded-test-still-runs-on-main)
says what that costs and what it buys.

**Below the threshold, some items are run more than once.** Repeats raise
the chance of catching something intermittent: a regression that shows up
in one run out of three is caught a third of the time by one run and 70
percent of the time by three. Two cases get them:

- An item in a suite whose measured flake rate is high — the browser and
  server-backed suites, where intermittency is the norm — when the item
  itself is new and has no history of its own. The suite's rate is the
  prior; the item's own record replaces it as it accumulates. This is
  mostly a stability check on the new test, and catching a flaky new test
  on the pull request that introduces it is the cheapest possible moment
  to catch it.
- An item whose own flake rate is non-zero but below the exclusion
  threshold, where a repeat is what turns "probably fine" into an answer.

The repeat count comes from the flake rate and is capped, and an item is
only repeated when its cost times the count still fits the budget.

**A repeat is not a retry, and the distinction matters here.** This
repository bans retry loops, because a retry lets something that should
have failed pass on a later attempt, and the error is then missed. Repeats
run the other way: every repeat must pass, and any failure among them
fails the lane. Three runs of a test is strictly stricter than one, never
laxer. Nothing is retried and nothing is masked. The identities [an
excluded test still runs on `main`](#an-excluded-test-still-runs-on-main)
covers are laxer than one gating run rather than stricter, which is the
trade that section argues; they are still not retries, since no run is
re-attempted and no result is discarded.

That does mean a flaky item below the threshold fails pull requests more
often in proportion to how often it is repeated. That is the honest cost,
and the exclusion threshold above it is what stops the cost being paid on
tests too noisy to be worth it.

Repeats also generate the cleanest flake data there is — several
observations at one commit in one environment — so the measurement
sharpens itself.

**Both rules compare runs in the same order, not only at the same
commit.** Test runners here shuffle the order their tests run in, apart
from the few whose order is the test, by a seed that is the Pacific day
the commit under test was committed on
([TESTING.md](../development/TESTING.md#every-test-run-shuffles-its-order)).
A test that depends on the order its siblings run in passes in one order
and fails in another. That is a bug in the test, not chance, and counting
it as a flake would withhold it from pull requests instead of getting it
fixed. Fixing the seed to the commit is what keeps every job of a run, and
every later attempt at it, in one order, for the reason the manifest a
lane reads is fixed to the same commit
([Why the lanes do not coordinate the plan](#why-the-lanes-do-not-coordinate-the-plan)). An override can still put one commit in two orders, so each
record's context carries the seed as `shuffleSeed`, and the fold compares
outcomes only at one point: the same commit and the same seed, or both
without one, which is a run in declaration order. The same holds for the
second rule. A failure on `main` followed by a pass under a different seed
is neither a flake nor a catch, and is dropped: the order moved on, and the
pass says nothing about whether a change fixed anything. That also drops
the catch of a real breakage whose fix landed on a later Pacific day than
the breakage did, which is the price of never crediting an order change as
a fix.

- [x] The context line carries `shuffleSeed`, written by local runs and by
  each CI job's gather step, and carried by the relay.
- [x] The fold keys same-commit disagreement, and the judgement of a
  pending failure on `main`, on the commit and the seed together.

### An excluded test still runs on `main`

The exclusion takes a test out of pull requests, and pull requests are
where a test is run more than once. What is left is one run per `main`
push, and a test run once per commit is seen to disagree with itself only
when somebody re-runs the job, since the pass and the failure have to sit
at one commit. So its share falls with almost every run it gets and rises
almost never. The exclusion is meant to reverse as a test goes back to
passing, and for the tests it holds the evidence points one way by
construction.

The score moves at the same time. A `main` failure that the next `main`
run passes at a later commit, in the same order, is credited as a catch,
and with nothing beside it at its own commit that is what each of an
excluded test's spurious failures becomes. So the test returns to pull
requests with a share near nothing and a score raised by its own noise.

Two rules answer this. They are separable, and only the second carries any
risk, so they are argued separately.

**An excluded identity runs on `main` as many times as its share asks
for.** [The line that decides the count](#flakes-and-repeats) already
runs past the exclusion rate, and the mandatory pass already places every
identity with the count its share asks for, so this half is in place. Any
share above the threshold asks for at least four runs, so it is at least
three further runs at each commit.

Those further runs are what let a share rise as well as fall. They also
put a pass beside a spurious failure at its own commit, which classifies
it as a disagreement rather than crediting it as a catch, so both
paragraphs above close on one mechanism.

**Every run of the identity at one commit has the same shape.** All of
its runs go in one lane, and a lane invokes a unit once per repeat
against one skip list, so each run of the identity sits beside exactly
the same siblings as the one before it. A test sensitive to whether a
particular sibling ran would otherwise be recorded as disagreeing with
itself at every commit, which would pin its exclusion in place for good.
The siblings run as often: the unit is invoked as many times as the
excluded test's share asks for, and every identity the lane placed in it
runs that many times. The cost model does not charge that. It charges
each identity its own cost times its own repeat count, so a sibling that
asked for one run and is invoked four times is paid for once, and a lane
holding a unit like that is projected at a fraction of what it will
spend.

**What these runs cannot separate is a bad machine.** All of an identity's
runs at one commit go in one lane, so they run on one runner, and a runner
that fails one of them fails all of them. That is not a disagreement, and
the rule that reads a failure across many sources as the environment
covers catches rather than disagreements and has one source to read on
`main` anyway. So a bad lane and a genuine regression produce the same
record here. That is the gap [flakes and repeats](#flakes-and-repeats)
already names, and these runs sit inside it rather than widening it.

What this costs is runner time. Each run is an invocation of its own, so
the cost model charges every one its invocation rather than charging the
file once. Most of the cost then arrives as more lanes, which the search
`--lane-count` runs finds by packing what the lanes will actually be
packed against. Not all of it: one identity's runs go in one lane, so an
expensive identity multiplied past a lane's bound cannot be helped by adding
lanes. The mandatory pass gives up runs until what is left fits, down to one,
which is what the discretionary passes do.

**A failure of an excluded test does not fail the run.** This is the
second rule and it is a different question, which is what a `main` failure
of a test nobody can act on should do. `main` already goes red for these
tests, once per commit; the first rule multiplies that by the count. A
`main` build that goes red for a test too noisy to judge a change by tells
nobody anything they did not already know, and several times per commit it
tells them nothing several times.

The rule reaches a repository gate like anything else. Formatting,
linting, the cycle check and the drift guard are withheld from pull
requests by the same threshold as everything else and excused on the
default branch by the same one. A gate introspects the tree where a test
runs the code, which decides what it reads and how it is invoked and
nothing about what its failures are worth to a change: a gate that
disagrees with itself fails somebody's change for something its author
cannot act on, which is what the threshold answers. What asks for such a
gate to be fixed is the flake tile, the same thing that asks for a flaky
test. So the lane reads a `reason` of `flaky` on a withheld entry, and an
entry held back for any other reason gates. Reading membership of the
withheld set instead would make every reason somebody adds later
non-gating without anybody deciding it.

The lane sorts a batch's failures by identity rather than by batch,
because a batch holds many identities and its runner reports one exit
status for all of them, and it has the batch's records by the time it
decides, since it gathers them immediately after the batch.

**A batch is excused only when it accounted for every identity it was
asked to run.** "No gating failure among the ones that recorded" is not
the condition, because a batch that runs a withheld test, records its
failure and then dies satisfies it while having run almost nothing. So the
lane compares the batch's records against the identities it planned for
that batch, and a batch missing any of them fails the lane whatever its
failures were. That is the record spec's own rule, that a conclusion rests
on a record that is there and never on one that is missing. A lane that
could not read a manifest has no withheld set, so nothing is run more than
once and every failure gates.

The plan a lane receives gains a `nonGating` list rather than reporting
these in `withheld`. `withheld` means the plan declined to run something,
and a run that ran a test ten times should not say in its own summary that
no lane chose it.

Three things elsewhere have to move with this rule.

- **Coverage.** A [measured set](#the-measured-set) whose lane held a
  non-gating failure is reported rather than having a baseline published
  from it, which is the rule the gate already applies to a run with a
  failing test. Coverage measured through a failing suite says nothing
  either way.
- **The pending-failure list.** A `main` failure waits in `pendingMain`
  until a later `main` run judges it, and nothing ages that list. Today a
  broken test turns `main` red and somebody fixes it; under this rule an
  excluded test can stay broken indefinitely and its pending failures
  accumulate without bound. `pendingMain` joins the windows `trimWindows`
  ages.
- **Re-runs.** A red `main` is what prompts somebody to re-run a job, and
  a re-run is one of the two ways a same-commit observation happens at
  all. Taking the red away takes that path away with it. The first rule
  more than replaces what it produced, but the loss is real, and it is one
  the first rule has to cover for the second to be affordable.

Nothing is masked. Every run is recorded, every failure is scored by the
same rules as any other, the job summary names each non-gating failure and
the identity it belongs to, and the dashboard and the deflake work queue
read exactly these records. The failure no longer fails the build, and
only for tests whose measured share says they cannot tell a good change
from a bad one.

**The first rule alone is a real option, and it is worth saying why it was
not taken.** Running an excluded identity several times on `main` and
still failing the run for it buys the whole measurement fix: the share can
rise, and a spurious failure stops being credited as a catch. It needs no
exception to "an execution is not a retry", no sorting of failures, and it
puts nothing at risk. What it costs is `main` going red several times as
often for tests nobody can act on, which is the thing this is being asked
to stop. That is the trade, stated plainly, and the second rule is the
side of it this design takes.

The second rule gives up more than whether the build is red. The attestation and
deploy jobs depend on `tests`, so a full run that stays green ships. A test that
is both too flaky for pull requests and genuinely broken therefore deploys,
where its failure would otherwise have held the deploy.

The reporter is what carries that case to a person: an excluded identity
that failed every one of its runs at this commit and passed every one at
the parent. The comment says what the observation is and what it is not,
because a bad lane produces the same record, and only a person looking can
say which it was. That is weak evidence and it is the only evidence there
is, which is the honest position for a test whose failures nobody could
act on before this rule either.


## Packing

### The cost model

A lane's wall time is modeled as:

```text
lane = prologue
     + sum over the capabilities the lane opens of setupCost(capability)
     + sum over the lane's batches of batchCost(batch)

batchCost(batch) = suiteOverhead(suite)
                 + correction(suite) * sum over items of cost(item)
                 + unitOverhead(suite) * the units the batch opens
```

The setup costs are what the table in
[Capabilities and setup](#capabilities-and-setup) describes, measured
rather than written down: each lane records how long each capability
took to open, and the publisher charges each capability the ninetieth
percentile of its openings over the last week, for the reason the
intercept below gives.

`suiteOverhead(suite)`, `correction(suite)` and `unitOverhead(suite)` are
the three numbers that make this work without constant tending, and they
are fitted from observation rather than written down. A suite's items do
not cost what the runners measured them at: suites run their items in
parallel to differing degrees, and they carry startup costs the per-test
measurements never see.
In the reference build the eight workspace unit shards recorded 2,737
seconds of measured test time inside 1,839 seconds of test steps. The
eight runner unit shards recorded only 1,120 seconds inside 1,583 seconds
of test steps, because work such as module loading is not part of a test's
own duration. That is about 1.49 seconds of measured tests for every
second of test step in the workspace shards and about 0.71 in the runner
shards. The two suites are a factor of two apart, so no one static
multiplier captures both.

A third of the cost tracks neither the suite nor its tests. A unit suite
starts a runner and loads a module per unit, which no test's own duration
holds and which grows with the number of units the batch opens rather than
with what is inside them: the runner unit suite has spent about half a
second a unit across batches of five units and batches of three hundred.
A model with only an intercept and a slope on the tests has to put that
somewhere, and the only place left is the intercept, which is charged once
however few units the batch holds. A suite whose whole set is expensive
then prices out its own smallest batch.

So the model is fitted instead. Every batch the lane runner executes
records what its own tests took between them, what the batch actually
took, and how many units it opened. The publisher fits those per suite
over the last week — `correction` is the least-squares slope of what a
batch spent on what its tests took, `unitOverhead` is the rate a batch
paid per unit for what it spent beyond its tests, and `suiteOverhead` is
what those two leave — and publishes the result in the next manifest.
They start at zero, one and zero, and converge within a few days of lanes
running. Three numbers per suite, all measured, none maintained by hand.

The intercept is then set at the ninetieth percentile of what each batch
spent beyond what the other two charge it, because a least-squares line
sits in the middle of its observations and half the lanes would
otherwise run past the budget they were packed against. It is not raised
to the slowest batch, because the intercept is charged to every lane
that holds the suite: one slow runner would set what every lane pays,
and every lane would pack short by that runner's excess. The percentile
is the observation at its rank, so over nine or fewer batches it is the
slowest of them. The correction is fitted at all only once a suite has
enough batches, far enough apart in the seconds their tests took, for a
slope to mean something: it is read far outside the range it was fitted
over, since a suite whose every batch anybody has seen held six seconds of
tests may be charged thousands the first time a lane packs it whole.

`unitOverhead` is a rate rather than a slope because whether a slope can
be fitted is a property of the run rather than of the suite. The packer
puts an identity in the cheapest lane that can hold it and breaks a tie by
which lane is emptier, so a suite gathers in the lanes already holding it
and is shared out among them; where every lane fills to one budget the
counts come out close. Across a full run of twenty-two lanes the widest
gap between two batches' sizes is around twenty units against batches of
eighty, and a least-squares slope over a gap that narrow is negative for
five of the eight suites with enough batches to fit one and inside its own
standard error for two more. Across five lanes packing a selection the
same suite has held five units in one batch and six hundred in another,
where the slope is worth fitting. A threshold on that gap therefore
settles what a suite is charged from how its run happened to divide, and
falls back to charging nothing a unit. What a batch says on its own is the
rate it paid, which is what it spent beyond its tests over the units that
spending opened. Whatever the batch paid for itself is in that rate, which
is what carries a reading above what a unit costs, and the middle reading
is the one taken.
Nothing bounds either from above. A slope fitted too high only
over-charges, and what a bound took off it would land on the intercept,
which a lane pays to run one test of the suite where the slopes are
charged in proportion.

The measurements travel through the machinery that already exists: the
lane runner writes them as ordinary test records of kind `gate` and
scope `ci`, named `ci-lane setup <capability>` and `ci-lane batch
<suite>`. A batch is written three times, the others named `ci-lane ran
batch <suite>` and `ci-lane units batch <suite>`, because neither what its
tests took between them nor how many units it opened can be recovered
from the records the batch produced: a reader of a report cannot tell
which of its records came from which batch, and a unit whose tests all
recorded nothing leaves no trace of having been opened. A lane also writes
`ci-lane excused <identity>`, carrying no figure, for each identity whose
failures it did not fail the run for, so what a run excused can be read from
that run's own records.

The tests' own time, rather than what the packer expected it to be. The
two differ by however wrong the manifest's costs are, and a unit nothing
has measured is charged a stand-in that can be out by a factor of ten.
Fitting against the expectation puts that error in the intercept, which
is charged once to every lane that holds the suite and kept for the whole
window. An intercept past the planned budget already costs a whole lane
for each identity of the suite that runs, since a lane holding two things
stops at that budget; past the lane's bound, which is what an identity's
lone cost is weighed against, the suite places no discretionary identity
at all. So an expectation that was briefly wrong takes the lanes away
from everything else, and then holds a whole suite out of every pull
request, for a week.
The record format carries one number and calls it a duration, so the unit
count travels in that field as a count, and the measurement's name is what
says which of the three figures it is. A batch run
with coverage on carries `with coverage` on the end of its name, because
instrumenting a run costs it time and how much is a property of the
suite. The publisher fits those batches apart from what the suite's batches cost
without coverage, into a map of their own in the manifest's calibration,
`suitesWithCoverage`, beside `suites`. A run charges each suite the fit for how
it runs that suite's batches (see [What a pull request
does](#what-a-pull-request-does)), and where no lane has run a suite that way
yet, the other fit. They ship in the lane's normal test-records artifact, the
relay stores them like anything else, and the publisher reads them with the same
reader it uses for everything else. No new pipeline, and the numbers show up in
the existing dashboards for free.

### The budget, and why it is derived rather than chosen

The five-minute bound is the constraint; everything else follows from it,
and the budget the packer fills is what is left after the parts the packer
does not control.

```text
LANE_BOUND_SECONDS      300   what a pull-request lane is packed to finish in
LANE_PROLOGUE_SECONDS    40   checkout, Deno, cache restore, ship, job overhead
LANE_SAFETY_SECONDS      30   headroom for a slower-than-usual runner

LANE_BUDGET_SECONDS = 300 - 40 - 30 = 230
```

`LANE_BUDGET_SECONDS` is a derived value rather than a dial of its own,
which is what stops the three drifting apart into a budget that cannot fit
inside its own bound. It covers **everything inside the work step**: the
capability setup the lane opens and the batches it runs. Capability setup
is charged against it as the initial load when the lanes are packed, so a
lane that opens the Toolshed server has 40 fewer seconds for tests than
one that does not, and the packer knows that while it is choosing.

The prologue is a chosen dial, and nothing measures it. A prologue longer than
`LANE_PROLOGUE_SECONDS` takes its extra time out of the safety margin until
someone raises the dial.

The three numbers are the only place the five-minute promise lives. The promise
is kept by packing rather than by a timeout. A lane's work step carries the
workflow's ordinary `*work-timeout` bound of 30 minutes, and its job the
`*job-timeout` bound of 40, like every bounded job in `deno.yml`. Those bounds
only stop a lane that hangs, and are not the budget. A lane whose mandatory set
is larger than the budget runs long and says by how much, rather than being
stopped part way through with its later batches unrun and unmeasured. So raising
`LANE_BOUND_SECONDS` moves nothing in the workflow.

### Choosing what to run

The packer starts by removing what must not run: the items above the
flake exclusion rate. They are listed in the job summary, so what was
withheld is visible rather than quietly absent.

From what is left, given every item's value and cost and a budget of five
lanes times 230 seconds each, it fills in four passes.

1. **Mandatory.** Everything mandatory goes in first: the items the diff
   touched directly, every unit of a [measured set](#the-measured-set)
   the diff reached, and the items with no
   history. An item excluded above comes back into this pass if the
   change edits the test itself, or its suite maps the change onto its
   unit, since that is very likely a fix. Every
   item taken here leaves the selectable set, so no later pass can run one
   of them again. This pass can in principle put a lane past its budget;
   when it does, the runner says in the job summary how far past, rather
   than silently dropping work.
2. **Value first, 60 percent of the remaining budget.** Items in
   descending order of value, ignoring cost. This is what gets the
   expensive, genuinely broken integration test into the run.
3. **Density, 25 percent.** Items in descending order of value divided by
   what one run of the item would cost the lane it would go in: its own
   corrected time, plus whichever of its suite's overhead, its unit's
   overhead and its capabilities' setup that lane has not paid yet.
   Taking an item lowers what its lane charges for everything sharing its
   unit, its suite or a capability, so the order is worked out again as
   the pass takes items rather than fixed when it starts, and the identity
   key breaks a tie. Because of the value floor, this pass sweeps up the
   cheap tail: thousands of sub-second tests at a value-per-second that
   nothing expensive can match.
4. **Exploration, 15 percent.** The draw described above.

Passes 2 and 3 both account for the setup a choice would open, and pass 3
orders by it as well. An item
whose suite needs a capability no lane has opened is charged the
capability's setup cost the first time it is picked, so a lone cheap test
behind 40 seconds of setup correctly loses to 40 seconds of tests that
need nothing.

Repeats are applied last, to items already selected, and are charged their
full cost. An item that would be repeated but no longer fits gives up runs
until it does, down to one, rather than being dropped: one observation
beats none.

### Filling the lanes

Once the set is chosen it is packed into five lanes by longest-processing-
time scheduling, which `tasks/test-selection/plan.ts` implements itself. Batches
are the units being packed and capability setup costs go in as the initial
loads, so a lane that has already opened the Toolshed server is the cheapest
place to put the next batch that needs it. That is the mechanism by which "tests
needing the same environment are grouped together" falls out of the packing
rather than being a special case in it.

The cheapest lane is chosen from among the lanes that can still hold the
work, which is what makes the 230 seconds a constraint on the packing
rather than a figure it aims at. When the cheapest lane is full the item
goes to the next-cheapest one with room for it, so a suite whose overhead
one lane has already paid collects that lane's share of the suite and no
more. The value, density and exploration passes each spend a share of the
whole run's budget, and none of the three puts a lane past its own. The
corpus holds far more than a run can fit, so between them those passes
fill every lane, and what the pull request waits on is 230 seconds rather
than whichever lane the grouping favored. Two things are allowed past a
lane's budget, and the next two paragraphs are about them: the mandatory
pass, and an item costing more than a whole lane.

The mandatory pass is the one allowed past a lane's budget. It takes its
items largest first, so an item filling most of a lane is offered the
lanes that are still empty; an item offered lanes that are already full
has nowhere to go but past one lane's budget. When a mandatory item fits
in no lane it goes where the lane's finishing time rises least, which
spreads an unavoidable overrun across the five rather than settling it on
one.

A batch that on its own exceeds a lane's budget is split, paying its
suite's setup twice. A single *item* cannot be split, so an item costing
more than the planned budget is given a lane to itself and allowed to run
up to the five-minute bound rather than the planned 230 seconds. The
lane carrying it carries nothing else, because everything else would have
to fit in what is left under the planned budget and there is nothing left.
Repeats get no such lane, since a repeat is what an item gives up to fit:
an item wanting three runs of a hundred seconds runs twice inside the
planned budget rather than three times inside the bound.

The refreshed census finds one item that does not fit. The `piece-call`
dispatch section of `packages/cli/integration/integration.sh` took 386
seconds in the test step, 86 seconds past the lane's bound. Its eight
recorded steps are already separate identities, and the slowest took 87
seconds.

The fix is nearly free, because the script is already most of the way
split. Seven of those eight steps have an arm that runs them alone today:
`piece-call-retry`, `three-topic`, `verbs`, `verb-gaps`, `completion`,
`topics-drill`, and `bulk-survey-drill`. Only `run_piece_call` has no arm
of its own, because the `piece-call` arm runs it and then seven more. So
the script gains one arm, and `cli-core` enumerates the single-step arms as
its items and leaves the grouped arms to people running the script by hand.
Running the steps as separate invocations pays the script's own startup
once per step instead of once per group. That cost rises with the number of
items selected, which is the shape `correction(cli-core)` is fitted to
absorb.

The item-level dry run described below then determines whether anything
else is unschedulable; individual identity durations cannot answer that for
files containing several tests.

The manifest still carries an `unschedulable` list for new items that do
not fit, and the report tool surfaces it. The general fix is the 60-second
rule that
[`tasks/test-records-report.ts`](../development/test-records.md#reading-the-data)
already ratchets. The identities that break it are what that tool's
over-sixty-seconds list names. Getting them split is valuable
independently of this plan and becomes more valuable with it.

### Why the lanes do not coordinate the plan

The five lanes do not talk to each other. Packing is a pure function of the
manifest, the diff, and the lane number, and all five lanes run the same
function over the same inputs, so they agree by construction. Adding a
mandatory item is part of that function, so the five agree about where it
lands too.

Joining what the lanes measured is a different thing and does happen, in
`Status`. The distinction is which side of the lanes the job sits on. A
job that decided the plan would sit *before* them, on the critical path,
and every lane would wait for it. A job that joins results sits *after*
them, in a position that has to be occupied anyway because GitHub wants
one required check to read. Nothing is bought by refusing to use it.

The full run on `main` does have a planning job before its lanes,
`plan-full`, because there the number of lanes is not fixed and GitHub
needs the matrix before it can start anything. A pull request needs no
planning job because `LANES` is a constant, so each lane can work out its
own share. What `plan-full` decides is the lane count and nothing else,
so `main`'s lanes work out their own shares the same way a pull request's
do.

What the two runs do differ in is two values handed to the same
function: the policy, which is `everything` for the full run and
`budgeted` for a pull request, and the diff, which the full run does not
have. Under `everything` every identity is required, so the exclusions
and the value, density and exploration passes have nothing to act on and
the rest of the packer behaves identically for both. Holding the
difference to those two values is what stops the two runs drifting into
enumerating different tests, applying a suite's settings unevenly, or
packing the same work in reliably different orders.

The function must therefore be deterministic: no wall clock, no unseeded
randomness, no dependence on anything but its inputs. The exploration
draw's seed comes from the manifest. `plan()` lives in
`tasks/test-selection/plan.ts`, is called by both the publisher and the
lane runner, and is straightforwardly testable offline against a recorded
manifest.

Re-running a single failed lane later must not shuffle the work. The lane
resolves the manifest as *the newest one generated at or before the
commit under test was made*, reading the committer date out of the
checkout.

What the moment has to be is stable rather than exact: every lane of a
run has to agree, and every later attempt has to agree with the first.
Nothing about the run satisfies that. GitHub reports `run_started_at`
per attempt rather than per run — measured across four re-run builds,
every one reported a later start for its second attempt, one of them
nearly six hours later — so an attempt resolving at its own start would
pick up whatever manifest is newest by then. Its five lanes would agree
with one another and disagree with the attempt before them, which is
worse than either: a test the first attempt placed in the lane that
failed can move to a lane the re-run does not run, leaving `Status` green
over a set no attempt ran whole.

The commit is stable by construction, and it needs nothing from the
service that scheduled the run — no credential, no request, and no
failure path where the request is refused. It is also the same value on a
workstation as in a job, so `plan --dry-run` answers the question a lane
would answer instead of resolving against the clock. And it is the better
anchor on its own terms: the manifest worth reading is the one that was
current when the tree under test came into being.

The committer date rather than the author date. A rebased or
cherry-picked commit keeps the author date it was first written at, which
can be arbitrarily old, while the committer date moves with the tree.

The seed every test run shuffles its order by is taken from the same
moment, for the same reasons: every lane of a run and every later attempt
at it has to run one commit in one order, and the clock at a job's start
gives neither. `commitMoment` in `packages/test-support/src/shuffle.ts`
reads it for both.

## What the census can project

Working from the reference build's numbers, and from the budget in [The
budget, and why it is derived rather than
chosen](#the-budget-and-why-it-is-derived-rather-than-chosen).

Five lanes at 230 seconds inside the work step is 1,150 seconds.
Capability setup takes perhaps 200 of that across the five, leaving around
950 seconds of test execution.

The one-second-and-under tail is 16,168 executions holding about 1,046
seconds of measurement. What that costs in lane time depends on which
suite the executions come from, and the two unit suites in the reference
build are a factor of two apart. At the workspace shards' rate of 1.49 the
whole tail costs about 700 seconds. At the runner shards' rate of 0.71 it
costs about 1,480. The budget is 950. The tail may fit and it may not, and
this census cannot say which.

Two further things mean less of the tail is bought than either end of that
range would suggest, and neither can be quantified yet. Selection happens
at item granularity, and a
unit-test file holds cheap and expensive identities together, so there are
fewer independently selectable cheap items than there are cheap executions.
And the density pass that sweeps the tail up gets a quarter of what the
value-first pass leaves rather than the whole remainder.

**None of that puts the design in doubt, because keeping the whole cheap
tail was never the objective.** The objective is running the tests that
find things. The mandatory pass and the value-first pass are where that
happens, and both are served before the tail is considered at all. The tail
is a bonus, bought with what those two leave: cheap enough per unit of
value that the density pass takes a great deal of it, and when it no longer
fits entire the density pass takes as much as its share affords, in
descending value per second. A pull request that runs every valuable test
and a large share of the cheap ones is doing the job this system exists to
do.

What would put the design in doubt is the mandatory set alone not fitting
in five lanes, or the value-first pass being unable to afford the expensive
tests that actually catch regressions. Neither is what this census shows.

The earlier version of this plan claimed the cheap tail fit in under half
the budget, on a conversion rate of two and a half taken from the fastest
single shard of one build. That rate was the weakest number in the
document and it did not survive a census across all 16 unit shards. What
it supported was the bonus and not the requirement, which is why losing it
changes the expected selection rather than the plan.

`deno task test-selection plan --dry-run` over the reference records
replaces this range with the first defensible projection, once the
topology classifies every identity, maps every item-level identity to a
runnable item, and gives the `piece-call` steps their own items. It
reports selected item count, measured test time, capability setup,
repeats, and unschedulable items, and it runs offline over recorded data,
so it is a check the branch makes before merging rather than something to
wait for. All five lanes must fit with the 30-second safety margin intact.

The end-to-end target depends on none of it. A packed lane has 230 seconds
of planned work and 40 seconds of prologue, so the five parallel lanes
target about four and a half minutes against the reference build's 15
minutes and 23 seconds. The continuously fitted suite overhead and
correction values turn that target into measurement once lanes begin
running.

## The manifest

The manifest is one gzipped JSON object per publisher run, created —
never overwritten — under a new dataset area beside the records:

```text
labs/test-selection/<area>/manifest-<ISO 8601 timestamp>-<ULID>.json.gz
labs/test-selection/<area>/state/<yyyy-mm-dd>-<ULID>.json.gz
```

The segment is `SELECTION_AREA`, a name rather than a number, and it does
not move when the shape of what is stored does. A reader lists the one
area and reads forward anything written in a shape behind its own,
passing over anything ahead of it and taking the newest it knows. Moving
the segment instead would leave the state behind in the old area, and
the state is where every catch lives: the publisher would have none to
carry forward and would stop and ask for a bootstrap, with nothing
published in between and every consumer running the whole corpus.

Write-once naming is not a stylistic choice: the store's writer
credentials hold `objectCreator` and nothing else, cannot overwrite, and
that is the property that makes the whole store trustworthy. So there is
no `current.json`. The timestamp leading an object's name is the moment
its publisher started, and it keeps a listing chronologically readable
without deciding what a resolution compares. When a lane resolves a
manifest, it lists once and takes the newest object the store had created
at or before the commit under test, using the full object name to break a
tie between two created in the same instant. The creation time rather than
the name, because the publisher names its manifest at the start of a run
that creates the object at the end, and a lane listing inside that gap
would otherwise disagree with one listing after it. Every lane and every
later attempt reads the same commit, and a manifest the store creates
while the run is going is created after that date and cannot change the
answer. [The specification](../specs/test-selection.md#determinism) says
what a commit dated ahead of the store's clock costs. What the answer does depend on is retention: the manifests a
commit can resolve have to outlive the window in which that run may be
re-run, which is a retention setting on the bucket rather than anything
this reads.

The object carries:

- the schema version, the generation time, and the exploration seed;
- the `main` commit whose topology was enumerated, and how many runs the
  aggregate saw;
- every dial it was built with, so the manifest explains its own
  behavior and two manifests can be diffed for why they differ;
- the calibration numbers: `setupCost` per capability, and
  `suiteOverhead`, `correction` and `unitOverhead` per suite;
- every item: its complete identity or identities, optional variants
  included, its suite, its file, its cost, its score, the inputs behind
  that score, its flake rate, its repeat count, and the last day
  anything ran it, which is what orders the exploration draw;
- the withheld set — the items above the flake exclusion rate — with the
  reason, so a lane can say why something is absent;
- the tests declared unavailable in a configuration-specific skip
  registry, with their suite, variant, phase, and reason;
- the reference packing into five lanes;
- the `unschedulable` list;
- a count and digest of the known item-level identities, for the
  unknown-item rule;
- each measured set's uncovered-line count, against the commit it was
  measured at, which is what the coverage gate compares a pull request
  against.

The size is measured rather than bounded. A publisher run over one day of
the store — 18,849 objects holding 5,487,611 executions — produced 20,091
identities, and the manifest carrying them is 9.59 megabytes serialized
and 1.05 megabytes gzipped, which is 478 bytes an entry. Identity names
dominate that: a describe chain runs to a hundred characters and more, and
the numbers beside it are rounded to the digits that mean anything. One
megabyte is a fetch of no consequence at the start of a job.

The same source item in default and non-default suites appears as two
manifest items. Their suite identifiers and complete record identities
keep their selection and cost histories separate. The digest of known
identities uses the canonical test-record identity key, including the
fourth part only when a variant is present.

The manifest is untrusted input to the lane runner, and is validated the
same way record lines are: a malformed manifest is rejected whole, and a
manifest declaring a shape from further ahead than the runner is treated
as absent, the runner taking the newest one behind it instead. Retention
is a bucket lifecycle rule deleting manifests after 45 days.

## The publisher

`.github/workflows/test-selection.yml`, on a four-hourly cron and on
manual dispatch. Four hours rather than a fixed daily hour: aggregation is
incremental and therefore cheap, and a flake that appears at nine in the
morning should not wait until four the next morning to be prioritized.
Manual dispatch is there so that somebody who has just fixed something can
refresh without waiting.

The job:

1. Reads the newest state object, which holds the submission object names
   and source-and-date rollup receipts already folded, along with the
   aggregate they produced.
2. Applies the one input plan described below. In the steady state this is
   about 2,000 objects per run.
3. Folds them in, ages the decayed counters by a day, classifies each new
   failure as a catch or as flake evidence, scores everything, reads back
   the lane timing records to update the corrections, calls `plan()` with
   an empty diff to produce the reference packing, and writes a new state
   object and a new manifest.
4. Reports, in the job summary, the projected per-lane times, the spread
   between them, what fell off the budget, and anything unschedulable.

A cold start reads a much wider window. The bootstrap is a manual
dispatch with `--bootstrap --days 60`, run once, after which the
incremental path keeps up. Sixty days of raw objects is hundreds of
thousands at the volume the store now takes, which is more than one job
can read, and that is where the rollups earn their place: the bootstrap
takes one rollup for each closed continuous-integration day, standing in
for that day's thousands of objects, and reads raw only the days no
rollup covers and every local source.

### One input plan for bootstrap and ordinary publishing

Bootstrap is permission to start from an empty aggregate and a larger
default window. It is not a second way to choose inputs. Both modes apply
the same rule independently to each source and date:

1. A receipt in the aggregate says this pair was folded from its rollup.
   A rollup records neither the objects it covers nor a point it is
   complete through, so nothing can say how much a raw object of that
   pair would repeat. The pair is closed rather than combined with
   objects whose overlap is unknown.
2. When nothing of the pair is folded and a rollup covers it, the rollup
   is the baseline and a receipt is written for it. One object stands in
   for the day's thousands, which is what makes a cold start over a wide
   window affordable at all.
3. Everything else reads raw objects, and two different things reach it.
   A pair with raw contributions already stays raw, because a rollup
   written afterwards would overlap them. A pair no rollup covers is raw
   because there is nothing else to read, which is every local source:
   rollups cover the continuous-integration area alone.

The current rollups cover CI only. Local submissions always take the raw
path. A date-only `compactedDays` receipt is therefore not sufficient: it
can make a CI rollup suppress local submissions from the same date. The
receipt is scoped by source as well as by date.

This rule lets an ordinary publisher use a rollup for a previously unseen
old date, such as one reached while catching up after an outage or after
a window expands. It does not make a steady-state publisher switch a date
from raw objects to a rollup seven days later, after the raw
contributions are already in its aggregate.

The publisher needs a writer credential for its own prefix. That is the
`test-selection-labs` service account with `objectCreator` on
`labs/test-selection/`, reached through a Workload Identity provider
pinned to exactly this workflow file on `main` — the same pattern, and
the same security argument, as the relay already uses. The infra
repository owns the account and the provider under `tofu/test-records`,
and both are applied. Nothing else needs a credential: a lane reads the
manifest it resolves and writes nothing.

When the publisher fails, nothing breaks: the previous manifest is still
the newest and lanes keep using it. A manifest going stale degrades
selection quality slowly rather than failing anything, which is the right
direction for a system nothing should gate on.

## The lane job

Nothing runs before a pull request's lanes. Each one resolves the manifest
from the commit it has checked out, so five lanes reach the same answer
without a job to tell them what it is. One job, `tests`, runs the lanes of
every run. On a pull request `plan-full` is skipped at once, and `tests` falls
back to five lanes over a selection against the base branch. In
[the full run](#the-full-run-on-main) `plan-full` supplies the lane count, the
lane list and `--full`. This is the job in `deno.yml`, abridged:

```yaml
tests:
  name: "Tests (${{ matrix.lane }}/${{ needs.plan-full.outputs.of || 5 }})"
  needs: plan-full
  if: >-
    !cancelled() &&
    (needs.plan-full.result == 'success' || needs.plan-full.result == 'skipped')
  runs-on: ubuntu-latest
  timeout-minutes: *job-timeout
  permissions:
    contents: read
  env:
    CF_TEST_RECORDS_DIR: ${{ github.workspace }}/test-records-spool
    LANE_ARGS: >-
      --lane ${{ matrix.lane }} --of ${{ needs.plan-full.outputs.of || 5 }}
      ${{ needs.plan-full.outputs.args ||
      format('--base origin/{0}', github.base_ref) }}
    LANE_JOB: Tests (${{ matrix.lane }}/${{ needs.plan-full.outputs.of || 5 }})
  strategy:
    fail-fast: false
    matrix:
      lane: ${{ fromJSON(needs.plan-full.outputs.lanes || '[1, 2, 3, 4, 5]') }}
  steps:
    - name: 📥 Checkout repository
      uses: actions/checkout
      with:
        fetch-depth: 0
        persist-credentials: false
    - name: 🦕 Setup Deno
      uses: ./.github/actions/deno-setup
    - name: 🔍 Verify lock file & install dependencies
      uses: ./.github/actions/deno-install
    - name: 🗺️ Plan the lane
      timeout-minutes: *work-timeout
      run: deno run -A tasks/ci-lane.ts $LANE_ARGS --dry-run
    - name: 🧮 Resolve what the lanes' binaries are built from
      id: binary-cache-key
      run: |
        key=$(deno run --allow-read --allow-run=git tasks/binary-cache-key.ts)
        if [ -z "$key" ]; then exit 1; fi
        echo "key=$key" >> "$GITHUB_OUTPUT"
    - name: 🧮 Resolve the compiler fingerprint
      id: compile-cache-key
      uses: ./.github/actions/compile-cache-key
    - name: ♻️ Restore/save the lanes' default-posture Toolshed binary
      uses: actions/cache
      with:
        path: .ci-cache/binaries/toolshed-baked-default
        key: lane-binary-toolshed-baked-default-${{ steps.binary-cache-key.outputs.key }}
    - name: ♻️ Restore/save the lanes' opposite-posture Toolshed binary
      uses: actions/cache
      with:
        path: .ci-cache/binaries/toolshed-baked-opposite
        key: lane-binary-toolshed-baked-opposite-${{ steps.binary-cache-key.outputs.key }}
    - name: ♻️ Restore/save the lanes' pattern compile byte cache
      uses: actions/cache
      with:
        path: .ci-cache/compile
        key: cc-lane-${{ steps.compile-cache-key.outputs.fingerprint }}-${{ github.job }}-${{ matrix.lane }}-${{ hashFiles('packages/patterns/**', 'packages/generated-patterns/**') }}
        restore-keys: |
          cc-lane-${{ steps.compile-cache-key.outputs.fingerprint }}-
    - name: 🧪 Run the lane
      timeout-minutes: *work-timeout
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: |
        mkdir -p "$RUNNER_TEMP/ci-lane-cores"
        ulimit -c unlimited
        sudo sysctl -w kernel.core_pattern="$RUNNER_TEMP/ci-lane-cores/core.%e.%p"
        deno run -A tasks/ci-lane.ts $LANE_ARGS --described
    - name: 📋 Upload what a failing lane left behind
      if: ${{ failure() }}
      uses: actions/upload-artifact
      with:
        name: lane-failure-${{ github.job }}-${{ matrix.lane }}-a${{ github.run_attempt }}
        path: ${{ runner.temp }}/ci-lane-*
        if-no-files-found: ignore
    - name: 📤 Upload the lane's coverage reports
      if: ${{ !cancelled() }}
      uses: actions/upload-artifact
      with:
        name: lane-coverage-${{ github.job }}-${{ matrix.lane }}
        path: |
          coverage/
          !coverage/raw/
        overwrite: true
        if-no-files-found: ignore
    - name: 📤 Ship test records
      if: always()
      uses: ./.github/actions/test-records-ship
      with:
        artifact: ${{ github.job }}-${{ matrix.lane }}
        job: ${{ env.LANE_JOB }}
```

`LANE_JOB` is the job name the lane's test records carry. One job rather than
one for each kind of run means its name, condition, matrix and arguments are
written once. Everything that varies with what a lane runs happens inside
`tasks/ci-lane.ts`, so one list of steps serves every run.

The lane plans in a step of its own, with `--dry-run`, so its plan heads a
step a reader of a running job can find. GitHub folds away the top of a step
thousands of lines long, which the lane's own step becomes. The lane's step
then packs the same plan again with `--described`, and names it in one line
rather than printing it twice.

The full-depth checkout and the `origin/<base>` spelling are what a lane needs
to diff against the merge base, and what the append-only gates need to read the
base revision.

The token in the environment of the step that runs the lane is what the
`github-api` capability distributes. No other step of the `tests` job holds it,
and `tasks/ci-workflow.test.ts` fails a workflow in which one does. Which suite
needs the token is a fact about the lane's packing rather than about the
workflow, so the lane step holds it and the runner narrows it further: it takes
the token out of its own environment before it opens anything, and only a suite
that declared `github-api` is given it back. The `contents: read` permission
bounds what the token can do to reading this repository, which is what
`check-action-pins` asks the service for.

The lanes use the same timeout anchors as every other bounded job in the file:
`*work-timeout`, 30 minutes, on the step that runs the lane, and `*job-timeout`,
40, on the job, which satisfies the repository's rule that a job's bound is at
least ten minutes above its work step's. `tasks/ci-workflow.test.ts` enforces
that rule. A lane packs against its budget, which is derived from
`LANE_BOUND_SECONDS` for a pull request and `FULL_LANE_BOUND_SECONDS` for the
full run. The step bound only stops a lane that hangs. [The
budget](#the-budget-and-why-it-is-derived-rather-than-chosen) says why the two
are kept apart.

The ship step carries neither a `variant` nor a `--junit` specification,
which is the last piece of per-suite knowledge to leave the workflow. A
lane may contain default and non-default batches, so the action's
job-wide `variant` input cannot represent it. The lane runner gives each
execution of a batch its own spool directory and output paths. This
includes every repeat. The suite's command describes each JUnit output
with its kind, scope, and optional file prefix. The suite's optional
variant applies to every direct and JUnit-derived record from that batch.

This uses the existing gather behavior rather than defining a second way
to apply variants. The part of `tasks/test-records-gather.ts` that reads
records, ingests JUnit, and applies a declared variant becomes a reusable
function. Both its command-line entry point and the lane runner call that
function.

When a suite declares a variant, the function writes that value onto every
record, replacing any value a producer supplied, exactly as the current
job-level `--variant` option does. When a suite is default, the value stays
absent.

A direct record carrying a variant in a default batch does not match that
batch's topology, and neither does one whose kind and scope are outside the
suite's declared record surfaces. The lane runner keeps both as the
producer wrote them, and names the conflict in the job summary. It does not
fail the batch: this is a metadata mistake, and the tests it came with
either passed or did not. The record then belongs to no suite, so the store
half of the topology drift guard fails on the next `main` run and names it,
which is where every other kind of topology drift is caught. Dropping the
record instead would put the only signal in a log line and leave the item
looking merely unrecorded, and an item with no records is reported and
never failed.

The final action only packages the already-complete lane spool. The lane's
own setup and batch-timing records remain unmarked. Their names contain the
suite identifier, and they measure the lane machinery rather than an
alternate execution of one test.

What the runner does, in order:

1. Take the GitHub token out of its own environment and hold it. Every
   child the lane spawns inherits what the lane holds, so this comes
   before the lane reads, plans, opens or runs anything, and a suite that
   declared `github-api` is given the token back through that capability.
2. Resolve the manifest from the commit's date and fetch it. A commit
   whose date cannot be read stops the lane. No manifest at or before
   that date takes the fallback, and a store the lane could not read
   fails the lane (see [Failure modes](#failure-modes)).
3. Enumerate every suite against the working tree, and read the manifest
   against that enumeration. The tree decides which tests exist and the
   manifest decides what each is worth and costs, so an entry naming a
   unit the tree no longer has drops out and a unit the manifest has
   never seen gains a stand-in. Everything after this reads the result
   rather than the manifest the store gave, which is what keeps the full
   run and a pull request working from one answer about what exists.
4. Compute the diff against the merge base, and ask each suite which of
   its units the diff touched. The full run skips this: it has no diff.
5. Call `plan()`, take this lane's plan. The full run calls it with the
   `everything` policy, and with the empty diff step 4 left it. Those two
   values are the whole of the difference between the two runs.
6. Print the plan to the job summary: which batches, which items, what
   each is expected to cost, why each was chosen, which items were
   withheld and why, which of them a failure would not fail the lane for,
   and which manifest the plan came from.
7. Set up the union of the capabilities the batches need, recording each
   one's duration.
8. Run each batch execution, in the order [the next
   section](#the-order-a-lane-runs-its-batches-in) gives, with fresh spool
   and JUnit output paths, recording what the batch spent and what its
   own tests took, and continuing past a failure so that one failure does
   not hide later batches or repeats.
9. Immediately after each execution, gather its direct records and
   described JUnit outputs into the lane spool through the shared gather
   function. Validate record surfaces and apply the suite's optional
   variant before another execution can reuse any runner-owned path. Then
   convert the coverage this lane produced into one report per suite and
   workspace member, which the job uploads for `Status` to join.
10. Exit non-zero if any batch failed, or if any repeat of any item
    failed. A failure the full run's non-gating rule covers is left out
    of that, and a batch that did not account for every identity it was
    asked to run is never left out of it. [An excluded test still runs on
    `main`](#an-excluded-test-still-runs-on-main) says which failures
    those are and how the runner tells them apart.

### The order a lane runs its batches in

What a lane costs beyond its tests is fitted from the lane's own
measurements, and [The cost model](#the-cost-model) says how. What that
section leaves to here is the order a lane takes its batches in, which
decides which suites the model can ever learn. A lane that the 30-minute step
timeout or a cancellation stops part way through leaves its later batches unrun,
so they record nothing, and a suite the model cannot price is one that makes
lanes over-run.

Two keys answer that. A suite whose charge was not fitted the way this run runs
it goes ahead of one whose charge was, because it is the one worth measuring: a
suite nothing has measured, and a suite this run measures with coverage on that
no lane has yet run that way. Within each group the largest share of the lane
goes first, because a lane that is going to be cut short should have spent its
time on the batch most worth knowing about and dropped the cheap ones. A share
is what the packer charged the lane for the suite's tests, `ownLoad` summed over
the suite's selections, so a suite running slower than it was measured at, or
running its tests several times, is as large here as it was when the lane was
filled.

Both keys are a function of the plan, and the suite identifier settles a
tie, so every attempt at a lane runs its batches in the same order
whatever order the plan listed its selections in.

## The full run on `main`

A push to `main` still runs everything, and it runs it through the same
topology so that the two paths cannot drift.

The full run does one thing a pull request does not. An identity too flaky
for pull requests is run here as many times as its share asks for, and its
failures do not fail the run, so the measurement that decides whether it is
still flaky keeps going while the test is out of pull requests. [An
excluded test still runs on `main`](#an-excluded-test-still-runs-on-main)
is the whole of that rule.

`deno.yml` has a small `plan-full` job that runs on a push, on a run the next
day's test-order workflow calls, and on a pull request labelled `ci: full`. It
computes one integer: how many lanes the run needs. It gets that from `deno run
-A tasks/ci-lane.ts --full --lane-count`, which reads the working tree against
the manifest and raises the lane count while that reduces the total by which the
lanes are over the full run's budget. The total rather than the worst lane: one
test costing more than a whole lane holds its own lane over budget at every
count, so a search reading the worst lane would stop at the first step and leave
every other lane packed far tighter than the budget it was given. It then packs
the run into that many lanes, the way the lanes will, and prints each lane's
projected work and job time to its error stream and the job summary, so the
step's log says how long the run should take before any lane starts.

The step writes the integer as the output `of`, and beside it the list `[1, …,
of]` as the output `lanes`. The job also outputs `--full` as `args`. The
`tests` job takes its matrix from the list with `fromJSON(...)` and runs
`tasks/ci-lane.ts` with `--lane N --of M` and those arguments. On a push, the
jobs that build the binaries run beside the lanes, and the jobs that attest and
deploy them depend on `tests` rather than on a list of test jobs:
`attest-binaries` needs the two builds and `tests`, `deploy-shell-staging` needs
`tests`, and `deploy-rapids` needs `attest-binaries`.

A count is deliberately the whole of the plan that passes from the planning
job to the lanes. Each lane reads the same tree against the same manifest and
computes the same packing for itself, exactly as the pull-request lanes
do, so nothing about which tests run travels through a job output and
there is no second packing anywhere to disagree with theirs. A planning
job that emitted the packing would be a second planner, and the two would
drift.

The full run's packing needs durations but no selection, so it reads the
manifest for its cost table. Where nothing in the tree has a measured
cost it falls back to the larger of one lane per suite that has anything
to run and what packing the stand-ins asks for. Less even, still
complete, and requiring no committed weight table to maintain.

The condition is what the tree holds rather than whether a manifest
arrived, because those are not the same question. A manifest published
before most of a tree existed arrives and still knows almost none of it,
and a cost model reading that one is as blind as a cost model reading
nothing at all.

The fallback is a count rather than a cost model on purpose. Where
nothing is measured, a projection from costs is arithmetic over whatever
figure stands in for the ones nobody measured, and it is wrong by
however wrong that figure is. Against this repository the stand-in
figure puts the whole corpus at 2,403 seconds where the reference build
measured 9,960, and the count that follows from it is five lanes for a
run where the reference build ran 67 jobs. The error is also in the direction
that breaks a run: too few lanes means every one of them runs past its bound,
where too many means some jobs finish early.

So a lane per suite with anything to run goes in as a floor. It needs no
number nobody measured, and it grows as test surfaces are added.

The packing is still asked what it would need, and the larger of the two
wins. Its answer is only as good as the stand-in costs behind it, which
is why it cannot be the whole of this — but those costs are what the
lanes will actually be packed against, so an answer below what they
imply is one the lanes cannot honor whatever else is true. That matters
most where a stand-in costs more than the bare unmeasured figure. A
suite whose measured units have all been renamed away carries what the
units it lost cost onto every stand-in, and a count that assumed the bare
figure would be out by that whole multiple.

Whichever way the count is reached, it is capped at `FULL_LANES_MAX`,
thirty lanes, which is half the sixty runners the organization has at
once. Each lane is a runner, and an uncapped count grows with the corpus,
so one push's full run could otherwise take the runners the pull requests
behind it are waiting for. A run needing more lanes than the cap takes
the cap and says so. Every test still runs. A test whose repeated runs
fit in no lane runs fewer times, down to once, and a test that fits
nowhere even once goes into the lane it leaves shortest, so the lanes
run past their budget rather than leaving tests out.

What comes out is a bound rather than a plan: the lanes still pack
themselves, and one of them may hold several suites.

A lane packing against stand-in costs says so in its summary, for the
same reason: a projected time that rests on nothing measured is a
different thing from one that rests on a week of records, and the job
summary is where somebody finds out which they are reading.

Before the pull-request path replaces the old matrix, `main` must complete
at least one successful full run whose records account for every item the
topology enumerates under its exact variant. The only permitted absences
are identities modeled as unavailable by a configuration-specific skip.
The store half of the topology drift guard must pass against those same
run records, and the publisher must produce a manifest from them. This
proves the complete identity-to-suite mapping and prevents a variant with
no records from making its entire suite mandatory on the first selected
pull request.

### Running everything on a pull request

Label a pull request `ci: full` and `plan-full` runs on it, so its lanes run
every test. Opting out of selection runs exactly what `main` runs rather than an
approximation of it. A label rather than a phrase in the description, because a
label can be added and removed without a push: `deno.yml` runs on a pull
request's `labeled` and `unlabeled` events as well as on a push, so changing the
label starts a run that reads the labels the pull request then carries. Any
other label starts one too. A re-run reads the labels of the event it repeats,
so it does not see a label changed since.

**The five selected lanes do not run when the label is present.** A run is
one or the other, never both. Running both would contradict the five-job
contract, and it would not be an opt-out at all. A pull request could still be
blocked by the selection path it had just asked to be excused from, which is
the opposite of what somebody reaching for the label wants. Only `plan-full`
reads the label. Its condition is the one place a run is decided to be full,
and `tests` runs every test when `plan-full` succeeded and a selection when it
was skipped.

The cost is that a labelled pull request stops exercising the selection
path. That is acceptable because the label is rare, `main` exercises the
lane runner continuously through `tests`, and `plan()` — the part
that differs between the two — is a pure function with its own tests and a
`--dry-run` mode.

`Status` needs `plan-full` and `tests`, and on a pull request without the label
`plan-full` is skipped. So its rule cannot be "fail unless every dependency
succeeded", which would read the skipped job as a failure. Its last step fails
unless:

- every dependency is `success` or `skipped`, **and**
- `tests` is `success`.

The second clause is not tidiness. Without it, a run in which `tests` is
skipped — a workflow-level condition that excludes it, a future edit that gets
an `if:` wrong — reports a green `Status` on a pull request that ran no tests
at all. That is the one failure mode of this whole design that would be silent,
so it is asserted directly rather than reasoned about.

A labelled pull request gets the full run's treatment of a flaky test as
well, since it is the same job: the excluded identities are run several
times on it and cannot fail it. That follows from the label running what
`main` runs, and it has one edge worth knowing about. The label runs every
test instead of the five selected lanes rather than beside them, so a change
that fixes a flaky test and also carries the label gets no gating run of
the test it fixes. The ordinary five-lane path is where that fix proves
itself, because there the exception for a change that edits a test makes
it mandatory and gating.

The natural users are a change nobody wants to be wrong about, a change to
the topology or to the test machinery itself, and the moment somebody
wants to know whether a lane failure is real.

`Status` also joins what the lanes measured. Each lane uploads the
coverage it produced, one report per [measured set](#the-measured-set),
and `Status` downloads every lane's upload, adds the reports up per set, and
runs the coverage gate over the totals. It is the only job in a position to do
that, and it is a job that has to exist regardless, so the gate costs a download
and an arithmetic pass rather than a job.

`Status` decides which sets the gate covers by running the same function
the lanes run, over the same diff and the same topology, rather than by
trusting what a lane reported. That includes the cap on how many measured
sets a change may reach, so a lane cannot talk `Status` into gating
something or into skipping something.

Two rules keep the joined result honest. A coverage failure says in the
summary that it is a coverage failure, so it is never mistaken for a test
failure. And when any lane failed, every set a lane's report measured is
reported rather than gated, because coverage measured through a failing run says
nothing about whether the change was tested. Every such set rather than
the sets the failure was in: `Status` is already failing for the lane, so
a second failure over a measurement taken through it buys nothing, and
attributing a lane's failure to a set would be a second way of asking
which tests belong to which set.

### What moves to `main`, and what happens to coverage

`Status` runs on a pull request and on a push, unless the run was cancelled. It
needs `plan-full` and `tests`. It fails unless every dependency is `success` or
`skipped` and `tests` is `success`. It is the one job after the lanes, so every
check over the whole run's records and coverage is a step of it rather than a
job of its own:

1. The store half of [the drift guard](#the-drift-guard) runs over every lane's
   `test-records-*` artifact, held to the run's commit.
2. On a pull request, the coverage gate runs over every lane's `lane-coverage-*`
   artifact, with the pull request's description read as it stands through the
   API rather than from the event, so an acceptance written after the push
   counts on a re-run. It uploads the comment it wants posted as the
   `coverage-comment` artifact, and writes none where the run's tests failed and
   the gate passed.
3. On a push, `tasks/coverage-report.ts` reads the same reports and writes the
   run's coverage measurements, which the job ships to the record store with
   `test-records-ship` under the artifact name `coverage`.
4. The last step applies that rule and decides the job's result.

Repository-wide coverage measurement moves to the full run and stops
gating; the gate that stays on pull requests is over [measured
sets](#the-measured-set). Step 3 is where the repository-wide figure is
measured, and it fails nothing. Each lane that opens the pattern compile byte
cache records whether it found the cache restored, at the top of its report
directory, so the figure from a run with a cold cache can be told apart. The
full run converts each measured set's coverage directory separately, so the
baselines come out of it. `.github/workflows/pull-request-comments.yml` posts
both this comment and the reporter's, from a trusted context with a write
token. [Telling a pull request what `main`
found](#telling-a-pull-request-what-main-found) describes the reporter.

## Coverage

Gating on the repository's whole coverage number cannot survive selection,
and saying so is not the same as giving up on coverage. That gate compares
a pull request's measured coverage against a `main` baseline; a pull
request that runs a fifth of the test time measures a fifth of the
coverage and reads as a catastrophe every single time. There is no
threshold that rescues that comparison, because the thing being compared
is no longer the same thing.

What the gate was actually for is worth separating from how it worked. It
was there so that coverage keeps going up, or at least stops going down
quietly. That goal survives, and it is served two ways: as a trend on
`main`, and as a gate over the sets a pull request can still measure
whole.

### The repository-wide number is a trend, not a gate

Coverage debt across the repository is measured on `main`, from the full
run, and it gates nothing. Not on pull requests, where a run of a fifth of
the test time measures a fifth of the coverage, and not on `main`, where a
red build for one uncovered line would make `main`'s color mean nothing.
Narrower measurements do still gate pull requests, and they are the
subject of [the next section](#the-measured-set).

It is a dashboard tile instead, and the tile follows [the dashboard's
rules](../../packages/dashboard/README.md#philosophy-and-values). It shows
the count of uncovered lines and, under it, what a median day does to that
count, which is the part somebody can act on. It is not a percentage:
a coverage percentage is exactly the kind of figure that stops meaning
anything the moment somebody optimizes for it. It goes amber when the
median day over the last three weeks is a rise, which takes more than half
the days in the window and so cannot be one bad day. And it reports on the
system: no per-person anything, no ranking, nothing that could be read as
a scoreboard.

That tile is live. It reads the repository-wide `workspace` figure from the
coverage measurements each `main` run writes into the record store. The full run
produces it in `Status`, by merging every report its lanes wrote.

The `ACCEPT_COVERAGE_DEBT` markers stay. They are how somebody says "yes,
knowingly", and they remain the right escape hatch whether or not anything
gates on them.

Nothing about coverage fails a run on `main`, and that includes the
per-set numbers the next section gates on. `main`'s job is to measure: its
full run produces the repository-wide figure for the trend and each
measured set's own figure for the baselines, and a landed change that
added an uncovered line must not turn `main` red for it. What happens
instead is that the rise is reported back to the pull request that caused
it, by [the reporter](#telling-a-pull-request-what-main-found). The
ratchet has teeth in the one place a person can still act on it, which is
before the change lands.

### The measured set

What stops the repository-wide gate working under selection is that its
two sides no longer measure the same thing. There is a case where they
still do. Take one suite's tests over one workspace member's lines, run
every one of those tests, and count as covered only what those tests
reached. The measurement is complete, whatever selection did anywhere else
in the run. Nothing about it depends on how many tests the pull request
chose, so the comparison against `main` stays honest, and so it can gate.

That pair — one suite's tests, one member's lines — is a **measured set**,
and it is the unit of everything below. A member's Deno-only unit tests
are one: the `workspace-unit` suite's tests over `packages/memory`. So are
`runner-unit`'s tests over `packages/runner`. A member whose tests are a
suite of their own is one measured set the same way, so nothing here
depends on which suite a member's tests sit in.

A measured set is also the comparison an author most wants. It answers
"did the change I just made to this package leave more of this package
untested than before", which is a question about the diff in front of
them.

### Each set is measured on its own, and never merged with another

Two measured sets over the same member are different numbers and are never
added together. `pattern-unit` and `pattern-integration` both reach
authored pattern code; a line one of them covers says nothing about
whether the other covers it, and a merged figure would let either suite
pay the other's debt down. Two sets over different members are separate
for the same reason in the other direction: `packages/memory`'s tests load
`packages/piece`, so a merged figure would credit `packages/piece` with
lines nothing in `packages/piece` tests.

So each set writes its coverage profiles into a directory of its own,
named for the suite and the member, and each set's number is converted
from that directory alone. The isolation is a property of where the
profiles land rather than a filter applied afterwards, which is what stops
a later reader merging them by accident.

A suite is never run once per set. A set's tests are mandatory items like
any others, so a suite two sets reach runs the union of them, and the two
directories catch what each set's own tests covered. Running the suite a
second time to keep two numbers apart would cost the run twice over and
measure nothing the one pass does not.

The counting rules are the existing ones in `tasks/coverage-metrics.ts`,
including the rule that a file compiling to nothing is charged nothing, so
a declarations-only file costs a set nothing here either. A member's lines
are the tracked source files under its own directory, and a file under a
member nested inside it belongs to that nested member instead. The result
is a separate series from `coverage-debt: packages/<name> uncovered
lines`, which sums every job in the repository that loads those files. The
two are never compared against each other, and the manifest keeps them
under distinct names so nothing can.

### Which sets exist, and what reaches them

A suite declares its measured sets. Each one names the member whose lines
it counts, the units that measure it, and the paths a change reaches it
by. Reaching a set is what makes every one of its units mandatory, which
is the same rule and the same declaration vocabulary as [what the change
touches must run](#two-rules-that-force-a-test-in), rather than a rule of
its own. Two mechanisms answering one question is two things to be wrong
about, and the failure they produce is silent: the gate would run a set's
tests and decline to score it, or score a set whose tests it did not
force.

That also settles what a set may declare. The bounds the declarations are
under are the ones stated there — nothing reached by a significant share
of the tree, and no file reaching a significant share of the things
declaring — and a member's own tree satisfies the first by construction.
`LOCAL_COVERAGE_MAX_SETS` is the second, said in measured sets.

The unit suites declare one set per workspace member under `packages/`, at
whatever depth the member sits: `packages/memory`,
`packages/connectors/github`, and anything nested deeper the same way. The
unit is the workspace member rather than a fixed path depth, which is what
makes depth stop mattering. Adding a package means adding it to the
`workspace` array in the root `deno.jsonc`, because nothing in the
repository knows a package exists until it is there, so a new package is
measured from the moment it exists. A member's set is reached by its own
tree.

`tasks` is one coverage group rather than a directory tree of them, and
`scripts` is left out of coverage accounting entirely today, so neither
carries a set.

A member is out only by being named in `EXCLUDED_FROM_COVERAGE_GATE` in
`tasks/test-selection/policy.ts`, beside every other dial, each entry
carrying the reason it is there. A list is the right shape for this
because the alternative — a rule that measures each member and decides —
can take a member's gate away for a change nobody meant as a change to
coverage, and a gate that silently stops gating is worse than no gate. The
list is what it is today:

| Excluded | Why |
| --- | --- |
| `packages/generated-patterns` | Its test task is `echo 'No tests defined.'`. Its test files run in the `generated-patterns` suite. |
| `packages/home-schemas` | It has no tests. |
| `packages/patterns` | Authored pattern code is measured by transformer instrumentation in the `pattern-unit` and `pattern-integration` suites. The package's own `deno test` ignores the pattern files deliberately. |
| `packages/runner` | Its whole set is past what all five lanes hold together: about 1,600 seconds of test steps in the reference build, against a budget of 1,150. |
| `packages/cli` | The command line's real coverage comes from the integration script rather than from these tests, so a gate on them would fail a change whose lines only the integration script runs. |
| `packages/identity` | Every one of its tests runs in a browser through `deno-web-test`. It has no Deno-only half to measure. |
| `packages/deno-web-test` | Its tests drive the browser harness end to end. |
| `packages/toolshed` | Its tests want the service's own environment and its initialized database. |
| `packages/integration` | The coverage metric counts none of its lines, since it leaves out every path with an `integration` directory in it, so a set over it would measure nothing. |

That leaves 34 measured sets in the tree today, `packages/memory` among
them, out of the 44 members `deno.jsonc` lists under `packages/`: the
nine on the list, and one member with no Deno-only tests to measure.
`packages/piece` is one of the 34: the packer spreads a set's units over lanes,
and `Status` joins what the lanes measured, so a member's set does not have to
fit in one lane.

One entry is there for size, and says so: each entry carries a kind, `size` or
`source`, beside its reason. Because `Status` joins the lanes' coverage, a set's
tests do not have to land in one lane, or even in one batch — they are ordinary
mandatory items that the packer distributes like any others, and the totals are
added together afterwards. What a set has to fit inside is the whole run's
budget rather than a lane's, which is five times the room. `packages/runner`
still does not fit it, at around 1,600 seconds against about 1,150 for all five
lanes together. Nothing else comes close to that.

None of this is special to those packages either: [sharding stops being written
down](#sharding-stops-being-written-down), so `packages/runner` and the rest are
ordinary suites whose items the packer distributes like every other. The numbers
are from the reference build and are what the item-level dry run checks; a
package listed for a size it no longer has comes off.

The list is a starting position and is expected to shrink. The publisher
reports which entries of kind `size` would now fit the run, charging a set the
overheads and setup of every lane it would spread over, the same way it reports
a measured set that has grown expensive, so a line comes off because somebody
read a measurement rather than because a threshold moved on its own. Two entries
are there because the member has no Deno-only tests at all, and the moment one
gains some, the same holds.

### Adding a browser test must not cost a member its gate

A package that mixes Deno-only tests with tests that need a browser should
keep the gate over the Deno-only half rather than losing it. Every package that
mixes the two names the halves as two tasks, `deno-test` and `browser-test`, and
runs both from `test`: `packages/static`, `packages/ui`,
`packages/iframe-sandbox` and `packages/dashboard` among them.

So the convention is this. A member that has a Deno-only half names it
`deno-test`. A member's measured set holds the units of that half and never its
browser unit. The browser unit then writes no coverage into the set's directory
either: it is not one of the set's units, so a lane that happened to select it
would move a number a lane that did not select it would not, which is exactly
what the set exists to rule out. A member with no `deno-test` is unchanged in
every respect: its whole test task is its Deno-only half.
`.claude/rules/workspace-packages.md` states the convention for whoever adds a
package.

Adding a browser test to any measured member is then an edit to `browser-test`,
and the gate does not notice.

### What a measured set costs is reported, never enforced

A set whose cost with coverage on grows past `LOCAL_COVERAGE_MAX_SECONDS` is
named in the publisher's summary, and by the `coverage` operator mode below.
Nothing happens to it automatically. Somebody then decides whether to split the
member's tests, let the run carry the cost, or add a line to the exclusion list
— all three being decisions about the repository rather than about one pull
request, which is why they belong to a person and not to a threshold. The same
two places name each member excluded for its size whose tests now fit the run's
budget.

Both read what a set costs with coverage on, from the fits the lanes'
coverage-on batches produce (see [the cost model](#the-cost-model)). What a set
costs without coverage is no answer, being short by whatever instrumenting it
costs, so until a lane has run a suite with coverage on the lines say that they
cannot tell yet and name the suites.

A set's cost is counted over the fewest of the run's lanes that hold it, since
its units are packed across lanes like any other mandatory work. Each of those
lanes pays the set's suites' overheads and its capabilities' setup. Each lane
holding part of a unit pays that unit's overhead, and a unit is split over no
more lanes than it holds entries, so that overhead is paid at most once per
entry. Each entry's own cost is multiplied by how many times it runs. The units
a set's suite declares unavailable are not run, so they are not charged. A set
that no number of the run's lanes holds is named as costing more than those
lanes hold.

### A change that reaches more than two measured sets forces none of them

The mandatory set a measured set adds is every one of its units, and a
change reaching several sets adds all of theirs. A sweeping change would
spend most of a run re-running suites it barely touched, and the gate's
value falls as the change gets broader anyway: over three or four sets at
once, "did this leave more untested" stops being a question about one
thing somebody can look at.

So when the diff reaches more than `LOCAL_COVERAGE_MAX_SETS` measured
sets, none of them is forced whole, and `Status` says so and why. The
tests are still selected normally, and the items the diff touched directly
are still mandatory under [what the change touches must
run](#two-rules-that-force-a-test-in); it is only the run-the-whole-set
part that stops.

None of them rather than some of them. Forcing two of the four sets a
change reached would mean the gate quietly ignored the other two, which
is the failure this design keeps refusing elsewhere. A cliff is also
predictable: an author can tell from the diff whether their change is
about to run whole packages, without knowing what any set's tests cost.

What the cap bounds is what a change is made to run, which is a cost.
Whether a number may be compared against the baseline is a different
question, and it turns on whether the set ran whole rather than on why it
did. So a set the cap left unforced that some run measured anyway is
still scored: the comparison is exactly as sound as a forced one, and
throwing it away would leave the gate silent over work the run has
already paid for. A pull request labelled `ci: full` measures every set
in the repository, so a sweeping change carrying that label is gated on
every set it reaches.

Nothing is lost permanently. The full run on `main` measures every set, so
a rise that a skipped gate let through is caught there and [reported back
to the pull request](#telling-a-pull-request-what-main-found), named as a
rise the gate would have caught.

### What a pull request does

When the diff reaches a measured set, by the declaration that set carries,
and the pull request is under the cap above, every unit in that set
becomes mandatory and runs with coverage turned on. They are packed like
any other mandatory items, so a large set spreads across lanes rather than
filling one. Coverage is turned on for the members being measured and for
no others, so a lane that also holds a few sampled tests from elsewhere
pays nothing for them.

Each unit is placed once, and that is enforced rather than hoped for: a
mandatory item leaves the selectable set, so no later pass picks it a
second time and no unit is placed in two lanes at once. That is what
stops a lane's budget being spent twice on the same work, and what keeps
a set's units from being scattered across lanes by two passes that both
chose them.

How many times a placed unit then runs is what its share asks for, and
measuring it changes nothing about that. A test that would have been run
three times to catch it disagreeing with itself is still run three times,
with coverage on. Those runs leave the set's number where it was, since a
coverage count is the union over what the runs reached.

A repeat reaches the unit that asked for it and no further. A lane's
batch is a suite's whole share of the lane, and a set the gate pulled in
whole is a great many units of one suite, so a batch that repeated at
its noisiest unit's count would run everything beside it again — time
the packer never charged, on tests nobody doubted.

None of this is special to the gate. How often an identity runs is what
its share asks for, whatever put it in the lane, so an identity a change
edited carries the same count as one the gate reached.

Nor does it depend on which run it is. The full run requires every
identity, the exclusion rule therefore takes none of them out, and every
identity withheld for disagreeing with itself runs in it the count its
share asks for. That is [what the default branch owes such a
test](#an-excluded-test-still-runs-on-main): those extra runs are the
only thing that lets a share rise rather than fall on a branch where an
identity runs once per commit. It rests on that section's other half,
which is that a failure of an excluded test does not fail the run.

All of one identity's runs go in one lane, so a lane cannot be added to
make room for them, and the mandatory pass gives up runs until what is
left fits, down to one.

Coverage makes those tests slower, and the packer charges them for it.
`pricedForRun` in `tasks/test-selection/census.ts` charges each suite the run
measures what that suite's batches have cost with coverage on, fitted apart from
its other batches, as [the cost model](#the-cost-model) describes, and every
other suite what its batches cost without. The full run measures every suite; a
pull request measures the suites of the sets its gate scores. A suite no lane
has yet run the way this run runs it is charged the other fit: with coverage on
that errs high, and without it is short by whatever instrumenting costs, but
either is nearer than charging nothing.

Each lane converts the profiles under each measured set's directory into
one report and uploads it. `Status` adds the five together per set, scores
each set the diff reached, and fails when the uncovered count has risen. A
rise is accepted with the marker the repository already has, in the same
form and with the same rebase-proof meaning:

```text
ACCEPT_COVERAGE_DEBT: packages/memory +12 lines
```

The marker names the member, and it accepts the rise for every measured
set over that member. A marker that had to name a suite as well would ask
an author to know which suite measured what before they could say "yes,
knowingly". Where a member carries two sets, one marker therefore accepts
a rise in both; no member carries two, since the sets in the tree are the unit
suites' and those divide the members between them.

A marker naming anything but a workspace member fails the gate, because nothing
consults it. A marker was written to have an effect, and one naming a source
group such as `packages/connectors`, which holds members but is none, would
otherwise pass for one that worked.

### What `main` does

The full run measures every set, because it runs every test in every
suite: the profiles land in the same per-set directories, and the same
conversion produces the same numbers. Those are the baselines. Nothing
gates on them there.

Then, separately, the run merges every report its lanes wrote into one and
takes the repository-wide figure out of that, which is the trend the
dashboard shows. The merge is over everything the run measured rather than
over the per-set reports alone, so the trend goes on counting the coverage
that integration tests and pattern runs contribute, as it does today.

The two figures come from the same profiles and answer different
questions, so they are published under different names and nothing
compares one against the other.

### The baseline, and when it declines to fail

The manifest carries the per-set numbers for every full `main` run in the
last `LOCAL_COVERAGE_BASELINE_DAYS`, each against its commit. The gate
takes the newest of them the branch contains, and which one that is comes
from git: it reads the branch's own history back from the tip and takes
the first of those commits it finds. The data it walks over is in the manifest
current at the tested commit's committer date, so the gate downloads nothing
from earlier runs.

The branch's history rather than the moment each run was created. A
re-run of an older commit is created after the run of a newer one, so run
times can order two baselines the opposite way from the trees they
measured, and the tree is what a rise is measured against. Reading the
history back from the tip also costs only the distance to the answer,
where asking about each commit in turn costs a question per commit and
the window holds a week of them.

Two of the cases that report instead of failing are about the baseline. A
set with no baseline yet is reported, because the first pull request to
reach a new package should not inherit the whole of that package's debt.
And when the manifest holds no run the branch contains, the comparison
would be against a tree the branch does not have, so a rise measured
against it is not the branch's rise.

A forced set whose joined reports name no line of its member fails. A
set's tests always load some of their own member's source, so an empty
report measured nothing, rather than covering nothing. Charging it every
tracked line would score a measurement that never happened, and passing
it would pass a rise that nothing measured. That is the failure of a
forced set no lane reported, and the gate treats the two alike. An
unforced set whose reports name nothing is reported, as an unforced set
no run measured is.

The publisher fills those numbers from the coverage measurements of the
`main` runs among the objects it folds, and carries forward what the previous
manifest held for the rest of the window. A publish folds only what no
earlier one folded, so what each adds is the runs since the last one. A
run whose line never reached the store contributes no baseline, and every
set with no baseline is reported rather than gated.

### Why this one is sound

Both sides run the same complete set of tests over the same member's
lines. Selection cannot skew it, because within that set nothing is
selected. How the packer spreads it over lanes cannot skew it, because the
profiles are joined by the set they belong to rather than by the lane that
produced them. Another suite cannot skew it, because another suite's profiles
are in another directory. The count moves when the member's own source or the
set's own tests change, which is the change the author is looking at. That is
the whole of the argument, and it is why this gate keeps its teeth while the
repository-wide one gives them up.

## Telling a pull request what `main` found

Selection means some regressions land and `main` catches them. That is the
trade, and it is only acceptable if the change that caused it finds out
without anybody having to go looking.

A reporter workflow follows every `main` run to completion, in the
base-repository context with a write token, exactly as the coverage
comment already does. The repository squash-merges with the pull request
number in the subject, so the pull request behind a `main` commit is
unambiguous. Both comments live in
`.github/workflows/pull-request-comments.yml`, and the reporter is
`tasks/post-main-report.ts` over `tasks/test-selection/report.ts`.

It comments once, on that pull request, when the run found something the
pull request's own run could not have:

- **A test that failed for the first time at this commit.** Precisely
  that: the identity passed in the previous `main` run and failed in this
  one. Attribution comes from the store rather than from an assumption,
  which is what stops the comment landing on whoever merged next after
  somebody else broke something.
- **What the pull request's own run did with that test.** Its records say
  whether it ran the test; the manifest it resolved says why it did not,
  which only this system can answer. That manifest is the one current at the
  committer date of the commit the run tested, which for a pull request is the
  merge commit its records name, and never the branch's tip. Where the report
  cannot establish that commit or its date, it says the run did not run the test
  and gives no reason. The same holds for a pull request whose run did not run
  in lanes, since no manifest chose what it ran. The answer changes what to do. Not selected is the
  expected cost of selection, and the failure will raise the test's score so the
  next change in that area runs it. Ran and passing is a flake or an interaction
  between changes, and it is a different conversation.
- **A coverage debt increase above the threshold**, naming the source
  groups the change touched that rose as well, which is as near as this
  gets to saying where a test would go. Never as a failure — the run is
  green — and never for one line.
- **A rise in a measured set's number**, named as one the coverage gate
  exists to catch. There are three ways one reaches `main`: the change
  reached more measured sets than the cap allows, so the gate did not run;
  a member the change reached is on the exclusion list; or a change
  somewhere else moved which lines of that member the set's tests reach. The comment says which, because the three call for
  different things — nothing, a look at the exclusion list, and a look at
  the change respectively. A fourth state is possible and the comment
  names it too: the gate measured the package on the pull request and
  passed it, which is the two measurements disagreeing rather than any of
  the three.
- **A new test that turned out to be flaky**, when a test the pull request
  added has since disagreed with itself.
- **A test too flaky for pull requests that failed every one of its runs
  at this commit and passed every one at the parent.** Those failures do
  not fail the run, so the lane's job summary is the only other place they
  appear, and nobody reads the summary of a run that passed. It says the
  test is a known flaky one, that this run did not fail because of it, and that
  the same record is what one bad runner produces, since every run of an
  identity at a commit shares a lane. It gives the run counts at the commit and
  at the parent, and the store's flake counts. Weak evidence, named as weak, is
  what there is. Such a test is not also listed as a first failure. Which
  failures a run excused is a fact about that run: a lane excuses a flaky test's
  failure only where its batch accounted for every identity it was asked to run,
  and a run that did not apply the rule excused nothing. The lanes record each
  identity they excused, and the report reads those records; the manifest
  supplies only the store's flake counts, and a report that cannot read it
  gives the note without them.
- **A rename that discarded history**, with the alias line to append and
  the number of catches it would bring back. See [Renames, and the alias
  file](#renames-and-the-alias-file).

### Keeping this on the right side of the line

The dashboard's rule is "report on the system, never on individuals: no
per-person leaderboards, no 'who broke the build', nothing that turns the
dashboard into a place to rank or shame people." A comment naming the
change that introduced a regression is close enough to that line to be
worth being deliberate about which side it is on.

It sits on the right side, and these are the properties that keep it
there, each of which is a constraint on the implementation rather than an
observation about it:

- **It addresses the change, not the person.** The comment's subject is a
  commit and a test. No author is named, no author is mentioned; GitHub's
  own subscription is what delivers it, the same as any other comment.
- **Nothing is aggregated, ever.** No count of regressions per author, per
  team, or per anything. No history. The comment exists on the pull
  request and nowhere else, and no tile, report, or query rolls them up.
- **It is not a judgement, because the system chose not to run the test.**
  When a test was not selected, the honest statement is that this design
  traded that coverage away, and the comment says so in those words. The
  author did not miss anything; the selector did.
- **It is accurate about flakes.** A test the store has seen disagreeing
  with itself is labelled as one, with the counts behind the label, so
  nobody is told they broke something that breaks on its own and nobody
  is asked to take that on trust.
- **It is actionable and it ends.** Every comment says what to do, and it
  is edited in place rather than repeated when the same thing recurs.

If it ever stops being all five of those, it should be removed rather than
tuned. A notification people learn to resent is worse than no
notification, for the same reason a board of red tiles is worse than no
board.

## Consequences we are choosing

These follow from the design rather than from any detail of it, and they
are the substance of the decision.

**More breakage reaches `main`.** A pull request that breaks a test the
selector did not pick will merge, and `main` will go red about 15 minutes
later. That is the trade. What makes it bearable is that the blast radius
is one commit, the full run names the test, the change that caused it gets
told without anybody going looking, and the failure raises that test's
score so the next change in that area runs it. If the rate turns out to be
intolerable, the escape hatch is a merge queue, which restores the
guarantee at the cost of merge latency. This plan does not propose one; it
notes that the option exists and that nothing here forecloses it.

**A test too flaky for pull requests cannot turn `main` red, so a real
regression inside one is missed and a green run ships.** The test still
runs, more often than it did before, and every result is recorded and
scored. What no longer happens is the build stopping for it, and the build
is what the deploy depends on. The reporter carries the one observation
that is left, and names what it cannot tell apart. I'd guess this is the
better trade, on two grounds neither of which is measured here: a failure
of a test whose share says it fails on its own says very little about the
commit it failed at, and a `main` that goes red for tests nobody can act
on is one people learn to read past, which costs the signal for everything
else on it. Running these tests several times and keeping every failure
gating is the alternative, and it is set out beside the rule.

**Outside a measured set, a change to a source file does not pull in the
tests that execute it.** Selection knows which test files a change edited,
and which units the declarations reach. Where those reach a [measured
set](#the-measured-set) and the diff stays under the cap, the gate makes
that whole set mandatory, which reaches the tests executing the changed
lines by running every test the set holds. Everywhere else, selection
does not know which tests execute a changed line, so what runs for an
edited source file is what the score chose. The finer answer is buildable
and is not being built. Deno writes one coverage profile per pair of test
file and source file, which was checked rather than assumed, but the
profiles carry no marker saying which test file produced them. So telling
them apart takes one coverage directory per test file, which takes one
`deno test` invocation per test file, and at around 2,000 test files that
is about three and a half hours of runner time. A job of that size runs on
a cadence of its own and publishes an artifact of its own, which every
lane then has to resolve, reconcile against the tree, and fall back from
when it is absent. What that buys is a better mandatory set, and what it
costs is a second store to keep and a second thing to be wrong about. Such
a map only ever adds items to a run, so building one later means adding
the job and the rules that read it rather than redesigning the packer.

**Pull requests should get *less* red, not more.** This is the opposite of
what an early draft of this design predicted, and the difference is the
exclusion rule. A test too flaky to judge by is not selected, so nobody's
pull request fails for a test that disagrees with itself. Three kinds of
test are left that can turn one red. One the packing made mandatory,
which is a test the change touches or one the store has never seen. One
the score reached, which is the category where a red build is worth
having. And one the default branch is already failing, which nothing
holds back; that failure belongs to the default branch, and fixing it
there is what clears it. Set against all of that, a
flaky-but-not-excluded item repeated three times fails three times as
often as it would have. The net is an empirical question and the
dashboard is where it gets answered.

**Coverage stops being enforced across the repository, and stays enforced
over each measured set.** Nothing will fail because a change lowered the
repository's whole coverage number. What replaces that is a weekly trend
somebody has to choose to look at, plus a comment naming the source
groups where the debt rose. Over the 34 [measured
sets](#the-measured-set) the ratchet still fails a pull request, because
there both sides measure the same complete thing. The reduction in
enforcement is real and confined to what could no longer be measured per
change: the code covered by suites a pull request only samples. If debt starts climbing there, the response is a conversation
about the trend, not a reinstated gate on a number a selected run cannot
produce.

**A developer whose pull request fails on a test they did not touch needs
a way forward.** The job summary names every item the lane ran and why it
was chosen — the catches behind its score, the change that made it
mandatory, or the exploration draw — which makes "this is not mine" a fast
conclusion rather than a guess. `--explain` answers the same question for
any identity. Re-running the lane runs the same set, because the manifest
is pinned to the commit's date. And if none of that settles it,
`ci: full` runs everything.

## Failure modes

| What goes wrong | What happens |
| --- | --- |
| The store holds no manifest at or before the commit | The lane reads its share from the tree instead. Nothing has records, so the whole corpus is mandatory and the lanes divide it between them, printing that they are running everything. Pull requests keep flowing, and slower. |
| The store is unreachable from a lane | The lane fails, saying so. An answer from the store is the same for every lane, but a failure to reach it can happen to one lane and not to the next. A lane that packed without the manifest its siblings packed from would lay out a plan they are not following, and a test each plan put in the other's lanes would run in neither. The full run's lane count is planned from the same reading, so it fails the same way. Re-running the job reads the store again, and a store that stays unreachable stops every pull request's lanes until it is reachable again. |
| The publisher has not run for a day | Lanes use the last manifest. Selection quality decays slowly; nothing fails. |
| The manifest is malformed or a newer schema | Rejected whole and treated as absent, the same path as a store holding none. |
| A selected item no longer exists in the tree | Dropped with a line in the summary. A renamed test is simultaneously an unknown item, so it runs anyway. |
| A new test surface nobody registered | `check-test-topology` fails on the next `main` run and names the unclaimed identities. |
| A workflow step that records a check by hand | The workflow half of the drift guard fails on the pull request that adds the step, whether or not a suite claims the check, and says which: a check a suite holds would be recorded twice, and one no suite holds would never be run or selected by a lane. |
| A record's variant or record surface contradicts its batch | Kept as written and named in the lane summary. The identity then belongs to no suite, so the store half of the drift guard fails on that `main` run. |
| A test is deleted | Nothing has to be declared. The topology stops enumerating it, so the manifest leaves it out and the reconciliation against the tree drops the entry a manifest published earlier still names. The store keeps its records, and the publisher's aggregate stops carrying its state once no run has recorded it inside the longest window a state keeps counters for. The store half of the drift guard judges the run's own records, so the deletion is not read as a disagreement. |
| A suite gains a new variant with no records | Every available item in that variant is mandatory until a successful full `main` run accounts for every enumerated item under that exact variant, the store drift guard passes, and the next publisher cycle includes the run. Other variants do not stand in for it. |
| A variant deliberately skips a file or leaf | The topology reads the existing skip registry and the manifest reports the test as unavailable with its phase and reason. It is not unknown. Removing the skip makes it mandatory until `main` records it. |
| One item is bigger than a lane's planned budget | It gets a lane to itself, up to the five-minute bound. Bigger than that, a mandatory item is still placed and its lane over-runs, while a discretionary one is listed as unschedulable in the manifest and reported; the 60-second ratchet is the fix. |
| The mandatory set alone exceeds the budget | The lane runs it anyway and over-runs, past the five-minute bound where the set demands it. The work step's own timeout is 30 minutes and only stops a lane that hangs, so the lane finishes and is measured rather than stopped. Its job log says how far its plan was projected past the budget, which is what argues for raising the bound. |
| A measured set has no baseline, or none from an ancestor of the merge base | `Status` reports the comparison and does not fail. The next full `main` run supplies one. |
| A measured member gains a test needing a browser or a server | It goes in the member's `browser-test` half, which no measured set holds, so the Deno-only half keeps its gate. A member with no such half yet names one. |
| A measured set grows expensive | Reported in the publisher's summary and by `deno task test-selection coverage`. Nothing is excluded automatically; somebody splits the member's tests or adds a line to the exclusion list. |
| A test in a measured set fails | Every set a lane's report measured is reported rather than gated. Coverage measured through a failing run says nothing about whether the change was tested, and the failure is the thing to fix. |
| A change reaches more than two measured sets | None is forced, and `Status` says so. A set some run measured anyway is still scored, and a set the cap left unforced that nothing measured is reported rather than failed. The full run on `main` still measures every set, and a rise it finds is reported back to the pull request. |
| No lane's report measuring a forced set reaches the gate: a lane dies before uploading, an upload or the download carries nothing, or a lane writes an empty report | That set fails the gate, whether or not any lane failed, because the change was made to measure those sets and a rise in them cannot be ruled out. A set the cap left unforced is reported rather than failed. |
| Two measured sets over one member disagree | Nothing joins them. Each carries its own baseline and its own verdict, and an `ACCEPT_COVERAGE_DEBT` marker naming the member accepts a rise in either. |
| A lane exceeds five minutes repeatedly | The correction factors rise on the next publisher run and less is packed. If it persists, the publisher's summary shows the miss and somebody looks. |
| Two attempts of one run straddle a UTC midnight | The later attempt's relay writes the earlier attempt's records a second time, under the later day, and the publisher folds both. Not observed in the store so far; see [What the store is missing](#what-the-store-is-missing). |
| A fork pull request | Works unchanged. The manifest is world-readable, and the existing member gate decides whether the fork's records ship. |
| A re-run of one failed lane | Runs the same set, because the manifest is resolved by the commit's date, which no attempt changes. |
| A lane cannot read the date of the commit it is testing | The lane fails and says why, and so does the job counting the full run's lanes. Reading the date can fail in one lane and not the next, and no other moment is one the lanes are sure to share, so this fails for the reason an unreachable store does. |
| `tests` is skipped | `Status` fails. Its second clause requires `tests` to have succeeded, so a pull request that ran no tests can never report green. |
| A test too flaky for pull requests fails on `main` | Where its batch accounted for every identity it was asked to run, the failure does not fail the run, and the job summary names the failure and its identity. The records are scored as any others, so the failure feeds the share, the dashboard, and the deflake work queue. |
| A batch on `main` does not account for every identity it was asked to run | The lane fails. Nothing has shown the failures it did record to be the whole of what went wrong, and missing evidence is read as a real failure. |
| A test too flaky for pull requests genuinely regresses | `main` stays green and the change ships. The regression is found when somebody deflakes the test, or from the reporter's comment where every run failed at the commit and every run passed at its parent. That comment says a bad runner produces the same record. |
| A repository gate goes above the flake threshold | It leaves pull requests as any test does, and it goes on failing `main`. The non-gating rule is for tests, so a gate never stops gating the branch it is a gate on. |
| A bad runner fails every run of an excluded identity at one commit | No disagreement is recorded, the failure waits for the next `main` run, and a pass at a later commit credits a catch the test did not earn. This is the environmental gap the flake rules already carry, and these runs sit inside it. |
| `main` is broken and stays broken | Nothing holds a test back for having failed on `main`, so a pull request that selects the broken test fails on it. The failure belongs to the default branch, and fixing it there is what clears it. |
| The reporter cannot find the pull request behind a `main` commit | It logs the commit and posts nothing. A direct push to `main` with no pull request behind it is the ordinary case for this. |
| The reporter would comment on a test that is known flaky | It says so in the comment rather than implying the change caused it. |
| Somebody games the coverage number | There is nothing to game: no gate, no per-change target, and a tile that shows a multi-week direction rather than a figure. |

## Security and trust

The manifest can only change *which* tests run. It cannot change what a
test does, what a test asserts, or what the repository builds. The worst a
corrupted manifest achieves is a pull request that ran fewer tests than it
should have, which the full run on `main` catches. That bounds the whole
attack surface, and it is why the manifest is allowed to be an ordinary
public object rather than a signed artifact.

The publisher is the only workflow-scoped writer to the manifest prefix. Its
service account is reachable through a Workload Identity provider pinned to one
workflow file on `main`, exactly as the relay is. Its identity-specific
`objectCreator` grant cannot overwrite or delete, while the dataset's public
`objectViewer` grant separately lets it read and list objects like any other
public reader. A bucket administrator can still write anywhere in the
bucket. That is a risk the infrastructure has to contain, rather than a
second way to publish a manifest.

The lane runner treats the manifest as untrusted input and validates it
whole. The only field that reaches a shell is a suite identifier, which is
matched against the topology's own list rather than interpolated.

## Testing this

A system that decides which tests run is one whose own bugs are quiet, so
it is worth saying up front how each part is held down.

`plan()` is a pure function and gets the most attention: recorded
manifests become fixtures, and the properties worth asserting are that the
five lanes partition the selected set with no item in two lanes and none
in none, that every mandatory item appears, that no lane's projected time
exceeds its budget unless a single item forces it, that the same inputs
give the same output every time, and that a manifest naming suites the
topology does not have is rejected rather than partly obeyed.

Scoring and catch classification are tested against synthetic record sets
where the right answer is known by construction. A failure at a commit
where `main` was already red is not a catch. A failure at a commit that
also has a pass is flake evidence, not a catch. A failure on `main` that
the next `main` run passes with no intervening change to covered code is
flake evidence; the same failure with a fix in between is a catch, and
that pair is the one worth writing first, because getting it wrong turns a
test that is flaky on `main` into the highest-scoring test in the
repository. A failure appearing on 11 branches within an hour is
environmental, not 11 catches. A test with four catches from two years ago
still outranks a test with none. An identity that has never failed
anywhere scores exactly `VALUE_FLOOR`, and one whose only failures were
classified as non-catches scores the floor plus its churn term and never a
missing value. A default identity and a variant with the same kind, scope,
and name get independent scores. And an identity absent from the store
comes out mandatory even when another variant has history.

Each suite's `enumerate()` and `locate()` get their own tests, and
`check-test-topology` is the integration-level check that they are
complete against what really ran. Its fixtures prove that a source item
may belong to one default suite and one non-default suite, that two suites
cannot claim it under the same variant, and that each stored identity maps
only to the suite carrying its exact variant. Separate fixtures cover both
skip shapes from `tasks/server-execution-on-skips.ts`: a whole-file skip is
declared unavailable and is not enumerated, while a step-level skip leaves
the file and its other identities available but excludes the named leaf
from the unknown-identity rule. A CLI fixture maps step identities to
items and the overlapping `integration.sh` task identity to the suite. The
task identity is claimed by the drift guard but contributes to neither
item score nor item cost, so it cannot double-count its steps. The same
fixture holds the dispatch table's overlapping arms and proves that a step
reachable from several of them still locates to exactly one item.

The lane runner gets a mixed-lane fixture containing a default batch and a
non-default batch. Both direct spool fragments and JUnit-derived records
from the default batch must omit `v`; both sources from the non-default
batch must carry its exact value. The final shipping step must remain
unmarked, proving that no job-wide marker can overwrite the mixed records.
The command-line gather path and the lane runner exercise the same gather
function and fixtures, including its existing overwrite behavior when a
variant is declared and its topology warning for a marked direct record in
a default batch. A repeated-item fixture gives every execution fresh paths
and proves that records from every execution reach the lane spool.

The coverage gate is tested from recorded profile directories rather than
by running tests. A fixture holding one measured set's coverage directory
proves that converting it alone gives that set's own figure, and that
merging it with its siblings gives the repository-wide figure, so the two series
are shown to be the two readings of one set of profiles. A fixture holding two
suites' directories over one member proves that neither suite's coverage moves
the other's number. A workspace fixture proves that every member under
`packages/` carries a set at whatever depth it sits, that a member added to the
fixture's workspace array carries one without any other edit, and that only the
members in `EXCLUDED_FROM_COVERAGE_GATE` are left out. A member defining
`deno-test` proves that the set holds that task's units, that its coverage
directory is separate from the rest of `test`, and that a test added to
`browser-test` moves neither the measured half nor the member's place in the
gate. The packer gets a fixture proving that a measured set's items are not
reachable by the value, density, or exploration pass, and are not repeated. The
join gets a fixture of five lanes' reports for one set split across them,
proving that the total equals the same tests measured in one run, and that a set
whose items landed in three lanes is scored once. A diff reaching one, two, and
three measured sets proves the cap: gated, gated, and not gated at all rather
than gated for two of the three. And the baseline walk is tested against
recorded chains of `main` commits: a rise against an ancestor fails, a
rise against a run the merge base does not contain reports, and a set with
no baseline reports.

The full run's treatment of a flaky test is tested at both ends. In
`plan()`, a withheld identity is placed under the `everything` policy
with the count its share asks for and named in `nonGating`; a withheld
entry whose reason is not `flaky` is held back and not named in
`nonGating`; and an identity whose runs do not fit gives them up until
they do rather than putting its lane past the bound. In the lane runner,
a fixture of batch results and records proves four cases: a batch failing only on non-gating identities does not fail the
lane, a batch failing on one other identity does, a batch failing on a
non-gating identity in one run and not another does not, and a batch that
recorded no outcome for some identity it was asked to run fails the lane
whatever its failures were. The last is the one worth writing first,
because getting it wrong turns a batch that died early into a green run.

The reporter's attribution is where a bug would be most costly, because a
wrong comment lands on a person. It is tested against recorded pairs of
consecutive `main` runs, and the property that matters is the negative
one: a test already failing in the previous run produces no comment, so a
break never gets attributed to whoever merged next.

Everything a person types goes through one entry point, `deno task
test-selection`. Its modes are also how the system is tested by hand.

- `plan --dry-run` prints what would run — batches, items, repeats,
  capabilities, projected times, and what was withheld — and runs nothing.
  Given a lane number it answers "what would lane three do on my branch?",
  and given none it prints all five. Pointed at a recorded run rather than
  a working tree, it is the offline projection this plan's own numbers are
  checked against.
- `plan --verify` compares the identity set the topology produces against
  what a recorded run actually executed, and names the difference in both
  directions: identities the run produced that no suite claims, and items
  the topology enumerates that the run never recorded. This is what proves
  the topology accounts for everything before it replaces the old matrix.
- `explain <identity>` prints one test's score, the catches behind it
  with their dates and sources, its flake rate, and which item it maps to.
  A suite-level measurement instead says that it is not selectable. For an
  item identity, the output says whether the manifest the checked-out
  commit resolves selects it, how many runs it gives it, and whether it
  withholds it from pull requests. The argument accepts the canonical
  three- or four-part identity key, and the output always names a present
  variant.
  This is what somebody uses to answer "why did my test not run?", which
  is the question this system will be asked most often and the one it
  would otherwise answer badly.
- `dials` prints every dial with its comment, its current value and the
  unit that value is in, saying of each whether somebody chose it, the
  publisher measures it, or it is computed from other dials, and for a
  measured one whether the figure shown is still the checked-in seed or
  one the publisher has since written back.
- `coverage` prints every measured set, the suite and the member it pairs,
  the task the set measures, and the baseline the checked-out commit's
  manifest holds for it, and beside them every workspace member that
  carries no set and the reason it does not. This is what somebody uses to answer "why is my
  package not gated?" and "what am I being compared against?". Where it resolves
  a manifest it also prints the publisher's lines about what the measured sets
  cost with coverage on.

`tasks/ci-lane.ts` keeps a `--dry-run` of its own, because that is how
continuous integration asks the same question from inside a job.
`plan --dry-run` is that code path with a person's output rather than a
job summary, so the two cannot disagree about what would run. Every mode
that reads a manifest resolves it the way a lane does, at the moment the
checked-out commit was made, so each reads the manifest the lanes testing
that commit read, or the one current at the moment `--at` names.

## Every dial in one place

`tasks/test-selection/policy.ts` holds every number this design can be
tuned by, and nothing else holds any of them. Each is a named export with
a comment saying what it does, which way to move it, and what moving it
costs. `deno task test-selection dials` prints the current values with
those comments, and every manifest records the values it was built with,
so a manifest is self-describing and a change in behavior can always be
traced to a change in a dial.

[Every dial](../development/test-selection.md#every-dial) in the
test-selection guide tabulates them, one row each with its default, its
unit, where its value comes from, and the reason to move it.

Of the chosen dials, three are worth revisiting first, because their right
values are empirical rather than structural. They stay chosen — nothing
measures them for us — but the evidence for moving them accumulates:
`FRESHNESS_HALF_LIFE_DAYS`, which decides how long a proven test stays
proven; `FLAKE_EXCLUSION_RATE`, which trades pull-request noise against
coverage; and `CHURN_HALF_LIFE_DAYS`.

## The work

**One pull request, unless something mechanical forces otherwise.** No
flags, no shadow systems, and nothing to flip. The three parts below are a
build order rather than three changes: each depends on the one before it,
and splitting them across pull requests buys a little caution at the price
of three review cycles, three rebases of a large change, and a stretch of
weeks in which the repository holds half a system and nobody can tell
which half.

The rest of this section is about what a single landing has to satisfy. It
is worth reading before assuming a split is needed, because two of the
three reasons that look like they force one turn out not to.

### The prerequisites that are not ours

The publisher needs a writer credential: the `test-selection-labs` service
account with `objectCreator` on the manifest and state prefixes, and a
Workload Identity provider pinned to
`.github/workflows/test-selection.yml` on `main`. Manifest and state
objects expire after 45 days, and that lifecycle rule is what a lane's
resolution rests on: a commit resolves the newest manifest at or before
its own date, so the manifests a run may need have to outlive the window
in which GitHub still permits that run to be re-run. Where the re-run
window is the longer of the two, the retention is what to raise. The same
infra root provisions the compactor principal.

All of that lives in the infra repository under `tofu/test-records`, and
all of it is applied: the accounts, the grants, the pinned providers, and
the lifecycle rule. Nothing outside this repository has to happen before
the work here publishes, so this is not a reason to split it.

### Proving the topology before merging, not after

The strongest argument for a separate pull request was that the topology
is only really proven by running, so it should carry `main` for a while
before any pull request depends on it. That argument does not survive
contact with the design, because the design already has the mechanism.

A pull request labelled `ci: full` runs `plan-full` and every test, as a push
to `main` does. So the branch can run exactly what
`main` would run, against its own tree, as many times as it takes, before
anything merges. That is the proof the extra pull request was there to
buy, and it costs a label.

The other pre-merge checks are all offline or read-only:

- `plan --verify` compares the identity set the topology produces against
  what the old matrix ran, from the store rather than by eye.
- The store half of the drift guard runs against the `ci: full` run on
  the branch, over that run's own records, which is the same comparison
  it will make after merging.
- `plan --dry-run` over the reference records is a pure function over
  recorded data and needs nothing live.

What remains unproven until the topology actually carries `main` is
narrow: that a full run through the lane runner produces the same record
set as the old matrix did, on `main`'s own tree rather than on a branch.
The `ci: full` run makes that a small residual rather than the main risk.

### The window after merging, and why it is safe

A manifest cannot exist before the topology has produced a `main` run,
because there is nothing to build one from. So there is a window: merge,
`main`'s full run, the one-off publisher dispatch, and only then does
selection have data. That window is one `main` run and one manual
dispatch, not days.

Pull requests in that window are already handled. A lane that finds no
manifest takes the fallback: nothing has records, so every unit the tree
holds is an identity with none and the whole corpus is mandatory. The
lanes divide it between them and print that they are running everything. Feedback costs the time selection
would have saved for one afternoon, and it misses nothing.

The calibration numbers converge over the days after that, from the lanes'
own timing records, which is what they were always going to do.

### Part one — the data, and what it already tells us

Nothing about what continuous integration runs changes. This pull request
only makes the store answer questions it cannot answer yet, and puts the
answers somewhere people can see them.

- [x] A preload module in `@commonfabric/test-support` that captures the
      registering module for every `Deno.test` and writes the name-to-file
      map into the spool; `ingestJUnit` joins on it; the runners append
      the preload to the invocations that can take one.
- [x] `packages/deno-web-test/runner.ts` sets `file` on the records it
      writes directly.
- [x] `tasks/test-selection/{policy,score,manifest,store}.ts` — the dials,
      the catch and flake derivation, the manifest format and its
      validators, and the reader and writer. Complete identities use the
      canonical test-record key, optional variants included, and variants
      score independently. Identities resolve through `loadAliasResolver`,
      as the report tool and dashboard collector already do. A
      reference-scale fixture records the serialized and gzipped manifest
      sizes instead of deriving item size from the identity count.
- [x] `tasks/test-selection/plan.ts`, the pure packing function, tested
      offline against recorded manifests.
- [x] `tasks/test-selection-publish.ts` and
      `.github/workflows/test-selection.yml`, on a four-hourly cron.
- [x] Hold manifest retention above the window in which GitHub still
      permits a run to be re-run. A lane resolves the newest manifest at or
      before the commit's date, so the answer is the same for every lane
      and every later attempt as long as the object it names still exists.
      A manifest that expires between an attempt and its re-run is the one
      way the two can disagree, and the lifecycle rule is where that is
      settled rather than in anything a lane reads.
- [x] One source-and-date input plan, which bootstrap and ordinary
      publishing both apply. A flag is permission to start from an empty
      aggregate and a wider default window, and nothing else decides what
      is read.
- [x] A source-scoped receipt in place of the date-only one, so that a
      rollup of the shared area cannot say a day is accounted for and
      take that day's local submissions with it. Local records stay on
      their raw path until they have rollups of their own.
- [x] The aggregate forgets a test the tree has lost, on the two
      conditions [removals](#removals-and-what-the-aggregate-forgets)
      names. Without it the store's whole history of deleted tests is
      read, scored and written back forever, and the count of identities
      the topology has no unit for cannot be read.
- [x] The one-off bootstrap dispatch. On 2026-09-06, [run
      34020738350](https://github.com/commonfabric/labs/actions/runs/34020738350)
      on `main` folded 12 rollup days and 67,463,235 executions, then created
      `manifest-2026-09-06T08:02:32.080Z-01M1TWYZZV2PXG5Y5VG3MCY91Q.json.gz`
      and the matching state object. The public listing shows both, and later
      incremental runs succeeded from that state. As a later check, scheduled
      [run
      34274701451](https://github.com/commonfabric/labs/actions/runs/34274701451)
      on 2026-09-08 folded 1,321,563 executions into 19,904 identities and
      created
      `manifest-2026-09-08T20:25:40.387Z-01M21B6E8PQV8ZPP0E21CMR4G3.json.gz`
      with its matching state object.
- [x] Repeat the record census after `main` emitted server-execution
      variant records, and replace the plan's projection inputs.
- [x] Dashboard tiles: the flake list, what the newest manifest would
      select, and the coverage debt trend. The trend reads the
      repository-wide figure from the coverage measurements each `main`
      run writes into the record store, so it needs nothing from the rest
      of this work.
- [x] The `deno task test-selection` entry point and its modes: `dials`,
      `coverage`, `explain <identity>`, and `plan` with `--dry-run` and
      `--verify`. Every mode that packs reads the topology, so the
      capability setup a lane opens is charged here as it is there.

On its own this part gives the repository a flake list derived from
evidence rather than from anecdote, and a coverage trend nobody has today.
If the rest never landed it would still have been worth it, which is why
it is the one part worth splitting off if the change has to be split at
all.

### Part two — the topology

The topology goes in, and both `main` and the `ci: full` label start using
it. Nothing here depends on selection, so this part can be finished and
exercised on the branch on its own.

- [x] `tasks/test-topology.ts` and one module per suite, including each
      suite's declared record surfaces and optional variant, and typed
      record-surface descriptors for every JUnit output. `locate()`
      distinguishes item identities from overlapping suite-level
      measurements, and returns at most one item for an identity that
      several arms or entry points can run. Add `tasks/ci-capabilities.ts`.
      Twenty-one suites currently hold 2,396 units. The repository gates are two
      suites rather than one, because a lane opens what a suite needs
      before it runs any of it: `repo-gates` holds every gate that reads
      the working tree alone, and `repo-history-gates` the two append-only
      gates that read the revision the change is measured against.
- [x] The server-execution ON configuration consumes
      `tasks/server-execution-on-skips.ts`: whole-file entries are declared
      unavailable and omitted from enumeration, while step entries exclude
      only the named leaf identity from the unknown-identity rule.
- [x] Give `packages/cli/integration/fuse-exec.sh` fine granularity.
  - [x] Every phase records, so the suite records 25 identities rather
        than one, across the 23 phases the script goes through. Each
        marker leads the phase it names, through the same
        `cf_test_step_begin` `integration.sh` uses, so a phase that fails
        is the record that carries the failure rather than the script's
        own record carrying it. The two phases that bring the mount up
        are the identities this adds beyond the phases that already
        named one.
  - [x] It gains a section dispatch over the four groups of phases that
        stand alone, so `cli-fuse` becomes an item suite like its sibling.
        A section is a group of phases over one mount, and the
        dependencies deciding where the boundaries fall are named in
        [the reference build's jobs as
        suites](#the-reference-builds-jobs-as-suites).
        `packages/cli/test/fuse-sections.test.ts` holds the dispatch table to
        the properties that make a section schedulable, the way
        `integration-sections.test.ts` holds its sibling's.
- [x] Split the `piece-call` CLI integration dispatch into its eight
      recorded steps. Seven already had an arm of their own; the missing
      one for `run_piece_call` is added, and so are the two the
      `piece-values` group hid, so every recorded step now has an arm that
      runs it alone. The grouped arms stay for hand runs and are not
      enumerated. Making those arms the `cli-core` items is the topology's
      part. `packages/cli/test/integration-sections.test.ts` holds the
      dispatch table to that property, and to every step being scheduled
      by some group rather than only by name.
- [x] `tasks/test-topology/binaries.ts`: each shipped binary is a unit
      whose test is that it still compiles, and the toolshed under the
      server-execution define is a variant of that rather than a second
      test. A pull request runs its servers and its command line from
      source and compiles nothing, so without these a broken compile
      would be found only on `main`.
- [x] `tasks/check-test-topology.ts`, tree, workflow and store, wired into
      `repo-gates`, with exact variant matching and one source-item claim
      allowed per variant. The store half is given the commit its records
      were produced at and refuses records from any other, so that a tree
      is judged by what that tree recorded rather than by what a build
      before a deletion did. Eight paths that look like tests and are not
      are declared as the fixtures they are: the five projects under
      `packages/deno-web-test/test/` that the harness drives, and the
      three command-line tours the verb-session gate holds the
      documentation to rather than running.
- [x] Extract the part of `tasks/test-records-gather.ts` that reads records,
      ingests JUnit, and applies a declared variant as the shared gather
      function. Its command-line entry point and `tasks/ci-lane.ts` both
      use it. The lane runner gives every batch execution fresh spool and
      JUnit paths, gathers it before any repeat, and combines all records
      into the unmarked lane spool. It also includes `--full`, `--dry-run`,
      and repeats.
- [x] `deno.yml`: `plan-full` on a push, a called run, and a pull request
      labelled `ci: full`, and one `tests` job running the lanes of every run,
      with the attestation and deploy jobs repointed at `tests` and the builds
      running on a push only. The lane's coverage upload carries the whole of
      the lane's coverage directory rather than its `.lcov` files: a measured
      set the lane saw fail is marked by a file beside the report, and a glob
      over one extension would drop it and publish the baseline anyway.
- [x] The store half of the drift guard runs over the records every job
      of a run shipped, against that run's commit. It cannot be a gate
      inside a lane: a lane's records have not shipped when its gates
      run, so the half would be reading an earlier build's records and
      failing on every test this run deleted. It is a step of `Status`, which
      waits for every lane and downloads every lane's `test-records-*` artifact.
      A gathered artifact is a run's records without the context a report opens
      with, so the commit each is held to is read from the facts its own job
      wrote beside them, and one that names none stays nameless for the store
      half to refuse.
- [x] That step runs on a pull request as well as on the default branch. What
      this drift is introduced by is a change to a suite, a runner, or a test's
      name, and that change has a run of its own to fail; the default branch is
      left catching the pair of changes that were each claimed separately and
      are not together. Turning it on cost nobody a blocked pull request, the
      half passing over the runs of both at the time it was wired.
- [x] Both post-test checks are steps of `Status`, the one job after the lanes,
      rather than jobs of their own that each keep a list of jobs to wait for
      and pay a checkout, a Deno setup, an install and a download to read a
      file. The records are not shipped by one job: each lane ships its own
      artifact, because the calibration fit reads one lane's measurements of
      itself per report. `Status` downloads them all, so it is the one job that
      reads the whole run. The `one-post-test-job` tripwire is deleted.
- [x] The full run's treatment of a test too flaky for pull requests.
      The count is placed already: `tasks/test-selection/plan.ts` gives
      every mandatory identity the count `executionsFor` returns for its
      share, and gives up runs until what is left fits rather than
      putting a lane past its bound. What is left is that it returns a
      `nonGating` list beside `withheld` naming the identities whose
      failures do not fail the run. A repository gate is one of those
      identities like any other: a gate introspects the tree where a test
      runs the code, which says nothing about what its failures are worth
      to a change.
      `tasks/ci-lane.ts` reads each batch's gathered records, exits
      non-zero only where a failing identity is outside `nonGating`, and
      names every non-gating failure in the job summary. Three rules
      decide a lane. An excusal takes the specification's: an invocation
      is excused only when it accounted for every identity it was asked
      to run, and an execution that ended badly having recorded no
      failure accounted for nothing, whatever the batch's other
      executions recorded. A unit that recorded nothing recorded nothing
      under any name, and that fails the lane whether or not anything was
      there to excuse. And an identity no record accounts for costs the
      batch its excusal rather than costing the run, since failing
      outright would fail the run for every rename: a manifest is hours
      old by construction and a test renamed since records under its new
      name.
      The manifest gains no field and `executionsFor` needs no change: its
      line already runs past the exclusion rate. `fullLaneCount`'s work
      sum counts the extra runs, so the count its search starts from is
      close to the answer rather than far below it, and the search walks
      down as well as up so that where it starts cannot decide how many
      lanes the run gets.
- [x] `pendingMain` joins the windows `trimWindows` ages. A `main` failure
      waits there until a later run judges it, and an excluded test that
      stays broken no longer turns `main` red, so nothing bounds what
      accumulates.
- [x] A measured set whose lane held a non-gating failure is reported
      rather than having a baseline published from it, the same way the
      gate already reports a run with a failing test.
- [x] `explain <identity>` gains the runs it is given and whether it is
      withheld, replacing the three-way answer that no longer partitions.
- [x] Repository-wide coverage measurement moves to the full run and stops
      failing anything. The repository-wide ratchet, `tasks/coverage-check.ts`,
      is deleted, and with it the per-group gating, `NEW_COVERAGE_BASELINE`, the
      `perf-metrics` baselines, the run listing, and the parts of
      `tasks/ci-check-lib.ts` only it used.
- [x] Each suite writes its coverage profiles into a directory of its
      own, one level per suite and one per member below it, and the lane
      converts every one of them into a report named for the measured
      set. `tasks/write-coverage-lcov.ts` carries the conversion as a
      function `tasks/ci-lane.ts` calls as well as a command. No test
      changes how it runs.
- [x] Delete the hand-maintained sharding: `tasks/test-timing-weights.ts`, the
      per-suite file selectors, `tasks/shard-utils.ts`,
      `INTERNALLY_SHARDED_PACKAGES` and every shard and disabled-package
      variable the packages' own runners read, and `TEST_DISABLED_PACKAGES:
      runner` with the separate `Runner Tests` matrix.
      `tasks/weighted-shards.ts` goes too, since the packer in
      `tasks/test-selection/plan.ts` does its own packing. The shard wrapper
      survives as `tasks/run-test-batches.ts`, reduced to splitting a member's
      files by the flags they need, because `cli` and `dashboard` still have
      files that must run alone or with every permission. Nothing is balanced by
      a transcribed number, and `check-test-topology` is what proves the items
      are all still there.
- [x] `packages/ui` and `packages/iframe-sandbox` split their one-string test
      tasks the way `packages/static` writes the same split, so each keeps a
      measured set over its Deno-only half. This landed on `main` separately
      (#7371).
- [x] The publisher carries each measured set's figure and its commit in
      the manifest, read from the coverage measurements of the `main` runs it
      folds and carried forward from the previous manifest for the rest of
      the window. It reads them from the record store, so it needs no
      GitHub credential for them.
- [x] The publisher's summary names the exclusion-list entries that would now
      fit the run's budget, and the measured sets past
      `LOCAL_COVERAGE_MAX_SECONDS`, and so does `deno task test-selection
      coverage`. Both read the lanes' coverage-on fits, and until a lane has run
      a suite with coverage on they say they cannot tell yet and name the
      suites.
- [x] A measured batch's measurements carry `with coverage` on their names, and
      the calibration fits them apart from what the suite's batches cost without
      coverage, into `suitesWithCoverage` beside `suites`. `pricedForRun`
      charges each suite the fit for how the run runs it — the coverage-on fit
      for every suite of the full run, and for the gate's sets' suites on a pull
      request — falling back to the other fit, and a lane runs first the batches
      of a suite whose charge was not fitted the way it runs them.
- [ ] Before merging: `plan --verify` against the last `main` run, proving
      the manifest accounts for every item the topology enumerates under
      its exact variant, apart from explicitly unavailable skip entries.
      Compare from the store rather than by eye. The store half of the
      drift guard is proved against the `ci: full` run below instead,
      since it judges a tree by the records that tree produced.
- [ ] Before merging: at least one `ci: full` run on the branch, green,
      accounting for every item the topology enumerates under its exact
      variant apart from explicit unavailable entries. This is what
      running on `main` was going to prove, done where a mistake costs one
      branch.
- [ ] Before merging: `plan --dry-run` over the reference records, after
      classifying every identity and mapping every item-level identity to
      its runnable item. Record selected item count, measured test time,
      capability setup, repeats, and unschedulable items. All five lanes
      retain their 30-second safety margin.

### Part three — the pull-request path

- [x] `deno.yml`: five selected lanes of `tests` replace every pull-request
      job; `Status` depends on `plan-full` and `tests`, with `skipped` counting
      as success, and fails unless `tests` succeeded.
- [x] The `ci: full` label.
- [x] `coverage-comment.yml` generalized into the reporter, with the
      first-failure attribution, the selected-or-not line, the coverage
      note, the measured-set rise note naming which of the three routes
      let it through, the flaky-new-test note, and the rename suggestion with
      its ready-to-append alias line. It is
      `.github/workflows/pull-request-comments.yml`, which now holds both
      comments this repository posts from the trusted context, and
      `tasks/test-selection/report.ts` beside `tasks/post-main-report.ts`.
      Each of the five properties under [keeping this on the right side of
      the line](#keeping-this-on-the-right-side-of-the-line) carries a
      test. It follows the test workflow, because a `workflow_run` payload
      describes the run it names rather than the run that triggered it,
      and it compares the run at the commit against the run at the
      commit's parent: the parent's records and the pull request's come
      from the store, and the run under report's from its own artifacts,
      which are readable before the relay has shipped them. Whether the
      pull request ran a test is settled by its own run's records, and the
      manifest it resolved answers why it did not. That manifest is resolved at
      the committer date of the commit the run tested, which is the merge commit
      its records name and never the branch's tip, and where that date cannot be
      established the report gives no reason. The measured-set rise reads a
      set's figure out of the run's own coverage artifact, so it reads the
      quantity the gate compares rather than the source group over the same
      member that a selected run only samples. The full run publishes those
      figures.
- [x] The reporter's note for a test too flaky for pull requests that failed
      every one of its runs at this commit and passed every one at the parent.
      It needs the full run's extra runs to exist before it can say anything,
      and it says the test is a known flaky one and that this run did not fail
      because of it, with both run counts and the store's flake counts. Such a
      test is not also listed as a first failure. Which failures a run excused
      comes from the `ci-lane excused` records its lanes wrote. The manifest
      supplies only the counts: it is read only when the note is written, at
      the commit's date from the checkout, and the report never fails for lack
      of it.
- [x] The coverage gate, in two halves. `tasks/ci-lane.ts` makes every
      unit of a measured set the diff reaches mandatory, keeps those
      units out of later passes, runs each of them as many times as its
      own share asks for, turns coverage on for those members alone, and
      converts what it collected into one report per set.
      `tasks/coverage-gate.ts` reads the reports, adds them per set,
      walks the manifest for the nearest baseline the branch contains,
      checks for a rise, and reads `ACCEPT_COVERAGE_DEBT` from the pull
      request's description. It works out which sets the gate covers by
      running the same function the lanes run, cap included, rather than
      trusting a lane's report. A coverage failure names itself as one, a
      run with a failing test reports rather than gates every set a
      lane's report measured, a forced set no lane's report measured
      fails, and a change over the cap forces no set, with a line saying
      so, and still scores any set some run measured anyway.
- [x] The gate's workflow half, which only the lanes can carry. Each lane
      uploads what is under its coverage directory as an artifact, `Status`
      downloads every lane's into one directory, and `Status` runs `deno run -A
      tasks/coverage-gate.ts --base origin/<base branch> --reports <that
      directory> --body <the pull request's description> --comment
      coverage-comment.json --pr <number>`, passing `--tests-failed` unless
      `tests` succeeded. The gate diffs `<base>...HEAD`, so git
      works out the merge base. It reads the description through the API, since
      a re-run repeats the event it was started by and an acceptance written
      after the push is what a re-run is for. Nothing else has to change: which
      sets are gated, what each is scored over, and what the baseline is are all
      decided inside that command. Its checkout has to hold the commits the
      baselines name, because it asks git whether the branch contains one; a
      checkout too shallow to answer reports every set as having no baseline,
      which turns the gate off without failing anything.
- [x] The full run's half of the same, which only the lanes can carry. Each
      lane of the full run uploads its coverage the same way, and the step that
      writes the run's coverage measurements merges every report for the
      repository-wide figure and reads each set's report for that set's figure.
      Both come out of the same reports.
- [x] The coverage report is steps of `Status` rather than a job of its own. On
      a push, `tasks/coverage-report.ts --reports lane-coverage` writes its
      measurements into the spool `CF_TEST_RECORDS_DIR` names, and
      `test-records-ship` ships them with `artifact: coverage`. No
      `perf-metrics` artifact is uploaded, since deleting
      `tasks/coverage-check.ts` removed its last reader, and the run-listing and
      artifact code in `tasks/ci-check-lib.ts` that only it used goes with it.
- [x] `tasks/ci-workflow.test.ts` updated for the `tests` job and `Status`,
      including that the shared lane ship step carries no job-wide variant.
- [x] Documentation, in the same pull request rather than after it:
      `docs/specs/test-selection.md` for the contract,
      `docs/development/test-selection.md` for the operating guide, the
      trust-boundary amendment and new dataset area in
      `docs/specs/test-records.md`, `docs/development/COVERAGE.md`
      rewritten around a trend for the repository-wide number and around
      the measured sets that keep their teeth,
      `docs/development/CI_PERFORMANCE.md` around lanes rather than shard
      balance, and `.claude/rules/github-workflows.md` and
      `.claude/rules/tests.md` where "add a job" becomes "add a suite".
      `.claude/rules/workspace-packages.md` gains the `deno-test`
      convention: a package that mixes Deno-only tests with tests needing
      a browser names the Deno-only half `deno-test`, and that half is
      what its measured set holds.
- [x] The workflow half fails every recording step, whether or not a suite
      claims it, and says which of the two it is, because the lanes run every
      test and gate the topology declares. That form also catches a gate a
      leftover step runs a second time. No workflow records by hand, so the
      half passes, and it fails the first change that adds such a step.
- [ ] This plan archived.

### What would force a split, and what to split first

Nothing mechanical does. The infra credential is already in place, the
topology can be proven on the branch with `ci: full`, and the window
before the first manifest is one `main` run that the lane fallback
already covers.

What could force one is review. This is a large change to the way the
repository tests itself, and a reviewer who cannot hold it at once is a
reason to split that is worth taking seriously — a change nobody has
really read is worse than a change that landed in two pieces.

If it comes to that, split part one off and leave parts two and three
together. Part one changes no behavior at all: it teaches the store to
answer questions it cannot answer yet and puts the answers on the
dashboard. It is separately useful even if the rest never lands, since it
gives the repository a flake list derived from evidence and a coverage
trend it does not have today. And it is the part with no dependency on
anything else, so landing it first costs nothing and removes a third of
the diff from the change that carries the risk.

Splitting parts two and three is the split to avoid. They share the
topology, the lane runner, and the manifest, and separating them means
writing the full run's job matrix twice: once against the old
pull-request layout and again when the lanes replace it.
