# A verb session, measured

What a whole session driven through `cf` costs and guarantees: the measurement
behind each step, the caveats each one carries, and what the surface still
owes. It assumes the vocabulary rather than teaching it.

**Not met a pattern or a piece before?** Read
[The Verb Session](the-verb-session.md) first. That is the tour of this same
session — it defines pattern, piece, space, verb, handler and invocation,
walks the thirteen acts, and reads start to finish. This document is where
those acts are priced and their limits stated.

[Verbs over the CLI](over-the-cli.md) explains what a verb hands back; this
document is where that behavior is priced against a session that exercises it.

The subject is a work-item tracker — items in a tree, plus typed cross-links.
It is a real pattern: [`packages/cli/integration/pattern/tracker.tsx`][tracker],
which belongs to this document and its two companion scripts and to nothing
else, so a change to a pattern the product ships can never break a
demonstration of the verb surface.
Every measurement below was taken against that pattern on a local toolshed.

**Every step here works against a current build.** That is not a claim this
document makes on its own: [`packages/cli/integration/verb-session-gaps.sh`][gaps]
asserts the same surface as pass/fail and CI runs it, so a step that stopped
working would fail there rather than going stale here. A step needing
something decided or built would say so; none does today.

## The two scripts, and how they line up with this

Two companion scripts under `packages/cli/integration/` carry this session.
[`packages/cli/integration/verb-session-demo.sh`][demo] is the session as it is meant
to read: it narrates each command, runs it, and prints the result, so the
transcript is the artifact. [`verb-session-gaps.sh`][gaps] asserts the same surface as
pass/fail and is what keeps the demo honest.

The demo counts in **acts**; this document counts in **steps**, and the two do
not run one-for-one — a step is a theme, an act is a beat, and a theme can
take several beats to show. Watching the transcript and wanting the reasoning
behind a particular act, read across:

| Demo act | Explained in |
| --- | --- |
| 1 · Arrive by name | step 1 |
| 2 · Ask what it is, and what it can do | step 2 |
| 3 · Ask what a verb wants | step 3 |
| 4 · Create, and act on what you were handed | step 5 |
| 5 · Read addresses instead of contents | step 6, and "What you are driving" on what an unshaped read costs |
| 6 · Ask the same question twice | step 6, on why a read may be asked twice and a call may not |
| 7 · A verb returns what only the pattern could compute, and its receipt reads that outcome back | the [tour's verb-shapes table](the-verb-session.md#three-design-decisions-each-aimed-at-a-hard-case), and step 6 on the receipt |
| 8 · Finishing reports what the caller could not know | the [tour's verb-shapes table](the-verb-session.md#three-design-decisions-each-aimed-at-a-hard-case) |
| 9 · A verb that declares no result | the [tour's verb-shapes table](the-verb-session.md#three-design-decisions-each-aimed-at-a-hard-case), and step 5's closing read |
| 10 · Step back and read the board | step 6 |
| 11 · Ask for something that is not there | step 7 |
| 12 · Relate two items | step 8 |
| 13 · One item, two paths, one address | step 8 |

Step 4 is the one with no act behind it: completion needs a terminal, so the
demo cannot run it.

A verb added to the fixture wants a row in the verb table below, an act in the
demo, and a step in the harness; a shape demonstrated in none of the three is a
claim this document is making alone.

This document quotes commands and never composes them: every `cf` line in a
bash block below is a line the demo runs — or carries a `# not in the demo`
comment saying why it cannot be — and every act number names an act the demo
has. `deno task check-verb-session-sync` enforces both, so a command here
cannot be wrong in a way the demo would have caught, and an act reference
cannot go stale under renumbering.

Section headers inside the help output below are the literal strings
`renderPieceCallHelp` emits ([`packages/cli/lib/exec-schema.ts`][exec-schema]). Their contents
are illustrative.

## What you are driving

A fixture exists to be driven, and this one is shaped so that driving it is hard
in the particular ways the verb surface has to be good at. The three decisions
behind that shape — a tree with cross-links, state a caller cannot set, and six
verbs covering five result shapes — are laid out in the tour's
[The program under the demo](the-verb-session.md#the-program-under-the-demo),
along with the table pairing each shape against the act that demonstrates it.
What belongs here is the cost of driving it, which the sections below carry
step by step.

Two patterns. A **board** holds root items; an **item** holds its own subtree,
its own graph edges, and its own verbs — so the thing a create hands back is
itself callable, with no separate lookup.

```tsx
// Shown for illustration only.

/** What a caller supplies at creation. Everything else the board derives. */
interface BoardInput {
  items?: ItemOutput[];
}

/** A work-item tracker: root items on a board, everything deeper under an
 *  item's `children`. State changes only through verbs — a caller files,
 *  notes, finishes, archives, and relates items; nothing here is written
 *  directly. */
interface BoardOutput {
  /** Root items only. The tree hangs off each one's `children`. */
  items: ItemOutput[];
  /** File a new root item on the board. */
  addItem: Stream<AddItemEvent, AddItemResult>;
}

/** A verb's event and result are named interfaces, not inline shapes, so each
 *  parameter has somewhere to be documented. This is the only pair spelled out
 *  here; the rest follow it. */
interface AddItemEvent {
  /** One line naming the work. */
  title: string;
}

interface AddItemResult {
  /** The root item this call created. */
  item: ItemOutput;
}

/** What a caller supplies. `status`, `notes`, `children` and `blockedOn` are
 *  the pattern's own state, not inputs — a caller changes them through verbs. */
interface ItemInput {
  title: string;
  parent?: ItemOutput | null;
}

/** One work item: what it holds, and what it can do. */
interface ItemOutput {
  title: string;
  /** "open" until a verb changes it — "done" or "archived". */
  status: string;
  /** Append-only. Each entry carries a time the pattern stamped, not the
   *  caller: reading the clock is a handler capability. */
  notes: { body: string; at: number }[];
  /** Null at a root. Carried so a caller can walk up as well as down. */
  parent: ItemOutput | null;
  /** The tree. */
  children: ItemOutput[];
  /** The graph. A blocker is any item anywhere on the board, not a
   *  descendant — which is what makes one item reachable by two paths. */
  blockedOn: ItemOutput[];

  /** File a new item beneath this one. */
  addChild: Stream<AddChildEvent, AddChildResult>;
  /** Append a progress note. Notes are append-only; nothing rewrites one. */
  recordNote: Stream<RecordNoteEvent, RecordNoteResult>;
  /** Mark this item done. Descendants are left alone — finishing a parent says
   *  nothing about its children, which is what `openBelow` reports. */
  finish: Stream<FinishEvent, FinishResult>;
  /** Record that this item waits on another. The blocker may be anywhere on
   *  the board — this is the edge that makes the tree a graph. */
  blockOn: Stream<BlockOnEvent, BlockOnResult>;
  /** Mark this item archived. Declares no result — the value-less shape. */
  archive: Stream<void>;
}
```

**A verb says what it does; its parameters describe themselves.** The comment
on `addItem` does not restate what it takes or returns, because
`AddItemEvent.title` and `AddItemResult.item` already say so where they are
declared — which is where `--help` sources both its `Output:` line and a flag's
prose. Restating it in the verb comment would be the same content twice, and
the copy that goes stale when a parameter changes.

**One interface, holding both.** An item's fields and its verbs sit together
because that is what an item *is*: a child in `children` is a full item, and
declaring it any narrower would be a claim the runtime contradicts — ask that
child what it can do and it lists all five. Act 4 asks it: an address is enough
to discover a surface, with no schema shipped alongside and nothing looked up
by type.

**Every field is a reference, not a copy.** `children` holds links to item
pieces, and so does `blockedOn`. That is the whole reason addresses matter
here: the same item can sit under one item's `children` and in another's
`blockedOn`, and only an address tells a reader those are one item rather than
two.

**Which makes an unshaped read expensive, on purpose.** Reading `children` with
no selection carries every field *and* a link envelope per verb per element —
measured at 3183 bytes for a single child on this pattern. Naming what you want
brings it to 51:

```bash
# not in the demo — the byte measurement's own illustration
cf cell get <item-address> children --select 'title,status'
```

That is not a workaround; it is the read model working. A schema is a query,
and a caller who names nothing has asked for everything. The same flags shape a
verb's result, because
[a result is a read on a different cell](../../plans/fabric-read-model.md) — 1743
bytes unshaped, 140 with `--select 'item.title'`.

**The prose above reaches a caller.** Each verb carries a doc comment saying
what it is for, which is where that documentation belongs, and `cf` serves it:
as a row's `description` under `cf piece verbs --json`, and as the summary line
of the verb's own help page. Step 3 has the measurement.


## 1. Arrive with a slug

An address a person can type, rather than a fid from a previous command.

```bash
# not in the demo — the demo deploys straight against a live toolshed
cf test tracker.test.tsx
cf piece new packages/cli/integration/pattern/tracker.tsx --slug board
cf piece slugs
cf piece verbs --piece board
```

```text
PATTERN cf:module/ZPxyGdkkv-YmizdHdNx5DIlqlpc9JRSm5iXTl4Tb2T0#default
NAME    KIND    ON     MARKS
addItem handler result
    File a new root item on the board.
```

**One row, because the board declares one verb.** `items` is the board's array
of root items and `$NAME` is its display name; both are data, and data is not
callable, so neither is offered to a caller as something to call.

Slug resolution sits on the shared path (`resolvePieceConfigWithPieces`,
[`packages/cli/lib/piece.ts`][piece-lib]), so every command below takes `board` too. And
the name is discoverable as well as resolvable: `cf piece slugs` lists the
space's slug index, so a session in a space someone else populated starts
from a listing rather than from folklore. The demo's act 1 runs it beside the
deploy.

The listing carries the deployed pattern's source identity, which is how a
client tells it is talking to a newer pattern than it was written against.

**Each row carries its verb's prose.** The columns stay a grid to scan — one
table line per verb — and the verb's own doc comment rides beneath its row:
the same sentence the help page opens with, and the same `description` the
row carries under `--json`, alongside the input and output schemas the table
has no room for. A person asking what one verb is for reads its help page; a
person asking what the piece is for reads its own page, next.

## 2. Ask what it is

```bash
cf piece describe --piece board
```

```text
NAME    Work tracker
PATTERN cf:module/ZPxyGdkkv-YmizdHdNx5DIlqlpc9JRSm5iXTl4Tb2T0#default (/tracker.tsx)

  A work-item tracker: root items on a board, everything deeper under an
  item's `children`. State changes only through verbs — a caller files,
  notes, finishes, archives, and relates items; nothing here is written
  directly.

STATE
  items  ItemOutput[]
      Root items only. The tree hangs off each one's `children`.

INPUTS
  items  ItemOutput[]

VERBS
  addItem
      File a new root item on the board.
```

The piece's man page: what it is, what it holds, what a caller supplies, and
what it can do — one command, and every sentence on it is the author's own,
compiled with the pattern and read back from it. The demo's act 2 runs it
here, and act 4 runs it again against the address a call handed back, where
the page that answers is the item's: its own purpose, its state fields'
prose, and a summary line per verb.

| Line | Written on | Compiled to |
| --- | --- | --- |
| the purpose paragraph | the result (Output) interface's own doc comment | the result schema's root `description` |
| a STATE row's prose | the field's doc comment | `resultSchema.properties.<field>.description` |
| an INPUTS row | a field of the argument (Input) interface | `argumentSchema.properties` — `Required.` marks what that schema requires |
| a VERBS row's summary | the verb's doc comment | the listing row's `description` — the same sentence its help page opens with |

**The purpose has exactly one compiled home.** A comment at the top of the
pattern FILE compiles to nothing — emit strips comments, so it survives only
in the stored source `cf piece getsrc` retrieves. The Output interface's
comment is where a pattern's purpose reaches a caller, because the schema
generator attaches a type's own doc comment only where that type is the root
of a generated schema — which its result root is, and which the nested types
inside it are not. The same rule is why an event interface's comment reaches
nothing (step 3's table).

**STATE and INPUTS split on who writes.** An INPUTS row is what a caller
supplies; a STATE row belongs to the pattern and changes only when a verb is
called. That split is the piece's usage model, and the page keeps it visible
— which is also why `Required.` appears only under INPUTS: a result schema's
`required` array marks fields the pattern owns, and that is not a claim on
any caller.

**The page degrades honestly.** A field nobody documented still lists with
its name and declared type (`title` on an item does exactly that). A piece
whose compiled pattern cannot be read keeps its VERBS — they still dispatch —
and loses purpose, STATE, and INPUTS, with a note saying so rather than empty
sections claiming the pattern declares nothing.

## 3. Ask what a verb wants

```bash
cf piece call --piece board addItem --help
```

```text
Usage:
  cf piece call ... addItem --help
  cf piece call ... addItem <json>
  cf piece call ... addItem [invoke] --title <string>
  cf piece call ... addItem ... -- --select <fields>

File a new root item on the board.

JSON input:
  Pass inline JSON as one positional argument or after `--json`.
  { title: string }

Flags:
  --title <string>    Required. One line naming the work.

Output:
  The invocation's `result`:
    item <json>  The root item this call created.
```

**Structure and prose are both published, and they come from different
documents.** The split is worth holding onto, because only one half is free:

| | Where it comes from | Reaches `cf`? |
| --- | --- | --- |
| flag name, placeholder, required-ness | the event's **type** — `{ title: string }` | **yes** |
| result field name and placeholder | the result's **type** — `AddItemResult` | **yes** |
| what `title` means, what the verb is for | the author's **doc comments** | **yes**, read from the pattern |

The `Output:` section names the position a caller collects the value from —
the settled Invocation JSON's `result` — because that is where a handler's
result arrives, rather than on stdout the way a tool's does. A verb that
declares nothing carries no such section at all, which is how the page tells
the two shapes apart without asserting anything false about either.

The structural half needs nothing authored per pattern:
`parseObjectInput` builds a `FlagDescriptor` per input-schema property, so
`--title <string> Required.`
falls out of the type. That is why the page exists at all.

**The two halves arrive by different roads**, and the page assembles them.
The structural half rides the schema the piece serves. The prose is read from
the compiled pattern, because that is where a doc comment survives
compilation — the same load `cf piece verbs` already makes to report what a
verb hands back. A caller sees one page; `cf` read two documents to build it.

Which document carries what, and why the fold walks both, is
[an author's prose, over the CLI](prose-over-the-cli.md). Two of its
consequences show up in this session: a field an author declares and the
handler never reads is still served, flagged and documented (the authored
event is the contract), and a declared reference arrives with its capability
marker stripped — which is what step 8's dispatch gate reads the pattern to
recover.

### Three levels of documentation

Every line of prose on the page above exists as a doc comment in
[`tracker.tsx`][tracker]. Nothing is invented for the illustration — it is that file's
own words, reaching a caller. An author writes each where the thing it
describes is declared — the verb says what it does, and each parameter
describes itself:

| Level | Written on | Compiled? | Reaches `cf`? |
| --- | --- | --- | --- |
| the verb — *what it does* | the `Stream` property | **yes**, beside the `$ref` | **yes**, as the summary line |
| an **input** parameter | a field of the event interface | **yes**, in `$defs.<Event>.properties` | **yes**, beside its flag |
| an **output** parameter | a field of the result interface | **yes**, on the declared result | **yes**, beside its `Output:` line |

The output parameter's prose needs no resolution to render. A verb's declared
result reaches `cf` **unresolved**, and a field's description is a ref-site
sibling on the property itself: `--help --json` on `addItem` serves
`properties.item` as a `$ref` into `$defs.ItemOutput` carrying
`"description": "The root item this call created."`, the author's own comment
verbatim, and the text page prints that same sentence beside `item <json>`.

The summary line is worth one more note, because an event *interface's*
comment would be the other candidate for it. That is the one level here that
does not compile at all
([#5937](https://github.com/commonfabric/labs/issues/5937)) — so the verb's
own comment is both the shorter road and the better place for an author to
write it, since it sits beside the type it describes.

## 4. Complete against the live piece

```bash
# not in the demo — completion needs a terminal
cf piece call --piece board <TAB>
addItem
```

Verb names and piece addresses complete against the space
(`shapeVerbCandidates` / `liveCandidates`,
[`packages/cli/lib/completion/providers.ts`][completion]), in bash and zsh. The candidates
map one-for-one over the listing in step 1, so completion offers what that
command names and nothing besides.

What does not complete is a result field — `--select 'it<TAB>'` has nothing to
offer. The knowledge exists now: the help page above enumerates `item`, off the
same declared result a completion provider would read. What is missing is the
provider consulting it, which is the same wiring a derived default selection
needs.

## 5. Create, and carry the address forward

This is where `--select` starts carrying the narrative. The grammar the session
uses is set out in the tour's
[act 4](the-verb-session.md#act-4--create-and-act-on-what-you-were-handed): a
selection names the shape of the answer, and everything not named is left out.

An address always arrives under the key `$link`, which is why that key is
everywhere in the output below. The full account of the suffix — marking
positions deeper than a link, the `{"$link": true}` spelling a JSON Schema
uses, and escaping a literal `@` — is in
[verbs over the CLI](over-the-cli.md#asking-a-read-for-an-address).

```bash
EPIC=$(cf piece call --piece board addItem --title "Login rewrite" \
       -- --select 'item@' | jq -r '.result.item."$link"')

cf piece call "$EPIC" addChild --title "Session cookies"
cf piece call "$EPIC" recordNote --body "blocked on the cookie spec"
cf cell get "$EPIC/status"
```

The `jq` hop above is how an address gets from a response into a variable, and
its quoting is load-bearing: `."$link"` must be quoted, because a bare
`.$link` reads as one of jq's own variables rather than as a key.

The create answers with the address that `EPIC` then holds, and every command
after it takes that same string:

```text
{
  "invocation": "a733f7d4-f238-46fa-9f89-30d7d228763c",
  "status": "settled",
  "receipt": "/of:fid1:GKtk39YEc7WOB6_d3iX6fkK7gEjgeoP5fw1dkirzb-E",
  "result": {
    "item": {
      "$link": "/of:fid1:4qFMKSZxAkTVIPBykdyTQGK5YYr_sjUmez3gARxKUkE"
    }
  }
}
```

`addChild` hands back the child whole, and `parent` — the position where the
type re-enters itself — answers with an address rather than recursing:

```text
"result": {
  "item": {
    "title": "Session cookies",
    "status": "open",
    "notes": [],
    "parent": {
      "$link": "/of:fid1:nC0C0km4taIIWtgziU841Ka94i9igKvzEIG-OuoLuNw/parent"
    },
    "children": [],
    "blockedOn": [],
    "$NAME": "Session cookies"
  }
}
```

`recordNote` returns a stamp the caller never supplied, and the closing read
answers with one scalar, because the address carried the path:

```text
"receipt": "/of:fid1:-PqRcxDVvI1AvqsJevG-N3Ui-PqMDW1HUYRm1X0cPAY",
"result": {
  "note": { "at": 1787075135000, "body": "blocked on the cookie spec" },
  "noteCount": 1
}

"open"
```

That `receipt` is an address like any other, and step 6 reads it back.

**This is the composition the surface exists for.** A create hands back the
piece it made, the address renders in place as one canonical reference, and the
next command takes that same string — bare, in its first position. An address
begins with `/` and a relative path never does, so the two cannot collide, and
the address may carry the path, as the `get` above shows. The slug stays on
`--piece`, where no path competes for the position; naming the target both
ways at once is refused. Identity survives the round trip instead of being
flattened into a copy of the item's contents. Read options (`--select`,
`--schema`, `--filter`) come after the `--` on a `call`, because the verb opens
the callable's section and the marker closes it.

`--show-links` is a second spelling of the same move: it returns a
dictionary of RFC 6901 pointers naming the document behind each result path, so
the address is one `jq` hop further away but reachable.

It differs from a marker in one way that matters: it **resolves**. A marker
renders the link as stored; `--show-links` follows the chain as far as the
links this replica has already materialized, and names the document it reaches.
That is not a terminal answer — a hop whose target is not local kicks off a
fetch nobody awaits, and a one-shot command exits before it lands, so the same
path can resolve further on a later read. For getting an address to compose
with, the two are interchangeable and an in-band marker is the shorter road.

**An address is not an identifier to compare.** Addresses are many-to-one over
cells, and a holder of one cannot tell a canonical id from an alias. Two
positions holding the same piece can render two different `id`s, and the two
spellings above can disagree with each other about one piece — a piece created
inside a handler and pushed into a collection is held through a link that
redirects to it, and the two routes stop at different points along that
redirect. Each address reads back the same contents, which is what an address
is for: something to read next, not a claim about canonical identity.

So compose with an address; do not compare one. Two ids differing does not mean
two pieces — and comparing contents does not rescue the question, since two
distinct pieces can hold identical contents and one piece's contents change
under it. **Asking whether two addresses name the same piece is not something
the CLI supports today.**

Neither route needs a verb to declare its result. A `$link` marker on a link
position renders the address and suppresses the fetch without consulting a
source schema at all. What a declared result would add is that `cf` could
derive the selection instead of the caller supplying it.

One case already works this way. `addChild` hands back the child it created,
and the child's `parent` points back at the item that holds it. That loop
means the result cannot be written out as plain JSON at all. So `cf` falls
back on the verb's declared result and renders that shape instead: the
child's fields come through as usual, and `parent` — the position where the
loop would start again — comes through as an address, the same address a
`$link` marker would have produced. If the verb declares no result, there is
nothing to fall back on, and the call fails with a clear message rather than
a stack trace.
[A result that points back at its container](over-the-cli.md#a-result-that-points-back-at-its-container)
shows the full exchange.

## 6. Read the tree back, bounded

```bash
cf cell get --piece board items --select 'title,status,children@'

cf cell get "$EPIC" children --select title --filter '.status == "open"'
```

Between step 5's reads and these, the session ran the verbs step 5 listed but
did not print: the epic was finished and one child archived (the demo's acts 8
and 9), which is why the statuses below have moved. The first read names three
fields and marks one, so the children come back as addresses rather than being
followed. The second names one field and selects on another, so only the child
still open survives the filter:

```text
[
  {
    "status": "done",
    "title": "Login rewrite",
    "children": [
      { "$link": "/of:fid1:nC0C0km4taIIWtgziU841Ka94i9igKvzEIG-OuoLuNw" },
      { "$link": "/of:fid1:1kF-PJw_VqqjEcSQi-3KObKU_uNgtbewvIHUbKTWDns" }
    ]
  }
]

[
  { "title": "CSRF tokens" }
]
```

Two commands rather than one, because **an `@` suffix and `--filter` are
refused together**, with a reason worth keeping:

```text
--filter cannot be combined with an `@` suffix in --select: a filtered array's
elements no longer say which positions they came from, and an address names a
position
```

`--filter` runs before projection, so `status` decides membership and need not
appear in the output. A marked collection costs one document read however many
entries it holds, because the links are stored inline in the document being
read, and a rejection below one of those links propagates up through the
containers holding it rather than being read past.

The same options work on a call's result, on a wish, on a verb reached through
a filesystem mount, and on a direct read: one read layer, four arrivals.
`cf exec` writes them past a `--`, since the mounted file opens the callable's
section and the marker closes it — the same boundary `cf piece call` draws at its
verb; `cf cell get` and `cf wish` name no callable, so they take them wherever their
own options go.

**A read may be asked twice; a call may not.** A projection is a question, and
asking it changes nothing — that is the invariant, and it is what makes every
read in this session safe to put in a script. It is not a promise that two
reads agree: a read answers from the state it finds, so anything written in
between shows up in the second answer. Here the two agree because nothing else
is writing to this fixture, which is also why the demo can take the addresses
its later acts drive out of a read the reader already watched rather than from
a hidden second one. A call is the opposite of side-effect-free: it runs the
handler body, so asking twice does the work twice.

**But a call need not be asked twice, because its outcome has an address.**
Every settled envelope names a `receipt` — the cell this handling wrote its
outcome to — and reading it is an ordinary read:

```bash
cf cell get "$RECEIPT" --select note,noteCount
```

```text
{
  "note": { "at": 1787075135000, "body": "blocked on the cookie spec" },
  "noteCount": 1
}
```

**What that does not prove, and where the proof lives.** A receipt is a
frozen snapshot of the outcome its handling committed, so it reports that
outcome whether or not anything has happened since. Reading it back therefore
cannot, on its own, tell you that the handler did not run again — the numbers
inside it would look the same either way. Only the piece can settle that:
`notes` is append-only, so a second execution leaves a second entry, and
reading the item's own `notes` is what shows there is none. The harness
asserts the live length after every one of these operations for exactly that
reason.

That is the whole asymmetry: reads repeat freely, calls do not repeat but
their outcomes stay readable.

**The receipt route needs the address.** Where a caller never got one — a
dropped connection, a response nobody saw — the invocation id is the handle
instead. Name a call with `--invocation`, and replaying that id hands back
the original outcome:

```bash
cf piece call --invocation note-retry "$EPIC" recordNote --body "first attempt"

cf piece call --invocation note-retry "$EPIC" recordNote --body "a different body entirely"
```

```text
{
  "invocation": "note-retry",
  "status": "settled",
  "deduplicated": true,
  "receipt": "/of:fid1:tdSLj9QyZFgmSQ53SFqN31lZz2yieuP1pWTW7nCeum0",
  "result": {
    "note": { "at": 1787082752000, "body": "first attempt" },
    "noteCount": 2
  }
}
```

The second payload is deliberately different text, and the body that comes
back is the first call's — along with the same receipt, and `deduplicated`,
which the first call did not carry. The same caution applies as above: a
replay is *defined* to hand the original snapshot back, so the envelope would
read like this whether or not a second note actually landed. The board is
what settles it:

```bash
cf cell get "$EPIC" notes --select body
```

```text
[
  { "body": "blocked on the cookie spec" },
  { "body": "first attempt" }
]
```

Two entries, from the two calls that committed, and the replay's text is not
among them.

An id is only half the handle — it is scoped to an **invocation session**, so
one agent's `note-retry` is not another's. Mint one per run and keep it in
`CF_INVOCATION_SESSION`: putting it in the environment keeps it out of the
command lines and shell history that a casual reader of your terminal would
see.

**A retry is still not free.** The guarantee is at-most-once **commit**, not
at-most-once **execution**: the redelivered event re-runs the handler body and
then loses the race for the receipt. A verb whose body reaches outside its
transaction — an LLM call, a fetch, a message sent — repeats those effects on
every retry. So retry freely for a verb that only writes its own space, and
prefer the receipt for one that reaches beyond it.
[Verbs over the CLI](over-the-cli.md) has the full contract.

The demo's acts 5, 6, 7 and 10 are this step: an address-only read, the same
read run a second time to show it answers the same, a call's receipt read back
to show the outcome outlived the call, and then the whole board, what is open,
and the refusal.

## 7. Refuse what the surface does not accept

Every step so far named something the pattern declares. Getting it wrong is the
other half of a surface that knows its own vocabulary, and the demo's act 11
asks for two things that are not there — one on a call, one on a read:

```bash
cf piece call --piece board addItem '{"title":"Ship it","titel":"typo"}'

cf cell get "$EPIC" children --schema '{"type":"array","items":{"type":"object","propertes":{"title":true}}}'
```

```text
Invalid input for "addItem": "titel" at <event> is not a field this verb
declares. Did you mean "title"? <event> takes "title"

Invalid --schema at <root>[]: "propertes" is not a projection schema keyword.
Did you mean "properties"? Projection reads "type", "properties", "items",
"additionalProperties", "$link"
```

**One shape of answer from both ends.** Each names what was wrong, the position
it sat at, what that position accepts, and the nearest thing you probably
meant — from the call gate and the projection reader alike, which are different
code answering in one voice.

**A refusal is a capability, not a failure.** What each one replaces is worse
than an error: a payload carrying `titel` used to be accepted, the field
dropped on the way in, and the caller told the call settled. That is the
silent-strip failure, and it is what a caller writing JSON by hand or by model
hits while a TypeScript author never does. The same holds for the projection
keyword: two denylists were consulted and every key in neither was carried
onward, so `propertes` shaped nothing and said nothing.

**Nothing is spent.** Both are refused before an invocation exists, so a
caller retries against a surface in the state they left it. Three more
refusals appear elsewhere in this session — the `@`-under-`--filter`
combination in step 6, and the two reference-position guards in step 8 —
and they answer in this same shape.

## 8. Relate two items

```bash
cf piece call "$KID" blockOn --on "$CSRF" -- --select blocked@,on@,blockedOnCount

cf cell get "$EPIC" children --select @,title,blockedOn@
```

```text
"result": {
  "blocked": { "$link": "/of:fid1:OGJ2ADfbRIhmZ-Z4Of4u3QK9mKGWBMKdUTKiUpuFsVQ" },
  "blockedOnCount": 1,
  "on": { "$link": "/of:fid1:1kF-PJw_VqqjEcSQi-3KObKU_uNgtbewvIHUbKTWDns" }
}

[
  {
    "$link": "/of:fid1:nC0C0km4taIIWtgziU841Ka94i9igKvzEIG-OuoLuNw",
    "title": "Session cookies",
    "blockedOn": [
      { "$link": "/of:fid1:1kF-PJw_VqqjEcSQi-3KObKU_uNgtbewvIHUbKTWDns" }
    ]
  },
  {
    "$link": "/of:fid1:1kF-PJw_VqqjEcSQi-3KObKU_uNgtbewvIHUbKTWDns",
    "title": "CSRF tokens",
    "blockedOn": []
  }
]
```

**The address that went in is the address that came back**, and the graph read
is the proof: `1kF-PJw…` is the second row's own address AND the entry in the
first row's `blockedOn`. One item, two positions — an edge, not a copy. Had
the tracker stored contents, those would be two objects that merely look
alike, and nothing in the output could tell one item from two.

That spelling — the address exactly as a read printed it — dispatches where
the verb declares a reference, and the edge that lands is the target rather
than a copy. So does the `{"$link": …}` object a marked read renders the
address in, alone or beside contents the same read projected: the address
inside is what the position takes, and those contents, the target's own
fields, are not sent. The dispatch gate reads the DECLARED contract
([verb input contract](../../history/plans/verb-input-contract.md)) to know
which positions declare references, and the same contract refuses the two
payloads that could only ever be mistakes at one:

```bash
cf piece call "$KID" blockOn --on "not-an-address"

cf piece call "$KID" blockOn '{"on":{"title":"a copy"}}'
```

A string that is no address is refused naming the position and the `/of:…`
form a read prints. An inline copy is refused outright, because a
shape-matching payload at a reference position stores a detached document
inside the caller's own item and reports success. The link envelope #5880
landed stays accepted beside the emitted spelling —
[`verb-session-gaps.sh`][gaps] step 10 asserts every spelling apart.

The demo's acts 12 and 13 run all of it: the conversion, both refusals, and
the two-paths read as the payoff addresses exist for.

## The composition axis

Steps 5 and 8 are the same move — take an address out of one command and put
it into the next — and both halves now hold: the receiver half in full, and
the argument half under every spelling a caller might be holding.

| Direction | State |
| --- | --- |
| address → the receiver (first positional, or `--piece`) | works |
| a link envelope → an argument field | works (#5880) — the edge that lands is the target, not a copy |
| the address a read emits → an argument field | works — converted against the declared contract at the dispatch gate |

The pre-dispatch gate passes a link envelope opaquely where a verb declares a
reference (#5880), and converts the canonical string a read prints — the one
spelling a caller is actually holding, since every `$link` and `receipt` in
this session emits exactly that form. The positions it converts at come from
the DECLARED contract read off the compiled pattern, because the schema a
dispatch cell carries keeps only stream markers; the
[verb input contract](../../history/plans/verb-input-contract.md) is what
makes that declaration authoritative.

A tree mostly hides the argument half, because the natural shape is to call
the verb *on* the parent — the receiver carries the relationship, so no
address needs to be an argument. It surfaces the moment two items must be
related to each other: `blockOn`, a `duplicates` edge, a `move`, or a removal
that names a child rather than an index. Indices are not addresses; a
position shifts under concurrent writes.

[CLI surface shape](../../plans/cli-surface-shape.md) states the property for
commands — an address printed by one command is accepted by the next. The
argument half is the same property one level in, on arguments, and it holds
now at both. `cf piece set-slug` resolves its source positional through its
own path rather than the one `--piece` uses, and takes the emitted address
there too.

## What the session is waiting on

| Gap | Needs |
| --- | --- |
| An event interface's own comment absent everywhere | The one prose level that does not compile ([#5937](https://github.com/commonfabric/labs/issues/5937)). Nothing downstream can serve what was never emitted |
| `--select` completion, and refusal before the call | A provider reading the declared result the help page already resolves |

Two rows, and two that used to sit beside them are gone the way this table
intends: the served input schema now carries every declared event field —
the [verb input contract](../../history/plans/verb-input-contract.md) ruled the
authored event authoritative — and the address a read emits dispatches as an
argument, with the detached-copy refusal standing guard beside it (step 8).

<!-- Source links resolve against the repository's default branch, so they
     follow head rather than pinning a revision this document would outlive. -->

[tracker]: https://github.com/commonfabric/labs/blob/main/packages/cli/integration/pattern/tracker.tsx
[demo]: https://github.com/commonfabric/labs/blob/main/packages/cli/integration/verb-session-demo.sh
[gaps]: https://github.com/commonfabric/labs/blob/main/packages/cli/integration/verb-session-gaps.sh
[exec-schema]: https://github.com/commonfabric/labs/blob/main/packages/cli/lib/exec-schema.ts
[piece-lib]: https://github.com/commonfabric/labs/blob/main/packages/cli/lib/piece.ts
[completion]: https://github.com/commonfabric/labs/blob/main/packages/cli/lib/completion/providers.ts
