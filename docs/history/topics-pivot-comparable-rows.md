---
status: historical
created: 2026-11-19
archived: 2026-11-19
reason: "Decision record for declaring the Topic pivot rows' references as comparable cells, and for the update proof accepting a comparable handle where a node declared no cell."
---

# Topic pivot rows as comparable cells

`TopicCrossrefRow` in `patterns/apps/topics/topic.tsx` declares its `topic` as
`ComparableCell<unknown>`, where it was `unknown`, and its `mentionedBy` as
`ComparableCell<unknown>[]`, a list of comparable cells, where it was
`unknown[]`. `TopicCrossrefIndex` declares its `source` a comparable cell, where
it was `unknown`. The `backlinksOf` lift declares the rows it reads the same
way. The stored rows are unchanged: the board writes the same links it wrote
before.

The update proof (`schemaSubsetIssue` in `runtime/piece/src/schema-compatibility.ts`)
accepts the change. In an argument contract or a link proof, a node that
declared no cell may become a comparable one, `asCell: ["comparable"]` with no
scope. Every other `asCell` change is still compared exactly, and so is every
change to a result's marker.

## Why the rows

`unknown` was meant to stop a reader of the pivot at each reference. A reader
in the runtime does stop there, but a query walk on the memory server does not:
a link it reaches under `unknown` is followed into the document behind it. Every
row's `topic` and every `mentionedBy` entry is a Topic piece. So each Topic's
argument, read under its own argument schema, carried every Topic's piece
document through `boardCrossrefs`.

That read is the one `cf piece call` and `cf piece step` make on a Topic, twice
for every comment, mention, link or edit an agent makes. Measured on a copy of
the Topics space (3,264 topics, labs `9d57d862d7`, server execution off), one
`topics comment` on one Topic:

| | `unknown` | cells |
|---|---:|---:|
| Incoming bytes, whole command | 275.4 MB | 12.6 MB |
| Largest response (the Topic's input) | 135.2 MB | 4.0 MB |
| Server time per Topic input sync | 1.45–2.05 s | 0.25–0.31 s |
| Wall time | 23.1 s | 8.4 s |

The lift's own declaration matters as well. With only the argument changed, the
Topic's input sync fell to 4 MB, but `backlinksOf` still read `mentionedBy` as
`unknown[]`, and the watches that loaded the pivot for it brought the mentioning
Topics' piece documents instead: 1,798 and 2,187 documents, two 35 MB responses.

`topic-board-pivot-sessions.test.ts` holds both reads to it. A fresh session
that reads one of four Topics' input under its piece's argument link holds none
of the other three pieces. A fresh session that reads the pivot through the
schema the compiled `backlinksOf` declares holds none of the four. The tests run
the current source only. Reverting the declarations by hand showed what they
guard: with the rows declared `unknown`, the first read held all four pieces;
with only the lift's `mentionedBy` declared `unknown[]` again, the second held
the two Topics that mention another.

## Why the proof

Under the exact comparison the proof made, a cell where the contract had none
read as "asCell changed" at each field. That had three costs:

- **Every deployed Topic would take this update forced**
  (`--dangerously-allow-incompatible-schema`), as the profile-picture update did
  ([topics-profile-picture-forced-update.md](topics-profile-picture-forced-update.md)).
- **`pattern-compat` would need an accepted break** over 26 recorded Topic
  contracts.
- **Linking a Topic's `boardCrossrefs` to the board's `crossrefs` would be
  refused from then on,** by `PiecesController.link` and `cf piece link`, which
  have no forced form. A result's schema keeps cell markers only for streams, so
  the board publishes its rows as `unknown` whatever it declares, and the
  Topic's demand would never match it. Four tests in
  `topic-board-pivot-sessions.test.ts` do this re-link, the rollout step that
  rebinds a Topic to the board's published pivot, and they failed.

None of those guards anything. A comparable handle says how a reader receives
the value at a node, as a reference it can compare with `equals` and track. It
does not change what is stored there or what the node accepts, and it writes
nothing, so every value the node held reads under it. `proveRebuiltContracts`
in `runtime/piece/src/ops/piece-controller.ts` already treats nested cell
wrappers this way on the rebuilt-link path: "a plain source may serve a
wrapper-declaring slot". The exception is narrower than that path, which
ignores every nested non-stream wrapper: it admits only `comparable`, only where
the node declared no cell, only without a scope, and only in an argument proof.
An argument proof reads from the previous contract, or a link's producer, to the
candidate, or the reader. A result proof reads the other way, from the candidate
to the previous contract, so there the same test would admit a result losing
its handle; a result's marker stays exact. A writable `cell` adds a
write-back the proof holds the source to, `readonly` and `opaque` change what a
reader can do with the value, and a scope changes which instance it reads, so
those stay compared exactly. The tests in `schema-compatibility.test.ts` hold
both sides of that line.

## Rejected alternatives

- **Forcing each Topic past the proof**, with an accepted break and a forced
  form of `link`. It would have worked, at the three costs above, and left the
  re-link forced for good.
- **Declaring the pivot fields opaque.** That measured 1.5 MB for the Topic's
  input instead of 4 MB, but `backlinksOf` reads through the pivot, so the
  Topic would need another way to reach its row.
- **Not following `unknown` in a query walk.** It would help every pattern, but
  it changes what a walk under `unknown` returns for every reader.
- **Waiting for the board on an indexed collection (#10025).** That removes the
  pivot, and this change with it. It is a larger change with its own rollout;
  this one is a stopgap until then.

## Rollout

Rehearsed on a copy of the live space, before the proof change, with each
Topic's update forced:

- A retarget of a Topic took a median of 0.6 s after a one-time compile of about
  11 s, so the whole space takes about 35 minutes.
- Topic 22's `referencedBy` was identical before and after.
- With the proof change, five more Topics took the update unforced.
- The board's update could not be applied at the space's size, onto this source
  or onto unmodified `main`. The update proof over its members sends a
  `session.watch.add` of 91,393 watches and a 21.5 MB `transact`, and the
  server refuses both as standing for more than `MAX_UNTRUSTED_MESSAGE_SLOTS`.
  Until the board moves, it creates new Topics on the previous Topic source.
