import {
  action,
  assert,
  Default,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findNodeById,
  findNodeByProp,
  hasText,
  propValue,
} from "../test/vnode-helpers.ts";
import {
  createRandomImportedClaimedMessages,
  seededRandom,
  sortDisplayMessages,
} from "./logic.ts";
import {
  type ChatAdminRegistryValue,
  chatAdminRolesValue,
  type EmptyMyProfileValue,
  type MyProfileCellValue,
  type MyProfileValue,
  participantClaimsValue,
  roomsValue,
  type SharedChatMessage,
  type SharedMessagesValue,
  type SharedProfilesValue,
  type SharedRoomsValue,
  TRUSTED_GROUP_CHAT_ADD_ROOM_ACTION,
  TRUSTED_GROUP_CHAT_ADMIN_SURFACE,
  TRUSTED_GROUP_CHAT_PROFILE_SURFACE,
  TRUSTED_GROUP_CHAT_ROOM_SURFACE,
  TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
  TRUSTED_GROUP_CHAT_SEND_ACTION,
  TRUSTED_GROUP_CHAT_SEND_SURFACE,
  TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
} from "./trusted.tsx";
import { GroupChatDemo } from "./main.tsx";

// Renderer-trusted gestures for the protected writes (profile save, message
// send, room add, admin policy). Under CFC enforcement these steps must be
// sent with trusted DOM provenance for the reviewed surface — the headless
// equivalent of clicking the surface's button.
const profileGesture = {
  surface: TRUSTED_GROUP_CHAT_PROFILE_SURFACE,
  action: TRUSTED_GROUP_CHAT_SAVE_PROFILE_ACTION,
};
const sendGesture = {
  surface: TRUSTED_GROUP_CHAT_SEND_SURFACE,
  action: TRUSTED_GROUP_CHAT_SEND_ACTION,
};
const roomGesture = {
  surface: TRUSTED_GROUP_CHAT_ROOM_SURFACE,
  action: TRUSTED_GROUP_CHAT_ADD_ROOM_ACTION,
};
const adminGesture = {
  surface: TRUSTED_GROUP_CHAT_ADMIN_SURFACE,
  action: TRUSTED_GROUP_CHAT_SET_ADMIN_ACTION,
};

type GroupChatDemoInputArg = Parameters<typeof GroupChatDemo>[0];

// A `cf-submit-input` delivers its field's text on the trusted click, from its
// button or from Enter in the field.
const submitted = (text: string) => ({
  type: "click",
  target: { value: text },
});

export default pattern(() => {
  const myProfile = Writable.of<MyProfileCellValue>(
    {} as Default<EmptyMyProfileValue>,
  );
  const messages = Writable.of<SharedMessagesValue>(
    [] as SharedMessagesValue,
  );
  const profiles = Writable.of<SharedProfilesValue>(
    [] as SharedProfilesValue,
  );
  const rooms = Writable.of<SharedRoomsValue>(
    {} as SharedRoomsValue,
  );
  const adminRegistry = Writable.of<ChatAdminRegistryValue>(
    {} as ChatAdminRegistryValue,
  );
  const chat = GroupChatDemo({
    myProfile,
    profiles,
    messages,
    rooms,
    adminRegistry,
  } as GroupChatDemoInputArg);
  const bobProfile = Writable.of<MyProfileCellValue>(
    {} as Default<EmptyMyProfileValue>,
  );
  const bobChat = GroupChatDemo({
    myProfile: bobProfile,
    profiles,
    messages,
    rooms,
    adminRegistry,
  } as GroupChatDemoInputArg);

  // Imported rows are appended via push: rewriting the whole list with
  // `messages.set([...])` re-writes the existing TRUSTED rows, which only the
  // reviewed send binding may author under CFC enforcement.
  const action_add_deterministic_imported = action(() => {
    const random = seededRandom(0xdecafbad);
    const nextMessages = createRandomImportedClaimedMessages(
      sortDisplayMessages(messages.get() as SharedChatMessage[]),
      participantClaimsValue(profiles, myProfile, messages),
      random,
    );
    nextMessages.forEach((message) =>
      messages.push(message as SharedChatMessage)
    );
  });
  const action_add_same_name_unverified_imports = action(() => {
    messages.push({
      origin: "imported",
      authorName: "Sam",
      body: "first Sam",
      timestamp: 10_000,
    });
    messages.push({
      origin: "imported",
      authorName: "Sam",
      body: "second Sam",
      timestamp: 10_001,
    });
  });

  const assert_initially_empty = assert(() =>
    (myProfile.get() as MyProfileValue | undefined)?.profile === undefined &&
    (messages.get()?.length ?? 0) === 0
  );
  const assert_admin_view_waits_for_profile = assert(() => {
    const managerChip = findNodeById(chat[UI], "group-chat-manager-chip");
    const panelStatus = findNodeById(
      chat[UI],
      "trusted-admin-manager-panel-status",
    );
    return propValue(managerChip, "label") === "No profile" &&
      propValue(panelStatus, "label") ===
        "Save a profile to manage admins";
  });
  const assert_profile_created = assert(() =>
    chat.currentProfileName === "Alice"
  );
  const assert_profile_bootstraps_admin = assert(() =>
    chat.currentUserIsAdmin === true &&
    chat.currentUserCanManageAdmins === true &&
    chatAdminRolesValue(adminRegistry).length === 0
  );
  const assert_alice_sees_bob_without_bob_message = assert(() => {
    const participants = participantClaimsValue(profiles, myProfile, messages);
    return participants.some((participant) => participant.name === "Alice") &&
      participants.some((participant) => participant.name === "Bob");
  });
  const assert_admin_view_everyone_enabled = assert(() => {
    const toggleButton = findNodeByProp(
      chat[UI],
      "data-ui-control",
      "admin-user-toggle",
    );
    const everyoneCheckbox = findNodeById(
      chat[UI],
      "trusted-everyone-admin-checkbox",
    );
    const managerChip = findNodeById(chat[UI], "group-chat-manager-chip");
    const panelStatus = findNodeById(
      chat[UI],
      "trusted-admin-manager-panel-status",
    );
    return propValue(managerChip, "label") === "Everyone is admin" &&
      propValue(panelStatus, "label") === "Everyone can add rooms" &&
      propValue(everyoneCheckbox, "checked") === true &&
      propValue(everyoneCheckbox, "disabled") === false &&
      propValue(toggleButton, "disabled") === true &&
      hasText(toggleButton, "Admin via everyone");
  });
  const assert_bootstrap_admin_can_add_room = assert(() => {
    const roomList = roomsValue(rooms);
    return roomList.length === 1 &&
      roomList[0]?.name === "Ops";
  });
  const assert_everyone_disabled_seeds_alice = assert(() =>
    chat.currentUserIsAdmin === true &&
    bobChat.currentUserIsAdmin !== true &&
    chatAdminRolesValue(adminRegistry).length === 1 &&
    (adminRegistry.get() as { everyoneIsAdmin?: boolean }).everyoneIsAdmin ===
      false
  );
  const assert_admin_view_explicit_alice = assert(() => {
    const toggleButton = findNodeByProp(
      chat[UI],
      "data-ui-control",
      "admin-user-toggle",
    );
    const userList = findNodeById(chat[UI], "trusted-admin-user-list");
    return propValue(toggleButton, "disabled") === false &&
      hasText(toggleButton, "Remove admin") &&
      // Alice's role chip carries its text in a `label` prop, so this looks
      // for the prop rather than for rendered text.
      findNodeByProp(userList, "label", "Admin") !== undefined;
  });
  const assert_admin_view_lists_bob_after_lockdown = assert(() => {
    const userList = findNodeById(chat[UI], "trusted-admin-user-list");
    return hasText(userList, "Bob") &&
      hasText(userList, "Make admin");
  });
  const assert_last_admin_removal_blocked = assert(() =>
    chat.currentUserIsAdmin === true &&
    bobChat.currentUserIsAdmin !== true &&
    chatAdminRolesValue(adminRegistry).length === 1 &&
    (adminRegistry.get() as { everyoneIsAdmin?: boolean }).everyoneIsAdmin ===
      false
  );
  const assert_bob_cannot_add_room_after_lockdown = assert(() =>
    roomsValue(rooms).length === 1
  );
  const assert_bob_admin_enabled = assert(() =>
    bobChat.currentUserIsAdmin === true &&
    bobChat.currentUserCanManageAdmins === true &&
    chatAdminRolesValue(adminRegistry).length === 2 &&
    (adminRegistry.get() as { everyoneIsAdmin?: boolean }).everyoneIsAdmin ===
      false
  );
  const assert_bob_can_add_room = assert(() => {
    const roomList = roomsValue(rooms);
    return roomList.length === 2 &&
      roomList[1]?.name === "Bob room";
  });
  const assert_alice_can_still_add_room = assert(() => {
    const roomList = roomsValue(rooms);
    return roomList.length === 3 &&
      roomList[2]?.name === "Ops 2";
  });
  // The second write to the floored `admins` path: the revoke reads back the
  // explicit list the grant wrote and stores a shorter one. A floor over two
  // atoms cannot satisfy that shape, because the read carries one atom and the
  // floor demands the other. The room add below turns a dropped revoke into a
  // failure, since a Bob who is still an admin can still create a room.
  const assert_bob_admin_revoked = assert(() =>
    bobChat.currentUserIsAdmin !== true &&
    chatAdminRolesValue(adminRegistry).length === 1 &&
    // The explicit `admins` list, which is the floored path. The length above
    // reads through `chatAdminRolesValue`, which falls back to the bootstrap
    // role when `admins` is absent, so it alone does not say the list landed.
    (adminRegistry.get() as { admins?: { displayName: string }[] }).admins
        ?.length === 1 &&
    (adminRegistry.get() as { admins?: { displayName: string }[] })
        .admins?.[0]?.displayName === "Alice"
  );
  const assert_bob_cannot_add_room_after_revoke = assert(() =>
    roomsValue(rooms).length === 3 &&
    roomsValue(rooms)[2]?.name === "Ops 2"
  );
  const assert_message_sent = assert(() =>
    messages.get().length === 1 &&
    messages.get()[0]?.origin === "sent" &&
    messages.get()[0]?.authorName === "Alice" &&
    messages.get()[0]?.body === "Hello from Alice"
  );
  const assert_profile_renamed = assert(() =>
    chat.currentProfileName === "Alice Renamed"
  );
  const assert_message_snapshot_stable = assert(() =>
    messages.get().length >= 1 &&
    messages.get()[0]?.authorName === "Alice"
  );
  const assert_second_message_uses_current_name = assert(() =>
    messages.get().length === 2 &&
    messages.get()[1]?.origin === "sent" &&
    messages.get()[1]?.authorName === "Alice Renamed" &&
    messages.get()[1]?.body === "After rename"
  );
  const assert_imported_messages_injected = assert(() => {
    const messageList = Array.from(messages.get() as SharedChatMessage[]);
    const importedMessages = messageList.filter((message) =>
      message.origin === "imported"
    );
    return messageList.length === 4 &&
      importedMessages.length === 2 &&
      importedMessages.every((message) =>
        message.authorName.length > 0 &&
        message.body.length > 0 &&
        message.authorProfile !== undefined
      );
  });
  const assert_thread_order_sortable = assert(() => {
    const ordered = sortDisplayMessages(messages.get() as SharedChatMessage[]);
    return ordered.length === 4 &&
      ordered.every((message, index) =>
        index === 0 || ordered[index - 1]!.timestamp <= message.timestamp
      );
  });
  const assert_verified_imports_do_not_duplicate_participants = assert(() =>
    participantClaimsValue(profiles, myProfile, messages).filter((
      participant,
    ) => participant.name === "Alice Renamed").length === 1
  );
  const assert_same_name_unverified_imports_are_distinct = assert(() => {
    const participants = participantClaimsValue(profiles, myProfile, messages);
    return participants.filter((participant) =>
      participant.name === "Sam" && participant.profile === undefined
    ).length === 2;
  });
  const assert_messages_and_rooms_do_not_store_ids = assert(() =>
    (messages.get() as SharedChatMessage[]).every((message) =>
      !("id" in message)
    ) &&
    roomsValue(rooms).every((room) => !("id" in room))
  );

  return {
    [TESTS]: [
      { assertion: assert_initially_empty },
      { assertion: assert_admin_view_waits_for_profile },
      {
        action: chat.saveProfile,
        event: submitted("Alice"),
        trustedUi: profileGesture,
      },
      { assertion: assert_profile_created },
      { assertion: assert_profile_bootstraps_admin },
      {
        action: bobChat.saveProfile,
        event: submitted("Bob"),
        trustedUi: profileGesture,
      },
      { assertion: assert_alice_sees_bob_without_bob_message },
      { assertion: assert_admin_view_everyone_enabled },
      {
        action: chat.addTrustedRoom,
        event: submitted("Ops"),
        trustedUi: roomGesture,
      },
      { assertion: assert_bootstrap_admin_can_add_room },
      {
        action: chat.toggleEveryoneAdmin,
        event: { type: "click", target: { name: "", value: "on" } },
        trustedUi: adminGesture,
      },
      { assertion: assert_everyone_disabled_seeds_alice },
      { assertion: assert_admin_view_explicit_alice },
      { assertion: assert_admin_view_lists_bob_after_lockdown },
      // Removing the last admin is refused by the handler, so the roster keeps
      // Alice.
      {
        action: chat.toggleParticipantAdmin,
        event: { name: "Alice" },
        trustedUi: adminGesture,
      },
      { assertion: assert_last_admin_removal_blocked },
      {
        action: bobChat.addTrustedRoom,
        event: submitted("Bob room"),
        trustedUi: roomGesture,
      },
      { assertion: assert_bob_cannot_add_room_after_lockdown },
      // The roster and the room list are both floored on `group-chat-admin`,
      // and both mint it at the path their floor sits on. The steps from here
      // change each of them more than once, which is what tells that shape
      // apart from a floor naming an atom the path's own reads do not carry.
      // Such a floor admits the first change to an empty path and silently
      // drops every one after it, so a single change proves nothing.
      {
        action: chat.toggleParticipantAdmin,
        event: { name: "Bob" },
        trustedUi: adminGesture,
      },
      { assertion: assert_bob_admin_enabled },
      {
        action: bobChat.addTrustedRoom,
        event: submitted("Bob room"),
        trustedUi: roomGesture,
      },
      { assertion: assert_bob_can_add_room },
      {
        action: chat.addTrustedRoom,
        event: submitted("Ops 2"),
        trustedUi: roomGesture,
      },
      { assertion: assert_alice_can_still_add_room },
      {
        action: chat.toggleParticipantAdmin,
        event: { name: "Bob" },
        trustedUi: adminGesture,
      },
      { assertion: assert_bob_admin_revoked },
      {
        action: bobChat.addTrustedRoom,
        event: submitted("Bob room 2"),
        trustedUi: roomGesture,
      },
      { assertion: assert_bob_cannot_add_room_after_revoke },
      {
        action: chat.sendTrustedMessage,
        event: submitted("Hello from Alice"),
        trustedUi: sendGesture,
      },
      { assertion: assert_message_sent },
      {
        action: chat.saveProfile,
        event: submitted("Alice Renamed"),
        trustedUi: profileGesture,
      },
      { assertion: assert_profile_renamed },
      { assertion: assert_message_snapshot_stable },
      {
        action: chat.sendTrustedMessage,
        event: submitted("After rename"),
        trustedUi: sendGesture,
      },
      { assertion: assert_second_message_uses_current_name },
      { action: action_add_deterministic_imported },
      { assertion: assert_imported_messages_injected },
      { assertion: assert_thread_order_sortable },
      { assertion: assert_verified_imports_do_not_duplicate_participants },
      { action: action_add_same_name_unverified_imports },
      { assertion: assert_same_name_unverified_imports_are_distinct },
      { assertion: assert_messages_and_rooms_do_not_store_ids },
    ],
    // TODO(cfc-schema-ref): the CFC schema-ref resolver warns about
    // unsupported/unresolved $ref(s) in this pattern's schemas (logger "cfc",
    // fail-closed). Fix the schema(s), then drop this opt-out.
    allowConsoleWarnings: true,
  };
});
