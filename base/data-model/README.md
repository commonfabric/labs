# `@commonfabric/data-model`

The fabric value model: the `FabricValue` types, and the codecs, hashing,
comparison, cloning, and debug rendering that operate on them. The normative
description is the formal spec, starting at
[`1-fabric-values.md`](../../docs/specs/space-model-formal-spec/1-fabric-values.md).

## Every exported class is frozen

Each class this package exports freezes itself and its prototype as it is
defined, in a `static` block placed first among its static members:

```ts
static {
  Object.freeze(this);
  Object.freeze(this.prototype);
}
```

This is deliberate. These classes define what a fabric value is and how one is
encoded, hashed, compared, and cloned, and every caller relies on that behavior
being exactly what this package says it is. The classes also reach code this
package does not control: patterns are handed several of them directly. A class
or prototype that can be changed after the fact is behavior that can be changed
out from under every one of those callers. Freezing rules out:

- assigning to a static, or adding one;
- replacing, adding, or deleting a method on a prototype, whether by hand or by
  a mocking library's stub or spy;
- assigning over an inherited method on an instance, since a frozen prototype's
  methods are read-only.

Subclassing is unaffected. A subclass has a class object and a prototype of its
own, and overrides by declaring its members. A subclass that installs a member
programmatically defines it with `Object.defineProperty()` rather than assigning
it: an assignment looks for the member up the prototype chain, finds the frozen
one, and is refused.

Two things follow for a class written here:

- The block comes first among the static members. Private static fields and
  later `static` blocks still work after it; a public static field does not,
  since nothing can be added to a frozen class.
- `test/frozen-classes.test.ts` walks `src/` and fails for any exported class
  that is not frozen, so a new class cannot leave the block out unnoticed.

## Size guarantees

The format has an implementation state how large a value it guarantees to
handle, by six measures, each guarantee at least a floor the format sets
([`3-json-encoding.md`](../../docs/specs/space-model-formal-spec/3-json-encoding.md)
Section 12). This package encodes, decodes, hashes and compares any value within
the figures below. Past one, it may refuse a value or may handle it. Most of the
figures are set by the host rather than by a check in this package's code, and
each says where its bound comes from.

- **Arrays:** 2^26 (67,108,864) elements. An array of that length is within it
  even when every element is a hole: `fvj1:[{"/hole":67108864}]` decodes, and
  the array it stands for encodes, hashes and compares, in about a second each.
  The bound is this package's own: encoding, hashing and comparing walk every
  index, holes included, so a very sparse array past this figure is slow. The
  JSON decoder accepts a longer array, up to 2^32 - 1 elements, the most a
  JavaScript array can hold, but past 2^26 this package promises nothing.
- **Records:** no figure. A record is built as a JavaScript object, so its size
  is bounded only by memory and by how many properties the JavaScript engine
  lets one object hold, which is far above the floor: a record of 2^22 members
  decodes and re-encodes.
- **Strings:** 2^26 (67,108,864) code points. The bound is the host's: V8 holds
  a string of at most 2^29 - 24 UTF-16 code units, the `fvj1:` text is itself
  such a string, and an escaped code unit takes six characters of it.
- **Byte sequences:** 2^27 (134,217,728) bytes. The bound is the host's: V8 runs
  out of memory in `JSON.stringify()` writing the base64url state of a 2^28-byte
  buffer.
- **Registered symbol keys:** 2^26 code points, as for any other string.
  `Symbol.for()` and this package's codec set no smaller bound.
- **Depth:** 2^11 (2,048). The bound is the host's stack, which the codec, the
  hasher and `valueEqual()` each use up recursing through a value. On Deno's
  default stack the first of them to fail does so past about 3,000 levels.

## Conformance fixtures

Two fixtures record what this package does, for an implementation in another
language to test itself against:

- `test/fixtures/fvj1-conformance.json`, what the JSON codec writes and reads in
  the `fvj1:` format, described in `test/fixtures/fvj1-conformance.md`.
- `test/fixtures/hash-conformance.json`, the bytes `hashOf()` feeds SHA-256 and
  the digest it returns, described in `test/fixtures/hash-conformance.md`.

Both write each value as its `fvj1:` text, with the mods to decoding it that
state what no text carries. The first states what decoding the text returns by
probes, paths into the value paired with what is there, in the vocabulary
`test/fixtures/value-probes.md` defines, and then what re-encoding it writes.
Each is generated from its cases, in `src/fvj1-conformance.ts` and
`src/hash-conformance.ts`, by `deno task regenerate-fvj1-conformance` and
`deno task regenerate-hash-conformance`, and a test fails whenever a fixture and
the code disagree.
