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
4. Operation: cf-harness, cli, connectors, fuse, state-inspector
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

Before writing or editing documentation, read [docs/README.md](docs/README.md),
which governs everything this repository writes down: how to write a document,
where a new one belongs, which examples belong in one, and how a document moves
to `docs/history/`. The rules that bite most often:

- **Live** documentation (everything outside `docs/history/`) describes the
  current system or pending plans. If your change alters behavior that a live
  document describes, update that document in the same change. Live
  documentation is forward-looking: it does not refer to previous states of the
  repository or justify decisions based on past choices. When a live plan
  reaches "done" or is abandoned, archive it.
- **Historical** documentation (`docs/history/`) holds point-in-time records.
  Never edit their content, and never treat them as descriptions of the current
  system. A new one gets the metadata header from `docs/history/README.md` and a
  single-line entry in `docs/history/INDEX.md`.
- TypeScript and TSX code blocks under `docs/` are type-checked in CI by
  `deno task check-docs`. A block selects the scaffold it compiles inside with
  an opening context comment; `docs/check.md` defines that vocabulary, which is
  not derivable from the source.
- The words themselves — American spelling, and one word per concept — are
  standardized under "Word choice" in `docs/development/DEVELOPMENT.md`, and
  that reaches comments, error and log messages, and test descriptions too.

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
through the `cf-review` skill at `skills/cf-review/SKILL.md`. A general-purpose
review command supplied by your agent harness knows nothing about this
repository and is not a substitute for it.
`docs/development/pr-review-comments.md` covers reading and answering the review
comments a pull request collects.

### Running the CLI

The `cf` CLI runs from source through `bin/cf`, which `deno task install-cf`
puts on PATH once per machine, and `skills/cf/SKILL.md` covers invoking it.
`deno task cf …` runs the same CLI from any directory inside the checkout and
needs nothing on PATH, so use it in a shell where `cf` is not found. Only
`bin/cf` answers `cf which`, which reports the checkout a `cf` would run.

### Test-reporting key

If `CF_TEST_RECORDS_KEY_FILE` is unset or names a missing file, mention once per
session, as a friendly suggestion, that `deno task test-records-key setup` is
worth running once your user contributes regularly
(`docs/development/test-records.md`, "Getting a key").

### Avoid timeouts, retry loops, sleeps, and polling

A timeout puts an upper bound on success, so work that would have completed
fails instead. A retry loop hides a failure that should not happen. A sleep sets
a floor on how long an operation takes and depends on timings lining up. A poll
wastes work while nothing changes and notices a change late; the component that
changes the state sends a notification instead, for example over a long-lived
socket. Avoid all four. When you work in code that has one, refactor it to
remove it, unless `docs/development/waiting-in-tests.md` lists it as a wait the
repo keeps. For tests, that document is the canonical guidance: read it before
removing a wait, and its companion
`docs/development/waiting-in-tests-rationale.md` before changing the wait
machinery.

### Pattern Development

If you are developing patterns, use the `pattern-dev` skill at
`skills/pattern-dev/SKILL.md`. `docs/common/README.md` indexes the pattern
documentation. When authoring or reviewing a skill itself, read
`docs/development/skill-authoring.md` and `docs/development/skill-audit.md`. For
reading or changing Topics on Estuary, use `skills/topics/SKILL.md`.

### Runtime Development

If you are developing runtime code, start with:

- `docs/development/LOCAL_DEV_SERVERS.md` - **CRITICAL**: How to start local dev
  servers correctly (use `dev-local` for shell, not `dev`)
- `docs/development/TESTING.md` - Running the test suites, and the hub that
  links the other testing docs
- `docs/development/unit-test-coding-style.md` - How a unit test file is shaped.
  Read it before writing a new test file; not every file in the tree follows it,
  so a neighbor is not evidence of it
- `docs/development/COVERAGE.md` - The coverage mechanisms, and the measured-set
  gate, the only coverage check that fails a pull request
- `docs/development/debugging/` - Runtime errors, type errors, and
  troubleshooting
- `docs/development/DEPENDENCIES.md` - Adding and rolling dependencies

Contextual Flow Control (CFC) is specified outside this repository, in
`commonfabric/specs` under `cfc/`, as prose with pseudocode, a Lean development,
and a paper that are kept equivalent, and the runtime here is held to that
specification. A change that alters what CFC decides goes through the
specification first, proof included; code may land ahead of a ruling only under
a budgeted `SPEC-PENDING` marker. `docs/development/cfc-spec-correspondence.md`
is the procedure: how to classify a change as host arrangement, conforming
implementation, or semantic gap, how a gap is filed as a specs pull request, and
what to do without access to the private specs repository. It governs
`packages/runner/src/cfc/` and `packages/runner/src/cfc.ts`, the CFC tests under
`packages/runner/test/`, the render boundaries in
`packages/html/src/worker/reconciler.ts` and
`packages/html/src/worker/display-fit.ts`, the harness's CFC enforcement in
`packages/cf-harness/src/` (`cfc-*.ts`, `contracts/cfc-*.ts`,
`sandbox/runsc-cfc-result.ts`), the harness console's display ceiling in
`packages/cf-harness/console/display-ceiling.ts`, and every
`docs/specs/cfc-*.md`; the harness audit's clause derivation is
`docs/specs/agent-harness/04-cfc-spec-correspondence.md`.

`docs/README.md` maps the whole documentation tree, `docs/development/README.md`
indexes the rest of the development documentation (configuration, benchmarks,
deploying, the continuous-integration policies), and `docs/features/README.md`
indexes one document per feature or aspect of the runtime. Read the relevant one
before you change a subsystem you have not worked on before. Three obligations
are easy to miss:

- `docs/development/EXPERIMENTAL_OPTIONS.md` is the central registry of every
  experimental flag. Read it before adding, changing, or removing a flag, and
  update it in the same change.
- `docs/development/space-clone-rehearsal.md` is the procedure for rehearsing a
  pattern update against a writable copy of a real space. Read it before any
  `setsrc` against a space that holds real data.
- A new workspace package is three edits: its path in the root `deno.jsonc`
  `"workspace"` array, a `"tasks"` object with a `"test"` entry in its own
  `deno.jsonc` (without it the root test runner refuses to start), and a checked
  path in `tasks/typecheck.ts`. `.claude/rules/workspace-packages.md` has the
  detail.

Working in `packages/ts-transformers` or `packages/schema-generator`? Start at
that package's own `AGENTS.md`.

#### Browser tests in agent sandboxes

On macOS, a command that can launch a browser needs unsandboxed execution. Your
harness reports whether your session is sandboxed: if it is, request unsandboxed
execution rather than trying the command there first. The browser-launching
commands are the root `deno task test`; the unfiltered root
`deno task integration`; unfiltered integration runs for `shell`, `patterns`, or
`patterns-reload`; `deno task demo`; `deno-web-test`; and focused or filtered
tests whose setup launches Chrome through Astral or `ShellIntegration`. Deno's
`-A` flag does not escape the outer sandbox, and a browser startup failure
caused by that sandbox is not test evidence. The complete rule is in
[`docs/development/TESTING.md`](docs/development/TESTING.md#browser-tests-in-agent-sandboxes).

#### Starting Chrome without the launcher

A script that runs the Chrome binary itself, rather than through Astral or the
integration browser launcher, passes `--use-mock-keychain` and
`--password-store=basic`. Without `--use-mock-keychain`, Chrome on macOS can
show the developer a keychain password dialog
([details](docs/development/TESTING.md#starting-chrome-without-the-launcher)).

## Instructions for committing to this repository

Before committing, squashing, or otherwise getting a branch ready to be reviewed
or landed: Execute repo-wide `deno fmt --check`, `deno lint` and
`deno task check`, and run all relevant tests. The type check is its own step: a
package's `test` task runs its tests, and whatever those happen to type-check on
the way is no substitute for checking the workspace. Patterns are the exception
`deno task check` does not own: `deno task cfcheck` is the authoritative pattern
type-check.

When babysitting a PR through CI, look for review comments in addition to failed
CI jobs. Cubic reviews nearly every PR here, and its review lands a few minutes
after each push, so wait for it before concluding a PR has none. Read its
findings with `gh api --paginate repos/commonfabric/labs/pulls/<n>/comments`;
they are inline review comments, which `gh pr view` does not return.
`docs/development/pr-review-comments.md` covers the rest. When facing
difficulties getting coverage checks to pass, consider the information in
`docs/development/COVERAGE.md`.

### Automated gates

Each of these `deno task` gates fails CI on its own, and none of them runs as
part of `deno task check`.
[`docs/development/automated-gates.md`](docs/development/automated-gates.md)
says what each one catches and how `tasks/typecheck.ts` records the trees it
leaves out; read it when one fails, or before adding a check exemption.

- `check-no-waitfor` — an integration test that imports the polling `waitFor`
- `check-bench-workflow` — a benchmark the dashboard names that CI no longer
  runs
- `check-docs` — a TypeScript block under `docs/` that stopped compiling
- `check-docs-history-index` — a malformed or missing `docs/history/INDEX.md`
  entry
- `check-conflict-markers` — an unresolved merge-conflict marker
- `check-control-characters` — a literal control codepoint in tracked source
- `check-test-shuffle` — a test runner started without a shuffle seed
- `check-skill-facts` — a path or import cited by a skill, an `AGENTS.md`, a
  rule, or a hook script that stopped resolving
- `check-address-examples` — a written cell address the reference parser refuses
- `check-cfc-correspondence` — the runtime's CFC claims against the committed
  specification snapshot
- `check-verb-session-sync` — a command in the verb-session documents that its
  demo script does not back
- `check-single-copy-deps`, `check-unused-deps`, `check-deno-pins` — dependency
  declarations
- `check-package-cycles` — two packages that import each other
- `check-completion-slots` — a `cf` option or positional nobody decided about
  completing
- `check-command-docs` — a `cf` command or shuttle verb that no live document
  describes
- `check-local-program` — a program built from local files without
  `resolveLocalProgram`
- `check-baselines-append-only` — a pattern baseline deleted rather than added
  to
- `check-test-aliases` — a test-identity alias line edited, removed, duplicated,
  or cyclic
- `check-pattern-tiers` — a legacy or fixture pattern without its marker

The detail behind each gate also lives in `.claude/rules/`, one file per kind of
file it governs. Claude Code loads the matching rule on its own when it reads a
file the rule names; an agent without that mechanism reads the rules directly,
and `.claude/rules/README.md` says which covers what.
