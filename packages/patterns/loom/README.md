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

A panel records who added it in one of two fields. `addedByProfile` links the
profile under which the person adding it acted, and the runtime labels that link
with `represents-principal` for the principal who acted, which it resolves
itself: no caller chooses the one the label names. The linked profile is the
actor's claim, as in the roster, since any participant may link any profile, and
a Fabric profile carries its own owner's `represents-principal`. An occurrence
added without a profile records the principal who acted in `addedBy` instead, as
the DID `currentPrincipal()` returns, and the runtime labels the field
`authored-by` for that same principal. Nothing in an event names the adder.

The actor is read from the panel document's own stored label map, with
`readStoredCfcMetadata` on the panel's document, which resolves a label map
stored by reference: the `represents-principal` atom of the entry whose path is
exactly `["addedByProfile"]` and whose `origin` is not `"link"`. Entries with
`origin: "link"`, at that path or below it, are copies of the linked profile's
label and name its owner, not the actor. A merged label view, such as
`cfcLabelViewForCell` on the field, unions the two without saying which is
which, and a document that links the panel, such as the panels list, holds all
of them as link copies; neither can name the actor. A reader shows the linked
profile as the adder only when that profile's own `represents-principal` names
the actor; otherwise the panel was added by the actor under someone else's
profile. The runtime does not refuse that combination.

`admission.tsx` holds `admitPanel`, the only handler the two fields' write
contracts admit, so `addPiece`, `addPanel`, and `duplicatePanel` are all
bindings of it and take one event shape; an event names the profile in `as`. The
contracts name the handler, not its binding, so any binding of this module's
`admitPanel` may write the fields. Once the root has written a panel, a write to
either field from any other handler is refused, and so is a write of the whole
panel that keeps it, such as `panel.set({ ...panel.get(), titleOverride })`; a
write to one of its other fields, such as `panel.key("titleOverride").set(...)`,
is not.

A profile is recorded only on an occurrence `admitPanel` creates, never on a
document a caller passes in. `addPiece` creates the occurrence. `addPanel` with
`as` admits a new occurrence copied from the one passed, with its target and
title, as `duplicatePanel` does, and leaves the document passed as it was, so an
occurrence another Loom holds keeps the adder it shows there. `addPanel` without
`as` links the occurrence passed itself, and refuses one that already names a
profile: its label names whoever added it then, to this Loom or to another, and
linking it would attribute this admission to them. For the same reason it
refuses one whose `addedBy` label names a principal other than the one the event
acts for, names more than one, or holds a claim in a form no runtime mints. It
links one whose `addedBy` label names only the principal the event acts for, and
one whose `addedBy` label names nobody (`principalsOf` returns `[]`), which
holds its adder, if any, only as its writer's claim. So a removed occurrence
that names a profile, another principal's adder, several adders, or an adder in
a form no runtime mints is added back by adding a new occurrence, with `as` or
through `addPiece`; `duplicatePanel` copies only an occurrence still in the
Loom. The runtime links an unlabeled document passed as `as` into the field when
the panel's document holds no stored write contract yet, as when the write
creates the panel: it checks a new link's source only under a write contract
outside a union branch, and this one sits inside each of `Panel`'s branches.
That does not change whose principal the label names.

`addedBy` is the DID of the principal who added the panel. On an occurrence
`admitPanel` creates without `as`, through `addPiece` or `duplicatePanel`, it is
the principal the event acted for: the participant who sent it, or, for an event
a pattern's own handler sent, the user that pattern runs as. It records
authority, not intent: any pattern a user runs can add a panel for them. A run
that acts for no one records no adder, and one acting for a principal whose DID
is longer than 195 characters, the bound every `addedBy` is held to, is refused.
The actor is read from the panel document's stored label map as for
`addedByProfile`: the `authored-by` atom of the entry whose path is exactly
`["addedBy"]` and whose `origin` is not `"link"`. Patterns read the adder with
`principalOf(panel.key("addedBy"), "authored-by", { followLink: false })`, which
reads the stamp on the field itself rather than the label of a document a link
stored there leads to, and every principal the field attests with
`principalsOf`, which tells a contested field from an unattested one; authorship
on another field, such as the panel's title, does not name the adder. `addPanel`
without `as` links an occurrence a caller made as it is, and an `addedBy` it
already holds is its writer's claim, which `addPanel` refuses unless it is a DID
in W3C DID Core syntax of at most 195 characters. The label entry there, when
the run that wrote the value minted one, names that writer rather than whomever
the value names. So a reader takes the adder from the label, and from the value
alone only where no entry exists. A panel with neither field names no adder.

The root's own Duplicate button acts under the session's `actingProfile` in
`viewerState` when it holds one, and otherwise under the viewer's `#profile`;
with neither, the copy records the principal the duplication acted for.

`pieceRegistry` derives from piece panels in order, including duplicates.
`addPiece({piece, as?})` idempotently adds a registration occurrence; for a
piece already registered it changes nothing, its adder included. `addPanel`
deduplicates by occurrence identity: an occurrence already in the Loom is not
added again, with or without `as`, while each `addPanel` with `as` of an
occurrence outside it adds a new copy. `movePanel` and `duplicatePanel` accept
an optional `before` occurrence; an absent source or anchor refuses. Duplicating
copies the occurrence's complete target link and its title. It takes its adder
from its own event, never from the source: a copy is added by whoever duplicates
it, under the profile its event names or else as the principal it acted for. The
runtime invocation identifies the new occurrence, including when that delivery
is retried. `removePanel` removes only one occurrence and its presentation
references. `removePiece` unregisters every occurrence of the specified complete
piece link. Neither operation deletes the target.

Only the principal who added an occurrence removes it, unless they have left.
`removePanel` reads the adder from the runtime's stamps on the occurrence's own
fields, with `principalsOf` and `followLink: false`: `authored-by` at `addedBy`,
whatever the field holds, and `represents-principal` at `addedByProfile`, which
names whoever acted under the profile rather than the profile's owner. It
removes an occurrence those stamps attest to the principal the event acts for
alone. It removes one they attest to nobody whose contribution the rule could
keep: an occurrence with no adder, one that holds its adder only as its writer's
claim in `addedBy`, and one whose stamps name more than one principal. A field
whose claims hold one in a form no runtime mints names nobody either: a label a
runtime did not mint is trusted in neither direction, and the rule falls open
there because the alternative is a panel nobody can remove; the other field's
stamp, when well formed, still names the adder. It refuses one attested to
another principal, with one exception: an OWNER of the Loom's space, by
`spaceAccess(panels)`, removes an occurrence whose attested adder the Loom's
access list grants nothing, by `spaceAccess(panels, adder)`, so that what a
participant who has left added can be cleared up. Both reads are anchored in the
Loom's list, never in the occurrence, which `addPanel` may have linked from
another space whose list says nothing about the Loom. A list the replica has not
read admits no such removal, and a list granting `*` a level says nobody has
left. The field read stops at a value link but follows a redirect, as a write
would, so a redirect stored in `addedBy` would stand the target document's stamp
in for the field's; the typed pattern API authors no redirect, so no pattern can
place one there. An occurrence that is not in the Loom is left alone without a
check. `removePiece` applies the same check to every occurrence of the piece and
removes all of them or none, so a piece that another principal also registered
is unregistered one occurrence at a time, with `removePanel`. The root's Remove
button sends `removePanel`, so it is refused on an occurrence someone else,
still in the Loom, added.

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

Run and attach all seven tests when deploying or updating source:

```sh
deno task cf test packages/patterns/loom/main.test.tsx
deno task cf test packages/patterns/loom/presentation-refusals.test.tsx
deno task cf test packages/patterns/loom/multi-user.test.tsx
deno task cf test packages/patterns/loom/participant-labels.test.tsx
deno task cf test packages/patterns/loom/url-view.test.tsx
deno task cf test packages/patterns/loom/adder-profile.test.tsx
deno task cf test packages/patterns/loom/actor-attribution.test.tsx

deno task cf piece new packages/patterns/loom/main.tsx \
  --root packages/patterns \
  --test packages/patterns/loom/main.test.tsx \
  --test packages/patterns/loom/presentation-refusals.test.tsx \
  --test packages/patterns/loom/multi-user.test.tsx \
  --test packages/patterns/loom/participant-labels.test.tsx \
  --test packages/patterns/loom/url-view.test.tsx \
  --test packages/patterns/loom/adder-profile.test.tsx \
  --test packages/patterns/loom/actor-attribution.test.tsx
```

Repeat all `--test` arguments with every `piece setsrc`. A source closure for
custom-root provisioning carries the same test modules in its `sourceRoots`.
`packages/piece/test/loom-root.test.ts` also exercises full foreign references
and replayed runtime invocations against the compiled source.
