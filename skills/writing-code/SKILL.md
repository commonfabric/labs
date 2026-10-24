---
name: writing-code
description: Conventions for writing or changing code in this repository — the two documents to read before the first edit, which document governs the thing you are about to touch, and which conventions no automated gate will catch. Use before writing, changing, or refactoring TypeScript anywhere in the tree. Patterns need `pattern-dev` as well; this skill covers what is true of all code here.
---

# Writing Code in Common Fabric

This skill is a **map**, not a recipe. It assumes you know how to write
TypeScript. What it supplies is the part you cannot derive from the tree: which
of this repository's documents governs what you are about to touch, and which of
its conventions nothing will catch for you.

All paths are relative to the repo root.

## Read these before your first edit

- `docs/development/DEVELOPMENT.md` — coding style and design principles. §
  Style & Conventions is the part that applies to every edit; § Code Design &
  Principles is the part a reviewer will hold a new abstraction to.
- `docs/development/code-comment-style.md` — how a comment is written, `//` and
  JSDoc alike. A comment describes the system as it stands, and nothing comes
  between a doc comment and the declaration it documents. Blank lines bound that
  pairing on both sides: one above the comment, one below the declaration.

Everything below this line is read-when-it-applies. Reach for it by what you are
doing, not by reading the list through.

## What governs what you are touching

- **Adding or reordering class members** — `docs/development/DEVELOPMENT.md`, §
  Classes.
- **Adding an import** — the same document, § Imports, for how imports are
  grouped and collated; `docs/development/imports.md` for what may not import
  what at all.
- **Writing a new file** — `docs/development/code-comment-style.md`, "File
  headers".
- **Writing or changing a test** — `docs/development/unit-test-coding-style.md`
  before the first one, and `docs/development/TESTING.md` for how the suites
  run. Not every file in the tree follows the conventions, so a neighbor is not
  evidence of them.
- **Making anything wait** — `docs/development/waiting-in-tests.md`. Avoiding
  timeouts, retry loops, and sleeps is a repository-wide principle, not a
  testing one.
- **Adding or changing an experimental flag** —
  `docs/development/EXPERIMENTAL_OPTIONS.md`, which is the registry as well as
  the guidance, and is updated in the same change.
- **Adding a dependency** — `docs/development/DEPENDENCIES.md`.
- **Adding a workspace package** — `.claude/rules/workspace-packages.md`. A
  missing `test` task is the edit most often forgotten; the root test runner
  refuses to start and names the package.
- **Writing a pattern** — the `pattern-dev` skill at
  `skills/pattern-dev/SKILL.md`, in addition to this one.
- **Changing behavior a live document describes** — `docs/README.md`. That
  document is part of your change, not a follow-up to it.

`docs/development/README.md` indexes the rest; `docs/features/README.md` indexes
one document per subsystem. Read the relevant one before changing a subsystem
you have not worked in before.

## The conventions nothing will catch

This is the part worth knowing by heart, because a green run is not evidence
about any of it. `deno fmt` settles line width, indent, semicolons, and quotes;
`deno lint` and `deno task check` settle types, untagged TODOs, and import
mechanics; the gates in `AGENTS.md`, § Automated gates settle the rest of what a
machine can settle. Everything here passes all of that and can still be wrong,
so it is the set a reviewer is left to find by reading. Tells include, for
example:

- **Class shape.** `#privateName` over TypeScript's `private`; a class exposes
  no enumerable properties; members run in the order § Classes gives. A
  `private` field type-checks clean and is still an own enumerable property. A
  test that needs a `#` member reaches it through an `accessForTestingOnly`
  getter, never through a cast on the instance; § Classes says how that getter
  is shaped and what it cannot cover.
- **Test-only exports.** Code a package offers only to other packages' tests
  goes behind its `./for-testing-only` export-map entry, in no barrel, each
  value export carrying a `ForTestingOnly` suffix (`_FOR_TESTING_ONLY` for an
  upper-case constant). Nothing checks that only tests and benchmarks import it.
  `docs/development/DEVELOPMENT.md`, § Offering test-only code to other
  packages, holds the rest.
- **Import grouping and collation.** Every specifier naming the same package
  sits in one contiguous run. Nothing sorts imports here.
- **Word choice.** American spelling, and one word per concept — this reaches
  comments, error and log messages, and test descriptions as much as it reaches
  documents. § Word choice holds the list.
- **What a comment is for.** A doc comment states the contract; mechanics go in
  `//`. A comment that litigates what the code does _not_ do, or narrates how it
  got here, is a comment to cut.
- **Layer direction.** Imports run down the pace layers in `AGENTS.md`. Only
  mutual cycles are gated, so an existing upward import is not a precedent.

## Before you push

`deno fmt --check`, `deno lint`, `deno task check`, and the `deno task test` of
every package you touched. Each misses what the others catch, and none of them
runs the separate gates listed under § Automated gates — `check-docs` among
them, which is why a TypeScript block in a document can break on a change that
never opened one.

Patterns are the exception `deno task check` does not own: `deno task cfcheck`
is the authoritative pattern type-check.

## When you think you are done

`skills/cf-review/SKILL.md` is the house reviewer, and self-review before
pushing is one of the things it is for. It holds code to the documents above —
so if it finds something here that this skill never pointed you at, that gap is
itself worth reporting.
