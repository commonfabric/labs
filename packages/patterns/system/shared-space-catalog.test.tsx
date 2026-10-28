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
  changeSharedSpaceMembershipIn,
  readSharedSpaceCatalog,
  registerSharedSpaceIn,
  retitleSharedSpaceIn,
  type SharedSpaceCatalogStorage,
  type SharedSpaceMembershipChange,
  type SharedSpaceMembershipResult,
  type SharedSpaceRegistration,
  type SharedSpaceRegistrationResult,
  type SharedSpaceRetitle,
  type SharedSpaceRetitleResult,
} from "./shared-space-catalog.ts";

const ROOM = "did:key:catalog-core-room";
const ARCHIVED = "did:key:catalog-core-archived";
const SAVED = "did:key:catalog-core-saved";
const FROM = "did:key:catalog-core-sender";
const HOST = "https://room.example";
const FIRST_OFFER = JSON.stringify([FROM, "first"]);
const AGAIN_OFFER = JSON.stringify([FROM, "again"]);
const CONFLICTING_OFFER = JSON.stringify([FROM, "conflicting"]);

/**
 * Registers the event's space in `catalog` from a handler of its own, which
 * also records the room the registration is for and the outcome, all in one
 * transaction, as a room's creator registers the room it creates.
 */
const createAndRegister = handler<
  SharedSpaceRegistration,
  {
    catalog: Writable<SharedSpaceCatalogStorage>;
    rooms: Writable<string[]>;
    results: Writable<SharedSpaceRegistrationResult[]>;
  }
>((event, { catalog, rooms, results }) => {
  rooms.push(event.space);
  results.push(registerSharedSpaceIn(catalog, event));
});

/**
 * Applies the event's membership choice in `catalog` from a handler of its
 * own, which also records the space the choice is for and the outcome, all in
 * one transaction, as forgetting a room archives its entry.
 */
const chooseAndRecord = handler<
  SharedSpaceMembershipChange,
  {
    catalog: Writable<SharedSpaceCatalogStorage>;
    chosen: Writable<string[]>;
    outcomes: Writable<SharedSpaceMembershipResult[]>;
  }
>((event, { catalog, chosen, outcomes }) => {
  chosen.push(event.space);
  outcomes.push(changeSharedSpaceMembershipIn(catalog, event));
});

/**
 * Retitles the event's space in `catalog` from a handler of its own, which
 * also records the outcome, in one transaction, as a manager refreshes the
 * title of a room it lists.
 */
const retitleAndRecord = handler<
  SharedSpaceRetitle,
  {
    catalog: Writable<SharedSpaceCatalogStorage>;
    retitles: Writable<SharedSpaceRetitleResult[]>;
  }
>((event, { catalog, retitles }) => {
  retitles.push(retitleSharedSpaceIn(catalog, event));
});

export default pattern(() => {
  const catalog = new Writable<SharedSpaceCatalogStorage>({
    entries: {
      [ARCHIVED]: {
        space: ARCHIVED,
        host: HOST,
        kind: "fabrichat-room",
        state: "archived",
        revision: "2:archived",
      },
      [SAVED]: {
        space: SAVED,
        host: HOST,
        kind: "fabrichat-room",
        state: "saved",
        revision: "1:saved",
      },
    },
    offers: {},
  });
  const rooms = new Writable<string[]>([]);
  const results = new Writable<SharedSpaceRegistrationResult[]>([]);
  const register = createAndRegister({ catalog, rooms, results });
  const chosen = new Writable<string[]>([]);
  const outcomes = new Writable<SharedSpaceMembershipResult[]>([]);
  const choose = chooseAndRecord({ catalog, chosen, outcomes });
  const retitles = new Writable<SharedSpaceRetitleResult[]>([]);
  const retitle = retitleAndRecord({ catalog, retitles });
  // Assertions read the catalog as Home's result does, validated.
  const view = computed(() => readSharedSpaceCatalog(catalog));

  const action_register = action(() => {
    register.send({
      space: ROOM,
      host: HOST,
      kind: "fabrichat-room",
      title: "Our room",
      offer: { from: FROM, id: "first" },
    });
  });
  const assert_registered_with_own_write = assert(() =>
    results.get()[0]?.status === "registered" &&
    rooms.get()[0] === ROOM &&
    view.entries[ROOM]?.state === "saved" &&
    view.entries[ROOM]?.from === FROM &&
    view.entries[ROOM]?.title === "Our room" &&
    view.offers[FIRST_OFFER]?.space === ROOM
  );

  const action_register_again = action(() => {
    register.send({
      space: ROOM,
      host: HOST,
      kind: "fabrichat-room",
      title: "Another title",
      offer: { from: FROM, id: "first" },
    });
  });
  const assert_existing_unchanged = assert(() =>
    results.get()[1]?.status === "existing" &&
    rooms.get().length === 2 &&
    view.entries[ROOM]?.title === "Our room" &&
    Object.keys(view.offers).length === 1
  );

  const action_offer_archived = action(() => {
    register.send({
      space: ARCHIVED,
      host: HOST,
      kind: "fabrichat-room",
      offer: { from: FROM, id: "again" },
    });
  });
  const assert_archived_stays_archived = assert(() =>
    results.get()[2]?.status === "existing" &&
    view.entries[ARCHIVED]?.state === "archived" &&
    view.entries[ARCHIVED]?.revision === "2:archived" &&
    view.offers[AGAIN_OFFER]?.space === ARCHIVED
  );

  const action_conflicting_kind = action(() => {
    register.send({
      space: ROOM,
      host: HOST,
      kind: "loom",
      offer: { from: FROM, id: "conflicting" },
    });
  });
  const assert_conflict_writes_nothing = assert(() =>
    results.get()[3]?.status === "conflict" &&
    view.entries[ROOM]?.kind === "fabrichat-room" &&
    view.offers[CONFLICTING_OFFER] === undefined &&
    Object.keys(view.offers).length === 2
  );

  const action_archive = action(() => {
    choose.send({
      space: SAVED,
      id: "archive",
      expectedRevision: "1:saved",
      state: "archived",
    });
  });
  const assert_archived_with_own_write = assert(() =>
    outcomes.get()[0]?.status === "applied" &&
    chosen.get()[0] === SAVED &&
    view.entries[SAVED]?.state === "archived" &&
    view.entries[SAVED]?.revision.startsWith("2:") === true
  );

  const action_archive_again = action(() => {
    choose.send({
      space: SAVED,
      id: "archive",
      expectedRevision: "1:saved",
      state: "archived",
    });
  });
  const assert_repeat_confirmed = assert(() =>
    outcomes.get()[1]?.status === "confirmed" &&
    chosen.get().length === 2 &&
    view.entries[SAVED]?.state === "archived"
  );

  const action_restore_stale = action(() => {
    choose.send({
      space: SAVED,
      id: "restore",
      expectedRevision: "1:saved",
      state: "saved",
    });
  });
  const assert_stale_writes_nothing = assert(() => {
    const outcome = outcomes.get()[2];
    return outcome?.status === "conflict" && outcome.reason === "revision" &&
      chosen.get().length === 3 &&
      view.entries[SAVED]?.state === "archived" &&
      view.entries[SAVED]?.revision.startsWith("2:") === true;
  });

  // A retitle changes the entry's title and nothing else: its membership and
  // revision stay as they were, so a choice naming the revision observed
  // before the retitle still applies.
  const action_retitle_archived = action(() => {
    retitle.send({ space: ARCHIVED, title: "Renamed" });
  });
  const assert_retitle_keeps_membership = assert(() =>
    retitles.get()[0]?.status === "retitled" &&
    view.entries[ARCHIVED]?.title === "Renamed" &&
    view.entries[ARCHIVED]?.state === "archived" &&
    view.entries[ARCHIVED]?.revision === "2:archived" &&
    view.entries[ARCHIVED]?.lastAction === undefined
  );
  const action_restore_after_retitle = action(() => {
    choose.send({
      space: ARCHIVED,
      id: "restore-renamed",
      expectedRevision: "2:archived",
      state: "saved",
    });
  });
  const assert_choice_still_current = assert(() =>
    outcomes.get()[3]?.status === "applied" &&
    view.entries[ARCHIVED]?.state === "saved" &&
    view.entries[ARCHIVED]?.title === "Renamed"
  );
  // The same title again writes nothing, and a space with no entry is
  // refused.
  const action_retitle_same_and_missing = action(() => {
    retitle.send({ space: ARCHIVED, title: "Renamed" });
    retitle.send({ space: "did:key:catalog-core-missing", title: "Nowhere" });
  });
  const assert_same_unchanged_missing_conflict = assert(() => {
    const missing = retitles.get()[2];
    return retitles.get()[1]?.status === "unchanged" &&
      missing?.status === "conflict" && missing.reason === "missing" &&
      view.entries["did:key:catalog-core-missing"] === undefined;
  });

  return {
    [TESTS]: [
      { action: action_register },
      { assertion: assert_registered_with_own_write },
      { action: action_register_again },
      { assertion: assert_existing_unchanged },
      { action: action_offer_archived },
      { assertion: assert_archived_stays_archived },
      { action: action_conflicting_kind },
      { assertion: assert_conflict_writes_nothing },
      { action: action_archive },
      { assertion: assert_archived_with_own_write },
      { action: action_archive_again },
      { assertion: assert_repeat_confirmed },
      { action: action_restore_stale },
      { assertion: assert_stale_writes_nothing },
      { action: action_retitle_archived },
      { assertion: assert_retitle_keeps_membership },
      { action: action_restore_after_retitle },
      { assertion: assert_choice_still_current },
      { action: action_retitle_same_and_missing },
      { assertion: assert_same_unchanged_missing_conflict },
    ],
  };
});
