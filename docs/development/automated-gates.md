# Automated gates

This document describes how `deno task check` decides what to type-check, how
the trees it leaves out are recorded, and what each gate that fails CI on its
own catches. `AGENTS.md` lists the gates.

`deno task check` type-checks a hand-maintained list of paths in
`tasks/typecheck.ts` (`tasks/check.sh` owns the Deno version gate and delegates
there). The list is written by hand; its completeness is not left to hand.
`UNCHECKED_TREES` beside it records every tree the list leaves out together with
the reason, and `tasks/typecheck.test.ts` reads every file the repository holds
— workspace members, and the trees no member owns, such as `.claude/scripts` —
and fails, naming the files, on any module that is neither checked nor covered
by one of those entries or excluded by a manifest. That population is every
extension the checker opens, JavaScript included: `deno check` type-checks a
`.js` file carrying `// @ts-check`, so a claim stated over TypeScript alone
would be narrower than the gate it describes. A directory left out on purpose
and one left out by accident look identical in a list of paths, so the record is
what separates them: a tree nobody decided about fails the test rather than
passing in silence. Adding an exemption means adding an entry that says why.

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
other covers pattern tests, the `.test.tsx` files that `cf test` compiles
through the runtime harness the way a running pattern is compiled. That compile
is the behavior those tests exercise, and the harness reports a type error as a
failed test. Every other test file in the repository is named by a checked path,
because every `deno test` runs under `--no-check` and a checked path is then the
only type check a test file gets. An entry claiming coverage is the one that can
mislead most quietly, since a file it wrongly matches is one every later reader
believes is checked — and where these keep going wrong is a predicate matching
by a file's shape while the reason beside it names a lane, the two agreeing in
the middle and parting at the edges.

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
`cfcheck` suite of the test topology) type-checks every pattern in the JSX and
runtime-type environment they actually compile under, and is the authoritative
pattern type-check.

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
- `deno task check-cfc-correspondence` — the runtime's claim about which
  Contextual Flow Control specification it implements, held to the snapshot
  committed at `packages/runner/src/cfc/kernel/spec-snapshot.json`: a kernel
  function whose `@spec` header hash the snapshot no longer carries or that
  imports past the kernel, a manifest row in
  `packages/runner/src/cfc/kernel/manifest.ts` naming a function the snapshot
  lacks or a kernel symbol that does not exist, a `§` citation under
  `packages/runner/src/cfc/` naming a section the specification has not, or more
  than three `SPEC-PENDING` markers in the files it governs (`GOVERNED_SOURCE`
  in `tasks/check-cfc-correspondence.ts`), or one naming no specs pull request. The specification is private and the snapshot is what crosses:
  `deno task cfc-spec-snapshot` regenerates it from a specs checkout, and labs
  CI never reads the specification itself. A citation written on purpose to
  something else is recorded in `EXEMPTIONS` in the task, and an entry whose
  file stopped writing its citation fails the same way
- `deno task check-verb-session-sync` — a `cf` command or act reference in
  `docs/common/verbs/the-verb-session.md` or
  `docs/common/verbs/session-walkthrough.md` that its demo script does not back;
  both documents quote commands, never compose them
- `deno task check-single-copy-deps`, `check-unused-deps`, `check-deno-pins` —
  dependency declarations across the workspace
- `deno task check-package-cycles` — two packages that import each other, the
  part of the dependency direction in `AGENTS.md`, "Pace Layers", that a machine
  can settle
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
