/**
 * A FabriChat room that is its space's root, as a manager creates one, with
 * the record it keeps its space's file store in. The room's `ensureFileStore`
 * creates the store from a handler, and the room reaches the store only
 * through the record's link. Fixture for
 * `fabrichat-file-store-multi-runtime.test.ts`.
 */

import { NAME, pattern, UI, Writable } from "commonfabric";
import type { FileStoreRecord } from "../../../system/fabrifile/store.tsx";
import type { MessagesValue } from "../../../system/fabrichat/room-records.tsx";
import { FabriChatRoomCore } from "../../../system/fabrichat/room.tsx";
import type { ChatProfile } from "../../../system/fabrichat/schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

export default pattern(() => {
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
  };
});
