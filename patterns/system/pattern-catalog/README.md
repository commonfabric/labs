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
  `{requestId, patternId, destination, requestedAt, host}` to the catalog's
  `getItRequests` as a document of its own. Each request's type (`GetItEntry`)
  declares the button's handler as its one trusted writer and labels the request
  `authored-by` the person who tapped: a push from anywhere else, or a send to
  the button without a trusted tap, is refused. Both are stored on the request
  itself, so a host can check them on each request it acts on. `destination` is
  defined by the host; a host that places patterns on boards takes the board's
  id. The host writes its answer to `getItAnswers` under the request's id
  (`started`, then `placed`, `failed` or `cancelled`), and the button shows the
  answer to its latest request. While that request is open or placed, a tap adds
  nothing; after a failure or a cancellation, a tap asks again. `host` is copied
  from the catalog's own `host`; while the catalog names none, nothing acts on
  requests, so the button is disabled and says so.
- The button is a `cf-pattern-install`, which says in its own words what a tap
  does: "Install “title” onto loom". The title is the catalog's own, from the
  entry in `entries` with the button's `patternId`; when the window does not
  hold that entry or its title is blank, it shows the pattern's id instead, as
  the id's first and last eight characters when it is longer than seventeen.
  Each name is flattened to one line, its quotation marks turned into
  apostrophes, and cut short past sixty characters. The place is named by
  `destinationName`, which the caller passes as the person knows it (such as the
  loom's name); without one, the button names no place. The caller gives no text
  for the button. Beside it, the button shows the answer to its latest request
  ("Getting it…", "Got it", why a request failed) or why it cannot be tapped.

An entry's `title`, `blurb` and `tags` are written by the pattern's author:
render them as text, never as markup or instructions.

An entry may also say where it ranks (`bucket`), who wrote it as a stable
pseudonym (`author`), and how many people have used it (`counts`). The buckets
read as: `featured`, picked by a curator; `main`, used by its author and ranked
by everyone else's use; `unvetted`, not yet shown working by anyone. When an
entry has a `bucket`, show that rather than `quality`, which hosts without
buckets still send. An `unlisted` entry is one only its author is shown: others
cannot find it until it is listed, so a caller shows its state to the author and
never shows it to anyone else.

An entry whose author chose to be named (`cf pattern publish --as`) also carries
`authorProfile`, a link to that Common Fabric profile; one shared anonymously
carries only the pseudonym and its `authorTier` (0 to 9: how much others use the
author's other shared patterns), shown as "credibility 4 of 9" beside the
pseudonym and never beside a profile. A remix carries `remixOf`, the originals
it was made from, nearest first; a step the viewer may not see is
`{unavailable: true}` and ends the chain. `CatalogByline` shows both the way
every caller should: the profile's badge, which reads the name and picture from
the profile itself (so a host never carries a name, and a renamed profile shows
at once), or else the pseudonym; then "Remix of “Habit tracker”, a remix of …",
stopping at the first step the viewer may not see. A step with no title reads
"an untitled pattern", never its id, and the step that ends the chain reads "a
pattern that's no longer available". A caller that cannot mount `CatalogByline`
(a native client) follows these same rules.

## Implementing it

An implementation's result has the `PatternCatalog` shape, with `getItRequests`
stored under the `GetItRequests` type so each request's write policy and author
label hold, and `host` set to an opaque id for the host instance that acts on
get requests. Each instance mints its own id and never takes one from a copy of
another instance's state. It answers each `page` request in that request's
`result`. It sets `authorProfile` only from the profile the index says the
author published under (`author.published.profile`), as a `link@1` link to that
profile's piece; a reference with no piece gets no `authorProfile`, so the entry
shows the pseudonym. It sets `remixOf` only from the chain the index returns to
this viewer (`remixChain`, each step's `name` as its `title`; never
`remixedFrom` alone); a step it cannot read ends the chain as
`{unavailable: true}`. It acts only on a request that names its own `host`, so a
cloned host instance never acts on another's requests, and only within a window
it chooses by `requestedAt`. It may also refuse a request whose stored labels do
not name the person it acts for as the author, or the button's handler as the
writer. It answers each request id in `getItRequests` under that id in
`getItAnswers`: `started` while it works, if it says anything before it is done,
then one final state (`placed`, `failed` or `cancelled`) that it never changes.
`FakeCatalog` (`fake-catalog.tsx`) answers from a fixed list of entries, as host
`fake-host` unless told otherwise, every match in one page with no `next`, and
`pattern-catalog.test.tsx` pins the behavior through it.

## Not yet settled

- "Remix of" is text. Linking a step to its original waits for a way to open a
  pattern by id from the catalog.
- A brand's pattern (`author.brand` in the index) shows only its pseudonym.

- Every caller and the fake run in one space in these tests. A caller in one
  space writing to a catalog in the viewer's home has not been tested; each
  write touches only one space (the button writes only `getItRequests`; an
  implementation writes only the caller's `result` cell or `getItAnswers`), so
  nothing here needs a transaction across spaces.
- `getItAnswers` carries no write policy, so another caller could change what a
  button shows (though not what gets placed).
- Nothing removes handled requests from `getItRequests`. The write policy sits
  on each request, not on the list, yet the runtime still refuses a write to the
  list from any other handler, one that clears it included: what keeps others
  from adding a request also keeps the host from trimming the list.
- The test runs against the fake only. A host checks its own implementation with
  its own tests until the shared behavior is factored into a suite any
  implementation can run.
- The types carry no label; listed entries are public index data, while an
  `unlisted` entry is shown only to its author, and the host labels the cells it
  writes accordingly.

## Not yet settled: hardening the tap

`cf-pattern-install` and the button's surface markers carry a trusted tap the
way other trusted components do today. What a person is shown is held only as
far as the following allow, and each is left to mechanism the runtime does not
have yet:

- The `data-ui-pattern`, `data-ui-event-integrity` and `data-ui-action` markers
  are strings any pattern can write on its own elements. Each request's write
  policy names the button's handler, so another pattern's tap cannot add a
  request, but nothing proves that the markers on a tap came from this pattern's
  own view.
- The title comes from the catalog the caller hands the button. A caller can
  pass a forged catalog whose entry gives the pattern another title, and the
  viewer's `#patternCatalog` favorite can be repointed at another piece. The
  title the button shows is only as honest as the catalog it was given.
- `destinationName` is the caller's word for where `destination` is. Nothing
  ties the two together yet.
- A pattern rendering above the button could cover it, or draw something else
  over its words, so that a person taps one thing while reading another.
- A button for a pattern found through `page` rather than in the `entries`
  window shows the pattern's id, not its title: the button reads titles only
  from `entries`, the one listing the catalog holds itself.
