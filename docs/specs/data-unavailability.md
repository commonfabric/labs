# Data Unavailability Values and Propagation

## Status

Implemented, including the separately specified `latestComplete()` snapshot
helper, pending renderer continuity, and the public asynchronous result APIs.
The deprecated `llm()` state API remains only for source and persisted-graph
compatibility; new patterns use the direct generation APIs or `llmDialog<T>()`.

## Summary

The runtime represents temporarily or permanently unavailable data with the
`FabricUnavailable` FabricType instead of overloading `undefined`.

`FabricUnavailable` has three discriminated reasons:

- `"pending"`
- `"error"`
- `"syncing"`

Schema mismatch is a terminal `"error"` with `errorKind: "schemaMismatch"`.

Single-result asynchronous built-ins such as `fetchJson<T>` and
`generateObject<T>` expose an explicit `AsyncResult<T>` union: either the
usable `T` or one of the three `FabricUnavailable` variants. Authors inspect that
union with the guard helpers or project its usable view with the zero-node
`resultOf()` helper. `resultOf()` removes the unavailable variants from the
TypeScript type while leaving the reactive runtime value untouched, so a
computation which expects `T` still waits for usable data.

Before invoking a computation, the runner inspects its inputs. An unavailable
input which the computation did not explicitly opt into is copied to the
computation's output and the implementation is not called. A normal schema
failure becomes an error with `errorKind: "schemaMismatch"` instead of
`undefined`.

Patterns explicitly observe unavailable states with type guards such as
`hasError()`. A guard over an `AsyncResult<T>` is already type-correct inside
an explicit `computed()` or `lift()`; the transformer uses the guard and
visible union to emit the corresponding runner input policy. Ordinary fetch and
generation code retains and guards the original `AsyncResult<T>`.
`observeAvailability()` is an almost-never-needed compatibility escape hatch
for a legacy or encapsulated boundary which exposes only `T`, may carry a
propagated unavailable value at runtime, and cannot yet be changed to expose the
originating request or an honest availability union.

## Goals

- Stop using `undefined` as an implicit pending, error, syncing, or invalid
  input signal.
- Make the unavailable union explicit at asynchronous request boundaries while
  letting ordinary dataflow project a required `T` once with `resultOf()`.
- Propagate unavailable values through computations without invoking code on
  inputs that do not satisfy its authored contract.
- Let patterns selectively observe error, pending, syncing, or schema mismatch
  states with normal TypeScript narrowing.
- Preserve unavailable states across cells, spaces, storage, and runtime
  boundaries using the FabricType codec protocol.
- Make selection deterministic when more than one input is unavailable.

## Non-goals

- Accumulating every unavailable input or attaching argument positions to a
  combined error.
- Replacing thrown programming errors inside a computation. Exceptions thrown
  by invoked code keep their existing error behavior.
- Changing the meaning of authored `undefined`. It remains a first-class
  `FabricValue` and is valid whenever the declared schema admits it.
- Flattening stateful, multi-channel APIs such as `wish` and `llmDialog` into a
  single result. Their state objects remain, while each data-bearing result
  channel migrates to `AsyncResult<T>` in its own stage.
- Automatically reconnecting `streamData`. A connection or decoding failure is
  terminal for the current request; changing a request input starts a new one.
- Defining a general JSON Schema vocabulary for every FabricType. This design
  uses a narrower, path-scoped runner policy for control signals.
- Adding implicit last-value continuity to asynchronous results. Continuity is
  opt-in through `latestComplete()` so ordinary `resultOf()` dataflow continues
  to propagate the current unavailable state.

## System Model

The design spans four behaviors.

1. The data model's canonical `FabricUnavailable` primitive can be stored and
   transported as a `FabricValue` through the existing codec protocol.
2. Default fetch, generation, streaming generation, external data streaming,
   and compilation built-ins return availability-aware results. Streaming
   intermediate output is exposed through a zero-node projection rather than a
   public state wrapper.
3. A JavaScript action whose input does not match its `argumentSchema` is not
   invoked; its output becomes `new FabricUnavailable("error", "schemaMismatch")`.
4. `computed()` is lowered to a lift with generated argument and result
   schemas. Captured values therefore have a concrete schema boundary even
   though authored `Reactive<T>` is represented as `T` in TypeScript.

The native `FabricUnavailable` schema identifies the primitive. Schema admission
does not authorize a computation to observe it: the exact-path runner policy
specified below decides whether an unavailable input is propagated or observed.

## The `FabricUnavailable` FabricType

### One class, discriminated state

`FabricUnavailable` is a canonical `FabricPrimitive`, not a `FabricInstance` or
a subclass hierarchy. The data model owns its construction, encoding, equality,
hashing, and immutable state. Runtime integration adds no second marker codec.

```typescript
// Shown for illustration only.
type UnavailableObservationKind =
  | "pending"
  | "error"
  | "syncing"
  | "schemaMismatch";

type FabricUnavailableState =
  | { reason: "pending" }
  | { reason: "syncing" }
  | {
    reason: "error";
    errorKind: UnavailableErrorKind;
    errorMessage: string;
  };
```

The native schema is `{ type: "FabricUnavailable" }`; structural object arms
do not authenticate a marker. `UNAVAILABLE_PENDING` and `UNAVAILABLE_SYNCING`
are shared prefab instances. Error markers carry an error kind and message,
not an embedded `Error` or `FabricError`. Consumers propagate the same instance
to preserve the producer's classification and avoid value churn.

The `"schemaMismatch"` error intentionally carries no expected schema,
actual value, or input path. Those details are large, can contain sensitive
data, and are not useful until an API can report multiple positions. Producers
retain a useful validation message when one is available without embedding the
failed payload or schema. Detailed runner diagnostics remain out of band.

### Pattern-visible shape

The pattern API exposes the native `FabricUnavailable` constructor alongside
its type. Both authored native instances and runtime-produced markers are
recognized by their nominal primitive identity. A plain structural lookalike
does not become an availability control signal.

```typescript
// Shown for illustration only.
type IsPending = FabricUnavailable & {
  readonly reason: "pending";
};

type HasError = FabricUnavailable & {
  readonly reason: "error";
  readonly errorKind: UnavailableErrorKind;
  readonly errorMessage: string;
};

type IsSyncing = FabricUnavailable & {
  readonly reason: "syncing";
};

type HasSchemaMismatch = HasError & {
  readonly errorKind: "schemaMismatch";
};

type UnavailableVariant =
  | IsPending
  | HasError
  | IsSyncing;
```

The primitive methods `isPending()`, `isSyncing()`, and `isError()` inspect its
discriminator. Pattern guards narrow the corresponding aliases. `hasError()`
accepts every terminal error kind; `hasSchemaMismatch()` accepts only the
schema-mismatch subset. The observation-policy token `"schemaMismatch"` names
that subset, not a fourth wire reason.

Only an actual decoded or runtime-created `FabricUnavailable` instance is a
control signal. A plain object such as `{ reason: "pending" }` is ordinary user
data.

## Authoring Contract

### Explicit asynchronous results

The pattern API names the union at asynchronous request boundaries:

```typescript
// Shown for illustration only.
type AsyncResult<T> = T | UnavailableVariant;
```

The final public signatures of single-result built-ins are:

| Built-in | Authored return type |
|----------|----------------------|
| `fetchBinary(...)` | `AsyncResult<FetchBinaryResult>` |
| `fetchText(...)` | `AsyncResult<string>` |
| `fetchJson<T>(...)` | `AsyncResult<T>` |
| `fetchJsonUnchecked(...)` | `AsyncResult<any>` |
| `fetchProgram(...)` | `AsyncResult<FetchedProgram>` |
| `generateText(...)` | `AsyncResult<string>` |
| `generateObject<T>(...)` | `AsyncResult<T>` |
| `generateTextStream(...)` | `AsyncResult<string>` |
| `generateObjectStream<T>(...)` | `AsyncResult<T>` |
| `compileAndRun<Input, Output>(...)` | `CompileResult<Output>` |

TypeScript reduces `any | X` to `any` and `unknown | X` to `unknown`.
Consequently, `fetchJsonUnchecked()` and unconstrained generic helpers cannot
preserve visible union members through their static type alone. Transformer
analysis retains resolved built-in and `resultOf()` source provenance for those
cases; authors should prefer typed `fetchJson<T>()` when narrowing matters.

The explicit union makes guard calls, editor completion, generic helpers, and
function boundaries honest about the current value. It does not require every
consumer to handle every state. The zero-node `resultOf()` helper projects the
usable member:

```typescript
// Shown for illustration only.
type ResultValue<R> = Exclude<R, UnavailableVariant>;
declare function resultOf<R>(value: R): ResultValue<R>;
```

Typing the whole argument and excluding marker members avoids generic inference
re-inferring a marker arm as part of `T`; it also works for aliases and wider
unions. Semantically, `resultOf()`:

- is a pure runtime identity and allocates no graph node;
- removes all `UnavailableVariant` members from the static type;
- does not accept or consume an unavailable runtime value; and
- leaves downstream runner preflight to propagate the marker without invoking
  a computation which expects the usable type.

There is deliberately no positive `isResult()` guard. A useful positive guard
would have to accept every unavailable reason at its computation boundary so
that it could return `false`; it would therefore be an accept-all observation
operation disguised as a simple success predicate. `resultOf()` expresses the
common "wait for usable data" path, while reason-specific guards make explicit
which unavailable states a computation can observe.

A public accept-all `isUnavailable()` guard remains a possible follow-up for
code which genuinely treats every reason alike. It is not part of v1 because
reason-specific guards keep policies narrower, and the migration did not yet
establish enough authoring demand to fix its name and status-projection
semantics.

An ordinary pattern establishes separate state and usable views:

```tsx
// Shown for illustration only.
const repoState = fetchJson<Repo>({ url });
const repo = resultOf(repoState);
const title = computed(() => `${repo.owner.login}/${repo.name}`);
```

While the fetch is pending, the title computation is not called. Its output is
also pending. Once `repoState` contains a `Repo`, `repo` is that same value and
the computation runs.

`resultOf()` is a transparent reactive alias. If both aliases are used by one
generated computation, the transformer must canonicalize them to the same
reactive source, or otherwise share their availability policy. It must not
serialize the same marker as an accepted `repoState` input and an unaccepted
second `repo` input. This common pattern must work:

```tsx
// Shown for illustration only.
const repoState = fetchJson<Repo>({ url });
const repo = resultOf(repoState);

return isPending(repoState)
  ? <div>Loading repository...</div>
  : hasError(repoState)
    ? <div>Error: {repoState.errorMessage}</div>
    : <RepoCard url={repo.url} name={repo.name} />;
```

This computation accepts pending and every error kind, including schema
mismatch. Syncing continues to propagate without rendering any branch.

### Type guards

The public guard helpers are pure predicates:

```typescript
// Shown for illustration only.
declare function isPending(value: unknown): value is IsPending;
declare function hasError(value: unknown): value is HasError;
declare function isSyncing(value: unknown): value is IsSyncing;
declare function hasSchemaMismatch(
  value: unknown,
): value is HasSchemaMismatch;
```

They check both the concrete `FabricUnavailable` brand and its `reason`. They do
not accept structurally similar plain objects.

In pattern-owned reactive code, the transformer lifts a guard call when
necessary and records that the synthesized node accepts the corresponding
reason. Other reasons still propagate through that node.

```tsx
// Shown for illustration only.
const repoState = fetchJson<Repo>({ url });

return hasError(repoState)
  ? <div class="error">Error: {repoState.errorMessage}</div>
  : <RepoCard repo={resultOf(repoState)} />;
```

The guard computation runs for a usable `Repo` and for an error. It returns
`false` for the former and `true` for every error kind, including schema
mismatch. Pending and syncing propagate instead of being turned into `false`.

### Explicit observation inside `computed()` and `lift()`

An `AsyncResult<T>` already carries its unavailable variants in TypeScript.
When a guard over that union appears inside an explicit computation, the
transformer widens no type: it preserves the union in the outer callback
argument schema and emits exact policy for the reasons tested by the guards.

```tsx
// Shown for illustration only.
const repoState = fetchJson<Repo>({ url });

const content = computed(() =>
  isPending(repoState)
    ? <div>Loading repository...</div>
    : hasError(repoState)
      ? <div>Error: {repoState.errorMessage}</div>
      : <RepoCard repo={resultOf(repoState)} />
);
```

The computation accepts pending and error because both are visible union
members and both have explicit guards. Syncing still propagates at its outer
boundary; schema mismatch is an accepted error kind.

#### Almost-never-needed legacy escape hatch

An unavailable runtime value can cross a legacy or encapsulated reactive
boundary whose static contract is only `T`. The originating `AsyncResult<T>`
may be private to another piece or otherwise unavailable to the consumer. If
that boundary cannot yet be corrected to expose an honest availability union,
a later computation has no type-level indication that its plain input might be
an unavailable marker. Its body would be skipped before a guard inside it could
run.

`observeAvailability()` is a zero-node, identity cast used outside that
boundary. It widens the TypeScript type and records the exact unavailable
reasons accepted at that captured input path. Almost no pattern should call it:
it exists only for migration adapters where the static type is plain `T`, the
originating request is inaccessible, and the upstream contract cannot yet be
corrected.

```typescript
// Shown for illustration only.
declare function observeAvailability<T>(
  value: T,
): T | FabricUnavailable;

declare function observeAvailability<
  T,
  K extends UnavailableObservationKind,
>(value: T, ...reasons: K[]): T | UnavailableFor<K>;
```

For example, this adapter receives a label from an older piece whose public
contract cannot yet be changed. The label is statically `string`, the
originating request is not exposed, and the linked value may carry a propagated
error at runtime:

```typescript
// Shown for illustration only.
// input.label is linked from a legacy or encapsulated piece.
const labelOrError = observeAvailability(input.label, "error");

const displayLabel = computed(() =>
  hasError(labelOrError)
    ? `Unavailable: ${labelOrError.errorMessage}`
    : labelOrError
);
```

Here the generated computation accepts `string | HasError`, including errors
whose kind is `schemaMismatch`. Pending and syncing propagate without invoking
the callback. If
the adapter owns the upstream contract, the preferred fix is to expose
`AsyncResult<string>` (or the original request) and remove the cast.

It should be absent from ordinary request/result code: retain and guard the
original `AsyncResult<T>`, or use `resultOf()` when the consumer only waits for
usable data.

Calling `observeAvailability(value)` without reasons accepts all three variants.
That broad form is intended only for generic diagnostic or compatibility
adapters. Callers should prefer a reason list when they only need selected
states.

`observeAvailability()` must be outside the explicit `computed()` or `lift()`
whose boundary it changes. The transformer reports an authoring diagnostic if
it appears inside that callback. It also reports a targeted diagnostic when a
guard inside a callback refers to an input that was not widened outside:

```text
hasError() observes an unavailable input inside computed(), but this input
is statically usable data. Guard the original AsyncResult, or move
observeAvailability(value, "error") outside the computed() and capture the
widened value.
```

The guard is the policy signal when its operand visibly includes the requested
variant. Observation provenance is the policy signal when the operand is
statically plain data. Both survive aliases and later transformer-generated
computed blocks and keep runtime policy reviewable in the serialized module.

### Guards are not factories

The guard helpers are regular, pure functions at execution time. They are not
node factories themselves. Pattern-context lowering may synthesize a lift
around a reactive guard expression, just as it does for other reactive
expressions, but a guard encountered inside an existing compute remains the
same pure call.

Purity alone is not sufficient. If the source operand is statically only `T`,
calling a type predicate does not widen the generated lift's capture, so the
transformer must attach `T | <probed variant>` before it analyzes and lowers
the capture. The latter case conceptually lowers to:

```typescript
// Shown for illustration only.
lift<{ value: Repo | HasError }, boolean>(
  ({ value }) => hasError(value),
)({ value: repo });
```

The concrete lowering also supplies the generated argument and result schemas
and the path policy. A callback which only passes the operand to availability
guards needs the reached root's identity, not the successful value's contents.
Capability shrinking therefore emits an opaque `unknown` schema at that path.
Preflight follows links to the root and checks its concrete marker, while a
successful value reaches the pure predicate as an opaque presence value. If
the callback also reads the successful value, that structural use cancels the
identity-only optimization and retains the usable structural schema its reads
require.

Whether the union came from `AsyncResult<T>` or synthetic widening, the
artifacts must agree:

- the lift input type includes `Repo | HasError`;
- the input schema materializes either the usable structure the callback reads
  or, for a guard-only path, its opaque reached root;
- the path policy authorizes only the `"error"` marker at `value`.

Without the widened lift input type and matching path policy, runner preflight
would reject the error before the pure predicate could run. The widening
applies only to the probed operand path, not to every capture of the synthesized
lift.

This removes the need to rewrite a factory call to a differently named runtime
predicate inside `computed()`. The transformer still gives the guard calls a
dedicated classification so it can attach availability policy and diagnostics.

## Transformer and Serialized Graph Contract

### Path-scoped unavailable input policy

Modules gain serialized, path-scoped metadata describing which unavailable
reasons their implementations may observe.

```typescript
// Shown for illustration only.
type UnavailableInputPolicy = readonly {
  path: readonly string[];
  reasons: readonly UnavailableObservationKind[];
}[];
```

For a computation which tests `hasError(repoState)`, the generated lift
contains policy equivalent to:

```json
[
  { "path": ["repoState"], "reasons": ["error"] }
]
```

Paths are relative to the module argument. A policy applies to the exact value
at that path; it does not implicitly accept markers anywhere below a container.
This avoids accidentally swallowing an unavailable list element because a
caller observed the list itself.

The path must also be statically stable. A helper guard over
`requests[index]` inside an existing computation cannot name the selected
capture path in serialized metadata. The transformer diagnoses that form with
`availability:unobserved-compute-guard`; authors hoist the dynamic selection to
pattern context and capture the resulting stable alias. Policy remains
capture-granular: a captured projected result gates the whole computation even
when the branch the author expected to take would not read it.

The policy, not a structural schema match, authorizes the callback to receive a
control value. The generated lift input type always includes the widened
TypeScript union. Its schema retains the usable structural paths when the
callback also reads the successful value, while a guard-only path emits the
opaque reached-root schema described above. Source-union schemas retain native
`{ type: "FabricUnavailable" }` arms, which identify the canonical primitive
rather than arbitrary structural lookalikes. The runner separately checks reason
and error kind against the exact-path observation policy.

### Transformer behavior

The transformer must:

1. Classify the four guards, `resultOf()`, and `observeAvailability()` by
   resolved `commonfabric` symbol, including aliased imports.
2. Preserve TypeScript's original type-predicate narrowing in both branches.
3. Treat `resultOf()` as an identity reactive alias which removes unavailable
   members only from the static usable view. It emits no node and no input
   policy by itself.
4. Canonicalize a `resultOf(source)` alias with `source` when both appear in one
   generated computation. A guard policy on `source` must not be defeated by a
   duplicate unaccepted capture introduced for the usable alias.
5. When a guard inside an existing compute probes an operand whose static type
   includes that variant, preserve the union in the outer argument schema and
   emit exact policy for the guard reason.
6. Treat `observeAvailability()` as an identity reactive alias and retain its
   source reactive path. For a statically plain input, widen the captured type
   and schema for the selected variants before schema injection.
7. For a guard expression in pattern context over a statically plain `T`,
   attach `T | <probed variant>` to only the probed capture of the synthesized
   computation.
8. Emit exact-path unavailable input policy on the owning module. A path used
   only as a guard operand is identity-only and receives an opaque input
   schema; any structural use of the successful value retains its complete
   schema.
9. Leave every guard as the same pure runtime call; no factory-to-predicate
   rewrite is needed.
10. Preserve alias provenance, types, and policy through closure hoisting,
    module serialization, reload, and nested transformer-generated computed
    blocks.

The transformer must not widen every input or every computation merely because
one availability helper appears somewhere in a pattern.

## Runner Semantics

### Input preflight

Availability preflight occurs after node bindings can be resolved but before
the implementation argument is materialized through `argumentSchema`.

For every value-producing node run, the runner performs these steps:

1. Walk the bound inputs in deterministic argument order, following the same
   links and opaque-reference boundaries the argument read would follow.
2. Record every concrete `FabricUnavailable` value and its argument-relative
   path.
3. Remove from consideration only markers whose exact path policy accepts
   their reason.
4. If any unaccepted markers remain, select one by the precedence rule below,
   write that same value to the node output, and do not invoke the
   implementation.
5. Otherwise materialize the argument against `argumentSchema`, retaining the
   exact accepted marker values and paths from preflight.
6. If materialization fails for a locally complete value, write the interned
   schema-mismatch error value and do not invoke the
   implementation.
7. If the argument is valid, carry each accepted branded marker through the
   lazy schema view at its exact path, then invoke the implementation normally.
   Accepted unavailable values are now ordinary inputs to that implementation.

This preflight must happen before ordinary object schema matching. Otherwise an
object-shaped `T` could accidentally accept the opaque FabricType leaf and run
without an explicit policy.

A clean preflight does not subscribe a schema-less legacy callback to inputs
it never reads. Its ordinary argument reads establish reactive dependencies.
An explicit `false` argument schema retains its validation-bypass behavior and
passes `undefined` to the callback. Both boundaries propagate a concrete marker
already present during preflight without invoking the callback.

An opaque schema position still checks the concrete value at its reached root.
Preflight does not descend below a normal root at that position, because
ordinary materialization does not expose that subtree to the implementation.
It does preserve and classify a `FabricUnavailable` root before returning.

Step 7 preserves the exact canonical primitive through the lazy schema view.
Schema traversal validates the surrounding usable shape without eagerly cloning
containers or reading branches the implementation never accesses. Local read
coverage and CFC refusal checks precede marker preservation.

A child value read whose ancestor holds a native `FabricUnavailable` preserves
that marker rather than reporting a schema mismatch for the child. The ancestor
is a normal value read, with the transaction's read ceiling and metadata, and
the returned value retains the requested child's logical address. This does not
turn a reference-only link probe into an observation of the ancestor's content.
Ordinary primitive ancestors still produce the usual path mismatch.

The result write caused by propagation must perform the same scope and CFC
bookkeeping as a normal computation result. In particular, an error message is
data derived from the input and must not bypass input label propagation merely
because the callback was skipped.

### Syncing versus schema mismatch

A value that is known not to be locally available yet produces `"syncing"`,
not `"schemaMismatch"`. A value that is locally complete but does not satisfy
the declared schema produces `"schemaMismatch"`.

The runner therefore needs a readiness result which distinguishes:

- a covered, present `undefined` value;
- a missing or invalid value after synchronization; and
- a value whose required storage coverage is still synchronizing.

Existing first-run deferral may prevent many syncing values from being
observable, but it is not a substitute for this distinction at every read
boundary.

### Precedence and tie-breaking

When more than one unaccepted input is unavailable, the selected reason is:

```text
error > pending > syncing
```

Accepted markers do not participate in selection. Among markers with the same
reason, the first marker in deterministic argument order wins.

Argument order is the serialized input-binding order. Arrays are visited by
increasing index and object bindings by their serialized property order. The
walk is depth-first and cycle-safe. This is deterministic across reloads and
matches the author's visible argument construction more closely than sorting
paths alphabetically.

V1 does not accumulate markers. If later usage shows that callers need every
failure, a separate aggregate variant can include paths and positions without
changing the deterministic single-marker rule.

The preflight walk is depth-first, cycle-safe, and bounded by the serialized
input tree. It stops at opaque schema positions; other value computations and
handler readiness checks still pay the remaining walk on each run. Read
metadata is shared so schema-less modules do not perform duplicate effective
reads; that does not eliminate traversal cost. Add a representative wide/deep
input benchmark before expanding the walk or introducing more
availability-aware boundaries, and optimize only with measured evidence.

### Nodes with no value output

An event handler or effect with no value output cannot propagate a marker.
Transient and terminal reasons therefore have different queue behavior.

For `pending` and `syncing`, an unavailable captured input, including a mutable
capture, gates the event before dispatch. The original queued event remains at
the head of the global FIFO queue, and later events remain behind it. The
handler is not invoked, no event transaction or receipt is produced, and its
`onCommit` callback does not fire. The scheduler waits on the captured reads;
when they change, it rechecks the same event and dispatches it once the inputs
are usable.

An input-parked head is scheduler-quiescent: `runtime.idle()` resolves while it
waits. Fetch, generation, and mutex producers may themselves await idle before
publishing the value that wakes the handler, so including the input park in
idle would create a producer/consumer deadlock. Opt-in
`scheduler.event.preflight` telemetry reports the parked reason and queue depth
with `skipped: true`.

Terminal `error` inputs, including `errorKind: "schemaMismatch"`, do not park. They dispatch
through ordinary argument validation, suppress the invalid handler invocation,
and drop the event with an explicit terminal failure so later queue entries can
proceed. Client commit callbacks receive a transaction in error; served events
retain their dropped disposition. They remain
observable at value-producing computation boundaries where a guard or
propagated output can represent them.

The immutable `$event` payload is deliberately excluded from that wait. A
malformed event cannot become valid while queued, so it is dispatched through
ordinary argument validation and settled as that event's final dropped outcome.
It must be removed from the queue and settle its `onCommit` callback so it
cannot deadlock later events.

A bound `Writable<T>` or Cell is also excluded from value gating. The handle is
a usable capability even when the value it points to is currently unavailable;
the handler runs and reads that state with `.get()`. Binding a plain `T`
requests snapshot semantics and participates in the transient wait above.

An effect which also owns a data result, including a fetch or generation
built-in, does propagate an unavailable input to that result while suppressing
the external effect. Scheduler classification as an effect must not by itself
disable value propagation.

Container operators apply the rule at their actual compute boundary. If the
entire list input is unavailable, the entire output is unavailable. If a
mapped element is unavailable, that element's sub-computation propagates the
marker to the corresponding result position.

## Renderer Semantics

Renderer reads do not pass through a value-producing computation, so the HTML
renderers recognize concrete `FabricUnavailable` values directly. An unavailable
root or child contributes no visible content before its first usable value.
After a usable value has rendered, a `pending` update preserves the last
rendered subtree until another usable value arrives. The retained element is
marked `data-cf-pending`, made `inert`, and exposed as `aria-busy`. The HTML
renderer owns those semantics; the enclosing `cf-render` owns their visual
treatment in its static shadow-root stylesheet. It dims the subtree using the
inherited `--cf-render-pending-opacity` and `--cf-render-pending-filter`
component properties, so a theme host can refine the presentation without
runtime style injection or inline-style mutation. Nested pending sources receive
one visual treatment per rendered branch. A retained text node protects its
authored parent element, keeping a control with a pending direct text label
inert. The parent remains pending until every text and element source
protecting it recovers or is removed. Text rendered directly into the host
container is retained without marking that unrelated container. The marker is
never stringified as `{}` and is not reported as invalid VDOM.

`error`, `syncing`, and `schemaMismatch` do not retain prior content. They
contribute no visible content unless the authored expression explicitly
observes the reason and renders a corresponding branch.

Authored `undefined` remains ordinary empty render content, not a suspense
signal. It contributes no visible content initially, and a transition from a
visible value to `undefined` removes that visible content instead of preserving
it.

An individual reactive DOM prop also treats an unobserved `FabricUnavailable` as
a withheld update: the prop remains unset before its first usable value and
retains its last usable value afterward. Availability markers never cross the
renderer IPC boundary as prop values. This is prop-level waiting, not subtree
pending continuity, so it does not add `data-cf-pending`, `inert`, or the dimmed
pending treatment to the element.

This pending continuity behavior is the unguarded default, not a loading UI.
Authors use the reason-specific guards when the interface should replace the
prior subtree with explicit status content. Confidentiality and integrity
render policy checks run before pending preservation, so a pending update
cannot retain content which has become disallowed.

## Asynchronous Built-in State Machines

### Direct output transitions

A single-result asynchronous built-in owns one direct value output. Its
observable transitions are:

| Situation | Output |
|-----------|--------|
| Required stored state is still loading | `new FabricUnavailable("syncing")` |
| A valid request is scheduled or in flight | `new FabricUnavailable("pending")` |
| The operation succeeds | `T` |
| Network, HTTP, provider, or execution failure | `new FabricUnavailable("error", kind, message)` |
| A response does not match its declared result schema | `new FabricUnavailable("error", "schemaMismatch")` |
| An input is unavailable | Propagated input marker |
| A locally complete input fails its schema | `new FabricUnavailable("error", "schemaMismatch")` |
| A hand-checked request omits a required parameter | `new FabricUnavailable("error", "invalidInput", message)` |

When inputs change, the built-in must replace any stale successful result with
the new pending or propagated state in the same logical transition. Consumers
must never observe the old `T` as the result for new inputs.

`pending` and `syncing` are serializable so they can cross cells and replicas,
but they are not terminal cache hits. On resume, the producer reconciles a
persisted transient marker against its request and synchronization state.
`error` remains stable until inputs change or the operation is retried.

`generateObject<T>()` validates successful provider output strictly against
the declared result schema. A violation writes `schemaMismatch`, does not
auto-retry until inputs change, and logs the detailed validation failure through
the `generateObject` debug logger because the public marker intentionally
carries no schema or payload detail.

Resume reconciliation must preserve a persisted unavailable marker while an
input list is still transiently absent; `map`, `filter`, and `flatMap` must not
replace it with a fabricated empty list. A linked-document provider failure
becomes a retained terminal `error` for subsequent demand
rather than leaving an unwakeable `syncing` value while the target space's
storage connection remains ready. A declared storage disconnect parks pending
linked-document loads at `syncing`. No retry timer guesses when connectivity
has returned. When that space
publishes a new ready epoch after session restoration, the runtime invalidates
both parked loads and prior terminal linked-load errors, then wakes their live
consumers for a fresh load. Initial connection establishment is not
a reconnect and does not invalidate an in-flight load. A new ready epoch also
invalidates errors retained from an initially refused session once an
authenticated access-admission retry succeeds; no disconnected session is
required for that recovery.

### Streaming generation

`generateTextStream()` and `generateObjectStream<T>()` return their final
`AsyncResult<T>` directly, like their non-streaming counterparts. The request
also has an associated usable intermediate-text projection selected with
`partialResultOf()`:

```typescript
// Shown for illustration only.
const request = generateTextStream({ prompt });
const finalText = resultOf(request);
const partialText = partialResultOf(request);
```

`partialResultOf()` is a zero-node usable projection. Its authoring type is the
partial value itself, while the underlying channel remains pending until the
first provider text arrives and downstream computations wait at their normal
availability boundary. A replacement request clears the channel back to
pending atomically, and a terminal failure is also published to the original
request. Availability guards therefore stay on the original request rather
than the partial projection. Direct object generation may produce no
intermediate text; in that case its partial projection remains unavailable
while the final object becomes usable. The object API never casts incomplete
provider text to `Partial<T>`.

The zero-node association is currently local to the pattern body containing the
direct streaming call (or a stable const alias of it). Project the partial value
there and bind it to a standalone `const` before deriving values from it or
capturing it in `computed()`, `lift()`, an action, or a handler;
inside those boundaries the argument is already the materialized final value.
Returning an `AsyncStreamResult` from a subpattern preserves its final result
but not the separate partial channel, so the transformer rejects
`partialResultOf(child.request)` instead of allowing a runtime failure. If a
composed parent needs partial output, have the child project and return
`partialResultOf(request)` as a separate field.

The persisted operation state still contains pending, result, error, partial,
messages, grounding sources, and request hashes as applicable. Those fields are
runtime implementation detail rather than a public state wrapper. Repository
use does not currently justify public metadata projections; a future metadata
use should add a narrowly named zero-node helper instead of restoring `.result`
and sibling state fields.

### Streaming external data

`streamData<T>()` uses the same direct-final-plus-partial shape as streaming
generation. `T` is the complete decoded server-sent event shape, and the
transformer injects its schema into the request:

```typescript
// Shown for illustration only.
type Event = {
  id: string;
  event: string;
  data: { progress: number };
};

const request = streamData<Event>({ url });
const closedEvent = resultOf(request);
const currentEvent = partialResultOf(request);
```

Both channels begin pending. Each decoded event updates only the partial
channel while the direct request remains pending. A clean close publishes the
last decoded event as the direct final result; a clean close before any event is
an error. A stream intended never to close consumes only the partial channel.

HTTP, connection, malformed-event, and JSON decode failures publish the same
terminal `error` marker to both channels. An event which does not match the
schema inferred from `T` publishes `schemaMismatch` to both. There is no
implicit reconnect. Changing the URL, request options, or inferred schema
atomically resets both channels to pending, aborts the old request, and starts a
new one. Stale reads from the replaced request cannot publish. Callers which
need the last usable partial event across pending or failure explicitly use
the projected partial alias:

```typescript
// Shown for illustration only.
const currentEvent = partialResultOf(request);
const lastUsableEvent = latestComplete(currentEvent);
```

Newly compiled graphs use a versioned direct-result module reference. The
legacy `streamData` module reference and raw `{ pending, result, error }` shape
remain readable for persisted graphs; the public API exposes neither that state
object nor implicit continuity.

`llmDialog` remains a multi-channel state object. A typed
`llmDialog<T>()` adds `result: AsyncResult<T>` and an inferred `presentResult`
tool schema. That result is pending before the first presentation and becomes
an error if the first producing turn fails terminally. Once a value has been
presented, later active or failed turns retain it; `pending` and `error` report
the independent turn lifecycle. An untyped control-only dialog has no public
result channel and does not manufacture a result marker. Cancellation, message,
pinning, flattened-tool, queueing, and CFC behavior are unchanged.

Legacy persisted generation state may contain `{ pending: false, error }`
without explicit result or partial markers. Internal state schemas continue to
materialize that shape until reconciliation; the runtime upgrades both channels
without retrying the provider. New producers always write explicit availability
markers. A child generation used by `llmDialog` waits only for transient
pending/syncing states and fails the tool call immediately for error or schema
mismatch instead of consuming the full tool timeout.

### Dynamic compilation

`compileAndRun<Input, Output>()` returns its live compiled-pattern result
directly. Its `CompileResult<Output>` contract is an `AsyncResult<Output>`.
Compiler-produced failures carry `errorKind: "compile"` and a diagnostic
message; upstream unavailable inputs and schema-mismatch errors retain their
original kinds:

```typescript
// Shown for illustration only.
const compileRequest = compileAndRun<Input, Output>({ files, main, input });
const output = resultOf(compileRequest);
const diagnostics = compileDiagnosticsOf(compileRequest);

const message = hasError(compileRequest)
  ? compileRequest.errorMessage
  : undefined;
```

A valid program request becomes pending before compilation begins and the live
result link replaces that marker once the compiled pattern starts. Invalid
program parameters produce `errorKind: "invalidInput"`; missing entrypoints, compiler
diagnostics, and other compilation failures produce `error`. Every compile
failure carries a message. `compileDiagnosticsOf(compileRequest)` exposes the
live sibling diagnostics cell without creating a node. It contains structured
compiler diagnostics on a diagnostic failure and is `undefined` while compiling,
after success, or for failures without compiler diagnostics. Call it in the
producer's pattern body on a direct request or a stable const alias. Export the
diagnostics separately across subpattern boundaries; calling the accessor on a
composed or materialized result is a compile-time error.
Bind its result to a standalone const before deriving values from diagnostics;
inline operations on the accessor result are rejected because they would move
the lookup into an implicitly generated computation.
Unavailable `files`, `main`, or `input` values propagate unchanged and
the compiler is not invoked.

The persisted raw builtin state still contains `pending`, `result`, `error`,
and `errors` for persisted compiled graphs. The public factory creates one raw
compilation node and associates its result projection with the sibling errors
projection. No additional reactive node or duplicate state is created.

### SQLite queries

`db.query<Row>()` and `sqliteQuery<Row>()` return one direct
`AsyncResult<SqliteQueryResult<Row>>`. A successful value contains the rows and
the clearance audit produced with them:

```typescript
// Shown for illustration only.
const queryRequest = db.query<Row>(sql, {
  reactOn: db,
  readClearance: true,
});
const { rows, withheld } = resultOf(queryRequest);
```

`rows` and `withheld` are published atomically. A replacement request clears
that entire value to pending; SQL, provider, CFC, row-label, decode, and
writeback failures publish `error`. A provider row which violates the
transformer-injected `Row` schema publishes `schemaMismatch`. Unavailable
inputs propagate before a query is issued.

The `Row` schema still drives typed `_cf_link` decoding and CFC field labels.
An `asCell` column is validated as its decoded link transport object rather
than as an embedded copy of the linked value; ordinary row fields remain
validated against their declared schemas.

Legacy compiled graphs continue to use the persisted `{ pending, result,
error, withheld }` state and the original `sqliteQuery` module ref. Newly
transformed graphs use a versioned module ref which projects the atomic value
channel directly, without adding a second reactive node.

## `latestComplete()` Snapshot Helper

`resultOf()` is stateless: whenever its source is unavailable, an ordinary
consumer also becomes unavailable. The `latestComplete()` built-in provides
the complementary continuity primitive. It publishes atomic snapshots only
when its entire schema-declared input is usable, then retains the most recent
complete snapshot while any current input is unavailable.

```typescript
// Shown for illustration only.
const repo = latestComplete(repoRequest);

const { repo, ticket, variable } = latestComplete({
  repo: repoRequest,
  ticket: ticketRequest,
  variable: regularReactiveCell,
});
```

The second form is an availability join. A new value of
`regularReactiveCell` is not copied while either request is unavailable. Once
all three fields are usable, the built-in publishes one new object containing
values from that same coherent read. It never constructs a snapshot by mixing
fields from different complete moments.

The state transitions are:

| Situation | Output |
|-----------|--------|
| No complete snapshot has been published | Interned pending marker |
| The complete input materializes against its usable schema | Atomically copied schema-materialized value |
| Any current input is unavailable or does not materialize | Prior output remains unchanged |
| Inputs later become complete again | Entire snapshot is replaced atomically |

This helper intentionally retains the prior snapshot for every unavailable
reason, including error and schema mismatch. Code which needs the current
failure continues to inspect the original request values. Before the first
complete snapshot, those details are intentionally collapsed to pending.

`latestComplete()` is stateful and creates a built-in node; it is not an
identity cast. Its authored return type is the recursively usable input shape,
which permits direct property access and destructuring. The runtime output may
carry the initial pending marker, and ordinary runner propagation gates its
consumers until the first snapshot.

The transformer injects one schema derived from the TypeScript input type. It
recursively removes `FabricUnavailable` and all three concrete unavailable
variants from unions at every schema path. The same stripped schema governs:

- the built-in's schema-aware input read;
- the exact value copied to the snapshot output; and
- the authored usable return type and output schema.

At runtime the implementation performs a status-bearing read through that
schema. On success it writes the materialized value to the existing output
cell with normal scope and CFC derivation. On unavailable, synchronizing, or
schema-invalid input it performs no write once a snapshot exists. A valid
authored `undefined` must remain distinguishable from a failed read when the
stripped schema admits `undefined`.

The node's result cell is the sole persisted snapshot. The output binding points
to that cell; there is no second hidden cache. Rehydration distinguishes an
absent snapshot from a stored valid `undefined` with a non-reactive,
non-tainting presence read. The initial pending write makes a later complete
`undefined` an explicit stored value rather than an unwritten output.

It is the intended follow-up for the ecosystem's previous
`request.result ?? priorValue` continuity idiom. `resultOf()` alone deliberately
exposes current unavailability to downstream preflight; use `latestComplete()`
only when retaining a coherent prior value is the desired behavior.

## Deferred Authoring Views

Some pattern outputs expose loading and failure as ordinary data rather than
using them only for internal control flow. The initial migration keeps those
contracts explicit, even when that means locally projecting an
`AsyncResult<T>` into `{ pending, result, error }`. A blessed status-projection
view and an accept-all `isUnavailable()` guard are deferred until the repeated
boundary use cases establish whether one helper should cover both. They must
not be confused with `latestComplete()`, which is a stateful coherent snapshot
and intentionally hides current failures behind the last complete value.

## Error Semantics

`new FabricUnavailable("error", kind, message)` represents a failed producer or effect. Its
`errorKind` classifies the failure and `errorMessage` carries diagnostic text.
Structured native errors remain private operation state where needed.

A result-schema verification failure is `"error"` with
`errorKind: "schemaMismatch"`.
This lets patterns distinguish an unavailable service from a violated data
contract without parsing an error string.

An implementation that is actually invoked and throws still follows the
runner's exception path. Automatically converting arbitrary thrown exceptions
into data would hide programming errors and is not part of this design.

## Compatibility and Versioning

This is a source-breaking API migration for patterns that read `.result`,
`.pending`, or `.error` from fetch and generation state objects. The repository
must migrate those uses as part of the public-name cutover. Ordinary consumers
now call `resultOf(request)` once to obtain a statically usable value; consumers
which render availability states keep the `AsyncResult<T>` and use guards.

Fallback-while-loading code requires special review. When the successful `T`
excludes `null` and `undefined`, replacing `request.result ?? fallback` with
`resultOf(request) ?? fallback` is incorrect: the runtime marker remains present
and truthy even though TypeScript exposes the usable type. Use explicit guarded
fallback UI, explicit persisted state for a last-successful value, or the
`latestComplete()` snapshot. When `T` itself includes `null` or `undefined`, a
nullish fallback remains valid for those successful values; it still does not
act as a loading fallback. This distinction is the headline migration hazard
for out-of-repository patterns.

Within pattern code and these docs, `AsyncResult<T>` means the public
availability union. The internal memory package has an unrelated generic named
`AsyncResult<T, E>`; that implementation type is not part of this API.

Internal operation-state containers remain implementation details. Direct
built-ins project their output from the result cell while advanced generation
APIs retain access to partial state.

Serialized modules gain unavailable input policy metadata. Runtimes that do
not understand the metadata must not execute those modules as if the policy
were absent. Likewise, an older data-model registry decodes
the canonical unavailable primitive as an unknown value and cannot implement propagation.
The transformer therefore emits a policy-bearing JavaScript computation with
the serialized module kind `javascript-availability`. A supporting runtime
validates its policy and executes it with JavaScript-node semantics. An older
runtime reaches its existing unknown-module failure path instead of silently
executing the callback without the policy. Deployment still uses the normal
runtime/compiler version gate before patterns emit the new type or policy.

## Implemented Layers

### FabricType and policy plumbing

- `FabricUnavailable`, its codec, factories, guards, public type mirrors, and
  builder/runtime wiring.
- Serialized path-scoped unavailable input policy on modules.
- Transformer classification, `observeAvailability()`, type widening, and
  diagnostics.
- Runner preflight which selects concrete unavailable inputs before schema
  materialization.

### Computation propagation

- JavaScript value computations propagate unaccepted markers.
- Invalid-input output is `"schemaMismatch"`, not `undefined`.
- Syncing is distinct from complete invalid data.
- Equivalent behavior applies to conditionals, container operators, and raw
  built-ins with data outputs.

### Explicit asynchronous results

- Fetch and generation built-ins write direct values or unavailable
  markers.
- Explicit advanced generation APIs cover streaming and metadata use.
- External data streams expose a direct clean-close result plus an associated
  partial result without a public state wrapper.
- Dynamic compilation and SQLite queries expose direct availability-aware
  results while preserving their legacy raw state for old compiled graphs.
- `AsyncResult<T>` and the transparent zero-node `resultOf()` helper are public.
- Public signatures use `AsyncResult<T>`; repository patterns, tests, examples,
  prompts, and live documentation use the same contract.
- Sibling pending/error fields remain private operation state except on the
  explicitly advanced APIs.
- The deprecated stateful `llm()` surface and its raw fields remain
  compatibility-only; repository patterns use the replacement APIs.

## Testing Requirements

### Data model

- Round-trip every reason through the default JSON codec.
- Preserve error kind and message, deep freeze, clone, equality, and hash
  behavior.
- Reject structural lookalikes as control values.
- Verify unknown-runtime decoding follows the normal unknown-type path.

### Transformer and schema generation

- Type-predicate narrowing in true and false branches.
- Direct pattern-context guard lowering with reason-specific policy.
- Guard-only operands use opaque root materialization, while a structurally
  read successful value retains its usable schema.
- Explicit computed guards over visible `AsyncResult<T>` unions without an
  observation cast.
- `resultOf()` remains a zero-node alias and canonicalizes with its source when
  both are captured by one guarded computation.
- Explicit computed over a statically plain propagated value with a correctly
  externalized observation cast.
- Diagnostics for a plain unobserved guard and for an observation cast inside
  the compute.
- Diagnostics for helper guards whose caller argument uses an unstable dynamic
  path instead of silently dropping policy.
- Selective reasons, aliases, destructuring, generic `T`, nested generated
  computed blocks, hoisting, serialization, and reload.
- Exact-path policy: accepting an outer value must not accept a nested marker.

### Runner

- Callback suppression and unchanged-marker propagation.
- `error > pending > syncing` precedence and stable
  same-reason tie-breaking.
- Accepted reasons reach the callback while other reasons propagate.
- Object-shaped `T` never accepts a marker without policy.
- Valid authored `undefined`, syncing, missing data, and schema mismatch remain
  distinct.
- Result scope, CFC labels, policy inputs, pull scheduling, and durable
  observation behavior match a normal result write.
- Per-element propagation through map-like operators.
- Handler pending/syncing parking preserves FIFO and event identity while
  remaining quiescent for `idle()`; terminal reasons settle without blocking.
- Opt-in handler preflight telemetry records unavailable reason and queue depth.
- Renderer roots and children are blank for an initial unavailable value.
  Pending retains the last usable subtree as dimmed, inert, busy content;
  terminal and syncing markers clear it.

### Built-ins

- Initial, pending, success, error, result-schema mismatch, input-change, retry,
  and rehydration transitions.
- No stale successful value after inputs change.
- Resume preserves list-operator markers, linked-load failures remain terminal
  until a new reconnect epoch, and child tool failures reject without waiting
  for timeout.
- Legacy persisted generation errors without a result remain materializable.
- Direct APIs and advanced streaming APIs share one operation rather than
  issuing duplicate requests.
- `streamData` covers initial pending, successive partial events, final decoder
  flush, clean close, empty close, terminal error, schema mismatch, request
  replacement, cancellation, no implicit reconnect, legacy outbox ordering,
  and stale-run suppression.
- End-to-end patterns demonstrate a default `resultOf()` projection, a
  pending/error/success expression using both state and usable aliases, and a
  computation which observes only errors while other reasons still propagate.
- `latestComplete()` recursively strips unavailable schema arms, publishes only
  whole schema-materialized snapshots, preserves authored `undefined`, and
  retains its durable snapshot through unavailable refreshes and cold resume.
