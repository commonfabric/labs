---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.bench.ts"
  - "**/integration/**/*.ts"
---

# Writing tests

`docs/development/TESTING.md` is the map for everything testing — how the
suites run, how each kind of test is shaped, and a "Related documentation"
section routing to coverage, benchmarks, shadow DOM, language-model tests, and
the pattern-update gates. What follows is only the part you would otherwise
learn by failing CI, or by shipping a file in the wrong shape.

## Run browser tests outside the macOS agent sandbox

A command that can launch a browser runs only outside the sandbox. If this
session already has unsandboxed execution, just run it — there is nothing to
request. If it does not, request unsandboxed execution for the command instead
of attempting it in the sandbox, where Chrome aborts during startup and the
failure is not test evidence. Known browser-launching paths include the root
`deno task test`, `deno task demo`, unfiltered browser targets of
`deno task integration`, `deno-web-test`, `Browser.launch()`, and a bound
`ShellIntegration` lifecycle. For a filtered integration run, inspect the
selected suite's launch path. An Astral import alone is not proof that a test
starts Chrome. Deno's `-A` does not escape the outer sandbox. The full rule is
in `docs/development/TESTING.md#browser-tests-in-agent-sandboxes`.

## A browser test routes itself by its name

A test that needs a real browser but not a running product goes in a
`*.browser.test.ts` file, and that name is the whole of the wiring. Every
package that splits its tests this way matches the pattern twice: once as an
`--ignore` that keeps the file out of plain `deno test` discovery, and once as
the argument list handed to `deno-web-test`. Both are globs, so there is no list
to add the file to. `packages/ui` and `packages/iframe-sandbox` write the two
halves as separate `deno-test` and `browser-test` tasks, and
`packages/dashboard` spreads the pair across a runner script and the task that
runner calls. Where the pair is written changes; what it matches does not.

Two things break it, and the second is what makes the first hard to notice.

A browser-only test under any other name lands in the plain Deno pass, where it
fails on the first browser global it touches. So use the name whenever the test
needs a browser, whatever its subject.
`packages/ui/src/v2/components/cf-svg/sanitize-svg.browser.test.ts` is the case
to keep in mind: it is not a component test at all, and needs a browser for
`DOMParser` alone.

A `typeof document === "undefined"` guard around the body turns that loud
failure into a silent one. The file runs in Deno, returns before its first
assertion, and reports "ok" having checked nothing. A file the glob routes
always has a document, so the guard can only ever hide a mis-wiring. Write no
guard.

`docs/development/TESTING.md#focused-browser-regressions` states the rest,
including when to use this route rather than the browser integration lane.

## Shape of a unit test file

First check which kind of file you are in. A `*.test.tsx` under
`packages/patterns`, and a scattering elsewhere such as those under
`packages/piece/test/vintages`, is a **pattern test** — itself a pattern,
driving another with `action()` and asserting with `assert()` from
`commonfabric`, run by `deno task cf test`. Nothing in this section applies
to one.
`docs/common/workflows/pattern-testing.md` governs those; its "Write
assertions with `assert()`" and "Use `assert()` only for assertions"
sections carry the two rules easiest to get wrong.

For everything else, `docs/development/unit-test-coding-style.md` is the
authority, and a new test file is a reason to open it rather than to copy a
neighbor. Not every file in the tree follows it, so what sits beside you in
the same directory is not evidence of what to write.

The eight rules its readers most often get wrong by defaulting to the
surrounding code:

- BDD only — `describe()` / `it()` / `beforeEach()` from `@std/testing/bdd`,
  never `Deno.test()`.
- One top-level `describe()`, titled with the name of the file under test
  minus its suffix, with everything else nested inside it.
- An `it()` description is a third-person verb phrase completing "it", and
  names an observable output rather than an intent: "returns `false` for a bare
  function", not "rejects a bare function".
- `expect()` over `assert*()`, always for structured values. Plain `assert(x)`
  only where truthiness itself is the assertion.
- A comment about a test or a group of tests goes inside the block, as the first
  thing in the callback and followed by a blank line. Above the `describe()` or
  `it()` line, the next block inserted there lands between the comment and what
  it describes. Two shapes are exceptions: hooks — a `beforeEach()` reads like
  any other statement with a comment over it — and a callback with no body of
  its own, which keeps its comment beside it. That second shape covers a bare
  expression, `{}` on the opener's line, and a `Deno.test({ … })` whose `fn`
  names a function declared elsewhere.
- A comment covering several adjacent tests is telling you those tests want a
  `describe()` of their own, or says one thing per case and belongs in each.
  Wrapping a run renames every test in it; bridge the rename per
  `docs/development/test-records.md`.
- A section marker is a `//` frame: an opening `//` line, a noun-phrase title,
  optionally a blank `//` line and a description, and a closing `//` line, set
  off by a blank line below it and above it where there is anything above.
- A section marker covers the region up to the next marker at the same level, or
  the end of the block or file, so writing one means choosing where it ends and
  putting a marker there. Its title is a claim about everything in that region,
  and the region holds the helpers and fixtures sitting in it as well as the
  blocks, so shared setup goes above the file's first marker. Moving or deleting
  a comment takes away whatever boundary it was providing for the region above
  it. None of this is checked mechanically; a file that reads better than the
  rule wins.

On placement: a test goes in the package's `test/` tree, mirroring `src/`. The
exception is a directory of independent components, `packages/ui` and
`packages/patterns` among them, where each test sits beside its component and
belongs there.

The "Which comparison decides the outcome?" section is the one to read before
writing a test that turns on a fine distinction — `-0`, `NaN`, or a boxed
value such as a `FabricHash`.

## Wait on an event, never on a poll

`deno task check-no-waitfor` fails the build when an integration test imports
the polling `waitFor` from `@commonfabric/integration`. Only `integration/`
directories under `packages/` are in scope; a unit test's poll has no gate, and
the rule below is what holds it. Reach for the primitive that
resolves on the thing actually happening:

- In a browser test: `awaitViewSettled(page)` for "the view is interactive",
  then `waitForText`, `clickCfButton`, `clickCfButtonAndWaitForText` and the
  rest of `packages/patterns/integration/cfc-browser-helpers.ts`.
- With no page: resolve a `defer()` from a callback the test already registers
  — a cell sink, a subscription's `next`, the scheduler's `onError`.

The full toolkit is in `docs/development/waiting-in-tests.md`. Read it before
adding a bounded poll; the section that decides the question is "Where the
polling `waitFor` stays". Its companion
`docs/development/waiting-in-tests-rationale.md` carries the argument and the
case studies, which writing a test does not need and changing the wait
machinery does.

If an event-driven wait genuinely cannot express the condition — a condition
spanning two browser pages, a headless cell read with no callback to hang on —
the exemption takes two edits, not one: add the file to `ALLOWLIST` in
`tasks/check-no-waitfor.ts` with a one-line reason, and record the same reason
under "Where the polling `waitFor` stays" in
`docs/development/waiting-in-tests.md`. A file in the allowlist with no entry in
the document is an exemption nobody can review.

The repository-wide ban on timeouts, retry loops, and sleeps applies here with
no exceptions, including in setup and teardown.

## A pattern that reads a data file

A pattern calling `dataFile()` needs its data files attached to the program the
test compiles, or it fails at the read. It compiles and type-checks either way,
so nothing earlier reports the omission.

A file the pattern names in a `dataFile()` call is attached by whichever
command builds the program, so a test whose fixture sits where the call says it
does needs to say nothing further. The path resolves against the module that
reads it — `./data/cities.json` is the file beside the pattern — so it names
the same file whichever root the runner assembles the program with. A file the
source cannot name — one read by a computed path — is added where the test
builds its program: `--datafile` on `cf test`, the `dataFiles` field of a
`generated-patterns` scenario, or `dataFilePaths` on the `resolveLocalProgram`
call a browser integration test makes. A browser test needs nothing beyond that
— the data reaches the browser through the space, inside the compiled pattern,
not from the filesystem. A name with no file behind it fails the build, saying
which module read it; an unattached file the source could not name shows up as
`No attached data file "<path>"` when the pattern runs, naming the path the
read resolved to and what is attached. That one function is the only sanctioned
way to build a program from local files, and
`deno task check-local-program` fails a `FileSystemProgramResolver` constructed
anywhere else — a program assembled by hand carries no data files and says
nothing about it.

## Every test's runs are recorded

Each test execution produces a telemetry record named by what the runner
reports — the describe chain, the `Deno.test` name, the pattern file path.
Nothing to instrument when adding a test to an existing suite; the runners
record on their own. Four consequences worth knowing while writing one:

- The reported name is the test's identity across history. Prefer stable,
  content-derived wording over positional counters (`#${i}`) or
  interpolated identifiers, which mint a new identity every time they
  shift; renames split history unless bridged in
  `tasks/test-identity-aliases/`, in the file named after the test file;
  `docs/development/test-records.md` states the naming rule.
- The name has to be unique within its scope — the whole describe chain
  plus the `it()` description, or the bare `Deno.test` name, across every
  test file of the package. Two tests under one name are one identity, so
  their outcomes and durations merge and neither can be tracked on its
  own. A loop that generates names is the case to check twice: a
  hand-written test beside it can land on one of them.
- Every test must finish within sixty seconds in CI, not counting setup.
- A lane runs a selected test on its own, with its file's other tests
  registered as ignored. A test that passes only after a neighbor has
  run fails there, and fails by waiting out the five-minute safety net
  rather than by asserting. A test charged five minutes is charged more
  than the bound a whole lane is packed to finish inside, so it then runs
  nowhere. "Every
  test has to pass on its own" in `docs/development/TESTING.md` covers
  the rest, including how to run one test that way locally.

A new test *surface* (a new script, harness, or kind of test) is a new suite in
`tasks/test-topology/`, never a new CI job, and does need wiring —
`docs/development/test-records.md` under "Covering a new test surface".

Your own runs are recorded too, and are marked as an agent's: with
`CF_TEST_AGENT` unset, the run context carries the name of the harness
you are running under. Nothing to set, and nothing to work around —
a run of yours is data about the tests, the same as anyone's.

AGENTS.md, under "Test-reporting key", says when to suggest setting up a
reporting key. Recording is inert without a key; never treat a missing
one as an error.

## Reaching into shadow DOM

Integration tests address components through accessibility locators rather than
by walking shadow roots. `docs/development/UI_TESTING.md` covers the
nested-shadow-root cases and the helpers for them.

## Tests that start another Deno process

Use `@commonfabric/test-support/isolated-deno`, which copies the lockfile and
runs with dependency resolution frozen. A test that resolves the graph again,
or that writes into the tree it is checking, turns an accidental dependency
change into a silent pass. "Tests that start Deno" in
`docs/development/TESTING.md` states the boundary; the `isolated-test-processes`
skill walks through applying it.
