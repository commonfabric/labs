# Naming in collections

A collection may give its members names of its own: `42` for a member of a board
that calls itself `top`, written together as `top/42`. This document defines how
such a name is addressed and resolved, how a spelling is chosen for a given
reader, and what has to be in place before a collection can offer one.

It governs any collection that wants named members, not one kind of board.
Topics is the first customer; nothing here is specific to it.

**This standardizes the edges, not the policies.** A collection chooses its own
naming mechanism and its own rules about what its names mean over time. What is
standardized is the boundary around that choice — how a collection declares
itself, how its members are addressed and resolved, how a reference is stored,
and how a spelling is rendered — so that any consumer in the fabric can name and
cite a member without knowing how the collection arrived at the name.

The document is in two parts, and they are separable. **Addressing** is how a
name identifies a thing. **Abbreviation and citation** is how a name is spelled
for a particular reader in a particular place, which is sometimes shorter than
the name in full and sometimes longer.

---

# Part 1 — Addressing

## Three layers of name

An item carries up to three names at once, and they are not interchangeable.
Only the first is guaranteed to exist.

| Layer | Example | Who states the guarantee |
| --- | --- | --- |
| Identity | `fid1:…` | the fabric: immutable, never reused, never retargeted |
| Member name | `42` | the collection that owns it |
| Space-level name | `verb-contract-arc` | the space: mutable, non-unique, retargetable |

A **member name** is a collection's name for one of its members, and the term
carries no policy: it says who assigned the name, not what the name promises.
The identity is what a stored reference resolves to. A member name is what a
person cites, paired with the name of the collection that assigned it. A
space-level name is a convenience that may move. The layers differ in who owns
the guarantee rather than in how strong it is: a collection may hold its member
names to something stronger than a space holds its slugs, or to something
weaker, and a consumer learns which by asking rather than by assuming.

## Naming members is optional

Every item already has an identity, and that identity addresses it on its own,
from anywhere, with no collection involved. A collection whose members are
reached by identity alone needs nothing from this document. What follows applies
only when a collection wants its members addressable *through it*, under a name
a person can hold — and a collection may want that for some members and not
others.

## What a collection declares

A collection that wants named members declares five things, and beyond them it
is free.

1. **A name for itself** — what other things bind to in order to reach it.
2. **A forward resolution** — given a member name, the link it currently names.
3. **A reverse resolution** — given a member, the name this collection calls it
   by. A renderer cannot shorten anything without this direction, so it is part
   of the contract rather than a convenience.
4. **Member names that fit the shared grammar**, so that each survives a URL
   segment and a prose citation.
5. **The policy it holds those names to**, published rather than implied.

The fabric adds one constraint, and only one: **at any moment, a member name
resolves to at most one member.** A resolver returns a target or nothing; it
does not return a set, because a URL and a citation each address one thing. The
constraint says nothing about what happens across moments, and it does not
prevent a name from addressing something computed — only from addressing several
things at once.

## Policies a collection owns

What a name means over time belongs to the collection, and different collections
will decide differently for good reasons:

- whether a name is unique across the collection's whole history, or only among
  its current members
- whether a name is permanent, or may be retired, reassigned, or reused
- whether a retired name forwards to a successor, errors, or goes quiet
- whether a name is mutable, and who may change it
- whether a member has one name or several — aliases, deprecated spellings,
  per-audience or translated names
- whether a name addresses a stored member or something computed, such as a
  standing query over the collection
- who allocates — the collection, or the person creating the member
- when allocation happens — at creation, on first sight, or on request
- what a name is made of — a sequence, a random code, a human string, a
  derivation from content

None of these is settled here, and a collection need not give every member it
holds the same answers.

Two of them touch the contract above and are worth stating explicitly. A
collection that permits several names for one member still returns exactly one
from its reverse resolution: that answer is what the collection considers the
member's canonical name, and it is what a renderer will show. A collection whose
names may address computed targets satisfies the forward resolution the same way
as any other, because a computed target is still one target.

## What a consumer may assume

Only what the collection declares. Absent a declaration a consumer assumes
nothing: it stores the identity rather than the name, and it re-resolves a short
spelling before showing it. Both of those are required elsewhere in this
document for their own reasons, which is what makes an undeclared policy safe
rather than merely unknown — the conservative path is already the default path.

A consumer that needs to hold a name rather than an identity — a printed
citation, an external system, a message leaving the fabric — needs the
collection to promise permanence, and should say so plainly when it cannot get
one.

## Choosing a mechanism

Non-normative, for a collection author deciding.

A **monotonic sequence** is the strongest choice for a name people handle. `42`
is one chunk over an alphabet automatized in childhood; a four-character
alphanumeric code is four unrelated chunks, plus a case question and homoglyph
confusion between `0`/`O` and `1`/`l`. Spoken, a number survives a hallway
conversation and a code does not. A dense sequence also locates itself in time —
a low number is old, a high one recent — and it stays short, holding a working
collection at two or three digits for years where an uncoordinated scheme is
opaque from its first member and can never shrink. The price is an allocation
point.

A **random code** buys allocation without coordination, which suits a collection
whose members are created offline, or at a rate that makes a shared allocator
unattractive. It pays in memorability, and its density has to be chosen against
the collection's expected size rather than against aesthetics. Widening on
collision beats lengthening by default.

A **human string** suits a collection whose members are things people name
rather than count — pages, documents, entries with titles. It inherits the
questions a space-level name already faces: what a rename does, and what happens
when two people want the same word.

A **derivation from the member's own content or identity** needs no allocation
and is stable by construction, at the cost of being unmemorable and of needing
expanding the derivation when two collide.

An allocator's own placement is constrained: `Date.now()` and `Math.random()`
may be called in an `action()` or `handler()` but not in a derivation
(`docs/common/concepts/action.md`), so a mechanism reading a clock or randomness
allocates on the write path, never in a computed view of the collection.

**Allocating on first sight rather than at creation** is worth weighing
whichever mechanism is chosen. A member receives its identity when it is
created; if its name may arrive later, allocation never blocks creation and can
be retroactive, and a member without a name yet still exists, still links, and
still opens.

### If the mechanism needs a shared allocator

Appends to a collection merge: Tier-2 conflict detection is path-aware, so
concurrent writes to distinct keys of the same container do not collide
(`docs/specs/memory-v2/08-conflict-granularity.md`). A map keyed by member name
inherits that. A shared counter does not — it is a same-path read and write, so
concurrent allocations serialize through one retry under `editWithRetry`. That
is the whole cost, and a collection that finds it too high has the uncoordinated
mechanisms above.

## Names resolve through collections

A space is the root namespace. Any collection inside it may host a namespace of
its own, and a name resolves by walking segments:

```text
<space>/top/42                  a member of a collection that numbers
<space>/docs/getting-started    a member named by a person
<space>/verb-arc                a space-level slug
```

Slugs generalize from space-scoped to collection-scoped. The grammar, the
derivation, and the claim semantics are the same one level down; only the scope
of the lookup changes. The derivation matters to anything built here: a slug
lives at an id derived from its name (`slugIdForSpace`,
`packages/runner/src/slugs.ts`), so it is addressable without a registry and
unenumerable without one. A space carries a separate index for that reason, and
the index is worth copying twice over — it is written one key at a time, so two
clients naming different things merge rather than racing, and it is honest that
it is a lower bound, listing only what was assigned since it existed. Anything
that checks what a name would collide with inherits that limit. A collection
needs no name registry and no new document type. A collection's name is a slug
that points at it, and a member name is a name that collection resolves.

**The collection resolves its own members, not the piece containing it.** A
piece holding three collections is not one namespace with internal routing; it
is three collections, each declaring its own name. A slug may point at a
collection nested inside a piece rather than at a piece root, which is what
makes this addressable without a new mechanism — `setPieceSlug`
(`packages/cli/lib/piece.ts`) accepts a source path and links the cell at that
path.

### Items contain collections

An item is not itself a collection. It may hold collections, and a segment after
an item addresses one of them:

```text
<space>/top/42/comments/7
```

A collection an item holds is one of its fields, so naming the collection and
naming the field are the same act, and the segment after an item stays what it
already is — a path into that item. Depth is uniform and unbounded, and it needs
no second mechanism.

An item's fields and a collection's member names are different namespaces, and
the segment after an item belongs to the fields. Keeping an item out of the
collection role is what holds them apart: a member name never competes for that
segment, so adding a field to an item's schema cannot change what an existing
name resolves to. The collection segment is always written, and compression
belongs to prose, which has a sigil and a round-trip check.

The shell does not yet resolve nested collection addresses such as
`<space>/top/42/comments/7`. It reads one member after a collection's name and
refuses an address carrying segments past that member, naming them, so the
address above states the design rather than one that opens today.

## Resolution scope

A name resolves through a scope chain, innermost first:

1. the containing collection's own declared name
2. other collections bound in that scope
3. the reader's home-space bindings
4. space-level slugs

This is ordinary lexical scope, and rungs three and four are the same mechanism
in two spaces. **A person's binding is a slug in their home space.** Subscribing
to a collection is assigning that slug; the resolver already follows a slug
whose target lives in another space, so a name in a reader's own space reaches a
collection anywhere. A binding in a person's own space is also the one place
where nobody else is renaming things
(`docs/common/conventions/HOME_SPACE.md`).

The chain resolves a reference's **leading** segment. Every segment after it
resolves within whatever the one before produced, so a nested reference walks
rather than searching again. A person's own binding and a space-level slug are
the same kind of thing reached at different rungs, so a reader who has bound a
name uses it and a reader who has not falls through to the space.

### A worked example

The board lives in space `topics-dev`, and its own space carries a slug naming
it:

```text
cf piece set-slug --space topics-dev top fid1:<board>
```

Anyone can now reach member 42 as `topics-dev/top/42`, with no setup of their
own. Written as a citation, fully qualified, that is `#@topics-dev/top/42`.

A person who works with that board every day binds a name to it in their own
home space. That binding is a slug like any other, but its target lives in
another space, and an entity id does not carry the space it belongs to:
`setPieceSlug` (`packages/cli/lib/piece.ts`) builds its target in the space it
was given, so this binding needs the cross-space target that step 2 of the road
below adds. The resolver is already ready for it — a slug's redirect is followed
into the space the target link names.

Once that binding exists, they write `#top/42`, because `top` resolves at their
own rung of the chain. Someone who bound it as `work` writes `#work/42` and
reaches the same member. Neither has to agree with the other, and neither has to
agree with the board's own name for itself, because what gets stored is
canonical and what gets displayed is computed per reader.

Reading through the board itself, the same member is `#42`: the containing
collection is the innermost rung, and it needs no name at all.

### Scope, then member

The last segment of a reference names a member. Before it comes an optional
space segment, marked with `@`, and then one or more collection segments; only
the first collection segment consults the chain, and each one after it resolves
within what the previous produced. A collection name and a member name therefore
never compete for a position, and no rule is needed to tell them apart.

### Nothing hidden decides what a name means

If a bare name is ambiguous, it is an error, or it is settled by an explicit,
visible, editable binding. Recency may order a picker; it may never decide the
meaning of text. A reference whose meaning depends on invisible state means
different things on different days, and nothing in the string says which.

## Character set

Names are ASCII: lowercase letters, digits, and single hyphens between words, as
the space-level slug grammar already requires (`packages/runner/src/slugs.ts`).
A name is compared by exact string equality, which keeps resolution total and
cheap.

`/` is the only structural separator. A name's own characters cannot carry
structure: hyphens are legal inside a name, and a collection chooses what its
members are called, so nothing about a name's shape says where one name ends and
the next begins. Separating segments with a character no name may contain is
what keeps parsing independent of naming.

Fixing the character set is a decision with a cost, taken deliberately: it makes
names in other scripts second-class, and widening it later reaches every stored
name. The widening is not only a grammar change. Admitting other scripts admits
confusables, and a confusable name is a spoofing vector — so a normalization
and confusable policy has to exist before the first non-ASCII name, not after.

---

# Part 2 — Abbreviation and citation

## Prose and URLs

Both forms separate scope from name with `/`, and a segment means the same thing
in each. Two things differ.

A prose reference carries a sigil, which marks where the reference begins and
ends in running text. A URL needs no such mark, because the whole string is the
reference.

A prose reference may lean on the reader's own bindings. A URL may not: it
travels, and whoever receives it has no access to the bindings that made it
short.

> Compress against what the reader already has; qualify whenever the reference
> travels.

| Form | Means |
| --- | --- |
| `#42` | member 42 of the collection being read through |
| `#top/42` | member 42 of the collection named `top` in scope |
| `#@<space>/top/42` | fully qualified; depends on no binding |

A leading `@` marks a space segment, matching what `asSpaceSegment`
(`packages/runner/src/fabric-url.ts`) already recognizes, and it keeps a binding
name and a space name from competing for the same slot. A space name is
universal rather than personal: `createSession`
(`packages/identity/src/session.ts`) derives a space's DID from a fixed public
passphrase and the name, so the same name resolves to the same space for
everyone, with no registry and no subscription. That is what makes the fully
qualified form depend on nobody.

`#` cannot appear in the URL form, where it delimits the fragment. The prose
form and the URL form differ by construction, and the canonical URL carries the
name in its segments, so nothing is lost between them.

### The bare form

`#42` names no collection. It is relative, and what it is relative *to* is the
rendering context — the collection a reader is reading through. The item the
text sits in does not settle it: an item may be a member of several collections
at once, so its own membership says nothing about which collection a bare form
addresses.

A context reading through exactly one collection gives the bare form its
meaning. A context that does not — a view holding several collections, or any
surface where the reader's path in is unknown — makes it an error rather than a
guess.

An author's context settles it the same way. Typing `#42` while reading through
a collection resolves against that collection, and canonicalizing on write
stores the result, so the bare form never has to be re-decided later.

### The compact form

A collection may offer a second spelling that joins its name to a member's with
a hyphen — `#top-42` beside `#top/42`. It is an option, it is a spelling only,
and it changes nothing about the resolver's grammar or the canonical form.

The form exists because a single token travels where a path does not. A git
branch name, an external tracker, a filename, a sentence read aloud: each takes
`top-42` more readily than `top/42`, which reads as a location rather than a
name.

A collection is eligible only if it declares that its member names cannot
contain a hyphen. A collection that numbers its members qualifies; one naming
them `getting-started` does not, because `#docs-getting-started` has no single
reading.

Reading a compact form is a lookup rather than a parse. The candidate splits are
tried and exactly one must resolve. Offering the form claims nothing in the
space's namespace, so a space-level name shaped like a compact form is simply
another candidate; where more than one resolves, the reader is asked. A person
choosing is not a hidden rule, and nothing is at risk in the asking, because
canonicalizing on write means an ambiguous input never becomes a stored
reference.

A renderer may prefer the compact form for a collection that offers one. None
offers it yet, so the flag a collection declares eligibility with — `compact` —
is reserved: setting it states that this collection's member names hold no
hyphen, and nothing reads the statement
([#6986](https://github.com/commonfabric/labs/issues/6986)).

## Rendering

A stored reference is canonical, so its spelling is free. **A renderer computes
the spelling from the reader's context and never stores it.** The same reference
renders as `#42` inside its own collection, `#top/42` for a reader who has bound
`top` to it, `#work/42` for a reader who bound it as `work`, and fully qualified
for a reader with no binding at all.

This is what makes a curated set of bindings safe. Brevity is earned by the
reader's own bindings; a reader without them sees more qualification; nobody
sees a wrong name.

The invariant: **a reader's bindings change how a reference is spelled, never
what it means.** Rendering is a spelling function over a fixed target, not a
resolution step. Adding a binding shortens existing text without moving
anything.

### Choosing the spelling

Not by rules about context, but by round trip: try spellings shortest to
longest, and use the first that, re-resolved under this reader's resolver,
returns the identical target. A short form is displayed only when re-resolving
it provably comes back to the same item. This is also what makes a short
spelling safe for a collection whose names may move: a spelling that no longer
round-trips is not shown.

The bare form needs no special handling here, because its own resolution rule
already confines it: it means something only where the reader is reading through
the collection that holds the member, which is the one context where it is also
the shortest spelling that round trips. What keeps a reference safe once it
leaves that context is the portable mode below, not a restriction on how short
an in-place spelling may be.

### The name a member publishes

A member may publish a name of its own, so that a consumer holding the member
has one without a lookup. It publishes **at most one**, and it is the name of
the collection that created it. A member that several collections name carries
nothing from the others, and a consumer wanting what one of those calls it asks
that collection's reverse resolution instead of reading the member.

A published name is a spelling and not a resolution. It says what one collection
calls the member; it settles nothing about which collection a reference
addresses, which stays the reading context's question.

A renderer that shows a published name in place of a round trip takes that limit
on. The editor's mention pill makes its name a round trip through the universe
the editor completes mentions from. It shows a name only where the mention's
destination is a row of that universe, found by identity, and the name it shows
is that row's rather than anything the destination publishes. So a shown name is
one a `#` query in the same editor offers back for the same destination, as far
as that query's grammar reaches: the sigil takes digits, so a collection naming
its members in words has those names shown on a pill but not offered by the
query. Widening that is a question for the query grammar rather than for the
renderer, which shows what the row carries either way. A destination the
universe does not list shows no name, whatever it publishes.

### Two modes, chosen by destination

- **In place** — read inside the application. Adaptive shortest spelling.
- **Portable** — export, copy-as-markdown, print, anything generated to leave.
  Always fully qualified, whatever the renderer's context.

The mode follows where the output is going, not what the content is. Surfaces
designed to travel never emit a context-dependent spelling.

### Copying

A copy carries several representations, and each is set deliberately:

| Flavor | Contents | Lands in |
| --- | --- | --- |
| `text/html` | an anchor to the canonical URL, labeled with the short form | rich editors |
| `text/plain` | the canonical URL | terminals, commit messages, chat |

The plain-text flavor is the lossy channel, so it carries the self-contained
form rather than the displayed one. The canonical URL is the qualified name plus
a host, so the name stays legible in pasted text and resolves where no resolver
exists.

Screenshots, speech, and retyping carry only what is visible, and neither a
clipboard flavor nor a render mode reaches them. A bare `#42` lifted that way is
unrecoverable, while a scope-qualified one is recoverable by anyone who knows
the collection. That is a reason to copy rather than screenshot a reference
meant to travel; it is not a reason to lengthen every spelling shown in
place.

## Storage

References canonicalize on write. A stored reference never depends on any
reader's bindings, so two people whose bindings disagree cannot break each
other's links. The short form is an input and display convenience at both ends,
and the middle is always qualified.

Canonicalizing to the identity rather than to a qualified name is the safe
default, and it is what lets a consumer store a reference into a collection
whose name policy it has not read. A qualified name is the right thing to store
only where the collection promises the name outlives the reference.

---

## Authority

Space ACLs are space-granular: a principal is evaluated against the space ACL
document for every command, with READ, WRITE, and OWNER ordering
(`docs/specs/memory-v2/04-protocol.md`). There is no per-document authorization,
so no address in a space is protected from a principal who can write the space.
Per-document authority arrives with UCAN-authorized commands.

This design therefore does not prevent a name from being taken; it makes taking
one impossible by accident and detectable when deliberate.

- A member name lives in the collection that assigned it, so a person choosing a
  space-level name cannot land on one. Retargeting one means writing that
  collection's own cell through its own actions — a visible edit, not a silent
  redirect on an invisible document.
- The binding naming a collection is the one name still exposed, and it fails
  loudly:
  every reference through it breaks at once, and one write repairs it.

A binding repointed to a target that resolves too is the case that does not fail
loudly, and nothing here detects it. A collection declaring the name it answers
to is what would, and that is open below rather than built.

## Implementation road

Each step is usable on its own, and where one rests on another the step says so.

**1. Restructure the reverse map.** A piece carries one single-valued `slug`
entry in its metadata, written by `setSlugLink` (`packages/piece/src/slugs.ts`)
and read by `handlePieceGetSlug`
(`packages/runtime-client/src/backends/runtime-processor.ts`); the shell
rewrites a visited identity URL to that name. One slot cannot hold both a member
name and a space-level name, so a map carrying both would make the canonical URL
whichever was written last. Two further gaps were to close here, and one of them
has closed ahead of this step: an assignment clears the `slug` entry from the
holder it takes a name from, in the transaction that writes the new redirect, so
a retarget no longer leaves a document claiming a name it has lost (step 2). The
other remains — `setPieceSlug` writes target metadata only for piece roots, so a
collection-targeted name has no reverse entry at all. The map needs a structured
form that distinguishes the two and designates one as canonical.

**This step is deferred, and what the deferral accepts is stated here rather
than left to be found.** A collection's own member names write nothing into the
entry: a namespace the collection owns lives in a cell of the collection, and
naming a member stamps no metadata on any piece. What still reaches the entry is
a space-level name whose path selects a member — `cf piece set-slug two /top/2`
resolves member `2` and stamps that member's root with `two`
(`packages/cli/test/setPieceSlug.test.ts`, "names the member a slug's path
selects, and stamps that member with the name"). Such a member answers to
`<space>/two` and to `<space>/top/2` at once, and a visit by identity is
rewritten to the first, because that single entry is the whole of the reverse
map and nothing writes a member form into it. So a member may carry one
space-level name, and the shell prefers it over the member form, until the map
distinguishes the two kinds of name and designates one as canonical.

**2. Make name assignment refuse by default.** Two halves, and only the first
has landed.

Landed: `setSlugLink` (`packages/piece/src/slugs.ts`) syncs the name and reads
it inside the transaction it commits in, refusing a name pointing anywhere but
where the caller said to take it from, and taking it under an explicit flag.
Taking a name clears the `slug` entry from the document root it takes it from,
in the same transaction. A caller whose own rule about a free name is wider
than this one's — the harness tool's is, counting a name that resolves to no
piece as free — carries that rule's answer in as the state to take from, so
the rule is judged against what the write lands on rather than against a read
the write has outlived. The read is a commit precondition, which is what makes
the refusal a claim rather than a time-of-check race; the evidence is under
"Settled" below.

Still to build: a **cross-space target**, which personal bindings depend on
entirely: a binding lives in the reader's home space and points at a
collection in someone else's. `setPieceSlug` builds its target cell in the space
it was configured with and drops the space an LLM-friendly reference carries, so
a target outside that space cannot be written today. Resolution already handles
it, following a slug's redirect into the space its target link names, so this is
a writer gap rather than a model gap.

**3. Give collections member namespaces.** Two halves, and only the second has
landed.

Still to build: a collection declares the name it answers to, its name policy,
and forward and reverse resolutions. Whatever allocator it needs is its own; a
collection that accepts names from people can reuse the claim from step 2 at
collection scope, which is itself unbuilt.

Landed: address resolution (`packages/piece/src/slugs.ts`) splits along what
the caller is asking for. An address alone resolves through
`resolvePieceAddress`, which names a piece and refuses a name pointing at a
collection, because a collection is not a piece and nothing downstream of it
could treat one as such. An address and the path written after it resolve
together through `resolvePieceReference`, which is where the collection is
walked: the first segment selects a member and the rest stays a cell path
inside it. Resolving the two together is what the split is for — the path is
the part that says which member, so a resolver handed the address on its own
has nothing to walk with.

**4. Walk segments in the URL layer.** Built for the shell's page URLs.
`urlToAppView` (`packages/navigation/src/view.ts`) reads the segment after a
slug as the member name and carries it in the view, which serializes back to
`<space>/<collection>/<member>`. It walks no further: segments past the member
are carried in the view as written, and the shell refuses such an address by
naming them, as [Items contain collections](#items-contain-collections) records.
It reads a path that opens with `//` the way the cell reference grammar writes a
fully qualified reference, so that reference and the page URL are one address
written two ways: the second slash is what a reference carries and is no part of
the space, so the shell opens `//<space>/top/42`, the reference its header
offers, and settles on `/<space>/top/42`. A leading `@` on the first segment
marks the space as well, and the shell opens `/@<space>/top/42` the same way.
Resolution is a separate worker round trip, `slug:resolve`
(`packages/runtime-client/src/backends/runtime-processor.ts`), which hands the
reference to the runner's walk and answers with the piece and whatever the walk
did not spend. A name with no member after it is a different question of the
same slug — which piece is this name inside — and `resolveSlugTargetInPiece`
answers it directly, so `<space>/top` opens the piece holding the collection.
The slug grammar in `packages/runner/src/slugs.ts` does not change, and a member
answers to it too.

Where the walk lives is what that split settles. `parseFabricUrl`
(`packages/runner/src/fabric-url.ts`) is deliberately pure and synchronous, and
names turning a space name into a DID as the kind of work that belongs outside
it. Walking into a collection is that kind of work — it syncs and reads a cell
— so the walk sits beside the parse rather than inside it, and every reader of
these URLs keeps reading the segments apart from resolving them.

That split is also what bounds who resolves a fully qualified reference. The
shell reads it and `cf` reads it, both holding a session that can turn a space
name into a DID and walk a collection. The pattern-facing reader, the
`cellFromUrl` builtin (`packages/runner/src/builtins/cell-from-url.ts`), does
not, and what refuses it is the parse rather than the builtin: it reads
through `parseFabricUrl`, whose rooted-path branch wants an entity id where a
collection's name sits. The builtin is not that pure contract itself — it
holds a runtime and a transaction, resolves a space name through one, and
reaches a cell — so what it lacks is the collection walk, and giving a pattern
one is a decision about that builtin rather than a gap in this step.

**5. Add the prose layer.** Sigil parsing, canonicalize-on-write,
context-computed rendering with round-trip verification, the two render modes,
and the clipboard flavors.

The editor already carries most of this shape and should be read before any of
it is rebuilt:
`packages/ui/src/v2/components/cf-code-editor/docs/mention-refs.md` describes a
reference form that keeps a short local key in the text while the destination
lives in a cell the host pattern owns, decides what is a reference by membership
in that map rather than by the token's shape, and keeps a mention's visible
label in step with a rename of its destination. `mintRefKey`
(`packages/ui/src/v2/core/mention-refs.ts`) is a worked short-key allocator,
widening on collision rather than lengthening by default. Two things that
document settles are worth carrying over rather than re-deciding: a reference's
visible label and its citation spelling are different, and a label that a person
has edited stops tracking the destination's name.

## Settled

A question this document once recorded as open, kept here with what answered
it so that a later reader finds the decision rather than re-opening it.

**Whether a synced read inside an `editWithRetry` body becomes a commit
precondition**, which is what step 2 rests on. Answered yes, 2026-09-04, and
the answer is the read's alone rather than the surrounding write's. Two
sessions over one memory server with fan-out held: the second loads a slug
document, the first rewrites it, and the second then reads that document and
writes a different one. Its commit is rejected `ConflictError`; the identical
write with the read removed commits. That rejection is in the retryable class,
so `editWithRetry` catches up and re-runs the body, which is what makes a
read-then-refuse a claim rather than a time-of-check race.
`packages/piece/test/slug.test.ts` holds the pair that differs in the read
alone.

## Deliberately open

Recorded rather than settled, so that a later answer is a decision and not a
discovery. Five of these block work rather than merely awaiting it, and a plan
should sequence around them: the sigil question and the renderer's preference
order both block step 5 outright, a machine-readable policy is what the
consumer rules in Part 1 rest on, the collection-scope claim path is part of
step 3, and sibling bindings decide the second rung of the resolver.

**A qualifier for revision, time, or branch.** No slot is reserved for naming a
thing *as of* something, and this is not hypothetical: memory carries causal
chains, point-in-time reads, and a branching spec
(`docs/specs/memory-v2/06-branching.md`). The characters are crowded — `:` is a
scheme, `/` separates segments, `@` marks a space, `#` is the fragment delimiter
and the prose sigil, `-` is a word separator inside names and so cannot carry
structure, and `~` is already taken by
the JSON Pointer escaping that `parseFabricUrl` performs on path segments. A
later answer that needs a character will have to take one from this list or
overload position.

**Whether names stay ASCII.** The Character Set section above states the current
decision and its cost; widening it is a question for the people who own the
grammar, and it carries the normalization and confusable policy with it.

**Whether tags and citations share a sigil.** `wish({query: "#note"})` resolves
a *kind* by searching the reader's own discovery collections — favorites,
mentionables, profile elements — and may return several candidates and a picker
(`docs/common/conventions/wish.md`). A citation names one *instance* and
resolves deterministically through the scope chain. Both spell themselves with
`#`.

One surface already routes on the mark alone: Shuttle's `cd` classifies an
operand beginning `#` as a wish and resolves it as one (`place.ts`,
`verbs.ts`), so `cd #favorites` is a wish query without the `wish` verb being
named. Nothing routes a `#` token to a citation the same way — the editor's
trigger produces one while a person types, and decides what is a reference by
membership in its map rather than by the token's shape.

So the mark is already load-bearing in one direction and not the other, and
what is unsettled is what a surface should do when it must choose. **Step 5 is
where that arises**, which is why it is blocked here rather than merely
awaiting an answer: sigil parsing reads `#` out of prose generally, and a
reader that resolves both kinds has to decide which a token is. Until then
either they are one system, in which case a tag search is the outermost rung
of the same scope chain and the well-known targets that resolve by recency
need reconciling with the rule that nothing hidden decides what a name means;
or they are two systems and one of them needs a different sigil.

The cost that exists now is a reader's rather than a parser's: the same mark
means "search a kind, perhaps pick from several" in one place and "this exact
member, resolved deterministically" in another, and only context separates
them.

**Which spelling a renderer prefers** when several are available and all round
trip — a collection's compact form, its path form, and any space-level name the
member carries of its own. Every candidate is verified before display; what is
unsettled is the order among them.

**Whether a name policy is machine-readable**, so a consumer can branch on it,
or is documentation that a consumer's author reads. The first customer
publishes one — `NamingDeclaration` in
`packages/patterns/collection-naming/naming.ts`, ruled 2026-09-03 in
`docs/plans/collection-naming-topics.md` (decision 7) — and whether that shape
becomes the standard every collection declares is what remains open.

**Whether a collection's declaration is checked against the name it is reached
through.** A declaration carries a slot for the collection's own name — `name`
in `NamingDeclaration` (`packages/patterns/collection-naming/naming.ts`) — and a
resolver reading it could verify that a binding and its target agree and report
a mismatch. Nothing reads the declaration: no collection sets `name`, no
resolver compares one, and member resolution
(`packages/runner/src/slug-resolution.ts`) reads no part of it. Making one
consumer real is [#6986](https://github.com/commonfabric/labs/issues/6986),
whose natural first consumer is that check, with a name assigned onto a
collection written into the declaration.

**Whether member resolution applies a collection's grammar.** It applies no
member-name grammar
([#6994](https://github.com/commonfabric/labs/issues/6994)):
`resolveSlugReference` (`packages/runner/src/slug-resolution.ts`) looks the
segment after a collection's name up as a key of that collection's map. The
allocator's grammar lives in the collection's library, as `isMemberName` in
`packages/patterns/collection-naming/naming.ts`. So a key the allocator would
never issue still resolves: `top/007` resolves to whatever piece a writer stored
under the key `007`, while the names table publishes no row for it.

The resolver does not hardcode that grammar because the two sit at opposite ends
of the pace layers in `AGENTS.md`: the decimal grammar belongs to the
collection's library, in `packages/patterns` at the top, and the resolver sits
in `runner`, at the foundation. Hardcoded, it would also refuse the members of
any collection that names them some other way, such as `docs/getting-started` in
"Names resolve through collections". Applying each collection's own grammar
would take reading it from the collection's `naming` declaration. Nothing reads
that declaration today (the question above,
[#6986](https://github.com/commonfabric/labs/issues/6986)), and it carries no
complete grammar predicate to test a key against. Its fields are `name`,
`policy`, and `compact`, and only the last says anything about a member name at
all — the eligibility rule in "The compact form" above — which rules one
character out rather than saying what a name is. That route is open, not
planned.

**Whether a collection accepting names from people** reuses the space-level
claim path or needs its own.

**Whether the scope chain admits bindings from a collection to its siblings**,
or stops at the containing collection and the reader's own bindings.

**Naming for things that are not collection members** — patterns, schemas,
verbs, spaces, people — is out of scope here, and worth checking against this
design before a second naming system grows beside it. So is federation across
hosts holding the same space, and the separation of naming from access: this
document assumes a name a reader can resolve, and says nothing about naming
something the reader cannot read.
