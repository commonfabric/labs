# Common Patterns

Prefix the URLs with
`https://raw.githubusercontent.com/commonfabric/labs/refs/heads/main/patterns/`

---

# Status tiers

This directory mixes exemplars, capability demos, regression fixtures, and
legacy experiments. They do NOT carry equal authority. Before imitating any
pattern, check its tier:

- **primitive** — designed for embedding in other patterns (used as a JSX tag),
  headless-able. Exposes streams + cells + an optional default `[UI]`. Copy
  these idioms when building composable building blocks. See
  `docs/common/patterns/product/primitives.md` for the composition contract.
- **exemplar** — current best practice. Copy idioms from these.
- **demo** — illustrates a specific capability or integration. The capability
  usage is real, but the surrounding wiring may be verbose, dated, or
  intentionally contrived. Imitate the capability call, not the style.
- **fixture** — regression/test scaffolding. Exists to pin down a bug or
  exercise the runtime. Never imitate.
- **legacy** — superseded or judged non-idiomatic. Do not copy. See also
  `DEPRECATED_IDIOMS.md` for API-level migrations.

Any pattern not listed below (newly added, or missed) should be treated as
**demo** until triaged.

## The tier is in the file

The two tiers that mean "do not copy" — legacy and fixture — do not rely on this
page being found. Every pattern source in them opens with a marker naming the
tier, so the answer reaches a reader who arrived from a directory listing, a
grep hit, or a link straight to the file:

```ts
// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
```

Membership is the table in `tasks/pattern-tiers.ts`, which tiers whole
directories and individual files. `deno task check-pattern-tiers` holds the two
to each other in both directions: a listed file without its marker fails, a
marker on an unlisted file fails, and a table entry matching nothing fails. So a
new fixture cannot arrive unmarked, and a marker cannot outlive its reason.
`deno task fix-pattern-tiers` applies or corrects a marker.

The sections below therefore do not re-list the members of those two tiers. The
marker in the file is the answer; the table is where it comes from.

The three copyable tiers carry no marker. Their instruction is to copy, or to
copy the capability call and not the style, which is what a reader already
assumes — and the several hundred remaining pattern sources would each need one
to say it.

## primitive

Composable building blocks designed for embedding in other patterns
(headless-able). Live under `product/primitives/`. See
`docs/common/patterns/product/primitives.md` for the composition contract and
the adopter-first entry bar.

`amount-ledger.tsx`, `check-list.tsx`, `counter.tsx`, `dice-roller.tsx`,
`option-picker.tsx`, `sortable-table.tsx`, and the `demo/` host that embeds
those six. Each is a single self-contained file taking real, optional inputs,
with an embeddable `[UI]` — a fragment rather than a `cf-screen` — so a host can
drop it in as a JSX tag or run it standalone.

`ledger-month-transactions.tsx`, `mailbox-month-headers.tsx` and
`source-row-count.tsx` read a database handed to them instead of a caller's own
cell. Their input is a `SqliteDb` handle, so none is in the `demo/` host: a host
that embeds one has to hand it a database. Their pattern tests build one with
`sqliteDatabase()` and drive one of the atom's own reactive inputs — the month,
or the predicate — which is what re-runs a query the atom declares no `reactOn`
for; `runtime/cf-harness/test/primitives-connector-reads.test.ts` states what
only an injected handle can. The first two carry the two tombstone conventions a
connector store uses — the integer `deleted = 0` flag on a connector ledger,
`deleted_at IS NULL` on the mail store — which is the thing a session reading
one of these databases has no other way to learn. `source-row-count.tsx` reports
a table's row count beside the count its predicate admits, from one aggregate
statement, so the two numbers say whether a predicate matched nothing or the
table holds nothing.

Their adopter is the pattern index: they are published to it as composable
parts, and their descriptions are derived from their doc comments by
`runtime/cf-harness/scripts/seed-pattern-index.ts`. So the first paragraph of
each doc comment is what a search ranks on, and it has to describe what the code
does rather than what the atom is for.

The earlier candidate (`EditableList`) was built, proven against real callers
both headless and rendered, and retired under the kill criterion — no caller
benefited (see the contract doc's "Lessons" section).

## exemplar

`dev/catalog/` (type-checked component catalog + `dev/catalog/stories/`),
`examples/counter/`, `examples/do-list/`, `examples/fair-share/`,
`examples/form-demo/main.tsx`, `system/notes/`, `examples/reading-list/`
(canonical list-detail example), `examples/simple-list/`, `examples/todo-list/`.

## demo

Capability and app demos, each a single file: `apps/annotation/annotation.tsx`,
`apps/annotation-manager/main.tsx`, `examples/aside/main.tsx`,
`apps/bookmarks/main.tsx`, `system/chatbot/chatbot.tsx`,
`apps/cheeseboard/main.tsx`, `examples/compiler/main.tsx`,
`apps/deep-research/main.tsx`, `showcase/dice/main.tsx` (+
`showcase/dice/dice-handlers.ts`),
`examples/group-chat-lobby/main.tsx`,
`examples/group-chat-room/group-chat-room.tsx`, `examples/image/main.tsx`,
`apps/image-analysis/main.tsx`, `examples/link-preview/main.tsx`,
`examples/map-demo/main.tsx`, `examples/mobile-app-demo/main.tsx`,
`examples/pattern-index/main.tsx`,
`examples/profile-roster-live-demo/profile-roster-live-demo.tsx` (demo: live
multi-user profile roster — every participant's cross-space profile badge),
`system/self/self.tsx`, `apps/self-improving-classifier/main.tsx`,
`apps/shopping-list/main.tsx`, `apps/store-mapper/main.tsx`,
`examples/text-swapper/main.tsx`.

App and integration directories: `apps/activity-log/`, `apps/agent/`,
`apps/base/`, `showcase/battleship/`, `apps/book-recommendations/`,
`apps/budget-tracker/`, `apps/calendar/`, `showcase/card-piles/`,
`product/collection-naming/` (the member-naming library and the board that
exercises it; the library is the reference, the board is a demo),
`apps/contacts/`, `apps/cozy-poll/`, `examples/`, `dev/experimental/`
(explicitly unhardened explorations), `system/fabrichat/` (chat among real
profiles: a room per conversation, whose messages and reactions are written only
through reviewed surfaces, each user's manager of their rooms, and placements
that show a room in other spaces), `system/fabrifile/` (a space's set of named
files: a store with no rendering, each entry a record linking a blob named as
the entry is, and a view of it for VDOM hosts in a module the store never
imports), `apps/file-share/` (a minimal file-sharing example: bytes go to the
blob store, cells hold descriptors), `apps/habit-tracker/`,
`examples/iframe-cursor-canvas/` (a shared board in a sandboxed iframe: shapes
are stored, while each viewer's pointer and a shape held mid-drag or mid-resize
travel through a presence room and are stored nowhere),
`examples/iframe-donut-menu/` (a menu in a sandboxed iframe whose pictures the
pattern ships as files and hands its guest as `assets`),
`examples/iframe-verb-list/` (a list in a sandboxed iframe whose guest adds an
item only by sending the pattern's `addItem` verb, which writes the pattern's
own state), `showcase/inductor/pool/` (lo-fi rule sets for one goal, contributed
under per-goal pseudonyms; a rule and its count become public only once enough
distinct contributors hold it), `product/lobby/`, `showcase/inductor/lofi/` (a
model labels a stream of items while a regex rule set learns to match it; a
proposed rule set replaces the current one only when it is in grammar, safe, and
better on a held-out split), `apps/lunch-poll/`, `examples/math-note/`,
`examples/profile-group-chat/`, `apps/project-list/`, `apps/star-chart/` (a
kids' daily-habit sticker chart), `apps/meal-orchestrator/` (plan a multi-dish
meal: link dishes from notes, dietary fit per guest, meal balance, and an oven
plan with conflict detection), `apps/food-recipe/` (recipes with timed step
groups, oven needs, photo/text extraction with diff review, a cooking view, and
prepared food for meal planning), `apps/codenames-helper/` (a spymaster's
companion for in-person Codenames, with photo reading and clue ideas),
`apps/smart-rubric/` (score and rank options against a weighted rubric, with LLM
Quick Add), `apps/story-weaver/` (brainstorm a story level by level with AI),
`apps/redactor/` (asks a model about personal matters with every personal value
swapped out, enforced by CFC; the CFC design and debt are in its README),
`apps/assumption-surfacer/` (a chat that surfaces the assistant's assumptions
for you to confirm or correct), `apps/reward-spinner/` (a kids' prize spinner
with parent-set odds),
[`apps/recommend-a-book/`](apps/recommend-a-book/README.md) (personal reading
shelf and private visitor recommendations), `examples/router/`,
`examples/scoped-group-chat/`, `examples/scoped-user-directory/`,
`showcase/scrabble/`, `apps/shared-note/` (a shared Markdown document whose live
cursors carry each viewer's profile name), `examples/shared-profile-demo/`,
`examples/shared-profile-roster/`, `examples/suggestable/`,
`examples/indexed-topics/` (topics that mention one another, held in an indexed
collection: the board's listing and each topic's "mentioned by" are SQL queries,
and no list of topics exists), `apps/weekly-calendar/`, `showcase/wordsearch/`
(a word search maker: form, puzzle, a PDF of the puzzle and its answer key, and
a Play tab).

Connector-owned patterns live with their connector families: the
[agent debug view](../connectors/agents/debug-view/README.md) and
[GitHub activity view](../connectors/github/activity-view/README.md).

CFC spec demos (intentionally verbose wiring): `system/cfc/`,
`examples/cfc-agent-prompt-injection-demo/`, `examples/cfc-authorized-save/`,
`examples/cfc-exchange-rules/`, `examples/cfc-authorship-chat/`,
`examples/cfc-group-chat-demo/`, `examples/cfc-render-policy-demo/`,
`examples/cfc-row-label-mailbox/`, `examples/cfc-row-label-records/`,
`examples/cfc-spec-gallery/`, `examples/cfc-staged-publish/`,
`examples/cfc-trusted-component-examples/`, `examples/cfc-trusted-surfaces/`.

System patterns: `system/` — live, load-bearing product patterns (home,
default-app, suggestions). They run the product but are of mixed idiom vintage;
not a style reference.

## fixture

Every fixture pattern source carries the fixture marker, so the file says so
itself. Two groups sit outside the marker's reach and are fixture anyway:

- Every `*.test.ts(x)` file anywhere in this package. The blanket rule is about
  pattern-authoring idioms — test _style_ is governed by
  `docs/common/workflows/pattern-testing.md`, and the exemplars' own test files
  remain good references for it.
- `integration/`, the browser test harness. These are test drivers rather than
  patterns, and nothing compiles them as pattern entries.

## legacy

The remaining legacy patterns each carry the legacy marker:

- `dev/collaborative-note/` — a minimal co-presence note, superseded by
  `apps/shared-note/`, which adds an editable title, an embeddable view, and
  notices for editing and live-cursor failures.
- `dev/factory-outputs/` and its support file `dev/factory-outputs/vehicles.ts`
  — machine-generated pattern-factory outputs, kept with their eval scores and
  never intended as style references. `parking-coordinator/main.tsx` is also a
  live integration and capability-gate fixture, which is why it stays.

The registry/`MODULE_METADATA` composition system — `record/`, `record.tsx`, its
backup and icon companions, `container-protocol.ts`, and the two dozen attribute
modules that existed only to register with it — has been removed. It was a
parallel composition system with no callers outside itself. Compose patterns
directly as JSX tags plus `wish` discovery instead;
`docs/common/patterns/composition.md` covers how.

Support files with no tier (not patterns): `deno.jsonc`, `mod.ts`, `index.md`,
`README.md`, `DEPRECATED_IDIOMS.md`, `tools/test-support/vnode-helpers.ts` (the
shared rendered-tree helpers for pattern tests), `tools/` (codegen tooling), and
`apps/topics/tools/` (the Topics board's command-line client). The December 2025
bug survey formerly kept here as `PREEXISTING_BUGS.md` is archived at
`docs/history/packages/patterns/PREEXISTING_BUGS.md`.

---

## `apps/annotation/annotation.tsx`

A first-class annotation pattern that points at existing cells/pieces, forms
blocker dependency graphs between annotations, and is discoverable by agents via
`wish({ query: "#annotation" })`. Annotations automatically create backlinks on
their target pieces via the `mentioned` array.

**Keywords:** annotation, note, todo, wish, comment, blocker, backlink, agent,
marker, dependency-graph

### Input Schema

```ts
type AnnotationKind = "note" | "todo" | "wish";
type AnnotationStatus = "open" | "in-progress" | "resolved" | "dismissed";

interface AnnotationInput {
  content: Writable<string | Default<"">>;
  kind: Writable<AnnotationKind | Default<"note">>;
  status: Writable<AnnotationStatus | Default<"open">>;
  targetPiece: Writable<MentionablePiece | null | Default<null>>;
  blockedBy: Writable<AnnotationPiece[] | Default<[]>>;
  isAnnotation: boolean | Default<true>;
  isHidden: boolean | Default<false>;
}
```

### Output Schema

```ts
interface AnnotationOutput {
  [NAME]: string; // emoji-prefixed truncated content
  [UI]: VNode;
  mentioned: MentionablePiece[]; // [targetPiece] — feeds the backlinks system
  content: string;
  kind: AnnotationKind;
  status: AnnotationStatus;
  targetPiece: MentionablePiece | null;
  blockedBy: AnnotationPiece[];
  isAnnotation: boolean; // always true — enables wish("#annotation")
}
```

### Agent usage

```ts
// Find all annotations in the space
const annotations = wish<AnnotationPiece[]>({ query: "#annotation" }).result;

// Create an annotation pointing at a specific piece
const ann = Annotation({
  content: "This note needs a summary",
  kind: "wish",
  targetPiece: somePiece,
});
addPiece.send({ piece: ann });
```

---

## `apps/topics/main.tsx`

**Topics — a multi-user tracker over #topic pieces** (durable units of shared
attention; CT-1878): title, living body document, flat chronological comment
thread, typed links out. Deliberately minimal — no statuses, labels, or
assignees. The board publishes a bounded discovery index — the topics
themselves, declared through a narrow row schema of summary scalars, so a row's
address IS its topic's and a survey and the follow-up read name one document.
`addTopic` returns the piece it created, so a caller addresses a new topic
straight from the create. The board owns a member namespace through
`product/collection-naming/naming.ts`: `addTopic` allocates the next decimal
number and passes it into the topic it creates, in the same transaction as the
append; each topic stores that number and publishes it as `shortName`, reading
nothing of its board to report it; and `backfillNames` numbers what the board
held before it numbered anything, asking each such topic to store its number
through the topic's own `recordName`. Every surface that shows a number reads
the one a topic publishes — the header badge, the card, the survey row, and the
mention universe row a `#42` query matches. Topics reference each other by CELL:
the board derives the whole graph once by scanning what each topic points at
with `equals`, and each topic reads its own inbound edges out of that pivot.
Demonstrates: reading-list-style piece-in-list composition, profile-native
browser authorship on a shared piece, mergeable comment appends, session-scoped
drafts, bounding a whole-list derivation with a narrow declared `lift`
parameter, passing topics through a sort so an activity-ordered list keeps the
identity its elements already have, `multiUserTest` coverage.

**Keywords:** topics, issues, tracker, discussion, thread, comments, multi-user,
profile, mergeable, index, discovery, bounded read, row identity, references,
backlinks, cell identity, equals, mentions, member names, shortName, namespace,
backfill

### Input Schema

```ts
interface TopicsInput {
  topics?: Writable<TopicDemand[] | Default<[]>>;
  // The member namespace: each decimal name to the topic it names, held as an
  // unread reference
  names?: Writable<Default<NamesMap, {}>>;
}
// TopicInput additionally takes the three wirings addTopic gives a child —
// mentionable (the @-mention universe for the body editor), boardCrossrefs
// (the reference pivot), and boardCrossrefIndex (that pivot's positions by
// topic number, which lets a topic read its own row alone) — plus shortName,
// the number the create allocated, which the topic stores and reports.
```

### Output Schema

```ts
interface TopicsOutput {
  topics: TopicDemand[];
  // { [NAME], title, shortName, piece } per topic — one document of copies
  mentionable: MentionableRow[];
  topicCount: number;
  // The topics, read through { title, createdAt, createdBy, commentCount,
  //   lastActivityAt, shortName } — a row addresses the topic it describes
  index: TopicIndexRow[];
  // { topic, mentionedBy, name? } per topic — the reference graph, derived
  // once here; a row carries its topic's number when the topic has one
  crossrefs: TopicCrossrefNamedRow[];
  // { source, byName } — the pivot's positions grouped by topic number
  crossrefIndex: TopicCrossrefIndex;
  // The namespace, the reverse lookup a caller reads a topic's number out of
  // by identity, and the policy the numbers are held to
  names: Default<NamesMap, {}>;
  namesTable: NamesTableRow[];
  naming: NamingDeclaration;
  // Returns { topic, name } — the piece it created and the number it allocated
  addTopic: Stream<AddTopicEvent, AddTopicResult>;
  // Numbers every member the namespace lacks and asks each unnumbered topic to
  // store its number; returns { assigned, named, pending }; idempotent
  backfillNames: Stream<BackfillNamesEvent, BackfillNamesResult>;
  submitTopic: Stream<void>;
}
```

## `apps/topics/topic.tsx`

A single #topic piece: the durable object the tracker's list holds. Body edits
go through an explicit Edit→Save toggle (one whole-value `set` per save keeps
the concurrent-edit window small); comments and links are mergeable appends.
Stores the number its board calls it by as its own input and publishes it as
`shortName`, rendering it as a badge beside the title. A topic nobody has
numbered stores none and publishes none. `recordName` is how a number reaches a
topic the board did not pass one to at create. Use from `apps/topics/main.tsx`
via `navigateTo()`, or standalone.

**Keywords:** topic, detail, thread, comment, links, body, navigateTo,
shortName, member name, badge

---

## `apps/agent/main.tsx`

An agent piece — autonomous worker with directive, learned state, and run
status. Consolidates agent configuration (directive, enable/disable), memory
(learned observations), and operational metadata (status, last run timestamp and
summary) into a single reactive piece. Agents discover their own piece via
`wish({ query: "#agent" })` and read/write state through FUSE or handlers.
Automatically logs lifecycle events to the Activity Log when one is deployed in
the same space.

**Keywords:** agent, directive, learned, status, autonomous, loop, briefing,
worker, bot, automation

### Input Schema

```ts
type AgentStatus = "idle" | "running" | "error";

interface AgentInput {
  agentName?: Writable<string | Default<"Unnamed Agent">>;
  directive?: Writable<string | Default<"">>;
  enabled?: Writable<boolean | Default<true>>;
  learned?: Writable<string | Default<"">>;
  status?: Writable<AgentStatus | Default<"idle">>;
  lastRun?: Writable<string | Default<"">>;
  lastRunSummary?: Writable<string | Default<"">>;
  isAgent?: boolean | Default<true>;
}
```

### Output Schema

```ts
interface AgentOutput {
  [NAME]: string; // "🤖 AgentName"
  [UI]: VNode;
  agentName: string;
  directive: string;
  enabled: boolean;
  learned: string;
  status: AgentStatus;
  lastRun: string; // ISO 8601 timestamp
  lastRunSummary: string;
  isAgent: boolean; // always true — enables wish("#agent")
  summary: string;
  // Handlers
  setDirective: Stream<{ value: string }>;
  setLearned: Stream<{ value: string }>; // full replace
  appendLearned: Stream<{ entry: string }>; // append dated entry
  toggleEnabled: Stream<void>;
  markRunning: Stream<void>;
  markIdle: Stream<{ summary: string; learned?: string }>; // appends learned entry
  markError: Stream<{ summary: string }>;
}
```

### Agent usage

```ts
// Find all agents in the space
const agents = wish<AgentPiece[]>({ query: "#agent" }).result;

// Bootstrap: agent finds its own piece
const self = wish<AgentPiece>({ query: "Wisher" }).result;
const directive = self.directive; // read directive
self.markRunning.send({}); // mark as running
// ... do work ...
self.markIdle.send({
  summary: "Processed 3 notes",
  learned: "## 2026-04-07\nNew observation",
});
```

---

## `examples/counter/main.tsx`

A simple counter demo.

### Input Schema

```ts
interface CounterInput {
  value?: Writable<number | Default<0>>;
}
```

### Output Schema

```ts
interface CounterOutput {
  value: number;
  increment: Stream<void>;
  decrement: Stream<void>;
}
```

## `examples/do-list/main.tsx`

A task list pattern with AI suggestions per item, indent-based subtasks, and
LLM-friendly title-based handlers.

**Keywords:** do-list, tasks, AI-suggestions, indent, suggestion, llmDialog

### Input Schema

```ts
interface DoItem {
  title: string;
  done: boolean | Default<false>;
  indent: number | Default<0>;
  aiEnabled: boolean | Default<false>;
}

interface DoListInput {
  items?: Writable<DoItem[] | Default<[]>>;
}
```

### Output Schema

```ts
interface DoListOutput {
  items: DoItem[];
  itemCount: number;
  compactUI: VNode;
  addItem: Reactive<Stream<{ title: string; indent?: number }>>;
  removeItem: Reactive<Stream<{ item: DoItem }>>;
  updateItem: Reactive<
    Stream<{ item: DoItem; title?: string; done?: boolean }>
  >;
  addItems: Reactive<
    Stream<{ items: Array<{ title: string; indent?: number }> }>
  >;
  removeItemByTitle: Reactive<Stream<{ title: string }>>;
  updateItemByTitle: Reactive<
    Stream<{ title: string; newTitle?: string; done?: boolean }>
  >;
}
```

## `examples/todo-list/main.tsx`

A todo list with AI suggestions.

### Input Schema

```ts
interface TodoItem {
  title: string;
  done: boolean | Default<false>;
}

interface TodoListInput {
  items?: Writable<TodoItem[] | Default<[]>>;
}
```

### Output Schema

```ts
interface TodoListOutput {
  items: TodoItem[];
  itemCount: number;
  addItem: Stream<{ title: string }>;
  removeItem: Stream<{ item: TodoItem }>;
}
```

## `examples/simple-list/main.tsx`

A checklist with indent support. Runs standalone, and embeds in another pattern
as a JSX tag.

**Keywords:** checklist, indentation, composable

### Input Schema

```ts
interface SimpleListItem {
  text: string;
  indented: boolean | Default<false>;
  done: boolean | Default<false>;
}

interface SimpleListInput {
  items?: Writable<SimpleListItem[] | Default<[]>>;
}
```

### Output Schema

```ts
interface SimpleListOutput {
  items: SimpleListItem[];
  addItem: Stream<{ text: string }>;
  deleteItem: Stream<{ index: number }>;
  toggleIndent: Stream<{ index: number }>;
}
```

## `apps/shopping-list/main.tsx`

Shopping list with AI-powered aisle sorting. Pair with
`apps/store-mapper/main.tsx` for store-specific layouts.

**Keywords:** shopping, groceries, AI-sorting, generateObject

### Input Schema

```ts
interface ShoppingItem {
  title: string;
  done: boolean | Default<false>;
  aisleSeed: number | Default<0>;
  aisleOverride: string | Default<"">;
}

interface Input {
  items: Writable<ShoppingItem[] | Default<[]>>;
  storeLayout: Writable<string | Default<"">>;
}
```

### Output Schema

```ts
interface Output {
  items: ShoppingItem[];
  totalCount: number;
  doneCount: number;
  remainingCount: number;
  storeLayout: string;
  addItem: Reactive<Stream<{ detail: { message: string } }>>;
  addItems: Reactive<Stream<{ itemNames: string[] }>>;
}
```

## `system/notes/note.tsx`

A note with wiki-links, backlinks, and embedding support. Managed by
`system/notes/notebook.tsx`.

**Keywords:** note, wiki-links, backlinks, embedding

### Input Schema

```ts
type Input = {
  title?: Writable<string | Default<"Untitled Note">>;
  content?: Writable<string | Default<"">>;
  isHidden?: boolean | Default<false>;
  noteId?: string | Default<"">;
  parentNotebook?: any;
};
```

### Output Schema

```ts
type Output = {
  content: string;
  isHidden: boolean;
  noteId: string;
  backlinks: MentionablePiece[];
  grep: PatternToolResult<{ content: string }>;
  translate: PatternToolResult<{ content: string }>;
  editContent: Stream<{ detail: { value: string } }>;
};
```

## `system/notes/notebook.tsx`

Notebook pattern managing notes and nested notebooks. Creates and organizes
`system/notes/note.tsx` pieces.

**Keywords:** notebook, notes, nested, navigateTo

### Input Schema

```ts
interface Input {
  title?: string | Default<"Notebook">;
  notes?: Writable<NotePiece[] | Default<[]>>;
  isNotebook?: boolean | Default<true>;
  isHidden?: boolean | Default<false>;
  parentNotebook?: any;
}
```

### Output Schema

```ts
interface Output {
  title: string;
  notes: NotePiece[];
  noteCount: number;
  isNotebook: boolean;
  isHidden: boolean;
  backlinks: MentionablePiece[];
  createNote: Stream<{ title: string; content: string }>;
  createNotes: Stream<{ notesData: Array<{ title: string; content: string }> }>;
  setTitle: Stream<string>;
  createNotebook: Stream<{
    title: string;
    notesData?: Array<{ title: string; content: string }>;
  }>;
}
```

## `system/notes/voice-note.tsx`

Record voice notes with automatic transcription and note history. Hold the
microphone button to record, release to transcribe.

**Keywords:** voice, transcription, audio, cf-voice-input

### Input Schema

```ts
type Input = {
  title?: Writable<string | Default<"Voice Note">>;
};
```

### Output Schema

```ts
interface TranscriptionData {
  id: string;
  text: string;
  chunks?: TranscriptionChunk[];
  audioData?: string;
  duration: number;
  timestamp: number;
}

type Output = {
  transcription: TranscriptionData | null | Default<null>;
  notes: TranscriptionData[] | Default<[]>;
};
```

## `apps/calendar/main.tsx`

Calendar for managing events with date and time. Events are sorted by date with
today highlighted.

**Keywords:** calendar, events, dates, navigateTo

### Input Schema

```ts
interface CalendarInput {
  events?: Writable<EventPiece[] | Default<[]>>;
}
```

### Output Schema

```ts
interface CalendarOutput {
  events: EventPiece[];
  sortedEvents: EventPiece[];
  todayDate: string;
  addEvent: Stream<{ title: string; date: string; time: string }>;
  removeEvent: Stream<{ event: EventPiece }>;
}
```

## `apps/weekly-calendar/main.tsx`

Weekly calendar with drag-and-drop event creation and resizing. Manages
`apps/weekly-calendar/event.tsx` pieces.

**Keywords:** weekly, calendar, drag-drop, events, navigateTo

### Input Schema

```ts
interface Input {
  title?: string | Default<"Weekly Calendar">;
  events: Writable<EventPiece[] | Default<[]>>;
  isCalendar?: boolean | Default<true>;
  isHidden?: boolean | Default<false>;
}
```

### Output Schema

```ts
interface Output {
  title: string;
  events: EventPiece[];
  eventCount: number;
  isCalendar: boolean;
  isHidden: boolean;
  backlinks: MentionablePiece[];
  createEvent: Stream<{
    title: string;
    date: string;
    startTime: string;
    endTime: string;
  }>;
  setTitle: Stream<{ newTitle: string }>;
}
```

## `showcase/wordsearch/main.tsx`

Word Search Maker: a form for a title, a word list (one per line), the grid size
and the directions words may run, beside the puzzle it makes. Composes
`showcase/wordsearch/wordsearch.tsx`.

**Keywords:** word search, puzzle, generator, printable, pdf, form

### Input Schema

```ts
interface WordSearchMakerInput {
  title?: Writable<string | Default<"Word Search">>;
  wordText?: Writable<
    string | Default<"apple\nbanana\ncherry\ngrape\nlemon\nmango\npeach">
  >;
  rows?: Writable<number | Default<12>>;
  cols?: Writable<number | Default<12>>;
  diagonals?: Writable<boolean | Default<false>>;
  backwards?: Writable<boolean | Default<false>>;
  seed?: Writable<number | Default<1>>;
}
```

### Output Schema

```ts
interface WordSearchMakerOutput {
  puzzle: WordSearch; // from wordsearch/generator.ts
}
```

## `showcase/wordsearch/play.tsx`

Play a word search: tap a hidden word's first letter, then its last, and it is
marked found. Found words are each player's own (`PerUser`); a reshuffled puzzle
starts unsolved. Takes the `puzzle` that `showcase/wordsearch/wordsearch.tsx`
puts out.

**Keywords:** word search, puzzle, game, play, solve

### Input Schema

```ts
interface WordSearchPlayInput {
  title?: string | Default<"Word Search">;
  puzzle?: WordSearch; // from wordsearch/generator.ts
  found?: PerUser<Writable<string[] | Default<[]>>>;
}
```

### Output Schema

```ts
interface WordSearchPlayOutput {
  foundCount: number;
  solved: boolean;
  tap: Stream<{ index: number }>;
  restart: Stream<void>;
}
```

## `showcase/wordsearch/wordsearch.tsx`

A word search puzzle from a list of words: the grid, the words to find, an
answers switch, Shuffle, and a PDF download of the puzzle and its answer key.
Every hidden word appears exactly once; words left out are named with why.

**Keywords:** word search, puzzle, grid, answer key, pdf, shuffle

### Input Schema

```ts
interface WordSearchInput {
  title?: string | Default<"Word Search">;
  words?: string[] | Default<[]>;
  rows?: number | Default<12>;
  cols?: number | Default<12>;
  diagonals?: boolean | Default<false>;
  backwards?: boolean | Default<false>;
  seed?: Writable<number | Default<1>>;
  showAnswers?: PerSession<Writable<boolean | Default<false>>>;
}
```

### Output Schema

```ts
interface WordSearchOutput {
  puzzle: WordSearch;
  pdf: string;
  shuffle: Stream<void>;
}
```

## `apps/contacts/main.tsx`

Manage contacts with search, notes, and relationships between contacts. Contacts
can be linked together with labels (friend, spouse, colleague, etc.).

**Keywords:** contacts, relationships, search, lift

### Input Schema

```ts
interface Contact {
  name: string;
  email: string | Default<"">;
  phone: string | Default<"">;
  company: string | Default<"">;
  tags: string[] | Default<[]>;
  notes: string | Default<"">;
  createdAt: number;
}

interface Relationship {
  fromName: string;
  toName: string;
  label: string | Default<"">;
}

interface ContactBookInput {
  contacts: Writable<Contact[] | Default<[]>>;
  relationships: Writable<Relationship[] | Default<[]>>;
}
```

### Output Schema

```ts
interface ContactBookOutput {
  contacts: Contact[];
  relationships: Relationship[];
  onAddContact: Stream<void>;
}
```

## `apps/habit-tracker/main.tsx`

Track daily habits with streak counting and 7-day history visualization. Mark
habits complete for today and see your progress over time.

**Keywords:** habits, streaks, daily-tracking, lift

### Input Schema

```ts
interface Habit {
  name: string;
  icon: string | Default<"✓">;
  color: string | Default<"#3b82f6">;
}

interface HabitLog {
  habitName: string;
  date: string; // YYYY-MM-DD
  completed: boolean;
}

interface HabitTrackerInput {
  habits: Writable<Habit[] | Default<[]>>;
  logs: Writable<HabitLog[] | Default<[]>>;
}
```

### Output Schema

```ts
interface HabitTrackerOutput {
  habits: Habit[];
  logs: HabitLog[];
  todayDate: string;
  toggleHabit: Stream<{ habitName: string }>;
  addHabit: Stream<{ name: string; icon: string }>;
  deleteHabit: Stream<{ habit: Habit }>;
}
```

## `apps/star-chart/main.tsx`

A reward calendar for a child learning one daily habit: tap the big star to earn
today's sticker, watch the streak grow, and celebrate at 3, 7, 14 and 30 days.
Until today's star is earned the streak shown is the one it would continue. A
single missed day after three or more earned days is forgiven (derived, never
stored) and shown as a dimmed "protected" day; a parent can correct past days.
The timeline shows the last 30 days. Today is the viewer's local date from the
`#now` clock; `todayOverride` pins it.

**Keywords:** kids, rewards, streaks, daily-habit, calendar, #now

### Input Schema

```ts
interface DayRecord {
  date: string; // YYYY-MM-DD, local
  earned: boolean;
  protected: boolean; // written false and ignored: see protectedDays
  rotation: number; // sticker tilt, -15..15
}

interface StarChartInput {
  goalName?: PerSpace<Writable<string | Default<"Gold Star Goal">>>;
  goalDescription?: PerSpace<Writable<string | Default<"">>>;
  days?: PerSpace<Writable<DayRecord[] | Default<[]>>>;
  todayOverride?: PerSpace<Writable<string | Default<"">>>;
}
```

### Output Schema

```ts
interface StarChartOutput {
  goalName: string;
  goalDescription: string;
  days: DayRecord[];
  today: string;
  currentStreak: number;
  bestStreak: number;
  protectedDays: string[]; // forgiven days, derived from the record
  todayHasStar: boolean;
  milestone: string;
  earnStar: Stream<void>;
  toggleDay: Stream<{ date: string }>;
}
```

## `apps/reward-spinner/main.tsx`

A slot-machine prize spinner for kids: tap the reel and it whirs through prizes
for six seconds before landing on three jelly beans, one jelly bean or a big
hug, with a burst of stars. A parent sets the odds with a quiet generosity
control (0 = mostly hugs, 10 = mostly candy) that briefly shows the resulting
odds, and every spin is recorded with its time and generosity. The prize and the
reel strip are decided once in the spin action; the reel is a CSS animation to
that strip's last cell, played only for spins made in the current session.

**Keywords:** kids, rewards, random, weighted-odds, animation, css-keyframes

### Input Schema

```ts
type PrizeId = "three-beans" | "one-bean" | "hug";

interface SpinRecord {
  timestamp: number; // ms since epoch
  generosity: number; // 0-10, at the time of the spin
  prize: PrizeId;
}

interface RewardSpinnerInput {
  generosity?: PerSpace<Writable<number | Default<10>>>;
  spinHistory?: PerSpace<Writable<SpinRecord[] | Default<[]>>>;
}
```

### Output Schema

```ts
interface RewardSpinnerOutput {
  generosity: number;
  spinHistory: SpinRecord[];
  lastPrize: string; // emoji the reel rests on; 🎁 before any spin
  odds: { emoji: string; dots: string; percent: number }[];
  reel: PerSession<string[]>; // this session's latest reel strip; empty before one
  spin: Stream<void>;
  moreGenerous: Stream<void>;
  lessGenerous: Stream<void>;
}
```

## `apps/assumption-surfacer/main.tsx`

A chat that shows, beside the conversation, the assumptions the assistant is
making about you. Before each reply the assistant records its few most
consequential guesses (your language, skill level, goal…) through a
`recordAssumptions` tool, each with alternatives; the list is read from those
tool calls in the chat, so only your verdicts are stored. The sidebar lists
them, newest first; pick the right alternative or "None of these". A correction
is also sent to the chat, and every settled assumption is folded into the system
prompt so later replies build on it.

**Keywords:** llm, chat, llmDialog, tools, assumptions, clarification

### Input Schema

```ts
interface Assumption {
  id: string; // a1, a2, … in recording order
  turn: number; // which user message (1-based) the reply answered
  about: string; // excerpt of that message
  label: string;
  description: string;
  alternatives: string[];
  assumedIndex: number;
  status: "open" | "confirmed" | "corrected" | "rejected";
  chosenIndex: number; // when corrected, else -1
}

interface AssumptionSurfacerInput {
  messages?: PerSpace<Writable<BuiltInLLMMessage[] | Default<[]>>>;
  // The user's verdict on each recorded assumption, by id. The assumptions
  // themselves are read from the recordAssumptions calls in `messages`.
  verdicts?: PerSpace<
    Writable<
      | Record<string, { status: Assumption["status"]; chosenIndex: number }>
      | Default<{}>
    >
  >;
  // Each message of assumption updates sent; one counts as told only once it
  // appears in `messages` (the dialog drops a send made mid-reply).
  updates?: PerSpace<Writable<SentUpdate[] | Default<[]>>>;
  systemPrompt?: PerSpace<Writable<string | Default<"">>>;
}
```

### Output Schema

```ts
interface AssumptionSurfacerOutput {
  messages: BuiltInLLMMessage[];
  assumptions: Assumption[];
  openCount: number;
  settled: string[]; // settled facts, as fed to the model
  unsent: string[]; // verdicts not yet told to the assistant in the chat
  system: string; // the full system prompt
  pending: boolean | undefined;
  recordAssumptions: Stream<{ assumptions: ReportedAssumption[] }>;
  confirmAssumption: Stream<{ id: string }>;
  rejectAssumption: Stream<{ id: string }>;
  chooseAlternative: Stream<{ id: string; index: number }>;
  sendUpdates: Stream<void>; // tell the assistant every unsent verdict now
  addMessage: Stream<BuiltInLLMMessage>;
  cancelGeneration: Stream<void>;
  clearChat: Stream<void>;
}
```

## `apps/redactor/redactor.tsx`

Ask a language model about something personal without sending it anything
personal. Names, emails, phone numbers, SSNs, card numbers and addresses in a
draft, from the embedded PII vault (`apps/redactor/main.tsx`) or found by
format, are swapped for realistic stand-ins; only that redacted draft may be
sent to the model, and the reply comes back with the originals restored for the
owner. CFC enforces the boundary: the draft and vault are `Confidential` under
`policy.tsx`, whose one exchange rule releases only what the `redactDraft` lift
computes, and the model's prompt is a `MaxConfidentiality` store. See the
README's CFC design and CFC debt sections.

**Keywords:** privacy, PII, redaction, pseudonymization, llm, CFC, exchangeRule,
TransformedBy, MaxConfidentiality

### Input Schema

```ts
interface RedactorInput {
  vaultEntries?: Writable<Default<Secret<PIIEntry>[], []>>;
  draft: Writable<Secret<string>>; // no Default: see README, CFC debt 3
  modelPrompt?: Writable<Default<PublicText, "">>;
  pastedReply?: Writable<Default<string, "">>;
}
```

### Output Schema

```ts
interface RedactorOutput {
  redacted: string; // released
  found: Detection[]; // secret
  leaks: string[];
  modelPrompt: PublicText;
  reply: string;
  restored: string; // secret
  send: Stream<void>;
  sendRawDraft: Stream<void>; // refused by the runtime
  typeDraft: Stream<{ text: string }>;
}
```

## `apps/story-weaver/main.tsx`

Grow a story with AI, one level at a time. Commit a synopsis (or ask for ideas
with Inspire me), and each spindle on the next level asks the model for four
Markdown options built on its parent; pin one and its children appear on the
level below, ready to generate. Levels (Characters & Themes, Chapters, ...) are
editable, and each has a branch factor for how many sibling spindles a pinned
parent gets. Respin asks for fresh options, a spindle can carry its own extra
instruction, and pins built on text that has since changed are flagged stale.
The board is a tree of paths derived from what was pinned (`story-logic.ts`),
and the pinned story projects to `[FS]` Markdown.

**Keywords:** llm, generateObject, writing, story, brainstorm, tree, branching

### Input Schema

```ts
interface Level {
  title: string;
  prompt: string; // instruction each spindle at this level sends
  branch: number; // siblings per pinned parent, 1..6
}

interface Spindle {
  path: string; // sibling indices per level, e.g. "0.2"
  pinned: number; // option index, or -1
  pinnedText: string;
  parentHash: string; // hash of the parent text when pinned (stale check)
  extraPrompt: string;
  respins: number;
  requested: boolean; // levels below the first wait for Generate options
}

interface StoryWeaverInput {
  title?: PerSpace<Writable<string | Default<"My Story Weaver">>>;
  synopsis?: PerSpace<Writable<string | Default<"">>>;
  synopsisDraft?: PerSpace<Writable<string | Default<"">>>;
  levels?: PerSpace<Writable<Level[] | Default<typeof DEFAULT_LEVELS>>>;
  spindles?: PerSpace<Writable<Spindle[] | Default<[]>>>;
}
```

### Output Schema

```ts
interface StoryWeaverOutput {
  title: string;
  synopsis: string;
  synopsisDraft: string;
  levels: Level[];
  spindles: Spindle[];
  board: string[][]; // paths on the board, level by level
  startStory: Stream<void>;
  pin: Stream<{ path: string; option: number; text: string }>;
  respin: Stream<{ path: string }>;
  generate: Stream<{ path: string }>;
  setExtraPrompt: Stream<{ path: string; text: string }>;
  setBranch: Stream<{ level: number; branch: number }>;
  addLevel: Stream<{ title: string; prompt: string }>;
  updateLevel: Stream<{ level: number; title: string; prompt: string }>;
  removeLastLevel: Stream<void>;
}
```

## `apps/smart-rubric/main.tsx`

Weigh options against a weighted rubric. Define categorical dimensions (scored
Excellent / Good / Fair / Poor) and numeric ones (an editable range mapped onto
the same 0–10 scale, higher or lower is better), weight them, and set each
option's values; options rank by weighted score. ▲/▼ pins an option at a slot by
hand while the rest keep ranking by score. Quick Add sends a free-text
description to `generateObject` and proposes the option's name and values,
checked against the rubric, for review before adding.

**Keywords:** decision, rubric, scoring, ranking, weights, generateObject, llm

### Input Schema

```ts
interface CategoryOption {
  label: string;
  score: number;
}

interface Dimension {
  name: string; // unique; option values refer to it
  type: "categorical" | "numeric";
  multiplier: number; // weight, 0..10 in steps of 0.5
  categories: CategoryOption[];
  numericMin: number;
  numericMax: number;
  higherIsBetter?: boolean; // numeric only; default true
}

interface RubricOption {
  name: string; // unique
  values: { dimensionName: string; value: string | number }[];
  manualRank: number | null; // slot pinned by hand, or null
}

interface RubricInput {
  title?: PerSpace<Writable<string | Default<"Decision Rubric">>>;
  options?: PerSpace<Writable<RubricOption[] | Default<[]>>>;
  dimensions?: PerSpace<Writable<Dimension[] | Default<[]>>>;
}
```

### Output Schema

```ts
interface RubricOutput {
  title: string;
  options: RubricOption[];
  dimensions: Dimension[];
  ranked: RankedOption[]; // displayed order with scores
  selected: string;
  quickAddStatus: "idle" | "pending" | "error" | "ready";
  quickAddPreview: QuickAddPreview;
  addOption: Stream<{ name?: string }>;
  removeOption: Stream<{ name: string }>;
  addDimension: Stream<{ name?: string; type: "categorical" | "numeric" }>;
  removeDimension: Stream<{ name: string }>;
  changeWeight: Stream<{ name: string; delta: number }>;
  toggleDirection: Stream<{ name: string }>;
  // a numeric dimension's range; a bound left out stays, min >= max is refused
  setRange: Stream<
    { name: string; min?: number | string; max?: number | string }
  >;
  selectOption: Stream<{ name: string }>;
  setValue: Stream<
    { option: string; dimension: string; value: string | number }
  >;
  stepValue: Stream<{ option: string; dimension: string; delta: number }>;
  moveOption: Stream<{ name: string; delta: number }>;
  resetManualRanks: Stream<void>;
  analyzeQuickAdd: Stream<void>;
  acceptQuickAdd: Stream<void>;
  clearQuickAdd: Stream<void>;
  dismissQuickAdd: Stream<void>;
}
```

## `apps/codenames-helper/main.tsx`

A spymaster's companion for playing the word game Codenames in person with the
physical cards. Setup: type the 25 board words into the grid and give each card
its key-card color (tap a card, then a color), or photograph the board and the
key card and apply what an LLM reads from each after checking it. The color
counts flag a key that is not 9/8/7/1. Play: tap a card when it is guessed to
mark it out of play (tap again to undo), and ask for one-word clue ideas that
connect your team's remaining words while avoiding the rest (ask again for
different ideas). Board logic is pure functions in `board.ts`.

**Keywords:** game companion, board game, word game, spymaster, LLM,
generateObject, image input, 5x5 grid

### Input Schema

```ts
type Team = "red" | "blue";
type Owner = "red" | "blue" | "neutral" | "assassin" | "unassigned";
type Mode = "setup" | "play";

interface BoardCard {
  word: string; // upper case, "" until entered
  owner: Owner; // key-card color
  revealed: boolean; // guessed, out of play
}

interface CodenamesHelperInput {
  board?: PerSpace<Writable<BoardCard[] | Default<[]>>>; // padded to 25
  myTeam?: PerUser<Writable<Team | Default<"red">>>; // each spymaster's own
  mode?: PerSpace<Writable<Mode | Default<"setup">>>;
}
```

### Output Schema

```ts
interface CodenamesHelperOutput {
  board: BoardCard[]; // always 25, row-major
  myTeam: Team;
  mode: Mode;
  selectedIndex: number; // card picked for coloring, or -1
  inPlay: Record<Owner, number>;
  keyWarnings: string[];
  clueRequest: string; // board prompt clue ideas were last requested for
  tapCard: Stream<{ index: number }>;
  assignOwner: Stream<{ owner: Owner }>;
  setWord: Stream<{ index: number; word: string }>;
  applyPhotoReading: Stream<{ reading: PhotoReading; photoId?: string }>;
  clearColors: Stream<void>;
  resetBoard: Stream<void>;
  startPlay: Stream<void>;
  editBoard: Stream<void>;
  requestClues: Stream<void>;
}
```

## `apps/food-recipe/main.tsx`

One recipe with what a cook and a meal planner need from it: ingredients, steps
grouped into phases timed against serving (nights before, or minutes before)
with durations, how long each result can wait, and oven needs (temperature,
minutes, rack height and width); servings scaling that understands fractions;
dietary analysis (`recipe-analyzer.tsx`, run on request and flagged when out of
date); and a cooking view with a checkbox per step (`viewer.tsx`). Paste a
recipe or add photos and "Extract Recipe Data" has the model fill the fields,
shown as a field-by-field diff (the notes as a word diff) to apply or cancel;
"Suggest Timing" proposes timing for the step groups the same way. Shared types
live in `schemas.tsx`; a meal planner should read the narrow `RecipeForMeal`
role type rather than the full output.

**Keywords:** recipe, cooking, meal-planning, generateObject, image extraction,
diff review, oven, dietary

### Input Schema

```ts
interface Ingredient {
  item: string;
  amount: string; // free text: "1 1/2", "2-3"
  unit: string;
}

interface OvenNeed {
  temperature: number; // °F
  duration: number; // minutes in the oven
  heightSlots: number; // 1 sheet pan, 2 casserole, 5 turkey
  width: "full" | "half";
}

interface StepGroup {
  id: string;
  name: string;
  nightsBeforeServing?: number; // exclusive with minutesBeforeServing
  minutesBeforeServing?: number;
  duration?: number;
  maxWaitMinutes?: number;
  oven?: OvenNeed; // absent when no oven
  steps: { description: string }[];
}

interface FoodRecipeInput {
  name?: PerSpace<Writable<string | Default<"">>>;
  cuisine?: PerSpace<Writable<string | Default<"">>>;
  servings?: PerSpace<Writable<number | Default<4>>>;
  yield?: PerSpace<Writable<string | Default<"">>>;
  difficulty?: PerSpace<Writable<Difficulty | Default<"medium">>>;
  prepTime?: PerSpace<Writable<number | Default<0>>>;
  cookTime?: PerSpace<Writable<number | Default<0>>>;
  restTime?: PerSpace<Writable<number | Default<0>>>;
  holdTime?: PerSpace<Writable<number | Default<0>>>;
  category?: PerSpace<Writable<RecipeCategory | Default<"other">>>;
  ingredients?: PerSpace<Writable<Ingredient[] | Default<[]>>>;
  stepGroups?: PerSpace<Writable<StepGroup[] | Default<[]>>>;
  tags?: PerSpace<Writable<string[] | Default<[]>>>;
  notes?: PerSpace<Writable<string | Default<"">>>;
  source?: PerSpace<Writable<string | Default<"">>>;
}
```

### Output Schema

```ts
interface FoodRecipeOutput {
  // every input field, as a plain value, plus:
  totalTime: number; // prep + cook + rest
  ovenRequirements: {
    needsOven: boolean;
    temps: number[];
    tempChanges: boolean;
  };
  dietaryCompatibility: {
    compatible: string[];
    incompatible: string[];
    warnings: string[];
    primaryIngredients: string[];
  };
  // "none" = not analyzed yet: empty lists mean unknown, not safe
  dietarySource: "analyzed" | "stale" | "none";
  analyzeDiet: Stream<void>;
  extraction: RecipeExtraction | null; // under review
  timingSuggestions: TimingSuggestions | null; // under review
  extract: Stream<void>;
  applyExtraction: Stream<void>;
  cancelExtraction: Stream<void>;
  suggestTiming: Stream<void>;
  applyTiming: Stream<void>;
  cancelTiming: Stream<void>;
  scale: Stream<{ factor: number }>;
  addIngredient: Stream<void>;
  removeIngredient: Stream<{ index: number }>;
  addStepGroup: Stream<void>;
  removeStepGroup: Stream<{ id: string }>;
  moveStepGroup: Stream<{ id: string; delta: number }>;
  addStep: Stream<{ id: string }>;
  removeStep: Stream<{ id: string; step: number }>;
  moveStep: Stream<{ id: string; step: number; delta: number }>;
  setGroupNumber: Stream<
    { id: string; field: GroupNumberField; value: string }
  >;
  setOven: Stream<{ id: string; field: OvenField; value: string }>;
  cook: Stream<void>; // opens the cooking view
}
```

## `apps/food-recipe/prepared-food.tsx`

A dish nobody cooks from a recipe (store-bought, guest-brought, takeout) for
meal planning: servings, category, prep time, whether it needs reheating, and
hand-declared dietary tags (common tags one tap away) and main ingredients. Its
`dietaryCompatibility` has the recipe's shape so a planner treats both alike;
`PreparedFoodForMeal` in `schemas.tsx` is the narrow role type.

**Keywords:** meal-planning, prepared food, takeout, dietary tags, cf-tags

### Input Schema

```ts
interface PreparedFoodInput {
  name?: PerSpace<Writable<string | Default<"">>>;
  servings?: PerSpace<Writable<number | Default<4>>>;
  category?: PerSpace<Writable<RecipeCategory | Default<"other">>>;
  dietaryTags?: PerSpace<Writable<string[] | Default<[]>>>;
  primaryIngredients?: PerSpace<Writable<string[] | Default<[]>>>;
  description?: PerSpace<Writable<string | Default<"">>>;
  source?: PerSpace<Writable<string | Default<"">>>;
  prepTime?: PerSpace<Writable<number | Default<0>>>;
  requiresReheating?: PerSpace<Writable<boolean | Default<false>>>;
}
```

### Output Schema

```ts
interface PreparedFoodOutput {
  // every input field, as a plain value, plus:
  dietaryCompatibility: DietaryCompatibility; // compatible = dietaryTags
  dietarySource: "declared" | "none"; // "none" until a tag or ingredient is entered
  addDietaryTag: Stream<{ tag: string }>;
}
```

## `apps/meal-orchestrator/main.tsx`

Plan a meal of several dishes: the event (name, date, serving time, guests),
equipment (ovens with rack positions and racks owned, stovetop burners), each
guest's dietary needs, and the menu of recipes and prepared foods from
`apps/food-recipe/`, read through the narrow `RecipeForMeal` /
`PreparedFoodForMeal` role types. "Link Dishes from Notes" has the model pick
the foods out of free-form planning notes, match each to a recipe or prepared
food already in the space (`wish("#recipe" / "#preparedFood")`), or offer to
create one, all reviewed with checkboxes before anything is added; existing
dishes can also be added by hand. It works out the meal's balance (dishes and
servings per course against the guest count), each guest's dietary fit (unknown
is never read as safe; "Analyze Diets" runs the recipes' own analyzers), and an
oven plan that gives every oven step an oven by temperature, racks and height
and reports what cannot fit, drawn as a timeline in clock time. "Suggest
Improvements" asks the model for menu ideas. Burners are recorded but not
scheduled: recipes do not say when they use one.

**Keywords:** meal-planning, recipe, prepared food, oven schedule, conflict
detection, dietary, generateObject, wish, composition, mentionable

### Input Schema

```ts
interface OvenConfig {
  rackPositions: number; // 3-7
  physicalRacks: number; // 1-3
}

interface GuestDietaryProfile {
  guestName: string;
  requirements: string[]; // "vegan", "gluten-free", "no-mushrooms"
}

// RecipeForMeal / PreparedFoodForMeal from ../food-recipe/schemas.tsx, every
// field optional, plus the dish's own stream.
interface MealRecipe extends Partial<RecipeForMeal> {
  analyzeDiet?: Stream<void>;
}
interface MealPreparedFood extends Partial<PreparedFoodForMeal> {
  addDietaryTag?: Stream<{ tag: string }>;
}

interface MealOrchestratorInput {
  mealName?: PerSpace<Writable<string | Default<"">>>;
  mealDate?: PerSpace<Writable<string | Default<"">>>; // "2026-11-26"
  mealTime?: PerSpace<Writable<string | Default<"">>>; // "18:00"
  guestCount?: PerSpace<Writable<number | Default<4>>>;
  ovens?: PerSpace<Writable<OvenConfig[]>>; // default: one 5-position, 2-rack oven
  stovetopBurners?: PerSpace<Writable<number | Default<4>>>;
  dietaryProfiles?: PerSpace<Writable<GuestDietaryProfile[] | Default<[]>>>;
  planningNotes?: PerSpace<Writable<string | Default<"">>>;
  recipes?: PerSpace<Writable<MealRecipe[] | Default<[]>>>;
  preparedFoods?: PerSpace<Writable<MealPreparedFood[] | Default<[]>>>;
  notes?: PerSpace<Writable<string | Default<"">>>;
}
```

### Output Schema

```ts
interface MealOrchestratorOutput {
  // every input field, as a plain value, plus:
  ovenPlan: {
    // start/end in minutes before serving; oven is an index, null if none fits
    events: {
      id: string;
      dish: string;
      step: string;
      start: number;
      end: number;
      temperature: number;
      heightSlots: number;
      width: "full" | "half";
      oven: number | null;
    }[];
    conflicts: {
      id: string;
      dish: string;
      step: string;
      at: number;
      temperature: number;
      with: string[];
      reason: string;
    }[];
    offTimeline: { dish: string; step: string; reason: string }[]; // night before, unscheduled
    warnings: string[]; // still in the oven after serving
  };
  balance: {
    categories: {
      category: RecipeCategory;
      label: string;
      dishes: number;
      servings: number;
    }[];
    dishCount: number;
    totalServings: number;
    warnings: string[];
  };
  dietary: {
    guest: string;
    requirement: string;
    fits: string[];
    conflicts: string[];
    unknown: string[];
    warning: string;
  }[];
  linkAnalysis: { items: LinkItem[] } | null; // under review
  suggestions: { suggestions: string[] } | null;
  mentionable: (RecipeForMeal | PreparedFoodForMeal)[]; // dishes it created
  addOven: Stream<void>;
  removeOven: Stream<{ index: number }>;
  setOvenField: Stream<
    { index: number; field: "rackPositions" | "physicalRacks"; value: string }
  >;
  addGuest: Stream<void>;
  removeGuest: Stream<{ index: number }>;
  setRequirements: Stream<{ index: number; requirements: string[] }>;
  linkNotes: Stream<void>;
  toggleLinkItem: Stream<{ index: number }>;
  applyLinking: Stream<void>;
  cancelLinking: Stream<void>;
  removeRecipe: Stream<{ index: number }>;
  removePreparedFood: Stream<{ index: number }>;
  analyzeDiets: Stream<void>;
  markSuits: Stream<{ index: number; requirement: string }>;
  suggest: Stream<void>;
  clearSuggestions: Stream<void>;
}
```

## `examples/reading-list/main.tsx`

**Canonical list-detail example.** Track books, articles, papers, and videos.
Demonstrates: footer forms, `navigateTo()` for details, `lift()` for filtering.

**Keywords:** reading, books, articles, status-tracking, lift, navigateTo

### Input Schema

```ts
type ItemType = "book" | "article" | "paper" | "video";
type ItemStatus = "want" | "reading" | "finished" | "abandoned";

interface ReadingListInput {
  items?: Writable<ReadingItemPiece[] | Default<[]>>;
}
```

### Output Schema

```ts
interface ReadingListOutput {
  items: ReadingItemPiece[];
  totalCount: number;
  currentFilter: ItemStatus | "all";
  filteredItems: ReadingItemPiece[];
  filteredCount: number;
  addItem: Stream<{ title: string; author: string; type: ItemType }>;
  removeItem: Stream<{ item: ReadingItemPiece }>;
  setFilter: Stream<{ status: ItemStatus | "all" }>;
  updateItem: Stream<{
    item: ReadingItemPiece;
    status?: ItemStatus;
    rating?: number | null;
    notes?: string;
  }>;
}
```

## `apps/budget-tracker/main.tsx`

Track expenses by category with budget limits and spending visualization.
Multi-file pattern using sub-patterns for the form and data views.

**Keywords:** budget, expenses, categories, sub-patterns

### Input Schema

```ts
interface Expense {
  description: string;
  amount: number;
  category: string | Default<"Other">;
  date: string; // YYYY-MM-DD
}

interface CategoryBudget {
  category: string;
  limit: number;
}

interface Input {
  expenses: Writable<Expense[] | Default<[]>>;
  budgets: Writable<CategoryBudget[] | Default<[]>>;
}
```

### Output Schema

```ts
interface Output {
  expenses: Expense[];
  budgets: CategoryBudget[];
}
```

## `examples/fair-share/main.tsx`

A shared group expense ledger (Splitwise-inspired). Track who paid for each
expense and who shared it, see reactive net balances, and a minimal greedy
"settle up" plan of who pays whom. Per-space ledger, per-user `myName` identity
("you are owed / you owe"), per-session form drafts. Money is computed in
integer cents with largest-remainder allocation so shares sum to the total and
balances tie out exactly. Identity uses `equals()` (no synthetic id fields);
people are referenced from expenses by their unique name.

**Keywords:** expenses, split, settle up, balances, group, shared ledger,
per-user, equals, money

### Input Schema

```ts
interface Person {
  name: string;
}

interface Expense {
  description: string;
  amount: number;
  paidBy: string; // Person.name
  sharedBy: string[]; // Person.name[]; empty => split among everyone
  date: string; // YYYY-MM-DD
}

interface Input {
  people: Writable<Person[] | Default<[]>>;
  expenses: Writable<Expense[] | Default<[]>>;
  myName: PerUser<string | Default<"">>;
}
```

### Output Schema

```ts
interface Balance {
  name: string;
  paid: number;
  share: number;
  net: number; // positive => is owed, negative => owes
}

interface Settlement {
  from: string;
  to: string;
  amount: number;
}

interface Output {
  people: Person[];
  expenses: Expense[];
  myName: string;
  balances: Balance[];
  settlements: Settlement[];
  total: number;
}
```

## `apps/shared-note/main.tsx`

A shared Markdown document built on `cf-code-editor` in collaborative prose
mode. The title and body are durable per-space state; body edits synchronize
through Memory's operation protocol. Names, carets, and selections travel
separately as ephemeral co-presence data over each viewer's memory connection.
Each viewer selects or creates a Fabric profile with
`wish({ query: "#profile" })`, and the editor uses that profile's `#profileName`
field as its cursor label. The same compact view serves as `UI` and `TILE_UI`,
so the note embeds in other surfaces, and editing or live-cursor failures show
as notices above the editor.

A panel beside the editor holds comments on ranges of the body, with replies and
a resolved state. Each comment names two anchors of the body, points that Memory
moves through every edit, which the pattern reads and writes as a cell through
`anchorsOf()`; the editor draws the text between each open comment's anchors as
a highlight. Comments and replies are labeled `authored-by` their writer through
`AuthoredByCurrentUser`, and shown through `cf-cfc-authorship`. Verbs let an
agent comment on text it quotes, reply, resolve, reopen, and delete. The note
reports what its members did under `"[ACTIVITY]"`: one row per editing session
that changed the note, edit verb call, comment or reply (an unchanged session,
resolving, reopening, deleting and drafts write none), labeled `authored-by` the
person who acted.

**Keywords:** multiplayer, collaborative editor, note, Markdown, profile, wish,
co-presence, CodeMirror, comments, annotations, anchors, anchorsOf,
AuthoredByCurrentUser, activity, WritePolicyAnyOf

### Input Schema

```ts
interface SharedNoteInput {
  title?: PerSpace<string | Default<"Untitled note">>;
  content?: PerSpace<string | Default<"">>;
  comments?: PerSpace<StoredComment[] | Default<[]>>;
  activity?: PerSpace<ActivityRow[] | Default<[]>>;
}
```

### Output Schema

```ts
interface SharedNoteOutput {
  title: PerSpace<string>;
  content: PerSpace<string>;
  comments: PerSpace<StoredComment[]>;
  participantName: PerUser<string>;
  "[ACTIVITY]": PerSpace<ActivityRow[]>;
  commentAnchors: FieldAnchors | undefined;
  appendLine: Stream<LineEvent>;
  prependLine: Stream<LineEvent>;
  replaceText: Stream<ReplaceTextEvent>;
  addComment: Stream<AddCommentEvent>;
  replyToComment: Stream<CommentReplyEvent>;
  resolveComment: Stream<CommentIdEvent>;
  reopenComment: Stream<CommentIdEvent>;
  deleteComment: Stream<CommentIdEvent>;
}
```

## `examples/cfc-agent-prompt-injection-demo/cfc-agent-prompt-injection-demo.tsx`

Interactive side-by-side chatbot demo for the new observation ceiling and
subagent behavior. One chat reads a hostile prompt-influencing briefing directly
and gets tainted before it can use a low-conf tool; the other delegates the raw
text to a higher-ceiling userland subagent pattern via `patternTool()` and only
receives a schema-limited safe summary.

**Keywords:** llmDialog, patternTool, prompt-injection, confidentiality,
tool-calling, cf-chat

### Input Schema

```ts
type Input = Record<string, never>;
```

### Output Schema

```ts
type SentEmail = {
  route: string;
  recipient: string;
  subject: string;
  body: string;
  loggedAt: string;
};

type Output = {
  emails: SentEmail[];
  unsafeMessages: BuiltInLLMMessage[];
  safeMessages: BuiltInLLMMessage[];
  unsafePending: boolean;
  safePending: boolean;
  parentModel: string;
  subAgentModel: string;
};
```

## `system/chatbot/chatbot.tsx`

Full-featured AI chat assistant with tool support, model selection, and
mentionables. Deploy this to have a conversational AI interface.

**Keywords:** llm, chat, tools, llmDialog, generateObject

### Input Schema

```ts
type ChatInput = {
  messages?: Writable<Array<BuiltInLLMMessage> | Default<[]>>;
  tools?: any;
  theme?: any;
  system?: string;
};
```

### Output Schema

```ts
type ChatOutput = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  addMessage: Stream<BuiltInLLMMessage>;
  clearChat: Stream<void>;
  cancelGeneration: Stream<void>;
  title?: string;
  pinnedCells: Array<{ path: string; name: string }>;
  tools: any;
};
```

## `examples/group-chat-lobby/main.tsx`

Multiplayer group chat lobby where users join with their shared profile
(`wish({ query: "#profile" })` — the wish UI covers profile create/pick) and
enter a shared chat room. Uses `navigateTo()` to transition into
`examples/group-chat-room/group-chat-room.tsx`.

**Keywords:** multiplayer, chat, lobby, navigateTo, profile, wish

### Input Schema

```ts
interface Message {
  id: string;
  author: string;
  content: string;
  timestamp: number;
  type: "chat" | "system" | "image";
  imageUrl?: string;
  reactions: Reaction[];
}

interface User {
  name: string;
  joinedAt: number;
  /** Avatar URL or glyph, snapshotted from the joiner's shared profile. */
  avatar?: string;
}

interface LobbyInput {
  chatName: string | Default<"Group Chat">;
  messages: Writable<Message[] | Default<[]>>;
  users: Writable<User[] | Default<[]>>;
  sessionId: Writable<string | Default<"">>;
}
```

### Output Schema

```ts
interface LobbyOutput {
  chatName: string;
  messages: Message[];
  users: User[];
  sessionId: string;
}
```

## `product/lobby/lobby.tsx`

Simple multiplayer presence lobby. Each viewer joins by contributing their live
Fabric profile cell from `wish({ query: "#profile" })`; every participant is
rendered with `cf-profile-badge`. Admin membership uses the shared trusted admin
registry flow: an empty registry defaults to everyone being an admin, and
turning that fallback off seeds the acting participant as the first explicit
admin. Admins can promote other participants and remove people. Agents can call
the no-payload `addSelf` action and read the profile-free `allParticipants`
snapshot for downstream processing.

**Keywords:** multiplayer, lobby, roster, profile, wish, trusted admin, CFC

### Input Schema

```ts
interface LobbyInput {
  roster?: PerSpace<LobbyRosterValue>;
  adminRegistry?: PerSpace<LobbyAdminRegistryCell>;
}
```

### Output Schema

```ts
interface LobbyOutput {
  addSelf: Stream<void>;
  allParticipants: readonly LobbyParticipantView[];
  participants: readonly LobbyParticipantView[];
  participantCount: number;
  currentUserIsAdmin: boolean;
  everyoneIsAdmin: boolean;
  join: Stream<LobbyTrustedActionEvent>;
  removeParticipant: Stream<LobbyTrustedActionEvent>;
  toggleParticipantAdmin: Stream<LobbyTrustedActionEvent>;
  setEveryoneIsAdmin: Stream<LobbyTrustedActionEvent>;
}
```

## `apps/store-mapper/main.tsx`

Capture grocery store layouts through manual aisle entry, perimeter department
positioning, and item location corrections. Generates layout data used by
`apps/shopping-list/main.tsx` for AI-powered aisle sorting.

**Keywords:** store-layout, grocery, aisles, generateObject

### Input Schema

```ts
interface Aisle {
  name: string;
  description: string | Default<"">;
}

interface Department {
  name: string;
  icon: string;
  location: WallPosition | Default<"unassigned">;
  description: string | Default<"">;
}

interface Entrance {
  position: WallPosition;
}

interface ItemLocation {
  itemName: string;
  correctAisle: string;
  incorrectAisle: string | Default<"">;
  timestamp: number;
}

interface Input {
  storeName: Writable<string | Default<"My Store">>;
  aisles: Writable<Aisle[] | Default<[]>>;
  departments: Writable<Department[] | Default<[]>>;
  entrances: Writable<Entrance[] | Default<[]>>;
  itemLocations: Writable<ItemLocation[] | Default<[]>>;
}
```

### Output Schema

```ts
interface Output {
  storeName: string;
  aisles: Aisle[];
  departments: Department[];
  entrances: Entrance[];
  itemLocations: ItemLocation[];
  storeLayout: string; // Generated markdown layout description
}
```

## `examples/image/main.tsx`

Display an image from a URL or data URI with optional caption. Useful for
rendering images when an LLM has a URL to display.

**Keywords:** image, photo, picture, display, url, data-uri, base64

### Input Schema

```ts
interface ImageInput {
  url?: string | Default<"">;
  caption?: string | Default<"">;
}
```

### Output Schema

```ts
interface ImageOutput {
  url: string;
  caption: string;
}
```

---

# AI & Capability Demos

## `apps/deep-research/main.tsx`

Deep research agent that uses llmDialog to search the web and synthesize
findings. Shows live progress via cf-message-beads and renders a structured
result with summary, confidence, and sources. Supports follow-up refinement.

**Keywords:** llm, research, web-search, tools, llmDialog, agent, beads

### Input Schema

```ts
type Input = {
  /** The research question to investigate */
  situation: string | Default<"What are the latest developments in AI agents?">;
  /** Message history (managed by llmDialog) */
  messages?: Writable<Array<BuiltInLLMMessage> | Default<[]>>;
  /** Optional context cells to provide to the agent */
  context?: { [id: string]: any };
};
```

### Output Schema

```ts
type ResearchResult = {
  summary: string;
  findings: { title: string; source: string; content: string }[];
  sources: string[];
  confidence: "high" | "medium" | "low";
};

type Output = {
  result: ResearchResult | undefined;
};
```

## `apps/image-analysis/main.tsx`

Upload images and get AI-powered analysis and descriptions. Supports multiple
images with customizable prompts.

**Keywords:** vision, image, generateText, cf-image-input

### Input Schema

```ts
type ImageChatInput = {
  systemPrompt?: string;
  model?: string;
};
```

### Output Schema

```ts
type ImageChatOutput = {
  images: Writable<ImageData[]>;
  prompt: Writable<string>;
  response: string | undefined;
  pending: boolean | undefined;
};
```

## `examples/clock/main.tsx`

Example pattern: a live wall clock driven by the reactive `#now` wish
(`wish({ query: "#now/1" })`, ticking once per second). Shows the sanctioned way
to read time in reactive code — the capability gate forbids `Date.now()` /
`new Date()` in a lift/computed/pattern-body — plus the `null`-until-resolved
load-window guard. `new Date(ms)` with an explicit argument stays fine for
formatting.

**Keywords:** now, wish, clock, time, reactive, capability-gate, timing

## `examples/reactive-now/main.tsx`

Example pattern demonstrating both pattern-facing surfaces of the timing
side-channel mitigations. Reading time: a one-shot `#now` snapshot (the piece's
first-ever load, durable), a ticking `#now/1` clock (current time), and a
`#now`-derived "N seconds ago" elapsed label — a worked reference for migrating
clock reads off the forbidden body-level `Date.now()` onto `#now`. Receiving
input: a "Tap" button and a `$value` text box, so a live browser can watch the
token-bucket delivery shaping — bursts are realtime, only sustained
mashing/typing is throttled, and nothing is dropped.

**Keywords:** now, wish, time, elapsed, relative-time, reactive,
capability-gate, timing, delivery-shaping, token-bucket, input

## `examples/profile-aware-writer/main.tsx`

Example pattern demonstrating how to use the `#profile` wish to personalize LLM
output. Fetches the user's profile summary and injects it into the system prompt
for personalized text generation.

**Keywords:** profile, wish, generateText, llm, personalization

### Input Schema

```ts
type Input = {
  title?: string | Default<"Profile-Aware Writer">;
};
```

### Output Schema

```ts
type Output = {
  topic: Writable<string>;
  response: string | undefined;
};
```

## `showcase/inductor/lofi/main.tsx`

A hi-fi model labels each item for a yes-or-no goal while a lo-fi regex rule set
shadows it. Disagreements become graded examples; an LLM proposes a new rule
set, adopted only when it is in grammar, cheap to run, and better on a held-out
split. Rules publish under a per-goal pseudonym to an `inductor-pool`, and the
pool's released rules come back as an offer judged the same way. The view is
five card sub-patterns, in the order a newcomer uses them (`items-card.tsx`,
`rules-card.tsx`, `history-card.tsx`, `pool-card.tsx`, `settings-card.tsx`).

**Keywords:** classifier, regex, rule induction, hi-fi lo-fi, held-out, F1,
pseudonym, threshold release, CFC

### Input Schema

```ts
interface LofiInductorInput {
  goal?: PerSpace<Writable<string | Default<"">>>;
  items?: PerSpace<Writable<Item[] | Default<[]>>>;
  rules?: PerSpace<Writable<CanonicalRule[] | Default<[]>>>;
  history?: PerSpace<Writable<HistoryEntry[] | Default<[]>>>;
  published?: PerSpace<Writable<Published | null | Default<null>>>;
  pseudonym?: PerSpace<Writable<string | Default<"">>>;
  pool?: PoolTarget;
  hifiModel?: PerSpace<Writable<string | Default<"">>>;
  rewriteAfter?: PerSpace<Writable<number | Default<3>>>;
  heldOutPercent?: PerSpace<Writable<number | Default<30>>>;
  rewriteAttempt?: PerSpace<Writable<number | Default<0>>>;
  adopted?: PerSpace<Writable<string[] | Default<[]>>>;
}
```

### Output Schema

```ts
interface LofiInductorOutput {
  goal: string;
  items: Item[];
  rules: CanonicalRule[];
  history: HistoryEntry[];
  published: Published | null;
  pseudonym: string;
  adopted: string[];
  hifiModel: string;
  rewriteAfter: number;
  heldOutPercent: number;
  rows: ItemRow[];
  summary: Summary;
  heldOutF1: number;
  rewrite: RewriteStatus;
  poolOffer: PoolOffer | null;
  setGoal: Stream<GoalEvent>;
  addItem: Stream<SubmittedItem>;
  addItems: Stream<SubmittedItems>;
  removeItem: Stream<ItemRef>;
  removeRule: Stream<RuleRef>;
  resetRules: Stream<void>;
  settleRewrite: Stream<void>;
  retryRewrite: Stream<void>;
  setRewriteAfter: Stream<RewriteAfterEvent>;
  setHeldOutPercent: Stream<HeldOutPercentEvent>;
  setHifiModel: Stream<HifiModelEvent>;
  settlePoolOffer: Stream<void>;
  publish: Stream<void>;
  unpublish: Stream<void>;
}
```

## `showcase/inductor/pool/main.tsx`

Lo-fi rule sets for one goal, contributed under per-goal pseudonyms and
confidential to the pool's own CFC policy (`pool-policy.tsx`). A rule and its
count become public only once enough distinct contributors hold the same
canonical rule; each rule's threshold is a sealed, configurable centre (at
least 5) plus a secret per-rule offset. The one release path is the trusted
`releaseConsensus` lift, witnessed by the pool's own writer. Not yet working end
to end: a public store currently refuses even the genuine release (top/3226),
and the label on what inductors send holds only in part (top/3175); see
`showcase/inductor/pool/README.md`.

**Keywords:** threshold release, k-anonymity, consensus, pseudonym, declassify,
exchange rule, TransformedBy, CFC

### Input Schema

```ts
interface InductorPoolInput {
  goal: Default<string, "">;
  thresholdCenter: Default<number, typeof DEFAULT_THRESHOLD_CENTER>;
  jitter: Default<number, typeof DEFAULT_JITTER>;
  contributions: Writable<Default<StoredContribution[], []>>;
}
```

### Output Schema

```ts
interface InductorPoolOutput {
  goal: string;
  thresholdCenter: number;
  jitter: number;
  contributions: StoredContribution[];
  consensus: ReleasedRule[];
  releasedCount: number;
  submit: Stream<ContributionEvent>;
  withdraw: Stream<void>;
}
```

---

# Detail Views

These patterns are used with `navigateTo()` from their parent patterns and can
also work standalone.

## `apps/calendar/event-detail.tsx`

Detail/edit view for a single calendar event.

**Keywords:** event, detail, edit, form, navigateTo

### Input Schema

```ts
interface EventDetailInput {
  title?: Writable<string | Default<"">>;
  date?: Writable<string | Default<"">>;
  time?: Writable<string | Default<"">>;
  notes?: Writable<string | Default<"">>;
}
```

### Output Schema

```ts
interface EventDetailOutput {
  title: string;
  date: string;
  time: string;
  notes: string;
  setTitle: Stream<{ title: string }>;
  setDate: Stream<{ date: string }>;
  setTime: Stream<{ time: string }>;
  setNotes: Stream<{ notes: string }>;
}
```

## `apps/contacts/contact-detail.tsx`

Detail/edit view for a single contact. Use with `navigateTo()` from
`apps/contacts/main.tsx` or as a standalone contact editor.

**Keywords:** contact, detail, edit, form, navigateTo

### Input Schema

```ts
interface Contact {
  name: string;
  email: string | Default<"">;
  phone: string | Default<"">;
  company: string | Default<"">;
  tags: string[] | Default<[]>;
  notes: string | Default<"">;
  createdAt: number;
}

interface ContactDetailInput {
  contact: Writable<Contact>;
}
```

### Output Schema

```ts
interface ContactDetailOutput {
  contact: Contact;
}
```

## `examples/reading-list/reading-item-detail.tsx`

Detail/edit view for a single reading list item. Use with `navigateTo()` from
reading-list or as a standalone item editor.

**Keywords:** reading, book, article, detail, edit, form, navigateTo

### Input Schema

```ts
type ItemType = "book" | "article" | "paper" | "video";
type ItemStatus = "want" | "reading" | "finished" | "abandoned";

interface ReadingItemDetailInput {
  title?: Writable<string | Default<"">>;
  author?: Writable<string | Default<"">>;
  url?: Writable<string | Default<"">>;
  type?: Writable<ItemType | Default<"article">>;
  status?: Writable<ItemStatus | Default<"want">>;
  rating?: Writable<number | null | Default<null>>;
  notes?: Writable<string | Default<"">>;
  addedAt?: number | Default<0>;
  finishedAt?: number | null | Default<null>;
}
```

### Output Schema

```ts
interface ReadingItemDetailOutput {
  title: string;
  author: string;
  url: string;
  type: ItemType;
  status: ItemStatus;
  rating: number | null;
  notes: string;
  addedAt: number;
  finishedAt: number | null;
  setStatus: Stream<{ status: ItemStatus }>;
  setRating: Stream<{ rating: number | null }>;
  setNotes: Stream<{ notes: string }>;
}
```

---

# Suggestable Patterns

Lightweight, LLM-powered utility patterns designed as building blocks for the
suggestion system (`system/suggestion/suggestion.tsx`). Each takes `topic` and
`context` inputs and produces a focused output.

## `examples/suggestable/summary.tsx`

Generates a concise summary of provided context using an LLM. The topic is what
asks for the summary: with none given the pattern holds the request back, so
`pending` stays `false` and `summary` stays empty until a caller names a
subject.

**Keywords:** summary, generateText, suggestion-fuel

### Input Schema

```ts
type SummaryInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};
```

### Output Schema

```ts
type SummaryOutput = {
  topic: string;
  summary: string;
  pending: boolean;
};
```

## `examples/suggestable/checklist.tsx`

Generates a checklist of actionable steps from a topic and context. The topic is
what asks for the steps: with none given the pattern holds the request back, so
`pending` stays `false` and `items` stays empty until a caller names a subject.

**Keywords:** checklist, generateObject, suggestion-fuel

### Input Schema

```ts
type ChecklistInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};
```

### Output Schema

```ts
type ChecklistItem = {
  label: string;
  done: boolean | Default<false>;
};

type ChecklistOutput = {
  topic: string;
  items: ChecklistItem[];
  pending: boolean;
};
```

## `examples/suggestable/question.tsx`

Generates a clarifying question with optional multiple-choice options. The topic
is what asks for the question: with none given the pattern holds the request
back, so `pending` stays `false` and both `question` and `options` stay empty
until a caller names a subject.

**Keywords:** question, generateObject, suggestion-fuel

### Input Schema

```ts
type QuestionInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};
```

### Output Schema

```ts
type QuestionOutput = {
  topic: string;
  question: string;
  options: string[];
  answer: Writable<string>;
  pending: boolean;
};
```

## `examples/suggestable/diagram.tsx`

Generates an ASCII diagram illustrating relationships, flows, or structures.
Rendered in a `<pre>` tag with monospace styling. The topic is what asks for the
diagram: with none given the pattern holds the request back, so `pending` stays
`false` and `diagram` stays empty until a caller names a subject.

**Keywords:** diagram, ASCII, generateText, suggestion-fuel

### Input Schema

```ts
type DiagramInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};
```

### Output Schema

```ts
type DiagramOutput = {
  topic: string;
  diagram: string;
  pending: boolean;
};
```

## `examples/suggestable/svg-diagram.tsx`

Generates an SVG diagram illustrating relationships, flows, or structures.
Rendered via `<cf-svg>` web component for scalable vector output. The topic is
what asks for the diagram: with none given the pattern holds the request back,
so `pending` stays `false` and `diagram` stays empty until a caller names a
subject.

**Keywords:** diagram, SVG, generateText, suggestion-fuel, cf-svg

### Input Schema

```ts
type SvgDiagramInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};
```

### Output Schema

```ts
type SvgDiagramOutput = {
  topic: string;
  diagram: string;
  pending: boolean;
};
```

## `examples/suggestable/budget-planner.tsx`

Generates a budget breakdown with editable amounts for each category. The LLM
suggests spending categories that sum to the given budget ceiling. The topic is
what asks for the breakdown: with none given the pattern holds the request back
and shows an empty budget, so building one costs nothing until a caller says
what the money is for.

**Keywords:** budget, generateObject, suggestion-fuel

### Input Schema

```ts
type BudgetInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
  maxAmount?: number | Default<1000>;
};
```

### Output Schema

```ts
type BudgetItem = {
  name: string;
  amount: number | Default<0>;
};

type BudgetOutput = {
  topic: string;
  items: BudgetItem[];
  total: number;
  remaining: number;
  pending: boolean;
};
```

## `examples/suggestable/people-list.tsx`

Displays people from local data using the wish system.

**Keywords:** people, wish, suggestion-fuel

### Input Schema

```ts
type PersonListInput = Record<string, never>;
```

### Output Schema

```ts
type Person = {
  contact: {
    name: string;
    email: string | Default<"">;
  };
};

type PersonListOutput = {
  people: Person[];
};
```

## `examples/suggestable/event-list.tsx`

Displays events from local data using the wish system.

**Keywords:** events, wish, suggestion-fuel

### Input Schema

```ts
type EventListInput = Record<string, never>;
```

### Output Schema

```ts
type Event = {
  title: string;
  date: string;
  time: string;
  notes: string;
};

type EventListOutput = {
  events: Event[];
};
```

---

# System Patterns

## `system/favorites-manager/favorites-manager.tsx`

View and manage favorited pieces with tags. Uses the wish system to query
`#favorites` and allows removing items.

**Keywords:** favorites, wish, cf-cell-link

### Input Schema

```ts
type Input = Record<string, never>;
```

### Output Schema

```ts
// Uses wish<Array<Favorite>>({ query: "#favorites" }) internally
// Displays favorited pieces with remove functionality
```

## `system/piece-grid/piece-grid.tsx`

A thumbnail tile grid view for pieces with scaled-down cf-render previews.

**Keywords:** grid, pieces, thumbnail, preview, cf-render

### Input Schema

```ts
type Input = {
  pieces: Piece[];
};
```

### Output Schema

```ts
// Returns a 3-column grid view of pieces with live previews
```

## `apps/bookmarks/main.tsx`

A pattern for collecting and browsing URLs/bookmarks. Users can add URLs to a
collection, view them in a searchable grid with rich link previews (via
cf-link-preview), and remove bookmarks. Designed to feed into the summary
system.

**Keywords:** bookmarks, links, collection, urls, grid, preview, search,
cf-link-preview, cf-grid

### Input Schema

```ts
interface Bookmark {
  url: string;
  title: string | Default<"">;
  description: string | Default<"">;
}

interface BookmarksInput {
  bookmarks?: Writable<Bookmark[] | Default<[]>>;
}
```

### Output Schema

```ts
interface BookmarksOutput {
  bookmarks: Bookmark[];
  count: number;
}
```

## `examples/link-preview/main.tsx`

A simple pattern that renders a rich link preview for a single URL. Uses
cf-input for URL entry and cf-link-preview to display the preview card with
metadata and screenshot.

**Keywords:** link, preview, url, cf-link-preview, cf-input

### Input Schema

```ts
interface LinkPreviewInput {
  url?: string | Default<"https://github.com">;
}
```

### Output Schema

```ts
interface LinkPreviewOutput {
  [NAME]: string;
  [UI]: VNode;
  url: string;
}
```

---

## `examples/cfc-row-label-mailbox/cfc-row-label-mailbox.tsx`

Demo of CFC Phase 3 per-row, data-derived SQLite labels: each email row's
confidentiality is computed from the row's own columns (sender ∧ regex-split
recipients ∧ the db owner), with claimed-authored-by integrity gated on the
row's dmarc evidence. Shows the declared output ceiling with onExceed:"skip" (a
skim view that drops rows the ceiling does not admit), the fail-closed COUNT(*)
refusal, and the db.exec write gate (a draft without a sender is rejected by the
rule's min anchor).

**Keywords:** cfc, sqlite, per-row, label, confidentiality, integrity, rowLabel,
cfSqlite, ceiling, maxConfidentiality, onExceed, mailbox, email

### Input Schema

```ts
interface MailboxInput {
  draftFrom: PerSession<Writable<string | Default<"">>>;
  draftTo: PerSession<Writable<string | Default<"">>>;
  draftBody: PerSession<Writable<string | Default<"">>>;
}
```

### Output Schema

```ts
interface MailboxOutput {
  [NAME]: string;
  [UI]: VNode;
  seed: Stream<void>;
}
```

---

## `examples/cfc-row-label-records/cfc-row-label-records.tsx`

Demo of per-row (Phase 3) and per-column (Phase 2) CFC labels COMPOSING on one
row entity: a patient-records table whose row rule derives the patient from the
row's own data while the ssn column carries a static "pii" label. The same rows
flow as a diagnosis projection under a declared ceiling but are REFUSED as an
ssn projection (the per-column pii label exceeds the ceiling) — fail-closed
composition of both label sources.

**Keywords:** cfc, sqlite, per-row, per-column, ifc, pii, label, composition,
ceiling, maxConfidentiality, fail-closed, records

### Input Schema

```ts
type RecordsInput = Record<string, never>;
```

### Output Schema

```ts
interface RecordsOutput {
  [NAME]: string;
  [UI]: VNode;
  seed: Stream<void>;
}
```
