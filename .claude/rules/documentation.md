---
paths:
  - "docs/**/*.md"
---

# Editing documentation

The full rules are in `docs/README.md`. These are the ones that are easiest to
break without noticing.

## `docs/history/` is a record, not a description

Never edit the content of a document under `docs/history/`. Its value is as a
record of what was true at a moment, so a correction destroys the thing it is
for. Two mechanical edits are permitted and no others: repointing a link whose
target moved, and fixing the metadata header.

A report, an audit, a post-mortem, or any account of completed work is created
in `docs/history/` from the start, with the metadata header defined in
`docs/history/README.md`. It is not written as a live document and archived
afterwards.

Every document there is listed in `docs/history/INDEX.md`, and two rules about
that file are not guessable from looking at it. An entry is a single line
however long it runs, and the file holds nothing besides its preamble, its
section headings, and the entries. Git merges it with the `union` driver so
that branches archiving documents at the same time do not conflict, and both
rules are what make that driver safe; `docs/history/README.md` gives the
reasoning. `deno task check-docs-history-index` enforces them, and also names
any document in the tree that no entry covers.

## Where a new live document goes

The map in `docs/README.md` says which directory holds what; read it rather
than guessing from the directory names. The part that is easy to skip is what
comes after: every directory has a `README.md` indexing it, and a document
missing from its index is a document nobody will find.

`deno task docs-links --orphan` names those. Run it after moving or renaming
more than one document; it is not a CI gate, so nothing else will tell you.

## Cell addresses here are parsed

`deno task check-address-examples` hands every rooted address a document writes
in backticks to the reference parser, and fails on one the parser refuses — a
spelling a grammar change retired, most often. It reaches skills and source
comments on the same terms.

A string written on purpose — the retired form quoted as retired, a spelling of
the shell's page URL, a grammar line with a hole in the scope slot — is
exempted by a directive naming it, inside an HTML comment so that it does not
render:

```text
<!-- check-address-examples-ignore: <the string> <why it is written> -->
```

The directive governs the file it sits in, wherever in that file it sits.
`docs/specs/cell-reference-grammar.md` carries one above its table of refused
forms. `tasks/check-address-examples.ts` states what counts as an address
example and what does not.

## Code blocks here are compiled

`deno task check-docs` type-checks the TypeScript and TSX blocks under `docs/`,
`docs/history/` excepted. Most blocks are fragments, so a block picks the
scaffold it compiles inside by opening with a context comment. That vocabulary
is defined in `docs/check.md` and cannot be worked out from the source. Run
`deno task check-docs` after touching a code block.
