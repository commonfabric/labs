/**
 * A FabriChat room's space's file store: a room that is its space's root
 * creates and keeps its own, and offers its record as a Loom does; a room
 * whose space's root is a Loom, or such a room, uses that root's; and a room
 * whose space's root keeps none has none, and writes nothing into that root.
 */
import {
  action,
  assert,
  NAME,
  pattern,
  spaceOf,
  TESTS,
  Writable,
} from "commonfabric";
import type { FileStoreOutput } from "../fabrifile/schemas.tsx";
import type { FileStoreRecord } from "../fabrifile/store.tsx";
import Loom from "../loom/main.tsx";
import type { MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import type { ChatContainer, ChatProfile } from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

/** A store the test holds, to compare a later one with. */
interface HeldStore {
  store?: Writable<FileStoreOutput>;
}

export default pattern(() => {
  const profile = Writable.of<ChatProfile>({ name: "Alice" });
  // Something in the test's space, which every room here shares.
  const here = new Writable({ [NAME]: "Here" });

  // A room a manager created, which is its space's root.
  const rootRoom = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Team" },
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    fileStore: Writable.of<FileStoreRecord>({}),
  } as RoomArg);
  const heldRootStore = Writable.of<HeldStore>({});

  // A room whose space's root is a room, offering its record as a Loom does.
  const roomRoom = FabriChatRoomCore({
    myProfile: profile,
    container: rootRoom,
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    fileStore: Writable.of<FileStoreRecord>({}),
  } as RoomArg);

  // A space's own chat, in a Loom's space.
  const loom = Loom({});
  const loomRoom = FabriChatRoomCore({
    myProfile: profile,
    container: loom,
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    fileStore: Writable.of<FileStoreRecord>({}),
  } as RoomArg);

  // A space's own chat, whose space's root keeps no store.
  const bare = Writable.of<ChatContainer>({});
  const bareRoom = FabriChatRoomCore({
    myProfile: profile,
    container: bare,
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    fileStore: Writable.of<FileStoreRecord>({}),
  } as RoomArg);

  const ensureRoot = action(() => rootRoom.ensureFileStore.send());
  const holdRoot = action(() => {
    if (rootRoom.fileStore !== undefined) {
      heldRootStore.set({ store: rootRoom.fileStore });
    }
  });
  const ensureInLoom = action(() => loomRoom.ensureFileStore.send());
  const ensureBare = action(() => bareRoom.ensureFileStore.send());

  return {
    [TESTS]: [
      // No room's space names a store until one is asked for.
      {
        assertion: assert(() =>
          rootRoom.fileStore?.get() === undefined &&
          loomRoom.fileStore?.get() === undefined &&
          bareRoom.fileStore?.get() === undefined &&
          bare.key("fileStoreRecord").get() === undefined
        ),
      },
      // Only the room that is its space's root offers a record, naming no store.
      {
        assertion: assert(() =>
          rootRoom.fileStoreRecord?.get() !== undefined &&
          rootRoom.fileStoreRecord.get()?.store === undefined &&
          loomRoom.fileStoreRecord?.get() === undefined &&
          bareRoom.fileStoreRecord?.get() === undefined
        ),
      },
      { action: ensureRoot },
      // The root room's store is a piece in its space, and starts out empty.
      {
        assertion: assert(() =>
          rootRoom.fileStore?.get() !== undefined &&
          spaceOf(rootRoom.fileStore) === spaceOf(here) &&
          rootRoom.fileStore.key("entries").get()?.length === 0
        ),
      },
      { action: holdRoot },
      // Asked again, it keeps the store it named.
      { action: ensureRoot },
      {
        assertion: assert(() =>
          heldRootStore.get().store !== undefined &&
          rootRoom.fileStore?.equals(heldRootStore.key("store")) === true
        ),
      },
      // Its record names that store, and a room whose root it is uses it.
      {
        assertion: assert(() =>
          rootRoom.fileStoreRecord?.key("store").equals(
              heldRootStore.key("store"),
            ) === true &&
          roomRoom.fileStore?.equals(heldRootStore.key("store")) === true
        ),
      },
      { action: ensureInLoom },
      // A room in a Loom's space has the Loom create the store, and uses it.
      {
        assertion: assert(() =>
          loom.fileStore?.get() !== undefined &&
          loomRoom.fileStore?.equals(loom.fileStore) === true &&
          loomRoom.fileStore.key("entries").get()?.length === 0
        ),
      },
      // The store is the Loom's, not the room's own.
      {
        assertion: assert(() =>
          loomRoom.fileStore?.equals(heldRootStore.key("store")) === false
        ),
      },
      { action: ensureBare },
      // A room whose space's root keeps no store has none, and writes nothing
      // into that root.
      {
        assertion: assert(() =>
          bareRoom.fileStore?.get() === undefined &&
          bare.key("fileStoreRecord").get() === undefined
        ),
      },
    ],
  };
});
