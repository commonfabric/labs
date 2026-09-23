import {
  Default,
  handler,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface ChatMessage {
  author: string;
  body: string;
  sentAt: number;
}

export interface Room {
  name: string;
  messages: ChatMessage[] | Default<[]>;
}

export interface Conversation {
  rooms: Room[] | Default<[]>;
}

export interface SelectedRoom {
  room?: Room;
}

// The Send button delivers the serialized DOM click (`type`, `provenance`,
// target scalars), which a closed event schema refuses before the handler runs.
// The handler reads nothing from its event, so it declares none.
export type SendMessageEvent = void;

export interface AddRoomEvent {
  name?: string;
}

export interface SelectRoomEvent {
  room?: Room;
}

const DEFAULT_CONVERSATION = {
  rooms: [],
} satisfies Conversation;

const EMPTY_ROOM = { name: "", messages: [] } satisfies Room;

type NameCell = Writable<string | Default<"">>;
type EmptySelectedRoom = Record<PropertyKey, never>;
type SelectedRoomCell = Writable<SelectedRoom | Default<EmptySelectedRoom>>;
type ConversationCell = Writable<
  Conversation | Default<typeof DEFAULT_CONVERSATION>
>;
type DraftCell = Writable<string | Default<"">>;
type NewRoomNameCell = Writable<string | Default<"">>;
type RoomCell = Writable<Room>;

const CHAT_THEME = {
  fontFamily:
    "'Avenir Next', 'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  monoFontFamily: "'SF Mono', 'Roboto Mono', ui-monospace, monospace",
  borderRadius: "8px",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#1f6f5b",
    primaryForeground: "#ffffff",
    secondary: "#34435f",
    secondaryForeground: "#ffffff",
    background: "#eef4f1",
    surface: "#ffffff",
    surfaceHover: "#f3f7f5",
    text: "#14211f",
    textMuted: "#5d6f68",
    border: "#cbd9d3",
    borderMuted: "#e2ebe7",
    accent: "#c2573a",
    accentForeground: "#ffffff",
    success: "#2f8a64",
    successForeground: "#ffffff",
    error: "#a33b35",
    errorForeground: "#ffffff",
    warning: "#b27722",
    warningForeground: "#ffffff",
  },
};

const shellStyle = {
  height: "100%",
  minHeight: "620px",
  background: "linear-gradient(160deg, #eef4f1 0%, #ffffff 46%, #e8f0ec 100%)",
};

const headerStyle = {
  padding: "18px 20px 12px",
  borderBottom: "1px solid var(--cf-theme-color-border-muted)",
  background:
    "linear-gradient(90deg, rgba(31,111,91,0.12), rgba(194,87,58,0.10))",
};

const panelStyle = {
  border: "1px solid var(--cf-theme-color-border)",
  borderRadius: "8px",
  background: "rgba(255,255,255,0.9)",
  boxShadow: "0 12px 32px rgba(31, 55, 49, 0.10)",
};

const composerStyle = {
  padding: "14px 16px",
  borderTop: "1px solid var(--cf-theme-color-border-muted)",
  background: "rgba(255,255,255,0.92)",
};

const metaTextStyle = {
  color: "var(--cf-theme-color-text-muted)",
  fontSize: "13px",
};

const senderName = (name?: string) => name?.trim() || "Anonymous";

const sendMessage = handler<SendMessageEvent, {
  name: NameCell;
  selectedRoom: SelectedRoomCell;
  conversation: ConversationCell;
  draft: DraftCell;
}>((_, { name, selectedRoom, conversation, draft }) => {
  const body = draft.get().trim();
  if (!body) return;

  const author = senderName(name.get());
  const sentAt = Date.now();

  const selectedRoomRef = selectedRoom.key("room");
  const hasSelectedRoom = selectedRoomRef.get();
  const roomRef = hasSelectedRoom
    ? selectedRoomRef
    : conversation.key("rooms", 0);
  if (!roomRef.get()) {
    return;
  }
  if (!hasSelectedRoom) {
    selectedRoom.set({ room: roomRef });
  }

  roomRef.key("messages").push({
    author,
    body,
    sentAt,
  });
  draft.set("");
});

const addRoom = handler<AddRoomEvent, {
  conversation: ConversationCell;
  selectedRoom: SelectedRoomCell;
  newRoomName: NewRoomNameCell;
}>(({ name: eventName }, { conversation, selectedRoom, newRoomName }) => {
  const name = (eventName ?? newRoomName.get()).trim();
  if (!name) return;

  const rooms = conversation.key("rooms");
  rooms.push({ name, messages: [] });
  selectedRoom.set({ room: rooms.key(rooms.get().length - 1) });
  newRoomName.set("");
});

const selectRoom = handler<SelectRoomEvent, {
  selectedRoom: SelectedRoomCell;
}>(
  ({ room }, { selectedRoom }) => {
    if (room) selectedRoom.set({ room });
  },
);

export interface ScopedGroupChatInput {
  name?: PerUser<string | Default<"">>;
  selectedRoom?: PerSession<SelectedRoom | Default<EmptySelectedRoom>>;
  conversation?: PerSpace<Conversation | Default<typeof DEFAULT_CONVERSATION>>;
  draft?: PerUser<string | Default<"">>;
  newRoomName?: PerSession<string | Default<"">>;
}

export interface ScopedGroupChatOutput {
  [NAME]: string;
  [UI]: VNode;
  name: PerUser<string | Default<"">>;
  selectedRoom: PerSession<SelectedRoom | Default<EmptySelectedRoom>>;
  conversation: PerSpace<Conversation | Default<typeof DEFAULT_CONVERSATION>>;
  draft: PerUser<string | Default<"">>;
  newRoomName: PerSession<string | Default<"">>;
  messageCount: number;
  roomCount: number;
  sendMessage: Stream<SendMessageEvent>;
  addRoom: Stream<AddRoomEvent>;
  selectRoom: Stream<SelectRoomEvent>;
}

export default pattern<ScopedGroupChatInput, ScopedGroupChatOutput>(
  ({ name, selectedRoom, conversation, draft, newRoomName }) => {
    const boundAddRoom = addRoom({
      conversation,
      selectedRoom,
      newRoomName,
    });
    const boundSelectRoom = selectRoom({ selectedRoom });
    const rooms = conversation.rooms;
    const selectedRoomValue = selectedRoom.room ?? EMPTY_ROOM;
    const messagesInSelectedRoom = selectedRoomValue.messages;
    const messageCount = messagesInSelectedRoom.length;
    const displayedRoomLabel = selectedRoomValue.name || "No room";
    const send = sendMessage({
      name,
      selectedRoom,
      conversation,
      draft,
    });
    const roomCount = rooms.length;
    return {
      [NAME]: "Scoped group chat",
      [UI]: (
        <cf-theme theme={CHAT_THEME}>
          <cf-screen style={shellStyle}>
            <cf-vstack slot="header" gap="3" style={headerStyle}>
              <cf-hstack justify="between" align="center" gap="4">
                <div>
                  <cf-heading level={2}>Group chat</cf-heading>
                </div>
                <cf-vstack gap="1" style="width: 220px;">
                  <cf-label>Your name</cf-label>
                  <cf-input
                    $value={name}
                    placeholder="Ada Lovelace"
                    aria-label="Your name"
                    timing-strategy="immediate"
                  />
                </cf-vstack>
              </cf-hstack>
            </cf-vstack>

            <cf-vscroll flex showScrollbar fadeEdges>
              <cf-vstack gap="3" padding="4">
                <cf-hstack gap="3" align="center">
                  <cf-tab-list variant="chip">
                    {rooms.map((room) => (
                      <cf-tab
                        value={room.name}
                        selected={selectedRoomValue.name === room.name}
                        onClick={() => boundSelectRoom.send({ room })}
                      >
                        {room.name} · {room.messages.length}
                      </cf-tab>
                    ))}
                  </cf-tab-list>
                  <cf-hstack gap="2" align="center" style="width: 280px;">
                    <cf-input
                      $value={newRoomName}
                      placeholder="Room name"
                      aria-label="Room name"
                      timing-strategy="immediate"
                    />
                    <cf-button onClick={boundAddRoom}>
                      Add
                    </cf-button>
                  </cf-hstack>
                </cf-hstack>

                <section style={panelStyle}>
                  <cf-vstack gap="3" style="padding: 16px;">
                    <cf-hstack justify="between" align="center">
                      <cf-heading level={3}>{displayedRoomLabel}</cf-heading>
                      <div style={metaTextStyle}>{messageCount} total</div>
                    </cf-hstack>

                    {messageCount === 0
                      ? (
                        <cf-card style="border-style: dashed;">
                          <cf-vstack slot="content" gap="1">
                            <cf-heading level={4}>No messages yet</cf-heading>
                            <div style={metaTextStyle}>
                              Start the room with a short note.
                            </div>
                          </cf-vstack>
                        </cf-card>
                      )
                      : (
                        <cf-vstack gap="2">
                          {messagesInSelectedRoom.map((message) => {
                            const author = message.author;
                            const isMine = author === senderName(name);
                            return (
                              <div
                                style={{
                                  display: "flex",
                                  width: "100%",
                                  justifyContent: isMine
                                    ? "flex-end"
                                    : "flex-start",
                                }}
                              >
                                <div
                                  style={{
                                    maxWidth: "72%",
                                    padding: "10px 12px",
                                    borderRadius: "8px",
                                    background: isMine
                                      ? "var(--cf-theme-color-primary)"
                                      : "var(--cf-theme-color-surface)",
                                    color: isMine
                                      ? "var(--cf-theme-color-primary-foreground)"
                                      : "var(--cf-theme-color-text)",
                                    border:
                                      "1px solid var(--cf-theme-color-border-muted)",
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: "12px",
                                      fontWeight: 600,
                                      marginBottom: "4px",
                                      opacity: 0.8,
                                    }}
                                  >
                                    {author}
                                  </div>
                                  <div style={{ whiteSpace: "pre-wrap" }}>
                                    {message.body}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </cf-vstack>
                      )}
                  </cf-vstack>
                </section>
              </cf-vstack>
            </cf-vscroll>

            <cf-hstack slot="footer" gap="3" align="end" style={composerStyle}>
              <cf-vstack gap="1" style="flex: 1;">
                <cf-label>Message</cf-label>
                <cf-input
                  $value={draft}
                  placeholder={`Message ${displayedRoomLabel}`}
                  aria-label="Message"
                  timing-strategy="immediate"
                />
              </cf-vstack>
              <cf-button onClick={send}>
                Send
              </cf-button>
            </cf-hstack>
          </cf-screen>
        </cf-theme>
      ),
      name,
      selectedRoom,
      conversation,
      draft,
      newRoomName,
      messageCount,
      roomCount,
      sendMessage: send,
      addRoom: boundAddRoom,
      selectRoom: boundSelectRoom,
    };
  },
);
