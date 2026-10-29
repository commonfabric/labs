/**
 * What a FabriChat room does with messages whose reply names neither a thread
 * nor a message it quotes, the shape a FabriChat stored before it named the two
 * apart: it counts them, says so, and shows each one shown in the main
 * conversation as a message in no thread, and none shown only in a thread. The
 * messages here are written straight into a list of their own, as an earlier
 * FabriChat left them, which no send of this room can write.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  type FabricEpochNsec,
  pattern,
  TESTS,
  UI,
  VIEWS,
  Writable,
} from "commonfabric";
import {
  findNodeById,
  propValue,
  readValue,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import { FabriChatRoomCore } from "./room.tsx";
import { type ChatProfile, epochNsecFromMsec } from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

/** A message as an earlier FabriChat stored it, its reply naming one message. */
interface OldMessage {
  authorProfile: Cell<TestProfile>;
  body: string;
  sentAt: FabricEpochNsec;
  replyTo?: {
    message: Cell<unknown>;
    shownIn: "main" | "thread" | "both";
  };
}

/** What `node` has as its display, as its `style` names it. */
const displayOf = (node: unknown) =>
  readValue(
    (propValue(node, "style") as { display?: unknown } | undefined)?.display,
  );

/** The room's caption saying how many replies lost their context. */
const banner = (ui: unknown) => findNodeById(ui, "fabrichat-legacy-replies");

/** The bodies of `messages`, in their order. */
const bodies = (messages: readonly Cell<unknown>[]) =>
  messages.map((message) => (message.get() as { body?: string })?.body)
    .join(" | ");

export default pattern(() => {
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const old = Writable.of<OldMessage[]>([]);
  const store = action(() => {
    const message = (body: string, at: number) => ({
      authorProfile: aliceProfile,
      body,
      sentAt: epochNsecFromMsec(at),
    });
    old.push(message("Root", 1));
    old.push({
      ...message("Old quote", 2),
      replyTo: { message: old.key(0), shownIn: "main" },
    });
    old.push({
      ...message("Old both", 3),
      replyTo: { message: old.key(0), shownIn: "both" },
    });
    old.push({
      ...message("Old thread-only", 4),
      replyTo: { message: old.key(0), shownIn: "thread" },
    });
  });
  const room = FabriChatRoomCore(
    {
      myProfile: aliceProfile,
      about: { kind: "group" },
      messages: old as never,
    } as RoomArg,
  );
  // A room with none of them, which says nothing.
  const fresh = FabriChatRoomCore(
    {
      myProfile: aliceProfile,
      about: { kind: "group" },
      messages: Writable.of<OldMessage[]>([]) as never,
    } as RoomArg,
  );

  return {
    [TESTS]: [
      { action: store },
      // Three replies name neither a thread nor a quote; the two shown in the
      // conversation show there, with no thread, and the one shown only in a
      // thread shows nowhere.
      {
        assertion: assert(() => {
          const list = room[VIEWS].room.messages;
          return list.legacyReplies === 3 && list.threads.length === 0 &&
            bodies(list.latest.messages) === "Root | Old quote | Old both";
        }),
      },
      // The room says how many, and a room with none says nothing.
      {
        assertion: assert(() =>
          displayOf(banner(room[UI])) === "block" &&
          textContent(banner(room[UI])).startsWith("3 messages here were") &&
          fresh[VIEWS].room.messages.legacyReplies === 0 &&
          displayOf(banner(fresh[UI])) === "none"
        ),
      },
    ],
  };
});
