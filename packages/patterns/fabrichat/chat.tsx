/**
 * The FabriChat room: a single shared conversation, each of whose messages is
 * labeled with the principal who sent it.
 *
 * A message names its sender by linking the sender's profile, and it is written
 * only by `commitSend`, reached from the composer's reviewed surface. The
 * runtime labels each stored message `authored-by` the principal who sent it.
 *
 * The room takes the viewer's profile as an input rather than wishing for it,
 * so that `main.tsx` supplies the real `#profile` and a test can supply a
 * stand-in.
 */
import {
  AuthoredByCurrentUser,
  type Cell,
  computed,
  Default,
  equals,
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

  /** The sender's profile name when the message was sent. */
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
 * message, and it refuses to send before the viewer's profile and profile name
 * are both known.
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
  if (!body || !authorName || myProfile?.get() === undefined) {
    return;
  }

  // The message stores the profile cell itself, not the link that reached it.
  messages.push({
    authorProfile: myProfile.resolveAsCell(),
    authorName,
    authorAvatar: (myAvatar ?? "").trim(),
    body,
    sentAt: Date.now(),
  } as SentMessage);
});

type CommitSendInput = Parameters<typeof commitSend>[0];

/** What a room needs: the viewer, and the conversation. */
export interface FabriChatRoomInput {
  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: ProfileCell | undefined;

  /** The viewer's profile name, empty while it is unknown. */
  myName: string;

  /** The viewer's profile avatar (a URL or a glyph), empty if none. */
  myAvatar: string;

  messages: MessagesCell;
}

/** What a room provides. */
export interface FabriChatRoomOutput {
  [NAME]: string;
  [UI]: VNode;
  messages: MessagesCell;
  participants: Participant[];
  sendMessage: Stream<SubmittedTextEvent>;
}

/**
 * A conversation among the people who send to it, with a composer that sends
 * as the viewer.
 */
export const FabriChatRoom = pattern<FabriChatRoomInput, FabriChatRoomOutput>(
  ({ myProfile, myName, myAvatar, messages }) => {
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
    const cannotSend = computed(() =>
      myProfile?.get() === undefined || (myName ?? "") === ""
    );

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
                <cf-vstack gap="0" style={{ flex: "1", minWidth: "0" }}>
                  <cf-text variant="body-compact">{message.authorName}</cf-text>
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
                </cf-vstack>
              </div>
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
      participants,
      sendMessage,
    };
  },
);
