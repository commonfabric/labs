---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Record of the deliberate contract break taken when book-recommendations' picks became new books with an optional link to the finished book each builds on, in place of a required link to a finished book."
---

# Book recommendations: a pick is a new book, not a finished one

`book-recommendations/main.tsx`'s result schema required each of the five
`picks` to carry `book`, a read-only link to a cell the run held whose value
has a `title` and an `author`. The run holds the `finishedBooks` list, the
`favoriteAuthors` list, and one cell per finished book, and only the last
match that shape, so every valid result recommended five books the reader had
already read. Measured live on Estuary,
2026-10-16, with the seeded demo: all five picks were rereads, each `why`
opening "A reread pick" or "Revisit".

A pick is now `{ title, author, why, basedOn? }`: the recommended book inline,
and `basedOn` a read-only link to the finished book the pick builds on, where
one does. The task text says a finished book is never a pick. The held-handle
flow the pattern demonstrates — a handle the model names becoming a labeled
link in the result document — moves from `book` to `basedOn`.

## What the proof reports

- `book-recommendations/main.tsx` and `seeded-live-demo.tsx`,
  `result.recommendation.result`, on every baseline each has: the result
  document's schema is held as an alternative there, and the recorded
  alternative's required `book` is gone.
- `book-recommendations/view.tsx`, `argument.state.result.picks[].title` and
  `result.state.result.picks[].book`, on its one baseline: the view takes the
  state it displays as an argument and returns it, so the break shows on both
  faces.

## What the break costs

A piece holding a result of the old shape shows five picks with no title or
author, since the view reads `title` and `author` inline. The pieces that hold
one are demonstration pieces in the labs repository's own spaces; none holds
reading history anyone keeps. `cf piece setsrc` refuses the update over them,
so each is replaced by a new piece.
