# The path reference

## Status

Ruled. The split is taken, and the five decisions below carry their rulings.
Nothing here is built.

## The problem

A cell's value holds links to other cells, and those cells hold links in turn.
Browsing means walking through them: into a field, across the link it holds,
into the document that cell keeps its inputs in, into a field of *that*. A
person doing this is somewhere, and wants to say where they are, go back out,
and hand the place to someone else.

A cell reference cannot say where they are. It names one cell and a position
inside it — space, piece, document, path, resolved in a single dereference,
which is what makes it canonical and shareable. (The cell reference grammar is
recorded in
[`cell-reference-grammar.md`](../../specs/cell-reference-grammar.md), and this
document cites its decisions by number.) It has one document slot because one is
enough for an address: reaching a second document's contents is two
dereferences, and an address describes the destination of the last one.

A route is the other thing. It is how the destination was reached, and it is
not recoverable from the destination.

The difference is not whether links are crossed. A path already crosses them:
`resolveLink` resolves to "a document that no longer has any links between the
top and the value at `link.path`", so a reference whose path runs through a
chain of links is valid and resolves. It is simply not the canonical spelling
of where it lands, because the destination has an address of its own. **Both
forms traverse. A cell reference forgets the crossings; a route remembers
them.**

## The split

Two forms, and neither replaces the other:

- A **cell reference** is where you are. Canonical, one per cell-and-position,
  shareable with anything that resolves references, and always derivable from
  the route.
- A **path reference** is how you got there. It carries the crossings the
  address forgets, and only shuttle needs it.

This is the split a shell already makes for symbolic links, and for the same
reasons. `pwd` prints the logical path and `pwd -P` the physical one; `cd ..`
from `/a/link-to-b/c` returns to `link-to-b` rather than to the real parent of
`b`. The logical path is kept because a user who walked in expects to walk back
out the way they came, and because two routes to one destination are different
places to someone browsing. The physical path is never lost — it is what the
route resolves to.

## What already exists

Shuttle keeps the route today and does not spell it. `place.ts` carries

```text
type Trail = readonly Position[];
```

described as "how shuttle reached it". A descent pushes the level it left onto
it; `..` walks back out through it; and `cd -` restores the previous place's
trail along with the place, so returning to where you were returns the route
that reached it. Nothing else reads it, and nothing prints it. So the ruling
below is not whether to model routes — shuttle models them and preserves them
across a `cd -`. It is whether to make that model renderable, typeable, and
complete enough to carry a link crossing.

Two facts make the fit close. A `Position` names a space, a piece and a path,
which is what a place is. And a link resolves to `NormalizedLink`, which is
`{ id, path, space, scope }` — a position and a scope, not a bare cell. So
crossing a link produces exactly what a trail already holds, and a trail of
positions is already the right container for a route.

## The shape

A path reference is an origin and a sequence of steps. Three kinds of step, of
which shuttle spells two today:

| Step | Meaning | Spelled today |
| --- | --- | --- |
| Descend | a key within the current document | `items/0/title` |
| Cross | follow a link a field holds, into the position it names | — |
| Enter | the current cell's other document | `#argument`, but only as a member on a piece segment or a relative head |

Descending is what `cd items/0` does now. Crossing is the new act. Entering
exists in the reference grammar and cannot recur there, because an address has
one document slot; a route needs it once per cell it passes through, which is
the whole reason a route is not an address.

## Decisions this needs

Each names what it costs and what I would rule. They are ordered so that an
earlier answer constrains a later one.

### 1. Is a crossing implicit or written?

A filesystem crosses a symbolic link without being asked: `cd link` works, and
nothing in the path says a boundary was passed. The alternative is a written
crossing, which makes a path reference say what it did.

**Ruled implicit.** `cd owner/name` should work whether `owner` holds a
record or a link, because a person browsing does not know which it is and the
distinction is not theirs to track. The crossing stays visible where it is
useful — a listing can mark which rows are links, and `where` can show the
crossings the current route made — rather than in every string anyone types.

The cost is that a path reference does not carry its own crossings in its
spelling, so it cannot be resolved without the fabric. That is already true of
a slug and is what distinguishes this form from an address.

### 2. How does the document axis recur?

After crossing into a cell, `#argument` has to mean *that* cell's arguments.
The reference grammar puts the member on a piece segment or a relative head,
before the path. In subsequent path segments, `#` is ordinary key data.

Two spellings, and both cost something:

- **As a path segment**, `owner/#argument/theme`. Reads in walking order and
  needs no new character. It respells `#`, which the reference grammar reserves
  on the piece segment or relative head, so a path reference and a cell
  reference would read `#` differently in the same position.
- **As a suffix on the crossing that produced the cell**,
  `owner#argument/theme`. Keeps `#` on the segment that names a cell,
  using the reference grammar's member suffix, and reads as "the
  arguments of what `owner` points at".

**Ruled the suffix.** It preserves one meaning per character across both
forms: `#` is a member introducer on a segment that names a cell, whether that
segment is a piece in an address or a crossing in a route. A person who learns
one has learned the other.

### 3. What does `..` do after a crossing?

**Ruled: back through the crossing**, to the field that held the link, not up
within the destination cell. That is the shell convention, it is what the
existing trail already implements for the moves shuttle has, and it is the
behavior that makes a route worth keeping at all — a `..` that ignores the
route makes the route decorative.

There is no other candidate, because a cell has no parent. Only a path has
one, by dropping its last segment. A crossing that lands at a cell's root
therefore has nothing above it but the crossing itself; one that lands at a
path inside the cell has a path-parent, and `..` still takes the crossing
rather than that parent, so the rule is the same either way.

### 4. What does `pwd` print?

`pwd` is ruled complete and pasteable, with no short form, the prompt being the
short surface. A route does not change that so much as split it: there are now
two complete answers, the route and the address.

**Ruled: `pwd` prints the route**, and the canonical address is a `where`
dimension rather than a `pwd` flag. `-P` would name it wrongly: it means the
same path physically resolved, and the address is not that — it is a different
address, a different piece with different segments, arrived at by forgetting
the route rather than by resolving it.

What `pwd` gets instead is a mode over the same route: how much of each
crossing to show. The route is the answer at every setting, and the settings
differ in annotation. The address stays what you hand to anything outside
shuttle, which is the property that made `pwd` complete in the first place, and
`where` is where it is printed.

### 5. What bounds a route?

An address cannot cycle. A route can: links may point back, so a walk can
revisit a cell and grow without limit. Nothing here should refuse a cycle —
walking in a circle is a legitimate thing to do and the fabric permits the
links — but a route that has revisited a position is worth *saying* so, and an
unbounded trail is worth a limit that is a limit on memory rather than on where
a person may go.

**Ruled**: no bound. Keep the whole route and let `where` note a revisited
position, since walking in a circle is a legitimate thing to do and a cap
chosen now would be a number nobody could defend.

## How this sits beside the cell reference grammar

It does not compete with it. Every place a route reaches has a cell reference,
and shuttle emits one for anything it hands outward — a link, a shared
address, an argument to `cf`. The route is a shuttle-local convenience for
walking and for saying where you are while you walk.

Three couplings are worth stating so they are not discovered later:

- **The renderer.** `renderPosition` is the single function in shuttle that
  hands a position to the shared renderer, `renderCellReference`, and what it
  writes is described in [`grammar.md`](grammar.md). A route's rendering must
  go through the same seam rather than compose its own, or the two forms
  drift.
- **The round trip.** The property that every name a listing prints is one `cd`
  takes back to that row must extend over routes, not just addresses. It is the
  test that would prove a route's spelling correct, and it exists already.
- **The document axis.** The reference grammar models the document as part of a
  context's location, between the piece and the path. Shuttle pins it to the
  result and varies the path below it. If a route can enter a document, that
  asymmetry closes on its own; if this is declined, the asymmetry stays and is
  worth recording as deliberate.

## Open questions

- **Typeable, not only printable.** Pasting a route back and having it work is
  wanted, and nothing argues against it — the round-trip property already
  drives exactly that for the forms shuttle prints today.
- **What does a listing show for a row that holds a link?** Marking it is
  cheap and is where the implicit crossing of decision 1 becomes visible. The
  form belongs with `ls`, not here.
- **`get` follows a link.** `cd` crossing implicitly and a read not following
  would be the surprise, and the alternative asks a person to split a path into
  the part `cd` takes and the part `get` takes, which nothing about the path
  tells them. Seeing the link itself stays available as a *mode* on the read
  rather than a second verb: `LastNode` is already `"value" | "writeRedirect" |
  "top"`, so stopping a resolution before a crossing is a supported act, and
  `--select '@'` already answers a position's address. What `set` does through
  a link is a separate question, and a real one, because a write-redirect link
  carries `overwrite: "redirect"` — it is about the write path, not this one.
