---
name: pattern-dev
description: Guide for developing Common Fabric patterns (TypeScript modules that define reactive data transformations with UI). Use this skill when creating patterns, modifying existing patterns, or working with the pattern framework. Triggers include requests like "build a pattern", "fix this pattern error", "deploy this piece", or questions about handlers and reactive patterns.
---

Start with the shared pattern development guidance in:

- `docs/common/ai/pattern-development-guide.md`

Read that guide first. It is the canonical reference.

For new or changed behavior, completion includes the whole source lifecycle:
write automated pattern tests, run every test entry with `cf test`, and attach
every entry with repeatable `--test` flags on `piece new` and every later
`piece setsrc`. Manual browser or CLI verification does not replace the
automated tests. Deployment packages and type-checks attached tests but does not
run them. A file the pattern ships with that is not code — a fixture, a lookup
table — is read with `dataFile(path)` from `commonfabric` and stored verbatim
rather than compiled. The path resolves against the module that reads it, as an
import specifier does, so `./data/cities.json` is the file beside the pattern.
That call is the whole declaration: store the file where the call points, and
every command that builds the pattern attaches it, so a pattern that reads one
is checkable, testable, and deployable with no extra flag. `--datafile` remains
for a file the source cannot name, such as one read by a computed path.

Also read the foundational reactivity references before implementing or
debugging pattern state:

- `docs/common/concepts/reactivity.md`
- `docs/common/patterns/new-cells.md`

These are required context for Common Fabric pattern work. TypeScript surface
types can look like plain values even when runtime values are reactive cells.

Decide each state field's sharing boundary before building the UI:

- `PerSpace<T>`: shared durable state for everyone in the space.
- `PerUser<T>`: state that follows one authenticated user across sessions.
- `PerSession<T>`: ephemeral state for one session, such as navigation, selected
  tab, selected room, selected item, local filter text, open modal, or focused
  item.

Default transient UI state to `PerSession<>` unless it intentionally needs to
persist for the user across sessions. A useful test: if the user opens the same
instance in a new tab, should this state carry over? If not, it is probably
`PerSession<>`. Multi-user patterns make this boundary especially important, but
the rule is about state lifetime, not only collaboration. Do not store user ids
or session ids in ordinary data to simulate isolation; use scope wrappers on the
relevant input and output types.

A handler the server runs reads each space with its owner's access, so access is
never why it misses what its user can read. What it can't reach is someone
else's scoped instance, or a `PerUser` or `PerSession` instance in another
space; `docs/common/patterns/multi-user-patterns.md`, "Scoped State In A Served
Run", has the rule.

Two common scoped authoring styles are useful:

```ts
// Plain-input style: public API looks like ordinary data.
interface ChatInput {
  conversation?: PerSpace<Conversation | Default<typeof DEFAULT_CONVERSATION>>;
  name?: PerUser<string | Default<"">>;
  selectedRoom?: PerSession<SelectedRoom | Default<EmptySelectedRoom>>;
}

// Writable-input style: handlers need stable writable cell handles.
type NameCell = Writable<string | Default<"">>;
type SelectedRoomCell = Writable<SelectedRoom | Default<EmptySelectedRoom>>;

interface ChatInputWithCells {
  name?: PerUser<NameCell>;
  selectedRoom?: PerSession<SelectedRoomCell>;
  conversation?: PerSpace<Writable<Conversation>>;
}
```

Use the plain-input style when the pattern API should stay data-shaped. Use the
writable-input style when handlers need `.key(...)`, `.equals(...)`, or stable
cell bindings, especially in mutation-heavy multi-user UI.

For local cells that should not become public pattern inputs, use scoped cell
constructors:

```ts
const sharedBoard = new Writable.perSpace(DEFAULT_BOARD);
const displayName = new Writable.perUser("");
const selectedItem = new Writable.perSession<string | null>(null);
```

Plain `new Writable(...)` inherits the containing pattern or factory scope. Use
`new Writable.perUser(...)` or `new Writable.perSession(...)` when the local
cell must have a specific sharing boundary independent of that context.

`PerAny<T>` is rare. Use it only when an inner value must override an outer
scope declaration and may validly come from any concrete scope:

```ts
type Selection = PerSession<{
  item: PerUser<Item>;
  attachment: PerAny<Attachment>;
}>;
```

Prefer `PerSpace<>`, `PerUser<>`, or `PerSession<>` whenever the inner value's
scope is known. Do not directly stack scope wrappers on the same value, such as
`PerUser<PerSession<T>>`; put the inner scoped declaration on the field or cell
that actually has that scope.

**Identity (multi-user):** Scope decides _where_ state lives; identity decides
_who_ it belongs to. Resolve the viewer via `wish({ query: "#profile" })` (never
a typed-name field), store each participant's live `#profile` cell in the shared
`PerSpace` roster on join, render **every** participant with `cf-profile-badge`
bound to that cell (`cf-avatar` + snapshot only as an offline fallback), and
identify people by `equals()` on a cell reference, not display name. See
`docs/common/patterns/multi-user-patterns.md#presenting-identity` and
`docs/common/components/COMPONENTS.md#identity-components`.

When working in a Pattern Factory Build workspace, also read:

- `docs/common/ai/pattern-factory-build-guide.md`

That guide defines the top-level build contract, verification posture, and
documentation discipline for Pattern Factory runs.

When you're unsure whether a reactive expression site lowers the way you expect,
inspect the emitted source directly with:

- `deno task cf check <pattern>.tsx --show-transformed`

Also inspect the emitted source when a composed pattern result is assigned to a
`PerUser<>` or `PerSession<>` typed variable or output. Contextual scope types
should lower into the factory call; if they do not, the pattern may instantiate
state at the wrong sharing boundary.

Prefer direct authored expressions, including plain ternaries, first; if a
conditional site behaves unexpectedly or seems ambiguous, inspect the emitted
source with `--show-transformed` rather than guessing.

Pay special attention to the SES authoring section of
`docs/common/ai/pattern-development-guide.md` before adding module-scope setup,
timers, or reads of the clock or entropy. Authors call `Date.now()` (or
`new Date()`) and `Math.random()` directly — they are built-ins, nothing to
import. Inside the sandbox these are gated: allowed only in a handler (the clock
coarsened to one-second resolution), and throwing in a lift, computed, or the
pattern body. To read a live clock in a computed, use the reactive `#now` wish.
Also follow its binding guidance: when a control is already bound to a cell,
usually via `$value` or `$checked`, do not add a handler that simply writes the
same value back into that same cell.

A display cap bounds the render, not the transaction. The number that decides
what an interaction costs is how many rows a query returned, not how many are on
screen: a pane showing six of 150 returned messages pays for the 150, and the
same pane showing 38 of 52 is faster than it. Nothing at authoring time says so
— a `slice(0, LIMIT)` in the render reads as if it bounded the work — so hold
down what the statement returns (a `LIMIT`, a narrower predicate) rather than
what the list shows. The worked measurement is
`docs/history/development/performance/2026-09-11-person-inbox-click-cost.md`.

The other half of the same point: an interaction dispatched before the runtime
has settled the previous one is not free. Clicking through a list faster than it
settles used to leave every later interaction slower for the rest of that
session; that specific cause is fixed, but a UI that fires writes faster than
the graph converges is still paying queueing it does not have to. Where a
control can be held during settle, hold it.

Hiding a list's rows does not make them cheap. `list.map(...)` instantiates what
its callback builds once per element whether or not anything shows it: a row
hidden by a `display` prop still has its nodes planned on every load, its
documents written on the first run, and those documents delivered on every
reload. A second `.map` over the same list — a thread panel, a detail pane, a
tab most sessions never open — is therefore a second full set of instances, and
hiding it removes none of that cost. Nothing at authoring time says so, because
the two calls read as two views of one list. Map a list that holds only what the
view shows. Where what it shows is chosen per session or per user, make that
list a computed of that scope, such as `computed((): PerSession<Item[]> => …)`:
`map` stores its result, and the instances it starts, at the scope of the list
it maps, so each session holds its own rows and no viewer's choice replaces
another's. A `display` prop stays the tool for a part of one row that differs by
viewer. The worked case is `threadMessages` in
`packages/patterns/fabrichat/room.tsx`: mapping the open thread's messages in
place of every message took a load of a thirty-message room from sixty row
instances to thirty, and its first run from committing two row trees to one.

A mapped child that derives its own facts from the list it is an element of
reads the whole list once per element. A row usually holds the list cell
already, because its handlers need it, and nothing at authoring time says that a
`computed()` reading it in the row differs from one reading it in the parent. It
does: each row's computation scans every element, so the work of a load grows
with the square of the list, and a change to one element re-runs the scan in
every row. Derive what is true of the list as a whole once, in the pattern that
maps it, as a record keyed by element, and give each child that record as a
cell: `ReadonlyCell<Record<string, T>>`, read as `facts.key(ownKey).get()`. A
computation that keys the cell that way reads one entry when it runs and re-runs
when that entry changes; the same record taken as a plain value is read whole by
every child. The key exists only at run time, so the transformer cannot declare
which entry that is: `--show-transformed` shows the record's whole schema on
that `lift`, as a cell, and no `completeSchedulerScopeSummary`. What narrows is
the read the run makes, and the read-cost report of
`cf test <file> --verbose --stats-threshold 0` counts it per step.
`packages/patterns/fabrichat/room.tsx` derives `places` this way and
`packages/patterns/fabrichat/message-row.tsx` reads its own.

How much of a value a `computed()` reads depends on what the value passes
through, and a function imported from another module is where the transformer
stops following it. A value handed to an imported helper is read whole:
`summarize(items)` reads every field of every item, where
`summarize(items.map(({ id, parent }) => ({ id, parent })))` reads two. A cell
handed to one is charged what the helper's parameter type declares, and
`Writable<T>` declares a write, through an alias such as
`type ItemsCell = Writable<Item[]>` as much as written out. The computation is
then scheduled as a writer of that cell: every reader of the cell is ordered
after it, and several such computations over one list order against each other
in a cycle. A helper that only reads takes `Cell<T>` or `ReadonlyCell<T>`.
`deno task cf check <pattern>.tsx --show-transformed` shows both: the size of
the schema each `lift` was given, and a `materializerWriteInputPaths` entry on
one the scheduler treats as a writer. "Imported capability contracts" in
`docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md` is the
rule.

Runtime notes:

- Use the `cf` skill, or read `skills/cf/SKILL.md`, when you need CLI command
  details.
- If your runtime supports delegation, pass file paths rather than pasted
  summaries.

## Runtime-Specific Notes

### Claude Code

Interactive labs sessions only. In a Pattern Factory workspace, the factory
orchestrator owns delegation, critique, and finalization — do not Task these
subagents, run a separate critic pass, or offer commits there.

- Use `EnterPlanMode` before building.
- Scale the plan to the problem:
  - simple pattern: 2-3 sentences
  - medium pattern: short list
  - complex pattern: structured plan with entities, relationships, and actions
- Delegate by role when that helps:

```text
Task({
  prompt: "Implement [feature]. Keep it simple, one file.",
  subagent_type: "pattern-maker"
})

Task({
  prompt: "Run every authored test, then deploy [pattern] with each test attached.",
  subagent_type: "pattern-user"
})

Task({
  prompt: "Review [file] for violations.",
  subagent_type: "pattern-critic"
})
```

- Run a critic pass before first deploy unless the change is a tiny, low-risk
  fix.
- At useful milestones, offer a commit.

### Other runtimes

- Preserve the same rhythm even when the invocation syntax differs:
  - plan first
  - keep the first slice runnable
  - separate implementation, runtime testing, and critique when the task is
    large enough to justify it

Phase skills consult as needed:

- Pattern Factory Build: `docs/common/ai/pattern-factory-build-guide.md`
- Reactivity and local cells: `docs/common/concepts/reactivity.md`,
  `docs/common/patterns/new-cells.md`
- Types: `docs/common/concepts/types-and-schemas/`
- Actions/handlers: `docs/common/concepts/action.md`,
  `docs/common/concepts/handler.md`
- Testing: `docs/common/workflows/pattern-testing.md`
- Existing patterns: `packages/patterns/index.md` — check the "Status tiers"
  section before copying idioms from any pattern; only `exemplar` entries are
  style references.
- Components: `packages/patterns/catalog/catalog.tsx` — the authoritative,
  type-checked component catalog. Story files in
  `packages/patterns/catalog/stories/` show live usage for each component. Also
  see `docs/common/components/COMPONENTS.md` for narrative docs.
- Debugging: start with `docs/development/debugging/README.md`, then follow the
  linked gotcha or workflow doc for the exact failure.
