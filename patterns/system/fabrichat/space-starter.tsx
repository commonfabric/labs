/** Starts and opens the enclosing Loom space's shared conversation. */

import {
  action,
  type Cell,
  computed,
  NAME,
  pattern,
  type PerSession,
  spaceAccess,
  type Stream,
  UI,
  VIEWS,
  type VNode,
  wish,
} from "commonfabric";
import type { ChatRoomView } from "./room.tsx";
import { type ChatDisplay, type ChatProfile } from "./schemas.tsx";

/** The registered room's rendering and data face. */
interface SpaceChatRoom {
  [UI]: VNode;
  [VIEWS]?: { room?: ChatRoomView };
}

/** The Loom root's space conversation and its creation operation. */
interface SpaceChat {
  chatRoom?: Cell<SpaceChatRoom>;
  hasChatRoom?: boolean;
  ensureChatRoom?: Stream<void>;
}

/** The registered room and its rendering, absent until the root names one. */
export interface SpaceStarterOutput {
  [NAME]: string;
  [UI]: VNode;
  room: Cell<SpaceChatRoom> | undefined;
  [VIEWS]: { room: ChatRoomView | undefined };
}

/**
 * Opens the enclosing space's conversation and offers profile setup. The
 * Start action asks the Loom root to create its room only if absent.
 */
export default pattern<Record<string, never>, SpaceStarterOutput>(() => {
  const profile = wish<PerSession<ChatProfile>>({ query: "#profile" });
  const selectedProfile: PerSession<ChatProfile | undefined> = profile.result;
  const space = wish<Cell<SpaceChat>>({ query: "#default" });
  // A stream schema supplies a handle even when the underlying field is
  // absent. The unbranded projection checks that the operation exists.
  const registry = wish<{ ensureChatRoom?: unknown }>(
    {
      query: "#default",
    },
  );
  const named = computed(() => space.result?.get()?.hasChatRoom === true);
  const room = computed(() => space.result?.get()?.chatRoom);
  const ready = computed(() =>
    room?.get()?.[UI] !== undefined && room?.get()?.[VIEWS]?.room !== undefined
  );
  const canCreate = computed(() => {
    if (
      !space.result || space.result.get()?.hasChatRoom !== false ||
      registry.result?.ensureChatRoom === undefined
    ) {
      return false;
    }
    const access = spaceAccess(space.result);
    return access === "WRITE" || access === "OWNER";
  });
  const start = action(() => {
    if (!canCreate || !space.result) return;
    const access = spaceAccess(space.result);
    if (access !== "WRITE" && access !== "OWNER") return;
    space.result.get()?.ensureChatRoom?.send();
  });
  const profileDisplay = computed(
    (): PerSession<ChatDisplay> =>
      !ready && selectedProfile === undefined ? "block" : "none",
  );
  return {
    [NAME]: "FabriChat",
    [UI]: (
      <cf-screen>
        {ready ? <cf-render $cell={room} /> : (
          <cf-vstack padding="4" gap="3">
            <cf-heading level={2}>Space conversation</cf-heading>
            <cf-text>
              Everyone with access to this space can read its conversation.
            </cf-text>
            {named
              ? <cf-text>The space's conversation is unavailable.</cf-text>
              : (
                <cf-button disabled={!canCreate} onClick={start}>
                  Start conversation
                </cf-button>
              )}
          </cf-vstack>
        )}
        <div
          id="fabrichat-starter-profile-setup"
          hidden
          style={{ display: profileDisplay }}
        >
          {profile[UI]}
        </div>
      </cf-screen>
    ),
    room,
    [VIEWS]: {
      room: computed(() => room?.get()?.[VIEWS]?.room),
    },
  };
});
