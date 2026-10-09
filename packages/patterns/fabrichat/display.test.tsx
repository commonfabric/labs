/** Room controls appear when their edit or reply session state calls for them. */
import {
  action,
  assert,
  FabricEpochNsec,
  handler,
  pattern,
  type RepresentsCurrentUser,
  TESTS,
  type TrustedActionWrite,
  UI,
  Writable,
} from "commonfabric";
import { clickButton, findNodeByProp, hasText } from "../test/vnode-helpers.ts";
import { testRoomAbout, testRoomStorage } from "./room-test-fixture.ts";
import { FabriChatRoom } from "./room.tsx";
import type { ChatProfile } from "./schemas.tsx";

/** Whether an edit form is present in the rendered room. */
const hasEditForm = (root: unknown): boolean =>
  findNodeByProp(root, "data-ui-pattern", "ChatEditSurface") !== undefined;

/** A profile whose label identifies the person operating the room controls. */
type OwnProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatProfile,
    typeof writeProfile,
    "FabriChatTestWriteProfile",
    "FabriChatTestProfileSurface"
  >
>;

/** The profile initialized by its owner's gesture. */
interface ProfileState {
  profile: Writable<OwnProfile>;
}

/** Attests the profile used to select the sender's edit controls. */
const writeProfile = handler<void, ProfileState>((_, { profile }) => {
  profile.set({ name: "Alice" } as OwnProfile);
});

export default pattern(() => {
  const profile = new Writable<OwnProfile>();
  const version = new Writable({
    body: "Hello",
    sentAt: new FabricEpochNsec(0n),
  });
  const initializeVersion = action(() =>
    version.key("sentAt").set(
      new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    )
  );
  const description = testRoomAbout({ kind: "group", standalone: false });
  const room = FabriChatRoom({
    myProfile: profile,
    about: description.about,
    ...testRoomStorage({}),
  });
  return {
    [TESTS]: [
      {
        action: writeProfile({ profile }),
        trustedUi: {
          surface: "FabriChatTestProfileSurface",
          action: "FabriChatTestWriteProfile",
        },
      },
      { action: description.initialize },
      { action: initializeVersion },
      { render: room[UI] },
      {
        assertion: assert(() =>
          !hasEditForm(room[UI]) && !hasText(room[UI], "Replying to a message")
        ),
      },
      {
        action: room.sendMessage,
        event: { requestId: "first", version },
        trustedUi: { surface: "ChatSendSurface", action: "ChatSend" },
      },
      { render: room[UI] },
      {
        assertion: assert(() =>
          hasText(room[UI], "Hello") && hasText(room[UI], "Edit") &&
          !hasEditForm(room[UI])
        ),
      },
      { action: action(() => clickButton(room[UI], "Edit")) },
      { render: room[UI] },
      { assertion: assert(() => hasEditForm(room[UI])) },
      { action: action(() => clickButton(room[UI], "Edit")) },
      { render: room[UI] },
      { assertion: assert(() => !hasEditForm(room[UI])) },
      { action: action(() => clickButton(room[UI], "Reply")) },
      { render: room[UI] },
      {
        assertion: assert(() =>
          hasText(room[UI], "Replying to a message") &&
          hasText(room[UI], "Placement: thread")
        ),
      },
      { action: action(() => clickButton(room[UI], "Conversation only")) },
      { render: room[UI] },
      { assertion: assert(() => hasText(room[UI], "Placement: main")) },
      { action: action(() => clickButton(room[UI], "Cancel reply")) },
      { render: room[UI] },
      { assertion: assert(() => !hasText(room[UI], "Replying to a message")) },
    ],
  };
});
