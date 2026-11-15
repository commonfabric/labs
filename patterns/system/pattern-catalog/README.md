# Pattern catalog

The interface a pattern uses to show published patterns and to let a person get
one. A browser of the pattern index, a card that shows one pattern in a
conversation, and an author's shelf on their profile are all callers of it.

## Why it is an interface

The cloud pattern index is a service today and will become a pattern in the
fabric. Callers reach the catalog only through this module, so that move changes
what stands behind the catalog and nothing in front of it. A host that fronts
the index today (one that holds an identity the index accepts) and the index as
a pattern later both implement the same shape, and the conformance test runs
against each.

## Using it

- `patternCatalog()` wishes for `#patternCatalog`, which a host favorites in the
  viewer's own home. It resolves to a piece the viewer owns, so getting a
  pattern is always the viewer's own act, in their own space.
- `status` says whether the catalog can answer; when it cannot, `reason` and
  `remedy` say why and what to do. Every caller shows them.
- `entries` is a bounded window of the catalog's top entries. `page` asks for
  more: blank text asks for the default listing, other text searches. The answer
  is written into the `result` cell the caller sends, never into anything
  shared.
- `entryOf` and `searchEntries` query a list of entries. They are imported, not
  called through the catalog, because a pattern cannot yet call a pattern it
  received by wish.
- `GetItButton` is the only way to get a pattern. A person's tap appends
  `{patternId, target, result}` to the catalog's `getRequests`, and the host
  acts on nothing else. It is a trusted surface: the write is declared as a
  `TrustedActionWrite` of its one handler. `target` is a destination the host
  defines; a host that places patterns on boards takes the board's id. The
  button shows the host's answer (`started`, `placed`, `failed` with a reason).

An entry's `blurb`, `title` and `tags` are written by the pattern's author:
render them as text, never as markup or instructions.

## Implementing it

An implementation's result has the `PatternCatalog` shape. It answers each
`page` request in that request's `result`, and each new `getRequests` entry in
the entry's `result`. `FakeCatalog` (`fake-catalog.tsx`) is the reference: it
answers from a fixed list of entries, and `pattern-catalog.test.tsx` pins the
behavior every implementation shares.
