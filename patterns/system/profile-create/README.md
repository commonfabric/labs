# Profile create

The trusted surface the `#profile` wish shows while its viewer has no profile: a
name field, an optional picture, and a "Create profile" button. The create is a
CFC trusted action (`TRUSTED_PROFILE_CREATE_ACTION` on
`TRUSTED_PROFILE_CREATE_SURFACE`): only a click on this surface creates a
profile, so a pattern that holds the surface cannot create one on the user's
behalf. `docs/common/conventions/wish.md` describes the wish and the host's
profile suggestion this surface offers.

## CFC debt

**The intended policy.** The new profile's name and picture are the owner's own
face, so only the owner, acting on this surface, decides them. A pattern that
holds the surface (a loom showing a guest's `#profile` create surface, say) may
show it but may not choose what goes into it: not the name, not the picture, and
not whether there is a profile at all. A host's suggestion is an offer the owner
takes or edits here; the host learns nothing back.

**The cut.** Choosing and removing the picture (`choosePicture`,
`removePicture`, and the `pictureChoice` cell they write) are not gated. Any
sender that reaches those streams can set or clear the picture the next create
gives the profile. The streams are outputs of the surface, and the rendered
surface binds them too, so a pattern that holds the surface reaches them either
way. The name and the create itself stay gated: the name rides the trusted
click's own event. This matches the posture profile-home already has, whose
`setPicture` is ungated.

The holder can also read the picture the user picked before they create, even
one they then abandon: the rendered surface shows it (`cf-avatar`'s `bytes`).
Under the intended policy the picked picture would be the owner's until they
create, readable by the holder only as a picture the owner chose to show. The
surface publishes no output carrying it, so reading it means walking the
rendered UI.

**Why.** Real CFC would gate the picture choice as it gates the create, and the
pattern did, briefly. But no real user could pass that gate. `cf-avatar-input`
hands the picked image over in a `cf-change` event it dispatches itself, after
the file dialog closes and the image is resized, and the renderer vouches only
for events the browser marks trusted (`event.isTrusted`, see
`runtime/html/src/main/event-provenance.ts`). A component's own event never is.

**The semantics we suspect CFC lacks.** A way for a value a trusted UI component
produces from a user's gesture to carry that gesture's provenance. Open
questions:

1. Which components may pass a gesture on. A blanket rule ("an event a component
   sends while handling a trusted event inherits it") would let a pattern
   launder a value through any component that emits a change when its value is
   set from code, so it likely has to be opt-in per component.
2. How provenance crosses an asynchronous step, such as a file dialog and a
   resize. One shape: the component carries the browser's trusted `change` event
   from its own file input, and the renderer checks it came from inside that
   component, on the same surface.
3. What the provenance vouches for. A click vouches that the user pressed
   something; a picked picture is a value the component derived from the user's
   file. Whether a TCB component's output counts as the user's value is a policy
   question.

Tracked on the laundry as top/2823.
