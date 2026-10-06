/**
 * Starting a chat is the person's reviewed act: a start that creates a room
 * commits only from a `ChatStart` on `ChatStartSurface`, since the room's
 * `about` record names that action as its writer's. A start sent without it,
 * or from another surface, creates no room, and its run commits nothing, so no
 * outcome is recorded either. A refused run logs its refusal, which is why
 * console warnings are allowed.
 */
import { assert, pattern, TESTS, Writable } from "commonfabric";
import { FabriChatManagerCore } from "./manager.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
} from "./schemas.tsx";

type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

// A stand-in for a principal, a base58btc key as a principal's is.
const BOB = "did:key:z6MkBob";

const startGesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };
const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };

const statusOf = (
  requests: Writable<Record<string, ChatRequestOutcome>>,
  id: string,
): string => requests.get()?.[id]?.status ?? "none";

export default pattern(() => {
  const rooms = Writable.of<ChatIndexEntry[]>([]);
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const notices = Writable.of<ChatManagerNotice[]>([]);
  const manager = FabriChatManagerCore({
    myProfile: Writable.of<ChatProfile>({ name: "Tester" }),
    rooms,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: notices,
  } as ManagerArg);

  return {
    [TESTS]: [
      // Without a gesture.
      {
        action: manager.openDirect,
        event: { requestId: "d-1", counterpart: BOB },
      },
      {
        action: manager.createGroup,
        event: { requestId: "g-1", title: "Team", members: [BOB] },
      },
      // From another reviewed surface.
      {
        action: manager.createGroup,
        event: { requestId: "g-2", title: "Team", members: [BOB] },
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          rooms.get().length === 0 && notices.get().length === 0 &&
          statusOf(requests, "d-1") === "none" &&
          statusOf(requests, "g-1") === "none" &&
          statusOf(requests, "g-2") === "none"
        ),
      },
      // From its own.
      {
        action: manager.openDirect,
        event: { requestId: "d-2", counterpart: BOB },
        trustedUi: startGesture,
      },
      {
        action: manager.createGroup,
        event: { requestId: "g-3", title: "Team", members: [BOB] },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() =>
          rooms.get().length === 2 && notices.get().length === 2 &&
          statusOf(requests, "d-2") === "done" &&
          statusOf(requests, "g-3") === "done"
        ),
      },
    ],
    allowConsoleWarnings: true,
  };
});
