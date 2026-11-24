/**
 * A FabriChat room that is its space's root, as a manager creates one, with
 * the record it keeps its space's file store in, beside a place to hold a
 * profile that a member's home can then list. The room's `ensureFileStore`
 * creates the store from a handler, the room reaches the store only through
 * the record's link, and `addToStore` adds to it as the room's composer does.
 * Fixture for
 * `fabrichat-file-store-multi-runtime.test.ts`.
 */

import {
  type Cell,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  Writable,
} from "commonfabric";
import type { AddFileEvent } from "../../../system/fabrifile/schemas.tsx";
import type { FileStoreRecord } from "../../../system/fabrifile/store.tsx";
import type { MessagesValue } from "../../../system/fabrichat/room-records.tsx";
import { FabriChatRoomCore } from "../../../system/fabrichat/room.tsx";
import type { ChatProfile } from "../../../system/fabrichat/schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

/** What holding a profile asks: the profile, as the link a session holds. */
interface HoldProfileEvent {
  /** The profile. */
  profile: Cell<ChatProfile>;
}

/** Holds the event's profile where a member's home can be pointed at it. */
const holdProfile = handler<
  HoldProfileEvent,
  { profile: Writable<Cell<ChatProfile> | undefined> }
>((event, { profile }) => {
  profile.set(event.profile);
});

/**
 * Sends the event to the store's `add`, from a handler in the room's piece,
 * as the room's composer sends the files it attaches.
 */
const addToStore = handler<
  AddFileEvent,
  { store?: Cell<{ add: Stream<AddFileEvent> }> }
>((event, { store }) => {
  store?.key("add").send(event);
});

export default pattern(() => {
  // Each member's own, so that each member's home lists their own profile.
  const profile = new Writable.perUser<Cell<ChatProfile> | undefined>(
    undefined,
  ).for("profile");
  const room = FabriChatRoomCore({
    myProfile: Writable.of<ChatProfile>({ name: "Ada" }),
    about: { kind: "group" as const, title: "Team" },
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    fileStore: Writable.of<FileStoreRecord>({}),
  } as RoomArg);
  return {
    [NAME]: "FabriChat file store",
    [UI]: room[UI],
    ensureFileStore: room.ensureFileStore,
    fileStore: room.fileStore,
    fileStoreRecord: room.fileStoreRecord,
    addToStore: addToStore({ store: room.fileStore }),
    profile,
    holdProfile: holdProfile({ profile }),
  };
});
