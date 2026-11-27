# Topics

A multi-user tracker over **#topic** pieces — durable units of shared attention.
A topic is a title, a **living body document** (durable conclusions get folded
up into the body; the thread holds the deliberation), a flat chronological
comment thread, and typed links out to other core objects (PRs, agent sessions,
other topics — URLs in v0).

The board publishes an **index**: one row per topic carrying the topic's
canonical address, a reference to the topic itself, and the scalars a survey
reads (`title`, `createdAt`, `createdBy`, `commentCount`, `lastActivityAt`,
`shortName`). The same rows render the board's cards, so a headless survey and
the rendered board read one derivation rather than two.

The board also **names its members**. It owns a namespace of decimal names,
dense from `1` and never reused, through the library in
[`product/collection-naming/`](../../product/collection-naming/README.md); a
topic is cited as `top/42`.

**A topic publishes the number it stores**, as `shortName`, and one property is
what every place a number shows reads: the topic's header, the board's cards,
the survey rows, and the entries of whatever mention universe a topic's editor
completes over — the board's derived copies, or the topics themselves where a
topic is not yet rewired to that universe. So a mention's pill shows the number
and `#42` offers the topic storing it. A topic nobody has numbered publishes
none, and every one of those surfaces reads nothing for it. A number renders as
a badge beside its topic's title rather than in place of it.

Topics reference each other. A reference is a **cell**, not a string: picking a
completion in the body editor stores the destination piece itself, and a link
whose URL names a piece resolves to that piece. Nothing scans prose for pasted
addresses, so a reference survives a rename, a move, and a redirect, and there
is no id to mint or keep in step.

Deliberately absent until reached for: statuses (not even open/closed), labels,
assignees, attachments, nesting. What a topic grows next is part of the
experiment.

This is the first wedge of Common Fabric's internal dogfooding program — the
team's own issue-tracker replacement, built on the platform it tracks. The
project's live design record is the "Build Topics v0" topic itself (bootstrap
lineage: Linear CT-1878, which this pattern exists to absorb).

## Design commitments

- **One principal, explicit actor.** Fabric authenticates every write with the
  identity key that made it. In the short-term agent model, that key belongs to
  the human user; an agent also supplies `agentName` in the same mutation event.
  Topics stores a structured `{ kind: "agent", name }` snapshot so the UI can
  say “Sol (agent)” without pretending the agent has a separate principal.
- **Profile-native browser authorship.** Human-facing controls use the current
  viewer's canonical `#profile` name/avatar and store a `{ kind: "person", … }`
  snapshot. There is no free-text “commenting as” field.
- **Wish-free agent handlers.** CLI streams do not depend on profile wishes.
  Every authored-content verb requires a non-blank `agentName`, and the
  signature is carried in the same event as the content, avoiding shared mutable
  attribution state. `mention` and `unmention` carry no authored content, so
  they take only the referenced piece; Fabric still retains the authenticated
  principal behind the edge. `recordName` carries none either: the number it
  stores is the board's allocation rather than something a caller authored.
- **Mergeable writes everywhere users collide**: comments, links, and topics are
  `push` appends; concurrent writers all land. The body and the title are single
  strings (whole-value conflict semantics), so both edit through an explicit
  Edit→Save flow rather than a live binding — and both saves stamp attribution
  and move the activity clock through the same core the headless verb uses, so a
  browser edit can never leave `bodyUpdatedBy` or `titleUpdatedBy` describing an
  earlier write.
- **Fabric owns history and concurrency.** Topics adds neither an activity-log
  duplicate nor an application-level revision/CAS protocol. If Fabric cannot
  preserve history or safely arbitrate concurrent body writes, this dogfood
  surface should expose the framework gap rather than conceal it mechanically.
- **Stored compatibility is explicit.** Durable records may lack a structured
  author snapshot, so stored author fields remain optional or defaulted. Every
  current authored-content verb writes structured attribution; the public result
  and mutation contracts contain no mutable "current author" state or
  display-name mirrors.
- **Topic state upgrades run in order.** Running a Topic runs an upgrade lift,
  even without a consumer reading its result. The input `topicStateVersion`
  defaults to zero; pending steps run in order, and each records its new version
  after its writes in the same transaction. Every durable mutation uses the same
  upgrade function before writing. Both board creation paths stamp the current
  version. A stored future or invalid version makes the lift inert and durable
  mutations reject; session editor controls remain available.
- **The first upgrade preserves legacy attribution.** It fills missing
  structured names from `createdByName` and comment `authorName`, retaining
  nonblank structured names, kinds, avatars, legacy fields, and comment
  identity. Partially populated author objects retain their other properties;
  absent or explicitly undefined authors receive new objects. Names without a
  known kind receive `kind: "legacy"`. Blank strings and the trimmed placeholder
  `"someone"` supply no attribution. Legacy inputs stay `unknown`; explicit
  reader schemas materialize strings and keep other values opaque and unchanged.
  Every source and destination is read through handles before the first write.
  In the lift, unresolved linked comments or names suspend the step until data
  arrives. Handlers can conflate absence with unresolved data; ambiguous reads
  leave the step incomplete without author writes or a version stamp. Content
  edits can still proceed on version-zero state when their own inputs are
  available. The lift completes genuine absence, while a standalone handler
  needs unambiguous inputs to complete migration. Once complete, later legacy
  writes are outside this pass.

  [State upgrade design](state-upgrades.md) describes the sequence, mutation
  boundary, schema bindings, tests, and rollback limits. Legacy writers must be
  retired before rollout. Source rollback preserves stored data; only code that
  implements the version guard can refuse writes to a newer state version.
- **Each topic stores the number the board calls it by, and every reader reaches
  it the same way.** `addTopic` allocates the next number and passes it into the
  topic it is creating, in the same transaction as the append, so no reader
  observes a topic without its number and two concurrent creates serialize on
  the map's keys rather than taking the same one; the browser composer allocates
  through the same call. The namespace is one map cell,
  `names: { "42": <topic> }`, written one key at a time and holding each topic
  as an unread reference, so surveying its keys expands no topic. A topic
  publishes what it stores as `shortName`, and every reader reaches the number
  through that one property: the survey row, the card badge, and the mention
  universe row, which a mention's pill and a `#42` query read. A topic reads
  nothing of its board to hold its number, which is what keeps a topic's reads
  out of its siblings.

  `backfillNames` is the step for a board that held topics before it numbered
  anything: it numbers every topic the namespace does not hold, in filing order,
  and asks every topic reporting no number to store the one the namespace holds
  for it, through that topic's own `recordName`. Asking is the most a board can
  do — a board writes a member's result and never a member's argument — so the
  step reports what it allocated, what it found already stored, and what it
  asked, and running it again completes whichever asking did not land. An empty
  `pending` is the finished state, and a topic's published number is the signal
  the step reads to reach it. A repeat over a board in that state writes nothing
  at all — no namespace key and no event. Where a topic is still outstanding the
  repeat is safe but not free: the step asks it again, that asking is itself a
  write, and the topic stores the number if it has not already. `naming` is what
  the board declares about those numbers, so a consumer reads the promise rather
  than assuming one, and `namesTable` is the reverse lookup a caller uses to
  find the board's number for a topic by identity, including one that publishes
  none.

  Every demand for that property is declared OPTIONAL rather than defaulted, and
  the spelling is what lets the whole graft be applied over a board deployed
  before it: a defaulted property moves a row demand's defaults below an array
  constraint the compatibility proof cannot show stable under default insertion,
  while an optional one tolerates a topic that publishes none. Universe ROWS are
  the exception and carry the empty string, because they are copies the board
  writes rather than a demand on anything stored.
- **The board's topics are an indexed collection.** The board holds no list of
  its topics. `addTopic` adds each topic to an
  [indexed collection](../../../docs/features/indexed-collections.md), which
  mirrors what a listing shows of a topic into a SQLite table named `topics`:
  its title, body, number, creation and activity instants, comment count, and
  who filed it. Every listing is a query over that table, so none of them reads
  a topic: the cards, most recently active first, fifty at first and fifty
  more each time a session presses "Show more…"; the topic count; the
  mention universe; and the `topics` and `index` outputs, which carry each topic
  as a reference.

  A topic holds the board's handle, so that it can ask which topics mention it,
  and the board publishes the handle as `board` so that a topic can be linked to
  it. Holding the handle does not let a topic, or anything else it is linked
  into, write the board: the collection names a guard that only the board's own
  ways of adding a topic may write, which are `addTopic`, `adoptTopics`,
  `backfillNames` and the composer's submit.

  What the collection mirrors is state a verb stores, so it follows a topic that
  is not running. That is why a topic publishes `filedBy`, the author as the
  create stored it, beside `createdBy`, which a running topic derives from it.

  A topic `addTopic` has just created has no fields to mirror until it has been
  set up, which happens after the create's transaction. For that moment its row
  is there with its columns unset, and it sorts last in `topics` and `index`,
  where its number will put it.
- **`mentionable` is rows read out of the collection.** Every topic on the board
  reads the mention universe, since each child's editor autocompletes over it,
  so whatever `mentionable` holds is multiplied by the board's own size. It
  holds one small row per topic: the display name, the title and the number as
  copies, and the topic itself as a reference (`MentionableRow` in
  `../../product/collection-naming/mentionable.ts`). A row carries the empty
  name for a topic that has no number.

  The reference is what a picked completion stores, and it is deliberately
  outside the demand a topic declares over the universe: a property that demand
  does not select is invisible to the walks that warm and watch a topic's
  argument, which is what keeps a topic's resume from reaching a sibling through
  its mention universe. The editor reaches it through its own contract, at the
  moment a completion is picked.
- **A card's strings are derived once for the cards shown.** The card list is a
  mapped sub-pattern, and every helper call or conditional in a mapped body,
  such as `snippet(card.body)`, `topicAuthorLabel(card.createdBy)` or a ternary,
  compiles to a computed cell of its own, minted per card, persisted per session
  and watched by every reader. `cardRowsOf` formats the badge, title, snippet
  and caption of every row the card query returns in one computation, and the
  card keeps only the two conditionals it cannot precompute: the badge and the
  snippet line are present or absent.
- **A board that held its topics as a list adopts them.** The `topics` input is
  read by two verbs and by nothing else. `adoptTopics` adds listed topics to the
  collection, at most `ADOPT_BATCH` (200) a call: it takes the position to start
  from, `from`, and returns `next`, the position to call it with again, until a
  call returns none. `backfillNames` adds every listed topic before it numbers
  them, and numbers the topics the collection holds as well, which is every
  topic of a board that never kept a list. Until one of them has run, such a
  board shows no topics.

  The batch bounds one transaction. Each adopted topic costs a read of its
  mirrored fields and up to seven database statements in the call's transaction,
  and on a copy of the team's board, adopting all 3,281 topics in one call kept
  a serving worker busy past the 60 seconds its host waits, so the host ended
  the worker and ran the call again, without end. `backfillNames` adopts the
  whole list in its one transaction, so a large board adopts through
  `adoptTopics` first.

  A topic filed before the board held a collection also has nothing bound to its
  `board` input, so it shows no backlinks. `scripts/topics-bind-board.ts` links
  each such topic's `board` to the board's, once the topic runs the pattern that
  declares it, and refuses a topic whose `board` already reaches another board's
  collection. The restore tooling (`scripts/topics-rehearsal-lib.ts`) relinks
  `board` on a topic that declares it and leaves it out on one that predates it,
  and retires `boardCrossrefs` and `boardCrossrefIndex` on a topic that no
  longer declares them.
- **An existing board moves to this pattern by being recreated.** Its space is
  exported from a snapshot with `scripts/topics-export.ts`, a board is deployed
  fresh from `main.tsx`, and `scripts/topics-recreate.ts` files every exported
  topic through the new board's `addTopic`, in number order, and then writes the
  export's content into it: title, body, comments, links, creation and activity
  times, authors, and its `mentioned` list and the body's `[Label][key]`
  mentions (`references`), pointed at the recreated topics. The export's numbers
  run densely from 1, so each topic keeps its number. Each recreated topic is a
  new piece, wired to the new board by its create, so none of the old topics'
  wiring has to be carried across, and the board's collection holds every topic
  from its create onward. The old board and topics are left as they were.

  Moving the topics in place does not work for all of them: a topic that
  `addTopic` linked straight to the old board's computed `crossrefIndex` refuses
  the new `topic.tsx` ("readonly capability cannot be exposed as an ordinary
  alias"), which was 17 of the team board's 3,281.
- **Authoring: cf-code-editor in the Edit→Save draft flow.** The editor binds
  the session-local `bodyDraft` (never live to the shared string — whole-value
  conflict semantics hold) with `@`-mention autocomplete over `mentionable`, and
  `$references` — the map where a picked completion stores its destination. The
  read view renders the body as markdown.
- **The mention map is staged with the prose, not written through it.** The
  editor writes an entry the instant a mention is inserted and drops one the
  instant its token leaves the document, neither waiting for Save. Both bindings
  therefore address session drafts: `bodyDraft` and `referencesDraft`, seeded
  together by Edit and published together by Save. Pointing `$references` at the
  durable map instead would make Cancel non-transactional in both directions — a
  discarded insertion would leave an edge no token names, and a discarded
  deletion would strip the destination out from under a token the durable body
  still carries. Each `destination` survives the two copies because it is
  declared `unknown`, which is what carries a reference across a whole-value
  read and write instead of expanding the piece behind it.
- **A reference is a cell, and the graph is two relation tables.** The
  collection mirrors what each topic points at into `topics_mentioned`, the
  pieces the `mention` verb stored, and `topics_mentions`, everything the topic
  derives from its prose, its links and that list. Both are indexed on the topic
  referred to, so "which topics mention this one" is a lookup.

  Each topic asks that question of the collection itself, by its own reference
  (`MENTIONED_BY_SQL` in `topic.tsx`), and publishes the answer as
  `referencedBy`: every topic that mentions it, once, never itself, in filing
  order, up to two hundred. The board publishes the whole graph as `crossrefs`
  and `crossrefIndex`, derived from the same tables for a reader that asks for
  them; no topic reads either.

  `topics_mentioned` follows a `mention` or `unmention` as soon as it commits.
  `topics_mentions` follows the topic's derivation, which runs when something
  reads the topic, so a reference made in the prose or by a link reaches the
  graph once the topic it was made on has been read. A read of `referencedBy`
  made in the instant after a `mention` can still return the earlier answer: the
  collection follows the commit, and the query follows the collection.
- **Agents reference through a verb.** `mention` and `unmention` take the piece
  itself. With prose no longer scanned there is otherwise no headless way to
  make a reference, and `kind: "topic"` links are ordinary links unless their
  URL resolves.
- **The collection is derived, and the board writes nothing into a topic.** The
  tables are a mirror the runtime maintains from the topics, so retracting a
  mention removes the edge and nothing else needs undoing.
- **A topic keeps two summaries of its own records.** `commentCount` and
  `lastActivityAt` are stored on the topic, because the board's collection
  mirrors them without running the topic, and a topic written to by an agent is
  often never run again. The topic's own verbs keep them, in the same write as
  the comment, link, body or title change they summarize, so no writer running
  this module has to run the topic afterwards for the board to be right. A
  writer still on an older topic module does not keep them, so they are reliable
  once every writer runs this one (`state-upgrades.md`, "Rollout and rollback").
  Keeping them costs concurrency on one topic: every such verb reads and writes
  the activity time, so two writes to the same topic at once conflict on it
  where two comment appends alone would merge, and the later one runs again
  against the committed state (the scheduler's stale-basis retry) rather than
  merging. A topic stored before they were kept gets them from the
  `activity-scalars` upgrade step (`state-upgrades.md`), which computes both
  from the topic's own records. That step runs once, so a value it computed from
  incomplete reads would stay wrong: only the lift completes it, reaching each
  array and each stamp through a key, which waits for an unresolved link rather
  than reading it as absent or as its default.
- Verified by `multi-user.test.tsx` (two isolated runtimes, one shared board).

## Headless / agent use

Agents are first-class participants. To survey Topics, read the projected board
`index` as described below. To discover a piece's readable fields and
operations, use `cf piece describe --cell <piece>`; `cf cell get` reads field
values. To choose an operation to call, use
`cf piece verbs --cell <piece> --json`, which carries the deployed pattern
reference and every verb's prose and schemas. Treat that pinned pattern as
authoritative for the contract. Once a verb is chosen, its own page is
`cf piece call --cell <piece> <verb> --help --json`. Discovery and per-verb help
run in separate cold CLI processes; choose the command relevant to the task. The
default verb listing is the contract surface; `--all` additionally shows UI
wrappers and deprecated verbs. Against a deployed board piece:

```bash
# The read options follow the `--` marker, which closes the verb's own
# section; before the verb the CLI exits 2. The projection names BOTH results,
# because one naming only `topic` drops `name` from the envelope.
cf piece call --cell <board> addTopic \
  '{"title":"...","body":"the initial living document","agentName":"Sol"}' \
  -- --schema '{"properties":{"topic":{"$link":true},"name":{"type":"string"}}}'
# -> { "result": { "name": "1", "topic": { "$link": "/of:fid1:..." } } }
cf cell get --cell <board> names
# -> { "1": {} }
# Idempotent. Re-run until `pending` comes back empty, which is the finished
# state: every listed topic publishes the number the namespace holds for it.
cf piece call --cell <board> backfillNames '{"agentName":"Sol"}'
# -> { "result": { "assigned": [], "named": ["1","2"], "pending": [] } }
cf cell get --cell <topic> shortName --input
# -> "1"
cf cell get --cell <board> topics --input \
  --select title,createdAt,lastActivityAt,commentCount
cf piece call --cell <topic> addComment \
  '{"body":"point-in-time progress update","agentName":"Sol"}'
cf piece call --cell <topic> setBody \
  '{"body":"latest state plus the topic narrative","agentName":"Sol"}'
cf piece call --cell <topic> setTitle \
  '{"title":"a sharper name for the same attention","agentName":"Sol"}'
cf piece call --cell <topic> addLink \
  '{"url":"https://github.com/org/repo/pull/123","kind":"pr","label":"PR #123","agentName":"Sol"}'
cf piece call --cell <topic> mention '{"topic":"/of:fid1:other-topic"}'
cf piece call --cell <topic> unmention '{"topic":"/of:fid1:other-topic"}'
# Store a number on one topic, which is what `backfillNames` asks each topic to
# do. Idempotent, and refused where it disagrees with what the topic stores —
# so against this flow's topic 1, which the create already numbered, the number
# the namespace holds for it is the one that answers.
cf piece call --cell <topic> recordName '{"name":"1"}'
# -> { "result": { "name": "1", "wrote": false } }   already stored
# `wrote: true` comes back only from a topic holding no number yet: one filed
# before the board numbered anything, which is what `backfillNames` is for.
cf piece call --cell <topic> removeLink \
  '{"url":"https://github.com/org/repo/pull/123","agentName":"Sol"}'
```

`addLink` requires `url` and `agentName`; `kind` defaults to `"web"`, and a
blank or omitted `label` defaults to the URL. `setTitle` renames with
attribution: it stamps `titleUpdatedBy`/`titleUpdatedAt` and moves
`lastActivityAt`, so a renamed topic surfaces in the board's most-recent sort.
It lives on the topic's direct interface rather than the shared `TopicPiece`
projection: a holder's required demands are write-once, so a verb added to the
projection every board embeds would refuse those boards' updates. Address the
topic itself and the verb is there.

**A retraction stamps the record; nothing is deleted.** `removeComment` and
`removeLink` write `removedAt` and `removedBy` onto the stored record and leave
it where it is, and `editComment` revises a body while stamping `editedAt` and
leaving `author` and `sentAt` alone. A reader hides a retracted record,
`commentCount` stops counting it, and a retracted link stops resolving into
`mentions` — the reference goes with the link that made it.

`lastActivityAt` is the one reader that does not filter them, and that is the
reason the design stamps rather than deletes: it is the newest stamp across what
the arrays hold, so removing the newest comment outright would move a topic
_backwards_ in the board's most-recent ordering. A stamped record keeps its
`sentAt` in that max, and the retraction's own stamp moves the clock forward.
The verbs keep it the same way: each moves it to its own stamp only when that is
newer.

All three live on the topic's direct interface for the same reason `setTitle`
does. `removeComment` and `editComment` name their target by reference, which is
what the no-minted-id rule prepared for — a caller passes the stored element,
and the UI hands one over from the row it is rendering. `removeLink`
additionally accepts `url`, because a link record is not a piece and carries no
fid for a CLI caller to name; it retracts the most recently added link still
present with that URL, so retracting twice retracts two.

`mention` and `unmention` take a canonical piece reference in the inline JSON
event. The CLI recognizes the declared reference position and turns `/of:...`
into the live piece link; neither verb takes `agentName` or returns a value. Do
not use `-- --topic /of:...`: the schema-derived flag parses its declared object
before reference resolution and rejects a bare address.

**A full-board survey is one bounded read of `index`.** Each row IS the topic it
describes, declared through a schema of scalar summaries (`title`, `createdAt`,
`createdBy`, `commentCount`, `lastActivityAt`, `shortName`). The declared schema
is the bound, so the read cannot expand a topic's body, thread, or verbs no
matter how it is projected.

```bash
cf cell get --cell <board> index --step
```

A row's own address is the address of the topic it describes — the one to pass
as `--cell` for that topic's own reads and verbs. Reading the `index` path with
`--select @,title` resolves it. An address names a position and a filtered
array's survivors no longer say which positions they came from, so `@` and
`--filter` do not combine: read the index, which the row schema keeps narrow
enough to read whole, and pick the row you want.

The board input is declared through `TopicDemand`: the card/index fields and
reference-graph inputs, with no Topic verbs or full thread. Targeted headless
discovery beyond the index should combine an exact/range `--filter` with a
concise `--select`, then address one Topic directly for its body, comments,
links, and verbs:

```bash
cf cell get --cell <board> index --step \
  --select @,title,lastActivityAt,commentCount
cf cell get --cell <board> topics --input \
  --filter '.lastActivityAt >= <epoch-milliseconds>' \
  --select title,lastActivityAt,commentCount,createdBy.kind,createdBy.name
cf cell get --cell <topic> comments --input \
  --filter '.author.name == "Sol"' \
  --select sentAt,author.kind,author.name,body
cf cell get --cell <topic> links --input \
  --filter '.kind == "pr"' --select kind,url,label,addedAt
```

Filtering happens before projection and preserves list order. The jq-inspired
predicate subset supports paths, JSON literals, comparisons, boolean operators,
and parentheses; it does not provide substring search, regexes, sorting, or an
arbitrary jq pipeline. These transforms execute as a session-scoped computed
pattern expression, so their CFC metadata behavior matches authored
filter/map/lift expressions. The durable `topics --input` list remains evidence
when the computed `index --step` read cannot materialize, but only a successful
index row supplies a Topic's address.

Every agent-authored content mutation carries `agentName`; there is no preceding
“set current name” call. Fabric's operation history retains the authenticated
human principal, while the stored snapshot disambiguates which agent acted.
Reference-only `mention` and `unmention` calls are not content authorship and
carry no agent signature.

**Every content verb returns what it recorded** — `mention` and `unmention` sit
outside the claim: they record an edge, a reference with nothing resolved about
it, and return nothing. `addTopic` returns the topic it created — the piece
itself, reaching the caller as a link the CLI renders as an address, so the
caller addresses the new topic straight from the create instead of filing it and
then searching the board for it. The result is declared through the index's row
schema rather than the full topic: the declared schema bounds the default
readback, and every name a verb's result publishes is permanent, so the create
hands back the survey row plus the write-time facts only the pattern could
resolve (`createdAt`, `createdBy`). `name` rides beside it — the number the
create allocated, as written to the namespace and passed into the topic —
because the row IS the created topic, so reading its `shortName` waits for that
piece to materialize. `backfillNames` returns three lists of numbers in filing
order: `assigned`, what it wrote into the namespace; `named`, the topics it
found already publishing theirs; and `pending`, the ones it asked, none of which
it can confirm. An empty `pending` is the finished state. `addComment` and
`addLink` return the appended record, `setBody` the persisted body plus the
attribution it wrote, `setTitle` the persisted title plus its attribution; each
carries fields the pattern resolved that a caller cannot compute for itself.
Counts are deliberately not returned: these appends are mergeable ops, so a
length observed inside one handling is not a fact about the resulting list —
read `commentCount` when you want the count.

A returned value reaches the caller through the handling's receipt. A result
carrying a piece (`addTopic`) travels the result-pattern projection path; the
plain records (`addComment`, `addLink`, `setBody`, `setTitle`) project into the
receipt under `plainResultReceipts`, which is on by default
(`docs/development/EXPERIMENTAL_OPTIONS.md`). Setting
`EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false` restores the discard, and those verbs
then still perform their write and simply report no result.

`addTopic` takes the body at create (optional): a topic born with a body appears
with it atomically — no reader observes a title-only halfway state, and no
follow-up `setBody` is needed to finish filing (the verb contract's atomic-unit
rule, `docs/plans/pattern-verb-contract.md`). Body-at-create is not a body
_update_: `bodyUpdatedBy`/`bodyUpdatedAt` stay unset.

Invalid mutations **throw** instead of silently returning (verb contract rule
4): an empty title, an empty comment body, a blank or non-http(s) link URL, a
blank `agentName` on an authored-content verb — `backfillNames` included, which
writes the namespace on someone's behalf — and a `recordName` naming something
outside the number grammar or disagreeing with the number the topic already
stores, all surface as a failed call — a nonzero CLI exit — never as apparent
success. The UI composer wrappers keep their silent guards: an empty draft is a
non-event in a composer, not a headless mutation.

## From the command line

[`tools/`](tools/README.md) holds `deno task topics`, the team's command-line
client for the board: it keeps a local copy of the board's documents, searches
it, and runs the verbs above through `cf piece call`.
