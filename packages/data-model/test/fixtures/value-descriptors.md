# Value descriptors

The conformance fixtures beside this file, `fvj1-conformance.json` and
`hash-conformance.json`, write each value as a descriptor: JSON that says
everything about a value a fixture checks, and nothing about how any format
carries it. An implementation in another language reads a fixture by building
the value each descriptor describes.
[`fvj1-conformance.md`](fvj1-conformance.md) and
[`hash-conformance.md`](hash-conformance.md) describe the fixtures themselves.

`src/conformance-fixtures.ts`, in `packages/data-model`, writes and reads them.

## Equality

Two descriptors describe the same value exactly when they are equal as JSON read
this way: a number is an IEEE 754 double, so `1` and `1.0` are equal, and an
integer past 2^53 is written in the shortest form that reads back as its double
and must be read as that double, not as an exact integer; a string is equal to
another with the same code points, compared without normalization; an array is
equal to another of equal elements in the same order; and an object is equal to
another with the same keys holding equal values.

## Kinds

`null`, `true`, `false`, and a finite number other than negative zero describe
themselves. A string describes itself when it holds no lone surrogate. Every
other descriptor is an object with one key, naming the kind of value:

| Descriptor                                       | Value                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `{"utf16": [55296, 97]}`                         | A string holding a lone surrogate, as its UTF-16 code units.                                   |
| `{"number": "-0"}`                               | Negative zero, or with `NaN`, `+Infinity` or `-Infinity`, those.                               |
| `{"undefined": null}`                            | `undefined`.                                                                                   |
| `{"bigint": "-129"}`                             | A bigint, in decimal.                                                                          |
| `{"symbol": "key"}`                              | The symbol registered under a key, which is a string descriptor.                               |
| `{"unregisteredSymbol": "local"}`                | A symbol with no registry key, under its description, or `null` for none.                      |
| `{"array": [1, {"hole": 3}, 2]}`                 | An array. A `hole` entry stands for that many absent elements, in runs as long as possible.    |
| `{"record": [["a", 1], ["b", 2]]}`               | A plain object, as key and value pairs in UTF-8 order of key. A key is a string descriptor.    |
| `{"cycle": 1}`                                   | The array or record that many levels up from where this stands, `1` being the one holding it.  |
| `{"Bytes": "0102"}`                              | Bytes, in lowercase hexadecimal.                                                               |
| `{"EpochNsec": "1700"}`                          | Likewise `EpochDay`, `DurationNsec` and `DurationDay`: the quantity, in decimal.               |
| `{"Hash": {"tag": "fid1", "hash": "00ff"}}`      | A hash: its algorithm tag, and its bytes in hexadecimal.                                       |
| `{"KeyPair": {...}}`                             | A key pair: `algorithm`, and `publicKey` and `privateKey` in hexadecimal.                      |
| `{"RegExp": {...}}`                              | A regular expression: `flavor`, `source` and `flags`.                                          |
| `{"Unavailable": {...}}`                         | Unavailable data: `reason`, and `errorKind` and `errorMessage` where the value has them.       |
| `{"Error": {...}}`                               | An error: `type`, `name`, `message`, `stack` and `cause` where present, and `extras` as pairs. |
| `{"Link": {"record": [...]}}`                    | A link, by the record of its payload.                                                          |
| `{"Map": [[key, value], ...]}`                   | A map, its entries in insertion order.                                                         |
| `{"Set": [value, ...]}`                          | A set, its values in insertion order.                                                          |
| `{"Unknown": {"tag": "Future@2", "state": ...}}` | A value of a type no codec claims: the tag it arrived under, and its decoded state.            |
| `{"Problematic": {...}}`                         | A preserved failure: `tag`, `state`, and `error`.                                              |

Strings inside the class descriptors are string descriptors. `name` in an
`Error` is the error's name even where a format writes something else for a name
equal to the type, and an `Unavailable` holds an `errorMessage` only where one
is stored, a kind's default message not being one.

A link's payload is opaque to the formats: its fields are whatever the link's
users define, and the payloads in the cases are examples rather than a required
shape.

## Cycles

A value whose arrays and records hold one another in a cycle is written with a
`cycle` descriptor where the cycle closes, counting up through the arrays and
records enclosing that point. A record holding itself under `self` is
`{"record": [["self", {"cycle": 1}]]}`. A container reached a second time other
than by a cycle, which is sharing, is written out in full each time, so the
notation does not record sharing.

The count runs through arrays and records only, and stops at an instance: the
value an instance holds is described as though it stood alone. So a cycle that
closes at an instance, or one that passes through an instance on its way to the
container it closes at, has no descriptor, and none of the cases holds one.
