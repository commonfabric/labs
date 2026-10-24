# Loom default pattern

`main.tsx` is a space default pattern with linked panel occurrence cells.
`schemas.tsx` defines its public contract and re-exports the participant
roster's types from `participants.tsx`, which also holds the roster's one
writer, `addParticipant`. The shared inputs are `title`, `panels`,
`presentation`, `participants`, `chatRoom`, `fileStore`, `meeting`, and `style`;
`hiddenPanels` and `privatePanels` belong to one user, and `viewerState` to one
session.

`style` is a `PerSpace` value: null, or `{id, mode}` where `id` is a portable
catalog identifier and `mode` is `native`, `light`, or `dark`.
`setStyle({style})` validates and replaces the pair in one write; null clears it
for every participant. Invalid initial selections are exposed as null; invalid
confirmation events are refused without changing the stored choice. The
identifier uses `[a-z][a-z0-9-]{0,63}`. Viewers interpret catalog identifiers
and fall back locally when a style is unknown. Hover previews remain ephemeral
viewer state and send no action. Space WRITE or OWNER authority admits changes;
READ viewers observe them.

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
itself: no caller chooses the one the label names. The profile is the actor's
own: `admitPanel` refuses an event whose `as` names a profile unless
`principalOf(as, "represents-principal")` returns the principal the event acts
for. A Fabric profile carries its own owner's `represents-principal`, so an
event naming another principal's profile is refused, and so is one naming a
profile from which `principalOf()` reads no principal, and one that acts for no
one. An occurrence added without a profile records the principal who acted in
`addedBy` instead, as the DID `currentPrincipal()` returns, and the runtime
labels the field `authored-by` for that same principal. Nothing in an event
names the adder.

The actor is read from the panel document's own stored label map, with
`readStoredCfcMetadata` on the panel's document, which resolves a label map
stored by reference: the `represents-principal` atom of the entry whose path is
exactly `["addedByProfile"]` and whose `origin` is not `"link"`. Entries with
`origin: "link"`, at that path or below it, are copies of the linked profile's
label and name its owner, not the actor. A merged label view, such as
`cfcLabelViewForCell` on the field, unions the two without saying which is
which, and a document that links the panel, such as the panels list, holds all
of them as link copies; neither can name the actor. The root admits no panel
under a profile its actor does not own, but the runtime does not refuse that
combination, so a reader shows the linked profile as the adder only when that
profile's own `represents-principal` names the actor; otherwise the panel was
added by the actor under someone else's profile.

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
Loom. The root's own check is what holds the profile to its actor. The runtime
checks a new link's source only under a write contract outside a union branch,
and this one sits inside each of `Panel`'s branches, so it would link any
document passed as `as` into the field when the panel's document holds no stored
write contract yet, as when the write creates the panel. That does not change
whose principal the label names.

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
`principalOf(panel.key("addedBy"), "authored-by", { label: "written" })`, which
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
with neither, the copy records the principal the duplication acted for. A
duplication under a profile that is not the viewer's own is refused, as any
other event naming one is.

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

Only the principal who added an occurrence removes it, unless they have left or
its label does not say who added it. `removePanel` reads the adder from the
runtime's stamps on the occurrence's own fields, with `principalsOf` and
`label: "written"`: `authored-by` at `addedBy`, whatever the field holds, and
`represents-principal` at `addedByProfile`, which names whoever acted under the
profile rather than the profile's owner. It removes an occurrence those stamps
attest to the principal the event acts for alone. It removes, for anyone, one
that records no adder: an occurrence that holds no profile and whose `addedBy`
no stamp names, which holds its adder, if any, only as its writer's claim. One
whose stamps do not settle on one adder is an OWNER's alone to remove: one whose
stamps name more than one principal, one where either field holds a claim in a
form no runtime mints, which a runtime did not write and is trusted in neither
direction, and one that holds a profile no stamp says anyone acted under, since
`admitPanel` stamps every profile it records. No participant's claim to such an
occurrence can be read, so none is protected, and an OWNER of the Loom's space,
by `spaceAccess(panels)`, is who clears it up. It refuses one attested to
another principal, with one exception: an OWNER of the Loom's space, by
`spaceAccess(panels)`, removes an occurrence whose attested adder the Loom's
access list grants nothing, by `spaceAccessOf(panels, adder)`, so that what a
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

`retitleLoom({title})` sets the Loom's title, which is also its name.
`retitlePanel({panel, titleOverride})` sets the title a panel shows in place of
its target's; an empty title clears it. `retargetPanel({panel, target})` points
a URL or piece panel at a new target, `{kind: "url", url}` or
`{kind: "piece", piece}`, in place: the occurrence keeps its position, its
staging and focus, its title, and its adder, and the target it leaves is
untouched. Each writes only the fields it names, `retitlePanel` the title and
`retargetPanel` the kind and the target's key, removing the other kind's key
when the kind changes, so a panel's adder fields, which only `admitPanel`
writes, are never rewritten. Both refuse a panel that is not in the Loom, and
`retargetPanel` also refuses a document panel, whose content is its producer's,
and a URL a panel may not hold. Any member may retitle or retarget any panel:
only removal turns on who added it. The runtime handles an invocation of any of
the root's streams once: a caller that sends an event again under an invocation
id the root has handled is refused with `receipt-exists` and changes nothing, so
retrying after a lost reply cannot overwrite a newer edit.

`hiddenPanels` holds the shared occurrences one user has hidden from their own
view. It is a per-user input: every session of that user reads the same list,
and no other user's runtime reads it. `hidePanel({panel})` adds an occurrence in
the Loom to the acting user's list, refuses one that is not in the Loom, and
changes nothing for one already hidden. `unhidePanel({panel})` takes one off the
list, including one removed from the Loom since. A hide changes no other user's
view and leaves `panels` as it is. `viewerPanels` is the viewer's own list:
`panels` without the occurrences they have hidden, in the shared order, with
their private panels placed as described below. The root renders the shared
panels with a Hide button on each and a Show button for each hidden one. The
list decides what the viewer is shown, not what they may read: a hidden
occurrence stays in `panels`.

`privatePanels` holds one user's private panels, a per-user input as
`hiddenPanels` is. Each entry is `{panel, before?}`: an occurrence that lives in
a space other than the Loom's, and the shared occurrence it shows just ahead of.
`addPrivatePanel({panel, before?})` adds one for the acting user. It refuses an
occurrence in the Loom's own space, a URL panel whose URL a panel may not hold,
and a `before` that is not in the Loom; adding one already there changes
nothing. A private panel is private by the access list of the space its
occurrence lives in: every member may read what the Loom's space holds, and a
per-user list says where an entry is kept, not who may read what it links.
`movePrivatePanel({panel, before?})` anchors one anew: `before` is a shared
occurrence, or another of the user's private panels, whose anchor it then takes,
and without `before` the panel shows after every shared one.
`removePrivatePanel({panel})` takes one off the list and leaves its occurrence
as it is. In `viewerPanels`, each private panel shows just ahead of its anchor,
or after the shared panels while its anchor is not shown, and private panels
anchored alike keep the order of the list. The root renders the viewer's private
panels as cards of their own, after the shared ones, each with a Remove button.
A private loom shown in a social loom is a private panel whose piece is that
loom's root, so several social looms can each show one private loom.

`participants` lists the Fabric profiles of the Loom's participants, each as the
live profile cell in its own space. It records no DID and no name: a profile
names its principal in its label, and its name and avatar are read from it when
shown. `participants.tsx` holds the roster and `addParticipant({profile})`, the
only writer its write contract admits; a write from any other action, or from
another pattern holding the roster cell, is refused. Adding is a mergeable set
add, so concurrent additions all land and a listed profile is not added twice.
Any participant may add any document, a bare one that names no principal
included, so the stored list is a set of claims: a consumer that needs the
actual participants keeps only profiles whose principal currently holds access
to the Loom's space, which hides an entry for anyone else and drops a removed
member without deleting their entry. The root does not render the list: it holds
claims, and only a consumer that can read the access list can say which are
participants.

`chatRoom` links the Loom's chat room, so every member finds it in the Loom's
shared state. It is a link to a room piece in the Loom's own space, typed as
`LinkedChatRoom`, which declares only the room's name: a reader of the Loom
loads nothing of the conversation, and a client opens the room through the link
under its own access. A Loom that names no room, including a root whose state
holds no `chatRoom` field, reads the link's value as `undefined`.
`setChatRoom({room?})` names the room, or clears it when `room` is omitted;
sending the same event again leaves the same state. It refuses a room in another
space. `ensureChatRoom()` names a room the root creates itself, unless the Loom
names one already, in which case it changes nothing, so sending it again, or
from two sessions at once, leaves one room named. The room it creates is the
space's own chat: a `FabriChatRoom` with no `about`, in the Loom's space, which
is not the space's root and is added neither as a panel nor to `pieceRegistry`,
so it never appears as a panel. A FabriChat room's members are the principals
its space's access list admits, so a room in the Loom's space has the Loom's
members. The participants it shows are the profiles its space's default pattern
lists, which in the Loom's space is this root's `participants`, a set of claims
as described above, plus the author profile of any of its messages that records
one the list leaves out. Whoever may change the Loom's panels may change
`chatRoom`, with either stream: the space's access list decides both, and
refuses a member who holds only READ. Of the root's handlers, only `setChatRoom`
and `ensureChatRoom` change it, and `ensureChatRoom` only while it names none.
The designation is a fact about the Loom, not about its layout, so it persists
through every panel change: removing the room's panels leaves it named, and
adding one back changes nothing. A reader that needs to know whether the room is
shown looks for a piece panel whose piece `equals()` the room. A deleted room
stays named until `setChatRoom` clears it, as any link does. The input holds the
link in a record, `{ room? }`, because a handler's cell for a field holding a
link writes through it, so replacing the link there would write into the room.

`fileStore` is where the Loom keeps its space's file store
([`FileStore`](../../../docs/specs/fabrifile/FileStore.md#where-it-lives)): a
`FileStoreRecord`, `{}` until the store is first needed. The output's
`fileStore` links the store, absent while the Loom names none, and
`ensureFileStore()` creates one as a piece in the Loom's space, unless the Loom
names one already, in which case it changes nothing. The store is added neither
as a panel nor to `pieceRegistry`. The output also offers the record itself as
`fileStoreRecord`, which is how the Loom's chat room, whose container the Loom
is, finds the store and creates it: a room in the Loom's space has the Loom's
store as its own.

`meeting` is the Loom's shared, durable meeting association, a record with an
optional `key`. An empty record, including the default for a root whose input
has no `meeting` field, names no meeting. The key is the existing CFS meeting
occurrence key: the lowercase 64-character hexadecimal SHA-256 of its organizer,
iCalUID, and UTC original start time, computed by CFS. The root validates the
key's format and stores it without recomputing it.

The optional `meeting.portableIdentity` carries `scheme: "ical-uid-slot"`,
`item_key`, and `occurrence_key`. The keys are complete lowercase hexadecimal
SHA-256 digests computed by the caller from the opaque iCalendar UID and typed
original slot. The root validates their scheme and format and stores these three
fields without recomputing them. The caller retains the provider evidence and
verifies which occurrence those keys identify. Any space member with WRITE may
supply this evidence, so the stored identity is a claim. Readers must
corroborate its relationship to the calendar occurrence before adopting a room
or accepting a lookup alias.

`bindMeeting({key, portableIdentity?, reply?})` binds an empty association once,
including the portable evidence when supplied. A same-key replay can add
portable evidence to a binding that has none; otherwise it confirms the
association. The legacy key remains immutable. A different key or different
supported portable keys leave the association unchanged and return a conflict.
The handler reads the association inside its transaction, so competing binds
retry against the first committed key. If supplied, the per-event reply cell
receives `{status: "bound", key}`, `{status: "already-bound", key}`, or
`{status: "conflict", key}`, where a conflict names the stored key. When the
reply key equals the request key, the conflict is between portable keys;
otherwise the legacy keys differ. An invalid request key receives
`{status: "invalid-key"}`. Malformed portable request evidence, including an
explicit `null`, receives `{status: "invalid-key"}` without binding the key.
Unrecognized stored state, including extra fields without a key or a malformed
stored key, receives `{status: "invalid-state"}` and stays intact. Extra
metadata alongside a valid key stays intact on replay, enrichment, or conflict,
including unknown fields inside an existing portable identity. A valid same-key
request for portable evidence receives `{status: "invalid-state"}` for malformed
or unsupported stored portable evidence and leaves it intact. A legacy replay
omitting portable evidence still confirms the legacy key and preserves that
stored metadata.

A request whose `reply` is the association cell itself changes nothing and
receives no response, since any response written there would replace the
association. A reply cell that lies within the association, such as one of its
fields, or contains it is not detected, and the response written there changes
the association; a caller passes a reply cell of its own. A caller omitting
`reply` confirms success by observing the matching `meeting.key` in the root's
output.

A caller using portable evidence must also observe the matching
`meeting.portableIdentity` through the root's output. A legacy `bound` or
`already-bound` reply alone does not establish support: a root running older
source may ignore the optional request field. Portable evidence supplies an
association for room lookup; binding does not allocate a room or deduplicate
simultaneous creators.

The association is meaningful shared state, independent of panels, chat, and
each viewer's overlay. Source updates preserve it through its `PerSpace` input.
Binding is a consistency guard; the space's existing WRITE authority governs the
handler. Explicit adoption of an existing Loom belongs to the caller's
owner-authorized workflow. A root without `bindMeeting` is unsupported for that
workflow: a caller must not infer support from an absent key, replace the root,
or overwrite its contents to adopt it.

Run and attach all seventeen tests when deploying or updating source:

```sh
deno task cf test packages/patterns/loom/style.test.tsx
deno task cf test packages/patterns/loom/style-refusals.test.tsx
deno task cf test packages/patterns/loom/main.test.tsx
deno task cf test packages/patterns/loom/presentation-refusals.test.tsx
deno task cf test packages/patterns/loom/multi-user.test.tsx
deno task cf test packages/patterns/loom/participant-labels.test.tsx
deno task cf test packages/patterns/loom/url-view.test.tsx
deno task cf test packages/patterns/loom/adder-profile.test.tsx
deno task cf test packages/patterns/loom/adder-profile-owner.test.tsx
deno task cf test packages/patterns/loom/actor-attribution.test.tsx
deno task cf test packages/patterns/loom/chat-room.test.tsx
deno task cf test packages/patterns/loom/ensure-chat-room.test.tsx
deno task cf test packages/patterns/loom/ensure-file-store.test.tsx
deno task cf test packages/patterns/loom/retitle-retarget.test.tsx
deno task cf test packages/patterns/loom/overlay.test.tsx
deno task cf test packages/patterns/loom/private-panels.test.tsx
deno task cf test packages/patterns/loom/meeting.test.tsx

deno task cf piece new packages/patterns/loom/main.tsx \
  --root packages/patterns \
  --test packages/patterns/loom/style.test.tsx \
  --test packages/patterns/loom/style-refusals.test.tsx \
  --test packages/patterns/loom/main.test.tsx \
  --test packages/patterns/loom/presentation-refusals.test.tsx \
  --test packages/patterns/loom/multi-user.test.tsx \
  --test packages/patterns/loom/participant-labels.test.tsx \
  --test packages/patterns/loom/url-view.test.tsx \
  --test packages/patterns/loom/adder-profile.test.tsx \
  --test packages/patterns/loom/adder-profile-owner.test.tsx \
  --test packages/patterns/loom/actor-attribution.test.tsx \
  --test packages/patterns/loom/chat-room.test.tsx \
  --test packages/patterns/loom/ensure-chat-room.test.tsx \
  --test packages/patterns/loom/ensure-file-store.test.tsx \
  --test packages/patterns/loom/retitle-retarget.test.tsx \
  --test packages/patterns/loom/overlay.test.tsx \
  --test packages/patterns/loom/private-panels.test.tsx \
  --test packages/patterns/loom/meeting.test.tsx
```

Repeat all `--test` arguments with every `piece setsrc`. A source closure for
custom-root provisioning carries the same test modules in its `sourceRoots`.
`packages/piece/test/loom-root.test.ts` also exercises full foreign references
and replayed runtime invocations against the compiled source.
`packages/piece/test/loom-meeting.test.ts` checks malformed stored state and
preservation through a source update.
`packages/patterns/integration/loom-meeting-multi-runtime.test.ts` checks
competing meeting bindings through independent runtimes.
