/**
 * The Loom creates its own chat room when it names none, keeps the room it
 * names, creates a new one once that is cleared, and adds no panel for any.
 * That a member who holds only READ is refused, and that two sessions racing
 * create one room, are checked by
 * `../integration/loom-chat-room-multi-runtime.test.ts`.
 */
import {
  action,
  assert,
  type Cell,
  NAME,
  pattern,
  spaceOf,
  TESTS,
  Writable,
} from "commonfabric";
import type { ChatRoomLink } from "../fabrichat/schemas.tsx";
import Loom from "./main.tsx";

/** The room `chatRoom` links, read as a room rather than by its name alone. */
function roomOf(link: unknown): Cell<ChatRoomLink> | undefined;
function roomOf(link: unknown): unknown {
  return link;
}

/** A room the test holds, to compare a later one with. */
interface HeldRoom {
  room?: Writable<{ [NAME]?: string }>;
}

export default pattern(() => {
  // A Loom that names no room, so `ensureChatRoom` creates one.
  const loom = Loom({});
  const held = Writable.of<HeldRoom>({});
  // Something in the test's space, which is the Loom's.
  const here = new Writable({ [NAME]: "Here" });
  const ensure = action(() => loom.ensureChatRoom.send());
  const hold = action(() => {
    if (loom.chatRoom !== undefined) held.set({ room: loom.chatRoom });
  });
  const clear = action(() => loom.setChatRoom.send({}));

  // A Loom whose room `setChatRoom` named first.
  const named = Loom({});
  const room = new Writable({ [NAME]: "Named room" });
  const name = action(() => named.setChatRoom.send({ room }));
  const ensureNamed = action(() => named.ensureChatRoom.send());

  return {
    [TESTS]: [
      { assertion: assert(() => loom.chatRoom?.get() === undefined) },
      { action: ensure },
      // The room is a space's own chat in the Loom's space: it has no
      // `about`, so it records no creator and no creation time.
      {
        assertion: assert(() =>
          loom.chatRoom !== undefined &&
          spaceOf(loom.chatRoom) === spaceOf(here) &&
          loom.chatRoom.get()?.[NAME] === "Chat" &&
          roomOf(loom.chatRoom)?.key("about").get()?.kind === "group" &&
          roomOf(loom.chatRoom)?.key("about").get()?.createdAt === undefined &&
          roomOf(loom.chatRoom)?.key("about").get()?.record === undefined
        ),
      },
      // It is no panel, and no piece the root registers.
      {
        assertion: assert(() =>
          loom.panels.length === 0 && loom.pieceRegistry.length === 0
        ),
      },
      { action: hold },
      // Asked again, it creates nothing and keeps the room it named.
      { action: ensure },
      { action: ensure },
      {
        assertion: assert(() =>
          held.get().room !== undefined &&
          loom.chatRoom?.equals(held.key("room")) === true
        ),
      },
      {
        assertion: assert(() =>
          loom.panels.length === 0 && loom.pieceRegistry.length === 0
        ),
      },
      // Once the room is cleared, it creates a new one.
      { action: clear },
      { assertion: assert(() => loom.chatRoom?.get() === undefined) },
      { action: ensure },
      {
        assertion: assert(() =>
          loom.chatRoom?.get()?.[NAME] === "Chat" &&
          loom.chatRoom?.equals(held.key("room")) === false
        ),
      },
      { assertion: assert(() => loom.panels.length === 0) },

      // A room `setChatRoom` named is kept.
      { action: name },
      { action: ensureNamed },
      { assertion: assert(() => named.chatRoom?.equals(room) === true) },
      { assertion: assert(() => room.get()[NAME] === "Named room") },
      { assertion: assert(() => named.panels.length === 0) },
    ],
  };
});
