# Pattern Debugging Guide

Quick error reference and debugging workflows. For detailed explanations, see linked docs.

## Quick Error Reference

| Error Message | Cause | Fix |
|---------------|-------|-----|
| "Property 'set' does not exist" | Missing `Writable<>` in signature | Add `Writable<T>` for write access ([@writeable](../../common/concepts/types-and-schemas/writable.md)) |
| "X.get is not a function" | Calling `.get()` on computed/lift result | Access directly without `.get()` - only `Writable<>` has `.get()` ([quick gotchas](gotchas/quick.md#get-is-not-a-function)) |
| "X.filter is not a function" | Value isn't an array (yet) | Check `Default<>`, don't assume `.get()` is the fix ([quick gotchas](gotchas/quick.md#filter-map-find-is-not-a-function)) |
| Console storm of "Cannot read properties of undefined (reading 'map')"; a UI section silently fails to render | A render-path `computed` chains `.map()`/`.filter()`/`[...]` off a scoped `.get()` that is `undefined` until first sync (esp. `perSession`); `Default<>` hasn't hydrated yet | Guard every render-path scoped read with `?? []` ([gotchas/scoped-cell-pitfalls](gotchas/scoped-cell-pitfalls.md), section 5) |
| "new Cell() only accepts static data" | Passing an input prop, mapped field, or computed/reactive value into `new Writable()` / `new Cell()` | Use the input writable cell directly, or initialize pattern-owned local cells from static values only ([new-cells](../../common/patterns/new-cells.md), [@reactivity](../../common/concepts/reactivity.md)) |
| "Tried to access a reactive reference outside a reactive context" | Accessing reactive value at init time (in `[NAME]`, `new Writable()`, or object indexing) | Wrap in `computed()`, use `lift()`, or set in event handler ([gotchas/reactive-reference-outside-context](gotchas/reactive-reference-outside-context.md)) |
| ".trim is not a function" / ".replace is not a function" / ".includes is not a function" | Calling plain string helpers on reactive fields, often from JSX or `.map()` render contexts | Render reactive values directly when possible, or derive labels/branches in `computed()` ([reactivity-issues](reactivity-issues.md), [@reactivity](../../common/concepts/reactivity.md)) |
| "Type 'string' is not assignable to type 'CSSProperties'" | String style on HTML element | Use object syntax `style={{ ... }}` ([style-errors](style-errors.md)) |
| Type mismatch binding item to `$checked` | Binding whole item, not property | Bind `item.done`, not `item` ([quick gotchas](gotchas/quick.md#binding-the-whole-item-instead-of-a-property)) |
| "ReadOnlyAddressError" | onClick inside computed() | Move button outside, use disabled ([quick gotchas](gotchas/quick.md#onclick-inside-computed)) |
| Piece hangs, never renders | ifElse with composed pattern cell | Use local computed cell ([quick gotchas](gotchas/quick.md#ifelse-with-composed-pattern-cells)) |
| Data not updating | Missing `$` prefix or wrong event | Use `$checked`, `$value` ([reactivity-issues](reactivity-issues.md)) |
| Filtered list not updating | Need computed() | Wrap in `computed()` ([reactivity-issues](reactivity-issues.md)) |
| lift() returns 0/empty | Passing cell directly to lift() | Use `computed()` or pass as object param ([quick gotchas](gotchas/quick.md#lift-returns-stale-or-empty-data)) |
| Handler binding: "Object literal may only specify known properties" | Passing event data at binding time | Use inline handler for test buttons ([quick gotchas](gotchas/quick.md#handler-binding-error-unknown-property)) |
| Stream.subscribe doesn't exist | Using new Stream()/subscribe() | Bound handler IS the stream ([quick gotchas](gotchas/quick.md#stream-subscribe-doesnt-exist)) |
| Can't access variable in nested scope | Variable scoping limitation | Pre-compute grouped data or use lift() with explicit params ([reactivity-issues](reactivity-issues.md#variable-scoping-in-reactive-contexts)) |
| "Cannot access cell via closure" | Using lift() with closure | Pass all reactive deps as params to lift() ([@reactivity](../../common/concepts/reactivity.md)) |
| CLI `cell get` returns stale computed values | `cf cell set` doesn't trigger recompute | Run `piece step` after `cell set` to trigger re-evaluation ([cli-debugging](cli-debugging.md#stale-computed-values-after-cf-cell-set)) |
| A field's properties read as `undefined` though the value is there; rendering the same path works | The field is typed `unknown`, which declares a reference: the runner hands back something that answers presence and identity and carries no properties | Name the field on the operand reading it — a lift/computed operand shape, or a `Cell<>` in a handler ([gotchas/unknown-typed-field-reads-a-reference](gotchas/unknown-typed-field-reads-a-reference.md)) |
| Browser UI stale after a handler write | The write usually worked — the cell, piece, or render path is what to check | Inspect actual cell state first via `readCell`; don't rewrite the mutation ([gotchas/browser-stale-ui](gotchas/browser-stale-ui.md)) |
| A write never lands, or a section of the interface is replaced by a `cf-cfc-blocked` placeholder | Contextual Flow Control turned it away — a policy decision, not a scheduler or renderer fault | The `[WARN][cfc]` line names the kind of decision; raise the `cfc` logger to debug and reproduce for the reasons, labels, and dials behind it, or in a pattern test run `cf test --cfc-denials` ([features/cfc-denial-reporting](../../features/cfc-denial-reporting.md)) |
| "handler() should be defined at module scope" | handler() inside pattern body | Move handler() outside pattern ([gotchas/handler-inside-pattern](gotchas/handler-inside-pattern.md)) |
| UI churning, high CPU, never settles | Non-idempotent computed or action cycle | Run `await commonfabric.detectNonIdempotent()` ([non-idempotent-detection](non-idempotent-detection.md)) |
| `non-idempotent raw:map` or `Reactive graph did not settle ... Actions: raw:map` | Mapped render body is doing work during render, often an event prop invoking `.send()` immediately | Inspect `.map()` JSX for `onClick={stream.send(...)}` or other render-time writes ([gotchas/immediate-event-invocation](gotchas/immediate-event-invocation.md)) |
| "Function creation is not allowed in pattern context" | Helper function inside pattern | Move function to module scope ([gotchas/handler-inside-pattern](gotchas/handler-inside-pattern.md)) |
| "Class creation is not allowed in pattern context" | Class declared/expressed inside pattern body | Move class to module scope; a method reading a captured reactive value sees a stale snapshot ([gotchas/handler-inside-pattern](gotchas/handler-inside-pattern.md)) |
| "A method/getter/setter/function-valued property ... on an object literal in pattern or render context ..." (`pattern-context:object-member`) | A function-valued member on an object literal that becomes pattern result data | A getter makes its object one the reactive data model cannot store, which holds only plain data properties; a method, setter, or function property (`toJSON` included) is a value it cannot store. Use a plain property or `computed(() => ...)` field for a value, or a module-scope `handler()`/`lift()` for behavior ([gotchas/handler-inside-pattern](gotchas/handler-inside-pattern.md)) |
| "lift() should not be immediately invoked inside a pattern" | `lift(...)(args)` inside pattern | Use `computed()` instead, or define lift() at module scope ([gotchas/handler-inside-pattern](gotchas/handler-inside-pattern.md)) |
| A list renders correctly but a control that only reorders it does nothing; sort state updates while the rows stay put | The order lives in a derived `computed()`, but a mapped list tracks the cell it maps, and only the sort state changed | Write the new order into the mapped cell itself ([gotchas/mapped-list-order-from-computed](gotchas/mapped-list-order-from-computed.md)) |
| Click handler does nothing, ID lookup fails silently | Using custom `id` property for lookups | Use `equals()` for identity, not custom IDs ([gotchas/custom-id-property-pitfall](gotchas/custom-id-property-pitfall.md)) |
| Selection overwrites item data, `.set()` changes wrong value | Storing Cell reference directly | Box the reference: `{ item }` instead of `item` ([gotchas/cell-reference-overwrite](gotchas/cell-reference-overwrite.md)) |
| List of records renders intermittently/blank; full-cell read is huge | Persisting inline image `data` (base64 data-URL) in a (PerSpace) cell | Persist the blob `url`, not `data`; `includeData` only for transient LLM use ([gotchas/persisting-images-in-cells](gotchas/persisting-images-in-cells.md)) |
| Per-row inline form (delete-confirm, edit, picker) never opens; no error | A `computed()` nested in a `.map()` over a computed-produced list reads a `perSession` cell; the narrower-scope follow is silently blocked | Read the perSession cell once at top level and emit a plain boolean per row ([gotchas/persession-read-in-mapped-computed](gotchas/persession-read-in-mapped-computed.md)) |
| "Reactive reference from outer scope cannot be accessed via closure" / "Cannot access cell via closure" at pattern construction | An inner `(cellCall() ?? []).map(...)` nested in an outer `.map(...)` — the `?? []` hides the cell from the transformer. The shape is a code smell even on runtimes where it no longer throws | Map the cell directly; if you need to transform first, pre-bake a top-level `computed` ([gotchas/closure-capture-in-nested-map](gotchas/closure-capture-in-nested-map.md)) |
| Writable-input computed causes churn or stale fan-out | A computed writes through a `Writable<>` input while also participating in reactive scheduling | Treat it as effectful and check for cycles ([non-idempotent-detection](non-idempotent-detection.md)) |
| `[object Object]` shown where a string was expected | A computed/`[NAME]` template string interpolates a whole object instead of a field | Interpolate the field, not the object, inside `computed()` ([quick gotchas](gotchas/quick.md#object-object-in-a-computed-string)) |
| "secure mode %SharedMath%.random() throws" (or `Date.now` in computed) | SES gates ambient `Math.random()`/`Date.now()` in the pattern sandbox — allowed in a handler, forbidden in a lift/computed or pattern body | Call `Math.random()` / `Date.now()` directly from a handler; for reactive time in a computed, read the `#now` wish ([gotchas/scoped-cell-pitfalls](gotchas/scoped-cell-pitfalls.md), section 7) |
| "Cannot read properties of null/undefined" exactly when a conditional section renders the fallback | Ternary branches are evaluated eagerly — the lowered `ifElse()` builds both branch expressions even when the condition is falsy | Defer the property-accessing branch in `computed()` ([gotchas/eager-ternary-branch-evaluation](gotchas/eager-ternary-branch-evaluation.md)) |
| Handler silently never runs; runner logs "action argument is undefined (potential schema mismatch) -- not running" | Handler state holds a cross-space value typed as the plain value; argument validation resolves it before it has loaded | Type the state field `Cell<T>` and read inside the handler ([gotchas/cross-space-handler-state-link](gotchas/cross-space-handler-state-link.md)) |
| "Source cannot contain reserved helper symbol '__cfHelpers'" loading a deployed piece | The piece's stored source closure holds transformer-processed source instead of authored source; a compile-cache rotation forces a recompile that the transformer rejects | `cf space recreate-root` ([gotchas/stale-source-closure-cfhelpers](gotchas/stale-source-closure-cfhelpers.md)) |

---

## Guides by Topic

### Common Gotchas

These issues compile without errors but fail at runtime.

**Short gotchas** live in one greppable file —
[gotchas/quick.md](gotchas/quick.md): `.get()` is not a function; filter/map/find
is not a function; `[object Object]` in a computed() string; handler binding
error; lift() returns stale data; ifElse with composed pattern cells; onClick
inside computed(); Stream subscribe doesn't exist; binding the whole item to
`$checked`; Writable array element types; nested Writable types; handler state
typed `any` unwraps Writables; performance quick tips.

**Longer gotchas** have their own files:

- [Reactive Reference Outside Context](gotchas/reactive-reference-outside-context.md) - Use `lift()` for object indexing
- [Local Cells](../../common/patterns/new-cells.md) - `new Writable()` is for
  new pattern-owned cells initialized from static values
- [Eager Ternary Branch Evaluation](gotchas/eager-ternary-branch-evaluation.md) - Ternary branches don't short-circuit; nullable property access crashes the fallback path
- [Immediate Event Invocation](gotchas/immediate-event-invocation.md) - Event props invoking streams or writes during render
- [handler() or Function Inside Pattern](gotchas/handler-inside-pattern.md) - Module scope requirement
- [Custom `id` Property Pitfall](gotchas/custom-id-property-pitfall.md) - Use `equals()` for identity
- [Cell Reference Overwrite](gotchas/cell-reference-overwrite.md) - Box references with `{ item }`
- [Persisting Images in Cells](gotchas/persisting-images-in-cells.md) - Store the blob `url`, not the inline `data`
- [perSession Read in a Mapped computed()](gotchas/persession-read-in-mapped-computed.md) - Per-row inline forms that never open; hoist the session read out of the nested `computed()`
- [Scoped Cell Pitfalls](gotchas/scoped-cell-pitfalls.md) - `PerSpace`/`PerUser`/`PerSession` gotchas, incl. guarding render-path `.get().map()` against undefined-before-sync
- [Closure Capture in Nested map()](gotchas/closure-capture-in-nested-map.md) - `(cellCall() ?? []).map(...)` nested in an outer `.map(...)` is a code smell; three recipes (map the cell directly; pre-bake top-level computed; local computed bridge)
- [Browser UI Stale After a Handler Write](gotchas/browser-stale-ui.md) - Inspect actual cell state before assuming the write failed
- [A Field Typed `unknown` Reads Back as a Reference](gotchas/unknown-typed-field-reads-a-reference.md) - The reading operand's schema decides what materializes; naming the field is what makes the read follow the link
- [Cross-Space Handler State Must Be a Cell Link](gotchas/cross-space-handler-state-link.md) - A cross-space value in handler state silently blocks the handler; pass the link, not the value
- [Stale Source Closure: Reserved Helper Symbol on Load](gotchas/stale-source-closure-cfhelpers.md) - A deployed piece whose stored source is not pristine authored TypeScript; repair with `cf space recreate-root`

### Error Categories

- [Quick Gotchas](gotchas/quick.md) - Type binding mistakes, Writable arrays, and other short gotchas
- [Style Errors](style-errors.md) - Object vs string syntax for HTML/custom elements
- [Reactivity Issues](reactivity-issues.md) - Data not updating, scoping problems
- [Runtime Errors](runtime-errors.md) - DOM access, async blocking

### Runtime Inspection

- [Console Commands](console-commands.md) - `globalThis.commonfabric.*` browser console reference
  - Starts with common tasks: read piece data, dump the rendered VDOM, diagnose
    churn, find dead handlers, watch values, agent-browser recipes — including
    why a sub-pattern's cell can read `undefined` at an `of:` id while its value
    lives at the `computed:` id of the same hash
  - Reference tail covers logger counts/timing/baselines/flags and worker traces
- **Server-side write trace** — set `CF_DEBUG_MEMORY_WRITES=1` on the toolshed to
  log every memory write as `[memwrite] c=<conn> op=… id=… scope=… vhash=…`,
  per-connection-tagged (`c=`) so cross-client write churn can be attributed to
  specific clients. Add `CF_DEBUG_MEMORY_WRITE_VALUES=1` to also dump raw values
  (avoid on real data — they can hold PII/secrets). Output goes to the toolshed's
  stderr — `packages/toolshed/local-dev-toolshed.log` under the local-dev scripts.
  See
  [`memwrite-trace.ts`](../../../packages/toolshed/routes/storage/memory/memwrite-trace.ts).
- [VDOM Debug Helpers](vdom-debug.md) - `commonfabric.vdom.*` VDOM tree inspection
- [Logger Internals](../../features/logger-internals.md) - Creating loggers in runtime code (`getLogger`, timing, flags)

### Diagnosis

- [Non-Idempotent Detection](non-idempotent-detection.md) - Detect non-settling computations, cycles, and non-idempotent actions
- [Profiling a Slowness](profiling.md) - Turning "this is slow" into a named
  source and a benchmark that correlates: phase timings, `performance.mark`
  brackets, worker CPU profiles, subphase splitting
- [Debugging Settle Waves](settle-wave-investigation.md) - Workflow for tracing worker fan-out: baselines, settle stats, trigger/action-run/write traces
  - Dated findings from the March 2026 investigation are archived in [settle-wave-2026-03-findings](../../history/development/debugging/settle-wave-2026-03-findings.md)
- [Browser Integration Test Diagnostics](integration-test-diagnostics.md) - Integration-test failures are self-diagnosing: fill phase ledger, host bound-cell probe, pending-IPC table, worker request ledger, console tail — read the failure output before instrumenting

### Workflows

- [Debugging Workflow](workflow.md) - Step-by-step process + quick fixes
- [CLI-Based Debugging](cli-debugging.md) - Local checks, deploying test pieces, CLI vs browser, the setsrc loop

---

## See Also

- [@reactivity](../../common/concepts/reactivity.md) - Reactivity system
- [@writeable](../../common/concepts/types-and-schemas/writable.md) - Writable type system
- [@COMPONENTS](../../common/components/COMPONENTS.md) - UI components
