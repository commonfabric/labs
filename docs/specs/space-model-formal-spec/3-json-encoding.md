# JSON Encoding for Fabric Values

This document specifies the JSON-compatible wire format used to represent
`FabricValue`s, including the `fvj1:` encoding prefix, the tagged-object
convention, escaping mechanisms, codec engine responsibilities, and the
reservation rules for `/`-prefixed keys.

## Status

Draft formal spec — extracted from Section 5 of `1-fabric-values.md`.

---

## 1. Overview

This section specifies the JSON-compatible wire format for special types. While
the system will maintain a JSON encoding indefinitely (for debugging and
interoperability), other wire and storage formats (e.g., CBOR) may represent
types more directly without layering on JSON.

### 1.1 Encoding Prefix

Every encoded `FabricValue` carries an unambiguous textual prefix, before the
JSON itself:

```
fvj1:<json>
```

The literal string `fvj1:` stands for "Fabric Value JSON, version 1". Its
purpose is to make the encoded form distinguishable, on inspection, from
arbitrary JSON produced by some other source — a brief peek at the start of
a string is sufficient to tell whether it carries a `FabricValue` payload.

- A conforming **encoder** emits the prefix exactly once, immediately before
  the JSON body, on every encoded value (including encoded primitives — e.g.,
  the number `42` encodes as the seven-character string `fvj1:42`).
- A conforming **decoder** verifies the prefix is present before parsing the
  remainder as JSON, and strips the prefix before processing. It refuses JSON
  in which an object names one member twice, and a number too large in
  magnitude for an IEEE 754 double, which it does not round to an infinity or
  to the largest double. It refuses the number `-0` too: negative zero is
  written only as `SpecialNumber@1` (Section 3).
- A short detection helper (`JsonCodecEngine.seemsLikeEncoded()`) tests for
  the prefix without parsing — useful for routing arbitrary input through the
  right decode path.

**Forward compatibility.** The trailing `1` is a version digit, reserving the
prefix space for future incompatible revisions of the wire format. Should the
encoding ever evolve in a way older decoders cannot interpret, a new prefix
(`fvj2:`, etc.) signals the change; older decoders can reject the input
cleanly rather than parsing it incorrectly. The current spec defines only
`fvj1:`.

## 2. Key Convention: `/<Type>@<Version>`

All special types in JSON use a single convention: single-key objects where the
key follows the pattern `/<Type>@<Version>`.

- `/` — sigil prefix (nodding to IPLD heritage)
- `<Type>` — type name
- `@<Version>` — version number

The tag is the key without its sigil, and its syntax is exact, because that
syntax is what separates an unrecognized type from a malformation. A name is an
uppercase ASCII letter followed by any number of ASCII letters and digits —
`UpperCamelCase`. A version is a decimal integer with no leading zero, so the
lowest version is 1. A tag is a name, `@`, and a version, with nothing before
or after. `Bytes@1` and `Abc123@1234` are tags; `bytes@1`, `By-tes@1`,
`Bytes@0`, `Bytes@01` and `Bytes@1.0` are not, and neither is any of those
padded with whitespace or a newline.

A string outside that syntax is not an unrecognized tag; it is not a tag at
all. A key naming one is a structural violation under Section 9 rather than an
`UnknownValue` under Section 8, and that is what lets an `UnknownValue` always
hold a real tag. The escapes `/quote` and `/object` (Section 6), and the
sparse-array marker `/hole` (Section 3), fall outside the syntax deliberately,
each being a structural marker the format handles itself rather than a type
anything encodes.

The syntax is not particular to JSON. It is the type-tag syntax the whole codec
system shares: a registry refuses a codec that declares a fixed tag outside it,
so no codec can claim a tag the decoder would reject, and a format that lays
its tags out differently on the wire still writes tags of this syntax.

This convention does **not** prohibit storing plain objects that happen to have
`/`-prefixed keys. The escaping mechanism in Section 6 (`/object` and
`/quote`) handles this case: during encoding, plain objects whose shape
would be ambiguous with a tagged type are automatically wrapped so they
round-trip correctly.

## 3. Standard Type Encodings

> **Base64url encoding convention.** All base64-encoded values in the JSON wire
> format use the URL-safe base64url alphabet (`A-Za-z0-9-_`, per RFC 4648
> Section 5). Encoders **must omit** trailing `=` padding characters. Decoders
> **must accept** both padded and unpadded input for compatibility;
> standard-base64 characters (`+`, `/`) are still invalid and must be rejected,
> as is whitespace, or any other character outside the alphabet and the
> trailing padding. Every bit the characters carry past the last whole byte
> must be zero, so that `AQ` is the one spelling of the byte `0x01` and `AR`
> is refused.
> This convention applies to `Bytes@1`, `BigInt@1`, `EpochNsec@1`,
> `EpochDay@1`, `DurationNsec@1`, and `DurationDay@1` state values, to the
> `hash` field of `Hash@1` state, and to the `publicKey` and `privateKey` fields
> of `KeyPair@1` state.

The JSON key for a tagged value is the tag with `/` prepended, per Section 2:
a value under `Link@1` is written `{ "/Link@1": <state> }`. What follows
specifies each built-in type's state. Which classes and codecs are registered
under these tags is a separate question, specified in `1-fabric-values.md`
Section 4.5.

These types need no rule beyond the shape of their state:

- `Link@1` — a plain object, the link's payload. The format sets no policy on
  its fields, which each use of links defines; `{ id: string, path: string[],
  space: string }` is one such shape.
- `Error@1` — `{ type: string, name: string | null, message: string, stack?:
  string, cause?: <any>, ... }`, where the trailing properties are the error's
  own custom ones.
- `Undefined@1` — `null`, and nothing else. The type is stateless (Section 5).
- `Map@1` — `[[key, value], ...]`, entry pairs in insertion order.
- `Set@1` — `[value, ...]`, values in insertion order.
- `Bytes@1` — a base64url string, per the convention above.
- `hole` — a positive integer giving the length of a run of array holes. This
  is a structural meta-key rather than a type tag, and is valid only directly
  inside an array; see the sparse-array note below.

### `Hash@1` — content hashes

State is `{ tag: string, hash: string }`. `tag` is the algorithm tag (for
example `fid1`), and `hash` is the hash bytes as an unpadded base64url string,
per the convention above. On decoding, a state that is not an object, or whose
fields are not strings, produces a `ProblematicValue`. See `1-fabric-values.md`
Section 1.4.9.

### `KeyPair@1` — asymmetric key pairs

State is `{ algorithm: string, publicKey: string, privateKey: string }`.
`algorithm` names the algorithm in Web Crypto's normalized spelling (for
example `Ed25519`), and the two keys are their raw bytes as unpadded base64url
strings, per the convention above. On decoding, a state that is not an object,
or whose fields are not strings, produces a `ProblematicValue`, as does a key
that is not valid base64url.

**Only a pair that holds key material has a state here.** A `FabricKeyPair`
that holds `CryptoKey` handles instead is refused: encoding one throws rather
than producing a state. That refusal is the format's contract with a
non-extractable key, whose material is by construction unreachable — there is
nothing to write down, and a state naming the algorithm alone would claim to
carry a key it did not. Such a pair crosses under the realm encoding
(Section 3.4 of [4-realm-encoding.md](./4-realm-encoding.md)) and nowhere else.
See `1-fabric-values.md` Section 1.4.11.

### `RegExp@1` — regular expressions

State is `{ source: string, flags: string, flavor: string }`. `source` is the
pattern string and `flags` the flag string (for example `gi`). `flavor`
identifies the regular-expression dialect, `es2025` being the default.

On decoding, a state that is not an object produces a `ProblematicValue`, as
does an `es2025` pattern that fails to construct. A pattern under any other
flavor is stored faithfully and **not** validated, its dialect not being one
this format can construct. See `1-fabric-values.md` Section 1.4.5.

### `Unavailable@1` — unavailable data

State is `{ reason: string }` for a transient reason, and for reason `error`
`{ reason: string, errorKind: string }` or
`{ reason: string, errorKind: string, errorMessage: string }`. `reason` is one
of `pending`, `syncing`, and `error`; `errorKind` is one of `general`,
`schemaMismatch`, `invalidInput`, `network`, `decode`, `compile`, `provider`,
and `sync`, present exactly when the reason is `error`; and `errorMessage` is
present exactly when a message is stored. A field with nothing to say is
absent rather than present as `null`. An `error` whose message is its kind's
default encodes without one, the default being presentation rather than
state.

On decoding, a state that is not an object, whose `reason` is not one of the
three, whose `errorKind` is present and not one of the kinds, or whose
`errorMessage` is present and not a string produces a `ProblematicValue`. So
does a state pairing a kind or a message with a transient reason, or omitting
the kind from `error`: the class never writes either, and the constructor
refuses both. A well-formed state that is a transient reason alone decodes to
that reason's prefab instance. See `1-fabric-values.md` Section 1.4.12.

### `BigInt@1` — arbitrary-precision integers

State is the base64url encoding of the value's minimal two's-complement
representation in big-endian byte order. The minimum length is one byte, so
even `0n` encodes as a single `0x00`:

| Value | Bytes | State |
|-------|-------|-------|
| `0n` | `0x00` | `"AA"` |
| `1n` | `0x01` | `"AQ"` |
| `-1n` | `0xFF` | `"_w"` |
| `128n` | `0x00 0x80` | `"AIA"` |
| `-128n` | `0x80` | `"gA"` |

`128n` is the case that shows why the representation is two's complement rather
than magnitude: `0x80` alone decodes as `-128`, so a leading zero byte is
required to keep the value positive. This is the same encoding the hash byte
format uses for bigint payloads (`2-hash-byte-format.md` Section 4.5).

On decoding, a state that is not minimal — one with a leading `0x00` or `0xFF`
byte that the sign does not need — is refused.

### Temporal quantities

`EpochNsec@1`, `EpochDay@1`, `DurationNsec@1`, and `DurationDay@1` each carry a
bigint, and each encodes it exactly as `BigInt@1` does: base64url of the
minimal two's-complement big-endian bytes.

### `SpecialNumber@1` — numbers JSON cannot represent

State is one of exactly four literal strings, and nothing else:

- `"-0"` — negative zero.
- `"NaN"` — any input NaN bit pattern encodes to this one literal, and decodes
  back to `NaN`.
- `"+Infinity"` — positive infinity.
- `"-Infinity"` — negative infinity.

The state is a string rather than a JSON number because a numeric state would
be lossy through the JSON layer: `JSON.stringify` emits `null` for `NaN` and
the infinities, and drops the sign of `-0`. On decoding, any other state —
including one that is not a string — produces a `ProblematicValue`. This is
the only way negative zero is written: the JSON number `-0` is refused
(Section 1.1).

Whether such a value reaches the encoder at all depends on the `FabricValue`
conversion gate (`1-fabric-values.md` Section 4.9). The encoding above is the
encoder's contract however the value arrived.

### `Symbol@1` — registry-interned symbols

State is the registry key: the string `Symbol.keyFor()` returns for the symbol.
On decoding, `Symbol.for(state)` retrieves or creates the registry symbol with
that key, so the result is identical to any other symbol interned under it in
the same realm.

A symbol with no registry key has no portable representation, and the codec
declines to encode one rather than coercing it to a key. On decoding, a state
that is not a string produces a `ProblematicValue`.

Whether such a value reaches the encoder at all depends on the `FabricValue`
conversion gate (`1-fabric-values.md` Section 4.9). The encoding above is the
encoder's contract however the value arrived.

### `Problematic@1` — preserved failures

State is `{ tag: string, state: <any>, error: string }`. `tag` is the tag the
faulty data arrived under, `state` is what was at fault, and `error` describes
what is wrong with it. All three are preserved, so a recorded failure survives
a round trip as an account of a failure rather than as an unremarkable value.

Alone among these types, the key here is a fixed tag rather than the tag of the
value it stands in for. The preserved tag rides inside the state because it
need not be a well-formed tag at all — reporting one that is not is among the
things this type is for, and such a value could not go back out under it.
`UnknownValue` is the type that re-emits under its preserved tag (Section 8),
which it can because that tag is known to be a real one.

On decoding, a state that is not an object, a `tag` or `error` that is not a
string, or an absent `state` property is refused, and settles against `lenient`
like any other malformation: a lenient decode yields a `ProblematicValue`
describing that decode, and a strict one raises. A well-formed record is a
record of a *past* failure and reads back as one under either setting, this
decode having succeeded. `state` is checked for presence rather than for type,
because every `FabricValue` is a valid state, `undefined` among them; filling in
an absent one would put a reshaped record back on the wire.

See `1-fabric-values.md` Section 3.5.

> **Decoding validation.** Decoding cannot assume type safety from the wire.
> Each codec must reject a state it did not write, rather than silently
> producing garbage from one — wrong type, invalid format, or missing fields
> alike. The rejection has two homes, and which one a check belongs in is
> settled by what asking costs. `canDecode()` holds what is cheap to ask and not
> already asked by the decoding: that the state is a `string`, that a record
> carries the fields the decoding reads and that they are strings, that a
> literal is one of a fixed set. `decode()` holds a check whose only
> implementation is the decoding itself — that a base64url string (such as
> `BigInt@1`, `EpochNsec@1`, `EpochDay@1`, `DurationNsec@1`, `DurationDay@1`,
> or `Bytes@1`) is valid base64url is answered by decoding it, so asking first
> costs that work twice.
>
> A codec may reject from `decode()` by throwing, or by returning a
> `ProblematicValue` (see `1-fabric-values.md` Section 3.5); with a refusal from
> `canDecode()` that makes three ways, and all three are equivalent, because the
> engine settles them into one answer according to its own `lenient` setting
> (see `1-fabric-values.md` Section 4.5). Which one a codec uses is therefore a
> matter of what reads well where it is written, and carries no meaning for a
> caller. This principle applies to all codecs. Wire data is untrusted input.
> See `1-fabric-values.md` Section 7.4 for the broader principle that applies to
> all code consuming decoded values.

> **Sparse array encoding in JSON.** Even when an array contains holes, it is
> encoded as a JSON array. Runs of consecutive holes are represented by `hole`
> entries, each carrying the run length as a positive integer. This preserves
> the array-as-array structure while efficiently encoding sparse arrays:
>
> - `[1, , undefined, 3]` encodes as `[1, { "/hole": 1 }, { "/Undefined@1": null
>   }, 3]`.
> - `[1, , , , 5]` encodes as `[1, { "/hole": 3 }, 5]`.
> - A very sparse array like `a = []; a[1000000] = 'x'` encodes as `[{ "/hole":
>   1000000 }, "x"]`.

> **Bounding a decode of untrusted text.** Parsing JSON text builds every
> value the text writes, and because a `hole` run carries its length as a
> number, a few bytes can also stand for billions of array slots that any walk
> over the decoded array visits. A decoder reading untrusted text may therefore
> refuse text standing for more slots than a limit its caller sets. A slot is
> an array element or a record member written in the text, wherever it
> appears, and a `hole` run adds one slot for each hole past the first that it
> stands for. The elements and members can be counted by scanning the text
> without parsing it, so a decoder can refuse text before building any of it.
> The format itself sets no limit, and a decoder reading text it wrote itself
> sets none.

## 4. Detection

In the JSON wire format, any plain object containing at least one key that
starts with `/` is a **reserved form** — it is either a tagged value, a
built-in escape, or an encoding error.

> **Data level vs. wire level.** User-data plain objects may carry any keys,
> including `/`-prefixed ones. The `/object` and `/quote` escapes (Section 6)
> exist precisely to represent such objects in encoded form without ambiguity. A
> conforming encoder always wraps user-data objects that contain `/`-prefixed
> keys via one of these escapes before they reach the wire, so bare `/`-prefixed
> keys in the wire format are always encoding signals, never literal user-data
> keys.

> **JS implementation note.** "Any keys" is the format's rule and this
> implementation does not yet meet it: a plain object carrying `__proto__` or
> `constructor` is refused rather than encoded, on both sides of the wire and in
> the inert check that decides what a `FabricValue` is at all. Neither name is
> reserved by the format, and neither is a limit of JavaScript. Both are about
> copying: this implementation rebuilds a record by assignment, which for
> `__proto__` reaches a prototype accessor instead of creating a property, and
> other boundaries here already drop `constructor`. An implementation on a host
> that does not route property assignment through a prototype chain reserves no
> names at all, which is the behavior the format describes.

The common case — a **tagged value** — is a single-key object whose sole key
starts with `/`:

1. It is a plain object.
2. It has exactly one key.
3. That key starts with `/`.

Multi-key objects that contain one or more `/`-prefixed keys among their keys
are also reserved (see Section 9). They are not treated as plain objects.

This reservation provides maximum flexibility to evolve the encoding without
ambiguity about what is an encoding signal and what is user data.

## 5. Stateless Types

Types that require no decoding state use `null` as the value:

```json
{ "/Undefined@1": null }
```

`null` is the only such state. A decoder refuses any other, `{}` included.
The distinction between "`null` state" and "no state needed" is implied by the
type being represented, not by the wire encoding.

## 6. Escaping

Two escape mechanisms handle cases where user data might be mistaken for
special types.

### `/object` — Single-Layer Escape

Wraps a plain object whose key(s) might look like special types. The values
are still processed normally during decoding:

```json
{ "/object": { "/myKey": { "/Link@1": { "id": "..." } } } }
```

Decodes to: `{ "/myKey": <decoded Link> }`. The `/object` wrapper is stripped;
inner keys are taken literally; inner values go through normal decoding.

A state under this tag that is **not** a plain object is malformed wire data,
and is refused rather than unwrapped — settled against `lenient` like any
other malformation off a channel.

**When the encoder emits `/object`:** During encoding, if a plain object
has any string key that starts with `/` — regardless of how many other keys the
object has — the encoder wraps it in one of these escapes (either `/object`
or `/quote`; see "Encoder dispatch" below). This prevents the decoder from
treating the object as a reserved form. `/object` is always a valid choice; the
distinction between `/object` and `/quote` is a recommendation about which form
makes the wire output most readable, not a correctness requirement.

### `/quote` — Fully Literal

Wraps a value that should be returned exactly as-is, with no decoding of any
nested special forms:

```json
{ "/quote": { "/Link@1": { "id": "..." } } }
```

Decodes to: `{ "/Link@1": { "id": "..." } }` — the inner structure is *not*
decoded. It remains a plain object.

**Freeze guarantee.** Although `/quote` skips type-tag interpretation, the
result is still deep-frozen (arrays and plain objects within the quoted value
are frozen via `Object.freeze()`). The immutability guarantee (see
`1-fabric-values.md` Section 2.9) is a property of decoding output, not of
whether decoding occurred. A caller receiving a value from the engine's
`decode()` can always assume it is immutable, regardless of whether it came from
a `/quote` path, a decoded type, or a plain literal. An engine constructed with
`mutable` as `true` reverses this uniformly: none of its output is frozen, the
`/quote` path's included.

Use cases:
- Storing schemas or examples that describe special types without instantiating
  them
- Metaprogramming and introspection
- Optimization: skip decoding when the subtree is known to be plain data
- Round-tripping JSON structures that happen to look like special types

### When to Use Which

- `/object`: You have a plain object with a slash-prefixed key, but values
  should still be interpreted normally.
- `/quote`: You want the entire subtree treated as literal JSON data.

### Encoder Dispatch (Recommended Best Practice)

When the encoder encounters a plain object that needs an escape (i.e., any plain
object containing one or more `/`-prefixed keys), both `/object` and `/quote`
are valid choices. The recommended best practice is:

- If the entire subtree to be wrapped is fully literal — i.e., it contains no
  values that would themselves need encoding as special types — emit `/quote`.
- Otherwise (some descendant value still needs to be processed as a special
  type during decoding), emit `/object`.

The motivation for the recommendation is wire-format readability and round-trip
fidelity: a `/quote`-wrapped literal subtree appears in the wire format as
itself, with no per-key escaping or restructuring, which is easier for humans to
read and easier for tools to compare. Conversely, `/object` is required (not
just preferred) whenever any descendant value still needs encoding, because
`/quote` would suppress that encoding entirely.

This is a **recommendation, not a requirement**. A conforming encoder may emit
`/object` in either case; the wire format is unambiguous either way. **A
conforming decoder must accept both forms.** See `1-fabric-values.md` Section
2.9 (immutability) and the freeze guarantee under `/quote` above for the
properties a decoder preserves regardless of which form it sees.

## 7. Codec Engine Responsibilities

The JSON engine generates and parses `/<Type>@<Version>` keys. It is also
responsible for:

- Owning recursion and tag-wrapping around the shallow per-type codecs (see
  `1-fabric-values.md` Sections 2.4 and 4.5): tags come from
  `codec.tagForValue(value)` on encode, and decode routes each tag to its
  registered codec via the `CodecRegistry`.
- Re-wrapping unknown types using the per-instance `wireTypeTag` preserved
  in `UnknownValue` (read back through its codec's `tagForValue()`), and
  constructing `UnknownValue` for tags with no registered codec. A
  `ProblematicValue` is not re-wrapped this way; see Section 8.
- Settling a codec's rejection according to `lenient`: in lenient mode a
  codec's throw becomes a `ProblematicValue`, and in strict mode a
  `ProblematicValue` a codec returns becomes a throw. `ProblematicValue`'s
  own codec is exempt from the second half, because for that one a
  `ProblematicValue` is the successful product rather than a rejection: a
  payload under `Problematic@1` is a well-formed record of a past failure,
  and reading one back is not a failure of this decode. Without the
  exemption a strict reader could never read such a record, which is most
  of what preserving one is for.

Note: `/object` escaping (Section 6) is applied directly by the engine's
internal encode walker in its plain-objects path, since it is structural
escaping rather than type encoding.

## 8. Unknown Type Handling

When a JSON decode encounters a `/<Type>@<Version>` key it doesn't recognize,
it wraps the data in `UnknownValue` (see `1-fabric-values.md` Section 3) to
preserve it for round-tripping. Re-encoding reproduces the original key,
the codec's `tagForValue()` reading back the preserved tag and `encode()`
returning the preserved bare state, so the value passes through byte for byte.

This applies only to a key that is syntactically a tag but claimed by no
codec. A key that is not a tag at all is a structural violation rather than an
unknown type, and is rejected under Section 9 — so an `UnknownValue` always
holds a real tag, which is what makes the round trip above a guarantee.

A `ProblematicValue` (Section 3) does not work this way. It encodes under its
own `Problematic@1` key with the preserved tag as data, because that tag may
be one that is not a tag, and so cannot be reproduced as a key.

Recognition is version-specific. For example, a runtime which registers
`FabricUnavailable@1` but not `FabricUnavailable@2` decodes the latter as an
`UnknownValue`; it does not apply the version-1 discriminator validation to
the future state.

## 9. `/`-Key Reservation Rule

The `/` prefix is wholly owned by the encoding system in the wire format. Any
object containing **any** key that starts with `/` — regardless of how many
other keys the object has — is a **reserved form** in the encoded
representation. User-data plain objects may contain `/`-prefixed keys at the
data level, but a conforming encoder always wraps them via `/object` or `/quote`
(Section 6) before they reach the wire. The presence of a bare `/`-prefixed key
in a wire-format object therefore always signals a tagged value, built-in
escape, or encoding error — never a literal user-data key.

Specifically:

- **Objects with a bare `"/"` key** (i.e., the tag name is empty after
  stripping the leading `/`) are always encoding errors, and are rejected. No
  valid tag has an empty name.
- **Single-key objects** whose sole key starts with `/` are either a tagged
  value of a known type (e.g. `{ "/Error@1": ... }`), a built-in escape
  (`/object`, `/quote`), or an unrecognized tag. A syntactically well-formed
  but unrecognized tag (e.g. `{ "/Future@2": ... }`) must be treated as
  `UnknownValue` (see Section 8) to preserve it for round-tripping. Structural
  violations — e.g. a tag name that cannot be a valid type identifier — are
  rejected.
- **Multi-key objects** containing one or more `/`-prefixed keys are structural
  encoding errors, and are rejected. They are not valid plain objects.

A structural violation is malformed wire data the engine detects itself,
rather than a state a codec refuses, and the two are settled the same way:
against `lenient` (see `1-fabric-values.md` Section 4.5). A lenient decode
yields a `ProblematicValue`, and a strict one raises. Which of the two
noticed the fault is an implementation detail of where a check lives, and does
not reach a caller.

The `/object` escape (Section 6) ensures that legitimate plain objects with
`/`-prefixed keys are always wrapped before reaching the wire, so a conforming
encoder will never emit a plain-object form that violates this rule. A
conforming decoder that encounters a violation should treat it as an encoding
error.

## 10. Plain Object Key Ordering

A conforming encoder **must** emit the keys of every plain object in **UTF-8
byte order**, using the same comparison defined for hashing in
`2-hash-byte-format.md` Section 5:

1. Compare byte-by-byte, treating each byte as an unsigned integer (0--255).
2. At each position, the byte with the smaller unsigned value comes first.
3. If one key is a prefix of another, the shorter key comes first.

This requirement applies to every plain object that reaches the wire,
including:

- Bare plain objects (no `/`-prefixed keys).
- Plain objects wrapped in `/object` (Section 6) — the keys of the wrapped
  inner object must be sorted.
- Plain objects wrapped in `/quote` (Section 6) — the keys of the quoted
  literal must be sorted.

> **Why sort.** Sorting makes the JSON wire form **canonical**: two plain
> objects with the same keys and values produce the same JSON bytes regardless
> of the order in which their keys were inserted. This in turn lets two
> independently-built encoders agree on a single byte-for-byte encoding for the
> same logical value, which simplifies content addressing, deduplication, and
> diffing. The sort key is the same UTF-8 byte order used by hashing, so the two
> systems share one specification of "canonical key order."
>
> The keys of a single-key tagged object (`/<Type>@<Version>`, `/object`,
> `/quote`, `/hole`, etc.) are trivially "sorted" — there is only one key. The
> requirement is meaningful only for plain objects with two or more keys, and
> for the inner contents of `/object` and `/quote` wrappers.

> **JS implementation note.** JavaScript's native string comparison (`<`, `>`,
> `Array.prototype.sort` with no comparator) sorts by UTF-16 code units, which
> differs from UTF-8 byte order when supplementary characters (U+10000 and
> above) are present. An implementation must use a UTF-8-aware comparator (or
> equivalently, sort by Unicode code point) when supplementary characters may
> appear in keys. See `2-hash-byte-format.md` Section 5 for the detailed
> rationale and example.

> **Decoder behavior.** A decoder is **not** required to validate that incoming
> keys are sorted. The host language's own object representation may impose its
> own iteration order on the decoded value (for example, in JavaScript,
> integer-index-like keys iterate in numeric order ahead of other string keys,
> regardless of the order in which they appeared on the wire). A conforming
> encoder re-establishes UTF-8 canonical key order on output regardless of the
> order in which keys were received or the host language's iteration rules.
