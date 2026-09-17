# Collection naming

A library a collection pattern calls to give its members names of its own, and
an exemplar collection that uses it. The Topics board in
[`../topics/`](../topics/README.md) is the collection it exists for and calls
the same library. The design is
[Naming in collections](../../../docs/specs/collection-naming.md); this
directory is its first customer. Member names here are decimal strings, dense
from `1`, so a member is cited as `<collection>/42`.

## The library: `naming.ts` and `allocator.ts`

The namespace is one map cell on the collection, `names: { "42": <member> }`,
holding each member as an unread reference. The library owns everything a
collection does with it:

- **Allocation.** `createNamed(names, create)` computes the next name — `1` when
  the map holds none, otherwise one more than the largest present — calls
  `create` with it, and records what `create` returns under it, all in the
  transaction of the verb that calls it; it returns the name and the member. A
  keyset read of the map conflicts with a concurrent key write to it, so of two
  verbs that read the same keys the second to commit is rejected and re-runs
  against the first one's write, and the re-run calls `create` with the name
  after it. A member built holding its name therefore holds the name the map
  records for it. `assignName(names, member)` is the same allocation for a
  member that already exists, and returns the name. `nextNameAmong()` is the
  rule on its own, over any list of keys.
- **The names table.** `namesTable` derives one row per named member,
  `{ member, name }`, each row addressed by the member it describes.
- **Reverse lookup.** `nameOf(member, table)` returns the name the table gives a
  member, matched by identity, or `undefined`. `ownName` is the same lookup as a
  lift, for a member reading its own row out of a table its collection wired to
  it.
- **The two backfills.** `backfillNames(members, names)` names every unnamed
  member of a list in filing order, skips those already named, and returns
  exactly the names it wrote — `[]` on a second run, which writes nothing. It
  writes the namespace and nothing else, so a member it names stores no name of
  its own. `recordNames(members, names)` does that walk and additionally asks
  each listed member to store the name the namespace holds for it, by sending
  that name to the member's own `recordName` verb; it returns `assigned`, the
  names it wrote, `named`, the members already reporting theirs, and `pending`,
  the members it asked. A send's effect is invisible to the transaction that
  makes it, so `pending` is a list of requests rather than of outcomes: a later
  run reports whichever landed under `named` and asks for the rest again. Which
  of the two a collection calls turns on whether its member pattern declares
  `recordName({ name })`. A member whose pattern does not stores the payload as
  ordinary data at that name in its result, because a send to a path holding no
  stream is an ordinary write — `Cell.send` in `packages/runner/src/cell.ts`
  delegates to `set`. The exemplar's item declares none and calls
  `backfillNames`; Topics' topic declares one and its board calls `recordNames`.
- **The declaration.** `NamingDeclaration` is what a collection publishes so a
  consumer learns the policy rather than assuming one: whether a name is unique
  across history or only among current members, whether it is permanent, whether
  it may be reused, and what allocates it. `SEQUENCE_NAMING` is the declaration
  for this sequence: unique across history, permanent, never reused, and
  eligible for the compact `<collection>-42` spelling because a decimal name
  holds no hyphen. Its `name` — the collection's own — is optional and absent on
  the exemplar: the stage that binds the board's namespace as a slug fills it,
  and that binding is what a resolver can then check the declaration against.

The library is two modules, and which one a declaration sits in turns on what it
needs at runtime. `allocator.ts` holds the allocation rule — `nextNameAmong`,
`createNamed`, `assignName`, and the `NamesMap` and `NamesMapCell` shapes — and
takes no value from `commonfabric`, so a plain `deno test` can import it and run
the allocator with no pattern runtime behind it. `naming.ts` holds what does
take one — the names table, the reverse lookup, the two backfills — and
re-exports the whole of `allocator.ts`, so a collection reaches the library
through `naming.ts` alone.

Nothing in `naming.ts` knows what kind of piece a member is beyond the one verb
`recordNames` sends to and the one property it reads. A member is a cell,
compared by identity and never read through, which is what keeps every read
there — the allocator surveying keys, the table over the map, a member finding
its row — from expanding a member document.

### Declaring the namespace

A collection declares the map at its input as
`names?: Writable<Default<NamesMap, {}>>`, written inline at the property, and
publishes it under the same default. Two details of that spelling decide whether
the reads above stay bounded:

- The two-argument `Default`. `NamesMap | Default<{}>` adds a bare empty-object
  arm to the union, and wherever that union reaches a handler unmerged it
  becomes an `anyOf` whose empty arm reads every value whole; the runtime's
  merge lets a branch that looked win over the opaque one, so the allocator
  would expand every member to survey the keys.
- Inline, not through an alias. The schema generator reads the default off the
  property's own type node, so a default declared through a type alias is
  dropped from the schema.

A verb reads its binding through a schema that carries no default, so inside a
verb the map is `undefined` until the first name is written. `NamesMapCell`
declares that structurally, and the library's readers take an absent map as
empty.

## The mention universe: `mentionable.ts`

The one derivation both this exemplar and the Topics board build their mention
universe with. `mentionableIndex` reads three display strings off each member —
its display name, its title, and its own `shortName` — and returns one document
of `MentionableRow` copies, each carrying the member itself as an unread
reference under the `piece` key;
[the mentionable convention](../../../docs/common/conventions/mentionable.md) is
what the editors consume it through. `mentionableRowsOf` is the per-member
projection on its own, over any list of cells.

Copies rather than the members are what bounds the read, and that is what
separates a universe from an index: a survey index whose rows ARE the members
costs nothing extra, because a survey reads those members anyway, while the
universe is read by EVERY member's editor — wiring it to the members would
multiply the collection by itself.

It is a module of its own rather than part of `naming.ts` because it reads
THROUGH a member, which is exactly what that module does not do; and it is one
module rather than a copy per board because a board importing the other board's
copy would carry that whole board into its own program.

## The exemplar: `board.tsx` and `item.tsx`

The board is a collection of items that owns a member namespace, and the demos
in the plan run on it. Its verbs:

- `addItem({ title, body?, agentName })` allocates the next name through
  `createNamed`, creates the item with that name as its `shortName` input, and
  appends it, in one write: the created item is reachable at `names[<n>]` and
  stores its own name the moment it exists. It returns the item, declared
  through the index's row schema, with the allocated `name` beside it, so a
  caller learns the name from the allocation itself rather than from anything
  the item publishes.
- `backfillNames({ agentName })` names every unnamed member in filing order and
  returns the names it wrote. Idempotent. It writes the namespace and nothing
  else. A member it names is named — `names` and `namesTable` carry it, and
  `nameOf` returns it — and shows no name of its own: its row, its universe
  entry, and its own header read only what the member stores, and a board writes
  a member's result, never its argument, so no verb of the board can write the
  name onto it. Writing a stored name onto such a member is not built.

It publishes `index` — the items themselves, declared through a row schema of
`title`, `createdAt`, and `shortName`, so a row IS its item and a row's own
address is the item's address; `shortName` is absent for a member that stores no
name, so a board holding such members still reads whole — and `names`,
`namesTable`, `naming`, `mentionable`, `itemCount`, and a card list showing each
item with its name.

`shortName` is written `shortName?: string` at every point the exemplar names it
— the row schema, the item's stored input and its own publication, and the
demand an item makes of a mention-universe entry. Apart from the stored input,
which Topic does not have, that is the spelling the Topics board and Topic ship.
Optional rather than defaulted, and the two are not interchangeable: a defaulted
property moves a demand's defaults below an array constraint the compatibility
proof cannot show stable under default insertion, and dropping the default
without making the property optional makes it newly required. The item publishes
it the same way because that is what `TopicPiece` ships, not because the demand
forces it; `ItemOutput.shortName` in `item.tsx` says which pairing of the two
the compiler does refuse.

The bound on what that buys is worth stating, because it is narrower than it
looks. The spelling is about the READ: a board whose members publish no name
reads whole, one row per member with the name simply absent. It is not what lets
a namespace be added to a board that is already deployed. `cf piece setsrc`
refuses a member demand that gains any property at all — optional included —
over a board whose stored members do not publish it, because the schema recorded
on the retained link to each member is unconstrained at that path. Naming the
members of an existing collection therefore takes more than a compatible
spelling.

An absent `shortName` covers two cases a survey cannot tell apart: a member
nothing has named, and a member the board has named that stores no name — one
filed before the board passed a name in at create, or one a backfill named. A
caller that needs to know which reads the namespace, where the answer is:
`nameOf` over `namesTable` returns the name for the second, and returns
`undefined` only for the first.

`mentionable` is the board's mention universe, derived through
`mentionableIndex` from `mentionable.ts` above. Every item the board creates is
wired to it, so an item's body editor completes `#42` over the board's own
numbering. The query matches a row's copied `shortName`, taken off the member's
own — the same property a member publishes for itself, and the one `index` shows
— so one fact is derived once and the editor reads one name at both ends. That
is what lets offering the list expand no member; what a picked completion stores
is the member itself.

A member that stores no name carries no name in either place, so what a backfill
leaves unwritten reaches both. The two read differently, because a universe row
is a copy and an index row is the member: `mentionableRowsOf` coalesces a member
with no name to the empty string, while the member's index row simply has no
`shortName`.

An item takes the universe as a READABLE binding, and the difference is not
cosmetic: a writable binding puts the board's whole published row inside the
retained link's proof, which runs both directions, and a member demand narrower
than that row fails the write-back leg — leaving a member that cannot be
re-sourced with any source, its own bytes included. So every board-wired input
an exemplar member declares is readable unless it has a write to make.

The item is the member: a title, a body, a filing time, and the name its board
calls it by, stored as its `shortName` input by the create that allocated it. A
name is permanent and never reused, so that stored copy is the name the
namespace holds for the item, and the item reads nothing of its board to show
it. Its body is drafted per session and written with its mention map by one
save, and the three streams that drive that — `startEditBody`, `saveBody`,
`cancelEditBody` — are the whole editing surface. The drafts are seeded by the
open and by nothing else, so the save refuses when no edit is open and a second
open leaves one in progress alone: either would otherwise write an empty or
stale draft over the stored body. It publishes its stored name as `shortName`,
rendering it as a badge beside the title when it has one; a mention of the item
elsewhere reads that same `shortName` to show the number on its pill. The body
is edited through `cf-code-editor`, which mints reference-form mentions into the
item's own `references` map — saved with the prose in one transaction, so the
tokens and the destinations they name land together.

An item whose input holds no name — one filed before the board passed a name in
at create, one filed past `addItem`, including every member a backfill names,
and one composed with no board — shows no name and does not fail. Writing a
stored name onto such an item is not built: a board writes a member's result and
never its argument, so nothing the board can do reaches that input once the item
exists, and a backfill writes the name into the namespace and nowhere else.

Headless, against a deployed board:

```bash
cf piece call --cell /of:<board> addItem --json '{"title":"...","agentName":"Sol"}'
# -> { "result": { "item": { "title": "...", ... }, "name": "1" } }
cf cell get /of:<board> names
# -> { "1": {}, "2": {} }
cf cell get /of:<board> index --select @,title,shortName
cf piece call --cell /of:<board> backfillNames --json '{"agentName":"Sol"}'
```

## Tests

- `allocator.test.ts` — a plain Deno unit test, run by `deno test` with no
  pattern runtime: the name grammar, the length-then-lexicographic comparison
  that keeps names distinct past `2^53`, the carry over a trailing run of nines,
  and `createNamed` and `assignName` driven over a stand-in namespace cell.
  Importing `allocator.ts` is half of what it checks. `commonfabric` declares
  `lift`, `equals` and `Writable` with `export declare const`, which binds
  nothing at runtime, so a module taking one of them as a value fails to link
  here — this test is what holds the allocator to needing none of them.
- `naming.test.tsx` — the sequence rule, the allocator re-run against a stale
  read (a first allocation, a concurrent writer's key landing, and a re-run over
  the map as the winner left it, which takes the next distinct name), the
  agreement between the name `createNamed` hands `create` and the name it
  records the member under, the reverse lookup, and the declaration. Two
  transactions overlapping is what the concurrency test below has and a sequence
  of test steps does not.
- `board.test.tsx` — the exemplar end to end: allocation on create, one more
  than the largest name present, a name kept through a rename and through
  leaving the list, the backfill and its idempotence, index rows that are the
  members and the absence an unnamed member's `shortName` reads as, the mention
  universe and the name each of its rows carries, the item showing the name it
  stores, a backfilled member named in the namespace and showing no name of its
  own, the bound on what a read of the namespace or the universe expands, a
  board given no namespace at all, and the rejections.
- `topics-shape.test.tsx` — a test-only board whose members are the real `Topic`
  pattern, wired through the library the way the exemplar is. It holds the
  library to a member pattern it does not own — allocation on create,
  `backfillNames`, the names table, and the reverse lookup, all over topics,
  through a board that is not the Topics board. `recordNames` is covered where
  its member contract is declared, in `../topics/naming.test.tsx`.

Two tests of this directory's code live under `../integration/`, because each
needs more than one runtime:

- `collection-naming-concurrency.test.ts` — two sessions on one memory server
  whose creates both read the map's keys before either commits, through
  `assignName` and through `createNamed`: distinct consecutive names at the cost
  of one re-run, and each member built by `createNamed` holding the name the map
  records for it.
- `collection-naming-member-name.test.ts` — a member filed through `addItem` in
  one replica, read in a second replica that never runs the board, shows its
  name. With server execution off a derived value is recomputed only where its
  owning piece runs and something pulls it, so this is the read that tells a
  stored name from one looked up in the board's names table; a single-runtime
  pattern test shows the name either way.

One more lives in the shell package, because it needs a browser as well:

- `../../shell/integration/collection-member.test.ts` — the shell opening
  `/<space>/<collection>/<member>` over an exemplar board filed by `cf`. What it
  proves is the whole chain standing up at once: a slug bound inside a piece, a
  worker resolving the reference through it, and a rendered page that is the
  member rather than the board.

## Topics

The Topics board (`../topics/`) is the collection this library exists for, and
it calls it: `addTopic` allocates in the same transaction as its append and
passes the name into the topic it creates, its `backfillNames` verb runs
`recordNames` over what the board held before, each topic stores its own name
and publishes it as `shortName`, and both boards derive their mention universe
through `mentionable.ts`. Topics shows no numbers for now — `SHOW_TOPIC_NUMBERS`
in `../topics/topic.tsx` says why — so a topic publishes no `shortName`, and
every place that would show one reads nothing: the header, the cards, the survey
rows, and the universe rows the derivation copies from each topic. A topic still
STORES its number, which is what `recordNames` asks it to do and what no switch
gates; the switch costs the step its report, which `RecordNamesResult` states.
This exemplar shows its numbers in all three places. What is still to come is in
[the plan](../../../docs/plans/collection-naming-topics.md): the production
backfill, and the slug that binds the board's `names` cell as `top`.
