# Common Fabric Documentation

Documentation for building **patterns** — reactive TypeScript programs that run
on the Common Fabric runtime.

## Mental Model

- A pattern is a `.tsx` file (may import other `.tsx` files) that exports a
  component built from reactive `Cell`s. Cells live in `Space`s (identified by
  a DID) and enable durable communication between patterns.
- Unlike React, a pattern body runs **once** to define a reactive graph; it is
  not re-invoked on every change (closest analogy: Solid.js signal networks).
  Use `computed()`/`lift()` for derived values and `action()`/`handler()` for
  events. Reactivity comes from subscribing to queries defined by schemas/type
  signatures.
- A pattern returns a result cell containing `[UI]` (JSX rendered with the
  `cf-*` components from `packages/ui`) plus any named key-value outputs. A
  running, instantiated pattern is called a **piece**.
- Patterns compose freely: import another pattern, instantiate it, link cells.
  Working examples live in `packages/patterns/`. Compile and typecheck with
  the `cf` CLI (`deno task cf`).

## Start Here by Task

| Task | Read |
|------|------|
| Build a pattern | [ai/pattern-development-guide.md](ai/pattern-development-guide.md) |
| Build an iframe-first pattern | [plain DOM](ai/iframe-pattern-guide.md), [React](ai/iframe-pattern-react-guide.md), [D3](ai/iframe-pattern-d3-guide.md), [Phaser](ai/iframe-pattern-phaser-guide.md), or [Babylon.js](ai/iframe-pattern-babylon-guide.md) |
| Write tests | [ai/pattern-testing-guide.md](ai/pattern-testing-guide.md) (mechanics: [workflows/pattern-testing.md](workflows/pattern-testing.md)) |
| Review / critique a pattern | [ai/pattern-critique-guide.md](ai/pattern-critique-guide.md) |
| Manual / runtime testing | [ai/manual-testing-guide.md](ai/manual-testing-guide.md) |
| Pattern Factory build phase | [ai/pattern-factory-build-guide.md](ai/pattern-factory-build-guide.md) |
| Author CFC helpers | [ai/cfc-helper-authoring-guide.md](ai/cfc-helper-authoring-guide.md) |
| Style / UI work | [patterns/style.md](patterns/style.md) → [patterns/ui-cookbook.md](patterns/ui-cookbook.md) → [components/COMPONENTS.md](components/COMPONENTS.md) |
| Something broke | [../development/debugging/README.md](../development/debugging/README.md) |

## Index

### concepts/ — the programming model

- [concepts/pattern.md](concepts/pattern.md) — what a pattern is; inputs, outputs, `[UI]`, `[NAME]`
- [concepts/reactivity.md](concepts/reactivity.md) — the cell system, read/write access, reactive mental model
- [concepts/reactive-collections.md](concepts/reactive-collections.md) — `map`, `filter`, `reduce`, shared indexes, named aggregates, and reactive collection recipes
- [concepts/computed/computed.md](concepts/computed/computed.md) — `computed()`, `lift()`, derived values, and measured collection-loop cost
- [../features/collection-aggregates.md](../features/collection-aggregates.md) — named aggregates, numeric contracts, and collection computation costs
- [concepts/action.md](concepts/action.md) — handling events with `action()`
- [concepts/handler.md](concepts/handler.md) — reusable parameterized handlers with `handler()`
- [concepts/identity.md](concepts/identity.md) — object identity, `equals()`, why `===` fails across cells
- [concepts/piece-discovery.md](concepts/piece-discovery.md) — the piece registry, searchable collections, link walks, and the limits of orphan-piece discovery
- [concepts/self-reference.md](concepts/self-reference.md) — self-referential types with `SELF`
- [concepts/types-and-schemas/writable.md](concepts/types-and-schemas/writable.md) — `Writable<>` and write access in type signatures
- [concepts/types-and-schemas/default.md](concepts/types-and-schemas/default.md) — `Default<>` for input defaults
- [concepts/types-and-schemas/unknown.md](concepts/types-and-schemas/unknown.md) — `unknown` for a reference you compare but never read through
- [concepts/glossary.md](concepts/glossary.md) — definitions of pattern, piece, cell, space, etc.

### patterns/ — authoring recipes

- [patterns/two-way-binding.md](patterns/two-way-binding.md) — `$value` binding vs handlers; the `equals()` removal idiom
- [patterns/new-cells.md](patterns/new-cells.md) — creating cells with `new Writable()`
- [patterns/conditional.md](patterns/conditional.md) — conditional rendering with plain ternaries
- [patterns/view-switching.md](patterns/view-switching.md) — switching between views with `computed()`
- [patterns/navigation.md](patterns/navigation.md) — navigating to detail views
- [patterns/composition.md](patterns/composition.md) — composing patterns into reactive graphs
- [patterns/llm-dialog.md](patterns/llm-dialog.md) — `llmDialog` tool catalog facts: built-in tool injection, reserved built-in tool names, mutation tools as handlers
- [patterns/held-item-interfaces.md](patterns/held-item-interfaces.md) — shaping what a pattern demands of the pieces it holds, across generations
- [patterns/primitives.md](patterns/primitives.md) — the composition contract
  for reusable pattern logic and state
- [patterns/multi-user-patterns.md](patterns/multi-user-patterns.md) — shared spaces, per-user state, collaboration
- [patterns/style.md](patterns/style.md) — styling and theme guide (design brief, tokens, fonts)
- [patterns/ui-cookbook.md](patterns/ui-cookbook.md) — worked UI layout vignettes
- [patterns/meta/drag-and-drop.md](patterns/meta/drag-and-drop.md) — drag-and-drop with `cf-drag-source` / `cf-drop-zone`

### components/ — the UI library

- [components/COMPONENTS.md](components/COMPONENTS.md) — index of all `cf-*` components, bindable props, usage narrative
- [components/forms.md](components/forms.md) — stub; form authoring lives in COMPONENTS.md, internals in `packages/ui/docs/`

### conventions/ — system integration

- [conventions/wish.md](conventions/wish.md) — discovering pieces with `wish()`; scopes, favorites, profiles
- [conventions/mentionable.md](conventions/mentionable.md) — exposing and consuming mentionable pieces
- [conventions/adding-pieces.md](conventions/adding-pieces.md) — adding pieces to a space via the `addPiece` handler
- [conventions/HOME_SPACE.md](conventions/HOME_SPACE.md) — home space, user identity, default patterns
- [conventions/summary.md](conventions/summary.md) — the summary convention for pieces

### capabilities/ — built-in effects

- [capabilities/llm.md](capabilities/llm.md) — `generateText` / `generateObject`; reactive results, no `await`
- [capabilities/agent.md](capabilities/agent.md) — `agent()`; a request for an agent run over cells passed by reference, followed through its record (behind the `agentBuiltin` flag, on by default)
- [capabilities/fetch.md](capabilities/fetch.md) — `fetchJson` / `fetchText` / `fetchJsonUnchecked` / `fetchBinary`; reactive results, no `await`
- [capabilities/files.md](capabilities/files.md) — uploading files with `cf-file-input`, what a pattern keeps from the upload, downloading by link, and the blob store's limits
- [capabilities/sqlite.md](capabilities/sqlite.md) — reading a `SqliteDb` a pattern was given as an input: `db.query`, one statement per database, bounding a query's rows, session-scoped results under a read ceiling

### workflows/ — CLI and testing mechanics

- [workflows/development.md](workflows/development.md) — `cf` CLI loop: check, deploy, setsrc, inspect, link
- [workflows/pattern-testing.md](workflows/pattern-testing.md) — writing and running pattern tests
- [workflows/handlers-cli-testing.md](workflows/handlers-cli-testing.md) — invoking mounted callables from the CLI
- [workflows/reading-and-writing.md](workflows/reading-and-writing.md) — the tour of reading a piece's cells and writing them: the two cells one piece has and the flag that chooses between them, the shaped read, and why a write recomputes nothing until `cf piece step` observes the piece
- [workflows/bulk-operations.md](workflows/bulk-operations.md) — the tour of surveying, repairing and retargeting a collection of deployed pieces, walked act by act against the demo that runs it; the contract these operations hold is [features/piece-bulk-operations.md](../features/piece-bulk-operations.md)

### verbs/ — driving a deployed piece through `cf`

Start with the tour if the vocabulary is new; it assumes nothing. Arriving
without a piece id, start with the agent's entry instead. The other three
answer narrower questions, and the README says which is which.

- [verbs/README.md](verbs/README.md) — which of the five to read, by the question you are asking
- [verbs/the-verb-session.md](verbs/the-verb-session.md) — the tour: what a pattern, piece, space and verb are, and a whole session driven through `cf` in thirteen acts. Assumes nothing; read it first
- [verbs/agents-over-the-cli.md](verbs/agents-over-the-cli.md) — reaching a piece with no id in hand: the discovery surfaces and what bounds each, orienting on an unfamiliar piece, and the conclusions an empty answer does not support
- [verbs/session-walkthrough.md](verbs/session-walkthrough.md) — the same session priced: byte measurements, the code behind each answer, the caveats, and what the surface still owes. Its companion script under `packages/cli/integration/` runs every step
- [verbs/over-the-cli.md](verbs/over-the-cli.md) — what a verb hands back: declared results, piece references, idempotent retries, and a runnable walkthrough
- [verbs/prose-over-the-cli.md](verbs/prose-over-the-cli.md) — how an author's doc comments reach a caller, and which of the two documents `cf` reads carries what

[INTRODUCTION.md](INTRODUCTION.md) is a stub kept for older links; this README
replaces it.
