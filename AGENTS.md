# Repository Guidelines for AI Agents

This repository represents the Common Fabric runtime: a fully integrated,
reactive runtime and execution environment for user-created programs. These
programs are known as patterns and somewhat similar to Solid.js components. Each
pattern is comprised of reactive `Cell`s stored in `Space`s (defined by a DID).
These cells enable durable communication between patterns. The reactivity is
enabled by subscribing to the result of a query, defined by the schemas/type
signatures.

## Pace Layers

This repository contains many packages that compose and stack to create the
Common Fabric product.

1. Foundation: api, data-model, data-model-schema, runner, identity, memory
2. System: schema-generator, iframe-sandbox, ts-transformers, js-compiler
3. Capabilities: piece, html, llm, navigation
4. Operation: background-piece-service, cf-harness, cli, connectors, fuse,
   state-inspector
5. Deployed Product: toolshed, shell, lib-shell, runtime-client
6. User Interface: ui
7. End-User Programs: home-schemas, patterns

Anything under `packages/` not named above — utilities, build tooling, test
support, internal dashboards, example code — sits outside the layer stack.

Dependencies run downward: a package imports from its own layer or a lower one.
That is the direction the stack is designed around, and the one to hold a new
import to. It does not describe the tree as it stands — a number of imports run
the other way, `runner` reaching into `js-compiler` and `llm` among them — so an
existing import upward is not a precedent for the next one. Only the weaker
property is enforced: `deno task check-package-cycles` fails when two packages
import each other. Layer direction rests on review.

When a module looks as though it belongs to a higher layer but something lower
needs it, decide by what the module actually touches rather than by what it is
named after. The JSX factory is the worked example. `h()` resolves cells to
links and returns a plain view-node object, which is data construction over
runtime primitives, so it lives in `runner` alongside the schema that describes
that object. Turning those view nodes into DOM is rendering, so that lives in
`html`.

## Documentation Lifecycle

Whenever editing documentation, read [docs/README.md](docs/README.md) and follow
the rules therein. These include:

- **Live** documentation (everything outside `docs/history/`) describes the
  current system or pending plans. If your change alters behavior that a live
  document describes, update that document in the same change.
- Live documentation must be forward-looking, and should not refer to previous
  states of the repository or justify decisions based on past choices.
  Everything should stand on its own merits in a forward-looking fashion.
- **Historical** documentation (`docs/history/`) holds point-in-time records:
  audits, reports, investigation findings, executed plans, superseded designs.
  Never edit their content, and never treat them as descriptions of the current
  system.
- The test for which is which: if the system changed, would someone edit this
  document, or write a new one and leave this one alone? Edit it — live. Write a
  new one — historical.
- When you produce a point-in-time artifact (a report on completed work, an
  audit, a post-mortem), create it in `docs/history/` with the metadata header
  defined in `docs/history/README.md`, and add an entry for it to
  `docs/history/INDEX.md`. That entry is a single line, however long it runs,
  and that file holds nothing but its preamble, its section headings, and the
  entries — both rules are what let git merge concurrent additions to the index
  without a conflict.
- When a live plan or design reaches "done" or is abandoned — for example, your
  change lands its last phase — archive it to `docs/history/` following the
  procedure in `docs/README.md`.
- TypeScript and TSX code blocks under `docs/` are type-checked in CI by
  `deno task check-docs`. A block selects the scaffold it compiles inside with
  an opening context comment; `docs/check.md` defines that vocabulary, which is
  not derivable from the source.

## Engineering principles and coding style

### Writing Code

Before writing or changing code anywhere in this tree, read
`docs/development/DEVELOPMENT.md` and `docs/development/code-comment-style.md`.
That obligation does not depend on which part of the tree you are working in, on
how small the change is, or on whether you would call the work "development".

The `writing-code` skill at `skills/writing-code/SKILL.md` is the map: which
document governs the thing you are about to touch, what to run before pushing,
and — the part a green run tells you nothing about — the conventions no gate
enforces, which are therefore left to a reviewer to find by reading. `skills/`
is the canonical authored source; Codex discovers the repo-local mirror through
`.agents/skills/`, and Claude through `.claude/skills/`.

### Reviewing Code

Reviewing a changeset — including reviewing your own before you push — goes
through the `cf-review` skill at `skills/cf-review/SKILL.md`. It holds code to
the same documents `writing-code` hands the author, so that a convention
enforced in review is one its author was told about. A general-purpose review
command supplied by your agent harness knows nothing about this repository and
is not a substitute for it.

`docs/development/pr-review-comments.md` covers reading and answering the review
comments a pull request collects.

### Running the CLI

The `cf` CLI runs from source through `bin/cf`, which `deno task install-cf`
puts on PATH once per machine, and `skills/cf/SKILL.md` covers invoking it.
`deno task cf …` runs the same CLI from any directory inside the checkout and
needs nothing on PATH, which makes it the spelling for a shell where `cf` is not
found, as an agent's non-interactive shell is on a machine that never ran the
install. The two differ in one respect: `cf which`, which reports the checkout a
`cf` would run, is answered by `bin/cf` alone.

### Avoid timeouts, retry loops, and sleeps

Timeouts cause flakiness because they put an upper bound on success: anything
that would have eventually completed cannot complete once it hits the timeout.

Retry loops mask errors: anything that should have succeeded first time now gets
missed because if it succeeds sometimes.

Sleeps are flaky and expensive: they increase the floor on the amount of time
operations take, and they rely on unpredictable timings to align for success.

Avoid all three; when you see them in existing code, point them out and suggest
starting an agent to remove them.

For tests, `docs/development/waiting-in-tests.md` is the canonical guidance. It
names the event-driven primitives to reach for instead of a poll, and the
specific cases where a bounded poll is the honest tool — read it before removing
one, so you don't strip a wait the repo keeps on purpose. Its companion,
`docs/development/waiting-in-tests-rationale.md`, holds the analysis and case
studies behind those rules; read it when you need to know why a rule is what it
is, or before changing the wait machinery a rule describes.

### Pattern Development

If you are developing patterns, use the repo-local `pattern-dev` skill at
`skills/pattern-dev/SKILL.md`. `skills/` is the canonical authored source. Codex
discovers the repo-local skill mirror through `.agents/skills/`, and Claude
compatibility continues to use `.claude/skills/`.

`docs/common/README.md` indexes the pattern documentation; follow links from
there to what your task needs.

When authoring or reviewing a skill itself, read
`docs/development/skill-authoring.md` and `docs/development/skill-audit.md`.

For reading or changing Topics on Estuary, use `skills/topics/SKILL.md`.

### Runtime Development

If you are developing runtime code, start with:

- `docs/development/DEVELOPMENT.md` - Coding style, design principles, and best
  practices
- `docs/development/code-comment-style.md` - How a comment is written, both the
  `//` kind and the JSDoc kind. Two rules catch people out. A comment describes
  the system as it stands: not its own past, not the road not taken, not the
  plan that got it here. And nothing comes between a doc comment and the
  declaration it documents — adding a definition means placing it after the
  whole of the declaration above it, doc comment included
- `docs/development/LOCAL_DEV_SERVERS.md` - **CRITICAL**: How to start local dev
  servers correctly (use `dev-local` for shell, not `dev`)
- `docs/development/TESTING.md` - Running the test suites and the general unit
  and integration test structure; hub that links the other testing docs; renamed
  tests must be tracked in the aliases file; a lane may run a subset of a file
  and skip the rest, so a test that leans on a sibling fails when it does
- `docs/development/unit-test-coding-style.md` - How a unit test file is shaped:
  its location and name, the single top-level `describe()`, how an `it()`
  description is worded, `expect()` over `assert*()`, and the matcher traps that
  yield a test which cannot fail. Read it before writing a new test file; not
  every file in the tree follows it, so a neighbor is not evidence of it
- `docs/development/waiting-in-tests.md` - Waiting on a real event instead of
  polling: the primitives to reach for, and the specific cases where a bounded
  poll is the honest tool
- `docs/development/COVERAGE.md` - The two coverage mechanisms (V8 runtime
  coverage and transformer-based pattern coverage), which CI job collects which,
  and why only one of the two pattern integration arms collects authored-pattern
  coverage
- `docs/development/debugging/` - Runtime errors, type errors, and
  troubleshooting
- `docs/development/DEPENDENCIES.md` - Adding and rolling dependencies, required
  version pins, and dependency troubleshooting

Everything else is indexed rather than listed here. `docs/README.md` maps the
whole documentation tree. `docs/development/README.md` indexes the rest of the
development documentation: configuration, benchmarks, deploying, the
continuous-integration policies, and so on. `docs/features/README.md` indexes
one document per feature or per aspect of the runtime — collection writes,
identity, ingest, host embedding, and the rest. Read the relevant one before you
change a subsystem you have not worked on before.

#### Browser tests in agent sandboxes

On macOS, a command that can launch a browser needs unsandboxed execution. Which
side of that you are on is a fact about your own execution state, and your
harness reports it: if the session already runs unsandboxed, run the command; if
it runs sandboxed, request unsandboxed execution rather than trying the command
there first. The browser-launching commands are the root `deno task test`; the
unfiltered root `deno task integration` command; unfiltered integration runs for
`shell`, `patterns`, or `patterns-reload`; `deno task demo`; `deno-web-test`;
and focused or filtered tests whose setup launches Chrome through Astral or
`ShellIntegration`. Deno's `-A` flag does not escape the outer sandbox, and a
browser startup failure caused by that sandbox is not test evidence. The
complete rule is in
[`docs/development/TESTING.md`](docs/development/TESTING.md#browser-tests-in-agent-sandboxes).

Three obligations that are easy to miss:

- `docs/README.md` governs everything this repository writes down: how to write
  documentation, where a new document belongs, and which examples belong in one.
  Read it before you write a document. The words themselves — American spelling,
  and one word per concept — are standardized under "Word choice" in
  `docs/development/DEVELOPMENT.md`, and that reaches comments, error and log
  messages, and test descriptions as much as it reaches documents.
- `docs/development/EXPERIMENTAL_OPTIONS.md` is the central registry of every
  experimental flag. Read it before adding, changing, or removing a flag, and
  update it in the same change.
- `docs/development/space-clone-rehearsal.md` is the procedure for rehearsing a
  pattern update against a writable copy of a real space. Read it before any
  `setsrc` against a space that holds real data.

Working in `packages/ts-transformers` or `packages/schema-generator`? Start at
that package's own `AGENTS.md`.

#### Adding New Packages

A new workspace package needs three edits, and the second one bites hard when it
is missed:

1. Its path added to the `"workspace"` array in the root `deno.jsonc`.
2. A `"tasks"` object in its own `deno.jsonc` carrying a `"test"` entry — either
   one running `tasks/run-member-tests.ts` over a `"deno-test"` entry, or
   `"echo 'No tests defined.'"` when it has no tests yet. Without one,
   `deno task test` falls through to the root workspace's task, which would
   re-run the whole suite inside itself, spawning processes exponentially. The
   workspace runner reads every member's manifest before it runs any of their
   test tasks, and refuses to start when one has no `"test"` entry, so what a
   missing entry costs is a message naming the member rather than a CI timeout.
   `packages/utils/deno.jsonc` is a correct example.
3. A checked path in `tasks/typecheck.ts`, usually a single directory entry, so
   `deno task check` opens the package at all. Naming the package in the
   `workspace` array is what puts it under the type check's coverage claim, so a
   package added there and left out here fails `tasks/typecheck.test.ts` with
   its unchecked files named — unless it earns an `UNCHECKED_TREES` entry
   recording why it has no path.

When the package needs a dependency, follow `docs/development/DEPENDENCIES.md`.

## Instructions for committing to this repository

Before committing, squashing, or otherwise getting a branch ready to be reviewed
or landed: Execute repo-wide `deno fmt --check`, `deno lint` and
`deno task check`, and run all relevant tests. The type check is its own step: a
package's `test` task runs its tests, and whatever those happen to type-check on
the way is no substitute for checking the workspace.

When babysitting a PR through CI, look for review comments in addition to failed
CI jobs. Cubic reviews nearly every PR here, and its review lands a few minutes
after each push, so wait for it before concluding a PR has none. Read its
findings with `gh api --paginate repos/commonfabric/labs/pulls/<n>/comments`;
they are inline review comments, which `gh pr view` does not return.
`docs/development/pr-review-comments.md` covers the rest. When facing
difficulties getting coverage checks to pass, consider the information in
`docs/development/COVERAGE.md`.

### Automated gates

`deno task check` type-checks a hand-maintained list of paths in
`tasks/typecheck.ts` (`tasks/check.sh` owns the Deno version gate and delegates
there). The list is written by hand; its completeness is not left to hand.
`UNCHECKED_TREES` beside it records every tree the list leaves out together with
the reason, and `tasks/typecheck.test.ts` walks the workspace that `deno.jsonc`
declares and fails — naming the files — on any module that is neither checked
nor covered by one of those entries. That population is every extension the
checker opens, JavaScript included: `deno check` type-checks a `.js` file
carrying `// @ts-check`, so a claim stated over TypeScript alone would be
narrower than the gate it describes. A directory left out on purpose and one
left out by accident look identical in a list of paths, so the record is what
separates them: a tree nobody decided about fails the test rather than passing
in silence. Adding an exemption means adding an entry that says why.

Four trees are recorded as unchecked. `packages/schema-generator/test/fixtures`
and `packages/ts-transformers/test/fixtures` are fixture corpora — the inputs
those tests feed their transformer, and the outputs they compare against — and
`packages/static/assets/types` is the ambient environment a pattern compiles
against, handed to the in-memory compiler. What earns all three the exemption is
holding data rather than modules this repository builds; neither corpus compiles
as a unit, though files within one may well compile alone. The fourth is
`packages/patterns`, which the next paragraph covers.

An exemption's reason is held to being true of every file it matches, which is
what decides how wide the entry may be. Two entries divide `packages/patterns`,
because two different things happen to the files there. The one pointing at
`deno task cfcheck` may excuse only files the collector in
`tasks/pattern-files.ts` hands that gate, and no single entry may span both
sides of that line; a test cross-checks both against the collector itself. The
other covers pattern tests, which the lane that runs them also type-checks —
`deno test` for a `.test.ts`, since `packages/patterns` runs without
`--no-check`, and `cf test` for a `.test.tsx`, whose harness reports a type
error as a failed test. That entry is scoped to what those two lanes take, not
to the test suffix in general. A test module under another extension has no
lane; a `.browser.test.ts` is kept out of the `deno test` pass and bundled to
its browser by a step that transpiles without checking; and a nested
`integration` tree is excluded from that pass by the package's test config while
the `integration` task names its top-level paths explicitly. Each falls through
and is reported unless a checked path names it. An entry claiming coverage is
the one that can mislead most quietly, since a file it wrongly matches is one
every later reader believes is checked — and where these keep going wrong is a
predicate matching by a file's shape while the reason beside it names a lane,
the two agreeing in the middle and parting at the edges.

The reasons that do not name another gate say what a tree _is_ rather than
asserting a property of each file in it. That is why the three above are
described as corpora and as an ambient environment: none is a set of modules the
repository builds, which is what earns the exemption. Individual files in them
may well compile alone, so a reason claiming that none of them does would be
false the moment one did — a universal quantifier over a corpus is the shape to
avoid when writing one of these.

Patterns are the exception `deno task check` does not own. It lists some pattern
directories and checks them through the automatic-JSX environment the rest of
the tree uses, but patterns compile under a different (classic-`h`) JSX runtime,
and the two disagree on some advanced pattern types. `deno task cfcheck` (the
"CFC Pattern Check" CI job) type-checks every pattern in the JSX and
runtime-type environment they actually compile under, and is the authoritative
pattern type-check. Run `deno task test` in every package you touched, and
`deno task check` alongside it: a package's `test` task runs its tests and does
not type check, so the two are separate obligations.

Each of these gates fails CI on its own, and none of them run as part of
`deno task check`:

- `deno task check-no-waitfor` — an integration test that imports the polling
  `waitFor`. It reads only `integration/` directories under `packages/`, so its
  green says nothing about a poll in a unit test
- `deno task check-bench-workflow` — a benchmark file the dashboard names by
  path that `.github/workflows/benchmarks.yml` no longer runs, or a workflow
  that stopped checking the report it uploads. The dashboard's machine factor
  and its key benchmarks tile each rest on a benchmark named outright, and a
  name that reaches nothing costs a chart its series without failing anything
- `deno task check-docs` — a TypeScript block under `docs/` that stopped
  compiling
- `deno task check-docs-history-index` — an entry in `docs/history/INDEX.md`
  that is wrapped, duplicated, or points at nothing, or a document in that tree
  that no entry covers
- `deno task check-conflict-markers` — an unresolved merge-conflict marker left
  in a file, which `docs/` has no other mechanical gate against
- `deno task check-control-characters` — a literal control codepoint below 0x20,
  other than newline, in tracked source. Written as an escape (`\x00`, `\t`) the
  string is identical; written as the byte, a single NUL makes the whole file
  read as binary, so `grep` skips it silently
- `deno task check-test-shuffle` — a command that starts a test runner without a
  seed to shuffle its order by. Every test run reorders its tests, so that a
  test needing another test to have run before it fails on a schedule rather
  than when somebody happens to move a test. A `deno test` takes
  `--shuffle=$(deno task -q test-seed)`; a runner this repository owns either
  shuffles in its own code or forwards that flag, and each is recorded in the
  task with which of the two it does. A runner whose order is the test — a
  scenario whose every step acts on what the step before it left — is recorded
  there too, with that reason
- `deno task check-skill-facts` — a path or import cited by a skill, an
  `AGENTS.md`, a rule, or a hook script under `.claude/scripts/` that stopped
  resolving
- `deno task check-address-examples` — a cell address written into a document, a
  skill, or a source comment that the reference parser refuses. A grammar change
  retires a spelling and says nothing about the places teaching it, so the
  tree's examples are held to the parser itself. A string written on purpose —
  the retired form quoted as retired, a spelling of the shell's page URL, a
  grammar line — is recorded in `EXEMPTIONS` in the task, naming the file, the
  string and the reason, so nothing a scanned file says can exempt itself. It
  fails the other way round too, on an entry whose file no longer writes its
  string. `tasks/check-address-examples.ts` states what counts as an example
- `deno task check-verb-session-sync` — a `cf` command or act reference in
  `docs/common/verbs/the-verb-session.md` or
  `docs/common/verbs/session-walkthrough.md` that its demo script does not back;
  both documents quote commands, never compose them
- `deno task check-single-copy-deps`, `check-unused-deps`, `check-deno-pins` —
  dependency declarations across the workspace
- `deno task check-package-cycles` — two packages that import each other, the
  part of "Dependencies run downward" above that a machine can settle
- `deno task check-completion-slots` — a `cf` option or positional nobody
  decided about completing. Shell completion's values come from two
  hand-maintained tables, and a slot missing from both is silent: it offers
  nothing, exactly as an unreachable fabric does. Give it candidates, or record
  in the task why it has none
- `deno task check-command-docs` — a `cf` command, or a shuttle verb, that no
  live document describes. The obligation to update a document when behavior
  changes cannot fire for a surface no document describes, so a command ships
  and its prose does not. Describe it in a live document — the README of the
  package that implements it is the usual home — or record in the task why it
  needs none. What counts as described differs with the surface: a command is
  named the way a caller types it, and a verb, whose name is a word a sentence
  may hold for its own reasons, is given a row of its own in a table. It fails
  the other way round too, on a recorded reason naming a command or a verb that
  no longer exists: one removed takes its entry with it
- `deno task check-local-program` — a program built from local files by hand
  rather than through `resolveLocalProgram`, which silently drops any data files
  the caller attached
- `deno task check-baselines-append-only` — a pattern baseline that was deleted
  rather than added to
- `deno task check-test-aliases` — a test-identity alias line that was edited or
  removed rather than appended, mapped an identity twice, or formed a cycle. The
  lines live under `tasks/test-identity-aliases/`, in files named after the last
  path segment of the test file they cover, so that renames in test files of
  different names do not meet in one file
- `deno task check-pattern-tiers` — a legacy or fixture pattern that does not
  open with the marker saying so. `packages/patterns` is example code of unequal
  authority, and the marker is what stops the wrong example being copied by
  someone who never found the index. Membership is `tasks/pattern-tiers.ts`, and
  `deno task fix-pattern-tiers` applies or corrects a marker

The detail behind each of these lives in `.claude/rules/`, one file per kind of
file it governs. Claude Code loads the matching rule on its own when it reads a
file the rule names. An agent without that mechanism can read the rule directly
— they are ordinary Markdown, and `.claude/rules/README.md` says which covers
what.
