/** A standalone group's owner may add members; direct and social chats refuse. */
import {
  type AddIntegrity,
  assert,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findNodeById,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
import { testRoomAbout, testRoomStorage } from "./room-test-fixture.ts";
import { FabriChatRoom } from "./room.tsx";
import type { ChatProfile } from "./schemas.tsx";

/** The display state of a room's add control. */
const displayOf = (root: unknown): unknown =>
  readValue(
    (propValue(findNodeById(root, "fabrichat-add-member"), "style") as {
      display?: unknown;
    })?.display,
  );

/** The refusal or result of the room's latest add gesture. */
const outcomeOf = (root: unknown): string =>
  textContent(findNodeById(root, "fabrichat-add-member-outcome"));

const addGesture = { surface: "ChatAddMemberSurface", action: "ChatAddMember" };
const BOB = "did:key:z6MkBob";

export default pattern(() => {
  const profile = new Writable<AddIntegrity<ChatProfile, ["chat-test"]>>({
    name: "Alice",
  });
  const groupDescription = testRoomAbout({ kind: "group", standalone: true });
  const directDescription = testRoomAbout({ kind: "direct", standalone: true });
  const socialDescription = testRoomAbout({ kind: "group", standalone: false });
  const ownRoom = FabriChatRoom({
    myProfile: profile,
    about: groupDescription.about,
    ...testRoomStorage({}),
  });
  const directRoom = FabriChatRoom({
    myProfile: profile,
    about: directDescription.about,
    ...testRoomStorage({}),
  });
  const sharedRoom = FabriChatRoom({
    myProfile: profile,
    about: socialDescription.about,
    ...testRoomStorage({}),
  });
  return {
    [TESTS]: [
      { action: groupDescription.initialize },
      { action: directDescription.initialize },
      { action: socialDescription.initialize },
      { render: ownRoom[UI] },
      { render: directRoom[UI] },
      { render: sharedRoom[UI] },
      {
        assertion: assert(() =>
          displayOf(ownRoom[UI]) === "flex" &&
          displayOf(directRoom[UI]) === "none" &&
          displayOf(sharedRoom[UI]) === "none"
        ),
      },
      { assertion: assert(() => outcomeOf(ownRoom[UI]) === "") },
      {
        action: ownRoom.addMember,
        event: { target: { value: `${BOB}/of:fid1:profile` } },
        trustedUi: addGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(ownRoom[UI]) === "That isn't a chat address."
        ),
      },
      {
        action: ownRoom.addMember,
        event: { target: { value: `${BOB}.` } },
        trustedUi: addGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(ownRoom[UI]) === "That isn't a chat address."
        ),
      },
      {
        action: sharedRoom.addMember,
        event: { target: { value: BOB } },
        trustedUi: addGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(sharedRoom[UI]) ===
            "Members of this chat are managed by its space."
        ),
      },
      {
        action: directRoom.addMember,
        event: { target: { value: BOB } },
        trustedUi: addGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(directRoom[UI]) ===
            "Members of this chat are managed by its space."
        ),
      },
    ],
  };
});
