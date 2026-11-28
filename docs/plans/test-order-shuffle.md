# Shuffled test order — what is left to build

Every test run in this repository reorders the tests it runs, seeded by the
Pacific day the commit under test was committed on.
[TESTING.md](../development/TESTING.md#every-test-run-shuffles-its-order) is
the reference for how that works and what it reaches. This plan carries the
two stages below. Stage 1 is built, and Stage 2 is not. Where Stage 2 names
something that already exists — the module every test file registers its tests
through, the seed in the test records — that thing is current, and the stage is
what would be built on it.

## Stage 1: a run under the next day's seed, a day ahead

Status: built.
[TESTING.md](../development/TESTING.md#tomorrows-seed-run-a-day-ahead)
describes it.

A workflow runs every CI test suite under the next Pacific day's seed, once
for each seed, the first time it finds that CI passed on the head of `main`.
It differs from the first design of this stage in two ways. It starts when CI
finishes on `main`, and at 11:17 UTC, which is early on a Pacific day in summer
and in winter, so one schedule entry serves the whole year and no step has to
check the Pacific hour. Its result is its conclusion: a failed test fails the
run.
Its records reach the store under their own seed, as the first design
proposed.

## Stage 2: reordering the cases inside a file

Status: not built. Measure before building.

`deno test --shuffle` reorders a run's files and each file's top-level
registrations. An `it()` inside a `describe()` is a step of the registration
that `describe()` made, and steps are not reordered. This repository asks for
one top-level `describe()` per file, so for most files the shuffle is a file
shuffle. Of 2591 test files in the tree, 1857 have exactly one top-level
`describe()` and no top-level `Deno.test()`; 213 have several top-level
`describe()` calls, and 514 register at least one `Deno.test()` directly.
Only the latter two groups have anything within a file for the flag to
reorder.

That matters more than a file count suggests, because Deno gives each test
file a realm of its own. Module-level state, singletons, globals and built-in
objects never pass from one file to another, so a file shuffle reaches only
what the process holds — environment variables, files, native libraries.
Everything else a test can leave behind for another test lives inside one
file. The first run under the shuffle bears that out: every order-dependent
test it found in the unit suites sat in a file with several top-level
registrations, and each failed because a sibling registration in the same
file ran first. For the 1857 files holding a single `describe()`, the same
kind of dependence between two `it()` calls is out of the shuffle's reach
today.

The place that would reach the rest already exists.
[`base/test-support/src/testing.ts`](../../base/test-support/src/testing.ts) is the
module every test file registers its tests through. Its `describe` already
collects what its body registers — its `it()` calls and its nested
`describe()` calls — into a tree before anything reaches Deno, and runs that
tree's tests as steps once the file has loaded. So no test file has to change,
and the question is only what order the module runs each group's children in.

What to add: run the children of each group in the seed's order rather than in
the order the body declared them. The hooks need no such treatment, since where
a `beforeEach()` sits in the body does not decide when it runs. A case's
identity is the chain of names around it joined with its own, which does not
depend on the order, so the run-record store and the skip list keep working
across the change.

Two things to get right, and the reason to measure before starting:

- A run that records nothing has to shuffle too, so the seed comes from the
  environment the runner sets (`CF_TEST_SHUFFLE_SEED`, or the commit's day),
  not from anything recording installs.
- A reader of a failing run sees cases in an order the file does not have.
  Each runner already prints its seed, which is what makes that order
  reproducible; whether it is also legible is worth checking on a real failure
  before committing to the change.

The measurement that decides it: run the suite once under a throwaway version
of that module which shuffles within a file, and count the tests that fail.
That number is the size of the debt the change would open, and it has to be
paid before the shuffle can be on by default. If it is a handful, fixing those
by hand and holding the line with the rule in
[unit-test-coding-style.md](../development/unit-test-coding-style.md#each-case-stands-on-its-own)
costs less than the change does. If it is large, the change is what stops
the next one arriving.
