/**
 * A room shows who is present in the Loom it is in: it binds the Loom's
 * presence element to its own result cell, whose space is the Loom's, and
 * publishes the viewer's name through it, which follows the viewer's profile
 * and is empty while the viewer has none.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  equals,
  pattern,
  SELF,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findElement, propsOf, propValue } from "../test/vnode-helpers.ts";
import { type MessagesValue } from "./room-records.tsx";
import { type ChatRoomOutput, FabriChatRoomCore } from "./room.tsx";
import { type ChatProfile, type ChatRoomLink } from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

interface SelfNamingRoomInput {
  myProfile?: Cell<TestProfile>;
  messages: Writable<MessagesValue>;
}

interface SelfNamingRoomOutput {
  [UI]: ChatRoomOutput[typeof UI];
  self: Cell<ChatRoomLink>;
}

/** A group room that hands the core its own result cell, as `FabriChatRoom` does. */
const SelfNamingRoom = pattern<SelfNamingRoomInput, SelfNamingRoomOutput>(
  (input) => {
    const room = FabriChatRoomCore({
      myProfile: input.myProfile,
      about: { kind: "group" as const },
      messages: input.messages,
      self: input[SELF],
    } as RoomArg);
    return { [UI]: room[UI], self: input[SELF] };
  },
);

/** The presence element under `root`. */
const presenceOf = (root: unknown) => findElement(root, "cf-loom-presence");

/** The cell the presence element under `root` is bound to. */
const boundCellOf = (root: unknown) =>
  propsOf(presenceOf(root))?.["$cell"] as object | undefined;

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const alice = SelfNamingRoom({ myProfile: aliceProfile, messages });
  const nobody = SelfNamingRoom({ messages });

  return {
    [TESTS]: [
      // The element is bound to the room itself, whose space is the Loom's.
      {
        assertion: assert(() => equals(boundCellOf(alice[UI]), alice.self)),
      },
      {
        assertion: assert(() =>
          propValue(presenceOf(alice[UI]), "name") === "Alice"
        ),
      },
      // A viewer with no profile publishes no name.
      {
        assertion: assert(() =>
          propValue(presenceOf(nobody[UI]), "name") === ""
        ),
      },
      // The name follows the profile.
      { action: action(() => aliceProfile.key("name").set("Alicia")) },
      {
        assertion: assert(() =>
          propValue(presenceOf(alice[UI]), "name") === "Alicia"
        ),
      },
    ],
  };
});
