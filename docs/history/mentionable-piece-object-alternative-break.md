---
status: historical
created: 2026-11-19
archived: 2026-11-19
reason: "Decision record for removing the object alternative from MentionablePiece's mentionable property."
---

# `MentionablePiece.mentionable` loses its object alternative

`MentionablePiece` in `system/backlinks-index/backlinks-index.tsx` declared
`mentionable?: MentionablePiece[] | { get?: () => MentionablePiece[] }`. The
second alternative came from the first version of the backlinks index, which
read a piece's `mentionable` export directly and called `.get()` on it when it
was a cell. The schema generator drops the function-typed `get`, so the
alternative reached every recorded contract as `{ type: "object",
properties: {} }`: any object.

The property is now `mentionable?: MentionablePiece[]`. The compiled pattern
language refuses a function type in the value type of a cell
(`subset-type:function-in-data`), and the alternative put one into every type
that contains `MentionablePiece`.

## The break

Every pattern whose argument holds a `MentionablePiece` now accepts only an
array at `mentionable`, where its recorded contracts accepted an array or any
object. The compatibility proof reports `a schema alternative accepted
previously is not accepted by the candidate` at these paths:

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

Declared on Bernhard's decision (2026-11-19). The contracts of
`dev/default-app-ben`, `system/default-app`, `system/knowledge-graph` and
`system/summary-index`, which contain `MentionablePiece` but apply over their
baselines, are recorded beside it.
