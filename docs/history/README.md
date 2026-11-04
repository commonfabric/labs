# Historical documentation

This tree holds point-in-time records: audit reports, migration notes,
investigation findings, profiling reports, executed or abandoned plans, and
designs that shipped and were superseded by the code itself. Each document's
value is as a record of what happened, what was found, or what was decided at
a moment. The live counterpart — documentation that must track the current
system — lives everywhere else; the split is explained in
[`../README.md`](../README.md).

The test for which is which: if the system changed, would someone edit this
document, or write a new one and leave this one alone? Edit it — it is live.
Write a new one — it is historical.

This README and [`INDEX.md`](INDEX.md) are the two live documents in the tree.
This one states the rules and must be kept accurate as they evolve; the index
lists every archived document. Neither carries a metadata header.

## Rules

- **Do not update these documents.** Their content is frozen at the moment
  they were archived. The only permitted edits are mechanical: fixing a link
  that broke because a file moved, or correcting the metadata header.
- **Do not cite them as descriptions of the current system.** A historical
  document was accurate when written; the code has moved on. When
  investigating current behavior, treat anything here as background only.
- **Do not "refresh" a historical document to make it current.** If the
  topic needs current documentation, write a live document in the
  appropriate place and, if useful, add a `superseded-by` key to the
  historical document's header.
- Code blocks in this tree are not type-checked by `deno task check-docs`;
  they reflect the API of their era.

## Layout

A document archived from `<path>` lives at `docs/history/<path>`, with a
leading `docs/` dropped. Examples:

- `docs/specs/compilation-cache.md` → `specs/compilation-cache.md`
- `runtime/cli/PLANNED_FIXES.md` → `runtime/cli/PLANNED_FIXES.md`
- `scripts/ralph/SOMETHING.md` → `scripts/ralph/SOMETHING.md`

A document keeps the path it was archived under when the file it came from
moves later. So `packages/` here holds what was archived from the packages
before they moved to `base/`, `runtime/`, `connectors/`, `dashboard/`, and
`patterns/`.

One more segment is dropped: when a document is absorbed from a local
`archive/` folder (the pre-history convention for keeping records next to
their live docs), the `archive/` segment is omitted, since this tree makes
those folders redundant.

New point-in-time artifacts (a report on work just completed, an audit, a
post-mortem) are created here directly, in the directory mirroring where
their subject lives.

## Metadata header

Every archived document in this tree starts with this header:

```text
---
status: historical
created: YYYY-MM-DD
archived: YYYY-MM-DD
reason: "<one line on why this document is historical>"
---
```

- `status: historical` — always exactly this.
- `created` — required; the date the document was originally written. Use
  the date stated in the document if it has one, otherwise the date of the
  git commit that first added it. A stated date that the git history
  contradicts (for example, a date months before the file first existed) is
  a typo in the document; use the git date and leave the frozen body as it
  is.
- `archived` — the date the document was moved here. For documents created
  here directly, the same as `created`.
- `reason` — required; one line saying why the document is a record rather
  than live documentation ("Executed plan; X shipped.", "Audit snapshot of
  Y.", "Superseded design; Z replaced it."). This is the line a reader uses
  to decide whether the document matters to them.
- `superseded-by: <repo-relative path>` — optional; points to the live
  document that replaced this one, if any exists.

If the document already has a frontmatter block (for example a MyST page),
add these keys at the top of that block instead of adding a second block.

## Index

[`INDEX.md`](INDEX.md) lists every archived document, one line each, grouped by
what kind of record it is. When you archive a document, or create one here,
add its line there.

Two constraints on that file are worth knowing before you edit it, because a
check enforces both and neither is guessable from looking at it:

- An entry is a single line, however long it runs. It is never wrapped, even
  though every other document in this repository wraps at 80 columns.
- The file holds nothing but its preamble, its section headings, and the
  entries. Notes, caveats, and explanations go in this README instead.

Both exist so that git can merge the index without a conflict. `.gitattributes`
gives it the built-in `union` merge driver, which combines what two branches
each added rather than stopping to ask. The driver works a line at a time, so a
wrapped entry can lose one of its lines to an identically worded line in
another entry, and a paragraph two branches both edit is kept twice. Restricting
the file to one-line entries takes both failures off the table: a line either
belongs to exactly one entry or is one of the fixed headings.

`deno task check-docs-history-index` checks the format, that every entry points
at something that exists, that no document is indexed twice, and that no
document in the tree is missing from the index. It runs in continuous
integration. An entry may point at a directory, which covers everything
beneath it — that is how the retired tutorial site and the server-side-execution
learning run are each carried by one line.

A directory covered that way still needs a way in for a reader, so its entry
links the document to start from as well.
