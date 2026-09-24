/**
 * FabriChat: a group chat among the people in a space, each identified by
 * their own profile, with every message attested as written by its sender.
 *
 * This is the room from `chat.tsx`, given the viewer's real profile. The
 * messages are shared by everyone in the space. A viewer with no profile can
 * read the conversation, and is offered the form that creates one.
 */
import {
  computed,
  NAME,
  pattern,
  type PerSpace,
  Stream,
  UI,
  type VNode,
  wish,
} from "commonfabric";
import {
  type FabriChatProfile,
  FabriChatRoom,
  type MessagesCell,
  type SubmittedTextEvent,
} from "./chat.tsx";

type FabriChatRoomInputArg = Parameters<typeof FabriChatRoom>[0];

export interface FabriChatInput {
  messages?: PerSpace<MessagesCell>;
}

export interface FabriChatOutput {
  [NAME]: string;
  [UI]: VNode;
  messages: PerSpace<MessagesCell>;
  sendMessage: Stream<SubmittedTextEvent>;
}

export default pattern<FabriChatInput, FabriChatOutput>(({ messages }) => {
  const messagesCell: MessagesCell = messages!;
  const profileWish = wish<FabriChatProfile>({ query: "#profile" });
  const profileNameWish = wish<string>({ query: "#profileName" });
  const profileAvatarWish = wish<string>({ query: "#profileAvatar" });

  const room = FabriChatRoom({
    myProfile: profileWish.result,
    myName: computed(() => profileNameWish.result ?? ""),
    myAvatar: computed(() => profileAvatarWish.result ?? ""),
    messages: messagesCell,
  } as FabriChatRoomInputArg);

  const hasProfile = computed(() => profileWish.result !== undefined);

  return {
    [NAME]: "FabriChat",
    [UI]: (
      <cf-screen>
        {room[UI]}
        {hasProfile ? null : (
          <div
            id="fabrichat-profile-setup"
            style={{ padding: "0 1rem 1rem", maxWidth: "640px" }}
          >
            {profileWish[UI]}
          </div>
        )}
      </cf-screen>
    ),
    messages: messagesCell as PerSpace<MessagesCell>,
    sendMessage: room.sendMessage,
  };
});
