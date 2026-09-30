/**
 * The FabriChat room, as several viewers sharing one conversation: what a send
 * stores, which sends and composers are refused, and who the participant strip
 * lists.
 */
import {
  action,
  type AddIntegrity,
  assert,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { findNodeByProp, propValue } from "../test/vnode-helpers.ts";
import {
  FABRICHAT_SEND_ACTION,
  FABRICHAT_SEND_SURFACE,
  type FabriChatMessage,
  type FabriChatProfile,
  FabriChatRoom,
  type MessagesValue,
  type ReactionsValue,
} from "./chat.tsx";

type FabriChatRoomInputArg = Parameters<typeof FabriChatRoom>[0];

// A stand-in for a viewer's `#profile`, which a pattern test cannot resolve.
// It is labeled, as a Fabric profile is, because a message may link only a
// document that carries a label.
type TestProfile = AddIntegrity<
  FabriChatProfile,
  readonly ["fabrichat-test-profile"]
>;

// A document linking a profile, labeled for the same reason.
type TestProfileHolder = AddIntegrity<
  { profile?: Writable<TestProfile> },
  readonly ["fabrichat-test-profile"]
>;

// A send is a protected write, so each send step carries the trusted gesture
// of the composer's reviewed surface: the headless equivalent of clicking its
// button.
const sendGesture = {
  surface: FABRICHAT_SEND_SURFACE,
  action: FABRICHAT_SEND_ACTION,
};

// A `cf-submit-input` delivers its field's text on the trusted click, from its
// button or from Enter in the field.
const submitted = (text: string) => ({
  type: "click",
  target: { value: text },
});

const sentIn = (messages: Writable<MessagesValue>): FabriChatMessage[] =>
  messages.get() as FabriChatMessage[];

const composerDisabled = (root: unknown): unknown =>
  propValue(findNodeByProp(root, "inputId", "fabrichat-message"), "disabled");

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const reactions = Writable.of<ReactionsValue>([] as ReactionsValue);

  // The two Sams are different people who share a name.
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const samOneProfile = Writable.of<TestProfile>({ name: "Sam" });
  const samTwoProfile = Writable.of<TestProfile>({ name: "Sam" });
  const namelessProfile = Writable.of<TestProfile>({});
  const aliceOtherProfile = Writable.of<TestProfile>({ name: "Alice" });

  // Alice's room reaches her profile through a link, as a viewer's room reaches
  // theirs through the `#profile` wish.
  const aliceProfileHolder = Writable.of<TestProfileHolder>(
    {} as TestProfileHolder,
  );
  const action_link_alice_profile = action(() =>
    aliceProfileHolder.key("profile").set(aliceProfile)
  );
  const action_switch_alice_profile = action(() =>
    aliceProfileHolder.key("profile").set(aliceOtherProfile)
  );

  const alice = FabriChatRoom({
    myProfile: aliceProfileHolder.key("profile"),
    myName: "Alice",
    myAvatar: "",
    messages,
    reactions,
  } as FabriChatRoomInputArg);
  const bob = FabriChatRoom({
    myProfile: bobProfile,
    myName: "Bob",
    myAvatar: "",
    messages,
    reactions,
  } as FabriChatRoomInputArg);
  const samOne = FabriChatRoom({
    myProfile: samOneProfile,
    myName: "Sam",
    myAvatar: "",
    messages,
    reactions,
  } as FabriChatRoomInputArg);
  const samTwo = FabriChatRoom({
    myProfile: samTwoProfile,
    myName: "Sam",
    myAvatar: "",
    messages,
    reactions,
  } as FabriChatRoomInputArg);
  // One viewer whose name is known before their profile, and one whose
  // profile is known before their name.
  const noProfile = FabriChatRoom({
    myProfile: undefined,
    myName: "Pending",
    myAvatar: "",
    messages,
    reactions,
  } as FabriChatRoomInputArg);
  const noName = FabriChatRoom({
    myProfile: namelessProfile,
    myName: "",
    myAvatar: "",
    messages,
    reactions,
  } as FabriChatRoomInputArg);

  const assert_starts_empty = assert(() =>
    sentIn(messages).length === 0 && alice.participants.length === 0
  );
  const assert_composer_disabled_before_profile_resolves = assert(() =>
    composerDisabled(alice[UI]) === true
  );
  const assert_composer_enabled_with_profile = assert(() =>
    composerDisabled(alice[UI]) === false
  );
  const assert_composer_disabled_without_profile = assert(() =>
    composerDisabled(noProfile[UI]) === true
  );
  const assert_composer_enabled_without_name = assert(() =>
    composerDisabled(noName[UI]) === false
  );
  const assert_alice_message_sent = assert(() => {
    const [message] = sentIn(messages);
    return sentIn(messages).length === 1 &&
      equals(message.authorProfile, aliceProfile) &&
      message.authorName === "Alice" &&
      message.body === "Hello, everyone";
  });
  const assert_blank_message_refused = assert(() =>
    sentIn(messages).length === 1
  );
  const assert_bob_message_sent = assert(() => {
    const message = sentIn(messages)[1];
    return sentIn(messages).length === 2 &&
      equals(message.authorProfile, bobProfile) &&
      message.body === "Hi, Alice";
  });
  const assert_repeat_sender_listed_once = assert(() => {
    const participants = bob.participants;
    return sentIn(messages).length === 3 &&
      participants.length === 2 &&
      equals(participants[0].profile, aliceProfile) &&
      equals(participants[1].profile, bobProfile);
  });
  const assert_same_name_senders_listed_apart = assert(() => {
    const sams = alice.participants.filter((participant) =>
      participant.name === "Sam"
    );
    return sams.length === 2 &&
      equals(sams[0].profile, samOneProfile) &&
      equals(sams[1].profile, samTwoProfile);
  });
  const assert_send_without_profile_refused = assert(() =>
    sentIn(messages).length === 5
  );
  const assert_send_without_name_stored = assert(() => {
    const message = sentIn(messages)[5];
    return sentIn(messages).length === 6 &&
      equals(message.authorProfile, namelessProfile) &&
      message.authorName === "" &&
      message.body === "From someone unnamed";
  });
  const assert_sent_message_keeps_its_profile = assert(() => {
    const [message] = sentIn(messages);
    return message !== undefined &&
      equals(message.authorProfile, aliceProfile) &&
      !equals(message.authorProfile, aliceOtherProfile);
  });

  return {
    [TESTS]: [
      // Alice's profile link holds nothing yet, as a `#profile` wish does before
      // it resolves.
      { assertion: assert_composer_disabled_before_profile_resolves },
      { action: action_link_alice_profile },
      { assertion: assert_starts_empty },
      { assertion: assert_composer_enabled_with_profile },
      { assertion: assert_composer_disabled_without_profile },
      { assertion: assert_composer_enabled_without_name },
      {
        action: alice.sendMessage,
        event: submitted("  Hello, everyone  "),
        trustedUi: sendGesture,
      },
      { assertion: assert_alice_message_sent },
      {
        action: alice.sendMessage,
        event: submitted("   "),
        trustedUi: sendGesture,
      },
      { assertion: assert_blank_message_refused },
      {
        action: bob.sendMessage,
        event: submitted("Hi, Alice"),
        trustedUi: sendGesture,
      },
      { assertion: assert_bob_message_sent },
      {
        action: alice.sendMessage,
        event: submitted("How are you?"),
        trustedUi: sendGesture,
      },
      { assertion: assert_repeat_sender_listed_once },
      {
        action: samOne.sendMessage,
        event: submitted("Sam here"),
        trustedUi: sendGesture,
      },
      {
        action: samTwo.sendMessage,
        event: submitted("Also Sam here"),
        trustedUi: sendGesture,
      },
      { assertion: assert_same_name_senders_listed_apart },
      {
        action: noProfile.sendMessage,
        event: submitted("From nobody"),
        trustedUi: sendGesture,
      },
      { assertion: assert_send_without_profile_refused },
      {
        action: noName.sendMessage,
        event: submitted("From someone unnamed"),
        trustedUi: sendGesture,
      },
      { assertion: assert_send_without_name_stored },
      { action: action_switch_alice_profile },
      { assertion: assert_sent_message_keeps_its_profile },
    ],
  };
});
