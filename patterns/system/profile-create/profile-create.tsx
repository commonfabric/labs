import {
  type Cell,
  Cfc,
  equals,
  handler,
  linksOf,
  NAME,
  pattern,
  profileOwnerOf,
  resultOwnerOf,
  spaceOf,
  Stream,
  UI,
  type VNode,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import ProfileHome, {
  type BackwardsCompatibleProfile,
  type InboxPointable,
  nameHasControlCharacter,
  pointAtInboxIfUnset,
  type ProfileInbox,
  type SetProfileNameEvent,
} from "../profile-home/profile-home.tsx";

// Trusted UI surfaces / actions. The create surface authorizes appending a new
// profile to the home `profiles` list; the picker surface authorizes setting the
// default profile and stamping most-recently-used (MRU).
export const TRUSTED_PROFILE_CREATE_SURFACE = "ProfileCreateSurface";
export const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";
export const TRUSTED_PROFILE_PICKER_SURFACE = "ProfilePickerSurface";
export const TRUSTED_PROFILE_SET_DEFAULT_ACTION = "SetDefaultProfile";
export const TRUSTED_PROFILE_SET_MRU_ACTION = "SetMruProfile";

/**
 * A link to a profile, as Home's lists hold one: read as the cell it names,
 * never as the profile's value, so that reading a list loads no profile and a
 * profile whose space has not loaded here still counts.
 */
export type ProfileLink = Cell<BackwardsCompatibleProfile>;

export type CreateProfileEvent = {
  detail?: { message?: string };
  key?: string;
  name?: string;
  target?: { value?: string };
};

/**
 * The seed step's event: the name typed at creation, and the profile that
 * creation made.
 */
export type SeedProfileNameEvent = {
  name: string;
  // A value, not a `Cell<…>`: the create sends a link, which the runner
  // resolves before the body runs (see `seedProfileName`).
  profile: SeedProfileTarget;
};

/**
 * What the seed step needs of the profile it seeds: the stored name (to write
 * only where none is stored yet) and the stream it writes through, and what
 * pointing the profile at Home's private inbox needs. The profile is the one
 * just created, so it is current-vintage by construction and carries
 * `setName`.
 */
export type SeedProfileTarget = InboxPointable & {
  name: string;
  setName: Stream<SetProfileNameEvent>;
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
// is queued behind the create in the same runtime. It names the new profile
// by its link, and reads no list: a read of Home's `profiles` here can run
// before the create's append is visible to it, and find no entry for the
// profile.
//
// The profile rides the event as a link and is bound as a VALUE: before the
// body runs, the runner loads the documents the handler's argument reaches
// through the event (the handler's `presyncInputs`) and resolves the
// argument against this schema. An event whose profile does not resolve
// reaches the body as `undefined`, and the step fails rather than leave the
// name unstored. Only a profile whose stored `name` is still empty is
// written: a re-delivery of this event, or the same profile seeded
// elsewhere, is left alone.
export const seedProfileName = handler<
  SeedProfileNameEvent,
  { privateInbox?: ProfileInbox }
>((event, { privateInbox }) => {
  if (event === undefined) {
    throw new Error(
      "Cannot seed a profile's name: the event lacks a name or a profile, " +
        "or its profile does not resolve.",
    );
  }
  const name = event.name.trim();
  if (!name) {
    throw new Error("Cannot seed a profile's name with an empty name.");
  }
  const target = event.profile;
  if (target.name !== "") return;
  // The profile is pointed at Home's private inbox here, after its create has
  // committed, for the same reason its name is stored here. Home's own pointing
  // step runs once per runtime worker, so a profile created later would
  // otherwise wait for the next worker.
  pointAtInboxIfUnset(target, privateInbox);
  target.setName.send({ name });
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
// `createPatternFrame` cause). The space is created with a random DID, so a
// profile is unique per user AND per creation event, and stable across the
// cross-space-commit retry. The space owns itself (`selfOwned`): its access
// list grants its own DID OWNER and the creating user nothing, and the user
// holds instead a delegation the space's key issued before being destroyed,
// recorded in the home space beside the allocation and presented when the
// user's runtime opens the space (docs/specs/profile-delegation.md). The
// space declares the `profile` kind. The display name flows ONLY to
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
  if (nameHasControlCharacter(name)) {
    throw new Error("A profile name cannot contain control characters.");
  }
  if (name) {
    const profile = ProfileHome.inSpace(undefined, {
      grants: { "*": "WRITE" },
      root: true,
      spaceKind: "profile",
      selfOwned: true,
    })({
      initialName: name,
    });
    profiles.push(profile);
    // Queued behind this create; stores the name once the profile is live
    // (see `seedProfileName`).
    seedName.send({ name, profile });
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
    // Absent for a home without the slot, whose picker offers no "Set
    // default"; an event sent there all the same is refused.
    defaultProfile?: Writable<DefaultProfileSlot>;
    // Take the profile as a LINK cell, not a resolved value: the handler only
    // needs the link to write into defaultProfile, and a link argument doesn't
    // require the profile's cross-space values to be loaded at event time —
    // resolving the full value here would fail required-field validation
    // ("stream action argument is undefined … not running") whenever the
    // profile's space hasn't materialized locally yet.
    profile: ProfileLink;
  }
>((_, { defaultProfile, profile }) => {
  if (defaultProfile === undefined) {
    throw new Error("Cannot set a default: this home has no default slot.");
  }
  if (profile) {
    defaultProfile.key("profile").set(profile);
  }
});

// Stamps a profile as most-recently-used: prepend to the MRU list (deduped by
// link identity). Drives the picker's "default first, then by MRU" ordering.
export const setMruProfile = handler<
  unknown,
  {
    // Read and written as the links it holds, whatever profiles they name.
    mru: Writable<unknown[]>;
    // Link cell, not a resolved value — same event-time-validation reason as
    // setDefaultProfile above.
    profile: ProfileLink;
  }
>((_, { mru, profile }) => {
  if (!profile) return;
  // The entries are read as the links they are (`linksOf()`), not inlined
  // values, so an entry that links into an unloaded space doesn't collapse
  // the whole read to `undefined` and silently wipe MRU history. Dedup by link
  // identity via `equals`.
  const filtered = (linksOf(mru) ?? []).filter((entry) =>
    !equals(entry, profile)
  );
  mru.set([profile, ...filtered]);
});

/**
 * The profile a retire or a restore acts on, as a link. A picker row binds
 * its own profile to the handler instead; Home's streams take it from the
 * event.
 */
export type ProfileRetirementEvent = {
  profile?: ProfileLink;
};

/**
 * The space of the profile a home's default names: the link under `profile`
 * in its slot `defaultProfile`, or, while that slot names none,
 * `legacyDefaultProfileSpace`, the space of a default chosen before the slot
 * (Home's `legacyDefaultProfileSpace`). A link into `homeSpace` names none,
 * and so does a home with neither.
 */
export const defaultProfileSpace = (
  defaultProfile: Cell<DefaultProfileSlot> | undefined,
  legacyDefaultProfileSpace: Cell<string | undefined> | undefined,
  homeSpace: string | undefined,
): string | undefined => {
  const named = (space: string | undefined) =>
    space !== homeSpace ? space : undefined;
  // The space of the profile the slot's link names, or the slot's own, Home's,
  // while it holds none.
  return named(spaceOf(defaultProfile?.key("profile"))) ??
    named(legacyDefaultProfileSpace?.get());
};

/**
 * Whether the profile `link` names is one of the user's own, `owner` being
 * the user's DID: `profileOwnerOf()` names them, by the rule the runner's
 * `profileOwnership()` applies to `#profile`. A profile whose document is
 * absent carries no label, so it is no one's.
 */
export const isOwnProfile = <T,>(
  link: Cell<T> | undefined,
  owner: string | undefined,
) => owner !== undefined && profileOwnerOf(link) === owner;

/**
 * The spaces of the profiles in `profiles` that are the user's own
 * (`isOwnProfile()`), retired or not, in list order, `homeSpace` being the
 * user's DID; a link into `homeSpace` names none. It is called from a handler
 * or a reactive computation, since it reads labels.
 */
export const ownProfileSpaces = <T,>(
  profiles: Cell<T[]>,
  homeSpace: string | undefined,
): string[] =>
  (linksOf(profiles) ?? [])
    .filter((link) => isOwnProfile(link, homeSpace))
    .map((link): string | undefined => spaceOf(link))
    .filter((space): space is string =>
      space !== undefined && space !== homeSpace
    );

/** Home's profile lists, as `liveProfileSpaces()` reads them. */
export type ProfileLists = {
  /** Home's `profiles` list. */
  profiles: Cell<BackwardsCompatibleProfile[]>;

  /** Home's default profile slot, `DefaultProfileSlot`, if bound. */
  defaultProfile?: Cell<DefaultProfileSlot>;

  /**
   * The space of a default a home chose before `defaultProfile`, Home's
   * `legacyDefaultProfileSpace`, if bound.
   */
  legacyDefaultProfileSpace?: Cell<string | undefined>;

  /** Home's `mru` list. */
  mru: Cell<unknown[]>;

  /** Home's `retiredProfiles` list, if bound. */
  retiredProfiles?: Cell<unknown[]>;
};

/**
 * The spaces of the user's live profiles, the ones in `profiles` that are
 * the user's own (`isOwnProfile()`) and that are not in
 * `retiredProfiles`, in the order `#profile` returns them for a runtime that
 * names no preferred profile: the default first, unless it is retired, then
 * by rank in `mru`, then in list order. The first is the profile `#profile`
 * returns. Profiles are compared by their own space, and a link into
 * `homeSpace`, the user's DID, names none. This is the order the runner's
 * `orderProfileCandidates()` decides `#profile` by, which pattern code cannot
 * import. It is called from a handler or a reactive computation, since it
 * reads labels.
 */
export const liveProfileSpaces = (
  lists: ProfileLists,
  homeSpace: string | undefined,
): string[] => {
  const spaces = (
    list: Cell<unknown[]> | undefined,
  ): (string | undefined)[] =>
    (linksOf(list) ?? []).map((link) => spaceOf(link));
  const retired = new Set(spaces(lists.retiredProfiles));
  const live = ownProfileSpaces(lists.profiles, homeSpace).filter((space) =>
    !retired.has(space)
  );
  const preferred = defaultProfileSpace(
    lists.defaultProfile,
    lists.legacyDefaultProfileSpace,
    homeSpace,
  );
  const mru = spaces(lists.mru);
  const rank = (space: string): number => {
    if (space === preferred) return -1;
    const index = mru.indexOf(space);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  // `sort()` is stable, so profiles of equal rank keep their list order.
  return live.sort((a, b) => rank(a) - rank(b));
};

// Retires one of the user's profiles, with `retired` set, or restores one,
// without it: Home's `retireProfile` and `restoreProfile` streams are its two
// bindings, and it is the one writer of Home's `retiredProfiles` list.
//
// Retiring appends the profile's link to the list. A retired profile is not
// one of the user's profiles: `#profile` never answers with it and leaves it
// out of its candidates, and the picker lists it only among the removed
// profiles it can restore. Its link stays in `profiles`, and its space and
// data stay on the host, so a link to it held elsewhere still shows it, and
// restoring makes it one of the user's profiles again. A profile already
// retired, compared by its own space as `#profile` compares profiles, is left
// as it is.
//
// Any pattern that reaches Home's streams can send a retirement, as it can a
// profile's rename, so retiring refuses a profile that is not one of the
// user's live profiles, those `profiles` lists that are the user's own
// (`ownProfileSpaces()`) and not retired, which keeps the list from holding
// anything else. It also refuses the profile `#profile` returns for a
// runtime that names no preferred profile, the first of
// `liveProfileSpaces()`: retiring it would quietly move `#profile` to another
// profile. That is the default when one is set, and otherwise the most
// recently used live profile, or the first listed. The person sets another
// profile as the default first. The last live profile is always that
// profile, so it is never retired. The guard decides by the lists and slots
// the handler is bound to, so it refuses a binding missing any of them, and
// one where any is not the field of that name of the result that owns the
// retired list (`resultOwnerOf()`), as each of Home's is.
//
// Restoring removes every link in the list into the space of the profile the
// row binds or the event names, whatever it names, so that a link the list
// came to hold some other way can be cleared. A profile that is not retired
// is left as it is.
export const setProfileRetired = handler<
  ProfileRetirementEvent,
  {
    profiles: Writable<BackwardsCompatibleProfile[]>;
    mru: Writable<BackwardsCompatibleProfile[]>;
    // Written, so read and written as the links it holds, whatever profiles
    // they name.
    retiredProfiles: Writable<unknown[]>;
    defaultProfile?: Writable<DefaultProfileSlot>;
    legacyDefaultProfileSpace?: Cell<string | undefined>;
    profile?: ProfileLink;
    retired: boolean;
  }
>((event, state) => {
  const target = state.profile ?? event.profile;
  const space = spaceOf(target);
  if (target === undefined || space === undefined) {
    throw new Error(
      `Cannot ${state.retired ? "retire" : "restore"} a profile: the event ` +
        "names no profile.",
    );
  }
  const { retiredProfiles } = state;
  const retired = linksOf(retiredProfiles) ?? [];
  if (!state.retired) {
    const kept = retired.filter((entry) => spaceOf(entry) !== space);
    if (kept.length !== retired.length) retiredProfiles.set(kept);
    return;
  }
  const { profiles, mru, defaultProfile, legacyDefaultProfileSpace } = state;
  // Each list must be the field of its name of the one result that owns the
  // retired list, which names no owner for a slot left unbound.
  const owners = new Set([
    resultOwnerOf(profiles, "profiles"),
    resultOwnerOf(mru, "mru"),
    resultOwnerOf(retiredProfiles, "retiredProfiles"),
    resultOwnerOf(defaultProfile, "defaultProfile"),
    resultOwnerOf(legacyDefaultProfileSpace, "legacyDefaultProfileSpace"),
  ]);
  if (owners.size !== 1 || owners.has(undefined)) {
    throw new Error(
      "Cannot retire a profile: the lists this handler was bound to are " +
        "not one Home's own.",
    );
  }
  const live = liveProfileSpaces(
    {
      profiles,
      defaultProfile,
      legacyDefaultProfileSpace,
      mru,
      retiredProfiles,
    },
    spaceOf(retiredProfiles),
  );
  if (retired.some((entry) => spaceOf(entry) === space)) return;
  if (!live.includes(space)) {
    throw new Error(
      "Cannot retire a profile that is not one of the profiles this home " +
        "lists as the user's own.",
    );
  }
  if (live[0] === space) {
    throw new Error(
      live.length === 1
        ? "Cannot retire the user's only profile."
        : "Cannot retire the profile `#profile` returns: set another " +
          "profile as the default first.",
    );
  }
  // The list links the profile's own document, which carries the labels a
  // link into the protected list is checked against, rather than whatever
  // link the event or the row holds on the way to it.
  retiredProfiles.set([...retired, target.resolveAsCell()]);
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

// The home `retiredProfiles` list. The container and each element are
// written by `setProfileRetired` and no other handler: the element policy
// gates adding or replacing a link, and the container policy gates the
// structural changes (truncation / removal / reorder) the element policy
// misses, for the reason `TrustedProfileList` gives. It asks for no gesture,
// so any pattern that reaches Home's streams can retire or restore a profile
// by sending their events, as it can rename one; what the policies rule out
// is a write by anything else.
export type TrustedRetiredProfileList = Cfc<
  WriteAuthorizedBy<
    Cfc<
      WriteAuthorizedBy<
        Cell<BackwardsCompatibleProfile>,
        typeof setProfileRetired
      >,
      { addIntegrity: ["profile-link"] }
    >[],
    typeof setProfileRetired
  >,
  { addIntegrity: ["profile-link"] }
>;

// Home's earlier default: a link at the root of a cell of its own, the shape a
// home held its default in before the `defaultProfile` slot, and the default
// while the slot holds none. Nothing writes it now. Its write contract names
// `setDefaultProfile`, which writes the slot instead, so that nothing else can
// replace the earlier default either.
export type TrustedLegacyDefaultProfile = WriteAuthorizedBy<
  BackwardsCompatibleProfile,
  typeof setDefaultProfile
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
    const seedName = seedProfileName({ privateInbox });
    const createProfile = submitProfileCreation({
      profiles,
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
