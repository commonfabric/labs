/**
 * Test Pattern: Group Chat Lobby
 *
 * The lobby and the exported `joinChat` handler share one message list,
 * roster and session, so what joining writes shows up in the lobby's view and
 * its Reset button clears it again.
 *
 * - Without a resolved profile the lobby asks for one, and its Join button
 *   adds nobody.
 * - The first person to join starts the session; each new person is added
 *   to the roster and announced in the chat.
 * - Identity is the profile cell, not the name: the same profile rejoining
 *   under a new name keeps the name it first claimed, and a different
 *   profile with a name already taken gets a numbered one.
 * - Reset empties the roster and the chat and starts a new session.
 *
 * The viewer's `#profile` does not resolve in a pattern test, so joining is
 * driven through the handler with profile cells the test owns. Joining also
 * navigates to the room, which the runner records but a test cannot read.
 *
 * Run: deno task cf test patterns/examples/group-chat-lobby/group-chat-lobby.test.tsx
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import type { ProfileFaceFields } from "../../system/profile-face/profile-face.ts";
import {
  clickButton,
  findElement,
  findElementByExactText,
  findNodeByProp,
  fireClick,
  hasText,
  propValue,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import type { Message, User } from "../group-chat-room/group-chat-room.tsx";
import GroupChatLobby, { joinChat } from "./group-chat-lobby.tsx";

type TestProfile = { name?: string } & ProfileFaceFields;

/** The Join button, which names what joining will do. */
const joinButton = (ui: unknown) =>
  findElementByExactText(ui, "button", "Create a profile to join");

export default pattern(() => {
  const messages = Writable.of<Message[]>([]);
  const users = Writable.of<User[]>([]);
  const sessionId = Writable.of("");
  const firstSession = Writable.of("");

  const annProfile = Writable.of<TestProfile>({ name: "Ann" });
  const otherAnnProfile = Writable.of<TestProfile>({ name: "Ann" });
  const thirdAnnProfile = Writable.of<TestProfile>({ name: "Ann" });

  const lobby = GroupChatLobby({
    chatName: "Book Club",
    messages,
    users,
    sessionId,
  });

  const action_join_without_profile = joinChat({
    messages,
    users,
    sessionId,
    profile: undefined,
    name: "Ann",
  });
  const action_join_without_name = joinChat({
    messages,
    users,
    sessionId,
    profile: annProfile,
    name: "   ",
  });
  const action_ann_joins = joinChat({
    messages,
    users,
    sessionId,
    profile: annProfile,
    name: " Ann ",
  });
  const action_ann_rejoins_renamed = joinChat({
    messages,
    users,
    sessionId,
    profile: annProfile,
    name: "Annie",
  });
  const action_other_ann_joins = joinChat({
    messages,
    users,
    sessionId,
    profile: otherAnnProfile,
    name: "Ann",
  });
  const action_third_ann_joins = joinChat({
    messages,
    users,
    sessionId,
    profile: thirdAnnProfile,
    name: "Ann",
  });
  const action_press_join = action(() =>
    fireClick(joinButton(lobby[UI]), "the Join button")
  );
  const action_note_session = action(() => firstSession.set(sessionId.get()));
  const action_press_reset = action(() => clickButton(lobby[UI], "Reset"));

  const assert_lobby_asks_for_profile = assert(() =>
    lobby[NAME] === "Book Club - Lobby" &&
    hasText(findElement(lobby[UI], "h1"), "Book Club") &&
    propValue(joinButton(lobby[UI]), "disabled") === true &&
    styleOf(joinButton(lobby[UI]), "backgroundColor") === "#b9b9c0" &&
    styleOf(joinButton(lobby[UI]), "cursor") === "default" &&
    !hasText(lobby[UI], "Now chatting")
  );
  const assert_nobody_joined = assert(() =>
    users.get().length === 0 && messages.get().length === 0 &&
    sessionId.get() === ""
  );
  const assert_ann_joined = assert(() =>
    users.get().map((u) => u.name).join() === "Ann" &&
    messages.get().map((m) => `${m.author}:${m.type}:${m.content}`).join() ===
      "System:system:Ann joined the chat" &&
    sessionId.get().startsWith("session-")
  );
  const assert_lobby_shows_ann = assert(() =>
    lobby.users.get().length === 1 &&
    hasText(lobby[UI], "Now chatting") &&
    findNodeByProp(lobby[UI], "name", "Ann") !== undefined
  );
  // Rejoining neither adds Ann again, announces her again, nor starts a new
  // session.
  const assert_ann_not_duplicated = assert(() =>
    users.get().map((u) => u.name).join() === "Ann" &&
    messages.get().length === 1 &&
    sessionId.get() === firstSession.get()
  );
  const assert_names_disambiguated = assert(() =>
    users.get().map((u) => u.name).join() === "Ann,Ann 2,Ann 3" &&
    messages.get().map((m) => m.content).join() ===
      "Ann joined the chat,Ann 2 joined the chat,Ann 3 joined the chat" &&
    sessionId.get() === firstSession.get() &&
    findNodeByProp(lobby[UI], "name", "Ann 3") !== undefined
  );
  const assert_reset = assert(() =>
    users.get().length === 0 && messages.get().length === 0 &&
    sessionId.get().startsWith("session-") &&
    sessionId.get() !== firstSession.get() &&
    !hasText(lobby[UI], "Now chatting")
  );

  return {
    [TESTS]: [
      { assertion: assert_lobby_asks_for_profile },
      { action: action_press_join },
      { action: action_join_without_profile },
      { action: action_join_without_name },
      { assertion: assert_nobody_joined },

      { action: action_ann_joins },
      { assertion: assert_ann_joined },
      { assertion: assert_lobby_shows_ann },
      { action: action_note_session },
      { action: action_ann_rejoins_renamed },
      { assertion: assert_ann_not_duplicated },

      { action: action_other_ann_joins },
      { action: action_third_ann_joins },
      { assertion: assert_names_disambiguated },

      { action: action_press_reset },
      { assertion: assert_reset },
    ],
    lobby,
  };
});
