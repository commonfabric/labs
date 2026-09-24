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

**What a clone rehearsal of the whole procedure showed** is recorded in
`docs/history/plans/topics-numbering-rehearsal-2026-09-22.md`, and the earlier
measurements of the source legs in
`docs/history/plans/collection-naming-s6-backfill-rehearsal-2026-09-05.md` and
`docs/history/plans/collection-naming-s6-backfill-rehearsal-rerun-2026-09-06.md`.
Rehearse per `docs/development/space-clone-rehearsal.md` before running any of
this against a space holding real data.

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

3. **`backfillNames` once, then the audit.** It numbers every Topic the
   namespace does not hold, in filing order, and asks every Topic reporting no
   number to store the one the namespace holds for it. Over Topics that all
   report their numbers it writes no key and sends no event — which, while
   numbers are hidden, is no Topic at all. While they are hidden its report
   cannot say which asking landed, so follow the one run with the per-Topic
   audit in "Telling when it is done", and repair only the Topics that audit
   finds missing. "What a re-run writes" below says what a run costs.

### The command

```bash
deno task cf piece call --cell "$TOPICS_BOARD" --invocation '<id>' backfillNames \
  '{"agentName":"Sol"}'
```

`--invocation` needs an invocation session; set `CF_INVOCATION_SESSION` as
`references/mutating.md` does. One command for the whole board, where the shape
this replaced cost one `cf piece link` per Topic.

Step 2 is still one source update per Topic. Drive it as a plan rather than a
loop of `setsrc` calls (`docs/common/workflows/bulk-operations.md`). Attach the
complete source package — one `--test` for every `*.test.tsx` beside the Topic
source, since attached tests are part of the package the plan's identity is
computed from — and expand the list from the directory rather than writing it
out, so it cannot fall behind a test added later:

```bash
PLAN="$(mktemp -d)/topics-plan.jsonl"
TESTS=()
for t in packages/patterns/topics/*.test.tsx; do TESTS+=(--test "$t"); done
deno task cf piece survey --piece "$TOPICS_BOARD" --path topics \
  --retarget "topics=packages/patterns/topics/topic.tsx" --root . \
  "${TESTS[@]}" --dangerously-allow-incompatible-schema --out "$PLAN"

# dry: every row classified against its own reference pair, nothing written
deno task cf piece retarget --plan "$PLAN"
```

Before the apply, take out the rows that need no move. A Topic filed through the
board after step 1 runs the Topic code the board's own program carries, under a
different identity from the standalone build the plan targets, and stores its
number from creation. The apply cannot be undone ("Traps"), so settle these rows
first. The test is the Topic's `shortName` input read, which **exits non-zero
unless the Topic stores a number**. On a Topic whose source does not declare the
input it refuses the path,
`property "shortName" not found in the current
pattern's input schema`; on one
that declares it and stores none it reports `property "shortName" not found` and
lists the keys the input does hold. Both exit 1. A stored number prints and
exits 0:

```bash
: > "$PLAN.numbered"
for p in $(jq -r 'select(.op) | .piece' "$PLAN"); do
  if deno task cf cell get --cell "/of:$p" shortName --input >/dev/null 2>&1; then
    echo "$p" >> "$PLAN.numbered"
  fi
done
wc -l < "$PLAN.numbered"   # expect the Topics filed since step 1, and no others
jq -c 'select(.op)' "$PLAN" | wc -l   # if the two counts match, stop: see below
jq -c --rawfile skip "$PLAN.numbered" \
  '.piece as $p | if .op and (($skip | split("\n")) | index($p)) then del(.op) else . end' \
  "$PLAN" > "$PLAN.edited" && mv "$PLAN.edited" "$PLAN"
deno task cf piece retarget --plan "$PLAN"   # dry again: the outstanding count drops by that many

deno task cf piece retarget --plan "$PLAN" --group-size 25 --apply
# the verdict: a second survey held against the plan
deno task cf piece survey --piece "$TOPICS_BOARD" --path topics --diff "$PLAN"
```

If every row reads as numbered, the read is not behaving as described, and the
edit would empty the plan so that the apply moves nothing and reports success.
Stop and look at one row's read by hand before editing anything. A row without
an operation is the plan format's own "leave this piece where it is", so the
edited rows are reported as unchanged by the verdict rather than counted as
missed. A run that stops partway is resumed by running the apply again, since a
Topic already on the target reads as landed and is not rewritten. On a board the
size of the Estuary one this is the bulk-CLI shape
`docs/history/topics-board-migration-2026-08-28.md` found unreliable from a
laptop over the network, so treat a stopped run as a reason to resume rather
than start over.

The report is three lists of numbers in filing order:

- `assigned` — what this run wrote into the namespace.
- `named` — the Topics already reporting theirs. Nothing was written or sent for
  these.
- `pending` — the Topics this run asked. None of them is confirmed, because a
  send's effect is invisible to the transaction that makes it.

Once numbers are shown, an empty `pending` is the finished state, and a
non-empty one is a reason to run the step again rather than a failure: the run
after it reports whichever asking landed under `named` and asks for the rest.
While they are hidden, `pending` never empties, so it is no reason to run again;
the audit in "Telling when it is done" is.

**While numbers are hidden, only `assigned` means anything.** The step reads a
Topic's published `shortName` to tell a stored number from none, and
`SHOW_TOPIC_NUMBERS` gates exactly that, so every Topic reads as storing nothing
however much it holds: `named` comes back empty and `pending` comes back holding
every Topic on the board, run after run. What it cannot do is tell you it is
done.

### Telling when it is done

While numbers are hidden, the step is finished when every Topic's own input
stores a number, and only a read per Topic answers that. Read each one through
the CLI, over the Topics the survey plan names:

```bash
deno task cf cell get --cell "$TOPIC" shortName --input
```

A Topic can come back without one after a run, and another run of the step does
not necessarily reach it: in the rehearsal recorded in
`docs/history/plans/topics-numbering-rehearsal-2026-09-22.md`, the same Topic
missed in both passes and a second run changed nothing for it. So store its
number directly. The numbers the namespace holds that no Topic reported storing
are the ones to resolve. Read each entry as an address, since the map renders
its members as `{}` otherwise, and confirm it is that Topic — by `createdAt`,
for the reason `references/reading.md` gives — before sending:

```bash
deno task cf cell get --cell "$TOPICS_BOARD" names/<n> --input --select @
# -> { "$link": "/of:fid1:..." }   compare its createdAt with the Topic's
deno task cf piece call --cell "$TOPIC" --invocation '<unique-repair-id>' \
  recordName '{"name":"<n>"}'
deno task cf cell get --cell "$TOPIC" shortName --input
# -> "<n>"
```

`recordName` stores whatever number it is handed, so resolving the entry first
is what keeps the number the namespace's. The call is a mutation like any other:
it takes an invocation id under `CF_INVOCATION_SESSION`, and its envelope is not
the evidence — the read of `shortName` after it is (`references/mutating.md`).

Every run also logs `Event dropped: speculative origin failed` once per Topic.
That counts the step's sends, not the Topics that missed: in the same rehearsal
all but one stored their number regardless. The per-Topic read above is the
count to trust.

### What a re-run writes

A re-run is safe. It is not idle, and on a board the size of the deployed one
the difference matters, because `pending` holding every Topic means every run
asks every Topic again. Per case:

- **The asking itself is a write.** A send is an ordinary write to the target's
  stream — `Cell.send` in `packages/runner/src/cell.ts` delegates to `set` — and
  every send in one run lands in the board's own transaction. So a run over a
  board of 125 Topics stages 125 writes, whatever the handlings then decide.
  That cost is per run and does not fall as Topics store their numbers, because
  the step cannot see that they have. A handling per Topic is the rest of it,
  but only where the Topic's source declares the stream: one that does not takes
  the last case below and dispatches nothing.
- **A Topic that already stores its number writes nothing further.**
  `recordName` compares the number asked for against its own input — which no
  switch gates — and returns before `upgradeTopicState` and before the write.
  This is the case "safe to repeat" is true of, and while numbers are hidden it
  is most of the board after the first run.
- **A Topic whose write did not land writes now.** That is what a re-run is for:
  the obstruction cleared, the asking arrives again, and the number is stored. A
  run is idle only over a board where nothing is outstanding.
- **A Topic that stores a different number refuses, and a refusal is not
  silence.** `recordName` rejects rather than overwriting, so that Topic's
  handling fails and is logged, once per run for as long as the disagreement
  stands. The same goes for a Topic parked at a state version no source supports
  — though only when the verb would otherwise write, since the already-stored
  return comes first.
- **A Topic whose source has no `recordName` yet takes the payload as data.**
  The send lands at `recordName` in that Topic's result document rather than
  running anything
  ([#7661](https://github.com/commontoolsinc/labs/issues/7661)), and it is
  written again on every run until that Topic's source moves. This is why step 2
  comes before step 3.

So: re-run when the audit finds something outstanding, not as a matter of
course. Each run costs one board transaction and one write per Topic; a handling
for each Topic whose source declares the verb, and none for one that does not;
and one logged failure per Topic in a state the verb refuses. After step 2 that
is a handling for every Topic, which is the shape to plan for. None of it
corrupts anything, and none of it is free.

Until the switch is on, read three things instead of `pending`:

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
already stores a different one. The way a Topic comes to store one the namespace
disagrees with is a direct `recordName` call carrying a number the board did not
allocate: the verb takes any well-formed member name, because a Topic holds no
namespace to check against, so the check belongs to whoever calls it. Read its
stored number, decide which number that Topic is to keep, and reconcile by hand;
nothing in the board resolves it, and each run costs one refused handler
transaction.

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
`deno task cf cell get //<space>/top/<n> title` answers as soon as the key is
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
deno task cf piece call --cell "$TOPICS_BOARD" --invocation '<id>' backfillNames \
  '{"agentName":"Sol"}'
# -> { "assigned": [], "named": [], "pending": ["1","2"] }

# what Topic 2 actually stores, which no switch gates
deno task cf cell get --cell "$TOPIC2" shortName --input
# -> fails, exit 1: Cannot access path "shortName" - property "shortName" not
#    found. Available keys: ...   (a Topic that has not stored one)

# and the number addresses the Topic anyway
deno task cf cell get //<space>/top/2 title
```

So the worst case is bounded: a number allocated, reachable, and permanently
that Topic's, on a Topic that does not yet show it. No content is touched, no
number is lost or reused, the board serves every Topic either way, and the
repair is another run of the step, or `recordName` on a Topic a run does not
reach ("Telling when it is done"). Nothing has to be undone.

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
| `recordName` on one Topic       | a write, not a read: the repair, whose `wrote` says whether it had to                                | the same                          |
| `//<space>/top/<n>`             | resolves to the Topic                                                                                | the same                          |

So while numbers are hidden, **the board's index answers nothing about storage**
— it is the read to skip, not the survey — and there is no board-wide read of
what Topics store. The read that works is one per Topic:

```bash
# what this Topic stores. No switch gates the durable input.
deno task cf cell get --cell "$TOPIC" shortName --input
```

`recordName` also answers the question, but it is a mutation, not a read: on a
Topic storing no number it writes the one it is handed. Use it only as the
repair in "Telling when it is done", with its invocation id and the read-back
that confirms it.

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

Audit only Topics whose source has already been migrated. Every targeted use of
an input path goes through one guard — `assertPieceInputPath` in
`packages/piece/src/ops/piece-input-path.ts`, which refuses a path the current
pattern's input schema does not select — so against a Topic whose pattern does
not declare `shortName`, reading it, writing it with
`deno task cf cell set --input`, and binding a link at it all fail the same way:

```
Cannot access path "shortName" - property "shortName" not found in the current
pattern's input schema. Update the target pattern with cf piece setsrc to
declare this input before linking, reading, or writing it.
```

That is step 2 restated by the runtime, and it is why step 2 is a prerequisite
rather than a nicety: updating the Topic's pattern is what makes the path
reachable at all.

### Traps

**`setsrc --check` issues no storage writes**, including when it refuses. Normal
reads can demand server-side materialization when server execution is active;
verify the clone's fingerprint before reusing its baseline. Applying source can
persist compilation artifacts before setup accepts it, so reset the clone with
`deno task cf space reset` before repeating an apply rehearsal.

**A number is permanent, and only the verb enforces that.** `recordName` refuses
a number that disagrees with one the Topic already stores, and writes nothing
when it agrees. A targeted `deno task cf cell set --input` write to `shortName`
carries no such guard and will overwrite or blank a stored number. The path
check above does not stand in for it: that one asks whether the pattern declares
`shortName` at all, and on a migrated Topic it passes and the write lands. So
reach for the verb, with the invocation id and read-back of the repair in
"Telling when it is done".

**A half-finished Topic is not an error state.** What it costs is above, under
"What a half-finished Topic looks like"; the repair is another run of the step,
or `recordName` directly for a Topic a run does not reach.

**A moved Topic does not move back.** `cf piece rollback` against the step-2
plan refuses, `result.recordName: existing result field was removed`, because
the old source publishes no `recordName`, and neither `rollback` nor
`cf piece restore` takes an override. Treat step 2 as roll-forward only, and
take what recovery would need immediately before a live run: a `VACUUM INTO`
snapshot of the space (`docs/development/space-clone-rehearsal.md`) and an
export with `scripts/topics-export.ts`.

**On a clone, `top/<n>` may not resolve.** The address needs the space's `top`
slug, and a clone that does not carry it answers `Slug "top" not found`. Read
the entry off the board instead, with
`deno task cf cell get --cell "$TOPICS_BOARD" names/<n> --input --select @`.

**The clone's free-cell check does not see Topic inputs.** The fingerprint does
not classify a Topic's input as a `free-cell`, so the authored-content reading
in `docs/development/space-clone-rehearsal.md` — a changed free-cell is a
clobber — passes a Topic whose title was overwritten as readily as one that only
gained a `shortName`. Compare the authored fields directly, pristine against
working: `title`, `body`, `comments`, `links`, `createdAt` and `createdBy`.
