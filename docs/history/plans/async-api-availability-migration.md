---
status: historical
created: 2026-07-14
archived: 2026-07-14
reason: "Executed plan; pending rendering, latestComplete, and the async API availability migrations shipped."
superseded-by: docs/specs/data-unavailability.md
---

# Pending Render Continuity And Async API Availability Migration

This plan covers two follow-ups to the
[`DataUnavailable` specification](../../specs/data-unavailability.md): the pending
renderer continuity behavior and the staged migration of the remaining
asynchronous APIs. The renderer portion, `latestComplete()`, direct streaming
generation results, direct compilation results, structured SQLite queries,
availability-aware Wish results, and typed dialog results are implemented; the
`streamData` migration and legacy `llm()` compatibility cleanup are also
implemented.

The complementary `latestComplete()` helper is now implemented and specified in
the [DataUnavailable spec](../../specs/data-unavailability.md#latestcomplete-snapshot-helper).
`resultOf()` exposes the current usable value and propagates current
unavailability; `latestComplete()` retains a coherent prior value.

## Status

- Pending renderer continuity: implemented and tested.
- Remaining asynchronous API migration: A1-A7 complete.

The DataUnavailable spec describes the shipped behavior. This executed plan is
archived under `docs/history/plans/`.

## Fixed Design Rules

1. A one-result operation has a default public API returning
   `AsyncResult<T>`. Code keeps the request for guards and calls
   `resultOf(request)` for its ordinary `T` view.
2. Public APIs do not add a state object merely to hold `.result`. A stream
   returns its final `AsyncResult<T>` directly and exposes intermediate values
   through `partialResultOf(stream)`. Successful metadata which is produced
   atomically with the value is part of `T`.
3. State objects remain only for genuine multi-channel state machines such as
   `wish` and `llmDialog`. Their data-bearing channels use `AsyncResult<T>`;
   lifecycle, controls, selection, and other independent state remain explicit.
4. `pending` and `error` fields must not duplicate the availability of the same
   result channel. Failure-only metadata belongs on a specialized error value;
   independent state such as an active dialog turn remains explicit.
5. A durable raw built-in may keep an internal state object. Builder-time
   projections expose the direct result and associate it with auxiliary
   zero-node projections such as `partialResultOf()`; genuine state machines
   expose their data-bearing channels directly on their public state object.
   Callers do not navigate raw implementation state.
6. Existing raw implementation references and persisted state shapes are not
   changed in place without compatibility tests. Old compiled graphs must
   continue to rehydrate while newly compiled code receives the new public
   surface.
7. Every new request replaces a stale result with pending in the same logical
   transition unless the API's contract explicitly retains a prior value. Only
   `latestComplete()` and state machines whose contract says so provide
   last-value continuity.
8. An input marker propagates unchanged. Locally invalid inputs become
   `schema-mismatch`; operational failures become `error`.
9. Transformer-derived result schemas remain the runtime contract. A generic
   result API must inject or forward its concrete TypeScript schema rather than
   adding an unvalidated cast.
10. CFC scope, labels, stale-write guards, request hashes, and post-commit effect
   ordering are preserved across every migration.

## Completed Renderer Contract

The renderer behavior is deliberately narrower than a general suspense cache:

| Previous render | New value | Result |
|---|---|---|
| none | pending | blank |
| usable subtree | pending | retain, dim, mark busy, and make inert |
| retained pending subtree | usable | remove treatment and reconcile |
| any | error, syncing, or schema mismatch | blank unless explicitly guarded |
| any | authored `undefined` | ordinary empty content |
| any | disallowed by render policy | blocked-policy rendering wins |

The retained element carries `data-cf-pending`, `inert`, and `aria-busy`; a
renderer-owned style is installed in the active document or shadow root. Bare
text is retained but has no element to dim or disable. Policy re-evaluation
always uses the current value, including an unavailable marker, so it cannot
resurrect content cleared by an error.

### R0 — Red tests

- [x] Pin initial pending, usable-to-pending retention, recovery, and
      non-pending clearing for worker roots and children.
- [x] Pin legacy renderer behavior and main-thread application of inert/busy
      state.
- [x] Pin policy re-evaluation after an error for roots and children.

### R1 — Renderer implementation

- [x] Reuse ordinary `set-prop` / `remove-prop` worker operations; add no VDOM
      protocol operation.
- [x] Apply the DOM treatment in the main-thread applicator and legacy renderer.
- [x] Install the style once per active document, shadow root, or detached
      container.
- [x] Keep policy checks ahead of pending retention and re-evaluate the current
      availability state on ACL changes.

### R2 — Renderer documentation and validation

- [x] Specify pending-only retention in the DataUnavailable spec and reactivity
      guide.
- [x] Pass focused red/green tests, the full `packages/html` suite, and relevant
      documentation checks.

## API End-State Inventory

| API | Classification | Planned public result contract | Auxiliary state |
|---|---|---|---|
| `fetch*` | one result | `AsyncResult<T>` | implemented |
| `generateText`, `generateObject` | one result | `AsyncResult<T>` | implemented |
| `generateTextStream`, `generateObjectStream` | final result plus intermediate values | `AsyncResult<T>` | `partialResultOf(request)` |
| `compileAndRun` | one result with failure diagnostics | specialized `AsyncResult<T>` | diagnostics on `CompileError` |
| `db.query`, `sqliteQuery` | one result plus success audit metadata | `AsyncResult<{ rows: Row[]; withheld?: number }>` | none |
| `wish` | discovery and selection state machine | `WishState<T>.result: AsyncResult<T>` | candidates and trusted `[UI]` |
| `llmDialog` | multi-turn state machine | `LLMDialogState<T>.result: AsyncResult<T>` when requested | turn activity, controls, pins, tools |
| `streamData` | long-lived stream with a final value | `AsyncResult<T>` | `partialResultOf(request)` while open |
| legacy `llm` | deprecated state API | no new surface | migrate callers, then remove |

`navigateTo`, `sqliteDatabase`, SQLite writes, and CFC label inspection are not
asynchronous data-result APIs and are outside this migration.

## A0 — Compatibility And Contract Harness

- [x] Add compile-time fixtures for direct results, auxiliary projections,
      genuine state-machine channels, guards, `resultOf()`, aliases, and
      namespace imports.
- [x] Add transformed-output fixtures for every generic API whose result
      schema is injected by the transformer.
- [x] Add raw built-in transition tests which distinguish stored authored
      `undefined` from every `DataUnavailable` reason.
- [x] Add rehydration fixtures for the currently persisted state object of each
      built-in before changing any producer.
- [x] Inventory and classify every repository call site as result-only,
      status-aware, metadata-aware, or state-machine control.
- [x] Decide the compatibility window for old public fields. Keep legacy raw
      fields readable until all repository consumers and rehydration fixtures
      have moved.

### A0 audit findings

The public cutover and persisted-graph compatibility are separate concerns.
Existing compiled graphs retain their serialized output bindings, so raw module
references and state shapes must remain readable even after newly compiled code
receives the concise API.

| API family | Repository consumers | Raw compatibility decision |
|---|---|---|
| streaming generation | three pattern consumers plus transformer/runtime tests | keep the existing generation state and module refs; project `result` and associate `partial` in the builder |
| `compileAndRun` | four pattern consumers | keep `compileAndRun` as the legacy state ref; use a versioned direct-result ref for newly compiled graphs |
| SQLite queries | three pattern consumers plus integration fixtures | keep `sqliteQuery` as the legacy state ref; use a versioned structured-result ref for newly compiled graphs |
| `wish` | state/UI use across the pattern catalog | retain the state object and raw ref; upgrade only its nested result channel |
| `llmDialog` | eight pattern consumers, with and without presented results | retain the state object and raw ref; typed overloads expose the existing nested result cell honestly |
| `streamData` | no repository pattern consumers; runner outbox tests only | keep `streamData` as the legacy state ref; use a versioned direct-result ref for newly compiled graphs |
| legacy `llm` | integration tests only | retain during the compatibility window; do not add a new surface |

The current object-generation endpoint is non-streaming. In the tool-calling
path, `partial` is accumulated model text, not a schema-valid partial object.
Accordingly, `partialResultOf(generateObjectStream<T>(...))` returns
`AsyncResult<string>`. A future provider endpoint may add a separately specified
partial-object channel; this migration must not cast incomplete text to
`Partial<T>`.

**A0 exit:** every API below has an agreed transition table, a red contract test,
and a proven old-state rehydration path.

## A1 — Direct Streaming Generation Results

`generateTextStream()` and `generateObjectStream()` use the same direct final
result contract as their non-streaming counterparts. The only public addition
is access to intermediate output:

```typescript
// Shown for illustration only.
const request = generateTextStream({ prompt });
const text = resultOf(request);
const partialRequest = partialResultOf(request);
const partialText = resultOf(partialRequest);
```

- [x] Make the stream call return its final `AsyncResult<T>` directly.
- [x] Add `partialResultOf(request)` as a zero-node associated projection. Text
      and object streams expose the accumulated provider text they actually
      receive. A true partial-object channel requires a future streaming object
      provider contract.
- [x] Keep grounding or message metadata only through separately named helpers
      if repository use proves those channels are needed; do not restore a
      generic state wrapper. The repository has no public metadata consumer, so
      A1 adds no metadata helper.
- [x] Retain persisted legacy decoding behind the builder projection.
- [x] Verify a new request atomically clears stale partial state and publishes
      pending on the result channel.

**A1 exit:** streaming and non-streaming generation have the same direct result
shape; intermediate output is available without `.result`.

## A2 — `compileAndRun`

Compilation diagnostics are emitted only on failure today, so they belong on a
specialized error rather than on a successful result or an advanced state:

```typescript
// Shown for illustration only.
const compileRequest = compileAndRun<Input, Output>({ files, main, input });
const output = resultOf(compileRequest);

const diagnostics = hasError(compileRequest)
  ? compileRequest.error.diagnostics
  : [];
```

- [x] Return a direct `AsyncResult<Output>` and project the persisted internal
      state without creating another node.
- [x] Define a serializable `CompileError extends Error` carrying structured
      `diagnostics`; specialize the error arm so `hasError(compileRequest)`
      preserves that type.
- [x] Represent non-diagnostic compilation and execution failures with the same
      error type and an empty or absent diagnostics array.
- [x] Define invalid program parameters precisely: schema-invalid input becomes
      `schema-mismatch`; a valid request which cannot compile becomes `error`.
- [x] Propagate unavailable `files`, `main`, or `input` before invoking the
      compiler.
- [x] Preserve the live compiled-pattern result link, scope, cancellation,
      request supersession, and structured diagnostic locations.
- [x] Migrate compiler UIs to the specialized error and result-only call sites
      to the direct form.

**A2 exit:** ordinary compilation reads like fetch/generation, while diagnostic
surfaces retain their structured errors without parallel pending semantics.

## A3 — SQLite Queries

Rows and `withheld` are delivered together, so they form one successful value;
there is no state variant:

```typescript
// Shown for illustration only.
const queryRequest = db.query<Row>(sql, {
  reactOn: db,
  readClearance: true,
});
const { rows, withheld } = resultOf(queryRequest);
```

- [x] Make `db.query` / `sqliteQuery` return
      `AsyncResult<{ rows: Row[]; withheld?: number }>` directly.
- [x] Publish `rows` and `withheld` atomically from the same provider response;
      a new pending request or failure replaces that entire value.
- [x] Map SQL, provider, CFC ceiling, row-label, decode, and writeback failures to
      `error`; map a typed row-result violation to `schema-mismatch`.
- [x] Preserve typed row-schema injection for both method and free-function
      forms, including `Cell<T>` rehydration and confidentiality labels.
- [x] Prove read-clearance per-user scoping, request identity, stale-write
      suppression, and post-commit execution remain unchanged.
- [x] Migrate call sites which currently use `result ?? []` to destructure the
      structured `resultOf()` value.

**A3 exit:** row consumers receive a structured usable value without optional
fallbacks, and the clearance audit is attached to the exact rows it describes.

## A4 — `wish`

`wish()` is not just a one-result request: candidates and its trusted UI drive
selection and profile creation. Keep `WishState<T>`, but make its resolved data
channel honest:

```typescript
// Shown for illustration only.
const noteWish = wish<Note>({ query: "#note" });
const note = resultOf(noteWish.result);

{hasError(noteWish.result) ? <span>{noteWish.result.error.message}</span> : noteWish}
```

- [x] Change `WishState<T>.result` from `T | undefined` to `AsyncResult<T>`.
- [x] Publish pending while discovery inputs or scoped indexes are still
      loading, error for a completed failed resolution, and `T` for the current
      selection.
- [x] Remove the duplicate `error` field from the new public surface after
      compatibility migration; keep `candidates` and `[UI]` independent.
- [x] Keep an empty candidates array distinct from an unresolved result. Do not
      use `[]` itself as an availability signal.
- [x] Preserve current single-match, multi-match, headless, profile-switcher,
      scope, sharing, and result-cell-link behavior.
- [x] Migrate non-null assertions and optional fallbacks to `resultOf`; explicit
      creation/error UIs guard the original result channel.

**A4 exit:** wish selection remains a state machine, but absence, loading, and
failure no longer collapse into `undefined`.

## A5 — `llmDialog`

Dialog `pending` describes an active turn, not necessarily the availability of
a previously presented structured result. Keep the dialog control object and
make its presented-result channel honestly typed, just like `wish.result`.

Current use:

```typescript
// Shown for illustration only.
const { addMessage, pending, result: rawResult } = llmDialog({
  messages,
  resultSchema: toSchema<ResearchResult>(),
});
const result = computed(() => rawResult as ResearchResult | undefined);

return (
  <>
    <cf-autostart onstart={startResearch({ addMessage })} />
    <ResearchView result={result} pendingTurn={pending} />
  </>
);
```

Proposed use:

```typescript
// Shown for illustration only.
const dialog = llmDialog<ResearchResult>({ messages });
const { addMessage, pending } = dialog;
const result = resultOf(dialog.result);

return (
  <>
    <cf-autostart onstart={startResearch({ addMessage })} />
    {hasError(dialog.result)
      ? <div>{dialog.result.error.message}</div>
      : <ResearchView result={result} pendingTurn={pending} />}
  </>
);
```

`addMessage`, `pending`, cancellation, pins, and the other dialog controls
remain on the dialog object unchanged. `pending` remains independent turn
activity; `.result` is the availability-aware presented data channel.

- [x] Add a typed dialog overload and transformer schema injection for its
      `result: AsyncResult<T>` channel.
- [x] Do not manufacture a perpetual pending result for dialogs which do not
      declare or use `presentResult`; their public type omits that channel even
      if legacy raw state remains readable internally.
- [x] Before the first presentation, expose pending while a turn can still
      produce it and error when that attempt fails terminally.
- [x] After a successful presentation, preserve that result across later active
      turns. The independent turn-activity flag and last-turn failure remain
      explicit rather than overwriting usable presented data.
- [x] Preserve message append/cancel streams, pins, flattened tools, tool-call
      availability handling, queueing, and CFC attribution.
- [x] Migrate unsafe `as T | undefined` result casts to
      `resultOf(dialog.result)`.

**A5 exit:** structured dialog results are typed and availability-aware without
conflating them with the dialog's multi-turn lifecycle.

## A6 — `streamData`

Use the same direct-final-plus-partial shape as LLM streams. The direct request
is analogous to fetch: it is pending while the stream is open, and
`resultOf(request)` is the final state of a cleanly closed stream. The partial
projection is the additional live view:

```typescript
// Shown for illustration only.
const request = streamData<Event>({ url });
const closedState = resultOf(request);
const partialRequest = partialResultOf(request);
const currentState = resultOf(partialRequest);
```

There is no implicit reconnect. A connection, HTTP, decode, or schema failure
is terminal for that request. Changing the URL, options, or inferred event
schema starts a replacement request; an unchanged failed request remains
failed.

- [x] Specify initial connect, first event, successive events, clean end,
      reconnect, request replacement, cancellation, and terminal failure.
- [x] Keep the direct request pending while the stream is open; publish the last
      event as its final result on clean close. Infinite subscriptions therefore
      use `partialResultOf()` for their event channel.
- [x] Publish each decoded event through `partialResultOf(request)`; before the
      first event that partial channel is pending.
- [x] A connection or decode failure makes the direct result an error. The
      partial channel may retain its last event only through an explicit
      `latestComplete(partialResultOf(request))`, not an implicit state wrapper.
- [x] Do not reconnect implicitly. A terminal failure remains stable until URL,
      options, or schema changes and starts a replacement request.
- [x] Add response-status validation, parser/schema mismatch handling, abort
      cleanup, and a defined final decoder flush.
- [x] Preserve sink outbox ordering, frozen request snapshots, idempotency keys,
      scope, and stale-run guards.

**A6 exit:** stream consumers use one direct final result and one explicit
intermediate projection, with no `.result` wrapper.

## A7 — Legacy `llm`, Cleanup, And Documentation

- [x] Migrate legacy `llm()` consumers to `generateTextStream()`,
      `generateObjectStream()`, or `llmDialog()` according to which auxiliary
      state they use. No authored pattern call sites remain; the integration
      patterns already use the replacement APIs.
- [x] Audit removal of the deprecated `llm()` surface. Retain it while source
      and persisted-pattern compatibility require the raw module reference; do
      not create a second DataUnavailable migration for it.
- [x] Audit compatibility `pending` / `error` fields. Retain them on raw
      persisted state while compatibility and rehydration tests require them.
- [x] Update live capability, wish, SQLite, transformer, and reactivity docs in
      the same stage as each API change.
- [x] Update the DataUnavailable spec's non-goals and status as stages land.
- [x] Archive this plan when all stages are complete.

The remaining `llm()` calls are deliberate raw-runtime, CFC, race, outbox, and
call-kind compatibility tests. They protect old graph behavior and are not
authored API consumers to migrate.

## Execution Protocol And Validation

Each API stage uses red-green testing and small commits:

1. Commit failing compile-time and runtime transition tests.
2. Commit the minimal API, transformer, and runtime implementation which makes
   them green.
3. Commit repository call-site and live-doc migrations separately.
4. Run the focused packages before the broad repository gate.

Minimum validation for every applicable stage:

```sh
deno task check-docs common
deno task check-docs specs
deno task --cwd packages/api test
deno task --cwd packages/ts-transformers test
deno task --cwd packages/schema-generator test
deno task --cwd packages/runner test
deno task --cwd packages/patterns test
deno task check
```

Inspect representative transformed output directly for every builder or method
whose public projection or generic schema injection changes:

```sh
deno task cf check <fixture>.tsx --show-transformed --no-run
```
