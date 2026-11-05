import {
  action,
  computed,
  equals,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  Stream,
  UI,
} from "commonfabric";
import {
  createRandomImportedClaimedMessages,
  seededRandom,
  sortDisplayMessages,
} from "./logic.ts";
import {
  chatAdminEveryoneIsAdmin,
  type ChatAdminRegistryCell,
  type ChatAdminRegistryValue,
  commitTrustedMessageSend,
  currentProfileCell,
  currentUserCanManageAdmins,
  currentUserIsAdmin as currentProfileIsAdmin,
  messagesValue,
  type MyProfileCell,
  participantClaimsValue,
  roomsValue,
  type SharedChatMessage,
  type SharedMessagesCell,
  type SharedMessagesValue,
  type SharedProfilesCell,
  type SharedProfilesValue,
  type SharedRoomsCell,
  type SharedRoomsValue,
  type SubmittedTextEvent,
  TrustedAdminPanel,
  type TrustedAdminPolicyEvent,
  TrustedChatSendSurface,
  TrustedProfileSaveSurface,
  TrustedRoomAddSurface,
} from "./trusted.tsx";

const messageCountText = (count: number): string =>
  count === 0 ? "No messages yet" : `${count} message${count === 1 ? "" : "s"}`;

const roomCountText = (count: number): string =>
  count === 0 ? "No rooms yet" : `${count} room${count === 1 ? "" : "s"}`;

interface SharedTranscriptInput {
  myProfile: MyProfileCell;
  messages: SharedMessagesCell;
  id: string;
}

const SharedTranscript = pattern<
  SharedTranscriptInput,
  { [NAME]: string; [UI]: any }
>((
  { myProfile, messages, id }: SharedTranscriptInput,
): { [NAME]: string; [UI]: any } => {
  const messageCountLabel = computed(() =>
    messageCountText(messagesValue(messages).length)
  );
  const transcriptRows = messages.map((messageCell) => {
    const authorProfile = messageCell.authorProfile;
    const isMine = computed(() =>
      equals(currentProfileCell(myProfile), authorProfile)
    );
    return (
      <div
        style={{
          display: "flex",
          width: "100%",
          justifyContent: isMine ? "flex-end" : "flex-start",
        }}
      >
        <div style={{ width: "min(34rem, 100%)" }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: isMine ? "flex-end" : "flex-start",
              gap: "4px",
              width: "100%",
            }}
          >
            <span
              style={{
                fontSize: "12px",
                color: "var(--cf-theme-color-text-secondary)",
              }}
            >
              {messageCell.authorName}
            </span>
            <cf-cfc-authorship
              $value={messageCell.body}
              $author={messageCell.authorProfile}
              authorName={messageCell.authorName}
              data-badge-placement={isMine ? "end" : "start"}
            >
              <span
                style={{
                  display: "inline-block",
                  maxWidth: "100%",
                  padding: "8px 10px",
                  borderRadius: isMine
                    ? "14px 14px 4px 14px"
                    : "14px 14px 14px 4px",
                  background: isMine
                    ? "var(--cf-theme-color-primary, #2563eb)"
                    : "var(--cf-theme-color-surface, #f3f4f6)",
                  color: isMine
                    ? "var(--cf-theme-color-primary-foreground, #ffffff)"
                    : "var(--cf-theme-color-text, #111827)",
                  overflowWrap: "anywhere",
                  whiteSpace: "pre-wrap",
                }}
              >
                {messageCell.body}
              </span>
            </cf-cfc-authorship>
          </div>
        </div>
      </div>
    );
  });

  return {
    [NAME]: computed(() => `${id} transcript`),
    [UI]: (
      <cf-vstack id={id} gap="3" style={{ minHeight: 0 }}>
        <cf-label>{messageCountLabel}</cf-label>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            maxHeight: "min(52vh, 32rem)",
            overflowY: "auto",
            overscrollBehavior: "contain",
            paddingRight: "0.25rem",
          }}
        >
          {transcriptRows}
        </div>
      </cf-vstack>
    ),
  };
});
type SharedTranscriptInputArg = Parameters<typeof SharedTranscript>[0];

interface RoomsListInput {
  rooms: SharedRoomsCell;
  id: string;
}

const RoomsList = pattern<RoomsListInput, { [NAME]: string; [UI]: any }>((
  { rooms, id }: RoomsListInput,
): { [NAME]: string; [UI]: any } => {
  const roomListText = computed(() => {
    const names = roomsValue(rooms).map((room) => room.name);
    return names.length === 0 ? "No rooms yet" : names.join(" · ");
  });

  return {
    [NAME]: computed(() => `${id} rooms`),
    [UI]: (
      <cf-hstack id={id} gap="2" wrap>
        <cf-chip
          label={roomListText}
          variant="accent"
        />
      </cf-hstack>
    ),
  };
});
type RoomsListInputArg = Parameters<typeof RoomsList>[0];

type TrustedChatSendSurfaceInputArg = Parameters<
  typeof TrustedChatSendSurface
>[0];
type TrustedProfileSaveSurfaceInputArg = Parameters<
  typeof TrustedProfileSaveSurface
>[0];
type TrustedAdminPanelInputArg = Parameters<typeof TrustedAdminPanel>[0];
type TrustedRoomAddSurfaceInputArg = Parameters<
  typeof TrustedRoomAddSurface
>[0];
type TrustedMessageSendInputArg = Parameters<typeof commitTrustedMessageSend>[
  0
];

export interface GroupChatDemoInput {
  myProfile?: PerUser<MyProfileCell>;
  profiles?: PerSpace<SharedProfilesCell>;
  messages?: PerSpace<SharedMessagesCell>;
  rooms?: PerSpace<SharedRoomsCell>;
  adminRegistry?: PerSpace<ChatAdminRegistryCell>;
}

export interface GroupChatDemoOutput {
  [NAME]: string;
  [UI]: any;
  myProfile: PerUser<MyProfileCell>;
  profiles: PerSpace<SharedProfilesCell>;
  messages: PerSpace<SharedMessagesCell>;
  rooms: PerSpace<SharedRoomsCell>;
  adminRegistry: PerSpace<ChatAdminRegistryCell>;
  currentProfileName: string;
  currentUserIsAdmin: boolean;
  currentUserCanManageAdmins: boolean;
  saveProfile: Stream<SubmittedTextEvent>;
  toggleCurrentUserAdmin: Stream<TrustedAdminPolicyEvent>;
  toggleParticipantAdmin: Stream<TrustedAdminPolicyEvent>;
  toggleEveryoneAdmin: Stream<TrustedAdminPolicyEvent>;
  sendTrustedMessage: Stream<SubmittedTextEvent>;
  addTrustedRoom: Stream<SubmittedTextEvent>;
  hostLookalikeSend: Stream<SubmittedTextEvent>;
  addRandomMessages: Stream<void>;
}

export const GroupChatDemo = pattern<GroupChatDemoInput, GroupChatDemoOutput>((
  {
    myProfile,
    profiles,
    messages,
    rooms,
    adminRegistry,
  }: GroupChatDemoInput,
): GroupChatDemoOutput => {
  const myProfileCell: MyProfileCell = myProfile!;
  const profilesCell: SharedProfilesCell = profiles!;
  const messagesCell: SharedMessagesCell = messages!;
  const roomsCell: SharedRoomsCell = rooms!;
  const adminRegistryCell: ChatAdminRegistryCell = adminRegistry!;
  const trustedProfileSave = TrustedProfileSaveSurface({
    myProfile: myProfileCell,
    profiles: profilesCell,
  } as TrustedProfileSaveSurfaceInputArg);
  const trustedAdminPanel = TrustedAdminPanel({
    profiles: profilesCell,
    myProfile: myProfileCell,
    messages: messagesCell,
    adminRegistry: adminRegistryCell,
  } as TrustedAdminPanelInputArg);
  const trustedSend = TrustedChatSendSurface({
    profiles: profilesCell,
    myProfile: myProfileCell,
    messages: messagesCell,
  } as TrustedChatSendSurfaceInputArg);
  const trustedRoomAdd = TrustedRoomAddSurface({
    myProfile: myProfileCell,
    adminRegistry: adminRegistryCell,
    rooms: roomsCell,
  } as TrustedRoomAddSurfaceInputArg);
  const hostLookalikeSend = commitTrustedMessageSend({
    myProfile: myProfileCell,
    messages: messagesCell,
  } as TrustedMessageSendInputArg);
  const participantCountLabel = computed(() => {
    const count =
      participantClaimsValue(profilesCell, myProfileCell, messagesCell).length;
    return `${count} participant${count === 1 ? "" : "s"}`;
  });
  const roomCountLabel = computed(() =>
    roomCountText(roomsValue(roomsCell).length)
  );
  const addRandomMessagesDisabled = computed(() =>
    participantClaimsValue(profilesCell, myProfileCell, messagesCell).length ===
      0 ||
    messagesValue(messagesCell).length === 0
  );
  const addRandomMessages = action(() => {
    const nextMessages = createRandomImportedClaimedMessages(
      sortDisplayMessages(messagesValue(messagesCell)),
      participantClaimsValue(profilesCell, myProfileCell, messagesCell),
      seededRandom(0xdecafbad),
    );
    nextMessages.forEach((message) =>
      messagesCell.push(message as SharedChatMessage)
    );
  });

  return {
    [NAME]: "CFC group chat demo",
    [UI]: (
      <cf-screen title="CFC group chat demo">
        <cf-vstack
          id="group-chat-demo"
          gap="4"
          style={{
            height: "100%",
            minHeight: "0",
            padding: "1rem",
          }}
        >
          <cf-card>
            <cf-vstack slot="content" gap="3">
              <cf-hstack justify="between" align="start" wrap gap="3">
                <cf-vstack gap="1">
                  <cf-heading level={2}>Group chat</cf-heading>
                  <cf-label>
                    Ordinary chat layout built from small reviewed CFC surfaces.
                  </cf-label>
                </cf-vstack>
                <cf-hstack gap="2" wrap>
                  <cf-chip
                    label={participantCountLabel}
                  />
                  <cf-chip
                    label={computed(() =>
                      messageCountText(messagesValue(messagesCell).length)
                    )}
                  />
                  <cf-chip
                    label={roomCountLabel}
                  />
                  <cf-chip
                    label={computed(() =>
                      currentProfileIsAdmin(myProfileCell, adminRegistryCell)
                        ? "Admin enabled"
                        : "Admin off"
                    )}
                  />
                  <cf-chip
                    id="group-chat-manager-chip"
                    label={computed(() =>
                      currentProfileCell(myProfileCell) === undefined
                        ? "No profile"
                        : chatAdminEveryoneIsAdmin(adminRegistryCell)
                        ? "Everyone is admin"
                        : currentUserCanManageAdmins(
                            myProfileCell,
                            adminRegistryCell,
                          )
                        ? "Can manage admins"
                        : "Manager off"
                    )}
                  />
                </cf-hstack>
              </cf-hstack>
            </cf-vstack>
          </cf-card>

          {trustedProfileSave}
          {trustedAdminPanel}

          <cf-card id="rooms-panel">
            <cf-vstack slot="content" gap="3">
              <cf-hstack justify="between" align="center" wrap gap="2">
                <cf-vstack gap="1">
                  <cf-heading level={3}>Rooms</cf-heading>
                  <cf-label>{roomCountLabel}</cf-label>
                </cf-vstack>
              </cf-hstack>
              {RoomsList({
                rooms: roomsCell,
                id: "trusted-room-list",
              } as RoomsListInputArg)}
              {trustedRoomAdd}
            </cf-vstack>
          </cf-card>

          <cf-card id="chat-panel">
            <cf-vstack slot="content" gap="3" style={{ minHeight: 0 }}>
              {SharedTranscript({
                myProfile: myProfileCell,
                messages: messagesCell,
                id: "trusted-conversation-preview",
              } as SharedTranscriptInputArg)}
              {trustedSend}
            </cf-vstack>
          </cf-card>

          <cf-card id="host-send-panel">
            <cf-submit-input
              slot="content"
              id="host-send-button"
              inputId="host-message-draft"
              placeholder="Write a message"
              buttonText="Send"
              onClick={hostLookalikeSend}
            />
          </cf-card>

          <cf-button
            id="add-random-messages"
            size="lg"
            style={{ width: "100%" }}
            disabled={addRandomMessagesDisabled}
            onClick={addRandomMessages}
          >
            Insert fake messages
          </cf-button>
        </cf-vstack>
      </cf-screen>
    ),
    myProfile: myProfileCell as PerUser<MyProfileCell>,
    profiles: profilesCell as PerSpace<SharedProfilesCell>,
    messages: messagesCell as PerSpace<SharedMessagesCell>,
    rooms: roomsCell as PerSpace<SharedRoomsCell>,
    adminRegistry: adminRegistryCell as PerSpace<ChatAdminRegistryCell>,
    currentProfileName: trustedProfileSave.currentProfileName,
    currentUserIsAdmin: computed(() =>
      currentProfileIsAdmin(myProfileCell, adminRegistryCell)
    ),
    currentUserCanManageAdmins: computed(() =>
      currentUserCanManageAdmins(myProfileCell, adminRegistryCell)
    ),
    saveProfile: trustedProfileSave.saveProfile,
    toggleCurrentUserAdmin: trustedAdminPanel.toggleCurrentUserAdmin,
    toggleParticipantAdmin: trustedAdminPanel.toggleParticipantAdmin,
    toggleEveryoneAdmin: trustedAdminPanel.toggleEveryoneAdmin,
    sendTrustedMessage: trustedSend.sendMessage,
    addTrustedRoom: trustedRoomAdd.addRoom,
    hostLookalikeSend,
    addRandomMessages,
  };
});

export default GroupChatDemo;

export type {
  ChatAdminRegistryValue,
  SharedMessagesValue,
  SharedProfilesValue,
  SharedRoomsValue,
};
