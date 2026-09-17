# Collection naming: the first customer

The build plan for [Naming in collections](../specs/collection-naming.md),
carried by a parallel exemplar so that the Topics board is touched once, at
the end, by a diff the exemplar has already proven. Member names are what the
spec calls them; for the exemplar and for Topics they are decimal numbers, so a
member is cited as `top/42`.

## Where this stands — read this first

This block is LIVE: the change that moves a stage updates it here.

| stage | state |
| --- | --- |
| S0 — decisions ruled, plan filed | on main (#6882) |
| S1 — the library and the exemplar board own a member namespace | on main (#6882) |
| S1b — index rows are the members | on main (#6886) |
| S2 — `top/42` resolves at the CLI | on main (#6890) |
| S2b — assignment refuses by default | on main (#6898) |
| S3 — the shell opens `/<space>/top/42` | on main (#6896) |
| S4 — `#42` in text | on main (#6887) |
| S6 — graft onto Topics | items 1, 2, 3, 5 on main (#6937), with what items 2 and 3 show hidden on Topics since 2026-09-17 (below); item 4 rehearsed twice and held, awaiting a demand for named Topics rather than a technical answer |
| S6b — a Topic stores its own number | built; awaiting review and merge |
| S5 — deferred, not scheduled | — |

### Built 2026-09-17: a Topic stores its own number

A topic takes the number its board calls it by as an ordinary input and
reports that. It reads no board table to learn it, and the `boardNames` input
is gone from `topic.tsx` altogether, so no topic reaches a sibling topic on
account of its own number. `addTopic` and the browser composer allocate over
the board's namespace and pass the number into the topic in the transaction
that creates it, the way the exemplar's `addItem` does. A topic nobody has
numbered stores nothing, reports nothing, and renders without failing.

The board's `backfillNames` is now the whole of the operator procedure for the
topics filed before the namespace. It numbers every topic the namespace does
not hold and asks every topic reporting no number to store the one the
namespace holds for it, by sending that number to the topic's own
`recordName` — the one thing a member must provide for `recordNames` in
`naming.ts` to reach it, and the verb an operator can also call directly. A
board cannot confirm that asking inside the transaction that makes it, so the
step returns `assigned`, `named` and `pending`, and a run leaving a non-empty
`pending` is completed by running it again. The per-topic `cf piece link` of
`namesTable` that decision 13 accepted is no longer part of any Topics
procedure; the operator procedure as it now stands, including what it has not
been rehearsed for, is
[`namespace-backfill.md`](../../skills/topics/references/namespace-backfill.md).

Two things it leaves as they were, and one it leaves behind. The namespace is
still what a number is allocated over, and `namesTable` is still the reverse
lookup a caller uses to find the board's number for a topic by identity,
including one that stores none. The exemplar's `item.tsx` declares no
`recordName`, so its board goes on calling `backfillNames` and a member a
backfill numbers there still stores nothing. And `ownName` in `naming.ts` now
has no pattern reading it: it is the lift a member would use to read its name
out of a board table, and no member does — the exemplar stores its name, and
Topics now does too.

### What remains, and none of it is built

The stages the table marks on main give a collection that adopts `naming.ts`
member names end to end: allocation, resolution at the CLI, the shell opening
`/<space>/top/42`, `#42` in the editor. **That is not the same as the work
being finished.** Five things are outstanding, and each still needs
execution.

**Decided 2026-09-15: each member stores its own member name.** Built for the
exemplar in #7532, and only there. `addItem` allocates the name over the board's
names map and passes it into the member's input in the same transaction that
creates the member, and the member publishes what it stores. For decision 14 and
for #7439 (items 1 and 2 below), that is the whole of what changes: a member the
create named reads its own name from its own input, without the board's derived
names table. Three things it does not change.

The names map has not left the picture. It is still what a name is allocated
over — `createNamed` reads its keys — and the derived `namesTable` is still what
`nameOf` reads to find the board's name for a member by identity, including a
member whose own `shortName` is absent.

An exemplar member filed before this change, or one a backfill names, stores
no name and shows none. Writing a name onto such a member is not built there,
because a board writes a member's result and never its argument, so no verb of
the board can reach that input once the member exists. What closes it is a
verb on the member, which Topics has and the exemplar does not.

For Topics this is built, and what it took is the dated entry above.

Items 1 and 2, and decisions 13 and 14, are not yet reconciled with this
decision. Read as an elaboration of it they would give the wrong input contract
for decision 14 and #7439. Reconciling them is its own stage, and is not done
here. The 2026-09-17 entry above settles the `boardNames` third of it for
Topics and nothing more: `mentionable` and `boardCrossrefs` are untouched, and
the exemplar's member still takes the tables it always took.

[The lenient-naming experiment record](../history/plans/collection-naming-lenient-naming-experiment-2026-09-14.md)
holds the evidence behind the decision: a member reading its name through the
board's table, and what it took to bind the board onto members filed before the
namespace.

**Decided 2026-09-17: Topics shows no numbers until every topic has one.** Mike
ruled it, and ruled the mechanism too. The deployed board numbers each topic it
creates, while a topic filed before the namespace has no number until the
production backfill and bind (item 3 below) reach it, so only some topics showed
a number, and that confused the people reading the board.

`SHOW_TOPIC_NUMBERS` in `packages/patterns/topics/topic.tsx` is off, and a topic
then publishes no `shortName`. Withholding the publication rather than each
display is what covers every surface: a topic's header, the board's cards, the
`index` rows, and the entries of whatever universe a topic's editor completes
over. That last one is why the choice matters. A topic filed before the board
derived its universe reads the raw topics list until an operator rewires it, and
a board cannot rewire it, because a parent writes a member's result and never a
member's argument. Blanking only the board's derived copies left those topics
offering `#1` and showing a pill number, measured against the derived-index
version of this change. So no pill shows a number and `#42` offers no topic
either way, which is the loss the ruling accepts until every topic has a number.

Addressing is untouched: the board allocates a number on every create, records
it in `names`, lists it beside its topic in `namesTable`, `addTopic` returns the
name it allocated, and `top/<n>` resolves. What the hiding costs is the two
reads that go through a topic — its own `shortName` and its `index` row — so the
namespace is where a number is read while numbers are hidden, and item 3's bind
check reads the topic's stored `boardNames` argument instead. The exemplar in
`packages/patterns/collection-naming/` shows its numbers in the header, on the
cards, and in the editor, and its tests are unchanged.

Showing numbers on Topics again means turning that one constant on, once every
topic has a number. Decision 5 still governs how a number renders wherever one
is shown.

1. **Decision 14 — a member takes one input naming its board.** Ruled, and
   measured buildable in
   [the board-demand measurement](../history/plans/collection-naming-board-demand-measurement-2026-09-07.md):
   an item whose one `board` input names only the derived tables compiled, read
   its board-given name, and reached the same number of other-member documents,
   with the same byte total, as the item wired with one link per table, from 2
   members to 40. **Unbuilt.** Until it lands, every collection adopting the
   namespace pays one `cf piece link` per existing member, per board-to-member
   input. A Topic has two such inputs rather than three: it stores its own
   number, so no names table is wired onto it.

2. **A table handed to every member delivers every member's document whole**
   (#7439). Measured on Topics: a member's declared demand over `boardCrossrefs`
   or `boardNames` reaches every other member, 90.5% of the frame on a
   40-member board; the share grew with member count from 4 to 40, and at 10
   members the document and byte counts were unchanged across the mention
   densities measured. `unknown` bounds the walk's descent, not its delivery,
   and comments in `naming.ts` and `topic.tsx` say otherwise. The fix is a
   row-shape change: the `comparable` marker was measured to leave the document
   and byte counts unchanged. It touches the same inputs decision 14 touches,
   so the two belong in one pass. `boardNames` is no longer among them on a
   Topic; `boardCrossrefs` and `mentionable` are.

3. **S6 item 4 — the production backfill.** Held for want of a demand rather
   than a technical answer. Its sequence, and the contract breaks it still
   needs, are recorded under S6 below. Finishing it is what lets Topics show
   numbers again (decided 2026-09-17, above). Two things that gated it have
   since moved. #6969 was closed by #7178, and the patched check accepted the
   board source retrieved from a local snapshot of the Topics board taken August
   31; and an optional `unknown` member demand no longer refuses. The
   [issue 6969 gates record](../history/development/issue-6969-upgrade-gates-2026-09-09.md)
   records both.

4. **The `naming` declaration has no reader** (#6986, #6994). Every collection
   publishes `NamingPolicy`; nothing consumes it. Member resolution applies no
   grammar, no renderer reads `compact`, and `name` is never set. It is an
   extension point with nothing extending through it, recorded in the spec's
   "Deliberately open" rather than claimed as working.

5. **The citation surfaces are partial.** A mention pill shows the name carried
   by the universe row standing for its destination, so what it shows means
   something only through the collection whose universe is being read, and a
   destination no row stands for shows none whatever it publishes (#6985); a URL
   naming more than a member is answered as if it named a member (#6993); "Copy
   reference" yields an address that does not resolve outside the fabric
   (#6995).

S5 is separately deferred and unscheduled; its scope is listed under S5 below.

## Decisions, ruled 2026-09-03

Each of these was a question with a recommendation; the recommendation was
ruled. A later reversal is a decision recorded here, not a discovery.

1. **The citation form follows the cell reference grammar.** The fully
   qualified citation is `#//topics-dev/top/42`. The spec's `#@space/...`
   spelling is amended when that grammar lands. Part 1 of the spec, which
   governs addressing, is unaffected. #6814 records that decision and changes
   no parser. The reference parser reads `//<space>/...` and refuses
   `/@<space>/...` for a named space, so the spelling that resolves is
   `//<space>/...`, and that is what a stage builds and demonstrates. A
   criterion's examples mean whichever spelling the reference parser accepts
   when the criterion is checked, so the switch follows that parser rather
   than any pull request.
2. **The reverse-map restructure and the cross-space slug target are
   deferred.** A board-owned namespace never writes the piece's single `slug`
   metadata entry, so that restructure gates URL rewriting rather than
   naming. Nothing here rewrites an identity URL to the member form, and no
   personal binding is built. What the deferral accepts: a space-level name
   whose path selects a member stamps that member's root —
   `cf piece set-slug two /top/2`, which
   `packages/cli/test/setPieceSlug.test.ts` covers as "names the member a
   slug's path selects, and stamps that member with the name" — so a member
   answers to `<space>/two` and `<space>/top/2` at once, and a visit by
   identity is rewritten to the first. The spec's step 1 records the same
   acceptance and is deferred with this decision rather than held as a
   prerequisite over it.
3. **The namespace is a map cell on the board**, `names: { "42": <link> }`,
   and the collection's slug points at that cell. Forward resolution is a path
   read: `parseFabricUrl` already returns the slug and a one-segment path, and
   the resolver follows the slug, then the link. No segment walk is built for
   a map-backed collection.
4. **Names are decimal strings, dense from `1`**, allocated on create as one
   more than the largest name present, permanent, never reused. Members that
   predate the namespace are named in filing order by a backfill verb run
   once. A keyset read of the map conflicts with a concurrent key write
   (`docs/specs/memory-v2/08-conflict-granularity.md`), so two creators
   serialize through one retry of `editWithRetry`.
5. **A member's display name stays its title.** The number renders as a badge
   beside it, never in place of it, and every reader reaches it through the
   member's own `shortName`: an index row, a mention universe row, and a
   mention's pill all read that one property.
6. **"In text" means the editor.** Typing `#42` completes to a reference-form
   mention that shows the number. Pasted text is left alone. The `#` sigil is
   provisional: the spec leaves tags versus citations open.
7. **The board publishes a machine-readable `naming` declaration.**
8. **Models.** Fable implements until Mike says otherwise.
9. **Slug names.** `top` names the namespace; `topics` may name the board
   root.
10. **Estuary is untouched**, read-only calls included, until Mike directs.
    Deployment and the production backfill are Mike's steps, rehearsed on a
    clone first.
11. **The work lands in `packages/patterns/collection-naming/`**: `naming.ts`
    (the library a collection pattern calls), `board.tsx` and `item.tsx` (the
    exemplar the demos run on), and tests. `packages/patterns/topics` is not
    edited until S6.
12. **The Topics-shape rehearsal is a test-only board** in that directory,
    composing the real `Topic` from `../topics/topic.tsx` unmodified through
    the library. Board-side naming is proven there. Item-side display is
    proven on the exemplar item and grafted onto `topic.tsx` in S6.
13. **Index rows are the members.** Ruled 2026-09-03: the exemplar's index
    rows are the members themselves, as Topics' are, and a name reaches a row
    through the member's `shortName` with a default; the rehearsal over the
    unmodified Topic proves naming through the names table and the reverse
    lookup. A name therefore reaches a row only through the member's own
    `boardNames`, which `addItem` wires and no later write can supply: a
    parent holds its member's result, while `boardNames` is the member's
    argument. So a backfill on a board whose members were filed past the
    create must be paired with a one-time link-bind of `namesTable` onto each
    of them, the same operator step Topics states for `mentionable`. S6
    carries that step into the Topics graft.

14. **Per-member wiring is restructured, and the retrofit cost is not the
    reason not to.** Ruled 2026-09-06. A member reaches its board's derived
    tables as an argument the board wires at creation, and a board writes a
    member's result but never a member's argument — so each new such input
    needs one `cf piece link` per existing member. Three inputs now do:
    `mentionable`, `boardCrossrefs`, `boardNames`. Decision 13 accepted that
    cost for the third on the grounds that the first had already paid it,
    which is a coincidence used as a precedent.

    The ruling is that a member taking one input naming its board, and
    deriving the tables from it, is the design to pursue, and that the
    expense of updating existing topics is not an argument against it:
    topic performance is improving continuously, and a slow retrofit is a
    cost worth paying once for a shape that ends the per-input bind.

    One thing the ruling does not settle, because it is a different cost:
    the mention-index break measured a *runtime* multiplication — 8.17 MB
    and 6,203 documents, 82% of a topic resume frame — when a per-member
    input reached the raw topics list. The same record names what contained
    it: the demand shape steers the walk, not the link. So the implementation
    must declare a board-demand that reaches only the derived tables, and
    that narrowness has to be measured rather than assumed. That is an
    implementation guard, not a gate on the decision.

## Gates and review

Every stage runs `deno fmt --check`, `deno lint`, `deno task check`, and
`deno task test` in the packages it touched; `deno task cfcheck` when a pattern
changed; and the gates in `AGENTS.md` § Automated gates that its files reach —
`check-command-docs` and `check-completion-slots` for a `cf` option,
`check-no-waitfor` for a test, `check-docs` for a document. Codex reviews each
round through `stage-loop`. Nothing merges without Mike.

## Stages

### S1 — The library and the exemplar board own a member namespace

Scope: `packages/patterns/collection-naming/` (new): `naming.ts`, `board.tsx`,
`item.tsx`, `topics-shape.test.tsx`, unit tests, `README.md`.

1. `naming.ts` exports what a collection pattern calls: allocate the next
   name inside an action, the names table lift (one row per member,
   addressed by the member), a backfill over an existing list, and the
   `naming` declaration type. Nothing in it names topics.
2. The exemplar board's `addItem` allocates the next name in the same atomic
   write as the append: the created item is reachable at `names[<n>]`, and
   the result row carries `name`.
3. Names are decimal strings, dense from `1`, one more than the largest name
   present, never reused. An item keeps its name whatever happens to it.
4. Two overlapping `addItem` calls end with distinct consecutive names. A
   test drives the overlap through the runtime's retry; if the harness cannot
   express the overlap, the allocator is tested against a stale read and the
   limitation is recorded here. Recorded: the pattern-test harness runs one
   runtime and dispatches events one at a time, so two `addItem` calls never
   overlap in it, and the multi-user harness runs its participants
   concurrently but offers no step that forces two of their events to
   overlap. `naming.test.tsx` tests the allocator against a stale read on one
   map cell instead: a first allocation, a concurrent writer's key landing,
   and a re-run over the map as the winner left it, which takes the next
   distinct name.
5. A backfill verb names every unnamed member in filing order, skips named
   ones, and is idempotent: a second run writes nothing.
6. Index rows are the members, declared through a row demand that carries
   `shortName` with a default, so a board holding older members still reads
   whole.
7. The exemplar item renders its own name from the board's names table,
   wired at creation the way Topics wires `boardCrossrefs`; an item without
   the wiring shows no name and does not fail.
8. The board publishes `naming`: `{ name?, policy: { unique, permanent,
   reuse, allocator }, compact }`. `compact` is reserved: it declares that the
   member names hold no hyphen, and no renderer offers the compact spelling.
   Nothing reads the declaration at all —
   [#6986](https://github.com/commonfabric/labs/issues/6986) is making one
   consumer real.
9. Allocation reads the namespace's keys without expanding any member: the
   declared schema holds the values as unread references.
10. The Topics-shape rehearsal passes: a test-only board over the unmodified
    `Topic` pattern, wired through `naming.ts`, allocates on create,
    backfills a pre-existing list, and proves the names-table lookup and the
    reverse lookup for a given topic. `topic.tsx` and `topics/main.tsx` are
    untouched by the stage.
11. `README.md` describes the library and the exemplar; `cfcheck`, pattern
    tests, and coverage green.

Demo: local dev server. Two `cf piece call addItem` on the exemplar board
return names `1` and `2`; `cf cell get /of:$BOARD names` lists both keys; the
Topics-shape test is green in the same run.

### S2 — `top/42` resolves at the CLI

Scope: `packages/piece/src/slugs.ts`, `packages/runner/src/slug-resolution.ts`,
`packages/cli` (`set-slug`, README, completion table).

1. `cf piece set-slug top <board>/names` writes a slug at a non-root path,
   and `cf piece slugs` lists it, naming the containing piece. Both demos run
   on the exemplar board.
2. A reference that names a collection and then a member resolves to that
   member: `cf cell get //<space>/top/42 title`,
   `cf piece describe --cell //<space>/top/42`, and
   `cf piece call --cell //<space>/top/42 <verb>` all reach it. A reference
   that stops at the collection refuses, naming the piece that holds it. The
   walk lives in `resolvePieceReference`, which takes an address and the path
   written after it; `resolvePieceAddress` is its no-path case and refuses a
   collection, because a caller holding an address alone has nothing to walk
   with.
3. A slug resolving to a non-piece with no further path fails with a message
   naming the containing piece.
4. `//<space>/top/999` fails with "no member 999 in top".
5. Unit tests in `packages/piece/test/slug.test.ts` and `packages/cli/test`.

Demo: `cf cell get //<space>/top/2 title` on the local exemplar board.

### S2b — Assignment refuses by default

The first half of the spec's step 2.

1. `set-slug` on a bound name refuses and names the current target; `--force`
   steals — every bound name, including one whose value is a link cycle,
   which is the state an operator forces to escape. That last case rests on
   the redirect write carrying a schema: a write handle with none resolves
   the value it is about to replace to find one, and resolving a cycle
   throws. The schema names nothing to follow, so the write pulls the one
   document it writes, and only the redirect write carries it.

   The check is a claim inside the transaction: a test with two writers has
   exactly one win. Recorded, after three attempts to describe the
   interleaving a one-runtime test achieves: it does not pin one, and the
   paragraph should not claim one. Two things are true and both are tested.
   The single-runtime test asserts the outcome — two assignments of one free
   name leave exactly one holder — and its assertions hold however the two
   were ordered. The racing path is a runtime guarantee, pinned by the
   cross-session pair: the claim's read joins the commit's read set, so a
   commit another writer overtakes is rejected and `editWithRetry` re-runs
   the body against what that writer left, which then declines. That is the
   shape `packages/runner/src/ensure-space-root.ts` states for the space
   root.
2. Whether a synced read inside `editWithRetry` becomes a commit precondition
   is settled by that test and recorded in the spec's open-questions list.
3. `--force` has a completion slot and a README sentence, on both commands
   that assign a name: `set-slug` and `piece new --slug`.
4. A caller whose own rule about a free name is wider than the library's
   carries that rule's answer into the transaction as `takeFrom` rather than
   forcing over what it read. Forcing after a standalone read spends the
   claim — two callers that both read a name as free would both take it — so
   the rule and the claim are held at once, and two concurrent callers still
   end with one holder whichever notion of free they hold.

What a forced reassignment leaves behind. Taking a name now clears the `slug`
entry from the document it takes it from, in the transaction that writes the
new redirect, so no piece is left claiming a name it no longer holds. What
remains is structural and still step 1's: the entry is single-valued, so a
document reachable under two names only ever claims the later one, and a name
pointing inside a piece stamps no entry at all, which leaves a
collection-targeted name absent from the reverse map. S3 renders URLs from
that map, so those two shape what it can say about a member.

### S3 — The shell opens `/<space>/top/42`

Scope: `packages/navigation` (the member in a view and its URL),
`packages/runtime-client` (the resolution the worker answers),
`packages/lib-shell` (the hop that carries it, and the piece cache it keys),
`packages/shell`, and shell integration tests.

1. `/<space>/top/42` opens the member piece; the tab shows its title. The
   exemplar item is the member; the Topics-shape test covers the board side
   only.
2. `/<space>/top` opens the board, the piece containing the namespace.
3. `/<space>/top/999` shows a not-found state naming the collection.
4. The item's own header shows the number, and the shell's header offers a
   copyable portable reference `//<space>/top/42`; board cards show the
   number. (Two headers, which is how this was read when the criterion was
   delivered and accepted: the badge is the item pattern's, while only the
   shell knows the space and the collection's name, so only the shell can
   compose the reference.)
5. A browser integration test covers 1 and 3.

### S4 — `#42` in text

Scope: `packages/ui` cf-code-editor mention completion and pill; the exemplar
(mentionable rows and the item output both carry the member's name as
`shortName`, which is the one property the editor reads at both ends of a
mention).

1. Typing `#42` in the exemplar item's body offers the member named 42;
   picking it inserts a reference-form mention.
2. A mention pill whose destination publishes a short name shows it beside
   the label; existing mentions gain it once the destination does.
3. Autocomplete matches the number as well as the title.
4. A pasted `#42` stays plain text; the editor's documentation says so and
   why.
5. Stretch: the pill's plain-text copy is `//<space>/top/42`.

### S6 — Graft onto Topics

Mike's call, after S4.

1. `topics/main.tsx` adopts `naming.ts` with the wiring the rehearsal board
   already carries; the diff is the rehearsal board's diff against today's
   board and nothing more.
2. `topic.tsx` gains the item-side display the exemplar item proved: the
   badge and `shortName`.
3. `TopicMentionableRow` gains `shortName` and the board copies each topic's
   own into it, which is what makes the `#42` trigger live on the deployed
   board — until then it matches nothing there, because a Topics universe row
   carries no such property. The exemplar's `mentionableRowsOf` and
   `mentionableIndex` are a fork of the Topics pair differing only by that
   property, so this step is where the fork ends: one of the two goes, and the
   survivor is the one both boards derive their universe through.

   Recorded: the survivor is one derivation, `mentionableIndex` and
   `mentionableRowsOf` in `packages/patterns/collection-naming/mentionable.ts`,
   which both boards import; `MentionableRow` is the row type both publish, and
   `TopicMentionableRow` and `ItemMentionableRow` are gone. Neither board could
   import the other's copy: a pattern module carries its imports into its own
   compiled program, so the exemplar would ship the Topics board or Topics
   would ship the exemplar. It is not in `naming.ts` either, because that
   module never reads through a member and this derivation reads three display
   strings off each one.
4. The production backfill is rehearsed on a clone per
   `../development/space-clone-rehearsal.md`; the deployed vintage includes
   #6827 before the backfill runs. The decision items 1-3 could not make for it
   is made by the 2026-09-17 entry above: a topic stores its own number, and
   `backfillNames` asks each topic filed before the namespace to store the one
   the namespace holds for it, so no per-topic `cf piece link` remains in the
   sequence. The two rehearsals recorded below ran the link-bind shape, so what
   they measured of the numbering step itself no longer describes it; what they
   measured of the two source legs does, and those legs are unchanged. The
   operator procedure is `skills/topics/references/namespace-backfill.md`, which
   states which of its steps have a clone run behind them.

   **Held 2026-09-06, and not for a technical reason.** The step is rehearsed
   twice; the second run, after the positional-link fix, is recorded at
   `../history/plans/collection-naming-s6-backfill-rehearsal-rerun-2026-09-06.md`
   and measured what the first could not. On a clone holding three topics, the
   forced board deploy verified `removed 0`, moved the board's argument
   document by one key (`names: {}`), and left those topics' titles and bodies
   intact; the mention-index transition cost eleven commits and one written key
   per topic. Three topics is not 125, and the record says which of its figures
   scale and which are counts of that run. What is missing is not a measurement
   but a demand — nobody has asked for named Topics on the deployed board.

   The sequence that makes running it routine rather than a one-way door,
   whenever consensus appears:

   1. Check the deployed board with `setsrc --check` before writing to it.
      #6969, that check exhausting the heap against the deployed board, was
      closed by #7178. The
      [issue 6969 gates record](../history/development/issue-6969-upgrade-gates-2026-09-09.md)
      ran the patched check over a local snapshot of the board taken August
      31, where it accepted the retrieved board source; production was not
      contacted.
   2. Deploy the board leg, which is refused over topics filed before the
      namespace and needs `--dangerously-allow-incompatible-schema` until a
      general mechanism for adding a property to existing data exists.
   3. Update each topic to a pattern that declares the `shortName` input and
      the `recordName` verb, then run `backfillNames` until its `pending` list
      comes back empty. Every topic takes the source update BEFORE the step
      runs: a send to a path holding no stream is an ordinary write, so the
      step's event lands as data in an un-updated topic's result. Run the
      source updates from a host: laptop runs died 4-6 minutes in during the
      2026-08-28 migration.
   4. Verify by reading both the board's index and the member addresses. In
      the rerun the fixed board's index agreed with its members at all three
      reads; the two reads that disagreed were on the instrument board
      carrying the walk #6987 replaced, and no run there attributed the
      staleness to a mechanism. So the rerun establishes no divergence for the
      code this graft deploys, and no cause for the one it saw. Reading both
      is what would show a divergence if one appeared, and costs a command.

   **The board leg of the deploy needs
   `--dangerously-allow-incompatible-schema`.** `setsrc --check` refuses it over
   a board holding topics filed before the namespace, because the typed
   `topics.0.shortName` demand constrains an unconstrained producer. An open
   producer contract permits any value at an undeclared
   property. A new string demand narrows that contract even when optional:
   absence is allowed, but a present non-string value is not. An optional
   `unknown` demand adds no value restriction and is compatible. The retained
   link proof uses producer-owned durable metadata; a schema carried by the
   alias is not a producer guarantee. The
   [issue 6969 gates record](../history/development/issue-6969-upgrade-gates-2026-09-09.md)
   replays the August 31 snapshot and separates this refusal, which stands,
   from the two false ones the checker no longer raises. The flag is held
   behind explicit team authorization by
   `skills/topics/references/pattern-updates.md`, so this step
   carries a decision it did not carry before. What the forced deploy leaves
   behind is measured, in the 2026-09-06 rerun below.

   **Why the gates said otherwise.** `deno task pattern-compat` and
   `deno task pattern-vintage` are both clean and neither can see this: the
   first judges a pattern's declared contract against the contracts it has
   declared before, the second replays the pattern's own stored documents, and
   neither examines the schema recorded on a link into a SIBLING piece — which
   is the check that fires. A gate passing is not the claim; the claim is what
   the gate examines, and the only instrument that examines this one is
   `setsrc --check` against the deployment itself.

   The board moves FIRST, which is what clears the topic leg's own
   `mentionable[].shortName` refusal; the topic leg then needs the flag once
   itself, for the mention universe narrowing to a readable handle
   (`../history/topics-mentionable-readonly-break.md`), and is proven on every
   update after that one. The deploy also needs
   `--root` at or above `packages/patterns`, because the board imports the
   naming library from a sibling directory and the default program root is the
   entry's own.
5. `skills/topics/references/naming.md` describes `top/42` addressing.

### S5 — Deferred, not scheduled

The reverse-map restructure and identity-URL rewrite to the member form;
cross-space personal bindings (`#top/42` through a home-space slug); the
compact form `top-42`; prose scanning; the tags-versus-citations sigil
decision.
