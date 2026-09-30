# CLI surface shape

The **command surface**, one of the three concerns in
[Reading Fabric data](fabric-read-model.md), which defines the shared model. The
`cf` surface grew one command at a time and now expresses a model the code no
longer has. That costs more than tidiness: the names imply distinctions the runtime
does not make, which misdirects design work before it starts.

This document is about the command surface, not the machinery underneath.
Nothing here blocks [Shaped reads and verb results](shaped-reads-and-verb-results.md).

## Where this stands — read this first

This block is LIVE: the change that moves a step updates it here, so the plan
says what the surface has rather than only what it wants. The steps themselves
are in [How to get there](#how-to-get-there); this says only which of them
have landed.

**Arc one — what the commands are called.**

| step | state |
| --- | --- |
| 1–5 — the shared read step, the read options on every arrival, `--piece` taking the `of:` form, positional addresses with the `#argument` suffix, and the data commands, spelled `cf cell get`/`set` and `cf piece call` since step 7 | on main |
| 6a — the old spellings warn, each naming its end date | on main |
| 6b — the old spellings are removed | on main |
| 7 — each command sits under the noun it acts on | on main |
| 7b — the superseded spellings are removed | not started; they are guaranteed only through 2026-09-11 |

**Arc two — how a caller writes what a command acts on.**

| step | state |
| --- | --- |
| 8 — `CF_SPACE` is ambient, and a write names the space it wrote to | on main |
| 9 — a reference takes a space by name and a piece by slug, positionally | on main, with 11 |
| 10 — the verb opens the callable's section and `--` closes it | on main |
| 11 — `--url` decomposes into the transport it names and the reference it carries | on main, with 9 |

## What the surface is for

Sorting commands by what they are for makes the trouble visible. Seven
purposes, and one command — `view` — genuinely straddles two of them, which is
itself part of the problem.

| Purpose | Commands |
| --- | --- |
| **Authoring** — work on source files, never touching a live space | `check`, `test`, `view` (pager), `init`, `deps update` |
| **Identity and access** — who you are, and who may do what | `id` (new/did/derive/from-mnemonic), `acl` (ls/set/remove) |
| **Live data** — reading and writing running state | `cell get`/`set`/`get-label`/`set-label`, `piece call`/`apply`/`link`/`step`/`verbs`/`inspect`, `wish` |
| **Piece and space lifecycle** — deploying and managing running programs, and rebuilding a space's own patterns | `piece new`/`setsrc`/`getsrc`/`rm`/`ls`/`search`/`map`/`set-slug`, `space recreate-root`/`set-home` |
| **Rendering** — turning things into something to look at | `piece view` (terminal), `piece render` (HTML), `view` (source pager) |
| **Storage forensics** — reading the database directly, mostly offline (`inspect pull` fetches from a remote) | `inspect` (22 subcommands), `space` (clone/verify/reset/fingerprint) |
| **Filesystem projection** — exposing cells as files | `fuse` (mount/unmount/status), `exec` |

Four of these are coherent and want nothing: authoring, identity and access,
storage forensics, and filesystem projection. The trouble is concentrated in the
middle three.

## Where it has accreted

**`piece` carries four unrelated jobs.** Deploying a program, listing what is
deployed, reading live data, and rendering a UI all hang off one word. Someone
reading a value and someone deploying a pattern share a command prefix and
nothing else.

**Names imply distinctions the code does not make.**

| Surface | What the name says | What it actually is |
| --- | --- | --- |
| `--piece` | a piece | any cell address — the function that fetches a piece's result returns the piece unchanged, and the read path checks nothing piece-specific |
| `--input` | a mode you switch on | an address — it follows a link stored in the document to reach the arguments cell |
| `--schema` | one input format | two — a full schema, and a concise path shorthand that is not a schema |
| `--url` | a transport address | a transport and a reference in one token, taken apart into the two when it is read |

The `--piece` case is not cosmetic. Believing the target had to be a piece is
what made a verb's receipt look like it needed purpose-built read machinery,
when it is an ordinary cell that any read already handles.

**One word, two jobs — twice.** `piece inspect` examines a running piece, while
`cf inspect` reads the database offline and has its own `piece` subcommand.
Separately, `piece view` prints an ASCII rendering of a piece while `view` is a
pager for source files. `piece map` and `cf inspect graph` both draw the graph
of entities and their connections — one live, one offline.

**Two commands, overlapping but not equivalent.** `piece apply` validates a
whole input against `argumentSchema` and re-executes the pattern with it;
`cf cell set` writes at one path. Both target the arguments cell, and the overlap
invites merging them, but they are not the same operation — which is why any
merge belongs in the last step rather than among the renames.

### One flag, two syntaxes

`--schema` takes two different things, and that is what makes it confusing —
not that it takes a schema.

Schemas are queries here. The schema-on-read principle runs through the whole
system: you describe the shape of the data you want, and that description
decides what is loaded. A reader supplying a schema is doing exactly what a
subscription does. So the flag's *full* form is a schema in good standing, and
the syntax should stay schema-shaped so a caller can lift a source schema and
prune it into a request.

The **concise** form is a different thing wearing the same flag:

```
--schema 'title,createdBy.name'                        # a path list
--schema '{"properties":{"title":{"type":"string"}}}'  # a schema
```

The concise form is a shorthand, and it exists because full schemas are verbose
enough that nobody writes one to select two fields. It is modeled on
[`llm`'s schemas](https://llm.datasette.io/en/stable/schemas.html), which is
worth recording so the next reader does not have to re-derive why it looks the
way it does.

`llm` keeps both syntaxes under one flag, so one flag is livable on its own
terms. What makes the split worth it here is that **our shorthand is growing
notation that is not schema syntax at all** — a suffix marking a path as an
address, below — and a separate flag gives that room without each addition
needing a justification as a schema dialect. A reader who sees
`--schema title,createdBy.name@` and asks "how is that a schema?" is right, and
will get righter.

**Give the concise syntax `--select` and leave `--schema` for full schemas.**
That resolves the ambiguity rather than papering over it, and it leaves room for
the
shorthand to grow notation a schema does not need — a suffix meaning "give me
the link at this path rather than its contents" is the obvious candidate, since
that is the common case and spelling it in full is painful.

`--select` is the name because it says what the syntax does, reads naturally
with the address suffix (`--select 'topic@,topic.title'`), and leaves "shape"
free as the word for what a caller asks for — covering both spellings rather
than competing with one of them.

Both spellings are carried on every command that reads — `cell get`,
`piece call`, `wish` and `exec` — and a command naming both is refused rather
than resolved, because it has not said which shape it wants.

**What a reader may not supply, in either syntax.** `asCell`, `default`,
`scope`, and `ifc` stay the source's — they decide how a value is treated, not
which values come back. `$ref`, `$defs`, and the combinators are unsupported.
Neither syntax can express them, though not by the same route: the checks run
when a full schema is parsed, while the concise form is held to an identifier
grammar with no way to write a keyword. Writing the full form does not unlock
them.

That rule needs no carve-out for the address suffix. `asCell` carries a handle
contract as well as a boundary, and a handle cannot cross a serialized channel —
so a reader supplying it would be asking for something the channel silently
downgrades to an address. The suffix desugars to a projection-only `$link`
instead; see
[shaped reads](shaped-reads-and-verb-results.md) for the reasoning.

## What it should look like

**The noun is what the verb acts on, not what it ranges over.** `ls` lists
pieces, so it sits under `piece`; the space it ranges over is context the
command reads rather than the thing it acts on. The same test taken from the
other end: if a command's target wants to be spelled `--cell`, it is a cell
command. That rule is what decides where a command goes, and it is worth more
than the individual placements below, which are only its output.

Reading is one operation reached from several starting points, so the surface
wants one read command and distinct commands for the distinct ways of arriving:

```
# <read opts> = [--select S | --schema S] [--filter P] — identical everywhere

cf cell get  <addr> [path]            <read opts>
cf cell set  <addr> [path]                       # writes; nothing to shape
cf cell get-label|set-label <addr>

cf piece call <addr> <verb> <payload> <read opts>
cf wish  <query>                      <read opts>  # a query, not an address
cf exec  <mountedFile> [args]         <read opts>  # through a filesystem mount

cf piece new|setsrc|getsrc|rm|ls|search|verbs|set-slug|step|link|inspect|…
cf space recreate-root|set-home|clone|verify|reset|fingerprint
cf id … | cf acl … | cf fuse …
cf inspect …                                     # offline forensics
cf check | test | view | init | deps             # working on source
```

Three properties earn their place.

**One way to write an address.** An entity id (`of:fid1:…`), a slug, or a URL,
with a suffix for navigating within it — `<addr>#argument` in place of the
`--input` flag. An address printed by one command is accepted by the next
without reshaping, which is not true today.

**Arrivals stay separate; the tail is shared.** `cell get`, `piece call`,
`wish`, and `exec` are genuinely different operations and none should absorb
another. But all of them finish by turning a cell into structured output, so
they take the same read options and an address renders the same way however you
arrived at it. A command that returns data gets the whole tail, not a subset — a
result worth shaping is a result worth filtering. `cell set` is the exception,
because it writes rather than returns.

**Each noun keeps only what acts on it.** `piece` deploys, updates, removes,
lists, searches, and inspects a piece. `cell` reads and writes a cell, which is
what `get` and `set` were always doing. `space` rebuilds a space's root and home
patterns and manages rehearsal clones of its store.

### The exceptions, and why they are exceptions

**`inspect` and `space` both act on a store, and the rule cannot separate
them.** They stay apart on a contract instead: `inspect` is read-only — it
explains, it never reproduces or replays — and that is what makes it
trustworthy, while `space` exists to write. One object, two nouns, divided by
what each promises rather than by what each addresses. Anything read-only over
stored state belongs under `inspect`; anything that writes a store belongs under
`space`.

**`space verify` and `space reset` take a clone directory, not a space.** A
rehearsal copy is identified by where it was written, so their argument names
the copy rather than the space it is a copy of. The noun does not resolve that,
and naming it here is cheaper than leaving a reader to wonder whether it was
noticed.

**`acl` stays a noun of its own.** The rule would fold it under `space`, since
an access-control list is a property of one. It is left alone because nothing is
confusing about `cf acl` today and the fold buys a reader nothing.

**`set-slug` stays under `piece`.** A slug names a piece within a space, so the
rule reads it either way. It acts on the piece — the space is where the name has
to be unique, which is range, not target.

**The authoring commands stay at top level.** `check`, `test`, `view`, `init`
and `deps` act on source files, and the rule would gather them under a `source`
noun. That is deliberately deferred rather than rejected: they are the commands
with the most prose written about them, so the move is by far the most expensive
in the surface, and no one has been confused about where `cf check` lives. A
future reader who wants the noun can have it; this records that it was
considered and priced, so it need not be re-derived.

**`cell` costs some callers a second migration.** `get` and `set` reached top
level recently and move again under `cell`. That cost was measured and accepted:
the cell/piece distinction is the entire content of the rule, and a rule that
cannot tell a cell from a piece has nothing left to say.

`--select` and `--schema` everywhere, split per the reasons above.

## Naming the target

Every read and every call names a target, and it takes three words to do it: a
space, a piece, and — for a call — a verb. How those words are spelled looks
like decoration on the layout above. It is not: it decides whether that layout
can be written at all.

### The order is a dependency chain

Each word can only be resolved once the words before it are known. A piece is
named within a space; a verb is named on a piece; a verb's fields and the shape
of its result are named by the verb.

```text
space  ->  piece  ->  verb  ->  verb fields  ->  result shape
```

Anything that resolves one of those — a caller reaching for the documentation, a
tool offering candidates, a reader making sense of a line — needs every earlier
word already in hand. So the chain is not a convention. It is the order the
words become knowable, and a layout that contradicts it is one where a stage
cannot be resolved from what precedes it.

Read the target layout against it and every element sits in dependency order,
`<read opts>` last because the result shape is knowable only once the verb is:

```text
cf piece call <addr> <verb> <payload> <read opts>
```

Two things follow, and they are the reason this section exists.

**The verb cannot lead.** A layout naming the verb before the address puts it
ahead of the words that say which piece it lives on, so nothing can resolve it —
including the caller. The verb goes after the address, which is where the layout
already puts it.

**The read options go after the payload, and nowhere else.** They shape the
verb's result, so they are knowable only at the end of the chain — a projection
written before the verb names positions in a result nothing has identified yet,
which is a shape the caller cannot check and a reader cannot follow. The layout
above is prescriptive on this point: `<read opts>` is a position, not an
illustration, and a projection written before the verb is refused rather than
accepted quietly.

`cf piece call` reads them past the `--` that closes the callable's section, which
is the position the layout names: everything between the verb and the marker
belongs to the callable's own schema-derived parser, and the read options
follow. A projection written before the verb is refused rather than accepted
quietly, so the three flags sit in the same relative place on `call` as on
`get` — after the thing they shape.

### What names a target

One spelling carries the whole target, and it is the one a person writes:

| Spelling | Carries | Piece written as | Space written as |
| --- | --- | --- | --- |
| `//my-space/tracker`, positionally or on `--cell` | space, piece, scope, path | a handle or a slug | a name or a DID |
| `--space` plus `--cell` | space, piece | a handle or a slug | a name or a DID |
| `--url` | host, plus a reference | a handle or a slug | a name or a DID |

The reference is what the other two are read against. `--cell` takes a
reference whole, so the flag is the same vocabulary written behind a name
rather than a second one; `--url` is a browser URL, and what it means is an
`--api-url` and a reference, which is how it is read. So the form that
composes and the form anyone types are the same form, and there is one
grammar to learn rather than a spelling per position.

Where the readings differ is what each one can resolve, not what it accepts.
A pattern resolves a link from the string alone, so it needs the
self-identifying spellings — `did:key:…` and `fid1:…`, which say what they
are. `cf` opens a session before it reads anything, so it resolves a name and
a slug as well. One grammar, held to whichever rule the reader can enforce.

**Terseness lives in the identifier, not in the separator.** The same piece,
three ways:

```text
  7  tracker
 51  of:fid1:pOrTkvYX-…
110  //did:key:z6MkiAwQ…/of:fid1:pOrTkvYX-…
```

Collapsing two flags into one token saves a handful of characters. Naming the
piece by its slug saves a hundred, and naming the space ambiently saves the
rest. A combined token is worth having for what it composes — one word to copy,
one word to pass on — rather than for its length, and the short spelling a
caller wants is mostly reachable already through parts that exist.

**A separator has to be one the parts cannot contain.** A handle contains a
colon (`fid1:…`) and so does a DID (`did:key:…`), so a colon-joined
`host:space:piece` cannot be split from either end without knowing which
segments are allowed to contain colons — and a host carries a port, which is a
third. `/` is contained by none of the three, which is why the canonical
reference already joins its parts with it. Its layout is the right structure
already: right-anchored, each level to the left a broader scope, omitted levels
supplied by context, the same shape a container image reference has.

**A host is not part of the referent.** `--url` carries one because it is a
browser URL, and that conflates a transport with a thing being addressed: the
same space and piece are the same space and piece whichever host serves them.
`--api-url` already names the transport. So `--url` did not want a better
name — it wanted to decompose into the two things it carries, and to survive as
a documented convenience for pasting a URL out of a browser rather than as the
one spelling carrying a whole target. It reads that way: the host is the
`--api-url` and the rest is a reference.

### Three moves, which compose

**Give the space an ambient source.** A parameter that is required everywhere
and identical across a working session is one a caller should state once. This
shortens the chain by a stage, so a piece resolves from a bare command, and it
removes the most-repeated word on the surface. `wish` already reads this way.

`CF_SPACE` is where it lives, beside the `CF_API_URL` and `CF_IDENTITY` the same
builder already reads, and `--space` overrides it. It serves reads and writes
alike, which is what every comparable tool does — a namespace, a project and a
profile are each ambient for deletes as much as for reads.

**A command that writes names the space it wrote to.** A wrong space is not an
error: it succeeds against data nobody meant to touch, and removing a piece from
one is indistinguishable at the prompt from removing it from another. Naming the
space in what the command prints is a receipt rather than a prompt, so it costs
a non-interactive caller nothing and leaves a wrong space visible the moment it
happens. Nothing in this CLI asks a caller to confirm anything, and this does
not introduce the first thing that does.

**Let one spelling carry the whole target, in the form a person writes.** The
reference had the right structure and a narrower vocabulary than the alias
beside it. Closing the gap means the reference accepts a space by name and a
piece by slug — `did:key:…` and `fid1:…` are both self-identifying, so neither
can be mistaken for a name — and that a reference may be written positionally.

Positionally means the commands that have a position for it: `get`, `set` and
`call`. The flag carries a reference on every command that takes a target, but
a position for one exists only where nothing else owns the first positional —
`piece setsrc <main>` and `piece getsrc <outpath>` already spend theirs — so
opening a target position elsewhere would be taking one away rather than
adding one.

The reference carries cells and stops there. A verb is not one, so it stays the
word after the reference rather than a segment inside it — which is where a
caller reads it anyway, the reference already in hand by the time they write it.

That is a change to the rule that new capabilities land in the canonical form
first and an alias never leads. The rule is right about direction and this does
not overturn it: the canonical form still leads, and what it gained is the
ability to say the same things the alias says. What would break the rule is
leaving the human vocabulary in the alias and letting the alias grow.

A reference that carries the target also collapses the chain into one word,
where every part a later segment depends on sits to its left inside the same
token. Resolving one is then the segment-at-a-time walk a path within a cell
already needs, rather than a rule about the order of separate words. And it is
what `--url` decomposes to.

**Separate the three parties on the line.** A call is read by three: `cf`
resolves the target, the callable consumes its input, and the read step shapes
what came back. The chain says they run in that order, and the layout says they
are written in that order. What is missing is the marker between the second and
the third.

**The verb opens the callable's section; `--` closes it.** A positional already
marks where the callable's vocabulary begins, so no marker is written there —
the same boundary `docker run` draws at an image name and `ssh` at a host. What
a marker is needed for is the boundary the conventional shape does not have: the
one where the callable's section ends and the read step's begins.

```text
cf piece call <target> <verb> <verb input>
cf piece call <target> <verb> <verb input> -- <read opts>
cf piece call <target> <verb> -- <read opts>             # a verb that takes none
cf piece call <target> <verb> -- --help                  # the verb's own page
cf exec <mountedFile> <verb input> -- <read opts>
```

One marker at most, and it appears only where something stands past it: a
projection, or the `--help` that is given the callable's page rather than this
command's. That second spelling is the one exception to what follows the
marker, and it is settled below.

`cf exec` already read this way — its arguments written directly after the
mounted file, with nothing between — so `call` was brought to the sibling's
spelling rather than a third one being invented. It is the smaller change of
the two: what the callable's section needs is not a new boundary at its start
but a way out at its end.

**This is one rule across every command that reads.** Six carry the read
options, and they divide by whether a callable's vocabulary stands between the
command and them. `get` and `wish` have none, so nothing separates their read
options from the rest of the line. `call` and `exec` have one, so a marker
closes it:

```text
cf cell get  <addr> [path]           --select …
cf wish <target>                --select …
cf piece call <target> <verb> <input> -- --select …
cf exec <mountedFile> <input>   -- --select …
```

The read options come after the thing they shape in all four, and the marker
appears exactly where something else owns flags in between. That is one rule a
caller derives rather than two they memorize.

Every example in the documentation writes it this way, on all four commands.
The split that used to run through them was imposed by the grammar rather than
chosen, and closing it converged the surface rather than giving `call` a
spelling of its own.

**Parsing what follows the marker needs nothing new.** Setting the `--help`
exception aside, the tokens past it are the read options and only those, so
they parse against a command carrying just those three. Value typing, the near-miss suggestion for a misspelled flag, and
the refusal of `--schema` beside `--select` all come from the declaration that
already exists.

**The payload is verb input, whichever way it is spelled.** Inline JSON is the
same argument as the schema-derived flags that replace it, so it sits in the
same section, and no caller has to know which spelling of an argument changes
where it goes.

**Two reasons the closing marker earns its place**, and the second is the one
that generalizes. A verb has to be named before a projection is written, both
because a result cannot be shaped before it is produced and because nothing can
offer the positions of a result it has not identified. And a projection must not
be read where a verb's fields are read, because the two vocabularies are
independent and either may grow a name the other already has.

That second reason is why the boundary is not conditional on a collision
existing today. A rule that admits a projection into the callable's section
while no field shares its name is a rule that holds until an author adds one,
and then a line that worked reaches a different reader with no edit and no
warning. The boundary is drawn whether or not anything is currently standing on
it.

**A projection is refused before the verb**, and inside the callable's section,
and reported rather than absorbed in both places.

**`--help` reaches the callable from both spellings.** Written after the verb
it falls inside the callable's section and prints that verb's own page. Written
as `<verb> -- --help` it would otherwise land among the read options and print
this command's page instead, with nothing to refuse it, since `--help` is the
one flag that is never an unknown one. That shape has no competing reading: a
caller wanting this command's help writes it without a verb. So it is given the
meaning it already has, as a rule about the grammar rather than a window that
closes — which is why the marker's contents are the read options plus this one
word, rather than the read options alone.

**Every way to get this wrong is answered with the line that would work.** The
vocabularies on both sides of the boundary are known — `cf`'s flags are
declared, and the verb's fields arrive with its input schema — so a name in the
wrong section is recognizable as belonging to the other one. A refusal names
which section the flag belongs to **and prints the corrected command**, rather
than reporting that a name is unknown and leaving the caller to work out where
it should have gone:

| Written | What it should say |
| --- | --- |
| a `cf` flag after the verb | it is a `cf` flag, and that a projection goes past `--` |
| a verb field before the verb | it is a field of that verb, and that fields follow the verb |
| a projection before the verb | a result has to be named before it can be shaped |
| a second `--` | one boundary follows the callable's section, and it is already drawn |

The corrected line is what makes this survivable without a warned window. Every
one of these is a spelling that worked before, so the caller reading the refusal
is someone who learned the old one — and a message that says only what is wrong
asks them to rediscover the grammar, while one that prints the line asks them to
retype it. It is also what keeps a field named for a read option from being read
as one, which is the only case here that would otherwise pass quietly.
The repository already answers this way where it matters: a mounted callable's
result reports the whole command that reads it
back rather than the address alone.

`undeclaredFlagError` is where the first of those belongs: it already answers an
undeclared name with a near miss and the vocabulary the position takes, and
already carries one special case that searches a different candidate set. A name
that is a `cf` flag is another.

The rule for `cf` is one sentence: `cf` owns the flags it declares plus the
payload spellings it already forwards, up to the first marker. A verb declaring
a field that collides with a `cf` flag reaches it past that marker, which is
where every schema-derived flag already lives.

The three moves are independent and each stands alone, but they point the same
way: a caller states the space once, names the rest in one word, and writes what
follows in the order the words become knowable.

### Alternatives, and why they are not the design

Recorded so they are not proposed again by someone reading only the outcome.

**The verb leading the line.** Naming the verb first would give every later word
a verb to resolve against, which reads like the obvious fix for a projection
that cannot find one. It puts the verb ahead of the words that say which piece
it lives on, so nothing can resolve the *verb* — and that is the completion that
works today and the one worth most.

**A distinct marker for the second boundary.** A marker unlike `--` names its
own place, where a repeat of `--` is positional. It also cannot be written where
the argument parser is still parsing: a word shaped like a flag is refused
there, including one the command has declared. So the spelling that would make
it convenient — reaching the read step with no callable section before it —
costs a split of the arguments ahead of parsing, which the repeated marker never
needs because a second `--` only ever follows a first.

**Two markers, with the verb opening nothing.** Fencing the callable's section
on both sides is symmetric and puts every vocabulary behind an explicit
boundary. It also spends a marker on a boundary a positional already draws,
which is the boundary `docker run`, `ssh` and `cf exec` all leave unmarked, and
it forces an empty section on any verb that declares no input.

**Admitting a projection into the callable's section when no field collides.**
This costs a caller nothing today and holds only until an author declares a
field of that name, at which point a line that worked reaches a different
reader with no edit and no warning.

**A colon-joined `host:space:piece`.** A handle contains a colon, a DID contains
two, and a host carries a port, so the token cannot be split from either end.

**A bare `--` before the read options on the commands that have no callable
section.** Accepting it on `get`, `set` and `wish` would make the marker a
prefix introducing the read options rather than a boundary closing a section,
which is one mental model instead of two and lets a line move between `call` and
`get` unedited. It is refused on both counts it would have to earn.

The model contradicts the one flag it cannot govern: `--help` written past the
marker reaches the callable, deliberately, so a marker that introduces read
options would have to except the one flag that is never an unknown one. And the
marker stays mandatory on `call` and `exec` whatever the markerless commands
accept, so the rule becomes optional here and required there — weaker than
*the marker appears exactly where something else owns flags in between*, which
a caller derives rather than memorizes.

What the markerless commands owe is a refusal rather than acceptance. A `--`
written on one sets every word after it aside, and an action that reads none of
them returns an unprojected value and exits zero — the same silent
reinterpretation as a field named for a read option, and the reason the marker
is refused where it closes nothing.

### Precedent worth not re-deriving

Position deciding which entity a flag applies to is well-established.
`ffmpeg` scopes options by their position relative to `-i` — the same flag
before and after names an input setting and an output setting. `ld` resolves
`-l` against the objects to its left. `git` accepts `--no-pager` before a
subcommand and not after. The pattern is ordinary; what draws complaints in
those tools is that the rule is invisible where it is broken, which is an
argument about the error message rather than about the grammar.

Handing everything after a boundary to a wrapped command is the most
conventional shape on this list, and it divides on how the boundary is drawn.
Where a positional already marks it, no marker is written: `docker run` ends its
own options at the image name, as `ssh` does at the host and `env`, `nice`,
`timeout` and `sudo` do at the command. Where no positional marks it, a marker
is required and its omission is an error: `kubectl exec … -- <cmd>`,
`npm run <script> -- <flags>`, `cargo run -- <args>`. Neither family lets a
caller choose.

A `cf` call has the positional — the verb names it — and takes the first
family's shape for that reason. What neither family has is a section *after* the
wrapped command's, which is the one boundary a marker is spent on here. The
nearest precedent is `curl --next`, which separates one request's flags from the
next's: evidence for reading a line as a sequence of sections rather than as a
nesting.

A hierarchy in one token with optional parts is equally well-trodden, and
right-anchored optionality is its usual form: a container image reference
(`registry/namespace/image:tag@digest`) defaults the registry and namespace when
they are omitted, as `scp`'s `[user@]host:path` defaults the user. `kubectl`'s
`type/name` is the same idea one level shallower.

Ambient scope with a flag override is close to unanimous among tools that
address more than one tenant: `kubectl` has a current-context namespace beside
`--namespace`, `gcloud` a configured project beside `--project`, `aws` a profile
from environment or configuration beside `--profile`.

## How to get there

Additive, in dependency order. Nothing before 6b removes or renames anything a
caller depends on — steps 1 through 6a only add, and 6a adds a warning rather
than taking anything away.

1. **Factor out the shared read step** so a single implementation turns a cell
   and a shape into structured output.
2. **Give every arrival access to it** — `cf piece call` gains `--select`,
   `--schema` and `--filter`, `wish` gains them, and an address renders identically from each.
3. **`--piece` accepts the `of:` address form**, so an emitted address composes
   into the next command. This is where addressing stops being piece-flavored
   in practice.
4. **Add positional addresses and the `#argument` suffix** beside the existing
   flags, keeping both.
5. **Give the data commands top-level names** — `cf get`, `cf set`, `cf call`
   — as aliases of the existing implementations. Same code, honest names,
   both spellings working. Step 7 moves them again, under the noun each acts
   on.
6a. **Warn on the old spellings**, each warning naming the date its spelling
   stops working — two weeks after this step reaches main. The date is a
   literal, fixed when this step merges, not a window recomputed per run: a
   caller who reads the warning today and acts on it next week must be told
   the same date both times.
6b. **Remove the old spellings** on the date the warnings named. Done: the
   piece-mounted `get`, `set` and `call`, the 6a notice and its dated
   constant, and the parity coverage that existed only while both spellings
   did, are gone.
7. **Put each command under the noun it acts on.** `cf cell` gains `get`,
   `set`, `get-label` and `set-label`; `piece` gains `call`; `space` gains
   `recreate-root` and `set-home`. Each moved command stays answerable at the
   spelling it had, hidden and dated, so a script keeps working while it is
   migrated. The date bounds a guarantee rather than schedules an execution:
   removing those mounts is 7b, a separate change, the way 6b was separate
   from 6a. 7b takes the notice and its dated constant with the mounts, and
   `packages/cli/test/integration-command-spellings.test.ts` too — the check
   holding the integration drills to the blessed spellings has nothing left to
   find once no superseded spelling answers.

   The duplicated nouns this step was named for resolve rather than merge.
   `piece inspect` reports on a live piece and `cf inspect` reads a stored
   one; `piece map` draws live pieces and `inspect graph` a stored graph;
   `cf view` pages a source file and `piece view` renders a running piece.
   Different objects, so the fix was naming. `piece apply` and `cf cell set`
   stay separate for the reason recorded above.

Steps 1–5 are mechanical. Step 7 needs real decisions and belongs last, because
each pair is two working commands whose merge changes behavior rather than
spelling.

**Naming the target is a second arc, not a later step.** Steps 1 through 7
decide what the commands are called; the work below decides how a caller writes
what a command acts on. The two are independent: 6b has removed the
spellings 6a warned about, so step 10 is free to change those same commands.

8. **Give the space an ambient source** in `CF_SPACE`, with the flag overriding
   it, serving reads and writes alike; and every command that writes names the
   space it wrote to.
9. **The reference takes a space by name and a piece by slug**, and may be
   written positionally wherever the target flag is accepted. Done.

   The flag is `--cell`, and `--piece` is a deprecated name for the same
   option — one Cliffy option with two long names, so the two cannot disagree
   and writing both is refused. Deprecated says what it says: do not write new
   commands against it. What it does not say is when it stops working, because
   there is no removal date and no removal condition, deliberately. Nothing
   warns at runtime either: a notice is worth printing when it names something
   a caller can act on, and this one would name nothing to do beyond a rename
   the documentation already asks for, while a per-invocation warning with
   nothing attached teaches people to ignore `cf`'s stderr — the surface where
   real problems are reported. "Will be removed" is what is not written, since
   that commits to something not decided.

   The positional reference is preferred over either flag, which is what makes
   the flag's name a small question rather than a large one.
10. **The verb opens the callable's section and `--` closes it**, on `call` and
    on `exec`. A projection is refused before the verb and inside the callable's
    section, and each refusal names the section the flag belongs to and prints
    the corrected line. The change takes effect at once rather than through a
    warned window.

    Printing the corrected line is what carries that. A `cf` flag written in
    the callable's section is refused with the section it belongs to named, and
    a word past the marker that is not a read option is refused with the marker
    taken back out — each message ends in the line to retype.

    The boundary itself is unconditional, which is what keeps it worth having.
    Past the marker a word is the read step's, whatever the verb's own fields
    are called; before it, a word is the verb's. Nothing reserves a field name,
    so a verb may declare `select`, `filter` or `schema` — and that costs its
    caller nothing, because the field is written in the section the verb opened
    and the projection past the marker, which are two different positions. A
    verb wanting both on one line writes both, one on each side. That a
    pattern's own vocabulary overlaps `cf`'s is a question for that pattern's
    author, not one the CLI answers by guessing between two readings of the
    same word.
11. **`--url` decomposes** into the transport it names and the reference it
    carries, and survives as a convenience for pasting rather than as the only
    spelling that carries a whole target. Done. It has no parsing of its own
    any more: the host becomes the `--api-url`, the rest becomes a reference,
    and both are read on exactly as if they had been written. Segments past
    the piece are that reference's path, which is the reading `parseFabricUrl`
    already gives a page URL of this shape and which the old `--url` dropped
    without saying so.

Steps 8, 9 and 11 add. Step 10 is the one that changes what a written line
means, and it is the one the rest of the surface reads against — a projection
cannot be written after the verb until it lands.

**9 and 11 landed together, as one change**, which is what kept them worth
doing. Step 9 on its own would have given the reference a vocabulary another
spelling already had and retired neither, leaving more overlap between the same
spellings — capability added to the accretion this document exists to reduce.
What made 9 worth doing is 11: the reference earned the human vocabulary so
that `--url` could decompose to it and stop being the only spelling carrying a
whole target. As a pair the surface ends with one fewer way to name a thing;
9 alone would have ended with one more.

Their ergonomics compound the same way, and mostly outside 9. Naming the space
ambiently is step 8's, and the slug is what saves the hundred characters — so
the increment 9 adds over 8 is that a slug also works in the canonical
position, not the whole distance between the long form and the short one.

**The prior question, and its answer.** Whether a reference grammar is the
right home for this at all, or whether it stands in for a naming and
resolution layer that does not exist. `cf` needs the grammar precisely because
it cannot have a *place*: [Shuttle](shuttle/) carries a mutable position
across commands, and a one-shot process cannot. They are complements rather
than substitutes, and a resolution layer would not have made either step
smaller.

**The trailing form is taught throughout.** The read options go after the thing
they shape on every command that has them, which is what `get` and `wish`
already showed and what `call` and `exec` gained.

**The verb session documents change with the demo script.** Their commands are
held by `deno task check-verb-session-sync` to what
`packages/cli/integration/verb-session-demo.sh` runs. They quote the demo's
commands and never compose them, so a command that changes changes in the
script and in both documents together, in one commit.

**Each step carries its own documentation.** `--input`, `--piece`, and
`cf cell get` appear across the tutorial, `packages/cli/README.md`, and the
pattern documentation, so a single sweep at the end would leave every
intermediate state wrong. What each step owes:

| Step | Documentation owed |
| --- | --- |
| 2 | The read options gain a second host — `cf piece call`'s section in `packages/cli/README.md`, and [Verbs over the CLI](../common/verbs/over-the-cli.md) |
| 3 | Address forms wherever `--piece` is taught: the CLI README and the tutorial's workflow chapter |
| 4 | `#argument` beside every `--input` example, in the same places |
| 5 | The new spellings alongside the old ones everywhere both work |
| 6a | The old spellings marked deprecated wherever they are taught, each carrying the removal date |
| 6b | Removal of the old spellings, and of the deprecation notes 6a added |
| 7 | The rule and the mapping here, `packages/cli/README.md`'s superseded-spellings table, and every example moved to the new spelling |

**Old spellings stay as redirects, not errors, until the date 6a names.** A
deprecated spelling that still works costs a line of aliasing; one that fails
costs every script and skill file that used it, including ones outside this
repository.

A DATE rather than a traffic threshold, because the traffic is not observable.
Both spellings mount the same builder and emit identical requests, and the CLI
sends nothing that would let a server attribute one to either — so measuring
adoption means adding a marker to the wire, somewhere to collect it, and a
privacy decision about a tool that runs on other people's machines. The
condition that wording implied could not be checked, only estimated.

What IS checkable is this repository, and it is a precondition rather than a
gate: the sweep in step 5's documentation row should land before 6a, so the
warning does not fire on examples we ourselves still teach. Consumers outside
this repository are unmeasurable by any means available here, which is an
argument for a generous interval rather than for instrumenting one.

## Decisions this document does not make

**`wish` stays its own command.** A wish is a query, not an address: it resolves
to whatever satisfies it, and may match nothing. Folding it into a read over
addresses would be a category error. It shares the output step, not the way you
arrive.

**`exec` runs something reached through a filesystem mount.** Whether that
becomes an address form or stays its own command depends on how far the address
grammar should reach into the filesystem projection.

**`piece step` is not redundant with the `--step` flag.** A separate step
process cannot carry its work into a later read in another process, so the
standalone command and the flag are not interchangeable. Any merge has to
preserve that.

**`piece link` stays.** It writes a link with reactive-wiring meaning that a
general value write does not express.
