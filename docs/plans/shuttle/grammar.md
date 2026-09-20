# Shuttle — line grammar and place resolution

Satellite of [`README.md`](README.md): the command line's shape, how
references resolve against the place, what listings show, and the write and
redirection surface. Ruled points are stated plainly; anything marked
*proposed* awaits a ruling.

## The line

```text
<verb> [reference] [arguments…] [options…]
```

Navigation verbs are shuttle-native: `cd`, `ls`, `pwd`, `watch`,
`unwatch`, `watches` (`cd -` returns to the previous place). Data verbs
are `cf`'s own — `get`, `set`, `call`, `wish`, `verbs`, `describe`, … —
accepting their existing
read and projection options (`--filter`, `--select`, `--schema`, `--json`),
with the place supplying target options. `!` marks "this runs on the local
machine" everywhere it appears: line-initial `! <cmd>` runs any local
program, `|!` is the same escape in a pipeline, and `!cf …` is the special
case that also injects place-derived flags.

## Splitting the line

`cf` never splits a line: it is handed `Deno.args`, already split by the
operating system's shell, and the reference grammar it reads those words
through has no rule for one. Shuttle is handed the line itself, so the split
is shuttle's, and it is POSIX's:

- **Whitespace separates tokens**, and a run of it separates no more than
  one. Whitespace is JavaScript's own class, which is what `trim` removes,
  so a no-break space and the Unicode line separator separate a line as a
  space does — a reader cannot see either, and the realistic way an operand
  acquires one is a paste out of a document. The pair stays consistent about
  them: what separates here is what the printer quotes, so a value holding
  one still reads back whole.
- **Single quotes are literal**: what sits between them is the token's,
  whatever it is.
- **Double quotes group**, and a backslash between them escapes a double
  quote or another backslash and is otherwise a character of the token, so
  `"C:\path"` keeps its backslash. Outside quotes a backslash escapes
  whatever follows it.
- **Runs that touch are one token**, so `a"b c"d` is `ab cd`, and an empty
  pair of quotes is a token that is the empty string.
- A quote that never closes, and a trailing backslash with nothing to
  escape, are refused with the reason. Nothing else refuses a line: one
  that splits says only that, and whether its tokens name anything is
  every later reading's question.
- **A line is one line**, and a terminator on it is whoever read it to
  strip. Line terminators are in the separator class, so text carrying one
  splits across the break into a single run of tokens: a pasted second line
  arrives as more operands of the first command rather than as a command of
  its own. That is a choice and not a necessity — every value the printer
  writes that holds a line break lands inside quotes, so refusing an
  unquoted one would leave the round trip below whole. The round trip says
  the choice is safe, not that it was forced.

Quoting is what makes a value holding whitespace one operand, which is what
the write surface below needs. `set draft '{"title": "a b"}'` is three
tokens; the same line with the quotes left off is four, and the JSON's own
quotes come off two of them, so what `set` would read is `{title:` rather
than an object. A verb reads a token, and nothing reassembles one.

**On output, a value is printed as a token**: bare where nothing in it would
end the token early or read as structure, and quoted where something would.
GNU `ls` has printed names this way since 8.25, so the habit is already in
every terminal user's hands, and the point of it is that the common case
stays bare — a slug, a handle, a flag and a path each print as themselves.

What forces quoting is whitespace, either quote, the backslash, and the
characters this grammar spends on structure rather than on data: the pipe,
the `!` that marks a local program, the two redirection operators, the `#` a
wish target and a member are written with, and the `%` a numbered handle is. Each is ruled elsewhere in this document; collected here, they
are the set a printed value is held against, and a value holding one is
quoted wherever in the value it sits — a printer is handed a value and no
position, so it quotes on the character rather than on the reading.

The characters an operand writes an address with — the `/` between segments,
the `@` of a scope qualifier, `-`, `..` — are deliberately not in that set,
and
that exclusion is what makes the output rule worth having rather than a
detail of it. Those characters are read inside a token by the place
resolution below rather than by the split, so quoting on them would buy the
split nothing and would cost the bare printing of every handle, every slug,
every path and every flag — which is to say nearly everything shuttle
prints, leaving nothing conditional about conditional quoting.

Some characters this grammar spends on structure are left out all the same,
and the same cost is the reason. `:` marks a scheme and the `x:` base, and
it also sits in every handle — `of:fid1:…` — so reserving it would quote
every reference that prints. `-` is the previous place and the stdin
sentinel, and it opens every long flag. Each of them is read at the head of
an operand, or as the whole of one, rather than by the split, which is what
puts them with the address characters rather than with the reserved ones.

The two halves are one decision: what the printer writes, the split reads
back as the one value it was given. That is the whole of the guarantee, and
it stops there: **a quote reaches no reading**. The split returns plain
strings, so a reading sees the characters a token holds and never how they
were delivered, and `cd '..'` and `cd ..` are one operand. What names a key
whose own characters a reading would take is therefore a different spelling
rather than a different quoting — the key behind the `.` head, `./..`, which
reads none of those readings — and that is what a listing prints for such a
row.
Ruling the other way has a known shape and a known cost: the split would
start carrying which parts of a token were quoted, which grows the value it
returns rather than adding a layer over it, and every reading that consults
quoting reads that value.

## Options and operands

The split says where a token ends; what a token is *for* is the second
reading, and it is POSIX's too. After the verb, **a token opening with `-` is
an option up to a bare `--`, and every other token is an operand**, the options
being the table that verb declares. Two tokens the rule turns on are the two
this grammar already spends the character on:

- **`-` on its own is an operand** — `cd`'s previous place and `set`'s stdin
  sentinel — so the one reading that would make it a flag is the one it does
  not get.
- **A bare `--` ends the options.** Every token after the first one is an
  operand whatever it opens with, and that first `--` is neither an option nor
  an operand. So a key called `-x` is reached by `cd -- -x`, and one called
  `--` by `cd -- --`.

Options may sit anywhere among the operands, which is what a `cf` command
reads unless it declares a section: `cf piece call` and `cf exec` are
`stopEarly()`, and everything past their first operand belongs to the callable.
So the line shape at the top of this document says where options usually go
rather than where they must, and a shuttle verb mirroring either of those two
carries the call section below rather than this rule.

How many operands a verb takes is part of the same table. A verb declares what
it takes, and the noun phrase its refusal calls a missing operand by, and the
reading that divides the line enforces both: the count is applied in one place
while the wording stays each verb's own — `cd` says it takes a place to move
to where `wish` says it takes the target to resolve. A verb that takes an
operand it can do without declares that too, since what it does with none is a
reading of its own rather than a line for the dispatch to answer: `get` reads
where it stands, and `help` lists the verbs.

The verb that carries a call section is the one with no upper bound to
declare, and it is the same fact as the option reading above: the words past
its own operands are the callable's, and how many the callable takes is not
this table's to know. So it declares the fewest it needs and nothing more, and
the words after those reach the callable whatever their number.

The parse is `cf`'s own: `parseFlags` (`@cliffy/flags`) is what `Command`
reads a `cf` line's flags through, and it reads a bare token array, so a flag
is spelled, defaulted and refused here exactly as the same flag is on a `cf`
command line. That is what keeps decision 7's "data verbs are exactly the
`cf` ones" true of the flags as well as of the words — `--select` here is
`--select` there, and a misspelling gets the sentence `cf` gives it, with one
naming the verb's own page after it.

**`--help` is an option every verb takes**, put in front of whatever a verb
declares rather than declared by each, so a verb has no way to be without one;
a line carrying it writes that verb's page instead of running the verb. It
carries the declaration `cf` gives its own, standalone included, so a verb
whose required options a line has not supplied still answers what it takes —
and `--help` written beside another option is refused rather than answered,
exactly as on a `cf` line. `help`
is the verb beside it: `help` lists every verb with its one-line summary, and
`help <verb>` writes the page `<verb> --help` writes. Decision 3 puts
teammates second and names help as part of what serves them, and a shell whose
only account of itself is the refusal a mistyped word gets serves nobody who
does not already know it.

The option reading costs a listing one shape, and it is the shape the quoting
ruling above already costs one of. Every name a listing prints is one `cd`
takes back, and a name opening with `-` is read as an option when it stands as
a token of its own, so such a key is offered behind the `.` head, `./-x`,
rather than as itself — the answer a key called `..` gets, for the same reason
one layer up. What a listing offers and what can be typed are two questions:
`cd -- -x` reaches that key and `cd -- --` reaches one called `--`, a bare `--`
ending the options, and what a listing prints is the name rather than the
route.

A verb's page lists the options it declares, read off the table the parse
reads. That is one record rather than two: an option added is an option the
page describes, and one the page describes is one the parse takes. What a
page carries past the table is a description per option, in shuttle's own
words — a page here speaks about the place a verb reads from, where `cf`'s
speaks about `--cell` and a path positional — while the spelling, the value,
the default and the conflicts are the `cf` command's, since those are what
decide whether a line means the same thing on both surfaces.

## Place resolution

A reference on the line resolves against the place, right-anchored, exactly
as the canonical grammar's context rule already works:

- `/of:…` — a **rooted** reference: it names the piece and path from the
  root, so no part of the position is read from the place — but it omits
  the space and the scope, and the place supplies both. Rooted is not
  place-independent. A rooted operand whose first segment names a facet is
  the walk down from the space root instead, the facet names being
  reserved there too (below).
- `//did:key:…/of:…` — a **complete** reference: piece, path and space are
  its own, and the scope is still the place's. It is place-independent in
  one dimension and not in the other, so the same string read at `@user`
  and at `@session` names two different cells. Denoting is not reaching,
  either: a connection serves one space, so a reference naming a different
  space than the place's is refused rather than followed —
  `validateEmbeddedSpaces` (`packages/cli/lib/llm-friendly-ref.ts`) already
  holds `cf` to that, and shuttle v1 holds one connection.
- `//did:key:…/of:…@scope` — a **fully qualified** reference: every level
  is its own and nothing is read from the place, so it denotes the same
  cell read from anywhere. This is the form a printed address or a shared
  link should be, and it is what `pwd` prints, for that reason.

  The scope a complete reference omits is the context's: a reader holding a
  context fills it from there, and one holding none reads the base. Shuttle's
  context is the place, so it fills the scope from the place, the way a shell
  reads a relative path — and that is why `pwd` writes the qualifier rather
  than trusting it to be inferred.

  A piece position is written by the shared renderer, `renderCellReference`
  (`packages/runner/src/cell-reference.ts`), against the empty context, which
  writes the space as `//<space>/` and the scope after the piece.
  `renderPosition` (`packages/cli/lib/shuttle/place.ts`) is where shuttle
  hands it a position, and the one place shuttle writes a complete reference.
- `#…` — a wish target (entry point), resolvable from anywhere within
  the connected space. A target anchored elsewhere — profile and
  favorites resolve against the reading identity's home space regardless
  of the connected space (`packages/cli/lib/wish.ts`) — is refused with
  the reason in v1, which holds one connection to one space.
- `/` — the space's own root, the leading `/` of a rooted reference
  with nothing following it; `cd -` — the previous place.
- `%n` — a row of the last listing, a head that what follows it is read
  against.
- Anything else — a **relative** reference, read by the reference grammar's
  own reader (`parseRelativeReference`) as a head and a literal path: the
  head, `.` or a run of `..`, says how many levels to climb and which member
  and scope to read, and the path is descended from where the climbs land —
  a facet at a space root, a piece segment inside `slugs/` or `pieces/`, and
  a key or index inside a piece.

The distinction is the parser's, not shuttle's: `parseCellReference`
(`packages/runner/src/cell-reference.ts`) takes the space from a context and
uses it whenever the reference carries no `//did:key:…/` prefix, overriding
it with the embedded space when one is present. A rooted reference is
therefore exactly as space-dependent as a relative one; it is the piece and
path it fixes, not the space.

How a reading is matched says where it holds. `-` and a lone `/` are matched
against the whole operand exactly, so neither governs a segment: a key named
`-` is reachable relatively wherever it is not the whole operand, and `./-`
reaches it there too. A lone leading `#` is matched against the operand's
head and takes the whole operand with it: `cd #favorites/topics` hands on the
whole string as one target. A leading `%` is a numbered handle, matched
against the head the same way.

Every other relative operand is the reference grammar's. Its head — `.`, or a
run of `..` — is read before the path, and is where the operand takes a
member or a qualifier: `.@user` moves the scope, and `.#argument` selects the
arguments member. After the head the path is one RFC 6901 pointer, in which
every segment is a literal key: `a/../b` names the three keys `a`, `..` and
`b`, `./items@user` is the key `items@user`, and `~1` and `~0` are the
escapes for `/` and `~` inside a key, so `cd a~1b` reaches the key `a/b`. A
key the bare form would read as a head — `..`, `.`, and the empty key — is
written behind the `.` head: `./..`, `./.` and `./`. What follows a handle is
read the same way, the handle standing where `.` stands, so `%1/..` is the
key `..` under the row's position and `%1/` the empty key under it.

A head's climbs are taken one at a time through the route shuttle walked,
and not computed from the position, because above a piece there is no parent
function of an address: a piece reached through `slugs/` and the same piece
reached through `pieces/` are one position with two different ways back. So
a climb leaves a piece for the facet or the root it was reached through,
which the reference grammar, having nothing above a piece, leaves to a reader
that holds a route. A walk that climbs back out of a piece lands without a
read, and one that descends waits on the read its last level needs.

Above a piece there are no keys. A final empty segment where a walk ends at
the root or a facet is the separator that ended the operand and names
nothing, so `cd slugs/` reaches the facet; an empty segment anywhere else
above a piece names a facet or a piece that no name is, and that level
refuses it. Inside a piece the same separator names the empty key, so
`cd slugs/board/` stands at the key `""` under `board`, and a `cd` that finds
no such key says that the trailing `/` named it.

Where a member and a qualifier are read is where a segment names a cell: the
head of a relative operand or of a handle, and a segment naming a piece — one
a walk reaches from a facet, and the piece segment of a rooted or complete
reference — which the reference grammar reads with `parsePieceSegment`, so
`board#argument@session` there selects the arguments member at scope
`session`. A qualifier the grammar registers that a place cannot hold is
refused rather than dropped where shuttle reads the head or the piece segment
itself: a place holds no pin, so `@pin=` is refused there, while `@inherit`
names the context's scope, which is the place's own. In every segment that
is data, `@` and `#` are ordinary characters.

The property every door is held to is that a rendering may be refused but
may never name a cell other than the one it was printed for. Writing a
rendering separates its lines with a newline, so a segment holding one would
split the position line and leave a shorter reference naming another cell,
and such a segment is refused wherever it sits. Reading a rendering back
loses nothing a key holds: the reference reader keeps an empty key and a key
ending in whitespace, and the renderer escapes the separator and the escape,
so both are keys like any other.

A control character is refused as well, for a reason the round trip cannot
see: a rendering is read on a terminal, and there Unicode's `Cc` characters —
C0, `DEL`, and C1, whose `U+009B` is a sequence introducer needing no escape
in front of it — are instructions rather than text. Refusing is what a name
gets rather than the escaping a message gets, and the difference is that an
escaped name no longer names its row: a message survives being made safe and
a name does not, so the door is the only place left to stop one. That such a
name reads back whole is what makes it dangerous rather than what excuses it,
since what a person copies off the screen is what the terminal did with it.
`U+00A0`, `U+2028` and `U+2029` are not in that class and are admitted: a
terminal prints them, and the printer quotes them, being whitespace to the
split.

Of what a rendering loses, only the newline reaches a piece that has one. An
empty piece renders as a piece segment with no id in it, which the reader
refuses whole rather than reading back as anything.

The piece is nonetheless held to more, for a different reason: one that is
empty, ends in whitespace, holds an `@`, or holds a control character is
refused because no slug or handle carries such a name. The reason covers all
four. The mechanism behind it covers three: for a piece shaped like a handle
— a colon, and twenty characters — the parse takes it, its handle test being
a length rule rather than an alphabet one, and hands back verbatim a name the
`fid1` encoding could not have produced, a rendering that round-trips exactly
and denotes nothing. That is neither a wrong address nor a dead one, which
is why the reason cannot be either. For an empty piece, and for anything
shaped like a slug, the parse refuses it already; refusing at the door
moves the refusal earlier and names the vocabulary where the parse names
only the failure.

One rule rather than four is a choice about wording, not about safety: the
redundant cases cost nothing.

**Every door holds the piece to the two vocabularies** besides, and the check
is the canonical parse's own — `validatePieceSegment`
(`packages/cli/lib/llm-friendly-ref.ts`), called rather than copied, so that a
name in neither vocabulary is refused with one sentence whichever door read
it. The doors are the reference, a walk into a piece, a target the fabric
resolved, a settled move, and the piece a read resolved, which is every door
a piece reaches a place through:
`cd slugs/Board` is refused, and the reason it gives is the reason `cd /Board`
gives. That is what makes a listing's job possible: a name printed as an
operand is one `cd` takes, and a name the rule refuses is one nothing offers
an operand for.

The vocabulary rule still buys no guarantee that every rendering is
followable, and it and the rendering rules above catch different names. A
handle-shaped piece holding an `@` or a `#`, or ending in whitespace, is
caught by the piece rules above rather than by the vocabulary,
`isPieceHandle` being a length rule that takes any of them.

A segment lifted out of a rendering is an operand in its own right, so
these readings decide it rather than the key it was printed from.

The `#` character has three readings, and they share nothing but the character.
A lone `#name` token is a wish target, as above. `#argument` is a **member**,
read where the rule above reads one — on a head and on a piece segment — and it
selects the piece's arguments cell, the same selection `--input` spells as a
flag: `.#argument/title` from inside a piece, `%1#argument/title` against a
listed row that stands in a piece, and `/slugs/board#argument/title` from
anywhere. A head standing at a space root or a facet holds no arguments cell and
is refused one, and so is a handle whose row stands at one: the row's own
position decides, and not the place its listing was read at, so a piece row
listed inside `slugs/` takes `%1#argument/title`. The path after the member is
inside the arguments cell and is read from that cell's root, so `.#argument/a`
reads the key `a` of the arguments cell wherever in the result shuttle stands,
and a head that climbs and selects the member in one, `..#argument/a`, is
refused — there is no level for the climb to leave, and the reference grammar
refuses the same head. `#result` is the default member and switches nothing. And
in every segment that is data `#` is an ordinary character:
`/slugs/board/title#argument` is the result key `title#argument`, the wish
reading being decided on the whole operand and governing its head and nothing
else.

A key whose first character is `#` is a wish target when it is the whole
operand, and is written behind the `.` head everywhere it is named: `./#tag`
reaches it, and that is what a listing prints for such a row.

A container renders without the leading `/` that marks a reference, so a
space root and a facet cannot be read back as a piece whose slug happens to
match their name; `cd` refuses such a rendering rather than following it.

A place is **result-rooted**, and holds exactly space, piece, path, and
scope. `cd` refuses a target selecting the `#argument` member, in every
spelling that selects it, rather than dropping the member silently: a place
that could root at the arguments cell would leave every later relative read
ambiguous about which side of the piece it addressed, and the prompt would
have to carry the distinction for as long as you stood there. Arguments are
reached per operand instead — `get .#argument/title`,
`get /slugs/board#argument/title`, and `--input` on the `cf` verbs that take
it — so the choice is one visible token at each use. A `#argument` written as
a whole operand names no piece to select the member of, and is refused with
those two spellings.

## What `cd` reads before it moves

A shell's `cd` is the one verb whose success means something, so a move
that reaches a piece is asked of the fabric before the place is adopted,
and the refusal a place that is not there gets is shuttle's own rather
than the runtime error whichever verb read next would have raised.

Three questions, each asked only where there is one to ask:

- **The piece**, where the move reaches one it is not already standing on.
  A slug resolves through the space's index (`resolvePieceReference`,
  `packages/piece/src/slugs.ts`) — the same resolution a read makes, given
  the same path, so a slug naming a *collection* spends leading segments
  reaching its member and `cd /tasks/first/title` lands where
  `get /tasks/first/title` reads. Two verbs disagreeing about whether a
  reference names anything would be worse than either answer. The place
  takes the path the resolution left and the scope it was reached through,
  a member held through a narrowed link being a different document from
  the one its id alone names. **The place holds the piece it resolved
  to**, with the slug beside it as the name the prompt shows —
  decision 13's checked name, read once at the move rather than trusted
  per command. A slug is a redirect: a place holding one would follow the
  index to another piece without moving, and B2's `set` would write where
  the index points now. A place holding the piece cannot move. A slug the
  index names nothing for is refused here, carrying the resolution's own
  sentence. A move that spells the piece already stood on — a key under
  it, or a reference naming it — resolves nothing: that piece came through
  a settle of its own, so the question is answered, and the move changes
  the path rather than the piece. What counts as already settled is the
  place and not the position: a move to the same path at another scope is
  a move to another document, and reads again.

  The place a settle adopts is the route's as well as the destination's. A
  trail is made of positions `..` walks back through and `-` restores, so
  every one of them is a place shuttle can stand at, and each is landed
  with the piece the resolution answered. Where the resolution spent
  segments, the levels it walked *through* are levels of the collection
  rather than of what it held and go with it; the level the member itself
  sits at is the member's, and lands with the member's piece. A route
  records how shuttle reached a place, so `cd a/b/c` and `cd a/b` then
  `cd c` are one walk written two ways and leave the same route.
- **The handle**, where the resolution reached one without proving it. A
  handle is a spelling and not a lookup — the resolution hands one
  straight back, `isPieceHandle` being a length rule — so the space's own
  identifier index is asked whether it holds that piece (`entityIdExists`,
  `PiecesController`, which tests one identifier without selecting a
  stored value). The lookup reads either spelling of an unkinded entity —
  the bare tagged hash a piece reports as its own id, which is what
  `pieces/` lists, and the `of:` id the index keys on — so a handle typed
  back off a listing is one it answers about. A value read cannot stand in
  for it: a piece the space does not hold reads as nothing, and so does an
  empty one. A slug needs no such lookup, its resolution having reached the
  document to take an id from it, and neither does the piece a move already
  stands on.
- **The path.** One read of the cell at the deepest level already stood
  at, walked segment by segment through the value it returned. The first
  segment that is not a key of the level above it is refused by name, with
  the keys that are — the sentence the runtime's `Available keys:` hint
  carries, in shuttle's words and as a refusal rather than as a failure.

What that costs is one identifier lookup on a `cd` onto a piece named by
handle, on top of the path read, and nothing on any other move: not on a
slug, whose resolution is its own proof; not on a key under the piece
already stood on; not on a move that reaches a container. The lookup reads
an index rather than a value, which is what makes it affordable at a
prompt.

The read is aimed one level above the destination and never at it, and
that is what keeps every miss a refusal. A read aimed at a path the fabric
does not hold raises, which is what tells a server that went away from a
line that was wrong; aimed one level up it reads a cell that is there, and
what it finds is data.

The lookup is a server capability, and there the promise stops. A server
that does not advertise it (`entityIdLookup`, `packages/memory/v2.ts`)
answers neither yes nor no, and a handle read against one is taken as
written — the one spelling `cd` adopts without having settled it. Every
current server advertises the lookup; the bound is what an older one
leaves.

A move that reaches no piece waits on nothing: a facet is a closed set of
names, and `..`, `-` and `/` each reach a place already stood at. A scope
on its own is not among them and settles like any other move onto a piece:
it leaves the position where it was and changes which document that
position's id names, so the place it reaches is one nothing has read.

`get` waits on nothing either, though its operand goes through the same
readings: where an operand points is a fact about the operand, and a read
of a cell that is not there fails on its own account and in its own words.
That asymmetry is the same one `#argument` has — the two doors differ
exactly where standing somewhere differs from reading it.

## The space root and facets

A space root lists **facets**, never pieces directly — a populated space is
too large for a flat root. The starting facet set:

- `slugs/` — the slug index: named pieces, the primary human view.
- `pieces/` — pieces by id, each showing what it calls itself.

A `fuse/` facet mirroring the FUSE layout is designed and deferred past v1
([`futures.md`](futures.md)); shuttle leverages `packages/fuse`'s naming
and hydration work regardless of when that facet lands.

Facet names are reserved wherever a walk from the root begins: as a
segment at the space root, and as the first segment of a **rooted**
reference, so `/slugs/todo` names what `cd /` then `cd slugs/todo`
names. Inside a piece no name is reserved at all, and a facet name is an
ordinary data key there. The readings above are spellings rather than
names, and are what they are wherever a piece's path admits them. A
piece's callables need no reserved name: they surface inline in
listings, annotated as callable, exactly as the FUSE layout marks a
handler an executable file inside the piece's tree (and the `verbs` verb
lists them on demand).

What the reservation buys is the property every rendering here is held
to. The prompt writes a facet as `/slugs/` and the shell teaches
`cd slugs` in its first minute, so the rooted spelling is the one a
person reaches for next; read as a reference it would name a piece one
character from the facet rendering, and read as a walk it names the facet
the prompt printed.

**What it costs is a divergence from the canonical grammar, at two slug
values.** The rooted spelling is not shuttle's own. `[//space]/<piece>…`
is the canonical way to name a cell — the runner's `parseCellReference`,
the same structure in patterns, in the shell and at every `cf` intake
seam — and this CLI, which opens a session before it reads anything,
resolves that piece segment by slug as well as by handle
(`packages/cli/lib/llm-friendly-ref.ts`). `slugs/` and `pieces/` are the
shuttle-only half: facets, a browsing overlay on the space root. So a
rooted reference whose first segment is a slug is the canonical grammar
and predates shuttle, and reserving two values in that position means
shuttle reads `/slugs/x` and `/pieces/x` differently from the way `cf`
reads the same strings — and identically for every other slug. Issue
[#6992](https://github.com/commonfabric/labs/issues/6992) retires the
divergence by having `set-slug` refuse those two values as slugs, after
which no piece can carry them and the two grammars agree everywhere.

The reservation reaches the rooted form and no further. A complete
reference carries its own space and is the canonical grammar's outright,
so `//did:key:…/slugs/todo` still names a piece slugged `slugs` — which
is what leaves such a piece nameable at all until #6992 lands, beside its
handle. The root already paid the same cost: `cd slugs` at the root has
never reached a piece by that name.

The reading is matched against the operand as written, as every reading
above is, and **an operand that would be rooted only once its leading
whitespace came off is refused**. Such an operand has two readings that
name different cells: as written it is a relative walk whose first segment
is whitespace, and to the reference grammar — which trims the string it is
given (`isReference`, `packages/cli/lib/llm-friendly-ref.ts`) — it is
rooted. Left to fall through, the rooted reading takes it, and the facet
names a rooted spelling reserves are not reserved in that one, so
`cd " /slugs/todo"` would reach a piece slugged `slugs`. Reaching it is
not what the refusal is for; reaching it *silently* is. A wrong place a
`cd` adopts is a promise the prompt goes on making, which is the thing
decision 11 ends, and a refusal cannot make it.

The rule is exactly that wide. Leading whitespace costs a name nothing
anywhere else — `cd " foo"` reaches the key `" foo"` — so only an operand
that trimming would *root* is refused, and one that trimming leaves
relative is read as it is written. A rooted operand carrying trailing
whitespace is rooted as written and is read that way: the walk keeps its
edges, so `cd "/slugs/todo "` is refused for a piece ending in whitespace,
by the rule a piece answers to, and `cd "/slugs/todo/title "` reaches the key
`title `.

The facet set stays deliberately small; growing it is a design decision,
not a convenience.

## Listings, pagination, search

`ls` lists what stands at a place: a space root's facets, the slugs the
space's index records, the space's pieces, or the keys directly under the
cell the place names. A row that failed on its own account is still a row —
a slug the index names and nothing resolves is a name the space has — so it
carries what went wrong rather than being dropped, and one failed row never
takes the listing down with it. A read that failed outright is no listing at
all and raises.

**Which place is `ls`'s operand to say, and the place shuttle stands at
where the line writes none.** The operand is read through the door every
reading verb reads one through, so `ls`, `get`, `describe` and `verbs` spell
a target the same way: a relative path, another piece, a slug, a facet, a
rooted or complete reference, a `%n` row of the last listing. What a verb
then does with what that door found is its own, and `ls` parts from `get`
twice, each time because a listing is not a value. A space root and a facet
hold no value and are refused there; here they are what a listing is for.
And the `#argument` member, which `get` takes, is refused here — a place
carries no selection between a piece's two cells, and a listing's rows are
reached from the place they were listed at. Nothing moves either way:
listing a child reads it without standing on it, exactly as reading one
does.

A listed target renumbers, as every listing does: `%n` is a reference until
the next listing (decision 17), and the rows a target's listing prints are
the rows the next line's handles name. The alternative is the one thing a
numbered listing may not be — numbers printed beside rows the next command
will not take.

A listing says what it is a listing of wherever its rows are not everything
standing there. `slugs/` is the case that has such a bound: the index names
slugs assigned since it existed, so a slug it never recorded still resolves
and is not listed (`listSlugs`, `packages/piece/src/slugs.ts`), and a listing
that implied completeness would be false.

**Every name a listing prints is one `cd` takes back to that row**, and a row
it has no name for prints none at all. Most rows print their own name,
written as a token by the rule above — a slug, a handle and an ordinary key
each print as themselves. A key is printed as the reference grammar's writer
writes it against the place it was listed at: a key holding the separator
escapes it, `a~1b`, and one the bare form would read as a head is written
behind the `.` head, `./..`, `./.`, and `./` for the empty key. Where one of
shuttle's own readings would take that form — `-` on its own, and a leading
`%`, `#` or `-` — the `.` head goes in front of it as well: `./-`, `./%1`,
`./#tag`, `./-x`. A key opening with `@` is data and prints as itself.

A line opens with the row's handle, in a column the widest of them sets, and
the name comes next. What a reader copies out of the name column is
therefore what `cd` takes, and that is the claim rather than anything about
the whole line: an error written after a name is text the fabric produced,
and an odd quote in it leaves the line as a whole refusing to split. The
handle column is the other half of the same claim — a numbered handle is a
reference too, so both columns of a listed line are things to type.

A piece carries what it calls itself as well, where the read found it a
name, and that is written after the name column rather than in it: it is
what the fabric holds rather than an address, so the name column stays the
one thing on the line a reader copies to reach the row. A piece the read
found no name for shows its handle and nothing else.

A row that is one of the piece's callables is annotated as one, and no other
kind is annotated. That is the promise the facets section makes: a callable
surfaces inline in the listing rather than behind a reserved name. The other
kinds carry the annotation nowhere because it would be on every row and
would say what the next `ls` says anyway — a container lists, and a value
does not.

A row with no name prints a marker in the name column, and says no more than
that: a key no door admits, such as one holding a line break, is reached by no
operand, and a listing prints names rather than routes. Everything on a listed
line that is
not a name is written between angle brackets. A name holding an angle bracket
is printed quoted, the grammar reserving it, so a name column opening with `<`
carries no name — while a marker's own payload is not escaped, those brackets
delimiting for a reader and not for a parser. Nothing parses a listed line.

A row is one line, and the lines are separated by a newline, so a name holding
one is described rather than written.

A name and a message answer a control character differently, and what each is
for is the difference. A **name** holding one is described rather than written,
for the reason the doors refuse one: the marker is the last place such a name
would still be written, and writing it there would put back on the screen what
refusing it kept off. A **message** — a row's error, the bound — is escaped
instead: every character survives and each acted-on one is shown as the Control
Pictures glyph that names it, so the text a person has to read arrives whole
and instructs nothing. The newline is the one exception, and the row rather
than the class is what makes it one: a message is one row, so a newline in it
is written as a space and every other character in the class is glyphed. A name
is typed back and a message is read, which is why one may be replaced by a
description and the other may not.

Nothing else is rewritten. The Unicode line and paragraph separators are
printed as they stand, a terminal acting on neither, because a name is printed
to be typed back and a rewritten one no longer names its row; and an angle
bracket in a message stands too, those delimiting a marker for a reader rather
than for a parser.

Large collections appear everywhere (a space's pieces, an array of
thousands). `ls` prints one height-fit page — what the terminal shows
minus the prompt's own row, and one row less again where the rows do not
all fit, that row going to a status line
(`<389 lines not shown — more continues>`). A page is bounded in *rows*
and composed of lines, and the two are not the same: a line wider than
the terminal wraps onto as many rows as it takes, and that is what it
costs against the bound — a status line that wraps included. `--limit`
overrides the height rather than capping it, since a person who asked for
forty rows on a screen showing twenty asked for forty; it counts rows of
the listing, so neither the bound line nor the status line is one of
them. It never takes the screen over uninvited, so piped
output stays clean by construction. The status
line counts what was held back rather than what the listing holds, which
is what makes the same sentence true on the first page and on every
continuation. `more` continues the same listing and its numbering
(`%39`…`%76`); backward at the prompt is scrollback's job, and real
two-way navigation is `browse`'s.
A `search <query>` verb at any place is designed and deferred past v1
([`futures.md`](futures.md)); pipes over `ls` cover the interim.

The bound a listing carries is shown whatever the page cuts, and opens it:
a listing longer than the screen is cut from the end, so a bound written
last is the first thing a page would drop, and what it says — that these
rows are not everything standing here — is what a reader of a partial
listing most needs.

**A read is bounded the same way.** `get` at a piece root returns
everything the piece computed, which is larger than a screen for the
simplest pattern, so the value is written as one page with the same status
line and `more` continues it. A value has no unit finer than the screen's
own, so it is broken at the width before the page cuts it: one long
string is one line and a screenful of rows, and unbroken there would be
nowhere for the page to cut and nothing for `more` to continue — the status line offering `--select` beside
`more`, the two answering different questions: `more` writes the rest of
what was read, and a projection reads less. And a piece's `$UI` node is
stood in for rather than written out, unless the line named the fields it
wants: it is a vnode tree with data URIs in it, and it is the piece's
picture of itself rather than state an operator debugs at this layer.
`--select '$UI'` names that key and gets what it holds, which is what
keeps the node reachable rather than merely narrower. A `--filter` alone
is not asking — it says which elements come back rather than what each
holds — so it leaves the standing-in where it was.

**`--json` is the machine-readable form, and that reaches past spelling.**
Every bound above rewrites the text: a break inserted at the width is a
character the value did not hold, and inside a JSON string it is not even
legal; a page holds part of a value back; the elision writes a string
where an object was. A program reading the output would have to undo all
three, or could not. So the flag turns them off and hands back the value
whole — no wrapping, no page, no standing-in — which is what
`cf cell get --json` hands back, and what decision 7 means by a data verb
taking `cf`'s read options.

The bound is in *rows*, and a row is what the terminal gives a character
rather than what a character count says: a double-width character takes
two columns, so a line of them is twice the rows a count of characters
would predict. Measuring the count would undercount, and undercounting is
the direction that overflows. Nothing `ls` or `get` writes exceeds the
screen without saying so — and where one row is taller than the whole
page, it is shown whole, because a truncated name is not one `cd` takes
back, and the status line says the page ran over.

Listings number their rows, and numbered handles are references: `%1`,
`%2`, … stay valid until the next new listing resets them (`more`
continues the current one), so `cd %3` and `get %1/title` act on what a
view showed without retyping anything. Handles are how a view feeds the
next command without the view being a place; an interactive picker can
layer on later and produce the same handles.

A handle carries structure rather than a string. The listing records each
row's kind as it mints one — container, value, callable, piece or slug —
and for a callable row the receiver and the verb name it stands for, which
is the place the listing was read at paired with the row's own name. That
is what lets `call %4` invoke without a hand-split reference, and lets
arity resolve locally (the "Calling a verb" section below).

A link is not one of those kinds, and its absence is a fact about the read
rather than a gap in the vocabulary: a cell read resolves a link on the way
past, so what a listing is handed at a position holding one is what it
points at. Marking such a row is the open question
[`pathref.md`](pathref.md) leaves for `ls`, and answering it means a read
that stops before a crossing rather than another kind.

**A view is not necessarily a place.** A page of results, a search hit
list, a filtered projection — these are things to look at and pick from,
and they need no path-shaped address of their own. Requiring every viewable
thing to be a place would constrain the interface for no gain. When a
derived set earns an address, that is the virtual-places extension the main
document holds open — the abstraction allows it; nothing requires it.

## Run state

Reaching in warms: `cd` into a piece, `watch` on anything inside it, or
any read aimed into it — `get topics/3/title` from the space root warms
`topics/3` exactly as `cd` would — starts the pattern in this process, and
reads are live from then on. A piece is cold only while it is merely
listed, so there is no unlabeled stored-state read path.

That is v1's whole run-state story. A **cold-browse mode** — walking with
no computation, stored reads labeled — is designed and deferred past v1
([`futures.md`](futures.md)).

## Scope is the cwd's second dimension

A cell can carry per-identity overlays — `@user`, `@session` — so the same
piece reads differently per identity (`cf inspect scopes <space>` shows that
ground truth offline). A scope applies at every place rather than nesting
inside one, so the cwd is a **pair**: position and scope. Both stick while
you navigate, both render in the prompt, and `pwd` prints both — and each
decides which cell the pair names, one id under two scopes being two
documents.

`cd` is the door to both dimensions, applying whatever components its
operand carries: `cd board@session` is a full reference and moves position
and scope in one step, `cd topics/3` moves position alone, and
`cd .@session` moves scope alone. There is no separate scope verb; the
general door is `where scope …`, like any other ambient dimension. The
active scope fills the omitted qualifier of every reference as the place
fills omitted position levels, and an explicit one on an operand overrides
it for that operand alone.

A scope on its own is written `.@scope`, which is the reference grammar's
own relative spelling rather than a navigation word of shuttle's: `.` is
the context's own cell, and the head of a relative reference is where that
reference takes a member or a qualifier
([`cell-reference-grammar.md`](../../specs/cell-reference-grammar.md), D1) —
`.#argument` the member, `.@user` the qualifier. The head is read before the
path, so it governs the rest rather than standing as a segment. So `@`
carries one meaning, a qualifier on the piece, and is an ordinary character
everywhere else — `cd @session` reaches a key called `@session`, and
`cd ./items@user` a key called `items@user`, the `@` there sitting on `items`
rather than on the head.

That the bare word is data is what the reading costs and what it buys. A
key named for a scope word was unreachable while the bare form was
navigation, and is reachable now; in exchange a person who types
`cd @session` meaning the scope is told so, the refusal naming `.@session`
where the operand named no key and the word is a scope word. The offer is
a hint on a refusal and never a reading: a place that holds the key lands
on it and says nothing.

Shuttle reads the spelling through the reference grammar's own reader,
`parseRelativeReference`, rather than a copy of it, so a head means here what
it means to every other reader of that grammar.

The canonical grammar bounds what a qualifier on a reference can say
(`parsePieceSegment` and `parseRelativeReference` in
`packages/runner/src/cell-reference.ts`):

- The scope qualifier is a scope word — `@space`, `@user`, `@session`, and
  `@inherit` — with no identity component; identities are never spelled in a
  reference. `@session` and `@user` therefore mean the **reading identity's
  own** overlays, composed with the caller's identity at resolution, and
  `@inherit` means the context's scope, which for shuttle is the place's own.
  A word outside those is refused in the reader's own sentence.
- `@space` is a canonical scope value, not shuttle's addition: the reader
  takes it beside the others, its refusal names all four, and
  `piece1@space/path` parses to `scope: "space"` distinct from an omitted
  qualifier (`packages/cli/test/piece.test.ts`). The base is therefore
  nameable, and `cd .@space` sets the ambient scope back to it.
- The grammar registers `@pin=` besides, a version of a piece. A place holds
  no pin, so shuttle refuses one on a head and on a piece segment it reads.
- The shared renderer writes `@space` when it is handed the empty context,
  which has no scope to leave the base to, so `pwd` writes the scope through
  it; the prompt writes the scope after the position itself.
- Standing in **another** identity's overlay (an `@session:<sid>`-shaped
  spelling) is not in the grammar and is out of v1. It is a
  canonical-grammar extension first — "the alias must not grow a
  capability the canonical form lacks" (`packages/cli/lib/llm-friendly-ref.ts`)
  — and a permission question besides; `cf inspect scopes <space>` remains the
  offline way to see other identities' overlays.

## The ambient context and `where`

Everything ambient is one record: the connection (api endpoint, identity),
the cwd pair (position, scope), the external working location, and the
invocation session. `where` prints the whole record, and
`where <dimension> <value>` sets the light dimensions — scope, the
external location. The heavyweight dimensions are fixed at launch in v1
and restarting is the switch; editing them live (`where api …`,
`where identity …`, rebuilding the connection) is designed and deferred
([`futures.md`](futures.md)). `cd`/`pwd` and `xcd`/`xpwd` are conveniences
over the hottest dimensions, not separate mechanisms, and launch flags
merely seed the initial record.

## Prompt

The prompt shows the position with checked names only: a space by the name
fabric knows it by, a piece by its slug when the slug index confirms it,
the whole handle otherwise, then the path. Shuttle uses the naming
mechanisms the fabric supports and introduces none of its own; user-managed
legible space names arrive when the fabric grows them.

The space is the only thing the prompt shortens, and a handle prints whole.
A prefix of one is spelled exactly as a whole handle is, so nothing in it
says which it is, and what a reader copies off the screen would look like
an address and name nothing — the same silent wrongness the reserved facet
names above are there to end. A prefix is also only useful where it is
unique, and knowing that is knowing every other handle in the space: an
index read, on every line the prompt draws. The name beside a handle costs
no such read, being the one the `cd` that adopted the place confirmed, and
the handle costs none at all.

`pwd` is the complete address and has no short form. It writes the scope
even when it is the base, so what it prints denotes one cell wherever it is
read, where an omitted qualifier would denote whatever the reader's own scope
selects — shuttle writes absolutely and reads ambiently, the asymmetry a
shell has between `pwd` and a relative path. Emitting the qualifier only for
a non-base scope would leave the common case contextual, since an
unqualified
address read in a `@session` shuttle lands at session. The prompt is the
short surface and is on screen continuously; what `pwd` is for is the thing
you copy, so a form that cannot be pasted is the one output it should not
produce.

## Recall and completion

`up` and `down` walk the lines this run typed. What they walk is those lines
and the line being typed — one position each, the line being typed last — so
an edit made at any of them is held there until the line is ended, and
everything that ends a line ends the traversal with it: running the line, and
`ctrl-c`. There is no wrap: `up` at the oldest line and `down` at the line
being typed each leave the prompt as it is. A line with nothing on it is not
recorded, nor is one identical to the line recorded last, and the comparison is
against that one line alone — comparing against every line would drop a line
from the middle of the run and leave the order no longer the order it was
typed in. What is recorded is the line exactly as it was typed, at the moment
it is taken rather than when it settles, so `up` reaches a line that is still
running. The recall is the run's own memory; persistent history is a separate
feature ([`futures.md`](futures.md)).

`tab` completes the token the line ends in, and it completes that token only:
with the cursor anywhere else on the line it does nothing, the token being
finished being the one the line ends with. What may stand there is asked of
the dispatch — the first token names a verb, and after a verb it is whatever
that verb declares its next operand completes, which is a verb name for
`help`, a reference for `cd` and `get`, and nothing for a verb whose operands
are already given or which takes none. So a completion never offers a token
the line would then refuse.

**What a completion writes is a token that reaches what it names.** The
candidates under a place are the operands `cd` takes to the rows `ls` lists,
which is the same answer the listing prints in its name column: a name whose
own characters are readings comes back as the operand that names it, and a
name needing quotes comes back quoted. A row nothing names is not offered,
which is the same shape as a listing printing a marker where a row has no
operand.

Three bounds, each of them a decision:

- **A common prefix shorter than a whole candidate is written only where it is
  bare.** Several candidates agreeing on `my ` agree on a partial that is not
  a token — a quote around it closes where the person's next character has to
  land, and no quote leaves the split refusing the line — so what is written
  in that case is nothing, and typing on reaches the same candidates again.
- **A completion is written onto the line it was computed for and onto no
  other.** A read already sent cannot be called off, so its answer may come
  back to a line a key has changed or a `ctrl-c` has emptied, and writing
  there would take back a character the person typed after the `tab`.
- **A read that failed offers nothing.** A `tab` is not a request for an
  answer about the fabric, so where `ls` reports a failed read as the failure
  it is, a completion writes nothing and says nothing. That is what
  `packages/cli`'s own completion does, and the one thing shuttle's takes
  from it.

The token being completed is the last one the split reads, off the same scan
the split itself runs. A separator inside quotes or behind a backslash is a
character of its token, so the run of characters after the last separator is
not the token: on `get --select a\ sl` it is `sl`, where the token is the
option's value `a sl` — and a completion working from the run would offer an
operand where the line has none and rewrite the value to reach it. The one
line not completed is one the split refuses: both its refusals are a token
with no end, and where the token being typed opens is exactly what such a
line does not yet say.

Nothing gates a candidate on its shape. What bounds a completion is which
candidates there are — the operands reaching what stands where shuttle stands
— so a prefix is completed exactly where it opens one of those. Two things
follow, and the second is the first read the other way round. An operand
carrying the separator is completed like any other, which is what reaches a
row whose own operand carries one: standing at a piece, `./.` completes to
`./..`, since that *is* the operand `operandForChild` offers for a key called
`..`. And `cd slugs/bo` at a space root
completes nothing — not because a rule turns it down, but because no row
standing at the root is called that; the row it names stands inside `slugs/`,
and reaching it is a read of a place the line has not moved to.

## Writes

- `set <path> <value>` — the value parses as JSON; a bare word is a string
  where that is unambiguous, and a value holding whitespace is quoted, being
  one token like any other operand. A token opening the way JSON opens a value
  and then failing to parse is refused with the parser's own reason rather
  than written as the string it spells.
- **`set <path> -` is refused rather than read.** Standard input is the
  keyboard the prompt reads its keys off, and two readers of one keyboard
  would each take some of the keys and neither would see them all — a read
  that never reaches end of input wedges the shell rather than failing. A call
  reaches that same stream by more spellings than a refusal over the line
  could enumerate, so the reader is substituted instead, which closes the set
  by construction. Reading a local file is the externals milestone's `<`, and
  is spelled `file:`.
- `edit <path>` — opens `$EDITOR` on the current value and writes back what
  was saved. The value goes out as JSON and comes back as JSON, so what is
  edited is what a write takes rather than what `get` prints. A value JSON
  cannot carry is refused before the editor opens: a cell holds an explicit
  `undefined`, an array hole, a symbol and a `bigint`, and a round trip
  through JSON would write a value the person never typed and report it as a
  success. It is the one write with no `cf` equivalent behind it, and the
  terminal's raw mode comes off around the editor and goes back on after.
- `link <target> <path>` — writes a cell reference, the fabric's link
  semantics (what FUSE spells `ln -s`). A redirect copies values; `link`
  is the only spelling that creates references, so the distinction is
  always visible on the line.

## Calling a verb

Three spellings, and no fourth:

- `call <ref> <name> [input]` — the typed form, matching `cf`'s
  (`call topics/3 add-reply '{"body":"hi"}'`), so knowledge transfers both
  ways. The input positional takes an inline JSON value or `-` to read the
  payload from stdin. The verb name opens the callable's section, so its
  schema-derived flags follow bare — `call topics/3 search --query milk` —
  and `--` closes the section. That is
  [`../cli-surface-shape.md`](../cli-surface-shape.md) step 10's form, which
  `cf` speaks as well, so the two surfaces read one grammar rather than two.
- `call <piece-handle> <name> [input]` — a piece handle stands wherever a
  typed reference stands, so this is the typed form with the receiver
  already in hand: `call %3 add-reply --body "shipped"` off a listing
  whose rows are pieces.
- `call <callable-handle> [input…]` — `call %4`, where the listing minted
  `%4` from a callable row. That handle carries receiver *and* name, so
  the name is not spelled again.

A typed path ending in a callable — `call topics/3/add-reply` — is
refused, and the error names the `<ref> <name>` form to use instead.

All three land on the resolution that exists. `resolvePieceCallable`
(`packages/cli/lib/piece.ts`) takes a receiver and a callable *name*,
resolving it against the piece's result cell, then its input cell, then
its handlers. A handle that carries the name rather than a path is what
keeps every form on that one resolution, so none of them needs a
full-path callable resolver built first.

One arity rule covers all three, and it never consults the fabric. The
typed form has a fixed shape — reference, name, optional input — and a
handle's kind is fixed when the listing mints it: a piece handle takes the
verb name in the next positional, a callable handle takes input. So
whether a positional is a name or a payload is known from the line and the
handle table alone, and nothing about parsing waits on what a reference
turns out to resolve to.

The split is the one the fabric already draws. A verb name is interface
vocabulary, not a data path — the receiver is the addressable thing, and
the name selects from what its interface offers. Keeping receiver and name
in separate slots keeps that visible on every line.

## Redirection and schemes

The ambient data plane is the fabric: redirection targets fabric paths, and
anything outside the fabric is named by an explicit scheme.

- Fabric-to-fabric redirection — `get topics/3 > drafts/copy` as a value
  copy, `link` remaining the reference-writer — is designed and deferred
  past v1 ([`futures.md`](futures.md)); the plane rules below are settled
  v1 grammar either way.
- `file:` names a local file, the only spelling that touches disk — and a
  scheme is legal only on an absolute complete path:
  `get topics --json > file:/tmp/topics.json` is fine, `file:out.json` is
  refused (`file:~/…` counts as absolute).
- `file:` is one member of an open scheme family: a schemed operand names
  something outside the fabric. `file:` is the v1 member; `https:` read
  ends are designed and deferred ([`futures.md`](futures.md)), and writing
  to an external scheme stays out of scope until a use rules it in.
- Shuttle maintains two working positions: the fabric cwd and one
  **external working location**. `xcd` sets it — `xcd file:~/data`,
  `xcd https://foo.com/a/b/` — and, its argument being already on the
  external plane, moves it with a plain relative path: `xcd ../foo`. It
  writes where it landed, where `cd` writes nothing: the prompt carries the
  place and carries nothing about this position, so a move nothing reports is
  one a person has to ask about. `xpwd` prints it. In operands, a relative external path is rooted with
  the `x:` base — `> x:../out.json`, `< x:data.json`. `x:` is a base name
  rather than a scheme: it roots a relative path at the external location
  whatever that location's scheme, so no operand ever changes plane by
  position. A bare relative operand is always fabric.

## Pipes: escaped locals

Local programs run behind the explicit escape — `|!` in a pipeline
(`get topics --json |! jq '.[].title'`), line-initial `!` for a whole
command — so stepping outside the portable surface is always visible on
the line. Bare `|` is reserved, and its error names `|!`: the **native
tool set** — names that work bare and are guaranteed wherever shuttle
runs — is designed and deferred past v1 ([`futures.md`](futures.md)),
and reserving the spelling now means v1 teaches no invisible-local habit
the set would have to unteach.

## Open questions

**Appending to a collection.** Shuttle's write vocabulary is whole-value:
`set` writes a value, `edit` writes back the one it opened, and `link`
writes a reference. The fabric below has more than that — operation-based
append, add-unique, increment and remove-by-value, covered in
[`mergeable-collection-writes`](../../features/mergeable-collection-writes.md)
and registered by
[`patch-operations.md`](../../features/patch-operations.md) — and no shuttle
spelling reaches any of them. Adding one item to a collection is therefore
`get`, edit, `set`: the read-modify-write those operations were made
first-class to avoid.

The base-overlay spelling is settled above, and so is what the prompt shows
where no slug is confirmed: the whole handle, for the reasons the Prompt
section carries. One further open item for shuttle overall (shallow-sink
expressibility) lives in [`views.md`](views.md).
