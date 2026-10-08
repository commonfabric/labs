import {
  type Cell,
  Cfc,
  equals,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import ProfileHome, {
  type BackwardsCompatibleProfile,
  type InboxPointable,
  pointAtInboxIfUnset,
  type ProfileHomeOutput,
  type ProfileInbox,
  type SetProfileNameEvent,
} from "./profile-home.tsx";

// Trusted UI surfaces / actions. The create surface authorizes appending a new
// profile to the home `profiles` list; the picker surface authorizes setting the
// default profile and stamping most-recently-used (MRU).
export const TRUSTED_PROFILE_CREATE_SURFACE = "ProfileCreateSurface";
export const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";
export const TRUSTED_PROFILE_PICKER_SURFACE = "ProfilePickerSurface";
export const TRUSTED_PROFILE_SET_DEFAULT_ACTION = "SetDefaultProfile";
export const TRUSTED_PROFILE_SET_MRU_ACTION = "SetMruProfile";

// Read a profile link (or list of links) as cell REFERENCES (`asCell`), not
// inlined values. A plain `.get()` deep-resolves each element and collapses the
// whole read to `undefined` when any element links into a space not yet loaded
// in this context (e.g. a freshly-created profile living in its own `inSpace`
// space). Item type is `unknown` to keep the sync shallow (links only). Mirrors
// wish.ts `profileLinkListSchema`; identity comparisons use `equals` on the
// resulting link cells, which never deep-resolves.
//
// These are functions (not const object literals) so the schema object is built
// per call inside the function body — module-top-level mutable data is rejected
// under SES (`__cf_data()`); a function returning a fresh literal is not.
// deno-lint-ignore no-explicit-any
export const profileLinkListSchema = (): any => ({
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
});
// deno-lint-ignore no-explicit-any
export const profileLinkSchema = (): any => ({
  type: "unknown",
  asCell: ["cell"],
});

export type CreateProfileEvent = {
  detail?: { message?: string };
  key?: string;
  name?: string;
  target?: { value?: string };
};

export type SeedProfileNameEvent = { name?: string; index?: number };

// What the seed step needs of each profile in the list: the stored name (to
// write only where none is stored yet) and the stream it writes through, and
// what pointing the profile at Home's private inbox needs. `setName` stays
// optional here so a stored profile of a vintage without it can never keep
// this handler from running for the profiles created after.
export type SeedProfileTarget = InboxPointable & {
  name: string;
  setName?: Stream<SetProfileNameEvent>;
};

// Stores the creation name in the new profile's `name` cell, through
// `setName` — the cell's owner-protected writer — so every `#profile` reader
// (Topics, `cf profile show`, the loom lobby), which reads the stored `name`
// and runs nothing, finds the name from the moment of creation. The cell is
// initialized statically in profile-home.tsx so it keeps its identity across
// releases; a default derived from `initialName` would not (see the `name`
// initializer there), so the value is written once, here, by the creator.
//
// A second step rather than a send in `submitProfileCreation`: the child a
// handler instantiates is materialized after the handler body returns (the
// runner runs the frame's reactives as a result pattern), so inside the body
// its streams do not exist yet and a send there reaches nothing. This event
// is queued behind the create in the same runtime and runs once the create
// has committed. The profile is addressed by position: the create handler
// reads the list's length before its push and sends it here as `index`.
// Position rather than the profile's display name, because the profile's
// lifts may not have run in this runtime by the time this step does (CI's
// slower lanes reached it first and a name match failed silently), and the
// argument is not on the result (re-exporting it changes the stored-profile
// schema every embedder carries, which the pattern-update gate refuses). The
// read of the list in the create handler keeps the append in the conflict
// set, so another device's create landing first conflicts and re-runs the
// create — re-deriving the index — instead of merging under it.
//
// The list is bound as a VALUE, not a link: the runner resolves a handler's
// argument against this schema before the body runs, and a profile whose
// docs the replica has not loaded yet reads as undefined — the runner then
// withdraws the dispatch and runs it again once the loads land (scheduler
// events.ts, the cold-argument arm). Reading the new profile in the body
// instead — through its link, right after the cross-space commit — raced
// that load: the send found no stream and reached nothing. Only a profile
// whose stored `name` is still empty is written: a re-delivery of this
// event, or the same profile seeded elsewhere, is left alone.
export const seedProfileName = handler<
  SeedProfileNameEvent,
  {
    profiles: SeedProfileTarget[];
    privateInbox?: ProfileInbox;
  }
>((event, { profiles, privateInbox }) => {
  const name = (event.name ?? "").trim();
  const index = event.index;
  if (!name || typeof index !== "number") return;
  const target = profiles[index];
  // The profile at `index` is the one just created only while its name is
  // unstored; an index taken from a list this replica had not loaded may name
  // an existing profile, which both steps below leave alone.
  if (target === undefined || (target.name ?? "") !== "") return;
  // The profile is pointed at Home's private inbox here, after its create has
  // committed, for the same reason its name is stored here. Home's own pointing
  // step runs once per runtime worker, so a profile created later would
  // otherwise wait for the next worker.
  pointAtInboxIfUnset(target, privateInbox);
  target.setName?.send({ name });
});

// Appends a freshly-created profile (its own `inSpace` space) to the home
// `profiles` list. The cross-space `inSpace` child materializes during the push;
// the `.inSpace(...)` call opts the transaction into a multi-space commit (see
// builder/pattern.ts `optIntoInSpaceMultiSpaceCommit` → runner
// `enableCrossSpaceChildCommit`).
//
// Each profile lives in a space of its own, created by the ANONYMOUS
// `inSpace()` call below: the calling (home) space records one allocation per
// call, keyed by this handler's frame cause, which carries the creating user's
// per-home-space input links plus the durable per-event id (runner.ts
// `createPatternFrame` cause). The space is created with a random DID and owned
// by the creating user, so a profile is unique per user AND per creation event,
// and stable across the cross-space-commit retry. The display name flows ONLY to
// `initialName` (editable later, independent of the space identity). Other
// users read a profile — a lunch poll or a chat room shows its name — and a
// runtime showing one writes into the profile's space, its per-session state
// at the least, so the space grants anyone WRITE. What keeps a visitor from
// changing the profile's data is the owner protection on its fields
// (profile-home.tsx), not the space's access list; its view state is per
// session. The profile is the space's root (`root: true`), reserved in the
// space's genesis commit, so a host holding only the space's DID reaches the
// profile through the space's root. Existing profiles keep their
// already-baked concrete DID link.
export const submitProfileCreation = handler<
  CreateProfileEvent,
  {
    profiles: Writable<BackwardsCompatibleProfile[]>;
    seedName: Stream<SeedProfileNameEvent>;
  }
>((event, { profiles, seedName }) => {
  // The submitted name rides the event: the create surface is a
  // `cf-submit-input`, whose submit-button click carries the typed text as
  // `event.target.value` (and the trusted surface's UI integrity). The handler
  // keeps no draft cell. This is what makes clear-on-submit safe: the push
  // materializes the profile in its own `inSpace` space, so the create is a
  // cross-space (multi-space) commit the runner drives through a pending →
  // resolve → retry cycle plus optimistic-conflict retries. Re-reading a
  // mutable draft on those retries — or clearing one — would race a back-to-back
  // second create; the event payload is fixed per creation, so the name stays
  // stable across retries and nothing is cleared late. The field clears itself
  // in the DOM after submit, with no durable write to clobber.
  const name = (event.name ?? event.detail?.message ?? event.target?.value ??
    "").trim();
  if (name) {
    // Where the push lands; the seed step below addresses the profile by it.
    // Read as link cells (see `profileLinkListSchema`): a deep read collapses
    // to undefined when any entry lives in a space this runtime has not
    // loaded, which every freshly created profile's does; the link read does
    // not. NOT bound as a value the runner would resolve first: a home whose
    // list doc this replica has not loaded reads as undefined there, and the
    // create then never runs ("did not run in 10 dispatches", measured in the
    // shell for a fresh user). The bound: a list doc that is unloaded here
    // reads as empty, the index is 0, and the seed step — which writes only
    // where no name is stored — skips rather than miswrites; the profile then
    // shows `initialName` until a name is saved.
    const index = ((profiles as any).asSchema(profileLinkListSchema()).get() ??
      []).length as number;
    profiles.push(
      ProfileHome.inSpace(undefined, { grants: { "*": "WRITE" }, root: true })({
        initialName: name,
        // The freshly created profile is current-vintage by construction — it
        // carries every stream and field, so the strict producer type is the
        // honest cast here (BackwardsCompatibleProfile is for stored docs of
        // unknown vintage).
      }) as ProfileHomeOutput,
    );
    // Queued behind this create; stores the name once the profile is live
    // (see `seedProfileName`).
    seedName.send({ name, index });
  }
});

/**
 * Home's default profile: a link to the chosen profile, under `profile`, or
 * no `profile` while none is chosen. The link sits under a key because a
 * handle to a cell whose root holds a link denotes the cell that link names,
 * so a link stored at the root would make every later write land in the
 * profile chosen first rather than re-point the default.
 */
export type DefaultProfileSlot = { profile?: BackwardsCompatibleProfile };

// Sets the user's default profile — the one `#profile` resolves to in headless
// mode and orders first in the picker. The chosen profile is bound per-row via
// handler state (mirrors how home's removeSpaceHandler binds its item).
export const setDefaultProfile = handler<
  unknown,
  {
    defaultProfile: Writable<DefaultProfileSlot>;
    // Take the profile as a LINK cell, not a resolved value: the handler only
    // needs the link to write into defaultProfile, and a link argument doesn't
    // require the profile's cross-space values to be loaded at event time —
    // resolving the full value here would fail required-field validation
    // ("stream action argument is undefined … not running") whenever the
    // profile's space hasn't materialized locally yet.
    profile: Cell<BackwardsCompatibleProfile>;
  }
>((_, { defaultProfile, profile }) => {
  if (profile) {
    defaultProfile.key("profile").set(profile as any);
  }
});

// Stamps a profile as most-recently-used: prepend to the MRU list (deduped by
// link identity). Drives the picker's "default first, then by MRU" ordering.
export const setMruProfile = handler<
  unknown,
  {
    mru: Writable<BackwardsCompatibleProfile[]>;
    // Link cell, not a resolved value — same event-time-validation reason as
    // setDefaultProfile above.
    profile: Cell<BackwardsCompatibleProfile>;
  }
>((_, { mru, profile }) => {
  if (!profile) return;
  // Read existing entries as link cells (not inlined values) so an entry that
  // links into an unloaded space doesn't collapse the whole read to `undefined`
  // and silently wipe MRU history. Dedup by link identity via `equals`.
  const current = ((mru as any).asSchema(profileLinkListSchema()).get() ??
    []) as BackwardsCompatibleProfile[];
  const filtered = current.filter((entry) => !equals(entry, profile));
  mru.set([profile, ...filtered] as any);
});

// A single owner-protected link to a profile pattern in its own space, created
// through the trusted create surface. This element contract gates adding or
// replacing a link (a changed element value); the array container additionally
// carries `writeAuthorizedBy` to gate structural changes (see TrustedProfileList
// below).
export type TrustedProfileLink = Cfc<
  WriteAuthorizedBy<
    Cell<BackwardsCompatibleProfile>,
    typeof submitProfileCreation
  >,
  {
    addIntegrity: ["profile-link"];
    uiContract: {
      helper: "UiAction";
      action: typeof TRUSTED_PROFILE_CREATE_ACTION;
      trustedPattern: typeof TRUSTED_PROFILE_CREATE_SURFACE;
      requiredEventIntegrity: [typeof TRUSTED_PROFILE_CREATE_SURFACE];
    };
  }
>;

// The home `profiles` list. Protection is two-layered:
//   - elements (`TrustedProfileLink`) carry the create `uiContract` — gates
//     adding/replacing a link (a changed element value) to the trusted surface;
//   - the array container carries `writeAuthorizedBy: submitProfileCreation` —
//     gates STRUCTURAL changes (truncation / removal / reorder) that the
//     element-wildcard contract misses, because CFC's element-applies check only
//     visits *changed* elements of the new array, so a `set([])` or shrink would
//     otherwise be unmediated. Container `writeAuthorizedBy` (identity-based)
//     rather than `uiContract` (per-event) so a legit append — which also
//     rewrites the container — passes under the create handler's identity
//     instead of re-triggering a per-event trusted requirement it can't satisfy.
export type TrustedProfileList = Cfc<
  WriteAuthorizedBy<TrustedProfileLink[], typeof submitProfileCreation>,
  { addIntegrity: ["profile-link"] }
>;

// A profile link written via the trusted picker surface (default / MRU writes).
type PickerProfileLink<Binding, Action extends string> = Cfc<
  WriteAuthorizedBy<Cell<BackwardsCompatibleProfile>, Binding>,
  {
    addIntegrity: ["profile-link"];
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: typeof TRUSTED_PROFILE_PICKER_SURFACE;
      requiredEventIntegrity: [typeof TRUSTED_PROFILE_PICKER_SURFACE];
    };
  }
>;

// The home `defaultProfile` slot (`DefaultProfileSlot`): its `profile` link is
// write authorized by `setDefaultProfile`.
export type TrustedDefaultProfile = {
  profile?: PickerProfileLink<
    typeof setDefaultProfile,
    typeof TRUSTED_PROFILE_SET_DEFAULT_ACTION
  >;
};

// The home `mru` list: elements carry the picker `uiContract`; the array
// container carries `writeAuthorizedBy: setMruProfile` to gate structural
// changes (truncation/removal), same two-layer rationale as TrustedProfileList.
export type TrustedProfileMru = Cfc<
  WriteAuthorizedBy<
    PickerProfileLink<
      typeof setMruProfile,
      typeof TRUSTED_PROFILE_SET_MRU_ACTION
    >[],
    typeof setMruProfile
  >,
  { addIntegrity: ["profile-link"] }
>;

export type ProfileCreateInput = {
  profiles: Writable<BackwardsCompatibleProfile[]>;
  inputId?: string;
  // Optional prefill for the create field. Embedders often already know the
  // user's name (e.g. Loom asks at setup) — without this, first-run re-asks a
  // question the product already knows the answer to. UI PREFILL ONLY: it
  // seeds cf-submit-input's `initialValue`, which the component copies into
  // its own editable field state once, on first render (see
  // cf-submit-input.ts `willUpdate` / `_seeded`), and the field stays
  // uncontrolled after that. The create still flows through the same trusted
  // click — `submitProfileCreation` reads the name from the event at gesture
  // time exactly as before — so a prefilled value is a head start on typing,
  // never a shortcut around the gesture.
  defaultName?: string;

  /**
   * Home's private inbox, if the embedder has it, held as a profile holds its
   * pointer. Each profile this creates is pointed at it, unless the profile
   * points at an inbox already.
   */
  privateInbox?: ProfileInbox;
};

export type ProfileCreateOutput = {
  [NAME]: string;
  [UI]: VNode;
  createProfile: Stream<CreateProfileEvent>;
};

export default pattern<ProfileCreateInput, ProfileCreateOutput>(
  ({ profiles, inputId, defaultName, privateInbox }) => {
    const seedName = seedProfileName({
      profiles: profiles as any,
      privateInbox,
    });
    const createProfile = submitProfileCreation({
      profiles: profiles as any,
      seedName,
    });
    return {
      [NAME]: "Create Profile",
      createProfile,
      [UI]: (
        <cf-vstack
          id="profile-create-surface"
          data-ui-pattern={TRUSTED_PROFILE_CREATE_SURFACE}
          data-ui-event-integrity={TRUSTED_PROFILE_CREATE_SURFACE}
          gap="1"
        >
          {
            /* The submit-button click carries the typed name as
              event.target.value with this surface's trusted UI integrity, so
              the create needs no draft cell and the field self-clears.
              `initialValue` only seeds the field's starting text (a one-time,
              uncontrolled copy inside cf-submit-input) — it does not touch the
              trusted-click path. */
          }
          <cf-submit-input
            inputId={inputId ?? "profile-name-input"}
            data-ui-action={TRUSTED_PROFILE_CREATE_ACTION}
            placeholder="Your name..."
            buttonText="Create profile"
            initialValue={defaultName ?? ""}
            onClick={createProfile}
          />
        </cf-vstack>
      ),
    };
  },
);
