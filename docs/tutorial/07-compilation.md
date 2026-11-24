# Chapter 7 — From TypeScript to a Runnable Graph

Part I kept repeating two suspicious claims: "the body runs once" and "your
types matter at runtime." Neither is something stock TypeScript can do —
types are erased at compile time, and closures don't survive serialization.
This chapter explains the machinery that makes both true: a custom compiler
pipeline that rewrites pattern source before it ever executes.

## Why a compiler is non-negotiable

Recall what the runtime needs from a pattern (Chapters 1–3):

1. **Schemas.** Reactivity is *subscription to queries defined by schemas*.
   When a piece loads, the runtime must know which documents and which paths
   inside them to sync — before running any user code. That information is
   in your TypeScript types (`Writable<number | Default<0>>`), which
   ordinarily vanish at compile time.
2. **A serializable graph.** A piece's program must be re-instantiable by a
   server or another browser from stored data. Closures over local variables
   can't be stored; graph nodes with explicit inputs can.
3. **Safety.** Pattern code is untrusted; the emitted code must be amenable
   to sandboxing (frozen functions, no ambient authority — Chapter 10).

So the pipeline's job is: **reify types into JSON schemas, reify closures
into explicit graph nodes, and harden the result.**

## The pipeline

`base/ts-transformers/src/cf-pipeline.ts` defines ~20 transformer stages
that run in strict order over the TypeScript AST. You don't need to know
all of them; you need the five jobs they implement:

**Validation** (early stages — `CastValidation`, `OpaqueGetValidation`,
`PatternContextValidation`, `MergeablePushValidation`, ...): reject things
that cannot work at runtime, at compile time — e.g. `.get()` calls in
invalid positions, malformed pattern context usage, or a mergeable `push`
whose value was read from the same list (a hidden read-modify-write). Many
"framework rules" from Part I are enforced here, which is why violations
are compile errors rather than weird runtime behavior.

**JSX lowering** (`JsxExpressionSiteRouter`, `LiftLowering`): every dynamic
expression site in JSX is routed to a lowering strategy. A multi-value
expression like `{price - discount}` is rewritten into a module-scope
`lift()` node (`__cfLift_1`) with schemas for its inputs and output — this
is precisely why plain ternaries in JSX "just work" reactively (Chapter 4)
while the same ternary inside a `computed()` body is plain JavaScript: the
transformer lowers JSX expression sites into reactive nodes, while a
closure's body logic stays plain JavaScript (only its captures are
rewritten, as described next).

**Closure reification** (`ClosureTransformer`,
`PatternCallbackLowering`, `BuilderCallHoisting`): callbacks that
conceptually close over pattern
state — `action()` bodies, `.map()` callbacks — are analyzed; their
captured variables become explicit, schema-described inputs, and the
callbacks are hoisted to module scope. A `.map()` over items becomes a
mapping *node* whose closure travels with a schema of what it captures.
This is the trick behind `action()`: you write a closure, the compiler
turns it into the same shape as a module-scope `handler()`.

**Schema injection** (`SchemaInjection`, `SchemaGenerator`): type arguments
on `pattern<I, O>()`, `handler<E, C>()`, and the lowered lifts are replaced
by generated JSON schemas (next section). A `TypeRegistry`
(`WeakMap<Node, Type>`) threads type information across stages so that
schemas can still be generated for synthetic nodes the earlier stages
created.

**Hardening** (`ModuleScopeFunctionHardening` and friends): emitted
module-scope functions get `Object.freeze()` and the module is shaped for
the SES sandbox.

You can watch all of this on any file (append `| deno task cf view` for a
navigable, syntax-colored view of the dense output):

```bash
deno task cf check pattern.tsx --show-transformed --no-run
```

## Types → JSON schemas

The `schema-generator` package walks TypeScript types with a chain of
formatters (`base/schema-generator/src/`); the Common Fabric–specific
one handles the branded wrapper types:

| You write | Schema emitted |
|---|---|
| `number` | `{ type: "number" }` |
| `Cell<T>` / `Writable<T>` | schema of `T` + `asCell: ["cell"]` |
| `Stream<T>` | schema of `T` + `asCell: ["stream"]` |
| `OpaqueCell<T>` | schema of `T` + `asCell: ["opaque"]` |
| `Reactive<T>` | schema of `T`, no wrapper marker (read-only semantics come from the type, not the schema) |
| `T \| Default<V>` | schema of `T` + `default: V` |
| `PerSpace<T>` / `PerUser<T>` / `PerSession<T>` | schema of `T` + `scope: "space" \| "user" \| "session"` (folded into the `asCell` entry when the inner type is cell-wrapped) |

So the "phantom" types of Part I are real after all — each becomes a schema
annotation the runtime reads: `asCell` tells the runtime to pass a cell
handle (write-capable) instead of a plain value; `default` fills missing
documents; `scope` selects the storage partition (Chapter 9).

A real before/after, from the transformer test fixtures
(`base/ts-transformers/test/fixtures/handler-schema/simple-handler.input.tsx`
and its `.expected.jsx`):

```tsx
// Shown for illustration only.
// You write:
const myHandler = handler<CounterEvent, CounterState>((event, state) => {
  state.value.set(state.value.get() + event.increment);
});

// The compiler emits:
const myHandler = handler({
  type: "object",
  properties: { increment: { type: "number" } },
  required: ["increment"],
}, {
  type: "object",
  properties: { value: { type: "number", asCell: ["cell"] } },
  required: ["value"],
}, (event, state) => {
  state.value.set(state.value.get() + event.increment);
});
```

The generics are gone; in their place are two schemas — what the event looks
like, and what state the handler touches (with `asCell` marking write
access). At runtime these schemas are the handler's *capability
declaration*: they bound what gets subscribed, what gets passed in, and what
it can write.

## What `pattern()` builds: the graph object

After transformation, executing the module is cheap and safe: calling
`pattern(inputSchema, outputSchema, fn)` and then instantiating it runs the
body **once** inside a tracking frame (`runtime/runner/src/builder/`).
Every `computed`/`lift`/`handler`/sub-pattern call registers a node; the
result is a frozen, serializable description
(`runtime/runner/src/builder/types.ts`):

```ts
// Shown for illustration only.
Pattern {
  argumentSchema, resultSchema,   // the generated schemas
  nodes: Node[],                  // the graph
  result,                         // shape of the output, with links into nodes
}
Node {
  module: { type: "javascript" | "pattern" | "raw" | "isolated" | ...,
            implementation, $implRef, ... },
  inputs, outputs,                // value trees containing cell links
}
```

During body execution your "values" are `Reactive`s — proxies that record
operations like `.key()` chains instead of performing them. That's the
body-runs-once trick demystified: the body manipulates *placeholders*, and
real data only flows later, when the scheduler executes nodes (Chapter 8).
It's also why `if (count > 3)` in the body can't work — `count` is a
placeholder, not a number.

## Identity and caching: `$implRef`

Each node's code carries an `$implRef` — a stable, content-derived identity
for the implementation: `{ identity, symbol }`, the defining module's
content identity plus the artifact's export symbol
(`runtime/runner/src/builder/types.ts`). It is deliberately ordinal-free —
where the function sits in the file doesn't participate, only its content.
It serves three masters:

- **Caching**: compiled implementations are resolved and cached by ref
  (`runtime/runner/src/harness/executable-registry.ts`, with compiled
  records in `runtime/runner/src/compilation-cache/`), so re-loading a
  piece doesn't recompile unchanged nodes.
- **Stable scheduling**: the scheduler identifies actions across re-runs by
  a content-addressed implementation fingerprint (the implementation hash).
- **Provenance**: verified-source tracking ties running code back to the
  exact source that produced it (this also feeds the CFC contextual
  flow-control machinery in `runtime/runner/src/cfc/` — Chapter 10).

The `js-compiler` package does the actual TypeScript-to-JS emission: one
CommonJS body per authored file, which the runtime's module-record loader and
verifier consume a module at a time. Compilation results are cached server-side
too (Toolshed's compilation cache), so opening a piece doesn't recompile it per
client.

## Where compiled code runs

Compiled pattern code executes inside an SES (hardened JavaScript)
environment in the runtime's process — that's the time-capability gate on
`Date.now()` from Chapter 3. For fully untrusted *rendered* content there's a second,
stronger boundary: `base/iframe-sandbox` runs guest HTML/JS inside a
double iframe (an outer `srcdoc` iframe that pins a strict
Content-Security-Policy, enclosing an inner iframe with the guest code),
with all data access mediated by a postMessage IPC protocol
(read/write/subscribe). Chapter 10 covers the security model in full.

---

**Next:** [Chapter 8 — The reactive runtime](08-runtime-internals.md): how
the graph the compiler built actually executes.
