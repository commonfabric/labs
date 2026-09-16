# Shuttle — live views

Satellite of [`README.md`](README.md): the full-screen half of the
hybrid — what opens, how it behaves, and what it reuses. Governs milestone
B3 of [`build-sequence.md`](build-sequence.md); the settle and lifecycle
disciplines it leans on are in
[`runtime-integration.md`](runtime-integration.md).

## Principles

- **A view is a lens, not a move.** Opening a view never changes the place;
  `q` returns to the prompt exactly where it was. Moving is always an
  explicit act (a `cd` from inside the view's command line).
- **Views are pure logic plus injected terminal deps**, the architecture
  `packages/cli/lib/view` already proves out: raw-mode terminal handling
  sits in one module, and state and key handling are pure and testable
  without a terminal.
- **Everything live obeys the settle discipline**: one repaint per quiet
  runtime (guard plus `idle()`), never a timer. A view's own sinks are
  canceled on exit; a watch's sink belongs to the watch, which outlives
  the view (see "Watches are session objects").
- **Views are live because reaching in warms** (the run-state rule). The
  deferred cold-browse mode ([`futures.md`](futures.md)) will reach into
  views when it lands — banner, labeled stored values, no sinks.

## The v1 views

**Value view** — `watch <ref>`. One cell or subtree, rendered as structured
JSON: scrollable, references followable, and live — the frame redraws as the
cell settles, so what it shows is what the cell holds now.

A changed value is to show the transition it made (`14 → 15`) in a row above
it, so that a change is seen rather than inferred. That row **stands until
another change replaces it rather than expiring**: nothing here waits on a
clock, and a row that took itself away would need one. That is a ruling and it
holds — what is deferred is the feature, not the decision. It needs a per-leaf
diff over arbitrary fabric values, and that is harder than it looks. Deciding
presence by indexing gets it wrong both ways. An absent key or index and one
holding `undefined` read the same, so a key holding `undefined` that went, or an
array that grew or shrank by an `undefined`, reads as no change. And a key named
for something `Object.prototype` carries reads as present on the side that does
not hold it, so a key that went reads as though it held the inherited member.
Comparing the leaves themselves needs fabric-aware equality, a special value
keeping its state in private fields. It returns when that diff has a test
surface of its own
([#7444](https://github.com/commonfabric/labs/issues/7444)).
Until then the frame shows the value and the event line above the prompt says
which cell changed.

**List view** — `browse [<ref>]`. A paged listing of whatever stands below
the reference — a facet, a collection, search results. Rows carry the same
`%n` handles the prompt uses; selection moves with arrows or `j`/`k`;
inserts and removals are reflected live and marked briefly. Entering a row
drills in place; leaving restores the parent's scroll and selection.

```text
┌ estuary/board/topics ─────────────── ● live ┐
│ %1  verb contracts        replies 14        │
│ %2  migration rehearsal   replies  3        │
│▸%3  co-presence rollout   replies  8    +   │
│ …                              14 of 16     │
│ : call %3 add-reply --body "shipped"        │
└ q back · enter drill · / search · : command ┘
```

There is no third view of a piece. What a piece is — its arguments, a
summary of its result, its callables with their doc annotations, and its
pattern identity — is one reading, and `describe` writes it as a page
(decision 26). A frame over the same four would add refreshing in place,
where a shell runs the line again, and scrolling, where `more` continues.
A *live* view of a piece is a different thing and is deferred whole
([`futures.md`](futures.md)).

## Watches are session objects

`watch <ref>` arms a watch — a session-level subscription with its own
handle — and opens the value view as one lens onto it. `q` closes the lens
and leaves the watch armed. While the prompt is up, an armed watch shows
its changes as **event lines**: each settled change appends one line —
`watch topics/3 @space: changed` — and the prompt is redrawn beneath it,
so cause and effect interleave in one transcript that doubles as a
record. (A pinned strip rendering armed watches live above the prompt is
designed and deferred: [`futures.md`](futures.md).)

`watches` lists what is armed (`where` shows it too); `unwatch <handle>`
disarms. Terminal output that has scrolled off is never mutated: liveness
lives in the event lines, and history stays append-only.

## Keys

Small, vim-flavored, and stable: `q` back to prompt; `j`/`k`/arrows
selection; `g`/`G` ends; `enter` drill, `backspace` up; `/` search within
the view, `n`/`N` next; `e` edit the selection in `$EDITOR` (the substrate
already suspends and restores the terminal for this); `:` opens the
command line.

`/` searches rather than narrows, and it searches the same way in every
view. Vim-flavored decides it: `/` finds and `n`/`N` step the matches in
every pager a person arrives here already knowing, and no such tool
narrows on it. Stable decides the rest — a key that narrowed a view of
rows and found in a view of one value would be a key a reader has to know
which view they are in before they can read, which is what the word is
there to prevent. So `/` takes what was typed and moves to the next place
in the view that holds it, `n` and `N` move to the next match and the
previous, wrapping, and the view says which match of how many it is on.

Narrowing is not a view key, and the reason is where narrowing belongs. A
view shows what a read returned; what the read returns is the read's own
question, and `--filter` is where the grammar already asks it — it says
which elements come back rather than what each holds
([`grammar.md`](grammar.md)), which is a narrowing shaped to the data
rather than to the text. It takes arrays today. A view reaches it through
`:` like any other line.

What a view must not grow instead is a narrowing shaped to the drawing. A
rendering of a value is a tree written as lines, and keeping only the
lines that match leaves something that is no longer that value's
rendering — a narrowing that cannot say what it returned. Should a view
ever want the key, it is sugar over a read that narrows, and whatever
shapes are worth narrowing beyond an array is that read's question to
answer once for every surface rather than a view's to answer for itself.

`e` edits the selected row where there is one, and the cell the view is
open on where there is not. `enter` and `backspace` drill, which needs a
cursor — a row the view is standing on, which a view of one value does not
have — so they belong to the views that carry one.

`:` is the general mechanism instead of a key per verb: any shuttle
command runs with the view's `%n` handles bound to its rows, and the view
repaints on the result. On `q`, the last view's handles stay valid at the
prompt (decision 17), so "look, leave, act" needs no retyping. The line
runs where a line typed at the prompt runs, under the same cancel, so one
line is in flight at a time whichever of the two took it, and what it
produced reaches the transcript the way every line's output does. The view
carries its first line, which is the acknowledgement rather than the
answer. A line that opens a view of its own is the one thing turned down:
one frame at a time, the line itself standing.

The command line is where a frame is typed at, and it is the only place
one is. A frame carries the cursor on that row while a line is open on it,
and hides the cursor otherwise — a frame that is read with a cursor
sitting on it reads as one that could be typed at.

The value view answers to the motions and the two ways out — `q` and
`ctrl-c`, `j`/`k` and the arrows, `g` and `G` — and to `/`, `n`/`N`, `e`
and `:`. `e` there is the cell the view watches, opened through the `edit`
verb. `enter` and `backspace` arrive with the list view, a value view
having a scroll position rather than the cursor they drill from.

## Reuse of the `cf view` substrate

`keys.ts` and `ansi.ts` are the terminal layer shuttle's views build on:
key decoding, and the escape vocabulary a frame is drawn in. `session.ts`
is the pattern to follow rather than import — shuttle views hold different
state — and `mod.ts` and `loadinput.ts` own the rest of `cf view`'s stdio,
probing whether stdout and stdin are terminals, writing plain output and
reading a piped document, which is one-shot-command concern a shell drives
for itself. Each is reached by a relative path: the shell is this package's
own code, so calling one of them costs no export entry
([`build-sequence.md`](build-sequence.md)).

`pager.ts` is not among them, and the reason is the keyboard rather than
the drawing. Its loop takes a single blocking `await tty.read(buf)` and
redraws from what that read returns, so it multiplexes nothing against the
keys: what else redraws it is a timer or a window resize, and a settled
runtime change is neither. Shuttle's prompt loop already multiplexes — it
races the keys against the line in flight — and, decisively, it *owns* the
key stream: one key it has asked for is one no view running beside it could
read. So a view is a state of that loop rather than a program beside it,
drawn through the terminal module the prompt already writes its lines
through. That holds for every view here, the list view and the piece
overview included.

## Live discipline

- A list view observes membership through a **raw-document subscription**:
  the collection doc under the rejecting selector, links parsed from the
  raw value — and sinks deeply only the rows on screen. Element cost is
  bounded by the visible page; membership is one document whose size
  grows with the collection's link array — the linear-in-links frame
  that replaces the element-closure shape behind the 89MB sync. A schema
  that looks shallow to a reader bounds the element closure but still
  delivers every element's root document, so this is the one place shuttle
  reads below `Cell.sink`; the seam
  (`SpaceReplica.sinkDocument`) exists but is unexercised. Issue
  [#6534](https://github.com/commonfabric/labs/issues/6534) carries the
  problem and the solution lanes. B3 opens by proving that seam on the
  remote path; if it disappoints, the fallback is a capped deep sink with
  an honest "watching first N" label.
- **The raw subscription serves the base scope only.**
  `SpaceReplica.sinkDocument` (`packages/runner/src/storage/v2.ts`) accepts
  no scope and keys its subscriber set with `docKey(uri, "space")` — the
  base instance — so under `@user` or `@session` it would watch base
  membership while the frame claimed to show an overlay. A list view
  therefore takes the raw subscription only when the ambient scope is the
  base, and the capped deep sink with its "watching first N" label under an
  overlay, where `Cell.sink` reads through the scope the cell carries. The
  keying vocabulary for the scope-aware version is already there — `docKey`
  takes an instance, and the load path passes
  `instance ?? normalizeCellScope(scope)` — so what has to grow a scope
  parameter is that one signature, not the storage model. #6534's seam must
  be scope-aware end to end before the raw path can serve an overlay.
- Guard-plus-`idle()` settling, per `renderVDomToHtml`'s form.
- The connection's state is visible in the frame (`● live`, cold banner,
  or a reconnecting marker), read from the relay B1 builds —
  the storage layer publishes no connection state today
  ([`runtime-integration.md`](runtime-integration.md)). On reconnect the
  memory client re-arms the watch itself, so the view resyncs and repaints
  without re-subscribing.

## Open questions

1. When a live view of a piece arrives — deferred whole
   ([`futures.md`](futures.md)), and deferred for its seam rather than its
   form. (The shallow-sink question is settled above: not expressible
   through `Cell.sink`; the raw-document seam and its proving gate are
   issue [#6534](https://github.com/commonfabric/labs/issues/6534).)
2. The pinned strip's layout — deferred with the strip itself
   ([`futures.md`](futures.md)).
