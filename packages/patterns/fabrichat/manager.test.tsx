/**
 * A FabriChat manager's refusals: the requests it turns down, each with its
 * outcome recorded, and changing nothing else. With no profile, as in this
 * lane, it starts no chat at all.
 *
 * `creation.test.tsx` covers the rooms a manager creates, with a profile of
 * its own.
 */
import { assert, pattern, TESTS } from "commonfabric";
import FabriChatManager from "./manager.tsx";
import { type ChatRequestOutcome } from "./schemas.tsx";

const statusOf = (
  requests: Record<string, ChatRequestOutcome> | undefined,
  id: string,
): string => requests?.[id]?.status ?? "none";

export default pattern(() => {
  const manager = FabriChatManager({});

  return {
    [TESTS]: [
      { assertion: assert(() => manager.rooms.length === 0) },
      {
        action: manager.openDirect,
        event: { requestId: "d-0", counterpart: "not a did" },
      },
      {
        action: manager.createGroup,
        event: { requestId: "g-0", title: "  ", members: [] },
      },
      // `#profile` resolves nothing here, and no chat starts without one.
      {
        action: manager.openDirect,
        event: { requestId: "d-1", counterpart: "did:key:z6MkBob" },
      },
      {
        assertion: assert(() =>
          statusOf(manager.requests, "d-0") === "refused" &&
          statusOf(manager.requests, "g-0") === "refused" &&
          statusOf(manager.requests, "d-1") === "refused" &&
          manager.rooms.length === 0 &&
          manager.outgoingNotices.length === 0
        ),
      },
      // A request already decided stays decided.
      {
        action: manager.createGroup,
        event: { requestId: "g-0", title: "  ", members: [] },
      },
      // `#profile` resolves nothing here, and no chat starts without one.
      {
        action: manager.openDirect,
        event: { requestId: "d-1", counterpart: "did:key:z6MkBob" },
      },
      {
        assertion: assert(() =>
          statusOf(manager.requests, "g-0") === "refused"
        ),
      },
    ],
  };
});
