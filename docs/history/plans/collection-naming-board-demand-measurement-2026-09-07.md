---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Record of the measurement run at cbdf66c3cf that answered the question collection-naming decision 14 left open: whether a member can declare a demand over its board that reaches only the board's derived tables."
---

# Measuring a collection member's demand over its board

Decision 14 in
[`collection-naming-topics.md`](../../plans/collection-naming-topics.md) rules
that a collection member takes one input naming its board and derives the
tables it reads from that input, in place of one wired link per derived table.
It leaves one question to measurement: whether a member can declare a demand
over its board that reaches the derived tables and not the other members.
[`topics-mentionable-index-break.md`](../topics-mentionable-index-break.md)
records what a per-member demand that reaches the other members costs.

This record answers that question on the exemplar board,
`packages/patterns/collection-naming/`. The runs were made on 2026-09-07 in a
throwaway worktree at this commit, and written up on 2026-09-14:

```
$ git log -1 --format='%H %ad %s' --date=iso
cbdf66c3cfe4bfdc661cacfdba7704ba40ede838 2026-09-07 10:34:34 -0700 fix(llm): a system instruction is not a message (#7048)
```

The rigs were never committed. Code excerpts below are copied from them, and
excerpts of `packages/memory` are from the tree at the commit. The next two
blocks were printed on 2026-09-14, when this record was written up. The first
gives each rig file's last modification time:

```
$ stat -f '%Sm  %N' -t '%Y-%m-%d %H:%M' packages/patterns/collection-naming/board-b.tsx packages/patterns/collection-naming/board-c.tsx packages/patterns/collection-naming/item-b.tsx packages/patterns/collection-naming/item-c.tsx packages/patterns/collection-naming/diagnose-board-demand.ts packages/patterns/collection-naming/measure-board-demand.ts packages/patterns/collection-naming/probe-crossing.ts packages/patterns/collection-naming/probe-mechanism.ts packages/patterns/collection-naming/probe-roots.ts
2026-09-07 11:01  packages/patterns/collection-naming/board-b.tsx
2026-09-07 11:01  packages/patterns/collection-naming/board-c.tsx
2026-09-07 11:01  packages/patterns/collection-naming/item-b.tsx
2026-09-07 11:01  packages/patterns/collection-naming/item-c.tsx
2026-09-07 11:19  packages/patterns/collection-naming/diagnose-board-demand.ts
2026-09-07 11:34  packages/patterns/collection-naming/measure-board-demand.ts
2026-09-07 11:34  packages/patterns/collection-naming/probe-crossing.ts
2026-09-07 11:31  packages/patterns/collection-naming/probe-mechanism.ts
2026-09-07 11:28  packages/patterns/collection-naming/probe-roots.ts
```

Every rig builds its store with `StorageManager.emulate`, passes
`experimentalOptionsFromEnv` to its runtime, runs a board file, reaches the
store's server through `MemoryV2Client.loopback`, and disposes the runtime:

```
$ grep -nE 'StorageManager\.emulate|experimentalOptionsFromEnv\(|main: |loopback\(|runtime\.dispose' packages/patterns/collection-naming/*.ts
packages/patterns/collection-naming/diagnose-board-demand.ts:33:const storageManager = StorageManager.emulate({ as: signer });
packages/patterns/collection-naming/diagnose-board-demand.ts:37:  experimental: experimentalOptionsFromEnv(Deno.env.get),
packages/patterns/collection-naming/diagnose-board-demand.ts:42:  { main: `${HERE}${boardFile}` },
packages/patterns/collection-naming/diagnose-board-demand.ts:105:  transport: MemoryV2Client.loopback(candidate.server!()),
packages/patterns/collection-naming/diagnose-board-demand.ts:199:await runtime.dispose();
packages/patterns/collection-naming/measure-board-demand.ts:89:  const storageManager = StorageManager.emulate({ as: signer });
packages/patterns/collection-naming/measure-board-demand.ts:94:    experimental: experimentalOptionsFromEnv(Deno.env.get),
packages/patterns/collection-naming/measure-board-demand.ts:102:    { main: `${HERE}${arm.board}` },
packages/patterns/collection-naming/measure-board-demand.ts:216:    transport: MemoryV2Client.loopback(candidate.server()),
packages/patterns/collection-naming/measure-board-demand.ts:271:  await runtime.dispose();
packages/patterns/collection-naming/probe-crossing.ts:49:  const storageManager = StorageManager.emulate({ as: signer });
packages/patterns/collection-naming/probe-crossing.ts:53:    experimental: experimentalOptionsFromEnv(Deno.env.get),
packages/patterns/collection-naming/probe-crossing.ts:58:    { main: `${HERE}board.tsx` },
packages/patterns/collection-naming/probe-crossing.ts:124:    transport: MemoryV2Client.loopback(candidate.server!()),
packages/patterns/collection-naming/probe-crossing.ts:217:  await runtime.dispose();
packages/patterns/collection-naming/probe-mechanism.ts:32:const storageManager = StorageManager.emulate({ as: signer });
packages/patterns/collection-naming/probe-mechanism.ts:36:  experimental: experimentalOptionsFromEnv(Deno.env.get),
packages/patterns/collection-naming/probe-mechanism.ts:41:  { main: `${HERE}board.tsx` },
packages/patterns/collection-naming/probe-mechanism.ts:95:  transport: MemoryV2Client.loopback(candidate.server!()),
packages/patterns/collection-naming/probe-mechanism.ts:136:await runtime.dispose();
packages/patterns/collection-naming/probe-roots.ts:35:const storageManager = StorageManager.emulate({ as: signer });
packages/patterns/collection-naming/probe-roots.ts:39:  experimental: experimentalOptionsFromEnv(Deno.env.get),
packages/patterns/collection-naming/probe-roots.ts:44:  { main: `${HERE}${boardFile}` },
packages/patterns/collection-naming/probe-roots.ts:100:  transport: MemoryV2Client.loopback(candidate.server!()),
packages/patterns/collection-naming/probe-roots.ts:213:await runtime.dispose();
```

A block shows what a command printed or what a file contains. It cannot show
when something was done, or that something was not done, so statements of those
two kinds rest on the author's account. Among them: the date of the runs; that
no deployed space was contacted, read-only calls included; that the `/tmp`
output files were not kept; when `git status` was taken; that the name
assertion was added after the ladder ran, and was run once; how the first rig's
output was first read, and when its rows were printed; and every statement that
something was not compared, recorded or tried.

Every fenced block of output is quoted as it was printed in the terminal. Three
kinds of trim are used, each named where it is used: terminal color codes
removed, lines elided and marked `…`, and a `grep` in the quoted command that
kept only matching lines. A `$` line gives the command that produced the block,
with a leading `cd` and any separator `echo` removed; the `diff` commands ran in
`packages/patterns/collection-naming/`, and every other command at the
repository root. The longer runs wrote their output to files under `/tmp` that
were not kept, so where a run was only partly printed to the terminal, only the
printed part is quoted. Where a figure appears in prose or a table, the block it
was read from is beside it.

## The answer

Buildable as ruled. The section each statement rests on is named in it.

- An item whose one `board` input declares a demand naming the board's
  `namesTable` and `mentionable` compiled, and read its board-given name
  (§ Expressing the demand).
- Across N = 2, 5, 10, 20 and 40, that item's argument walk returned the same
  number of other-member documents, with the same byte total, as the item wired
  with one link per table, and returned 2 more documents and 1,714 more bytes at
  every N (§ The ladder).
- With the element schemas held equal, rooting the walk at the board and naming
  the two tables as its properties returned the same document count and the
  same byte count as rooting it at the two tables directly, at N = 2, 10 and 40
  (§ Isolating the crossing).
- A demand that also names the members returned N more documents than the
  one-input demand at every N (§ The ladder), so the instrument registers the
  growth such a demand causes.
- The one-input arm is built from `SELF`, `ReadonlyCell` and `.key()`, and no
  tracked file was modified (§ The three arms), so no runtime change was
  needed.

## The three arms

| arm | the item's board-facing inputs | files |
| --- | --- | --- |
| A | `boardNames` and `mentionable`, each a wired link; the exemplar as it stood at the commit | `board.tsx`, `item.tsx` |
| B | one `board` input, wired as `board: self`, declared over `{ namesTable, mentionable }` | `board-b.tsx`, `item-b.tsx` |
| C | arm B's input with `index` added to the declared demand, so that the demand names the members | `board-c.tsx`, `item-c.tsx` |

What separates the item of arm A from the item of arm B, in full:

```
$ diff item.tsx item-b.tsx
78a79,89
> /**
>  * PROBE (arm B): what a member declares of its BOARD. Names exactly the two
>  * derived tables the member reads and nothing else — not `items`, not
>  * `index`, not `names` — so the walk that warms and watches this member's
>  * argument has no path to a sibling member.
>  */
> export interface ItemBoardDemand {
>   namesTable: NamesTableRow[] | Default<[]>;
>   mentionable: ItemMentionable[] | Default<[]>;
> }
> 
91,95c102,105
<    * The board's names table, one row per named member. The item reads its
<    * own row out of it and nothing else; absent, the item shows no name.
<    *
<    * Readable, not writable: the table is the board's derivation, and an item
<    * has no business writing into it.
---
>    * PROBE (arm B, decision 14): the board itself, as ONE input, with a demand
>    * naming only the derived tables this item reads. The member reaches its
>    * board's derived outputs through this rather than through one wired link
>    * per table.
97,116c107
<   boardNames?: ReadonlyCell<NamesTableRow[] | Default<[]>>;
< 
<   /**
<    * The board's mention universe — what the body editor completes over.
<    * Wired at creation to the board's mention index, one derived document of
<    * rows (`MentionableRow` in `mentionable.ts`). Absent, the editor simply
<    * offers no completions.
<    *
<    * Readable, not writable, for the reason `boardNames` above states, and
<    * with a cost a writable handle carries besides: a writable binding puts
<    * the board's whole published row inside the retained link's proof, and
<    * this demand names three of that row's fields, so the write-back leg
<    * fails on a field the demand does not declare and the item can no longer
<    * be re-sourced at all. The editor writes nothing here — the one write it
<    * makes through this handle, the name write-back in `_updatePieceName`
<    * (`packages/ui/src/v2/components/cf-code-editor/cf-code-editor.ts`),
<    * lands on the piece a row stands for rather than on the row, because
<    * every row this board publishes carries `piece`.
<    */
<   mentionable?: ReadonlyCell<ItemMentionable[] | Default<[]>>;
---
>   board: ReadonlyCell<ItemBoardDemand>;
220,221c211
<       boardNames,
<       mentionable,
---
>       board,
233c223
<     const shortName = ownName({ table: boardNames, self });
---
>     const shortName = ownName({ table: board.key("namesTable"), self });
313c303
<                         $mentionable={mentionable}
---
>                         $mentionable={board.key("mentionable")}
```

The boards, with whitespace differences ignored. The hunks after the wiring are
line breaks `deno fmt` introduced when the pattern body moved one indentation
level:

```
$ diff -wB board.tsx board-b.tsx
16a17
>   SELF,
23c24
< import Item from "./item.tsx";
---
> import Item from "./item-b.tsx";
223c224,225
< export default pattern<BoardInput, BoardOutput>(({ items, names }) => {
---
> export default pattern<BoardInput, BoardOutput>(
>   ({ items, names, [SELF]: self }) => {
246,251c248,250
<         // The board's names table, so the item can read its own name out of
<         // the row the board already built for it.
<         boardNames: table,
<         // The board's mention universe, so the item's body editor completes
<         // `#42` and `[[` over its siblings.
<         mentionable,
---
>           // PROBE (arm B): ONE input naming the board. The item derives both
>           // tables from it under a demand that names only those two.
>           board: self,
294c293,296
<                 <cf-text block style="flex: 1; min-width: 0; font-weight: 600;">
---
>                   <cf-text
>                     block
>                     style="flex: 1; min-width: 0; font-weight: 600;"
>                   >
303c305,307
<             ? <cf-empty-state message="No items yet. File one with addItem." />
---
>               ? (
>                 <cf-empty-state message="No items yet. File one with addItem." />
>               )
323c327,328
< });
---
>   },
> );
```

Arm C against arm B. Arm C's pattern body does not read `index`; it is added to
the declared demand and nowhere else:

```
$ diff item-b.tsx item-c.tsx
87a88,96
> 
>   /**
>    * PROBE (arm C, the KNOWN-BAD arm): the board's members, named by the
>    * demand a member declares over its board. This is the shape
>    * `docs/history/topics-mentionable-index-break.md` measured: every
>    * member's declared demand crosses into every sibling. It exists to prove
>    * the instrument can see the multiplication.
>    */
>   index: { title: string | Default<"">; createdAt: number }[] | Default<[]>;
$ diff board-b.tsx board-c.tsx
24c24
< import Item from "./item-b.tsx";
---
> import Item from "./item-c.tsx";
248,249c248,249
<           // PROBE (arm B): ONE input naming the board. The item derives both
<           // tables from it under a demand that names only those two.
---
>           // PROBE (arm C): the same one input, under a demand that ALSO names
>           // the board's members.
```

The worktree's state, taken after every run in this record and after a later,
separate run whose rig is the last line. No tracked file is modified:

```
$ git status --short
?? packages/patterns/collection-naming/board-b.tsx
?? packages/patterns/collection-naming/board-c.tsx
?? packages/patterns/collection-naming/diagnose-board-demand.ts
?? packages/patterns/collection-naming/item-b.tsx
?? packages/patterns/collection-naming/item-c.tsx
?? packages/patterns/collection-naming/measure-board-demand.ts
?? packages/patterns/collection-naming/probe-crossing.ts
?? packages/patterns/collection-naming/probe-mechanism.ts
?? packages/patterns/collection-naming/probe-roots.ts
?? packages/patterns/topics/measure-topic-demand.ts
```

## Expressing the demand

The first form of arm B declared `board?:` as optional and read the tables by
property access. The pattern check refused it. Color codes removed; the lines
before the first diagnostic, and the two diagnostics that repeat these at the
editor's `mentionable` binding, elided:

```
$ deno task cf check packages/patterns/collection-naming/board-b.tsx 2>&1 | tail -40
…
[ERROR] 'board' is possibly 'undefined'.
222 |     // The board has already derived the table; this is a lookup by identity,
223 |     // and it is written as one.
224 |     const shortName = ownName({ table: board.namesTable, self });
    |                                        ^
225 |     const itemName = title.get().trim() || "(untitled item)";
226 |     const hasBody = body.get().trim().length > 0;

[ERROR] Property 'namesTable' does not exist on type 'ReadonlyCell<ItemBoardDemand>'.
222 |     // The board has already derived the table; this is a lookup by identity,
223 |     // and it is written as one.
224 |     const shortName = ownName({ table: board.namesTable, self });
    |                                              ^
225 |     const itemName = title.get().trim() || "(untitled item)";
226 |     const hasBody = body.get().trim().length > 0;
…
```

With `board` required and the tables read through `.key()`, the form quoted in
§ The three arms, the check printed no diagnostics for any arm. Color codes
removed; the exit status was not captured:

```
$ deno task cf check packages/patterns/collection-naming/board-b.tsx 2>&1 | tail -25
Task cf deno run --allow-run --allow-env --allow-read ./packages/cli/launcher.ts 'check' 'packages/patterns/collection-naming/board-b.tsx'
```

```
$ deno task cf check packages/patterns/collection-naming/board-c.tsx 2>&1 | tail -25 && echo "=== arm A ===" && deno task cf check packages/patterns/collection-naming/board.tsx 2>&1 | tail -5
Task cf deno run --allow-run --allow-env --allow-read ./packages/cli/launcher.ts 'check' 'packages/patterns/collection-naming/board-c.tsx'
=== arm A ===
Task cf deno run --allow-run --allow-env --allow-read ./packages/cli/launcher.ts 'check' 'packages/patterns/collection-naming/board.tsx'
```

Whether each arm's item reads its board-given name was checked by an assertion
added to the ladder rig after the ladder had run, and run once, at N = 3. The
assertion throws inside `measure()`:

```ts
  const index = result.key("index");
  await index.pull();
  const firstName = index.key(0).key("shortName").get();
  if (firstName !== "1") {
    throw new Error(
      `${arm.id}/${size}: member 1 shortName is ${
        JSON.stringify(firstName)
      }, expected "1"`,
    );
  }
```

and the rig prints its summary table only after `measure()` has returned for
every arm and size:

```ts
for (const arm of ARMS) {
  for (const size of sizes) {
    const row = await measure(arm, size);
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
console.log(
  "\n arm    N |   docs      bytes | sibDocs   sibBytes | per input root",
);
```

The run printed the summary table for all three arms. Standard error was
discarded, and the exit status was not captured:

```
$ deno run -A packages/patterns/collection-naming/measure-board-demand.ts 3 2>/dev/null | tail -5

 arm    N |   docs      bytes | sibDocs   sibBytes | per input root
  A    3 |     67      81587 |       2      22547 | boardNames=59d/75435b/2s mentionable=37d/34316b/0s
  B    3 |     69      83301 |       2      22547 | board=60d/74792b/2s
  C    3 |     72      87404 |       4      24695 | board=65d/84918b/4s
```

## The instrument

The memory server's `graph.query`, the walk a `session.watch.add` runs. For the
member at position 0 of `items`, the root is that member's argument document and
the selector schema is the schema recorded on the member's argument link,
unaltered:

```ts
  const memberCell = items.key(0).resolveAsCell();
  const memberLink = memberCell.getAsNormalizedFullLink();
  const argumentLink = getMetaLink(memberCell, "argument");
…
  const argumentFrame = await session.queryGraph({
    roots: [{
      id: argumentLink.id,
      selector: { path: [], schema: argumentLink.schema },
    }],
  });
```

`entities` is the document set the query returns. Documents are its length.
Bytes are this function over it, which is not a byte count on the wire:

```ts
const bytesOf = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;
```

A returned document counts as a sibling's when its id is the result document,
or the argument, internal or pattern rail document, of a member other than the
one measured:

```ts
  const noteFamily = (cell: Json, who: string) => {
    owner.set(cell.getAsNormalizedFullLink().id, `${who}:result`);
    for (const rail of ["argument", "internal", "pattern"] as const) {
      const link = getMetaLink(cell, rail);
      if (link) owner.set(link.id, `${who}:${rail}`);
    }
  };
  noteFamily(resultCell, "board");
  for (let index = 0; index < listed.length; index++) {
    noteFamily(items.key(index).resolveAsCell(), index === 0 ? "self" : "sib");
  }
```

The ladder's per-input column runs the same query once per input: rooted at the
document that input's stored link points at, under the input's property schema
with the top-level `asCell` and `asStream` markers removed:

```ts
    inputRoots.push({
      input: name,
      id: link.id,
      selector: {
        path: [...(link.path ?? []) as string[]],
        schema: withoutAsCell(deref(propertySchema)),
      },
    });
```

## The instrument bug hit first

The first form of the rig passed `path: ["value"]`:

```ts
  const argumentSchema = argumentLink.schema ?? factory.argumentSchema;
  const frame = await session.queryGraph({
    roots: [{
      id: argumentLink.id,
      selector: { path: ["value"], schema: argumentSchema },
    }],
  });
```

A root selector's path is relative to the document's value, because the server
prepends `value` itself. `trackGraph` in `packages/memory/v2/query.ts` converts
each root's selector:

```ts
  for (const root of query.roots) {
…
      const selector = toDocumentSelector(root.selector);
```

and `packages/memory/v2.ts` defines the conversion. `toDocumentPath` is a type
cast:

```ts
export const toDocumentPath = (path: readonly string[]): DocumentPath =>
  path as DocumentPath;
…
export const toDocumentSelector = (
  selector: Pick<SchemaPathSelector, "path" | "schema">,
): DocumentSchemaPathSelector =>
  internPathSelector({
    ...selector,
    path: toDocumentPath(["value", ...selector.path]),
  }) as DocumentSchemaPathSelector;
```

So `["value"]` selected the document path `["value", "value"]`.

What that run printed. At every N printed, arm A returned 36 documents and arms
B and C each returned 42, and no arm reached a sibling document, the
deliberately bad arm C included. These are eight of the run's nine rows,
printed by a `grep` of its output file while the ninth, arm C at N = 40, was
still running; the file was not kept:

```
$ time LOG_LEVEL=error deno run -A packages/patterns/collection-naming/measure-board-demand.ts 2 10 40 > /tmp/probe_ladder.txt 2>&1
$ grep -E '^\{"arm"' /tmp/probe_ladder.txt 2>/dev/null
{"arm":"A","size":2,"docs":36,"bytes":29074,"siblingDocsReached":0,"argumentDoc":"of:fid1:zqWbVBOcHeGtspBxwLwlMUfZ9n_yWUQL4ok__T-Rswo","argumentSchemaBytes":63}
{"arm":"A","size":10,"docs":36,"bytes":29074,"siblingDocsReached":0,"argumentDoc":"of:fid1:YZ6XlQGgAiajIVv7UoJH3pMx-CHc4ZsCKC1gNBhX6lw","argumentSchemaBytes":63}
{"arm":"A","size":40,"docs":36,"bytes":29074,"siblingDocsReached":0,"argumentDoc":"of:fid1:5dGIFySRKYgUf9XVYUHz_BnM65ffdKG2AUJRNQUED64","argumentSchemaBytes":63}
{"arm":"B","size":2,"docs":42,"bytes":34563,"siblingDocsReached":0,"argumentDoc":"of:fid1:q7caysVsNm1VgMU2xkPTQFNjwRc8XMbKWFnj-KlugLE","argumentSchemaBytes":63}
{"arm":"B","size":10,"docs":42,"bytes":34563,"siblingDocsReached":0,"argumentDoc":"of:fid1:lO_hdf_D7U5aI6Wj_nedRn46Kx29SIlZf069td-7Cj0","argumentSchemaBytes":63}
{"arm":"B","size":40,"docs":42,"bytes":34563,"siblingDocsReached":0,"argumentDoc":"of:fid1:wFewKxHhAu3oebS13Wq6CD7CXwrwVbttiBGyA1pgNQY","argumentSchemaBytes":63}
{"arm":"C","size":2,"docs":42,"bytes":35079,"siblingDocsReached":0,"argumentDoc":"of:fid1:elsz4CDF-R7z0kUTUYxabEKtMSMNXek6pAEAqsmKccs","argumentSchemaBytes":63}
{"arm":"C","size":10,"docs":42,"bytes":35079,"siblingDocsReached":0,"argumentDoc":"of:fid1:LScncTUlwa14nrKzOvJbMkJNiq-k9QsOTYrQ5ffvSRQ","argumentSchemaBytes":63}
```

That output was first read as the `asCell` markers on the item's inputs
stopping the walk at the input links. The ladder rig's header comment still says
so:

```ts
 * Instrument: the memory-v2 server's own `graph.query` — the same
 * `GraphQueryWalk` a `session.watch.add` runs. Two measurements per arm:
 *
 *   argument-walk  one root at the member's ARGUMENT document under the
 *                  schema the member's pattern declares over it. Every input
 *                  is `asCell`, so this walk stops at the links and never
 *                  reaches what they point at. Reported to show that.
```

A second form of the rig kept `"value"` as the first segment of every path
and added one query rooted at all of the item's inputs at once, with the
markers removed:

```ts
      selector: { path: ["value"], schema: argumentLink.schema },
…
      selector: {
        path: ["value", ...(link.path ?? []) as string[]],
        schema: withoutAsCell(deref(propertySchema)),
      },
```

That query returned 36 documents in every arm (`inDocs`), and no arm reached a
sibling document. The three JSON rows before the table are elided:

```
$ deno run -A packages/patterns/collection-naming/measure-board-demand.ts 3 2>/dev/null | tail -20
…

 arm    N | argDocs argBytes | inDocs   inBytes | sibDocs  sibBytes | roots
  A    3 |      36    29074 |     36     34028 |       0         2 | boardNames+mentionable
  B    3 |      42    34563 |     36     34100 |       0         2 | board
  C    3 |      42    35079 |     36     34100 |       0         2 | board
```

A probe that varied the schema settled it. On an arm C board of 3 members, with
`"value"` prepended to every path, the 13 queries rooted at the board's result
or argument document each returned 36 documents and 0 of 3 members, for every
schema tried, `schema: true` included; the one query rooted at a member
returned 42 documents and 1 of 3. The labels carry `value` for that reason:

```
$ deno run -A packages/patterns/collection-naming/probe-roots.ts board-c.tsx 3 2>/dev/null | grep "docs,"
  36 docs,   0/3 members  board:result value, {index:[row]}
  36 docs,   0/3 members  board:result value/index, [row]
  36 docs,   0/3 members  board:argument value/items, [row]
  36 docs,   0/3 members  board:argument value, {items:[row]}
  36 docs,   0/3 members  board:result value, schema true
  42 docs,   1/3 members  member0 result, schema true
  36 docs,   0/3 members  board:arg value/items, [{type:object}]
  36 docs,   0/3 members  board:arg value/items/0, {type:object}
  36 docs,   0/3 members  board:arg value/items, [{title only, not required}]
  36 docs,   0/3 members  board:arg value/items/0, {title only, not required}
  36 docs,   0/3 members  board:arg value/items, [true]
  36 docs,   0/3 members  board:arg value/items/0, true
  36 docs,   0/3 members  board:arg value/items, [{}]
  36 docs,   0/3 members  board:arg value/items/0, {}
```

The same cases with `"value"` removed from every path are the second block of
§ Evidence the instrument registers growth. Every other rig result in this
record uses the corrected paths.

## The ladder

`docs` and `bytes` are the whole argument walk. `sibDocs` and `sibBytes` are the
part of that frame counted as other members' documents. The per-input column is
`<input>=<documents>d/<bytes>b/<sibling documents>s`:

```
$ deno run -A packages/patterns/collection-naming/measure-board-demand.ts 2 5 10 20 40 > /tmp/ladder2.txt 2>/dev/null
$ sed -n '/^ arm    N/,$p' /tmp/ladder2.txt
 arm    N |   docs      bytes | sibDocs   sibBytes | per input root
  A    2 |     64      69372 |       1      11274 | boardNames=56d/62874b/1s mentionable=37d/33588b/0s
  A    5 |     73     106017 |       4      45093 | boardNames=65d/100557b/4s mentionable=37d/35772b/0s
  A   10 |     88     167104 |       9     101460 | boardNames=80d/163380b/9s mentionable=37d/39423b/0s
  A   20 |    118     289324 |      19     214200 | boardNames=110d/289070b/19s mentionable=37d/46743b/0s
  A   40 |    178     533764 |      39     439680 | boardNames=170d/540450b/39s mentionable=37d/61383b/0s
  B    2 |     66      71086 |       1      11274 | board=57d/62231b/1s
  B    5 |     75     107731 |       4      45093 | board=66d/99914b/4s
  B   10 |     90     168818 |       9     101460 | board=81d/162737b/9s
  B   20 |    120     291038 |      19     214200 | board=111d/288427b/19s
  B   40 |    180     535478 |      39     439680 | board=171d/539807b/39s
  C    2 |     68      73769 |       2      12348 | board=61d/71283b/2s
  C    5 |     80     114674 |       8      49389 | board=73d/112188b/8s
  C   10 |    100     182867 |      18     111130 | board=93d/180385b/18s
  C   20 |    140     319327 |      38     234640 | board=133d/316845b/38s
  C   40 |    220     592247 |      78     481660 | board=213d/589765b/78s
```

The differences between arms, computed from that block by a script with the
figures copied in, not separate output:

```
   N | B-A docs  B-A bytes | C-B docs  C-B bytes | sibDocs A  B  C
   2 |        2       1714 |        2       2683 |         1  1  2
   5 |        2       1714 |        5       6943 |         4  4  8
  10 |        2       1714 |       10      14049 |         9  9 18
  20 |        2       1714 |       20      28289 |        19 19 38
  40 |        2       1714 |       40      56769 |        39 39 78
```

Arms A and B return the same sibling document count and sibling byte total at
every N, and B returns 2 more documents and 1,714 more bytes than A at every N.
The sibling columns of arms A and B grow with N, and the per-input column places
that growth in `boardNames`; the growth and its cause are recorded in #7439,
and this record uses those columns only to compare the arms with each other.

## Evidence the instrument registers growth

**The deliberately bad arm grows against the one-input arm.** From the two
blocks above: arm C's sibling documents are twice arm B's at every N, and arm C
returns N more documents than arm B at every N.

**Varying the schema moves the count.** The probe of § The instrument bug hit
first, run again with the same arguments and with `"value"` removed from every
path. The case list, as run:

```ts
const rowSchema = {
  type: "object",
  properties: { title: { type: "string" }, createdAt: { type: "number" } },
  required: ["title", "createdAt"],
} as const;

const cases: { name: string; id: string; path: string[]; schema: Json }[] = [
  {
    name: "board:result, {index:[row]}",
    id: boardResultId,
    path: [],
    schema: {
      type: "object",
      properties: { index: { type: "array", items: rowSchema } },
    },
  },
  {
    name: "board:result/index, [row]",
    id: boardResultId,
    path: ["index"],
    schema: { type: "array", items: rowSchema },
  },
  {
    name: "board:argument/items, [row]",
    id: boardArgumentId,
    path: ["items"],
    schema: { type: "array", items: rowSchema },
  },
  {
    name: "board:argument, {items:[row]}",
    id: boardArgumentId,
    path: [],
    schema: {
      type: "object",
      properties: { items: { type: "array", items: rowSchema } },
    },
  },
  {
    name: "board:result, schema true",
    id: boardResultId,
    path: [],
    schema: true,
  },
];
…
cases.push({
  name: "member0 result, schema true",
  id: [...memberIds][0],
  path: [],
  schema: true,
});
const variants: [string, Json][] = [
  ["{type:object}", { type: "object" }],
  ["{title only, not required}", {
    type: "object",
    properties: { title: { type: "string" } },
  }],
  ["true", true],
  ["{}", {}],
];
for (const [name, elem] of variants) {
  cases.push({
    name: `board:arg/items, [${name}]`,
    id: boardArgumentId,
    path: ["items"],
    schema: { type: "array", items: elem },
  });
  cases.push({
    name: `board:arg/items/0, ${name}`,
    id: boardArgumentId,
    path: ["items", "0"],
    schema: elem,
  });
}
```

The same 14 cases now return between 43 and 91 documents, and 1 or 3 of 3
members, depending on the root and schema:

```
$ deno run -A packages/patterns/collection-naming/probe-roots.ts board-c.tsx 3 2>/dev/null | grep "docs,"
  61 docs,   3/3 members  board:result, {index:[row]}
  61 docs,   3/3 members  board:result/index, [row]
  61 docs,   3/3 members  board:argument/items, [row]
  61 docs,   3/3 members  board:argument, {items:[row]}
  91 docs,   3/3 members  board:result, schema true
  43 docs,   1/3 members  member0 result, schema true
  91 docs,   3/3 members  board:arg/items, [{type:object}]
  65 docs,   1/3 members  board:arg/items/0, {type:object}
  61 docs,   3/3 members  board:arg/items, [{title only, not required}]
  55 docs,   1/3 members  board:arg/items/0, {title only, not required}
  91 docs,   3/3 members  board:arg/items, [true]
  65 docs,   1/3 members  board:arg/items/0, true
  91 docs,   3/3 members  board:arg/items, [{}]
  65 docs,   1/3 members  board:arg/items/0, {}
```

**A one-property change moves the count.** On an arm A board of 20 members, one
document — the names table a member's `boardNames` link points at — under
three row demands. The first two differ only in whether the row's `member`
reference is named. The third is the schema recorded on that `boardNames` link:

```ts
const rowsUnder = (rowProperties: Json) => ({
  type: "array",
  items: { type: "object", properties: rowProperties },
  default: [],
});

const cases: [string, Json][] = [
  ["name only", rowsUnder({ name: { type: "string" } })],
  [
    "name + member:unknown",
    rowsUnder({ name: { type: "string" }, member: { type: "unknown" } }),
  ],
  ["as the exemplar declares it", boardNamesLink.schema],
];
```

```
$ deno run -A packages/patterns/collection-naming/probe-mechanism.ts 20 2>/dev/null
board of 20 members; root = the names table
    57 docs    52321 bytes    0/20 members  name only
   110 docs   289070 bytes   20/20 members  name + member:unknown
   110 docs   289070 bytes   20/20 members  as the exemplar declares it
```

## Isolating the crossing

The ladder's arms A and B differ in more than where the walk starts; § Stated
limitations lists what else differs. This probe runs both wirings on the same
board with the same schemas. For each size it runs `board.tsx`, arm A's board,
into `resultCell`, and takes the first member of that board's `items`. Both
element schemas come from the schema recorded on that member's argument link,
with the top-level cell marker removed; both table links are read from that
member's stored argument; and `boardId` is the id of `resultCell`'s document.
Elided lines are marked `…`:

```ts
async function run(size: number) {
  …
  const program = await resolveLocalProgram(
    (resolver) => runtime.harness.resolve(resolver),
    { main: `${HERE}board.tsx` },
  );
  const factory = await runtime.patternManager.compilePattern(program, {
    space,
  });

  const tx = runtime.edit();
  const resultCell = runtime.getCell<Json>(
    space,
    { probeCrossing: size },
    factory.resultSchema,
    tx,
  );
  const result = runtime.run(tx, factory, {}, resultCell);
  …
  const items = result.key("items");
  await items.pull();
  const listed = items.get() ?? [];
  const memberIds = new Set<string>();
  for (let index = 0; index < listed.length; index++) {
    memberIds.add(
      items.key(index).resolveAsCell().getAsNormalizedFullLink().id,
    );
  }

  const memberCell = items.key(0).resolveAsCell();
  const argumentLink = getMetaLink(memberCell, "argument")!;
  const argumentCell = runtime.getCellFromLink(argumentLink);
  await argumentCell.sync();
  const stored = argumentCell.getRawUntyped() as Record<string, Json>;
  const argumentSchema = deref(argumentLink.schema);

  // The two element demands, exactly as the exemplar's item declares them.
  const namesSchema = withoutAsCell(
    deref(argumentSchema.properties.boardNames),
  );
  const mentionableSchema = withoutAsCell(
    deref(argumentSchema.properties.mentionable),
  );
  const namesLink = parseLink(stored.boardNames, argumentLink)!;
  const mentionableLink = parseLink(stored.mentionable, argumentLink)!;
  const boardId = resultCell.getAsNormalizedFullLink().id;
  …
const sizes = (Deno.args.length > 0 ? Deno.args : ["2", "10", "40"]).map(
  Number,
);
const rows = [];
for (const size of sizes) {
  const row = await run(size);
  …
```

It then queries with the two schemas from two sets of roots. The first is one
root at each table's document, which is arm A's wiring. The second is one root
at the board's result document naming the two tables as its properties, which
is arm B's wiring:

```ts
  const direct = await measure([
    {
      id: namesLink.id,
      selector: {
        path: [...(namesLink.path ?? []) as string[]],
        schema: namesSchema,
      },
    },
    {
      id: mentionableLink.id,
      selector: {
        path: [...(mentionableLink.path ?? []) as string[]],
        schema: mentionableSchema,
      },
    },
  ]);
  const viaBoard = await measure([
    {
      id: boardId,
      selector: {
        path: [],
        schema: {
          type: "object",
          properties: {
            namesTable: namesSchema,
            mentionable: mentionableSchema,
          },
        },
      },
    },
  ]);
```

It repeats both with `member` dropped from the names-table row demand:

```ts
  const namesNoMember = {
    ...namesSchema,
    items: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  };
```

In this block `members` counts returned result documents of every member of
the board, the first included. A `memberBytes` of 2 is the length of `[]`:

```
$ (deno run -A packages/patterns/collection-naming/probe-mechanism.ts 20 2>/dev/null; echo "=== CROSSING ==="; deno run -A packages/patterns/collection-naming/probe-crossing.ts 2 10 40 2>/dev/null) > /tmp/probes.txt
$ sed -n '/N | shape/,$p' /tmp/probes.txt
   N | shape                        | docs    bytes  members memberBytes
   2 | A: two roots, tables direct |   56    62874        2       22547
   2 | B: one root, via the board   |   56    62874        2       22547
   2 | A - member reference         |   40    34283        0           2
   2 | B - member reference         |   40    34283        0           2
  10 | A: two roots, tables direct |   80   163380       10      112733
  10 | B: one root, via the board   |   80   163380       10      112733
  10 | A - member reference         |   48    42409        0           2
  10 | B - member reference         |   48    42409        0           2
  40 | A: two roots, tables direct |  170   540450       40      450953
  40 | B: one root, via the board   |  170   540450       40      450953
  40 | A - member reference         |   78    73009        0           2
  40 | B - member reference         |   78    73009        0           2
```

At every N, the two wirings return the same document count and the same byte
count, with and without the `member` reference. The contents of the returned
documents were not compared.

## Stated limitations

- **Board size and content.** N ran from 2 to 40 (§ The ladder). No block here
  shows the fixture itself — the items' titles and bodies, or how boards were
  assigned to spaces — and the rigs that built it are not in the tree.
- **The exemplar, not Topics.** This question was measured on
  `packages/patterns/collection-naming/`, not on the Topics patterns.
- **A query, not a resume.** The instrument is one `graph.query` rooted at a
  member's argument document. The runtime's resume pre-sync,
  `#syncCellsForRunningPattern` in `packages/runner/src/runner.ts`, issues its
  own sync requests, and they were not reproduced. The precedent's figures came
  from a deployed topic resume; this record shares its units and not its
  instrument.
- **Bytes are not wire bytes.** A byte figure here is the UTF-8 length of the
  returned snapshot array as JSON, per `bytesOf` in § The instrument. The
  memory protocol's own encoding and message compression are not measured.
- **Equal counts, not compared contents.** Where two queries return the same
  document and byte counts, the documents themselves were not compared.
- **Sibling documents are classified by four ids per member.** A returned
  document belonging to another member, other than its result, argument,
  internal and pattern rail documents, is counted in `docs` and not in
  `sibDocs`.
- **The one-input arm's difference is not attributed by document.** Arm B
  returns 2 more documents and 1,714 more bytes than arm A at every N, and which
  documents those are was not recorded. § Isolating the crossing shows the two
  wirings return the same counts when the element schemas are equal, and the
  ladder's arms do not have equal schemas (next item).
- **Arms A and B differ in more than the demand shape.** From the diffs in
  § The three arms:
  - arm B's `board` input is required, where arm A's `boardNames` and
    `mentionable` are optional. It was made required to clear the
    `'board' is possibly 'undefined'` diagnostic quoted in § Expressing the
    demand, and an optional `board` read through `.key()` was not tried;
  - the input doc comments differ, and a doc comment is carried into the
    recorded argument schema as `description`. An excerpt of arm C's resolved
    argument schema, whose `board` declaration and its comment are the same
    lines as arm B's, with the other properties elided:

    ```
    $ deno run -A packages/patterns/collection-naming/diagnose-board-demand.ts board-c.tsx 3 2>/dev/null | head -120
    …
      "board": {
       "$ref": "cid:fid1:86stQFZpCsUASXyQaNBMTvXSmY_zUnNrqfDpJeGAFgI",
       "asCell": [
        "readonly"
       ],
       "description": "PROBE (arm B, decision 14): the board itself, as ONE input, with a demand\nnaming only the derived tables this item reads. The member reaches its\nboard's derived outputs through this rather than through one wired link\nper table."
      },
    …
     "required": [
      "board"
     ],
     "description": "What an item holds, and what its board hands it."
    }
    ```

  - arm B adds the `ItemBoardDemand` interface;
  - arm B's board destructures `[SELF]: self` and wires `board: self` in place
    of `boardNames: table` and `mentionable`.
- **Arm C's demand is declared and not read.** Arm C's pattern body does not
  read `index`, so arm C measures a declared demand and not a pattern that
  consumes the members.
- **The ladder carried no name check.** The assertion that each item reads its
  board-given name was added after the ladder ran, and ran once, at N = 3. No
  exit status was captured for any `cf check` run or for that run.
- **Separate runs.** The ladder, the two mutation probes and the crossing probe
  ran as separate script invocations, as their quoted commands show, and this
  record does not compare figures across them.
- **Experimental options were not recorded.** Each rig passed
  `experimentalOptionsFromEnv(Deno.env.get)`, as the setup lines quoted at the
  top show, and no quoted output shows the options it read.
- **The rigs are not committed**, and one of their comments is out of date. The
  header comment of `measure-board-demand.ts` quoted in § The instrument bug hit
  first states that the argument walk stops at the input links, which the
  sibling columns of § The ladder contradict.
