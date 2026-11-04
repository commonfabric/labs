# Documentation

How this repository writes things down: comments in code, and documents.

Every document in this repository is in one of two categories, and the
category determines whether the document may be edited. This applies to
`docs/`, to package-level documents inside each package, and to the documents
of the scripts under `scripts/`.

The test for which is which: if the system changed, would someone edit this
document, or write a new one and leave this one alone? Edit it — it is live.
Write a new one — it is historical.

## Comments in code

A comment carries what the code cannot say on its own. The code speaks for
itself, so a comment describes rather than defends it, and public interfaces
additionally carry descriptive JSDoc.

[`development/code-comment-style.md`](development/code-comment-style.md) is the
guide to both kinds: what earns a comment, what a doc comment carries, the
markup they share with error and log messages, and the shapes that make a
comment go stale or mislead. The word-choice rule below reaches comments too.

## Live documentation

Live documentation describes the repository as it is now, or work that is
still intended. Orientation documents and READMEs, concept guides and
tutorials, reference documentation, debugging guides, skills, specs that
govern current or planned behavior, and plans that have not yet been executed
are all live. Everything outside `docs/history/` is live.

Live documentation carries an obligation: **if you change behavior that a
live document describes, update that document in the same change.** A live
document that no longer matches the code is a bug. This applies to human and
AI contributors alike.

That obligation reaches only behavior some document already describes, so new
surface needs the other half of it: **a capability a caller can reach is
described somewhere a caller can find.** The two are not the same rule — nothing
is out of date when a command ships with no prose, because nothing claimed to
cover it, and the absence is visible only to someone who already knows the
command exists.

For the surfaces a caller types that half is mechanical:
`deno task check-command-docs` fails when a command the CLI accepts, or a verb
shuttle accepts, is described in no live document, and takes a recorded reason
instead where one genuinely needs none. Prose belongs with the code it
describes — the README of the package that implements the command, or the
feature document that owns the surface — which is where the gate looks.

## Historical documentation

[`docs/history/`](history/README.md) holds point-in-time records: audit
reports, migration notes, investigation findings, profiling reports, executed
or abandoned plans, and superseded designs. Their value is as a record of
what happened or what was known at a moment, so their content is **never
updated**. Each one carries a metadata header giving at least its creation
date. The rules and the header format are in
[`history/README.md`](history/README.md), and
[`history/INDEX.md`](history/INDEX.md) lists every document in the tree with a
line saying what it records.

## Moving a document from live to historical

A live document becomes historical when its status changes. Typical triggers:
a plan lands its last phase or is abandoned; a design ships and the document
now describes the change rather than the system; a report's measurements
describe code that no longer exists. When you notice this — most often
because your own change is what completed the plan — archive the document:

1. `git mv` it to `docs/history/<original path>`, dropping a leading `docs/`
   from the original path (so `docs/specs/foo.md` becomes
   `docs/history/specs/foo.md`, and `runtime/cli/BAR.md` becomes
   `docs/history/runtime/cli/BAR.md`).
2. Prepend the metadata header described in
   [`history/README.md`](history/README.md).
3. Fix references: repoint links elsewhere in the repo to the new path, and
   fix relative links inside the moved document so they still resolve. After
   that, an archived document receives only the edits
   [`history/README.md`](history/README.md) permits: mechanical link fixes
   and metadata-header corrections.
4. Add an entry for it to [`history/INDEX.md`](history/INDEX.md). An entry is
   a single line, however long it runs, and that file holds nothing but its
   preamble, its section headings, and the entries. Both rules are what let
   git merge concurrent additions to the index without a conflict;
   [`history/README.md`](history/README.md) explains the mechanism.

Step 4 is checked by `deno task check-docs-history-index`, which runs in
continuous integration: it enforces the shape of the index, and it names any
document in the tree that no entry covers.

Step 3 goes wrong quietly, and `deno task docs-links --orphan` names every
document nothing links to. It is worth running whenever you move or rename
more than one document at a time — see
[`development/README.md`](development/README.md#tools) for its other modes.

## Creating a new historical document

Reports, audits, post-mortems, and records of completed work should be
created directly in `docs/history/`, with the metadata header, rather than
created as live documents and archived later. A plan you intend to execute
starts in `docs/plans/` (a pending plan is live) and is archived when it is
done.

## Examples in documentation

An example that illustrates a general rule is invented. Donuts, glazes, and
flavors do the job, and code lifted from this repository does it worse for two
reasons that compound. Real code moves, and nothing about moving it brings
anyone back to the document that quoted it. And while it sits there it answers
searches for the identifier it names, with a hit that is not a use of it —
the same reason [the word-choice rule](#word-choice) exists, pointed at a
different target.

An example that documents a specific hazard is the exception, because the
hazard is the real thing: a guide to what goes wrong with a particular
function has to name that function. Such an example takes both costs
knowingly. `deno task check-docs` covers only the first half of the first one,
catching drift that stops the block compiling and never drift that compiles
and is no longer true.

## Word choice

Prose written here — comments, documents, error and log messages, test
descriptions — standardizes on one spelling per word (American: `behavior`,
`color`, `serialize`) and one word per concept (`returns`, not `answers`). A
search for a word then finds all of it, and two files stating the same kind of
fact read as though they do.

The rule, its carve-outs, and the list of settled pairs are in
[`development/DEVELOPMENT.md`](development/DEVELOPMENT.md#word-choice). It lives
with the coding standards because code is where it applies most; documents are
held to the same standard.

## Map of this tree

- [`why.md`](why.md) — what Common Fabric is for: the trust model it inverts,
  and which parts already run
- [`how.md`](how.md) — the same argument as code: what the compiler emits for
  an ordinary pattern, where the runtime checks the result, what the exits
  are, and what is not built yet
- [`inverting-the-physics-of-trust.md`](inverting-the-physics-of-trust.md) —
  the long form of the argument, including the hardware and the objections
- [`FAQ.md`](FAQ.md) — frequently asked questions with pointers to the
  authoritative answers
- [`common/`](common/README.md) — pattern-author documentation: concepts,
  components, conventions, workflows
- [`development/`](development/README.md) — how to work in this repository:
  style, dependencies, running things locally, testing, debugging, and the
  policies that govern continuous integration
- [`features/`](features/README.md) — one document per feature, or per aspect
  of the runtime: how it behaves and what to know before changing it
- [`specs/`](specs/README.md) — technical specifications of current and
  intended behavior
- [`plans/`](plans/README.md) — pending implementation plans
- [`tutorial/`](tutorial/README.md) — the two-part system tutorial
- [`history/`](history/README.md) — archived point-in-time records (see
  above), listed in [`history/INDEX.md`](history/INDEX.md)
- [`check.md`](check.md) — how the TypeScript code blocks embedded in these
  documents are type-checked in CI (`deno task check-docs`); `history/` is
  exempt
