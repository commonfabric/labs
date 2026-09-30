---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Record of the measurement #7439 reports, run again on a rig branch based on main after #7480: each figure against #7439's, the demand without boardNames, and a prototype pivot row holding topic identities as strings."
---

# A topic's demand over its board, measured again after #7480

#7439 reports what one topic's declared demand over its Topics board reaches:
the documents the memory server's graph query returns when it is rooted at that
topic's argument document under the schema recorded on the topic's argument
link. This record runs that measurement again on a rig branch whose base is a
`main` commit that includes #7480 (§ Provenance), and compares each figure with
the figure #7439's body and comments report for the same input and member count.
It also measures the demand with `boardNames` removed from it, which storing a
member's name on the member allows, and one prototype of the row shape #7439
names as its fix: a pivot row carrying identity as a value rather than as a
reference.

## Provenance

The work is on the local branch `experiment/7439-remeasure`, whose base is
`e1bbc1d549` on `main`. The rig is not in that base; the branch's own commits
add it. So no figure here was produced at `e1bbc1d549`: the measurement run ran
at `8a029b7dab`, and the control run at `a7ac8e4317` (§ What changed in the
rig). Each run printed the commit it ran at, and that line is quoted with its
figures. The base, its place on `main`, the presence of #7480 in it, the
branch's commits up to the one holding the last output quoted here, and the
commit among them that adds the rig:

```
$ git log -1 --format='%H %ad %s' --date=iso e1bbc1d549
e1bbc1d5497a0a975b906ff9677bf6451f94ef11 2026-09-15 11:42:40 -0700 Show only arrows on dashboard tile links (#7508)
$ git merge-base --is-ancestor e1bbc1d549 origin/main && echo 'e1bbc1d549 is an ancestor of origin/main'
e1bbc1d549 is an ancestor of origin/main
$ git log -1 --format='%h %s' c08e5d41f0
c08e5d41f0 fix(topics): a topic listed twice on a board gets one cross-reference row (#7480)
$ git merge-base --is-ancestor c08e5d41f0 e1bbc1d549 && echo 'c08e5d41f0 is an ancestor of e1bbc1d549'
c08e5d41f0 is an ancestor of e1bbc1d549
$ git log --format='%h %s' e1bbc1d549..a06fd0ea66
a06fd0ea66 experiment(topics): the comparison reads only the run's measurement lines
b7ac194790 experiment(topics): the run's figures beside the ones #7439 reports
451886f918 experiment(topics): demand of one topic over its board, both boards
8a029b7dab experiment(topics): the prototype's identity resolves a list entry first
c59c55d2a1 experiment(topics): drop the `schema: true` controls from the rig
8937f84128 experiment(topics): the whole-table `true` selector is refused
a7ac8e4317 experiment(topics): run the #7439 demand rig on main, with a row-shape prototype
5a3b020f43 chore(topics): the #7439 demand rig, as archived at cbdf66c3cf
$ git log --format='%h %s' --diff-filter=A e1bbc1d549..a06fd0ea66 -- packages/patterns/topics/measure-topic-demand.ts
5a3b020f43 chore(topics): the #7439 demand rig, as archived at cbdf66c3cf
```

## How to read this record

A block shows what a command printed or what a file contains. It cannot show
when something was done, or that something was not done, so statements of those
kinds rest on the author's account. Among them: that the archived script is the
one #7439's figures came from; that the runs were made on 2026-09-15; that
storing a member's name on the member was decided on 2026-09-15; that no
deployed space or toolshed was contacted, read-only calls included; that nothing
was pushed; and every statement that something was not measured, compared or
tried.

Each block of output is quoted as printed, with two kinds of trim, named where
each is used: terminal color codes removed, and a `sed` or `grep` in the quoted
command that kept only some lines. Commands ran at the root of the worktree
unless the section says otherwise.

## The answers

- **The counts #7439 reports are the same; the byte figures are not.** On the
  board as it stands, the `boardCrossrefs` and `boardNames` roots each reach N −
  1 other topics at N = 4, 10, 20 and 40, and the `mentionable` root reaches
  none, as #7439 reports. Every byte figure is lower than #7439's, and an
  other-topic document is 37,784 to 37,785 bytes here against 63,284 to 63,285
  there (§ Comparison with #7439).
- **With `boardNames` removed, the demand still reaches N − 1 other topics** on
  the board as it stands, at every N and density measured (§ With `boardNames`
  removed).
- **The prototype row brings `boardCrossrefs` to no other topic** at every N and
  density measured, while `boardNames` reaches N − 1 in the same store (§ The
  prototype's figures). `mentionable` reaches no other topic on either board,
  and the prototype does not change it. On the prototype board with `boardNames`
  also removed, the whole argument walk reaches a number of other topics equal
  to the density: none at density 0, and 2 at density 2 at every N (§ With
  `boardNames` removed).

## Setup

The command that produced `02-ladder.stdout.txt` and `02-ladder.stderr.txt` is
named in the message of the commit that holds them:

```
$ git log -1 --format=%B 451886f918
experiment(topics): demand of one topic over its board, both boards

Output of `deno run -A packages/patterns/topics/measure-topic-demand.ts
4:2 10:2 20:2 40:2 10:0 10:1 10:3 10:6`, run at 8a029b7dab, exit 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Kp8NcNXPougGPyJCEyYtob
```

That this command produced those two files, and exited 0, rests on the author's
account: no committed file records the invocation. The run also prints the
commit it ran at, the worktree's status, its arguments, the store, and the
experimental options, both those read from the environment and those the first
board's runtime resolved:

```
$ sed -n 1,10p packages/patterns/topics/demand-runs/02-ladder.stdout.txt
# git rev-parse HEAD: 8a029b7dab92615f6d4a26bc72176a6e12ba26fa
# git status --short at start:
?? packages/patterns/topics/demand-runs/02-ladder.stderr.txt
?? packages/patterns/topics/demand-runs/02-ladder.stdout.txt
# deno 2.9.4
# arguments: ["4:2","10:2","20:2","40:2","10:0","10:1","10:3","10:6"]
# arms: current=main.tsx rows=main-rows.tsx
# store: one StorageManager.emulate per board, queried through MemoryV2Client.loopback on that store's server
# experimental options read from the environment: {}
# runtime.experimental (resolved, first board): {"modernCellRep":false,"commitPreconditions":true,"plainResultReceipts":true,"computedCellIds":true,"lazyMaterialization":true,"serverExecution":false,"contentAddressedSchemas":true,"readerSchemaPrecedence":true}
```

Each argument is `<N>:<density>`: #7439's member counts N = 4, 10, 20 and 40 at
density 2, and N = 10 at densities 0, 1, 3 and 6. Each argument builds two
boards, each in its own store: `current`, which is `main.tsx` as it stands, and
`rows`, which is `main-rows.tsx` (§ The prototype files). The rig files N topics
through `addTopic`, and then each topic sends `mention` for the next `density`
topics, wrapping, so topic 0 is mentioned by `density` topics:

```
$ git show 8a029b7dab:packages/patterns/topics/measure-topic-demand.ts | sed -n '/const addTopic = result.key("addTopic");/,/await runtime.storageManager.synced();/p'
  const addTopic = result.key("addTopic");
  for (let n = 1; n <= size; n++) {
    await addTopic.pull();
    await runtime.editWithRetry((tx) =>
      addTopic.withTx(tx).send({
        title: `Topic ${n}`,
        body: `Body of topic ${n}. ${"x".repeat(400)}`,
        agentName: "probe",
      })
    );
  }
  await runtime.idle();

  const topics = result.key("topics");
  await topics.pull();
  const listed = topics.get() ?? [];
  if (listed.length !== size) {
    throw new Error(`expected ${size} topics, board holds ${listed.length}`);
  }

  stage(arm, size, density, "mention");
  const topicCells: Json[] = [];
  for (let index = 0; index < size; index++) {
    topicCells.push(topics.key(index).resolveAsCell());
  }
  for (let from = 0; from < size; from++) {
    for (let step = 1; step <= density; step++) {
      const to = (from + step) % size;
      if (to === from) continue;
      const stream = topicCells[from].key("mention");
      await stream.pull();
      await runtime.editWithRetry((tx) =>
        stream.withTx(tx).send({ topic: topicCells[to] })
      );
    }
  }
  await runtime.idle();
  await runtime.storageManager.synced();
```

## The instrument

The rig is `packages/patterns/topics/measure-topic-demand.ts` from the archive
`~/projects/labs-throwaway/board-demand-rigs-2026-09-07.tar.gz`, with the
changes § What changed in the rig lists. The archive's listing, and its copy of
the script against the one committed unchanged as `5a3b020f43`:

```
$ tar tzf ~/projects/labs-throwaway/board-demand-rigs-2026-09-07.tar.gz
packages/patterns/collection-naming/board-b.tsx
packages/patterns/collection-naming/board-c.tsx
packages/patterns/collection-naming/item-b.tsx
packages/patterns/collection-naming/item-c.tsx
packages/patterns/collection-naming/diagnose-board-demand.ts
packages/patterns/collection-naming/measure-board-demand.ts
packages/patterns/collection-naming/probe-crossing.ts
packages/patterns/collection-naming/probe-mechanism.ts
packages/patterns/collection-naming/probe-roots.ts
packages/patterns/topics/measure-topic-demand.ts
$ tar xzOf ~/projects/labs-throwaway/board-demand-rigs-2026-09-07.tar.gz packages/patterns/topics/measure-topic-demand.ts | shasum -a 256
2beda90b14d3e09d21337b1d1814b192eb534ec3261c3c19f2228956c1d84e97  -
$ git show 5a3b020f43:packages/patterns/topics/measure-topic-demand.ts | shasum -a 256
2beda90b14d3e09d21337b1d1814b192eb534ec3261c3c19f2228956c1d84e97  -
$ cmp <(tar xzOf ~/projects/labs-throwaway/board-demand-rigs-2026-09-07.tar.gz packages/patterns/topics/measure-topic-demand.ts) <(git show 5a3b020f43:packages/patterns/topics/measure-topic-demand.ts) && echo 'cmp: identical'
cmp: identical
```

The lines the measurement rests on are the same in the archived rig, committed
unchanged as `5a3b020f43`, and in the rig that ran, `8a029b7dab`: the store, the
loopback session, the query, the whole-walk selector at `path: []`, the
per-input selector, and the byte count:

```
$ for ref in 5a3b020f43 8a029b7dab; do echo "=== $ref"; git show "$ref:packages/patterns/topics/measure-topic-demand.ts" | grep -n -E 'const bytesOf|new TextEncoder\(\)\.encode\(JSON\.stringify|StorageManager\.emulate\(|loopback\(|client\.mount\(space, \{\}, testSessionOpenAuthFactory\)|session\.queryGraph\(\{ roots \}\)|selector: \{ path: \[\], schema|path: \[\.\.\.\(link\.path|schema: withoutAsCell\(deref\(propertySchema\)\)'; done
=== 5a3b020f43
40:const bytesOf = (value: unknown) =>
41:  new TextEncoder().encode(JSON.stringify(value)).length;
60:  const storageManager = StorageManager.emulate({ as: signer });
170:        path: [...(link.path ?? []) as string[]],
171:        schema: withoutAsCell(deref(propertySchema)),
180:    transport: MemoryV2Client.loopback(candidate.server()!),
182:  const session = await client.mount(space, {}, testSessionOpenAuthFactory);
204:    const frame = await session.queryGraph({ roots });
216:    selector: { path: [], schema: argumentLink.schema },
=== 8a029b7dab
67:const bytesOf = (value: unknown) =>
68:  new TextEncoder().encode(JSON.stringify(value)).length;
121:  const storageManager = StorageManager.emulate({ as: signer });
268:        path: [...(link.path ?? []) as string[]],
269:        schema: withoutAsCell(deref(propertySchema)),
278:    transport: MemoryV2Client.loopback(candidate.server!()),
280:  const session = await client.mount(space, {}, testSessionOpenAuthFactory);
317:    const frame = await session.queryGraph({ roots });
368:    query([{ id: argumentLink.id, selector: { path: [], schema } }]);
```

The whole walk is rooted at topic 0's argument document under the schema
recorded on its argument link (`as recorded`). A per-input query is rooted at
the document one input's stored link names, under that input's property schema
with the top-level `asCell` and `asStream` markers removed. Bytes are the UTF-8
length of the returned documents serialized as JSON, which is not a byte count
on the wire; an empty result is `[]`, 2 bytes. Each figure is one query, not a
resume.

A returned document counts as another topic's by two rules. The rail rule, the
`others`, `topics`, `otherBytes` and `share` columns of the run's figures table
and the `oth` columns of the comparison, counts a document whose id is the
result document, or the argument or pattern rail document, of a topic other than
topic 0. The family rule, the `famDoc` to `famShr` columns, also counts a
document whose chain of `result` backlinks reaches such a topic's result
document:

```
$ git show 8a029b7dab:packages/patterns/topics/measure-topic-demand.ts | sed -n '/Whose document is whose, by id/,/const others = entities.filter/p'
  // Whose document is whose, by id: the result document and the argument and
  // pattern rail documents of the board and of each topic. An id two of them
  // name is recorded as `shared` and counted as nobody's.
  const owner = new Map<string, string>();
  const note = (id: string, who: string) => {
    const known = owner.get(id);
    owner.set(id, known === undefined || known === who ? who : "shared");
  };
  const railsNoted: Record<string, number> = {};
  const noteFamily = (cell: Json, who: string) => {
    note(cell.getAsNormalizedFullLink().id, who);
    railsNoted.result = (railsNoted.result ?? 0) + 1;
    for (const rail of ["argument", "pattern"] as const) {
      const link = getMetaLink(cell, rail);
      if (link === undefined) continue;
      note(link.id, who);
      railsNoted[rail] = (railsNoted[rail] ?? 0) + 1;
    }
  };
  noteFamily(resultCell, "board");
  topicCells.forEach((cell, index) =>
    noteFamily(cell, index === 0 ? "self" : `other${index}`)
  );
  const topicResultIds = new Map<string, string>(
    topicCells.map((cell, index) => [
      cell.getAsNormalizedFullLink().id,
      index === 0 ? "self" : `other${index}`,
    ]),
  );
  const boardResultId = resultCell.getAsNormalizedFullLink().id;

  const shareOf = (part: number, whole: number, count: number) =>
    count === 0 ? "0.0%" : `${(100 * part / whole).toFixed(1)}%`;

  const query = async (roots: Json[]): Promise<Figures> => {
    const frame = await session.queryGraph({ roots });
    const entities = frame.entities as Json[];
    // Each returned document's `result` backlink, where it carries one.
    const backlink = new Map<string, string>();
    for (const entity of entities) {
      const raw = entity.document?.result;
      if (raw === undefined) continue;
      const link = parseLink(raw, { ...argumentLink, id: entity.id, path: [] });
      if (link?.id !== undefined) backlink.set(entity.id, link.id);
    }
    const familyOf = (id: string): string | undefined => {
      const seen = new Set<string>();
      let current: string | undefined = id;
      while (current !== undefined && !seen.has(current)) {
        const byId = owner.get(current);
        if (byId !== undefined) return byId;
        seen.add(current);
        const parent = backlink.get(current);
        if (parent === undefined) return undefined;
        const topic = topicResultIds.get(parent);
        if (topic !== undefined) return topic;
        if (parent === boardResultId) return "board";
        current = parent;
      }
      return undefined;
    };
    const others = entities.filter((entity) =>
```

`others` counts the attributed documents and `topics` the distinct topics among
them, and the comparison's `oth` column is `others`. The two are equal in every
row of the run's figures table, so each other-topic count this record states is
both a document count and a count of distinct topics:

```
$ git show 8a029b7dab:packages/patterns/topics/measure-topic-demand.ts | sed -n '/otherDocs: others.length,/,/otherTopics:/p'
      otherDocs: others.length,
      otherTopics: new Set(others.map((entity) => owner.get(entity.id))).size,
$ /usr/bin/grep -c '|  *[0-9][0-9]*  *[0-9][0-9]*  *[0-9][0-9]*  *[0-9][0-9]*  *[0-9][0-9]*  *[0-9][0-9]*\.[0-9]%' packages/patterns/topics/demand-runs/02-ladder.stdout.txt
208
$ /usr/bin/grep -c '|  *[0-9][0-9]*  *[0-9][0-9]*  *\([0-9][0-9]*\)  *\1  *[0-9][0-9]*  *[0-9][0-9]*\.[0-9]%' packages/patterns/topics/demand-runs/02-ladder.stdout.txt
208
```

The first pattern matches a row of that table: after the scope column, five
numbers and a percentage. The second matches a row whose third and fourth
numbers, `others` and `topics`, hold the same value, and it matches all 208 of
them. The table holds one row per scope for each of the 16 boards the run built,
and the comparison reads the same figures from the run's JSON lines.
`/usr/bin/grep` is BSD grep, whose basic regular expressions carry the
back-reference the second pattern needs.

## What changed in the rig

The archived rig ran at `cbdf66c3cf`. Commits `a7ac8e4317` to `8a029b7dab`
changed it as follows.

- Two boards per argument, as § Setup describes.
- The `comparable` marker variants are removed; that marker is not re-tried
  here.
- The family rule, and a `shared` label for an id two topics' rails both name,
  which counts as nobody's.
- The whole walk is measured four ways: as recorded; as an inline copy of the
  recorded schema, which returns the same figures as the recorded schema in
  every row quoted in § The prototype's figures; without `boardNames`; and
  without `boardNames` and `boardCrossrefs`.
- A `mentionable` control naming the row's `piece` reference.
- Checks per board: the pivot's row count, topic 0's own row, and topic 0's
  `referencedBy`.
- The header above, and stage markers on standard error.
- `"internal"` is dropped from the rails the rail rule records.

The archived rig passed `"internal"` to `getMetaLink`. At `cbdf66c3cf`,
`META_LINK_FIELDS` already did not contain it, and no commit from there to the
base changed the number of occurrences of `"internal"` in that file, which is
what `git log -S` counts:

```
$ git show 5a3b020f43:packages/patterns/topics/measure-topic-demand.ts | grep -n 'for (const rail of'
188:    for (const rail of ["argument", "internal", "pattern"] as const) {
```

```
$ git show cbdf66c3cf:packages/runner/src/meta-seam.ts | sed -n 3,9p
export const META_LINK_FIELDS = Object.freeze(
  [
    "pattern",
    "argument",
    "result",
  ] as const,
);
$ git log --oneline -S'"internal"' cbdf66c3cf..e1bbc1d549 -- packages/runner/src/meta-seam.ts | wc -l
       0
```

So the message of commit `a7ac8e4317`, which says `internal` "is no longer a
meta link field", is wrong: it was not one at `cbdf66c3cf` either. What the
archived rig's call returned at `cbdf66c3cf` is not established.

A `schema: true` control was tried and dropped. The rig carried one on the
`boardCrossrefs` root and one on the `mentionable` root, the last entry of each
control table, and none on `boardNames`:

```
$ git show a7ac8e4317:packages/patterns/topics/measure-topic-demand.ts | sed -n '/const crossrefMutations = await mutationsOf(/,/^  );/p'
  const crossrefMutations = await mutationsOf(
    "boardCrossrefs",
    (base) => [
      ["nothing named", rowsUnder(base, {})],
      ["topic only", rowsUnder(base, { topic: { type: "unknown" } })],
      [
        "mentionedBy only",
        rowsUnder(base, {
          mentionedBy: { type: "array", items: { type: "unknown" } },
        }),
      ],
      ["as declared", base],
      ["schema true", true],
    ],
  );
$ git show a7ac8e4317:packages/patterns/topics/measure-topic-demand.ts | sed -n '/const mentionableMutations = await mutationsOf(/,/^  );/p'
  const mentionableMutations = await mutationsOf(
    "mentionable",
    (base) => [
      ["as declared", base],
      ["piece named", rowsUnder(base, { piece: { type: "unknown" } })],
      ["schema true", true],
    ],
  );
```

The control run took `--arms=current`, so it built only the board as it stands,
and it printed its header and no measurement line. The last stage marker before
the rejection is the `schema true` query on the `boardCrossrefs` root, and no
stage marker for the `mentionable` control follows it, so the `boardCrossrefs`
control is the one this block shows refused and the `mentionable` one was never
reached. No `schema: true` query on `boardNames`, and none on the prototype
board, is part of this record. Color codes removed:

```
$ cat packages/patterns/topics/demand-runs/01-schema-true-control.stdout.txt
# git rev-parse HEAD: a7ac8e4317bfbff42613348bd1461183c749153a
# git status --short at start:
?? packages/patterns/topics/demand-runs/
# deno 2.9.4
# arguments: ["--arms=current","3:1"]
# arms: current=main.tsx
# store: one StorageManager.emulate per board, queried through MemoryV2Client.loopback on that store's server
# experimental options read from the environment: {}
$ cat packages/patterns/topics/demand-runs/01-schema-true-control.stderr.txt
# stage current 3:1 build board
Can't load profile-create.tsx
# stage current 3:1 add topics
Can't load profile-create.tsx
# stage current 3:1 mention
# stage current 3:1 checks: pivot rows
# stage current 3:1 checks: referencedBy
# stage current 3:1 argument link
# stage current 3:1 queries: whole
# stage current 3:1 queries: per input
# stage current 3:1 queries: boardCrossrefs nothing named
# stage current 3:1 queries: boardCrossrefs topic only
# stage current 3:1 queries: boardCrossrefs mentionedBy only
# stage current 3:1 queries: boardCrossrefs as declared
# stage current 3:1 queries: boardCrossrefs schema true
SES_UNHANDLED_REJECTION: [Error [QueryError]: session scoped memory operations require a principal]
```

`resolveScopeKey` in `packages/memory/v2.ts` raises that message for a
session-scoped read made with no principal, and the rig mounts its session
through `testSessionOpenAuthFactory`:

```
$ sed -n 140,160p packages/memory/v2.ts
export const resolveScopeKey = (
  scope: CellScope | undefined,
  identity: ScopeKeyIdentity,
): ScopeKey => {
  switch (scope ?? "space") {
    case "space":
      return "space";
    case "user":
      if (!identity.principal) {
        throw new ProtocolError(
          "user scoped memory operations require a principal",
        );
      }
      return `user:${encodeScopeKeyPart(identity.principal)}`;
    case "session":
      if (!identity.principal) {
        throw new ProtocolError(
          "session scoped memory operations require a principal",
        );
      }
      if (!identity.sessionId) {
$ grep -n 'testSessionOpenAuthFactory)' packages/patterns/topics/measure-topic-demand.ts
280:  const session = await client.mount(space, {}, testSessionOpenAuthFactory);
```

## The prototype files

`topic-rows.tsx` and `main-rows.tsx` are copies of `topic.tsx` and `main.tsx`.
Everything that separates them, run in `packages/patterns/topics/`:

```
$ diff main.tsx main-rows.tsx
0a1,8
> /**
>  * A copy of `main.tsx` whose mention pivot writes the row shape
>  * `topic-rows.tsx` declares, topic identities as strings, and which files
>  * `topic-rows.tsx` topics. For measuring a topic's declared demand over the
>  * pivot only. Comments outside the regions that differ from `main.tsx` are
>  * copied unchanged and describe `main.tsx`.
>  */
> 
31a40
>   identityOf,
45c54
< } from "./topic.tsx";
---
> } from "./topic-rows.tsx";
68c77
< } from "./topic.tsx";
---
> } from "./topic-rows.tsx";
370,375c379,389
<       const inbound = mentionedBy(topic, list, mentions);
<       // Addressed by the topic it describes, so a row keeps its identity
<       // wherever it sits and however the board is reordered. That is what lets
<       // every topic's lookup re-run freely on any board change and still write
<       // nothing: an unchanged row recomputes to the same links at the same
<       // address.
---
>       const identity = identityOf(topic);
>       // A topic with no identity to record gets no row, as an entry with
>       // nothing behind it gets none.
>       if (identity === undefined) return;
>       const inbound = mentionedBy(topic, list, mentions)
>         .map((source) => identityOf(source))
>         .filter((source): source is string => source !== undefined);
>       // Addressed by the topic it describes, so a row keeps its address
>       // wherever it sits and however the board is reordered. The row holds
>       // identities as strings and no reference, so no reader of the table has
>       // a link to follow into a topic.
378c392
<           topic,
---
>           topic: identity,
$ diff topic.tsx topic-rows.tsx
0a1,9
> /**
>  * A copy of `topic.tsx` whose board mention pivot rows carry topic identities
>  * as string values rather than cell references, for measuring what a topic's
>  * declared demand over the pivot reaches. A measurement prototype, not a
>  * design: the "Referenced by" list shows identities rather than links.
>  * Comments outside the regions that differ from `topic.tsx` are copied
>  * unchanged and describe `topic.tsx`.
>  */
> 
7c16,17
<   equals,
---
>   entityRefToString,
>   getEntityId,
514,518c524,527
<  * Both sides are declared `unknown`, which is the whole design rather than a
<  * shortcut. A row holds cell REFERENCES — `unknown` is the declaration that
<  * lets a cell be written into one without a cast, and the one that stops any
<  * reader of the table expanding a topic it did not ask for. Each consumer
<  * declares what it wants to see through them.
---
>  * Both sides hold a topic's identity as a string value, as `identityOf`
>  * returns it, and the row holds no cell reference. No position in a row is a
>  * link, so no reader of the table, whatever schema it declares, has a link
>  * here to follow into a topic.
521,526c530,534
<   /** The topic this row is about. `unknown` because it is written as a
<    * reference and only ever compared — `equals` takes the raw link. Anything
<    * wider retrieves the piece instead of pointing at it: declared `object`,
<    * this field reads back as the whole expanded topic, `$UI` tree included. */
<   topic: unknown;
<   mentionedBy: unknown[];
---
>   /** The identity of the topic this row is about. */
>   topic: string;
> 
>   /** The identities of the topics that mention it. */
>   mentionedBy: string[];
529a538,555
>  * A topic's identity as a value: the entity id of the document `topic` links
>  * to, as a string, or `undefined` for a value carrying no link. A cell is
>  * resolved to the document it links to first, because a cell addressing a
>  * position in a list carries the list's document and a path, from which
>  * `getEntityId` derives an id of its own. Two cells in different spaces or
>  * scopes can share an entity id, so the string identifies a topic only among
>  * topics of one space and scope.
>  */
> export function identityOf(topic: unknown): string | undefined {
>   const resolvable = topic as { resolveAsCell?: () => unknown } | undefined;
>   const target = typeof resolvable?.resolveAsCell === "function"
>     ? resolvable.resolveAsCell()
>     : topic;
>   const ref = getEntityId(target);
>   return ref === undefined ? undefined : entityRefToString(ref);
> }
> 
> /**
683,690c709,711
<   /** The topics that mention this one, read out of the board's pivot.
<    *
<    * Declared through `TopicSummary` rather than `TopicPiece`, and that is
<    * load-bearing rather than stingy: a topic whose backlinks were topics would
<    * be a type that contains itself, and resolving one from a list would walk
<    * the graph. The summary carries no reference of its own, so it terminates.
<    * A reader that wants more follows the link, which resolves whole. */
<   referencedBy: TopicSummary[] | Default<[]>;
---
>   /** The identities of the topics that mention this one, read out of the
>    * board's pivot. */
>   referencedBy: string[] | Default<[]>;
1695,1699c1716,1717
<  * This topic's INBOUND references: its own row of the board's pivot.
<  *
<  * The board has already done the join, so this is a lookup, and it is written
<  * as one — find the row whose `topic` is this piece, hand back its
<  * `mentionedBy`. Nothing else about the table is touched.
---
>  * This topic's INBOUND references: the identities its own row of the board's
>  * pivot lists.
1701,1712c1719,1722
<  * It re-runs whenever any row changes, which at board scale is often. That is
<  * fine, and deliberately so: the rows are addressed by the topic each describes
<  * rather than by position, so a re-run over an unchanged board recomputes the
<  * same links and writes nothing. What would make it expensive is reading
<  * through the references, which is why the parameter declares them `unknown`:
<  * `topic` is compared by identity and `mentionedBy` is passed through as links,
<  * so surveying the whole table expands no topic at all.
<  *
<  * HACK, as elsewhere in this pattern: reads `unknown[]`, publishes
<  * `TopicSummary[]`. A reference through a lift is a link and resolves to the
<  * whole topic however little the lift declared, so the assertion states what a
<  * consumer receives while the narrow parameter bounds what this reads.
---
>  * The board has already done the join, so this is a lookup by identity: find
>  * the row whose `topic` is this topic's own identity, and return its
>  * `mentionedBy`. Every position the parameter declares holds a string, so
>  * surveying the whole table reads no topic.
1716,1718c1726
<     table:
<       | { topic: ComparableCell<unknown>; mentionedBy: unknown[] }[]
<       | Default<[]>;
---
>     table: { topic: string; mentionedBy: string[] }[] | Default<[]>;
1721,1730c1729,1735
< ): TopicSummary[] =>
<   // `filter` + `flatMap` rather than `find`, so a topic with no row on the
<   // table — no board wired in — yields an empty array from the shape of the
<   // expression instead of from a `?? []` bolted onto a miss. At most one row
<   // matches: the board's pivot builds one row per distinct topic, compared by
<   // `equals` as this lookup compares.
<   table
<     .filter((row) => equals(self, row.topic))
<     .flatMap((row) => row.mentionedBy) as TopicSummary[]
< );
---
> ): string[] => {
>   const own = identityOf(self);
>   // A topic with no identity matches no row, and so has no inbound references.
>   return table
>     .filter((row) => own !== undefined && row.topic === own)
>     .flatMap((row) => row.mentionedBy);
> });
2696,2697c2701,2702
<                       {referencedBy.map((topic) => (
<                         <cf-cell-link $cell={topic} />
---
>                       {referencedBy.map((identity) => (
>                         <cf-text variant="caption">{identity}</cf-text>
```

A pivot row holds the identity of the topic it is about and the identities of
the topics that mention it, as the strings `identityOf` returns, and holds no
cell reference. `backlinksOf` compares strings, and `referencedBy` is those
strings. The pattern check printed no diagnostic. Color codes removed:

```
$ deno task cf check packages/patterns/topics/main-rows.tsx 2>&1; echo "exit $?"
Task cf deno run --allow-run --allow-env --allow-read ./packages/cli/launcher.ts 'check' 'packages/patterns/topics/main-rows.tsx'
exit 0
```

The recorded `boardCrossrefs` selector names a different item schema document on
the two boards, and the `mentionable` and `boardNames` selectors name the same
one on both:

```
$ sed -n '/^# selector schemas/,/^# figures/p' packages/patterns/topics/demand-runs/02-ladder.stdout.txt | grep -o -E '"arm":"[a-z]+"|"(mentionable|boardCrossrefs|boardNames)":\{"path":\[\],"schema":\{"type":"array","items":\{"\$ref":"cid:[^"]*"'
"arm":"current"
"mentionable":{"path":[],"schema":{"type":"array","items":{"$ref":"cid:fid1:o9_xws8kA2PUaMM3h6PSpbSURgqpIYMXC5sHppTW6Ms"
"boardCrossrefs":{"path":[],"schema":{"type":"array","items":{"$ref":"cid:fid1:PSkgYKxo6q5qw9_wLFI0u_1bca_wmwhML0Dv5pUz-Mc"
"boardNames":{"path":[],"schema":{"type":"array","items":{"$ref":"cid:fid1:vochz27BM86ZAYGA8R1unn5cl3nflz2ntAUO5UoVeLU"
"arm":"rows"
"mentionable":{"path":[],"schema":{"type":"array","items":{"$ref":"cid:fid1:o9_xws8kA2PUaMM3h6PSpbSURgqpIYMXC5sHppTW6Ms"
"boardCrossrefs":{"path":[],"schema":{"type":"array","items":{"$ref":"cid:fid1:TvEzLewzcDq_kWv2CSss9kGTCQvojQKLpj6GwClzgY8"
"boardNames":{"path":[],"schema":{"type":"array","items":{"$ref":"cid:fid1:vochz27BM86ZAYGA8R1unn5cl3nflz2ntAUO5UoVeLU"
```

Checks per board. `ownRowMentionedBy` is the length of topic 0's own row's
`mentionedBy`, `referencedBy` the length of topic 0's `referencedBy`, and
`rowIdsEqualTopicIds` compares the prototype's row identities with the topics'
ids:

```
$ sed -n '/^## 0\./,/^$/p' packages/patterns/topics/demand-runs/03-compare-7439.txt
## 0. Checks per board, from the run's JSON lines
arm      N  d | pivotRows ownRowFound ownRowMentionedBy referencedBy rowIdsEqualTopicIds railsNoted sharedIds runtimeErrors
current  4  2 |         4        true                 2            2                 n/a {"result":5,"argument":5} 0 0
rows     4  2 |         4        true                 2            2                true {"result":5,"argument":5} 0 0
current 10  2 |        10        true                 2            2                 n/a {"result":11,"argument":11} 0 0
rows    10  2 |        10        true                 2            2                true {"result":11,"argument":11} 0 0
current 20  2 |        20        true                 2            2                 n/a {"result":21,"argument":21} 0 0
rows    20  2 |        20        true                 2            2                true {"result":21,"argument":21} 0 0
current 40  2 |        40        true                 2            2                 n/a {"result":41,"argument":41} 0 0
rows    40  2 |        40        true                 2            2                true {"result":41,"argument":41} 0 0
current 10  0 |        10        true                 0            0                 n/a {"result":11,"argument":11} 0 0
rows    10  0 |        10        true                 0            0                true {"result":11,"argument":11} 0 0
current 10  1 |        10        true                 1            1                 n/a {"result":11,"argument":11} 0 0
rows    10  1 |        10        true                 1            1                true {"result":11,"argument":11} 0 0
current 10  3 |        10        true                 3            3                 n/a {"result":11,"argument":11} 0 0
rows    10  3 |        10        true                 3            3                true {"result":11,"argument":11} 0 0
current 10  6 |        10        true                 6            6                 n/a {"result":11,"argument":11} 0 0
rows    10  6 |        10        true                 6            6                true {"result":11,"argument":11} 0 0
```

On every board the pivot holds N rows, topic 0's own row is found, and both
lengths equal the density. On every prototype board the row identities equal the
topic ids. No id is labeled `shared`, no runtime error was recorded, and no
`pattern` rail link resolved on any board.

## Comparison with #7439

The figures in this section come from the run § Setup describes. Its command,
and the commit, arguments, store and runtime options the run printed:

```
$ git log -1 --format=%B 451886f918
experiment(topics): demand of one topic over its board, both boards

Output of `deno run -A packages/patterns/topics/measure-topic-demand.ts
4:2 10:2 20:2 40:2 10:0 10:1 10:3 10:6`, run at 8a029b7dab, exit 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Kp8NcNXPougGPyJCEyYtob
$ sed -n '1p;6,10p' packages/patterns/topics/demand-runs/02-ladder.stdout.txt
# git rev-parse HEAD: 8a029b7dab92615f6d4a26bc72176a6e12ba26fa
# arguments: ["4:2","10:2","20:2","40:2","10:0","10:1","10:3","10:6"]
# arms: current=main.tsx rows=main-rows.tsx
# store: one StorageManager.emulate per board, queried through MemoryV2Client.loopback on that store's server
# experimental options read from the environment: {}
# runtime.experimental (resolved, first board): {"modernCellRep":false,"commitPreconditions":true,"plainResultReceipts":true,"computedCellIds":true,"lazyMaterialization":true,"serverExecution":false,"contentAddressedSchemas":true,"readerSchemaPrecedence":true}
```

The sections below are quoted from `03-compare-7439.txt`, printed by a script
that reads the run's measurement lines and holds #7439's figures typed in, each
labeled with where the issue states it. The commit that holds the output names
its command, and running that command again prints the committed file:

```
$ git log -1 --format=%B a06fd0ea66 | sed -n '1,/^$/d; /^Co-Authored-By/,$d; p'
The run's output also holds its selector schemas as JSON lines without
`checks`, so compare-7439.ts threw after table 0 and the output committed
in b7ac194790 stops there. The output here is the whole of
`deno run --allow-read packages/patterns/topics/demand-runs/compare-7439.ts`,
exit 0.
$ deno run --allow-read packages/patterns/topics/demand-runs/compare-7439.ts | diff - packages/patterns/topics/demand-runs/03-compare-7439.txt && echo identical
identical
```

### The body table

```
$ sed -n '/^## 1\./,/^$/p' packages/patterns/topics/demand-runs/03-compare-7439.txt
## 1. #7439 body table against arm `current`, density 2, for the two roots its `frame` column could be
 N | source                        | docs      bytes oth otherBytes  share | bytes diff  otherBytes diff  otherBytes/others
 4 | #7439 body table              |         385,475   3    189,853  49.3% |                                       63,284
   | now: whole as recorded        |  101    240,221   3    113,353  47.2% |   -145,254         -76,500            37,784
   | now: input boardCrossrefs     |   87    231,651   3    113,353  48.9% |   -153,824         -76,500            37,784
10 | #7439 body table              |         775,509   9    569,563  73.4% |                                       63,285
   | now: whole as recorded        |  125    477,258   9    340,063  71.3% |   -298,251        -229,500            37,785
   | now: input boardCrossrefs     |  105    464,656   9    340,063  73.2% |   -310,853        -229,500            37,785
20 | #7439 body table              |       1,425,598  19  1,202,413  84.3% |                                       63,285
   | now: whole as recorded        |  165    872,347  19    717,913  82.3% |   -553,251        -484,500            37,785
   | now: input boardCrossrefs     |  135    852,996  19    717,913  84.2% |   -572,602        -484,500            37,785
40 | #7439 body table              |       2,725,831  39  2,468,115  90.5% |                                       63,285
   | now: whole as recorded        |  245  1,662,578  39  1,473,615  88.6% | -1,063,253        -994,500            37,785
   | now: input boardCrossrefs     |  195  1,629,721  39  1,473,615  90.4% | -1,096,110        -994,500            37,785
```

- Other-topic documents: 3, 9, 19 and 39 at N = 4, 10, 20 and 40, in #7439 and
  here, under both roots.
- Other-topic bytes: 76,500, 229,500, 484,500 and 994,500 fewer here. Per
  other-topic document, 63,284 to 63,285 bytes in #7439 and 37,784 to 37,785
  here.
- Frame bytes: 145,254 to 1,063,253 fewer here against the whole walk, and
  153,824 to 1,096,110 fewer against the `boardCrossrefs` root.
- Share: 49.3%, 73.4%, 84.3% and 90.5% in #7439; 47.2%, 71.3%, 82.3% and 88.6%
  for the whole walk here, and 48.9%, 73.2%, 84.2% and 90.4% for the
  `boardCrossrefs` root.
- Documents in the frame: #7439's table gives no count; here 101, 125, 165 and
  245 for the whole walk, and 87, 105, 135 and 195 for the `boardCrossrefs`
  root.
- #7439's body does not say which root its `frame` column measures. At N = 20
  that frame, 1,425,598 bytes, is larger than the body's own `as declared` row
  on the `boardCrossrefs` root, 1,385,039 bytes (§ `as declared` at N = 20), as
  the whole walk here is larger than the `boardCrossrefs` root.

### Density at N = 10

```
$ sed -n '/^## 2\./,/^$/p' packages/patterns/topics/demand-runs/03-compare-7439.txt
## 2. #7439 body: at N = 10, 9 documents / 569,563 bytes at density 0, 1, 3 and 6; arm `current` now
 d | root                       | docs      bytes oth otherBytes  share | otherDocs diff  otherBytes diff
 0 | whole as recorded          |  124    472,381   9    340,063  72.0% |              0        -229,500
 0 | input boardCrossrefs       |  105    461,443   9    340,063  73.7% |              0        -229,500
 1 | whole as recorded          |  125    475,486   9    340,063  71.5% |              0        -229,500
 1 | input boardCrossrefs       |  105    463,046   9    340,063  73.4% |              0        -229,500
 2 | whole as recorded          |  125    477,258   9    340,063  71.3% |              0        -229,500
 2 | input boardCrossrefs       |  105    464,656   9    340,063  73.2% |              0        -229,500
 3 | whole as recorded          |  125    479,029   9    340,063  71.0% |              0        -229,500
 3 | input boardCrossrefs       |  105    466,266   9    340,063  72.9% |              0        -229,500
 6 | whole as recorded          |  125    484,341   9    340,063  70.2% |              0        -229,500
 6 | input boardCrossrefs       |  105    471,096   9    340,063  72.2% |              0        -229,500
```

- Other-topic documents and bytes: 9 and 340,063 at densities 0, 1, 2, 3 and 6.
  #7439 reports 9 documents and 569,563 bytes at densities 0, 1, 3 and 6: the
  same count, and 229,500 fewer bytes here.
- #7439 calls the cost identical at those densities. Here the other-topic
  figures are identical and the frame bytes are not: the whole walk returns
  472,381, 475,486, 477,258, 479,029 and 484,341 bytes, and the `boardCrossrefs`
  root 461,443, 463,046, 464,656, 466,266 and 471,096.

### `as declared` at N = 20

```
$ sed -n '/^## 3\./,/^$/p' packages/patterns/topics/demand-runs/03-compare-7439.txt
## 3. #7439 body, `as declared` on the boardCrossrefs root at N = 20 (159d 1385039b others= 19 1202413b); arm `current`, density 2, now
now:  135    852,996  19    717,913  84.2% | docs -24, bytes -532,043, otherDocs 0, otherBytes -484,500
```

- 24 fewer documents, 532,043 fewer bytes, the same 19 other-topic documents,
  and 484,500 fewer other-topic bytes. #7439's line carries no share; here it is
  84.2%.

### The body's other claims

```
$ sed -n '/^## 4\./,/^$/p' packages/patterns/topics/demand-runs/03-compare-7439.txt
## 4. #7439 claims restated as comparisons over arm `current`, now
 N  d | boardNames = boardCrossrefs (otherDocs, otherBytes) | mentionable otherDocs | topic only = mentionedBy only (docs, bytes) | whole without boardNames otherDocs
 4  2 |                                                true |                     0 |                                        true |                                  3
10  2 |                                                true |                     0 |                                        true |                                  9
20  2 |                                                true |                     0 |                                        true |                                 19
40  2 |                                                true |                     0 |                                        true |                                 39
10  0 |                                                true |                     0 |                                       false |                                  9
10  1 |                                                true |                     0 |                                        true |                                  9
10  3 |                                                true |                     0 |                                        true |                                  9
10  6 |                                                true |                     0 |                                        true |                                  9
```

- `boardNames` and `boardCrossrefs` return the same other-topic documents and
  bytes on every board of the board as it stands. #7439 says the two reach the
  same documents "at the same byte counts"; here their other-topic bytes are
  equal and their frame bytes differ at every N (§ With `boardNames` removed).
- `mentionable` reaches no other topic on any board.
- `topic only` and `mentionedBy only` return the same documents and bytes at N =
  10 and 20 at density 2, where #7439 reports them the same, and at every
  density from 1. At density 0 they differ, which #7439 has no figure for:
  `topic only` reaches 9 other topics and `mentionedBy only` none (§ The
  prototype's figures, the density-0 block).
- #7439 says the only demand that avoids the follow does not name the property.
  Here `nothing named` on the `boardCrossrefs` root reaches no other topic, and
  naming `topic` or `mentionedBy` reaches 39 at N = 40 (§ The prototype's
  figures).
- The whole walk without `boardNames` reaches N − 1 other topics at every N, as
  #7439's statement that removing one of the two fixes nothing says.

### Needs and receives at N = 40

```
$ sed -n '/^## 5\./,/^$/p' packages/patterns/topics/demand-runs/03-compare-7439.txt
## 5. #7439 body: at N = 40 with inbound degree 2, needs 2 documents (~126,570 bytes), receives 39 (2,468,115 bytes); arm `current` now, whole as recorded
now: 2 documents ~75,570 bytes; receives 39 (1,473,615 bytes) | receives bytes -994,500
```

- #7439: a topic needs 2 documents, about 126,570 bytes, and receives 39,
  2,468,115 bytes. Here: 2 documents are about 75,570 bytes, and the topic
  receives 39, 1,473,615 bytes, 994,500 fewer.
- #7439's first comment: 39 documents and 2.47 MB on a 40-topic board, 90.5% of
  the frame. Here 39 documents and 1,473,615 bytes, 88.6% of the whole walk and
  90.4% of the `boardCrossrefs` root (§ The body table). The same comment's 9
  documents at N = 10 whether density is 0 or 6 is 9 here (§ Density at N = 10).

## With `boardNames` removed

The figures in this section come from the run § Setup describes. Its command,
and the commit, arguments, store and runtime options the run printed:

```
$ git log -1 --format=%B 451886f918
experiment(topics): demand of one topic over its board, both boards

Output of `deno run -A packages/patterns/topics/measure-topic-demand.ts
4:2 10:2 20:2 40:2 10:0 10:1 10:3 10:6`, run at 8a029b7dab, exit 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Kp8NcNXPougGPyJCEyYtob
$ sed -n '1p;6,10p' packages/patterns/topics/demand-runs/02-ladder.stdout.txt
# git rev-parse HEAD: 8a029b7dab92615f6d4a26bc72176a6e12ba26fa
# arguments: ["4:2","10:2","20:2","40:2","10:0","10:1","10:3","10:6"]
# arms: current=main.tsx rows=main-rows.tsx
# store: one StorageManager.emulate per board, queried through MemoryV2Client.loopback on that store's server
# experimental options read from the environment: {}
# runtime.experimental (resolved, first board): {"modernCellRep":false,"commitPreconditions":true,"plainResultReceipts":true,"computedCellIds":true,"lazyMaterialization":true,"serverExecution":false,"contentAddressedSchemas":true,"readerSchemaPrecedence":true}
```

```
$ sed -n '/^## 6\./,$p' packages/patterns/topics/demand-runs/03-compare-7439.txt
## 6. Each board, with and without `boardNames` in the member's demand
arm      N  d | scope                        | docs      bytes oth otherBytes  share
current  4  2 | whole as recorded            |  101    240,221   3    113,353  47.2%
              | whole without boardNames     |   94    237,175   3    113,353  47.8%
              | input boardCrossrefs         |   87    231,651   3    113,353  48.9%
              | input mentionable            |   15     15,390   0          2   0.0%
              | input boardNames             |   87    229,362   3    113,353  49.4%
rows     4  2 | whole as recorded            |   99    236,709   3    113,353  47.9%
              | whole without boardNames     |   86    156,999   2     75,569  48.1%
              | input boardCrossrefs         |   18     16,886   0          2   0.0%
              | input mentionable            |   15     15,207   0          2   0.0%
              | input boardNames             |   86    227,678   3    113,353  49.8%
current 10  2 | whole as recorded            |  125    477,258   9    340,063  71.3%
              | whole without boardNames     |  112    471,521   9    340,063  72.1%
              | input boardCrossrefs         |  105    464,656   9    340,063  73.2%
              | input mentionable            |   15     16,731   0          2   0.0%
              | input boardNames             |  105    460,413   9    340,063  73.9%
rows    10  2 | whole as recorded            |  123    471,765   9    340,063  72.1%
              | whole without boardNames     |   92    161,005   2     75,569  46.9%
              | input boardCrossrefs         |   24     19,551   0          2   0.0%
              | input mentionable            |   15     16,548   0          2   0.0%
              | input boardNames             |  104    458,728   9    340,063  74.1%
current 20  2 | whole as recorded            |  165    872,347  19    717,913  82.3%
              | whole without boardNames     |  142    862,121  19    717,913  83.3%
              | input boardCrossrefs         |  135    852,996  19    717,913  84.2%
              | input mentionable            |   15     18,991   0          2   0.0%
              | input boardNames             |  135    845,502  19    717,913  84.9%
rows    20  2 | whole as recorded            |  163    863,555  19    717,913  83.1%
              | whole without boardNames     |  102    167,705   2     75,569  45.1%
              | input boardCrossrefs         |   34     23,991   0          2   0.0%
              | input mentionable            |   15     18,808   0          2   0.0%
              | input boardNames             |  134    843,818  19    717,913  85.1%
current 40  2 | whole as recorded            |  245  1,662,578  39  1,473,615  88.6%
              | whole without boardNames     |  202  1,643,369  39  1,473,615  89.7%
              | input boardCrossrefs         |  195  1,629,721  39  1,473,615  90.4%
              | input mentionable            |   15     23,512   0          2   0.0%
              | input boardNames             |  195  1,615,689  39  1,473,615  91.2%
rows    40  2 | whole as recorded            |  243  1,647,184  39  1,473,614  89.5%
              | whole without boardNames     |  122    181,149   2     75,569  41.7%
              | input boardCrossrefs         |   54     32,912   0          2   0.0%
              | input mentionable            |   15     23,329   0          2   0.0%
              | input boardNames             |  194  1,614,003  39  1,473,614  91.3%
current 10  0 | whole as recorded            |  124    472,381   9    340,063  72.0%
              | whole without boardNames     |  111    466,644   9    340,063  72.9%
              | input boardCrossrefs         |  105    461,443   9    340,063  73.7%
              | input mentionable            |   15     16,731   0          2   0.0%
              | input boardNames             |  105    460,413   9    340,063  73.9%
rows    10  0 | whole as recorded            |  122    469,089   9    340,063  72.5%
              | whole without boardNames     |   46     51,790   0          2   0.0%
              | input boardCrossrefs         |   24     18,538   0          2   0.0%
              | input mentionable            |   15     16,548   0          2   0.0%
              | input boardNames             |  104    458,729   9    340,063  74.1%
current 10  1 | whole as recorded            |  125    475,486   9    340,063  71.5%
              | whole without boardNames     |  112    469,750   9    340,063  72.4%
              | input boardCrossrefs         |  105    463,046   9    340,063  73.4%
              | input mentionable            |   15     16,731   0          2   0.0%
              | input boardNames             |  105    460,412   9    340,063  73.9%
rows    10  1 | whole as recorded            |  123    471,095   9    340,063  72.2%
              | whole without boardNames     |   91    122,550   1     37,785  30.8%
              | input boardCrossrefs         |   24     19,041   0          2   0.0%
              | input mentionable            |   15     16,548   0          2   0.0%
              | input boardNames             |  104    458,729   9    340,063  74.1%
current 10  3 | whole as recorded            |  125    479,029   9    340,063  71.0%
              | whole without boardNames     |  112    473,292   9    340,063  71.9%
              | input boardCrossrefs         |  105    466,266   9    340,063  72.9%
              | input mentionable            |   15     16,731   0          2   0.0%
              | input boardNames             |  105    460,413   9    340,063  73.9%
rows    10  3 | whole as recorded            |  123    472,437   9    340,063  72.0%
              | whole without boardNames     |   93    199,460   3    113,353  56.8%
              | input boardCrossrefs         |   24     20,061   0          2   0.0%
              | input mentionable            |   15     16,548   0          2   0.0%
              | input boardNames             |  104    458,729   9    340,063  74.1%
current 10  6 | whole as recorded            |  125    484,341   9    340,063  70.2%
              | whole without boardNames     |  112    478,605   9    340,063  71.1%
              | input boardCrossrefs         |  105    471,096   9    340,063  72.2%
              | input mentionable            |   15     16,731   0          2   0.0%
              | input boardNames             |  105    460,412   9    340,063  73.9%
rows    10  6 | whole as recorded            |  123    474,449   9    340,063  71.7%
              | whole without boardNames     |   96    314,828   6    226,708  72.0%
              | input boardCrossrefs         |   24     21,591   0          2   0.0%
              | input mentionable            |   15     16,548   0          2   0.0%
              | input boardNames             |  104    458,728   9    340,063  74.1%
```

On the board as it stands, `current`:

- With `boardNames` removed, the whole walk still reaches 3, 9, 19 and 39 other
  topics at N = 4, 10, 20 and 40 at density 2, and 9 at N = 10 at every density.

On the prototype board, `rows`:

- With `boardNames` in the demand, the whole walk reaches N − 1 other topics, as
  the `boardNames` root alone does.
- With `boardNames` removed, the whole walk reaches 2 other topics at density 2
  at every N, from 86 documents and 156,999 bytes at N = 4 to 122 documents and
  181,149 bytes at N = 40, and 0, 1, 3 and 6 at N = 10 at densities 0, 1, 3 and
  6. At density 0 that is no other topic, 46 documents and 51,790 bytes, while
  the same board's whole walk as recorded reaches 9.

The per-input roots do not show which input the remaining other-topic documents
come from. In the two blocks of § The prototype's figures, the whole walk
without both `boardNames` and `boardCrossrefs` reaches the same count on both
boards: 2 at N = 40 at density 2, and none at N = 10 at density 0.

## The prototype's figures

The figures in this section come from the run § Setup describes. Its command,
and the commit, arguments, store and runtime options the run printed:

```
$ git log -1 --format=%B 451886f918
experiment(topics): demand of one topic over its board, both boards

Output of `deno run -A packages/patterns/topics/measure-topic-demand.ts
4:2 10:2 20:2 40:2 10:0 10:1 10:3 10:6`, run at 8a029b7dab, exit 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Kp8NcNXPougGPyJCEyYtob
$ sed -n '1p;6,10p' packages/patterns/topics/demand-runs/02-ladder.stdout.txt
# git rev-parse HEAD: 8a029b7dab92615f6d4a26bc72176a6e12ba26fa
# arguments: ["4:2","10:2","20:2","40:2","10:0","10:1","10:3","10:6"]
# arms: current=main.tsx rows=main-rows.tsx
# store: one StorageManager.emulate per board, queried through MemoryV2Client.loopback on that store's server
# experimental options read from the environment: {}
# runtime.experimental (resolved, first board): {"modernCellRep":false,"commitPreconditions":true,"plainResultReceipts":true,"computedCellIds":true,"lazyMaterialization":true,"serverExecution":false,"contentAddressedSchemas":true,"readerSchemaPrecedence":true}
```

`boardCrossrefs` on the prototype board reaches no other topic at any N or
density: 18, 24, 34 and 54 documents and 16,886, 19,551, 23,991 and 32,912 bytes
at N = 4, 10, 20 and 40 (§ With `boardNames` removed). On the board as it
stands, the same root reaches N − 1.

The rows for N = 40 at density 2 and for N = 10 at density 0, from the run's
figures table. `row` and `refBy` are topic 0's own row and `referencedBy`:

```
$ sed -n '/^arm      N  d  row refBy/p' packages/patterns/topics/demand-runs/02-ladder.stdout.txt
arm      N  d  row refBy | scope                                      |  docs     bytes others topics otherBytes  share famDoc famTop  famBytes famShr
$ sed -n '/^current 40  2 /,/^current 10  0 /p' packages/patterns/topics/demand-runs/02-ladder.stdout.txt | sed '$d'
current 40  2    2     2 | whole: as recorded                         |   245   1662578     39     39    1473615  88.6%     39     39    1473615  88.6%
                         | whole: inline copy                         |   245   1662578     39     39    1473615  88.6%     39     39    1473615  88.6%
                         | whole: without boardNames                  |   202   1643369     39     39    1473615  89.7%     39     39    1473615  89.7%
                         | whole: without boardNames, boardCrossrefs  |    81    163300      2      2      75569  46.3%      2      2      75569  46.3%
                         | input mentionable                          |    15     23512      0      0          2   0.0%      0      0          2   0.0%
                         | input boardCrossrefs                       |   195   1629721     39     39    1473615  90.4%     39     39    1473615  90.4%
                         | input boardNames                           |   195   1615689     39     39    1473615  91.2%     39     39    1473615  91.2%
                         | boardCrossrefs: nothing named              |    55     46803      0      0          2   0.0%      0      0          2   0.0%
                         | boardCrossrefs: topic only                 |   195   1629721     39     39    1473615  90.4%     39     39    1473615  90.4%
                         | boardCrossrefs: mentionedBy only           |   195   1629721     39     39    1473615  90.4%     39     39    1473615  90.4%
                         | boardCrossrefs: as declared                |   195   1629721     39     39    1473615  90.4%     39     39    1473615  90.4%
                         | mentionable: as declared                   |    15     23512      0      0          2   0.0%      0      0          2   0.0%
                         | mentionable: piece named                   |   154   1606142     39     39    1473615  91.7%     39     39    1473615  91.7%
rows    40  2    2     2 | whole: as recorded                         |   243   1647184     39     39    1473614  89.5%     39     39    1473614  89.5%
                         | whole: inline copy                         |   243   1647184     39     39    1473614  89.5%     39     39    1473614  89.5%
                         | whole: without boardNames                  |   122    181149      2      2      75569  41.7%      2      2      75569  41.7%
                         | whole: without boardNames, boardCrossrefs  |    80    161616      2      2      75569  46.8%      2      2      75569  46.8%
                         | input mentionable                          |    15     23329      0      0          2   0.0%      0      0          2   0.0%
                         | input boardCrossrefs                       |    54     32912      0      0          2   0.0%      0      0          2   0.0%
                         | input boardNames                           |   194   1614003     39     39    1473614  91.3%     39     39    1473614  91.3%
                         | boardCrossrefs: nothing named              |    54     32912      0      0          2   0.0%      0      0          2   0.0%
                         | boardCrossrefs: topic only                 |    54     32912      0      0          2   0.0%      0      0          2   0.0%
                         | boardCrossrefs: mentionedBy only           |    54     32912      0      0          2   0.0%      0      0          2   0.0%
                         | boardCrossrefs: as declared                |    54     32912      0      0          2   0.0%      0      0          2   0.0%
                         | mentionable: as declared                   |    15     23329      0      0          2   0.0%      0      0          2   0.0%
                         | mentionable: piece named                   |   153   1604456     39     39    1473614  91.8%     39     39    1473614  91.8%
```

```
$ sed -n '/^current 10  0 /,/^current 10  1 /p' packages/patterns/topics/demand-runs/02-ladder.stdout.txt | sed '$d'
current 10  0    0     0 | whole: as recorded                         |   124    472381      9      9     340063  72.0%      9      9     340063  72.0%
                         | whole: inline copy                         |   124    472381      9      9     340063  72.0%      9      9     340063  72.0%
                         | whole: without boardNames                  |   111    466644      9      9     340063  72.9%      9      9     340063  72.9%
                         | whole: without boardNames, boardCrossrefs  |    35     48269      0      0          2   0.0%      0      0          2   0.0%
                         | input mentionable                          |    15     16731      0      0          2   0.0%      0      0          2   0.0%
                         | input boardCrossrefs                       |   105    461443      9      9     340063  73.7%      9      9     340063  73.7%
                         | input boardNames                           |   105    460413      9      9     340063  73.9%      9      9     340063  73.9%
                         | boardCrossrefs: nothing named              |    25     20329      0      0          2   0.0%      0      0          2   0.0%
                         | boardCrossrefs: topic only                 |   105    461443      9      9     340063  73.7%      9      9     340063  73.7%
                         | boardCrossrefs: mentionedBy only           |    25     20329      0      0          2   0.0%      0      0          2   0.0%
                         | boardCrossrefs: as declared                |   105    461443      9      9     340063  73.7%      9      9     340063  73.7%
                         | mentionable: as declared                   |    15     16731      0      0          2   0.0%      0      0          2   0.0%
                         | mentionable: piece named                   |    94    457557      9      9     340063  74.3%      9      9     340063  74.3%
rows    10  0    0     0 | whole: as recorded                         |   122    469089      9      9     340063  72.5%      9      9     340063  72.5%
                         | whole: inline copy                         |   122    469089      9      9     340063  72.5%      9      9     340063  72.5%
                         | whole: without boardNames                  |    46     51790      0      0          2   0.0%      0      0          2   0.0%
                         | whole: without boardNames, boardCrossrefs  |    34     46631      0      0          2   0.0%      0      0          2   0.0%
                         | input mentionable                          |    15     16548      0      0          2   0.0%      0      0          2   0.0%
                         | input boardCrossrefs                       |    24     18538      0      0          2   0.0%      0      0          2   0.0%
                         | input boardNames                           |   104    458729      9      9     340063  74.1%      9      9     340063  74.1%
                         | boardCrossrefs: nothing named              |    24     18538      0      0          2   0.0%      0      0          2   0.0%
                         | boardCrossrefs: topic only                 |    24     18538      0      0          2   0.0%      0      0          2   0.0%
                         | boardCrossrefs: mentionedBy only           |    24     18538      0      0          2   0.0%      0      0          2   0.0%
                         | boardCrossrefs: as declared                |    24     18538      0      0          2   0.0%      0      0          2   0.0%
                         | mentionable: as declared                   |    15     16548      0      0          2   0.0%      0      0          2   0.0%
                         | mentionable: piece named                   |    93    455873      9      9     340063  74.6%      9      9     340063  74.6%
```

- On the prototype board, the four demands on the `boardCrossrefs` root, from
  naming nothing to the recorded schema, return the same figures, and none
  reaches another topic. In the same store, the `boardNames` root reaches 39 and
  9 other topics, and `mentionable: piece named` 39 and 9.
- `mentionable` as declared reaches no other topic on either board, and
  `mentionable: piece named`, the same document under a demand naming the row's
  reference, reaches N − 1 on both. The prototype does not change `mentionable`
  (§ The prototype files), whose selector names the same schema document on both
  boards. The `mentionable` root's bytes differ between the two boards at every
  N (§ With `boardNames` removed).
- In every row of these two blocks, the family columns equal the rail columns.

## Standard error

```
$ wc -l packages/patterns/topics/demand-runs/02-ladder.stderr.txt
     274 packages/patterns/topics/demand-runs/02-ladder.stderr.txt
$ grep -c '^# stage' packages/patterns/topics/demand-runs/02-ladder.stderr.txt
224
$ grep -c 'sync-load-failure.*ConnectionError: memory client closed' packages/patterns/topics/demand-runs/02-ladder.stderr.txt
15
$ grep -c "Can't load profile-create.tsx" packages/patterns/topics/demand-runs/02-ladder.stderr.txt
32
$ grep -c 'slow-traverse' packages/patterns/topics/demand-runs/02-ladder.stderr.txt
3
$ grep -c 'REJECTION' packages/patterns/topics/demand-runs/02-ladder.stderr.txt
0
$ grep -v -c -e '^# stage' -e 'sync-load-failure' -e "Can't load profile-create.tsx" -e 'slow-traverse' packages/patterns/topics/demand-runs/02-ladder.stderr.txt
0
```

The run wrote 274 lines to standard error: 224 stage markers, 15
`sync-load-failure` lines ending `memory client closed`, 32
`Can't load
profile-create.tsx` lines, and 3 `slow-traverse` warnings. No line
is a rejection. When the `sync-load-failure` lines were written relative to the
queries is not established.

## The comments #7439 names

#7439 cites `topic.tsx:1231`, `topic.tsx:476`, `naming.ts:96` and
`naming.ts:340`. At the base, the lines holding the text it quotes, and the
declarations that follow each:

```
$ grep -n -e 'surveying the whole table expands no topic at all' -e 'is that missing annotation' packages/patterns/topics/topic.tsx
493: * `ComparableCell` is that missing annotation. It does not change what an entry
1707: * so surveying the whole table expands no topic at all.
$ grep -n -e '^export interface TopicMentionSource' -e '^const backlinksOf' packages/patterns/topics/topic.tsx
497:export interface TopicMentionSource {
1714:const backlinksOf = lift((
$ grep -n -e 'expands no member it did not follow' -e 'surveying the whole table expands no member' packages/patterns/collection-naming/naming.ts
96: * one entry — expands no member it did not follow.
340: * and nothing more, so surveying the whole table expands no member.
$ grep -n -e '^export type NamesMap' -e '^export const ownName' packages/patterns/collection-naming/naming.ts
109:export type NamesMap = Record<string, unknown>;
342:export const ownName = lift(
```

## Stated limitations

- **A query, not a resume.** Each figure is one graph query rooted at one
  document. The runtime's own sync requests were not reproduced.
- **Bytes are not wire bytes.** A byte figure is the UTF-8 length of the
  returned documents as JSON.
- **Differences are named, not attributed.** No run at `cbdf66c3cf` is part of
  this record, so no difference from #7439's figures is attributed to a change
  between the two commits.
- **#7439's frame column names no root.** § The body table compares it with both
  candidates.
- **Other-topic documents are the ones two rules attribute.** A document a
  followed topic brings into the frame that neither rule attributes counts in
  `docs` and `bytes` and not in the other-topic columns, so a share is of
  attributed bytes. No `pattern` rail link resolved (§ The prototype files), and
  in the quoted rows the family rule attributes nothing the rail rule does not.
- **The archived rig's `internal` rail.** What the archived rig attributed at
  `cbdf66c3cf` through `"internal"` is not established (§ What changed in the
  rig).
- **The prototype is for measuring.** Its identity is an entity id, which
  identifies a topic only among topics of one space and scope. Its "Referenced
  by" list renders identities, not links. `identityOf` calls `resolveAsCell()`
  on each list entry inside the board's pivot, and what that adds to the pivot's
  reads was not measured. Its comments outside the regions that differ describe
  the originals. `cf check` of `main-rows.tsx` is the only check run on it; no
  pattern test was run against it.
- **The widest control that returned figures is a demand naming a reference.**
  The `schema: true` control on the `boardCrossrefs` root was refused, and no
  `schema: true` figure is part of this record (§ What changed in the rig).
- **One store per board.** Figures from different boards are compared as counts,
  and the returned documents' contents were not compared.
- **The density of #7439's table.** #7439's body states inbound degree 2 at N =
  40, and its first comment writes "2 at d=2". This record compares the table
  with density 2 at every N.
- **`comparable` was not re-tried.** #7447 states the result in the plan text it
  merged, `docs/plans/collection-naming-topics.md`, "What remains" item 2: "the
  `comparable` marker was measured to leave the document and byte counts
  unchanged". #7439's body reports the figures, at N = 20 (§ `as declared` at N
  = 20). The plan text at #7447's merge commit:

```
$ git log -1 --format='%h %s' 6d1bb61495
6d1bb61495 docs(collection-naming): the plan says what remains, and records the measurement it cites (#7447)
$ git show 6d1bb61495:docs/plans/collection-naming-topics.md | sed -n 43,52p
2. **A table handed to every member delivers every member's document whole**
   (#7439). Measured on Topics: a member's declared demand over `boardCrossrefs`
   or `boardNames` reaches every other member, 90.5% of the frame on a
   40-member board; the share grew with member count from 4 to 40, and at 10
   members the document and byte counts were unchanged across the mention
   densities measured. `unknown` bounds the walk's descent, not its delivery,
   and comments in `naming.ts` and `topic.tsx` say otherwise. The fix is a
   row-shape change: the `comparable` marker was measured to leave the document
   and byte counts unchanged. It touches the same inputs decision 14 touches,
   so the two belong in one pass.
```

The history record #7447 added,
[`collection-naming-board-demand-measurement-2026-09-07.md`](../../../plans/collection-naming-board-demand-measurement-2026-09-07.md),
does not contain the word:

```
$ grep -c comparable docs/history/plans/collection-naming-board-demand-measurement-2026-09-07.md
0
```
