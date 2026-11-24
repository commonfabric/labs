---
status: historical
created: 2026-10-17
archived: 2026-10-17
reason: "A census of the sinks the worker reconciler binds per rendered element on a thirty-message FabriChat room's cold load, October 2026, by binding site, element tag, property and what the property's stored value is; the one cut it supported without changing a render-policy decision, a literal style object read with its element's props, and the counts before and after it."
---

# What sinks the render binds per element on a FabriChat room's cold load, October 2026

A count of sink fires made the day before in a sibling investigation, whose
record (`2026-10-16-fabrichat-render-sink-fires.md`) was in a pull request of
its own when this one was written, found that the thirty-message room's cold
load binds 5,584 sinks, that no two of them read one view, and that each pays
a first fire: a descent of the view
tree from its document's root, the registration of its read set with the
scheduler, and two transactions. It left "fewer sinks per element" as the
lever inside the render. This record is the census that says which element
and which property each sink is bound for, and what one cut of them did.

## Setup

- The server: the toolshed binary the sibling investigation built from `main`
  at `e1f82339ed` with `EXPERIMENTAL_SERVER_EXECUTION=false` baked in, over a
  copy of its store, which already held the seeded room, on a port no other
  session held. Every change here is worker-side, so the server did not change
  between arms.
- The room: `packages/patterns/integration/fabrichat-room-seed.ts`, twelve
  members, thirty messages, one thread of five replies, a reaction every third
  message.
- The client: the throwaway harness of the cold-load records, opening a
  headless browser against a dev shell served from a checkout
  (`deno task dev-local` in `packages/shell`), signing in as the room's
  starter, attaching the worker profiler, and waiting for the last message and
  every member's badge. It writes the worker's CPU profile, the load summary
  and the worker's logger counts. Every load below is the room's second or
  later against that store.
- The counter: a temporary logger row in `packages/html/src/worker/reconciler.ts`
  at each place the reconciler binds a sink, carrying the binding site, the
  element's tag, the property's key where there is one, whether a render
  policy gates the element, the first segment and the length of the sunk
  cell's path, and for a property, what the props document stores at that
  key: a link, an object holding a link somewhere beneath it, an object
  holding none, or a primitive. A second row at a cell child's first fire
  carried what the child resolved to. The rows crossed the worker boundary as
  logger counts. Two loads of one tree gave identical counts.
- The arms: `main` at `fcdd1ae927` as before, and the same with the change
  below, each served from its own checkout on its own port against the one
  toolshed, loaded in two interleaved pairs (before, after, before, after).
- The machine: an M3 Max with sixteen cores, at a one-minute load of 25 to 45
  from other sessions' work throughout. Wall times and profile samples are
  noise at that load; the counts are the evidence.

## The census

5,504 sinks per load are the reconciler's own, its one root sink included,
bound at six sites. The 80 that count found beyond them are bound outside
the reconciler, the host's `cell:subscribe` sinks among them.

| Site                                                   | Sinks | Share |
| ------------------------------------------------------ | ----: | ----: |
| a cell child (`#renderCellChild`)                      | 1,877 |   34% |
| an element's props cell (`#bindCellProps`)             | 1,261 |   23% |
| an element's children cell (`#bindChildren`)           | 1,261 |   23% |
| one property read on its own (`#sinkAdmittedPropValue`) |   977 |   18% |
| a `$` binding's host read (`#bindCell`)                |   127 |    2% |
| the mounted root                                       |     1 |       |

Every element rendered under the room's policy is gated, and every element
read from a view takes the first three: the VDOM schema reads a node's
`props` and `children` as cells, and each item of `children` as a cell, so
one sink stands at each of those positions. 1,261 elements were rendered,
454 of them `cf-button`, 254 `span`, 218 `div`, 64 `cf-submit-input`, 63
`cf-hstack`, 53 `cf-profile-badge`, 46 `cf-vstack`, 34 `cf-text`, 30
`cf-hover-reveal`, 30 `cf-cfc-authorship`, 10 `cf-hover-card`, and six
others. That is about 42 elements per message, so about 84 structural sinks
per message before any child or property is counted.

The 1,877 cell-child sinks resolved to 1,218 nodes, 470 strings, 61 nulls,
42 arrays, 42 plain objects, 34 undefineds and 10 numbers. 1,286 of them are
bound at a path inside the row's own view document (first segment the
pattern's `[UI]` result, five to fifteen segments deep); 381 at the root of a
document reached through a link, which is where a computed's result or a
nested piece's view is read; 210 at positions inside a children document of
their own.

The 977 per-property sinks, by key and by what the props document stores
there:

| Property           | Stored value                 | Sinks |
| ------------------ | ---------------------------- | ----: |
| `style`            | an object holding no link    |   415 |
| `disabled`         | a link                       |   292 |
| `style`            | an object holding a link     |   210 |
| `revealed`         | a link                       |    30 |
| `aria-describedby` | a link                       |    10 |
| `variant`          | a link                       |    10 |
| `id`               | a link                       |    10 |

The 415 are the literal style objects the message row writes on its spans
(232), divs (121), stacks (32) and texts (30): `{ display: "flex", gap:
"0.5rem" }`, the emoji style on every reaction and quick-reaction button, and
the like. Under a render policy the reconciler gave every object-valued
`style` its own sink, read with schema `true`, so that the policy could decide
on the labels a read through a link inside the object consumes; it could not
tell a style holding a link from one holding none, since the element's props
read resolves both. The 210 are the styles whose `display` is a computed
(`editorDisplay`, `pickerDisplay`, `threadLinkDisplay` and the rights
displays), stored as a link. The 352 link-valued primitives are the row's
`disabled={cannotWrite}` on each of its buttons and inputs, `revealed` on each
hover-reveal, and the tallies' ids and variants: each links to the row's
argument or to a derived record, and each is decided on what its own read
consumes.

The 127 binding sinks are `$profile` on each message's badge and on the
members', `$value` and `$author` on each message's authorship boundary, and
`name` on the member buttons.

## What changed

A style object holding no link is a literal of the view, which the render
policy admitted when it admitted the view, and the element's props read
already resolves it in full through the VDOM schema's explicit `style` entry.
So under a policy the reconciler now sets such a style from the props read,
as it already set literal primitives, while a style holding a link keeps its
own read and decision. The props document the reconciler already reads raw to
find the properties stored as links tells the two apart. The literal-primitive
rule's own condition carries over unchanged: a literal is set directly only
while the policy admits the props object's own label, and every key is read
on its own while it does not, as when the props are linked from a document
of their own. The remote-load decision a literal style gets is the one a
literal primitive gets, against the props cell's labels. No decision on a
label a read consumed changed, because the read that was removed consumed
only the view document's own labels at the style's position, the labels the
view's admission was already decided on.

The row of `docs/specs/cfc-render-boundary-composition.md` that lists which
properties are read on their own says so now, and the ceiling test over
props and bindings pins both halves: a literal style set under a ceiling with
no sink at its own position, and a style holding a link read on its own.

## Before and after

| Per load                       | before-1 | after-1 | before-2 | after-2 |
| ------------------------------ | -------: | ------: | -------: | ------: |
| sinks the reconciler bound     |    5,504 |   5,089 |    5,504 |   5,089 |
| of them, `style` read alone    |      625 |     210 |      625 |     210 |
| action runs                    |    1,156 |   1,157 |    1,157 |   1,157 |
| `commitNative`                 |      190 |     190 |      190 |     190 |
| `resumeListChildSync`          |    1,663 |   1,663 |    1,663 |   1,663 |
| `resumeCellSync`               |      285 |     285 |      285 |     285 |
| `prepareCfc`                   |      614 |     615 |      615 |     615 |
| sign-in to last message, s     |     19.4 |    19.4 |     19.8 |    19.7 |

415 sinks per load, 7.5% of what the reconciler binds, are gone, and nothing
the load runs, commits or syncs changed. The profiles do not resolve the
change: at a one-minute load of 30 to 40 the busy samples of the four loads
run 20,515, 17,192, 18,905 and 14,810, and the samples under the sink action
(5,923, 6,101, 6,600, 3,582) move more between two loads of one arm than
between arms. The one bucket that moves with the arms is the deep traversal a
schema-`true` sink's first fire runs over its value, 143 → 71 and 126 → 55
samples, which is what those 415 sinks were.

## What is left, and why it is not this cut

The 4,399 structural sinks, 80% of the reconciler's, are the design: one
sink per position of the view, so that a write to one position of a view a
computed rebuilds, a literal string child or a property, re-fires the sink at
that position and nothing above it. Reading a subtree in one sink would hand
every change in it to the diffing update path instead, and would change what
the gated child sink's read consumes by the container positions it took in,
which is a decision on the render boundary and goes through the CFC
correspondence procedure. The per-element `children` sink is the
narrowest such change: 1,261 sinks whose read decides nothing (it carries no
consumed labels), bound only so that the array of child cells is reactive on
its own; folding it into the node's read adds the children container's own
position to what the child sink consumes, which is the same label as the
node's unless the view document labels that position on its own.

The 352 link-valued primitives are decided each on its own read because each
slot's labels govern it; ten of a row's buttons read the same `cannotWrite`
argument through ten slots. The 210 link-carrying styles are the same. The
1,877 cell-child sinks include 470 that resolve to a string literal stored
inline in the view, each deciding text integrity on its own cell.

The larger lever outside the render is unchanged from the cold-load records:
the per-row piece, thirty nested instances with their starts, commits and
session derivations.
