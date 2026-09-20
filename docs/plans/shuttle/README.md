# Shuttle — a place-aware fabric shell

Status: v1 design settled — the decisions below are ruled, and nothing
blocks construction. The v1 cutline is drawn: a handful of settled designs
are deferred past v1 and preserved in [`futures.md`](futures.md), so they
are re-scheduled later rather than re-litigated, and the decisions below
say so where they defer. Construction is under way;
[`build-sequence.md`](build-sequence.md) carries the order and where each
item stands. This document stays the working design state: new decisions
land here as they are made.

Shuttle is an interactive terminal tool for exploring and editing fabric
state: a line-oriented REPL whose prompt carries a mutable **current place**,
plus full-screen live views that open on demand and drop back to the prompt.
The codename is the loom's shuttle — the part that travels back and forth
through the warp carrying the weft — beside the user-facing shell's "weaver".

```text
shuttle estuary/board> watch topics/3
┌ topics/3 ──────────────────── ● live ┐
│ title    "verb contracts"            │
│ replies  14                          │
└── q: back (watch stays armed) ───────┘
shuttle estuary/board> call topics/3 add-reply --body "hi"
watch topics/3 @space: changed
shuttle estuary/board>
```

## Why

Weaver is where a person stands inside the woven fabric: rendered pieces,
live interfaces, the product. Shuttle is the same sense of presence one
layer down — standing in the substrate itself, where cells, links, scopes,
and reactions are visible as themselves. When the rendered surface
misbehaves, this is the layer a person needs to see: what a cell actually
holds, when it settled, which overlay a read went through, what a verb call
wrote.

The substrate is reactive, and no tool shows it moving at this layer. `cf`
prints snapshots; the FUSE mount is bounded by cache staleness; `cf
inspect` is offline forensics; weaver shows the rendered product, not the
mechanism. Shuttle's watches and live views make the mechanism observable:
arm a watch, issue the cause, see the reaction arrive — cause and effect
interleaved in one transcript that doubles as a record.

The moving half of context has no home. `CF_API_URL`, `CF_IDENTITY`, and
`CF_SPACE` absorb the constant half, and
[`cli-surface-shape.md`](../cli-surface-shape.md) step 8's rationale — "a
parameter that is required everywhere and identical across a working
session is one a caller should state once" — caps out exactly there,
because piece, path, and scope are not identical across a session: they
change with every step, because they are the work. The fabric's cell
reference grammar — `//<space>/<piece>[#member][@qualifier…][/path…]` and its
space- and piece-relative forms, recorded in
[`cell-reference-grammar.md`](../../specs/cell-reference-grammar.md) and read
by `packages/runner/src/cell-reference.ts` — takes the levels a reference
omits from a context, and shuttle makes that context a position you
navigate: **a place is the context that fills in the omitted levels of a
reference**, moved by `cd`, relative references, and handles instead of by
copying printed addresses between commands (the composition axis of
[`../common/verbs/session-walkthrough.md`](../../common/verbs/session-walkthrough.md)).

Underneath both, a persistent runtime session is a capability one-shot
commands cannot have at any flag cost: warm pieces serving live computed
values without a per-command `--step`, subscriptions feeding watches and
views, pagination cursors, the handle table, invocation-session
continuity. And where an environment variable makes context ambient and
invisible, the prompt renders the whole ambient record — place and scope
— so what every command is about to touch is visible before it runs.

## Settled decisions

1. **Shape: hybrid.** A REPL is the spine — a prompt showing the place, line
   commands that print and return. Full-screen live-updating views (`watch` a
   cell, browse a collection) open on demand and return to the prompt. The
   prompt serves composition and muscle memory; the views serve the
   browse-and-observe loop a reactive substrate deserves.
2. **Home: inside `packages/cli`**, in `lib/shuttle/`, reached as the `cf sh`
   subcommand. A shell is the `cf` verbs held open over one connection, so it
   is `cf`'s own subsystem rather than a package beside it: it calls the seams
   as neighbors, `cf sh` imports what it runs, and there is no package
   boundary for a cycle to form across. It keeps its own directory, beside
   `lib/view/` and `lib/completion/`, the two other subsystems `cf` gives one
   to. A person's flags are read once, in the command, in the words every
   other command reads a space and an identity in, so nothing under it parses
   a command line a second time. The pace layer is `cli`'s, and the seam work
   stage A landed stands whether a caller is inside the package or beside it.
3. **Audience: the operator at the keyboard.** Power use first; teammates
   second, served by completion, help, and forgiving defaults. Agents and
   demo audiences are not v1 targets, and no decision may preclude them.
4. **First workflows: inspecting live state, and browsing + editing data**
   (navigate, read, set, call, wish). The pattern-development inner loop and
   bulk operations are possible futures the design must leave open, not v1
   targets.
5. **Place model: reference prefixes plus named entry points.** A place is a
   prefix of the canonical reference — a space, a piece, a path under a piece
   — and named entry points (wish targets such as `#favorites`, slugs, space
   names) are navigable: `cd #favorites` works when the target resolves
   within the connected space, and `cf wish` already resolves those
   targets headlessly. A target anchored elsewhere — profile and
   favorites resolve against the reading identity's home space — is
   refused with the reason in v1, which serves one space per process
   (decision 22). Virtual places — standing inside a
   search result, a survey's holders, a filtered collection — are a designed
   extension: the place abstraction must not assume a place is only a
   prefix.
6. **Ambience: shell-private, passed explicitly.** The place lives in the
   shell process. One-shot `cf` outside the shell is untouched. A `cf`
   command run from inside the shell receives the place explicitly — context
   injected into that invocation — never by mutating environment variables.
   The ambient record is one serializable value with one owner module, so
   an ambient adoption fuller than step 8's `CF_SPACE` — a `CF_PLACE`
   carrying the moving half — can reuse the representation without
   redesign.
7. **Vocabulary: navigation verbs plus `cf` verbs.** Navigation is
   shell-native (`cd`, `ls`, `pwd`, `watch`, …). Data verbs are exactly the
   `cf` ones (`get`, `set`, `call`, `wish`, `verbs`, `describe`, …) with the
   place filling in target options, so knowledge transfers in both
   directions between the shell and one-shot `cf`.
8. **Codename: shuttle.**
9. **Execution model: in-process, with a `!cf` escape.** The shell's own
   verbs call the same library seams `cf`'s commands do, over one persistent
   runtime connection that the live views share for their subscriptions. A
   `!cf …` escape spawns the real binary with place-derived flags injected,
   covering the rest of the surface. The known risk is drift where `cli`
   code is not yet factored as callable seams; the answer is to factor the
   seam in `cli`, not to reimplement the verb in shuttle.
   [`runtime-integration.md`](runtime-integration.md) grounds
   this decision: the connection and watch mechanics that exist, the
   lifecycle discipline a long-lived process adds, and the prerequisite seam
   work in `packages/cli`.
10. **Run state: reaching in warms.** `cd` into a piece, `watch` on
    anything inside it, or any read aimed into it — `get topics/3/title`
    from outside warms `topics/3` exactly as `cd` would — starts the
    pattern in-process, so every read shuttle serves is live and v1 has no
    unlabeled stored-state path; pieces merely listed stay cold — which is
    v1's whole run-state story. A cold-browse mode is
    designed and deferred past v1 ([`futures.md`](futures.md)).
11. **A space root lists facets, never pieces directly** — `slugs/` and
    `pieces/` in v1; the `fuse/` facet (the FUSE layout mirrored,
    leveraging `packages/fuse` rather than reinventing it) is designed and
    deferred ([`futures.md`](futures.md)). Facet names are reserved
    wherever a walk from the root begins: as a segment at the space root,
    and as the first segment of a **rooted** reference, so `/slugs/todo`
    names what `cd /` then `cd slugs/todo` names. The shell teaches
    `cd slugs` at the root in its first minute and the natural next
    spelling is the rooted one, so a rooted `/slugs/…` that named a piece
    slugged `slugs` would be one character from the facet rendering and
    would name another cell entirely. Inside a piece nothing is reserved.

    **The reservation diverges from the canonical grammar, for two slug
    values.** The rooted spelling is not shuttle's — `[//space]/<piece>…`
    is the canonical cell reference, the runner's `parseCellReference`,
    the same structure in patterns and at every `cf` intake seam, and this
    CLI resolves the piece segment by slug as well as by handle
    (`packages/cli/lib/llm-friendly-ref.ts`). The facets are the
    shuttle-only half: a browsing overlay on the space root. So shuttle
    reads `/slugs/x` and `/pieces/x` differently from the way `cf` reads
    the same strings, and identically for every other slug. That is the
    current state and it is what decision 11 costs: a piece slugged
    `slugs` or `pieces` has no rooted slug spelling in shuttle, and is
    reached by handle or by a complete reference carrying its space.
    Issue [#6992](https://github.com/commonfabric/labs/issues/6992)
    retires the divergence by having `set-slug` refuse those two values,
    after which no piece can carry them and the two grammars agree
    everywhere.
12. **A view is not necessarily a place.** Pagination and search produce
    views to look at and pick from; they need no path-shaped address unless
    one earns it (the virtual-places extension of decision 5).
13. **Prompt and naming: checked names only, fabric's mechanisms only.**
    Space names and slugs are shown when an index confirms them, and the
    whole handle otherwise; shuttle introduces no naming layer of its own.
    The prompt shortens nothing but the space, for two reasons that hold
    on their own. A prefix of a handle is spelled exactly as a whole handle
    is, so nothing in it says which it is, and `pwd` is ruled to be what a
    person copies — a prompt handing out something that looks like an
    address and is not is the silent wrongness decision 11 ends. And a
    prefix is only useful if it is unique, which is knowing every other
    handle in the space: an index read, per prompt line, where a name is
    read once at the `cd` that adopted it and the handle needs no read at
    all.
14. **Writes: inline value, editor, explicit links.** `set` takes a JSON
    value on the line (stdin via `-`); `edit` opens `$EDITOR` on the current
    value; `link` is the only spelling that creates a reference rather than
    copying a value.
15. **Externals are schemed; nothing outside the fabric is a default.**
    Redirection targets fabric paths; a local file is always spelled
    `file:…`, and `file:` is one member of an open scheme family (`https:`
    sources are designed and deferred; external writes wait for a use).
    Beside the place shuttle tracks one **external working location**,
    schemed like its operands: `xcd` sets or relative-moves it, `xpwd`
    prints it.
16. **Pipelines: escaped locals now, a published native tool set later.**
    Arbitrary local programs need an explicit escape, so leaving the
    portable surface is always visible on the line; bare `|` is reserved,
    and its error names `|!`. The native set — names that work bare and
    are guaranteed wherever shuttle runs, contract not implementation —
    is designed and deferred ([`futures.md`](futures.md)).
17. **Numbered handles, in the first column.** Listings number their rows and
    `%n` is a reference until the next listing — the mechanism by which a view
    (decision 12) feeds the next command without being a place. The handle
    opens the row, in a fixed-width column the widest of them sets, and the
    name comes next. A short handle column is what makes a numbered listing
    scannable: every name starts at the same offset, so a reader runs their
    eye down one column for the names and down another for the numbers.
    Numbers written after names are not a column at all — the names vary in
    length, so the numbers land ragged, and the reader who wants `%39` has
    nowhere to look for it. What the order costs is that the name is no
    longer the first thing on a line, so what identifies a row with no name
    is the marker standing in its name column rather than the line's first
    character; [`grammar.md`](grammar.md) carries that rendering.
18. **`!` means local, everywhere.** Line-initial `! <cmd>` runs a local
    program, `|!` is the same escape inside a pipeline, `!cf` the special
    case that injects place-derived flags.
19. **Shuttle is what it is; `cf sh` is what you type.** The relationship is
    the one Fabric already has with `cf`: a product carries the name a person
    means, and the command carries the name a person types thirty times an
    hour. Shuttle stays the codename and the product, and no command spells
    it. `cf sh` is the subcommand and `cfsh` the one-word spelling of it —
    the space elided, so it is one name at two spellings rather than two
    names, and it reads as a shell in the family `zsh` and `ksh` are in.

    Both reach one process: `bin/cfsh` is a forward to `cf sh`, which runs in
    whichever checkout `bin/cf` resolved from the working directory. The
    forward carries no checkout logic of its own — `exec` leaves the working
    directory alone, so both hops mean the same checkout — and it finds `cf`
    by name, where `install-cf` put it. `install-cf` installs
    `cfsh` beside `cf`, without which the spelling this decision settles on
    is one nobody has on their PATH.
20. **Scope is the cwd's second dimension.** Per-identity overlays
    (`@user`, `@session`) are a way of seeing every place, so the cwd is
    the pair (position, scope): both stick across navigation, both render
    in the prompt, and `pwd` prints both. `cd` is the door to both —
    `cd board@session` moves both, `cd .@session` scope alone, `cd .@space`
    back to the base — there is no separate scope verb, and an explicit
    qualifier on an operand overrides the ambient scope for that operand. A
    scope moved alone still moves onto a place: the same id under two
    scopes is two documents, so `cd .@session` settles against the fabric
    as every other move `cd` adopts does. All
    three scope words are canonical, and a qualifier on a reference is
    verified against the canonical parser. A scope on its own is written
    `.@scope`: `.` is the context's own cell and the qualifier hangs off
    it, which is the reference grammar's own relative spelling rather than
    a navigation word beside `/`, `..` and `-`. `@` therefore carries one
    meaning — a qualifier on the piece — and is an ordinary character
    everywhere else, so `cd @session` reaches a key of that name and a
    refusal that finds none offers `.@session` instead.

    The spelling is the cell reference grammar's
    ([`cell-reference-grammar.md`](../../specs/cell-reference-grammar.md)),
    and shuttle reads it through that grammar's own reader. A qualifier names
    the base scope or the reading identity's own overlays, never another
    identity's; standing in another identity's overlay is a canonical-grammar
    extension, out of v1.
21. **The native tool set v0 is ruled and deferred** with decision 16's
    contract: the list, and `cat`'s deliberate absence, are preserved in
    [`futures.md`](futures.md).
22. **`where` is the ambient context's one surface.** Every dimension —
    connection, cwd pair, external location, invocation session — prints
    in `where`, and `where <dimension> <value>` sets the light ones (scope,
    the external location). The heavyweight dimensions — api endpoint,
    identity, and the space — are fixed at launch in v1, and restarting is
    the switch: one shuttle process serves one space, so `cd` moves within
    it (multi-space sessions are a named candidate in
    [`futures.md`](futures.md));
    editing them live is designed and deferred ([`futures.md`](futures.md)),
    which also honors the one-connection-per-process limit the seam work
    records. `cd`/`xcd` are conveniences over the hottest dimensions;
    launch flags seed the initial record.
23. **A scheme is legal only on an absolute complete path.** Relative
    external operands are rooted with the `x:` base (`> x:../out.json`) —
    a base name, not a scheme — and a bare relative operand is always
    fabric, so no operand ever changes plane by position.
24. **Pagination: height-fit pages, and `more` continues.** `ls` prints
    one terminal-height page plus a status line and never escalates to a
    view uninvited; `more` continues the listing and its handle numbering,
    so a run's handles stay valid until a new listing resets them.
25. **List views watch membership raw, elements deep, window only.**
    Reader schemas cannot express a membership-only subscription (verified
    — an opaque item schema bounds the element closure but still delivers
    every element's root document), so membership comes from a raw-document
    subscription on the collection doc and only visible rows sink deeply —
    cost bounded by the visible page in element documents; membership is
    one document whose size grows with the collection's link array — linear
    in links, not in element closures. The seam and solution lanes are
    issue [#6534](https://github.com/commonfabric/labs/issues/6534); B3
    opens by proving the seam, and falls back to a capped deep sink with
    an honest label if it disappoints. The raw subscription serves the
    base scope only — `SpaceReplica.sinkDocument` keys on the base
    instance and takes no scope — so a list read under `@user` or
    `@session` takes the capped deep sink, which reads through the scope
    its cells carry. Making that seam scope-aware end to end is part of
    #6534, not a shuttle workaround.
26. **A piece reads through one verb, and `describe` is it.** The four
    things a reader wants of a piece — its arguments, a summary of its
    result, its callables with their doc annotations, and its pattern
    identity — are one reading, and `describe` writes it. This decision
    ruled a second surface onto those four on 2026-08-29, before that verb
    existed: `describe` reached the shell on 2026-09-07, in B2, and the two
    were written several slices apart. The dates are here so the overview
    is not proposed a second time by a reader who finds the ruling and not
    the verb. A second surface
    onto the same four is an overlap in purpose that a difference in form
    does not pay for: a frame over them would add a way to refresh in
    place, where a shell refreshes by running the line again, and a way to
    scroll, where `more` continues the page already. So v1 ships the one
    verb. A live view of a piece is deferred
    ([`futures.md`](futures.md)), and it is deferred for the seam rather
    than the form.
27. **Handles are structured.** A handle is a bound reference with
    structure, not a string: a listing records each row's kind as it mints
    the handle, and for a callable row it records the receiver and the
    verb name. So `call %4` invokes what the listing showed through the
    same root-level name resolution `cf` already performs, and arity
    resolves against a kind known locally at mint time — a callable handle
    means the positionals after it are input, a piece handle means the
    next positional is the verb name. That delivers the ergonomic the
    listing demands, calling what was shown without splitting a reference
    by hand, and delivers it without a typed path grammar: `call` keeps
    `cf`'s receiver-plus-name form (`call topics/3 add-reply`) as the
    typed spelling, and a typed path ending in a callable is refused. This
    is also how a verb is named everywhere else — a verb name is interface
    vocabulary rather than a data path, and the receiver is the
    addressable thing.
28. **Watches are session objects.** `watch` arms a subscription that
    outlives its view: leaving the view keeps it armed, and each settled
    change appends one event line at the prompt. `watches` lists what is
    armed, `unwatch` disarms, and scrollback stays append-only — liveness
    lives in the event lines, never in mutated history. The pinned strip
    (a live region above the prompt) is designed and deferred
    ([`futures.md`](futures.md)).
29. **Recall is in-session; completion offers a token the line takes.** `up`
    and `down` walk the lines this run typed, which is the run's own memory
    and nothing a later process reads — persistent, searchable history is a
    separate feature and is deferred ([`futures.md`](futures.md)). The
    traversal runs over those lines and the line being typed, one position
    each, so an edit is held wherever it was made and everything that ends
    the line returns the traversal to it. A line is recorded with each `%n`
    replaced by what it bound to when it ran: `%n` is a reference only until
    the next listing (decision 17) and recall outlives listings, so a
    recalled handle would otherwise act on whichever row that number names
    now — the wrong thing, silently and successfully, which is the one
    failure a shell must not have. What is recorded resolves from
    anywhere the session can stand: a piece row records the id the listing
    resolved it to — a slug is repointable, so recording one would name
    whichever piece it comes to mean — and a row inside a piece records
    the reference naming
    the cell — the piece and the path, which is what a callable row
    already records for its receiver. A bare name would not do, two pieces
    being free to hold a key of the same name, so a recalled name could
    still reach a different cell without saying so. What the prompt shows
    is what was typed; what recall replays is what it meant, and the
    listing knows the difference already at mint time (decision 27). `tab`
    completes the token the line
    ends in: a verb where the line names none, and otherwise whatever the
    verb declares its next operand completes, which the two arms of the arity
    that take an operand require and the arm that takes none cannot express.
    What is offered under a place is the listing `ls` reads, under the
    operands `operandForChild` offers for its rows, so a completion writes
    what a listing prints and what `cd` takes back — the round trip decision
    13's checked names rest on, held by reuse rather than by a second answer.
    A completion is a read, so it is work in flight: it is cancelled by
    `ctrl-c` and written onto the line it was computed for and onto no other.

The line grammar itself — what a line may say, what its parts denote, and what
shuttle does and shows in return — is drafted in [`grammar.md`](grammar.md). The
full-screen views are designed in [`views.md`](views.md). The order of
construction — the `cli` seam PRs and the shuttle milestones they gate — is
[`build-sequence.md`](build-sequence.md). The trajectory past v1 — configuration
in the fabric, the session scope as the variable store, the scripting layers,
and the ranked candidates behind them — is [`futures.md`](futures.md).

## The ambient model

The ambient context is one record:

- **Connection**: api endpoint, identity.
- **The cwd pair**: position (space, optionally a piece, optionally a path
  inside it) and scope.
- **External working location**, **invocation session**.

`cd` accepts relative references — a head, `.` or a run of `..` that climbs
back through the route shuttle walked, and a literal path after it — `-`,
`/`, rooted and complete canonical references, slugs, numbered handles, wish
targets, and scope qualifiers. A space
named by name inside a reference is accepted and settled in two steps,
since deriving a DID from a name needs a session: the move comes back
carrying the name, and landing it means handing it over again with the
space that name resolved to, which is refused when that is not the
connected space. A space name as an operand of its own joins when
multi-space sessions do.

**A move onto a piece is settled the same way, against the fabric**, so
that `cd` is the one verb whose success means something. Three questions
are asked, and what the prompt promises is exactly their answers: a slug
resolves through the space's index, a handle is looked up in that same
index, and a path is walked against one read of the level above it. Each
failure is refused in shuttle's words — the path carrying the keys that
are there — rather than reported one command later in the runtime's. One
spelling escapes, and it is worth naming rather than surveying: a handle
read against a server that does not advertise the identifier lookup gets
neither a yes nor a no, and is taken as written.
[`grammar.md`](grammar.md) records that bound.

The place holds the piece the index pointed at rather than the slug,
which is what keeps an index repointed mid-session from moving a place a
write then lands in; the slug stays beside it as the name the prompt
shows (decision 13), and `pwd` prints the piece. `get` settles nothing:
where an operand points is the operand's own fact, and a read of a cell
that is not there fails on its own account. Every
reference a command takes resolves against the cwd, and how much of the
cwd it needs varies: a rooted `/of:…` fixes the piece and path but draws
its space and its scope from the place, a complete `//did:key:…/of:…`
carries the space and still draws the scope, and only a fully qualified
`//did:key:…/of:…@scope` names its cell from anywhere
([`grammar.md`](grammar.md)). The place is result-rooted — `cd` refuses a
reference selecting the `#argument` member, and arguments are reached per
operand, as in `get .#argument/title`. The
prompt renders position and scope compactly (an elided alias is checked
against the target's declared name, never guessed).

One place at a time in v1, but no global singleton: the implementation keeps
place-per-instance so multiple places (tabs, split views, an agent holding
several) stay reachable later.

## What exists to build on

| Component | Where | What it gives shuttle |
| --- | --- | --- |
| Cell reference grammar | [`cell-reference-grammar.md`](../../specs/cell-reference-grammar.md); `packages/runner/src/cell-reference.ts` — `parseCellReference`, `parseRelativeReference`, `parsePieceSegment`, `renderCellReference` — and `packages/cli/lib/llm-friendly-ref.ts` at the CLI's intake | The address syntax; shuttle consumes it and must not fork it |
| Target option surface | `targetOptions` in `packages/cli/commands/piece.ts` | The enumeration of exactly what a place must supply |
| Live-state listing and completion | `keysOf` in `packages/cli/lib/cell-listing.ts` — exported, beside the `listCellKeys` that reads a cell through it, which path completion in `packages/cli/lib/completion/providers.ts` uses | The `ls` primitive and tab completion; shuttle reads the cell over the connection it holds and names its rows through `keysOf`, and a failed read raises rather than listing empty. Shuttle's own tab completion reads that listing rather than a second read, and swallows the failure at its own call site, as the providers do at theirs |
| Pager/TUI substrate | `packages/cli/lib/view/` — `pager.ts` is the only module doing raw-mode full-screen TTY handling; `mod.ts` and `loadinput.ts` touch stdio for the one-shot path (capability probes, plain-output writes, piped input); `keys.ts`, `ansi.ts`, `render.ts`, `session.ts` hold state and decoding as pure logic | The full-screen half: raw mode, frames, key decoding, testable without a terminal; already follows references and edits buffers |
| FUSE mount | `packages/fuse` | The same addressing as a POSIX filesystem; prior art for layout (arrays as numeric directories, handlers as executables, links as symlinks). Shuttle is its interactive, live sibling, not a replacement |
| Offline inspector | `packages/state-inspector`, `cf inspect` | The forensic counterpart (snapshots, scopes, history); its HTML explorer is prior art for tree-plus-detail browsing |
| Entry-point resolution | `cf wish` | Headless resolution of `#favorites`-style targets — the mounts of decision 5 |
| Web shell route grammar | `packages/shell` routes `/<space>/<piece>` | Another spelling of place; keep them mutually translatable |

## Relationship to the CLI surface arc

Shuttle rides the addressing decisions of
[`cli-surface-shape.md`](../cli-surface-shape.md) rather than making its own:

- Step 8's `CF_SPACE` is on main: the constant half of the context is
  ambient for one-shot `cf` too, which is what isolates the moving half —
  piece, path, scope — as shuttle's ground. The serializable ambient
  record stays the shared seam for any further convergence.
- Step 9 (space by name, piece by slug, positionally) is what `cd` and the
  prompt want — names, not hashes — and it now lands paired with step 11,
  under the recorded prior question of whether the reference grammar is
  the right home for naming at all, or stands in for a resolution layer
  that does not exist. Shuttle consumes that work rather than duplicating
  it, and bears on the question from the consumer side: `cd`, completion,
  and the prompt are exactly a naming-and-resolution layer exercised
  against live state, so building them produces the evidence the question
  needs.
- The duplicated nouns that plan records (two `inspect`s, two `view`s) are
  words shuttle must not add a third meaning to.

Word hazards, so shuttle does not add to them: "shell" names the web
frontend, so nothing here takes it as a second identifier — no command is
named `shell`, the subcommand being `cf sh` (decision 19), and no document
names this thing that way. What the word does here is the ordinary one it
does in English, for the kind of thing shuttle is, which names nothing and
collides with nothing; "session" already carries three
meanings (invocation session, process connection, `@session` cell scope) —
shuttle says **place** and **connection**; "collection" means an array path
inside a holder piece (`cf piece survey`), and shuttle uses it only that
way.

## Open questions

None blocking v1. The B3 seam-proving gate and its two preparatory
experiments are recorded in decision 25 and issue
[#6534](https://github.com/commonfabric/labs/issues/6534). Reading what a
piece is belongs to `describe` rather than to a view (decision 26), so what
stands deferred is a *live* view of one, and that whole
([`futures.md`](futures.md)).

## Non-goals for v1

- Not an agent surface (stable machine-readable output, one-shot scripting)
  — leave the door open.
- Not a bulk-operations or migration driver — leave the door open.
- Not a replacement for `packages/fuse`, `cf view`, or `cf inspect`.
- No persisted cross-process ambient place, and no environment-variable
  mutation, ever.
- Not a hosted or remote terminal — but shuttle must not assume a local
  execution environment exists, so it can become reachable from one later.
  The native-versus-escaped pipeline split (decision 16) is that
  constraint's first tooth.
