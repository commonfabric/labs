# Common Patterns

Prefix the URLs with
`https://raw.githubusercontent.com/commonfabric/labs/refs/heads/main/packages/patterns/`

---

# Status tiers

This directory mixes exemplars, capability demos, regression fixtures, and
legacy experiments. They do NOT carry equal authority. Before imitating any
pattern, check its tier:

- **primitive** — designed for embedding in other patterns (used as a JSX tag),
  headless-able. Exposes streams + cells + an optional default `[UI]`. Copy
  these idioms when building composable building blocks. See
  `docs/common/patterns/primitives.md` for the composition contract.
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
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
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
(headless-able). Live under `primitives/`. See
`docs/common/patterns/primitives.md` for the composition contract and the
adopter-first entry bar.

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
for; `packages/cf-harness/test/primitives-connector-reads.test.ts` states what
only an injected handle can. The first two carry the two tombstone conventions a
connector store uses — the integer `deleted = 0` flag on a connector ledger,
`deleted_at IS NULL` on the mail store — which is the thing a session reading
one of these databases has no other way to learn. `source-row-count.tsx` reports
a table's row count beside the count its predicate admits, from one aggregate
statement, so the two numbers say whether a predicate matched nothing or the
table holds nothing.

Their adopter is the pattern index: they are published to it as composable
parts, and their descriptions are derived from their doc comments by
`packages/cf-harness/scripts/seed-pattern-index.ts`. So the first paragraph of
each doc comment is what a search ranks on, and it has to describe what the code
does rather than what the atom is for.

The earlier candidate (`EditableList`) was built, proven against real callers
both headless and rendered, and retired under the kill criterion — no caller
benefited (see the contract doc's "Lessons" section).

## exemplar

`catalog/` (type-checked component catalog + `catalog/stories/`), `counter/`,
`do-list/`, `fair-share/`, `form-demo.tsx`, `notes/`, `reading-list/` (canonical
list-detail example), `simple-list/`, `todo-list/`.

## demo

Capability and app demos (root files): `annotation.tsx`,
`annotation-manager.tsx`, `aside.tsx`, `bookmarks.tsx`, `chatbot.tsx`,
`cheeseboard.tsx`, `compiler.tsx`, `deep-research.tsx`, `dice.tsx` (+
`dice-handlers.ts`), `group-chat-lobby.tsx`, `group-chat-room.tsx`, `image.tsx`,
`image-analysis.tsx`, `link-preview.tsx`, `map-demo.tsx`, `mobile-app-demo.tsx`,
`pattern-index.tsx`, `profile-roster-live-demo.tsx` (demo: live multi-user
profile roster — every participant's cross-space profile badge), `self.tsx`,
`self-improving-classifier.tsx`, `shopping-list.tsx`, `store-mapper.tsx`,
`text-swapper.tsx`.

App and integration directories: `activity-log/`, `agent/`, `base/`,
`battleship/`, `budget-tracker/`, `calendar/`, `card-piles/`,
`collection-naming/` (the member-naming library and the board that exercises it;
the library is the reference, the board is a demo), `contacts/`, `cozy-poll/`,
`examples/`, `experimental/` (explicitly unhardened explorations), `file-share/`
(a minimal file-sharing example: bytes go to the blob store, cells hold
descriptors), `habit-tracker/`, `lobby/`, `lunch-poll/`, `profile-group-chat/`,
`project-list/`, `router/`, `scoped-group-chat/`, `scoped-user-directory/`,
`scrabble/`, `shared-profile-demo/`, `shared-profile-roster/`, `suggestable/`,
`weekly-calendar/`.

Connector-owned patterns live with their connector families: the
[agent debug view](../connectors/agents/debug-view/README.md) and
[GitHub activity view](../connectors/github/activity-view/README.md).

CFC spec demos (intentionally verbose wiring): `cfc/`,
`cfc-agent-prompt-injection-demo/`, `cfc-authorized-save/`,
`cfc-exchange-rules/`, `cfc-authorship-chat/`, `cfc-group-chat-demo/`,
`cfc-render-policy-demo/`, `cfc-row-label-mailbox/`, `cfc-row-label-records/`,
`cfc-spec-gallery/`, `cfc-staged-publish/`, `cfc-trusted-component-examples/`,
`cfc-trusted-surfaces/`.

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

- `factory-outputs/` and its support file `vehicles.ts` — machine-generated
  pattern-factory outputs, kept with their eval scores and never intended as
  style references. `parking-coordinator/main.tsx` is also a live integration
  and capability-gate fixture, which is why it stays.

The registry/`MODULE_METADATA` composition system — `record/`, `record.tsx`, its
backup and icon companions, `container-protocol.ts`, and the two dozen attribute
modules that existed only to register with it — has been removed. It was a
parallel composition system with no callers outside itself. Compose patterns
directly as JSX tags plus `wish` discovery instead;
`docs/common/patterns/composition.md` covers how.

Support files with no tier (not patterns): `deno.jsonc`, `mod.ts`, `index.md`,
`README.md`, `DEPRECATED_IDIOMS.md`, `test/vnode-helpers.ts` (the shared
rendered-tree helpers for pattern tests), `tools/` (codegen tooling). The
December 2025 bug survey formerly kept here as `PREEXISTING_BUGS.md` is archived
at `docs/history/packages/patterns/PREEXISTING_BUGS.md`.

---

## `annotation.tsx`

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

## `topics/main.tsx`

**Topics — a multi-user tracker over #topic pieces** (durable units of shared
attention; CT-1878): title, living body document, flat chronological comment
thread, typed links out. Deliberately minimal — no statuses, labels, or
assignees. The board publishes a bounded discovery index — the topics
themselves, declared through a narrow row schema of summary scalars, so a row's
address IS its topic's and a survey and the follow-up read name one document.
`addTopic` returns the piece it created, so a caller addresses a new topic
straight from the create. The board owns a member namespace through
`collection-naming/naming.ts`: `addTopic` allocates the next decimal number and
passes it into the topic it creates, in the same transaction as the append; each
topic stores that number and publishes it as `shortName`, reading nothing of its
board to report it; and `backfillNames` numbers what the board held before it
numbered anything, asking each such topic to store its number through the
topic's own `recordName`. No topic's number is SHOWN for now:
`SHOW_TOPIC_NUMBERS` in `topic.tsx` is off while only some topics have one, so a
topic publishes no `shortName` and every surface that would show one reads
nothing; the numbers are stored and recorded either way. Topics reference each
other by CELL: the board derives the whole graph once by scanning what each
topic points at with `equals`, and each topic reads its own inbound edges out of
that pivot. Demonstrates: reading-list-style piece-in-list composition,
profile-native browser authorship on a shared piece, mergeable comment appends,
session-scoped drafts, bounding a whole-list derivation with a narrow declared
`lift` parameter, passing topics through a sort so an activity-ordered list
keeps the identity its elements already have, `multiUserTest` coverage.

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
// TopicInput additionally takes the two wirings addTopic gives a child —
// mentionable (the @-mention universe for the body editor) and boardCrossrefs
// (the reference pivot) — plus shortName, the number the create allocated,
// which the topic stores and reports.
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
  // { topic, mentionedBy } per topic — the reference graph, derived once here
  crossrefs: TopicCrossrefRow[];
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

## `topics/topic.tsx`

A single #topic piece: the durable object the tracker's list holds. Body edits
go through an explicit Edit→Save toggle (one whole-value `set` per save keeps
the concurrent-edit window small); comments and links are mergeable appends.
Stores the number its board calls it by as its own input, and publishes it as
`shortName` while `SHOW_TOPIC_NUMBERS` is on, rendering it as a badge beside the
title; the constant is off for now, so a topic stores its number and shows none.
A topic nobody has numbered stores none either way. `recordName` is how a number
reaches a topic the board did not pass one to at create. Use from
`topics/main.tsx` via `navigateTo()`, or standalone.

**Keywords:** topic, detail, thread, comment, links, body, navigateTo,
shortName, member name, badge

---

## `agent/agent.tsx`

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

## `counter/counter.tsx`

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

## `do-list/do-list.tsx`

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

## `todo-list/todo-list.tsx`

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

## `simple-list/simple-list.tsx`

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

## `shopping-list.tsx`

Shopping list with AI-powered aisle sorting. Pair with `store-mapper.tsx` for
store-specific layouts.

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

## `notes/note.tsx`

A note with wiki-links, backlinks, and embedding support. Managed by
`notes/notebook.tsx`.

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

## `notes/notebook.tsx`

Notebook pattern managing notes and nested notebooks. Creates and organizes
`notes/note.tsx` pieces.

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

## `notes/voice-note.tsx`

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

## `calendar/calendar.tsx`

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

## `weekly-calendar/weekly-calendar.tsx`

Weekly calendar with drag-and-drop event creation and resizing. Manages
`weekly-calendar/event.tsx` pieces.

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

## `contacts/contact-book.tsx`

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

## `habit-tracker/habit-tracker.tsx`

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

## `reading-list/reading-list.tsx`

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

## `budget-tracker/main.tsx`

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

## `fair-share/main.tsx`

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

## `collaborative-note/main.tsx`

A minimal multiplayer note built on `cf-code-editor`. The note body is durable
per-space state synchronized through Memory's operation protocol. Names, carets,
and selections travel separately as ephemeral co-presence data. Each viewer
selects or creates a Fabric profile with `wish({ query: "#profile" })`; the
editor uses that profile's `#profileName` field as its participant label. The
host provides the WebSocket endpoint, while `cf-code-editor` derives an opaque
room identifier from the shared note field.

**Keywords:** multiplayer, collaborative editor, note, profile, wish,
co-presence, CodeMirror

### Input Schema

```ts
interface CollaborativeNoteInput {
  note?: PerSpace<
    string | Default<"# Collaborative note\n\nStart writing together.">
  >;
}
```

### Output Schema

```ts
interface CollaborativeNoteOutput {
  note: PerSpace<
    string | Default<"# Collaborative note\n\nStart writing together.">
  >;
  participantName: string;
}
```

## `cfc-agent-prompt-injection-demo/main.tsx`

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

## `chatbot.tsx`

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

## `group-chat-lobby.tsx`

Multiplayer group chat lobby where users join with their shared profile
(`wish({ query: "#profile" })` — the wish UI covers profile create/pick) and
enter a shared chat room. Uses `navigateTo()` to transition into
`group-chat-room.tsx`.

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

## `lobby/main.tsx`

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

## `store-mapper.tsx`

Capture grocery store layouts through manual aisle entry, perimeter department
positioning, and item location corrections. Generates layout data used by
`shopping-list.tsx` for AI-powered aisle sorting.

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

## `image.tsx`

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

## `deep-research.tsx`

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

## `image-analysis.tsx`

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

## `examples/clock.tsx`

Example pattern: a live wall clock driven by the reactive `#now` wish
(`wish({ query: "#now/1" })`, ticking once per second). Shows the sanctioned way
to read time in reactive code — the capability gate forbids `Date.now()` /
`new Date()` in a lift/computed/pattern-body — plus the `null`-until-resolved
load-window guard. `new Date(ms)` with an explicit argument stays fine for
formatting.

**Keywords:** now, wish, clock, time, reactive, capability-gate, timing

## `examples/reactive-now.tsx`

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

## `examples/profile-aware-writer.tsx`

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

---

# Detail Views

These patterns are used with `navigateTo()` from their parent patterns and can
also work standalone.

## `calendar/event-detail.tsx`

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

## `contacts/contact-detail.tsx`

Detail/edit view for a single contact. Use with `navigateTo()` from contact-book
or as a standalone contact editor.

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

## `reading-list/reading-item-detail.tsx`

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
suggestion system (`system/suggestion.tsx`). Each takes `topic` and `context`
inputs and produces a focused output.

## `suggestable/summary.tsx`

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

## `suggestable/checklist.tsx`

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

## `suggestable/question.tsx`

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

## `suggestable/diagram.tsx`

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

## `suggestable/svg-diagram.tsx`

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

## `suggestable/budget-planner.tsx`

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

## `suggestable/people-list.tsx`

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

## `suggestable/event-list.tsx`

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

## `system/favorites-manager.tsx`

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

## `system/piece-grid.tsx`

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

## `bookmarks.tsx`

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

## `link-preview.tsx`

A simple pattern that renders a rich link preview for a single URL. Uses
cf-input for URL entry and cf-link-preview to display the preview card with
metadata and screenshot.

**Keywords:** link, preview, url, cf-link-preview, cf-input

### Input Schema

```ts
interface LinkPreviewInput {
  url: string | Default<"https://github.com">;
}
```

### Output Schema

```ts
interface LinkPreviewInput {
  url: string;
}
```

---

## `cfc-row-label-mailbox/main.tsx`

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

## `cfc-row-label-records/main.tsx`

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
