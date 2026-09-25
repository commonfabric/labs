/**
 * The FabriChat room: a single shared conversation, each of whose messages is
 * labeled with the principal who sent it.
 *
 * A message names its sender by linking the sender's profile, and it is written
 * only by `commitSend`, reached from the composer's reviewed surface. The
 * runtime labels each stored message `authored-by` the principal who sent it,
 * and `cf-cfc-authorship` marks the message verified when that principal owns
 * the profile the message links.
 *
 * A reaction is a record of its own, not a field of the message: which message,
 * which of a few cat faces, and the profile of the person reacting. It is
 * written only by `commitReact`, reached from a reviewed surface on the
 * message, and labeled `authored-by` its reactor as a message is by its sender.
 * Each reaction is kept at an address derived from the reactor, the message,
 * and the emoji, so adding or removing one never rewrites anyone else's.
 *
 * The room takes the viewer's profile as an input rather than wishing for it,
 * so that `main.tsx` supplies the real `#profile` and a test can supply a
 * stand-in.
 */
import {
  action,
  AuthoredByCurrentUser,
  type Cell,
  computed,
  Default,
  entityRefToString,
  equals,
  getEntityId,
  handler,
  NAME,
  pattern,
  Stream,
  type TrustedActionWrite,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/** The UI integrity the composer's reviewed surface gives the events in it. */
export const FABRICHAT_SEND_SURFACE = "FabriChatSendSurface";

/** The reviewed action a send is, on the composer's surface. */
export const FABRICHAT_SEND_ACTION = "FabriChatSend";

/** The UI integrity a message's reviewed reaction surface gives its events. */
export const FABRICHAT_REACT_SURFACE = "FabriChatReactSurface";

/** The reviewed action a reaction is, on a message's reaction surface. */
export const FABRICHAT_REACT_ACTION = "FabriChatReact";

/** The reactions on offer, in the order a message shows them. */
export const FABRICHAT_REACJI = ["😺", "😻", "🙀", "😿"] as const;

/** How a reaction's emoji is drawn, at twice a small button's text size. */
const REACJI_STYLE = { fontSize: "22px", lineHeight: "1" };

/** The fields of a profile that the room reads. */
export interface FabriChatProfile {
  name?: string;
  avatar?: string;
}

/** A live link to a person's profile. */
export type ProfileCell = Cell<FabriChatProfile>;

/** What a sent message holds. */
export interface FabriChatMessage {
  /** The profile the sender sent under. */
  authorProfile: ProfileCell;

  /**
   * The sender's profile name when the message was sent, or `""` when the
   * profile has no name or the name had not yet reached the handler.
   */
  authorName: string;

  /** The sender's profile avatar (a URL or a glyph) when the message was sent. */
  authorAvatar: string;

  body: string;

  /**
   * When the message was sent, in milliseconds since the epoch, at the
   * one-second resolution a handler's clock has.
   */
  sentAt: number;
}

/** A stored message: written only by `commitSend`, labeled with its sender. */
export type SentMessage = AuthoredByCurrentUser<
  TrustedActionWrite<
    FabriChatMessage,
    typeof commitSend,
    typeof FABRICHAT_SEND_ACTION,
    typeof FABRICHAT_SEND_SURFACE
  >
>;

/** A live link to a message. */
export type MessageCell = Cell<FabriChatMessage>;

/** What a reaction holds. */
export interface FabriChatReaction {
  /** The profile the reactor reacted under. */
  reactorProfile: ProfileCell;

  /** The message reacted to. */
  message: MessageCell;

  /** One of `FABRICHAT_REACJI`. */
  emoji: string;
}

/**
 * A stored reaction: written only by `commitReact`, labeled with its reactor.
 */
export type SentReaction = AuthoredByCurrentUser<
  TrustedActionWrite<
    FabriChatReaction,
    typeof commitReact,
    typeof FABRICHAT_REACT_ACTION,
    typeof FABRICHAT_REACT_SURFACE
  >
>;

/** A conversation's reactions, in no particular order. */
export type ReactionsValue = SentReaction[] | Default<[]>;

/** The cell holding a conversation's reactions. */
export type ReactionsCell = Writable<ReactionsValue>;

/** How one emoji stands on one message. */
export interface ReactionTally {
  emoji: string;

  /** How many people reacted with it. */
  count: number;

  /** Whether the viewer is one of them. */
  mine: boolean;

  /**
   * Their profiles, in the order the reactions list holds them. That is the
   * order of adding in a single session; reactions added at once in different
   * sessions can land in either order.
   */
  reactors: ProfileCell[];

  /**
   * An id for the card that lists them, unique on the page, so the count can
   * name the card as its description.
   */
  cardId: string;
}

/** A conversation's messages, oldest first. */
export type MessagesValue = SentMessage[] | Default<[]>;

/** The cell holding a conversation's messages. */
export type MessagesCell = Writable<MessagesValue>;

/**
 * The click a `cf-submit-input` delivers, from its button or from Enter in its
 * field. It is a trusted DOM gesture, and it carries the field's text as
 * `target.value`.
 */
export interface SubmittedTextEvent {
  readonly target?: { readonly value?: string };
}

/** Someone who has sent at least one message. */
export interface Participant {
  name: string;
  profile: ProfileCell;
}

/**
 * The distinct senders of `messages`, in order of first message. Two senders
 * are the same person when their profiles are the same cell; a shared name
 * does not make them one.
 */
export const participantsOf = (
  messages: readonly FabriChatMessage[],
): Participant[] =>
  messages.reduce<Participant[]>(
    (found, message) =>
      message?.authorProfile === undefined ||
        found.some((known) => equals(known.profile, message.authorProfile))
        ? found
        : [...found, {
          name: message.authorName,
          profile: message.authorProfile,
        }],
    [],
  );

/**
 * Appends the submitted text as a message from the viewer. It refuses an empty
 * message, and it refuses to send before the viewer's profile is known. The
 * profile name is kept only as a snapshot, so it does not hold a send back: a
 * profile's name can reach the handler later than the profile does, when the
 * handler runs apart from the viewer's page, and the profile itself names the
 * sender. The profile can lag the same way, and a send the handler refuses for
 * want of it is spent, like any event a handler declines.
 */
export const commitSend = handler<
  SubmittedTextEvent,
  {
    // Holds no value until the viewer's profile resolves.
    myProfile: ProfileCell | undefined;
    myName: string;
    myAvatar: string;
    messages: MessagesCell;
  }
>((event, { myProfile, myName, myAvatar, messages }) => {
  const body = (event?.target?.value ?? "").trim();
  const authorName = (myName ?? "").trim();
  // The message stores the profile cell itself, not the link that reached it,
  // and it is that cell's value that decides whether the send goes ahead.
  const profile = myProfile?.resolveAsCell();
  if (!body || profile?.get() === undefined) {
    return;
  }

  messages.push({
    authorProfile: profile,
    authorName,
    authorAvatar: (myAvatar ?? "").trim(),
    body,
    sentAt: Date.now(),
  } as SentMessage);
});

type CommitSendInput = Parameters<typeof commitSend>[0];

/**
 * A reaction's address: its reactor's profile entity, its message's entity, and
 * its emoji. One person's one reaction to one message has a single address in
 * every session, so a handler reaches it without reading the list, and two
 * people reacting at once write different records. Both cells must be resolved
 * to the entities they name: a cell reaching a message through its slot in the
 * list names the slot. It is `undefined` when either cell names no entity.
 */
export const reactionKeyFor = (
  reactor: ProfileCell,
  message: MessageCell,
  emoji: string,
): string | undefined => {
  const reactorRef = getEntityId(reactor);
  const messageRef = getEntityId(message);
  if (reactorRef === undefined || messageRef === undefined) return undefined;
  return JSON.stringify([
    entityRefToString(reactorRef),
    entityRefToString(messageRef),
    emoji,
  ]);
};

/**
 * The emoji `reactions` hold for `message`, in the order `FABRICHAT_REACJI`
 * lists them, leaving out any nobody used, each with the profiles that used
 * it. A reaction is the viewer's when its profile is the viewer's profile
 * cell.
 */
export const reactionTallies = (
  reactions: readonly FabriChatReaction[],
  message: MessageCell | FabriChatMessage | undefined,
  viewer: ProfileCell | undefined,
): ReactionTally[] => {
  const messageRef = message === undefined ? undefined : getEntityId(message);
  const cardIdPrefix = `fabrichat-reactors-${
    messageRef === undefined ? "unsaved" : entityRefToString(messageRef)
  }`;
  return FABRICHAT_REACJI.map((emoji, index) => {
    const onThis = reactions.filter((reaction) =>
      reaction?.emoji === emoji && equals(reaction.message, message)
    );
    return {
      emoji,
      count: onThis.length,
      mine: viewer !== undefined &&
        onThis.some((reaction) => equals(reaction.reactorProfile, viewer)),
      reactors: onThis.map((reaction) => reaction.reactorProfile),
      cardId: `${cardIdPrefix}-${index}`,
    };
  }).filter((tally) => tally.count > 0);
};

/**
 * Clears the record at `key`. A reaction's record outlives its place in the
 * list, and it is the record that says whether someone has the reaction, so a
 * removal clears it too.
 */
const clearReaction = (reactions: ReactionsCell, key: string): void => {
  const reaction: Writable<SentReaction | undefined> = reactions.elementById(
    key,
  );
  reaction.set(undefined);
};

/**
 * Adds the viewer's `emoji` reaction to `message`, or removes it when the
 * viewer already has it there, and closes the picker the reaction was chosen
 * from, when there is one. It refuses an emoji not on offer, and it refuses to
 * react before the viewer's profile is known, leaving the picker open. The
 * profile can reach the handler later than it reaches the viewer's page, as
 * `commitSend` describes, and a click the handler refuses is spent.
 */
export const commitReact = handler<
  unknown,
  {
    emoji: string;
    message: MessageCell;
    // Holds no value until the viewer's profile resolves.
    myProfile: ProfileCell | undefined;
    reactions: ReactionsCell;
    pickerOpen?: Writable<boolean>;
  }
>((_event, { emoji, message, myProfile, reactions, pickerOpen }) => {
  if (!(FABRICHAT_REACJI as readonly string[]).includes(emoji)) return;
  const reactor = myProfile?.resolveAsCell();
  const target = message.resolveAsCell();
  if (reactor?.get() === undefined || target.get() === undefined) return;
  const key = reactionKeyFor(reactor, target, emoji);
  if (key === undefined) return;

  pickerOpen?.set(false);
  const mine = reactions.elementById(key);
  if (mine.get() !== undefined) {
    reactions.removeByValue(mine);
    clearReaction(reactions, key);
    return;
  }
  mine.set({ reactorProfile: reactor, message: target, emoji } as SentReaction);
  reactions.addUnique(mine);
});

type CommitReactInput = Parameters<typeof commitReact>[0];

/** What a message row needs. */
export interface FabriChatMessageRowInput {
  message: FabriChatMessage;

  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: ProfileCell | undefined;

  reactions: ReactionsCell;
}

/** What a message row provides. */
export interface FabriChatMessageRowOutput {
  [UI]: VNode;
  tallies: ReactionTally[];
}

/**
 * One message: its sender, its body, and its reactions, with a control that
 * appears on hover to add one.
 */
export const FabriChatMessageRow = pattern<
  FabriChatMessageRowInput,
  FabriChatMessageRowOutput
>(({ message, myProfile, reactions }) => {
  const pickerOpen = new Writable.perSession(false);
  const togglePicker = action(() => pickerOpen.set(!pickerOpen.get()));
  const tallies = computed(() =>
    reactionTallies(
      (reactions.get() ?? []) as FabriChatReaction[],
      message,
      myProfile?.get() === undefined ? undefined : myProfile,
    )
  );
  const cannotReact = computed(() => myProfile?.get() === undefined);

  return {
    [UI]: (
      <div
        data-ui-pattern={FABRICHAT_REACT_SURFACE}
        data-ui-event-integrity={FABRICHAT_REACT_SURFACE}
      >
        <cf-hover-reveal revealed={pickerOpen}>
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              alignItems: "flex-start",
            }}
          >
            <cf-profile-badge
              variant="circle"
              size="sm"
              $profile={message.authorProfile}
            />
            <cf-vstack gap="1" style={{ flex: "1", minWidth: "0" }}>
              <cf-cfc-authorship
                $value={message.body}
                $author={message.authorProfile}
                authorName={message.authorName || undefined}
              >
                <cf-text
                  variant="body"
                  block
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {message.body}
                </cf-text>
              </cf-cfc-authorship>
              <div
                style={{
                  display: "flex",
                  gap: "0.25rem",
                  flexWrap: "wrap",
                }}
              >
                {tallies.map((tally) => (
                  <cf-hover-card>
                    <cf-button
                      data-ui-action={FABRICHAT_REACT_ACTION}
                      aria-describedby={tally.cardId}
                      size="sm"
                      color="primary"
                      variant={tally.mine ? "outline" : "ghost"}
                      disabled={cannotReact}
                      onClick={commitReact({
                        emoji: tally.emoji,
                        message,
                        myProfile,
                        reactions,
                      } as CommitReactInput)}
                    >
                      {
                        /* One item in the button's row, so the emoji and its
                        count read as one run of text. */
                      }
                      <span>
                        <span style={REACJI_STYLE}>{tally.emoji}</span>{" "}
                        {tally.count}
                      </span>
                    </cf-button>
                    <cf-vstack id={tally.cardId} slot="card" gap="1">
                      {tally.reactors.map((reactor) => (
                        <cf-profile-badge
                          size="sm"
                          noNavigate
                          $profile={reactor}
                        />
                      ))}
                    </cf-vstack>
                  </cf-hover-card>
                ))}
              </div>
            </cf-vstack>
          </div>
          <cf-hstack slot="actions" gap="1" align="center">
            {pickerOpen
              ? FABRICHAT_REACJI.map((emoji) => (
                <cf-button
                  data-ui-action={FABRICHAT_REACT_ACTION}
                  size="sm"
                  variant="ghost"
                  disabled={cannotReact}
                  onClick={commitReact({
                    emoji,
                    message,
                    myProfile,
                    reactions,
                    pickerOpen,
                  } as CommitReactInput)}
                >
                  <span style={REACJI_STYLE}>{emoji}</span>
                </cf-button>
              ))
              : null}
            <cf-button
              size="sm"
              variant="ghost"
              aria-label="Add reaction"
              title="Add reaction"
              disabled={cannotReact}
              onClick={togglePicker}
            >
              <span style={REACJI_STYLE}>{pickerOpen ? "✕" : "⚇+"}</span>
            </cf-button>
          </cf-hstack>
        </cf-hover-reveal>
      </div>
    ),
    tallies,
  };
});

/** What a room needs: the viewer, and the conversation with its reactions. */
export interface FabriChatRoomInput {
  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: ProfileCell | undefined;

  /**
   * The viewer's profile name, or `""` while it is unknown or when the profile
   * has none.
   */
  myName: string;

  /** The viewer's profile avatar (a URL or a glyph), empty if none. */
  myAvatar: string;

  messages: MessagesCell;

  reactions: ReactionsCell;
}

/** What a room provides. */
export interface FabriChatRoomOutput {
  [NAME]: string;
  [UI]: VNode;
  messages: MessagesCell;
  reactions: ReactionsCell;
  participants: Participant[];
  sendMessage: Stream<SubmittedTextEvent>;
}

/**
 * A conversation among the people who send to it, with a composer that sends
 * as the viewer.
 */
export const FabriChatRoom = pattern<FabriChatRoomInput, FabriChatRoomOutput>(
  ({ myProfile, myName, myAvatar, messages, reactions }) => {
    const sendMessage = commitSend({
      myProfile,
      myName,
      myAvatar,
      messages,
    } as CommitSendInput);
    const participants = computed(() =>
      participantsOf(messages.get() as FabriChatMessage[])
    );
    const isEmpty = computed(() => (messages.get() ?? []).length === 0);
    const cannotSend = computed(() => myProfile?.get() === undefined);

    return {
      [NAME]: "FabriChat",
      [UI]: (
        <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "640px" }}>
          <cf-hstack justify="between" align="center" gap="4">
            <cf-heading level={3}>FabriChat</cf-heading>
            <cf-profile-badge $profile={myProfile} size="sm" />
          </cf-hstack>

          {
            /* A plain flex row, not `cf-hstack`, whose host clips overflow
              and would cut off the badges' verified glow. */
          }
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {participants.map((participant) => (
              <cf-profile-badge
                variant="chip"
                $profile={participant.profile}
              />
            ))}
          </div>

          <cf-vstack
            id="fabrichat-messages"
            gap="3"
            style={{ minHeight: "160px" }}
          >
            {messages.map((message) => (
              <FabriChatMessageRow
                message={message}
                myProfile={myProfile}
                reactions={reactions}
              />
            ))}
            {isEmpty
              ? <cf-empty-state message="No messages yet. Say hello!" />
              : null}
          </cf-vstack>

          <div
            data-ui-pattern={FABRICHAT_SEND_SURFACE}
            data-ui-event-integrity={FABRICHAT_SEND_SURFACE}
          >
            <cf-submit-input
              data-ui-action={FABRICHAT_SEND_ACTION}
              inputId="fabrichat-message"
              placeholder="Message"
              buttonText="Send"
              disabled={cannotSend}
              onClick={sendMessage}
            />
          </div>
        </cf-vstack>
      ),
      messages,
      reactions,
      participants,
      sendMessage,
    };
  },
);
