# Fabric Values

This document specifies the immutable data representation for the Space Model:
what values can be stored, how custom types participate in encoding, and how
values are identified by content.

## Status

Draft formal spec — extracted from the data model proposal.

---

## 1. Fabric Value Types

### 1.1 Overview

The system stores **fabric values** — data that can flow through the runtime
as typed values and be serialized to wire/storage formats at boundary crossings.
All persistent data and in-flight messages use this representation.

The key design principle is **late serialization**: values flow through the
runtime as themselves; serialization to wire/storage formats happens only at
boundary crossings (persistence, IPC, network).

#### Three-Layer Architecture

The data model is organized into three explicit layers:

```
JavaScript "wild west" (unknown/any) <-> Strongly typed (FabricValue) <-> Serialized (Uint8Array)
```

- **Left layer — JS wild west.** Arbitrary JavaScript values (`unknown`/`any`),
  including JS objects like `Error`, `Map`, `Set`, `Date`, `RegExp`, and
  `Uint8Array`. Code in this layer has no type guarantees about what it is
  handling.

- **Middle layer — `FabricValue`.** The strongly typed core of the data model.
  Contains only primitives and containers, the latter being arrays, plain
  objects, and `FabricInstance` implementations (including wrapper classes for
  convertible JS types). No convertible JS objects appear at this layer — they
  are wrapped into `FabricInstance` implementations by the conversion functions
  (Section 8).

- **Right layer — Serialized form.** The wire/storage representation
  (`Uint8Array` for binary formats, JSON-compatible trees for the JSON engine).
  Serialization operates exclusively on `FabricValue` input; it never sees raw
  convertible JS objects.

Conversion functions bridge the left and middle layers:
`shallowFabricFromConvertibleJsValue()` / `fabricFromConvertibleJsValue()`
convert from JS values to `FabricValue`, wrapping JS objects into
`FabricInstance` wrappers and freezing the result.
`convertibleJsFromFabricValue()` converts back, unwrapping `FabricInstance`
wrappers to their JS equivalents. See Section 8 for the full
specification of these functions.

### 1.2 Type Universe

A `FabricValue` is defined as the following union. This is the **middle layer**
— the strongly typed core. Convertible JS objects (`Error`, `Map`, `Set`,
`Date`, `RegExp`, `Uint8Array`) do not appear here; they are handled by the
conversion layer (Section 8) and represented in `FabricValue` trees as
`FabricInstance` wrapper classes (Section 1.4).

> **Package note:** The data model implementation lives in
> `packages/data-model/`. The `FabricValue` union and the types beside it are
> declared in `api.ts`, together with the pattern-visible declarations of the
> special-object classes (`FabricInstance`, `FabricPrimitive`) and their union
> `FabricSpecialObject`. The classes themselves, the layer types, and the
> conversion-layer types
> are declared in `interface.ts`, which also re-exports every type `api.ts`
> declares. The in-process lifecycle symbols (`DEEP_FREEZE`, `IS_DEEP_FROZEN`)
> live in `fabric-bases/`, on `BaseFabricInstance` alongside the abstract base
> that carries them (Section 8.6). The codec vocabulary (the
> `CODEC` symbol, `FabricCodec`, `LiveEnvironment`) lives in `codec-interface/`
> (Section 2), and the machinery that acts on it in `codec-common/` -- including
> `BaseEncodeAct` and `BaseDecodeAct`, which are classes the walk carries rather
> than contracts a caller implements. The conversion functions are in
> `convertible-js.ts` (Section 8).
>
> **Where a thing is declared is not where it is imported from**, and the
> modules named here divide on that point. The whole `FabricValue` vocabulary
> comes from `@commonfabric/data-model`, the package's main entry point: the
> declarations in `api.ts` and `interface.ts`, the conversions in
> `convertible-js.ts`, the clone helpers in `value-clone.ts`, and the
> operations a value of any class is subject to -- `deep-freeze.ts`,
> `value-hash.ts`, the debug renderers in `value-debug/`, the comparisons in
> `comparison/`, and the tag vocabulary in `types/`.
> Of those, one is also an exported subpath: `api.ts` as
> `@commonfabric/data-model/api`, which is how `@commonfabric/api` reaches it.
> `codec-interface/` is internal in the same way, reached through
> `@commonfabric/data-model/codec-common`, which re-exports it.
> `codec-common/`, `fabric-bases/` and `fabric-instances/` are exported subpaths
> in their own right and are imported directly under those names; the main entry
> point does *not* re-export the codec vocabulary, so `LiveEnvironment` and its
> siblings come from `@commonfabric/data-model/codec-common`. Cite a module to
> say where something is defined; consult the package's `exports` map to know
> where to import it from.
>
> Type declarations visible to patterns are in
> `packages/data-model/src/api.ts` (the `interface` + `declare const` pattern),
> which `packages/api/index.ts` re-exports as part of the `commonfabric`
> surface. They must agree with the implementations they mirror, and the
> agreement is asserted at compile time: `api-agreement.ts`, a module nothing
> imports, asserts that each of the three base classes and its declaration are
> mutually assignable, and each concrete class asserts beside its own
> definition that it satisfies its declaration. The second kind of check runs
> one way only -- a public member an implementation gains without a declaration
> is unreachable from a pattern, and no gate reports it. `packages/runner/`
> wires concrete implementations into builder exports.

```typescript
// Shown at module scope.
// file: packages/data-model/src/api.ts

/**
 * The complete set of values that can flow through the runtime, be stored
 * persistently, or be transmitted across boundaries. This is the "middle
 * layer" of the three-layer architecture — no convertible JS objects appear
 * here.
 */
type FabricValue =
  // (a) Primitives
  | null
  | boolean
  | number    // any number, including `-0`, `NaN`, and `±Infinity`; see Section 1.3
  | string
  | undefined // first-class `FabricValue`; requires tagged representation in formats lacking native `undefined`
  | bigint    // large integers; rides through without wrapping (like `undefined`)
  | symbol    // registry-interned symbols only (`Symbol.keyFor(s)` returns a string); see Section 1.3

  // (b) Special primitives (FabricPrimitive subclasses — always frozen)
  | FabricEpochNsec
  | FabricEpochDay
  | FabricHash
  | FabricBytes
  | FabricKeyPair
  | FabricRegExp
  | FabricUnavailable

  // (c) Branded fabric types (custom types implementing the fabric protocol)
  //     This arm covers:
  //       - JS object wrappers: `FabricError`, `FabricMap`,
  //         `FabricSet` (Section 1.4)
  //       - User-defined types: `Cell`, `Stream`, etc.
  //       - System types: `UnknownValue`, `ProblematicValue`
  | FabricInstance

  // (d) Plain containers -- read-only; see the immutability callout below
  | readonly FabricValue[]
  | { readonly [key: string]: FabricValue };
```

Arm (b) is a deliberate expansion, not a divergence. The implementation writes
a single `FabricPrimitive` arm, and every concrete `FabricPrimitive` class is
defined by the data model, so naming those classes individually describes
exactly the same set while saying more about it. Read the split as this
document's elaboration of one implementation arm.

Arms (c) and (d) are the **containers** — the values that expose other
`FabricValue`s for a walk to descend into. The implementation names that set
`FabricContainerValue` and writes it as the union's other arm, so the two arms
here are that one written out. What divides the two arms is where the contents
live, not whether there are any: a plain container's contents are its own
indices and keys, while a `FabricInstance` holds its contents privately and
exposes them through the protocol of Section 2.3. Arms (a) and (b) are the
non-containers. A `FabricPrimitive` may hold `FabricValue`s of its own — a
`FabricRegExp` its source and flags, a `FabricKeyPair` holding material two
`FabricBytes` — but holds them privately and self-freezes at construction, so it
exposes none of them and a walk stops there (Section 8.6).

> **Fabric values are deeply read-only, with one intentional hole.** The plain
> container arms are read-only, and because their element and property types are
> themselves `FabricValue`, that read-only-ness is inherited all the way down: a
> `FabricValue` tree cannot be written through at any depth. The implementation
> names those two arms `FabricArray` (`ReadonlyArray<FabricValue>`) and
> `FabricPlainObject` (`Readonly<Record<string, FabricValue>>`); this is the
> type-level counterpart of the runtime deep-freeze contract in Section 8.6, and
> the two are meant to agree.
>
> The hole is the `FabricInstance` arm — the one container the guarantee does
> not reach. An instance exposes arbitrary members, and a member can change
> instance state — including which values the instance refers to — so the
> read-only-ness stops at an instance boundary and does not reach what lies
> beyond it. This is deliberate rather than an oversight: the intended semantics
> *are* expressible in TypeScript, but not concisely enough to be worth the cost
> at every use site. Treat the type-level guarantee as covering the plain
> containers and the primitives, and Section 8.6 as the statement that actually
> binds instances.
>
> **Construction is the exception that proves the rule.** Building a plain
> container requires writing to it, so the implementation provides
> `MutableFabricValueLayer` — a value whose *root* container is mutable
> (`MutableFabricArrayLayer` is `FabricValue[]`, `MutableFabricPlainObjectLayer`
> is `Record<string, FabricValue>`) while everything nested within it remains an
> ordinary read-only `FabricValue`. `MutableFabricContainerValueLayer` is that
> same layer narrowed to the container arms, for a caller that has already
> established it holds one. Each is a single construction layer, not a deep
> thaw, and each is a builder's type: a value that has finished being built is a
> `FabricValue`.

> **Restricted and excluded JS types.**
>
> - `symbol` — **Conditionally** part of the universe. Registry-interned symbols
>   (`Symbol.for(key)`, where `Symbol.keyFor(s)` returns a string) are
>   first-class `FabricValue`s: they are portable across realms and processes
>   via their registry key. **Unique** symbols (`Symbol(desc)`, where
>   `Symbol.keyFor(s)` returns `undefined`) have no portable representation and
>   are rejected. The TypeScript `symbol` type cannot express this distinction,
>   so it is enforced at runtime by membership, by the tag dispatch (which tags
>   a unique symbol `null`, as it does a function), and by the conversion,
>   hashing, and encoding boundaries (Sections 4.9, 6, and 5). Symbol-keyed
>   *properties* on plain
>   objects are a separate matter — see Section 1.5 (Plain Containers /
>   Objects).
> - `function` — Functions are opaque closures with no portable representation.
>   They are explicitly **not** representable as `FabricValue`s, eliciting a
>   thrown error from `fabricFromConvertibleJsValue()` and a `false` return
>   value from `isValidFabricConvertibleJsValue()`. (`FabricInstance`s are not
>   functions in this sense — they are class instances whose encoding is
>   handled by their class's `[CODEC]`.)
>
> A proposed, deliberately narrow exception adds a `FabricFactory` arm for
> builder-created factories and codec-decoded factory shells admitted to the
> internal data-model brand table. The function itself is the `FabricValue` and
> encodes through `Factory@1`; there is no non-callable wrapper class. This
> data-type brand does not grant executable trust, which is established
> separately by resolving a content-addressed builder artifact. The exception is
> not automatic under the current protocol: it requires branded-function
> dispatch before generic function rejection, plus factory-state handling in
> conversion, freezing, cloning, equality, hashing, and traversal. Every
> unbranded function remains rejected. See [First-Class Encodable
> Factories](../pattern-construction/node-factory-shipping.md).
>
> Of the two JS primitive types whose `typeof` results (`"symbol"` and
> `"function"`) describe non-data values, `symbol` has a corresponding
> `FabricValue` arm (with the runtime interned-vs-unique restriction above) and
> `"function"` does not **in the current model**. The proposal above adds only
> the branded `FabricFactory` function arm. All other `typeof` results
> (`"undefined"`, `"boolean"`, `"number"`, `"string"`, `"bigint"`, `"object"`)
> have unconditional `FabricValue` arms.

#### `FabricConvertibleJsObject`

A separate type — **outside** the `FabricValue` hierarchy — defines the raw
convertible JS object types that the conversion layer can handle:

```typescript
// Shown at module scope.
// file: packages/data-model/src/interface.ts

/**
 * Union of convertible JS object types that the conversion layer can translate
 * to and from `FabricValue`. These types sit outside the `FabricValue`
 * hierarchy and only appear at conversion function boundaries (Section 8).
 *
 * Primitives like `bigint` and `undefined` are NOT included — they are
 * directly part of `FabricValue`. The wrapper classes (`FabricError`,
 * `FabricMap`, etc.) are also NOT this type — they are `FabricInstance`
 * implementations that live inside `FabricValue`.
 */
type FabricConvertibleJsObject =
  | Error
  | Map<unknown, unknown>
  | Set<unknown>
  | Date
  | RegExp
  | Uint8Array;

/**
 * A `FabricValue`, a `FabricConvertibleJsObject`, or a deep tree thereof -- the
 * values that convert to and from fabric form. This is the precondition of
 * `fabricFromConvertibleJsValue()` (which fails on anything else), the result
 * of `convertibleJsFromFabricValue()`, and what
 * `isValidFabricConvertibleJsValue()` tests for.
 *
 * Distinct from `FabricValue`: containers here may hold
 * `FabricConvertibleJsObject`s. Converting a `FabricError` yields an `Error`,
 * so an array of them is an array of JS objects, which has no `FabricValue`
 * name.
 */
type FabricConvertibleJsValue = FabricValuePlus<FabricConvertibleJsObject>;
```

`Map` and `Set` are named with unconstrained type arguments: their contents are
checked when they are converted, not by the type. The constraint has nowhere to
bind in any case while `FabricMap` and `FabricSet` remain stubbed (Sections
1.4.3 and 1.4.4).

Neither type is ever a member of `FabricValue`; both exist solely at the
conversion boundary (Section 8). Of the two, **`FabricConvertibleJsValue` is the
one the boundary actually speaks**, and it exists because `FabricValue |
FabricConvertibleJsObject` cannot say "or a tree of these." A container arm of
`FabricValue` holds `FabricValue`s, so it cannot hold an `Error`; and a
`FabricConvertibleJsObject` is a single JS object, not a container of them.
Converting a `FabricError` yields an `Error`, so an array of `FabricError`s
converts to an array of `Error`s — a value that is neither a `FabricValue` nor a
`FabricConvertibleJsObject`, and which only the recursive type names. It is what
`fabricFromConvertibleJsValue()` succeeds on, what
`convertibleJsFromFabricValue()` returns, and what
`isValidFabricConvertibleJsValue()` tests (Sections 8.3 and 8.4). It is a
precondition rather than a parameter type: the conversion functions that accept
arbitrary input declare `unknown` and reject what they cannot convert (Section
8.2).

`FabricValuePlus<PlusType>` is the general form of that recursion, declared in
`api.ts`: `FabricValue` with one additional type admitted at the top and inside
every container, so that `FabricValuePlus<never>` is `FabricValue` itself.
`FabricConvertibleJsValue` is `FabricValuePlus<FabricConvertibleJsObject>`, and
`FabricValueLayer` is the same mechanism at a different `PlusType`. The array
and plain-object arms carry `PlusType` structurally, in their element and value
types. The instance arm, `FabricInstancePlus<PlusType>`, carries it as a
type-only brand -- the member keyed by `FABRIC_INSTANCE_PLUS_BRAND`, which
`FabricInstance` declares at `never` -- because an instance holds its contents
privately and nothing structural on it can witness what they may include. What
exposes them is the class's codec, which is bound at that same `PlusType`
(Section 2.4).

Every arm names a specific JS class. There is no duck-typed arm: a value
becomes fabric-representable by being one of these, by implementing the fabric
protocol (`FabricInstance` + `[CODEC]`), or not at all. In particular a
`toJSON()` method carries no meaning here — it is an ordinary member, and a
function-valued member is not representable.

### 1.3 Primitive Types

| Type | Constraints | Notes |
|------|-------------|-------|
| `null` | None | The null value |
| `boolean` | None | `true` or `false` |
| `number` | None | Any IEEE 754 binary64 value, including `-0`, `NaN`, and `±Infinity`. See the callout below. |
| `string` | None | Unicode text |
| `undefined` | None | First-class `FabricValue`; see note below |
| `bigint` | None | Large integers; JSON-encoded as base64url (RFC 4648, Section 5) of two's complement big-endian bytes (Section 3 of `3-json-encoding.md`) |
| `symbol` | Registry-interned only | Only symbols for which `Symbol.keyFor(s)` returns a string (i.e., `Symbol.for(key)` symbols) are admitted. Unique symbols (`Symbol(desc)`) are rejected. See the callout below. |

> **`undefined` as a first-class fabric value.** `undefined` is a first-class
> `FabricValue` that round-trips faithfully through encoding. Because most wire
> formats (including JSON) have no native `undefined` representation, the codec
> system uses a dedicated tagged form for `undefined` — the same tagged form
> regardless of context (array element, object property value, or top-level
> value). See Section 3 of `3-json-encoding.md` for the specific JSON encoding.
> Deletion semantics (e.g., removing a cell's value when `undefined` is written
> at top level) are an application-level concern, not an encoding concern: the
> encoder faithfully records `undefined` and the application layer interprets
> the result.

> **`-0`, `NaN`, and `±Infinity`.** The hashing layer (Section 6.4 and
> `2-hash-byte-format.md` Section 4.3) and the JSON wire format (Section 5;
> `3-json-encoding.md` Section 3, `SpecialNumber@1`) both faithfully represent
> `-0`, `NaN`, `+Infinity`, and `-Infinity` as first-class values, distinct from
> `0` and from each other. All four values pass through
> `shallowFabricFromConvertibleJsValue()` and `fabricFromConvertibleJsValue()`
> (Section 4.9) unchanged — `-0` retains its sign (`Object.is(result, -0) ===
> true`), and `NaN` / `±Infinity` round-trip through hashing and JSON encoding
> via the byte-level forms in `2-hash-byte-format.md` Section 4.3 and the
> `SpecialNumber@1` envelope in `3-json-encoding.md` Section 3. Value-equality
> among these values follows `Object.is()` — `-0` is distinct from `+0` while
> all `NaN`s are equal — as specified in Section 6.7.

> **Interned vs. unique symbols.** The hashing layer (Section 6.4 and
> `2-hash-byte-format.md` Section 4.6) and the JSON wire format (Section 5;
> `3-json-encoding.md` Section 3, `Symbol@1`) both faithfully represent
> registry-interned symbols, identifying them by their registry key
> (`Symbol.keyFor(s)`). Unique symbols (`Symbol(desc)` — those for which
> `Symbol.keyFor(s)` returns `undefined`) have no portable representation and
> are rejected at every layer. Interned symbols pass through
> `shallowFabricFromConvertibleJsValue()` and `fabricFromConvertibleJsValue()`
> (Section 4.9) unchanged: round-trip via `Symbol.for(key)` yields a result that
> is `===` to any other `Symbol.for(key)` in the same realm. Unique symbols
> throw with the message ``"Not representable as a `FabricValue`: unique
> (uninterned) symbol"``.

### 1.4 JS Object Wrapper Classes

Certain built-in JS types (`Error`, `Map`, `Set`) cannot have `Symbol`-keyed
methods added via prototype patching in a reliable, cross-realm way. Rather than
handling them with special-case logic in the encoder, the system defines
**wrapper classes** — one per JS type — that implement `FabricInstance`. The
conversion layer (Section 8) wraps convertible JS objects into these classes
when bridging from the JS wild west to `FabricValue`, and unwraps them when
bridging back. (A JS `RegExp` is also bridged by the conversion layer, but into
the `FabricRegExp` **primitive** rather than a wrapper — see Section 1.4.5.)

Because each wrapper genuinely implements `FabricInstance` and hosts a `[CODEC]`
(Section 2.4), the codec system processes them through the same uniform codec
dispatch as every other fabric class — no special cases needed in the encoder.
The hashing system also uses the standard `TAG_INSTANCE` path for all wrappers.
`FabricBytes` (the byte-sequence type) has a dedicated `TAG_BYTES` tag for
content-level identity (see Section 6.3), but it is a `FabricPrimitive`, not a
`FabricInstance`.

The **special primitive** types (`FabricEpochNsec`, `FabricEpochDay`,
`FabricHash`, `FabricBytes`, `FabricKeyPair`, `FabricRegExp`,
`FabricUnavailable`) are **not** `FabricInstance`s — they are `FabricPrimitive`
subclasses (Section 1.4.6).
`FabricPrimitive` is an arm of the `FabricValue` union, so all
`FabricPrimitive` subclasses are implicitly members of `FabricValue`. They are always-frozen value types that
bypass the `freeze` option in conversion functions. Each hosts its own codec for
wire-format encoding, but bound per wire format — under `[JSON_CODEC]` for JSON
— rather than under the format-neutral `[CODEC]` a wrapper binds, because a
primitive's codec terminates an encoding where a wrapper's only decomposes. What
further distinguishes them is the hashing layer, where each has a dedicated
primitive hash tag rather than the `TAG_INSTANCE` path (Section 6.3). They do
not carry a `wireTypeTag` property (no fabric type does, save `UnknownValue` and
`ProblematicValue`; the wire tag is the codec's concern).

#### 1.4.1 Wrapper Class Summary

| Wrapper Class | Wraps | Type Tag | Encoded State | Notes |
|---------------|-------|----------|---------------|-------|
| `FabricError` | `Error` | `Error@1` | `{ type, name, message, stack?, cause?, ...custom }` | `type` is the constructor name (e.g. `"TypeError"`). `name` is the `.name` property if it differs from `type`, or `null` if it matches (the common case). Includes `message`, `stack` (if present), `cause` (if present), and custom enumerable properties. The conversion layer (Section 8.2) recursively converts nested values (including `cause` and custom properties) before wrapping, ensuring all values are `FabricValue` by the time the codec's `encode()` runs. |
| `FabricMap` | `Map` | `Map@1` | `[[key, value], ...]` | Entry pairs as an array of two-element arrays. Insertion order is preserved. Keys and values are recursively processed. **Implementation status: stubbed** — the tag is reserved and the class exists, but its members and codec currently throw (see Section 1.4.3). |
| `FabricSet` | `Set` | `Set@1` | `[value, ...]` | Elements as an array. Iteration order is preserved. Values are recursively processed. **Implementation status: stubbed** — the tag is reserved and the class exists, but its members and codec currently throw (see Section 1.4.4). |

(A JS `RegExp` is also bridged by the conversion layer, but into the
`FabricRegExp` **primitive** — a `FabricPrimitive` subclass, not a wrapper. It
is therefore listed in the special-primitive table below and detailed in
Section 1.4.5, not here.)

Each wrapper class above:

- **Extends `FabricNativeWrapper<T>`** (which extends `BaseFabricInstance`,
  which in turn extends `FabricInstance`), inheriting the `shallowClone()`
  frozenness-management template method from `BaseFabricInstance` and
  providing a `toNativeValue(frozen)` method for unwrapping.
- **Hosts a static `[CODEC]`** (Section 2.4) whose `encode()` extracts essential
  state and whose `decode()` returns an instance of the wrapper class — **not**
  the JS type. Callers who need the underlying JS object use
  `convertibleJsFromFabricValue()` (Section 8) to unwrap it. The wire tag (e.g.,
  `"Error@1"`) is carried by the codec, not by the instances.
- **Has `[DEEP_FREEZE]` and `[IS_DEEP_FROZEN]` methods plus a
  `deepClone(frozen)` method** per the `FabricInstance` protocol (Section 2.3);
  the deep-freeze pair participates in the generic `deepFreeze()` dispatch
  (Section 8.6).

##### `FabricNativeWrapper<T>` Base Class

All JS object wrappers share an abstract base class that extends
`BaseFabricInstance` (see Section 2.3) and adds methods for unwrapping back
to convertible JS form:

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-instances/FabricNativeWrapper.ts

/**
 * Abstract base class for `FabricInstance` wrappers that bridge convertible JS
 * objects into the `FabricValue` layer.
 * Provides a common `toNativeValue()` method used by both the shallow and
 * deep unwrap functions, replacing their `instanceof` cascades with a
 * single `instanceof FabricNativeWrapper` check.
 */
export abstract class FabricNativeWrapper<T extends object>
  extends BaseFabricInstance {
  /** The wrapped JS value, used by `toNativeValue` for freeze-state checks. */
  protected abstract get wrappedValue(): T;

  /** Converts the wrapped value to frozen form (only called on state mismatch). */
  protected abstract toNativeFrozen(): T;

  /** Converts the wrapped value to thawed form (only called on state mismatch). */
  protected abstract toNativeThawed(): T;

  /** Returns the underlying JS value, optionally frozen. */
  toNativeValue(frozen: boolean): T {
    const value = this.wrappedValue;
    if (frozen === Object.isFrozen(value)) return value;
    return frozen ? this.toNativeFrozen() : this.toNativeThawed();
  }

  /** @inheritDoc */
  deepClone(_frozen: boolean): FabricInstance {
    throw new Error(
      `Cannot yet handle deep cloning of \`${this.constructor.name}\`.`,
    );
  }
}
```

The `toNativeValue(frozen)` method returns the original wrapped value when
its freeze state already matches the `frozen` argument, and constructs a new
instance only when a freeze-state change is needed. This avoids defensive
copying in the common case and centralizes the freeze-state logic for all
wrapper types.

Unlike the wrappers above, the special primitive types (`FabricEpochNsec`,
`FabricEpochDay`, `FabricHash`, `FabricBytes`, `FabricKeyPair`,
`FabricRegExp`, `FabricUnavailable`) are **`FabricPrimitive` subclasses** and
do not extend `FabricInstance`. They are included in `FabricValue` via the
`FabricPrimitive` arm of the union (Section 1.4.6). See Sections 1.4.5
through 1.4.12.

| Special Primitive Type | Extends | Wire Tag | Stored Value | Notes |
|------------------------|---------|----------|--------------|-------|
| `FabricEpochNsec` | `FabricPrimitive` | `EpochNsec@1` | `bigint` (signed nanoseconds from POSIX Epoch) | Primary temporal type. JS `Date` has only millisecond precision; conversion from `Date` multiplies by 10^6. When `Temporal` is available, `Temporal.Instant` maps naturally (it uses nanoseconds from epoch internally). |
| `FabricEpochDay` | `FabricPrimitive` | `EpochDay@1` | `bigint` (signed days from POSIX Epoch) | Day-precision temporal type. Anticipates `Temporal.PlainDate`. Mostly nascent — class and spec entry are defined, but full integration (Temporal types, calendar concerns) is deferred. |
| `FabricHash` | `FabricPrimitive` | `Hash@1` | `Uint8Array` (hash bytes, private) + `string` (algorithm tag) | Content identifier / hash. Stringifies as `<tag>:<base64urlhash>` (unpadded base64url, RFC 4648 Section 5). The first algorithm tag is `fid1` ("fabric ID, v1"). Wire state is `{ tag, hash }` (see Section 1.4.9). |
| `FabricBytes` | `FabricPrimitive` | `Bytes@1` | `Uint8Array` (private byte storage) | Immutable byte sequence. The instance owns its bytes outright: input is copied at construction time, unless the caller cedes it with `transfer`. Callers access bytes via `slice()`, `sliceBuffer()`, `copyInto()`, and `length`. |
| `FabricKeyPair` | `FabricPrimitive` | `KeyPair@1` | Either two `CryptoKey` handles, or an algorithm name and the two keys' bytes | Asymmetric key pair. Which of the two states it holds decides what it can do: only the material state has a JSON encoding or a hash, and only the handle state can hand back a `CryptoKeyPair` (see Section 1.4.11). |
| `FabricRegExp` | `FabricPrimitive` | `RegExp@1` | `source` / `flags` / `flavor` strings | Regular-expression value. `source` is the pattern string (`regex.source`); `flags` is the flag string (`regex.flags`); `flavor` is the regex dialect identifier (e.g. `"es2025"`). Stores strings only; `value` returns a fresh JS `RegExp` clone per call. Extra enumerable properties on a JS `RegExp` cause rejection. |
| `FabricUnavailable` | `FabricPrimitive` | `Unavailable@1` | `reason` string; for reason `error`, an `errorKind` string and an optional `errorMessage` string | Marker standing in for data that is not available, saying why: `pending`, `syncing`, or `error`, the last sorted by a kind. Only the `error` reason carries a kind and a message. Wire state is `{ reason }`, `{ reason, errorKind }`, or `{ reason, errorKind, errorMessage }` (see Section 1.4.12). |

#### Extra Enumerable Properties

**`FabricError`** MAY carry extra enumerable properties beyond the standard
fields (`type`, `name`, `message`, `stack`, `cause`). Custom properties on
`Error` objects are common JavaScript practice (e.g., `error.code`,
`error.statusCode`), so `FabricError` preserves them in an "extras" bag: the
codec's `encode()` includes them in its output, and `decode()` restores them on
the decoded instance (Section 1.4.2).

**`FabricMap`, `FabricSet`, `FabricRegExp`, `FabricEpochNsec`, `FabricEpochDay`,
`FabricHash`, `FabricBytes`, `FabricKeyPair`** must NOT carry extra enumerable
properties. Their stored value contains only the essential JS data (entries,
items, epoch value, bytes respectively). Extra enumerable properties on the
source JS object cause **rejection** — the conversion function throws. This
follows the principle "Death before confusion!" (Mark Miller): it is better to
fail loudly than to silently lose data. This is in the same spirit as the
treatment of arrays, where extra non-index properties also cause rejection
(Section 1.5) — though the array rule is stricter still, rejecting
non-enumerable and symbol-keyed properties as well. Unlike `Error`, these JS
types have no established convention for custom properties.

#### 1.4.2 `FabricError`

Unlike a thin wrapper holding a JS `Error`, `FabricError` stores
**structured `FabricValue`-typed state** — fixed-schema slots (`type`, `name`,
`message`, `stack`, `cause`) plus a hidden "extras" bag of custom enumerable
properties accessed via map-like methods. The JS `Error` form is a
*projection*, produced on demand by `toNativeValue()` (and cached once the
instance is frozen, when it can no longer go stale).

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-instances/FabricError.ts

/**
 * Structured state for constructing a `FabricError`. Spec slots are
 * `FabricValue`-typed; the optional `extras` carries any custom enumerable
 * properties (also in `FabricValue` form).
 */
export type FabricErrorState = {
  /** Constructor name of the originating JS `Error`
   *  (e.g. `"TypeError"`). */
  readonly type: string;
  /**
   * The `.name` property. Pass `null` (or omit) to mean "same as `type`";
   * the resulting instance's `.name` is always a concrete string (`null`
   * is a wire-level optimization at the `[CODEC]` encode boundary, not
   * part of the public API).
   */
  readonly name?: string | null | undefined;
  /** The `.message` property. */
  readonly message: string;
  /** The `.stack` property, or `undefined`. */
  readonly stack: string | undefined;
  /** The `.cause` value, in `FabricValue` form, or `undefined`. */
  readonly cause: FabricValue | undefined;
  /** Optional custom enumerable own properties, in `FabricValue` form.
   *  Keys must not collide with the fixed-schema slot names or with
   *  prototype-sensitive keys. */
  readonly extras?:
    | Iterable<readonly [string, FabricValue]>
    | Readonly<Record<string, FabricValue>>
    | undefined;
};

/**
 * Wrapper for `Error` instances in the fabric type system. The publicly
 * observable state is entirely `FabricValue`-typed: fixed-schema slots
 * plus a hidden extras bag. The JS `Error` form is produced on demand
 * by `toNativeValue()`.
 *
 * Like all `FabricInstance`s, a `FabricError` is wholeheartedly mutable
 * until frozen and immutable thereafter. Every mutator -- the slot setters
 * along with `setExtra` / `deleteExtra` -- throws once the instance is
 * `Object.freeze`'d. The codec layer handles `FabricError` via its
 * static `[CODEC]`, which is the source of truth for the encoded form.
 */
export class FabricError extends FabricNativeWrapper<Error> {
  // Fixed-schema slots, each a getter/setter pair over a private field.
  get type(): string;                      // and `set type(value: string)`
  get name(): string;                      // always a concrete string
  get message(): string;
  get stack(): string | undefined;
  get cause(): FabricValue | undefined;

  /** Hidden bag of custom enumerable properties. */
  readonly #extras: Map<string, FabricValue>;

  /**
   * Constructs from a `FabricErrorState` record. All state values must
   * already be in `FabricValue` form. Unsafe keys (`__proto__`,
   * `constructor`) and fixed-schema slot names are silently skipped in
   * `extras`.
   */
  constructor(state: FabricErrorState);

  /**
   * Conversion from a JS `Error`. The error's `.cause` and custom
   * properties go through `options.convert`: by default one that holds a
   * valid `FabricValue` as it stands and puts anything else through the
   * deep conversion of Section 8.2 without freezing, so the result is a
   * valid `FabricValue` throughout. The shallow conversion layer passes an
   * identity converter and stores them as they stand, for the deep path to
   * convert when it rebuilds the instance.
   */
  static fromNativeError(
    error: Error,
    options?: { readonly convert?: (value: unknown) => FabricValue },
  ): FabricError;

  // Extras-bag access (the bag is not exposed as an own property).
  // `setExtra`/`deleteExtra` throw on a frozen instance, on fixed-schema
  // slot names, and on prototype-sensitive keys.
  getExtra(key: string): FabricValue | undefined;
  hasExtra(key: string): boolean;
  setExtra(key: string, value: FabricValue): void;
  deleteExtra(key: string): boolean;
  get extraSize(): number;
  extraKeys(): IterableIterator<string>;
  extraEntries(): IterableIterator<[string, FabricValue]>;

  // ([DEEP_FREEZE] / [IS_DEEP_FROZEN] freeze `this` and recurse into
  // `cause` + the extras-bag values; `[SHALLOW_UNFROZEN_CLONE]()` copies the
  // slots + bag; `wrappedValue` / `toNativeFrozen()` / `toNativeThawed()`
  // build the JS `Error` projection on demand. `deepClone(frozen)`
  // round-trips through the codec: `codec.decode(tag,
  // codec.encode(this, env), env)`. Bodies omitted for brevity.)

  static #codec = Object.freeze(
    new (class FabricErrorCodec extends BaseNonterminalCodec {
      constructor() {
        super(CODEC_TYPE_TAGS.Error, FabricError);
      }

      /**
       * Emits `{ type, name, message, stack?, cause?, ...extras }`.
       * `name` is emitted as `null` when it matches `type` (the common
       * case) to avoid redundancy; `decode()` interprets `null` as "same
       * as `type`."
       */
      encode(value: FabricError, _env: LiveEnvironment): FabricValue {
        const state: Record<string, FabricValue> = {
          type: value.type,
          name: value.name === value.type ? null : value.name,
          message: value.message,
        };
        if (value.stack !== undefined) {
          state.stack = value.stack;
        }
        if (value.cause !== undefined) {
          state.cause = value.cause;
        }
        for (const [key, val] of value.extraEntries()) {
          state[key] = val;
        }
        return state as FabricValue;
      }

      /**
       * Rebuilds a `FabricError` from wire state. Uses `type` for class
       * identity, falling back to `name` for backward compatibility with
       * data encoded before `type` was added; missing `message`
       * becomes `''`. Reserved and unsafe keys are excluded from the
       * extras. Honors `env.shouldDeepFreeze` (Section 2.5).
       */
      decode(
        _typeTag: string,
        state: FabricValue,
        env: LiveEnvironment,
      ): FabricValue {
        const s = state as Record<string, FabricValue>;
        const type = (s.type as string) ?? (s.name as string) ?? 'Error';
        const name = (s.name as string | null | undefined) ?? type;
        const message = (s.message as string) ?? '';

        const extras: Array<[string, FabricValue]> = [];
        for (const key of Object.keys(s)) {
          if (FABRIC_ERROR_RESERVED_KEYS.has(key) || UNSAFE_KEYS.has(key)) {
            continue;
          }
          extras.push([key, s[key]]);
        }

        const result = new FabricError({
          type,
          name,
          message,
          stack: s.stack as string | undefined,
          cause: s.cause,
          extras,
        });
        return env.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
```

The JS projection (`#buildNativeError()`, reached via `toNativeValue()`)
decodes the appropriate `Error` subclass from `type` (via a constructor-name
lookup, defaulting to `Error`), restores `name` when it differs, and copies
`stack`, `cause`, and the extras onto the result. While the instance is mutable
the projection is rebuilt on each access; once frozen it is cached.

#### 1.4.3 `FabricMap`

> **Implementation status: stubbed (tag reserved).** The live class exists with
> the full wrapper shape (including the JS-projection members, with
> `toNativeFrozen()` producing a `FrozenMap`), and its `Map@1` tag is reserved
> in `CODEC_TYPE_TAGS`, but the protocol members and the codec's
> `encode()`/`decode()` currently throw (`"FabricMap: not yet implemented"`) —
> `FabricMap` is not yet used and is being reworked separately. The code below
> is the **normative target** the implementation must converge on; the wire
> format matches Section 1.4.1.

```typescript
// Shown at module scope.
// file: packages/data-model/fabric-instances/FabricMap.ts
// (Normative target -- the live codec is currently a throwing stub.)

/**
 * Wrapper for `Map` instances. Extra properties beyond the wrapped
 * collection are not supported on non-`Error` wrappers.
 */
export class FabricMap
  extends FabricNativeWrapper<Map<FabricValue, FabricValue>> {
  constructor(readonly map: Map<FabricValue, FabricValue>) {
    super();
  }

  // ([DEEP_FREEZE] / [IS_DEEP_FROZEN] freeze `this` and recurse into the
  // entries; `[SHALLOW_UNFROZEN_CLONE]()` copies `map` into a new wrapper;
  // `wrappedValue` / `toNativeFrozen()` (-> `FrozenMap`) /
  // `toNativeThawed()` are the JS-projection members.)

  static #codec = Object.freeze(
    new (class FabricMapCodec extends BaseNonterminalCodec {
      constructor() {
        super(CODEC_TYPE_TAGS.Map, FabricMap);
      }

      /** Entry pairs as an array of two-element arrays; insertion order
       *  is preserved. */
      encode(value: FabricMap, _env: LiveEnvironment): FabricValue {
        return [...value.map.entries()] as FabricValue;
      }

      decode(
        _typeTag: string,
        state: FabricValue,
        env: LiveEnvironment,
      ): FabricValue {
        const entries = state as [FabricValue, FabricValue][];
        const result = new FabricMap(new Map(entries));
        return env.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
```

#### 1.4.4 `FabricSet`

> **Implementation status: stubbed (tag reserved)**, exactly parallel to
> `FabricMap` (Section 1.4.3): the class shape and reserved `Set@1` tag exist
> (with `toNativeFrozen()` producing a `FrozenSet`); the protocol members and
> codec currently throw (`"FabricSet: not yet implemented"`). The code below is
> the **normative target**; the wire format matches Section 1.4.1.

```typescript
// Shown at module scope.
// file: packages/data-model/fabric-instances/FabricSet.ts
// (Normative target -- the live codec is currently a throwing stub.)

/**
 * Wrapper for `Set` instances.
 */
export class FabricSet extends FabricNativeWrapper<Set<FabricValue>> {
  constructor(readonly set: Set<FabricValue>) {
    super();
  }

  // (Lifecycle and JS-projection members parallel to `FabricMap`.)

  static #codec = Object.freeze(
    new (class FabricSetCodec extends BaseNonterminalCodec {
      constructor() {
        super(CODEC_TYPE_TAGS.Set, FabricSet);
      }

      /** Elements as an array; iteration order is preserved. */
      encode(value: FabricSet, _env: LiveEnvironment): FabricValue {
        return [...value.set] as FabricValue;
      }

      decode(
        _typeTag: string,
        state: FabricValue,
        env: LiveEnvironment,
      ): FabricValue {
        const elements = state as FabricValue[];
        const result = new FabricSet(new Set(elements));
        return env.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
```

#### 1.4.5 `FabricRegExp`

`FabricRegExp` is a `FabricPrimitive` subclass, not a JS-object wrapper. A
regular expression is a leaf type with respect to references (it holds no nested
`FabricValue`s) and is reasonably conceived of as stateless: although a JS
`RegExp` carries mutable internal state (notably `lastIndex`), a `FabricRegExp`
never hands out its stored `RegExp` un-cloned, so no mutable state is exposed.
It therefore has a dedicated hash tag (`TAG_REGEXP`, Section 6.3). Like every
fabric class, it hosts its own `[CODEC]` (tag `RegExp@1`) for wire-format
encoding; being a `FabricPrimitive`, it does not implement the `FabricInstance`
members.

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-primitives/FabricRegExp.ts

import { FabricPrimitive } from './interface';

/**
 * Immutable regular-expression value in the fabric type system.
 *
 * The essential state is `{ source, flags, flavor }` — the values needed to
 * (re)construct an equivalent regex. The `flavor` string identifies the regex
 * dialect; only `"es2025"` (the default) is currently representable as a
 * JS `RegExp`. The `flavor` field is forward-looking for multi-runtime
 * scenarios where different regex engines may be in use.
 *
 * For the `"es2025"` flavor the constructor proactively builds and retains a
 * private `RegExp` (validating the pattern eagerly and making `value` cheap);
 * the retained instance is never handed out directly, so `value` returns a
 * fresh clone on each call. Other flavors store their strings faithfully but
 * cannot yet produce a JS `RegExp`, so `value` throws for them.
 *
 * A JS `RegExp` argument with extra enumerable own properties is rejected
 * (death before confusion).
 */
export class FabricRegExp extends FabricPrimitive {
  // Constructed either from a JS `RegExp` (implying the `"es2025"`
  // flavor) or from explicit `flavor` / `source` / `flags`.
  constructor(regex: RegExp);
  constructor(flavor: string, source: string, flags: string);

  /** The pattern source text. */
  get source(): string;

  /** The flags string (e.g. `"gi"`). */
  get flags(): string;

  /** Regex flavor/dialect identifier (e.g. `"es2025"`). */
  get flavor(): string;

  /**
   * A fresh JS `RegExp` equivalent to this value, returned anew on each
   * call so the internal instance is never aliased out. Throws when the
   * flavor has no JS `RegExp` representation.
   */
  get value(): RegExp;
}
```

#### 1.4.6 `FabricPrimitive`, `FabricInstance`, and `FabricSpecialObject`

The fabric type hierarchy has two abstract classes, and a type naming either:

```
BaseFabricSpecialObject (runtime root; an implementation detail)
├── FabricInstance (abstract — object-like protocol types)
└── FabricPrimitive (abstract — immutable special primitives)

FabricSpecialObject = FabricPrimitive | FabricInstance
```

**`FabricSpecialObject`** is the union of the two classes, which are the only
two kinds of `FabricValue` beyond the JavaScript built-ins. The two differ along
one axis: whether the data model treats an instance as a primitive. A
`FabricPrimitive` is treated the way a built-in `string` or `number` is, and a
`FabricInstance` the way an `object` is. What follows from that, and what a
caller sees of it, is that a `FabricInstance` may hold and expose arbitrary
outgoing `FabricValue` references, and a `FabricPrimitive` may not.

At runtime the two classes extend one root, `BaseFabricSpecialObject` in
`fabric-bases/`, so that `isFabricSpecialObject()` recognizes either with a
single `instanceof`, narrowing to the union. The root is not a type a caller
names, and the data model defines no other subclass of it; an instance of one
defined elsewhere is not a `FabricValue`.

Each class is **nominal**, not structural: each declares a brand member that
exists only in the type system (`declare` emits no runtime member, and nothing
reads the key), keyed by an interned symbol that `api.ts` exports --
`FABRIC_PRIMITIVE_BRAND` and `FABRIC_INSTANCE_PLUS_BRAND`, the latter typed as
the `PlusType` an instance may hold, `never` on `FabricInstance`. This matters
for what `FabricValue` means as a static claim. TypeScript is structurally typed, so were
`FabricPrimitive` empty, every object would satisfy it — and therefore satisfy
`FabricValue`, since the union includes it — and were `FabricInstance` only its
two clone methods, so would every object carrying two methods by those names.
The brands are what make the annotation carry information.

Each brand is a symbol so that it can never be mistaken for data: a
symbol-keyed member has no place in a schema, where a string-keyed one has to
be skipped by name. Each is interned so that every realm and every copy of the
module agree on its value. `packages/data-model/src/api.ts` declares the
identical members; the two must agree exactly, since a value branded by one
would otherwise not satisfy the other, and `api-agreement.ts` stops compiling
when they stop agreeing.

```typescript
// Shown at module scope.
// file: packages/data-model/src/api.ts

/**
 * The two kinds of `FabricValue` beyond the JavaScript built-ins, as one type.
 * The two differ along one axis: whether the data model treats an instance as
 * a primitive. A `FabricPrimitive` is treated the way a built-in `string` or
 * `number` is; a `FabricInstance` is treated the way an `object` is. What
 * follows from that, and what a caller sees of it, is that a `FabricInstance`
 * may hold and expose arbitrary outgoing `FabricValue` references, and a
 * `FabricPrimitive` may not. `isFabricSpecialObject()` narrows to this type
 * with one check.
 *
 * As part of the overall `FabricValue` contract, no instance of either class
 * exposes any enumerable own property; all interaction with an instance is via
 * its concrete class's instance members, and in particular an object-spread
 * (`{ ...instance }`) on an instance always yields an empty object (`{}`).
 */
type FabricSpecialObject = FabricPrimitive | FabricInstance;
```

**`FabricPrimitive`** is the abstract base class for non-`FabricInstance` types
that form the `FabricPrimitive` arm of `FabricValue`.

- `UnknownValue` and `ProblematicValue` are the `FabricInstance` subtypes
  that preserve a type tag alongside their state (Section 3.2).
- `FabricPrimitive` is the base for types that behave like primitives but
  need a class wrapper (`FabricEpochNsec`, `FabricEpochDay`, `FabricHash`,
  `FabricBytes`, `FabricRegExp`, `FabricUnavailable`).

```typescript
// Shown for illustration only.
// file: packages/data-model/src/interface.ts

import type { FabricPrimitiveSchemaType } from "./api.ts";
import { FABRIC_INSTANCE_PLUS_BRAND, FABRIC_PRIMITIVE_BRAND } from "./api.ts";

/**
 * Abstract base class for the `FabricValue`s that participate in the fabric
 * protocol as primitives: values that behave like primitives in the fabric
 * type system but are represented as class instances for type safety and
 * dispatch. Covers temporal types, content IDs, byte sequences, and similar.
 * `FabricSpecialObject` says how this differs from `FabricInstance`.
 *
 * This class enables a single `instanceof` check where code needs to handle
 * any `FabricPrimitive` uniformly.
 *
 * Instances are always frozen (like true primitives, they are immutable), pass
 * through the convertible-JS conversions unchanged, and hold no arbitrary
 * outgoing `FabricValue` reference. `BaseFabricPrimitive` freezes each instance
 * at construction; a subclass keeps its state in private fields, which the
 * freeze does not reach.
 *
 * See Section 1.4.6 of the formal spec.
 */
export abstract class FabricPrimitive extends BaseFabricSpecialObject {
  /**
   * The nominal brand that tells a `FabricPrimitive` from a `FabricInstance`
   * and from every other object, in the type system; without it this class is
   * structurally empty. `declare` emits no runtime member, and nothing ever
   * reads the key. `api.ts` declares the identical member, and
   * `api-agreement.ts` stops compiling if the two stop agreeing.
   */
  declare readonly [FABRIC_PRIMITIVE_BRAND]: true;

  /** Constructs an instance. */
  constructor() {
    super();
  }

  /**
   * Name of this instance's class in the schema `type` vocabulary: the `type`
   * a schema names to admit this value by its class. Every instance of a class
   * reports the same name, which need not be the name of the class. Each
   * concrete class supplies its own, and the getter reads no instance state,
   * so that it returns the same name when read off the class's `prototype`.
   */
  abstract get schemaType(): FabricPrimitiveSchemaType;
}
```

Subclasses define their own state in private fields behind accessors (e.g., a
`#value: bigint` under a `value` getter for temporal types, `#hash: Uint8Array`
and `#tag: string` for content IDs, `#bytes: Uint8Array` for byte sequences).
The base class holds no state — its purpose is to provide a single
`instanceof FabricPrimitive` check where code needs to identify these types
uniformly (e.g., the conversion functions' freeze-bypass logic).

Its one abstract member, `.schemaType`, is how a value reports the name its
class has in the schema dialect's `type` vocabulary
(`docs/specs/json_schema.md`). Every concrete class supplies it as a constant.
The per-class listings in the sections that follow leave it out, as they leave
out each class's codecs.

#### 1.4.7 `FabricEpochNsec`

```typescript
// Shown at module scope.
// file: packages/data-model/fabric-primitives/FabricEpochNsec.ts

/**
 * Temporal type representing nanoseconds from the POSIX Epoch
 * (1970-01-01T00:00:00Z). Direct member of `FabricValue` (not a
 * `FabricInstance`). This is the primary temporal type.
 *
 * JS `Date` has only millisecond precision, so conversion from `Date`
 * multiplies by 10^6 (losing sub-millisecond information). When `Temporal`
 * is available, `Temporal.Instant` maps naturally — it uses nanoseconds
 * from epoch internally.
 *
 * The underlying value is a `bigint`, not a string. This avoids baking
 * in any particular string representation (ISO 8601, etc.) and lets the
 * codec layer use the same bigint encoding as `BigInt@1`.
 */
export class FabricEpochNsec extends FabricPrimitive {
  readonly #value: bigint;

  constructor(value: bigint) {
    super();
    this.#value = value;
  }

  get value(): bigint {
    return this.#value;
  }
}
```

#### 1.4.8 `FabricEpochDay`

```typescript
// Shown at module scope.
// file: packages/data-model/fabric-primitives/FabricEpochDay.ts

/**
 * Temporal type representing a particular day, as a count of days from the
 * POSIX Epoch (1970-01-01).
 * Extends `FabricPrimitive` (not a `FabricInstance`).
 * Anticipates `Temporal.PlainDate`.
 *
 * Mostly nascent — the class and spec entry are defined, but full
 * integration with Temporal types and calendar concerns is deferred.
 *
 * The underlying value is a `bigint`.
 */
export class FabricEpochDay extends FabricPrimitive {
  readonly #value: bigint;

  constructor(value: bigint) {
    super();
    this.#value = value;
  }

  get value(): bigint {
    return this.#value;
  }
}
```

#### 1.4.9 `FabricHash`

```typescript
// Shown at module scope.
// file: packages/data-model/fabric-primitives/FabricHash.ts

/**
 * A content-addressed identifier: a hash digest paired with an algorithm tag.
 * Extends `FabricPrimitive` — treated like a primitive in the fabric type
 * system (always frozen, passes through conversion unchanged).
 *
 * The first algorithm tag is `fid1` ("fabric ID, v1"), which corresponds
 * to the SHA-256-based hash produced by `hashOf()` (Section 6.4).
 *
 * Stringification produces `<tag>:<base64urlHash>` where `<base64urlHash>`
 * is the unpadded base64url encoding (RFC 4648 Section 5) of the hash
 * bytes. For example: `fid1:n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg`.
 *
 * Immutable: instances are `Object.freeze()`-d at construction time, and an
 * instance owns its hash bytes outright, holding a buffer no other code can
 * reach. (JS cannot freeze `ArrayBuffer` contents, so sole ownership is the
 * defense.) The string form is cached internally so that repeated
 * `toString()` calls are O(1).
 */
export class FabricHash extends FabricPrimitive {
  readonly #hash: Uint8Array;
  readonly #tag: string;
  readonly #justHashString: string;
  readonly #fullStringForm: string;

  /**
   * @param hash - The raw hash bytes, as a view or as a whole buffer.
   * @param tag - Algorithm identifier (e.g., `"fid1"` for fabric ID v1).
   * @param transfer - Whether the caller cedes `hash` to this instance, which
   *   permits taking over its buffer instead of copying it. When `true`, the
   *   caller must not use `hash` afterwards.
   */
  constructor(
    hash: Uint8Array | ArrayBufferLike,
    tag: string,
    transfer: boolean = false,
  ) {
    super();
    this.#hash = toOwnedUint8Array(hash, transfer);
    this.#tag = tag;
    this.#justHashString = toUnpaddedBase64url(this.#hash);
    this.#fullStringForm = `${tag}:${this.#justHashString}`;
    Object.freeze(this);
  }

  /** Defensive copy of the raw hash bytes. */
  get bytes(): Uint8Array {
    return new Uint8Array(this.#hash);
  }

  /** Length of the hash in bytes. */
  get length(): number {
    return this.#hash.length;
  }

  /** The algorithm tag (e.g., `"fid1"`). */
  get tag(): string {
    return this.#tag;
  }

  /** String form of the hash _without_ an algorithm tag. */
  get hashString(): string {
    return this.#justHashString;
  }

  /** Copy the hash bytes into `target` starting at offset 0. Returns `target`. */
  copyInto(target: Uint8Array): Uint8Array {
    target.set(this.#hash);
    return target;
  }

  /** Returns `<tag>:<base64urlHash>` (unpadded base64url). */
  override toString(): string {
    return this.#fullStringForm;
  }

  /**
   * Parse an instance from its string representation
   * (`<tag>:<base64urlHash>`). Splits at the FIRST colon: the tag segment is
   * a colon-free identifier (e.g. `fid1`) and the hash segment is base64url
   * (which never contains a colon), so the first colon is the tag/hash
   * boundary. Entity URI schemes (`of:`, `computed:`) are NOT part of this
   * string — a caller must strip the scheme before parsing and carry it
   * alongside, since the scheme is part of the entity's identity. An input
   * that still carries a scheme leaves a colon in what would be the hash
   * segment, which is not valid base64url, so parsing fails loudly rather
   * than silently mis-splitting.
   */
  static fromString(source: string): FabricHash {
    const colonIndex = source.indexOf(":");
    if (colonIndex === -1) {
      throw new ReferenceError(`Invalid content hash string: ${source}`);
    }
    const tag = source.substring(0, colonIndex);
    const hashBase64url = source.substring(colonIndex + 1);
    // The decoded array is freshly allocated and reaches nothing else, so it
    // is ceded rather than copied.
    return new FabricHash(fromBase64url(hashBase64url), tag, true);
  }
}
```

The hash bytes are private (`#hash`). The public API provides:

- `.bytes` — defensive copy of the raw hash bytes.
- `.length` — byte count of the hash.
- `.tag` — the algorithm tag (e.g., `"fid1"`).
- `.hashString` — the hash as an unpadded base64url string, without the tag.
- `.copyInto(target)` — copies hash bytes into a caller-provided buffer.
- `.toString()` — `<tag>:<base64urlHash>`.
- `FabricHash.fromString(s)` — parse from `<tag>:<base64urlHash>` (splits at
  the first colon; entity URI schemes like `of:`/`computed:` are NOT part of
  this string and must be stripped — and preserved — by the caller).

The `tag` field is an opaque string identifier. Known algorithm tags:

| Algorithm Tag | Meaning | Hash Algorithm | Output Size |
|:--------------|:--------|:---------------|:------------|
| `fid1`        | Fabric ID, version 1 | SHA-256 (Section 6.4) | 32 bytes |

Future algorithm tags may be added for different hash algorithms or versioned
content-addressing schemes. The algorithm tag is part of the content ID's
identity — two `FabricHash` instances with the same hash bytes but
different algorithm tags are distinct values.

Like every `FabricPrimitive`, `FabricHash` hosts a `[JSON_CODEC]` (tag
`Hash@1`). Its encoded state is `{ tag, hash }` — the algorithm tag plus the
hash as an unpadded base64url string (i.e., `.hashString`); `canDecode()`
refuses a state that is not a record of two strings, and `decode()` produces a
`ProblematicValue` for a `hash` that is not valid base64url. See Section 5 of
`3-json-encoding.md` for the wire format.

#### 1.4.10 `FabricBytes`

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-primitives/FabricBytes.ts

/**
 * Immutable byte sequence in the fabric type system. Extends `FabricPrimitive`
 * — treated like a primitive (always frozen, passes through conversion
 * unchanged). Direct member of `FabricValue` via the `FabricPrimitive` arm.
 *
 * The underlying bytes are private. Callers access them through:
 * - `length` — the byte count.
 * - `slice()` — returns an unshared copy (or sub-range).
 * - `sliceBuffer()` — the same, as a bare `ArrayBuffer`.
 * - `copyInto()` — copies bytes into a caller-provided buffer.
 *
 * Immutable: instances are `Object.freeze()`-d at construction time, and an
 * instance owns its bytes outright, holding a buffer no other code can reach.
 * (JS cannot freeze `ArrayBuffer` contents, so sole ownership is the defense.)
 */
export class FabricBytes extends FabricPrimitive {
  readonly #bytes: Uint8Array;

  /**
   * Constructs an instance holding the given bytes, which it owns outright.
   *
   * @param bytes - The raw bytes to wrap, as a view or as a whole buffer.
   * @param transfer - Whether the caller cedes `bytes` to this instance, which
   *   permits taking over its buffer instead of copying it. When `true`, the
   *   caller must not use `bytes` afterwards.
   */
  constructor(bytes: Uint8Array | ArrayBufferLike, transfer: boolean = false) {
    super();
    this.#bytes = toOwnedUint8Array(bytes, transfer);
    Object.freeze(this);
  }

  /** The number of bytes. */
  get length(): number {
    return this.#bytes.length;
  }

  /**
   * Return a copy of the bytes (or a sub-range). The returned array is
   * unshared — the caller may mutate it freely.
   */
  slice(start?: number, end?: number): Uint8Array {
    return this.#bytes.slice(start, end);
  }

  /**
   * Return a copy of the bytes (or a sub-range) as a bare `ArrayBuffer`. The
   * returned buffer is unshared — the caller may mutate it freely. This is
   * the form `postMessage()` can transfer.
   */
  sliceBuffer(start?: number, end?: number): ArrayBuffer {
    return this.#bytes.buffer.slice(start ?? 0, end);
  }

  /**
   * Copy bytes from this instance into a caller-provided buffer.
   */
  copyInto(target: Uint8Array, offset?: number, length?: number): number {
    // ... bounds checking, then:
    // target.set(this.#bytes.subarray(offset, offset + toCopy));
    // return toCopy;
  }
}
```

Unlike the previous `FabricUint8Array` (which was a `FabricInstance` wrapping
`Uint8Array` via `FabricNativeWrapper`), `FabricBytes` is a `FabricPrimitive`.
It does not implement the `FabricInstance` members; like every
`FabricPrimitive`, it hosts its own `[JSON_CODEC]` (tag `Bytes@1`), the same
shape as `FabricEpochNsec` and `FabricEpochDay`. The hashing system uses the
dedicated `TAG_BYTES` primitive tag (Section 6.3).

#### 1.4.11 `FabricKeyPair`

`FabricKeyPair` holds an asymmetric key pair, in one of two states:

* It **holds handles**: two `CryptoKey`s, whose material the holding realm may
  have no way to reach.
* It **holds material**: the two keys as bytes, beside the name of the
  algorithm they belong to.

The union is inside the class rather than beside it because the property that
matters here belongs to the value's state rather than to its type. A pair
either holds material or holds handles, and only the first can be written down.
A single fabric type covers the pair whole, so a carrier of one — a message
field, a cell — has nothing to narrow.

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-primitives/FabricKeyPair.ts

export class FabricKeyPair extends FabricPrimitive {
  readonly #algorithm: string;
  readonly #publicKey: CryptoKey | FabricBytes;
  readonly #privateKey: CryptoKey | FabricBytes;

  constructor(pair: CryptoKeyPair);
  constructor(
    algorithm: string,
    publicKey: FabricBytes | Uint8Array,
    privateKey: FabricBytes | Uint8Array,
  );

  /** The algorithm name, in Web Crypto's normalized spelling. */
  get algorithm(): string;

  /** Whether this instance holds key material, as opposed to handles. */
  get hasMaterial(): boolean;

  /**
   * A `CryptoKeyPair` holding this instance's two keys: a new record each
   * call, holding the same two `CryptoKey`s. Throws when this instance holds
   * material.
   */
  get cryptoKeyPair(): CryptoKeyPair;

  /** The public key's handle. Throws when this instance holds material. */
  get publicCryptoKey(): CryptoKey;

  /** The private key's handle. Throws when this instance holds material. */
  get privateCryptoKey(): CryptoKey;

  /** The public key's bytes. Throws when this instance holds handles. */
  get publicKeyBytes(): FabricBytes;

  /** The private key's bytes. Throws when this instance holds handles. */
  get privateKeyBytes(): FabricBytes;
}
```

A pair holding handles is constructed from a `CryptoKeyPair` whose two keys are
a public/private pair agreeing on their algorithm; anything else is refused.
`algorithm` is then read from the keys rather than stored beside them. A pair
holding material is constructed from an algorithm name and the two keys' bytes,
which it copies unless handed a `FabricBytes`, that being already immutable and
sole-owned.

**Only the material state has a byte representation.** A `CryptoKey`'s
material is reachable only through `SubtleCrypto.exportKey()`, which is
asynchronous where a codec's `encode()` is synchronous, and which a
non-extractable key refuses outright. So:

- The JSON encoding **refuses** a pair holding handles: encoding one throws
  (Section 3 of [3-json-encoding.md](./3-json-encoding.md), under
  `KeyPair@1`).
- The **hash** of a pair holding handles is undefined, and computing one throws
  (Section 4.17 of [2-hash-byte-format.md](./2-hash-byte-format.md)). Its
  algorithm name alone is shared by every key that uses that algorithm, so
  hashing it would give distinct keys one identity.
- The **realm encoding** carries the keys themselves (Section 3.4 of
  [4-realm-encoding.md](./4-realm-encoding.md)), which is what a transport
  preserving `CryptoKey` makes possible.

The refusals are the point rather than a gap, and they follow from the key
rather than from any policy about formats. A pair holding handles has no bytes
for a synchronous `encode()` to reach, so a format writing bytes down has
nothing to write; a pair holding material has them, and such a format uses
them. Which state a key is in is settled where it is minted, and that is
upstream of every format here: an algorithm Web Crypto does not implement has
no handle to hold, and an implementation wanting its keys exportable mints
them so.

Carrying a handle is a third thing, and neither writes material down nor needs
it: the key arrives with its extractability unchanged, and whoever reads it
gains nothing a holder of the original did not have. That is what lets a pair
holding handles reach a durable structured-clone store (Section 1.2 of
[4-realm-encoding.md](./4-realm-encoding.md)) while staying unrepresentable in
JSON.

#### 1.4.12 `FabricUnavailable`

`FabricUnavailable` is a marker standing in for data that is not available,
saying why. It holds no data of its own: the reason, and for one reason the
kind of error and a message, are the whole of what it says, which is what
makes it a `FabricPrimitive` rather than a container. A consumer reading a
slot that holds one learns that the value it wanted is not there and why,
rather than reading `undefined` and having to guess among the situations that
could have produced it.

```typescript
// Shown at module scope.
// file: packages/data-model/src/api.ts

/**
 * Why a `FabricUnavailable` stands where data would otherwise be. The two
 * transient reasons say the data is on its way; `error` says producing it
 * failed, and is the one reason that carries a kind and a message.
 */
type UnavailableReason = "pending" | "syncing" | "error";

/**
 * The kinds of failure a `FabricUnavailable` with reason `error` sorts into.
 * `general` is the kind for a failure none of the others describes.
 */
type UnavailableErrorKind =
  | "general"
  | "schemaMismatch"
  | "invalidInput"
  | "network"
  | "decode"
  | "compile"
  | "provider"
  | "sync";
```

The reasons split along one axis, which `isTransient()` reports:

* `pending` — the value is being produced and has not arrived yet.
* `syncing` — the value exists but has not reached this runtime yet.
* `error` — producing the value failed. `errorKind` says how, and
  `errorMessage` says more.

The kinds sort a failure by what failed, so that a consumer can tell a broken
service from a violated data contract without parsing a message:

* `general` — a failure none of the other kinds describes.
* `schemaMismatch` — a value was produced but does not satisfy the schema it
  was read through.
* `invalidInput` — an input was locally complete but not usable, an empty
  URL or a program with no files among them.
* `network` — a network request failed.
* `decode` — a response arrived but could not be decoded.
* `compile` — a program failed to compile.
* `provider` — an external provider reported a failure.
* `sync` — synchronization with stored data failed.

```typescript
// Shown at module scope.
// file: packages/data-model/src/fabric-primitives/FabricUnavailable.ts

/**
 * A marker standing in for data that is not available, saying why.
 * Extends `FabricPrimitive` (not a `FabricInstance`).
 *
 * Only the `error` reason carries a kind, and it always does; only the
 * `error` reason may carry a message. The constructor refuses the other
 * pairings.
 */
export class FabricUnavailable extends FabricPrimitive {
  readonly #reason: UnavailableReason;
  readonly #errorKind: UnavailableErrorKind | null;
  readonly #errorMessage: string | null;

  constructor(
    reason: UnavailableReason,
    errorKind: UnavailableErrorKind | null = null,
    errorMessage: string | null = null,
  ) {
    super();
    if (reason === "error") {
      if (errorKind === null) {
        throw new Error("Reason `error` requires an `UnavailableErrorKind`.");
      }
    } else if (errorKind !== null || errorMessage !== null) {
      throw new Error(
        `Reason \`${reason}\` takes neither an \`errorKind\` nor an ` +
          "`errorMessage`.",
      );
    }
    this.#reason = reason;
    this.#errorKind = errorKind;
    // A message equal to the kind's default is stored as none.
    this.#errorMessage = (errorMessage === defaultMessageFor(errorKind))
      ? null
      : errorMessage;
  }

  get reason(): UnavailableReason {
    return this.#reason;
  }

  get errorKind(): UnavailableErrorKind | null {
    return this.#errorKind;
  }

  /** The message, or the kind's default when none was stored. */
  get errorMessage(): string | null {
    return this.#errorMessage ?? defaultMessageFor(this.#errorKind);
  }

  /** The message as stored, with no default supplied. */
  get rawErrorMessage(): string | null {
    return this.#errorMessage;
  }

  isPending(): boolean {
    return this.#reason === "pending";
  }

  isSyncing(): boolean {
    return this.#reason === "syncing";
  }

  /** Narrows the two error members to what the `error` reason carries. */
  isError(): this is {
    readonly errorKind: UnavailableErrorKind;
    readonly errorMessage: string;
  } {
    return this.#reason === "error";
  }

  isTransient(): boolean {
    return this.#reason !== "error";
  }
}

declare function defaultMessageFor(
  kind: UnavailableErrorKind | null,
): string | null;
```

**The pairing of the error members with the reason is an invariant of the
class**, held by the constructor: reason `error` without a kind, or a
transient reason with a kind or a message, is refused. A wire state carrying
either pairing is therefore one the class never wrote, and decoding it
produces a `ProblematicValue` (Section 3.5) rather than an instance.

**The message has a default, and the default is not state.** `errorMessage`
returns the stored message, or a fixed message for the kind when none is
stored; `rawErrorMessage` returns the stored message alone, `null` when there
is none. A message given at construction that equals its kind's default is
stored as no message at all, so the two ways of arriving at the default are
one state: they encode alike, hash alike, and are equal by content. The
default text is presentation, never encoded or hashed, and may change without
a format change.

**Prefab instances.** The two transient reasons each have one exported
instance, `UNAVAILABLE_PENDING` and `UNAVAILABLE_SYNCING`, and both wire
formats decode a state naming one of those reasons alone to that instance
rather than to a fresh one. Nothing turns on the identity: two instances with
the same state are equal by content (Section 6), and hash the same, however
they were made. The prefabs exist so that the common case allocates nothing.

**Wire state** is `{ reason }` for a transient reason, and for `error`
`{ reason, errorKind }` or `{ reason, errorKind, errorMessage }`, the message
present exactly when `rawErrorMessage` is not `null`, under the tag
`Unavailable@1`. A field with nothing to say is absent from the state rather
than present as `null`. The state is a record of strings, so it is a
`FabricValue` and a realm-crossing value alike: the JSON codec is nonterminal
over it and the realm codec terminal, as for `FabricRegExp` (Section 3.4 of
[4-realm-encoding.md](./4-realm-encoding.md)). The hashing layer feeds the
reason, the kind or `null`, and the raw message or `null`, under the dedicated
`TAG_UNAVAILABLE` (Section 4.18 of
[2-hash-byte-format.md](./2-hash-byte-format.md)).

What flows where — which built-ins produce one and under which kind, how a
computation reacts to one arriving as an input, what a renderer shows while a
value is pending — is the runtime's contract, not the type's, and is
specified where those consumers are.

#### 1.4.13 `FabricLink`

`FabricLink` is a fabric-native `FabricInstance` — like the wrapper classes of
Sections 1.4.2–1.4.4, but not wrapping any convertible JS type — that represents
a **link**: the modern, object-shaped form of a reference to data stored in the
fabric. It wraps a single **payload**, a plain object (`FabricPlainObject`) of
addressing fields, as its sole nested `FabricValue`.

A link is a `FabricInstance` rather than a `FabricPrimitive` because its
payload is an **outgoing reference**, not leaf data: the payload may itself
carry nested `FabricValue`s (for example a schema filter), so a link is a
small object graph rather than an immutable scalar. Like every instance, a
`FabricLink` is mutable until frozen and immutable thereafter, and its protocol
members (`[DEEP_FREEZE]`, `[IS_DEEP_FROZEN]`, `deepClone()`, and the inherited
`shallowClone()`; Section 2.3) recurse through the payload as their one nested
value.

**The data-model does not constrain the payload's field set.** The value
definition here is deliberately general: the data-model requires only that the
payload be a plain object with no prototype-polluting keys, and treats its
entries as arbitrary `FabricValue`s. Which fields a link carries — and what
they mean — is a **consumer concern**: a module that uses links (for example a
runner's cell references) defines its own payload shape on top of this general
form. Keeping the field set unconstrained is what lets `FabricLink` be reused
across consumers, each specializing the general link value in its own way.

Like every fabric class, `FabricLink` hosts a static `[CODEC]` (Section 2.4)
with wire tag `Link@1`. Its encoded state **is** the payload object: the codec's
`encode()` returns the payload directly, and `decode()` rebuilds a `FabricLink`
from it (or a `ProblematicValue`, Section 3.5, if the payload is malformed). The
JSON wire form is the `/Link@1`-tagged envelope `{ "/Link@1": <payload> }`; see
Section 3 of `3-json-encoding.md` for the wire encoding, and the migration table
in Section 4 for how legacy link forms (the IPLD sigil `{ "/": { "link@1": … }
}`) map onto it.

```typescript
// Shown for illustration only.
// file: packages/data-model/fabric-instances/FabricLink.ts

/**
 * A link value: a `FabricInstance` wrapping a plain-object addressing
 * `payload` as its sole nested `FabricValue`. The data-model does not
 * constrain the payload's fields; consumers define their own payload shape.
 */
export class FabricLink extends BaseFabricInstance {
  constructor(payload: FabricPlainObject);

  /** The wrapped addressing payload. */
  get payload(): FabricPlainObject;

  /** The codec for instances of this class; wire tag `Link@1`. */
  static get [CODEC](): NonterminalCodec;
}
```

#### 1.4.14 `bigint` — Not Wrapped

`bigint` is a JavaScript primitive (`typeof x === 'bigint'`), not an object. It
rides through the `FabricValue` layer directly, like `undefined`. No
`FabricBigInt` wrapper class is needed. The codec layer handles `bigint` with a
standalone codec (`BigIntCodec`, analogous to `UndefinedCodec` — there is no
owned class to host a `[CODEC]`); see Section 4.5.

#### 1.4.15 Design Notes

> **Why wrapper classes instead of inline encoder branches?** Each wrapper
> genuinely implements `FabricInstance` and hosts its own `[CODEC]`, so the
> codec system dispatches every wrapper through the same uniform codec path as
> any other fabric class — no per-type branches in the encoder. This gives the
> codec layer a uniform, simpler structure: it handles codec-dispatched values
> and the structural types (arrays, objects, primitives), with no knowledge of
> specific convertible JS types.
>
> **Decoding returns the wrapper.** The `FabricError` codec's `decode()` returns
> a `FabricError`, not a raw `Error`. This is consistent with the three-layer
> separation: the middle layer (`FabricValue`) contains wrappers, not
> convertible JS objects. Code that needs the underlying JS type uses
> `convertibleJsFromFabricValue()` (Section 8) as a separate step.
>
> **File organization.** Each `FabricInstance` and `FabricPrimitive` class lives
> in its own file: the `FabricInstance` subclasses (including the JS object
> wrappers `FabricError`, `FabricMap`, `FabricSet` and the explicit-tag-value
> family) under `packages/data-model/fabric-instances/`; the `FabricPrimitive`
> subclasses (`FabricEpochNsec`, `FabricEpochDay`, `FabricHash`, `FabricBytes`,
> `FabricRegExp`, `FabricUnavailable`) under
> `packages/data-model/fabric-primitives/`.

### 1.5 Plain Containers

Two of the three container arms: the ones whose contents are structural, held
as the value's own indices and keys. The third, `FabricInstance`, keeps its
contents private and is governed by the protocol of Section 2.3 instead.

**Arrays:**
- Direct `Array` instances only: the prototype must be `Array.prototype`
  itself. An `Array` subclass instance, an array whose prototype has been
  severed or replaced, and an array from another realm all cause rejection,
  because an array's prototype has no representation as array content, so
  accepting one could only mean dropping it silently. A subclass prototype is
  live code besides — an overridden `Symbol.iterator`, say, makes iteration
  yield different content than the indices do, and freezing the array does not
  change that. Plain objects are governed by the same principle; see the
  object rule below.
- May be dense or sparse
- Elements may be `undefined` (a first-class `FabricValue`; see Section 1.3)
- Sparse arrays (arrays with holes) are supported; holes are distinct from
  `undefined` and are represented using run-length encoding in serialized forms
  (see below and Section 3 of `3-json-encoding.md` for the specific JSON
  encoding)
- Non-index keys cause rejection, `length` aside: named (string-keyed) and
  symbol-keyed properties alike, whether or not they are enumerable
- Every present index must hold a *data* property: an accessor-backed
  (getter and/or setter) index causes rejection, because an accessor is live
  code rather than an inert value. Index enumerability is not significant,
  because array contents are reached by index rather than by
  enumeration-driven copying

> **Holes vs. `undefined`.** A hole (sparse slot) is distinct from an
> explicitly-set `undefined` element. Given `const a = [1, , 3]`, index `1` is a
> hole — `1 in a` is `false`. Given `const b = [1, undefined, 3]`, index `1` is
> an explicit `undefined` — `1 in b` is `true`. Both must round-trip faithfully:
>
> - Explicit `undefined` elements have a dedicated tagged representation in
>   serialized forms (distinct from `null`).
> - Holes have their own tagged representation, using run-length encoding:
>   each hole entry carries a positive integer count of consecutive holes.
>
> On decoding, hole entries are decoded as true holes (absent indices in the
> resulting array, not `undefined` assignments), preserving the `in`-operator
> distinction. See Section 3 of `3-json-encoding.md` for the specific JSON
> encodings.

> **Array encoding strategy.** Even when an array contains holes, it is encoded
> as an array (not an object or other structure). Runs of consecutive holes are
> replaced by a single hole marker carrying the run length, preserving the array
> structure while efficiently encoding sparse arrays. See Section 3 of
> `3-json-encoding.md` for the specific JSON encoding and examples.

**Objects:**
- Direct `Object` instances only: the prototype must be `Object.prototype`
  itself. A class instance must implement the fabric protocol, and a
  null-prototype object causes rejection, for the reason arrays give above — a
  prototype has no representation as object content, so accepting one could
  only mean dropping it silently. A record therefore has exactly one shape,
  the one the natural syntax produces
- Keys must be strings; symbol-keyed *properties* cause rejection (this is
  distinct from symbol *values*, which are admitted per Section 1.2 with the
  runtime restriction in Section 1.3)
- Every property must be an enumerable *data* property: an accessor-backed
  (getter and/or setter) property causes rejection, because an accessor is
  live code rather than an inert value, and a non-enumerable key causes
  rejection because it has no representation as a property name in
  name-driven copying or encoding
- Values must be valid `FabricValue`s; properties whose value is `undefined` are
  preserved (not omitted) — `undefined` is a first-class value, not a signal for
  deletion
- **Host restriction, not a model rule:** the property names `__proto__` and
  `constructor` cause rejection in the JavaScript implementation. See the
  callout below
- Decoding produces regular plain objects, which is the only object shape a
  `FabricValue` has

> **Property names this implementation reserves.** A `FabricPlainObject`'s keys
> are strings, and the model attaches no meaning to any particular one: a
> property name is data. Two names are nonetheless refused by the JavaScript
> implementation, `__proto__` and `constructor`, for two different reasons —
> neither of which is a limit of the language, and both of which are removable.
>
> `__proto__` cannot be rebuilt by the copying this implementation performs.
> Records are decoded at each boundary — conversion, cloning, decoding — by
> assignment (`target[key] = value`) and `Object.assign()`, and for this name
> both reach `Object.prototype`'s accessor rather than creating a property: the
> value is dropped, and the copy's prototype is repointed as well when that
> value is an object or `null`. Mechanisms that carry the name faithfully do
> exist — spread, `Object.fromEntries()`, `Object.defineProperty()`, and
> `JSON.parse()` — so what stands in the way is the copy loops, not JavaScript.
>
> `constructor` copies faithfully. It is reserved because other boundaries in
> this implementation already refuse it: the projection to JS values drops
> it, and `FabricError` throws on it. Admitting it here would mean accepting a
> key that a later boundary discards without saying so.
>
> The boundary refuses such a record rather than corrupting it in transit
> ("death before confusion"), and a decoder that meets one reports a
> `ProblematicValue` rather than decoding something the bytes do not say.
>
> **This reservation belongs to the implementation, not to the model.** A host
> that does not route property assignment through a prototype chain — Rust,
> Swift, C++, Python, and most others — reserves no names at all and must not
> adopt this rule. Even here it is not permanent: rebuilding the copy loops on
> a faithful mechanism, and revisiting the boundaries that filter these names,
> would retire it. It is expressed as a check separate from the inertness rules
> so that it can be removed as a unit when that happens.

### 1.6 Circular References and Shared References

A `FabricValue` may hold a cycle, and may hold the same object at more than one
position. Whether either survives encoding is a property of the **wire
format and the engine carrying it**, not of the value model, and the two are
separate questions: an engine may preserve shared references while refusing
cycles.

**A conforming engine may support either, both, or neither, and must say
which.** Its documentation states, for cycles and for shared references
separately, whether it reproduces the graph as it stands, flattens it to a
tree, or refuses the value. Silence is underspecification rather than
permission: a caller cannot read the answer off the value, and must not have to
read it off an implementation.

What no engine may do is any of the three silently. A refusal is raised at
encode time, and a flattening is documented — because a cycle quietly
expanded, or a shared subtree quietly copied in two, is a value that decodes
to a different graph than the one encoded, with nothing at either end saying
so.

**Conversion is decided separately from encoding, and refuses a cycle.**
`fabricFromConvertibleJsValue()` builds a `FabricValue` out of JS data, and
will not build one containing a cycle; it preserves shared references, so the
converted form for a given original is reused and structural sharing survives.
That is a third answer under the same rule, not an exception to it: membership
admits a cycle -- `isValidFabricValue()` handles one and returns `true` -- while
this entry point declines to construct one. A value holding a cycle therefore
reaches the model by being built directly rather than converted.

Note that preserving shared references means preserving _structure_: the same
encoded subtree appears at each position it appeared at. Whether the decoded
objects are `===` to each other is a further promise, which an engine states
only if it makes it.

Cycles *across* documents are a separate matter, and are supported whatever an
engine does within one. They are written as explicit links (`FabricInstance`s
referencing other documents), so two cells may reference each other and form a
cycle in the broader data graph without any single cell's content containing
one.

---

## 2. The Fabric Protocol

### 2.1 Overview

Types that the system controls opt into storability by implementing members
keyed by well-known symbols. This allows the system to encode and decode custom
types without central registration at the type level.

The protocol has two complementary halves:

- The **instance protocol** (Section 2.3) covers in-process lifecycle: deep
  freezing and cloning. Its members live on each instance.
- The **codec protocol** (Section 2.4) covers encoding: each class hosts a
  `FabricCodec` — an encoder-decoder object that is the **single source of
  truth** for how instances of that class are encoded — as a static getter keyed
  by the `CODEC` symbol.

This split deliberately separates wire-format concerns from live in-process
representation: the codec vocabulary lives in its own module area
(`codec-interface/`), separate again from the machinery that reads it
(`codec-common/`), and the dependency-free `interface.ts` carries no codec
machinery at all. Two motivations drove this shape: the seam between
`FabricValue`'s encoding/decoding and the JSON-layer serialization had grown
rough and needed harmonizing, and the previous design had no clean affordance
for legacy-data migration/import (see the decode-only tag discussion in Section
2.4).

### 2.2 Symbols

The encoding symbols live with the codec vocabulary; the in-process
lifecycle symbols live on the implementation base class `BaseFabricInstance`
(Section 2.3), kept off the pure-protocol `FabricInstance` interface as
implementation plumbing.

There is one encoding symbol per wire format, plus the format-neutral
`CODEC` (Section 2.4). A registry reads the format's own symbol through a
variable rather than naming it, which is what lets one curated class list serve
every format.

Each is a genuinely unique symbol rather than a registry-interned one, so a
member keyed by it is reachable only by importing the symbol. The string passed
to `Symbol()` is a description, for debugging; it is not a key anything can look
the symbol up by.

```typescript
// file: packages/data-model/codec-interface/interface.ts

/**
 * Well-known symbol for binding the getter
 * `FabricClassWithNonterminalCodec[CODEC]`.
 * A class hosts its encoding codec as a static getter keyed by this
 * symbol (see Section 2.4).
 */
export const CODEC: unique symbol = Symbol('data-model.codec');

/**
 * Well-known symbol for binding the static getter `[JSON_CODEC]` on a
 * `FabricPrimitive` class. A class binds its codec per wire format, not
 * once for all of them, where the formats disagree about it (see Section
 * 2.4).
 */
export const JSON_CODEC: unique symbol =
  Symbol('data-model.jsonCodecEngine');
```

```typescript
// file: packages/data-model/fabric-bases/BaseFabricInstance.ts

/**
 * Well-known symbol for deeply freezing a `FabricInstance` in place. The
 * implementation freezes the instance's own internal slot(s) and recurses
 * into any nested `FabricValue`s via a `subFreeze` callback supplied by the
 * generic `deepFreeze()` utility. See Section 8.6.
 */
export const DEEP_FREEZE: unique symbol = Symbol('data-model.deepFreeze');

/**
 * Well-known symbol for checking whether a `FabricInstance` is already
 * deeply frozen, without mutating it. The side-effect-free sibling of
 * `[DEEP_FREEZE]`: verifies the instance's own internal slot(s) are in
 * canonical deep-frozen form and recurses into any nested `FabricValue`s
 * via a `subIsDeepFrozen` callback, returning the boolean conjunction.
 * See Section 8.6.
 */
export const IS_DEEP_FROZEN: unique symbol = Symbol('data-model.isDeepFrozen');

/**
 * Well-known symbol for the **internal** shallow-clone hook: a `protected`
 * template-method member that returns a new unfrozen copy of a fabric
 * instance. Unlike `[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]`, which the generic
 * freeze utility invokes externally, this member is not part of the external
 * protocol surface — concrete subclasses implement it, and the
 * `shallowClone()` template method on `BaseFabricInstance` is its only caller
 * (Section 2.3).
 */
export const SHALLOW_UNFROZEN_CLONE: unique symbol = Symbol(
  'data-model.shallowUnfrozenClone',
);

// Protocol evolution: a further exported symbol, e.g.
// `Symbol('data-model.codec@2')`.
```

### 2.3 Instance Protocol

`FabricInstance` is the **pure abstract protocol surface** — the
`instanceof`-able contract that external code is written against. It declares
the two protocol members a caller reaches, `deepClone()` and `shallowClone()`,
as `abstract`, and carries no implementations. The freeze-protocol members
`[DEEP_FREEZE]` and `[IS_DEEP_FROZEN]` are declared on a separate abstract base
class `BaseFabricInstance` (below), which is also where shared template-method
scaffolding lives and which subclasses extend in practice.

The instance protocol covers in-process lifecycle only — deep freezing and
cloning. Encoding is **not** an instance concern: it lives on the
class-side `[CODEC]` (Section 2.4).

```typescript
// Shown for illustration only.
// file: packages/data-model/src/interface.ts

import { FABRIC_INSTANCE_PLUS_BRAND, FABRIC_PRIMITIVE_BRAND } from "./api.ts";

/**
 * Abstract base class for the `FabricValue`s that participate in the fabric
 * protocol as non-primitives. An instance may hold and expose arbitrary
 * outgoing `FabricValue` references, and is mutable until frozen.
 * `FabricSpecialObject` says how this differs from `FabricPrimitive`. See
 * Section 2.3 of the formal spec.
 *
 * This is the pure abstract protocol -- the `instanceof`-able contract that
 * external code is written against. Concrete `FabricInstance` classes in the
 * data-model extend `BaseFabricInstance` (a subclass of this one) rather
 * than this class directly; `BaseFabricInstance` is where shared
 * template-method scaffolding (such as `shallowClone()`) lives.
 *
 * An instance holds all of its state privately and makes it reachable only
 * through members, so it has no enumerable own properties. A structural view
 * of one -- a spread, `Object.keys()`, a naive walk -- therefore sees nothing.
 * Mutable state is exposed as an accessor pair over a private field, whose
 * setter is responsible for honoring the instance's frozen state:
 * `Object.freeze()` bears only on own properties and so cannot enforce that
 * on its own.
 *
 * Subclasses must implement `deepClone()` and `shallowClone()`; both are
 * normally inherited from `BaseFabricInstance` as template methods, with the
 * subclass supplying the symbol-keyed clone core each one calls. The
 * freeze-protocol members `[DEEP_FREEZE]()` and `[IS_DEEP_FROZEN]()` are
 * declared on `BaseFabricInstance`, not here: they are implementation plumbing
 * and are kept off this pure-protocol class.
 */
export abstract class FabricInstance extends BaseFabricSpecialObject {
  /**
   * The nominal brand that tells a `FabricInstance` from any other object with
   * the two clone methods, in the type system, at `never` since an instance of
   * this class holds only `FabricValue`s; the runtime root carries no brand,
   * so this member is what makes the class nominal. `declare` emits no runtime
   * member, and nothing ever reads the key. `api.ts` declares the identical
   * member, and `api-agreement.ts` stops compiling if the two stop agreeing.
   */
  declare readonly [FABRIC_INSTANCE_PLUS_BRAND]: never;

  /**
   * Returns a new deep clone of this instance with equivalent data but no
   * shared structure for any unfrozen data in the original. When `frozen ===
   * true`, produces a frozen instance with maximal structural sharing,
   * including returning `this` if it is already deep-frozen. When `frozen ===
   * false`, produces a deeply-mutable instance with no visible shared reference
   * structure with the original.
   *
   * The concrete template-method implementation lives on `BaseFabricInstance`
   * (deferring to the `[DEEP_CLONE_CORE]` sibling, mirroring the
   * `shallowClone()`/`[SHALLOW_UNFROZEN_CLONE]()` split); this declaration just
   * pins the protocol surface so that callers can invoke it through a
   * `FabricInstance` reference.
   */
  abstract deepClone(frozen: boolean): FabricInstance;

  /**
   * Returns a shallow clone of this instance with the requested frozenness.
   * The concrete template-method implementation lives on
   * `BaseFabricInstance`; this declaration just pins the protocol surface so
   * that callers can invoke it through a `FabricInstance` reference.
   */
  abstract shallowClone(frozen: boolean): FabricInstance;
}
```

```typescript
// Shown for illustration only.
// file: packages/data-model/src/fabric-bases/BaseFabricInstance.ts

/**
 * Abstract base class providing shared scaffolding for `FabricInstance`
 * subclasses. Concrete `FabricInstance` classes extend this, not
 * `FabricInstance` directly: `FabricInstance` is the pure abstract protocol
 * (the `instanceof`-able contract that external code is written against), while
 * `BaseFabricInstance` is where shared template-method implementations and the
 * freeze-protocol plumbing (`[DEEP_FREEZE]()`, `[IS_DEEP_FROZEN]()`) live.
 */
export abstract class BaseFabricInstance extends FabricInstance {
  //
  // Subclass contract
  //

  /**
   * Deeply freezes this instance in place: freezes this instance's own
   * internal slot(s) and recurses into each nested `FabricValue` by calling
   * the provided `subFreeze` callback on it. Implementations must NOT import
   * or call `deepFreeze()` directly -- recursion is handed through the
   * callback so that the freeze utility's caching / cycle-detection
   * bookkeeping is preserved and no import cycle is introduced.
   *
   * Returns the (now deeply-frozen) value. Freeze-in-place implementations
   * return `this`.
   */
  abstract [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue;

  /**
   * Indicates whether this instance is already deeply frozen, without mutating
   * it. Checks this instance's own internal slot(s) are in canonical
   * deep-frozen form and recurses into each nested `FabricValue` via the
   * provided `subIsDeepFrozen` callback, returning the boolean conjunction.
   * Implementations must NOT import or call the deep-frozen type guard directly
   * -- recursion is handed through the callback, mirroring `[DEEP_FREEZE]`'s
   * callback shape and avoiding an import cycle.
   *
   * Side-effect-free and must not throw: an instance that is not in canonical
   * deep-frozen form returns `false`.
   *
   * **Deep-frozen honesty (mandatory).** This report must be truthful and
   * permanent: an implementation must not return `true` unless the instance is,
   * and will remain, deeply immutable (including its private slots). Once it
   * reports deep-frozen, that is permanent for the life of the instance. The
   * rest of the system -- the data model in general and `isDeepFrozen()`
   * specifically, but also the entire codebase that _uses_ the data model -- is
   * entitled to rely on this: a deep-frozen proof is cached by root identity
   * and not re-validated, so an instance that lies here (reports deep-frozen
   * while still mutable) can corrupt data-model invariants, exactly as any
   * other broken class contract can. Making this correct is the implementing
   * class's responsibility, not something the freeze-checking code papers over.
   */
  abstract [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean;

  /**
   * Returns a new unfrozen copy of this instance with the same data. Called
   * by `shallowClone()` when a new instance is needed.
   */
  protected abstract [SHALLOW_UNFROZEN_CLONE](): FabricInstance;

  /**
   * Returns a new deep clone of this instance, cloning nested `FabricValue`s
   * to the requested frozenness (see `[DEEP_CLONE_CORE]`'s symbol doc). The
   * returned instance itself is not yet frozen: the `deepClone()` template
   * method owns the identity optimization and the final freeze. Called by
   * `deepClone()` when a fresh instance is needed.
   */
  protected abstract [DEEP_CLONE_CORE](frozen: boolean): FabricInstance;

  //
  // Instance members
  //

  /**
   * Returns a shallow clone of this instance with the requested frozenness.
   *
   * When `frozen` is `true` and this instance is already frozen, returns
   * `this` (identity optimization -- freezing is idempotent). In all other
   * cases, creates a new instance via `[SHALLOW_UNFROZEN_CLONE]()` and freezes
   * it if requested.
   *
   * This effectively-final template method manages the frozenness
   * contract:
   * - `shallowClone(true)` on a frozen instance returns `this` (identity).
   * - `shallowClone(true)` on an unfrozen instance returns a frozen clone.
   * - `shallowClone(false)` always returns a new unfrozen clone -- even
   *   if the instance is already unfrozen. The caller gets a distinct,
   *   mutable object.
   */
  shallowClone(frozen: boolean): FabricInstance {
    if (frozen && Object.isFrozen(this)) return this;
    const copy = this[SHALLOW_UNFROZEN_CLONE]();
    return frozen ? Object.freeze(copy) as FabricInstance : copy;
  }
}
```

> **Why an abstract class, not an interface?** An abstract class is what lets
> `shallowClone()` be an effectively-final template method (on
> `BaseFabricInstance`), encapsulating the frozenness-management contract
> (clone-if-necessary, freeze-if-requested) in one place. Concrete subclasses
> implement only the two clone cores, `[SHALLOW_UNFROZEN_CLONE]()` and
> `[DEEP_CLONE_CORE]()` (the type-specific copy logic), plus the deep-freeze
> pair; encoding lives on the class's `[CODEC]` (Section 2.4). Brand detection
> uses `instanceof FabricInstance` directly — no type guard function is needed
> (see Section 2.6).

> **Why a separate `BaseFabricInstance`?** Keeping `FabricInstance` pure
> abstract (no implementations) gives the protocol surface a clean, minimal
> definition for external consumers: the pattern-visible declaration in
> `packages/data-model/src/api.ts`, which `packages/api/` re-exports, exposes
> `FabricInstance` with just its protocol members, and `BaseFabricInstance`
> stays an internal implementation detail of the data-model package. External
> code written against `FabricInstance` is therefore stable against changes to
> the template-method scaffolding, and the `instanceof FabricInstance` brand
> check still catches every concrete `FabricInstance` value.

> **An aside on sealing instances.** Nothing in this model requires it, and an
> implementation is free to skip it, but a JavaScript implementation may want
> to seal an instance so that adding a property to one throws rather than
> silently attaching data that no structural view, encoder, or hash will read.
> Doing so takes one wrinkle. `Object.isFrozen()` reports `true` for any sealed
> object with no own properties, so an instance holding all of its state
> privately would report as frozen from the moment it was built, and a request
> for a mutable copy would hand back the original. Giving the instance a single
> writable own property, keyed by a symbol and non-enumerable, is enough to fix
> that: `Object.freeze()` clears the property's `writable` bit, so
> `Object.isFrozen()` again tracks the instance's frozen state. Such a property
> is invisible to a spread, `Object.keys()`, and `JSON.stringify()` alike, so
> instances still present no properties to a client.

### 2.4 Codec Protocol

Encoding participation is class-level, not instance-level: a class hosts a
**codec** — an encoder-decoder object implementing
`FabricCodec<PlusType, Encoded>` — as a static getter keyed by a well-known
symbol. The codec is the **single source of
truth** for how instances of that class are encoded; nothing about encoding
lives on the instances themselves.

`PlusType` is what the values a codec works on may hold beyond `FabricValue`:
the value side of every member is `FabricValuePlus<PlusType>`, so a codec at
`never` works over `FabricValue` exactly. `Encoded` is the domain a codec's
essential state lives in, and it divides codecs into two kinds. A
**nonterminal** codec's state is made of `FabricValuePlus<PlusType>`s, which the
walker goes on to expand in turn; the sense is the one formal grammars give the
word, a state that is not yet an answer. A **terminal**
codec's state is already in one wire format's own domain, and the walker passes
it through. `FabricError` is the clearest nonterminal case — its state carries
`cause` and every extra entry, so it can hold arbitrary nested values, and only
the walker can know what to do with them. `FabricBytes` is the clearest terminal
one: JSON's codec produces a base64url string, where a format carrying bytes
natively wants the bytes themselves.

Which kind a codec is cannot be read off its signature, because the domains
overlap — an all-string record satisfies `FabricValue` and JSON's value type
alike. A codec therefore **declares** its kind by which base class it extends,
and everything downstream reads that declaration.

The kind belongs to the pair (class, format) rather than to the class, and the
symbol a class binds under is a separate question from the kind. Binding
`[CODEC]` is the class-level claim that **one codec serves every format**; a
terminal codec can never make that claim, since its state is in one format's
domain, so a class binding here supplies a nonterminal one. Nothing enforces
that: a registry refuses only a codec extending neither base, so a terminal
codec bound here is accepted and its state reaches the wire unexpanded. A class
the formats want to treat differently — in the state produced, in the kind of
codec, or both — binds one per format under that format's own symbol instead,
such as `JSON_CODEC` for the JSON wire format, and what it supplies there may be
of either kind.

So the symbol tracks whether the formats agree about the class, while the kind
is settled per (class, format). `FabricRegExp` shows both halves at once: it
binds per format, and what it gives JSON is *nonterminal*, expanding into a
record of strings because JSON has no pattern type of its own to terminate
into.

```typescript
// Shown at module scope.
// file: packages/data-model/codec-interface/interface.ts

/**
 * Interface for codecs (encoder-decoder objects). These are objects which
 * can extract "essential state" out of values (objects per se or otherwise)
 * and also take such "essential state" and produce values that are
 * equivalent (in a context-dependent sense) to the values that state was
 * extracted from.
 *
 * `PlusType` is what the values this codec works on may hold beyond
 * `FabricValue`: the value side of every member is
 * `FabricValuePlus<PlusType>`, so a codec at `never` works over `FabricValue`
 * exactly. `Encoded` is the domain that essential state lives in. Every codec
 * has the same shape whatever those two are -- the same matching members,
 * the same pair of transformations -- and they are the only things that
 * vary.
 */
export interface FabricCodec<PlusType, Encoded> {
  /**
   * The unique _direct_ class of instances, if any, that is associated with
   * the format this instance encodes. The codec system uses this to make a
   * quick determination about value compatibility before calling
   * `canEncode()` to confirm.
   */
  get uniqueHandledClass(): Constructor | undefined;

  /**
   * The unique wire format tag that is associated with the format this
   * instance decodes from, or `undefined` for a codec with no single tag.
   * When defined, the codec system uses it to mark state produced by
   * `encode()` and (by default) routes state so marked back to this
   * instance (or an equivalent) for decoding; a codec with no tag is not
   * registered for tag-based decode dispatch.
   */
  get recognizedTypeTag(): string | undefined;

  /** Returns `true` if this handler can encode the state of the given
   *  value. */
  canEncode(value: FabricValuePlus<PlusType>): boolean;

  /**
   * Returns `true` if the given state is one this codec knows how to
   * decode: the decode side's counterpart to `canEncode()`, answering the
   * same kind of question about whether a value is in the domain this codec
   * works over.
   *
   * What belongs here is what is cheap to ask and not already asked by the
   * decoding: the state's type, the presence and types of the parts a
   * decode reads, membership in a fixed set of literals. What does not
   * belong is a check whose only implementation is the decode itself.
   * Whether a string is valid base64 is answered by decoding it, so asking
   * here costs that work twice; `decode()` keeps such a question and is
   * where a state failing it is refused.
   *
   * An implementation states this as a type predicate over its own state
   * type, which is what lets its `decode()` declare that same type and read
   * the state's parts without re-checking them.
   *
   * Called on every state before `decode()` sees it, so an implementation of
   * the latter may take the check as done.
   */
  canDecode(state: Encoded): boolean;

  /**
   * Returns the wire type tag to use when encoding the given value. Only
   * ever called on a value for which `canEncode()` has returned `true`.
   * Unlike `recognizedTypeTag` -- the codec's single recognized tag, if it
   * has one -- this is the concrete tag for a _specific_ value; a codec
   * whose instances each carry their own per-instance tag reads it from
   * the value.
   */
  tagForValue(value: FabricValuePlus<PlusType>): string;

  /**
   * Decodes a value from the given essential state, which is (alleged /
   * supposed) to be a value that was produced by an earlier call to
   * `encode()` on a compatible class to this one. The result is expected
   * to be a _shallow_ decoding. The codec system handles recursively
   * converting `state` contents as necessary.
   *
   * The given `typeTag` is what was associated with the given `state` and
   * does not necessarily correspond to `recognizedTypeTag` (depending on
   * how an instance of this class got hooked up).
   *
   * Only ever called on a state for which `canDecode()` has returned `true`,
   * which is the decode side's counterpart to the way `canEncode()` precedes
   * `encode()`. That is what lets an implementation declare the narrower
   * state type it actually decodes and read its parts as such. `state` is the
   * whole of `Encoded` here because this interface is what a registry holds,
   * and the codecs in one agree on nothing narrower.
   */
  decode(
    typeTag: string,
    state: Encoded,
    env: LiveEnvironment,
  ): FabricValuePlus<PlusType>;

  /**
   * Encodes the given value, returning its essential state. This is only
   * ever called after `canEncode()` has confirmed that `value` is
   * encodable by this instance. The result is expected to be a _shallow_
   * encoding. The codec system handles recursion as necessary.
   *
   * `env` is what a codec reaches the running system through, the same one
   * `decode()` is handed.
   */
  encode(value: FabricValuePlus<PlusType>, env: LiveEnvironment): Encoded;
}

/**
 * A codec whose essential state is **nonterminal**: it is itself made of
 * `FabricValuePlus<PlusType>`s, which the walker goes on to expand in turn.
 * Instantiating `FabricCodec` with its state domain equal to its value
 * domain is what says so, because that is the walker's own input domain.
 * One instance serves every wire format.
 *
 * `PlusType` is what the instances this codec exposes may hold, and its
 * state holds the same. At `never`, the default, both sides are
 * `FabricValue`, which is the one kind a wire format's registry takes. At
 * any other `PlusType` the codec exposes an instance's contents, that type
 * included, to a walker that admits it, and has no wire form.
 */
export type NonterminalCodec<PlusType = never> = FabricCodec<
  PlusType,
  FabricValuePlus<PlusType>
>;

/**
 * A codec whose essential state is **terminal**: it is already in the domain
 * of one particular wire format, and the walker passes it through rather
 * than expanding it further. Such a codec is bound to that one format, and a
 * class needing one supplies a separate instance per format it participates
 * in.
 *
 * `Encoded` ranges over the wire formats' own value types. `FabricValue` is
 * not among them, and instantiating at it is unsound.
 *
 * The value side is at `never`: a wire format carries `FabricValue`s, and a
 * value holding anything beyond those has no wire form to terminate into.
 */
export type TerminalCodec<Encoded> = FabricCodec<never, Encoded>;

/**
 * A codec usable for the wire format whose value type is `Encoded`: either
 * kind serves. A terminal codec serves that format alone, a nonterminal one
 * serves every format, and both are "for" this one.
 *
 * Writing the union out is unavoidable. `FabricCodec` is covariant in
 * `Encoded`: its members are methods, whose parameters TypeScript compares
 * bivariantly, so the return position of `encode()` is what decides, and a
 * codec is assignable to an instantiation at a wider `Encoded` and to none
 * at a narrower one. `FabricValue` is a subtype of no format's value type,
 * so a `NonterminalCodec` is assignable to no format's instantiation, and
 * the two arms have to be named separately.
 *
 * The nonterminal arm is at `never`, the one `PlusType` with a wire form.
 * That is a claim about what a registry holds, not a check on what a class
 * binds: `CodecRegistry` reads a class's `[CODEC]` through a cast, so a codec
 * at another `PlusType` registers as this type, and what refuses its state
 * is the encode walk, which finds a value no codec claims.
 */
export type CodecForFormat<Encoded> =
  | NonterminalCodec
  | TerminalCodec<Encoded>;

/**
 * A wire format, as `CodecRegistry` needs to know one: the type its encoded
 * states live in, and the symbol under which a class binds its codec for
 * this format. The symbol arrives as data rather than being known here,
 * which is what keeps this module from naming any particular format.
 */
export interface WireFormat<Encoded> {
  /**
   * Symbol under which a class binds the codec it supplies for this format.
   * Consulted only when the class binds no format-neutral `[CODEC]`, which
   * wins where a class has both.
   */
  readonly codecSymbol: symbol;
}

/**
 * Interface for classes that provide a `NonterminalCodec` which is
 * guaranteed to operate on instances of the class. Binding here is the claim
 * that one codec serves every wire format.
 *
 * `PlusType` is the class's own: a class whose instances are
 * `FabricInstancePlus<PlusType>` binds its codec at that same `PlusType`, so
 * that the state the codec exposes is typed for what the instances hold.
 * `codecOf()` types its result on that agreement and does not check it.
 */
export interface FabricClassWithNonterminalCodec<PlusType = never> {
  /** The codec instance to use for instances of this class. */
  get [CODEC](): NonterminalCodec<PlusType>;
}
```

There is no counterpart interface for a per-format binding, and there can be
none: `CodecRegistry` reads a per-format codec through a symbol *variable*, so
it types a class as `Partial<Record<symbol, ...>>`, which no fixed-symbol
interface satisfies. `FabricClassWithNonterminalCodec` can exist only because
`CODEC` is statically known. The obligation a per-format interface would state
is enforced when a registry is built instead (Section 4.5).

Three base classes round out the vocabulary:

- **`BaseFabricCodec<PlusType, Encoded, State extends Encoded = Encoded>`**
  (`codec-interface/BaseFabricCodec.ts`) supplies the common scaffolding: a
  constructor taking `(recognizedTypeTag, uniqueHandledClass)`, an
  `instanceof`-based `canEncode()`, and a `tagForValue()` that returns
  `recognizedTypeTag` (a codec with no recognized tag — whose instances carry
  per-instance tags — must override it). It is abstract in `encode()`,
  `canDecode()` and `decode()` and, deliberately, in identity: a concrete codec
  extends one of the two below rather than this directly.
- **`BaseNonterminalCodec<PlusType = never, State extends
  FabricValuePlus<PlusType> = FabricValuePlus<PlusType>>`**
  (`codec-interface/BaseNonterminalCodec.ts`) adds nothing but the
  `FabricValuePlus<PlusType>` domain, on the value side and the state side
  alike, and its own identity, and the identity is the point: `CodecRegistry`
  reads it to know that a state coming out of here is more work rather than an
  answer. `PlusType` comes first so that `State` can default to the whole of
  the domain it bounds; a codec naming its state alone writes `never` ahead of
  it.
- **`BaseTerminalCodec<Encoded, State extends Encoded = Encoded>`**
  (`codec-interface/BaseTerminalCodec.ts`) is its opposite number, telling the
  registry that a state coming out of here is the answer, with the value side
  at `never`. Extending one of these two fixes the `PlusType` and `Encoded`
  domains in the same stroke as the declaration, so the two cannot drift
  apart.

`State` is the codec's own state type, a subtype of the format-wide `Encoded`:
what `encode()` emits, what `canDecode()` narrows to as a type predicate, and
the only thing `decode()` is handed. One declaration serving all three members
is what says the three agree, and it is what lets a decoding read its state's
parts as the types `canDecode()` established them to be. That narrower
parameter is true rather than merely declared because the engine asks
`canDecode()` of every state before dispatching one to a codec. A codec that
works over the whole of `Encoded` leaves it at the default.

`TerminalCodec<FabricValue>` and `NonterminalCodec` are the same type, so a
subclass of `BaseTerminalCodec` declared at `FabricValue` would satisfy the
nonterminal half of every signature while classifying as terminal at run time,
and its state would reach the wire unexpanded. Nothing enforces this; a codec
whose state is made of `FabricValue`s extends `BaseNonterminalCodec`.

Lookup goes through **`codecOf(value, altCodec?)`**
(`codec-common/codecOf.ts`), which returns a value's class's `[CODEC]`,
throwing a "shouldn't happen" error if the class has none. The result is typed
at the value's own `PlusType`, on the contract `FabricClassWithNonterminalCodec`
states, and nothing checks that the class kept it. The hashing system (Section
6) and other instance-state walkers use it. A `FabricPrimitive` binds
no `[CODEC]`, so the one-argument form throws for one; a caller wanting a
primitive's codec passes the symbol of the format it means as `altCodec`, which
is consulted only when `[CODEC]` is absent. The alternative arrives as a
parameter rather than being known there, which is what keeps this module from
naming any particular format.

Key contracts:

- **Codecs are shallow.** `encode()` returns one layer of essential state
  without recursing into nested values; `decode()` receives state whose nested
  values have already been decoded. The codec engine owns recursion and
  tag-wrapping (Section 4.5), which keeps the format mechanics in one place
  rather than spread across every codec.
- **`canDecode()` runs before every decode.** The engine asks it of each state
  it is about to dispatch, so a state reaches `decode()` only once that codec
  has accepted it and is of the type that method declares. A refusal is a
  rejection of wire data like any other, and the engine settles it against
  `lenient` exactly as it settles one the codec raises from inside the
  decoding (Section 4.5).
- **`decode()` is codec-side, not constructor-side**, for two reasons: it
  receives a `LiveEnvironment` (Section 2.5) which shouldn't be mandated in a
  constructor signature, and it may return an existing instance (interning)
  rather than creating a new one — essential for types like `Cell` where
  identity matters.
- **`recognizedTypeTag` vs. `decode()`'s `typeTag` parameter.** The former is
  the single tag a codec is *registered* under; the latter is whatever tag the
  value *actually carried* on the wire. They usually agree, but the distinction
  is deliberate: a registry can route a legacy or alternate tag to an equivalent
  codec (a decode-only hookup), which is the affordance for legacy-data
  migration/import. The canonical tag constants (`CODEC_TYPE_TAGS`,
  `codec-interface/codec-type-tags.ts`) reserve a section for exactly such
  decode-only "non-primary versions" of classes (e.g., a future `Map@2` decoding
  into the same class as `Map@1`).
- **The wire surface is explicit and curated.** Which classes participate in
  encoding is determined by curated `codecClasses()` lists (one each in
  `fabric-primitives/` and `fabric-instances/`), not by ad-hoc registration
  scattered across the codebase. See Section 4.5.

### 2.5 Live Environment

```typescript
// Shown at module scope.
// file: packages/data-model/codec-interface/interface.ts

/**
 * The minimal interface that codec `encode()` and `decode()` implementations
 * may depend on: what a codec needs of the live system around it, and
 * nothing more. This package names what it requires rather than the classes
 * that happen to supply it, so a client brings its own.
 * `BaseLiveEnvironment` is the base to build one on, and
 * `NullLiveEnvironment` covers a caller that expects to need no cell.
 */
export interface LiveEnvironment {
  /**
   * Resolves a cell reference. Used by types that need to intern or look
   * up existing instances during decoding.
   */
  getCell(ref: { id: string; path: string[]; space: string }): FabricInstance;

  /**
   * Output-contract directive: when `true`, every codec `decode()`
   * implementation that consults this live environment must produce a deep-frozen
   * result; when `false`, a mutable result is acceptable. Same contract as
   * the `frozen` argument to `cloneIfNecessary()` (see
   * `packages/data-model/value-clone.ts`): `shouldDeepFreeze === true`
   * corresponds to `cloneIfNecessary(value, { frozen: true })`.
   *
   * Required (not optional): every live environment declares it. A shared
   * `BaseLiveEnvironment`
   * (`packages/data-model/src/codec-interface/BaseLiveEnvironment.ts`)
   * centralizes the getter with a `true` default, mirroring
   * `cloneIfNecessary()`'s default; environments opt out by overriding. An
   * `NullLiveEnvironment` (same directory) covers environment-less
   * decodes: its `getCell()` throws with a configurable message.
   */
  readonly shouldDeepFreeze: boolean;
}
```

> **Why an interface rather than a named class?** `packages/data-model/` is a
> standalone low-level package, and a requirement it states as an interface is
> one any client can satisfy. It has several already -- `memory` builds one,
> as do tests in `data-model` and `runner` -- and more are expected. Future
> fabric types may extend `LiveEnvironment` if they need capabilities beyond
> `getCell` and `shouldDeepFreeze`.

### 2.6 Brand Detection

Because `FabricInstance` is an abstract class, the idiomatic brand check is
`instanceof`:

```typescript
// Shown at module scope.
if (value instanceof FabricInstance) {
  // value is a FabricInstance
}
```

No dedicated type guard function is needed.

> **Why `instanceof` rather than a property-brand check.** `FabricInstance`
> being an abstract class, `instanceof` is both the natural check and the more
> robust one: a property-brand test such as `DECONSTRUCT in value` admits any
> object that happens to carry that property without extending the base class.

### 2.7 Example: Temperature (Illustrative)

The following example is artificial, designed to illustrate the `FabricInstance`
protocol. It is not part of the codebase.

A `Temperature` value type demonstrates why the protocol exists: without it, a
`Temperature` instance would encode as a plain object `{ value: 100, unit:
"C" }`, losing its type identity and any methods. With the protocol, the
codec system can round-trip it back to a real `Temperature` instance.

```typescript
// Shown for illustration only.
// Illustrative example -- not from the codebase.

import {
  type FabricValue,
} from '@commonfabric/data-model';
import {
  CODEC,
  BaseNonterminalCodec,
  type NonterminalCodec,
  type LiveEnvironment,
} from '@commonfabric/data-model/codec-common';
import { BaseFabricInstance } from '@commonfabric/data-model/codec-common';
import { isPlainObject } from '@commonfabric/utils/types';

type TemperatureUnit = "C" | "F" | "K";

/** The unit literals, for the wire check in `canDecode()` below. */
const TEMPERATURE_UNITS: ReadonlySet<string> = new Set(["C", "F", "K"]);

/** The codec's own state type: what it writes and the only thing it reads. */
type TemperatureState = { value: number; unit: TemperatureUnit };

class Temperature extends BaseFabricInstance {
  // (deepFreeze protocol members
  //  omitted for brevity; see §2.3
  //  and §8 for the full pattern.)

  constructor(
    readonly value: number,
    readonly unit: TemperatureUnit,
  ) {
    super();
  }

  protected [SHALLOW_UNFROZEN_CLONE](): Temperature {
    return new Temperature(this.value, this.unit);
  }

  /** Convert to Celsius for comparison. */
  toCelsius(): number {
    switch (this.unit) {
      case "C": return this.value;
      case "F": return (this.value - 32) * 5 / 9;
      case "K": return this.value - 273.15;
    }
  }

  /** The codec singleton: the source of truth for encoding. */
  static #codec = Object.freeze(
    new (class TemperatureCodec
      extends BaseNonterminalCodec<never, TemperatureState> {
      constructor() {
        super('Temperature@1', Temperature);
      }

      /** Extract essential state (shallow). */
      encode(
        value: Temperature,
        _env: LiveEnvironment,
      ): TemperatureState {
        return { value: value.value, unit: value.unit };
      }

      /** Accept only the state this codec writes. */
      canDecode(state: FabricValue): state is TemperatureState {
        return isPlainObject(state) && (typeof state.value === "number") &&
          TEMPERATURE_UNITS.has(state.unit as string);
      }

      /** Produce an instance from essential state (shallow). */
      decode(
        _typeTag: string,
        state: TemperatureState,
        _env: LiveEnvironment,
      ): FabricValue {
        return new Temperature(state.value, state.unit);
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
```

> **Runtime validation in `canDecode()`.** `TemperatureCodec.canDecode()` above
> is what lets `decode()` read `state.value` and `state.unit` without a cast:
> the state has been through encoding and decoding and need not conform to any
> TypeScript type until something checks it at run time. Every codec owes that
> check, and `canDecode()` is where the cheap part of it goes. See Section 7.4
> for the full rationale.

**Why the protocol matters.** Without the codec protocol, the encoding system
would see a `Temperature` as an opaque object and either reject it or flatten it
into `{ value: 100, unit: "C" }`. With the protocol, the codec system:

1. Finds the class's codec (via the registry; Section 4.5) and calls
   `codec.encode(value, env)` to extract the essential state.
2. Encodes that state (recursively handling any nested `FabricValue`s) and wraps
   it with the tag from `codec.tagForValue(value)`.
3. On decoding, routes the tag back to the codec, asks
   `codec.canDecode(state)`, and calls `codec.decode(tag, state, env)` for a
   state it accepts, producing a real `Temperature` instance with its methods
   intact.

**Reference types and `LiveEnvironment`.** The `Temperature` example above is a
simple value type -- its codec's `decode()` creates a fresh instance each time.
Reference types (such as the runtime's internal `Cell` type) use the
`LiveEnvironment` parameter to look up or intern existing instances, ensuring
that two references to the same logical entity decode to the same object.

### 2.8 Encoded State and Recursion

The value returned by a codec's `encode()` can contain any value that is
itself a `FabricValue` — including other `FabricInstance`s (such as JS
object wrappers), primitives, and plain objects/arrays.

**The codec system handles recursion, not the individual codecs.** An `encode()`
implementation returns one shallow layer of essential state without recursively
encoding nested values. The codec does not have access to the codec machinery —
by design, as it would be a layering violation.

Similarly, `decode()` receives state where nested values have already been
decoded by the codec system. Importantly, `decode()` returns the **wrapper
type**, not the JS type. For example, the `FabricError` codec produces a
`FabricError` instance, not a raw `Error`. Unwrapping to JS types is a
separate step via `convertibleJsFromFabricValue()` (Section 8).

### 2.9 Decode Guarantees

The system follows an **immutable-forward** design:

- **Plain objects and arrays** are frozen (`Object.freeze()`) upon decoding.
  This applies to all decoding output paths, including `/quote` (Section 6 of
  `3-json-encoding.md`) — the freeze is a property of the decoding boundary, not
  of whether type-tag decoding occurred.
- **`FabricInstance`s** should ideally be frozen as well — this is the north
  star, though not yet a strict requirement.
- Decoding always produces regular plain objects, that being the only
  object shape a `FabricValue` has.

This immutability guarantee enables safe sharing of decoded values and
aligns with the reactive system's assumption that values don't mutate in place.

> **Immutability of JS object wrappers.** Under the three-layer
> architecture, decoding produces `FabricInstance` wrappers (`FabricMap`,
> `FabricSet`, etc.), not JS types. Because the system controls the
> shape of these wrapper classes, they can be properly frozen with
> `Object.freeze()` — unlike the JS types they wrap (e.g., `Object.freeze()`
> on a `Map` does not prevent mutation via `set()`/`delete()`). The underlying
> JS objects stored inside wrappers (e.g., `FabricMap.map`) are not directly
> exposed to consumers of `FabricValue` — callers who need the JS types use
> `convertibleJsFromFabricValue()` (Section 8), which returns `FrozenMap` and
> `FrozenSet` (effectively-immutable wrappers) for collection types, preserving
> the immutability guarantee even after unwrapping.

### 2.10 Encode Input Contract

Encoding is specified only for a **valid `FabricValue`** — one that has
passed, or would pass, `isValidFabricValue()` (Section 1). Given such a value,
an engine's `encode()` produces its format's serialized form or throws for a
reason the format names: a `FabricSpecialObject` whose class no codec in the
registry claims, a cycle, or an instance whose class a codec does claim but
whose present state that format cannot express.

That third reason is a carve-out, and is expected to remain rare. Validity is a
question about a value; whether it can be written down is a question about a
format, and the two may disagree — a class can hold a state that one format
carries and another has no way to represent. A format refusing such a state is
meeting its contract rather than failing it.

**A class in that position says so in its own documentation.** Nothing in the
encoding machinery enumerates which classes they are: a format knows what it
can express, not which classes will hand it something it cannot.

Given anything else, **all error checking is best-effort.** The binding part
of that is what it forbids rather than what it permits: no check on this path
may cost correct input anything. A non-member may therefore encode, may encode
to something wrong, or may throw, and which of those happens is not specified
and may differ between formats.

Two consequences follow, and neither is a defect:

- An engine may share a subtree with the value it was given when nothing in
  that subtree needed encoding. Vetting what is shared would cost the walk the
  sharing exists to avoid, and would charge it to input that is correct.
- A codec's `canEncode()` and `encode()` may take a valid `FabricValue` as
  given, and `encode()` may further take as given that this same codec's
  `canEncode()` has already returned `true` for it. Re-checking either is work
  spent on input that is correct by contract.

**Decoding is governed the opposite way.** A serialized form is untrusted
input in its own right — it arrives from another writer, another version, or
another realm — so a form that is not this format's, or a payload that will
not parse, is refused rather than handled best-effort, and `lenient` decides
only whether the caller sees a throw or a `ProblematicValue` (Section 4.5).
The asymmetry is deliberate: an encoder is handed a value by its own caller,
and a decoder is handed one by a stranger.

---

## 3. Unknown Types

### 3.1 Overview

When decoding, an engine may encounter a type tag it doesn't recognize —
for example, data written by a newer version of the system. Unknown types are
**passed through** rather than rejected, preserving forward compatibility.

### 3.2 Preserved Tags: `UnknownValue` vs. `ProblematicValue`

Both `UnknownValue` and `ProblematicValue` preserve a type tag and raw state
for round-tripping. They differ in what a preserved tag is allowed to be, and
that difference decides how each reaches the wire.

An `UnknownValue` preserves a tag that **is** a tag — syntactically valid per
Section 9 of `3-json-encoding.md`, though claimed by no codec here. It is
checked at construction. That is what lets the class encode back under the tag
it preserved: a tag a decoder would refuse would otherwise make an instance
that encodes and cannot be read back.

A `ProblematicValue` preserves whatever was at fault, and a tag that is not a
tag is among the faults it exists to report. It therefore **encodes under a
fixed tag of its own**, `Problematic@1`, carrying the preserved tag as data
beside the state and the error. A value whose whole content is "this tag was
not a tag" cannot go back out under that tag.

They differ again in what they do with something they cannot keep, and the two
answers follow from the same split. `ProblematicValue` **normalizes**: a state
that is not a `FabricValue`, and a tag that is not a string, are each replaced
by a debug rendering of themselves, so that reporting a failure cannot itself
fail. `UnknownValue` **refuses**: a tag that is not a tag makes construction
throw, because there is no such thing as an unknown type that has no name, and
an instance holding one could not be encoded to anything readable.

A rendering is deliberately not a conversion — a string plainly reads as a
description of a value rather than the value, which is the honest answer where
fidelity is not on offer. Each class hosts its own `[CODEC]`, and the two are
shaped differently for the reason above.

`UnknownValue`'s codec is a deliberate "snowflake": it declares **no
`recognizedTypeTag`** (its instances each carry a per-instance tag, which
`tagForValue()` reads back), so it is not registered for tag-based decode
dispatch — an unrecognized tag reaches it through the engine's unknown-tag arm
instead (Section 4.5). Its `encode()` returns the preserved **bare `state`**
(not an envelope), so an instance round-trips to the *same* storage form as the
value it stands in for.

`ProblematicValue`'s codec is ordinary: it declares `Problematic@1`, is
tag-routed on decode like any other, and its `encode()` returns a record of the
three preserved facts (`tag`, `state`, `error`). One consequence is worth
stating, because it is the only place a returned `ProblematicValue` does not
mean a refusal: this codec's *successful* product is a `ProblematicValue`, so
the rule in Section 4.5 that turns one into a raise under a strict engine does
not apply to it. Reading back a record of a past failure is not a failure of
that read, and without the carve-out a strict reader could never read one at
all.

### 3.3 `UnknownValue`

```typescript
// Shown for illustration only.
// file: packages/data-model/codec-common/UnknownValue.ts

import { DEEP_FREEZE, type FabricValue, IS_DEEP_FROZEN } from '../interface';
import {
  CODEC,
  type NonterminalCodec,
  type LiveEnvironment,
} from '../codec-interface/interface';
import { BaseNonterminalCodec } from '../codec-interface/BaseNonterminalCodec';
import { BaseFabricInstance } from './BaseFabricInstance';
import { isCodecTypeTag } from './isCodecTypeTag';
import { deepFreeze } from '../deep-freeze';

/**
 * Container for an unrecognized type's data, used for round-tripping. When
 * the codec system finds a tag no codec claims during
 * decoding, it wraps the tag and state here; on re-encoding,
 * the preserved pair reproduces the original wire form.
 */
export class UnknownValue extends BaseFabricInstance {
  readonly #wireTypeTag: string;
  readonly #state: FabricValue;

  constructor(wireTypeTag: string, state: FabricValue) {
    super();

    // A real tag, so that what this encodes back to is always decodable.
    if (!isCodecTypeTag(wireTypeTag)) {
      throw new Error('Not a codec type tag; use a `ProblematicValue`.');
    }

    this.#wireTypeTag = wireTypeTag;
    this.#state = state;
  }

  get state(): FabricValue {
    return this.#state;
  }

  /** The tag preserved for this instance, read back by `tagForValue()`. */
  get wireTypeTag(): string {
    return this.#wireTypeTag;
  }

  // ([DEEP_FREEZE] / [IS_DEEP_FROZEN] freeze `this` and recurse into
  // `state`; `[SHALLOW_UNFROZEN_CLONE]()` copies the two fields. Omitted for
  // brevity; see §2.3 and §8.6 for the pattern.)

  static #codec = Object.freeze(
    new (class UnknownValueCodec extends BaseNonterminalCodec {
      constructor() {
        // No recognized wire tag: an `UnknownValue` round-trips to its
        // *preserved* tag, which varies per instance.
        super(undefined, UnknownValue);
      }

      /** The instance's preserved per-instance tag. */
      override tagForValue(value: UnknownValue): string {
        return value.wireTypeTag;
      }

      /** The preserved bare state -- NOT an envelope. */
      encode(value: UnknownValue, _env: LiveEnvironment): FabricValue {
        return value.state;
      }

      decode(
        typeTag: string,
        state: FabricValue,
        env: LiveEnvironment,
      ): FabricValue {
        const result = new UnknownValue(typeTag, state);
        return env.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
```

### 3.4 Behavior

- When the codec system encounters an unknown type tag during decoding, it
  constructs an `UnknownValue` directly from the original tag and
  (already-decoded) state. (The unknown-tag arm is the one decode path that does
  not route through a registered codec — there is, by definition, none to route
  to.)
- When re-encoding an `UnknownValue`, its codec's `tagForValue()` reads
  back the preserved tag and `encode()` returns the preserved bare state,
  reproducing the original wire format byte-for-byte.
- This allows data to round-trip through systems that don't understand it.

### 3.5 `ProblematicValue` (Recommended)

It is recommended that implementations provide a `ProblematicValue` type,
analogous to `UnknownValue`, for cases where encoding or decoding fails partway
through. This allows graceful degradation rather than hard failures — for
example, a type whose codec `decode()` throws can be preserved as a
`ProblematicValue` with the original tag, state, and error information.

```typescript
// Shown for illustration only.
// file: packages/data-model/codec-common/ProblematicValue.ts

import { DEEP_FREEZE, type FabricValue, IS_DEEP_FROZEN } from '../interface';
import {
  CODEC,
  type NonterminalCodec,
  type LiveEnvironment,
} from '../codec-interface/interface';
import { BaseNonterminalCodec } from '../codec-interface/BaseNonterminalCodec';
import { BaseFabricInstance } from './BaseFabricInstance';
import { CODEC_TYPE_TAGS } from '../codec-interface/codec-type-tags';
import { toReportableState } from './toReportableState';
import { toReportableTag } from './toReportableTag';
import { deepFreeze } from '../deep-freeze';

/**
 * Container for a value whose encoding or decoding failed.
 * Preserves the tag and raw state at fault, for round-tripping and
 * debugging. Used in lenient mode to allow graceful degradation rather
 * than hard failures.
 */
export class ProblematicValue extends BaseFabricInstance {
  readonly #wireTypeTag: string;
  readonly #state: FabricValue;
  readonly #error: string;

  constructor(
    /** Of any type; rendered if it is not a string. */
    wireTypeTag: unknown,
    /** Of any type; rendered if it is not a `FabricValue`. */
    state: any,
    /** Description of what went wrong. */
    error: string,
  ) {
    super();

    this.#wireTypeTag = toReportableTag(wireTypeTag);
    this.#state = toReportableState(state);
    this.#error = error;
  }

  /** Description of what went wrong. */
  get error(): string {
    return this.#error;
  }

  get state(): FabricValue {
    return this.#state;
  }

  /**
   * The tag preserved for this instance, which need not be a well-formed
   * tag. It is not the tag this encodes under; that is `Problematic@1`.
   */
  get wireTypeTag(): string {
    return this.#wireTypeTag;
  }

  /** Whether `other` reports this same fault. */
  equals(other: any): boolean {
    return (other instanceof ProblematicValue) &&
      (other.wireTypeTag === this.wireTypeTag) &&
      (other.error === this.error) &&
      Object.is(other.state, this.state);
  }

  // ([DEEP_FREEZE] / [IS_DEEP_FROZEN] freeze `this` and recurse into
  // `state`; `[SHALLOW_UNFROZEN_CLONE]()` copies the three fields. Omitted
  // for brevity; see §2.3 and §8.6 for the pattern.)

  static #codec = Object.freeze(
    new (class ProblematicValueCodec extends BaseNonterminalCodec {
      constructor() {
        // A tag of its own: the preserved tag need not be a tag at all.
        super(CODEC_TYPE_TAGS.Problematic, ProblematicValue);
      }

      /** All three preserved facts; the tag is data here, not structure. */
      encode(
        value: ProblematicValue,
        _env: LiveEnvironment,
      ): FabricValue {
        return {
          tag: value.wireTypeTag,
          state: value.state,
          error: value.error,
        };
      }

      decode(
        _typeTag: string,
        state: FabricValue,
        env: LiveEnvironment,
      ): FabricValue {
        // A state that is not this shape becomes a `ProblematicValue` of
        // this decode; omitted for brevity.
        const { tag, state: inner, error } = state as never;
        const result = new ProblematicValue(tag, inner, error);
        return env.shouldDeepFreeze ? deepFreeze(result) : result;
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
```

A `ProblematicValue` round-trips through encoding with all three of its
facts intact, `error` among them, so a preserved failure survives storage as
the account of a failure rather than as a value that merely looks unremarkable.

This is the trade against `UnknownValue`'s behavior, and it is deliberate.
Because the wire form is `Problematic@1` rather than the preserved tag, a
later reader that *does* have a codec for that tag will not silently decode
the real value: it reads back a `ProblematicValue` and can see, in `error`,
why the value was never built.

Healing is not available to this class in any case. A preserved tag is kept
only when it is a string, and is otherwise a *rendering* of whatever sat in
tag position — so re-emitting under it would sometimes name the original tag
and sometimes name a description of it, and a reader could not tell which. A
form that heals for some inputs and silently produces a different value for
others is worse than one that heals for none. `UnknownValue` is the type that
heals, and it can because its tag is checked to be a real one.

Whether a decode failure surfaces as a `ProblematicValue` or as a throw is the
engine's `lenient` setting alone, not the codec's: a strict engine (e.g., tests)
raises either form of rejection, while a lenient one (e.g., production decoding)
degrades either into a value. The exception is this class's own codec, whose
successful product is a `ProblematicValue` — see Section 3.2.

---

## 4. Codec Engines

### 4.1 Overview

Classes provide the *capability* to encode via the fabric protocol, but they
don't own the wire format. A **codec engine** owns the mapping between classes
and wire format tags, and handles format-specific encoding/decoding.

### 4.2 Codec Value Types

`JsonCodecEngine` uses an intermediate tree representation during encoding and
decoding. This type is internal to the JSON implementation — it is not part of
the public boundary interface.

```typescript
// file: packages/data-model/codec-json/interface.ts

/**
 * JSON-compatible codec value. This is the intermediate tree
 * representation used during encode tree walking -- NOT the final
 * serialized form (which is `string`). Internal to the JSON implementation.
 *
 * Deep-frozen invariant on the decode side: every such tree that
 * enters decoding is deep-frozen, enforced at the one construction site that
 * feeds it, `parseWireText()`. This is what lets the tag-unwrap and `/quote`
 * arms hand back extracted sub-trees directly without further copying. The
 * encode-side trees are transient (`JSON.stringify`-ed and discarded)
 * and are not covered by this invariant. The `readonly` on the array and
 * object arms of the union expresses the decode-side contract at the
 * type level. See Section 8.6.
 */
export type JsonCodecValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonCodecValue[]
  | { readonly [key: string]: JsonCodecValue };
```

### 4.3 Public Boundary

Every engine exposes `encode()` and `decode()`, parameterized by the boundary
type — `string` for JSON, `Uint8Array` for a binary format. An engine may add a
pair for a second boundary type, though none does: a second pair over the same
walk is API a caller can write for itself, and it invites the two forms to
drift. Both are supplied by the base class and are not overridden: they mint the
act and hand the work to it. An engine is otherwise its configuration — the
codec registry and the leniency setting — and the two factories that say which
act classes this format uses.

The walk itself, and the format's account of how a plain container is written
down, belong to the acts. That is what lets the walk be written without a
threaded parameter: the state one call carries and the methods that consult it
are the same object.

```typescript
// Shown at module scope.
// file: packages/data-model/codec-common/BaseCodecEngine.ts

abstract class ExampleEngine {
  protected abstract newEncodeAct(env: LiveEnvironment): ExampleEncodeAct;
  protected abstract newDecodeAct(
    env: LiveEnvironment,
    data: string,
  ): ExampleDecodeAct;
}

abstract class ExampleEncodeAct {
  abstract serializedFromEncoded(encoded: JsonCodecValue): string;
  protected abstract encodeArray(value: readonly FabricValue[]): JsonCodecValue;
  protected abstract encodePlainObject(
    value: Record<string, FabricValue>,
  ): JsonCodecValue;
  protected abstract wrapTag(tag: string, state: JsonCodecValue): JsonCodecValue;
}

abstract class ExampleDecodeAct {
  abstract encodedFromSerializedForm(data: string): JsonCodecValue;
  abstract decodeValue(data: JsonCodecValue): FabricValue;
}
```

Minting the act in the base rather than in each engine is what makes *per act*
structural: an engine cannot hold one across calls, because it never gets to
decide when one is made.

`encodedFromSerializedForm()` is where a format checks that what it was
handed is its own. What arrives there is data off a channel like anything
else, so a form that is not this format's is refused by throwing, and
`decode()` settles that against the engine's `lenient` setting — a lenient
decode returns a `ProblematicValue` for a syntactic fault, exactly as it
does for a fault found further in. `newDecodeAct()` sees the same form and
may read something out of it for the act, but it *sniffs rather than
validates*: it runs before anything has established that the form is this
format's at all.

The act is what the walk threads from node to node: the caller's
`LiveEnvironment`, and the values whose encoding or decoding is in progress.
Holding it per call rather than on the engine is what lets a codec reach back
through a public entry point while a walk is already running — the inner act
gets its own bookkeeping instead of corrupting the outer one's. A format needing
more than the base class knows about, such as a wire marker minted per call,
subclasses the act and carries it there.

`JsonCodecEngine` supplies both directions at its one boundary type:

- `encode(value, env?)` encodes a `FabricValue` into the `/<Type>@<Version>`
  tagged wire format, then stringifies the result.
- `decode(data, env)` parses a JSON string, then decodes tagged forms back into
  runtime types.

A caller wanting bytes encodes the string itself. The format's boundary is the
string, and a second entry point for the same walk was API without a purpose.

> **Why the boundary is this narrow.** Tag wrapping and unwrapping belong to the
> acts rather than to an engine's public surface, leaving only `encode(value,
> env?) -> SerializedForm` and `decode(data, env) -> FabricValue` — as public
> API. The engine owns the full pipeline rather than the tag step alone, and its
> public surface says so by exposing no step of it.

### 4.4 Encode and Decode Flow

```
Encode:  value -> codec.encode(value) -> serialized form (e.g., JSON string)
Decode:  serialized form -> codec.decode(data, env) -> FabricValue
```

Internally, `JsonCodecEngine`'s `encode()` method mints an encoding act and
has it walk (`encodeValue()`) the `FabricValue` tree into a `JsonCodecValue`
tree, which the same act then stringifies. The `decode()` method mints a
decoding act, which parses the JSON string and walks (`decodeValue()`) the
`JsonCodecValue` tree back into runtime types. The recursive descent and codec
dispatch belong to the acts, and neither is public.

### 4.5 Codecs, the Registry, and Internal Tree Walking

The encoding and decoding logic belongs to the acts an engine mints. It
dispatches per-type logic to the **codecs** (Section 2.4) held in a
**`CodecRegistry<Encoded>`** — an index of which codec handles which class (for
encoding) and which tag (for decoding), built over one wire format, which an
act reads through its engine's configuration. Codecs are shallow: the act owns
recursion and tag-wrapping, and each codec translates exactly one layer.

A registry is built over a `WireFormat<Encoded>` descriptor, which names both
the type its encoded states live in and the symbol a class binds its codec for
that format under. The two travel together because they name the same format,
and a registry given one of each separately could be given a mismatched pair.

```typescript
// Shown for illustration only.
// file: packages/data-model/codec-common/CodecRegistry.ts

/**
 * Sentinel returned by `CodecRegistry.codecFromValue()` for a
 * self-representing value -- one that is its own wire form (encoded as-is,
 * with no codec and no tag).
 */
export const SELF_REP = 'self-rep' as const;

/**
 * Registry of the codecs usable for one wire format. Provides tag-based
 * lookup for decoding, and primitive-type and class matching for encoding.
 */
export class CodecRegistry<Encoded> {
  /**
   * Constructs an instance over the given wire format, which decides the
   * symbol `registerClass()` reads a codec out from under. `format` must be
   * frozen: a registry holds it for its lifetime and reads the symbol on
   * every class registration, so a mutable descriptor could change which
   * codec a class supplies partway through a registry being built.
   */
  constructor(format: WireFormat<Encoded>);

  /**
   * Registers the codec that the given class supplies for this registry's
   * format: its `[CODEC]` if it has one, and otherwise the codec bound under
   * the format's own symbol. A class with both supplies the former, that
   * being the one which serves every format. Throws if the class supplies a
   * codec under neither symbol.
   *
   * This is what lets a single curated class list serve every format. Which
   * symbol a given class binds is a question about that class and that
   * format, and reading it here means no caller has to keep one list per
   * format in step with the others.
   *
   * The parameter is only `Constructor`, and cannot be narrower: naming the
   * symbol a class must bind would name a format, which is the thing a shared
   * roster must not do. So this refuses at run time what a type cannot rule
   * out.
   */
  registerClass(cls: Constructor): void;

  /**
   * Registers a codec directly, indexing it by its `recognizedTypeTag` (for
   * decode) and its `uniqueHandledClass` (for encode dispatch). Either may be
   * `undefined`, in which case the codec is left unindexed for the
   * corresponding lookup; a codec with no `uniqueHandledClass` is
   * unreachable for encoding.
   */
  register(codec: CodecForFormat<Encoded>): void;

  /**
   * Registers a codec for a primitive `type` (a `typeof` result, or
   * `"null"`). Indexes the codec by its `recognizedTypeTag` (for decode)
   * and by `type` (for O(1) encode dispatch on primitives).
   */
  registerPrimitive(
    type: PrimitiveTypeName,
    codec: CodecForFormat<Encoded>,
  ): void;

  /**
   * Registers a primitive `type` as self-representing: a value of that
   * type is its own wire form, so `codecFromValue()` returns `SELF_REP`
   * for it. A type may be both self-representing and have a
   * `registerPrimitive()` codec (e.g. `"number"`: finite numbers are
   * self-representing, special ones go through a codec); the codec is tried
   * first.
   */
  registerSelfRep(type: PrimitiveTypeName): void;

  /**
   * Returns a new frozen registry holding everything this one holds plus the
   * given entries. This instance is left untouched, so a shared registry can
   * be built on without being altered. An entry may be a class, whose codec
   * is found as `registerClass()` finds one, or a bare codec.
   *
   * This is the intended way to add to a registry someone else assembled:
   * extending what a factory returns is what keeps a caller from omitting, by
   * accident, everything that factory put there.
   */
  extend(
    ...entries: readonly (
      | Constructor
      | CodecForFormat<Encoded>
      | readonly (Constructor | CodecForFormat<Encoded>)[]
    )[]
  ): CodecRegistry<Encoded>;

  /**
   * Finds how to encode the given value: a matched codec that can encode
   * it, `SELF_REP` if it is a self-representing primitive, or `undefined`
   * if neither matches (the caller falls through to structural handling
   * for arrays and plain objects, or fails for an unencodable value).
   */
  codecFromValue(
    value: FabricValue,
  ): CodecForFormat<Encoded> | typeof SELF_REP | undefined;

  /** Looks up a codec by tag for decoding. */
  codecFromTag(typeTag: string): CodecForFormat<Encoded> | undefined;
}
```

Encode dispatch is O(1) on both paths — there is no linear scan over
registered codecs:

1. **Primitive** — `switch (typeof value)` (with `"null"` for `null`)
   selects a primitive `type` key; the type's registered codec is tried
   first (via `canEncode()`), then self-representation.
2. **Object** — a class map keyed by the value's exact constructor.

#### The default registry

Building a registry takes two decisions, held apart because they belong to
different things.

`createBaseJsonRegistry()` (`codec-json/createBaseJsonRegistry.ts`) makes the
one the JSON format owns: which of JavaScript's primitive types are their own
wire form, and which need a tagged encoding. It registers no fabric class, so
another wire format supplies its own counterpart here without disturbing
anything below.

`createDefaultJsonRegistry()` (`codecs.ts`) adds the classes, and is the
registry the shared JSON codec uses. The wire-format surface is **explicit and
curated**: fabric classes whose instances have a fixed wire tag supply their
codec as a static getter, and the curated `codecClasses()` list from each of
`fabric-primitives/` and `fabric-instances/` is the source of truth for which
classes participate. Each list is read through the symbol its classes bind —
`[JSON_CODEC]` for a primitive, `[CODEC]` for an instance — the wire surface is
curated there, in one obvious place per area, rather than implied by scattered
registrations. A caller needing classes of its own extends what this returns.

| Registration | Codec / type | Tag | Notes |
|--------------|--------------|-----|-------|
| `register(cls[JSON_CODEC])` | `FabricBytes` | `Bytes@1` | Via `fabric-primitives` `codecClasses()`. |
| 〃 | `FabricHash` | `Hash@1` | 〃 |
| 〃 | `FabricEpochNsec` | `EpochNsec@1` | 〃 |
| 〃 | `FabricEpochDay` | `EpochDay@1` | 〃 |
| 〃 | `FabricRegExp` | `RegExp@1` | 〃 |
| `register(cls[CODEC])` | `FabricError` | `Error@1` | Via `fabric-instances` `codecClasses()`. |
| 〃 | `FabricMap` | `Map@1` | 〃 (implementation currently stubbed; see Section 1.4.3). |
| 〃 | `FabricSet` | `Set@1` | 〃 (implementation currently stubbed; see Section 1.4.4). |
| 〃 | `UnknownValue` | _(per-instance)_ | No `recognizedTypeTag`; `tagForValue()` reads the preserved tag (Section 3). |
| 〃 | `ProblematicValue` | `Problematic@1` | Fixed tag of its own; the preserved tag rides inside the state, since it need not be a tag (Section 3.2). |
| `registerPrimitive` | `BigIntCodec` (`bigint`) | `BigInt@1` | Encodes as unpadded base64 of minimal two's complement big-endian bytes. Standalone codec in `codec-json/` — no owned class to host a codec getter. |
| 〃 | `SpecialNumberCodec` (`number`) | `SpecialNumber@1` | Catches `-0` / `NaN` / `±Infinity`; finite numbers fall to self-representation. |
| 〃 | `SymbolCodec` (`symbol`) | `Symbol@1` | Registry-interned symbols only; an uninterned symbol matches no codec and is correctly unencodable. |
| 〃 | `UndefinedCodec` (`undefined`) | `Undefined@1` | Stateless; state is `null`. |
| `registerSelfRep` | `null`, `boolean`, `number`, `string` | _(none)_ | Self-representing: emitted as-is. `number` is registered both ways; the codec is tried first. |

The canonical tag strings live in `CODEC_TYPE_TAGS`
(`codec-interface/codec-type-tags.ts`), which takes the `FabricPrimitive`
classes' entries from `FABRIC_PRIMITIVE_CODEC_TYPE_TAGS`
(`fabric-primitives/interface.ts`), where they sit with the other vocabularies
that range over those classes; the structural meta tags (`quote`, `hole`,
`object`) live in `CODEC_META_TAGS` (`codec-interface/codec-meta-tags.ts`).

An un-codec'd `FabricSpecialObject` reaching the encoder is a **hard
error** — every wire form is explicitly represented; there is no implicit
fallback for fabric classes. Arrays and plain objects (the structural
types) are handled by the walker itself after no codec matches.

#### The encode walk (`encodeValue()`)

The encoding act's walk processes the `FabricValue` tree:

1. **Codec dispatch** — `codecFromValue()` finds how to encode the value. A
   `SELF_REP` result means the value is its own wire form (emitted as-is). A
   codec result drives the standard tagged encoding: the walker reads the tag
   via `codec.tagForValue(value)`, gets one shallow layer of state via
   `codec.encode(value)`, **recursively encodes that state itself**, and wraps
   the result as `{ "/<tag>": state }`. (The walker uses `tagForValue()` rather
   than any property of the value, because it is up to the codec — not the value
   — to determine the correct tag.)
2. **Mandate guard** — a `FabricSpecialObject` that no codec matched is a
   hard error: every fabric class's wire form must be explicitly
   represented by a registered codec.
3. **Arrays** — encoded element-by-element; sparse arrays use run-length encoded
   `hole` entries (Section 1.5).
4. **Plain objects** — encoded key-by-key, iterating keys in UTF-8 byte order
   (matching the canonical key order used by hashing; see Section 10 of
   `3-json-encoding.md`), making the encoding deterministic across insertion
   orders; `/object` / `/quote` escaping applied per Section 6 of
   `3-json-encoding.md`.

Circular references are detected via a `Set<object>` tracked during the walk.

#### The decode walk (`decodeValue()`)

The decoding act's walk processes the `JsonCodecValue` tree:

1. **Tag unwrapping** — checks for single-key objects with `/`-prefixed
   keys.
2. **Structural escapes** — handles `/quote` (literal pass-through) and
   `/object` (entry-by-entry decode), per Section 6 of
   `3-json-encoding.md`.
3. **State decode + tag syntax check** — for any other tag, the walker first
   recursively decodes the wrapped state, then rejects any tag that is not
   syntactically a type tag as an encoding error: a bare `"/"` key (the
   empty tag), and equally a name that is not of the `<Type>@<Version>`
   form, such as a meta-tag met outside the context that defines it. That
   rejection, and every other malformed-wire fault the walker finds for
   itself, is settled against `lenient` exactly as a codec's is: a
   `ProblematicValue` leniently (Section 3.5), a raise strictly (see also
   Section 9 of `3-json-encoding.md`).
4. **Codec dispatch** — `codecFromTag()` routes the tag to its registered
   codec's `decode()`, and settles the codec's verdict against `lenient`:
   leniently, a throw becomes a `ProblematicValue`; strictly, a
   `ProblematicValue` the codec returned becomes a throw. Values returned from
   this arm are guaranteed deep-frozen at the walker boundary (the contract
   holds for both the codec-produced value and the lenient-mode
   `ProblematicValue`), so callers need not each freeze. Every other arm
   guarantees the same, the unknown-tag arm (step 5) included, so a caller need
   not ask which arm produced what it was handed. See Section 8.6 for the full
   deep-freeze protocol and the egress-freezing call sites.
5. **Unknown tags** — a syntactically valid tag with no registered codec
   produces an `UnknownValue` wrapping the tag and (already-decoded) state,
   preserving the form for round-tripping (Section 3). Syntax is what
   separates this from step 3: a tag names a type nothing here knows,
   whereas a non-tag names nothing at all.
6. **Primitives** — pass through.
7. **Arrays** — recursively decoded; `hole` entries decoded as true holes
   (absent indices).
8. **Plain objects** — recursively decoded; output frozen. Any `/`-prefixed key
   in a plain (non-single-key-tagged) object is reserved, as is any name this
   runtime reserves: rather than silently round-trip it, the walker rejects it,
   settled against `lenient` as in step 3 (Section 9 of `3-json-encoding.md`).

> **Where a tag comes from.** There is no tag→class registry: a concrete type
> decodes through its own codec, and a tag no codec claims falls straight to
> `UnknownValue`. A tag is normally the codec's, either its single
> `recognizedTypeTag` or whatever `tagForValue()` returns for the specific
> value. Only `UnknownValue` carries a per-instance `wireTypeTag` that its
> `tagForValue()` reads back, holding a tag whose codec is unknown.
> `ProblematicValue` preserves a tag too, but encodes under `Problematic@1` and
> carries the preserved one as data, that tag being possibly no tag at all
> (Section 3.2).

> **Why the walks belong to an act.** `encodeValue()` and `decodeValue()` are
> the act's rather than the engine's, which keeps an engine's public API to
> `encode()`/`decode()` and puts the state one call carries on the same object
> as the methods that consult it — so no recursive call threads it. What an act
> needs of its engine, it reads through `CodecEngineConfig`.

### 4.6 Separation of Concerns

This architecture enables:

- **Protocol versioning**: Same class, different tags in v1 vs v2.
- **Format flexibility**: JSON context vs CBOR context vs Automerge context.
- **Migration paths**: Old context reads legacy format, new context writes
  modern format.
- **Testing**: Mock contexts for unit tests.

### 4.7 Encoding Boundaries

The boundaries where encoding occurs:

| Boundary | Packages | Direction |
|----------|----------|-----------|
| **Persistence** | `memory` <-> database | read/write |
| **Iframe sandbox** | `runner` <-> `iframe-sandbox` | `postMessage` |
| **Background service** | `shell` <-> `background-piece-service` | worker messages |
| **HTML reconciler** | `html` reconciler (runs in a web worker) | worker messages |
| **Network sync** | `toolshed` <-> remote peers | WebSocket/HTTP |
| **Cross-space** | space A <-> space B | if in separate processes |

Each boundary uses a codec engine appropriate to its format and version
requirements.

> **Note:** The `html` package reconciler (`html/src/worker/reconciler.ts`)
> calls `convertCellsToLinks` in a web worker context. Threading encoding
> options to this call site requires worker-initialization-time configuration,
> since the reconciler does not have direct access to a `Runtime` instance.

### 4.8 JSON Encoding

The storage boundary routes through functions that bridge between the
storage layer (JSON strings) and the runtime layer (`FabricValue`). These
functions live in the package's codec-defaults module
(`packages/data-model/src/codecs.ts`), which pairs the JSON format with the
set of fabric classes this package defines. The format itself, and the
recognizer for text in it, live one layer down in
`packages/data-model/src/codec-json/`.

```typescript
// Shown for illustration only.
// file: packages/data-model/src/codecs.ts

/**
 * Encodes a `FabricValue` to a JSON string in the standard `FabricValue`
 * JSON-embedded encoding, prefixed with the format-identifying tag
 * `fvj1:`.
 */
export function jsonFromFabricValue(value: FabricValue): string;

/**
 * Decodes a string in the `FabricValue` JSON-embedded encoding format. If no
 * live environment is given, {@link NULL_LIVE_ENVIRONMENT} is substituted,
 * which throws if any decoding is needed.
 */
export function fabricFromJsonValue(
  json: string,
  env?: LiveEnvironment,
): FabricValue;

/**
 * Like `fabricFromJsonValue()`, except the decoded result is expected to be a
 * plain object. Throws if it turns out to be something else.
 */
export function plainObjectFromJson<T extends object = object>(
  json: string,
  env?: LiveEnvironment,
): T;
```

```typescript
// Shown for illustration only.
// file: packages/data-model/src/codec-json/JsonCodecEngine.ts

declare class ExampleJsonCodecEngine {
  /**
   * Indicates if the given text has a "first-blush" appearance as text in the
   * JSON-embedded encoding (i.e., carries the `fvj1:` prefix).
   */
  static seemsLikeEncoded(value: string): boolean;
}
```

`codecs.ts` creates a single stateless `JsonCodecEngine` instance at module load
time and reuses it for all encode/decode operations.

The `memory` package wraps these at its encoding boundary
(`packages/memory/v2.ts`):

- **Write path:** `encodeMemoryBoundary(value)` calls
  `jsonFromFabricValue(value)`.
- **Read path:** `decodeMemoryBoundary(source)` calls
  `fabricFromJsonValue(source, env)` with a memory `LiveEnvironment`.

### 4.9 Fabric Value Conversion

The JS-to-`FabricValue` boundary is managed by
`packages/data-model/convertible-js.ts`. This module provides
`fabricFromConvertibleJsValue()` / `convertibleJsFromFabricValue()` functions
that bridge the left layer (JS wild west) and the middle layer (`FabricValue`)
at the `Cell` read/write boundary.

The module also provides a shallow conversion function
(`shallowFabricFromConvertibleJsValue()`) and a type-check function
(`isValidFabricConvertibleJsValue()`). The public surface is re-exported from
`index.ts`, as is the comparison function `valueEqual()` from `comparison/`.

```typescript
// Shown for illustration only.
// file: packages/data-model/convertible-js.ts

/**
 * Convert a convertible JS value to fabric form (deep, recursive). Wraps
 * convertible JS types into fabric wrappers (Section 8.2). When `freeze` is
 * `true` (the default), the result tree is deep-frozen; when `false`, wrapping
 * and validation still occur but the result is left mutable. An input that is
 * already a deep-frozen `FabricValue` is returned as-is (identity
 * optimization).
 */
export function fabricFromConvertibleJsValue(
  value: unknown,
  freeze = true,
): FabricValue;

/**
 * Convert a `FabricValue` back to convertible JS form, unwrapping fabric
 * wrappers back to convertible JS types (Section 8.4).
 */
export function convertibleJsFromFabricValue(
  value: FabricValue,
  frozen?: boolean,
): FabricConvertibleJsValue;
```

In the `Cell` implementation:

- **Read path:** `Cell.getRaw()` calls `convertibleJsFromFabricValue(value)` to
  unwrap fabric wrappers before returning values to the JS wild west.
- **Write path:** `Cell.setRaw()` calls `fabricFromConvertibleJsValue(value)` to
  wrap JS types into fabric form before storing.

#### Module structure

The implementation is split across several files for separation of concerns:

| File | Purpose |
|------|---------|
| `index.ts` | Public surface, and the package's main entry point: re-exports the conversion functions (from `convertible-js.ts`), the type declarations (from `interface.ts`), the clone helpers (from `value-clone.ts`), the deep freeze (from `deep-freeze.ts`), the hash (from `value-hash.ts`), the debug renderers (from `value-debug/`), the tag vocabulary, narrowings, and validators (from `types/`), and the comparisons `valueEqual()` and `fabricAwareEqual()` (from `comparison/`) |
| `api.ts` | The pattern-visible declarations: the `FabricValue` union and the types beside it, the three base classes and every concrete class as an `interface` plus a `declare const`, and the debug-rendering option types. It has no imports, so that the type module the sandbox is served can inline it; it is also the `./api` export subpath, which `@commonfabric/api` re-exports. |
| `interface.ts` | The three abstract base classes as classes, the layer types, and the conversion-layer types (`FabricConvertibleJsObject`, `FabricConvertibleJsValue`); re-exports every type `api.ts` declares. Free of runtime imports, so that any module can import it. |
| `api-agreement.ts` | Asserts that each of the three base classes and its `api.ts` declaration are mutually assignable. Nothing imports it; it exists to be type-checked, and everything in it erases at compile time. |
| `convertible-js.ts` | Conversion: `fabricFromConvertibleJsValue`, `shallowFabricFromConvertibleJsValue`, `convertibleJsFromFabricValue`, `isValidFabricConvertibleJsValue` |
| `fabric-bases/` | The abstract bases a concrete `FabricValue` extends, one per branch of the type hierarchy: `BaseFabricInstance.ts`, `BaseFabricPrimitive.ts` (plus an `index.ts` barrel). These are the implementer's half of the hierarchy; `interface.ts` is the client's, and reaching it does not reach these. |
| `fabric-instances/` | Concrete `FabricInstance` subclasses, each in its own file: `FabricNativeWrapper.ts`, `FabricError.ts`, `FabricLink.ts`, `FabricMap.ts`, `FabricSet.ts`. `impl.ts` holds the set of instance classes and what derives from it, `codecClasses()` among them, and `index.ts` is the barrel. `UnknownValue` and `ProblematicValue` are `FabricInstance`s too, and members of that set, but live in `codec-common/`, existing only as products of a decode fault. |
| `fabric-primitives/` | Concrete `FabricPrimitive` subclasses, each in its own file: `FabricBytes.ts`, `FabricHash.ts`, `FabricEpochNsec.ts`, `FabricEpochDay.ts`, `FabricKeyPair.ts`, `FabricRegExp.ts`, `FabricUnavailable.ts`. `interface.ts` holds the tag vocabularies that range over those classes and imports nothing, the classes being its importers; `impl.ts` holds the set of classes and what derives from it, `codecClasses()` and the schema `type` names among them; and `index.ts` is the barrel. |
| `for-testing-only.ts` | What the package offers to tests alone, under an export-map entry of its own and in no barrel: makers of examples of every concrete `FabricPrimitive` and `FabricInstance` class, each table typed so that a class with no entry stops the build, and one shared instance per primitive maker. The makers keep a stated contract: a new object per call, equal objects from one maker, and unequal objects from two makers of one class, of which every class has at least two. A test that ranges over the classes takes its values from here and holds no table of its own. It also offers internal steps of the package that a test of the public surface cannot reach dependably, each under a name ending `ForTestingOnly`: `float64BytesOfForTestingOnly()` is `value-hash.ts`'s number-to-bytes step, whose `NaN` arm a test of `hashOf()` can exercise only where the engine keeps a `NaN`'s payload. Loading it also loads `value-debug/`, which is how a unit test that imports a module by its path gets the debug renderers installed. |
| `value-debug-internal.ts` | The debug renderers as the package's own modules reach them, and what the import-map key `@/value-debug` names: one forwarder per renderer, each calling the renderer of the same name which `value-debug/` installs as it loads. It imports nothing at run time, so any module may import it without a circular load-time dependency, the root class in `fabric-bases/` included. A forwarder throws until `value-debug/` has loaded. Every export-map entry which loads a module that renders loads `value-debug/` too, by way of the `fabric-bases/` barrel, so a program which imports the package has the renderers; `index.ts` re-exports them from `value-debug/` itself. |

---

## 5. JSON Encoding for Special Types

The JSON encoding for `FabricValue`s — the `/<Type>@<Version>` wire format,
type encodings, escaping mechanisms, and the `/`-key reservation rule — is
specified in a dedicated document:

**See [`3-json-encoding.md`](./3-json-encoding.md)**

---

## 6. Hashing

### 6.1 Overview

The system uses hashing for content-based identity. The hashing scheme
operates directly on the natural data structure without intermediate tree
construction.

### 6.2 Design Principles

- Traverse the natural data structure directly (no intermediate tree
  construction).
- Sort plain-object keys lexicographically; preserve array element order and
  `FabricMap`/`FabricSet` insertion order.
- Hash type tags + content in a single pass.
- No intermediate allocations beyond the hash state.
- The hash reflects the logical content, not any particular encoding or
  intermediate representation.

### 6.3 Suggested Tag Bytes

The following single-byte type tags are used by the hash byte format and are
recommended for any binary encoding of `FabricValue`s. They are organized into
four categories by high nibble:

**Meta tags (`0x0N`)** — structural markers that are not themselves value types:

| Tag               | Hex    | Decimal | Used for                        |
|:------------------|:-------|:--------|:--------------------------------|
| `TAG_END`         | `0x00` | 0       | end-of-sequence sentinel         |
| `TAG_HOLE`        | `0x01` | 1       | sparse array holes (run-length) |
| `TAG_CYCLE`       | `0x02` | 2       | cycle reference to a container on the path |

**Compound tags (`0x1N`)** — containers whose children are tagged values:

| Tag               | Hex    | Decimal | Used for                        |
|:------------------|:-------|:--------|:--------------------------------|
| `TAG_ARRAY`       | `0x10` | 16      | plain arrays                    |
| `TAG_OBJECT`      | `0x11` | 17      | plain objects                   |
| `TAG_INSTANCE`    | `0x12` | 18      | `FabricInstance` (general)    |

**Primitive tags (`0x2N`)** — leaf value types:

| Tag               | Hex    | Decimal | Used for                          |
|:------------------|:-------|:--------|:----------------------------------|
| `TAG_NULL`        | `0x20` | 32      | `null`                            |
| `TAG_UNDEFINED`   | `0x21` | 33      | `undefined`                       |
| `TAG_BOOLEAN`     | `0x22` | 34      | `boolean`                         |
| `TAG_NUMBER`      | `0x23` | 35      | `number` (any IEEE 754 binary64)  |
| `TAG_STRING`      | `0x24` | 36      | `string` (direct form)            |
| `TAG_BYTES`       | `0x25` | 37      | `FabricBytes`                     |
| `TAG_BIGINT`      | `0x26` | 38      | `bigint`                          |
| `TAG_EPOCH_NSEC`  | `0x27` | 39      | `FabricEpochNsec`                 |
| `TAG_EPOCH_DAY`   | `0x28` | 40      | `FabricEpochDay`                  |
| `TAG_HASH`        | `0x29` | 41      | `FabricHash`                      |
| `TAG_SYMBOL`      | `0x2A` | 42      | `symbol` (registry-interned only) |
| `TAG_REGEXP`      | `0x2B` | 43      | `FabricRegExp`                    |
| `TAG_KEY_PAIR`    | `0x2C` | 44      | `FabricKeyPair` (holding material) |
| `TAG_UNAVAILABLE` | `0x2D` | 45      | `FabricUnavailable`               |

**Optimized tags (`0xFN`)** — hash-level substitutes that replace the raw
payload of a primitive type with a digest, when doing so shortens the byte
stream fed to the outer hasher:

| Tag                | Hex    | Decimal | Used for                                 |
|:-------------------|:-------|:--------|:-----------------------------------------|
| `TAG_STRING_HASH`  | `0xF0` | 240     | `string` (hashed form; see byte-format spec §4.4) |

All unassigned values are reserved for future use. The category structure
(meta/compound/primitive/optimized) is a convention for readability and is not
enforced by the encoding — a decoder should handle any tag byte it encounters
regardless of nibble range.

> **Scope.** These tag bytes are defined here for use by any wire format that
> needs to distinguish `FabricValue` types at the byte level. The hash byte
> format (`2-hash-byte-format.md`) is the first consumer; future binary encoding
> formats may reuse the same tag assignments.

### 6.4 Hashing Algorithm

```typescript
// Shown for illustration only.
// file: packages/data-model/value-hash.ts

/**
 * Compute a hash for a `FabricValue`. The hash is encoding-independent:
 * the same identity whether later serialized to JSON, CBOR, or any
 * other format.
 *
 * The digest algorithm is SHA-256. Future additions (e.g., BLAKE2b)
 * would use the same byte-level input format; only the digest function
 * changes.
 *
 * The return value is a `FabricHash` instance (Section 1.4.9),
 * which encapsulates the raw hash bytes and the algorithm tag. The
 * algorithm tag for SHA-256 is `fid1` ("fabric ID, v1"). Callers who
 * need a string representation can call `toString()` on the result,
 * which produces `<tag>:<base64urlhash>` (unpadded base64url with the
 * URL-safe alphabet `A-Za-z0-9-_`, per RFC 4648 Section 5; see
 * Section 3 of `3-json-encoding.md`).
 *
 * Two public entry points are provided:
 * - `hashOf(value)` — returns a `FabricHash`.
 * - `hashStringOf(value)` — returns a plain `string` (the hash
 *   as base64url, without the algorithm tag). This avoids `FabricHash`
 *   allocation when only the string form is needed.
 *
 * Both functions cache results: constants for `null`, `undefined`,
 * `true`, `false`; an LRU cache for primitives (`string`, `number`,
 * `bigint`); and a WeakMap for deep-frozen objects.
 *
 * JS `Date`, `RegExp`, and `Uint8Array` values are handled via
 * on-the-fly conversion to their fabric equivalents
 * (`shallowFabricFromConvertibleJsValue`), then hashed in their converted
 * form.
 */
export function hashOf(value: unknown): FabricHash {
  // Type tag bytes — see Section 6.3 for the full table.
  // Tag categories: meta (0x0N), compound (0x1N), primitive (0x2N),
  // optimized (0xFN).
  //
  // Implementation feeds type-tagged data into the hasher.
  // Byte-length prefixes for raw payloads use unsigned LEB128.
  // Compound types (array, object) use TAG_END instead of a count prefix.
  //
  // Strings use two forms based on UTF-8 byte length (threshold is 64
  // bytes; see byte-format spec §4.4). The helper `hashStr(s)` emits:
  //   - direct form (utf8ByteLen <= 64):
  //       hash(TAG_STRING, leb128(utf8ByteLen), utf8Bytes)
  //   - hashed form (utf8ByteLen > 64):
  //       hash(TAG_STRING_HASH, sha256(utf8Bytes))
  // The `hashStr` abstraction is used wherever the algorithm emits a
  // complete tagged string — including object keys, FabricInstance type
  // tags, and FabricHash algorithm tags.
  //
  // - `null`:              hash(TAG_NULL)
  // - `boolean`:           hash(TAG_BOOLEAN, boolByte)
  // - `number`:            hash(TAG_NUMBER, ieee754Float64Bytes)
  // - `string`:            hashStr(s)
  // - `bigint`:            hash(TAG_BIGINT, leb128(byteLen), signedTwosComplementBytes)
  // - `undefined`:         hash(TAG_UNDEFINED)
  // - `FabricBytes`:      hash(TAG_BYTES, leb128(byteLen), rawBytes)
  //                        (hashes the underlying byte content)
  // - `FabricEpochNsec`: hash(TAG_EPOCH_NSEC, leb128(byteLen), twosComplementBytes)
  //                        (same payload format as TAG_BIGINT but distinct tag)
  // - `FabricEpochDay`: hash(TAG_EPOCH_DAY, leb128(byteLen), twosComplementBytes)
  //                        (same payload format as TAG_BIGINT but distinct tag)
  // - `FabricHash`: hash(TAG_HASH, hashStr(algTag), leb128(hashByteLen), hashBytes)
  //                        (algorithm tag as a tagged string, then raw hash bytes)
  // - array:               hash(TAG_ARRAY, ...elements, TAG_END)
  //                        Elements are hashed in index order:
  //                          if `i in array`: hashOf(array[i])
  //                          else (hole run): hash(TAG_HOLE, leb128(N))
  //                        TAG_END marks the end of the element sequence.
  //                        (order-preserving)
  //
  //                        Holes use run-length encoding in the hash
  //                        stream, matching the wire format: a maximal
  //                        run of N consecutive holes is hashed as a
  //                        single `TAG_HOLE` followed by the run length
  //                        (unsigned LEB128). A single hole is
  //                        `hash(TAG_HOLE, leb128(1))`.
  //
  //                        Runs MUST be maximal — consecutive holes are
  //                        always coalesced into a single TAG_HOLE entry
  //                        so the hash is canonical. (An implementation
  //                        must not split a run of 10 holes into two
  //                        runs of 5; this would produce a different
  //                        hash.)
  //
  //                        When hashing from the wire format, each
  //                        `hole` entry maps directly to one
  //                        `TAG_HOLE + leb128(N)` in the hash (since
  //                        the wire format also uses maximal runs).
  //                        When hashing from an in-memory array, the
  //                        implementation must count consecutive absent
  //                        indices to form maximal runs.
  // - object:              hash(TAG_OBJECT, ...sortedKeyValuePairs, TAG_END)
  //                        Keys sorted lexicographically by UTF-8.
  //                        Each pair: hashStr(key) + tagged value.
  //                        TAG_END marks the end of the pair sequence.
  // - `FabricInstance`:  hash(TAG_INSTANCE, hashStr(codec.tagForValue(v)),
  //                              hashOf(codec.encode(v)))
  //                        where `codec` is `codecOf(v)` -- the class's
  //                        `[CODEC]` (Section 2.4), the same source of
  //                        truth the codec layer uses.
  // - cycle:               an array, object, or `FabricInstance` that is
  //                        already on the path from the root (by identity)
  //                        is hashed as hash(TAG_CYCLE, leb128(distance)),
  //                        where `distance` counts up the path from this
  //                        position: 1 for the enclosing container. See
  //                        the byte-level spec, Section 4.19.
  //
  // The JS object wrappers and temporal types are hashed as follows:
  //
  // - `FabricError`, `FabricMap`, `FabricSet`,
  //   and other `FabricInstance`s with recursively-processable
  //   encoded state are hashed via TAG_INSTANCE:
  //     hash(TAG_INSTANCE, hashStr(codec.tagForValue(v)),
  //          hashOf(codec.encode(v)))
  //
  // - `FabricBytes` uses TAG_BYTES (dedicated primitive tag).
  // - `FabricEpochNsec` uses TAG_EPOCH_NSEC (dedicated primitive tag).
  // - `FabricEpochDay` uses TAG_EPOCH_DAY (dedicated primitive tag).
  // - `FabricHash` uses TAG_HASH (dedicated primitive tag).
  // - `FabricRegExp` uses TAG_REGEXP (dedicated primitive tag).
  // - `FabricKeyPair` uses TAG_KEY_PAIR (dedicated primitive tag), and only
  //   when it holds material; hashing one that holds handles throws.
  // - `FabricUnavailable` uses TAG_UNAVAILABLE (dedicated primitive tag).
  //
  // Examples (existing type tags are all short enough for the direct
  // string form, so `hashStr(tag)` below expands to
  // `TAG_STRING, leb128(utf8ByteLen), utf8Bytes`):
  // - `FabricError`:      hash(TAG_INSTANCE, hashStr("Error@1"), hashOf(errorState))
  // - `FabricMap`:        hash(TAG_INSTANCE, hashStr("Map@1"), hashOf(entries))
  //                         where entries are hashed in insertion order
  // - `FabricSet`:        hash(TAG_INSTANCE, hashStr("Set@1"), hashOf(elements))
  //                         where elements are hashed in insertion order
  // - `FabricEpochNsec`:  hash(TAG_EPOCH_NSEC, leb128(byteLen), twosComplementBytes)
  // - `FabricEpochDay`:   hash(TAG_EPOCH_DAY, leb128(byteLen), twosComplementBytes)
  // - `FabricHash`:  hash(TAG_HASH, hashStr(algTag), leb128(hashByteLen), hashBytes)
  // - `FabricBytes`:      hash(TAG_BYTES, leb128(byteLen), rawBytes)
  // - `FabricRegExp`:     hash(TAG_REGEXP, hashStr(source), hashStr(flags),
  //                               hashStr(flavor))
  // - `FabricKeyPair`:    hash(TAG_KEY_PAIR, hashStr(algorithm),
  //                               hashOf(publicKey), hashOf(privateKey))
  // - `FabricUnavailable`: hash(TAG_UNAVAILABLE, hashStr(reason),
  //                               hashOf(errorKind), hashOf(rawErrorMessage))
  //                         where each of the last two is a string or `null`
  //
  // Each type is tagged to prevent collisions between types with
  // identical content representations. In particular, holes (TAG_HOLE),
  // `undefined` (TAG_UNDEFINED), and `null` (TAG_NULL) all produce
  // distinct hashes, ensuring `[1, , 3]`, `[1, undefined, 3]`, and
  // `[1, null, 3]` are distinguishable by hash.
  //
  // Note: The hash is a function of the logical value, not any
  // particular wire format. Implementations that hash from an
  // in-memory array and implementations that hash from the wire
  // format must produce identical hashes. Both use maximal-run RLE
  // for holes in the hash stream.
}
```

> **String encoding for hashing.** Strings are hashed as UTF-8 byte sequences,
> prefixed by their byte length (unsigned LEB128). See the byte-level spec
> (`2-hash-byte-format.md`, Section 4.4) for the precise encoding.

> **Map/Set ordering in hashing.** Hashing preserves insertion order for
> `FabricMap` entries and `FabricSet` elements, matching the serialized form.
> This means two `FabricMap`s or `FabricSet`s with the same elements in
> different insertion order will hash differently. This is intentional:
> insertion order is part of the observable semantics of `Map`/`Set` in
> JavaScript, so values that behave differently should not hash the same. (By
> contrast, plain objects are hashed with sorted keys, matching the existing
> convention that plain-object key order is not semantically significant.)

### 6.5 Relationship to Late Serialization

Hashing operates on `FabricValue` directly, using codec-encoded state for
`FabricInstance`s (including the JS object wrappers; via `codecOf()`,
Section 2.4) and type-specific handling for primitives and plain containers.
This makes identity hashing independent of any particular wire encoding — the
same hash whether later serialized to JSON, CBOR, or Automerge.

### 6.6 Use Cases

Hashing is used for:
- Pattern ID generation (derived from pattern definition)
- Request deduplication
- Causal chain references (hashing the causal tree of what led to the data's
  existence)

Entity IDs remain stable addresses (analogous to IPNS names) pointing to the
most current version of the data. Hashes are not used as entity addresses.

### 6.7 Value Equality

`FabricValue`s are compared for logical (content) equality by
`valueEqual(a: FabricValue, b: FabricValue): boolean`. This is the equality the
reactive system's change-detection and no-op gates depend on, and the equality
that `Map` / `Set` key behavior over `FabricValue`s is expected to follow.

**Governing principle.** Primitive arguments follow `Object.is()`. Hashable
containers compare by their canonical content (Section 6.4), with the same
result as comparing their content hashes. `Object.is()`, not `===`, preserves
the numeric distinctions the hashing layer also carries:

- **`-0` ≠ `+0`.** `Object.is(-0, +0)` is `false`, so `-0` and `+0` are distinct
  `FabricValue`s and hash distinctly (Section 6.4; `2-hash-byte-format.md`
  Section 4.3). (`===` would conflate them, treating `-0 === +0` as `true`.)
- **All `NaN`s are value-equal.** `Object.is(NaN, NaN)` is `true`, so every
  `NaN` is value-equal to every other `NaN` — including bitwise-distinct
  payloads, which the hashing layer canonicalizes to a single quiet `NaN`
  (Section 6.4; `2-hash-byte-format.md` Section 4.3) — and all `NaN`s hash
  identically. (`===` would report `NaN !== NaN`.)

Every other primitive falls through to ordinary same-value equality:
`+Infinity`, `-Infinity`, and each finite number equals itself and nothing else,
and likewise for `string`, `boolean`, `bigint`, interned `symbol`, `null`, and
`undefined`.

**Objects, arrays, and instances.** Equality compares the contents of plain
objects and arrays and the codec-defined type and state of instances. It
distinguishes a sparse array hole from a stored `undefined`, an absent key from
a present `undefined`, and instance state held outside enumerable properties.
Instance identity and concrete wrapper class do not replace the codec's
definition of content: an `UnknownValue` preserving an instance's type tag and
state compares equally to that instance.

Available immutable hashes can settle a comparison without reading contents.
Otherwise, an iterative comparison visits each distinct object pair once and
skips identical descendants. Sharing is not itself content: one shared child can
equal multiple independent copies. Cycles compare the contents reached through
corresponding edges; a mismatch reachable after a back edge still makes the
values unequal. Equality therefore supports cyclic values.

For a cyclic value, though, this comparison and the content hash can disagree,
because the hash also distinguishes where a cycle closes
(`2-hash-byte-format.md` Section 4.19): `a = {x: a}` and `b = {x: {x: b}}`
compare equal by the walk above, and hash differently. Since available hashes
settle a comparison, the result for such a pair also depends on whether both
of its hashes are cached. That is an exception to the governing principle, and
to the statement below that caching a hash does not change an equality result.

**UTF-8 representation.** Container equality preserves the hash encoding's
replacement of lone UTF-16 surrogates with U+FFFD in strings, symbol registry
keys, property names, and codec tags. Object keys retain the canonical sort
order before replacement, including multiple keys that encode identically. For
example, `{s: "\ud800"}` and `{s: "\ufffd"}` have equal content hashes and
compare equally. The primitive arguments `"\ud800"` and `"\ufffd"` remain
distinct under `Object.is()`. Freezing or caching a container's hash does not
change its equality result.

---

## 7. Implementation Guidance

### 7.1 Adopting Late Serialization

Migration to the spec involves replacing early JSON-form conversion with
boundary-only encoding and the three-layer architecture:

1. Update `FabricValue` to exclude convertible JS types, include
   `FabricInstance` (Section 1.2).
2. Introduce the JS object wrapper classes (`FabricError`, etc.) that
   implement `FabricInstance` (Section 1.4).
3. Rework `shallowFabricFromConvertibleJsValue()` /
   `fabricFromConvertibleJsValue()` to wrap JS types into `FabricInstance`
   wrappers and return frozen results (Section 8).
4. Add `convertibleJsFromFabricValue()` for unwrapping back to JS types
   (Section 8).
5. Remove early conversion points (e.g., `convertCellsToLinks()`, legacy `Error`
   wrapping as `{ "@Error": ... }`).
6. Introduce a codec engine at each boundary (Section 4.7).
7. Update internal code to work with `FabricValue` types rather than JSON
   shapes or convertible JS objects.

> **`toJSON()` is not a conversion route.** The conversion functions give a
> `toJSON()` method no standing: a value that is not a `FabricValue`, a
> `FabricConvertibleJsObject`, or an accepted plain container does not become
> representable by carrying one. An object bearing `toJSON` is read as the
> record it is, so the method itself is an ordinary member — a function, which
> no record may hold. Anything that needs a representation of its own implements
> the fabric protocol (`FabricInstance` + `[CODEC]`); anything that a caller
> wants encoded on its way in is that caller's to encode before it reaches the
> conversion. Honoring `toJSON()` would eagerly convert to JSON-compatible
> shapes, which is incompatible with late serialization.

### 7.2 Unifying JSON Encoding

**The JSON layering defined by `codec-json` is to be the only JSON layering the
system defines. This is settled.** It is the direction the system is committed
to, not one option among several: a value's JSON form is the
`/<Type>@<Version>` tagged-object convention of `3-json-encoding.md`, and no
other layer defines a competing one.

**It is not yet the whole truth of the system, and this section says so
deliberately.** Conventions predating that decision still appear on the wire,
and they are being retired rather than accommodated. The distinction matters for
anyone reading this to decide something: treat the unified encoding as the
target to build toward and to write new code against, and treat what follows as
the remaining distance, not as a menu.

`codec-json` already holds up its end: **neither convention below is an encoding
it defines**, so the work is not to teach the JSON layer about alternative
encodings, but to retire the conventions where they are produced and recognized,
in the layers above it. The two get there by different routes, and the
difference matters to anyone tracing a value through the wire format.

- **`$stream` is an ordinary key.** The JSON layer attaches no meaning to it: a
  record carrying it round-trips as the record it is. Nothing writes it any
  more — a stream position is declared by its schema and stores no value — so
  what remains of it is the documents written before that.
- **The link-ref envelope is not.** `/` is reserved — the prefix is wholly owned
  by the encoding system in the wire format (Section 9 of `3-json-encoding.md`),
  so a `/`-keyed record reaching the wire is a tagged value, a built-in escape,
  or an encoding error, never a literal user key. A literal one reaches the wire
  only by being wrapped in an escape first — `/object` where its values should
  still be interpreted, `/quote` where the whole subtree is to be taken
  literally (Section 6 of the same document).

That the envelope needs escaping is the stronger statement of the two. It is not
a rival encoding the JSON layer tolerates alongside its own; it is user data the
layer has to work around, and it can only reach the wire intact by being hidden
from the very rule that gives `/` its meaning.

**What remains:**

| Convention | Where Produced and Recognized | Example | Unified Form |
|------------|-------------------------------|---------|--------------|
| Link-ref envelope | Links (`runner/src/sigil-types.ts`, chokepointed on `data-model/cell-rep`) | `{ "/": { "link@1": { id, path, space } } }` | `{ "/Link@1": { id, path, space } }` |
| `$stream` marker | Retired; still recognized as a fallback by the readers that classify a position from its stored value, until no stored document holds one (`runner/src/builder/types.ts`, `runner/src/query-result-proxy.ts`, `runner/src/cell.ts`, `fuse/callables.ts`, `cli/lib/shuttle/listing.ts`, `state-inspector/model.ts`) | `{ "$stream": true }` | none — the schema declares the stream |

> **Note on `$stream`:** the marker is retired rather than renamed. A stream
> position is declared by `asCell: ["stream"]` on its schema — carried by the
> links that reach it, and by the manifest link its owner keeps for it — and
> stores nothing, so no `/Stream@1` tagged type replaces it. What the wire
> still meets is the sentinel in documents written before the declaration was
> stored, and readers recognize that until none remain.

> **The link-ref envelope has a named owner.** `sigil-types.ts` states that the
> envelope and its tag belong to `data-model/cell-rep`, the chokepoint that
> dispatches the form — and the envelope's occurrences are concentrated there
> rather than scattered across the tree. The unification therefore has a place
> to happen rather than a search to perform first, which is a large part of why
> the direction is settled and not merely intended.

> **"IPLD" here names a shape, not a codec.** No IPLD codec is used: `dag-cbor`
> and `multihash` appear nowhere, and `dag-json` only as a link to the IPLD spec
> in prose. (`multiformats` is a real dependency, but `identity` uses it for
> multibase and varint handling in DIDs, which is unrelated to this section.) So
> retiring IPLD here means retiring the `{ "/": … }` envelope above and nothing
> else; reading it as a codec to rip out overstates the work considerably.

> **`$alias` is not on this list, and must not be added to it.** It is a
> Pattern-binding form rather than a link, and it is kept: link recognition is
> sigil-only, and `$alias` survives as binding vocabulary. Its open work is
> unrelated to this section — making alias objects unambiguously distinguishable
> from plain objects, so that the full plain-object space stays available to
> callers.

> **On counting what remains.** A bare search for `$`-prefixed tokens badly
> overstates the residue: JSON Schema keywords (`$ref`, `$defs`, `$schema`), CFC
> datalog variables (`{ var: "$s" }` and kin), and Pattern authoring vocabulary
> (`$UI`, `$NAME`, `$TYPE`) all match and none are on this arc — the datalog
> variables alone outnumber `$stream` several times over. Any figure quoted for
> this work should come from a classified count, and a count of occurrences
> measures distance from the end state rather than the effort to close it, since
> it does not distinguish a live wire path from a debugging or inspection one.

### 7.3 Replacing CID-Based Hashing

The hashing approach (Section 6) replaces `merkle-reference` / CID-based
hashing. Since the system does not participate in the IPFS network, CID
formatting adds overhead without interoperability benefit. The hash operates
on the logical data structure directly.

### 7.4 Untrusted Decoded Input

**Decoded values must not be trusted for type safety.** After encoding and
decoding, a value may not conform to the TypeScript type that code assumes — the
wire format carries no type guarantees, and a round-trip through JSON (or any
other encoding) can silently produce values whose runtime shape does not match
their static type.

This applies at every point where decoded data is consumed:

- **Codec implementations** (Section 2.4) are handed a state whose internal
  structure is whatever was on the wire. Checking it at run time — property
  existence, types, constraints — is the codec's obligation, and a type cast
  (`state as { value: number }`) discharges none of it. What a codec is spared
  is checking twice: `canDecode()` holds the cheap part, stated as a type
  predicate over the codec's own state type, and the engine asking it of every
  state before dispatch is what makes the narrower `state` parameter `decode()`
  declares true rather than asserted. `decode()` keeps the checks whose only
  implementation is the decoding itself. See the note in Section 2.7 for a
  concrete example.

- **JSON-side codec decoding** (Section 3 of `3-json-encoding.md`) must
  validate the format of its state before processing. Malformed input must
  be rejected rather than silently producing garbage; a codec rejects by
  refusing the state in `canDecode()`, or from `decode()` by throwing or by
  returning a `ProblematicValue`, and the engine settles all three against its
  `lenient` setting (Section 4.5).

- **Hashing** (Section 6.3) may operate on values that have been through a
  decoding round-trip. Code that extracts properties from `FabricInstance`
  values must validate those properties at runtime.

- **Application code** that reads values from cells, IPC messages, or any other
  boundary listed in Section 4.7 should treat the values as untrusted until
  validated.

The general principle: a type cast (`as T`) is a compile-time assertion with no
runtime effect. After an encoding boundary, the only reliable way to
confirm a value's shape is runtime checking.

---

## 8. Conversion Functions

### 8.1 Overview

The conversion functions bridge the left layer (JS wild west) and the middle
layer (`FabricValue`). They form the boundary between arbitrary JavaScript
values and the strongly typed data model.

There are two directions:

- **JS wild west -> `FabricValue`:** `shallowFabricFromConvertibleJsValue()`
  (shallow) and `fabricFromConvertibleJsValue()` (deep, recursive).
- **`FabricValue` -> JS wild west:** `convertibleJsFromFabricValue()` (deep,
  recursive).

### 8.2 `shallowFabricFromConvertibleJsValue()` and `fabricFromConvertibleJsValue()`

```typescript
// Shown for illustration only.
// file: packages/data-model/convertible-js.ts

/**
 * Convert a value to `FabricValue` without recursing into nested values.
 * Wraps convertible JS types (`Error`, `Date`, `RegExp`, `Uint8Array`) into
 * their `FabricInstance` or `FabricPrimitive` wrapper classes. If the value
 * is already a valid `FabricValue`, returns it as-is.
 *
 * The input type is `unknown` — the function accepts any JavaScript value.
 * Unsupported types cause a thrown error.
 *
 * **Freeze semantics (shallow):** By default, the returned value is frozen
 * at the top level via `Object.freeze()`. Nested values are NOT recursively
 * frozen. The caller's input is never mutated — if the top-level value is
 * an unfrozen array or object, a shallow copy is made before freezing. If
 * the input is already a frozen `FabricValue`, returns the same object.
 * Pass `freeze: false` to skip freezing (see below).
 */
export function shallowFabricFromConvertibleJsValue(
  value: unknown,
  freeze?: boolean, // default: true
): FabricValueLayer;

/**
 * Convert a value to `FabricValue`, recursively processing nested values
 * (deep conversion). This is the primary conversion entry point.
 *
 * - Recursively descends into arrays and plain objects.
 * - Wraps convertible JS objects at any depth.
 * - **Single-pass design:** Validation, wrapping, and freezing are performed
 *   together in one recursive descent — there are no separate passes. Each
 *   node is checked, wrapped if needed, and frozen before the function
 *   returns from that level.
 * - **No caller mutation:** The caller's input objects are never frozen or
 *   modified in place. When freezing is needed, shallow copies are made
 *   first. If the input is already a deeply-frozen `FabricValue`, returns
 *   the same object (no copying needed).
 * - Detects circular references and throws.
 * - Throws on unsupported types at any depth.
 *
 * Pass `freeze: false` to perform wrapping and validation without freezing
 * (see "Freeze Semantics" below).
 */
export function fabricFromConvertibleJsValue(
  value: unknown,
  freeze?: boolean, // default: true
): FabricValue;
```

#### Conversion Rules

| Input Type | Output |
|------------|--------|
| `null`, `boolean`, `number`, `string`, `undefined`, `bigint` | Returned as-is (primitives are `FabricValue` directly). All numbers pass through unchanged, including `-0`, `NaN`, and `±Infinity`. See Section 1.3 callout for layer-by-layer details. |
| `symbol` | Registry-interned symbols (`Symbol.keyFor(s)` returns a string) returned as-is; unique symbols (`Symbol(desc)`) throw with the message ``"Not representable as a `FabricValue`: unique (uninterned) symbol"``. See Section 1.3 callout for layer-by-layer details. |
| `FabricPrimitive` (`FabricEpochNsec`, `FabricEpochDay`, `FabricHash`, `FabricBytes`, `FabricKeyPair`, `FabricRegExp`) | Returned as-is. Always-frozen: the `freeze` option has no effect on these types (see Section 1.4.6). |
| `FabricInstance` (including wrapper classes) | Returned as-is (already `FabricValue`). |
| `Error` | Wrapped into `FabricError`. Before wrapping, `cause` and custom enumerable properties are recursively converted to `FabricValue` (deep variant) or left as-is (shallow variant). Extra enumerable properties are preserved (see Section 1.4.1). This ensures that by the time the `FabricError` codec's `encode()` runs, all nested values are already valid `FabricValue`. |
| `Map` | Wrapped into `FabricMap`. Keys and values are recursively converted (deep variant only). Extra enumerable properties on the `Map` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Set` | Wrapped into `FabricSet`. Elements are recursively converted (deep variant only). Extra enumerable properties on the `Set` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Date` | Wrapped into `FabricEpochNsec`. The `Date`'s millisecond timestamp is converted to nanoseconds: `BigInt(date.getTime()) * 1_000_000n`. Note the millisecond precision limitation — sub-millisecond information is not available from `Date`. Extra enumerable properties on the `Date` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `RegExp` | Converted into `FabricRegExp` (a `FabricPrimitive`, not a wrapper). The `source` and `flags` are extracted from the JS `RegExp`; `flavor` defaults to `"es2025"` (it is a `FabricRegExp`-level property, not a JS `RegExp` property). Extra enumerable properties on the `RegExp` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `Uint8Array` | Wrapped into `FabricBytes`. The input bytes are copied (the caller may mutate the original afterward). Extra enumerable properties on the `Uint8Array` object cause **rejection** (throw) — it is better to fail loudly than silently lose data. |
| `FabricValue[]` | Shallow: returned as-is (frozen if `freeze` is true). Deep: elements recursively converted (frozen at each level if `freeze` is true). |
| `{ [key: string]: FabricValue }` | Shallow: returned as-is (frozen if `freeze` is true). Deep: values recursively converted (frozen at each level if `freeze` is true). |

> **Implementation: tag-based type dispatch.** The conversion functions
> classify a value through `tagOfConvertibleJsValueElseNull()` (in
> `packages/data-model/src/types/`), which returns a tag string from the
> `VALUE_TAGS` vocabulary -- the JS type tags of `JS_TYPE_VALUE_TAGS` (the
> `typeof` name of each primitive and of a function, plus `"null"`),
> `"Array"`, `"Object"`, `"JsError"`, `"JsMap"`, `"JsSet"`, `"JsDate"`,
> `"JsUint8Array"`, `"JsRegExp"`, the primitive tags of
> `FABRIC_PRIMITIVE_VALUE_TAGS` (one reported by each `FabricPrimitive` class,
> under a `Fabric` prefix), and `"FabricInstance"` -- or `null` for an object
> it does not recognize. The conversion function then switches on the tag to
> route to the appropriate wrapping logic. The dispatch asks its questions in
> a fixed order.
> An error is tagged first, by `Error.isError()`, which reads the value's
> internal slot and so holds across realms, for a subclass nobody here knows,
> and whatever the value's prototype names: an `Error` re-pointed at
> `Object.prototype` is still `"JsError"`.
> Then the `typeof` question, ahead of every object question: a primitive,
> and `null`, is tagged by its `typeof` name; a function comes back `null`,
> whatever its prototype names, since a function is never asked an object
> question; and a symbol is tagged `"symbol"` only when it is
> registry-interned, a unique symbol coming back `null` for the reason
> Section 1.3 gives.
> An array is tagged next, by `Array.isArray()`, so a subclass instance, a
> severed-prototype array, and a cross-realm array all reach array handling and
> are handled by the array rule of Section 1.5, rather than being rejected as
> some unrecognized class or routed elsewhere by something the array carries.
> A plain object is decided next, by its prototype being `Object.prototype` or
> `null`, plain objects being the common case; that classifies more broadly
> than the type admits, for the same reason the array tag does: it is what
> lets the object rule of Section 1.5 reject the value by name rather than as
> some unrecognized class. Then a `FabricPrimitive`, by the tag its instance
> reports, one of `FABRIC_PRIMITIVE_VALUE_TAGS`, and a `FabricInstance`, by
> class. What remains is a JS class instance, decided last by its class, by a
> `switch` on the identity of its prototype; a
> recognized one is a value the conversion has yet to import, the heavier
> path, so the lookup's cost sits on it alone. That `switch` names only the
> classes no earlier question decides: an object merely built on a plain
> object, or on the prototype of `Array` or of an `Error` class, is none of
> those by the test that decides it, and comes back `null`, unrecognized
> rather than misidentified. Prototype identity is a per-realm question, so
> a `Map`, `Set`, `Date`, `Uint8Array`, or `RegExp` from another realm comes
> back `null` the same way, where an array or an error from another realm is
> decided by the earlier test that holds across realms. The realm's global
> constructor bindings do not enter into it: SES lockdown replaces the global
> `Date` and `RegExp` with constructors of its own that keep the original
> prototypes, so an instance made before lockdown, after it, or inside a
> compartment is recognized alike. A
> `FabricPrimitive` subclass that reports no tag of its own is tagged as its
> parent, which is a defect in that subclass rather than one the dispatch
> guards against.

> **Implementation: centralized shallow-clone utility.** The conversion
> functions use a centralized `cloneIfNecessary()` utility (in
> `packages/data-model/value-clone.ts`) to handle frozenness adjustment for
> values that are already valid `FabricValue` but whose freeze state does not
> match the requested `freeze` argument. This function dispatches on the same
> tag to clone primitives (no-op), arrays (shallow copy preserving sparse
> holes), plain objects (spread copy), and `FabricInstance` values (via the
> protocol's `shallowClone()` method from Section 2.3). It is the single home
> for clone-for-frozenness logic, which every conversion call site reaches
> rather than implementing itself.

#### Freeze Semantics

The immutable-forward design requires that `FabricValue` trees produced by
conversion are frozen **by default**:

- **`shallowFabricFromConvertibleJsValue()` (shallow):** `Object.freeze()` on
  the top-level result.
- **`fabricFromConvertibleJsValue()` (deep):** `Object.freeze()` at every level
  of nesting, performed in the **same recursive pass** as validation and
  wrapping. There are no separate passes — each node is checked, wrapped, and
  frozen before the recursion returns from that level.

**Caller arguments are never mutated.** The conversion functions must not call
`Object.freeze()` on the caller's input objects. When `freeze` is `true` and
the input is an unfrozen array or plain object, the function creates a shallow
copy and freezes the copy. This ensures that callers can safely pass mutable
data structures without side effects — the caller's objects remain mutable
after the call returns. (Wrapper objects like `FabricError` are freshly
constructed by the conversion function, so freezing them is not a mutation of
caller state.)

**`deepFreeze` at schema merge/combine sites.** The `deepFreeze()` utility (in
`packages/data-model/deep-freeze.ts`) recursively freezes an object tree in
place; see Section 8.6 for its full protocol, dispatch shape, and the
boundary-crossing egress contracts. At sites where schema objects are merged or
combined (e.g., schema `merge()` and `combine()` functions), pass-through paths
— where the input is returned as the result without structural modification —
must copy the value before freezing to avoid mutating caller-owned schema
objects. The general principle: `deepFreeze()` freezes in place, so if the
caller retains a reference to a mutable object, the function must not freeze
that object as a side effect. Callers at these sites should copy before freezing
rather than relying on the input being "safe to freeze."

**Always-frozen types bypass the `freeze` option.** JS primitives (`null`,
`boolean`, `number`, `string`, `undefined`, `bigint`) are inherently immutable
and pass through unchanged regardless of the `freeze` setting. `FabricPrimitive`
instances (`FabricEpochNsec`, `FabricEpochDay`, `FabricHash`, `FabricBytes`,
`FabricKeyPair`, `FabricRegExp`) are treated the same way — they are always
returned as-is, never copied or modified by the freeze/thaw logic. Their state
is immutable by construction (readonly fields, no mutation methods), so
`Object.freeze()` is unnecessary and thawing is meaningless. See Section 1.4.6.

If the input is already frozen (or deep-frozen for the deep variant), the same
object is returned — no defensive copying. This avoids unnecessary allocation
in the common case where values are already immutable.

The freeze check starts with a naive recursive `Object.isFrozen()` walk. This
is sufficient for correctness; optimization (e.g., a `WeakSet<object>` of known
deep-frozen objects) can be added later if profiling shows a need.

#### Optional `freeze` Parameter

All conversion functions accept an optional `freeze` parameter (default:
`true`). When `freeze` is `false`, the function performs validation and wrapping
but skips freezing:

```typescript
// Shown inside a pattern body.
// Frozen (default) -- immutable result, safe for sharing.
const frozen = fabricFromConvertibleJsValue(input);

// Unfrozen -- mutable result, caller can modify before freezing later.
const mutable = fabricFromConvertibleJsValue(input, false);
```

This exists because JavaScript makes it difficult to update frozen values —
there is no "thaw" operation. Callers that need to build up a `FabricValue`
tree incrementally (e.g., merging data from multiple sources) can use
`freeze: false` to get a mutable tree, then freeze it when construction is
complete. The `freeze` parameter does not affect validation or wrapping — the
returned value is always a valid `FabricValue` regardless of its frozen state.

### 8.3 `isValidFabricConvertibleJsValue()`

```typescript
// Shown for illustration only.
// file: packages/data-model/convertible-js.ts

/**
 * Type predicate: returns `true` if `fabricFromConvertibleJsValue()` would
 * succeed on the given value — i.e., the value is a `FabricValue`, a
 * `FabricConvertibleJsObject`, or a tree of these types. That is exactly what
 * `FabricConvertibleJsValue` names (Section 1.2), so callers can use
 * `isValidFabricConvertibleJsValue(x)` as a type guard in conditionals.
 *
 * This is a check-without-conversion function for system boundaries where
 * code receives `unknown` and needs to determine convertibility without
 * actually performing the conversion (and its associated wrapping, freezing,
 * and allocation).
 *
 * Relationship to other functions and checks:
 * - `isValidFabricValue(x)` (in `packages/data-model/src/types/validation.ts`):
 *   the narrower check — "is `x` already a `FabricValue`?" — which does NOT
 *   accept JS types like `Error` or `Map`.
 * - `isValidFabricConvertibleJsValue(x)`: "Could `x` be converted to a
 *   `FabricValue` via `fabricFromConvertibleJsValue()`?" Returns `true` for
 *   both `FabricValue` values AND `FabricConvertibleJsObject` values (and deep
 *   trees thereof).
 * - `fabricFromConvertibleJsValue(x)`: Actually performs the conversion,
 *   throwing on unsupported types.
 */
export function isValidFabricConvertibleJsValue(
  value: unknown,
): value is FabricConvertibleJsValue;
```

The function recursively checks the value tree. It returns `true` if and only
if the value is:

- A primitive (`null`, `boolean`, `number`, `string`, `undefined`, `bigint`).
  All numbers are accepted, including `-0`, `NaN`, and `±Infinity`; see the
  Section 1.3 callout.
- A registry-interned `symbol` (one for which `Symbol.keyFor(s)` returns a
  string). Unique symbols return `false`; see the Section 1.3 callout.
- A `FabricInstance` (including the JS object wrapper classes)
- A `FabricConvertibleJsObject` (`Error`, `Map`, `Set`, `Date`, `RegExp`,
  `Uint8Array`)
- An array where every present element satisfies
  `isValidFabricConvertibleJsValue()`, and which the array rule of Section 1.5
  accepts
- A plain object where every value satisfies `isValidFabricConvertibleJsValue()`

It returns `false` for unsupported types (`WeakMap`, `Promise`, DOM nodes,
class instances that don't implement `FabricInstance`, etc.) and for unique
symbols.

> **Performance note.** `isValidFabricConvertibleJsValue()` walks the value tree
> without allocating wrappers or frozen copies. For large trees, this is cheaper
> than calling `fabricFromConvertibleJsValue()` inside a try/catch, since it
> avoids the wrapping and freezing work that would be discarded on failure.
> However, if the caller intends to convert on success, calling
> `fabricFromConvertibleJsValue()` directly (and catching the error) avoids
> walking the tree twice.

### 8.4 `convertibleJsFromFabricValue()`

```typescript
// Shown for illustration only.
// file: packages/data-model/convertible-js.ts

/**
 * Deep unwrap: recursively walk a `FabricValue` tree, unwrapping any
 * `FabricNativeWrapper` values to their underlying JS types via
 * `toNativeValue()`. Non-native `FabricInstance` values (`Cell`, `Stream`,
 * `UnknownValue`, `ProblematicValue`, etc.) pass through unchanged.
 *
 * Wrapper classes are unwrapped to their JS equivalents:
 *
 * - `FabricError`      -> `Error` (with cause and custom properties
 *                         recursively unwrapped)
 * - `FabricMap`        -> `FrozenMap` / `Map`
 * - `FabricSet`        -> `FrozenSet` / `Set`
 *
 * `FabricPrimitive` subclasses (`FabricEpochNsec`, `FabricEpochDay`,
 * `FabricHash`, `FabricBytes`, `FabricKeyPair`, `FabricRegExp`) pass through
 * unchanged — they are always-frozen (Section 1.4.6). (`FabricRegExp` exposes
 * its convertible JS form via `value`, and `FabricKeyPair` via `cryptoKeyPair`,
 * each returning it on request; neither is unwrapped to that form by this
 * function.)
 *
 * **The `frozen` argument is always honored.** The freeze state of every
 * value in the output matches the `frozen` argument. When `frozen` is
 * `true` (the default), unwrapped wrappers use immutable variants
 * (`FrozenMap`, `FrozenSet`, frozen `Error`). When `frozen` is `false`,
 * mutable JS types are returned instead.
 */
export function convertibleJsFromFabricValue(
  value: FabricValue,
  frozen?: boolean, // default: true
): FabricConvertibleJsValue;
```

#### Unwrapping Rules

| Input | Output (frozen) | Output (not frozen) |
|-------|-----------------|---------------------|
| `FabricError` | `Error` (original if already frozen; frozen copy otherwise) | `Error` (original if already unfrozen; mutable copy otherwise) |
| `FabricMap` | `FrozenMap` (original if already `FrozenMap`; new wrapper otherwise) | `Map` (original if already plain `Map`; mutable copy otherwise) |
| `FabricSet` | `FrozenSet` (original if already `FrozenSet`; new wrapper otherwise) | `Set` (original if already plain `Set`; mutable copy otherwise) |
| `FabricEpochNsec` | Passed through unchanged (`FabricPrimitive`; always-frozen) | Passed through unchanged (same) |
| `FabricEpochDay` | Passed through unchanged (`FabricPrimitive`; always-frozen) | Passed through unchanged (same) |
| `FabricHash` | Passed through unchanged (always-frozen; Section 1.4.6) | Passed through unchanged (same) |
| `FabricBytes` | Passed through unchanged (always-frozen; Section 1.4.6) | Passed through unchanged (same) |
| `FabricKeyPair` | Passed through unchanged (`FabricPrimitive`; always-frozen) | Passed through unchanged (same) |
| `FabricRegExp` | Passed through unchanged (`FabricPrimitive`; always-frozen) | Passed through unchanged (same) |
| Other `FabricInstance` | Passed through unchanged | Passed through unchanged |
| Primitives | Passed through unchanged | Passed through unchanged |
| Arrays | Recursively unwrapped; output frozen | Recursively unwrapped; output NOT frozen |
| Plain objects | Recursively unwrapped; output frozen | Recursively unwrapped; output NOT frozen |

The output type is `FabricConvertibleJsValue` (Section 1.2), reflecting that the
result may contain convertible JS types at any depth — a plain container of them
is neither a `FabricValue` nor a `FabricConvertibleJsObject`, so the recursive
type is what names it.

> **Implementation: `FabricNativeWrapper` dispatch.** The unwrapping functions
> use a single `instanceof FabricNativeWrapper` check to identify all native
> object wrappers, then delegate to `toNativeValue(frozen)` on the base class.
> This replaces the previous pattern of per-wrapper `instanceof` cascades
> (`instanceof FabricError`, `instanceof FabricMap`, etc.) with a single branch.
> The `toNativeValue()` method (defined on `FabricNativeWrapper`, Section 1.4.1)
> handles the freeze-state check and delegates to the subclass's
> `toNativeFrozen()` or `toNativeThawed()` when a state change is needed.

**The `frozen` parameter is always honored.** The freeze state of every value in
the output tree matches the `frozen` argument. Specifically:

- If `frozen` is `true` and the value's freeze state already matches, the
  original reference is returned as-is.
- If `frozen` is `true` and the value is unfrozen, a new frozen variant is
  constructed (e.g., wrapping a `Map` in `FrozenMap`).
- If `frozen` is `false` and the value is frozen, a new unfrozen (mutable) copy
  is returned.
- If `frozen` is `false` and the value is already unfrozen, the original
  reference is returned as-is (or a copy is returned if structural changes are
  needed, e.g., unwrapping children in the deep variant).

This applies uniformly to all output values — arrays, plain objects, `Error`s,
and all wrapper-derived JS types. Primitives are inherently immutable and
need no freeze/thaw action. A new object is constructed only when the freeze
state differs between the stored value and the requested output.

**Recurses into `FabricError` internals.** The function recurses into
`FabricError` internals — specifically, the `cause` chain and custom enumerable
properties — unwrapping any nested `FabricInstance` values. This ensures the
output is fully "plain JS" with no fabric wrappers at any depth. Without this
recursion, an Error's `cause` could still contain `FabricInstance` wrappers
(e.g., a nested `FabricError`).

> **Why `FrozenMap` / `FrozenSet`?** `Object.freeze()` does not prevent mutation
> of `Map` and `Set` — their `set()`, `delete()`, `add()`, and `clear()` methods
> remain callable on a frozen instance. `FrozenMap` and `FrozenSet` are thin
> wrappers that expose the read-only subset of the `Map`/`Set` API (`get`,
> `has`, `entries`, `forEach`, `size`, etc.) and throw on any mutation attempt.
> This ensures that data round-tripped through the fabric layer remains
> effectively immutable even after unwrapping. The exact API of `FrozenMap` and
> `FrozenSet` is an implementation decision.

> **Why `FabricPrimitive` subclasses pass through unchanged.**
> `FabricEpochNsec`, `FabricEpochDay`, `FabricHash`, `FabricBytes`,
> `FabricKeyPair`, and `FabricRegExp` are all `FabricPrimitive` subclasses —
> always frozen at construction time with no mutable state. Most have no JS
> equivalent to unwrap to (unlike `FabricError` → `Error` or `FabricMap` →
> `Map`). Where one does exist it is reached through a member —
> `FabricRegExp.value`, `FabricKeyPair.cryptoKeyPair` — rather than by
> unwrapping, so the unwrap function returns every one of them as-is.

> **Why `FabricBytes` owns its input.** `FabricBytes` is a `FabricPrimitive` —
> always frozen at construction time, holding bytes no other code can reach.
> `FabricBytes` has no JS equivalent to unwrap to, so it is the byte
> representation rather than a wrapper around one. Callers who need raw bytes
> use `slice()`, `sliceBuffer()`, or `copyInto()` on the instance directly.

### 8.5 Round-Trip Guarantees

For any supported value `v`:

```
convertibleJsFromFabricValue(fabricFromConvertibleJsValue(v))
```

produces a value that is structurally equivalent to `v` — the same data at the
same positions. The round-tripped value may or may not be `===` to the original:
when the freeze state already matches, wrappers return their internal reference
directly; when it differs, a new object is constructed. The **freeze state of
the output always matches the `frozen` argument**: when `frozen` is `true` (the
default), the output tree is fully frozen — arrays and plain objects are frozen
via `Object.freeze()`, a mutable `Map` becomes a `FrozenMap`, a mutable `Set`
becomes a `FrozenSet`, every `FabricPrimitive` (`FabricEpochNsec`,
`FabricEpochDay`, `FabricHash`, `FabricBytes`, `FabricKeyPair`, `FabricRegExp`)
passes through unchanged, and `Error`s are frozen. When `frozen` is `false`, the
output tree is fully mutable. The data content is preserved; the mutability
matches the `frozen` argument.

Similarly, for any `FabricValue` `sv`:

```
fabricFromConvertibleJsValue(convertibleJsFromFabricValue(sv))
```

produces a `FabricValue` that is structurally equivalent to `sv`.

### 8.6 Deep-Freeze Protocol and Egress Contracts

`FabricValue` trees produced by decoding at boundary-crossings are
deep-frozen by default. This is enforced via a small protocol on
`BaseFabricInstance` together with a generic top-level utility that dispatches
across the four kinds of values that can appear in a `FabricValue` tree.

#### Instance protocol members

Every concrete `FabricInstance` provides the three members below (Section 2.3).
Their declarations are split by concern: the freeze-protocol members
`[DEEP_FREEZE]` and `[IS_DEEP_FROZEN]` are declared on `BaseFabricInstance` —
the abstract base that concrete instance classes extend — keeping this
implementation plumbing off the pure-protocol `FabricInstance` interface, while
`deepClone()` and the inherited `shallowClone()` are declared on
`FabricInstance` itself. These members, plus the class-side `[CODEC]` (encoding;
Section 2.4), are the whole instance protocol:

- **`[DEEP_FREEZE](subFreeze)`** — Deeply freezes this instance in place
  and returns it. The implementation freezes the instance's own internal
  slot(s) and calls the provided `subFreeze` callback on each nested
  `FabricValue`. Implementations must NOT call `deepFreeze()` directly:
  recursion is handed through the callback so that the freeze utility's
  caching and cycle-detection bookkeeping is preserved and no import cycle
  is introduced.

- **`[IS_DEEP_FROZEN](subIsDeepFrozen)`** — Side-effect-free sibling of
  `[DEEP_FREEZE]`: returns `true` if this instance's own internal slot(s) are in
  canonical deep-frozen form and every nested `FabricValue` (visited via the
  `subIsDeepFrozen` callback) is also deep-frozen. An instance that is not in
  canonical deep-frozen form returns `false`; the check must not throw.

- **`deepClone(frozen)`** — Returns a new deep clone of this instance with
  equivalent data but no shared structure for any unfrozen data in the original.
  When `frozen === true`, produces a frozen instance with maximal structural
  sharing (including returning `this` if already deep-frozen). When `frozen ===
  false`, produces a deeply-mutable instance with no visible shared reference
  structure with the original.

The `subFreeze` / `subIsDeepFrozen` callbacks (rather than direct utility
imports) keep the protocol layering clean and let the outer utility thread
its shared cycle-detection state through implementations transparently.

#### `deepFreeze()` and the 4-arm dispatch

The generic top-level utility (`packages/data-model/deep-freeze.ts`) recursively
freezes a `FabricValue` in place. It dispatches on four arms in order:

1. **Necessarily- or already-known-deep-frozen value** — primitives (`null` and
   `typeof !== "object"`) and objects already recorded in the internal
   deep-frozen cache. Short-circuits unchanged.

2. **`FabricPrimitive` instance** — `FabricPrimitive` subclasses
   (`FabricEpochNsec`, `FabricEpochDay`, `FabricHash`, `FabricBytes`,
   `FabricKeyPair`, `FabricRegExp`; Section 1.4.6) self-freeze at
   construction and expose no `FabricValue` for a walk to descend into.
   Short-circuits unchanged. (A `FabricKeyPair` holding material does hold
   two `FabricBytes`, but privately, and each froze itself in its own
   constructor.)

3. **`FabricInstance`** — Delegates to the instance's `[DEEP_FREEZE]` member
   with a `subFreeze` callback that recurses back through the same utility,
   threading the shared cycle-detection state. The dispatch gates on
   `instanceof` against the abstract base; it does not enumerate concrete
   subclasses. The (now deep-frozen) result is recorded in the deep-frozen cache
   so subsequent `isDeepFrozen()` checks short-circuit in O(1).

4. **Plain object or array** — Recurses into children, then freezes the
   container with `Object.freeze()`. Arrays preserve sparse holes. The
   container is recorded in the deep-frozen cache.

A shared `inProgress` set, threaded through all recursive calls (including
into participating `FabricInstance`s' `[DEEP_FREEZE]` impls via the
`subFreeze` callback closure), makes the utility cycle-safe: a cycle back
to a value the outer call is already deep-freezing short-circuits rather
than recursing.

#### `isValidDeepFrozenFabricValue()` and the 4-arm type guard

The type guard (`isValidDeepFrozenFabricValue`) is the side-effect-free sibling
of `deepFreeze()`. It mirrors the same arm shape:

1. Primitives are accepted directly.
2. `FabricPrimitive` instances are accepted directly.
3. `FabricInstance` instances delegate to their `[IS_DEEP_FROZEN]` member
   with a `subIsDeepFrozen` callback that recurses back through the same
   guard.
4. Plain objects and arrays must be `Object.isFrozen` and have every child
   accepted by the guard.

Visited objects are tracked in a per-call `Set` for cycle safety.

#### Egress-freezing call sites

The deep-freeze contract is enforced at the points where decoded values cross
from internal codec machinery to callers:

- **Every value the decode walker returns is deep-frozen at the boundary**,
  whichever arm produced it. The arms reach that by two routes. A leaf arm
  calls `deepFreeze()`: the codec-produced value (often a `FabricPrimitive`
  subclass, already frozen — the cache hit makes this O(1)), the lenient-mode
  `ProblematicValue` fallback, and the unknown-tag arm's `UnknownValue`. A
  plain-container arm calls `Object.freeze()` on the array or object it has
  just built, whose children the leaf arms have already deep-frozen, so the
  guarantee holds without walking them a second time. Which arm produced a
  value is therefore not something a caller has to know. See Section 4.5
  step 4.

- **`ProblematicStateError.asProblematicValue()`.** The rendering of a thrown
  refusal as a returned value is deep-frozen where it is built, rather than at
  each call site, so a caller reaching it outside the walker gets the same
  guarantee.

- **`JsonCodecValue` parse boundary.** The `parseWireText()` helper (invoked by
  `decode()`) deep-freezes the parsed tree before handing it to the decode
  walker. This is what makes the decode-side `JsonCodecValue` invariant
  load-bearing: tag-unwrap and the `/quote` arm can hand back extracted
  sub-trees directly without further copying because the input tree is already
  deep-frozen.

- **Codec `decode()` implementations honoring `shouldDeepFreeze`.** When a
  decode call's `LiveEnvironment.shouldDeepFreeze` is `true` (Section 2.5; the
  safe default), each codec `decode()` implementation produces a deep-frozen
  result (typically via the instance's own `[DEEP_FREEZE]`, recursing through
  `deepFreeze()`).

- **`deepFreeze()` at schema merge/combine sites.** See Section 8.2.

---

## Appendix A: Open Design Decisions

These questions may need resolution during implementation but do not block the
spec from being implementable.

- **Type registry management**: How are codec engines configured? Static
  registration? Dynamic discovery? Who owns the registry? The isolation
  strategy (see `coordination/docs/2026-02-09-isolation-strategy.md`) proposes
  per-`Runtime` configuration via `ExperimentalOptions`, which provides a
  natural place for registry configuration per runtime instance.

- **Schema integration**: Each `FabricInstance` type implies a schema for its
  encoded state. How does this integrate with the schema language?
  Currently out of scope (schemas are listed as out-of-scope for this spec).

- **Exact hash specification**: The precise byte-level format is defined in
  `2-hash-byte-format.md`. All lengths and counts use unsigned LEB128
  encoding; see that document for the complete specification of type tags,
  encoding per type, and illustrative examples.

- **Migration path**: Out of scope for this spec. The detailed migration plan
  (sequencing of flag introductions, criteria for graduating each flag to
  default-on) will be addressed in a separate document.

- **`LiveEnvironment` extensibility**: The minimal interface defined in Section
  2.5 covers `Cell` decoding. Other future fabric types may need additional
  environment methods. Should the interface be extended, or should types cast to
  a broader interface? Recommendation: extend the interface as needed; the
  indirection through an interface (rather than depending on `Runtime` directly)
  makes this straightforward.

- **`getRaw()` / `setRaw()` middle-layer contract**: Emerging consensus is that
  `Cell.getRaw()` and `Cell.setRaw()` should traffic in `FabricValue` (middle
  layer), not arbitrary convertible JS values (wild west). A usage survey of all
  call sites in the codebase found that every existing caller operates on
  well-defined `FabricValue`s (plain objects, arrays, strings, links, stream
  markers) — no call site stores or retrieves JS types like `Error`, `Date`,
  `RegExp`, `Map`, `Set`, or `Uint8Array` through these methods. Formalizing
  this contract (e.g., refining the type parameter `T` of `IAnyCell` to `extends
  FabricValue`) would make the implicit expectation explicit without breaking
  any current caller. The `convertibleJsFromFabricValue()` /
  `fabricFromConvertibleJsValue()` conversion in these methods (Section 4.9) is
  correct but forward-looking: it will become load-bearing when user-facing
  patterns start storing rich types through the schema-aware `set()` path.
