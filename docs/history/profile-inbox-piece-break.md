---
status: historical
created: 2026-09-18
archived: 2026-09-18
reason: "Record of the deliberate contract break taken when the profile's share inbox pointer dropped its space and host fields for a link to the inbox piece, including the ruling under which the required home pattern takes the break."
---

# Profile: the share inbox pointer is a link to the inbox piece

`system/profile-home.tsx`'s `inbox` was `{ space, host }`: the DID of the
owner's share inbox space and the http(s) origin of the memory host it lives
on. It is `{ piece? }` now, where `piece` is a link to the owner's share inbox
piece — the `link@1` sigil naming the piece and its space — and `setInbox`
takes that link alone, or nothing to clear the pointer. The memory host is not
part of it: the inbox lives on the host the profile pointing at it lives on,
so a reader uses the host it read the profile from.

The link sits under a key rather than being the stored value itself. Measured
in the pattern test: a write to a cell whose document root holds a link goes
through the link into the piece it names, so a pointer stored bare was set
once and then every re-point wrote the next link into the first piece, and a
clear erased it. Under a key, a new link re-binds the slot and an omitted key
removes it, and both pieces the test pointed at keep their content.

## Why the pointer names the piece

Measured on a live install, an inbox space can hold several `Share inbox`
pieces — every re-mint adds one — and a sender that discovers the piece by
listing the space picks an arbitrary one, so an offer can land in a piece the
owner's reader never reads. Berni, 2026-09-18: "pointing to the piece instead
of the space seems right — such a link is effectively redundant since it
contains the space and the host (if it differs from where the link is written
to)".

An additive shape was measured first — the object kept, with an optional
`piece` id beside it — and Berni ruled it out the same day: "`inbox: {
space, host, piece? }` is an antipattern, let's not go there. Drop the current
inbox format and just send a link to the piece and that's it. It's backwards
incompatible, so apply the overrides."

## What the proof reports

The recorded object requires `space` and `host`, so no candidate without them
applies over any baseline that records it. The proof names one path per
pattern:

- `system/profile-home.tsx`, `result.inbox.host` — the first of the two
  fields that left — on both baselines that record the pointer.
- `system/profile-picker.tsx`, `argument.defaultProfile`, on both — the same
  path its earlier entry forgives for the pointer's arrival, so the two
  entries keep their baseline pairs disjoint.
- `system/home.tsx`, `result.defaultProfile`, on all five of its baselines
  that record the pointer.

`system/profile-create.tsx`, which takes the stored profiles as an argument,
reports the change compatible, and carries no entry.

## Why the required home pattern takes the break

Home is a required pattern: it updates every space's root aggressively and
unconditionally, and `pattern-break-registry-guards.ts` refuses an accepted
break naming one, because such a break strands every root the moment it
merges. Berni ruled the break in anyway, 2026-09-18: "you can make that an
allowed incompatible pattern update if you need to since other than Gideon no
one will have that version of setInbox." The guard gained a
`requiredPatternOverride` field for exactly this: an entry naming a required
pattern passes when it carries the ruling — who made it, when, and what it
said — and is refused when it does not. Home's entry carries this
ruling.

## What the break costs

A stored profile holding the old `{ space, host }` object still validates
against the candidate — the new object requires nothing, and the old fields
are extra properties — and reads as a pointer with no `piece`, so what the
break costs is the in-place update of a piece holding the old contract, not
the profile's readability. One install held a pointer of the old shape when
this shipped. A sender that read `inbox.space` and `inbox.host` reads
`inbox.piece` now — a link — and takes the space from it, and the host from
wherever it read the profile.
