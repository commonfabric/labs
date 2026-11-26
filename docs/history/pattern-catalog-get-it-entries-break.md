---
status: historical
created: 2026-11-20
archived: 2026-11-20
reason: "Record of the deliberate contract break taken when the pattern catalog's requests to get a pattern moved their write policy from the list onto each request, labeled with who tapped, which strands every catalog storing the old list."
---

# Pattern catalog: each request to get a pattern carries its own policy

The catalog contract (`patterns/system/pattern-catalog/pattern-catalog.tsx`)
typed `getItRequests` as one `TrustedActionWrite` over the whole list, naming
`requestGetIt` as its writer. A request was stored inside the list, with no
labels of its own. A host that acts on a request installs code under the
person's name, and it could not tell from the request itself who asked for it
or which handler wrote it.

Each request is now a `GetItEntry`: `AuthoredByCurrentUser` over a
`TrustedActionWrite` naming `requestGetIt` under the button's gesture. A new
request is stored as a document of its own carrying its author and its
writer, so a host can check both on the request it acts on, as hosts of other
trusted outboxes do.

## What the gate reports

Against each of `fake-catalog.tsx`'s four recorded baselines, the
pattern-update proof reports `argument.getItRequests: ifc changed` and
`result.getItRequests: ifc changed`: the stored list's policy named
`requestGetIt` on the list, and the new one names it on each element.

## Why this could not be done compatibly

The per-request policy is the point: it is what puts the author and the writer
on the request a host reads. A policy a later schema changes is refused whole
(`docs/specs/ts-transformer/cfc_authoring_contract.md`, `WritePolicyAnyOf`,
rule 4), and keeping the old list beside a new one would leave two lists every
caller and host must read.

## What is left behind

A catalog created before this change holds a list the new handler cannot
write, and never adopts the new source. Nothing removes a request from the
list, and each `GetItButton` reads the latest request for its pattern and
destination, with its answer, every time it renders. A host that replaces
such a catalog with a fresh one therefore loses that history: a button that
showed "Got it" or a failure shows nothing and can be tapped again, and a
request still open on the old catalog is never answered there. A host acts on
a request within minutes of the tap, so what is lost is what buttons show of
past taps, not work still to be done.
