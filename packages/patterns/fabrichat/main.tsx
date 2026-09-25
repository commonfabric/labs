/**
 * FabriChat: a group chat among the people in a space, each identified by
 * their own profile, with every message labeled with the principal who sent
 * it.
 *
 * This is the room from `chat.tsx`, given the viewer's real profile. The
 * messages and their reactions are shared by everyone in the space. A viewer
 * with no profile can read the conversation, and is offered the form that
 * creates one.
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
  type ReactionsCell,
  type SubmittedTextEvent,
} from "./chat.tsx";

type FabriChatRoomInputArg = Parameters<typeof FabriChatRoom>[0];

/** What FabriChat stores: the conversation, shared by the space. */
export interface FabriChatInput {
  messages?: PerSpace<MessagesCell>;
  reactions?: PerSpace<ReactionsCell>;
}

/** What FabriChat provides. */
export interface FabriChatOutput {
  [NAME]: string;
  [UI]: VNode;
  messages: PerSpace<MessagesCell>;
  reactions: PerSpace<ReactionsCell>;
  sendMessage: Stream<SubmittedTextEvent>;
}

/** A FabriChat room whose viewer is the person looking at it. */
export default pattern<FabriChatInput, FabriChatOutput>(
  ({ messages, reactions }) => {
    const messagesCell: MessagesCell = messages!;
    const reactionsCell: ReactionsCell = reactions!;
    const profileWish = wish<FabriChatProfile>({ query: "#profile" });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });

    const room = FabriChatRoom({
      myProfile: profileWish.result,
      myName: computed(() => profileNameWish.result ?? ""),
      myAvatar: computed(() => profileAvatarWish.result ?? ""),
      messages: messagesCell,
      reactions: reactionsCell,
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
      reactions: reactionsCell as PerSpace<ReactionsCell>,
      sendMessage: room.sendMessage,
    };
  },
);
