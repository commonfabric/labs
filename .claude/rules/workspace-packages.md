---
paths:
  - "deno.jsonc"
  - "packages/*/deno.jsonc"
---

# Workspace package configuration

## A test task hands its runner a seed to shuffle by

Every `deno test` in the workspace carries
`--shuffle=$(deno task -q test-seed)`, which resolves to the root `test-seed`
task from any directory in the checkout. `deno task check-test-shuffle` fails
on one that does not, and on a package whose `test` task reaches no runner it
knows shuffles.

Two things about that spelling are easy to get wrong. Write it exactly, since
`tasks/test-topology/deno-task.ts` recognizes that one string and takes it out
before reading the rest of the task; any other command substitution makes the
task unreadable, and the package loses the per-file granularity a
continuous-integration lane selects with. And a package that runs its tests
through a script of its own needs the script named in `RUNNERS` in
`tasks/check-test-shuffle.ts`, saying whether it shuffles in its own code or
forwards the flag to the `deno test` it starts.
[TESTING.md](../../docs/development/TESTING.md#every-test-run-shuffles-its-order)
covers what the shuffle reaches.

## Every package needs its own test task

A package's `deno.jsonc` must contain a `"tasks"` object with a `"test"` entry.
When the package has tests, that entry runs `tasks/run-member-tests.ts` over a
`"deno-test"` entry that runs the tests themselves — a `deno test` for most
packages, or a runner of the package's own; when it does not have them yet, it
is `"echo 'No tests defined.'"`.

This is not a tidiness rule. The root test runner (`tasks/test.ts`) walks every
workspace member and runs `deno task test` in each. A member with no `test`
task falls through to the root workspace's task, which is the whole suite —
so the suite would re-enter itself once per such package, spawning processes
exponentially. The runner reads every member's manifest before it runs any of
their test tasks, and refuses to start when one has no `test` entry, naming it,
so the symptom is that message rather than a hung job.

What the entry has to do is resolve in the package's own directory, and two
things follow. A `test` task defined by its `"dependencies"` alone satisfies
the rule, so the check asks whether the manifest declares the task at all —
a different question from the one `memberTestTask()` in
`tasks/workspace-tests.ts` answers, which is what command line the task runs,
and a dependencies-only task has none. And the manifest that has to carry the
entry is the one Deno resolves: a `deno.json` beside a `deno.jsonc` is taken
whole and the other file ignored, so a `test` task written in the ignored one
counts for nothing.

`packages/utils/deno.jsonc` is a correct minimal example.

## A new package is three edits

Adding the directory is not enough. The package path also goes into the
`"workspace"` array in the root `deno.jsonc`, or nothing in the repository
knows it exists.

The third edit is a checked path in `tasks/typecheck.ts`, so `deno task check`
opens the package at all. `tasks/typecheck.test.ts` walks the members that root
manifest declares, so the workspace edit is also what puts the package under
the type check's coverage claim: with no path naming it, and no
`UNCHECKED_TREES` entry saying why it has none, that test fails and names the
files. Most packages take a single directory entry.

## Declare dependencies at the narrowest scope

A dependency belongs in the `deno.jsonc` of the package that imports it, not at
the root. `docs/development/DEPENDENCIES.md` has the version-pin rules and the
reasoning. Three gates enforce parts of it, and all three are cheap to run
before you push:

- `deno task check-single-copy-deps` — one version of a dependency across the
  workspace.
- `deno task check-unused-deps` — nothing declared that nothing imports.
- `deno task check-deno-pins` — the accepted Deno range in `tasks/check.sh`
  still contains the pin in `mise.toml`.

## Two packages may not import each other

`deno task check-package-cycles` fails when a package's production source can
reach back to itself through another package. It counts an import by package
name and a relative path that climbs into another package alike, and it ignores
test code, which reaches wherever it needs to. It is the mechanical floor under
"Dependencies run downward" in `AGENTS.md`, and only the floor: a cycle is
caught, an import that merely runs up the stack is not. That paragraph's worked
example is where to put a module each side seems to want.

The cycles that predate the gate are listed in `ALLOWLIST` in
`tasks/check-package-cycles.ts`, each with what the two sides take from each
other. That list may only shrink: break one of those cycles and the gate fails
until its entry is deleted.
