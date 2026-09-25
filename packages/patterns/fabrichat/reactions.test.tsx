/**
 * Reactions in a FabriChat room: what a reaction stores, how a second use of
 * the same emoji takes it back, which reactions are refused, and how each
 * message tallies its own.
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
import {
  findNode,
  findNodeByProp,
  fireClick,
  isButton,
} from "../test/vnode-helpers.ts";
import {
  commitReact,
  FABRICHAT_REACJI,
  FABRICHAT_REACT_ACTION,
  FABRICHAT_REACT_SURFACE,
  FABRICHAT_SEND_ACTION,
  FABRICHAT_SEND_SURFACE,
  FabriChatMessageRow,
  type FabriChatProfile,
  type FabriChatReaction,
  FabriChatRoom,
  type MessagesValue,
  type ReactionsValue,
  type ReactionTally,
} from "./chat.tsx";

type FabriChatRoomInputArg = Parameters<typeof FabriChatRoom>[0];
type FabriChatMessageRowInputArg = Parameters<typeof FabriChatMessageRow>[0];
type CommitReactInput = Parameters<typeof commitReact>[0];

// A stand-in for a viewer's `#profile`, labeled as a Fabric profile is, because
// a message or a reaction may link only a document that carries a label.
type TestProfile = AddIntegrity<
  FabriChatProfile,
  readonly ["fabrichat-test-profile"]
>;

// A document linking a profile, labeled for the same reason.
type TestProfileHolder = AddIntegrity<
  { profile?: Writable<TestProfile> },
  readonly ["fabrichat-test-profile"]
>;

// Each send and each reaction is a protected write, so its step carries the
// trusted gesture of the reviewed surface it is made from.
const sendGesture = {
  surface: FABRICHAT_SEND_SURFACE,
  action: FABRICHAT_SEND_ACTION,
};
const reactGesture = {
  surface: FABRICHAT_REACT_SURFACE,
  action: FABRICHAT_REACT_ACTION,
};

const submitted = (text: string) => ({
  type: "click",
  target: { value: text },
});

const storedIn = (
  reactions: Writable<ReactionsValue>,
): FabriChatReaction[] => reactions.get() as FabriChatReaction[];

// A row's tallies, as `emoji count` with a `*` on the viewer's own, so that an
// assertion's failure shows the whole row.
const talliesText = (tallies: readonly ReactionTally[]): string =>
  tallies.map((tally) =>
    `${tally.emoji} ${tally.count}${tally.mine ? "*" : ""}`
  ).join(", ");

// The picker's buttons, each labeled with its emoji alone; a tally's button
// carries its count as well.
const pickerButtonCount = (root: unknown): number =>
  FABRICHAT_REACJI.filter((emoji) =>
    findNode(root, isButton(emoji)) !== undefined
  ).length;

const addReactionButton = (root: unknown): unknown =>
  findNodeByProp(root, "aria-label", "Add reaction");

export default pattern(() => {
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const reactions = Writable.of<ReactionsValue>([] as ReactionsValue);
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  // A profile that holds nothing yet, as a `#profile` wish does before it
  // resolves.
  const pendingProfile = Writable.of<TestProfile | undefined>(undefined);

  const alice = FabriChatRoom({
    myProfile: aliceProfile,
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

  // Each message as Alice sees it, and the first as Bob sees it.
  const aliceSeesFirst = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: aliceProfile,
    reactions,
  } as FabriChatMessageRowInputArg);
  const aliceSeesSecond = FabriChatMessageRow({
    message: messages.key(1),
    myProfile: aliceProfile,
    reactions,
  } as FabriChatMessageRowInputArg);
  // The first message as Alice sees it through a link to her profile, as a
  // viewer's room reaches their profile through the `#profile` wish.
  const aliceProfileHolder = Writable.of<TestProfileHolder>(
    {} as TestProfileHolder,
  );
  const action_link_alice_profile = action(() =>
    aliceProfileHolder.key("profile").set(aliceProfile)
  );
  const aliceSeesFirstThroughLink = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: aliceProfileHolder.key("profile"),
    reactions,
  } as FabriChatMessageRowInputArg);
  const bobSeesFirst = FabriChatMessageRow({
    message: messages.key(0),
    myProfile: bobProfile,
    reactions,
  } as FabriChatMessageRowInputArg);

  // Reactions, as a viewer's click on one emoji of one message delivers them.
  const aliceCatsFirst = commitReact({
    emoji: "😺",
    message: messages.key(0),
    myProfile: aliceProfile,
    reactions,
  } as CommitReactInput);
  const aliceCriesFirst = commitReact({
    emoji: "😿",
    message: messages.key(0),
    myProfile: aliceProfile,
    reactions,
  } as CommitReactInput);
  const bobCatsFirst = commitReact({
    emoji: "😺",
    message: messages.key(0),
    myProfile: bobProfile,
    reactions,
  } as CommitReactInput);
  const aliceCatsSecond = commitReact({
    emoji: "😺",
    message: messages.key(1),
    myProfile: aliceProfile,
    reactions,
  } as CommitReactInput);
  const aliceOffersADog = commitReact({
    emoji: "🐶",
    message: messages.key(0),
    myProfile: aliceProfile,
    reactions,
  } as CommitReactInput);
  // The same reactions, chosen from a picker that is open.
  const openPicker = Writable.of(true);
  const pendingCatsFirstFromPicker = commitReact({
    emoji: "😺",
    message: messages.key(0),
    myProfile: pendingProfile,
    reactions,
    pickerOpen: openPicker,
  } as CommitReactInput);
  const aliceCriesSecondFromPicker = commitReact({
    emoji: "😿",
    message: messages.key(1),
    myProfile: aliceProfile,
    reactions,
    pickerOpen: openPicker,
  } as CommitReactInput);
  const pendingCatsFirst = commitReact({
    emoji: "😺",
    message: messages.key(0),
    myProfile: pendingProfile,
    reactions,
  } as CommitReactInput);

  const action_toggle_picker = action(() =>
    fireClick(addReactionButton(aliceSeesFirst[UI]), "the add-reaction button")
  );

  const assert_starts_without_reactions = assert(() =>
    storedIn(reactions).length === 0 &&
    aliceSeesFirst.tallies.length === 0
  );
  const assert_reaction_stored = assert(() => {
    const [reaction] = storedIn(reactions);
    return storedIn(reactions).length === 1 &&
      reaction.emoji === "😿" &&
      equals(reaction.reactorProfile, aliceProfile) &&
      equals(reaction.message, messages.key(0));
  });
  const assert_tallies_in_offered_order = assert(() =>
    talliesText(aliceSeesFirst.tallies) === "😺 2*, 😿 1*"
  );
  const assert_tallies_mark_only_viewers_own = assert(() =>
    talliesText(bobSeesFirst.tallies) === "😺 2*, 😿 1"
  );
  const assert_linked_viewer_sees_own_marked = assert(() =>
    talliesText(aliceSeesFirstThroughLink.tallies) === "😺 2*, 😿 1*"
  );
  const assert_second_use_takes_reaction_back = assert(() =>
    storedIn(reactions).length === 2 &&
    talliesText(aliceSeesFirst.tallies) === "😺 1, 😿 1*" &&
    talliesText(bobSeesFirst.tallies) === "😺 1*, 😿 1"
  );
  const assert_taken_back_reaction_can_return = assert(() =>
    storedIn(reactions).length === 3 &&
    talliesText(aliceSeesFirst.tallies) === "😺 2*, 😿 1*"
  );
  const assert_each_message_tallies_its_own = assert(() =>
    storedIn(reactions).length === 4 &&
    talliesText(aliceSeesSecond.tallies) === "😺 1*" &&
    talliesText(aliceSeesFirst.tallies) === "😺 2*, 😿 1*"
  );
  const assert_unoffered_emoji_refused = assert(() =>
    storedIn(reactions).length === 4
  );
  const assert_reaction_without_profile_refused = assert(() =>
    storedIn(reactions).length === 4
  );
  const assert_refusal_leaves_picker_open = assert(() =>
    storedIn(reactions).length === 4 && openPicker.get() === true
  );
  const assert_reaction_closes_picker = assert(() =>
    storedIn(reactions).length === 5 && openPicker.get() === false
  );
  const assert_picker_starts_closed = assert(() =>
    pickerButtonCount(aliceSeesFirst[UI]) === 0
  );
  const assert_picker_offers_every_cat = assert(() =>
    pickerButtonCount(aliceSeesFirst[UI]) === FABRICHAT_REACJI.length
  );
  const assert_picker_closes_again = assert(() =>
    pickerButtonCount(aliceSeesFirst[UI]) === 0
  );

  return {
    [TESTS]: [
      {
        action: alice.sendMessage,
        event: submitted("Lunch?"),
        trustedUi: sendGesture,
      },
      {
        action: bob.sendMessage,
        event: submitted("Tacos"),
        trustedUi: sendGesture,
      },
      { assertion: assert_starts_without_reactions },
      { action: action_link_alice_profile },
      { action: aliceCriesFirst, trustedUi: reactGesture },
      { assertion: assert_reaction_stored },
      { action: aliceCatsFirst, trustedUi: reactGesture },
      { action: bobCatsFirst, trustedUi: reactGesture },
      { assertion: assert_tallies_in_offered_order },
      { assertion: assert_tallies_mark_only_viewers_own },
      { assertion: assert_linked_viewer_sees_own_marked },
      { action: aliceCatsFirst, trustedUi: reactGesture },
      { assertion: assert_second_use_takes_reaction_back },
      { action: aliceCatsFirst, trustedUi: reactGesture },
      { assertion: assert_taken_back_reaction_can_return },
      { action: aliceCatsSecond, trustedUi: reactGesture },
      { assertion: assert_each_message_tallies_its_own },
      { action: aliceOffersADog, trustedUi: reactGesture },
      { assertion: assert_unoffered_emoji_refused },
      { action: pendingCatsFirst, trustedUi: reactGesture },
      { assertion: assert_reaction_without_profile_refused },
      { action: pendingCatsFirstFromPicker, trustedUi: reactGesture },
      { assertion: assert_refusal_leaves_picker_open },
      { action: aliceCriesSecondFromPicker, trustedUi: reactGesture },
      { assertion: assert_reaction_closes_picker },
      { assertion: assert_picker_starts_closed },
      { action: action_toggle_picker },
      { assertion: assert_picker_offers_every_cat },
      { action: action_toggle_picker },
      { assertion: assert_picker_closes_again },
    ],
  };
});
