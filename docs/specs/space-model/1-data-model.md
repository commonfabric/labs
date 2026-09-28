# Data Model

This document specifies the immutable data representation — what values can be
stored and how they are identified.

## Status

Draft — based on codebase investigation.

---

## Current State

### Overview

The system stores **fabric values** — data that can be serialized to JSON
text with some extensions. All persistent data and in-flight messages use this
representation.

### Base Types

`FabricValue`s are JSON-compatible with specific constraints:

| Type | Notes |
|------|-------|
| `null` | JSON null |
| `boolean` | `true` or `false` |
| `number` | Any IEEE 754 binary64 value, including `-0`, `NaN`, and `±Infinity` (see Numbers below). |
| `string` | Unicode text |
| `array` | Ordered sequence of `FabricValue`s |
| `object` | String-keyed map of `FabricValue`s |

#### Numbers

All IEEE 754 binary64 values are accepted, including `-0`, `NaN`,
`+Infinity`, and `-Infinity`:

- `-0` retains its sign
- `NaN` and `±Infinity` round-trip via the `SpecialNumber@1` JSON
  envelope (see `space-model-formal-spec/3-json-encoding.md` Section 3)
  and via the byte-level forms in
  `space-model-formal-spec/2-hash-byte-format.md` Section 4.3

#### Arrays

- May be dense or sparse; holes are preserved, and are distinct from an
  explicitly-stored `undefined`
- Elements may be `undefined`, that being a first-class `FabricValue`
- Non-index keys cause rejection as a non-`FabricValue`, `length` aside:
  named
  (string-keyed) and symbol-keyed properties alike, whether or not they are
  enumerable
- Every present index must hold a *data* property; an accessor-backed
  (getter and/or setter) index causes rejection as a non-`FabricValue`

See `space-model-formal-spec/1-fabric-values.md` Section 1.5 for the
authoritative statement of these rules.

#### Objects

- Direct `Object` instances only: the prototype must be `Object.prototype`
  itself, so class instances and null-prototype objects alike cause rejection
- Keys must be strings; symbol keys cause rejection as a non-`FabricValue`
- Every property must be an enumerable *data* property; accessor-backed
  (getter and/or setter) and non-enumerable properties cause rejection as a
  non-`FabricValue`
- The names `__proto__` and `constructor` cause rejection in the JavaScript
  implementation. This is a reservation of that implementation — one name its
  copy loops cannot rebuild, one that its other boundaries already refuse —
  rather than a rule of the model; see Section 1.5 of
  `space-model-formal-spec/1-fabric-values.md`
- Values must be valid `FabricValue`s
- Decoding produces regular plain objects, which is the only object
  shape a `FabricValue` has

### Special Values

#### `undefined`

`undefined` has special semantics depending on context:

- **Top-level**: Indicates deletion (remove the stored value)
- **Object property**: Treated as absent (property is omitted)
- **Array element**: Stored as `undefined`, and remains distinguishable from
  both a hole and a `null`

#### Non-Fabric Types

These types cannot be stored directly:

- `symbol` — only registry-interned symbols are storable; unique symbols
  throw (see Symbols below)
- `function` — throws
- Class instances — throw unless the class has special handling (a recognized
  native class, or the fabric protocol)

#### Symbols

Symbol handling at the `FabricValue` conversion gate:

- Registry-interned symbols (`Symbol.for(key)`, where `Symbol.keyFor(s)`
  returns a string) are first-class `FabricValue`s, portable across realms
  and processes via their registry key
- Unique symbols (`Symbol(desc)`) throw with the message
  ``"Not representable as a `FabricValue`: unique (uninterned) symbol"``
- Round-trip via the `Symbol@1` JSON envelope (see
  `space-model-formal-spec/3-json-encoding.md` Section 3) and via the
  byte-level form in `space-model-formal-spec/2-hash-byte-format.md`
  Section 4.6

Note: this is about symbol *values*. Symbol-keyed *properties* on plain
objects continue to cause rejection (see "Objects" above), because
plain-object keys must be strings.

### Special Object Shapes

Certain object shapes have system-defined semantics. These use reserved keys
that begin with special characters.

#### Reference Sigil: `{ "/": ... }`

Objects with a `"/"` key are references, not literal data. This convention
comes from [DAG-JSON](https://ipld.io/specs/codecs/dag-json/spec/).

```json
{
  "/": {
    "link@1": {
      "id": "of:abc123...",
      "path": ["items", "0", "name"]
    }
  }
}
```

See [Identity and References](./3-identity-and-references.md) for details.

#### Streams: Declared, Not Stored

A stream position stores no value. What marks it is its schema: the link that
reaches it carries `asCell: ["stream"]` in front of the event schema, and among
those links is the one the owning piece keeps for the stream in its `internal`
manifest. The stream's own document holds only its `result` back-link to that
owner, so a reader holding the document alone tells it is a stream by following
the back-link to the manifest. Event payloads are ephemeral. Documents written
before this held a `{ "$stream": true }` sentinel as their value; readers still
recognize it, and nothing writes it.

See [Cells](./4-cells.md) for stream semantics.

#### Error Wrapper: `{ "@Error": {...} }`

Error instances are converted to a fabric form using the `@` prefix convention:

```json
{
  "@Error": {
    "name": "TypeError",
    "message": "Cannot read property 'x' of undefined",
    "stack": "TypeError: Cannot read...",
    "cause": null
  }
}
```

Properties captured:
- `name` — error type name
- `message` — error message
- `stack` — stack trace (if available)
- `cause` — nested cause (recursively converted)
- Any custom enumerable properties

This allows errors to round-trip through storage while preserving diagnostic
information.

### Circular References

Within a single document, circular references are detected and throw an error.
The system does not support storing cyclic data within a document's value.
Shared references (the same object appearing multiple times) are preserved
correctly.

Cycles *across* documents are supported via explicit links (sigil links). Two
cells can reference each other, forming a cycle in the broader data graph. The
no-cycles constraint applies only to the encodable content of a single cell.

The within-document prohibition is inherited from JSON's tree structure, not from
a deep architectural requirement. If a future storage format supports cyclic
references natively (e.g. CBOR with shared references, or a CRDT layer with
internal pointers), this constraint could be relaxed.

---

## Hashing and Content Addressing

### Current State

The system uses merkle-tree hashing with CID-formatted output:

1. Content is translated into a binary tree representation
2. Tree nodes are hashed using SHA-256
3. Result is formatted as a CID (Content Identifier)

However, entity data is generally **not content-addressed**. Entity IDs are
stable addresses (analogous to IPNS names) that point to the most current
version of the data. Hashes are primarily used for:
- Pattern ID generation (derived from pattern definition)
- Request deduplication
- Causal chain references (hashing the causal tree of what led to the data's
  existence, not the data content itself)

The `"/"` sigil convention is reused as a general escape mechanism for special
object shapes, not specifically tied to IPLD/IPFS semantics. The legacy
`{ "/": string }` bare-string *link* form has been removed from recognition;
current link formats use structured objects under the `"/"` key. (This does not
cover the serialized entity-id *reference* form, which still uses a
`{ "/": "<tag>:<hash>" }` shape under the current cell representation — see
[Identity and References](./3-identity-and-references.md#serialized-entity-id-reference-form).)

### Concerns: IPFS Conventions Without IPFS Benefits

The system uses IPFS-derived conventions — CID formatting and merkle tree
hashing — but does not participate in the IPFS network:

- **No content retrieval by CID**: The system doesn't fetch data from IPFS
- **No pinning**: Content isn't published to or retrieved from the IPFS network
- **No external verification**: CIDs aren't verified against external sources
- **No deduplication across peers**: The distributed storage benefits don't apply

Since entity IDs are addresses (not content hashes), the CID formatting adds
encoding complexity without providing interoperability. A simpler hashing scheme
would serve the actual use cases (pattern IDs, deduplication, causal chains)
equally well.

---

## Proposed Directions

### Simplified Hashing

Replace `merkle-reference` with a simpler hashing approach:
- Traverse the natural data structure directly (no intermediate tree)
- Sort object keys, preserve array order
- Hash type tags + content in a single pass
- No intermediate allocations

The hash should reflect the logical content, not any particular encoding or
intermediate representation.

#### Benefits

- Simpler implementation
- Lower overhead (no tree construction)
- Hash reflects actual data shape
- Easier to reason about what changes affect identity

#### Relationship to Late Serialization

This proposal pairs with [Late Serialization](#late-serialization-rich-types-within-the-runtime):
if rich types flow through the runtime, hashing should operate on those
types directly (via their codec-encoded state for `FabricInstance`s), not
on JSON-encoded forms. The hash becomes encoding-independent — the same
identity whether later serialized to JSON, CBOR, or Automerge.

#### Open Questions

- What is the exact specification for hashing?
- How should each type be tagged? (null, bool, int, float, string, bytes, array, object, references)
- How do special object shapes (references, streams, errors) participate?
- What is the migration path from current CID-based identifiers?

### Late Serialization: Rich Types Within the Runtime

#### The Principle

Rich types should flow through the runtime as themselves; serialization to
wire/storage formats should happen only at boundary crossings.

```
┌─────────────────────────────────────────────────────┐
│                    Runtime Context                   │
│                                                      │
│   Cell ←→ Cell ←→ Error ←→ Cell ←→ [rich types]     │
│                                                      │
└──────────┬──────────────────┬───────────────────────┘
           │                  │
           ▼                  ▼
    ┌──────────────┐   ┌──────────────┐
    │   Storage    │   │   Network    │
    │  (serialize) │   │  (serialize) │
    └──────────────┘   └──────────────┘
```

#### Current State: Early Conversion

Today, special JSON forms are created early and travel through the system:

- `normalizeAndDiff()` converts Cells to SigilLinks (`{ "/": {...} }`) immediately
- `convertCellsToLinks()` explicitly replaces Cell references with JSON forms
- `fabricFromConvertibleJsValue()` wraps Errors as `{ "@Error": {...} }` during
  data updates

Streams have no JSON form of their own: a stream position is declared by the
schema on the link that reaches it, and stores nothing.

The JSON forms then propagate through transactions, the reactive system, and
query results. Code throughout the system must detect and handle these special
shapes via `isSigilLink()`, `isErrorWrapper()`, etc.

#### Proposed: Defer Conversion to Boundaries

Keep rich types as themselves within the runtime:

- **Cells remain Cells** through the reactive graph and transactions
- **Errors remain Errors** until they cross an encoding boundary
- **Streams are first-class** rather than marker objects
- Encoding becomes a "last mile" concern at specific boundary points

The `FabricValue` type would expand to a union of three categories:

```typescript
// Shown at module scope.
type FabricValue =
  // (a) Primitives
  | null | boolean | number | string
  | undefined                             // currently has special semantics; could become first-class
  | bigint                                // currently rejected; could become first-class

  // (b) Built-in JS types (cannot be patched with symbols)
  | Error
  | Map<FabricValue, FabricValue>
  | Set<FabricValue>
  | Uint8Array                           // or other byte-array type
  | Date                                 // or Temporal type

  // (c) Branded fabric types (our types implementing the protocol)
  | FabricInstance

  // Recursive containers
  | FabricValue[]
  | { [key: string]: FabricValue }
```

Built-in JS types require explicit encoding handling — we cannot (and
should not) patch `Error.prototype` with symbol-keyed methods. The
codec engine must recognize these types directly.

#### The Fabric Protocol

Types *we control* opt into storability by implementing members keyed by
well-known symbols:

```typescript
// Shown inside a pattern body.
// Unique symbols, not registry-interned ones: a member keyed by one is
// reachable only by importing the symbol, and the string is a description
// rather than a lookup key.
const CODEC: unique symbol = Symbol('data-model.codec');
const DEEP_FREEZE: unique symbol = Symbol('data-model.deepFreeze');
const IS_DEEP_FROZEN: unique symbol = Symbol('data-model.isDeepFrozen');
// If protocol evolution is needed: a further symbol,
// e.g. `Symbol('data-model.codec@2')`.

// Instance protocol: "here's how to freeze me deeply, and here's how to
// clone me." (In-process lifecycle only -- encoding is class-level.)
abstract class FabricInstance {
  abstract [DEEP_FREEZE](subFreeze: (v: FabricValue) => FabricValue): FabricValue;
  abstract [IS_DEEP_FROZEN](subIsDeepFrozen: (v: FabricValue) => boolean): boolean;
  abstract deepClone(frozen: boolean): FabricInstance;
  abstract shallowClone(frozen: boolean): FabricInstance;
}

// Codec protocol: each class hosts an encoder-decoder object -- the
// single source of truth for how its instances encode -- as a static
// getter keyed by a well-known symbol. `PlusType` is what the values may
// hold beyond `FabricValue`, `never` for a codec over `FabricValue` alone;
// `Encoded` is the domain the essential state lives in.
interface FabricCodec<PlusType, Encoded> {
  get uniqueHandledClass(): Constructor | undefined;
  get recognizedTypeTag(): string | undefined;
  canEncode(value: FabricValuePlus<PlusType>): boolean;
  canDecode(state: Encoded): boolean;
  tagForValue(value: FabricValuePlus<PlusType>): string;
  encode(                                    // shallow
    value: FabricValuePlus<PlusType>,
    env: LiveEnvironment,
  ): Encoded;
  decode(                                    // shallow
    typeTag: string,
    state: Encoded,
    env: LiveEnvironment,
  ): FabricValuePlus<PlusType>;
}

// Nonterminal: state made of the same values the codec takes, which the
// walker expands in turn. One such instance can serve every wire format;
// only one at `never` has a wire form.
type NonterminalCodec<PlusType = never> =
  FabricCodec<PlusType, FabricValuePlus<PlusType>>;

// Terminal: state already in one format's own domain, which the walker
// passes through. Serves that one format alone, over `FabricValue`s.
type TerminalCodec<Encoded> = FabricCodec<never, Encoded>;

// The symbol a class binds under is a separate question from the kind.
// `CODEC` is the claim that one codec serves every format, which a
// terminal codec cannot truthfully make, so only a nonterminal codec
// belongs there; nothing enforces that. A class the formats treat
// differently binds per format instead, under that format's own symbol,
// and what it supplies there may be of either kind.

// Which kind a codec is cannot be read off its signature -- the domains
// overlap -- so a codec declares it by which base class it extends.

interface FabricClassWithNonterminalCodec<PlusType = never> {
  get [CODEC](): NonterminalCodec<PlusType>;
}
```

The `[DEEP_FREEZE]` / `[IS_DEEP_FROZEN]` pair lets a generic top-level
`deepFreeze()` utility freeze any `FabricValue` tree by dispatching on the
abstract `FabricInstance` base. The `subFreeze` / `subIsDeepFrozen`
callbacks (rather than direct utility imports) thread shared
cycle-detection state through implementations without creating an import
cycle. See `space-model-formal-spec/1-fabric-values.md` Section 8.6 for
the full protocol, dispatch shape, and boundary-crossing egress
contracts.

`decode()` lives on the codec rather than being a constructor for two
reasons:

1. **Decoding-specific environment**: It receives a `LiveEnvironment`
   (and potentially more besides) which shouldn't be mandated in a regular
   constructor's signature.
2. **Instance interning**: It can return existing instances rather than always
   creating new ones — essential for types like `Cell` where identity matters.

Since `FabricInstance` is an abstract class, the natural brand check is
`instanceof` — no separate type guard function is needed:

```typescript
// Shown at module scope.
if (value instanceof FabricInstance) {
  // value is a FabricInstance
}
```

Example implementation:

```typescript
// Shown for illustration only.
class Cell<T> extends FabricInstance {
  static #codec = new (class extends BaseNonterminalCodec {
    constructor() {
      super('Cell@1', Cell);
    }

    encode(value: Cell<unknown>): FabricValue {
      return { id: value.entityId, path: value.path, space: value.space };
    }

    decode(
      _typeTag: string,
      state: FabricValue,
      env: LiveEnvironment,
    ): Cell<unknown> {
      return env.getCell(state as CellState);
    }
  })();

  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
```

This approach:
- **Open for extension**: New fabric types don't require modifying a central
  type definition
- **Co-located logic**: Each type's codec lives with the type itself
- **Explicit, curated wire surface**: which classes participate is
  determined by curated codec lists, and an unregistered fabric class
  reaching the encoder is a hard error — not an implicit fallback
- **Symbol-based brands**: Unique symbols prevent collision with user data keys
  and provide reliable runtime type discrimination

#### Encoded State and Recursion

The value returned by a codec's `encode()` can contain any value that is
itself a `FabricValue` — including other `FabricInstance`s, primitives,
and plain objects/arrays.

The **codec system handles recursion**, not the individual codecs.
An `encode()` implementation simply returns one shallow layer of essential
state; it does not (and should not) recursively encode nested values. The
codecs won't have access to the codec machinery required
for that — by design, as it would be a layering violation.

Similarly, `decode()` receives state where nested values have already been
decoded by the codec system.

#### Decode Guarantees

The system aims for an **immutable-forward** design:

- **Plain objects and arrays** are frozen (`Object.freeze()`) upon decoding
- **`FabricInstance`s** should ideally be frozen as well — this is the north
  star, though not yet a strict requirement
- Decoding always produces regular plain objects, that being the only
  object shape a `FabricValue` has

This immutability guarantee enables safe sharing of decoded values and
aligns with the reactive system's assumption that values don't mutate in place.

#### Unknown Types

When decoding, a codec engine may encounter a type tag it doesn't recognize —
for example, data written by a newer version of the system. Unknown types should
be **passed through** rather than rejected, preserving forward compatibility.

This requires a generic `FabricInstance` to hold unrecognized types:

```typescript
// Shown for illustration only.
class UnknownValue extends FabricInstance {
  constructor(
    readonly wireTypeTag: string, // e.g., "FutureType@2"
    readonly state: FabricValue,  // the raw state, already recursively processed
  ) { super(); }

  static #codec = new (class extends BaseNonterminalCodec {
    constructor() {
      // No recognized tag: the instance carries its own.
      super(undefined, UnknownValue);
    }

    override tagForValue(value: UnknownValue): string {
      return value.wireTypeTag;
    }

    encode(value: UnknownValue): FabricValue {
      return value.state; // the preserved bare state -- not an envelope
    }

    decode(typeTag: string, state: FabricValue): UnknownValue {
      return new UnknownValue(typeTag, state);
    }
  })();

  static get [CODEC](): NonterminalCodec {
    return this.#codec;
  }
}
```

The codec system has special knowledge of `UnknownValue`: when it
encounters an unknown type tag during decoding, it constructs an
`UnknownValue` directly from the original tag and state. When
re-encoding, the codec's `tagForValue()` reads back the preserved tag
and `encode()` re-emits the preserved bare state, reproducing the original
wire format and allowing data to round-trip through systems that don't
understand it.

#### Codec Engines

Classes provide the *capability* to encode (via their codecs) but don't
own the wire format. A **codec engine** owns the format-specific
pipeline, dispatching per-type work to the codecs through a registry:

```typescript
// Shown at module scope.
// The public boundary (formal spec Section 4.3): an engine exposes
// `encode()` and `decode()`, and mints a context per act of each.
// Internally, a registry maps classes -> codecs (for encoding) and
// tags -> codecs (for decoding); see formal spec Section 4.5.
```

This separation enables:
- **Protocol versioning**: Same class, different tags in v1 vs v2
- **Format flexibility**: JSON engine vs CBOR engine vs Automerge engine
- **Migration paths**: A registry can route a legacy decode-only tag to an
  equivalent codec without touching the owning class
- **Testing**: Mock engines for unit tests

The flow becomes:

```
Encode: codec.encode(instance) → state
        → wrap(codec.tagForValue(instance), state) → wire
Decode: wire → unwrap() → { tag, state }
        → registry.codecFromTag(tag).decode(tag, state, env)
        → instance
```

#### Encoding Boundaries

The boundaries where encoding occurs in the current architecture:

| Boundary | Packages | Direction |
|----------|----------|-----------|
| **Persistence** | `memory` ↔ database | read/write |
| **Iframe sandbox** | `runner` ↔ `iframe-sandbox` | postMessage |
| **Network sync** | `toolshed` ↔ remote peers | WebSocket/HTTP |
| **Cross-space** | space A ↔ space B | if in separate processes |

Each boundary would use a codec engine (sketches of the engine's
internal walkers):

```typescript
// Shown inside a pattern body.
// At boundary exit (inside the engine's encode walk)
function encodeValue(value: FabricValue): JsonCodecValue {
  const codec = registry.codecFromValue(value);
  if (codec) {
    const state = encodeValue(codec.encode(value)); // engine recurses
    return wrapTag(codec.tagForValue(value), state);
  }
  // Handle self-representing primitives, arrays, plain objects...
}

// At boundary entry (inside the engine's decode walk)
function decodeValue(
  data: JsonCodecValue,
  env: LiveEnvironment,
): FabricValue {
  const unwrapped = unwrapTag(data);
  if (unwrapped) {
    const { tag, state } = unwrapped;
    const codec = registry.codecFromTag(tag);
    if (codec) return codec.decode(tag, decodeValue(state, env), env);
    return new UnknownValue(tag, decodeValue(state, env));
  }
  // Handle primitives, arrays, plain objects recursively...
}
```

The decode path needs a live environment (`LiveEnvironment`) to
reconstitute rich types (e.g., looking up existing Cell instances rather
than creating duplicates).

#### Benefits

- **Type safety**: Rich types carry more information than JSON shapes
- **Simpler internal code**: No `isSigilLink()` checks scattered throughout
- **Single conversion point**: Easier to maintain, audit, and change
- **Format flexibility**: Different boundaries can use different engines
- **Better tooling**: Debuggers show actual Cells, not JSON blobs
- **Extensible**: New fabric types only need to implement the protocol

#### Relationship to Hashing

This proposal pairs with [Simplified Hashing](#simplified-hashing):
hashes can be computed over rich types directly, using codec-encoded
state for `FabricInstance`s and type-specific handling for built-in JS types.
This makes identity hashing independent of any particular wire encoding.

#### Trade-offs

- **Migration complexity**: Existing code assumes JSON forms internally
- **Live environment required**: Decoding needs access to the runtime
- **Comparison semantics**: Must define equality for rich types (by identity?
  by encoded state?)
- **Not "zero transformations"**: Late encoding eliminates encoding
  copies within the runtime, but does not eliminate all transformations.
  Schema-driven reads still select and shape data (resolving links, projecting
  fields). Link construction still needs to know which data belongs to which
  document. CFC validation will require traversing data on write. The benefit is
  eliminating one copy (sometimes more, when pass-through data can be detected
  as already frozen), not eliminating all data traversal.

#### Open Questions

- What is the migration path from early to late conversion?
- How do rich types participate in change detection and diffing?
- Should cycles in encoded state be detected and rejected, or is this
  left to the codec system?
- How are codec engines configured and selected at each boundary?
- How is the type registry within an engine managed? (Static registration?
  Dynamic discovery? Who owns the registry?)
- What happens when a codec's `encode()` or `decode()` fails partway
  through? (Answered in the formal spec: a `ProblematicValue`, with
  similar structure/use to `UnknownValue`, plus a lenient engine mode.)
- How do schemas integrate with the fabric protocol? Each `FabricInstance`
  type implies a schema for its encoded state. The fabric layer should
  provide codec engines access to these schemas. What changes to the
  schema language are required? (See [Schemas](./7-schemas.md).)
- Which built-in JS types should be included?
  - Byte arrays: `Uint8Array`, `ArrayBuffer`, or both?
  - Date/time: `Date`, `Temporal.Instant`, `Temporal.ZonedDateTime`?
  - Are there others beyond Error, Map, Set?
- Should additional JS primitives become first-class?
  - `undefined`: Currently has context-dependent semantics (deletion, absent, null)
  - `bigint`: Currently rejected; useful for large integers
- How does this interact with the proposed CRDT layer (below)?

---

### JSON Encoding for Special Types

This section describes the **JSON-compatible** representation of special types.
While the system will likely maintain a JSON encoding indefinitely (especially
useful for debugging and interoperability), the intent is for other wire and
storage formats to be available which _are not_ themselves layered on top of a
translation from "native types" to JSON. Other encodings like CBOR may represent
types more directly — for example, using CBOR's native byte array rather than `{
"/Bytes@1": "base64..." }`.

> **Pointer to formal spec.** The mechanics summarized in this section —
> tagged-key form, escapes, detection, and the `/`-key reservation rule — are
> defined precisely in the formal spec at `space-model-formal-spec/3-json-encoding.md`.
> The text below is a prose summary; the formal spec is authoritative on
> conformance details.

#### Encoding Prefix: `fvj1:`

Every encoded `FabricValue` carries a literal `fvj1:` prefix in front of the
JSON itself. The prefix lets a recipient distinguish, at a glance, JSON that
came from the fabric encoder from arbitrary JSON of unrelated origin.
"`fvj1`" stands for "Fabric Value JSON, version 1"; the trailing version
digit reserves space for future incompatible revisions of the wire format.

For full details — including how decoders verify and strip the prefix —
see Section 1.1 of the formal spec.

#### Current State: Two Conventions

The current system uses two different conventions for special object shapes:

| Convention | Example | Used For |
|------------|---------|----------|
| IPLD sigil | `{ "/": { "link@1": {...} } }` | Cell references |
| `@` prefix | `{ "@Error": {...} }` | Error instances |

A third, the `$`-prefixed `{ "$stream": true }` stream marker, is retired: a
stream position is declared by its schema and stores nothing. This
inconsistency complicates parsing and adds cognitive overhead.

#### Proposed: Unified `/<type>@<version>` Keys

Unify all special types under a single convention: single-key objects where the
key follows the pattern `/<type>@<version>`:

- `/` — sigil prefix (nodding to IPLD heritage)
- `<type>` — `UpperCamelCase` type name
- `@<version>` — version number (natural number, optionally `.<minor>`)

Examples:

```json
{ "/Link@1": { "id": "of:abc...", "path": ["x", "y"], "space": "..." } }
{ "/Error@1": { "name": "TypeError", "message": "...", "stack": "..." } }
{ "/Map@1": [ ["key1", "value1"], ["key2", "value2"] ] }
{ "/Set@1": [ "a", "b", "c" ] }
{ "/Bytes@1": "base64encoded..." }
{ "/Date@1": "2026-02-05T12:34:56Z" }
{ "/BigInt@1": "12345678901234567890" }
```

**Note:** The `/<type>@<version>` convention described here applies specifically
to the JSON encoding. Codec engines for other formats are free to use
whatever representation makes the most sense in their context.

#### Benefits

- **Single convention**: One pattern to recognize and parse
- **Flat structure**: One level of nesting (vs two for current IPLD style)
- **Self-describing**: Type and version visible in the key
- **Compact**: Shorter than `{ "/": { "link@1": {...} } }`
- **Versionable**: Built-in version field supports evolution

#### Detection

In the JSON wire format, **any plain object containing at least one key that
starts with `/`** is a reserved form — either a tagged value, a built-in
escape, or an encoding error. The common case is a single-key object whose
sole key starts with `/` (a tagged value); multi-key objects with one or
more `/`-prefixed keys are also reserved (see "Reservation Rule" below for
how each form is interpreted).

This rule provides maximum flexibility to evolve the key format while
keeping the boundary between encoding signals and user data unambiguous.

#### Stateless Types

A type that requires no decoding state uses `null` as its value, which
distinguishes "no state needed" from "empty state" (`{}`). No current type is
stateless: the stream marker that would have been one is retired rather than
renamed, since a stream position is declared by its schema and stores nothing.

#### Escaping and Literal Values

Two escape mechanisms handle cases where user data might be mistaken for special
types:

**`/object` — Single-layer escape, values still interpreted**

Wraps a plain object whose key(s) might look like special types, but the values
are still processed normally:

```json
{ "/object": { "/myKey": { "/Link@1": { "id": "..." } } } }
```

Decodes to: `{ "/myKey": <decoded Link> }`

The `/object` wrapper is stripped, the inner object's keys are taken literally,
but its values go through normal decoding (the Link is decoded).

**`/quote` — Fully literal, no interpretation**

Wraps a value that should be returned exactly as-is, with no decoding of
any nested special forms:

```json
{ "/quote": { "/Link@1": { "id": "..." } } }
```

Decodes to: `{ "/Link@1": { "id": "..." } }` — the inner structure is *not*
decoded as a Link; it remains a plain object.

Use cases for `/quote`:
- Storing schemas or examples that describe special types without instantiating them
- Metaprogramming and introspection
- Optimization: skip decoding when the subtree is known to be plain data
- Round-tripping JSON structures that happen to look like special types

**When to use which:**
- `/object`: You have a plain object with a slash-prefixed key, but values should
  still be interpreted normally
- `/quote`: You want the entire subtree treated as literal JSON data

**Encoder dispatch (recommended best practice).** When the encoder must wrap
a plain object with `/`-prefixed keys, both forms are valid wire output, but
the recommended choice is `/quote` when the entire subtree is fully literal
(no descendants need encoding) and `/object` otherwise. The wire form is
unambiguous either way — a conforming encoder may emit `/object` in any
case, and **a conforming decoder must accept both forms**. See Section 6 of
the formal spec for the precise dispatch rule and motivation.

#### Reservation Rule

The `/` prefix is wholly owned by the encoding system in the wire format.
That means a wire-format object containing any `/`-prefixed key is always
either a tagged value, a built-in escape, or an encoding error — never a
literal user-data key. User-data plain objects may carry `/`-prefixed keys
at the data level, but a conforming encoder always wraps them via `/object`
or `/quote` before they reach the wire (see Escaping above).

Concretely:

- A bare `"/"` key (i.e. the tag name is empty after stripping the leading
  `/`) is always an encoding error. Decoders should produce a
  `ProblematicValue` rather than treating it as a tagged form.
- A single-key object whose sole key starts with `/` is a tagged value of
  a known type, a built-in escape (`/object`, `/quote`), or an unrecognized
  tag (preserved as `UnknownValue` for round-tripping).
- A multi-key object containing one or more `/`-prefixed keys among its
  keys is a structural encoding error, and is rejected the same way: a
  `ProblematicValue` from a lenient engine, a raise from a strict one. It is
  not a valid plain object.

See Section 9 of the formal spec for the full rule and the
`ProblematicValue` interpretation across the cases above.

#### Unknown Type Handling

When a JSON engine encounters a `/<type>@<version>` key it doesn't recognize,
it uses `UnknownValue` (see [Unknown Types](#unknown-types) in the Fabric
Protocol section) to preserve the data for round-tripping.

#### Relationship to Codec Engines

This wire format is what codec engines produce. The engine's `wrap()`
and `unwrap()` methods would generate and parse these `/<type>@<version>` keys,
mapping between rich runtime types and their serialized form. The engine is
also responsible for:
- Applying `/object` or `/quote` escaping when encoding plain objects that
  happen to have slash-prefixed keys
- Wrapping unknown types using the `wireTypeTag` preserved in `UnknownValue`

#### Open Questions

- What is the migration path from current formats?
- Is `.minor` versioning needed, or is major-only sufficient?

---

### CRDT-Based Storage Layer

For collaborative features (multiple users editing shared data), the storage
layer could be implemented using CRDTs (Conflict-free Replicated Data Types).
Automerge is a candidate implementation.

#### Automerge's Data Model

Automerge is described as "JSON-like" but supports a richer type system:

| Category | Types |
|----------|-------|
| Containers | Map (string keys), List, Text (collaborative UTF-8) |
| Primitives | null, boolean, string, f64, i64, u64, bytes, timestamp, counter |

Notable differences from the current system:
- **Distinct integer types**: i64 and u64 vs JavaScript's single number type
- **Native binary data**: `bytes` as a first-class type
- **Timestamps**: Built-in, not a convention
- **Counter**: Special type with additive merge semantics

#### Type System Constraints

Automerge has a **fixed type system by design** — merge semantics, binary format
optimization, and cross-language interoperability require known types. Custom
types must be handled at an application layer above Automerge.

This means the current special object shapes (`"/"`, `@Error`) would need a
mapping layer:
- Store as Automerge primitives/containers
- Interpret special shapes at a layer above Automerge
- The `bytes` type could store arbitrary data but loses fine-grained merge
  (entire blob becomes last-write-wins)

#### Internal Structure

Automerge documents store:
- Full causal history with actor IDs (128-bit)
- Operation sequences forming a change DAG (similar to git)
- Columnar encoding with RLE compression

This enables offline editing with automatic merge on reconnection.

#### Layered CRDT Architecture

CRDTs could operate at multiple levels simultaneously:

- **Space level**: The entire space modeled as a single CRDT document, tracking
  the evolution of the overall JSON-ish structure
- **Component level**: Individual parts (e.g., a text field) modeled as their
  own independent CRDT documents with type-specific merge semantics

These layers work in harmony:
- The space treats component CRDTs opaquely — just another value that changes
- Patterns that understand specific CRDT types can work with the component's
  native semantics (e.g., collaborative text editing with cursor positions)
- The space-level CRDT handles structural changes (adding/removing fields)
- Component-level CRDTs handle content changes within their boundaries

This separation allows general-purpose space sync to coexist with specialized
collaborative editing where needed.

#### Trade-offs

| Benefit | Cost |
|---------|------|
| Automatic conflict resolution | Fixed type system requires mapping layer |
| Offline-first with sync | Causal history grows over time |
| Proven merge semantics | Additional complexity vs simple last-write-wins |
| Cross-language support | Must map custom types to Automerge types |

#### Open Questions

- Which data benefits from CRDT semantics vs simple last-write-wins?
- How do Cells map to Automerge documents?
- Should collaborative text (Text type) be exposed directly?
- What is the compaction/garbage collection strategy for causal history?

---

## Open Questions

- Should there be additional special object shapes beyond `"/"` and `@Error`?
- How should versioning of special shapes work?
- What happens when unknown special shapes are encountered?
- Should the `@Error` format capture more or less information?

---

**Next:** [Storage Format](./2-storage-format.md)
