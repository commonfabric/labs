import {
  action,
  assert,
  computed,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

import {
  readSharedSpaceCatalog,
  registerSharedSpaceIn,
  type SharedSpaceCatalogStorage,
  type SharedSpaceProfileStanding,
  type SharedSpaceProfileStorage,
  type SharedSpaceRegistration,
  type SharedSpaceRegistrationResult,
} from "./shared-space-catalog.ts";
import {
  sharedSpaceCollectionViewOf,
  sharedSpaceProfileViewOf,
} from "./shared-space-interface.ts";

const LOOM = "did:key:profiles-loom";
const LEGACY = "did:key:profiles-legacy";
const BROKEN = "did:key:profiles-broken";
const RETIRED_LOOM = "did:key:profiles-retired-loom";
const STRANGER_LOOM = "did:key:profiles-stranger-loom";
const WORK = "did:key:profiles-work";
const PERSONAL = "did:key:profiles-personal";
const OLD = "did:key:profiles-old";
const STRANGER = "did:key:profiles-stranger";
const UNREADABLE = "did:key:profiles-unreadable-label";
const FOREIGN_LOOM = "did:key:profiles-foreign-loom";
const PLAIN_LOOM = "did:key:profiles-plain-loom";
const FROM = "did:key:profiles-sender";
const HOST = "https://loom.example";

/**
 * The spaces of the person's own profiles, by the label on their names,
 * retired ones among them.
 */
const OWN = [WORK, PERSONAL, OLD];

/** The spaces of the profiles Home lists as retired. */
const RETIRED = [OLD];

/**
 * What Home's lists say of the profile in `profile`, as Home's handler reads
 * them, failing for the one whose label cannot be read.
 */
const standing = (profile: string): SharedSpaceProfileStanding => {
  if (profile === UNREADABLE) throw new Error("The label cannot be read.");
  return !OWN.includes(profile)
    ? "unknown"
    : RETIRED.includes(profile)
    ? "retired"
    : "live";
};

/** The key of the receipt for the sender's offer keyed `id`. */
const offer = (id: string) => JSON.stringify([FROM, id]);

/** A saved `loom` entry for `space`, at its first revision. */
const entry = (space: string) => ({
  space,
  host: HOST,
  kind: "loom",
  state: "saved",
  revision: "1:entry",
});

/** What one registration returned, or the message of what it threw. */
type RegistrationOutcome = {
  result?: SharedSpaceRegistrationResult;
  error?: string;
};

/**
 * Registers the event's space in `catalog` from a handler of its own,
 * recording the profile the registration names in `records`, and records the
 * outcome, or the message of what the registration threw, as Home's
 * `registerSharedSpace` does with Home's records and profile list. Without
 * `records` it records no profile.
 */
const registerAndRecord = handler<
  SharedSpaceRegistration & { withoutRecords?: boolean },
  {
    catalog: Writable<SharedSpaceCatalogStorage>;
    records: Writable<SharedSpaceProfileStorage>;
    results: Writable<RegistrationOutcome[]>;
  }
>(({ withoutRecords, ...event }, { catalog, records, results }) => {
  try {
    results.push({
      result: registerSharedSpaceIn(
        catalog,
        event,
        withoutRecords ? undefined : { records, standing },
      ),
    });
  } catch (error) {
    results.push({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default pattern(() => {
  const catalog = new Writable<SharedSpaceCatalogStorage>({
    entries: {
      [LEGACY]: entry(LEGACY),
      [BROKEN]: entry(BROKEN),
      [RETIRED_LOOM]: entry(RETIRED_LOOM),
      [FOREIGN_LOOM]: entry(FOREIGN_LOOM),
    },
    offers: {},
  });
  const records = new Writable<SharedSpaceProfileStorage>({
    [BROKEN]: { space: BROKEN, profile: "not a did" },
    [RETIRED_LOOM]: { space: RETIRED_LOOM, profile: OLD },
    [FOREIGN_LOOM]: { space: FOREIGN_LOOM, profile: STRANGER },
  });
  const results = new Writable<RegistrationOutcome[]>([]);
  const register = registerAndRecord({ catalog, records, results });
  // Assertions read the catalog as Home's result does, validated.
  const stored = computed(() => readSharedSpaceCatalog(catalog));
  const view = computed(() =>
    sharedSpaceProfileViewOf(
      sharedSpaceCollectionViewOf(catalog.get()),
      records.get(),
      RETIRED,
      OWN,
    )
  );

  const action_register = action(() => {
    register.send({
      space: LOOM,
      host: HOST,
      kind: "loom",
      offer: { from: FROM, id: "work" },
      profile: WORK,
    });
  });
  const assert_recorded = assert(() =>
    results.get()[0]?.result?.status ===
      "registered" &&
    records.get()[LOOM]?.profile === WORK &&
    records.get()[LOOM]?.space === LOOM &&
    stored.offers[offer("work")]?.space === LOOM
  );

  // The same profile again, under another offer, is a replay: the space's
  // entry and record stay, and the offer's receipt is added.
  const action_replay = action(() => {
    register.send({
      space: LOOM,
      host: HOST,
      kind: "loom",
      offer: { from: FROM, id: "again" },
      profile: WORK,
    });
  });
  const assert_replay_keeps_record = assert(() =>
    results.get()[1]?.result?.status ===
      "existing" &&
    records.get()[LOOM]?.profile === WORK &&
    stored.offers[offer("again")]?.space === LOOM
  );

  const action_compete = action(() => {
    register.send({
      space: LOOM,
      host: HOST,
      kind: "loom",
      offer: { from: FROM, id: "personal" },
      profile: PERSONAL,
    });
  });
  // The competing offer is registered all the same; only its profile is
  // refused, which its receipt says.
  const assert_competing_conflicts = assert(() => {
    const result = results.get()[2]?.result;
    return result?.status === "conflict" && result.reason === "profile" &&
      "registration" in result && result.registration === "existing" &&
      records.get()[LOOM]?.profile === WORK &&
      stored.offers[offer("personal")]?.space === LOOM &&
      stored.offers[offer("personal")]?.profileConflict === "profile" &&
      stored.offers[offer("work")]?.profileConflict === undefined;
  });

  const action_name_none = action(() => {
    register.send({ space: LOOM, host: HOST, kind: "loom" });
  });
  const assert_none_keeps_record = assert(() =>
    results.get()[3]?.result?.status ===
      "existing" &&
    records.get()[LOOM]?.profile === WORK
  );

  // A space registered before profiles were recorded gains one from a
  // registration naming it.
  const action_record_legacy = action(() => {
    register.send({ space: LEGACY, host: HOST, kind: "loom", profile: WORK });
  });
  const assert_legacy_recorded = assert(() =>
    results.get()[4]?.result?.status ===
      "existing" &&
    records.get()[LEGACY]?.profile === WORK &&
    stored.entries[LEGACY]?.revision === "1:entry"
  );

  const action_stranger = action(() => {
    register.send({
      space: STRANGER_LOOM,
      host: HOST,
      kind: "loom",
      profile: STRANGER,
    });
  });
  const assert_stranger_registers_without_profile = assert(() => {
    const result = results.get()[5]?.result;
    return result?.status === "conflict" &&
      result.reason === "unknown-profile" &&
      "registration" in result && result.registration === "registered" &&
      stored.entries[STRANGER_LOOM]?.state === "saved" &&
      records.get()[STRANGER_LOOM] === undefined;
  });

  const action_over_unreadable = action(() => {
    register.send({ space: BROKEN, host: HOST, kind: "loom", profile: WORK });
  });
  const assert_unreadable_kept = assert(() => {
    const result = results.get()[6]?.result;
    return result?.status === "conflict" && result.reason === "profile" &&
      records.get()[BROKEN]?.profile === "not a did";
  });

  // A conflict over the route writes no record either.
  const action_route_conflict = action(() => {
    register.send({
      space: LEGACY,
      host: "https://elsewhere.example",
      kind: "loom",
      profile: PERSONAL,
    });
  });
  const assert_route_conflict_keeps_record = assert(() => {
    const result = results.get()[7]?.result;
    return result?.status === "conflict" && result.reason === "host" &&
      records.get()[LEGACY]?.profile === WORK;
  });

  const action_without_records = action(() => {
    register.send({
      space: "did:key:profiles-unrecordable",
      host: HOST,
      kind: "loom",
      profile: WORK,
      withoutRecords: true,
    });
  });
  const assert_without_records_throws = assert(() =>
    results.get()[8]?.error !== undefined &&
    stored.entries["did:key:profiles-unrecordable"] === undefined
  );

  // A new record needs one of the person's live profiles, so a retired one is
  // refused for a space that has none, while naming the retired profile a
  // record already names records nothing new.
  const action_retired = action(() => {
    register.send({
      space: "did:key:profiles-new-for-retired",
      host: HOST,
      kind: "loom",
      profile: OLD,
    });
    register.send({
      space: RETIRED_LOOM,
      host: HOST,
      kind: "loom",
      profile: OLD,
    });
  });
  const assert_retired_refused_and_replay_kept = assert(() => {
    const fresh = results.get()[9]?.result;
    const replay = results.get()[10]?.result;
    return fresh?.status === "conflict" &&
      fresh.reason === "unknown-profile" &&
      records.get()["did:key:profiles-new-for-retired"] === undefined &&
      replay?.status === "existing" &&
      records.get()[RETIRED_LOOM]?.profile === OLD;
  });

  // A receipt that an earlier registration naming no profile left takes the
  // conflict of a later one naming a profile it cannot record.
  const action_existing_receipt = action(() => {
    register.send({
      space: PLAIN_LOOM,
      host: HOST,
      kind: "loom",
      offer: { from: FROM, id: "plain" },
    });
    register.send({
      space: PLAIN_LOOM,
      host: HOST,
      kind: "loom",
      offer: { from: FROM, id: "plain" },
      profile: STRANGER,
    });
  });
  const assert_existing_receipt_conflicted = assert(() => {
    const result = results.get()[12]?.result;
    return result?.status === "conflict" &&
      result.reason === "unknown-profile" &&
      stored.offers[offer("plain")]?.profileConflict === "unknown-profile";
  });

  // A label that cannot be read fails the registration, which writes nothing,
  // so it is not taken for a profile that is not the person's.
  const action_unreadable_label = action(() => {
    register.send({
      space: "did:key:profiles-unreadable-loom",
      host: HOST,
      kind: "loom",
      offer: { from: FROM, id: "unreadable" },
      profile: UNREADABLE,
    });
  });
  const assert_unreadable_label_writes_nothing = assert(() =>
    results.get()[13]?.error !== undefined &&
    stored.entries["did:key:profiles-unreadable-loom"] === undefined &&
    stored.offers[offer("unreadable")] === undefined
  );

  const assert_view_tells_states_apart = assert(() => {
    if (view.status !== "ready") return false;
    const spaces = view.spaces;
    const loom = spaces[LOOM];
    const retiredLoom = spaces[RETIRED_LOOM];
    const foreignLoom = spaces[FOREIGN_LOOM];
    return loom?.status === "live" && loom.profile === WORK &&
      spaces[BROKEN]?.status === "unreadable" &&
      retiredLoom?.status === "retired" && retiredLoom.profile === OLD &&
      spaces[STRANGER_LOOM]?.status === "unrecorded" &&
      foreignLoom?.status === "foreign" && foreignLoom.profile === STRANGER &&
      spaces["did:key:profiles-unrecordable"] === undefined;
  });

  const assert_view_unavailable = assert(() => {
    const ready = sharedSpaceCollectionViewOf(catalog.get());
    const loading = sharedSpaceProfileViewOf(ready, undefined, RETIRED, OWN);
    const retiredLoading = sharedSpaceProfileViewOf(ready, {}, undefined, OWN);
    const ownLoading = sharedSpaceProfileViewOf(ready, {}, RETIRED, undefined);
    const malformed = sharedSpaceProfileViewOf(ready, [], RETIRED, OWN);
    const unreadableRetired = sharedSpaceProfileViewOf(
      ready,
      {},
      [undefined],
      OWN,
    );
    const unreadableOwn = sharedSpaceProfileViewOf(ready, {}, RETIRED, [
      undefined,
    ]);
    const catalogMalformed = sharedSpaceProfileViewOf(
      sharedSpaceCollectionViewOf({ entries: [] }),
      {},
      RETIRED,
      OWN,
    );
    const unrecorded = sharedSpaceProfileViewOf(ready, {}, RETIRED, OWN);
    return loading.status === "unavailable" &&
      loading.reason === "loading" &&
      retiredLoading.status === "unavailable" &&
      retiredLoading.reason === "loading" &&
      ownLoading.status === "unavailable" &&
      ownLoading.reason === "loading" &&
      unreadableOwn.status === "unavailable" &&
      unreadableOwn.reason === "malformed" &&
      malformed.status === "unavailable" &&
      malformed.reason === "malformed" &&
      unreadableRetired.status === "unavailable" &&
      unreadableRetired.reason === "malformed" &&
      catalogMalformed.status === "unavailable" &&
      catalogMalformed.reason === "malformed" &&
      unrecorded.status === "ready" &&
      unrecorded.spaces[LOOM]?.status === "unrecorded";
  });

  return {
    [TESTS]: [
      { action: action_register },
      { assertion: assert_recorded },
      { action: action_replay },
      { assertion: assert_replay_keeps_record },
      { action: action_compete },
      { assertion: assert_competing_conflicts },
      { action: action_name_none },
      { assertion: assert_none_keeps_record },
      { action: action_record_legacy },
      { assertion: assert_legacy_recorded },
      { action: action_stranger },
      { assertion: assert_stranger_registers_without_profile },
      { action: action_over_unreadable },
      { assertion: assert_unreadable_kept },
      { action: action_route_conflict },
      { assertion: assert_route_conflict_keeps_record },
      { action: action_without_records },
      { assertion: assert_without_records_throws },
      { action: action_retired },
      { assertion: assert_retired_refused_and_replay_kept },
      { action: action_existing_receipt },
      { assertion: assert_existing_receipt_conflicted },
      { action: action_unreadable_label },
      { assertion: assert_unreadable_label_writes_nothing },
      { assertion: assert_view_tells_states_apart },
      { assertion: assert_view_unavailable },
    ],
  };
});
