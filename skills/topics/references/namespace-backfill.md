# Numbering the Topics that predate the namespace

Part of `skills/topics/SKILL.md`, which is the map. This is the operator
procedure, with its order, its command, its audit, and its traps.

A Topic reports the number stored in its own input. `addTopic` allocates the
number and passes it into the Topic it creates, so a Topic filed since the
namespace landed carries one from birth. A Topic filed before it carries none,
and no verb of the board can write one into it: a parent writes its member's
result and never its member's argument. The Topic makes that write itself,
through its own `recordName`, and the board's `backfillNames` is the step that
numbers the namespace and asks every Topic reporting no number to store the
number the namespace holds for it.

**Topics shows no numbers while this runs.** `SHOW_TOPIC_NUMBERS` in
`packages/patterns/topics/topic.tsx` is off until every Topic has a number, and
while it is off a Topic publishes no `shortName` whether or not it stores one.
Turning it on is a pattern update of its own and the team's decision, not an
agent's. So every `shortName` read below is what this procedure looks like once
numbers are shown. Until then the namespace says which Topics it has numbered
and what each number is, and only a Topic's own durable input says what that
Topic stores — the two are different questions, and "Which read answers what"
below gives each one its command. `deno task cf cell get /top/<n> title` answers
either way, because a member's address is the namespace's and not the Topic's.

**This procedure has not been rehearsed against a clone in this shape.** The two
source legs below are unchanged, and were measured twice —
`docs/history/plans/collection-naming-s6-backfill-rehearsal-2026-09-05.md` and
`docs/history/plans/collection-naming-s6-backfill-rehearsal-rerun-2026-09-06.md`
record what each run cost and which of its figures scale. What stands behind the
numbering step is pattern-test coverage in
`packages/patterns/topics/naming.test.tsx`, not a clone run. Rehearse per
`docs/development/space-clone-rehearsal.md` before running any of this against a
space holding real data.

### The order

1. **The board's source first**, and it needs
   `--dangerously-allow-incompatible-schema`. `setsrc --check` refuses it over a
   board holding Topics filed before the namespace, because the typed
   `topics.0.shortName` demand constrains an unconstrained producer.

   An open producer contract permits any value at an undeclared property. A new
   string demand narrows that contract even when optional: absence is allowed,
   but a present non-string value is not. An optional `unknown` demand adds no
   value restriction and is compatible. The retained link proof uses
   producer-owned durable metadata; a schema carried by the alias is not a
   producer guarantee. The checker is
   `packages/piece/src/schema-compatibility.ts`, and the snapshot evidence is
   `docs/history/development/issue-6969-upgrade-gates-2026-09-09.md`.

   `deno task pattern-compat` and `deno task pattern-vintage` do not see this.
   `tasks/pattern-vintage.ts` says what each proves: a pattern's declared
   contract against the contracts it declared before, and its own stored
   documents under today's source. Neither reaches the schema recorded on a link
   into a sibling piece, so both can be green while the deploy is refused. Run
   `setsrc --check` against the deployment itself before scheduling a window,
   and treat the flag as needing team authorization under the rule in
   `references/pattern-updates.md`.

2. **Then each Topic's source**, and it needs
   `--dangerously-allow-incompatible-schema` once per Topic. Moving the board
   first clears the Topic leg's own `mentionable[].shortName` refusal, and what
   `setsrc --check` reports underneath is the Topic's mention universe narrowing
   from a writable handle to a readable one:

   ```
   Pattern schemas are not backward compatible:
   - argument.mentionable: asCell changed
   ```

   `asCell` is compared for exact equality by
   `packages/piece/src/schema-compatibility.ts`, so a narrowed cell reads as a
   break however narrow the narrowing is; the decision and what it costs are
   `docs/history/topics-mentionable-readonly-break.md`. The cost is one forced
   update per Topic and no more: a readable handle drops the write-back leg of
   the retained-link proof that a writable one carries — the leg that would
   demand the Topic's three-field projection accept the `piece` the board's row
   publishes — so `setsrc --check` proves every update after this one. Like step
   1's, the flag is a team-authorization decision under the rule in
   `references/pattern-updates.md`, and a separate one, for an unrelated reason.
   The flag is for `mentionable` and for nothing else this leg does.

   This leg is also what gives a Topic the input its number is stored in and the
   `recordName` verb that writes it, so it is a prerequisite of step 3 rather
   than a nicety.

   **It also stops declaring `boardNames`, which every deployed Topic has a link
   bound at, and that is not a second refusal.** The candidate declares no path
   there, so the retained-link proof reaches the link against an unconstrained
   destination and neither refuses it nor writes it: the link stays in the raw
   argument document, unreachable through the new projection, and a targeted
   input read of `boardNames` then refuses the path. That is measured, in
   `packages/cli/test/piece-link-input-visibility.test.ts` — "accepts a
   candidate that stops declaring an input holding a retained link". The bound
   is in the case beside it: what a candidate may not do is stop PUBLISHING a
   path, which is an ordinary backward-compatibility refusal and not about the
   link. A Topic never published `boardNames`, so only the declaration goes.

   **Every Topic takes this step before step 3 runs.** A Topic still on source
   that declares no `recordName` is not merely left unnumbered. A send to a path
   holding no stream is an ordinary write — `Cell.send` in
   `packages/runner/src/cell.ts` delegates to `set` — so the numbering step's
   event lands as data at `recordName` in that Topic's result document. Nothing
   else about the Topic is harmed and the number itself is in the board's
   `names` map either way, but that data sits there until the Topic's source
   moves and replaces the path with the stream. Finish step 2 first.

   **Skipping step 2 leaves a usable board**, on narrower terms than a
   namespace-only run left. A Topic still on pre-graft source is numbered in the
   namespace like any other member, answers to
   `deno task cf cell get /top/<n> title`, and reads back as an ordinary `index`
   row with no `shortName` and no damage to the array around it. So numbering,
   `/top/<n>` addressing and index membership all survive the step being
   skipped, and `shortName` — the badge, and the number on the index row — is
   what is absent. What is different now is that nothing can supply it later:
   the number lives in the Topic's own input, and a Topic that declares no such
   input has nowhere to put one.

3. **`backfillNames`, as many times as it takes.** It numbers every Topic the
   namespace does not hold, in filing order, and asks every Topic reporting no
   number to store the one the namespace holds for it. Over Topics that all
   report their numbers it writes no key and sends no event.

### The command

```bash
deno task cf piece call --cell "$TOPICS_BOARD" --invocation '<id>' backfillNames \
  '{"agentName":"Sol"}'
```

One command for the whole board, where the shape this replaced cost one
`cf piece link` per Topic. Step 2 is still one `setsrc` per Topic, serially, and
on a board the size of the Estuary one that is the bulk-CLI shape
`docs/history/topics-board-migration-2026-08-28.md` found unreliable from a
laptop; run it from somewhere that record vindicates.

The report is three lists of numbers in filing order:

- `assigned` — what this run wrote into the namespace.
- `named` — the Topics already reporting theirs. Nothing was written or sent for
  these.
- `pending` — the Topics this run asked. None of them is confirmed, because a
  send's effect is invisible to the transaction that makes it.

An empty `pending` is the finished state, and a non-empty one is a reason to run
the step again rather than a failure: the run after it reports whichever asking
landed under `named` and asks for the rest.

**While numbers are hidden, only `assigned` means anything.** The step reads a
Topic's published `shortName` to tell a stored number from none, and
`SHOW_TOPIC_NUMBERS` gates exactly that, so every Topic reads as storing nothing
however much it holds: `named` comes back empty and `pending` comes back holding
every Topic on the board, run after run. The asking writes nothing —
`recordName` reads the Topic's own input, which no switch gates, and declines a
number already stored — so running the step again is safe and idle; what it
cannot do is tell you it is done.

So until the switch is on, read three things instead of `pending`:

- **`assigned` empty** means every listed Topic is numbered in `names`. That is
  the whole of the namespace half, and it is what `top/<n>` resolves through.
- **One Topic's stored number** comes from its own durable input, which no
  switch gates: `deno task cf cell get --cell "$TOPIC" shortName --input`.
- **`recordName` called on one Topic reports that Topic**: `wrote: true` the
  first time, `wrote: false` once the number is stored. The board route cannot
  report per Topic, because a verb's result reaches its caller and the board
  sends rather than calls. For a handful of Topics this is the direct answer;
  for a boardful it is one command each, which is what the board route exists to
  avoid.

Turning `SHOW_TOPIC_NUMBERS` on restores the report by itself. Nothing else
about the step changes with it.

**A number that comes back under `pending` on every run is not waiting for a
retry** — once numbers are shown, when `pending` means something again. That
Topic's own verb is refusing the number, which `recordName` does when the Topic
already stores a different one. Read its stored number, decide which number that
Topic is to keep, and reconcile by hand; nothing in the board resolves it, and
each run costs one refused handler transaction.

### What a half-finished Topic looks like, and what it costs

Numbering a Topic is two writes, and only the first is the board's: the key in
the board's `names` map, committed by the step's own transaction, and the number
in the Topic's own input, which only the Topic can write. A run that makes the
first and does not get the second is the state `pending` names, and it is worth
knowing exactly how far it goes, because an operator meets it whenever a run
leaves `pending` non-empty.

**`top/<n>` resolves.** The resolver reads the containing piece's map and
follows the entry to the piece — `resolveSlugReference` in
`packages/runner/src/slug-resolution.ts` looks the segment up with
`map.key(member)` and never reads the Topic — so
`deno task cf cell get /@<space>/top/<n> title` answers as soon as the key is
there, whatever the Topic stores. The number is usable as an address before the
Topic can show it.

**The Topic shows no number.** Its `shortName` is absent, so its header renders
no badge, its `index` row carries no `shortName`, and its mention-universe row
matches no `#<n>` query. Every display reads that one property, so all three
move together.

**A re-run cannot give it a different number.** The step looks a listed member
up among the map's entries by identity before it allocates, so a member the map
already holds takes the name it is held under. The comparison resolves both
sides, so a Topic whose document has moved behind a forwarding link still
matches its entry. No number is reused, and no Topic collects two.

**A Topic whose source has no `recordName` ends up holding the payload as
data.** A send to a path holding no stream is an ordinary write, so
`{"name":"<n>"}` lands at `recordName` in that Topic's result document. Nothing
declares a reader for it, so it is inert: it survives the Topic running again,
and the Topic's next source update replaces the path with the stream, after
which the verb works. It is untidy rather than damaging, and step 2 before step
3 is what avoids it.

**What an operator sees**, in the order they would look:

```bash
# the step's own report, run after run. While numbers are hidden it reads every
# Topic as storing nothing, so `named` is empty and `pending` holds them all:
# what moves between runs is `assigned`.
deno task cf piece call --cell "$TOPICS_BOARD" backfillNames '{"agentName":"Sol"}'
# -> { "assigned": [], "named": [], "pending": ["1","2"] }

# what Topic 2 actually stores, which no switch gates
deno task cf cell get --cell "$TOPIC2" shortName --input
# -> (absent, for a Topic that has not stored one)

# and the number addresses the Topic anyway
deno task cf cell get /@<space>/top/2 title
```

So the worst case is bounded: a number allocated, reachable, and permanently
that Topic's, on a Topic that does not yet show it. No content is touched, no
number is lost or reused, the board serves every Topic either way, and the
repair is another run of the step. Nothing has to be undone.

### Which read answers what

Every read below is named somewhere in this procedure, and they do not all
survive `SHOW_TOPIC_NUMBERS` being off. The switch gates a Topic's PUBLISHED
`shortName`, so every read that goes through the publication reads the same
absence for a Topic storing a number and one storing none. The reads that go
through the namespace, or through a Topic's own durable input, are untouched by
it.

| Read                            | Numbers hidden                                                                                       | Numbers shown                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| `backfillNames` → `assigned`    | what this run wrote into the namespace                                                               | the same                          |
| `backfillNames` → `named`       | always empty                                                                                         | the Topics already storing theirs |
| `backfillNames` → `pending`     | every listed Topic, every run                                                                        | the Topics this run asked         |
| board `index` row's `shortName` | absent for every Topic                                                                               | the number that Topic stores      |
| board `names` map               | which Topics the namespace has numbered, and what each number is — never whether the Topic stores it | the same                          |
| Topic's `shortName` input       | the number that Topic stores                                                                         | the same                          |
| `recordName` on one Topic       | `wrote` says whether it had to write                                                                 | the same                          |
| `/@<space>/top/<n>`             | resolves to the Topic                                                                                | the same                          |

So while numbers are hidden, **the board's index answers nothing about storage**
— it is the read to skip, not the survey — and there is no board-wide read of
what Topics store. The two that work are one per Topic:

```bash
# what this Topic stores. No switch gates the durable input.
deno task cf cell get --cell "$TOPIC" shortName --input

# or ask the Topic, which answers for itself
deno task cf piece call --cell "$TOPIC" recordName '{"name":"<n>"}'
# -> { "name": "<n>", "wrote": false }   already stored; nothing written
# -> { "name": "<n>", "wrote": true }    it had none and now stores this
```

Board-wide, the namespace is what can be surveyed, and it answers the other half
of the question:

```bash
deno task cf cell get "$TOPICS_BOARD" names
# -> { "1": {}, "2": {} }   the Topics the namespace has numbered
```

Once numbers are shown, the board's index becomes the one bounded read that
answers both halves at once, because a row's `shortName` is then the number its
Topic stores:

```bash
deno task cf cell get "$TOPICS_BOARD" index --step --select @,title,shortName
```

Audit only Topics whose source has already been migrated. Input reads use the
current pattern's projection: a Topic whose pattern does not declare `shortName`
refuses this targeted read with `Cannot access path "shortName"`, and so does a
targeted `deno task cf cell set --input` write to it. Updating the Topic's
pattern is what makes the path reachable at all.

### Traps

**`setsrc --check` issues no storage writes**, including when it refuses. Normal
reads can demand server-side materialization when server execution is active;
verify the clone's fingerprint before reusing its baseline. Applying source can
persist compilation artifacts before setup accepts it, so reset the clone with
`deno task cf space reset` before repeating an apply rehearsal.

**A number is permanent, and only the verb enforces that.** `recordName` refuses
a number that disagrees with one the Topic already stores, and writes nothing
when it agrees. A targeted `deno task cf cell set --input` write to `shortName`
has no such guard and will overwrite or blank a stored number, so reach for the
verb:

```bash
deno task cf piece call --cell "$TOPIC" recordName '{"name":"42"}'
```

**A half-finished Topic is not an error state.** What it costs is above, under
"What a half-finished Topic looks like"; the repair is another run of the step.
