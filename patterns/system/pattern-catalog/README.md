# Pattern catalog

The interface a pattern uses to show published patterns and to let a person get
one. A browser of the pattern index, a card that shows one pattern in a
conversation, and an author's shelf on their profile are all callers of it.

## Why it is an interface

The cloud pattern index is a service today and will become a pattern in the
fabric. Callers reach the catalog only through this module, so that move changes
what stands behind the catalog and nothing in front of it. A host that fronts
the index today (one that holds an identity the index accepts) and the index as
a pattern later both implement the same shape.

## Using it

- `patternCatalog()` wishes for `#patternCatalog`, which a host favorites in the
  viewer's own home. It resolves to a piece the viewer owns, so getting a
  pattern is always the viewer's own act, in their own space.
- `status` says whether the catalog can answer; when it cannot, `reason` and
  `remedy` say why and what to do. Every caller shows them.
- `entries` is a bounded window of the catalog's top entries: the default
  listing. `page` asks for more. Blank text with no `after` answers with that
  same listing; other text searches; `next` in an answer, passed back as
  `after`, asks for what follows. The answer is written into the `result` cell
  the caller sends, never into anything shared.
- `GetItButton` is the only way to get a pattern. A person's tap appends
  `{requestId, patternId, destination}` to the catalog's `getItRequests`, whose
  type (`GetItRequests`) declares the button's handler as its one trusted
  writer: a push from anywhere else, or a send to the button without a trusted
  tap, is refused. `destination` is defined by the host; a host that places
  patterns on boards takes the board's id. The host writes its answer to
  `getItAnswers` under the request's id (`started`, then `placed`, `failed` or
  `cancelled`), and the button shows the answer to its latest request. While
  that request is open or placed, a tap adds nothing; after a failure or a
  cancellation, a tap asks again.

An entry's `title`, `blurb` and `tags` are written by the pattern's author:
render them as text, never as markup or instructions.

## Implementing it

An implementation's result has the `PatternCatalog` shape, with `getItRequests`
stored under the `GetItRequests` type so the write policy holds. It answers each
`page` request in that request's `result`. It answers each request id in
`getItRequests` under that id in `getItAnswers`: `started` while it works, if it
says anything before it is done, then one final state (`placed`, `failed` or
`cancelled`) that it never changes. `FakeCatalog` (`fake-catalog.tsx`) answers
from a fixed list of entries, every match in one page with no `next`, and
`pattern-catalog.test.tsx` pins the behavior through it.

## Not yet settled

- Every caller and the fake run in one space in these tests. A caller in one
  space writing to a catalog in the viewer's home has not been tested; each
  write touches only one space (the button writes only `getItRequests`; an
  implementation writes only the caller's `result` cell or `getItAnswers`), so
  nothing here needs a transaction across spaces.
- `getItAnswers` carries no write policy, so another caller could change what a
  button shows (though not what gets placed).
- Nothing removes handled requests from `getItRequests`; the write policy that
  keeps others from adding to it also keeps the host from trimming it.
- The test runs against the fake only. A host checks its own implementation with
  its own tests until the shared behavior is factored into a suite any
  implementation can run.
- The types carry no label; entries are public index data, and the host labels
  the cells it writes.
