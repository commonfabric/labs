import {
  action,
  assert,
  computed,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findNodeByProp, hasText, propValue } from "../test/vnode-helpers.ts";
import SharedSpaceCollection from "./shared-space-collection.tsx";
import type { SharedSpaceCatalogStorage } from "./shared-space-catalog.ts";
import {
  sharedSpaceCollectionViewOf,
  sharedSpaceReceiptViewOf,
} from "./shared-space-interface.ts";

const LOOM = "did:key:interface-loom";
const CHAT = "did:key:interface-chat";
const FUTURE = "did:key:interface-future";
const OLDER = "did:key:interface-older";
const HOST = "https://social.example";
const SEED = {
  entries: {
    [LOOM]: {
      space: LOOM,
      host: HOST,
      kind: "loom",
      state: "saved",
      revision: "1:loom",
      title: "Team loom",
      since: 2000,
      extension: "kept",
    },
    [CHAT]: {
      space: CHAT,
      host: HOST,
      kind: "fabrichat-room",
      state: "archived",
      revision: "2:chat",
      title: "Team chat",
      since: 3000,
    },
    [FUTURE]: {
      space: FUTURE,
      host: HOST,
      kind: "future-kind",
      state: "left",
      revision: "future-revision",
      title: "Future space",
      since: 4000,
    },
    [OLDER]: {
      space: OLDER,
      host: HOST,
      kind: "loom",
      state: "saved",
      revision: "1:older",
      title: "Older loom",
    },
  },
  offers: {},
};

export default pattern(() => {
  const catalog = new Writable<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  });
  const view = computed(() => sharedSpaceCollectionViewOf(catalog.get()));
  const browser = SharedSpaceCollection({ catalog, view });
  const firstRevision = new Writable("");
  const unavailable = computed(() => sharedSpaceCollectionViewOf(undefined));
  const malformed = computed(() =>
    sharedSpaceCollectionViewOf({
      entries: { [LOOM]: { ...SEED.entries[LOOM], since: "yesterday" } },
      offers: {},
    })
  );
  const malformedReceipts = computed(() =>
    sharedSpaceReceiptViewOf({
      entries: {},
      offers: {
        bad: { from: LOOM, id: "offer", space: LOOM, host: HOST, kind: "loom" },
      },
    })
  );
  const assert_availability = assert(() =>
    unavailable.status === "unavailable" && unavailable.reason === "loading" &&
    malformed.status === "unavailable" && malformed.reason === "malformed" &&
    malformedReceipts.status === "unavailable" &&
    malformedReceipts.reason === "malformed" &&
    view.status === "ready" && view.saved.length === 0 &&
    ["toString", "constructor", "__proto__"].every((kind) =>
      view.byKind[kind] === undefined
    )
  );
  const assert_absent_kinds = assert(() => {
    const empty = sharedSpaceCollectionViewOf({ entries: {}, offers: {} });
    return empty.status === "ready" &&
      empty.byKind["toString"] === undefined &&
      empty.byKind["constructor"] === undefined &&
      empty.byKind["__proto__"] === undefined;
  });
  const assert_special_kinds = assert(() => {
    const special = sharedSpaceCollectionViewOf({
      entries: {
        [LOOM]: { ...SEED.entries[LOOM], kind: "__proto__" },
        [CHAT]: { ...SEED.entries[CHAT], kind: "constructor" },
      },
      offers: {},
    });
    return special.status === "ready" &&
      special.byKind["__proto__"].saved[0]?.space === LOOM &&
      special.byKind["constructor"].archived[0]?.space === CHAT;
  });
  const action_seed = action(() => catalog.set(SEED));
  const assert_partitions = assert(() =>
    view.status === "ready" && view.saved.map((entry) =>
        entry.space
      ).join(",") === `${LOOM},${OLDER}` &&
    view.archived[0]?.space === CHAT && view.other[0]?.space === FUTURE &&
    view.byKind.loom.saved.length === 2 &&
    view.byKind["future-kind"].other[0]?.state === "left" &&
    Object.keys(view.entries).length === 4 &&
    catalog.get().entries[LOOM].extension === "kept"
  );
  const assert_saved_ui = assert(() =>
    hasText(browser[UI], "Team loom") && hasText(browser[UI], "Older loom") &&
    !hasText(browser[UI], "Team chat") &&
    !hasText(browser[UI], "Future space") &&
    propValue(
        findNodeByProp(browser[UI], "data-space", LOOM),
        "data-revision",
      ) === "1:loom"
  );
  const action_search = action(() => browser.search.set("TEAM"));
  const assert_search = assert(() =>
    hasText(browser[UI], "Team loom") && !hasText(browser[UI], "Older loom")
  );
  const action_archive = action(() => {
    firstRevision.set("1:loom");
    browser.chooseMembership.send({
      target: {
        dataset: { space: LOOM, revision: "1:loom", state: "archived" },
      },
    });
  });
  const assert_archived = assert(() =>
    view.status === "ready" && view.entries[LOOM].state === "archived" &&
    view.entries[LOOM].revision.startsWith("2:") &&
    !hasText(browser[UI], "Team loom") &&
    catalog.get().entries[LOOM].extension === "kept"
  );
  const action_show_archived = action(() => {
    browser.search.set("");
    browser.membership.set("archived");
  });
  const assert_archived_ui = assert(() =>
    hasText(browser[UI], "Team loom") && hasText(browser[UI], "Team chat")
  );
  const action_stale_restore = action(() =>
    browser.chooseMembership.send({
      target: {
        dataset: { space: LOOM, revision: firstRevision.get(), state: "saved" },
      },
    })
  );
  const assert_stale_choice = assert(() =>
    view.status === "ready" && view.entries[LOOM].state === "archived" &&
    hasText(browser[UI], "The collection changed after this choice was shown.")
  );
  const action_restore = action(() => {
    if (view.status !== "ready") {
      throw new Error("The collection is unavailable.");
    }
    browser.chooseMembership.send({
      target: {
        dataset: {
          space: LOOM,
          revision: view.entries[LOOM].revision,
          state: "saved",
        },
      },
    });
  });
  const assert_restored = assert(() =>
    view.status === "ready" && view.entries[LOOM].state === "saved" &&
    !hasText(
      browser[UI],
      "The collection changed after this choice was shown.",
    ) &&
    !hasText(browser[UI], "Team loom")
  );
  const action_future = action(() => {
    browser.membership.set("other");
    browser.kind.set("future-kind");
  });
  const assert_future_ui = assert(() =>
    hasText(browser[UI], "Future space") &&
    findNodeByProp(browser[UI], "data-space", FUTURE) === undefined &&
    catalog.get().entries[FUTURE].revision === "future-revision"
  );
  const action_malformed = action(() =>
    catalog.set({ entries: {}, offers: null })
  );
  const assert_unavailable_ui = assert(() =>
    view.status === "unavailable" && view.reason === "malformed" &&
    hasText(browser[UI], "The collection could not be read.") &&
    !hasText(browser[UI], "No social spaces match this view.")
  );
  return {
    [TESTS]: [
      { assertion: assert_availability },
      { assertion: assert_absent_kinds },
      { assertion: assert_special_kinds },
      { action: action_seed },
      { assertion: assert_partitions },
      { assertion: assert_saved_ui },
      { action: action_search },
      { assertion: assert_search },
      { action: action_archive },
      { assertion: assert_archived },
      { action: action_show_archived },
      { assertion: assert_archived_ui },
      { action: action_stale_restore },
      { assertion: assert_stale_choice },
      { action: action_restore },
      { assertion: assert_restored },
      { action: action_future },
      { assertion: assert_future_ui },
      { action: action_malformed },
      { assertion: assert_unavailable_ui },
    ],
  };
});
