# The Verb Session

A running program is deployed, inspected, driven and re-read entirely from the
command line — with no tooling written for it. Everything the terminal knows,
it derived from the program's own TypeScript.

This is the tour: it defines the vocabulary, states what the verb surface is
for, and walks a whole session against a real pattern. Read it start to
finish. [A verb session, end to end](session-walkthrough.md) reports the same
session's measurements, its caveats, and what the surface still owes; come
here first and go there for the evidence.

## What this is for

The goal is narrow and testable: everything you can do to a running program,
you can do from the command line — and nothing had to be written per program
to make it so.

### Three words, and then the CLI makes sense

The system runs user-written programs. Three terms carry almost all of the
vocabulary, and they map cleanly onto ideas you already have.

| Term | What it is | The nearest familiar thing |
| --- | --- | --- |
| **Pattern** | A TypeScript module declaring some reactive state and the operations allowed on it. | A class definition — or a component, if you know Solid.js. |
| **Piece** | A running instance of a pattern, with durable state. Deploying a pattern makes one. | An object; a row; a live process with an address. |
| **Space** | The shared durable place pieces live in, named by a cryptographic identifier. | A database, or a tenant. |

The fourth term is the one this work is named for. A **verb** is an operation a
pattern declares — the only way a pattern changes its own state, an operator
writing a cell directly with `cf cell set` being a write that runs nothing and that
the next recomputation may overwrite
([the read and write session](../workflows/reading-and-writing.md)). In the
source it is a typed stream: an event type in, a result type out.

Every example from here on comes from one program: a work-item tracker,
written to be driven and nothing else. Items sit in a tree on a **board**, and
any item can be blocked by any other. The next section takes it apart; for
now, one of its verbs is enough to show the shape of a declaration.

```tsx
// Shown for illustration only.

/** Record that this item waits on another. The blocker may be anywhere on
 *  the board — this is the edge that makes the tree a graph. */
blockOn: Stream<BlockOnEvent, BlockOnResult>;
```

That single declaration is the whole contract. The event type says what a
caller may send, the result type says what comes back, and the doc comment
says what it is for. Everything in the session below — flags, help pages,
listings, validation, error messages — is derived from declarations like this
one, at the moment you ask.

Two more words show up in the output later and are worth having now. The
function behind a verb is its **handler** — the only code that changes the
piece's state, and the only place with privileges a caller lacks, such as
reading the clock. Calling a verb creates an **invocation**: a record that
settles, carrying the result if the verb declares one. A call returns that
record, not a bare value.

### The claim being tested

A system where programs are user-written has an awkward problem: someone
deploys a program you have never seen, and you need to operate it. The usual
answers are a bespoke UI per program, or a hand-written client per program.
Both mean that operating a piece requires someone to have anticipated you.

The verb surface is the other answer. A caller arrives knowing nothing, asks
the piece what it is and what it can do, and drives it. The test of whether
that works is not a design document; it is a transcript, and the session below
is that transcript.

**The thing to watch for.** Nothing in the session was authored for the
tracker. Every flag name, type, required-ness mark, man page, listing row,
error message and result field was computed from the pattern's TypeScript.
Swap in a different pattern and the same commands describe that one instead.

### What "fully functional" has to include

Six capabilities, because a surface missing any one of them sends you back to
writing a client:

- **Discovery** — arrive at a piece and learn what it is and what it can do, without being told.
- **Documentation** — read the author's own words about a verb and its parameters, at the terminal.
- **Invocation** — call a verb, with flags derived from its event type.
- **Reading** — ask for exactly the shape of answer you want, and no more.
- **Composition** — take an address one command printed and hand it to the next, unedited.
- **Refusal** — be told precisely what was wrong, before anything happens.

The last two are where the difficulty concentrated, and the session spends its
final acts there.

## The program under the demo

A work-item tracker, about 260 lines of TypeScript. It exists only to be
driven, and it is shaped to be awkward in exactly the ways the verb surface
has to be good at.

The fixture is
[`runtime/cli/integration/pattern/tracker.tsx`](../../../runtime/cli/integration/pattern/tracker.tsx).
It belongs to this demonstration and nothing else, so no product change can
quietly break the story — and no story pressure can bend a shipped pattern.

### Two patterns, and the second one is the interesting one

A **board** holds root items. An **item** holds its own subtree, its own graph
edges, and its own verbs — so the thing a create hands back is itself a fully
callable piece, with no separate lookup and no schema shipped alongside.

```tsx
// Shown for illustration only.

/** One work item: what it holds, and what it can do. */
interface ItemOutput {
  title: string;
  /** "open" until a verb changes it — "done" or "archived". */
  status: string;
  /** Append-only. Each entry carries a time the pattern stamped,
   *  not the caller: reading the clock is a handler capability. */
  notes: { body: string; at: number }[];
  /** The tree. */
  children: ItemOutput[];
  /** The graph. A blocker is any item anywhere on the board, not a
   *  descendant — which is what makes one item reachable by two paths. */
  blockedOn: ItemOutput[];

  addChild: Stream<AddChildEvent, AddChildResult>;
  recordNote: Stream<RecordNoteEvent, RecordNoteResult>;
  finish: Stream<FinishEvent, FinishResult>;
  blockOn: Stream<BlockOnEvent, BlockOnResult>;
  archive: Stream<void>;
}
```

Fields and verbs sit in one interface because that is what an item *is*. A
child in `children` is a full item; declaring it any narrower would be a claim
the runtime contradicts. The walkthrough's
[What you are driving](session-walkthrough.md#what-you-are-driving) carries the
full declaration, both patterns and every event and result type.

### Three design decisions, each aimed at a hard case

**A tree with cross-links.** An item is filed under one parent and can be
blocked by any other item anywhere on the board. So the same item is reachable
by two different paths — and that is where an address stops being a
convenience. Handing a caller the item's contents twice says nothing about
whether they are looking at one item or two copies. Only an address answers
that, which is why the session ends where it does.

**State a caller cannot set.** `title` is the only field supplied at creation.
Everything else — `status`, `notes`, `children`, `blockedOn` — belongs to the
pattern and changes only when a verb is called. That is what makes the verb
surface the whole interface rather than a convenience laid over a writable
document.

**Six verbs, five shapes.** The verbs are not six features. Each exercises a
different question a caller asks about what comes back, and the tracker
carries every one so that none goes undemonstrated.

| Verb | The shape it exercises | Where |
| --- | --- | --- |
| `addItem`, `addChild` | Returns a piece — an address the next command takes as its target, and a value that can be reached from inside itself. | acts 4 and 8 |
| `recordNote` | Returns what only the pattern could compute: the clock is a handler capability, so the timestamp cannot come from the caller. | act 7 |
| `finish` | Returns a derived fact — counting what is still open below takes a walk of the whole subtree, which a caller would pay N reads for. | act 8 |
| `archive` | Declares no result at all. The invocation settles carrying nothing, and what changed is a separate read. | act 9 |
| `blockOn` | Takes an address as an **argument** rather than as the receiver — the case a tree hides and a graph forces. | act 12 |

**Why a doc comment is load-bearing here.** Each comment above is not
decoration — it is the only source for what the terminal prints when someone
asks what a verb is for. An author writes it where the thing it describes is
declared, and the CLI reads it back out of the compiled pattern.
[An author's prose, over the CLI](prose-over-the-cli.md) is the full account of
which document carries which sentence.

## The session, act by act

Thirteen beats against a space that starts empty. Every block below is real
output from a run — the demo prints each command before running it, so the
transcript is the artifact.

Two environment variables are exported (the server URL and an identity key);
`-s` names the space. Everything else you see is the whole command. Addresses
are long content hashes — they are shortened with `…` below for width, and
printed in full by the real run.

### Acts 1–3 · Arrive knowing nothing

#### Act 1 · Arrive by name

Deploying the pattern makes a piece. A **slug** gives it a name in the space,
so the identifier this command prints is never typed again. The name is
discoverable rather than folklore: the space keeps a slug index, so someone
landing in a space another person populated starts from a listing.

**Deploy, and name it.**

```console
$ cf piece new runtime/cli/integration/pattern/tracker.tsx -s demo --slug board
fid1:QX-ZJYrB8ynVZvX5Ne_nWlvOaeOcfehraVa2-6et5tk

$ cf piece slugs -s demo
SLUG  PIECE
board fid1:QX-ZJYrB8ynVZvX5Ne_nWlvOaeOcfehraVa2-6et5tk
```

#### Act 2 · Ask what it is, and what it can do

One command is the piece's man page. Every sentence on it is a doc comment
from the source, compiled with the pattern and read back out of it. `STATE` and
`INPUTS` are split by who writes them: inputs are what a caller supplies, state
belongs to the pattern and moves only when a verb runs.

**The piece's own page.**

```console
$ cf piece describe -s demo --piece board
NAME    Work tracker
PATTERN cf:module/85fQFjnFuBYjduHt…#default (/tracker.tsx)

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

The board declares one verb, so the listing has one row. `items` is data, and
data is not callable — so it is never offered as something to call.

#### Act 3 · Ask what a verb wants

The help page is assembled from two sources: the structure comes from the event
type, the sentences come from the author's doc comments. Neither was written
for the CLI.

**A verb's own help page.**

```console
$ cf piece call -s demo --piece board addItem --help
File a new root item on the board.

JSON input:
  Pass inline JSON as one positional argument or after `--json`.
  {
    title: string
  }

Flags:
  --title <string>  Required. One line naming the work.

Output:
  The invocation's `result`:
    item <json>  The root item this call created.
```

`--title <string> Required.` falls out of `{ title: string }`. *One line naming
the work* is the comment on that field. The `Output:` section appears only
because this verb declares a result — a verb that declares none has no such
section, rather than an empty one.

### Acts 4–6 · Create, and carry the address forward

#### Act 4 · Create, and act on what you were handed

The create returns the piece it made, as an address. That address is the whole
of what later commands need — and it goes into the next command exactly as
printed, standing bare in the first position. An address begins with `/` and a
relative path never does, so the two cannot collide.

`--select` appears here for the first time and carries the rest of the session,
so it is worth stating in full. A selection names the shape of the answer;
anything not named is left out.

| Spelling | What comes back |
| --- | --- |
| `title,status` | Those two fields and nothing else. |
| `item.title` | Walks into `item` and keeps `title`. It prunes rather than flattens — the answer is still shaped like the result. |
| `@` | The **address** of the position being read, in place of its contents. |
| `item@` | The address `item` holds — rather than following that link and copying whatever is behind it. |
| `children@` | Applied across an array: each element's own address. |
| `@,title` | Both — the address beside the field. |

An address always arrives under the key `$link`, which is why that key is
everywhere in the output from here on. So `--select item@` below asks for
*where the new item lives*, not a copy of it. The full account of the suffix —
marking positions deeper than a link, the `{"$link": true}` spelling a JSON
Schema uses, and escaping a literal `@` — is in
[verbs over the CLI](over-the-cli.md#asking-a-read-for-an-address).

Note where it stands on the line. The verb name opens the verb's own section
and `--` closes it, so a verb's fields are written straight after the name and
the read options come past the marker. That is the order the words become
knowable: a result has to be named before it can be shaped, and a projection
written before the verb would name positions in a result nothing has
identified. `cf cell get` and `wish` have no verb between them and their read
options, so they need no marker — the read options still come last.

**A create hands back an address.**

```console
$ cf piece call -s demo --piece board addItem --title 'Login rewrite' -- --select item@
{
  "invocation": "74c9fde6-bdee-4163-9775-b2f7f38add94",
  "status": "settled",
  "receipt": "/of:fid1:sE-3T7t35uBkvKndib5FzQuaGnBRPhwhWPPvLPMIPbU",
  "result": {
    "item": {
      "$link": "/of:fid1:i4v6HTLQqLO4a7cDo9Vzexxs8fb5zZK0vLRrDogTIQs"
    }
  }
}
```

Reading that address off the screen is fine by hand. To keep it in a script you
pipe the response through [jq](https://jqlang.github.io/jq/), the standard
command-line JSON tool: `-r` asks for the raw string rather than a quoted one,
and the path walks the response — `.result`, then `.item`, then the `$link` the
`@` produced. The quotes around `$link` are load-bearing: jq reads a bare
`.$link` as one of its own variables, so the unquoted form fails to compile at
all.

**The same call, captured — and the address goes into the next command unedited.**

```bash
EPIC=$(cf piece call -s demo --piece board addItem --title 'Login rewrite' -- --select item@ \
       | jq -r '.result.item."$link"')

cf piece verbs -s demo --piece "$EPIC"
```

```text
PATTERN cf:module/85fQFjnFuBYjduHt…#Item
NAME       KIND    ON     MARKS
addChild   handler result
    File a new item beneath this one.
archive    handler result
    Mark this item archived. Declares no result — the value-less shape.
blockOn    handler result
    Record that this item waits on another. The blocker may be anywhere on
    the board — this is the edge that makes the tree a graph.
finish     handler result
    Mark this item done. Descendants are left alone — finishing a parent
    says nothing about its children.
recordNote handler result
    Append a progress note. Notes are append-only; nothing rewrites one.
```

Every verb an item has, and not the board's one. The listing was derived from
the piece in front of you, so an address alone is enough to discover a surface
you were never told about.

#### Act 5 · Read addresses instead of contents

A read is a query: you name the shape you want. An unshaped read follows every
link and carries everything — measured at 3183 bytes for a single child on this
pattern. Naming what you want brings it to 51. Here the `@` from act 4 crosses
an array, so each child answers with its own address, and `title` rides beside
it.

**Projection: names and addresses only.**

```console
$ cf cell get -s demo /of:fid1:i4v6HTL…gTIQs children --select @,title
[
  { "$link": "/of:fid1:SKf22px…N5UfM", "title": "Session cookies" },
  { "$link": "/of:fid1:d4ppvfP…Pqsls", "title": "CSRF tokens" }
]
```

#### Act 6 · Ask the same question twice

The demo runs the identical command a second time, deliberately — because the
first thing anyone watching a live system says is *show me that again*. Asking
again changes nothing.

That is the read/call dividing line the whole session rests on. A read is a
question, and asking it has no effect — which is what makes reads safe to
script. It is not a promise that two reads agree: a read answers from the state
it finds, so anything written in between shows up the second time. These two
agree because nothing else is writing to this fixture, which is also why the
addresses the later acts drive can come out of this read rather than a hidden
second one.

A call is the opposite of effect-free: it runs the handler body, so asking
twice does the work twice. Act 7 shows what a caller does instead.

### Acts 7–9 · What a verb hands back

#### Act 7 · A verb returns what only the pattern could compute

The note's timestamp is the pattern's. Reading the clock is a capability a
handler has and a caller does not, so this value could not have been supplied
from outside.

**A stamp the caller could not have sent.**

```console
$ cf piece call -s demo /of:fid1:2zR3_Jo…mC84 recordNote --body 'blocked on the cookie spec'
{
  "invocation": "58cb83ba-51c0-453d-87a4-b53e9ec9537d",
  "status": "settled",
  "receipt": "/of:fid1:5dl-nOAgrKiU39qtTtfaBRZnR7DJCmAkxvMX1lrpz_4",
  "result": {
    "note": { "at": 1787075808000, "body": "blocked on the cookie spec" },
    "noteCount": 1
  }
}
```

The `at` field is the one to watch: `1787075808000` came from the handler, and
nothing in the command carries it.

Act 6 asked a read twice. A call cannot be asked twice — it would run the
handler again — but it does not need to be. That `receipt` is the address of
the cell this handling wrote its outcome to, and reading it is an ordinary read.

**The outcome, without calling anything again.**

```console
$ cf cell get -s demo /of:fid1:5dl-nOA…pz_4 --select note,noteCount
{
  "note": {
    "at": 1787075808000,
    "body": "blocked on the cookie spec"
  },
  "noteCount": 1
}
```

The same `at` comes back, off the receipt rather than off a second call.

**What that does not prove.** A receipt is a frozen snapshot of the outcome its
handling committed, so it reports that outcome whether or not anything has
happened since. Reading it back cannot, on its own, tell you the handler did
not run again — the numbers inside would look the same either way. Only the
piece can settle it, and this act reads it at the end.

**That route needs the address.** When a caller never got one — a dropped
connection, a response nobody saw — the invocation id is the handle instead.
Name a call with `--invocation`, and replaying that id hands the original
outcome back. The second payload below is deliberately different text.

**The same id, a different payload.**

```console
$ cf piece call -s demo --invocation note-retry /of:fid1:3bSpAHm…JIRk recordNote --body 'first attempt'
$ cf piece call -s demo --invocation note-retry /of:fid1:3bSpAHm…JIRk recordNote --body 'a different body entirely'
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

Two things in that envelope are the answer: `"deduplicated": true`, and a
`body` reading `first attempt` rather than the second call's text. But the same
caution applies: a replay is *defined* to hand the original snapshot back, so
this envelope would read the same whether or not a second note actually landed.
The board is what settles it.

**Where a second note would have shown up.**

```console
$ cf cell get -s demo /of:fid1:akNXtBX…JfUU notes --select body
[
  { "body": "blocked on the cookie spec" },
  { "body": "first attempt" }
]
```

Two entries, from the two calls that committed, and the replay's text is not
among them. That is the proof; the envelopes could not have given it.

An id is only half the handle — it is scoped to an **invocation session**, so
one agent's `note-retry` is not another's. Mint one per run and keep it in
`CF_INVOCATION_SESSION`: out of argv means out of shell history and the default
process listing, which reduces casual exposure rather than making it a secret
store.

**A retry is still not free.** Read the guarantee precisely: at-most-once
*commit*, not at-most-once *execution*. The redelivered event re-runs the
handler body and then loses the race for the receipt, so a verb that reaches
outside its transaction — an LLM call, a fetch, a message sent — repeats those
effects on every retry. Retry freely for a verb that only writes its own space;
prefer the receipt for one that reaches beyond it.

#### Act 8 · Finishing reports what the caller could not know

`finish` hands back how many items are still open beneath this one. That takes
a walk of the whole subtree — a caller computing it would pay one read per
level. One call, one answer.

#### Act 9 · A verb that declares no result

`archive` is `Stream<void>`: nothing to supply, nothing handed back. The call
is the verb's name alone, and the invocation settles carrying no `result` key
at all — not an empty one. What changed is a read away, and the address may
carry the path, so one word names the piece and the field in it.

**The value-less shape.**

```console
$ cf piece call -s demo /of:fid1:SKf22px…N5UfM archive
{
  "invocation": "cf78ac78-75d8-4d4b-a461-c341b9f41534",
  "status": "settled",
  "receipt": "/of:fid1:0u1OqcMyuo2Zo7JK1XgqNL03xHUtEDI_Ur9ug6tsRW0"
}

$ cf cell get -s demo /of:fid1:SKf22px…N5UfM/status
"archived"
```

### Act 10 · Step back

#### Act 10 · Read the board

Every change so far was seen one call at a time. One read from the name the
session started with shows the tree they add up to — and a filter decides
membership before projection, so a field can select without appearing in the
output.

**Depth is a call; breadth is a read.**

```console
$ cf cell get -s demo --piece board items --select title,status,children@
[
  {
    "status": "done",
    "title": "Login rewrite",
    "children": [
      { "$link": "/of:fid1:SKf22px…N5UfM" },
      { "$link": "/of:fid1:d4ppvfP…Pqsls" }
    ]
  }
]

$ cf cell get -s demo /of:fid1:i4v6HTL…gTIQs children --select title --filter '.status == "open"'
[ { "title": "CSRF tokens" } ]
```

### Act 11 · Being told no

#### Act 11 · Ask for something that is not there

Every act so far named something the pattern declares. Getting it wrong is the
other half of a surface that knows its own vocabulary — and the answers come
from two entirely different pieces of code, in one voice.

**A typo on a call, and a typo on a read. Both blocks below are refusals.**

```console
$ cf piece call -s demo --piece board addItem '{"title":"Ship it","titel":"typo"}'
Invalid input for "addItem": "titel" at <event> is not a field this verb
declares. Did you mean "title"? <event> takes "title"

$ cf cell get -s demo /of:fid1:i4v6HTL…gTIQs children --schema '{"type":"array","items":{"type":"object","propertes":{"title":true}}}'
Invalid --schema at <root>[]: "propertes" is not a projection schema keyword.
Did you mean "properties"? Projection reads "type", "properties", "items",
"additionalProperties", "$link"
```

Each names what was wrong, the position it sat at, what that position accepts,
and the nearest thing you probably meant.

**A refusal is a capability, not a failure.** What it replaces is worse than an
error. A payload carrying `titel` used to be accepted, the unknown field
dropped on the way in, and the caller told the call settled — a silent strip
that a hand-written or model-written JSON payload hits and a TypeScript author
never does. Both refusals land before an invocation exists, so nothing is
spent.

### Acts 12–13 · The graph, and the payoff

#### Act 12 · Relate two items

Here the address stops being a receiver and becomes an **argument**. A tree
hides this case — you call the verb *on* the parent, so the receiver carries
the relationship. A graph forces it: two items must be related to each other,
and the second one has to be named.

**The address as printed, standing as an argument.**

```console
$ cf piece call -s demo /of:fid1:SKf22px…N5UfM blockOn --on /of:fid1:d4ppvfP…Pqsls -- --select blocked@,on@,blockedOnCount
"result": {
  "blocked":         { "$link": "/of:fid1:xIWrhn5…nWsK4" },
  "blockedOnCount":  1,
  "on":              { "$link": "/of:fid1:d4ppvfP…Pqsls" }
}
```

The `on` address that came back is `d4ppvfP…Pqsls` — the same string that went
in. What landed is an *edge to that item*, not a copy of its contents. It would
go in again either way: as that bare string, or inside the `{"$link": …}`
object the read printed it in, which the gate reads as the address it carries.

Two payloads could only ever be mistakes at a position like this, and both are
refused by name.

**Guarding a reference position. Both blocks below are refusals.**

```console
$ cf piece call -s demo /of:fid1:SKf22px…N5UfM blockOn --on not-an-address
"not-an-address" at <event>.on is not an address — the position declares a
reference, and takes the /of:… form a read prints

$ cf piece call -s demo /of:fid1:SKf22px…N5UfM blockOn '{"on":{"title":"a copy"}}'
<event>.on declares a reference, and an inline copy would store a detached
document rather than an edge — send the address a read printed
```

**The second refusal is the one worth understanding.** A payload shaped like
the target validates perfectly against the schema — so it used to be accepted,
stored as a detached copy inside the caller's own item, and reported as
success. Nothing pointed at anything. Refusing it required the CLI to know
which positions declare a reference, which is a fact only the compiled pattern
still carries by the time a schema reaches the wire.

#### Act 13 · One item, two paths, one address

The closing read is the point of the whole session. The same item appears twice
— once as a child in its own right, once inside the `blockedOn` of the item
waiting on it — and it is *the same string* in both places.

**An edge, not a copy.**

```console
$ cf cell get -s demo /of:fid1:i4v6HTL…gTIQs children --select @,title,blockedOn@
[
  {
    "$link": "/of:fid1:SKf22px…N5UfM",
    "title": "Session cookies",
    "blockedOn": [
      { "$link": "/of:fid1:d4ppvfP…Pqsls" }
    ]
  },
  {
    "$link": "/of:fid1:d4ppvfP…Pqsls",
    "title": "CSRF tokens",
    "blockedOn": []
  }
]
```

`d4ppvfP…Pqsls` is the address to follow: it stands inside the first item's
`blockedOn`, and again as the second item's own `$link`. Had the tracker stored
contents instead of addresses, this output would show two objects that happen
to look alike, and a caller could not tell one item from two. The matching
address is the proof.

## How the story is kept honest

A demo that drifts from the system it describes is worse than no demo. Three
artifacts check each other, and two of them run in CI:

| Artifact | What it guarantees |
| --- | --- |
| [`verb-session-demo.sh`](../../../runtime/cli/integration/verb-session-demo.sh) | Prints each command and runs that same command — there is no second, prettier spelling. An act claiming a refusal that no longer happens fails the run, and so does one claiming a success it does not get. |
| [`verb-session-gaps.sh`](../../../runtime/cli/integration/verb-session-gaps.sh) | Asserts the same surface as pass/fail in CI. It also carries a `gap` assertion for a capability that is deliberately absent, which fails loudly the day that capability arrives — so a gap closing gets noticed rather than aging into a stale document. |
| [`check-verb-session-sync`](../../../tasks/check-verb-session-sync.ts) | Every command quoted in this page and in the walkthrough must be a command the demo actually runs, and every act number must name a real act. Prose cannot invent a command that was never executed. |

Read the harness's summary line carefully: a count of zero open gaps means
nothing is currently asserting one, which is not the same as the surface being
complete. What the surface still owes is tracked in prose, in the walkthrough's
[What the session is waiting on](session-walkthrough.md#what-the-session-is-waiting-on).

## Running it yourself

Start the local servers, then run the demo against them. It deploys into a
fresh throwaway space and needs nothing set up first, and takes about thirty
seconds end to end.

```bash
./scripts/start-local-dev.sh
runtime/cli/integration/verb-session-demo.sh

# and the pass/fail version:
runtime/cli/integration/verb-session-gaps.sh
```

## Where to read further

- [Verbs over the CLI](over-the-cli.md) — what a verb hands back: declared results, piece references, and what a retry does and does not guarantee.
- [A verb session, end to end](session-walkthrough.md) — the same session's measurements, its caveats, and what the surface still owes.
- [An author's prose, over the CLI](prose-over-the-cli.md) — how an author's doc comments reach a caller, and which of the two documents the CLI reads carries what.
