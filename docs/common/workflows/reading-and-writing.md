# The read and write session

*What is this, and why is it shaped this way?* A tour of reading a piece's
cells and writing them, walked act by act against a thermostat with two
derived fields. It assumes you can deploy a piece; it assumes nothing about
what a piece is made of.

## What this is for

A piece answers two questions a caller asks constantly: what does it hold,
and how do I change it. The reading half is the friendlier one — a read is a
query, you name the shape you want, and asking twice costs nothing. The
writing half is where the surprises live, and all of them come from one fact
about the surface: **a write addresses a cell, and addressing a cell is not
running a program.**

That sentence has three consequences, and they are what this tour exists to
demonstrate. The write goes somewhere a caller does not expect. Nothing
recomputes afterward, so a derived field read straight back looks wrong. And
the read that looks most like the others — `cf wish` — is the one that is not
free at all.

### Two cells, one piece

A piece has two cells, and every read and every write picks one of them.

The **result** cell is what the pattern produced: its declared outputs, its
derived fields, and handles for its verbs. It is where a command goes by
default. The **arguments** cell is what a caller supplied: exactly the fields
the pattern declared as input, and nothing else. A command reaches it two
ways, `--input` as a flag and an `#argument` suffix on the target, and the
two are one selection rather than two.

The CLI's own help calls that second cell the *input* cell where the flag is
described and the *arguments* cell where the suffix is. They are one cell.
This document says arguments cell throughout, except where it quotes.

`cf piece describe` splits its page on the same line — `STATE` is the result
cell's contents, `INPUTS` is the arguments cell's — so the page a piece prints
about itself is already telling you which cell a field lives in.

They are two cells rather than two views of one, which is why a field can
exist in one and not the other. A derived field is the clear case: the pattern
computes it, so it has a position in the result cell and no position at all in
the arguments cell. Act 2 asks for one there and is told which keys exist
instead.

Where a result field is the input passed straight through, the result holds a
link to the arguments cell rather than a copy, and a write at that position
follows the link. So for a pass-through field the two spellings land in the
same place, and for a derived field they do not — which is why the flag is
worth understanding rather than memorizing.

### The default is the result cell, and the flag says so

`cf cell set` writes the **result** cell unless told otherwise. That is the piece's
output — the answer half, not the question half. `--input` is what redirects
the write to the arguments cell, and the flag's own help is the plainest
statement of the default there is: *Write to the piece's input cell instead of
result cell.*

Four commands take `--input` — `cf cell get`, `cf cell set`, `cf cell get-label` and
`cf cell set-label` — and those same four are the ones that accept the
`#argument` suffix. That is not two lists that happen to agree: a command
declares it accepts an arguments-cell selection once, and both spellings are
read out of that one declaration. Any other command is refused by name,
`cf piece call` among them, so a call cannot quietly be aimed at a cell no
handler reads.

The suffix rides every spelling of the target — the reference form
(`/of:fid1:…#argument`, `/thermostat#argument`), the bare id, and the slug
(`--cell thermostat#argument`) — because all of them designate the same piece.
A `--url` is not one of those spellings. It carries no fragment into the
reference it decomposes to, whatever the URL names: a URL fragment is not part
of the path a URL's piece is read out of, so a `#argument` written on a `--url`
is dropped without comment and any read it would have redirected goes to the
result cell. A URL that names the piece admits no `--cell` or positional
address beside it, so `--input` is what reaches the arguments cell there. A URL
that names only the space leaves the target to arrive as it always does — a
positional address, or `--cell` — carrying the suffix like any other.

Hold on to the asymmetry. A suffix written on the target is honored where the
command takes `--input` and refused by name where it does not; a suffix written
on a `--url` gets neither.

### Nothing here runs the program

A write commits a value to a cell. It does not start the piece, and it does
not recompute anything downstream. A pattern's derived fields hold whatever
they were last computed to, so a computed field read straight after a write
reports an answer to the state before it.

`cf cell set` says so itself, on every write:

```text
TIP: Computed values may be stale. Run 'cf piece step --piece … ' to trigger
recomputation.
```

**A verb call is no different.** This is the part that catches people who
already know the verb surface: calling a verb runs the handler, and the
handler's own result is computed inside the piece and is correct — but
settlement is that handler's commit, deliberately and not the recomputation
the commit sets off. Waiting for the graph to quiesce would hold an
already-committed write hostage to every recomputation it triggered elsewhere,
so `executeResolvedCallable` in
[`runtime/cli/lib/callable.ts`](../../../runtime/cli/lib/callable.ts) does
not wait. Act 8 calls a verb and then reads a derived field that has not
moved.

`cf piece step` is the command whose whole job is to be the observer nothing
else is: start the piece, let the graph settle, sync what it wrote, stop. It
is the act this tour exists for, and it is the answer to every "why is this
number wrong" the rest of the tour produces. A read can carry the same step
inline with `cf cell get --step`, which recomputes, commits, and answers in one
session.

## The session, act by act

Nine acts against a space that starts empty. Every command below is one the
demo runs; `$SPACE` is a throwaway space and `-s` names it on each command,
because `cf` has no environment variable for a space. `$ADDRESS` and `$FOUND`
are addresses the session read out of a run rather than a second, hidden one.

### Acts 1–3 · What a piece holds, and how to ask for less of it

#### Act 1 · A piece to read and write

The fixture is
[`thermostat.tsx`](../../../runtime/cli/integration/pattern/thermostat.tsx),
and it belongs to this demonstration and nothing else. A target a caller
writes, three zones with a reading each, and two figures derived from both:
`targetFahrenheit` from the target alone, and `belowTarget` from the target
and the zones together. Two derived fields rather than one, because the tour
needs to show that neither of them moves.

```bash
cf piece new runtime/cli/integration/pattern/thermostat.tsx -s demo --slug thermostat
```

#### Act 2 · Two cells behind one piece

The piece's own page is split by who writes what. `targetFahrenheit` and
`belowTarget` appear under `STATE` and not under `INPUTS`, because nothing
supplied them.

```bash
cf piece describe -s demo --piece thermostat
```

The arguments cell holds only what the pattern declared as input, so reading
it whole is a short answer — `target` and `zones`, each a link.

```bash
cf cell get -s demo --piece thermostat --input
```

And a derived field has no position there at all. The refusal names the keys
that do exist, which is the fastest way to find out which cell you are
addressing.

```bash
cf cell get -s demo --piece thermostat targetFahrenheit --input
```

#### Act 3 · A read is a query: name the shape you want

An unshaped read carries everything the result cell holds, including the verb
handle — a link, and not data anyone asked for. Three flags shape the answer,
and `--select` and `--schema` are refused together rather than resolved,
because a command naming both has not said what shape it wants.

```bash
cf cell get -s demo --piece thermostat
cf cell get -s demo --piece thermostat --select target,targetFahrenheit,belowTarget
cf cell get -s demo --piece thermostat zones --filter '.celsius < 20'
cf cell get -s demo --piece thermostat zones \
  --schema '{"type":"array","items":{"type":"object","properties":{"name":true}}}'
```

`--select` names fields and prunes everything else. `--filter` decides
membership in an array with a jq-inspired predicate, before any projection
runs — so a field can decide the answer without appearing in it. `--schema` is
the same projection written as JSON Schema: the spelling a program generates
rather than one a person types.

The full account of what a selection can ask for — including `@`, which asks
for a position's **address** in place of its contents, and which act 7 uses to
get this piece's own — is in
[verbs over the CLI](../verbs/over-the-cli.md#asking-a-read-for-an-address).

### Acts 4–6 · The write, and what it does not do

#### Act 4 · A write lands on the result cell unless you say otherwise

`cf cell set` reads its value from stdin, so the value arrives on the pipe and the
path is the argument. No flag here means the result cell.

```bash
echo '25' | cf cell set -s demo --piece thermostat target
cf cell get -s demo --piece thermostat --select target,targetFahrenheit,belowTarget
```

The target moved to 25. The two figures derived from it did not: 68°F is 20°C,
and the count is still the count against 20. Both are answers to the target
that was there before this write, because a write commits a value and runs no
program.

#### Act 5 · `cf piece step` is the recomputation

A derived value moves when something observes the piece, and a CLI process
that writes and exits never does.

```bash
cf piece step -s demo --piece thermostat
cf cell get -s demo --piece thermostat --select target,targetFahrenheit,belowTarget
```

Same read as before the step; now both figures answer to 25. Nothing about the
piece changed between those two reads except that something ran it.

#### Act 6 · Writing a derived field, and what the next step does to it

Nothing stops a write landing on a derived field. It is a position in the
result cell like any other, and the write is accepted and reads back exactly
as written.

```bash
echo '100' | cf cell set -s demo --piece thermostat targetFahrenheit
cf cell get -s demo --piece thermostat --select targetFahrenheit
cf piece step -s demo --piece thermostat
cf cell get -s demo --piece thermostat --select targetFahrenheit
```

It survives until something recomputes it. The pattern owns that position, so
the next step puts the derived answer back and the written one is gone with no
record that it was ever there. **This is the shape of the whole hazard.** A
write to a cell a pattern computes is not a change to the program; it is a
value sitting in the program's way until the program next runs. Change the
input and step, or call the verb — do not write the output.

### Act 7 · The arguments cell, by flag and by suffix

`--input` sends the same write to the arguments cell.

```bash
echo '15' | cf cell set -s demo --piece thermostat target --input
cf cell get -s demo --piece thermostat target --input
```

The other spelling of that choice rides the address. `@` alone answers with
the address of what is being read, so the piece can hand over its own:

```bash
cf cell get -s demo --piece thermostat --select @
```

A trailing `#argument` on that address selects the same cell `--input` does,
on the read and on the write alike:

```bash
cf cell get -s demo "$ADDRESS#argument" target
echo '30' | cf cell set -s demo "$ADDRESS#argument" target
cf cell get -s demo --piece thermostat target --input
```

A slug and a bare id designate the piece a reference designates, so the
selection written after one means what it means after the other. Here the slug
reads back the cell the address just wrote to.

```bash
cf cell get -s demo --piece 'thermostat#argument' target
```

What bounds it is the flag it is a spelling of: a command that takes no
`--input` takes no `#argument` either. The refusal names the flag rather than
the suffix, because they are one selection with two spellings.

```bash
cf piece call -s demo "$ADDRESS#argument" setTarget '{"celsius":21}'
```

### Acts 8–9 · The two things that look like exceptions

#### Act 8 · A verb writes, and leaves the derived fields behind just the same

A verb is how a pattern changes its own state: the handler runs inside the
piece, with capabilities a caller does not have, and what it returns was
computed there. The result of this call is right.

```bash
cf piece call -s demo --piece thermostat setTarget --celsius 10
cf cell get -s demo --piece thermostat --select target,targetFahrenheit,belowTarget
```

Then read the piece, and the target is the verb's while the derived fields
still answer to the target the last step saw. A call is no more of an observer
than a set is.

```bash
cf piece step -s demo --piece thermostat
cf cell get -s demo --piece thermostat --select target,targetFahrenheit,belowTarget
```

One step, and the whole piece agrees with itself again.

#### Act 9 · A query instead of an address, and the read that writes

Every read so far named its target. `cf wish` names a **query** and lets the
space answer with what matches — resolving through the same runtime builtin a
pattern's own `wish()` uses, driven headless so no picker UI spins up. Asking
for the answer as addresses rather than contents makes it a discovery command:
you arrive with no id and leave with one.

```bash
cf wish -s demo '#pieceRegistry' --select @
cf cell get -s demo "$FOUND" --select target,belowTarget
```

**Resolving a wish is a write.** It builds a one-node pattern holding the
query, runs it into a cell in the space, and commits that transaction before
reading the answer back — so resolving leaves a durable trace, and the command
is a write against the space however much it reads like a query. This is the
one command in this tour that breaks the read/call dividing line the verb
tour's
[act 6](../verbs/the-verb-session.md#act-6--ask-the-same-question-twice)
draws: it is shaped like a read, and it is not effect-free.

## How the story is kept honest

Every command above is one
`runtime/cli/integration/read-write-demo.sh` runs. The demo narrates each act
and then executes it, and each act re-parses its own displayed line and
compares the words against the argv that ran — so a line a reader retypes is
the line that executed, checked rather than asserted. The `echo … |` half of a
write is rendered from the same value the pipe carries, so those cannot
disagree either.

`deno task check-verb-session-sync` holds this document to that script: a `cf`
line here either quotes a command the demo runs or carries a
`# not in the demo` comment saying why it cannot. There are none of the latter
in this document — every line above ran.

What the demo cannot check is the prose, and two claims here are properties of
the implementation rather than of a transcript: that `cf cell set`'s default lands
on the result cell (`setCellValue` in
[`runtime/cli/lib/piece.ts`](../../../runtime/cli/lib/piece.ts) branches on
`options.input` and reaches `piece.result` without it), and that resolving a
wish commits (`resolveWish` in
[`runtime/cli/lib/wish.ts`](../../../runtime/cli/lib/wish.ts) opens a
transaction, runs its pattern into a cell, and commits before reading). Both
are stated from those functions.

## Running it yourself

```bash
API_URL=http://localhost:8000 runtime/cli/integration/read-write-demo.sh
```

The transcript is the artifact, and every act in it runs. Each one makes a
claim the demo counts: an unmarked act says the command works, a REFUSED act
says the surface turns it down, and a displayed line that would not re-parse
to the argv that ran is counted too. A transcript that reads clean is one
where every one of those claims held, because a run that got any of them wrong
cannot exit zero.

## Where to read further

- [The Verb Session](../verbs/the-verb-session.md) — the tour of the other
  half: what a pattern, piece, space and verb are, and how a caller drives a
  piece it has never seen
- [Verbs over the CLI](../verbs/over-the-cli.md) — what a verb hands back, and
  what a retry does and does not guarantee
- [An agent's entry](../verbs/agents-over-the-cli.md) — the discovery surfaces
  `cf wish` sits among, and what an empty answer does not prove
- [`runtime/cli/README.md`](../../../runtime/cli/README.md) — the reference
  for `get`, `set`, `wish`, and the reference forms their targets take
- [computed()](../concepts/computed/computed.md) — the authoring side of a
  derived field: what makes one, and why it is the pattern's to write
