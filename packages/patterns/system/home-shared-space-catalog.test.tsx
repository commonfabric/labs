import { action, assert, pattern, TESTS, Writable } from "commonfabric";

import Home from "./home.tsx";

const SPACE = "did:key:catalog-test-room";
const FROM = "did:key:catalog-test-sender";
const OFFER = JSON.stringify([FROM, "first-offer"]);

export default pattern(() => {
  const home = Home({});
  const revision = new Writable("");
  const assert_empty_catalog = assert(() =>
    Object.keys(home.sharedSpaceCatalog.entries).length === 0 &&
    Object.keys(home.sharedSpaceCatalog.offers).length === 0
  );
  const action_register = action(() => {
    home.registerSharedSpace.send({
      space: SPACE,
      host: "HTTPS://ROOM.EXAMPLE:443/",
      kind: "loom",
      title: "Our loom",
      since: 1000,
      offer: { from: FROM, id: "first-offer" },
    });
  });
  const assert_registered = assert(() =>
    home.sharedSpaceCatalog.entries[SPACE]?.state === "saved" &&
    home.sharedSpaceCatalog.entries[SPACE]?.host === "https://room.example" &&
    home.sharedSpaceCatalog.entries[SPACE]?.from === FROM &&
    home.sharedSpaceCatalog.entries[SPACE]?.since === 1000 &&
    home.sharedSpaceCatalog.offers[OFFER]?.space === SPACE
  );
  const action_archive = action(() => {
    revision.set(home.sharedSpaceCatalog.entries[SPACE].revision);
    home.changeSharedSpaceMembership.send({
      space: SPACE,
      id: "archive",
      expectedRevision: home.sharedSpaceCatalog.entries[SPACE].revision,
      state: "archived",
    });
  });
  const assert_archived = assert(() =>
    home.sharedSpaceCatalog.entries[SPACE]?.state === "archived" &&
    home.sharedSpaceCatalog.entries[SPACE]?.revision !== revision.get()
  );
  const action_replay_offer = action(() => {
    home.registerSharedSpace.send({
      space: SPACE,
      host: "https://room.example",
      kind: "loom",
      title: "Replacement title",
      offer: { from: FROM, id: "first-offer" },
    });
  });
  const assert_replay_keeps_choice = assert(() =>
    home.sharedSpaceCatalog.entries[SPACE]?.state === "archived" &&
    home.sharedSpaceCatalog.entries[SPACE]?.title === "Our loom" &&
    Object.keys(home.sharedSpaceCatalog.entries).length === 1 &&
    Object.keys(home.sharedSpaceCatalog.offers).length === 1
  );
  const action_restore = action(() => {
    home.changeSharedSpaceMembership.send({
      space: SPACE,
      id: "restore",
      expectedRevision: home.sharedSpaceCatalog.entries[SPACE].revision,
      state: "saved",
    });
  });
  const assert_restored = assert(() =>
    home.sharedSpaceCatalog.entries[SPACE]?.state === "saved"
  );
  const action_stale_archive = action(() => {
    home.changeSharedSpaceMembership.send({
      space: SPACE,
      id: "archive",
      expectedRevision: revision.get(),
      state: "archived",
    });
  });
  const action_conflicting_route = action(() => {
    home.registerSharedSpace.send({
      space: SPACE,
      host: "https://elsewhere.example",
      kind: "loom",
    });
  });
  const assert_route_retained = assert(() =>
    home.sharedSpaceCatalog.entries[SPACE]?.host === "https://room.example" &&
    home.sharedSpaceCatalog.entries[SPACE]?.state === "saved"
  );
  return {
    [TESTS]: [
      { assertion: assert_empty_catalog },
      { action: action_register },
      { assertion: assert_registered },
      { action: action_archive },
      { assertion: assert_archived },
      { action: action_replay_offer },
      { assertion: assert_replay_keeps_choice },
      { action: action_restore },
      { assertion: assert_restored },
      { action: action_stale_archive },
      { assertion: assert_restored },
      { action: action_conflicting_route },
      { assertion: assert_route_retained },
    ],
  };
});
