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
[`collection-naming/`](../collection-naming/README.md); a topic is cited as
`top/42`.

**Topics shows no topic's number for now.** `SHOW_TOPIC_NUMBERS` in `topic.tsx`
is off while only some topics have a number, and a topic then publishes no
`shortName`. That one absence covers every place a number shows, because every
one of them reads that property: the topic's header, the board's cards, the
survey rows, and the entries of whatever mention universe a topic's editor
completes over — the board's derived copies, or the topics themselves where a
topic is not yet rewired to that universe. So no pill shows a number and `#42`
offers no topic either way. The numbers themselves are untouched: the board
allocates one on every create, records it in `names`, lists it beside its topic
in `namesTable`, and `top/42` resolves. Wherever numbers are shown, a number
renders as a badge beside its topic's title rather than in place of it.

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
  universe row, which a mention's pill and a `#42` query read. A topic publishes
  it only while `SHOW_TOPIC_NUMBERS` is on, so while that is off none of them
  carries a number and the name is read from `namesTable` instead — the number
  is stored all the same. A topic reads nothing of its board to hold its number,
  which is what keeps a topic's reads out of its siblings.

  `backfillNames` is the step for a board that held topics before it numbered
  anything: it numbers every topic the namespace does not hold, in filing order,
  and asks every topic reporting no number to store the one the namespace holds
  for it, through that topic's own `recordName`. Asking is the most a board can
  do — a board writes a member's result and never a member's argument — so the
  step reports what it allocated and what it asked, and running it again
  completes whichever asking did not land. While numbers are hidden it cannot
  see what a topic stores, so it asks every topic every run; the asking writes
  nothing, because `recordName` reads the ungated input and declines a number
  already stored. `naming` is what the board declares about those numbers, so a
  consumer reads the promise rather than assuming one, and `namesTable` is the
  reverse lookup a caller uses to find the board's number for a topic by
  identity, including one that publishes none.

  Every demand for that property is declared OPTIONAL rather than defaulted, and
  the spelling is what lets the whole graft be applied over a board deployed
  before it: a defaulted property moves a row demand's defaults below an array
  constraint the compatibility proof cannot show stable under default insertion,
  while an optional one tolerates a topic that publishes none. Universe ROWS are
  the exception and carry the empty string, because they are copies the board
  writes rather than a demand on anything stored.
- **`mentionable` is a derived index, and its copies are the design.** Every
  topic on the board reads the mention universe — each child's editor
  autocompletes over it — so whatever `mentionable` is wired to is multiplied by
  the board's own size. Pointed at the topics themselves, every topic's walk
  crosses into every other topic, and document-granular delivery ships each
  sibling whole to serve two strings. The index bounds that product:
  `mentionableIndex` derives one small document of rows, each carrying a topic's
  display name, title and `shortName` as COPIES plus the topic itself as a
  reference. One derivation pays the board-wide walk, once per change, in place
  of every reader paying it on every load. The lift and its row type are shared
  with the collection-naming exemplar (`../collection-naming/mentionable.ts`):
  both boards derive their universe through the one derivation, so a member's
  number reads the same on either. A Topics row carries the empty name while
  Topics shows no numbers, because the copy is taken off a topic that publishes
  none.

  The reference is what a picked completion stores, and it is deliberately
  outside the demand a topic declares over the universe: a property that demand
  does not select is invisible to the walks that warm and watch a topic's
  argument, which is what keeps a topic's resume from reaching a sibling through
  its mention universe. The editor reaches it through its own contract, at the
  moment a completion is picked.

  `addTopic` wires the index into each topic it creates. A piece created before
  the index is rewired to it as a one-time link-bind; until then it reads the
  raw topics list — correct, at the cost the index exists to remove.
- **A declared schema is the only thing that bounds a read.** The transformer
  shrinks a derivation's input schema to the paths it can see the body reach,
  and gives up when it cannot: `topics.get().length` declares `items: unknown`
  and expands no topic, while the same count through a helper it cannot see into
  declares `items: true` and reads every topic whole — thread, verbs, and
  rendered UI included. That is how one derived value ends up reading the whole
  space. So every derivation here is a module-scope `lift`, because a `lift`'s
  declared parameter type is a ceiling an opaque helper cannot widen.

  Four derivations run over the whole board, and each declares only what it
  reads. `crossrefTable` takes one list of references per topic and builds the
  mention pivot from it; `cardsByActivity` takes a single timestamp per topic
  and orders the cards by it; `mentionableIndex` takes the three display strings
  per topic and builds the mention universe; `namesTable` takes the namespace
  map and builds one row per numbered member, for a caller's reverse lookup,
  without reading through any of them. None expands a topic's prose, thread,
  verbs, or rendered UI.

  A lift's parameter and its result look like one type, which seems to force a
  choice: narrow the parameter to bound the read, and what comes out narrows
  with it, so a card could no longer render a body snippet. It is not a real
  choice, and it is not settled by a cast either. A generic lift states the two
  separately — the CONSTRAINT is what the body reads, the type parameter is what
  the caller handed in — and a reference that passes through resolves to the
  whole topic however little the lift declared. `cardsByActivity` is written
  that way: it reads one timestamp and gives back the topics themselves.

  What each reader of a topic gets is then its own declared schema's business.
  The published `index` declares the six scalars a survey reads, so a survey
  cannot expand a topic past them, while the card list's argument schema is
  shrunk to the handful of fields its body renders. Neither widens the topic,
  which is what leaves both free to be that narrow — and it is why every field a
  card renders carries a default, since that schema is what a piece holding
  older topics is updated against.

  The rule for new code stands regardless: prefer a scalar reduction
  (`topics.get().length`) over anything that hands the array to a helper.
- **Row identity is a cell, not an array position.** Each row goes in a cell
  caused by the topic it describes, and the rows array holds links to those
  cells rather than the row values inline. The card list is a mapped
  sub-pattern, and `map` keys its element runs by each element's normalized
  link: a link resolves to the row's own entity and stays the same wherever the
  row sits, while an inline value resolves to the array position. Because the
  board sorts by activity, every append is a prepend — with inline rows, one new
  topic re-keys every card and rebuilds its whole subtree.
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
- **A reference is a cell, and identity is the only thing compared.** The board
  derives the whole graph once, in `crossrefTable`, from the same topics array
  read under two minimal declared views: one for identity, one for what each
  topic points at. Matching is a scan of `equals`, because nothing in the
  pattern API turns a topic reference into a resolved key carrying space, scope,
  and path. The comparisons come from two passes. Finding the distinct topics,
  in `distinctByIdentity`, compares each of the board's `n` entries with the
  distinct entries kept before it, at most `n(n - 1) / 2` comparisons, which
  grows with the square of the topic count even on a board with no mentions.
  Each distinct topic's row then checks every source's mentions for that topic,
  which grows as the number of topics times the number of mentions.

  Each topic then does a lookup rather than the join: `backlinksOf` scans the
  pivot for the row whose topic is itself, and takes that row's `mentionedBy`.
  The scan compares a field nested inside a row, and what lets it is that row's
  declaration — the field is declared a `ComparableCell`, the annotation that
  makes it arrive as something `equals` can follow rather than a value to look
  at. The published row declares both sides `unknown` instead, so a consumer
  that only carries the graph onward expands neither.

  The pivot works over the board's distinct topics, with distinctness decided by
  the same `equals`: a topic the board lists at two entries, whether as the same
  link twice or as a link and an alias of it, has one row, so its lookup returns
  its backlinks once, and counts once as a source in the rows of the topics it
  mentions, at the place of its first entry. Every row is addressed by the topic
  it describes (`Writable.for(topic)`), so a row keeps its identity however the
  board is reordered, and a lookup re-run by an unrelated change recomputes the
  same links at the same address and writes nothing.
- **Agents reference through a verb.** `mention` and `unmention` take the piece
  itself. With prose no longer scanned there is otherwise no headless way to
  make a reference, and `kind: "topic"` links are ordinary links unless their
  URL resolves.
- **Nothing derived is persisted.** The index and the reference graph are
  recomputed from the board on read; no derived field is written back into a
  topic, so retracting a mention simply removes the edge. A pattern that writes
  derived data into its own children can destroy real data when it runs from a
  partial-view replica, so any future persisted index needs single-writer +
  full-view preconditions first.
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
# Idempotent. While `SHOW_TOPIC_NUMBERS` is off the step cannot see what a topic
# stores, so `named` is empty and `pending` holds every topic however many runs
# have gone by: re-run until `assigned` is empty, and read one topic's stored
# number from its own input. The three empty lists below are what this returns
# once numbers are shown again.
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
# do. Idempotent, and refused where it disagrees with what the topic stores.
cf piece call --cell <topic> recordName '{"name":"42"}'
# -> { "result": { "name": "42", "wrote": true } }
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
reason the design stamps rather than deletes: it is a max over what the arrays
hold, so removing the newest comment outright would move a topic _backwards_ in
the board's most-recent ordering. A stamped record keeps its `sentAt` in that
max, and the retraction's own stamp moves the clock forward.

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
create allocated, as written to the namespace and passed into the topic — for
two reasons: the row IS the created topic, so reading a property off a piece
filed a moment ago waits for that piece to materialize, and the topic publishes
no `shortName` at all while numbers are hidden. `backfillNames` returns three
lists of numbers in filing order: `assigned`, what it wrote into the namespace;
`named`, the topics it found already reporting theirs; and `pending`, the ones
it asked, none of which it can confirm. While numbers are hidden `named` is
always empty and `pending` holds every listed topic, which is what
`BackfillNamesResult` states and what an operator reads around. `addComment` and
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
