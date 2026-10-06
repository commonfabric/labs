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

## Conformance fixtures

Two fixtures record what this package does, for an implementation in another
language to test itself against:

- `test/fixtures/fvj1-conformance.json`, what the JSON codec writes and reads in
  the `fvj1:` format, described in `test/fixtures/fvj1-conformance.md`.
- `test/fixtures/hash-conformance.json`, the bytes `hashOf()` feeds SHA-256 and
  the digest it returns, described in `test/fixtures/hash-conformance.md`.

Both write their values in the notation `test/fixtures/value-descriptors.md`
defines. Each is generated from its cases, in `src/fvj1-conformance.ts` and
`src/hash-conformance.ts`, by `deno task regenerate-fvj1-conformance` and
`deno task regenerate-hash-conformance`, and a test fails whenever a fixture and
the code disagree.
