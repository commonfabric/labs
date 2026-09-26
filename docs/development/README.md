# Development

How to work in this repository: coding style, dependencies, running things
locally, testing, debugging, and the policies that govern continuous
integration.

Documents about a single feature, or about one aspect of the runtime, live in
[`../features/`](../features/README.md) instead. The rest of the tree is
mapped in [`../README.md`](../README.md).

## Start here

- [`DEVELOPMENT.md`](DEVELOPMENT.md) — coding standards, design principles,
  the word choice all prose here standardizes on, and the build and test
  workflow. Read this first
- [`code-comment-style.md`](code-comment-style.md) — how a comment is written:
  what earns one, the rule that a comment describes the system as it stands and
  the shapes that break it, the Markdown markup comments and error messages
  share, the `debugStr` template tag for putting a value into a message, and
  what a doc comment carries
- [`imports.md`](imports.md) — why a file's dependencies belong in its import
  list, the two lint rules that keep them there, and what earns a deferred
  `import()` the ignore directive that keeps it
- [`LOCAL_DEV_SERVERS.md`](LOCAL_DEV_SERVERS.md) — starting the local servers,
  and what to do when they misbehave. Use `dev-local` for the shell, not `dev`
- [`TESTING.md`](TESTING.md) — running the test suites, and how unit and
  integration tests are structured. This is the hub that links the other
  testing documents
- [`debugging/`](debugging/README.md) — the error reference and the debugging
  workflows, including a large catalog of specific gotchas

## Dependencies and configuration

- [`DEPENDENCIES.md`](DEPENDENCIES.md) — adding a dependency, rolling one,
  the version pins the repository requires, and how to diagnose a dependency
  failure
- [`CONFIGURATION.md`](CONFIGURATION.md) — a categorized guide to environment
  variables, build flags, command-line arguments, and developer tasks, with
  pointers to the schemas that actually define them
- [`EXPERIMENTAL_OPTIONS.md`](EXPERIMENTAL_OPTIONS.md) — the single registry
  of every experimental flag: what it gates, its default, its intended end
  state, and how it will be removed. Update it in the same change that adds,
  changes, or removes a flag

## Testing

- [`unit-test-coding-style.md`](unit-test-coding-style.md) — how a unit test
  file is shaped: where it goes and what it is named, how its `describe()` and
  `it()` blocks nest, which assertions to reach for, and the matcher traps
  that produce a test which cannot fail
- [`UI_TESTING.md`](UI_TESTING.md) — reaching into shadow DOM from an
  integration test, and why accessibility locators are the preferred way
- [`waiting-in-tests.md`](waiting-in-tests.md) — waiting on a real event
  rather than polling: which primitives to reach for, and the few places
  where a bounded poll is still the honest tool
- [`waiting-in-tests-rationale.md`](waiting-in-tests-rationale.md) — the
  argument and the case studies behind that guidance. Writing a test does not
  need it; changing the wait machinery itself does
- [`space-clone-rehearsal.md`](space-clone-rehearsal.md) — rehearsing a
  pattern update against a writable copy of a real space. Read this before
  running `setsrc` against a space that holds real data

## Continuous integration, deployment, and measurement

- [`pr-review-comments.md`](pr-review-comments.md) — reading the review
  comments on a pull request: the commands that list a reviewer's findings and
  tell you which threads are still open, which automated reviewers post here,
  and why `gh pr view` returns none of it
- [`deploying.md`](deploying.md) — how a commit reaches a host: which jobs
  deploy where, and the contract the bastion's deploy wrapper enforces on what
  they pass it. Read this before editing a deploy step, because that wrapper
  lives in the infra repository rather than this one
- [`staging-space-copy.md`](staging-space-copy.md) — how a *space* reaches a
  host: snapshotting one space's store and serving the copy from rapids, what
  installing it commits you to, and the questions a local clone answers more
  cheaply
- [`CI_PERFORMANCE.md`](CI_PERFORMANCE.md) — how continuous-integration wall
  time is tracked, the dials that govern the lanes, and when to move them
- [`COVERAGE.md`](COVERAGE.md) — the two coverage mechanisms, which suite
  collects which, and how to read the resulting numbers
- [`test-records.md`](test-records.md) — the record of every test execution:
  what gets recorded, the environment surface, opting a workstation in with
  a personal key, and reading the public store
- [`test-records-adoption.md`](test-records-adoption.md) — implementing the
  test-run record system in another repository of the organization: what is
  shared, what the repository adds, and the rules that are not optional
- [`test-selection.md`](test-selection.md) — what a test is worth running,
  how to ask why one did or did not run, where the dials are, and what the
  publisher does
- [`deno-coverage-guard-line-artifact.md`](deno-coverage-guard-line-artifact.md)
  — why `deno coverage` reports a one-line guard as uncovered whenever its
  branch is not taken
- [`BENCHMARKS.md`](BENCHMARKS.md) — how the `deno bench` files run in
  continuous integration, where the results are charted, what a bench
  file must do to be tracked, and the end-to-end benchmark that navigates a
  data-heavy board in a browser

## Priorities

- [`ENGINEERING_PRIORITIES.md`](ENGINEERING_PRIORITIES.md) — the dimensions
  along which our work reaches users, and the shared language for arguing
  about where to focus
- [`PERFORMANCE_PROGRAM.md`](PERFORMANCE_PROGRAM.md) — the speed dimension
  turned into measurements and candidate projects

## Skills and reference

- [`skill-authoring.md`](skill-authoring.md) — what belongs in a repo-local
  skill: the map and the values an agent cannot derive, rather than a
  procedure a capable model already follows
- [`skill-audit.md`](skill-audit.md) — the two mechanisms that keep the facts
  in a skill honest, including the `deno task check-skill-facts` tripwire
- [`runtime-glossary.md`](runtime-glossary.md) — the storage and memory
  vocabulary of the runtime, including the difference between a link and an
  `$alias` pattern binding. Pattern authors want the
  [author-facing glossary](../common/concepts/glossary.md) instead

## Tools

These are not documents but they belong in the same reach, because nothing
else in the tree names them.

- `deno task docs-links` (`scripts/docs-links.ts`) — the link graph of `docs/`.
  `--orphan` lists documents nothing links to, which is what an index entry
  someone forgot looks like from the outside; `--dot` and `--json` give the
  graph itself; `--html` writes a self-contained interactive viewer. Pass
  `--history` to include the archive, which is excluded by default. Useful
  when restructuring the tree, and largely beside the point otherwise
- `deno task check-docs` — type-checks the TypeScript and TSX blocks embedded
  in these documents. [`../check.md`](../check.md) defines the context comment
  a block uses to pick its scaffold
