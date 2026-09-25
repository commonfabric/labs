# Chapter 1 — The Problem and the Big Picture

## The problem

Think about the small programs people actually want: a shared shopping list
that sorts itself by store aisle, a poll for the group chat, a tracker that
watches a feed and summarizes it every morning. Today each of those is either
a SaaS product (someone else's data model, someone else's server, no
composability) or a script (no UI, no sharing, no durability, dies with the
terminal).

The structural reasons these are hard to build well:

1. **State is trapped.** Every app owns its own database. Two programs can
   only cooperate through bespoke APIs, so "wire my todo list into my
   calendar" is an integration project, not a link.
2. **Reactivity stops at the process boundary.** Inside one React app, a
   change propagates automatically. Across two browser tabs, two users, or a
   browser and a server job, you're back to polling, webhooks, and cache
   invalidation — hand-rolled every time.
3. **User programs can't be trusted.** If end users (or LLMs acting for them)
   write the programs, the platform must run code it didn't review, with
   real user data, without letting it exfiltrate that data or corrupt it.
4. **Durability and identity are afterthoughts.** Who owns the data? Where
   does it live when the tab closes? Can a server keep running my program
   while I'm offline?

Common Fabric is a runtime built to dissolve all four problems at once: a
substrate where small reactive programs (**patterns**) operate on durable,
shared, access-controlled state (**cells** in **spaces**), and where
reactivity spans processes, machines, and users as naturally as it spans a
single component tree.

## The shape of the solution

The system's bet is that one abstraction can carry all of this: **a reactive
cell that is also a durable, addressable, synchronized document.**

- A **cell** is a unit of state. Reading it inside a computation subscribes
  you; writing it re-runs every computation that read it. So far, that's an
  ordinary signal, like Solid.js.
- But a cell is also **durable**: it lives in a **space** (a data store named
  by a [DID](https://www.w3.org/TR/did-core/) — a cryptographic identifier),
  persisted server-side in SQLite, and synchronized to every connected
  client. The "subscription" that drives reactivity is literally a
  subscription to a query over the store. Two browsers, a CLI, and a
  background worker observing the same cell are all just subscribers.
- A **pattern** is a program over cells. Crucially, a pattern is *not* a
  function that re-renders; it runs **once** to build a reactive graph —
  nodes for derived values, event handlers, and UI — and then the runtime
  keeps that graph live forever. (If you know Solid.js: components run once
  and wire signals. Same idea, but the graph and its state are durable.)
- A **piece** is a deployed instance of a pattern: the pattern's code plus
  its argument and result cells, written into a space. Pieces are the things
  users see, link together, and keep.

Because state and reactivity live in the substrate rather than in any one
process, the same piece can be driven from a browser UI, poked from a CLI,
recomputed by a server-side worker, and linked into other pieces — with no
integration code.

## One trace, end to end

Here is the whole system in one user action. You check off a todo item in
your browser; your housemate is looking at the same list on their laptop.

1. **UI event.** The checkbox is a `<cf-checkbox $checked={item.done} />` —
   a two-way binding. Toggling it writes `true` into the `done` cell.
2. **Local reactivity.** The write goes into a transaction. When it commits,
   the scheduler finds every computation that read `item.done` — the
   "remaining items" count, the list partition into active/completed — and
   re-runs exactly those. Your UI updates immediately (optimistically).
3. **Sync.** The runtime's storage layer turns the transaction into a
   *commit* — the operations plus, for read-modify-write operations, a
   record of what was read so the server can detect conflicts (a simple
   toggle like this one ships as a last-write-wins write; Chapter 9) — and
   sends it over a WebSocket to the server (**Toolshed**), which validates
   it and appends it to the space's SQLite log.
4. **Fan-out.** The server knows which sessions are watching queries that
   touch this document. It pushes a delta to your housemate's session.
5. **Remote reactivity.** Their runtime integrates the delta into its local
   replica, which fires the same scheduler machinery on their machine: their
   item count updates, the item moves to "completed". No app code was
   involved in steps 3–5; the pattern's author wrote only the checkbox
   binding.

Every chapter of this tutorial is an expansion of one of those five steps.

## The layers, and why each must exist

The repository describes itself in "pace layers" (see `AGENTS.md`); here is
the same stack with the *why* attached:

| Layer | Packages | Why it has to exist |
|---|---|---|
| Foundation | `api`, `data-model`, `runner`, `identity`, `memory` | The cell/pattern abstractions, the canonical value/link data model, the scheduler that runs graphs, cryptographic identity, and the durable store. Everything else is expressed in these terms. |
| System | `schema-generator`, `ts-transformers`, `js-compiler`, `iframe-sandbox` | Patterns are authored as ordinary TypeScript, but the runtime needs *schemas* (to know what to subscribe to) and *graph nodes* (to schedule). A compiler pipeline extracts both. The sandbox exists because pattern code is untrusted. |
| Capabilities | `piece`, `html`, `llm` | The things patterns can *do* beyond pure computation: be instantiated as pieces, render HTML, call LLMs. |
| Operation | `cli`, `fuse`, `state-inspector`, `cf-harness` | Drive, mount, and inspect the system from scripts and agents. |
| Deployed product | `toolshed`, `shell`, `lib-shell`, `runtime-client` | The server (storage, sync, LLM proxy, blobs), the browser app users actually open, and the shared shell logic and runtime-client seam that connect its UI thread to the worker-hosted runtime. |
| UI | `ui` | The `cf-*` web-component library patterns build interfaces from. |
| End-user programs | `patterns`, `home-schemas` | The patterns themselves — the point of the whole exercise. |

A useful way to hold this: **the bottom four rows are one machine** (a
reactive, durable, secure computer), and patterns are its programs. The
tutorial's Part I teaches you the machine's instruction set; Part II opens
the case.

## Vocabulary card

Keep this list at hand; everything else in the tutorial is built from these
seven words.

- **Cell** — a reactive, durable unit of state, addressed by
  (space, entity id, path) and described by a schema.
- **Space** — a store of cells, named by a DID; the unit of sharing and
  access control.
- **Pattern** — a TypeScript/JSX module that runs once to define a reactive
  graph over cells.
- **Piece** — a deployed instance of a pattern in a space, with its own
  argument and result cells.
- **Stream** — a stateless channel; sending to it fires a handler. Event
  handlers and exported actions are streams.
- **Toolshed** — the server: WebSocket sync endpoint, persistence, LLM
  proxy, blob store.
- **Shell** — the browser application that logs you in, boots a runtime, and
  renders pieces.

---

**Next:** [Chapter 2 — Cells](02-cells.md), the unit everything else is made
of.
