# An agent over the CLI

Its three siblings all begin with a piece id already in hand. This one is about
getting one, and about what an answer is worth once you have it.

That is the shape of an agent's problem rather than a person's. A person opens a
space in the shell and sees what is in it; an agent gets a space name and a key,
and every command it can run takes a target it does not yet have. The
commands that close that gap exist and are current — this collects them, names
what bounds each one, and states the conclusions a caller is not entitled to
draw from them.

Read [Verbs over the CLI](over-the-cli.md) for what a verb hands back, and
[the session walkthrough](session-walkthrough.md) for the surface measured
end to end. [`skills/cf/SKILL.md`](../../../skills/cf/SKILL.md) is the command
map, including the `--select` / `--schema` / `--filter` grammar this document
uses without restating.

## Arriving cold

Five ways to reach a piece, each bounded by something different:

| Starting from | Command | Bounded by |
| --- | --- | --- |
| the space itself | `cf piece ls` | the piece registry |
| a name someone assigned | `cf piece slugs` | the slug index |
| text you expect to be in the data | `cf piece search <query>` | registered pieces, matched client-side |
| a convention a pattern publishes | `cf wish <target>` | the collection that target names |
| an address you were handed | `cf cell get <reference>` | nothing — this is not discovery |

All but the last are partial views, and they are partial in different
directions, so an empty result from one says nothing about the others.
[Finding pieces](../concepts/piece-discovery.md) is the full account of the
boundaries. One consequence is worth carrying into every session:

> **A piece created inside a handler is not registered automatically.**
> Registration happens by sending the piece to the default pattern's `addPiece`
> handler, which a handler can do deliberately
> ([adding pieces](../conventions/adding-pieces.md)) and which instantiating a
> child pattern does not do on its own. So `cf piece ls` and `cf piece search`
> may not see the items a board created, however many there are — whether they
> do is the pattern author's decision, not something the listing reports.

The collection that holds those pieces is the discovery path for them — read
the board and follow its links, or read the index the pattern publishes for
exactly this purpose. Substituting `cf piece ls` for a pattern's own listing is
the single most common way to conclude a space is empty when it is not.

`runtime/cli/integration/verb-session-gaps.sh` asserts both halves of this
against a live host, under the step named "the registry does not list what a
handler created", so the paragraph above fails in CI rather than going stale: a
board deployed at the top level is listed, the item its handler created is not,
and that unlisted item reads on its own address regardless.

`cf wish` reaches collections a pattern publishes by convention rather than the
registry: `#pieceRegistry` resolves the registry itself, while `#mentionable`
and `#favorites` resolve the collections of those names. The `#profile` family
resolves against the identity's home space. It takes the same projection flags
as `cf cell get`, so a survey can be narrowed on the way out.

## Orienting on one piece

`cf piece verbs --json` is the first call to make against an unfamiliar piece:
it names the deployed pattern and lists every callable verb with its prose and
the schemas a payload is judged against, which is what a caller needs to act.
Each of the reads below is its own cold CLI process. `verbs` and `describe` load
the compiled pattern without starting the piece or loading its result tree;
they are still not a preflight to run together, so reach for the others when
the question they answer comes up. `cf piece describe` prints the piece's man
page — what it is, what it holds, what a caller supplies, and what it can do —
with every sentence compiled from the pattern's own doc comments:

```bash
cf piece describe --cell <piece>
```

```text
NAME    Donut counter
PATTERN cf:module/ZPxyGdkkv-YmizdHdNx5DIlqlpc9JRSm5iXTl4Tb2T0#default (/counter.tsx)

  Counts donuts by glaze. State changes only through verbs.

STATE
  glazes  GlazeOutput[]

INPUTS
  glazes  GlazeOutput[]

VERBS
  addGlaze
      Record a glaze nobody has counted yet.
```

`--json` returns the same content as data. `--all` adds the wrapper-tier and
deprecated verbs the default view hides; hidden verbs stay callable either way.

Three reads form a narrowing ladder, and each answers a question the one above
it does not:

| Read | Returns |
| --- | --- |
| `cf piece describe` | the whole piece in prose — purpose, state, inputs, one summary line per verb |
| `cf piece verbs --json` | each shown verb's input schema, and its result schema where it declares one |
| `cf piece verbs --json --all` | the same, plus the wrapper-tier and deprecated verbs the default view withholds |
| `cf piece call <verb> --help --json` | one verb, in full |

The `describe` page summarizes each verb in a line and does not carry the
schema a payload has to satisfy; `describe --json` carries the same verb rows
the listing does, schemas included, so prefer `verbs --json` over it for payload
size, not because `describe` lacks the schema. Build a payload from the `verbs`
listing or from a verb's own help page, both of which report the schema the
dispatcher will judge the payload against. Of the two, prefer the listing you
already have: a verb's help page is served through the dispatch path, which
starts the addressed piece, so it is the most expensive read on this ladder.

**Both listings hide wrapper-tier and deprecated verbs by default**, and both
say so rather than hiding them silently: `--json` carries a `hidden` object
counting what it withheld, and the human view prints the same counts as a note.
Hidden verbs stay callable. `--all` is what makes either listing exhaustive.

## Which pattern you are actually talking to

The `PATTERN` line on a `describe` page, and the source identity on a
`cf piece verbs` listing, name the pattern the deployed piece is running.

That line is what makes every other claim checkable. A piece runs whatever
source was last deployed to it, which may be older than the checkout in front of
you and older than any guide describing it. An older pattern silently discards
fields its schema does not declare, returns nothing from a verb that now returns
a record, and may not carry a computed field a caller intends to read.

**Establish which pattern a piece is running before the first mutation, not
after.** A create against an unexpected version can leave a piece you then
cannot address, and no later read recovers what was discarded on the way in.

## Acting

Once a piece is in hand, [Verbs over the CLI](over-the-cli.md) is the whole
story. Three of its properties are the ones that shape how an agent structures a
run:

**Mint one invocation session per run, and name your mutations.**

```bash
export CF_INVOCATION_SESSION=$(cf invocation-session new)
cf piece call --cell <piece> --invocation add-glaze-1 addGlaze '{"name":"maple"}'
```

Replaying that id within that session returns the original result and writes
nothing a second time, which is what makes a retry safe when a response was
never seen. A refused call never spends its id, so a corrected payload reuses
it.

**Carry addresses forward instead of searching again.** A verb that creates
something can hand back the piece it created; `--show-links` adds the address of
each document behind the result, and a target position takes such an address exactly as
emitted. Filing a thing and then searching a collection for it is a guess the
moment two callers write concurrently.

**Collect outcomes by address.** Every settled call carries a `receipt` — the
address of the cell the handling wrote its outcome to. Reading it back is an
ordinary read, so it does not run the verb body again. Prefer it to a replay for
any verb that reaches outside its own space.

## What a negative answer is worth

Every command here can return an empty or absent answer for a reason other than
the one a caller expects. These are the conclusions the surface does not support:

**An empty verb listing is not proof that no such verb exists.** A listing can
be short in three ways. A handler the piece stores that its pinned pattern
neither declares nor wires is callable by name but not listed at all. A listing
whose compiled pattern could not be read is empty, and reports `incomplete`
rather than passing that emptiness off as the surface.
And the default view withholds wrapper-tier and deprecated verbs, reporting the
count under `hidden`. Only the third is recoverable — `--all` lists those rows;
nothing recovers a verb the pattern could not be read to name.

So enumerate against a listing that reports **neither `incomplete` nor
`hidden`**, or against `--all`. Even then it means no *listable* verb of that
name, which is enough to work from and not enough to prove a named verb does not
exist.

**An absent `result` is not a failed write.** A verb that declares a result
hands one back where the channel carrying it is enabled; where a plain record is
absent, the option was turned off and the verb still performed its write. Treat
an absent result as "not enabled here", never as "the mutation did not land". A
verb returning an empty record is indistinguishable from one returning nothing,
so a pattern that needs the distinction declares at least one field.

**Two different addresses are not two pieces.** Addresses are many-to-one over
cells, and two positions holding one piece can render different addresses. Feed
an address into the next command rather than comparing it to another. Whether
two addresses name the same piece is not a question the CLI answers today.

**A receipt witnesses the commit, not the execution.** A replay runs the handler
body again and then loses the race for the receipt, so nothing commits twice —
but anything the body did outside that transaction happened twice. A verb that
sends mail or spends a model call is not made idempotent by an invocation id.

**A read that exits nonzero is not an empty value.** A result read whose
required values have not materialized reports that stored data is present and
points at `--step`; a projection that cannot render says so and states that it
is not JSON `null`. A printed `null` has several origins — a projected null, an
absent optional source, or a wish run under `--allow-empty`, which prints `null`
and exits 0 where it would otherwise error — and no caller can tell them apart
from the output. Read it as "no value here", never as proof of no matches.

**An empty projection from a field list is a field holding nothing, not a field
that is not there.** A `--select`/`--schema` field list is held to the source's
own vocabulary, so a name the schema proves cannot be there — one the position
neither declares nor admits, one below a scalar, one below a verb — is refused
before the read, naming the position and what it declares. What that spelling
returns as `{}` is therefore a position that could have held a value and does
not: an optional field nobody has written, an interface an item does not
implement, a link that has not synced.

Two cases keep the older reading, and `{}` covers a typo in both. A JSON
`--schema` names a shape of its own rather than the source's fields and is held
to no vocabulary at all. And a field list visits positions the source schema
settles nothing about — an open `additionalProperties`, a `patternProperties`
map that names a pattern, a disjunction, an untyped source, a position that
only may hold an array, a tuple-shaped one, a reference site declaring fields
of its own, a name several `allOf` members declare — where no refusal is
available. Read a `{}` from either against `cf piece describe` rather than as a
fact about the data.

One of those positions goes further. A field declared only through an `allOf`
member is named by the schema and refused by nothing, and no spelling on this
surface returns it: a field list returns `{}`, a JSON `--schema` naming it
returns `{}`, and `cf piece describe` does not list it among the fields. So
`{}` there is neither absence nor a typo, and nothing the CLI offers separates
it from either — the pattern's own source is what settles it.

**An unregistered piece is not a missing piece.** Covered above, and repeated
here because it is the failure that reads most like a definitive answer: `ls`
and `search` returning nothing is consistent with a space full of pieces whose
creating handler never sent them to `addPiece`.

## Building a domain guide on this

A guide to one pattern — how to run workstreams on a tracker, how to file
against a board — refers here for mechanism and states its own consequences.
The test for a line in such a guide:

> Could this sentence be true of a different pattern?

Where it could, the sentence belongs in this tree and the domain guide links it.
Where it names a verb, a field, a deployed instance, or a team convention, the
domain guide owns it and nothing here can know it.

That puts the general rules above in the domain guide as *named consequences*
rather than as summaries: not "computed reads need `--step`" but which fields on
this pattern are computed; not "retries are safe" but what a double call would
do to this board. A pattern's own README carries its verbs and contract; a
domain guide carries the deployed instance and the conventions around it.
