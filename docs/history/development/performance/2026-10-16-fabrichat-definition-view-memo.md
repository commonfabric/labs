---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Counts from a thirty-message FabriChat room's cold load, October 2026, of what interning a resolved definition view hashes: minting the view once per definition body and map removes no hashing, because three fifths of the map-carrying views hashed carry a map already hashed by identity; and the finding that the value hash is a single digest over the tree's encoded bytes, so no cached hash of a sub-object can shorten it."
---

# What interning a resolved definition view hashes on a FabriChat room's cold load, October 2026

The render-join record
([`2026-10-16-fabrichat-render-schema-join-memo.md`](2026-10-16-fabrichat-render-schema-join-memo.md))
left the largest remaining schema-intern cost of a thirty-message room's cold
load in the views a `$ref` resolves to. A `#/$defs/<name>` reference resolves
to `{ ...body, $defs }`, the definition's body carrying its document's whole
definition map, and every such view is interned, which hashes the map again:
1,146 misses of 672 contents, 6.6 million characters of schema JSON per load,
under the join's first walks alone. Two remedies were named: have the hasher
reuse the cached hash of a deep-frozen sub-object it reaches, or mint the
view once per definition body and map so documents sharing a map share each
definition's view. This record is what each turned out to be worth.

## The hash does not compose

`ValueHasher` (`packages/data-model/src/value-hash/ValueHasher.ts`) feeds one
SHA-256 context with the type-tagged bytes of the whole value: for a plain
object, the object tag, then for each key in WTF-8 byte order the key's
encoding followed by the child's encoding, then the end tag. A container's
hash is a function of its children's encodings, not of their hashes. The one
Merkle-style step the format has is for strings longer than 64 WTF-8 bytes,
which are fed as their own SHA-256. The identity cache of deep-frozen objects
(`cachedFrozenObjectHashElseUndefined()` in `caching.ts`) is consulted for
the root value alone, and there is nothing it could be consulted for below
the root: a cached hash of a sub-object is not the bytes the digest needs,
and feeding the hash in place of the bytes would change every hash whose
value reaches such a sub-object. Hashes are a stored, replicated format, held
byte-identical by `test/hash-conformance.test.ts`, so that option is closed.

What a hasher could reuse is the sub-object's encoded bytes. A micro-benchmark
over a view carrying a 120-definition map (62 thousand JSON characters, 57
thousand encoded bytes, 7,562 `update()` calls) put hashing the whole view at
5.6 ms, hashing its body alone at 0.03 ms, the body's walk plus one `update()`
of the map's pre-encoded bytes at 0.13 ms, and SHA-256 over the map's bytes
alone at 0.22 ms: the walk over the map is about 25 times the digest over it.
For a 20 thousand character map the figures were 0.98 ms and 0.39 ms. The
machine was at a one-minute load above 100 throughout, so the ratios are what
the numbers are for.

## The memo, and what it changed

`definitionBodyWithDefs()` in `packages/runner/src/cfc/schema-refs.ts` mints
the view of a deep-frozen body under a deep-frozen map once per body per
map, deep-frozen, whichever document the reference was resolved from, so that
every document carrying one map resolves a definition to one object and
interning it hashes the map once.
`packages/runner/test/cfc/schema-refs-definition-views.test.ts` pins it: two
deep-frozen documents carrying one map resolve a definition to the same
deep-frozen view carrying that map; two maps of equal content get a view
each, carrying its own map; a mutable map gets a mutable view per
resolution; and resolving from the second document hashes no container.

The load was the one the render-join record describes, over a copy of its
store, with the same counter in `internSchemaReturningSchemaAndHash()`
reading each miss's caller, its deep-frozen state, whether its content was
already interned, and its JSON length, and a counter on
`definitionBodyWithDefs()` recording each mint by whether its body and map
were deep-frozen and whether the pair had been minted before. The before arm
is `main` with the render-join change; the after arm adds the memo. Two
loads per arm, the room's second or later; the join's row is exact between
loads, the rows under `collectCfcSchemaEntries` and `_schemaHasIfcUncached`
move with render timing.

| per load | before, load 1 | before, load 2 | after, load 1 | after, load 2 |
| --- | ---: | ---: | ---: | ---: |
| `internSchema()` identity misses | 28,643 | 28,498 | 28,440 | 28,436 |
| JSON characters hashed by misses | 38.35 M | 35.87 M | 35.76 M | 35.76 M |
| view mints | 2,102 | 2,018 | 2,018 | 2,018 |
| of which a deep-frozen pair minted before | 546 | 508 | 510 | 510 |
| of which a body or map not deep-frozen | 694 | 694 | 694 | 694 |
| distinct maps attached | 353 | 351 | 349 | 349 |
| join's first walks: misses / contents / characters | 1,146 / 672 / 6.60 M | 1,146 / 672 / 6.60 M | 1,137 / 670 / 6.57 M | 1,137 / 670 / 6.57 M |

The memo serves about 510 mints per load from its cache and removes nine
misses. The repeated pairs were never the views being re-interned: they are
resolved under roots that are not deep-frozen, which the resolver's pair memo
cannot key on, and so never reach the interning.

## Where the map hashing is

A third load, with the miss counter also recording whether the view's `$defs`
had been hashed before, by identity and by content:

| intern misses carrying a `$defs` map | misses | map characters hashed |
| --- | ---: | ---: |
| map identity hashed before | 4,291 | 20.88 M |
| map identity new, content hashed before | 2,448 | 6.27 M |
| map new | 297 | 1.03 M |

Under the join, 1,025 of the 1,137 misses carry a map identity already
hashed; the views are distinct definitions of one map, not one definition
reached from many roots. The distinct maps a load attaches add up to 1.24
million characters, and the load walks them 28 million characters' worth. A
hasher that kept the encoded bytes of a deep-frozen sub-object it had fed,
and fed them again with one `update()` on meeting the same object, would
walk each map once and digest it per view; by the micro-benchmark that is
most of the view's cost. The hash stays byte-identical. A cycle reference
inside the sub-object that reaches an ancestor outside it encodes a distance
that depends on where the sub-object sits, so such a sub-object is not
cacheable, and `getContainersHashed()` would count fewer containers, which
the tests that read it as evidence of a whole-value hash would need to
account for.
