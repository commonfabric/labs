# Loom default pattern

`main.tsx` is a space default pattern with linked panel occurrence cells.
`schemas.tsx` defines its public contract and re-exports the participant
roster's types from `participants.tsx`, which also holds the roster's one
writer, `addParticipant`. The shared inputs are `title`, `panels`,
`presentation`, and `participants`; `viewerState` belongs to one session.

A panel is a `piece`, `document`, or HTTP(S) `url`. Piece and document targets
are native cell references. Their complete space, scope, document, and path
survive registration and duplication. Adding a foreign piece links it and
changes no source-space permissions. The renderer reads the target under the
viewer's ordinary authority. A URL renders in a native iframe with an opaque
origin: its sandbox permits scripts, forms, and popups but no same-origin
access, and its referrer policy sends no referrer. Only valid HTTP(S) URLs
without embedded credentials are accepted. An always-visible browser link
remains available when embedding is blocked. Neither surface receives a Fabric
bridge or identity.

Panel bodies are stateless computed views inside the Loom. A READ viewer can
render URL and document content without a publisher first opening the UI or
initializing a separate panel-view pattern. Linked pieces retain their own
execution and access requirements: Loom renders an initialized target under the
viewer's authority and does not initialize arbitrary nested patterns on its
behalf.

A published document stores `{source, notes}`. `source` is the allowlisted
`PublishedSource` page excerpt or person card. The producer refreshes only that
key. `notes` is collaborative text and remains intact when source data changes;
the root renders it as a shared text field.

`pieceRegistry` derives from piece panels in order, including duplicates.
`addPiece({piece})` idempotently adds a registration occurrence. `addPanel`
deduplicates by occurrence identity. `movePanel` and `duplicatePanel` accept an
optional `before` occurrence; an absent source or anchor refuses. Duplicating
copies the occurrence fields and retains its target link. The runtime invocation
identifies the new occurrence, including when that delivery is retried.
`removePanel` removes only one occurrence and its presentation references.
`removePiece` unregisters every occurrence of the specified complete piece link.
Neither operation deletes the target.

`setPresentation({stagedPanels, focusedPanel?})` replaces staging and focus in
one transaction. Staged occurrences must belong to the current collection and be
unique; focus must be staged. Omitting focus clears it. Structural actions read
the current collection inside their handler transaction, so conflicts retry
against current membership rather than applying a stale client's list.

`participants` lists the Fabric profiles of the Loom's participants, each as the
live profile cell in its own space. It records no DID and no name: a profile
names its principal in its label, and its name and avatar are read from it when
shown. `participants.tsx` holds the roster and `addParticipant({profile})`, the
only writer its write contract admits; a write from any other action, or from
another pattern holding the roster cell, is refused. Adding is a mergeable set
add, so concurrent additions all land and a listed profile is not added twice.
The roster links only a profile whose label the runtime holds, the first entry
included: a bare document names no principal, and adding one is refused. Any
participant may add any profile, so the stored list is a set of claims: a
consumer that needs the actual participants keeps only profiles whose principal
currently holds access to the Loom's space, which hides an entry for anyone else
and drops a removed member without deleting their entry. The root does not
render the list: it holds claims, and only a consumer that can read the access
list can say which are participants.

Run and attach all five tests when deploying or updating source:

```sh
deno task cf test packages/patterns/loom/main.test.tsx
deno task cf test packages/patterns/loom/presentation-refusals.test.tsx
deno task cf test packages/patterns/loom/multi-user.test.tsx
deno task cf test packages/patterns/loom/participant-labels.test.tsx
deno task cf test packages/patterns/loom/url-view.test.tsx

deno task cf piece new packages/patterns/loom/main.tsx \
  --root packages/patterns \
  --test packages/patterns/loom/main.test.tsx \
  --test packages/patterns/loom/presentation-refusals.test.tsx \
  --test packages/patterns/loom/multi-user.test.tsx \
  --test packages/patterns/loom/participant-labels.test.tsx \
  --test packages/patterns/loom/url-view.test.tsx
```

Repeat all `--test` arguments with every `piece setsrc`. A source closure for
custom-root provisioning carries the same test modules in its `sourceRoots`.
`packages/piece/test/loom-root.test.ts` also exercises full foreign references
and replayed runtime invocations against the compiled source.
