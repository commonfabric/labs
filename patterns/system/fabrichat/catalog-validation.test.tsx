/**
 * Catalog validation gates both newly discovered rooms and retained membership.
 * Changes to optional fields and offer receipts invalidate the whole catalog;
 * future states and revisions retain the catalog's forward-compatible meaning.
 */

import {
  action,
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import type { SharedSpaceCatalogStorage } from "../shared-space/shared-space-catalog.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import {
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
} from "./schemas.tsx";

/** Inputs accepted by the manager fixture. */
type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];
/** A labeled profile, as a room participant supplies. */
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

export default pattern(() => {
  const catalog = Writable.of<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  });
  const profile = Writable.of<TestProfile>({ name: "Tester" });
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: catalog,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: Writable.of<Record<string, ChatRequestOutcome>>({}),
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const discovered = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: catalog,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: Writable.of<Record<string, ChatRequestOutcome>>({}),
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const space = Writable.of<string>("");
  const rememberSpace = action(() =>
    space.set(Object.keys(catalog.get().entries)[0])
  );
  const malformedTitle = action(() =>
    catalog.key("entries", space.get(), "title").set(123)
  );
  const repairTitle = action(() =>
    catalog.key("entries", space.get(), "title").set("Team")
  );
  const malformedSince = action(() =>
    catalog.key("entries", space.get(), "since").set(-1)
  );
  const repairSince = action(() =>
    catalog.key("entries", space.get(), "since").set(0)
  );
  const malformedFrom = action(() =>
    catalog.key("entries", space.get(), "from").set(123)
  );
  const repairFrom = action(() =>
    catalog.key("entries", space.get(), "from").set("did:key:z6MkBob")
  );
  const malformedOffer = action(() => catalog.key("offers").set({ bad: {} }));
  const repairOffers = action(() => catalog.key("offers").set({}));
  const futureState = action(() =>
    catalog.key("entries", space.get(), "state").set("future-state")
  );
  const futureRevision = action(() => {
    catalog.key("entries", space.get(), "state").set("saved");
    catalog.key("entries", space.get(), "revision").set("future-revision");
  });
  const removeEntry = action(() => catalog.key("entries").set({}));
  const listed = assert(() =>
    manager.rooms.length === 1 && discovered.rooms.length === 1
  );
  const absent = assert(() =>
    manager.rooms.length === 0 && discovered.rooms.length === 0
  );

  return {
    [TESTS]: [
      { assertion: absent },
      {
        action: manager.createGroup,
        event: { requestId: "group", title: "Team", members: [] },
        trustedUi: { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION },
      },
      { assertion: listed },
      { action: rememberSpace },
      { action: malformedTitle },
      { assertion: absent },
      { action: repairTitle },
      { assertion: listed },
      { action: malformedSince },
      { assertion: absent },
      { action: repairSince },
      { assertion: listed },
      { action: malformedFrom },
      { assertion: absent },
      { action: repairFrom },
      { assertion: listed },
      { action: malformedOffer },
      { assertion: absent },
      { action: repairOffers },
      { assertion: listed },
      { action: futureState },
      { assertion: absent },
      { action: futureRevision },
      { assertion: listed },
      {
        assertion: assert(() =>
          manager.rooms[0]?.revision === "future-revision" &&
          discovered.rooms[0]?.revision === "future-revision"
        ),
      },
      { action: removeEntry },
      { assertion: absent },
    ],
  };
});
