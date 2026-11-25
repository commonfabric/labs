# Compiled pattern language: what has to hold before it ships

This document lists the checks the compiled pattern language (experimental
option `compiledPatterns`) has to pass before the option is turned on for
users, and where each check stands. It is the coordinator's draft for the
owner to edit: nothing in it is a ruling until the owner says so. The
branches and the open work are in
[compiled-pattern-language-handoff.md](compiled-pattern-language-handoff.md),
the rulings in [compiled-pattern-language.md](compiled-pattern-language.md).

The build has shown that the approach is faster where it was meant to be: an
edit of a Topics title and a FabriChat send take the same number of
evaluations and records at every size measured. It has not shown that a
compiled piece behaves as today's piece does for more than one user, or
across a restart, an update, or a switch of an existing piece. The checks
below are about that. A check is met when a command that anyone can run
exits 0 for it, or when the owner has ratified each difference it reports.

## 1. A compiled piece does what today's piece does

- Every pattern of the corpus under `patterns/` that the compiler accepts is
  run on both paths with the same events, by two principals that each hold
  a session, under clauses that differ between the principals. The two paths
  agree on which events commit and which are refused, on the values each
  principal reads afterwards, and on the labels stored at each position.
- Each difference is either a defect or a decision the owner has ratified,
  listed in one file with the pattern, the position and the reason. The
  comparison fails on a difference that is not in that file.
- The comparison also fails on any error state in a store dump, on either
  path, counted over every document and not by one message.

Where it stands: `compare/both-paths.ts` compares one principal's run on 14
hand-written scenarios and on the 28 corpus modules that declare a write
policy, and compares labels only under an option. No run has two principals
under differing clauses. The first use by two identities showed "Content
hidden by policy" to a topic's creator.

## 2. More than one user

- The real FabriChat room and the real Topics board, each with two users in
  two browsers, show each user what today's path shows: every message's
  author, every topic open to its creator and to a second member, no
  "Content hidden by policy" that today's path does not show.
- A value or a label of one principal is never stored in a document another
  principal reads. A test stores labels under clauses that differ between
  principals for each construct that reads a value of a narrower scope: a
  `wish`, a per-user or per-session cell, a per-element construct whose body
  reads one, and an instance a handler makes.

Where it stands: neither pattern has been run with two users under a test.
The review of 2026-11-25 found two places where one principal's label is
stored in a document of the space (P474, P476).

## 3. Cost follows demand

- A piece derives a scope instance only while something watches its
  documents. A session no client holds derives nothing and writes nothing.
- What one event writes does not grow with the number of sessions or
  principals the server has seen, and what a new session writes does not
  grow with the collection where today's path does not.
- No step grows with the size of a collection where today's path does not,
  measured in documents, bytes, writes, registrations and time, not in
  evaluations alone. The growth check compares all of them and fails when it
  has fewer than two sizes.

Where it stands: every session the server holds derives every topic, a
create writes about 132 + 5.4n documents at n topics, and a scoped
collection in a row writes one document per row and principal. The FabriChat
growth check compares nine counts and leaves out bytes, writes, documents
and time.

## 4. The life of a piece

- A serving runtime that starts over a space holding a compiled piece brings
  it up no slower than today's path does (Z90), and its peak memory is
  measured on the largest real board.
- An existing piece can be switched to the compiled path, and back.
- A compiled pattern can be updated (`cf piece setsrc`), with the same
  compatibility rules as today's path.
- A pattern the compiler refuses runs on today's path, and a failure of the
  compiler itself is reported as a failure and not as a refusal.

Where it stands: the first edit after a restart takes 8.5 s at 2,000 topics
against 2.3 s on today's path. No switch and no update of a compiled piece
exists. `cf piece new` treats a compiler crash as a refusal.

## 5. The language

- The forms the rulings name are built: `slice` for a window (Z92),
  `toSorted` for a sorted collection (Z93).
- The real FabriChat room, the real Topics board and Home compile with no
  stand-in and no rewritten copy.
- Every built-in and effect a corpus pattern uses is answered, or refused
  with a diagnostic that names it. The share of the corpus that runs
  compiled is reported with each change.

Where it stands: Z92 and Z93 are not built. The Topics board compiles as it
is; the FabriChat room and Home run as copies with stand-ins. Seven
built-ins and every effect other than five are unanswered.

## 6. Contextual Flow Control

- Every change that decides a label is classified under
  `docs/development/cfc-spec-correspondence.md` by someone other than its
  author, and a semantic gap has a specs pull request before it lands.
- The questions deferred under Z88 are each answered or accepted by the
  owner. Z99 and Z100 have gone through the specification.
- No test that asserted a refusal or a label was changed to assert its
  absence without a ruling that names it.

Where it stands: the deferred questions run to more than eighty. The review
of 2026-11-25 found the sidecar commit `854faa3f7f` and the marker
enrollment P476 classified as host arrangements where the repository's own
records make them semantic gaps, and four tests inverted to fit the first.

## 7. The server

- A serving worker runs only a program whose text it has checked against the
  identity the piece names, in every space.
- A compile on a server is bounded, runs outside the serving loop's wait,
  and cannot be made to serve one space's program to another.

Where it stands: the compile cache is keyed by the source document's id and
shared between spaces, with no check of the text against the id.

## 8. The record

- Every branch is pushed, and the stack is in pull requests small enough to
  review.
- The specification documents state what the code does: the decisions after
  P210 are in them and not only in `SPEC-NOTES.md`.
- Each provisional decision is ratified or withdrawn.
- Each round is reviewed by a reviewer that did not write it before its
  result counts, and each gate asserts what its name says.
- With the option off, nothing changes on today's path.

Where it stands: rounds twenty-one to twenty-nine are on one local branch.
About 280 provisional decisions await the owner. The first independent
review, of rounds twenty-five to twenty-nine, was on 2026-11-25.

## Order of work

1. The comparison of section 1, with two principals, as a standing gate.
2. Derivation by demand (section 3), which is also the likely cause of
   several findings under section 2.
3. The record (section 8): push, document, ratify.

The other sections follow from what the comparison reports.
