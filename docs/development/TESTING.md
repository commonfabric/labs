## Testing

### Running Tests

**From workspace root** (recommended):

```bash
# Run all tests (includes unit and integration)
deno task test

# Run tests for specific package
cd packages/runner
deno task test
```

**Important:** Always use `deno task test` from the root, NOT `deno test`, as the task includes necessary flags.

A package's `test` task is no substitute for a type check: some packages' tests
skip checking outright, and the rest check only the modules their tests reach.
`deno task check` at the root checks the whole workspace at once, so run both:

```bash
deno task check
deno task test
```

A package with a `check` task of its own runs the same check over its own
files, which is useful while working inside one package and is not a
substitute: the root check is the one continuous integration runs, and it
covers trees no package's own check reaches.

### Running one test by name

Use `--filter` on a package's `test` task, not on the root one. The root task
runs `tasks/test.ts`, which reads no arguments. A flag passed to it is ignored,
and the whole workspace suite runs.

```bash
cd packages/runner
deno task test --filter "test name"
```

The flag is passed to the `deno test` that the package's own task invokes, so
the preload, the permissions, and the file globs that package's tests need are
all still applied. The same holds for the packages that run their tests through
a script, `packages/cli` and `packages/piece` among them. Each of those scripts
passes on the arguments it receives.

`deno task` appends the extra arguments to the end of the task's command line.
A package's `test` task runs `tasks/run-member-tests.ts`, which is handed the
names of the package's tasks that make up its tests — its `deno-test`, and any
others such as a browser half — and the order to run them in. That script gives
the appended arguments to `deno-test` and to nothing else, so a filter reaches
the tests:

```bash
deno task test --filter "test name"
```

The package's `test` task in its `deno.jsonc` names what it runs, and
`deno task <name>` runs any one of them on its own. `deno task test` also
prints each command line as it runs it, which shows where the flag was
appended.

A package can run a test runner of its own, as `packages/identity` does, and
appended arguments reach whatever that runner does with them, which its own
source says.

A test's name is also its identity in the run-record store, so a renamed test
must be listed in `tasks/test-identity-aliases/` to keep its recorded
history joined to its new name.

### Every test has to pass on its own

A continuous-integration lane selects individual tests, not whole files. A lane
given one `it()` out of a file registers every other test in the file as
ignored, and the file's `beforeAll` and `afterAll` hooks all still run —
including those of a `describe()` whose every test was ignored, which pays for
that suite's setup and runs none of its tests. Only `beforeEach` and
`afterEach` narrow, to the surviving test. So what a test needs comes from a
hook or from the test itself, and never from a test above it. A page another
test navigated to a view, a cell another test set to a value, and a piece
another test created are all things a test has to arrange for itself.
[Test selection](test-selection.md) describes the machinery that picks them.

Such a test fails by waiting. The waits an integration test uses resolve on an
event, and the event never comes, so the wait runs to its stuck-condition
safety net and the test costs five minutes. Selection then charges the test
what it cost, and five minutes is more than a lane can hold. A lane may fill
to `LANE_BUDGET_SECONDS`, and a lane running one test and nothing else may go
up to `LANE_BOUND_SECONDS`, which is 300 — so a test charged more than that
fits nowhere at all, and one charged between the two runs only while a change
makes it mandatory. [Test selection](test-selection.md) has the packing rules;
`tasks/test-selection/policy.ts` has the numbers.

A page and a value are not equally easy to find missing. A page a test never
navigated announces itself: the wait's diagnostics say `document URL:
about:blank` and `globalThis.app: absent`, in the cause of whatever message the
helper wrapping the wait reports. A value a test never wrote does not.
The page is there, every diagnostic reads healthy, and the test waits out the
same five minutes against the initial value. So give each test the value it
asserts as well as the page it drives, or, where one test's expectation is
another test's effect, make the two one test.

Writing that value is what leaves the test waiting on a condition its own
starting state satisfies, where the value is the one a neighbor wrote first.
["A wait the initial state already satisfies establishes
nothing"](waiting-in-tests.md#a-wait-the-initial-state-already-satisfies-establishes-nothing)
covers that, including how to tell it from a test whose subject is the initial
state. The part of it to carry away here: give such a test a value no other
test in the file writes.

Making a test stand alone has a third consequence in a browser test. What the
page shows is now the effect of a write the page did not make, and an
integration test holds no subscription that drives the page between a wait's
checks, so a passive wait can sit on an unchanged DOM while the effect is
ready to apply. Reach for a wait that settles
the view on each check — `waitForSettledText` rather than `waitForText`, and a
`waitForCondition` predicate that settles before it reads.
[Waiting in tests](waiting-in-tests.md) covers the primitives.

Of the two places a test's page can come from, give it to the test rather than
to `beforeAll`. `ShellIntegration.bindLifecycle()` collects the browser's
console errors and uncaught page exceptions, clears them in `beforeEach` and
fails the test on them in `afterEach`, and `beforeAll` runs before the first
`beforeEach`. So a navigation in `beforeAll` has everything the shell's
bootstrap, login and first render reported thrown away before anything looks at
it, while a navigation inside the test is covered. A helper each test calls
keeps that check. It is one line per test to read and a whole `goto` to run —
page load, state wait, and a login that rebuilds the worker runtime — so a
suite of four tests pays for four of them, which is a cost a section about
what selection charges should not leave out.

Reproducing one of these locally takes the skip list rather than `--filter`.
`--filter` matches the name of a `Deno.test`, which for a file using
`describe()` and `it()` is a top-level `describe()`, so the least it can select
is a whole suite. `CF_TEST_SKIP_LIST` names a JSON file mapping a
repository-relative test file to the test names inside it to ignore, each
written as its full describe chain:

```json
{
  "packages/patterns/integration/cf-render.test.ts": [
    "cf-render integration test > should load the nested counter piece and verify initial state"
  ]
}
```

Reading that file is the registration preload's job, and `tasks/integration.ts`
hands `deno test` that preload only for a run that writes a JUnit report. So
the run needs `--junit-dir` as well. The name after the package selects test
files rather than tests:

```bash
HEADLESS=1 CF_TEST_SKIP_LIST=/tmp/skip.json \
  deno task integration --junit-dir=/tmp/junit patterns cf-render
```

Check the output says `ignored (0ms)` beside each test the list names. Where
nothing reads the list every test runs, and a file that still depends on a
sibling passes.

[Focused browser regressions](#focused-browser-regressions) states the same
requirement one level up, for a file sharing a browser with the files beside
it.

### Every test run shuffles its order

Every test run reorders the tests it runs, always, with no flag to remember.
A test that quietly needs another test to have run before it passes for as
long as nothing disturbs the order, and a runner left to itself walks its
tests in the order they were declared, so such a dependence is otherwise found
only when somebody moves or removes a test. Shuffling finds it on a schedule
instead.

This is a different failure from the one test selection finds. Selection
leaves a test out, which breaks a test that needed it to run. Shuffling runs
everything and changes the order, which breaks a test whose failure comes from
another test having run before it, and also catches a test that needs a
particular predecessor rather than merely some earlier state.

The seed is the date on which the commit under test was committed, taken in
the Pacific time zone and written `YYYYMMDD`. It is read from git as the
committer date, not the author date, so a rebased commit takes the day it was
rebased. Each runner prints it:

```text
Test order shuffled with seed 20260922. Set CF_TEST_SHUFFLE_SEED=20260922 to run this order again.
```

So one commit runs in one order wherever and whenever it runs. Every job of a
continuous-integration run agrees, a re-run of that job days later agrees, and
a checkout of the commit on a workstation agrees. The order moves on as commits
are made, to a new one each Pacific day. Uncommitted edits run in the order of
the commit they sit on. Outside a git checkout the seed is today's date.

Setting `CF_TEST_SHUFFLE_SEED` to any non-negative integer runs that order
instead, which is how a different order is tried against the same commit.

It matters that a commit never runs in two orders. This repository decides a
test is flaky by seeing it pass and fail at the same commit, and withholds a
test that flakes often enough from pull requests. An order-dependent test run
in two orders at one commit has exactly that signature, so the tests this is
meant to surface would be withheld instead of fixed. With one order per commit,
an order-dependent test fails every time its commit is run, until somebody
fixes it. The test records carry the seed each run used, and
[test selection](test-selection.md) compares outcomes only between runs that
agree on it, so a run under an override is not read as a flake either.

#### Tomorrow's seed, run a day ahead

The order changes with the first commit of each Pacific day, so a test that
the new order breaks starts failing on that commit, whatever the commit
changed. The Tomorrow's Test Order workflow,
`.github/workflows/test-order-tomorrow.yml`, runs the next day's seed a day
ahead, so that such a test can be found and fixed before the day it would
break.

The workflow runs at 11:00 UTC every day. That is 04:00 in the Pacific zone in
summer and 03:00 in winter, early on a Pacific day either way. It asks
`deno task -q test-seed --tomorrow` for the seed of the next Pacific day, and
calls the CI workflow at the head of `main` with that seed, which runs every CI
test suite under it. When a test fails, the run fails. The run's checks on the
commit are listed under "Tomorrow's order", apart from the checks of the
commit's own run. The CI workflow skips its coverage and topology gates, and
its attestation and deploy jobs, when another workflow calls it. The records
relay follows the workflow, and its records carry the seed they ran under, so
[test selection](test-selection.md) keeps them apart from the commit's own
runs.

The order a run takes depends on the set of test files as well as the seed:
`deno test --shuffle` and the runners this repository owns permute the whole
list, so adding or removing one test file can move every other file.
The next day's commits therefore run the next day's seed over a set of files
that commits made in between may have changed. What the run gives is one more
order, on a day's notice, that no commit has taken yet.

To run a failing order again locally, set `CF_TEST_SHUFFLE_SEED` to the seed
the run printed.

#### What gets reordered

`deno test --shuffle=<seed>` reorders the files of a run, and within each file
the top-level registrations — a `Deno.test()` call, or a top-level
`describe()`. It does not reorder the steps inside a registration, and an
`it()` inside a `describe()` is a step.

What each of those can catch follows from how Deno runs a file. Each test file
gets a realm of its own, with its own module instances, globals and built-in
objects, so nothing held in JavaScript passes from one file to the next. File
order therefore matters only for state the process holds: environment
variables, the filesystem, the working directory, native libraries loaded
through FFI, and network ports. Order among a file's top-level registrations
reaches everything in that file's realm — module-level state, a singleton, a
global a test replaced and did not put back — which is where the shuffle has
found most of what it has found.

A file written the way [unit-test-coding-style.md](unit-test-coding-style.md)
asks, with a single top-level `describe()` holding everything, is one
registration, so its cases keep their order. A dependence between two `it()`
calls in one `describe()` is still the author's to avoid, and [Every test has to
pass on its own](#every-test-has-to-pass-on-its-own) above is the rule that
covers it.

The runners this repository owns reach further, because their order is ours to
choose:

- `deno-web-test` shuffles both the files of a run and the tests inside each
  file, since it drives the browser harness one test at a time and picks which.
- `cf test` shuffles the `.test.tsx` files of a run and leaves the steps inside
  one alone. A pattern test states its expectations as a sequence, each one
  about the state the step before it left, so their order is the test rather
  than an accident of it.
- The CLI's shell harnesses under `packages/cli/integration/` run in a fixed
  order for that same reason: each is one scenario driven end to end.

#### Writing a task that runs tests

A `deno test` written anywhere in this repository takes the seed from the root
`test-seed` task. In a package, that is its `deno-test` task, which its `test`
task runs through `tasks/run-member-tests.ts`:

```json
"deno-test": "deno test --shuffle=$(deno task -q test-seed) --allow-read test/"
```

`deno task -q test-seed` resolves to the root task from any directory inside
the checkout, prints the seed on standard output and the line naming it on
standard error. `deno task check-test-shuffle` fails when a command that
starts a test runner does not carry a seed, and lists the runners this
repository owns along with the ones whose order is the test.
`packages/test-support/src/shuffle.ts` holds the seed and the permutation.

### Browser tests in agent sandboxes

Headless Chrome registers with AppKit and needs Launch Services and
WindowServer, which the macOS agent sandbox can deny, aborting Chrome during
startup. That abort is an artifact of the sandbox rather than a test result,
and the same sandbox reproduces it. So a browser command runs outside the
sandbox: when the harness reports the session as already unsandboxed, run the
command; when it reports otherwise, request unsandboxed execution instead of
trying it there first. Read that from the harness's own report of the session,
not from an escalation option being available — a harness may offer one to a
session that has no sandbox to escape.

The following repository commands and test paths launch a browser:

- The root `deno task test` command, which reaches browser-backed workspace
  package tests.
- The unfiltered root `deno task integration` command. With no target, it
  includes browser tests from `shell` and `patterns`. Unfiltered target runs
  for `shell`, `patterns`, and `patterns-reload` also include browser tests.
- A filtered integration run when the selected test launches a browser. A
  package name associated with browser tests does not by itself establish that
  a filtered test launches one.
- The `deno task demo` command.
- Tests that run `deno-web-test`, call `Browser.launch()`, or bind a
  `ShellIntegration` lifecycle.

An `@astral/astral` import alone is not proof that a test launches Chrome. It
can be a type-only import or support a fake browser. When it is not clear
whether a focused test starts a browser, inspect its suite setup and launch
call path before running it.

Deno's `-A` flag changes Deno's permission checks but does not escape the outer
agent sandbox. Chrome's `--no-sandbox` flag disables a different protection;
do not add it as a workaround.

If a browser command did run inside the agent sandbox, disregard its
browser-startup failure and rerun it outside the sandbox before interpreting
the test result.

### Browser process cleanup

The integration browser launcher uses the installed Chrome selected by
`packages/integration/astral-adapter.ts`; `ASTRAL_BIN_PATH` overrides that
selection. Chrome launches include `--disable-updater-scheduler` so an
ephemeral test profile cannot start maintenance of the installed browser.
Detached updater crash handlers can inherit Chrome's stderr and keep it open
after the browser exits. Chrome's own crash reporting remains enabled.

Each browser launches in its own Unix process group. `BrowserProcess.close()`
sends `SIGKILL` to that group, including renderers that outlive the root, and
waits for root exit and both output streams to reach EOF before profile removal.
Test callers dispose their page runtimes and collect coverage before closing the
browser. Process termination does not wait for the browser's event loop to
handle a signal. An output reader failure is propagated after the browser
process has been reaped. A browser's exit and its output reaching EOF are
separate events: inherited descriptors can outlive the process that opened
them. Detached crash handlers can outlive the group and remain covered by the
EOF wait. When investigating a teardown stall, capture every holder of the
pipe, including renderers and detached updater processes, and record assertion
completion separately from suite and process completion.

Browser tests require macOS or Linux. The launcher rejects other platforms
before it starts a browser.

### Focused browser regressions

A package can reserve a `*.browser.test.ts` file for DOM behavior that needs a
real browser but not a running shell, toolshed, or piece. The name is the whole
of the wiring. Every package that splits its tests this way matches
`*.browser.test.ts` twice: once as an `--ignore` pattern that keeps the file out
of plain `deno test` discovery, and once as the argument list handed to
`deno-web-test`. Adding a browser test means naming the file and nothing
further.

The two matches sit on two task lines, `deno-test` and `browser-test`, which
the package's `test` task runs in turn. What matters is that both are the same
glob, so neither can fall behind the other. The test topology reads the second
one to find the files the browser half runs. The package-level task remains the
one command authors and the root workspace runner invoke, and it owns every
step.

The glob hands its files to `deno-web-test` in the order the shell expands
them, which is alphabetical rather than the order anyone chose. Tests in one
file share a browser with the tests in the others, so a file that only passes
after some particular sibling has run is relying on something no longer written
down anywhere. Each file has to stand on its own.

A package whose tests all need a browser, `packages/identity` among them, hands
its whole test directory to `deno-web-test` and has no such split to get wrong.

Name a test that way whenever it needs a browser, including when its subject is
not a component.
`packages/ui/src/v2/components/cf-svg/sanitize-svg.browser.test.ts` needs a
browser for `DOMParser` and for nothing else. Under any other name the glob
does not reach it and the plain `deno test` pass collects it instead.

Do not guard the body with `typeof document === "undefined"`. A file the glob
routes always has a document. The guard turns a file that reached the wrong
runner into a reported pass over zero assertions, which is how such a file goes
unnoticed.

Use this route for a narrow browser boundary such as event propagation or
layout API behavior. Use the browser integration lane when the test needs the
running product, multiple identities, durable state, or worker behavior. Pair
a focused browser regression with a plain Deno unit test for any extracted
policy or state machine, because code executed inside Chrome does not enter
Deno's V8 coverage profile.

### Browser row reconnect acceptance

The row browser test can place real reader storage outages around remote color,
profile, and removal writes. Its normal CI run covers connected readers. The
reconnect mode requires a local relay and a shell compiled against that relay;
the independent writer continues to use the toolshed directly.

Start the local servers with offset 89, following
[the local server procedure](LOCAL_DEV_SERVERS.md):

```bash
EXPERIMENTAL_SERVER_EXECUTION=false ./scripts/start-local-dev.sh --port-offset 89
```

This starts toolshed on port 8089 and the ordinary shell on port 5262. The test
uses the separate relay-connected shell on port 5263 started below. Run this
relay in another terminal from the repository root:

```bash
deno run -A packages/patterns/integration/storage-network-gate-server.ts http://127.0.0.1:8089 58848 58849
```

The relay accepts a loopback API URL, a relay port, and a control port. It binds
both listeners to loopback. Dedicate the relay to this run; its socket count
includes every connected reader. Use free ports and substitute them consistently.
Start a separate shell against the relay in another terminal:

```bash
TOOLSHED_PORT=58848 SHELL_PORT=5263 EXPERIMENTAL_SERVER_EXECUTION=false deno task --cwd packages/shell dev-local
```

After the shell reports that it is listening, run the browser test:

```bash
API_URL=http://127.0.0.1:8089 FRONTEND_URL=http://127.0.0.1:5263/ EXPERIMENTAL_SERVER_EXECUTION=false CF_ROW_RECONNECT_CONTROL_URL=http://127.0.0.1:58849/ CF_ROW_REPRO_ARTIFACT_DIR=/tmp/row-reconnect deno test -A packages/patterns/integration/reactive-vote-rows-browser.test.ts
```

Each outage asserts that the relay closed live socket endpoints before the
writer changes data. Requests remain held until the test resumes the relay.
The four cases cover nested and mapped rows with same-space and cross-space
profiles, and assert rendered content after reconnect and after later updates.
Captures include a `reconnect` field in their metadata. These are synthetic
spaces; testing a live poll requires separate coordination. Stop the relay and
the extra shell after testing.

### Running a test under a server-execution posture

`serverExecution`'s first-party default is the constant
`SERVER_EXECUTION_DEFAULT_ENABLED`; the summary table in
[EXPERIMENTAL_OPTIONS.md](EXPERIMENTAL_OPTIONS.md#serverexecution) states its
current value. CI keeps stable `default` and
`opposite` roles; `tasks/server-execution-ci.ts` derives their actual ON/OFF
posture from the first-party default constant. The opposite toolshed binary is
built with an explicit inverse so its browser shell, server, and test processes
stay aligned. [EXPERIMENTAL_OPTIONS.md](EXPERIMENTAL_OPTIONS.md#serverexecution)
covers the flag itself.

Running an explicit posture locally means putting the flag on every process the
test spans, not only the one `deno test` starts. A pattern integration test
drives a runtime in the test process and commits through a toolshed, and the
per-class commit admission rows are enforced by the memory server under the
flag, so a test process on the ON arm talking to a toolshed on the OFF arm is
on neither arm. Start the servers with it too:

```bash
EXPERIMENTAL_SERVER_EXECUTION=true ./scripts/start-local-dev.sh
cd packages/patterns
EXPERIMENTAL_SERVER_EXECUTION=true API_URL=http://localhost:8000/ \
  deno test --no-check -A ./integration/<name>.test.ts
```

Then ask the server what posture it is in, rather than trusting the command
that set it:

```bash
curl -fsS http://localhost:8000/api/health/stats | jq -e '.servingLoop != null'
```

`servingLoop` is null on the OFF arm and an object on the ON arm, and this is
the check CI's own posture-probe step makes against the server; the paragraph
below covers the shell half, which that step asserts separately.

The toolshed log records the same thing, but it accumulates NUL bytes, so
`grep` can decide it is binary and print nothing rather than the line that is
there; pass `grep -a` if you read it.

`start-local-dev.sh` and `restart-local-dev.sh` inherit their caller's
environment. Supply the flags on every start or restart, or export them in the
calling shell; a variable supplied to an earlier command does not persist for
the next one.

A posture mismatch does not announce itself. It fails the test, which reads as
the behavior under test being broken, so a run against a default-posture
toolshed can report a test as failing at every commit while CI has that test
green. That is enough to send a bisect to the wrong answer, which is the cost
worth avoiding here.

The shell receives these flags through build-time defines in `felt.config.ts`.
Felt's development server builds with those defines before serving the shell,
so flags supplied to `deno task integration` reach the server, test processes,
and browser workers. The runtime-client integration helper also forwards the
environment-selected flags into its workers. `/api/meta`'s
`shellServerExecutionDefine` describes a packaged shell build and can be null
with local dev servers; it does not report the defines in the dev bundle.

The `generated-patterns` and `pattern-tests` targets use in-process, emulated
stores without a serving host. The integration runner explicitly disables
`serverExecution` for these two harnesses while preserving the other inherited
flags. Server-backed targets receive the supplied server-execution setting.

For view-scoped replication, run the complete default integration suite with:

```bash
EXPERIMENTAL_SERVER_EXECUTION=true \
EXPERIMENTAL_VIEW_SCOPED_REPLICATION=true deno task integration
```

The browser regression `shell/integration/view-scoped-replication.test.ts`
checks the server's published posture and the shell's actual worker
initialization. Run it through `deno task integration shell view-scoped` to
test a flag combination, including `EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION=false`
overriding a true global default, or a true web override with the global default
false. Restart the servers through the integration runner for each combination
so the browser bundle is rebuilt with that environment.

### The ON topology in one process

A runtime on the ON arm commits the event a handler is fired with and nothing
else; the handler runs on a serving loop beside the memory server. A test that
hosts its own memory server and runs a client ON therefore needs that loop
too. Without it the server admits the event and nothing ever delivers it, so
a wait on the consequence never resolves and the test hangs rather than
failing.

`@commonfabric/runner/executor/serving-memory-server.deno` supplies the pair:
a memory server over a fresh non-persistent store, with an `ExecutorHost`
attached whose serving runtimes are built by the same factory toolshed uses.
It comes in two shapes, by how the test's clients reach it:

- `startServingMemoryServer({ apiUrl })` is reached in-process. Clients connect
  with `EmulatedStorageManager.connectTo(serving.server, ...)`, and session
  opens are authorized by the principal they name, as with
  `newLoopbackServer()`.
- `listenServingMemoryServer()` also listens on a localhost websocket at
  `serving.url`, for a runtime built with the `remoteClient` preset — in the
  test's realm, in a Deno Worker, or in a subprocess. It wraps
  `StandaloneMemoryServer`, verifies signed session opens as toolshed does, and
  takes the same `serve` option for the plain HTTP requests that address
  receives. Its serving runtimes compile against `serving.url` unless given an
  `apiUrl`.

Both return a handle that `await using` closes, serving loop first. The host
keeps the process's ambient server-execution flag on while it lives, so a
runtime in the same realm that asks for the OFF arm runs ON beside it. The
serving loop's own options pass through: `policy`, the `on*` diagnostic hooks,
and `ensureSpaceRoots`, which defaults to `false` here, the switch the serving
loop keeps for tests. `prepareStorageManager` hands the test each serving
runtime's storage manager before the runtime is built, which is where a stub on
one of its providers goes.

```ts
// Shown at module scope.
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { startServingMemoryServer } from "@commonfabric/runner/executor/serving-memory-server.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

const alice = await Identity.fromPassphrase("alice");
await using serving = await startServingMemoryServer({
  apiUrl: new URL(import.meta.url),
});
const storageManager = EmulatedStorageManager.connectTo(serving.server, {
  as: alice,
});
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
  experimental: { serverExecution: true },
});
```

`serving.idle()` covers the memory server and not the loop: it says the server
has applied what it received, while a served consequence may still be in a
wave. Wait for the consequence itself, the way any other test waits for a
value.

A test that should follow whichever posture a run resolves, rather than fixing
one, resolves it as a deployed entry point does — the explicit
`EXPERIMENTAL_SERVER_EXECUTION`, else `SERVER_EXECUTION_DEFAULT_ENABLED` — and
starts a serving server for ON and a plain one for OFF. The pattern
`MultiRuntimeHarness` and `packages/cli/test/agent-connections.serial.test.ts`
do this, so each runs on whichever arm the CI role selects.

### Tests that start Deno

For deliberate import-map and lockfile changes, follow the
[dependency maintenance guide](DEPENDENCIES.md). This section covers the
separate requirement that verification tests preserve the checked-in graph.

Dependency installation and verification are separate parts of CI. Installation
may fetch registry metadata and package contents. Verification must use the
dependency graph recorded in `deno.lock` without resolving package versions
again.

Use `@commonfabric/test-support/isolated-deno` when a test starts another Deno
process. Its check helper copies the lockfile and runs `deno check` with frozen
dependency resolution. A generated config may change compiler options, but it
must preserve the root config's imports and workspace members. Package imports
already come from each workspace member's config and must not be copied into
the generated root config.

This boundary keeps a verification test independent of mutable registry
metadata. It also makes an accidental dependency graph change fail as an
out-of-date lockfile instead of silently resolving a different graph.

Both helpers start the Deno that is running the test, found through
`Deno.execPath()`. Starting the program named `deno` instead would find whatever
copy comes first on `PATH`, which is a different version than the pin in
`mise.toml` on any machine whose shell Deno is not that pin. The versions share
one cache directory and each reads transpiled sources only from its own part of
it, so a test that collects a coverage profile under one version and reports it
under the other gets a report with every file missing.

Deno resolves an allowlist entry of `deno` through `PATH` as well, so
`--allow-run=deno` refuses the very binary the test is running under. Name that
binary instead of widening the grant. A task line can compute it, because `deno`
inside one runs the Deno running the task whatever `PATH` says. The quotes keep
a path holding a space one argument:

```
--allow-run="$(deno eval "console.log(Deno.execPath())")"
```

A test launched from a script can read `Deno.execPath()` directly, as
`tasks/run-member-tests.test.ts` does with `--allow-run=${deno}`.

That a task's `deno` is the running one rather than one found on `PATH` is what
makes the computed form name the right binary, so
`packages/test-support/src/isolated-deno.test.ts` holds it in place: it runs a
task with a decoy `deno` as the only entry on the child's `PATH` and fails if the
decoy is the one that runs.

The child also inherits the environment of the run that started it, which in CI
carries the recording variables, `CF_TEST_SKIP_LIST` among them. A test that
starts a child naming its own tests names those variables too, and
[test-records.md](test-records.md#covering-a-new-test-surface) says which and
what to set them to.

The inherited environment includes `DENO_COVERAGE_DIR`, so under coverage a
child Deno writes coverage profiles of its own as it exits. A signal that
reaches a child while it is exiting either loses its profiles or leaves one
truncated, and one truncated profile makes `deno coverage` refuse every profile
in the job, which then reports no coverage at all. So a test whose child is
done, or is waiting only on input the test controls, ends it by closing that
input and then awaits its `status` rather than sending it a signal. A test
whose subject is a child killed while it runs is not in that position: the
kill loses that child's coverage, but it cannot truncate a profile. `packages/memory/test/inbox-store.test.ts`
ends its writer processes by closing their input, and
`packages/memory/test/inbox-store-child-coverage.test.ts` fails when any of them
loses its profile.

### Test Structure

- **Unit tests**: Use `@std/testing/bdd` (`describe`/`it`) with `@std/expect` for assertions
- **Integration tests**: Executable scripts that test end-to-end workflows against a running API
- **Test files**: Named `*.test.ts`

**Unit test example:**

```typescript
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { isDeepFrozen } from "@commonfabric/data-model";

describe("deep-freeze", () => {
  describe("isDeepFrozen()", () => {
    it("returns `false` for a plain unfrozen object", () => {
      expect(isDeepFrozen({ a: 1 })).toBe(false);
    });
  });
});
```

Note the shape: one top-level `describe()` named after the file under test, a
nested `describe()` per function, and an `it()` reading as a verb phrase that
completes the word "it".
[Unit test coding style](unit-test-coding-style.md) covers that shape in full:
where a test file goes, what it is called, how class and function tests nest,
which assertions to reach for, the matcher traps that produce a green test
proving nothing, and what rewording a description costs in recorded history.

**Integration test example:**

Integration tests are executable scripts that connect to a real backend and test full workflows. They are located in `packages/runner/integration/` and follow this pattern:

```typescript
// Shown for illustration only.
#!/usr/bin/env -S deno run -A

import { Runtime } from "@commonfabric/runner";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { env } from "@commonfabric/integration";
const { API_URL } = env;

console.log("=== TEST: My Integration Test ===");

async function test() {
  const identity = await Identity.fromPassphrase("test operator");

  const runtime = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  // Test your workflow here
  // ...

  await runtime.dispose();

  // Return results or throw on failure
}

await test();
console.log("Done");
Deno.exit(0);
```

**Key characteristics of integration tests:**
- Start with shebang: `#!/usr/bin/env -S deno run -A`
- Connect to real API using `env.API_URL` from `@commonfabric/integration`
- Test complete workflows (runtime, storage, pieces)
- Use `console.log` for output and `Deno.exit(1)` for failures
- Run as part of CI against deployed backend

**Adding integration tests:**

When adding runtime features, consider adding integration tests to `packages/runner/integration/` that verify the feature works end-to-end. See existing tests like `basic-persistence.test.ts` or `array_push.test.ts` for examples.

### Diagnostics a test must not fail on

Some of the runtime's warnings report wall time rather than behavior: the
slow-traversal report in `packages/runner/src/traverse.ts`, above 100ms, and
the slow-`Cell.get` report in `packages/runner/src/cell.ts`, above 50ms. A busy
machine crosses those thresholds and an idle one does not, so a test that
counted such a warning would pass or fail on how loaded the machine was.

`packages/cli/lib/perf-diagnostic-logs.ts` holds the one list of them, by
logger name and key prefix, and both places that hold a run's warnings to
account read it: the pattern test runner, which fails a test on a logger
warning the pattern did not allow, and the stderr budget the CLI tests assert
in `packages/cli/test/utils.ts`. A new timing-triggered warning belongs on that
list. A warning about behavior does not, and must keep failing tests.

The budget drops records rather than lines. A logger hands the console the
values it is reporting, and a console inspects one too wide for a line across
several, so a dropped warning whose line ends by opening a bracket takes the
indented lines beneath it and the bracket closing them. One a console fitted on
a single line takes nothing, and whatever follows it is held to the budget as
usual.

Writing such a diagnostic so that its own coverage does not move with the clock
is a separate obligation, and
[`COVERAGE.md`](COVERAGE.md#diagnostics-that-fire-on-wall-clock-time) carries
it.

### A test double over `editWithRetry` must not read as it observes

`Runtime.editWithRetry` is the seam a test replaces when it wants to watch or
delay one particular commit. It is also how much of what the runtime commits
on a transaction of its own reaches storage: the compile cache's write-back,
which the pattern manager keeps independent of whatever asked for the compile,
and a `#now` wish's interval tick, among others. A double installed to watch
one commit runs for those too.

What that costs depends on what the double does. Reading a document inside a
transaction joins that document's confidentiality label onto the transaction's
flow join, and the join lands on every document that transaction writes. With
`cfcFlowLabels: "persist"` the label is stamped on all of them durably, and
section 8.12.2's ratchet does not take it back. Add
`cfcEnforcementMode: "enforce-strict"` and the writer-fit check refuses the
commit wherever the written document declares no ceiling covering the label,
which the documents a compile-cache write-back writes do not. See
[the enforcement matrix](../specs/cfc-enforcement-matrix.md) section 4 for the
check.

Forcing that row on refuses the write-back of the debug-view deployment's own
compile. `PatternManager.#writeBackCompileCache` rethrows the refusal, so the deployment
promise rejects. A case waiting for a commit further along the deployment then
waits forever, and the reason string names documents the case never mentions.

So a double observes the transaction rather than reading through it. To ask
whether the wrapped action wrote a particular document, walk the transaction's
own write set with `getWriteDetails`, which adds nothing to the read set.
`debug-view-deployment-lifecycle.test.ts` asks that way.

### Recording browser integration tests as video demos

Selected `patterns` and `shell` browser integration tests can be recorded with
the same local servers, browser identities, UI events, waits, assertions, and
cleanup used by the normal integration suite:

```bash
deno task demo patterns cfc-render-policy-demo
deno task demo patterns cfc-render-policy-demo lunch-poll-vote
deno task demo patterns lunch-poll-vote --output=tmp/demos/lunch-poll.mp4
```

Each file filter must resolve to exactly one `*.test.ts` file. The command runs
each complete file sequentially because its `it` blocks may share suite setup
and browser state. Every invocation writes an `index.html` video gallery beside
the test-named MP4s and versioned diagnostic manifests beneath `tmp/demos/`.
The gallery uses relative links, so its complete directory can be copied or
served as-is.

With one filter, `--output=PATH` copies the final MP4 to a chosen file. With
multiple filters, `--output=DIRECTORY` copies the named MP4s and a portable
`index.html` gallery into that directory.

FFmpeg must be installed and available as `ffmpeg`, or its path must be set in
`FFMPEG`. Normal integration tests do not require FFmpeg. Useful options are
`--keep-frames`, `--viewport=WIDTHxHEIGHT`, and `--port-offset=N`.

Presentation mode modifies the existing browser interaction paths rather than
using demo-only clicks or typing. `<input>` fields type with a readable
character delay, clicks show an injected cursor, and labeled scenario steps
appear as captions. All presentation behavior is disabled during
`deno task integration`.

A `<textarea>` is the exception: the typing path resolves an `HTMLInputElement`
and declines anything else, so `fillCfTextarea` sets the field's value and a
recording shows the text arriving rather than being typed. A demo whose
composer is a `cf-textarea` reads that way on purpose, not by mistake.

Tests with multiple `ShellIntegration` instances retain their independent
browsers and identities. Each page is recorded against one shared timeline and
the streams are composed afterward: two participants are side by side, while
three or four use a 2-by-2 grid. Configure stable labels and colors through the
shell's `presentation` metadata.

If a test, browser capture, or FFmpeg encode fails, the command exits nonzero
and retains its manifest and available intermediate streams under the printed
run directory.

## Patterns that read data files

A pattern calling `dataFile()` reads a file attached to the program under test.
The call names the file, and that is the declaration every test path reads:
`resolveLocalProgram` attaches what the source asks for, so a pattern under
test behaves the way it does deployed without the test restating anything. The
path resolves against the module that reads it, so `./data/cities.json` is the
file beside the pattern under whichever root the test's own runner assembles
the program with — a test lane rooted at `packages/patterns` and a gate rooted
at the repository reach the same file. A file the source cannot name — one read
by a computed path — is added where the test builds the program: `cf test`
takes repeatable `--datafile` paths, a `generated-patterns` scenario names them
in `dataFiles` grounded by `dataRoot`, and a browser integration test passes
`dataFilePaths` to `resolveLocalProgram`.

A browser integration test needs nothing further: the data travels to the
browser inside the compiled pattern the space holds, so there is no file to
serve and no browser-side plumbing to arrange.

The attachment is easy to leave out and reports nothing when it is: the pattern
compiles and type-checks without it, and fails only when it reads, with
`No attached data file "<path>"` — naming the path the read resolved to, and
what is attached instead. That is why
`resolveLocalProgram` is the one operation for building a program from local
files, and why `deno task check-local-program` refuses a
`FileSystemProgramResolver` built anywhere else.

## Related documentation

- [test-records.md](test-records.md) — the record of every test execution:
  every suite here reports one record per test to a public store, and that
  document covers what gets recorded, opting a workstation in, reading the
  data, and the alias line that keeps a renamed test's history joined to its
  new name.
- [unit-test-coding-style.md](unit-test-coding-style.md) — how a unit test file
  is shaped: where it lives and what it is called, the single top-level
  `describe()` and the blocks nested under it, how an `it()` description is
  worded, `expect()` over `assert*()`, and the matcher traps that yield a green
  test which proves nothing. Read it before writing a new test file.
- [waiting-in-tests.md](waiting-in-tests.md) — waiting in tests: prefer
  primitives that resolve on a real event over polling with a timeout. Covers
  the event-driven primitives, the `check-no-waitfor` CI guard that keeps new
  polling `waitFor` out of the integration suites, and the deliberate exceptions
  where a bounded poll is the honest observation — read it before adding a poll.
- [waiting-in-tests-rationale.md](waiting-in-tests-rationale.md) — the analysis
  and case studies behind that guidance: the full argument against bounded
  timeouts, the sizing of the deno-web-test backstop, retired real-clock
  exemptions, the FUSE exec suite's design, and the production waits that apply
  the same principle. Not needed to write a test; read it before changing the
  wait machinery itself.
- [COVERAGE.md](COVERAGE.md) — how CI measures coverage. It explains the two
  mechanisms (Deno's V8 coverage for runtime code, and transformer-based
  coverage for authored patterns) and how both feed the coverage-debt gate.
- [CI_PERFORMANCE.md](CI_PERFORMANCE.md) — the CI wall-time policy, and the
  coverage-debt baseline and ratchet markers that gate a pull request.
- [BENCHMARKS.md](BENCHMARKS.md) — how `*.bench.ts` files run in CI, how the
  team ops dashboard charts their trends, and the naming and stdout
  constraints a bench file must satisfy.
- [llm-testing.md](../features/llm-testing.md) — testing patterns and server
  routes that call the LLM, including the test-environment guard and
  conversation fixtures.
- [UI_TESTING.md](UI_TESTING.md) — testing shadow DOM components in browser
  integration tests.
- [../specs/pattern-update-testing.md](../specs/pattern-update-testing.md) —
  the two CI gates standing between an incompatible pattern and every piece
  running it: contract compatibility (`deno task pattern-compat`) and state
  continuity (`deno task pattern-vintage`), what each proves, and what an
  author does to add a pattern to the fixture set.
- [../common/workflows/pattern-testing.md](../common/workflows/pattern-testing.md)
  — writing and running pattern tests with `cf test`. The agent-oriented version
  is [../common/ai/pattern-testing-guide.md](../common/ai/pattern-testing-guide.md),
  and the design reference is [../specs/PATTERN_TESTING_SPEC.md](../specs/PATTERN_TESTING_SPEC.md).
