# Mention references in cf-code-editor

A mention can take either of two forms in the document. The wiki-link form,
`[[Name (id)]]`, carries its destination inside the sentence and is described in
[`backlinks.md`](backlinks.md). The reference form carries a short local key
instead, and the destination lives in a cell the host pattern owns:

```text
Doc text:    I read [Attention Framework][a3f9zz] last night.

$references: { a3f9zz: { destination: <cell>, modifiedTitle: false } }
```

The editor mints reference-form mentions when it is given a `$references` cell,
and wiki-links when it is not. Both forms are read whichever way it was given,
so a document part-way through a migration works.

## What a key is

Six characters over `[0-9a-z]`, minted by `mintRefKey` (`core/mention-refs.ts`)
against the keys the map already holds and the keys already in the document. It
is local to one document and means nothing outside it, which is what lets it be
short.

## Membership, not shape, decides

A token is a mention when **the map holds its key**. A token that looks like one
but whose key the map does not hold is ordinary text: not styled, not protected,
not collected. This is what keeps a hand-written reference link —
`[the docs][readme]` — editable, and it is worth being deliberate about, because
the alternative rule is tempting and wrong. Deciding by shape would capture that
link, make its `][readme]` unreachable from the keyboard, and give the user no
way to fix it.

The cost is a window: a document whose text has loaded but whose map has not
shows its mentions as plain text until the map arrives. The `setKnownRefKeys`
effect is what closes it — the field reparses on the effect as well as on a
document change.

## The four CM6 building blocks

The same four the wiki-link form uses, over `features/mention-refs.ts`:

| Part                                 | Job                                              |
| ------------------------------------ | ------------------------------------------------ |
| `mentionRefField` (`StateField`)     | parses the document against the known keys       |
| `mentionRefEditFilter`               | blocks or truncates edits reaching into `][key]` |
| `atomicMentionRefRanges`             | the cursor skips `[` and `][key]`                |
| `createMentionRefDecorationPlugin()` | hides both, so the user sees a pill              |

Only `][key]` needs protecting. The label is ordinary text and stays fully
editable, which is the point of the form.

| Cursor position     | What the user sees             |
| ------------------- | ------------------------------ |
| Outside the mention | the label, styled as a pill    |
| Inside the mention  | `[Label]`, with the key hidden |

## `modifiedTitle`

A mention's label starts as the destination's name and is kept in step with it:
`_setupRefDestinationSubscriptions` subscribes to each destination, and a rename
elsewhere rewrites the label here.

That subscription is on the destination rather than on its `title`, and it is
what makes the name readable at all. A destination arrives as a bare link with
nothing cached, so reading NAME off it returns undefined until a subscription
under a schema naming NAME has delivered a value. The wiki-link form watches
`title` for the opposite reason — it writes NAME's source and would otherwise
hear its own echo — which does not arise here, because this form never writes
the destination.

Editing the label ends that. `_detectRefLabelChanges` compares the edited label
against the destination's current name, and sets `modifiedTitle` when they
differ — the user has chosen a wording, and a later rename leaves it alone.
Editing the label back into agreement clears the flag, so it tracks divergence
rather than accumulating a history of edits. Only the map write is conditional
on the flag changing: `mention-ref-label-changed` fires on every label edit,
including one custom wording replacing another.

A key whose destination is repointed at a different piece gets a new
subscription. `_setupRefDestinationSubscriptions` records the identity each
subscription was opened against, because a key-only check would keep listening
to the piece the mention used to name — rewriting this label on ITS rename, and
never hearing the new one's.

The destination is never renamed from here. In the wiki-link form editing a pill
writes `destination.title`, which makes every local wording a rename; in the
reference form the label is local and the destination is untouched.

## The short name a pill shows

A mention whose destination a row of the editor's universe stands for — a row of
`mentionable` whose piece is that destination — shows the row's `shortName`
beside the label, inside the pill: `42` for a member of a board that numbers its
members. A destination no row stands for shows no name, whatever `shortName` it
publishes for itself.

The row is found by identity: `_universeShortNames` compares the cell the
reference map names with the one the resolution pass recorded for each row, over
the whole of what tells two cells apart — document id, space, scope and path. A
document id alone would not, because one id names a document in every space that
holds it, and two paths into one document are two cells. The `cfcLabelView` a
ref may also carry is left out: it is a main-thread display copy that drifts
while CFC settles, so weighing it would leave a destination unrecognized for as
long as the drift lasted. The name comes from the row and is never read off the
destination, because the two answer different questions. What a destination
publishes is the name the collection that created it gave it, which means
something only to a reader reading through that collection. The row carries what
the collection publishing this universe calls the member, and a `#` query here
matches that copy, so a name on a pill is one a `#` query in the same editor
offers back for the same destination — as far as the query's grammar reaches,
the sigil taking digits, so a collection naming its members in words has those
names shown but not offered. That is the round trip
`docs/specs/collection-naming.md` asks of a rendered spelling, under "Choosing
the spelling".

A name is shown only while the editor can find it that way. A universe that
changes takes every pill's name away until its rows have resolved again, and
then shows what the rows say now. A mention whose universe is unbound, or which
is repointed at a destination no row stands for, loses its name as soon as the
editor learns of the change. The name does not wait on the destination's own
subscription, so a mention whose destination has not delivered its title yet
still shows it.

The document's own text does not change. The label is the person's wording and
the short name is display, which is what `docs/specs/collection-naming.md`
settles under "Rendering": a reference's spelling is computed from where it is
read and is never stored. The name reaches the view as a `setRefShortNames`
effect, is held in `refShortNameField`, and lands on the pill as a
`data-short-name` attribute the stylesheet renders.

Being display, it does not travel. Generated content sits in no text node, so
the number is absent from `textContent`, from a copy taken out of the editor,
and from anything reading the raw body — a copy carries the document's own text,
which is the label and the key. That is a bound rather than a gap: the spelling
a reference needs once it leaves is the fully qualified form
`docs/specs/collection-naming.md` describes under "Copying", which is a
clipboard flavor nothing here writes yet.

## Two triggers, one mention

`[[` opens a query over the universe's display names. `#` followed by digits
opens one over each row's own `shortName` — what the collection publishing the
universe calls that member. Both are sources of the same `autocompletion`
extension, both offer the same rows, and picking from either mints the same
reference-form mention. What differs is only what opens the query.

`shortName` is optional in the `Mentionable` contract
(`packages/ui/src/v2/core/mentionable.ts`), so a universe whose collection names
nothing offers nothing to a `#` query, and a member the collection has not named
is a row that query never reaches. The match is a PREFIX rather than a
substring, because a member name is a number and `4` offering `42` beside `14`
and `24` buries the one being typed. The `[[` query matches a row's `shortName`
as well as its display name, so someone who knows the number reaches the member
without switching sigils; what Enter completes there is unchanged, because an
exact match is still asked of the display name alone.

Enter does not complete a `#` query at all: it is picked from the list, or it
stays text. The `[[` handler's fallthrough CREATES a piece for a query that
matched nothing, and a stray `#7` must never create anything, so the sigil is
left out of that handler rather than given a branch inside it.

A sigil that does not open its token opens no query: `abc#4` is one word and
`##4` is no citation. The boundary is asked in Unicode letters, marks and
numbers rather than JavaScript's ASCII-only `\w`, because a member's names are
ASCII by the spec's decision but the prose around them is any script — `Ω#4` is
inside a word too. At least one digit is required, which is what keeps a
markdown heading from opening a query over every named member.

Nor does a sigil inside a gesture the backlink source owns. Anywhere within an
unclosed `[[…` the query is that source's — it reads back over the brackets and
extends across an auto-closed `]]`, which this one does not — and anywhere
inside an existing mention's label a completion would nest a token in a token.

## Collection

An entry whose token has left the document is removed by
`_collectUnreferencedRefEntries`. Only keys this editor saw when the document
loaded, or minted itself, are eligible: a key another client added while this
one was open is one this editor has no reason to think was ever in its document,
and the conservative reading keeps it.

Entries go **one key at a time**, not by writing back a filtered copy of the
map. A blind write of a snapshot takes any entry that arrived between the read
and the write down with it.

Collection also **flushes the content write first**, inverting the ordering an
insertion uses. The deletion that made an entry collectable is still sitting in
the content cell's debounce, or waiting on blur; dropping the entry now and then
losing that write to a disconnect leaves the durable document holding a token
whose destination is gone. Flushed first, the worst interruption leaves an
unreferenced entry, which the next collection takes.

The collector will not run against an empty document. A document that has not
loaded names nothing, which is not the same as a document that names nothing.

## Ordering, when a mention is made

The map entry is written **before** the token reaches the document. If only one
of the two writes lands, an entry no token names is inert, while a token no
entry resolves is a dead link.

Creating a piece for a novel mention cannot follow that order — there is no
destination until the create resolves. The token goes in first with a key the
map does not hold, so it reads as ordinary text for as long as the create takes,
and is unwound to the bare label if the create fails.

That window belongs to the user: an unresolved token is unprotected, so it can
be edited or deleted before the create returns. Both ends of the create
therefore find the token by its KEY (`_findRefToken`) rather than by the text
that was inserted, so an edited label still matches — and a token that has gone
means the mention was abandoned, so no entry is written for it.

A completion whose destination has not been resolved yet mints a **wiki-link
instead**. `mentionable.key(index)` addresses a position in a list rather than a
piece, and a mention persisted against that path would later name whatever moved
into the slot; the older form's id comes from the same resolution, so falling
back to it costs the form and not the target.

## A pasted URL

Pasting a piece's URL is how someone says "this one" when they have the link
rather than the name, and left as a URL it is invisible to everything that reads
mentions. In reference mode a paste that names a piece becomes one.

Which URLs name a piece is `parseFabricUrl` (`@commonfabric/runner/fabric-url`),
judged against this document's own host plus anything in `fabricHosts`. Two
cases deliberately paste as text: a URL naming its space by name rather than by
DID, which this side cannot resolve, and a slug, which addresses a redirect
document and would need a read before it could name the piece.

The label starts as the pasted text and becomes the destination's name when the
subscription delivers it. Nothing special does that: `modifiedTitle` is false,
so this is the same rewrite a rename gets.

## Pasted prose is left alone

Nothing scans prose for citations. A `#42` that arrives by paste — or one typed
and never completed — is ordinary text, and stays ordinary text however long the
document lives. The pasted URL above is the one exception, and it is the
exception for a reason that says why the rest is the rule: a URL names its
destination outright, while `#42` names a member of whichever collection is
being read through.

A mention is therefore made where an author picks a destination, and what gets
stored is the destination. That is `docs/specs/collection-naming.md` under
"Storage": references canonicalize on write, and the bare form is settled at
authoring time, in the context the author is typing in. Scanning later would
resolve it in whatever context the text ended up in, against a namespace that
has since grown — a `#42` written on one board and pasted into a note under
another would acquire a destination nobody chose.

## What the form gives up

`[[Name (id)]]` survives being copied anywhere. `[Label][a3f9zz]` means nothing
without the map, so text pasted into another document reads as ordinary text
there, and a consumer reading raw content sees a label with no destination.

A paste between two live documents is not recovered. The exported file is:
`note.tsx` emits the map as the markdown reference-definition block it
resembles, so a projected note is self-contained. That projection is read-only —
`writeFsFile` (`packages/fuse/cell-bridge.ts`) writes an entire edited body back
to `$FS.content`, and a note that accepted it would take its own generated
definitions in as text — and an edit arrives through the note's `editProjection`
verb instead, which reads the block back as its mentions.
