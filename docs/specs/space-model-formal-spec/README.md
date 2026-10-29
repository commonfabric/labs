# Space Model Formal Spec: Data Model

This directory contains the formal specification for the Space Model data model.
It is derived from the proposal sections of the original [data model
spec](../space-model/1-data-model.md), reformulated as a self-contained,
implementable specification.

## Scope

This spec covers:

- **Fabric values** (Sections 1-2) -- the type universe for all persistent and
  in-flight data, and the fabric protocol (a per-class codec getter --
  `[CODEC]` or `[JSON_CODEC]` -- yielding a `FabricCodec`) for custom type
  participation in encoding
- **Unknown types** (Section 3) -- forward-compatibility via `UnknownValue`
- **Codec engines** (Section 4) -- boundary-crossing encoding strategy, the
  `encode()`/`decode()` boundary, and boundary inventory
- **JSON encoding** -- the `fvj1:` encoding prefix, the `/<Type>@<Version>`
  wire format for special types, escaping, detection rules, the `/`-key
  reservation rule, the canonical text an encoder writes, and the floors on
  the size guarantees an implementation states
- **Realm-crossing encoding** -- the wire format for a structured-clone
  transport: the envelope and the marker that identifies it, per-type
  encodings, the ownership contract on decode, and what the format refuses
- **Hashing** (Section 6) -- content-based identity for `FabricValue`s
- **Implementation guidance** (Section 7) -- migration from legacy formats

Out of scope: CRDT-based storage layer, network sync protocols, the reactive
system, schemas.

## Documents

- [1-fabric-values.md](./1-fabric-values.md) -- Fabric value types, the
  three-layer architecture, the fabric protocol, unknown types, encoding
  contexts, hashing, implementation guidance, and conversion functions.
  (Sections 1-4, 6-8.)
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
