---
status: historical
created: 2026-11-20
archived: 2026-11-20
reason: "Decision record for the contract breaks from removing function-typed data and `any` from the system patterns."
---

# System patterns: no function types in data, no `any`

The compiled pattern language refuses a function type in the value type of a
cell (`subset-type:function-in-data`) and refuses `any` (`subset-type:any`).
One change removes both from the system patterns and the patterns that embed
them. Two of the edits narrow a recorded argument contract, and the pattern
update check reports them as breaks. The other changed contracts apply over
their recorded baselines and are recorded beside this one.

## `MentionablePiece.mentionable` loses its object alternative

`MentionablePiece` in `system/backlinks-index/backlinks-index.tsx` declared
`mentionable?: MentionablePiece[] | { get?: () => MentionablePiece[] }`. The
second alternative came from the first version of the backlinks index, which
read a piece's `mentionable` export directly and called `.get()` on it when it
was a cell. The schema generator drops the function-typed `get`, so the
alternative reached every recorded contract as `{ type: "object",
properties: {} }`: any object. It also put a function type into every type
that contains `MentionablePiece`.

The property is now `mentionable?: MentionablePiece[]`. Every pattern whose
argument holds a `MentionablePiece` now accepts only an array at
`mentionable`, where its recorded contracts accepted an array or any object.
The compatibility proof reports `a schema alternative accepted previously is
not accepted by the candidate` at these paths:

* `system/backlinks-index/backlinks-index.tsx`: `pieceRegistry[].mentionable`,
  and the same property under `pieceRegistry[].mentioned[]` and
  `pieceRegistry[].backlinks[]`.
* `apps/annotation/annotation.tsx`: `targetPiece`, `blockedBy[].targetPiece`
  and `blockedBy[].mentioned[].mentionable`.
* `system/omnibox-fab/omnibox-fab.tsx`: `mentionable[].mentionable`.
* `system/quick-capture/quick-capture.tsx`: `pieceRegistry[].mentionable`,
  against its oldest baseline only.

No stored state is stranded. What a piece stores at `mentionable` is a link to
the array its pattern exports, such as a notebook's `notes` or a calendar's
`events`, and the link resolves to that array. No pattern exports an object
there. The one reader, `computeMentionable` in the backlinks index, reads the
position with `piece.key("mentionable").get()` and skips any value that is not
an array.

## Suggestion: context entries are read as cells

`system/suggestion/suggestion.tsx` declared its `context` argument as
`{ [id: string]: any }`. It is now `Record<string, Writable<unknown>>`. That
is the type `llmDialog` declares for its own `context`
(`Record<string, AnyCell<any>>`), and the pattern passes the argument to
`llmDialog` unchanged. `Record<string, unknown>` does not type-check against
that parameter.

Each entry of the argument's schema now carries `asCell`. The compatibility
proof reports `argument.context.*: asCell changed` against the three recorded
baselines.

No stored state is stranded. A stored entry is either a literal or a link to
another cell, and either one reads as a cell: a literal becomes a cell holding
it. `llmDialog` reads each entry's value to show it to the model, as it read
the value before. The suggestion tests, and the tests of `daily-journal` and
`do-list`, which embed the pattern, pass with the change.

## Decision

Declared on Bernhard's decision (2026-11-19).
