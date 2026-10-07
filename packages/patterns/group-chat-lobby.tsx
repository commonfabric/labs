import {
  computed,
  Default,
  equals,
  handler,
  hasError,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  resultOf,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import GroupChatRoom, {
  Message,
  ParticipantProfileCell,
  User,
} from "./group-chat-room.tsx";

/**
 * Group Chat Lobby Pattern
 *
 * Apple iOS-style lobby where unlimited users can join. Identity comes from
 * the viewer's shared profile (`wish({ query: "#profile" })`): the wish's
 * built-in UI lets the viewer pick one of their existing profiles or create a
 * new one, and joining snapshots the resolved name/avatar into the shared
 * user roster (see docs/specs/shared-profile-rosters.md).
 */

interface LobbyInput {
  chatName: string | Default<"Group Chat">;
  messages: Writable<Message[] | Default<[]>>;
  users: Writable<User[] | Default<[]>>;
  sessionId: Writable<string | Default<"">>;
}

export interface LobbyOutput {
  [NAME]: string;
  [UI]: VNode;
  chatName: string | Default<"Group Chat">;
  messages: Writable<Message[] | Default<[]>>;
  users: Writable<User[] | Default<[]>>;
  sessionId: Writable<string | Default<"">>;
}

// Handler to reset the lobby (clear all state and generate new session)
const resetLobby = handler<
  unknown,
  {
    messages: Writable<Message[]>;
    users: Writable<User[]>;
    sessionId: Writable<string>;
  }
>((_event, { messages, users, sessionId }) => {
  console.log("[resetLobby] Resetting all chat state...");
  // Generate new session ID to invalidate all existing chat room connections
  const newSessionId = `session-${Date.now()}-${
    Math.random().toString(36).slice(2)
  }`;
  sessionId.set(newSessionId);
  messages.set([]);
  users.set([]);
  console.log(
    "[resetLobby] Chat state reset complete, new session:",
    newSessionId,
  );
});

// Handler for joining the chat. `name`/`avatar` arrive as plain strings
// resolved from the viewer's shared profile (named `computed` values
// auto-unwrap as handler state); `profile` is the live profile cell — the
// STABLE identity key. Display names are mutable and not unique across users
// (two profiles can both be "Alex"), so re-join detection compares profile
// cells with `equals()`, never names.
const joinChat = handler<
  unknown,
  {
    messages: Writable<Message[]>;
    users: Writable<User[]>;
    sessionId: Writable<string>;
    // May be undefined until the viewer's `#profile` wish resolves.
    profile: ParticipantProfileCell | undefined;
    name: string;
    avatar: string;
  }
>((_event, { messages, users, sessionId, profile, name, avatar }) => {
  const trimmed = (name ?? "").trim();
  if (!trimmed || !profile) {
    console.log("[joinChat] No resolved profile yet, returning");
    return;
  }
  console.log("[joinChat] Name:", trimmed);

  // Initialize session ID if not set (first user joining)
  let currentSessionId = sessionId.get();
  if (!currentSessionId) {
    currentSessionId = `session-${Date.now()}-${
      Math.random().toString(36).slice(2)
    }`;
    sessionId.set(currentSessionId);
    console.log("[joinChat] Initialized new session:", currentSessionId);
  }

  // Re-join check by profile-cell identity: the same user (even after a
  // rename) navigates back in under their previously claimed display name.
  const existingUsers = users.get() || [];
  const mine = existingUsers.find(
    (u) => u.profile && equals(u.profile, profile),
  );
  let displayName = trimmed;
  if (mine) {
    displayName = mine.name;
  } else {
    // The room keys messages/reactions on the display name, so it must stay
    // unique within this roster — disambiguate when a DIFFERENT profile
    // already claimed the same name.
    let suffix = 2;
    while (existingUsers.some((u) => u.name === displayName)) {
      displayName = `${trimmed} ${suffix++}`;
    }
    users.push({
      name: displayName,
      joinedAt: Date.now(),
      avatar: (avatar ?? "").trim(),
      profile,
    });
    console.log("[joinChat] User added:", displayName);

    // Add system message for join
    messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      author: "System",
      content: `${displayName} joined the chat`,
      timestamp: Date.now(),
      type: "system",
      reactions: [],
    });
  }

  // Create chat room instance and navigate
  // Pass both the session ID at join time (mySessionId) and the Cell reference to check against (currentSessionId)
  console.log(
    "[joinChat] Navigating to chat room with session:",
    currentSessionId,
  );
  const roomInstance = GroupChatRoom({
    messages,
    users,
    myName: displayName,
    mySessionId: currentSessionId,
    currentSessionId: sessionId,
  });

  return navigateTo(roomInstance);
});

export default pattern<LobbyInput, LobbyOutput>(
  ({ chatName, messages, users, sessionId }) => {
    // Resolve THIS viewer's shared profile. The `#profile` wish's built-in UI
    // covers the whole lifecycle: a create surface when the viewer has no
    // profile, a link when they have one, and a picker (with inline create)
    // when they have several. The field targets give the snapshot strings.
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
    const profile = resultOf(profileWish.result);

    const myName = hasError(profileNameWish.result)
      ? ""
      : resultOf(profileNameWish.result);
    const myAvatar = hasError(profileAvatarWish.result)
      ? ""
      : resultOf(profileAvatarWish.result);
    const hasProfile = computed(() => myName.trim() !== "");
    const joinLabel = computed(() =>
      hasProfile ? `Join as ${myName}` : "Create a profile to join"
    );

    const userCount = computed(() => users.get().length);

    const join = joinChat({
      messages,
      users,
      sessionId,
      profile,
      name: myName,
      avatar: myAvatar,
    });

    return {
      [NAME]: computed(() => `${chatName} - Lobby`),
      [UI]: (
        <div
          style={{
            display: "flex",
            height: "100%",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
            backgroundColor: "#f2f2f7",
          }}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "2rem",
            }}
          >
            <h1
              style={{
                marginBottom: "0.5rem",
                color: "#1c1c1e",
                fontSize: "2.5rem",
                fontWeight: "700",
                letterSpacing: "-0.02em",
              }}
            >
              {chatName}
            </h1>
            <p
              style={{
                marginBottom: "2rem",
                color: "#8e8e93",
                fontSize: "1.1rem",
              }}
            >
              Join the conversation with your profile
            </p>

            {/* Join Form Card */}
            <div
              style={{
                width: "320px",
                padding: "1.5rem",
                backgroundColor: "white",
                borderRadius: "16px",
                boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                marginBottom: "1.5rem",
              }}
            >
              <div
                style={{
                  fontSize: "0.75rem",
                  fontWeight: "500",
                  color: "#8e8e93",
                  marginBottom: "0.75rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Your profile
              </div>
              {
                /* Built-in profile UI: create a profile when there is none,
                  pick between (or add to) existing profiles otherwise. */
              }
              <div style={{ marginBottom: "1rem" }}>{profileWish[UI]}</div>
              <button
                type="button"
                disabled={computed(() => !hasProfile)}
                style={{
                  width: "100%",
                  padding: "0.75rem 1.5rem",
                  fontSize: "1rem",
                  backgroundColor: computed(() =>
                    hasProfile ? "#007AFF" : "#b9b9c0"
                  ),
                  color: "white",
                  fontWeight: "600",
                  border: "none",
                  borderRadius: "8px",
                  cursor: computed(() => hasProfile ? "pointer" : "default"),
                }}
                onClick={join}
              >
                {joinLabel}
              </button>
            </div>

            {/* Active Users Section */}
            {ifElse(
              userCount,
              <div
                style={{
                  width: "320px",
                  padding: "1rem 1.5rem",
                  backgroundColor: "white",
                  borderRadius: "16px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                }}
              >
                <div
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: "500",
                    color: "#8e8e93",
                    marginBottom: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Now chatting
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                  }}
                >
                  {users.map((user) => (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        padding: "0.5rem 0.75rem",
                        backgroundColor: "#f2f2f7",
                        borderRadius: "20px",
                      }}
                    >
                      <cf-avatar src={user.avatar} name={user.name} size="xs" />
                      <span
                        style={{
                          fontSize: "0.875rem",
                          fontWeight: "500",
                          color: "#1c1c1e",
                        }}
                      >
                        {user.name}
                      </span>
                    </div>
                  ))}
                </div>
              </div>,
              <></>,
            )}

            {/* Reset Button */}
            <button
              type="button"
              style={{
                marginTop: "1.5rem",
                padding: "0.5rem 1rem",
                fontSize: "0.875rem",
                background: "none",
                color: "#8e8e93",
                fontWeight: "400",
                border: "none",
                cursor: "pointer",
              }}
              onClick={resetLobby({ messages, users, sessionId })}
            >
              Reset
            </button>
          </div>
        </div>
      ),
      chatName,
      messages,
      users,
      sessionId,
    };
  },
);
