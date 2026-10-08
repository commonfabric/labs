/**
 * A FabriChat manager with no profile, as in this lane: it offers no start
 * controls, and refuses every start and every acceptance, recording why and
 * changing nothing else.
 *
 * `creation.test.tsx` covers the rooms a manager creates, and its other
 * refusals, with a profile of its own.
 */
import { assert, pattern, TESTS, UI } from "commonfabric";
import { findNodeByProp, propValue } from "../test/vnode-helpers.ts";
import FabriChatManager from "./manager.tsx";
import { type ChatRequestOutcome } from "./schemas.tsx";

/** Why the request `id` was refused, or its status if it wasn't. */
const reasonOf = (
  requests: Record<string, ChatRequestOutcome> | undefined,
  id: string,
): string => {
  const outcome = requests?.[id];
  return outcome?.status === "refused"
    ? outcome.reason
    : outcome?.status ?? "none";
};

const NEEDS_PROFILE = "Starting a chat needs a profile.";

export default pattern(() => {
  const manager = FabriChatManager({});

  return {
    [TESTS]: [
      { assertion: assert(() => manager.rooms.length === 0) },
      // The start controls are disabled.
      {
        assertion: assert(() =>
          propValue(
            findNodeByProp(manager[UI], "inputId", "fabrichat-start-direct"),
            "disabled",
          ) === true
        ),
      },
      {
        action: manager.openDirect,
        event: { requestId: "d-1", counterpart: "did:key:z6MkBob" },
      },
      {
        action: manager.createGroup,
        event: { requestId: "g-1", title: "Team", members: [] },
      },
      { action: manager.accept, event: { requestId: "a-1" } },
      {
        assertion: assert(() =>
          reasonOf(manager.requests, "d-1") === NEEDS_PROFILE &&
          reasonOf(manager.requests, "g-1") === NEEDS_PROFILE &&
          reasonOf(manager.requests, "a-1") ===
            "Accepting a chat needs a profile." &&
          manager.rooms.length === 0 &&
          manager.outgoingNotices.length === 0
        ),
      },
    ],
  };
});
