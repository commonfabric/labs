# Verbs over the CLI

A **verb** is a pattern's callable surface: a `Stream` property a caller invokes
with `cf piece call`. This document is about what a caller gets *back*.

A verb can declare a result, and the caller reads it off the call. That turns a
sequence of "mutate, then go looking for what happened" into a single
exchange — and the thing a verb hands back can be a **piece**, so a create tells
you where the thing it created lives.

Every command here takes a target the caller already holds — written as a
reference in the first positional, or on `--cell`. Reaching one
without an id in hand is [an agent over the CLI](agents-over-the-cli.md).

For the authoring side, see [concepts/action.md](../concepts/action.md) and
[concepts/handler.md](../concepts/handler.md); for the general CLI loop, see
[workflows/development.md](../workflows/development.md).

## Declaring a result

A verb's type carries its result as the second parameter, and the body returns
it:

```tsx
import {
  action,
  type Default,
  pattern,
  type Stream,
  type Writable,
} from "commonfabric";

interface NoteOutput {
  title: string;
}

const Note = pattern<{ title: string }, NoteOutput>(({ title }) => ({ title }));

interface AddNoteEvent {
  title: string;
}

interface AddNoteResult {
  /** The note this call created — the piece itself, not a minted identifier. */
  note: NoteOutput;
}

interface BoardOutput {
  notes: NoteOutput[];
  addNote: Stream<AddNoteEvent, AddNoteResult>;
}

export default pattern<
  { notes?: Writable<NoteOutput[] | Default<[]>> },
  BoardOutput
>(({ notes }) => {
  const addNote = action<AddNoteEvent, AddNoteResult>(({ title }) => {
    const note = Note({ title });
    notes.push(note);
    // Return the piece itself. Patterns return references; rendering identity
    // as an address is the client's job.
    return { note };
  });
  return { notes, addNote };
});
```

A verb that declares nothing stays spelled `Stream<Event>` and is a value-less
verb — the overwhelmingly common shape. `Stream<E, R>` and `Stream<E>` are
deliberately not interchangeable, so a declared result cannot be dropped
silently on assignment.

## What the CLI gives you

### Ask what a piece can do

`cf piece verbs` lists a piece's callables, and the listing carries the deployed
pattern's source identity — so you can tell which version you are talking to
before relying on any of its behavior.

```bash
cf piece verbs --cell <piece> --json
```

Each row carries the verb's input schema and, when the verb declares a result,
the schema of what it hands back — so both halves of "what may I send, and what
do I get" are answerable before the first call rather than by making one:

```json
{
  "name": "addNote",
  "kind": "handler",
  "on": "result",
  "inputSchema": { "…": "…" },
  "outputSchema": {
    "type": "object",
    "properties": { "note": { "$ref": "#/$defs/NoteOutput" } },
    "required": ["note"],
    "$defs": { "…": "…" }
  }
}
```

A value-less verb carries no `outputSchema` at all, which is how a caller tells
the two apart without calling.

The listing is read from the compiled pattern the piece is pinned to: its
declared result type, the result graph it wires, and its declared argument
type. Nothing below the piece's own document is read, so listing a board's
verbs costs the same whatever the board holds. That also settles what gets
named: a pattern whose result type is its argument schema reused still returns
the streams and tools it wired, and those are listed off the graph — a handler
by the node that drives it, a tool by the tool value itself — so a verb the
declared type omits is as listed as any other, while a data field is never
offered as callable, whatever the pattern hangs at that name.

Every row says where it lives: the row's `on` names the cell `cf piece call`
will reach it on. Result shadows input there exactly as it does in
`cf piece call`, so a name both types declare is listed — and called — on
the result cell, carrying that cell's event. Build a payload from the row and it
is the payload the verb you reach expects.

Two things the listing cannot say, worth knowing before treating an empty
listing as an answer:

- The listing describes the pinned pattern, not the piece's stored state. A
  handler the piece stores that its pattern neither declares nor wires is not
  listed; given its name, `cf piece call` still reaches it.
- When the compiled pattern cannot be read, the listing has no source of names
  at all and is empty. It says so rather than passing the emptiness off as the
  surface: `incomplete` carries `"pattern-unavailable"` in `--json`, and the
  human listing prints the same note. Every verb the piece stores is still
  callable by name.

So absence from a listing that reports no `incomplete` means the pinned pattern
declares and wires no verb of that name — strong enough to enumerate against,
not strong enough to prove a named verb does not exist.

One verb at a time, `--help` answers the same question from the callable
itself:

```bash
cf piece call --cell <piece> <verb> --help
```

```text
Output:
  The invocation's `result`:
    note <json>
```

The section names where the value arrives rather than describing stdout,
because a handler's result rides the Invocation JSON below. A value-less verb's
page carries no `Output:` section at all — the same distinction the listing
draws, drawn on the page a caller is already reading before the first call.
`--help --json` serves the declared result as `outputSchema`, descriptions and
all, for a client that wants the schema rather than the summary.

### Call a verb and read its result

`cf piece call` prints one settled **Invocation JSON** object on stdout:

```bash
cf piece call --cell <board> addTopic \
  '{"title":"Ship the thing","body":"the initial document","agentName":"Sol"}'
```

```json
{
  "invocation": "0f4c…",
  "status": "settled",
  "receipt": "/of:fid1:…",
  "result": { "topic": { "$NAME": "Ship the thing", "…": "…" } }
}
```

The `result` is what the verb returned. Here that is the created topic piece,
so the caller can address it directly instead of filing it and then searching
the board for the thing it just made — a search that is a guess the moment two
callers file concurrently.

Anything the *pattern* resolved comes back too. A verb that stamps a write time
or derives structured authorship from the event returns those in its record;
the caller could not have computed them.

The `receipt` is where that outcome lives: the address of the cell this
handling wrote it to, written as one string in the reference syntax
`--cell` reads. Keep it and the result is re-readable without calling anything
again —

```bash
cf cell get --cell "$(echo "$RESULT" | jq -r .receipt)"
```

— which is an ordinary read, so the verb's body does not run a second time.
The address is known at commit rather than at readback, so it rides every
envelope, including `--no-wait`'s. It is absent only where the runtime wrote no
receipt to name.

### Asking for a smaller result

A verb decides what it returns; the caller decides how much of it to look at.
`--filter`, `--select`, and `--schema` — the same three flags `cf cell get`,
`cf wish` and `cf exec` take, with the same grammar — shape the `result` before
it reaches stdout, and come after the thing they shape.

One rule covers all four commands, and it turns on whether a callable's own
vocabulary stands between the command and the read options. `cf cell get` and
`cf wish` have none, so nothing separates their read options from the rest of
the line. `cf piece call` and `cf exec` have one, so a marker closes it:

```text
cf cell get  <addr> [path]           --select …
cf wish <target>                --select …
cf piece call <target> <verb> <input> -- --select …
cf exec <mountedFile> <input>   -- --select …
```

The name that opens the callable's section — the verb on `call`, the mounted
file on `exec` — needs no marker of its own, the same boundary `docker run`
draws at an image name and `ssh` at a host. `--` is spent on the boundary no
positional draws: where the callable's section ends and the read step's begins.

A projection written before the verb is refused rather than accepted quietly,
because it would name positions in a result nothing has identified yet; so is
one written inside the callable's section, where the verb's own fields are
read and either vocabulary may grow a name the other already has. Each refusal
names the section the flag belongs to and prints the line that works.
`--help` is the one word that crosses the marker on purpose: written past it,
it still reaches the callable and prints that verb's page, since a caller
wanting the command's own page writes it with no verb at all.

Where a command has no callable section at all, `--` closes nothing: it is
refused on `cf cell get`, `cf cell set` and `cf wish` rather than silently setting aside
words that nothing reads.

```bash
cf piece call --cell <topic> addComment '{"body":"first","agentName":"Sol"}' \
  -- --select comment.writtenAt
```

```json
{
  "invocation": "0f4c…",
  "status": "settled",
  "result": { "comment": { "writtenAt": "2026-08-07T09:15:27Z" } }
}
```

A selection over a schemaless handler receipt first loads the receipt without
following its children. If it holds an object or array, the selection reads from
that container and can avoid fetching unselected linked content. Root links,
instances, scalars, and receipts read through an explicit schema are materialized
before selection, as are tool results. A root link can resolve to an absent
value, so its stored existence alone does not establish a result.

A value-less verb keeps reporting no `result` at all — there is nothing for a
selection to be about — and `--no-wait`, which never reads the receipt back,
refuses all three flags. `--show-links` composes with a projection, because a
projection leaves every surviving path where it was; it does not compose with
`--filter`, which moves the positions a link names.

**A field list is held to what the verb's result declares.** A name the
declared result proves cannot be there — one the position neither declares nor
admits, one below a scalar, one below a verb — is refused before the read and
names the vocabulary that position takes. A name it declares that simply holds
nothing returns nothing, which is what an optional field is entitled to. Where
the result carries no declared shape, nothing holds the list and
every name is read as written. A JSON `--schema` states a shape of its own and
is held to none of this.

**A verb reached through a filesystem mount is the same call.** `cf exec` takes
the three flags too, past the marker that closes the section the mounted file
opened — everything between the two belongs to the callable's own
schema-derived interface. It settles the handling under an invocation of its
own and prints the same Invocation JSON this section shows, so a mounted
handler's outcome has an address and a shape rather than being unreported:

```bash
cf exec /tmp/cf/<space>/pieces/<piece>/result/addComment.handler \
  --body first --agent-name Sol \
  -- --select comment.writtenAt
```

<!-- check-address-examples-ignore: //space/piece@scope a grammar line, whose three parts are holes rather than one address -->

A tool prints its result on stdout as it always did, with the result cell's
address on stderr. The line spells out the whole command that reads it back,
and the address is one token that carries all three parts — space, id, and
scope — as the `//space/piece@scope` reference a target position takes whole.
Naming the space inside the token is what makes the command portable: `cf exec`
gets its space from the mount it ran through, while the suggested read falls
back to whichever space the caller has configured, so an address that named
only id
and scope would read the right cell only for a reader configured for the same
space.

`packages/cli/README.md` has the grammar and the supported schema subset.

### A result that points back at its container

A verb that hands back the piece it created returns a value you can reach from
inside itself, whenever that piece carries a back-reference — `parent` beside
`children`, the shape [self-reference](../concepts/self-reference.md) documents.
A circle has no JSON rendering, so there is nothing to write for a readback
that follows one.

Ask for no shape and `cf` derives one from the verb's declared result. The
position where the declared type re-enters itself is the position that closes
the circle, so that position renders its address and the rest reads as it
always did:

```bash
cf piece call --cell "$EPIC" addChild --title "Session cookie handling"
```

```json
{
  "invocation": "c5df…",
  "status": "settled",
  "result": {
    "item": {
      "title": "Session cookie handling",
      "status": "open",
      "children": [],
      "parent": { "$link": "/of:fid1:…/parent" }
    }
  }
}
```

That address is the one a `$link` marker would have produced by hand, so the
derived answer and a written one agree.

A verb whose declared result is narrower than the value behind it is bounded a
second way. `addTopic` is the case: it hands back the topic it created and
declares a compact row over it, so a create does not expand that topic's prose,
its thread, and every sibling it references. The row re-enters nowhere, and the
circle a readback of the topic closes — through its view, into a profile, into
that profile's own view — is at no position the row names. There is nothing
there for a recursion cut to land on, and the bound is the declared shape
itself: every object position the declaration closes is held to the fields it
declares, and what comes back is the row its author wrote. A position the
declaration leaves open — an index signature beside its named members — still
reads every key stored at it, because those keys are declared too.

```bash
cf piece call --cell "$BOARD" addTopic --title "Session cookie handling" \
  --agent-name b7
```

```json
{
  "invocation": "9a71…",
  "status": "settled",
  "result": {
    "topic": {
      "title": "Session cookie handling",
      "createdAt": 1756400000000,
      "createdBy": { "kind": "agent", "name": "b7" },
      "commentCount": 0
    }
  }
}
```

The two bounds are tried weakest first, so neither narrows anything it does not
have to: a result the recursion cut renders is never held to the declared shape
as well.

A shape you asked for wins wherever it renders: `--filter`, `--select` and
`--schema` are applied to the receipt first, and one that narrows past the
circle — `--select item.title` — comes back exactly as written, with nothing
derived added to it. One that keeps the circle — `--select item`, which names
the re-entering subtree whole — is bounded on the way out, and the bound is a
cut into what you selected rather than a shape that replaces it: the closing
position renders its address, and no position you did not name comes back
beside it. A position you asked for the address of — `--select
'item@,item.parent'` — still answers with that address, which was your whole
answer there rather than a field of what sits behind it. `--select item.parent`
names the closing position itself, and answers with that one address alone.

Where nothing bounds it — the verb declares no result, the declaration
describes no less than the value does, or a `--filter` is in play, whose
surviving elements no longer say which positions they came from and so cannot
carry an address — the call names the position the circle closes at and the
receipt to collect the outcome from, and exits nonzero. Read that as the result
being unrenderable, never as the mutation having failed: **the write landed**,
and the message says so. A `--filter` reaches a renderable answer by naming a
projection beside it that narrows past the circle.

### Retries are safe, and cheap to reason about

`--invocation <id>` makes a call idempotent. The id is your own word for the
call — and `add-comment-1` is a word two agents both reach for, so an id on its
own does not say whose invocation it is. An **invocation session** does. Mint
one per agent run and carry it on every call of that run:

```bash
export CF_INVOCATION_SESSION=$(cf invocation-session new)
```

The environment is where a session belongs: it is what keeps an outcome's
address out of reach of a stranger, and keeping it out of argv keeps it out of
shell history and of the process listing anyone gets by default. That is a
reduction in casual exposure rather than secret storage — `ps -E` prints the
environment too, so treat the session as a credential either way. `--invocation-session <id>` overrides it for one call.

The pair is what names an invocation. Replaying a settled id **from the session
that chose it** hands back the **original** result, and nothing is written a
second time:

```bash
cf piece call --cell <topic> --invocation add-comment-1 \
  addComment '{"body":"first","agentName":"Sol"}'

# Same id, same session, different payload: the original result comes back,
# and no second comment is recorded.
cf piece call --cell <topic> --invocation add-comment-1 \
  addComment '{"body":"different","agentName":"Sol"}'
```

That is the property an agent depends on when it retries a call whose response
it never saw.

**A receipt witnesses the commit, not the execution.** The replay above does run
the handler body again; it then loses the race for the create-only receipt, so
its commit is refused and no second comment is recorded. What it cannot undo is
anything the body did *outside* that transaction: a verb that sends mail or
spends a model call does it twice, and a write it made into another space
commits before the receipt is contested and is not rolled back when the receipt
is lost. So retry freely for a verb that only writes its own space, and prefer
reading the `receipt` address for a verb that reaches beyond it — that collects
the same outcome without running anything.

That same id under a **different** session is a different invocation: it
executes, and returns its own result. So two agents that pick the same word are
never told each other's calls have settled, and knowing a piece, a verb and an
id is not enough to read someone else's outcome — the session is the part a
stranger cannot guess.

`--invocation` therefore requires a session, and a call naming an id without one
is refused, pointing you at `cf invocation-session new` and
`CF_INVOCATION_SESSION`. Pass neither and both are minted for that one call: a
random id names an outcome nothing else will ask for, and a call that never
intended to replay loses nothing.

A **rejected** call is different from a settled one: it never spends its id. If
a verb refuses the payload, correct it and retry under the same id.

```bash
# Refused: nonzero exit, nothing written — and `add-1` is NOT spent, because
# the payload never became an event.
cf piece call --cell <board> --invocation add-1 \
  addTopic '{"title":"","agentName":"Sol"}'

# The same id, corrected. This one executes; a settled id would have replayed
# instead.
cf piece call --cell <board> --invocation add-1 \
  addTopic '{"title":"Corrected","agentName":"Sol"}'
```

That is the difference worth holding onto: a **settled** id replays its original
result, while a **refused** id was never consumed and is still yours to use.

### A field the verb does not declare

A payload is judged against the verb's declared event schema before anything is
sent, and a field that schema does not name is refused there. The runtime hands
a handler the fields its event schema names and drops the rest, so a field
nobody declared would otherwise reach nothing while the call reported itself
settled. The refusal names the field, the position it sat at, the vocabulary
that position takes, and the declared name it is one edit from:

```bash
cf piece call --cell <board> addTopic '{"titel":"Ship it","agentName":"Sol"}'
```

```
Invalid input for "addTopic": "titel" at <event> is not a field this verb
declares. Did you mean "title"? <event> takes "title", "body", "agentName"
```

Positions below the root are spelled the way a `--schema` position is —
`<event>.item`, `<event>.tags[1]` — so one vocabulary covers this refusal and
the one an unrecognized projection key gets.

Every position that names its fields is judged, however it names them: with a
stated `type: "object"`, with a `properties` map and no type beside it, with a
type union admitting an object, or through a conjunction — whose fields are the
**union** across its members, since a payload satisfying an `allOf` satisfies
every one of them.

Two kinds of position are passed over, and a call reaching one goes out rather
than being refused on a guess. Under a **disjunction** (`anyOf`, `oneOf`) a
payload need satisfy only one branch, so a field missing from one branch may be
named by another. And a position marked as a cell or a stream may hold a link
rather than a value, whose `"/"` is nothing anybody declared.

The declared vocabulary is what `cf piece call --cell <id> <verb> --help`
prints, and it names the fields the verb's handler **reads**. That can be fewer
than the TypeScript event type declares: a field the body never touches is one
the runtime would have dropped, so the call is refused rather than accepted and
quietly emptied. A verb that publishes no event schema at all takes any payload
— with nothing declared, nothing is dropped either.

Like every other refusal here, this one costs nothing: the invocation id was
never spent, and the corrected retry can reuse it.

### Reading is not calling

`cf cell get` reads data. A path that lands on a verb is refused and redirected
to `cf piece call` — the spelling the diagnostic literally prints — because
reading a verb would return the stream's serialization — never what a
caller wanted.

### Watching where the time goes

`--verbose` streams per-phase wall-clock timings to **stderr**, leaving stdout
as clean Invocation JSON you can pipe into `jq`:

```text
timing: initial_sync → dispatched 424.5ms
timing: dispatched → committed 129.8ms
timing: committed → readback 0.0ms
timing: readback → settled 72.8ms
```

`--await` and `--no-wait` control whether the call waits for settlement and
readback or exits once the commit is acknowledged.

What `committed` acknowledges is the caller's own durable act. Off server
execution that is the handling's commit: the handler has run. Under server
execution the caller's act is the event append — the serving loop runs the
handler afterwards — so `committed` arrives as soon as the event is on the
record, and the readback that follows is what waits for the served handling
to land before it reads the receipt. A handling the server refuses, drops,
or fails is reported there, as the readback's failure.

### Dispatching now, collecting later

`--no-wait` returns at `"committed"`: the caller's act is durable — the
handler has run, or under server execution the event is appended and the
server will run it — and only the readback is skipped. The envelope still
carries the `receipt`, so a detached call is a handle rather than a dead end —

```json
{
  "invocation": "add-1",
  "status": "committed",
  "receipt": "/of:fid1:…"
}
```

— and collecting the outcome later is `cf cell get --cell <that string>`.
Replaying the same id and session recovers it too, but that re-runs the handler
body: a verb that sends mail or spends a model call does it again. Reading the
address does not.

## Which results arrive, and when

Two paths deliver a result, and both arrive by default:

- A result **carrying cells or pieces** — like a create returning the piece it
  made — travels the result-pattern projection path.
- A result that is **plain JSON** — a record of what was written — projects into
  the receipt under the `plainResultReceipts` runtime option, which is on by
  default ([EXPERIMENTAL_OPTIONS.md](../../development/EXPERIMENTAL_OPTIONS.md)).
  `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false` restores the discard, which is a
  rollback switch rather than something a caller opts into.

So a verb that declares a result hands one back. Where a plain record is absent,
the option was explicitly turned off — the verb still performed its write.
**Treat an absent result as "not enabled here", never as "the mutation did not
land."**

One boundary of that channel: the empty record is the value-less witness, so a
verb that deliberately returns `{}` settles with no `result` key and is
indistinguishable from one that returned nothing. Declare at least one field
where that distinction matters.

One more caveat worth carrying: a verb's result shape is not part of the piece's
stored schema, so nothing validates it and nothing protects it across a pattern
update. Read the pattern's own documentation for what a verb returns, and check
`cf piece verbs` for which source a piece is actually running.

## Exercising all of it

Everything above is asserted by a walkthrough that lives with the integration
tests, not with this document:

- **`packages/cli/integration/verbs-over-the-cli.sh`** — the runnable
  walkthrough. Each step names the property it asserts, so a failure says which
  one broke. A fresh space per run, no prior state.
- **`packages/cli/integration/pattern/verb-results.tsx`** — the pattern it
  deploys, which exists for this walkthrough alone. Nothing else deploys it, so
  a change to a pattern the product ships can never break a demonstration of how
  the verb surface works.

Run it against any host:

```bash
API_URL=http://localhost:8000 packages/cli/integration/verbs-over-the-cli.sh
```

CI runs it in the `piece-call` shard. It takes under half a minute and around
two dozen `cf` invocations against a warm local toolshed.

Each step demonstrates one use case:

| Step | What it shows |
| --- | --- |
| 1–2 | Deploy a pattern, then ask what it can do |
| 3 | A create hands back the piece it created |
| 4 | A verb returns what it wrote, including what only it could compute |
| 5 | A call's result names the document behind each path, and that address calls |
| 6 | A read returns an address in place of what is behind it |
| 7 | A replayed id returns the original result within its session, and executes as its own call in another |
| 8 | A piece result survives `plainResultReceipts=false`; a plain record does not — and the write lands either way |
| 9 | A value-less verb settles with the empty witness |
| 10 | A refused call does not spend its invocation id |
| 11 | Reading a verb redirects to `cf piece call` |
| 12 | Timings on stderr, Invocation JSON still clean on stdout |
| 13 | An invocation id without a session is refused, and the refusal says how to mint one |
| 14 | A detached (`--no-wait`) call's `receipt` address reads back the outcome, and a settled call's receipt reads back exactly its `result` |

## Addressing a piece you were handed

A result carrying a piece gives you the piece's **value**. Calling a verb *on*
that piece needs its address, and `--show-links` supplies it: a dictionary of
RFC 6901 pointers into the result, each naming the document behind that path.

```bash
cf piece call --show-links --cell <board> createNote '{"title":"Notes"}'
```

```json
{
  "status": "settled",
  "result": { "note": { "$NAME": "Notes", "…": "…" } },
  "links": {
    "/": "/of:receipt…",
    "/note": "/of:fid1:…"
  }
}
```

`/note` is the created piece's own document, and each entry is written in the
reference syntax the target positional reads — taken exactly as emitted, `of:`
prefix included — so it addresses directly:

```bash
cf piece call "$(echo "$RESULT" | jq -r '.links["/note"]')" \
  append '{"text":"second line"}'
```

Entries appear only where a path's backing document differs from its enclosing
one, so a chain of references annotates each hop exactly once. The walk stops at
any non-plain object: a live runtime object reached through a result gets its
own entry and nothing below it, because its properties belong to the runtime
rather than to the result.

`links` answers a different question from the envelope's `receipt`: `"/"` names
whatever document backs the result **value**, which is the receipt only when the
result is not itself a reference, while `receipt` always names the handling's
own receipt and needs no flag to appear. Where the two describe the same thing
they carry the same address — the receipt appears in `links` as `"/"`, or under
the reserved bare `receipt` key when `"/"` had to name something else — so under
`--show-links` the address is simply present twice.

The links describe whatever result you were handed, so a projection composes
with them: a path `--select` or `--schema` dropped simply gets no entry.
`--filter` is refused alongside `--show-links` — a predicate leaves the elements
it keeps at positions that are no longer the ones they came from, and every
address below a filtered array would name the wrong element.

A pattern should not mint identifier fields to make any of this easier —
rendering identity is the client's job, and a pattern-authored fid is a copy
that can go stale.

### Asking a read for an address

A cell is a point in a graph, so a read that does not say where to stop follows
links onward and hands back a copy of everything behind them. A projection says
where to stop: a marked position returns that position's address rather than
its contents. A field list marks with a trailing `@`, and a JSON Schema marks
with `{"$link": true}`.

```bash
cf cell get --cell <board> notes \
  --schema '{"type":"array","items":{"$link":true}}'
```

```json
[
  { "$link": "/of:fid1:…" }
]
```

The address is one string in the fabric's reference syntax —
`//<space>/<piece>[#member][@qualifier…][/path]` or its
space-relative form `/<piece>[#member][@qualifier…][/path]` — the same form the target positional reads,
so an address a read hands you is passed onward as it stands. The space rides in front only
when it differs from the space the command targeted, and the scope follows the
id only when it is not the default. No schema is inlined: a stored link can
carry an entire one, and what was asked for is where the value lives.

Marking a position deeper than a link names the linked document and the path
below it — `notes[0].title`, where `notes` holds links, renders the note's own
id followed by `/title`. A link is a durable identity for the edge it
records; the slot that holds it stops naming the same value the moment the
collection is reordered.

**What comes back is a link to read next, not a claim about canonical
identity.** Addresses are many-to-one over cells: a holder of one cannot tell a
canonical id from an alias, and normal use does not require it. Two positions
holding one piece can render two different addresses, and a marker and
`cf piece call --show-links` can disagree about the same piece, because a piece
created inside a handler and pushed into a collection is held through a link
that redirects to it and the two stop at different points along that redirect.

So feed an address into the next command rather than comparing it to another:
two addresses differing is not evidence of two pieces. Comparing contents
answers a different question — distinct pieces can hold identical contents, and
one piece's contents change under it. **Whether two addresses name the same
piece is not a question the CLI answers today.**

The marker sits beside a projection when both are wanted, and the answer
carries both:

```bash
cf cell get --cell <board> notes --schema \
  '{"type":"array","items":{"$link":true,"type":"object","properties":{"title":true}}}'
```

```json
[{ "$link": "/of:fid1:…", "title": "First note" }]
```

A field list unions the same way, and its two paths meet at the one position.
`noteCount` is computed, so the read steps the piece to bring it up to date:

```bash
cf cell get --cell <board> --step --select 'notes@,noteCount'
```

```json
{ "notes": [{ "$link": "/of:fid1:…" }], "noteCount": 3 }
```

A field list applies to each element wherever it crosses an array, and an
address is one of the things it applies: `notes@` answers with the address of
each note rather than of the slot it sits in, which makes it the concise
spelling of the `items` marker above. Where the marked position holds anything
else, the address is that position's own.

The suffix is special only at the end of a segment, and `\@` writes a literal
one, so a field named `user@home` stays reachable.

A path that is only `@` names the position the read is already at, which no
field path reaches because it sits above every field. `--select '@'` returns
the source's own address in place of its contents — one per element where the
source is an array — and `--select '@,title'` returns the address beside the
title.

A marked position is not fetched — the address is stored in the document that
contains it, so a marked collection of a hundred notes costs the one read that
document already needed. It costs the same whether the marker sits on the link
or below it: a position that asks for nothing but addresses is not read either,
so `notes.title@` reads what holds the collection and none of the notes. Where
the marker is the whole selection, nothing behind it is read at all.

The address a marked read returns is one `cf piece call` accepts exactly as
emitted, `of:` prefix included — which is the reason to ask for it.
