/**
 * Who wrote what in a FabriChat room shared by two people, each in a runtime
 * of their own with an identity of their own: a message is labeled with its
 * sender and a reaction with its reactor, each writer's label survives the
 * other's writes, and a write no handler of the room makes is refused, whether
 * to a message's text, to someone else's reaction, or to the room's list:
 * removing an element, replacing it in place, pointing its position at
 * another document, or pushing one under someone else's profile.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  currentPrincipal,
  multiUserTest,
  pattern,
  principalOf,
  TESTS,
  Writable,
} from "commonfabric";
import { FabriChatMessageRow } from "./message-row.tsx";
import {
  type MessageRecord,
  type MessagesValue,
  type ReactionsValue,
  type SentMessage,
} from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_REACT_ACTION,
  CHAT_REACT_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_UNREACT_ACTION,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];
type RowArg = Parameters<typeof FabriChatMessageRow>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const reactGesture = { surface: CHAT_REACT_SURFACE, action: CHAT_REACT_ACTION };
const unreactGesture = {
  surface: CHAT_REACT_SURFACE,
  action: CHAT_UNREACT_ACTION,
};

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** What every session receives from the setup. */
interface Setup {
  messages: Writable<MessagesValue>;
}

const firstBody = (messages: Cell<MessagesValue>): string => {
  const first = ((messages.get() ?? []) as MessageRecord[])[0];
  return typeof first?.body === "string" ? first.body : "";
};

const messageCount = (messages: Cell<MessagesValue>): number =>
  ((messages.get() ?? []) as MessageRecord[]).length;

const reactionsOnFirst = (messages: Cell<MessagesValue>): number => {
  const first = ((messages.get() ?? []) as MessageRecord[])[0];
  return ((first?.reactions?.get() ?? []) as unknown[]).length;
};

/** An element of a list whose elements carry no policy. */
interface PlainNote {
  body: string;
}

/** Each of `notes`' bodies, in order. */
const plainBodies = (notes: Cell<PlainNote[]>): string =>
  (notes.get() ?? []).map((note) => note?.body).join(" | ");

/** The first message's reaction list, as a cell to write through. */
const reactionListOfFirst = (
  messages: Cell<MessagesValue>,
): Writable<ReactionsValue> | undefined =>
  ((messages.get() ?? []) as MessageRecord[])[0]?.reactions;

export const setup = pattern(() => ({
  messages: Writable.of<MessagesValue>([] as MessagesValue),
}));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const room = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const },
    messages: setup.messages,
  } as RoomArg);
  const me = Writable.of<string>("");
  const noteMe = action(() => me.set(currentPrincipal() ?? ""));
  // Removes Bob's reaction through no handler the reaction names.
  const removeBobsReaction = action(() => {
    const list = reactionListOfFirst(setup.messages);
    if (list === undefined) return;
    list.removeByValue(list.key(0));
  });

  return {
    // The write no handler makes is refused, which the runtime reports.
    allowRuntimeErrors: true,
    allowConsoleErrors: true,
    allowConsoleWarnings: true,
    [TESTS]: [
      { action: noteMe },
      {
        action: room.composerSend,
        event: typed("Hello from Alice"),
        trustedUi: sendGesture,
      },
      // Alice's message is labeled as hers.
      {
        assertion: assert(() =>
          me.get() !== "" &&
          firstBody(setup.messages) === "Hello from Alice" &&
          principalOf(setup.messages.key(0), "authored-by") === me.get()
        ),
      },
      { label: "alice-sent" },
      { await: "bob-reacted" },
      // Bob's reaction landed, labeled as his; Alice's message keeps her
      // label and her text.
      {
        assertion: assert(() => {
          const reactor = principalOf(
            setup.messages.key(0).key("reactions").key(0),
            "authored-by",
          );
          return reactionsOnFirst(setup.messages) === 1 &&
            reactor !== undefined && reactor !== me.get() &&
            firstBody(setup.messages) === "Hello from Alice" &&
            principalOf(setup.messages.key(0), "authored-by") === me.get();
        }),
      },
      // Alice can't remove Bob's reaction outside the room's handlers.
      { action: removeBobsReaction },
      { assertion: assert(() => reactionsOnFirst(setup.messages) === 1) },
      { label: "alice-tried" },
      { await: "bob-done" },
      // Bob removed his own reaction, and couldn't remove Alice's message.
      {
        assertion: assert(() =>
          reactionsOnFirst(setup.messages) === 0 &&
          messageCount(setup.messages) === 1
        ),
      },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<TestProfile>({ name: "Bob" });
  const onFirst = FabriChatMessageRow({
    message: setup.messages.key(0),
    myProfile: profile,
    inThread: false,
    kind: "group" as const,
    composer: Writable.of({}),
    // Stand-ins for what the room derives; a row's streams read none of it.
    places: {},
    cannotWrite: false,
    isOwner: false,
    messages: setup.messages,
  } as RowArg);
  const me = Writable.of<string>("");
  const noteMe = action(() => me.set(currentPrincipal() ?? ""));
  // Writes no handler the message names makes.
  const editAlicesMessage = action(() =>
    setup.messages.key(0).key("body").set("Bob was here")
  );
  const removeAlicesMessage = action(() =>
    setup.messages.removeByValue(setup.messages.key(0))
  );
  // Writes at the message's position in the list, which the element's
  // policy governs: the element replaced in place, the position pointed at
  // a document of Bob's, and a push under Alice's profile.
  const forged = Writable.of<MessageRecord | undefined>(undefined);
  const replaceAlicesMessage = action(() => {
    const current = setup.messages.key(0).get();
    if (current === undefined) return;
    setup.messages.key(0).set(
      { ...current, body: "Bob replaced this" } as SentMessage,
    );
  });
  const repointAlicesMessage = action(() => {
    const current = setup.messages.key(0).get();
    if (current === undefined) return;
    forged.set({ ...current, body: "Bob pointed here" });
    setup.messages.key(0).set(forged as never);
  });
  const pushAsAlice = action(() => {
    const current = setup.messages.key(0).get();
    if (current === undefined) return;
    setup.messages.push(
      { ...current, body: "Bob pushed this" } as SentMessage,
    );
  });
  // The same three writes on a list whose elements carry no policy, each of
  // which lands: what refuses them on the room's list is the policy.
  const plain = Writable.of<PlainNote[]>([]);
  const plainTarget = Writable.of<PlainNote | undefined>(undefined);
  const seedPlain = action(() => plain.push({ body: "Plain" }));
  const replacePlain = action(() => {
    const current = plain.key(0).get();
    if (current === undefined) return;
    plain.key(0).set({ ...current, body: "Bob replaced this" });
  });
  const repointPlain = action(() => {
    const current = plain.key(0).get();
    if (current === undefined) return;
    plainTarget.set({ ...current, body: "Bob pointed here" });
    plain.key(0).set(plainTarget as never);
  });
  const pushPlain = action(() => {
    const current = plain.key(0).get();
    if (current === undefined) return;
    plain.push({ ...current, body: "Bob pushed this" });
  });

  return {
    allowRuntimeErrors: true,
    allowConsoleErrors: true,
    allowConsoleWarnings: true,
    [TESTS]: [
      { action: noteMe },
      { await: "alice-sent" },
      {
        action: onFirst.sendReaction,
        event: { emoji: "👍" },
        trustedUi: reactGesture,
      },
      // Bob's reaction is labeled as his.
      {
        assertion: assert(() =>
          me.get() !== "" &&
          reactionsOnFirst(setup.messages) === 1 &&
          principalOf(
              setup.messages.key(0).key("reactions").key(0),
              "authored-by",
            ) === me.get()
        ),
      },
      // Bob can't change Alice's text outside the room's handlers, nor
      // replace her message, point its position elsewhere, or push one as
      // her.
      { action: editAlicesMessage },
      { action: replaceAlicesMessage },
      { action: repointAlicesMessage },
      { action: pushAsAlice },
      {
        assertion: assert(() =>
          firstBody(setup.messages) === "Hello from Alice" &&
          messageCount(setup.messages) === 1 &&
          principalOf(setup.messages.key(0), "authored-by") !== me.get()
        ),
      },
      { action: seedPlain },
      { action: replacePlain },
      {
        assertion: assert(() => plainBodies(plain) === "Bob replaced this"),
      },
      { action: repointPlain },
      { action: pushPlain },
      {
        assertion: assert(() =>
          plainBodies(plain) === "Bob pointed here | Bob pushed this"
        ),
      },
      { label: "bob-reacted" },
      { await: "alice-tried" },
      // Bob removes his own reaction through the room, and can't remove
      // Alice's message outside it.
      {
        action: onFirst.deleteReaction,
        event: { reaction: setup.messages.key(0).key("reactions").key(0) },
        trustedUi: unreactGesture,
      },
      { assertion: assert(() => reactionsOnFirst(setup.messages) === 0) },
      { action: removeAlicesMessage },
      { assertion: assert(() => messageCount(setup.messages) === 1) },
      { label: "bob-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
