# Paths, mods and probes

The two conformance fixtures beside this file share a notation, which this
document defines. Both write each value as its `fvj1:` text, with mods to
decoding it that state what no text carries. `fvj1-conformance.json` then states
what decoding the text returns as a list of probes, each a path into the value
paired with what a reader finds there.
[`fvj1-conformance.md`](fvj1-conformance.md) and
[`hash-conformance.md`](hash-conformance.md) describe the fixtures themselves,
and `src/conformance-fixtures.ts`, in `packages/data-model`, writes and reads
this notation.

## Paths

A path is a list of steps from the root, `[]` being the root itself. A number
steps into an array at that index. A string steps into a record under that key,
or into an instance under the name of one of its fields, as [Shapes](#shapes)
lists them. `{"utf16": [...]}` steps under a key holding a lone surrogate, as
its UTF-16 code units, since not every JSON reader keeps one.

A path runs through the value, not the wire. On the wire an `Error`'s extras sit
beside its `message`, and a link's payload is the whole of its state, but the
paths into them are `["extras", "code"]` and `["payload", "id"]`.

## Mods

Some values have no text, or none that decodes to them unaided. Two mods state
what the text cannot:

- `unclaimed`: wire tags, in UTF-8 order and each once. Decode the text as
  though no codec claimed them, so that a value under one decodes as an unknown
  value preserving its tag and state, as it would for a reader that has no codec
  for the tag. Only a tag a class claims is named here. The four that the format
  itself decides, `BigInt@1`, `SpecialNumber@1`, `Symbol@1` and `Undefined@1`,
  never are, so an unknown value under one of those has no text and mods.
- `patches`: changes made to the decoded value, each `{"at": path, "put": …}`.
  The path runs through the arrays and records of the decoded text, never into
  an instance, and the text holds a `null` where it ends, which the patch
  replaces. `put` is one of:
  - `{"cycle": path}`: the array or record at that path, which closes a cycle.
    The path is absolute, from the root, and is a proper prefix of `at`.
  - `{"unregisteredSymbol": description}`: a symbol of no registry key, under
    that description, a string, or `null` for none.

  Follow every path before making any patch, so that no path runs into what a
  patch put. No two patches share a path.

## Probes

A probe is a pair `[path, expected]`: a path into a decoded value, and what a
reader finds there. A reader decodes the text, walks the value it gets, and
compares what it finds with the probes. It never builds the expected value, and
never compares two values by an equality of its own, which is the subtle part of
the spec.

### Completeness

The probes of a value are complete: there is one for every node of the value, so
a reader may take a missing probe as a missing node. An array index with no
probe is a hole, and an instance field with no probe is an optional field the
value lacks.

The one exception is a path where a patch puts a value. The patch is what states
that part of the value, so there is no probe at its path or under it. A symbol
of no registry key, and a cycle through arrays and records alone, are stated
that way, and have no probe. A cycle through an instance has no text and mods.

A node's probe comes before the probes of what it holds, which run in index
order in an array, in UTF-8 order of key in a record, and in the order of the
table below in an instance. Each path appears once.

### What a probe expects

What a probe expects is a leaf or a shape. Each is JSON, read this way: a number
is an IEEE 754 double, so `1` and `1.0` are equal, and an integer past 2^53 is
written in the shortest form that reads back as its double and must be read as
that double, not as an exact integer; and a string is equal to another with the
same code points, compared without normalization.

#### Leaves

`null`, `true`, `false`, and a finite number other than negative zero stand for
themselves. A string stands for itself when it holds no lone surrogate. Every
other leaf is an object with one key, naming the kind of value:

| Leaf                                        | Value                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `{"utf16": [55296, 97]}`                    | A string holding a lone surrogate, as its UTF-16 code units.                             |
| `{"number": "-0"}`                          | Negative zero, or with `NaN`, `+Infinity` or `-Infinity`, those.                         |
| `{"undefined": null}`                       | `undefined`.                                                                             |
| `{"bigint": "-129"}`                        | A bigint, in decimal.                                                                    |
| `{"symbol": "key"}`                         | The symbol registered under a key.                                                       |
| `{"Bytes": "0102"}`                         | Bytes, in lowercase hexadecimal.                                                         |
| `{"EpochNsec": "1700"}`                     | Likewise `EpochDay`, `DurationNsec` and `DurationDay`: the quantity, in decimal.         |
| `{"Hash": {"tag": "fid1", "hash": "00ff"}}` | A hash: its algorithm tag, and its bytes in hexadecimal.                                 |
| `{"KeyPair": {...}}`                        | A key pair: `algorithm`, and `publicKey` and `privateKey` in hexadecimal.                |
| `{"RegExp": {...}}`                         | A regular expression: `flavor`, `source` and `flags`.                                    |
| `{"Unavailable": {...}}`                    | Unavailable data: `reason`, and `errorKind` and `errorMessage` where the value has them. |

A string inside a leaf is written as a path's string step is, as itself or as
`{"utf16": [...]}`. An `Unavailable` holds an `errorMessage` only where one is
stored, a kind's default message not being one.

#### Shapes

An array, a record, or an instance is probed by its shape, and what it holds is
probed under it:

| Shape                     | Value                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `{"array": 4}`            | An array of that length. An index with no probe is a hole.                         |
| `{"record": ["a", "b"]}`  | A plain object with those keys, in UTF-8 order, each written as a path's step is.  |
| `{"instance": "Link@1"}`  | An instance of the type the format writes under that tag, its fields probed below. |
| `{"unknown": "Future@2"}` | A value of a type no codec claims, preserving that tag. Its one field is `state`.  |

An instance's fields are these, in this order:

| Tag             | Fields                                                                  |
| --------------- | ----------------------------------------------------------------------- |
| `Link@1`        | `payload`, a record.                                                    |
| `Error@1`       | `type`, `name`, `message`, `stack` and `cause` where present, `extras`. |
| `Problematic@1` | `tag`, `state`, and `error`.                                            |

The open-ended part of an instance is always a field holding a record, so its
keys come from a record shape. An `Error`'s `extras` is probed even when it is
empty, which tells it apart from an absent optional field, and its `name` is the
error's name even where the wire writes `null` for a name equal to the type. A
link's payload is opaque to the formats: its fields are whatever the link's
users define, and the payloads in the cases are examples rather than a required
shape.

`Map@1` and `Set@1` have no probes, and none of the cases holds one, their
codecs being stubs pending general `FabricInstance` support.

### An example

The text
`fvj1:{"/Error@1":{"code":7,"message":"boom","name":null,"type":"TypeError"}}`
has these probes:

```json
[
  [[], { "instance": "Error@1" }],
  [["type"], "TypeError"],
  [["name"], "TypeError"],
  [["message"], "boom"],
  [["extras"], { "record": ["code"] }],
  [["extras", "code"], 7]
]
```
