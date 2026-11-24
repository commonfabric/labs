import {
  type Cell,
  computed,
  Default,
  type FabricBytes,
  handler,
  ifElse,
  ImageData,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/**
 * Group Chat Room Pattern v9
 *
 * Features:
 * 1. Pictures come from each user's shared profile (snapshotted on join in the
 *    lobby) and render via cf-avatar
 * 2. Camera icon sends images to chat
 * 3. Emoji reactions on messages with hover UI
 */

// Emoji reaction type
export interface Reaction {
  emoji: string;
  userNames: string[];
}

export interface Message {
  id: string;
  author: string;
  content: string;
  timestamp: number;
  type: "chat" | "system" | "image";
  imageUrl?: string;
  reactions: Reaction[];
}

/**
 * Stable identity for a user: the joiner's own `#profile` cell. Display names
 * are mutable and not unique across users, so they must not be the identity
 * key — compare profile cells with `equals()` instead (see
 * `docs/specs/shared-profile-rosters.md`).
 */
export type ParticipantProfileCell = Cell<{ name?: string; avatar?: string }>;

export interface User {
  /**
   * Display name shown in the room. Unique within this roster (the lobby
   * disambiguates collisions) because messages/reactions key on it.
   */
  name: string;
  joinedAt: number;

  /** Picture bytes, snapshotted from the joiner's shared profile. */
  picture?: FabricBytes;

  /** Avatar text, snapshotted instead when the joiner's profile has no
   * picture. */
  avatar?: string;

  /**
   * Link to the joiner's profile cell — the stable identity key (optional so
   * rosters written before the profile migration still load).
   */
  profile?: ParticipantProfileCell;
}

interface RoomInput {
  messages: Writable<Message[] | Default<[]>>;
  users: Writable<User[] | Default<[]>>;
  myName: string | Default<"">;
  mySessionId: string | Default<"">;
  currentSessionId: Writable<string | Default<"">>;
}

export interface RoomOutput {
  [NAME]: string;
  [UI]: VNode;
  myName: string | Default<"">;
}

// Common reaction emojis
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "😡"];

// Handler to send a text message
const sendMessage = handler<
  unknown,
  {
    messages: Writable<Message[]>;
    myName: string;
    contentInput: Writable<string>;
  }
>((_event, { messages, myName, contentInput }) => {
  const content = contentInput.get().trim();
  if (!content || !myName) return;

  messages.push({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    author: myName,
    content,
    timestamp: Date.now(),
    type: "chat",
    reactions: [],
  });

  contentInput.set("");
});

// Handler to send an image message
const sendImageMessage = handler<
  unknown,
  {
    messages: Writable<Message[]>;
    myName: string;
    chatImages: Writable<ImageData[]>;
  }
>((_event, { messages, myName, chatImages }) => {
  const images = chatImages.get() || [];
  if (images.length === 0 || !myName) return;

  const image = images[0];
  messages.push({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    author: myName,
    content: "",
    imageUrl: image.url,
    timestamp: Date.now(),
    type: "image",
    reactions: [],
  });

  chatImages.set([]);
});

// Handler to clear pending images
const clearImages = handler<
  unknown,
  { images: Writable<ImageData[]> }
>((_event, { images }) => {
  images.set([]);
});

type ImageUploadEvent = {
  detail?: {
    images?: ImageData[];
    files?: ImageData[];
  };
};

const setUploadedImage = handler<
  ImageUploadEvent,
  { images: Writable<ImageData[]> }
>(({ detail }, { images }) => {
  const uploaded = detail?.images ?? detail?.files ?? [];
  const first = uploaded[0];
  images.set(first ? [first] : []);
});

// Handler to toggle emoji picker for a message
const toggleEmojiPicker = handler<
  unknown,
  { emojiPickerMessageId: Writable<string>; msgId: string }
>((_event, { emojiPickerMessageId, msgId }) => {
  const current = emojiPickerMessageId.get();
  // Toggle: if already open for this message, close it; otherwise open for this message
  emojiPickerMessageId.set(current === msgId ? "" : msgId);
});

// Handler to add/toggle a reaction on a message
const toggleReaction = handler<
  unknown,
  {
    messages: Writable<Message[]>;
    msgId: string;
    emoji: string;
    myName: string;
    emojiPickerMessageId: Writable<string>;
  }
>((_event, { messages, msgId, emoji, myName, emojiPickerMessageId }) => {
  const msgs = messages.get() || [];
  const msgIndex = msgs.findIndex((m: Message) => m && m.id === msgId);
  if (msgIndex < 0) return;

  const msg = msgs[msgIndex];
  const reactions = [...(msg.reactions || [])];

  const existingIdx = reactions.findIndex((r: Reaction) => r.emoji === emoji);

  if (existingIdx >= 0) {
    const reaction = { ...reactions[existingIdx] };
    if (reaction.userNames.includes(myName)) {
      reaction.userNames = reaction.userNames.filter((n: string) =>
        n !== myName
      );
      if (reaction.userNames.length === 0) {
        reactions.splice(existingIdx, 1);
      } else {
        reactions[existingIdx] = reaction;
      }
    } else {
      reaction.userNames = [...reaction.userNames, myName];
      reactions[existingIdx] = reaction;
    }
  } else {
    reactions.push({ emoji, userNames: [myName] });
  }

  const updatedMsgs = [...msgs];
  updatedMsgs[msgIndex] = { ...msg, reactions };
  messages.set(updatedMsgs);

  // Close the emoji picker after selecting
  emojiPickerMessageId.set("");
});

export default pattern<RoomInput, RoomOutput>(
  ({ messages, users, myName, mySessionId, currentSessionId }) => {
    const contentInput = new Writable("");
    const chatImages = new Writable<ImageData[]>([]);
    const emojiPickerMessageId = new Writable<string>("");

    const userList = computed(
      () => (users.get() || []).filter((user: User) => user && user.name),
    );
    const myNameResolved = computed(() => myName || "");

    const hasPendingChatImage = computed(
      () => chatImages.get() && chatImages.get().length > 0,
    );
    const pendingChatImageUrl = computed(() => {
      const imgs = chatImages.get();
      if (!imgs || imgs.length === 0) {
        return "";
      }
      return imgs[0].url || "";
    });

    const isSessionValid = computed(() => {
      const currentSessId = currentSessionId.get();
      if (!mySessionId || !currentSessId) return true;
      return mySessionId === currentSessId;
    });

    const myUser = computed(() => {
      const resolved = myNameResolved;
      return (users.get() || []).find((user: User) => user.name === resolved);
    });

    const myPicture = computed(() => myUser?.picture);
    const myAvatar = computed(() => myUser?.avatar || "");

    return {
      [NAME]: computed(() => `Chat: ${myName}`),
      [UI]: (
        <div
          style={{
            display: "flex",
            height: "100%",
            fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
          }}
        >
          {ifElse(
            isSessionValid,
            <>
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  padding: "1rem",
                }}
              >
                {/* Header with user list */}
                <div
                  style={{
                    padding: "0.75rem 1rem",
                    backgroundColor: "white",
                    borderRadius: "12px",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                    marginBottom: "1rem",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.7rem",
                      fontWeight: "500",
                      color: "#8e8e93",
                      marginBottom: "0.5rem",
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
                      paddingBottom: "0.75rem",
                      borderBottom: "1px solid #e5e5ea",
                    }}
                  >
                    {userList.map((user) => (
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
                        <cf-avatar
                          bytes={user.picture}
                          src={user.avatar}
                          name={user.name}
                          size="xs"
                        />
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
                </div>

                {/* Messages Container */}
                <div
                  style={{
                    flex: 1,
                    overflowY: "auto",
                    marginBottom: "1rem",
                    padding: "0.5rem",
                    backgroundColor: "#f5f5f7",
                    borderRadius: "12px",
                  }}
                >
                  {messages.map((msg) => {
                    // Guard against undefined messages in the array
                    const isValidMessage = computed(() => msg && msg.id);
                    const isMyMessage = computed(() =>
                      msg && msg.author === myNameResolved
                    );
                    const isSystemMessage = computed(() =>
                      msg && msg.type === "system"
                    );
                    const isImageMessage = computed(() =>
                      msg && msg.type === "image"
                    );
                    const author = computed(() =>
                      msg
                        ? (users.get() || []).find((usr: User) =>
                          usr && usr.name === msg.author
                        )
                        : undefined
                    );
                    const authorPicture = computed(() => author?.picture);
                    const authorAvatar = computed(() => author?.avatar || "");
                    const isFirstInAuthorBlock = computed(() => {
                      if (!msg) return true;
                      const msgArray = (messages.get() || []).filter((
                        message: Message,
                      ) => message && message.id);
                      const currentIndex = msgArray.findIndex((
                        message: Message,
                      ) => message && message.id === msg.id);
                      if (currentIndex <= 0) return true;
                      const prevMessage = msgArray[currentIndex - 1];
                      if (!prevMessage) return true;
                      return prevMessage.author !== msg.author ||
                        prevMessage.type === "system";
                    });
                    const shouldShowAvatar = computed(() =>
                      !isMyMessage && isFirstInAuthorBlock
                    );

                    // Check if emoji picker is open for this message
                    const isPickerOpen = computed(
                      () => msg.id && emojiPickerMessageId.get() === msg.id,
                    );

                    return (
                      <div
                        style={{
                          display: computed(() =>
                            isValidMessage ? "flex" : "none"
                          ),
                          marginBottom: computed(() => {
                            if (!msg) {
                              return "8px";
                            }
                            const msgArray = (messages.get() || []).filter((
                              message: Message,
                            ) => message && message.id);
                            const currentIndex = msgArray.findIndex((
                              message: Message,
                            ) => message && message.id === msg.id);
                            if (
                              currentIndex < 0 ||
                              currentIndex >= msgArray.length - 1
                            ) return "8px";
                            const nextMessage = msgArray[currentIndex + 1];
                            if (!nextMessage) return "8px";
                            return nextMessage.author === msg.author &&
                                nextMessage.type !== "system"
                              ? "2px"
                              : "8px";
                          }),
                          flexDirection: computed(() =>
                            !msg
                              ? "row"
                              : (msg.type === "system"
                                ? "column"
                                : (msg.author === myNameResolved
                                  ? "row-reverse"
                                  : "row"))
                          ),
                          alignItems: "flex-end",
                          gap: "8px",
                        }}
                      >
                        {ifElse(
                          isSystemMessage,
                          <div
                            style={{
                              width: "100%",
                              textAlign: "center",
                              padding: "8px 12px",
                              fontSize: "13px",
                              color: "#6b7280",
                              fontStyle: "italic",
                            }}
                          >
                            {msg.content}
                          </div>,
                          <>
                            {/* Avatar */}
                            {ifElse(
                              isMyMessage,
                              null,
                              ifElse(
                                shouldShowAvatar,
                                <cf-avatar
                                  bytes={authorPicture}
                                  src={authorAvatar}
                                  name={msg.author}
                                  size="sm"
                                  style={{ flexShrink: "0" }}
                                />,
                                <div
                                  style={{ width: "32px", flexShrink: "0" }}
                                />,
                              ),
                            )}

                            {/* Message bubble and reactions */}
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: computed(() =>
                                  msg && msg.author === myNameResolved
                                    ? "flex-end"
                                    : "flex-start"
                                ),
                              }}
                            >
                              {/* Author name */}
                              {ifElse(
                                shouldShowAvatar,
                                <div
                                  style={{
                                    fontSize: "12px",
                                    fontWeight: "600",
                                    color: "#86868b",
                                    marginBottom: "2px",
                                    marginLeft: "4px",
                                  }}
                                >
                                  {msg.author}
                                </div>,
                                null,
                              )}

                              {/* Bubble - text or image */}
                              {ifElse(
                                isImageMessage,
                                <img
                                  src={msg.imageUrl}
                                  style={{
                                    maxWidth: "200px",
                                    maxHeight: "200px",
                                    borderRadius: "12px",
                                    objectFit: "cover",
                                  }}
                                />,
                                <div
                                  style={{
                                    width: "fit-content",
                                    maxWidth: "66%",
                                    padding: "10px 14px",
                                    borderRadius: "18px",
                                    borderBottomRightRadius: computed(() =>
                                      msg && msg.author === myNameResolved
                                        ? "4px"
                                        : "18px"
                                    ),
                                    borderBottomLeftRadius: computed(() =>
                                      msg && msg.author === myNameResolved
                                        ? "18px"
                                        : "4px"
                                    ),
                                    backgroundColor: computed(() =>
                                      msg && msg.author === myNameResolved
                                        ? "#007AFF"
                                        : "#E5E5EA"
                                    ),
                                    color: computed(() =>
                                      msg && msg.author === myNameResolved
                                        ? "white"
                                        : "#1d1d1f"
                                    ),
                                    fontSize: "15px",
                                    lineHeight: "1.4",
                                  }}
                                >
                                  {msg.content}
                                </div>,
                              )}

                              {/* Reactions row */}
                              <div
                                style={{
                                  display: "flex",
                                  gap: "4px",
                                  marginTop: "4px",
                                  marginBottom: "12px",
                                  flexWrap: "wrap",
                                  alignItems: "center",
                                }}
                              >
                                {/* Existing reactions */}
                                {msg.reactions.map((reaction) => (
                                  <button
                                    type="button"
                                    onClick={toggleReaction({
                                      messages,
                                      msgId: msg.id,
                                      emoji: reaction.emoji,
                                      myName,
                                      emojiPickerMessageId,
                                    })}
                                    style={{
                                      padding: "2px 6px",
                                      fontSize: "12px",
                                      backgroundColor: "#f0f0f0",
                                      borderRadius: "12px",
                                      border: "1px solid #e0e0e0",
                                      cursor: "pointer",
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "2px",
                                    }}
                                  >
                                    {reaction.emoji}
                                    <span
                                      style={{
                                        fontSize: "11px",
                                        color: "#666",
                                      }}
                                    >
                                      {computed(() =>
                                        reaction && reaction.userNames
                                          ? reaction.userNames.length
                                          : 0
                                      )}
                                    </span>
                                  </button>
                                ))}

                                {/* Add reaction button - always visible, click to toggle picker */}
                                <button
                                  type="button"
                                  onClick={toggleEmojiPicker({
                                    emojiPickerMessageId,
                                    msgId: msg.id,
                                  })}
                                  style={{
                                    padding: "2px 6px",
                                    fontSize: "12px",
                                    backgroundColor: "#f8f8f8",
                                    borderRadius: "12px",
                                    border: "1px solid #e0e0e0",
                                    cursor: "pointer",
                                    color: "#888",
                                  }}
                                >
                                  +
                                </button>

                                {/* Emoji picker (visible when toggled) - positioned inline to avoid clipping */}
                                {ifElse(
                                  isPickerOpen,
                                  <div
                                    style={{
                                      display: "inline-flex",
                                      gap: "2px",
                                      padding: "4px 6px",
                                      backgroundColor: "white",
                                      borderRadius: "16px",
                                      border: "1px solid #e0e0e0",
                                      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                                      marginLeft: "4px",
                                    }}
                                  >
                                    {REACTION_EMOJIS.map((emoji) => (
                                      <button
                                        type="button"
                                        onClick={toggleReaction({
                                          messages,
                                          msgId: msg.id,
                                          emoji,
                                          myName,
                                          emojiPickerMessageId,
                                        })}
                                        style={{
                                          padding: "2px 4px",
                                          fontSize: "14px",
                                          background: "none",
                                          border: "none",
                                          cursor: "pointer",
                                          borderRadius: "4px",
                                        }}
                                      >
                                        {emoji}
                                      </button>
                                    ))}
                                  </div>,
                                  null,
                                )}
                              </div>
                            </div>
                          </>,
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Input Area */}
                <div
                  style={{
                    padding: "0.75rem",
                    backgroundColor: "#f0f9ff",
                    borderRadius: "8px",
                    border: "1px solid #bae6fd",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.75rem",
                      marginBottom: "0.5rem",
                    }}
                  >
                    {
                      /* Profile picture (snapshotted from the shared profile
                        when the user joined in the lobby) */
                    }
                    <cf-avatar
                      bytes={myPicture}
                      src={myAvatar}
                      name={myNameResolved}
                      size="md"
                    />

                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: "0.875rem",
                          fontWeight: "600",
                          color: "#0369a1",
                        }}
                      >
                        Chatting as:{" "}
                        <strong style={{ color: "#0c4a6e" }}>{myName}</strong>
                      </div>
                    </div>

                    {/* Attachment button for sending images to chat */}
                    <cf-image-input
                      maxImages={1}
                      showPreview={false}
                      buttonText="📎"
                      variant="ghost"
                      size="sm"
                      oncf-change={setUploadedImage({ images: chatImages })}
                    />

                    {/* Pending chat image preview */}
                    {ifElse(
                      hasPendingChatImage,
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                        }}
                      >
                        <img
                          src={pendingChatImageUrl}
                          style={{
                            width: "40px",
                            height: "40px",
                            borderRadius: "8px",
                            objectFit: "cover",
                            border: "2px solid #007AFF",
                          }}
                        />
                        <button
                          type="button"
                          style={{
                            padding: "0.25rem 0.5rem",
                            fontSize: "0.75rem",
                            backgroundColor: "#007AFF",
                            color: "white",
                            fontWeight: "600",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                          }}
                          onClick={sendImageMessage({
                            messages,
                            myName,
                            chatImages,
                          })}
                        >
                          Send
                        </button>
                        <button
                          type="button"
                          style={{
                            padding: "0.25rem 0.5rem",
                            fontSize: "0.75rem",
                            backgroundColor: "#FF3B30",
                            color: "white",
                            fontWeight: "600",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer",
                          }}
                          onClick={clearImages({ images: chatImages })}
                        >
                          ✗
                        </button>
                      </div>,
                      null,
                    )}
                  </div>

                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <cf-input
                      $value={contentInput}
                      placeholder="Type your message..."
                      style="flex: 1;"
                      timingStrategy="immediate"
                      oncf-submit={sendMessage({
                        messages,
                        myName,
                        contentInput,
                      })}
                    />
                    <cf-button
                      onClick={sendMessage({ messages, myName, contentInput })}
                    >
                      Send
                    </cf-button>
                  </div>
                </div>
              </div>
            </>,
            // Expired session
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: "2rem",
                backgroundColor: "#f2f2f7",
              }}
            >
              <div
                style={{
                  padding: "2rem",
                  backgroundColor: "white",
                  borderRadius: "16px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                  textAlign: "center",
                  maxWidth: "400px",
                }}
              >
                <div
                  style={{
                    width: "64px",
                    height: "64px",
                    borderRadius: "50%",
                    backgroundColor: "#FF3B30",
                    color: "white",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "32px",
                    margin: "0 auto 1rem",
                  }}
                >
                  !
                </div>
                <h2
                  style={{
                    color: "#1c1c1e",
                    fontSize: "1.5rem",
                    fontWeight: "600",
                    marginBottom: "0.5rem",
                  }}
                >
                  Session Expired
                </h2>
                <p
                  style={{
                    color: "#8e8e93",
                    fontSize: "1rem",
                    marginBottom: "1.5rem",
                    lineHeight: "1.5",
                  }}
                >
                  This chat session has been reset. Please return to the lobby
                  to join a new session.
                </p>
                <div
                  style={{
                    padding: "0.75rem 1.5rem",
                    backgroundColor: "#f2f2f7",
                    borderRadius: "8px",
                    color: "#8e8e93",
                    fontSize: "0.875rem",
                    marginBottom: "1rem",
                  }}
                >
                  You were chatting as:{" "}
                  <strong style={{ color: "#1c1c1e" }}>{myName}</strong>
                </div>
                <div
                  style={{
                    padding: "0.75rem 1.5rem",
                    fontSize: "0.875rem",
                    backgroundColor: "#e5e5ea",
                    borderRadius: "8px",
                    color: "#6b7280",
                  }}
                >
                  Use the back button to return to the lobby
                </div>
              </div>
            </div>,
          )}
        </div>
      ),
      myName,
    };
  },
);
