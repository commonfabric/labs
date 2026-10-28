# Paths, mods and probes

The two conformance fixtures beside this file share a notation, which this
document defines. Both write each value as its `fvj1:` text, with mods to
decoding it that state what no text carries. `fvj1-conformance.json` then states
what decoding the text returns as a list of probes, each a path into the value
paired with what a reader finds there. Values are written only as `fvj1:` text.
The one escape is for a string holding a lone surrogate, which a JSON reader may
not keep, where it stands outside a text, as a key in a path or a symbol's
description in a patch: `{"utf16": [...]}` writes it as its UTF-16 code units.
An entry of either fixture may also state what a reader must support to read it
at all, as [Requirements](#requirements) describes.
[`fvj1-conformance.md`](fvj1-conformance.md) and
[`hash-conformance.md`](hash-conformance.md) describe the fixtures themselves,
and `src/conformance-fixtures.ts`, in `packages/data-model`, writes and reads
this notation.

## Paths

A path is a list of steps from the root, `[]` being the root itself. A number
steps into an array at that index. A string steps into a record under that key,
or into an instance under the name of one of its fields, as
[Special forms](#special-forms) lists them. `{"utf16": [...]}` steps under a key
holding a lone surrogate, as its UTF-16 code units, since not every JSON reader
keeps one.

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
  The path runs through the arrays, records and instances of the decoded text,
  by the steps [Paths](#paths) gives, and the text holds a `null` where it ends,
  which the patch replaces. `put` is one of:
  - `{"cycle": path}`: the array, record or instance at that path, which closes
    a cycle. The path is absolute, from the root, and is a proper prefix of
    `at`. A path to an instance and the path from it into its state, such as
    `[..., "payload"]` for a link, name two places, as section 4.19 of
    [`2-hash-byte-format.md`](../../../../docs/specs/space-model-formal-spec/2-hash-byte-format.md)
    has the instance and its state be two entries on a cycle's path. An error's
    `extras` names no such place, being no record of the error's own.
  - `{"unregisteredSymbol": description}`: a symbol of no registry key, under
    that description, a string, or `null` for none.

  Follow every path before making any patch, so that no path runs into what a
  patch put. No two patches share a path. Where an instance holds what a patch
  changes for good, as a link holds its payload, make the instance again with
  the change in it, and put the new instance where the old one was. A copy of
  what it held stands in for the original wherever that held itself, as a link's
  payload may.

## Probes

A probe is a pair `[path, expected]`: a path into a decoded value, and what a
reader finds there. A string `expected` is a fragment, the `fvj1:` text of a
leaf. An object `expected` is a special form, which says what a fragment does
not. A reader decodes the text, walks the value it gets, and checks it against
the probes.

### Fragments

A leaf is a node with no steps under it: `null`, a boolean, a number, a string,
`undefined`, a symbol, a bigint, or a value of a primitive type, such as
`Bytes@1`, a temporal quantity, `Hash@1`, `KeyPair@1`, `RegExp@1` or
`Unavailable@1`. Only a leaf has a fragment, and every leaf has one, unless a
patch states it.

A fragment is the leaf's canonical `fvj1:` text, written on its own, prefix and
all, as sections 10 and 11 of
[`3-json-encoding.md`](../../../../docs/specs/space-model-formal-spec/3-json-encoding.md)
define canonical text: `"fvj1:{\"/BigInt@1\":\"BQ\"}"` for the bigint `5n`.
Being written on its own and canonically, it need not appear in the entry's
`text` as is: a text that is not canonical can write `fvj1:100` as `1.0E2`.
Decode a fragment applying the case's `unclaimed`, if any, but never its
`patches`, whose paths start at the root of the whole value.

There are two ways to check a fragment, and a reader may take either:

1. Decode the fragment, and compare what it decodes to with the node, by
   whatever identity the reader's own model of values gives. Mind `NaN`, which
   may not equal itself, and `-0`, which may equal `0`.
2. Encode the node, canonically and on its own, and compare the text with the
   fragment. This needs no equality of values.

### Special forms

| Form                      | Says                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `{"array": 4}`            | An array, of that length.                                                          |
| `{"record": 2}`           | A plain object, with that many keys.                                               |
| `{"holes": 3}`            | That many holes in an array, from the index the path ends at.                      |
| `{"instance": "Link@1"}`  | An instance of the type the format writes under that tag, its fields probed below. |
| `{"unknown": "Future@2"}` | A value of a type no codec claims, preserving that tag. Its one field is `state`.  |

A run of holes is probed at its first index, and runs are as long as possible:
an array of a million holes is one probe. A hole has no fragment, since
`{"/hole": 1}` alone is malformed.

`unknown` is kept apart from `instance` because a reader can't tell the two from
a tag alone: another implementation may claim a tag this package does not, or
the reverse.

An instance's fields are these, in this order:

| Tag             | Fields                                                                  |
| --------------- | ----------------------------------------------------------------------- |
| `Link@1`        | `payload`, a record.                                                    |
| `Error@1`       | `type`, `name`, `message`, `stack` and `cause` where present, `extras`. |
| `Problematic@1` | `tag`, `state`, and `error`.                                            |

The open-ended part of an instance is always a field holding a record, so its
keys are probed as a record's are. An `Error`'s `extras` is probed even when it
is empty, which tells it apart from an absent optional field, and its `name` is
the error's name even where the wire writes `null` for a name equal to the type.
A link's payload is opaque to the formats: its fields are whatever the link's
users define, and the payloads in the cases are examples rather than a required
shape.

`Map@1` and `Set@1` have no probes, and none of the cases holds one, their
codecs being stubs pending general `FabricInstance` support.

### Completeness

The probes of a value are complete. Every array, record and instance has its
special form, every leaf its fragment, and every run of holes its probe. Each
index of an array has a probe of its own or lies in a run of holes, and an index
with neither is an error in the fixture, not an implied hole. Each record has a
probe for each of its keys.

The one exception is a path where a patch puts a value. The patch is what states
that part of the value, so there is no probe at its path or under it, and the
reader counts the index, key or field it names as present. The arrays, records
and instances on the way to it keep their special forms. A symbol of no registry
key, and a cycle, whether it passes through instances or not, are stated that
way, and have no probe.

A path has one probe. A node's probe comes before the probes of what it holds:
an array's elements and runs of holes in index order, a record's keys in UTF-8
order, and an instance's fields in the order of the table above.

## Requirements

An entry may carry `requires`, naming what a reader must support for the entry
to apply to it. A reader that does not meet every requirement an entry names
skips the entry: the case is not applicable to it, which is neither a pass nor a
divergence. An entry with no `requires` applies to every reader.

`flavors` is a list of regular-expression flavors whose patterns the reader must
construct, as section 3 of
[`3-json-encoding.md`](../../../../docs/specs/space-model-formal-spec/3-json-encoding.md)
describes for `RegExp@1`. It marks a case whose outcome depends on constructing
one, such as a pattern that fails to construct: the format requires no flavor,
and a reader that does not construct one stores its patterns unvalidated, so the
outcome differs. Cases are marked by hand.

The other fields each need a guarantee of at least the figure given, by one of
the measures section 12 of `3-json-encoding.md` defines. A reader whose stated
guarantee by that measure is below the figure skips the entry, whether or not it
would in fact handle the value:

- `arrayLength`: the length of the longest array, counting each hole a run
  stands for.
- `propertyCount`: the member count of the largest record, any object in the
  JSON body counting.
- `stringLength`: the length of the longest string, in code points, a lone
  surrogate counting as one.
- `bytesLength`: the length of the longest byte sequence, in bytes.
- `symbolKeyLength`: the length of the longest registered symbol's key, in code
  points.
- `depth`: the value's depth, counted as section 12 counts it.

These are computed from the entry's text, and each is present only where it is
past the floor section 12 sets for its measure, which every conforming reader
guarantees.

This package meets every requirement either fixture names. It constructs
`es2025` patterns, and its own guarantees, which its README states, are past
every floor.

## Checking with a codec of known behavior

Checking a fragment either way takes a codec, and the codec being tested can't
vouch for itself, since a fault on both sides of a comparison cancels out. A
reader's test codec is therefore validated without the fixtures, in one of two
ways:

- A codec written for the test alone, as simple as checking fragments allows,
  whose correctness can be seen in its code.
- The codec under test, with unit tests that do not use the fixtures and that
  pin, value by value, the texts that matter.

This package takes the second way. Its unit tests of the JSON codec, in
`test/codec-json/`, and of each class's codec pin texts without the fixtures.
`test/fvj1-conformance.test.ts` then checks each fragment by encoding the node,
which needs no equality of values.

## An example

The text
`fvj1:{"/Error@1":{"code":7,"message":"boom","name":null,"type":"TypeError"}}`
has these probes:

```json
[
  [[], { "instance": "Error@1" }],
  [["type"], "fvj1:\"TypeError\""],
  [["name"], "fvj1:\"TypeError\""],
  [["message"], "fvj1:\"boom\""],
  [["extras"], { "record": 1 }],
  [["extras", "code"], "fvj1:7"]
]
```
