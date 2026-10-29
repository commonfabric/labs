# JSON Encoding for Fabric Values

This document specifies the JSON-compatible wire format used to represent
`FabricValue`s, including the `fvj1:` encoding prefix, the tagged-object
convention, escaping mechanisms, codec engine responsibilities, the
reservation rules for `/`-prefixed keys, the canonical text an encoder writes,
and the floors on the guarantees an implementation states.

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
  the number `42` encodes as the seven-character string `fvj1:42`). The JSON
  body it writes is the canonical text of Sections 10 and 11.
- A conforming **decoder** verifies the prefix is present before parsing the
  remainder as JSON, and strips the prefix before processing. It refuses JSON
  in which an object names one member twice, and a number too large in
  magnitude for an IEEE 754 double, which it does not round to an infinity or
  to the largest double. It refuses the number `-0` too: negative zero is
  written only as `SpecialNumber@1` (Section 3). Short of those refusals, it
  accepts any JSON text, not only the canonical text an encoder writes
  (Section 11.4), for a value within the guarantees it states (Section 12).
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
>
> Padding, where a state has it, is exactly RFC 4648's (Section 3.2, "Padding
> of Encoded Data"). `=` appears only at the end of a state, and there are
> exactly as many as complete its final group of characters to four: two after
> a final group of two, one after a final group of three, and none when the
> characters already make whole groups. So `AQ==` and `AQI=` are accepted, and
> `AA=`, `AAA==`, `AAAA=`, and `==` are refused. Padded or not, the characters
> before any `=` never number one more than a multiple of four, since a group of
> one character cannot carry a whole byte.
>
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
- `Undefined@1` — `null`, and nothing else. The type is stateless (Section 5).
- `Map@1` — `[[key, value], ...]`, entry pairs in insertion order.
- `Set@1` — `[value, ...]`, values in insertion order.
- `Bytes@1` — a base64url string, per the convention above.
- `hole` — a positive integer giving the length of a run of array holes. This
  is a structural meta-key rather than a type tag, and is valid only directly
  inside an array; see the sparse-array note below.

### `Error@1` — errors

State is `{ type: string, name?: string | null, message: string, stack?:
string, cause?: <any>, ... }`, where the trailing properties are the error's own
custom ones. `type` names the error's class and `message` is its message, and
both are required. `name` is the error's name where that differs from `type`.
A `name` of `null` means the name is the same as `type`, and so does a state
with no `name` at all; an encoder writes `null` for such a name rather than
leaving it out. `stack` and `cause` are present exactly when the error has
them.

On decoding, a state that is not an object, that lacks `type` or `message`, or
whose `type`, `message`, or `stack` is not a string, or whose `name` is neither
a string nor `null`, produces a `ProblematicValue`.

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

State is `{ source: string, flags: string, flavor: string }`, and all three
fields are required. `source` is the pattern string and `flags` the flag string
(for example `gi`). `flavor` names the regular-expression dialect the pattern
and flags are written in, for example `es2025`, that of ECMAScript 2025. The
format has no default flavor, and requires no implementation to support any
particular one.

On decoding, a state that is not an object, that lacks any of the three
fields, or that has one that is not a string produces a `ProblematicValue`. An
implementation constructs each pattern whose flavor it supports, which
validates it, and may refuse one that fails to construct, producing a
`ProblematicValue`. A pattern under a flavor the implementation does not
construct is stored faithfully and **not** validated. See `1-fabric-values.md`
Section 1.4.5.

> **JS implementation note.** This implementation constructs `es2025` patterns,
> as JavaScript `RegExp`s, and refuses one that fails to construct. It
> constructs no other flavor.

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

> **Maximum array length.** How long an array an implementation handles is
> one of the guarantees of Section 12, which also says how a run of holes counts
> toward it.

> **Bounding a decode of untrusted text.** Parsing JSON text builds every
> value the text writes, and because a `hole` run carries its length as a
> number, a few bytes can also stand for billions of array slots that any walk
> over the decoded array visits. A decoder reading untrusted text may therefore
> refuse text standing for more slots than a limit its caller sets. A slot is
> an array element or a record member written in the text, wherever it
> appears, and a `hole` run adds one slot for each hole past the first that it
> stands for. The elements and members can be counted by scanning the text
> without parsing it, so a decoder can refuse text before building any of it.
> The format itself sets no slot limit, and a decoder reading text it wrote
> itself sets none. A slot limit is distinct from the guarantees of Section 12:
> it belongs to one decode rather than to the implementation, and the floors
> that section sets do not bind it.

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
object has — the encoder wraps it in one of these escapes, `/object` or
`/quote`, chosen as "Encoder Dispatch" below requires. This prevents the
decoder from treating the object as a reserved form. A decoder reads either
escape wherever it is well-formed; the choice binds the encoder alone, so that a
value has one text (Section 11).

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

### Encoder Dispatch

When the encoder encounters a plain object that needs an escape (i.e., any plain
object containing one or more `/`-prefixed keys), it **must** choose the escape
this way:

- If the entire subtree to be wrapped is fully literal — it contains no value
  encoded under a tag (Section 3, `undefined` and the special numbers among
  them) and no array holding a hole — emit `/quote`. A plain object within it
  that has `/`-prefixed keys of its own is written as itself, `/quote` having
  already made the whole subtree literal.
- Otherwise (some descendant value still needs to be processed as a special
  type during decoding), emit `/object`. Each plain object within it that has
  `/`-prefixed keys of its own makes the same choice for its own subtree.

The motivation is wire-format readability and round-trip fidelity: a
`/quote`-wrapped literal subtree appears in the wire format as itself, with no
per-key escaping or restructuring, which is easier for humans to read and
easier for tools to compare. Conversely, `/object` is required whenever any
descendant value still needs encoding, because `/quote` would suppress that
encoding entirely. Requiring one choice rather than allowing either is what
gives a value one text (Section 11).

The rule binds the encoder alone. **A conforming decoder must accept both
forms** wherever each is well-formed, whichever an encoder would have chosen:
`{ "/object": { "/x": 1 } }` decodes to the plain object `{ "/x": 1 }`, whose
canonical text is `{"/quote":{"/x":1}}`. See `1-fabric-values.md` Section 2.9
(immutability) and the freeze guarantee under `/quote` above for the properties
a decoder preserves regardless of which form it sees.

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
returning the preserved bare state, so the value passes through byte for byte
when it arrived as its canonical text (Section 11).

This applies only to a key that is syntactically a tag but claimed by no
codec. A key that is not a tag at all is a structural violation rather than an
unknown type, and is rejected under Section 9 — so an `UnknownValue` always
holds a real tag, which is what makes the round trip above a guarantee.

A `ProblematicValue` (Section 3) does not work this way. It encodes under its
own `Problematic@1` key with the preserved tag as data, because that tag may
be one that is not a tag, and so cannot be reproduced as a key.

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

A key holding a lone surrogate is compared by the bytes WTF-8 gives it, as
`2-hash-byte-format.md` Sections 4.4 and 5 specify.

This requirement applies to every plain object that reaches the wire,
including:

- Bare plain objects (no `/`-prefixed keys).
- Plain objects wrapped in `/object` (Section 6) — the keys of the wrapped
  inner object must be sorted.
- Plain objects wrapped in `/quote` (Section 6) — the keys of the quoted
  literal must be sorted.

> **Why sort.** Sorting is the part of the JSON wire form's **canonical** text
> (Section 11) that concerns records: two plain objects with the same keys and
> values produce the same JSON bytes regardless of the order in which their keys
> were inserted. This in turn lets two
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

## 11. Canonical Text

The sections before this one settle the structure of the JSON body for a value:
which arrays, records, and tags it holds, the exact states of Section 3, the
escape each record with a `/`-prefixed key takes (Section 6), and the order of
a record's keys (Section 10). This section settles the text: for a given value,
a conforming encoder **must** write exactly one text, fixing where whitespace
goes, how a number is written, and how a string is written. Two independently
built encoders therefore write the same text for the same value.

The rules are the ones ECMAScript's `JSON.stringify()` follows when called with
no indentation argument, and ECMA-262 is the authority wherever the summary
below seems to leave room. The summary is written so that an implementation in
another language can follow it without running JavaScript.

### 11.1 Whitespace

The body carries no insignificant whitespace: none before or after it, and none
between tokens. Members of a record are separated by a bare `,`, and a key from
its value by a bare `:`, so a record holding an array is written
`{"a":[1,2],"b":null}`. Whitespace appears only inside strings, as Section 11.3
writes it. The JSON examples elsewhere in this document are spaced for reading,
and are not the text an encoder writes for them.

### 11.2 Numbers

A number in the body is finite and is not negative zero: `NaN`, the infinities,
and `-0` are written as `SpecialNumber@1` (Section 3). A number is written as
ECMA-262's `Number::toString` abstract operation writes it in radix 10, which
is what `JSON.stringify()` writes for a finite number. In outline:

1. **Digits.** Take the shortest string of significant decimal digits that,
   scaled by a power of ten, reads back as the same IEEE 754 double. Where more
   than one string of that length reads back, take the one closest in value to
   the double, and of two equally close, the one whose last digit is even.
   ECMA-262 states this last refinement as a recommendation, in a note to
   `Number::toString`; this format requires it, since without it the final
   digit is not determined.
2. **Form.** Let `e` be the decimal exponent of the leading digit, so that the
   number's magnitude is `d.ddd × 10^e`.
   - For `-6 ≤ e ≤ 20`, the number is written positionally, with no exponent:
     a whole number as its digits followed by any zeros needed, with no decimal
     point; any other magnitude of 1 or more with the point after the first
     `e + 1` digits; and a magnitude below 1 as `0.`, then `-e - 1` zeros,
     then the digits.
   - Otherwise, that is for `e ≥ 21` or `e ≤ -7`, it is written exponentially:
     the first digit; then, if there are more, `.` and the rest; then a
     lowercase `e`, the sign of the exponent (`+` or `-`, always present), and
     the exponent's magnitude in decimal with no leading zeros.
3. **Sign.** A negative number is `-` followed by the form of its magnitude. A
   positive number carries no sign.

So `0`, `-1`, `100`, `0.1`, `0.000001`, `1e-7`, `1.5e-7`,
`100000000000000000000` (`1e20`), `1e+21`, `1.25e+21`, `0.30000000000000004`,
and `5e-324` are each the one way to write their number. A digit string never
ends in a zero after the point, and no number is written with an uppercase
`E`, a leading `+`, or a leading zero other than the one before `.` in a
magnitude below 1.

### 11.3 Strings

Every string in the body — a string value, a record key, a tag key such as
`"/Bytes@1"` — is written as ECMA-262's `QuoteJSONString` abstract operation
writes it. The string is taken as its sequence of UTF-16 code units, lone
surrogates included (`1-fabric-values.md` Section 6.7), and written between two
`"` characters, code unit by code unit:

- `"` and `\` are written `\"` and `\\`.
- U+0008, U+0009, U+000A, U+000C, and U+000D are written `\b`, `\t`, `\n`,
  `\f`, and `\r`.
- Every other code unit below U+0020, and every lone surrogate (a code unit in
  the range U+D800 to U+DFFF that is not part of a high-then-low pair), is
  written `\u` followed by four **lowercase** hexadecimal digits: U+001B is
  `\u001b`, and a lone U+DABC is `\udabc`.
- Everything else is written as itself, `/`, U+007F, U+2028, and U+2029
  included, and a surrogate pair as the one character it encodes.

Because a lone surrogate is always escaped, the body is always well-formed
Unicode, whatever strings the value holds.

### 11.4 Encoder and decoder

These rules bind what an encoder writes, and nothing else. A decoder accepts
any JSON text RFC 8259 allows, subject only to the refusals of Section 1.1:
whitespace between tokens, a number written `1.0E2` or `1E+21`, an escaped `\/`
or `\u2028`, an escape with uppercase digits such as `\uD800`, keys in any order
(Section 10), and `/object` where an encoder would write `/quote` (Section 6)
all decode. Such a text decodes to the same value its
canonical form does, so re-encoding that value writes the canonical form, which
can differ from the text that arrived even though the value does not.

> **Why one text.** Section 10's reasoning for key order extends to the rest of
> the body: when the text is a function of the value alone, equal values have
> equal text, which lets content addressing, deduplication, and diffing work on
> the text directly, and lets a conformance case state the exact text an
> encoder must produce.

## 12. Implementation Guarantees

An implementation states how large a value it guarantees to handle, by each of
the measures below. A stated figure is a guarantee rather than a limit: the
implementation encodes and decodes any value within it. Past the figure, the
implementation may refuse the value or may handle it, and the format says
neither, so a conformance test asks nothing of a value past a stated
guarantee, and in particular does not ask that one be refused. An implementation
that states no figure for a measure guarantees every size by it.

Each measure has a floor, the smallest guarantee an implementation may state:

| Measure | Floor |
|---------|-------|
| Length of an array | 2^24 (16,777,216) elements |
| Members of a record | 2^14 (16,384) members |
| Length of a string | 2^24 (16,777,216) code points |
| Length of a byte sequence | 2^24 (16,777,216) bytes |
| Length of a registered symbol's key | 2^10 (1,024) code points |
| Depth | 2^10 (1,024) containers |

A guarantee covers one measure taken alone. The format sets no floor on a
value's size as a whole, and an implementation may fail a value that is within
each of its guarantees but too large in total for it to hold.

**Arrays.** An array's length counts every hole a `hole` run stands for
(Section 3), not just the members the text writes. An array of exactly the
guaranteed length is within the guarantee even when every element is a hole:
an implementation guaranteeing a length of `n` decodes `[{ "/hole": n }]`, and
encodes the array it stands for.

**Records.** A record is any object the JSON body writes: a plain object,
including one wrapped in `/object` or `/quote` (Section 6), and equally a
type's state, such as an `Error@1` state with its custom properties. The
single-key object that wraps a tagged value has one member.

**Strings.** A string's length is its count of Unicode code points. A surrogate
pair is one code point, and so is a lone surrogate, which the format treats as
a code point of its own value (`1-fabric-values.md` Section 6.7, and the WTF-8
encoding of `2-hash-byte-format.md` Section 4.4). The guarantee covers every
string the value holds: string values, record keys, and the strings in a
type's state, such as an `Error@1` message or a `RegExp@1` source. It is about
the value, not the text: a string's JSON text can be several times as long as
its count of code points, an escaped code unit taking six characters.

**Byte sequences.** The guarantee covers every byte sequence the value holds: a
`Bytes@1` value, the hash of a `Hash@1`, and each key of a `KeyPair@1`. It
counts the bytes, not the base64url characters of the state that writes them.

**Registered symbol keys.** The key a `Symbol@1` state carries is measured as a
string is, but has its own, smaller floor. For that one string, the
implementation's guarantee for symbol keys takes the place of its guarantee for
strings.

**Depth.** A value's depth is the greatest number of containers enclosing any
point in it, counted as `2-hash-byte-format.md` Section 4.19 counts the path:
arrays, plain objects, and instances, with an instance and its state as two
where the state is an array or a plain object. A value that is not a container
has depth 0, `[]` has depth 1, `[[]]` has depth 2, and an `Error` whose state
holds no container has depth 2. Depth is the value's, not the text's: an escape
wrapper, `/object` or `/quote`, adds nothing, and nor does a `hole` entry; the
single-key object wrapping an instance is the instance; and a primitive adds
nothing, whatever the shape of its state in the text.

**What the floors do not bind.** The floors bind only the guarantees an
implementation states. A caller reading untrusted text may set a lower bound
for one decode, the slot limit of Section 3, and refusing text under that bound
is no failure to meet a guarantee.
