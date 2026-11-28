/**
 * Home's `registerSharedSpace` records the profile a registration names only
 * when Home's own lists say it is one of the person's live profiles: a
 * profile Home's create made, listed and not retired. A retired profile and
 * one Home does not list register the space with an `unknown-profile`
 * conflict on the offer's receipt and record nothing, and restoring the
 * retired profile lets the same offer record it. A binding whose catalog and
 * records are not Home's own refuses a registration naming a profile, and
 * still registers one naming none.
 *
 * Run: deno task cf test patterns/system/shared-space/shared-space-catalog.home-standing.test.tsx --verbose
 */
import {
  action,
  assert,
  pattern,
  spaceOf,
  TESTS,
  Writable,
} from "commonfabric";
import Home from "../home/home.tsx";
import {
  TRUSTED_PROFILE_CREATE_ACTION,
  TRUSTED_PROFILE_CREATE_SURFACE,
} from "../profile-create/profile-create.tsx";
import {
  registerSharedSpace,
  type SharedSpaceCatalogStorage,
  type SharedSpaceProfileStorage,
  type SharedSpaceRegistration,
} from "./shared-space-catalog.ts";

const CREATE = {
  surface: TRUSTED_PROFILE_CREATE_SURFACE,
  action: TRUSTED_PROFILE_CREATE_ACTION,
};

const HOST = "https://loom.example";
const FROM = "did:key:standing-sender";
const LIVE_LOOM = "did:key:standing-live-loom";
const RETIRED_LOOM = "did:key:standing-retired-loom";
const STRANGER_LOOM = "did:key:standing-stranger-loom";
const STRANGER = "did:key:standing-stranger-profile";
const LOOSE_NAMED = "did:key:standing-loose-named";
const LOOSE_PLAIN = "did:key:standing-loose-plain";

/** The key of the receipt for the sender's offer keyed `id`. */
const offerKey = (id: string) => JSON.stringify([FROM, id]);

/** A registration of `space` from the offer keyed `id`, naming `profile`. */
const registration = (
  space: string,
  id: string,
  profile: string | undefined,
): SharedSpaceRegistration => ({
  space,
  host: HOST,
  kind: "loom",
  offer: { from: FROM, id },
  ...(profile === undefined ? {} : { profile }),
});

export default pattern(() => {
  const home = Home({});
  // A binding over Home's profile lists, with a catalog and records of no
  // Home's.
  const looseCatalog = new Writable<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  });
  const looseRecords = new Writable<SharedSpaceProfileStorage>({});
  const loose = registerSharedSpace({
    catalog: looseCatalog,
    sharedSpaceProfiles: looseRecords,
    profiles: home.profiles,
    retiredProfiles: home.retiredProfiles,
  });

  const action_retire_alan = action(() =>
    home.retireProfile.send({ profile: home.profiles.get()[1] })
  );
  const action_register = action(() => {
    home.registerSharedSpace.send(
      registration(LIVE_LOOM, "live", spaceOf(home.profiles.get()[0])),
    );
    home.registerSharedSpace.send(
      registration(RETIRED_LOOM, "retired", spaceOf(home.profiles.get()[1])),
    );
    home.registerSharedSpace.send(
      registration(STRANGER_LOOM, "stranger", STRANGER),
    );
  });
  const assert_only_live_recorded = assert(() => {
    const records = home.sharedSpaceProfiles.get();
    const { entries, offers } = home.sharedSpaceCatalog;
    return records[LIVE_LOOM]?.profile === spaceOf(home.profiles.get()[0]) &&
      offers[offerKey("live")]?.space === LIVE_LOOM &&
      offers[offerKey("live")]?.profileConflict === undefined &&
      records[RETIRED_LOOM] === undefined &&
      entries[RETIRED_LOOM]?.state === "saved" &&
      offers[offerKey("retired")]?.profileConflict === "unknown-profile" &&
      records[STRANGER_LOOM] === undefined &&
      entries[STRANGER_LOOM]?.state === "saved" &&
      offers[offerKey("stranger")]?.profileConflict === "unknown-profile";
  });

  const action_restore_alan = action(() =>
    home.restoreProfile.send({ profile: home.profiles.get()[1] })
  );
  const action_register_restored = action(() =>
    home.registerSharedSpace.send(
      registration(RETIRED_LOOM, "retired", spaceOf(home.profiles.get()[1])),
    )
  );
  const assert_restored_recorded = assert(() =>
    home.sharedSpaceProfiles.get()[RETIRED_LOOM]?.profile ===
      spaceOf(home.profiles.get()[1]) &&
    home.sharedSpaceCatalog.offers[offerKey("retired")]?.profileConflict ===
      undefined
  );

  const action_register_loosely = action(() => {
    loose.send({
      space: LOOSE_NAMED,
      host: HOST,
      kind: "loom",
      profile: STRANGER,
    });
    loose.send({ space: LOOSE_PLAIN, host: HOST, kind: "loom" });
  });
  const assert_loose_refuses_profiles = assert(() =>
    looseCatalog.get().entries[LOOSE_NAMED] === undefined &&
    looseRecords.get()[LOOSE_NAMED] === undefined &&
    looseCatalog.get().entries[LOOSE_PLAIN]?.state === "saved"
  );

  return {
    [TESTS]: [
      { action: home.createProfile, event: { name: "Ada" }, trustedUi: CREATE },
      {
        action: home.createProfile,
        event: { name: "Alan" },
        trustedUi: CREATE,
      },
      { assertion: assert(() => home.profiles.get().length === 2) },
      { action: action_retire_alan },
      {
        assertion: assert(() =>
          spaceOf(home.retiredProfiles.get()[0]) ===
            spaceOf(home.profiles.get()[1])
        ),
      },
      { action: action_register },
      { assertion: assert_only_live_recorded },
      { action: action_restore_alan },
      { action: action_register_restored },
      { assertion: assert_restored_recorded },
      { action: action_register_loosely },
      { assertion: assert_loose_refuses_profiles },
    ],
    home,
    // The loose binding's registration naming a profile.
    expectRuntimeErrors: 1,
  };
});
