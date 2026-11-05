# Space Model Formal Spec: Data Model

This directory contains the formal specification for the Space Model data model
that the [data model spec](../space-model/1-data-model.md) describes: a
self-contained, implementable specification.

## Scope

This spec covers:

- **Fabric values** (Sections 1-2) -- the type universe for all persistent and
  in-flight data, and the fabric protocol (a per-class codec getter --
  `[CODEC]` or `[JSON_CODEC]` -- yielding a `FabricCodec`) for custom type
  participation in encoding, and the type-tag syntax every interchange format
  shares
- **Unknown types** (Section 3) -- forward-compatibility via `UnknownValue`
- **Codec engines** (Section 4) -- boundary-crossing encoding strategy, and the
  `encode()`/`decode()` boundary
- **Wire formats and boundaries** (Section 5) -- the boundary inventory, and
  the two wire formats, each specified in a document of its own:
  - **JSON encoding** -- the `fvj1:` encoding prefix, the `/<Type>@<Version>`
    wire format for special types, escaping, detection rules, the `/`-key
    reservation rule, the canonical text an encoder writes, and the floors on
    the size guarantees an implementation states
  - **Realm-crossing encoding** -- the wire format for a structured-clone
    transport: the envelope and the marker that identifies it, per-type
    encodings, the ownership contract on decode, and what the format refuses
- **Hashing** (Section 6) -- content-based identity for `FabricValue`s
- **Unifying JSON encoding** (Section 7) -- the conventions still found in
  stored JSON that are not part of the JSON encoding, and their retirement
- **Conversion functions** (Section 8) -- the bridge between arbitrary
  JavaScript values and `FabricValue`s

Out of scope: CRDT-based storage layer, network sync protocols, the reactive
system, schemas.

## Documents

- [1-fabric-values.md](./1-fabric-values.md) -- Fabric value types, the
  three-layer architecture, the fabric protocol, type tags, unknown types,
  codec engines, wire formats and boundaries, hashing, the unification of JSON
  encoding, and conversion functions. (Sections 1-8.)
- [2-hash-byte-format.md](./2-hash-byte-format.md) -- Byte-level encoding for
  the hash algorithm.
- [3-json-encoding.md](./3-json-encoding.md) -- The JSON wire format for
  `FabricValue`s: the `fvj1:` encoding prefix, `/<Type>@<Version>` tagged
  objects, standard type encodings, detection, escaping, the `/`-key
  reservation rule, the canonical text an encoder writes (key order, numbers,
  strings, and whitespace), and the floors on the size guarantees an
  implementation states: array and string length, record members, byte
  sequences, symbol keys, and depth.
- [4-realm-encoding.md](./4-realm-encoding.md) -- The realm-crossing wire
  format, for the self-dealing boundary internal to a runtime --
  `structuredClone()` and `postMessage()`, and a durable structured-clone
  store read back later: the `[marker, tree]` outer envelope, identity-based
  detection, standard type encodings, cycles and sharing, and the ownership
  contract each direction carries -- an encoded tree sharing structure with
  the value it came from, and a decoded one carrying no guarantee of being
  usable again.

## Citing these documents

From outside a document, cite a section by the file name of its document, as
in "`1-fabric-values.md` Section 2.4". "The formal spec" names the whole series,
so it does not say which document a section number belongs to. Within a
document, a bare section number names a section of that same document.
