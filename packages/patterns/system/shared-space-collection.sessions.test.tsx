import {
  action,
  assert,
  computed,
  multiUserTest,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { hasText } from "../test/vnode-helpers.ts";
import SharedSpaceCollection, {
  type SharedSpaceCollectionOutput,
} from "./shared-space-collection.tsx";
import type { SharedSpaceCatalogStorage } from "./shared-space-catalog.ts";
import { sharedSpaceCollectionViewOf } from "./shared-space-interface.ts";

const LOOM = "did:key:session-collection-loom";
const CHAT = "did:key:session-collection-chat";

interface Setup {
  browser: SharedSpaceCollectionOutput;
}

export const setup = pattern(() => {
  const catalog = new Writable<SharedSpaceCatalogStorage>({
    entries: {
      [LOOM]: {
        space: LOOM,
        host: "https://social.example",
        kind: "loom",
        state: "saved",
        revision: "1:loom",
        title: "Team loom",
      },
      [CHAT]: {
        space: CHAT,
        host: "https://social.example",
        kind: "fabrichat-room",
        state: "saved",
        revision: "1:chat",
        title: "Team chat",
      },
    },
    offers: {},
  });
  const view = computed(() => sharedSpaceCollectionViewOf(catalog.get()));
  return { browser: SharedSpaceCollection({ catalog, view }) };
});

export const first = pattern<{ setup: Setup }>(({ setup }) => {
  const filter = action(() => setup.browser.search.set("Team loom"));
  const archive = action(() =>
    setup.browser.chooseMembership.send({
      target: {
        dataset: { space: LOOM, revision: "1:loom", state: "archived" },
      },
    })
  );
  return {
    [TESTS]: [
      { action: filter },
      {
        assertion: assert(() =>
          hasText(setup.browser[UI], "Team loom") &&
          !hasText(setup.browser[UI], "Team chat")
        ),
      },
      { label: "first-filtered" },
      { await: "second-viewed" },
      {
        assertion: assert(() =>
          setup.browser.search.get() === "Team loom" &&
          hasText(setup.browser[UI], "Team loom") &&
          !hasText(setup.browser[UI], "Team chat")
        ),
      },
      { action: archive },
      {
        assertion: assert(() =>
          !hasText(setup.browser[UI], "Team loom") &&
          !hasText(setup.browser[UI], "Team chat")
        ),
      },
      { label: "first-archived" },
    ],
  };
});

export const second = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "first-filtered" },
    {
      assertion: assert(() =>
        setup.browser.search.get() === "" &&
        hasText(setup.browser[UI], "Team loom") &&
        hasText(setup.browser[UI], "Team chat")
      ),
    },
    { label: "second-viewed" },
    { await: "first-archived" },
    {
      assertion: assert(() =>
        setup.browser.search.get() === "" &&
        !hasText(setup.browser[UI], "Team loom") &&
        hasText(setup.browser[UI], "Team chat")
      ),
    },
  ],
}));

export default multiUserTest({
  setup,
  participants: { first, second: { pattern: second, user: "first" } },
});
