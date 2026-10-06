# Shell completion coverage — implementation plan

`cf completion` answers a Tab with candidates for the slot under the cursor.
This plan sequences the work that makes it answer correctly across the surface
it already claims, and extends it to the pattern-owned vocabulary it does not
yet reach.

The design is unchanged and is not restated here.
[`packages/cli/README.md`](../../packages/cli/README.md#shell-completion) is
the reference for what completion covers and how it is installed;
[Verbs over the CLI](../common/verbs/over-the-cli.md) is the caller-facing
surface most of this plan serves. Read those for reasoning; read this for
order.

## Why

Completion is the one part of the CLI that fails by staying silent. Every
provider failure degrades to an empty candidate list on purpose, because a
completion request runs between two keystrokes and must never paste a stack
trace into the command line. That is the right disposition and it is also why
a defect here does not announce itself: a slot that resolves nothing and a slot
that has no provider are the same experience at the prompt.

Three consequences follow, and they are what this plan is for.

**Completion trails the command surface.** The resolver walks the live Cliffy
tree, so a new subcommand or flag becomes completable the moment it is
registered. The *values* do not: they come from two hand-maintained tables in
`lib/completion/providers.ts`, and a new command reaching the tree with no
entry in either is indistinguishable at the prompt from one whose fabric is
unreachable.

**The chain has a weak first link.** Reaching a piece, a verb, or a cell path
needs a space, `--space` is required on every command that reads one, and
`--space` completes to space DIDs discovered from local stores while a caller
often knows a Home-space display label instead. A DID does not reveal that
personal label. The dormant
[Common Fabric URL registry](../specs/fabric-urls.md) concept describes a
different possible public naming source, but no deployment is planned and this
completion plan does not depend on it.

**A live provider is exercised in one place only.** The unit tests cover the
pure shaping functions and assert that a slot with no fabric context degrades
to empty; nothing they can see distinguishes a provider that reaches a fabric
and returns the wrong set. `completion-over-the-cli.sh` (item 18) is what does,
and the defects below are the ones it was written to make visible — several of
them are asserted there as gaps until the item that closes them lands.

## How this list is ranked

Two axes, because either one alone gets the order wrong.

**Correctness gates value.** A slot that offers a candidate the command
rejects, or that hides candidates it holds, is worse than a slot that offers
nothing: the first teaches a caller something false, the second only fails to
help. Those defects are also the smallest edits here. They go first, cheapest
first, and nothing is built on a slot that is still answering wrongly.

**After that, rank by whose vocabulary it is.** Completion earns its keep where
the words are not the CLI's own. A flag name, an enumerated value, and a
subcommand are each one `--help` away, so completing them saves keystrokes. A
piece id, a verb name, a verb's flags, a cell path, and the field paths of a
verb's result are none of them derivable from the CLI — they belong to a
deployed pattern, and the only other way to learn one is to make a call and read
what comes back. Completing those saves a round trip and a context switch, which
is a different order of saving.

Frequency multiplies it. The slots on the call path — name a piece, name a verb,
fill its event, shape its result — are hit on nearly every command; `inspect`'s
positionals are hit by an operator during an investigation.

So: correctness first, then pattern-owned vocabulary on the call path, then
everything a caller could have read out of `--help` anyway. The rank column
records which of those an item is, and the table is in working order.

## State

Where every item stands. The sections below carry the detail and are what to
read before picking one up; this table is the roll-up.

| # | Item | Rank | Status |
| --- | --- | --- | --- |
| 1 | Inline `--option=value` drops every live candidate | correctness | done |
| 2 | Flags offered past a `stopEarly()` boundary | correctness | done |
| 3 | Target resolution lags the reference grammar | correctness | done |
| 4 | Verb flags do not complete | pattern vocabulary | shaper done, wiring open |
| 5 | Result field paths for `get` and `wish` | pattern vocabulary | `get` done, `wish` declined |
| 6 | Result field paths for `call` and `exec` | pattern vocabulary | open |
| 7 | Slugs never complete | pattern vocabulary | done |
| 8 | `--space` has no source a caller recognizes | first link | partly settled |
| 9 | A verb's annotation is its kind, not its prose | comprehension | done |
| 10 | Wrapper and deprecated verbs are offered unmarked | comprehension | done |
| 11 | Every Tab costs two process starts | felt cost | needs a decision |
| 12 | `nospace` is inert on the stock macOS bash | felt cost | done |
| 13 | Space and entity positionals across `inspect` | operator surface | done |
| 14 | `wish` targets and scopes | CLI vocabulary | done |
| 15 | Remaining path-shaped and enumerable values | CLI vocabulary | done |
| 16 | Two provider entries that can never fire | hygiene | done |
| 17 | The README table omits the top-level spellings | hygiene | done |
| 18 | A live-provider test seam | mechanism | done |
| 19 | A gate that fails when a new slot has no decision | mechanism | done |

**What can be picked up today.** Items 4 and 6. Step 10 of
[CLI surface shape](cli-surface-shape.md) has landed, so the position each of
them fills is settled and neither is waiting on anything. Items 8 and 11 hold
decisions; item 5's `wish` half is declined, because resolving a wish writes.

One defect this list does not enumerate is open and unranked: the cell-path slot
offers a piece's callables, which `cf cell get` refuses and redirects to `cf piece call`.
It is asserted in `completion-over-the-cli.sh` as what happens today. Telling a
callable from a value at a path needs the verbs listing, which that provider
does not fetch — so it is a round trip rather than a filter, and that is the
decision it waits on.

Item 4's candidates are built and its wiring is what is left: the verb opens
the callable's section, so its fields fill the `tail` argument directly after
the verb name, and `liveCandidates` does not dispatch on that slot yet.

Item 6 is the same shape one boundary later. A projection now follows the verb
it shapes rather than preceding it, so the verb is already before the cursor
and the slot needs no whole-line read to find it — which is the machinery this
item was waiting to be spared.

Items 8 and 11 hold open decisions and are not work yet. Item 5's `wish` half is
closed rather than open: resolving a wish writes, so the slot cannot be
completed from a resolution as it stands.

## What this list covers, and what it cannot

Two of the four ways completion can be wrong are enumerated here exhaustively,
and two are not. Knowing which is which is the difference between working the
list and trusting it.

**Enumerated exhaustively, and now gated.** A slot with no provider entry: the
keys of both provider tables are derivable from the same command tree the
resolver walks, so walking the tree and subtracting the tables names every one.
That is items 13 to 16, and `deno task check-completion-slots` is the same walk
made permanent.

**Enumerated exhaustively, and now gated.** A provider entry with no slot: the
same subtraction run the other way. That is item 16, and the same gate.

**Not enumerated.** A provider that returns the *wrong set* rather than an
empty one. This is invisible at the prompt — plausible candidates look like
correct ones — and there is no mechanical test for it. Item 2 is one instance,
found by reading a flag's help text rather than by any method that would find
the next one. The open questions of this kind are listed under item 18, because
a live seam is what turns them from questions into assertions.

**Not enumerated.** Defects in the installed shell functions rather than in the
callback they invoke. The bash function has been driven directly and agrees
with the callback on the cases tried, including reproducing item 1 end to end.
zsh's `_describe` rendering, the colon escaping that piece ids and DIDs need,
and the `deno` binding are untested.

## Working on this

Completion swallows every error on purpose, so a provider that throws, a fabric
that is unreachable, and a slot with no provider are one experience: no
candidates. Nothing here can be debugged by watching a shell, and a change that
looks like it worked at the prompt has not been observed.

**Drive the callback directly.** The installed shell function calls one command,
and so should you. It takes the line and the cursor offset, and prints what the
shell would have offered:

```bash
cf completion complete --shell zsh --line "cf piece call --piece x " --point 24
```

The shell functions themselves are a separate surface and are exercised by
sourcing what `cf completion bash` prints and calling `_cf_complete` with
`COMP_LINE`, `COMP_POINT`, `COMP_WORDS` and `COMP_CWORD` set. Reach for that
only when the defect is in the script rather than in the candidates.

**Live slots need a space, a piece, and something deployed in it.** A piece id,
a verb name, a cell path and a result shape are all read from a running fabric,
so a provider cannot be exercised without one: point `CF_API_URL` at a local
server, `CF_IDENTITY` at a keyfile, deploy a fixture, and complete against it.
An empty result from a provider proves nothing until the same target answers
the equivalent `cf` command.

**Where the tests go.** `packages/cli/test/completion-*.test.ts` hold the pure
half — line resolution, candidate shaping, the degrade-to-empty path — and are
the right home for anything answerable without a fabric.
[`unit-test-coding-style.md`](../development/unit-test-coding-style.md) governs
their shape and is worth reading first, since not every file in that directory
follows it. Anything that needs a fabric belongs beside
`packages/cli/integration/verbs-over-the-cli.sh`, which is item 18.

**Two traps in the parsing layer.** A throwaway Cliffy command used to parse a
token list needs `.noExit()`, or a bad flag ends the process instead of
throwing. And `parseExecArgs` takes the spec first and the arguments second.

## Correctness

### 1. Inline `--option=value` drops every live candidate

`complete` in `lib/completion/mod.ts` attaches the slot's `inlinePrefix` to
every candidate, whichever source produced it. `staticCandidates` returns bare
values, so one rule covers the static half and the live half alike — where the
static half owning the prefix alone left every live candidate failing the
prefix filter that `--piece=` is.

This spelling is why `tokenizeLine` exists — bash splits its own words on `=` —
so it is the one form the implementation is built to serve.

The directive half of the same slot lives in the shell functions, because it is
the shell that applies a glob. `$cur` is the whole word (`--identity=~/keys/a`)
while readline replaces only the fragment after the last word-break character,
so bash globs that fragment and zsh `compset -P`s the flag into `IPREFIX`.

### 2. Flags offered past a `stopEarly()` boundary

`resolveCompletionLine` in `lib/completion/line.ts` reads Cliffy's `_stopEarly`
field, so past the callable name on `cf piece call` and past the mounted file on
`cf exec` no option slot is reachable and a flag-shaped word does not shift the
positional index. That keeps the property where the command declares it: a
third command becoming `stopEarly()` needs no edit in the completion layer.

The position belongs to the callable: the verb opens its section, and a `cf`
flag written there is refused with the section it belongs to named — see
[Naming the target](cli-surface-shape.md#naming-the-target). So declining to
offer one there is correct. It leaves the position offering nothing until item
4 fills it, which is what a position whose vocabulary the command cannot yet
name should offer.

### 3. Target resolution lags the reference grammar

`resolvePieceContext` in `lib/completion/providers.ts` parses the target through
`normalizeLLMFriendlyRef`, which is the function the command's own intake parses
it with: the embedded space, the `@scope` suffix, a trailing path, and the
`#argument` suffix that selects the arguments cell the way `--input` does. What
that does not recognize falls through to the alias grammar,
`id[@scope][#argument]` (`splitArgumentSuffix` then `parseScopedIdSegment`).
Every spelling that intake accepts has to reach one of those two readings. A
word taken verbatim as a piece id resolves to a listing call that cannot
succeed, and completion answers a failure with silence, so the slot offers
nothing and says nothing about why.

An embedded space DID supplies the space where the line names none, the way
`parsePieceOptions` does with the same reference. Where the line names one it
wins, and a mismatch between the two is the command's to report.

A positional address is the second thing this item settles, independent of the
grammar above. `resolveCompletionLine` reads it out as `line.address` rather
than counting it, which shifts the index the way `readCallTarget` and
`readTargetPositionals` shift it; counted, it would hold positional index 0 and
put the cursor on the variadic `tail` where `callable` belongs. Which commands
accept one is carried in `POSITIONAL_ADDRESS_COMMANDS`, for the reason
`PRE_PARSE_GLOBALS` is carried: nothing on the command tree distinguishes those
arguments from an ordinary string.

## Pattern vocabulary

This is the half of the list that pays for itself. Every slot in this section
names something a deployed pattern owns, so the alternative to completing it is
a call to `cf piece verbs` or `cf cell get` and a read of what comes back.

### 4. Verb flags do not complete

A verb's own fields are the pattern author's vocabulary rather than the CLI's,
so this is the position where a caller has least to go on and completion has
most to give. Nothing is offered there.

Where "there" is, step 10 settled: the verb opens the callable's section and
its fields are written directly after the verb, with `--` closing that section
and opening the read step's.

```text
cf piece call --piece <piece> addItem --ti<TAB>
```

**The candidates and their slot are separable, and only the wiring is left.**
`shapeVerbFlagCandidates` in `lib/completion/verb-flags.ts` turns a listing
row's `inputSchema` into the flags the parser accepts: one per declared field,
kebab-cased, both spellings of a boolean, the value flags of a non-object input,
and the generic ones every verb takes. `--help` is among them, because it falls
inside the callable's section where it reaches the verb and prints that verb's
own page.

It reads `declaredVerbFlags` in `lib/exec-schema.ts`, which is the enumeration
the verb's help page renders. Two readers of one schema is how a flag comes to
be accepted by the parser and named by neither surface, or the reverse.

The module sits beside the providers rather than inside `providers.ts` because
reading a declared input resolves `callable.ts`, which costs about a third of a
whole static completion — and `providers.ts` is resolved on every Tab.

The wiring is what is left. `liveCandidates` dispatches on `option-value` and
`argument` slots only, so the position — the `tail` argument, past the callable
name — reaches no provider.

The slot past the marker is not this one. It belongs to the read options, and
completing it from the verb's declared result is item 6.

### 5. Result field paths for `get`, and why not for `wish`

`--select` takes comma-separated, dot-separated field paths into the value a
read returns, and `--schema` accepts the same spelling. On `cf cell get` both
complete, in the projection's own grammar rather than the
cell-path one: a list splits on `,` and a path on `.`, where `cellPathCandidates`
walks `/`. A segment ending in `@` asks for that position's address rather than
its value, and a bare `@` asks the read for its own, so both spellings of a
position are offered.

The vocabulary needs no request the slot does not already have: the value being
projected is the one at the piece and path the line names, which `getCellValue`
reads. A path below an array names a field of each element rather than an index,
because that is what a projection does with one and an index there is refused.
A key the concise grammar cannot carry is left out rather than offered in a form
that does not work.

**`wish` is refused, and the plan's own precondition is what refuses it.**
Resolving a wish writes. `resolveWish` runs a single-node pattern in the target
space and commits the cell it lands on, so the first Tab on a query that has not
been resolved before adds revisions to the space — measured against a local
server as 5 revisions, 2 commits and 4 heads for a query not seen before, where
`piece ls`, `get` and `piece verbs` each add none. A second Tab on the same
query adds nothing, because the cell is keyed by the query; a caller editing a
query writes once per spelling they pass through.

That is a keystroke with a side effect, which is the bar this item said to clear
before building it. **It is not cleared, and that is decided rather than
deferred: a durable write per distinct query is not acceptable at a keystroke.**
The slot stays empty. Completing it would need a resolution that reads without
committing — a change to `resolveWish`, and a question for whoever owns the
wish builtin rather than for this plan.

`call` and `exec` are the other two commands carrying these flags, and their
projection names positions in a verb's result rather than in the piece's root.
Completing them from the root would offer plausible names for a different value,
which is item 6's subject and not this one.

### 6. Result field paths for `call` and `exec`

The same flags on a call shape the verb's result, whose vocabulary is the verb's
`outputSchema` — carried by the same listing item 4 reads.

This one is not really a completion item, because the surface settles most of
it. [Naming the target](cli-surface-shape.md#naming-the-target) puts a
projection past the `--` that closes the callable's section, and therefore
always after the verb it shapes:

```text
cf piece call --piece <piece> addItem --title x -- --select it<TAB>
```

The verb is on the line ahead of the cursor, so the candidates come from the
`outputSchema` the listing in item 4 already carries, read from the words before
the cursor like every other slot. The slot itself is the one `--` opens, which
`resolveCompletionLine` reports as `passthrough` and `liveCandidates` does not
dispatch on.

What is left beyond that wiring is one improvement completion wants on its own
account. `resolveCompletionLine` derives two different things from
`words.slice(1, cursor)` — which slot the cursor is in, and which piece and verb
the line names — and only the first needs the prefix. Resolving the slot from
the prefix while gathering context from the whole line is what makes mid-line
editing complete against the position being edited rather than against the end
of the line. It is not load-bearing for this item, and it is still the
difference between a line that completes as it is typed and one that completes
however it is edited.

### 7. Slugs never complete

The `--piece` slot offers every slug the space's index records, then every piece
id. Both are values the flag takes, and the slug is the readable half of that
vocabulary, so it leads. The annotation says which a candidate is and, where the
slug resolves to a piece the listing named, what it points at.

`piece set-slug`'s slug positional completes the same set. Naming an existing
slug is refused unless `--force` says to take it, and that is the case
completion helps with: a name the caller means to move has to be spelled
exactly to be moved, while a slug being coined for the first time is a word
nothing can offer.

The listing is bounded by the space's index, which names slugs assigned since it
existed — so an older slug still resolves and is not offered. Nothing can
enumerate what it was never told the name of.

The slot asks for both listings, so `loadPieces` is called twice. Measured
against a local server across cold processes, one listing takes 333–347 ms and
both together 345–439 ms: the second rides the session the first opened, and
its cost sits under the run-to-run noise. A combined listing would be a new API
for no measured gain, so the two calls stay.

## The first link

### 8. `--space` has no source a caller recognizes

`--space` takes a space name or a DID, is required on every command that reads a
space, and has no environment fallback. Completion offers DIDs discovered from
local memory-v2 stores. Registered names are independent records, so the
discovered DID cannot reconstruct them. A caller who works in names therefore
gets candidates they can use but may not recognize.

Discovery is also positional: `candidateRoots` walks up from the working
directory looking for a store, so completion offers spaces in a checkout that
holds one and nothing in a worktree that does not — while both talk to the same
server.

[Naming the target](cli-surface-shape.md#naming-the-target) settles where the
*command* gets a space it was not given: `CF_SPACE`, with the flag overriding
it. Two candidate sources follow from that and need no further decision — the
ambient value itself, and the identity's home space, which is derivable from
`--identity` alone with no server and no local store and is where a profile
target resolves.

An ambient space also changes how much this slot matters. `--space` is written
to override rather than to state the usual case, so it is reached for less
often once it has a default.

What stays open is whether anything holds a space **name**. Local stores yield
DIDs and are the only source completion reads today; making them independent of
the working directory keeps those candidates and stops them depending on where
the caller stands, but they are still DIDs. The one source that could hold a
name is a record of the spaces this CLI has opened, written at the moment a
session resolves one — which is new state on disk, and the question of when an
entry expires. That is a decision rather than a task, and it is worth deferring
until `CF_SPACE` has been in use long enough to say whether the slot is still
reached for.

## Comprehension

### 9. A verb's annotation is its prose, falling back to its kind

`shapeVerbCandidates` annotates a candidate with the doc comment the author
wrote on the property — the same sentence `cf piece verbs` prints under the row
and the verb's help page opens with — taking its first line, which is what one
column of one row holds. The kind is the fallback where the author documented
nothing, so a candidate is never unannotated, and it is never derived from the
name: a listing that restates `addItem` as "add item" reports a caller's own
word back to them and calls it documentation.

### 10. Wrapper and deprecated verbs are marked

`cf piece verbs` hides `tier: "wrapper"` and `deprecated` rows unless `--all`,
and prints a note saying how many it held back. Completion offers them, because
both are callable and a name that works should be reachable — and marks them,
because two surfaces disagreeing silently is what is not defensible. The marks
lead the annotation: `[deprecated] Add one item.`

The two can coexist, and the listing joins them, so completion joins them the
same way — `[wrapper,deprecated]`. Picking one would be the same disagreement
in a narrower place.

## Felt cost

A completion that arrives late is experienced as one that did not arrive. These
two items are what a caller feels on slots that are otherwise working.

### 11. Every Tab costs two process starts

`bin/cf` runs `launcher.ts`, which spawns a second Deno process for the CLI, and
both start on every Tab. Measured against a local server from a warm checkout: a
purely static completion — subcommand names, no I/O at all — settles in about
0.34s, and a completion that reaches the fabric takes 0.44s to 1.2s. This agrees
with the figure `packages/cli/README.md` already records for the source path
against the compiled binary.

The compiled binary is declined for a reason that has nothing to do with
completion: nothing invalidates it, so a stale one rejects newer flags and skews
against an updated server. That reasoning is sound and this item does not
reopen it.

What has not been considered is whether the cost has to be paid per keystroke at
all. The static half of the surface needs no fabric and no piece listing, and
the live half re-reads the same listing on every Tab of the same line. Both are
shapes a cache or a resident process could serve, and both are decisions about
where state lives rather than about how fast a process starts.

Worth sizing before it is scheduled: it may be that the correctness and
vocabulary items above change the experience more than a faster Tab would.

### 12. The trailing space is inverted, not suppressed

Cell paths, link endpoints and projection paths complete one segment at a time
and emit a `nospace` directive so the cursor stays attached for the next
separator. `compopt` is the per-completion switch and it is bash 4 and later;
macOS ships bash 3.2, where the directive was simply inert. It cost a keystroke
*per segment*, on the deepest and most useful completion there is.

The space is now taken away by default and given back instead. The binding is
registered `complete -o nospace`, and a candidate that should END the word
carries its own trailing space, which bash inserts verbatim. One mechanism
serves bash 3.2 and bash 4 alike.

Three measurements against bash 3.2 through a pty decided the shape, and the
first two are why it is not the shape this item first proposed:

- A candidate carrying its own trailing **separator** does not help. `items/`
  inserts `items/ `, so the space falls after the separator rather than inside
  the path and the caller still deletes it. `complete -o filenames` does not
  change that — it suppresses the space only where the candidate names a
  directory that exists on disk — and it adds filename escaping to every
  candidate, so `#profile` reaches the line as `\#profile`.
- Re-registering the compspec from inside the completion function, the usual
  stand-in for `compopt`, takes effect one completion LATE. The first Tab gets
  a space and the second does not, which puts the option on the wrong slot.
- A candidate carrying its own trailing **space** under `-o nospace` inserts
  verbatim, colons and all, and an ambiguous set still inserts only the common
  prefix.

`$1` is the command word the compspec fired for, and it decides who gets the
space: the `deno` binding is registered without `-o nospace` and adds nothing,
because a line handed back to another completion has to keep that completion's
spacing. `compopt` is still called where it exists, since it is the only thing
that reaches that binding.

## Operator surface and CLI vocabulary

### 13. Space and entity positionals across `inspect`

Every `cf inspect` subcommand that reads a space completes it from the same
local stores `space clone` and `space fingerprint` read, and item 8's
disposition applies unchanged. The `<entity>` positional beside them completes
from `listEntityModels` — the listing `inspect entities` prints — annotated
with the label it reconstructs, so an opaque id reads.

The two sets are generated from a list of subcommand names rather than written
out as thirty-odd table entries, because which subcommands open a space is one
fact and repeating it is somewhere for the next one to be forgotten. Item 19's
gate is what names a subcommand the list has missed.

The entity provider reads local stores only. `--remote` fetches a snapshot over
the network before it can list anything, which is a round trip a keystroke
should not start.

### 14. `wish` targets and scopes

`cf wish <target>` completes the vocabulary its help enumerates — the profile
targets and the space-relative ones — and `--scope` completes `~`, `.`,
`profile` and the space provider's DIDs.

The target list is hand-maintained, because the vocabulary is the wish
builtin's rather than the command tree's and nothing on the tree carries it.
The command's help text is where it is documented and where it is kept in step.

`--scope` means something else on `cf inspect`, where it is a scope key. An
option provider is keyed by long name alone, so this one says which commands it
applies to — the same scoping `--from` needs, being a file on `space clone` and
a sequence number on `inspect diff`.

### 15. Remaining path-shaped and enumerable values

The mechanical remainder, each one an entry in an existing table: pattern files
for `piece set-home <main>`; files and directories for `piece getsrc <outpath>`,
`deps update <file>`, `fuse mount|unmount <mountpoint>`, `--dir`, `--out`,
`--output` and `space clone --from`; `--api-url`'s candidates for `--remote`;
and `piece map --format` and `inspect entities --kind` beside the four already
in `ENUMERATED_OPTION_VALUES`.

`--remote` is reachable only as `--remote=<value>`. Its value is optional
(`[url:string]`), so a bare `--remote` is legal and the word after it is a
positional rather than the flag's value — which is what the resolver reads it
as, and what the command reads it as too.

`piece set-slug <source>` is not in that enumeration and is completed with it:
it takes what `--piece` takes, which is the same table entry.

## Hygiene

### 16. Two provider entries that can never fire

`log-file` and `state-path` are gone from `OPTION_VALUE_PROVIDERS`. Both
belonged to `fuse-supervisor` and `fuse-daemon`, which take raw arguments and
declare no Cliffy options, and which completion drops from its subcommand
candidates as internal. Item 19's gate is the same subtraction made permanent.

### 17. The README table omits the top-level spellings

The completion table in `packages/cli/README.md` names `call`, `get` and `set`,
which are the spellings the surface leads with, and says that the `piece `
spellings complete identically. It is the document each item updates as it
lands, which is the obligation rather than the one edit.

## Mechanism

### 18. A live-provider test seam

`packages/cli/integration/completion-over-the-cli.sh` is where every provider
that reads state is exercised — the four that reach a fabric, the one that
reads local stores, the one that reads the environment, and the pattern-file
glob — at one of the slots it answers. The rest of the table hands the shell a
constant directive that a fabric cannot change, and those are asserted one by
one — kind and glob — in `test/completion-providers.serial.test.ts`, over a set
that file derives from the tree rather than remembers: a slot handing the shell
a directive that no case pins fails there. Item 19 adds the other half: whether
a slot has an entry at all.

`--space` is the one whose candidates depend on the machine, since it reads
what is on disk. That step reads `cf inspect spaces`' exit status as well as
its output — a command that failed and a machine with no store print the same
nothing — and probes the provider either way: with a store it must offer the
DID, without one it must come back empty and successful.

It deploys `pattern/completion-target.tsx`,
then asserts what a Tab offers at each slot of the chain, and runs in CI through
`integration.sh`'s `piece-call` section (`completion` is the standalone
selector). `test/completion-*.test.ts` stay the home for everything answerable
without a fabric.

Two rules the script holds to, both forced by completion's silence. A slot is
judged only after the equivalent `cf` command has been run against the same
target, so an empty candidate list reads as a defect rather than as an
unreachable fabric. And a candidate is judged by whether the command accepts it.

It carries `gap` assertions, on the `verb-session-gaps.sh` precedent, for the
slots below that answer nothing today: each fails loudly the day its slot starts
answering. The count is printed on the script's last line rather than restated
here.

The three questions no table walk can reach are settled there:

- `cellPathCandidates` **follows** a `$link` boundary rather than stopping at
  it, and the path that crosses one is a path `cf cell get` reads.
- Every id the `--piece` listing offers is one the same command reads back. The
  converse does not hold and is not a defect: the listing enumerates registered
  pieces, while a child piece is reached by the address its parent's result
  carries.
- A verb on both cells completes **once**, against the result cell — the same
  one the dispatcher reaches, which is the shadowing rule the verbs listing
  states.

One defect the script found that this list did not enumerate: the cell-path slot
offers a piece's callables, which `cf cell get` refuses and redirects to `cf piece call`.
It is asserted there as what happens today.

### 19. A gate that fails when a new slot has no decision

`deno task check-completion-slots` walks the same tree `resolveCompletionLine`
walks and subtracts the two provider tables from it, in three directions:

- A slot with no provider, no enumerated set, and no allowlist entry.
- A provider entry matching no slot — item 16's subtraction, made permanent.
- An allowlist entry that decides no slot, so the record of a decision cannot
  outlive the thing it was about.

A slot is one option on one command, not one option name. The scoped providers
carry the commands they answer on, and the gate asks about each command the
name is declared on separately: a `--from` answered on `space clone` says
nothing about the `--from` on `inspect diff`, and reading the key alone would
report the second as decided when what it offers is silence. The allowlist
takes the same two shapes — a bare long name where nothing provides the option
anywhere, and `<command path>:<long name>` for the commands where an option
that is provided elsewhere means something else.

It cannot decide that a slot *should* complete, and does not try. It requires
that every slot has been decided about, and the allowlist is where a decision
not to complete one is written down with its reason — what the candidates would
have been, and why there are none.

Its first run named thirty-six options and no positionals. Three of them turned
out to be path-shaped and got directives rather than an allowance
(`--pattern-coverage-dir`, `--timing-measures-out`, `--cfc-writeback-state`);
the rest are counts, timestamps, pasted identifiers, coined words, and
expressions with their own grammar.

Asking per command named twenty more. One took candidates — `piece repair
--list` names a piece, exactly as the `--list` on `piece survey` does. The rest
are recorded: the two sequence numbers `inspect diff` spells `--from` and
`--to`; the raw scope keys nine `inspect` subcommands take, which are read out
of the data being inspected the way `--session` already is; and the eight
projections that shape something other than the value at a target, which are
items 6 and 5's `wish` half rather than an omission.
