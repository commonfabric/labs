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
handle, by seven measures, each guarantee at least a floor the format sets
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
- **Depth:** 2^9 (512), the format's floor. The bound is the host's stack, which
  the codec, the hasher and `valueEqual()` each use up recursing through a
  value. On Deno's default stack the first of them to fail does so past about
  3,000 levels. The figure sits well below that because a caller may already
  have used part of the stack by the time it hands this package a value.
- **Bigints:** 2^26 (67,108,864) bytes (2^29 bits). The bound is the host's: V8
  holds no bigint of 2^30 bits. A bigint of 2^26 bytes encodes, decodes, hashes
  and compares in about a second each.

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

## Module layout

Paths here are under `src/` unless written in full. Where each part of the model
is declared:

- `api.ts` declares the `FabricValue` union and the types beside it, together
  with the pattern-visible declarations of the special-object classes
  (`FabricInstance`, `FabricPrimitive`), each as an `interface` plus a
  `declare const`, and their union, the type `FabricSpecialObject`.
  `base/api/index.ts` re-exports it as part of the `commonfabric` surface.
- `interface.ts` declares the classes themselves, the layer types, and the
  conversion-layer types, and re-exports every type `api.ts` declares.
- The in-process lifecycle symbols (`DEEP_FREEZE`, `IS_DEEP_FROZEN`) live in
  `fabric-bases/`, on `BaseFabricInstance` alongside the abstract base that
  carries them.
- The codec vocabulary (the `CODEC` symbol, `FabricCodec`, `LiveEnvironment`)
  lives in `codec-interface/`, and the machinery that acts on it in
  `codec-common/` -- including `BaseEncodeAct` and `BaseDecodeAct`, which are
  classes the walk carries rather than contracts a caller implements.
- The conversion functions are in `convertible-js.ts`.
- `codecs.ts` pairs each wire format, JSON and realm-crossing, with the set of
  fabric classes this package defines. For each it holds the boundary functions
  (`jsonFromFabricValue()`, `realmFromFabricValue()`, and their siblings), built
  on one engine created at module load, and a factory
  (`newDefaultJsonCodecEngine()`, `newDefaultRealmCodecEngine()`) for a caller
  that needs an engine of its own configuration. The formats themselves live one
  layer down, in `codec-json/` and `codec-realm/`.
- Each `FabricInstance` and `FabricPrimitive` class lives in its own file: the
  `FabricInstance` subclasses `FabricError`, `FabricLink`, `FabricMap`,
  `FabricSet` and `FabricNativeWrapper` under `fabric-instances/`, with
  `UnknownValue` and `ProblematicValue` under `codec-common/`; the
  `FabricPrimitive` subclasses (`FabricEpochNsec`, `FabricEpochDay`,
  `FabricDurationNsec`, `FabricDurationDay`, `FabricHash`, `FabricBytes`,
  `FabricKeyPair`, `FabricRegExp`, `FabricUnavailable`) under
  `fabric-primitives/`.

**Where a thing is declared is not where it is imported from**, and the modules
named here divide on that point. The whole `FabricValue` vocabulary comes from
`@commonfabric/data-model`, the package's main entry point: the declarations in
`api.ts` and `interface.ts`, the conversions in `convertible-js.ts`, the clone
helpers in `value-clone.ts`, and the operations a value of any class is subject
to -- `deep-freeze.ts`, the hashing in `value-hash/`, the debug renderers in
`value-debug/`, the comparisons in `comparison/`, and the tag vocabulary in
`types/`. Of those, one is also an exported subpath: `api.ts` as
`@commonfabric/data-model/api`, which is how `@commonfabric/api` reaches it.
`codec-interface/` is internal in the same way, reached through
`@commonfabric/data-model/codec-common`, which re-exports it. `codec-common/`,
`fabric-bases/` and `fabric-instances/` are exported subpaths in their own right
and are imported directly under those names; the main entry point does _not_
re-export the codec vocabulary, so `LiveEnvironment` and its siblings come from
`@commonfabric/data-model/codec-common`. Cite a module to say where something is
defined; consult the package's `exports` map to know where to import it from.

The declarations in `api.ts` must agree with the implementations they mirror,
and the agreement is asserted at compile time: `api-agreement.ts`, a module
nothing imports, asserts that `FabricInstance` and `FabricPrimitive`, and their
constructors, are each the same type as their declarations, and each concrete
class that `api.ts` declares asserts beside its own definition that it satisfies
its declaration. `runtime/runner/` wires concrete implementations into builder
exports.

The files and directories, in more detail:

- `index.ts`: Public surface, and the package's main entry point: re-exports the
  conversion functions (from `convertible-js.ts`), the type declarations (from
  `interface.ts`), the clone helpers (from `value-clone.ts`), the deep freeze
  (from `deep-freeze.ts`), the hash (from `value-hash/`), the debug renderers
  (from `value-debug/`), the tag vocabulary, narrowings, and validators (from
  `types/`), and the comparisons `valueEqual()`, `valueEqualByWalk()`, and
  `fabricAwareEqual()` (from `comparison/`).
- `api.ts`: The pattern-visible declarations: the `FabricValue` union and the
  types beside it, `FabricInstance`, `FabricPrimitive`, and the concrete classes
  patterns can reach, each as an `interface` plus a `declare const`, and the
  debug-rendering option types. `FabricMap` and `FabricSet` are not declared
  here. It has no imports, so that the type module the sandbox is served can
  inline it; it is also the `./api` export subpath, which `@commonfabric/api`
  re-exports.
- `interface.ts`: The abstract classes `FabricInstance` and `FabricPrimitive` as
  classes, the layer types, and the conversion-layer types
  (`FabricConvertibleJsObject`, `FabricConvertibleJsValue`); re-exports every
  type `api.ts` declares. Its only runtime imports are two leaves that import
  nothing back, `api.ts` for the brand symbols and the module holding the
  classes' common root, so that any module can import it without a cycle.
- `api-agreement.ts`: Asserts that `FabricInstance` and `FabricPrimitive`, and
  their constructors, are each the same type as their `api.ts` declarations.
  Nothing imports it; it exists to be type-checked, and everything in it erases
  at compile time.
- `convertible-js.ts`: Conversion: `fabricFromConvertibleJsValue`,
  `shallowFabricFromConvertibleJsValue`, `convertibleJsFromFabricValue`,
  `isValidFabricConvertibleJsValue`.
- `fabric-bases/`: The abstract bases a concrete `FabricValue` extends, one per
  branch of the type hierarchy: `BaseFabricInstance.ts`,
  `BaseFabricPrimitive.ts`, and the root both extend,
  `BaseFabricSpecialObject.ts` (plus an `index.ts` barrel, and `blessing.ts`,
  which hands the package's own primitive classes the token they construct
  with). These are the implementer's half of the hierarchy; `interface.ts` is
  the client's, and reaching it does not reach these.
- `fabric-instances/`: Concrete `FabricInstance` subclasses, each in its own
  file: `FabricNativeWrapper.ts`, `FabricError.ts`, `FabricLink.ts`,
  `FabricMap.ts`, `FabricSet.ts`. `impl.ts` holds the set of instance classes
  and what derives from it, `codecClasses()` among them, and `index.ts` is the
  barrel. `UnknownValue` and `ProblematicValue` are `FabricInstance`s too, and
  members of that set, but live in `codec-common/`, existing only as products of
  a decode fault.
- `fabric-primitives/`: Concrete `FabricPrimitive` subclasses, each in its own
  file: `FabricBytes.ts`, `FabricHash.ts`, `FabricEpochNsec.ts`,
  `FabricEpochDay.ts`, `FabricDurationNsec.ts`, `FabricDurationDay.ts`,
  `FabricKeyPair.ts`, `FabricRegExp.ts`, `FabricUnavailable.ts`. `interface.ts`
  holds the tag vocabularies that range over those classes and imports nothing,
  the classes being its importers; `impl.ts` holds the set of classes and what
  derives from it, `codecClasses()` and the schema `type` names among them; and
  `index.ts` is the barrel.
- `for-testing-only.ts`: What the package offers to tests alone, under an
  export-map entry of its own and in no barrel: makers of examples of every
  concrete `FabricPrimitive` and `FabricInstance` class, each table typed so
  that a class with no entry stops the build, and one shared instance per
  primitive maker. The makers keep a stated contract: a new object per call,
  equal objects from one maker, and unequal objects from two makers of one
  class, of which every class has at least two. A test that ranges over the
  classes takes its values from here and holds no table of its own. It also
  offers internal steps of the package that a test of the public surface cannot
  reach dependably, each under a name ending `ForTestingOnly`:
  `float64BytesOfForTestingOnly()` is `value-hash/`'s number-to-bytes step,
  whose `NaN` arm a test of `hashOf()` can exercise only where the engine keeps
  a `NaN`'s payload, `getFrozenObjectHashCacheHitsForTestingOnly()` counts the
  hashes `value-hash/`'s deep-frozen-object cache serves, which the public
  surface cannot tell from hashes computed afresh, and
  `getContainersHashedForTestingOnly()` counts the arrays and plain objects
  `value-hash/` feeds a hasher, which is how a test tells a whole-value hash
  from a small one. Loading it also loads `value-debug/`, which is how a unit
  test that imports a module by its path gets the debug renderers installed.
- `value-debug-internal.ts`: The debug renderers as the package's own modules
  reach them, and what the import-map key `@/value-debug` names: one forwarder
  per renderer, each calling the renderer of the same name which `value-debug/`
  installs as it loads. It imports nothing at run time, so any module may import
  it without a circular load-time dependency, the root class in `fabric-bases/`
  included. A forwarder throws until `value-debug/` has loaded. Every export-map
  entry which loads a module that renders loads `value-debug/` too, by way of
  the `fabric-bases/` barrel, so a program which imports the package has the
  renderers; `index.ts` re-exports them from `value-debug/` itself.
