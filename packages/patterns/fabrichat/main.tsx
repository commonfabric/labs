/**
 * FabriChat: a group chat among the people in a space, each identified by
 * their own profile, with every message attested as written by its sender.
 *
 * This is the room from `chat.tsx`, given the viewer's real profile. The
 * messages are shared by everyone in the space.
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

  return {
    [NAME]: "FabriChat",
    [UI]: room[UI],
    messages: messagesCell as PerSpace<MessagesCell>,
    sendMessage: room.sendMessage,
  };
});
