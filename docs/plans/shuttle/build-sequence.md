# Shuttle — build sequence

Satellite of [`README.md`](README.md): the order of construction,
as small landable pull requests. Stage A is seam work inside `packages/cli`
— each PR stands on its own merits there, shuttle or no shuttle, because a
seam that lets a sibling inject a connection is the same seam that lets a
unit test run the action body (the documented rationale of the
`*FromCommand` family). Stage B is the shell itself, in vertical slices,
under `packages/cli/lib/shuttle/`. A-PRs go first in line because they gate
everything and review latency is the scarce resource; B milestones start as
soon as their named prerequisites land.

## Stage A — seams in `packages/cli`

**A1 — the library seams a place reads through.** Done (#6626). Each is
reachable on its own, without the module that builds the command tree:
`lib/piece`, `commands/piece`, `lib/wish`, `lib/piece-render`, and
`lib/llm-friendly-ref`, which a place reads every reference operand through.
The completion listing is the one that took work: `listCellKeys`
(`packages/cli/lib/cell-listing.ts`) sits behind a `PieceResolutionDeps` seam
with `keysOf` beside it, and the providers are designed to fail silently and
empty — right for tab completion, wrong for `ls` — so the listing raises its
errors and completion's provider dispatch swallows them at its own call site.
The shell reads four of them — `lib/piece`, `lib/wish`,
`lib/llm-friendly-ref` and `lib/cell-listing` — with `lib/cell-selection`
beside them and `commands/piece` read by the command rather than by a place;
`lib/piece-render` waits for the milestone that renders a piece. Each is
reached by relative path, the view substrate with them: the shell is this
package's own code, so `packages/cli/deno.jsonc` carries `.` alone, under the
rule the map states.

**A2 — connection injection for the write path.** Done (#6646). The write
path takes the connection as a parameter, so a held `PiecesController`
serves every call rather than each opening a runtime, a storage manager,
and a socket of its own: `setCellValue`, `removePiece`, `linkPieces`,
`renderPiece`, `callPieceHandler`, and `getPieceView` in `lib/piece.ts`
and `lib/piece-render.ts`, plus the `lib/acl.ts` loaders, beside
`stepPiece`, whose seam (#6556) the rest are modeled on. `withAcl`
disposes only a runtime it opened itself, so an ACL call over a held
connection leaves it open. Each carries the unit test the seam makes
possible — a controller stub driving the function's body against a doubled
piece, with no socket and no server behind it — which is the PR's
standalone value.

**A3 — extract `callFromCommand`.** Done (#6682). `call` carries the
named-export shape its siblings have: the mount's spelling and the two
arrays Cliffy splits the argv into — this command's own arguments, the
line past `cf piece call`, which a grammar refusal reprints, and the words past
`--`, which the read step parses — are parameters beside the options and
the positionals, so nothing under the action line needs the binding. The
dispatch and the `render`/`hint` sinks ride a deps bag, which holds
collaborators and no data. Its unit tests drive the whole action over a
stub dispatcher and reach the success tail, which is what the extraction
is worth in coverage: seven lines of `commands/piece.ts`, measured, and no
other tracked file moves. The package's coverage shadow is real and lies
elsewhere — it opens inside the chained `piece` command expression, around
its first inline action, and `buildCallCommand` is a standalone function
well before it.

**A4 — exit and output seams audit.** Done (#6704). `exitWithDataError` and
`exitPieceCallFailure` default to `Deno.exit(1)` and take a `deps`
override in its place, each with an `exit` typed `never` beside the sinks
its own report needs — `printError` and `printHint` for the data error,
`printError` and `render` for the call failure, whose expiry writes
Invocation JSON to the machine surface. Each seam that reports through one
forwards the caller's own:
`getCellValueFromCommand`, and `callFromCommand` at each of its three
exits, the payload rejection reported from inside the dispatch's promise
chain included. An `exit` typed `never` throws rather than returning, so
that rejection's throw lands in the action's own catch;
`callFromCommand` records that an exit ran and rethrows, rather than
describing the shell's exit as a second failure of the call.
`describePieceFromCommand` takes `render`/`hint` beside them, so its page
and next steps land where the caller puts them, and the confirmation
`cf piece call` puts on stderr for a JSON payload — so that stdout stays the
machine surface — rides the caller's `printError` rather than the
process's. `announce` beside those carries what a call publishes in
flight — the invocation pair, and the spans under `--verbose` — which
raw stderr serves for a one-shot command and corrupts for a caller
drawing its own screen. The bulk seams — survey, repair, retarget,
`setsrc --check` — are on no v1 verb's path and keep the exits they have.
Each threaded seam carries the test the override makes possible: an
injected exit that throws, and the report read back as a value.

**A5 — module-global state.** Done (#6717), as the recorded limit rather
than as scoping: **shuttle v1 holds one connection per process**, revisited
when
multiple places arrive ([`futures.md`](futures.md) candidate 3). What the
limit covers is `quietMode` (`commands/piece.ts`), the process's hint
posture; `receipted` (`lib/write-receipt.ts`), which memoizes the write
receipt for the life of the process; and a connection's own settings —
the LLM endpoint, the base URL a pattern's relative `fetch` resolves
against, and the ambient experimental flags a `Runtime` applies — which
land in globals under `packages/llm` and `packages/runner` that no
connection owns. Part of that is mechanically enforced and the rest is
prose: `claimProcessDeployment` (`lib/process-deployment.ts`) refuses a
connection to a second *deployment*, a weaker bound than the limit and
the one where those settings actually fight, since a verb reaching an
un-injected library function opens another connection to the same
deployment as a matter of course. The three declarations that name the
limit are all in `packages/cli`; the inventory, both bounds, and the
globals in the other two packages, recorded there and nowhere else, are
in item 6 of [`runtime-integration.md`](runtime-integration.md).

## Stage B — the shell itself

**B0 — scaffold** (after A1). Done (#6741). The shell needs no
configuration of its own. It sits under `packages/cli/lib/shuttle/`, so
`deno task check` reaches it through that package's path entry, its tests run
under that package's runner, and its uncovered lines land in that package's
coverage group. What a package of its own would have needed — a path in the
root `deno.jsonc` workspace array, and a `tasks.test` entry in its own, without
which a `deno task test` run there resolves the root workspace task instead and
re-runs the whole suite inside itself — `cli` has already.

**B1 — walking skeleton** (after A1; A2 for nothing yet). Landing in
slices, and open until the last of them lands. Each slice moves what it
built into the first list.

Landed:

- **B1a — the place value and its owner module**
  (`packages/cli/lib/shuttle/place.ts`). The whole pair, position *and* scope,
  because scope is half of what a place is (decision 20): `cd` over relative
  references read by the shared reader — a `.` or `..` head with its member
  and qualifier, and a literal path — `-`, `/`, and rooted and complete
  references; the `slugs/` and `pieces/` facets a space root reserves, and
  nothing else there; the rendering `pwd` prints of both halves, the position
  line carrying the scope so that it denotes one cell wherever it is read; and
  the refusals — a move selecting the `#argument` member, a member that is
  not one on a piece segment, a part no rendering would name back, and a move
  into a space other
  than the connected one, which is the gate a home-anchored entry point meets
  once resolution hands it a space. Two operands come back for the connection
  rather than moving: a `#name` wish target, which B1b resolves, and a
  reference naming its space by name, which is a two-step protocol — the
  caller resolves the name and hands the move back with the space it resolved
  to, and the place is landed or refused there.
- **B1b (slice 1) — the held connection**
  (`packages/cli/lib/shuttle/connection.ts`). One `PiecesController` for the
  process, opened on the first ask and served to every ask after, where `cf`
  builds one per invocation. The connection half of the ambient record maps
  onto `SpaceConfig` and is handed to `loadPieces`, so shuttle reaches the
  connect sequence and none of the flag parsing in front of it. The memo is
  cf-harness's: a rejected construction is not held, so the next ask opens
  again rather than replaying a terminal failure, which covers the connection
  that never opened and says nothing about one that later drops. Ownership is
  named by the source rather than inferred from an overridden collaborator —
  a connection opened here is closed here, one handed over is left to whoever
  opened it — so either can be driven with no socket behind it. A close that
  fails is terminal: the disposal stays rejected and the holder serves nothing
  after it, which is what a disposal that is process shutdown wants. A
  `disconnect` verb makes a run carry on past one, and then a single transient
  teardown error kills the holder for the rest of the run — so that verb
  revisits this trade rather than inheriting it. No verb reaches the
  connection yet, and the place is untouched.

- **B1b (slice 2) — the line grammar** (`packages/cli/lib/shuttle/line.ts`). How
  a line becomes tokens, and how a value prints as one of them. `cf` is
  handed words the operating system's shell already split; shuttle is handed
  the line, and both halves are its own. The split is POSIX quoting —
  whitespace separates, single quotes are literal, double quotes group, a
  backslash escapes one character and between double quotes only a quote or
  another backslash, and runs that touch are one token — and a line is
  refused for one of two reasons: a quote that never closes, naming the
  column it opened at, and a trailing backslash with nothing to escape.
  The printer quotes only where quoting is needed, which is what keeps a
  slug, a handle, a flag and a path each printing as themselves; what forces
  it is whitespace, either quote, the backslash, and the characters the
  grammar spends on structure, collected in one constant rather than counted
  in prose. The characters an operand writes an address with stay out of that
  set: what the pair guarantees is that a printed value splits back into that
  one value, and a quote reaches no further than that. No verb reads a line
  yet.

- **B1b (slice 3) — `ls`, and the vocabulary a segment speaks**
  (`packages/cli/lib/shuttle/listing.ts`). What stands at a place — a space root's
  facets, the slugs the index records, the space's pieces, the keys directly
  under the cell a place names — read over the held connection through
  `listSpaceSlugs`, `listPieces` and a cell read named through `keysOf`, each
  of which takes that connection as `deps.loadPieces`. A row that failed on its own account is
  still a row and carries what went wrong; a read that failed outright raises.
  `slugs/` says what it is a listing of. Its index records the names assigned
  since it existed, which is not the set of slugs that resolve: one assigned
  before the index is not listed, and one that is listed may no longer resolve,
  nothing removing an entry once made. So `ls slugs/` does not enumerate what
  resolves, and a row carries its own error where the name it lists reaches
  nothing. A slug stands in a place unresolved and the read resolves
  it the way `--cell` does, which is what makes a slug typed back off a listing
  reach its piece.

  The slice settles the two questions held for it, both of them recorded in
  [`grammar.md`](grammar.md). A quote reaches no reading, so a name whose own
  characters are readings prints as the operand that reaches it — behind the
  `.` head, or with its separator escaped — rather than as a quoted spelling
  of itself — which is what makes every name a listing
  prints one `cd` takes back to that row, and leaves the split returning plain
  strings. And every door holds a piece to the slug and handle vocabularies,
  `validatePieceSegment` being called rather than copied, so a walk, a resolved
  target and a settled move hold a piece to what a reference holds one to, and
  give its reason. What the first ruling costs is one shape: a key whose first
  character is `#` is not reached by its name on its own, which is a wish
  target, so a listing prints it behind the `.` head, `./#tag`;
  [`grammar.md`](grammar.md) carries the ruling. Which keys are spelled through
  which door is pinned case by case in
  `packages/cli/test/shuttle-place.test.ts`, so the record moves when the
  behavior does and not otherwise.

- **B1b (slice 4) — the verbs** (`packages/cli/lib/shuttle/verbs.ts`). A line
  splits, its first token names a verb, and the tokens after it are that
  verb's operands: `cd`, `ls`, `pwd`, `get` and `wish`, over the one held
  connection and over the listing above. Nothing writes. A verb returns what
  it did — a place that moved, text shuttle wrote, a value the fabric holds,
  or a refusal carrying its reason — so where any of it lands is the prompt's
  decision, and every case drives the whole surface with no terminal behind
  it. A read that failed is the one thing that is not an outcome: it raises,
  so a server that cannot be reached is told apart from a line that was
  wrong.

  The slice settles the two `Move` arms B1a left for the connection. A
  `#name` target resolves through `readWish` asked for the target's
  *address* rather than its value, which is what `--select` spells `@`: the
  space a target resolved in rides in the answer, so a home-anchored one is
  refused with the reason decision 5 gives and nothing has to know which
  targets are anchored where. A space written as a name is held against the name
  the connection was opened under (`PiecesController.getSpaceName`). One
  connection serves one space, so all such a reference can want to know is
  whether it names this one, and the recorded name answers that — the
  comparison being exact is not an approximation of the key derivation but its
  own answer, since a named space's key hangs off the name's bytes and the
  reference reader reads the space slot as written, the grammar admitting no
  separator in a space name. A session opened by a DID recorded no name and is
  refused, which is the honest arm rather than an error path: whether a name
  denotes that space is exactly what it cannot say, and the refusal names
  starting against that name as what would. What `cd` asks a wish through is
  `--select`'s own parser (`lib/cell-selection.ts`), read by relative path as
  every seam here is.

  `get`'s operand goes through the door `cd`'s goes through *plus the
  `#argument` member that door turns down*, read from where shuttle stands
  rather than from a standing built for the occasion, which is what makes the
  two agree about `..`. `CurrentPlace.aim` is that door and
  `CurrentPlace.resolveNamedSpace` the settling twin beside it. A place is
  result-rooted and cannot stand in an arguments cell, which is why `cd`
  refuses the member in every spelling; reading one is a different act, and
  `get .#argument/title` is how an operand asks for it.

  The one spelling `get` does not take is a `#name` target: `cf cell get`
  takes none and `cf wish` does, and a data verb here means what it means
  there. The two `#` readings pull opposite ways for a reason that is not
  arbitrary — the member says which of a piece's two cells to read and its
  piece is reachable either way, so refusing it would put a cell out of reach,
  while a `#name` is a whole target with a verb of its own that answers a
  second way as well as a second time, so taking it would put a second answer
  in reach.

- **B1c — the prompt, `where`, and the launcher.** A line read off a terminal,
  handed to the dispatch above, and its outcome written where B1f put it.
  Where a run's output comes from is one place: a verb returns what it did
  rather than writing it, so everything a line puts on screen passes through
  the prompt in the order the person caused it, and a case drives the whole
  loop with a scripted key stream and reads back what it produced. A refusal
  and a read that failed both land there as text and the loop reads the next
  line — what the seam's distinction buys here is that a shell whose server
  went away is still a shell.

  The line editor is the view substrate's rather than `node:readline`'s.
  `EditBuffer` holds the motions and `decodeKeys` supplies the key stream a
  binding table reads, so the bindings are a value with room for a second table
  beside it — which is what keeps modal editing an option
  ([`futures.md`](futures.md)). `node:readline` has no supported place for a
  second table: its exported surface is an interface, three cursor helpers and
  a keypress decoder, and that interface's prototype carries one public method,
  `question()` — everything else on it, the key dispatch `_ttyWrite` among
  them, is underscore-prefixed.
  What is exported and would have helped — the keypress decoder — is the job
  `decodeKeys` already does, so the interface is the part that cannot be
  reused and the decoder is the part there is no need to.

  `where` prints the whole ambient record, and so chooses the format `pwd`
  prints two dimensions of: one dimension to a line, its name in a column of
  fixed width, and the width exported so a caller reading a value back slices
  it rather than spelling the label again. Each dimension is named by whatever
  owns it — the connection's three by the connection, the place's two by the
  place — and `where` reads nothing, so it still prints for a shuttle whose
  connection will not open.

  The prompt carries the place short, and the only shortening it does is
  leaving the space out: one connection serves one space, so that part is the
  same on every line of a run and `where` prints it. Nothing else is
  abbreviated. A piece with no checked name prints its handle whole, which is
  decision 13's rule and not a gap in it: a prefix is spelled exactly as a
  whole handle is, so it would read as an address and name nothing, and a
  prefix worth printing is a unique one, which is an index read per line.

  The launcher is decision 19's pair. `cf sh` is a command in the `cf`
  tree, with the three flags every command taking a space and an identity
  declares, read once by `parseSpaceOptions` and handed on as a settled
  connection; its action imports what it runs, the shell being this package's
  own code. `bin/cfsh` forwards to `cf sh` and carries no checkout logic
  of its own.

- **B1d — the option grammar, and `help`**
  (`packages/cli/lib/shuttle/options.ts`). What a token after the verb is for.
  The split says where a token ends; this says whether it is an option or an
  operand, and the rule is POSIX's: a token opening with `-` is an option up to
  a bare `--`, `-` on its own is an operand — the previous place and the stdin
  sentinel — and every token after the `--` is an operand whatever it opens
  with. The parse is `cf`'s own: `parseFlags` is what `Command` reads a `cf`
  line's flags through and it takes a bare token array, so a verb mirroring a
  `cf` command spells and refuses a flag as that command does rather than in a
  second dialect that has to be kept in step with one — with the two section
  commands as the bound, `cf piece call` and `cf exec` declaring `stopEarly()`,
  so a verb mirroring either carries the call section
  ([`grammar.md`](grammar.md)) rather than this rule. Arity is the same
  reading's: an entry declares both bounds, and the noun phrase its refusal
  calls a missing operand by, so the count is applied in one place while each
  verb keeps its own sentence. A verb that reads a meaning into having no
  operand declares that instead — `get` reads where it stands and `help` lists
  the verbs — which is what tells a default apart from too few.

  `--help` is the option the reading puts in front of whatever a verb declared,
  so no verb can be without one, and it carries the declaration `cf` gives its
  own — standalone, so a verb whose required options a line has not supplied
  still answers what it takes. `help` is the verb beside it. The list and the
  page read the same strings, which sit in the dispatch table beside what
  running each verb does, so a verb added is a verb `help` lists. Decision 3
  names help as part of what serves the audience it puts second, and a shell
  whose only account of itself is the refusal a mistyped word gets serves
  nobody who does not already know it.

  What the rule costs is one shape, recorded in [`grammar.md`](grammar.md)
  beside the readings it joins: a key whose name opens with `-` is not reached
  by that name standing alone, so a listing prints it behind the `.` head,
  `./-x`, as it does for a key called `..`. The typed spelling stays open —
  `cd -- -x` reaches such a key — and what a listing owes is the name rather
  than the route. `operandForChild` asks the option grammar rather than making
  the move, that reading being one layer above a place.

- **B1e — `cd` settles against the fabric, and the place holds the piece.**
  A shell's `cd` is the one verb whose success means something, so a move
  that reaches a piece comes back from `place.ts` pending and `verbs.ts`
  reads before the place is adopted: the slug resolved through
  `resolvePieceReference`, which is the resolution a read makes and given the
  same path, so a slug naming a collection reaches its member and `cd` cannot
  refuse a reference `get` accepts; the handle looked up through
  `entityIdExists` — the
  space's own identifier index, which a value read cannot stand in for, an
  absent piece reading as nothing and an empty one reading the same — and the
  path found by one read of the level already stood at, walked segment by
  segment. None of the three is asked where there is no question. A move that
  spells the piece already stood on, at the scope it was settled at, resolves
  and looks up nothing, that piece having come through a settle of its own —
  and what the skip rests on is a projection the compiler closes, so a field
  added to a position cannot widen the decision without widening the key; a slug needs no lookup, its
  resolution having reached the document; and a move that adds no segment to a
  level already confirmed reads nothing. What the settle costs is one identifier
  lookup on a `cd` onto a piece named by handle, on top of the path read, and
  nothing on any other move. The refusal a path that is not there gets is
  shuttle's own and carries the keys that are — the runtime's
  `Available keys:` hint said in the shell's words, at the command that was
  wrong rather than at the next one. It is the two-step protocol B1a left for
  a `#name` target and a space written as a name, with a third spelling on
  it; the recursion is two deep at most, since a settled space-named move is
  a place standing on a piece and a confirmed piece lands or refuses.

  The place holds the piece the slug resolved to, and the slug stands beside
  it as the name. A slug is a redirect, so a place holding one moves when the
  index is repointed and B2's `set` writes where it points now; a place
  holding the piece cannot move, and `samePosition` compares pieces, so two
  arrivals at one cell are one position as [`grammar.md`](grammar.md)
  promises. The name is decision 13's checked name: the prompt shows it
  because a read confirmed it, and `pwd` prints the piece — a resolution
  answers with a piece's own id, which is the form `namesResolvedParts` takes
  for a durable link. `enter` is the one door
  that lands a piece without a read, the fabric having resolved the target
  already, and it refuses an address naming its piece by slug so that the
  place holds a piece whichever door reached it.

  The facet names are reserved in a rooted reference too, so `/slugs/todo`
  is the walk `cd /` and `cd slugs/todo` make. Decision 11 and
  [`grammar.md`](grammar.md) carry the rule and what it costs. It closes the
  gap the short form left open: the prompt writes a facet as `/slugs/`, and
  the claim that the leading separator reads as the walk down from the root
  was one only the rule makes true. The rooted spelling is the canonical
  reference grammar rather than shuttle's, and it resolves a piece by slug,
  so the reservation is a divergence from what `cf` reads — at two slug
  values and no others. Issue
  [#6992](https://github.com/commonfabric/labs/issues/6992) retires it by
  refusing those two as slugs at `set-slug`.

  `get` settles nothing, and that is the same asymmetry `#argument` has.
  `CurrentPlace.aim` and `CurrentPlace.resolveNamedSpace` answer where an
  operand points, so neither hands back a pending move: a `cd` waits because
  the prompt would go on promising the place, and a read of a cell that is
  not there fails on its own account and in its own words.

- **B1f — the prompt is an event loop, and the out-of-band line.** The keys
  are read continuously and a running line is a task beside them, so a line
  waiting on a server holds up neither the keyboard nor the screen. `ctrl-c`
  reaches a line in flight: an `AbortSignal` rides the deps bag the verbs
  already read their collaborators through, checked at each boundary between
  a verb's phases. The rule is that **every read has a check in front of it
  with nothing awaited in between**, and so does every adoption — an await
  between the two is a window the cancel lands in and the read goes out of
  anyway, which is why the settle asks the holder for its connection once and
  hands it down. What holds the rule is not the enumeration but a case that
  cancels from inside every read there is, and at each line's first
  suspension, and asserts nothing was read afterwards; a boundary nobody
  enumerated fails that too. What a check cannot reach is a read already sent, whose
  answer is dropped rather than called off; the prompt abandons the line and
  says so, which is the interruption it can actually deliver.

  A key typed under a running line is drawn as it arrives, into the line that
  runs next. The two keys that end a line — `enter`, and `ctrl-d` on an empty
  one — are held instead, along with every key after them, and replayed the
  moment the prompt is free, so a pasted script runs line by line and each
  line runs against the place the one before it settled on. Nothing is
  discarded and nothing runs unseen, which is what B2's `set` and `call` need
  from a queue that today can only navigate and read.

  `PromptTerminal` gains its third write, the out-of-band line: text above the
  line being edited, with the prompt drawn again beneath it. A line's own
  outcome lands through it, because by the time a line settles the person may
  have gone on typing; decision 28's event lines and A4's `announce` land
  through the same one when they arrive. It is a door that carries a user
  program's own strings, so it holds every character a terminal acts on to the
  glyph naming it — `escapeControlCharacters` exactly, a line feed excepted
  and let through as a row — at the door in `paint.ts` rather than at each
  producer, where one of them would be the one that forgot.

  The producers finding 8 names are routed there: `loadPieces` takes a
  `ConnectionOutput` carrying the sink for what a connection writes for itself
  and the runtime's `consoleHandler`, and shuttle opens its connection with
  both aimed at that line. The console it hands the runtime is a proxy rather
  than a console, and for a reason the enumeration would have missed: a real
  one raises a *process warning* for a timer or count label it does not hold,
  which goes to the process's stderr whatever console the call was made on,
  carrying a label a pattern chose — an escape sequence among the labels it
  may choose. A proxy answers every property with a function of shuttle's
  own, so there is no method, named in `ConsoleMethod` or not, that reaches
  anything but the announce line; the label state those methods read is held
  beside it, and an ask it cannot answer becomes a line. Item 5's `lib/piece.ts` sweep is finished for every
  site a v1 verb can reach — the navigate callback's three lines,
  `withRuntimeCleanupOnFailure`'s two, and `loadPieceForCallables`' bootstrap
  warning, which no v1 verb reaches yet and which B2's `call` will. The
  terminal opens before the connection now, since the terminal is where the
  connection's writing has to land.

- **B1g — projection on `get`, and a listing that numbers, marks and pages.**
  The two verbs a person reaches for first were each unbounded: `get` at a
  piece root wrote everything the piece computed, the rendering included, and
  `ls` at `pieces/` in a populated space wrote a row per piece. Both are now
  one page with a status line, and `more` continues either — one mechanism,
  because what a page held back is lines whichever verb composed them
  (`page.ts`), waiting on the session beside the place (`session.ts`).

  `get` takes the read and projection options decision 7 gives a data verb —
  `--filter`, `--select`, `--schema` and `--json` — declared as
  `cf cell get` declares them and parsed by that command's own parser
  (`parseCellSelectionOptions`), so a flag means on both surfaces what it
  means on one. It is the first caller of the option grammar B1d built, and
  what it settles is how a verb receives what the parse read: the options and
  the operands arrive together as one value, since `readOptions` divides a
  line into exactly that pair and a verb that reads one usually reads the
  other. A piece's `$UI` node is stood in for unless a projection named the
  fields the line wants, `--select '$UI'` being what reads it.

  `ls` numbers its rows from `%1` and records what each one is — container,
  value, callable, piece or slug — as it mints the handle, which is decision
  27's structured handle and what B2's `call %4` resolves against. A callable
  row is annotated as one, which is what [`grammar.md`](grammar.md) promises.
  The listing reads the cell's value rather than a list of its keys, which is
  the same read `listCellKeys` makes and no extra round trip. `--limit`
  overrides the height rather than capping it.

  The table is what lands here because `call %4` reads it at mint time; the
  reading of `%n` as a reference belongs with the verb that consumes it, and
  is B2's first slice rather than its last.

- **B1h — recall and completion, at the prompt B1c built.** The two keys a
  person's fingers reach for before they reach for a verb, and B1 owns them:
  each rides the prompt loop and the line grammar rather than any verb, and
  decision 29 rules what each is over.

  `up` and `down` walk the lines this run typed
  (`packages/cli/lib/shuttle/history.ts`), which is a value beside the
  buffer and nothing outside the process reads. They are ordinary rows of
  B1c's binding table, `ctrl-p` and `ctrl-n` beside them, since the buffer a
  prompt holds is one row and a vertical motion over it has nowhere else to
  go. The traversal runs over the recorded lines *and the line being typed*,
  which is one mechanism rather than a mechanism plus a special case: an edit
  is held at whichever position it was made at, the line being written when
  the first `up` left it included, and everything that ends the line —
  running it, and `ctrl-c` — drops the edits and returns the traversal to it.

  `tab` completes the token the line ends in
  (`packages/cli/lib/shuttle/completion.ts`): a verb where the line names
  none, and where it names one, whatever that verb's arity declares its next
  operand completes — a slot declared on the two arms that have an operand
  and unspellable on the arm that has none, so a verb cannot be added without
  the decision. The candidates under a place are the listing `ls` reads and
  the operands `operandForChild` offers for its rows, so a completion writes
  a token `cd` takes back to the row, a name needing quotes and a name the
  reference has to carry included, and nothing gates a candidate on its shape.
  Which token a half-typed line ends in is the split's own question, and it is
  answered off the split's own scan (`tailOfLine`, `line.ts`): the token is
  the last one the split reads rather than the run after the last separator,
  which is what keeps an escaped or quoted separator a character of its token
  instead of the edge of one.

  A completion reads, so it is work in flight beside the keys exactly as a
  line is: `enter` typed under one is held and runs the line it completed,
  and `ctrl-c` cancels it — the read that has not gone out through the guard
  every read here goes through, and the prompt back through the race, since a
  read already sent may never answer. Two bounds are ruled rather than
  inherited, and [`grammar.md`](grammar.md) carries them: a completion is
  written onto the line it was computed for and onto no other, and a common
  prefix shorter than a whole candidate is written only where it needs no
  quoting.

Still to come:

- **Liveness, in two halves.** Recovery of an *established* connection needs
  nothing from shuttle: the memory client reconnects and
  re-arms its watches by itself
  ([`runtime-integration.md`](runtime-integration.md)), so B1 proves that
  rather than rebuilding it — a test that drops the transport under a
  standing watch and shows the subscription still delivering afterwards.
  What B1 does build is the relay that carries the memory client's
  connection state up, reporting it as live, reconnecting, and permanently
  failed, because the storage layer publishes none today and both the
  prompt and the view markers consume it. No retry loop in shuttle on
  either half.

**B2 — writes, calls, handles.** Done. (After A2, A3, and A4 — a failed call
or write must surface as a value, never reach `Deno.exit`.) `set` with
inline values,
`edit` over `$EDITOR`, and `link` — the one spelling that writes a
reference instead of copying a value (decision 14), which leans on
`cf piece link`. `edit` is the only write of the three with no `cf`
equivalent behind it. `call` through
`callFromCommand`, with `verbs` and `describe` beside it, since listing a
piece's callables is what makes `call` usable without leaving the shell.
`%n` becomes an operand here, over the handle table B1g's listing mints:
the table carries each row's kind and the place its rows stand in, which is
the receiver and the verb name a callable handle needs (decision 27), and
what `call %n` resolves against. It settles the way the other unsettled
spellings do — an arm `place.ts` hands back and `verbs.ts` looks up
(`handles.ts`) — so a row naming a piece is confirmed by the read `cd`
already makes, and a walk written after the handle is the walk a person could
have typed.

Two things the landed modules did not carry come with it. `Arity` gains the
arms these verbs need: two operands for `set` and `link`, and a verb whose
own operands run on into a callable's section for `call`. And that section is
what the option grammar reads differently — the parse stops at `call`'s first
operand, so a callable's schema-derived flags reach the callable, and the bare
`--` closes the section rather than quoting an operand.

`more` continues a listing *and its
numbering* already, the rows being numbered where they are read rather than
where they are written (decision 24). The invocation session is
minted once at startup and passed explicitly. The step-10 call section
is shuttle's own line grammar, parsed locally and fed to the
schema-derived flag machinery `cf` already exports (`pieceCallRawArgs`,
`pieceCallInvocation`), so no arc step gates it either. Reaching-in-warms
lands here, since `set` is what makes stale computed state visible.

**B3 — watch and views** (after A4). `Cell.sink` with the guard-plus-`idle()`
settling discipline; the value and list views;
session watches (`watch`, `watches`, `unwatch`) with prompt event lines.
Governed by [`views.md`](views.md). Landing in slices.

Landed:

- **B3a — the settle discipline, the value view, and watches as session
  objects.** `sinkCellValue` (`packages/cli/lib/piece.ts`) is the subscription
  seam: it resolves the target the way a read does, sinks the cell, and reports
  once per quiet runtime through a reentrancy guard plus `runtime.idle()` —
  `renderVDomToHtml`'s form, and no timer anywhere under it. Starting the piece
  stays the caller's own act, so a caller watching several cells of one piece
  starts it once.

  A watch (`lib/shuttle/watch.ts`) is a session object beside the handle table
  and the warm set: `watch <ref>` arms one and numbers what is armed, `watches`
  lists them, `unwatch %n` disarms the one a row was minted for, and `where`
  names them. Each settled change writes one line above the prompt — the cell
  and which of the piece's two cells it is — through the out-of-band door a
  connection's own writing already goes through, so scrollback stays
  append-only. A change is what is reported: the first settle is the baseline,
  and a settle that landed on the value already held writes nothing. Deciding
  that needs fabric-aware equality at the root, `deepEqual` reading two
  distinct `FabricBytes` as equal, so a cell whose bytes changed would otherwise
  report nothing.

  The line says *that* the cell changed, which root equality is enough to
  decide. Reporting which leaves moved and what each moved to needs a per-leaf
  diff over arbitrary fabric values, and that is deferred with the transition
  row it feeds ([#7444](https://github.com/commonfabric/labs/issues/7444)) —
  the feature rather than the decision behind it. Reading the value out is
  `get`'s, and watching it move is what the lens is for.

  The value view (`lib/shuttle/lens.ts`) opens as one lens onto that watch,
  drawn on the alternate screen so that nothing already written scrolls while
  it is up, and given back on every way out of a run — a signal among them,
  which ends the process without unwinding. It is pure logic plus a frame the
  prompt draws: the prompt owns the keyboard, so a lens is a state of its loop
  rather than a program beside it, which is the shape every view here takes
  and the reason `pager.ts` is not the substrate ([`views.md`](views.md)).
  The terminal keeps what was announced while a frame held the screen. The two
  lifetimes are separate, which is what the slice is for: `q` cancels the
  lens's own subscription and leaves the watch armed.

  Two things the frame does not draw are worth naming. The connection marker,
  the relay that would report connection state being B1's and unbuilt
  ([`runtime-integration.md`](runtime-integration.md)). And the transition row,
  which is deferred with the diff it is built on
  ([#7444](https://github.com/commonfabric/labs/issues/7444)) rather than
  declined: the project owner ruled that such a row **stands until another
  change replaces it rather than expiring**, which is
  [`views.md`](views.md)'s "never a timer" applied to its own sentence, and
  that ruling is what it returns under.

- **B3b — the rest of a value view's keys.** `:` opens a command line on the
  row above the bottom edge, `/` with `n`/`N` finds text in the rendering, and
  `e` opens the watched cell in an editor.

  `:` is the reason this is a slice rather than a handful of key arms. Running
  a line is asynchronous and the prompt loop is what runs one, so the lens
  leaves the line where the loop collects it and the loop hands back what it
  produced (`asked` and `answered`, `lib/shuttle/lens.ts`). That keeps the lens
  synchronous — a case still drives the whole of it with a key and a value —
  and keeps one line in flight at a time under one cancel, the loop's own. What
  the line produced reaches the transcript the way every line's output does;
  the modeline carries its first line, which is the acknowledgement rather than
  the answer. `e` is that same mechanism with the line composed rather than
  typed (`edit <reference>`), so the editor trip, the refusals and the write
  stay the `edit` verb's.

  Three things the loop decides rather than the frame. A `ctrl-c` means the
  innermost of the three things it can mean — what is being typed, then the
  line in flight, then the way out — which is the order the prompt already
  takes. A line that opens a view of its own has that view closed rather than
  adopted: one frame at a time, and the line itself stands, so a `watch` typed
  at a frame leaves a watch armed. And a frame is now typed at, so it carries a
  cursor on the command line's row and hides the cursor otherwise.

  `/` searches, and the owner ruled that it searches in every view rather than
  narrowing in one and finding in another: `views.md`'s own "vim-flavored" is
  what `/` means in every pager a person arrives here knowing, and its "stable"
  is what a key meaning two things costs. Narrowing is not a view key at all —
  a view shows what a read returned, and `--filter` is where the grammar asks
  what a read returns. `enter` drill and `backspace` up are not here either;
  both need a cursor, which is the row a view stands on, and they arrive with
  the view that carries one.

  Two things a reader will look for and not find. `tab` completes nothing on
  the command line — completion is an errand of its own and the loop runs one
  at a time — and the lines typed at a frame are recalled by that frame's own
  `up` and `down` rather than joining the prompt's history, the prompt's being
  the lines typed at the prompt.

  The line editor is one table both places read (`lib/shuttle/editing.ts`), so
  a line typed at a frame takes the motions a line typed at the prompt takes,
  and a binding added to either is added to both.

Still to land:

- **A watch on a piece's arguments cell.** `sinkCellValue` takes the cell a
  read takes, and for an arguments path the two are not the same cell: the
  read resolves the link stored at the member and a subscription does not, so
  it reports the link marker and a write through that link settles nothing it
  can see. What closes it is a resolved cell for an arguments path —
  `PiecePropIo.get` builds one for the read and `getCell()` hands back the
  unresolved root, so the seam is `packages/piece`'s to offer rather than
  shuttle's to assemble. Until then `watch` refuses the `#argument` member, and
  the refusal names what does work: `get .#argument/<path>`, which reads that
  cell, and `watch <ref>`, which watches the result the pattern computes from
  it.
  The two cells are already named and keyed apart everywhere a watch is shown,
  so what the seam costs is the refusal and nothing under it.
- **The list view,** and with it `enter` drill and `backspace` up. It rests on
  `SpaceReplica.sinkDocument`, which is on neither `IStorageProvider` nor
  `ISpaceReplica`, so the seam question is `packages/runner`'s to settle before
  shuttle reaches it. It opens with the two experiments and the
  raw-document-subscription proving test from issue
  [#6534](https://github.com/commonfabric/labs/issues/6534), falling back to
  the capped deep sink if the seam disappoints. The two drilling keys come with
  it because both need a cursor — the row a view stands on — and a view of one
  value has a scroll position instead. Giving it one is not a key arm: its
  rendering is the one `get` and `wish` write, so a cursor that meant anything
  to `enter` would be a map from a drawn row back to a path inside the value,
  which is a change to a shared renderer.

**B4 — externals and escapes.** `>` and `<` to and from `file:` externals
under the scheme-absolute rule; the external working location
(`xcd`/`xpwd`, the `x:` base); the `!` escape family — line-initial `!`,
`|!` in a pipeline (bare `|` reserved, its error naming `|!`), and `!cf`
with place-derived flags injected. With the external location, `where`
reaches its v1 surface: every dimension printed, the light ones settable
(decision 22).

One question B4 settles rather than inherits: what a rendering carries when
it is not going to a terminal. Only part of the treatment of a control
character is at stake, and [`grammar.md`](grammar.md) is where the division
is. A segment holding a newline is refused for what a rendering of it reads
back as, which is a fact about addresses: it holds in a file and a pipe as
readily as on a screen,
and B4 changes nothing about it. The rest of the class is refused because a
terminal acts on it, the round trip there being exact, and a message is
glyphed for that same reason — those two are what a second destination puts
in question. `>` to a `file:` external and `|!` into a pipeline are that
destination, and there the same treatment reads differently: glyphs in a
file are noise rather than safety, and a redirected `get` is where somebody
wants the value as the fabric holds it. Which way that goes is open. The
canonical output form ([`futures.md`](futures.md)) reaches the same fork
for the same reason, so whichever answer B4 takes is the one that form
inherits.

B4 closes v1. The deferred set — the pinned strip, cold-browse mode, the
native tool set, heavyweight `where` edits, the `fuse/` facet,
fabric-to-fabric redirection, `https:` read ends, and `search` — is
designed and preserved in [`futures.md`](futures.md), each returning as
its own slice when scheduled.

## Working rules

- Every stage-A PR carries the unit tests its seam enables; a seam PR
  without tests is the shape the `FromCommand` rationale exists to
  prevent.
- `packages/cli` coverage gates apply to stage A; the extraction PRs are
  coverage-positive by construction, which is the order's second reason.
- A slice adds no configuration of its own: the shell is `packages/cli`'s
  code, so it rides that package's entry in `deno task check`'s path list, its
  test runner, and its coverage group. A test file that stands in for a
  process-wide member — an environment variable, a `Deno` member — goes in that
  runner's `SERIAL_TESTS` list, because the parallel pass runs every other file
  on a thread of one process.
