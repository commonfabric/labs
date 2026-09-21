# Loom default pattern

`main.tsx` is a space default pattern with linked panel occurrence cells.
`schemas.tsx` defines its public contract. The shared inputs are `title`,
`panels`, and `presentation`; `viewerState` belongs to one session.

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

Run and attach all four tests when deploying or updating source:

```sh
deno task cf test packages/patterns/loom/main.test.tsx
deno task cf test packages/patterns/loom/presentation-refusals.test.tsx
deno task cf test packages/patterns/loom/multi-user.test.tsx
deno task cf test packages/patterns/loom/url-view.test.tsx

deno task cf piece new packages/patterns/loom/main.tsx \
  --root packages/patterns \
  --test packages/patterns/loom/main.test.tsx \
  --test packages/patterns/loom/presentation-refusals.test.tsx \
  --test packages/patterns/loom/multi-user.test.tsx \
  --test packages/patterns/loom/url-view.test.tsx
```

Repeat all `--test` arguments with every `piece setsrc`. A source closure for
custom-root provisioning carries the same test modules in its `sourceRoots`.
`packages/piece/test/loom-root.test.ts` also exercises full foreign references
and replayed runtime invocations against the compiled source.
