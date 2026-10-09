/**
 * `FabriChatRoom`: one conversation, an implementation of `ChatRoomOutput`
 * (`docs/specs/fabrichat/FabriChatRoom.md`). What the room stores, and the
 * handlers that write it, are in `room-records.tsx`; one message's rendering
 * is in `message-row.tsx`.
 *
 * Who may read and write is the business of the room's space: its access list
 * decides. A room a manager creates is its space's root, and keeps the space's
 * participants itself: the profiles of those who joined, each added through
 * `addParticipant`, the roster's one writer (`../loom/participants.tsx`). A
 * room in some other social space, which isn't its space's root, lists that
 * space's participants as the root lists them (`wish("#default")`), then those
 * who joined the room itself. The room shows every author alongside them.
 *
 * `FabriChatRoomCore` takes the viewer's profile as an input, so a test can
 * supply a stand-in. The default export, `FabriChatRoom`, resolves the real
 * one with `#profile`.
 */
import {
  action,
  type Cell,
  computed,
  type Default,
  equals,
  eventKey,
  type FabricEpochNsec,
  grantSpaceAccess,
  handler,
  NAME,
  pattern,
  type PerSession,
  principalOf,
  SELF,
  spaceAccess,
  spaceOf,
  Stream,
  UI,
  VIEWS,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import {
  addParticipant,
  participantEntries,
  type ParticipantRosterCell,
} from "../loom/participants.tsx";
import {
  isSharedSpaceCatalog,
  type SharedSpaceCatalogStorage,
} from "../system/shared-space-catalog.ts";
import { isInMain, type ShownIn } from "./logic.ts";
import {
  type ActivityCell,
  type ActivityCounters,
  type ActivityCountersCell,
  canActIn,
  commitDelete,
  commitDeleteReaction,
  commitEdit,
  commitObliterate,
  commitSend,
  commitSendReaction,
  commitWindow,
  compareEntries,
  type ComposerState,
  entryFor,
  FABRICHAT_POLICY,
  type MessageCell,
  messageEntries,
  type MessageEntry,
  type MessagesCell,
  NO_ACTIVITY,
  NUMBERING_KEY,
  type ReactionListsCell,
  type RequestsCell,
  type RoomStreamEvent,
  type RoomWindowEvent,
  type StoredAbout,
  type UsedTimesCell,
  type WindowsCell,
  type WindowsValue,
} from "./room-records.tsx";
import { bodyText, FabriChatMessageRow } from "./message-row.tsx";
import {
  type AboutRecord,
  type AddMemberOutcome,
  type AddMemberRefusalCode,
  CHAT_ADD_MEMBER_ACTION,
  CHAT_ADD_MEMBER_SURFACE,
  CHAT_ROOM_OFFER_KIND,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatDisplay,
  type ChatProfile,
  type ChatRoomAbout,
  type ChatRoomActivity,
  type ChatRoomKind,
  type ChatRoomLink,
  type ChatRoomPolicy,
  isPrincipalDID,
  type ProfileCell,
} from "./schemas.tsx";

/**
 * The room's participants: those listed, then every author not among them,
 * each once, in the order each first appears. Two are the same person when
 * their profiles are the same cell.
 */
export const participantsOf = (
  listed: readonly ProfileCell[],
  entries: readonly MessageEntry[],
): ProfileCell[] =>
  [
    ...listed,
    ...[...entries].sort(compareEntries).map((entry) =>
      entry.record.authorProfile
    ),
  ].reduce<ProfileCell[]>(
    (found, profile) =>
      profile === undefined || found.some((known) => equals(known, profile))
        ? found
        : [...found, profile],
    [],
  );

/** What joining a room asks: the profile to add to its participants. */
export interface JoinRoomEvent {
  /** The profile, as the live cell in its own space. */
  profile: ProfileCell;
}

/**
 * What a participant's chip sends its viewer's manager's `openDirect`: the
 * click on its chat control, whose target names the person to chat with.
 */
export interface StartDirectEvent {
  /** The chat control, naming the other person's principal. */
  readonly target?: { readonly dataset?: { readonly counterpart?: string } };
}

/** What a participant's chip needs. */
export interface ParticipantChipInput {
  /** The participant's profile. */
  participant: ProfileCell;

  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: ProfileCell | undefined;

  /**
   * Whether the viewer has a manager to start a direct chat with; absent for
   * none.
   */
  startsDirect?: boolean;

  /**
   * The viewer's manager's `openDirect`, when `startsDirect` holds. The
   * control sends its click there itself, so that the manager receives the
   * viewer's reviewed `ChatStart`.
   */
  startDirect?: Stream<StartDirectEvent>;
}

/** What a participant's chip provides. */
export interface ParticipantChipOutput {
  /** The participant's badge, and the control that starts a chat with them. */
  [UI]: VNode;
}

/**
 * One participant, shown by their profile, with a control that starts a direct
 * chat with them. The control shows only where it can start one: for someone
 * other than the viewer, whose profile attests a principal, to a viewer who
 * has a manager. It names the participant to the manager by the principal
 * their profile's `represents-principal` label attests.
 */
export const ParticipantChip = pattern<
  ParticipantChipInput,
  ParticipantChipOutput
>(({ participant, myProfile, startsDirect, startDirect }) => {
  const counterpart = computed(() =>
    principalOf(participant, "represents-principal") ?? ""
  );
  // Who may start a chat differs by viewer, so the control is hidden by a
  // prop rather than built as a different tree (see `FabriChatMessageRow`).
  const chatDisplay = computed((): ChatDisplay =>
    startsDirect === true && myProfile?.get() !== undefined &&
      !equals(participant, myProfile) && counterpart !== ""
      ? "inline-flex"
      : "none"
  );

  return {
    [UI]: (
      <span style={{ display: "inline-flex", gap: "0.25rem" }}>
        <cf-profile-badge variant="chip" $profile={participant} />
        <span
          data-ui-pattern={CHAT_START_SURFACE}
          data-ui-event-integrity={CHAT_START_SURFACE}
          hidden
          style={{ display: chatDisplay }}
        >
          <cf-button
            data-ui-action={CHAT_START_ACTION}
            data-counterpart={counterpart}
            size="sm"
            variant="ghost"
            onClick={startDirect}
          >
            Chat
          </cf-button>
        </span>
      </span>
    ),
  };
});

/** What adding a room to a manager's list asks of it: the room. */
export interface AcceptRoomEvent {
  /** The room to list. */
  room: Cell<ChatRoomLink>;
}

/** Asks the viewer's manager to list `room`. */
const askToList = handler<unknown, {
  room: Cell<ChatRoomLink>;
  accept?: Stream<AcceptRoomEvent>;
}>((_event, { room, accept }) => {
  accept?.send({ room });
});

/**
 * Whether `catalog` keeps the room in `space` as one of its user's chats; a
 * catalog that doesn't read as one keeps none.
 */
const listsRoomIn = (catalog: unknown, space: string | undefined): boolean => {
  if (!isSharedSpaceCatalog(catalog) || space === undefined) return false;
  const entry = catalog.entries[space];
  return entry?.kind === CHAT_ROOM_OFFER_KIND && entry.state === "saved";
};

/** What the control adding a room to the viewer's chats needs. */
export interface AddToChatsInput {
  /** The room. */
  room: Cell<ChatRoomLink>;

  /**
   * The shared-space catalog the viewer's manager lists its rooms from; absent
   * when the viewer has no manager.
   */
  catalog?: SharedSpaceCatalogStorage;

  /** The viewer's manager's `accept`, when `catalog` is present. */
  accept?: Stream<AcceptRoomEvent>;
}

/** What the control adding a room to the viewer's chats provides. */
export interface AddToChatsOutput {
  /** The control, shown only where it can add the room. */
  [UI]: VNode;

  /** Adds the room to the viewer's chats. */
  add: Stream<unknown>;
}

/**
 * Offers to add a room to the viewer's chats, for a viewer with a manager that
 * doesn't list it: someone who reached the room by its link, rather than by a
 * notice their client delivered.
 */
export const AddToChats = pattern<AddToChatsInput, AddToChatsOutput>(
  ({ room, catalog, accept }) => {
    // TODO(danfuzz): A stop-gap. Remove this control once creating a room
    // offers it to every member, so that every member's catalog lists it
    // without a step of their own.
    const add = askToList({ room, accept });
    // Whether the viewer's manager lists the room differs by viewer, so the
    // control is hidden by a prop rather than built as a different tree (see
    // `FabriChatMessageRow`).
    const addDisplay = computed((): ChatDisplay =>
      catalog !== undefined && !listsRoomIn(catalog, spaceOf(room))
        ? "flex"
        : "none"
    );

    return {
      [UI]: (
        <cf-hstack
          id="fabrichat-add-to-chats"
          gap="2"
          align="center"
          hidden
          style={{ display: addDisplay, padding: "1rem 1rem 0" }}
        >
          <cf-text variant="caption">
            This chat isn't in your chats yet.
          </cf-text>
          <cf-button size="sm" onClick={add}>Add to my chats</cf-button>
        </cf-hstack>
      ),
      add,
    };
  },
);

/** What adding a member asks of a room: the control's text. */
export interface AddMemberEvent {
  /**
   * Chosen by the sender, and unique among its adds. The outcome is recorded
   * under it, and sending the same event again with it changes nothing. A
   * rendered control's click carries none, and is given one of its own.
   */
  readonly requestId?: string;

  /** The control, holding the new member's chat address. */
  readonly target?: { readonly value?: string };
}

/** Each of the viewer's adds' outcomes, by its `requestId`. */
export type AddRequestsCell = Writable<
  Record<string, AddMemberOutcome> | Default<Record<PropertyKey, never>>
>;

/** What adding a member is bound to. */
interface AddMemberState {
  /** One of the room's records, which names the room's space. */
  room: MessagesCell;

  /** Whether the room is one a manager created in a space of its own. */
  ownSpace: boolean;

  /** The room's kind, which a direct room's space keeps to its two members. */
  kind: ChatRoomKind;

  /** The viewer's adds' outcomes; absent where they aren't remembered. */
  requests?: AddRequestsCell;

  /** What the session's latest add came to, which the control shows. */
  outcome: Writable<string>;
}

/**
 * Admits the person whose chat address the control holds to the room's space,
 * with OWNER, so that they too may add others, from a trusted gesture on
 * `ChatAddMemberSurface`. Only an OWNER of the space may admit someone, only
 * to a group room, and the session is shown what came of it.
 */
const commitAddMember = handler<AddMemberEvent, AddMemberState>(
  (event, { room, ownSpace, kind, requests, outcome }) => {
    const requestId = event?.requestId ?? eventKey();
    if (requests?.key(requestId).get() !== undefined) return;
    const record = (result: AddMemberOutcome, shown: string): void => {
      requests?.key(requestId).set(result);
      outcome.set(shown);
    };
    const refuse = (reason: string, code?: AddMemberRefusalCode): void =>
      record(
        { status: "refused", reason, ...(code === undefined ? {} : { code }) },
        reason,
      );
    // A space's own chat shares its space, whose members are its own
    // business, whatever a rendering shows.
    if (!ownSpace) {
      refuse("Members of this chat are added by its space.");
      return;
    }
    // A direct room is a conversation between two people, whatever reaches
    // its stream.
    if (kind === "direct") {
      refuse("A direct chat keeps its two members.", "direct-room");
      return;
    }
    const member = event?.target?.value?.trim() ?? "";
    if (!isPrincipalDID(member)) {
      refuse("That isn't a chat address.");
      return;
    }
    try {
      grantSpaceAccess(room, member, "OWNER");
    } catch (error) {
      // A refusal the call can see throws before anything is staged, so the
      // session is told, and nothing else changes.
      refuse(
        `They couldn't be added: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    record({ status: "done" }, `Added ${member}. Send them this chat's link.`);
  },
);

/** What the control adding a member to a room needs. */
export interface AddMemberInput {
  /** One of the room's records, which names the room's space. */
  room: MessagesCell;

  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: ProfileCell | undefined;

  /**
   * Whether the room is one a manager created in a space of its own. A
   * space's own chat shares its space, whose members are its own business.
   */
  ownSpace: boolean;

  /** The room's kind; a direct room's space keeps to its two members. */
  kind: ChatRoomKind;

  /** The viewer's adds' outcomes; absent where they aren't remembered. */
  requests?: AddRequestsCell;
}

/** What the control adding a member to a room provides. */
export interface AddMemberOutput {
  /**
   * The control, shown only to an OWNER of a group room in a space of its own
   * whose profile has resolved, as the room's other controls are.
   */
  [UI]: VNode;

  /** Admits the person the event's control names, from a trusted gesture. */
  add: Stream<AddMemberEvent>;

  /**
   * Whether the viewer can add someone: an OWNER of a group room in a space of
   * its own.
   */
  canAdd: boolean;
}

/**
 * Offers an OWNER of a group room's space a way to admit someone else to it,
 * by their chat address.
 */
export const AddMember = pattern<AddMemberInput, AddMemberOutput>(
  ({ room, myProfile, ownSpace, kind, requests }) => {
    const outcome = new Writable.perSession<string>("");
    const add = commitAddMember({ room, ownSpace, kind, requests, outcome });
    const canAdd = computed(() =>
      ownSpace && kind !== "direct" && spaceAccess(room) === "OWNER"
    );
    // Who may add differs by viewer, and what came of an add by session, so
    // both are hidden by a prop rather than built as a different tree (see
    // `FabriChatMessageRow`).
    const addDisplay = computed((): ChatDisplay =>
      canAdd && myProfile?.get() !== undefined ? "flex" : "none"
    );
    const outcomeDisplay = computed((): ChatDisplay =>
      (outcome.get() ?? "") === "" ? "none" : "block"
    );

    return {
      [UI]: (
        <cf-vstack
          id="fabrichat-add-member"
          gap="1"
          hidden
          style={{ display: addDisplay }}
        >
          <div
            data-ui-pattern={CHAT_ADD_MEMBER_SURFACE}
            data-ui-event-integrity={CHAT_ADD_MEMBER_SURFACE}
          >
            <cf-submit-input
              data-ui-action={CHAT_ADD_MEMBER_ACTION}
              inputId="fabrichat-add-member-address"
              placeholder="Their chat address (did:key:…)"
              buttonText="Add"
              onClick={add}
            />
          </div>
          <div
            id="fabrichat-add-member-outcome"
            hidden
            style={{ display: outcomeDisplay }}
          >
            <cf-text variant="caption">{outcome}</cf-text>
          </div>
        </cf-vstack>
      ),
      add,
      canAdd,
    };
  },
);

/** A room's messages: facts, the newest, and this session's windows. */
export interface ChatMessageList {
  /** How many messages the room holds, obliterated tombstones included. */
  count: number;

  /** The oldest message's `sentAt`; absent while there are none. */
  oldestAt?: FabricEpochNsec;

  /** The newest message's `sentAt`; absent while there are none. */
  newestAt?: FabricEpochNsec;

  /** The newest messages of the main conversation, kept current. */
  latest: {
    /** Up to `maxWindowCount` of them, oldest first. */
    messages: MessageCell[];

    /** Whether the main conversation has older messages than these. */
    hasOlder: boolean;
  };

  /** This session's open windows, by the `windowId` its client chose. */
  windows: PerSession<WindowsCell>;

  /** Opens a window, or moves one already open. */
  openWindow: Stream<RoomWindowEvent>;

  /** Closes a window. */
  closeWindow: Stream<RoomWindowEvent>;
}

/** A room's data face, for hosts that draw it natively. */
export interface ChatRoomView {
  /** What the room says about itself. */
  about: ChatRoomAbout;

  /** What the room recorded recently, in `seq` order. */
  recentActivity: ChatRoomActivity[];

  /** The highest `seq` dropped from `recentActivity` for age; 0 for none. */
  recentActivityExpiredThrough: number;

  /**
   * The room's participants: for a room that is its space's root, those who
   * joined it; for any other, its space's participants as the space's root
   * lists them, then those who joined the room itself; and then any author
   * neither lists.
   */
  participants: ProfileCell[];

  /**
   * Adds a profile to those who joined the room, once. Any participant may add
   * any profile, so an entry is a claim: it does not say that the profile's
   * principal holds access to the room's space.
   */
  addParticipant: Stream<JoinRoomEvent>;

  /** The room's messages. */
  messages: ChatMessageList;

  /** Whether this reader can send, edit, delete, and react. */
  canSend: boolean;

  /** Sends a message. */
  sendMessage: Stream<RoomStreamEvent>;

  /** Records a new version of one of the sender's messages. */
  editMessage: Stream<RoomStreamEvent>;

  /** Records one of the sender's messages as deleted. */
  deleteMessage: Stream<RoomStreamEvent>;

  /** Reduces a message to a tombstone. */
  obliterateMessage: Stream<RoomStreamEvent>;

  /** Adds the sender's reaction to a message. */
  sendReaction: Stream<RoomStreamEvent>;

  /** Removes the sender's reaction to a message. */
  deleteReaction: Stream<RoomStreamEvent>;

  /**
   * Admits someone to the room's space, with OWNER, from a trusted gesture on
   * the rendering's `ChatAddMemberSurface`, or from a client's own control
   * through the sanctioned issuing path. Only an OWNER of a group room in a
   * space of its own may admit someone.
   */
  addMember: Stream<AddMemberEvent>;

  /**
   * Whether this reader can add someone: an OWNER of a group room in a space
   * of its own.
   */
  canAdd: boolean;

  /** The outcome of each of this reader's adds, by its `requestId`. */
  addRequests: Record<string, AddMemberOutcome>;
}

/** What a room offers everyone its space admits: `ChatRoomOutput`. */
export interface ChatRoomOutput extends ChatRoomView {
  /** The room's name, for lists of pieces. */
  [NAME]: string;

  /** The room's own rendering, with its reviewed surfaces. */
  [UI]: VNode;

  /** The room's data face, as one group. */
  [VIEWS]: { room: ChatRoomView };
}

/** What a room stores, and who is looking at it. */
export interface FabriChatRoomCoreInput {
  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: ProfileCell | undefined;

  /**
   * What the room says about itself, as its creator wrote it; absent for a
   * space's own chat, which reads as a group room with no title.
   */
  about?: Cell<AboutRecord>;

  /** The room's messages. */
  messages: MessagesCell;

  /** Every message's reaction list. */
  reactionLists: ReactionListsCell;

  /** The requests the room has acted on. */
  requests: RequestsCell;

  /** The times the room has recorded something at. */
  usedTimes: UsedTimesCell;

  /** The room's recent activity. */
  activity: ActivityCell;

  /** Where the activity's numbering stands. */
  counters: ActivityCountersCell;

  /** Those who joined the room; absent for a room nobody can join. */
  roster?: ParticipantRosterCell;

  /** The viewer's adds' outcomes; absent where they aren't remembered. */
  addRequests?: AddRequestsCell;

  /**
   * Whether the viewer has a manager to start a direct chat with; absent for
   * none.
   */
  startsDirect?: boolean;

  /** The viewer's manager's `openDirect`, when `startsDirect` holds. */
  startDirect?: Stream<StartDirectEvent>;
}

/**
 * What the room's core offers: `ChatRoomOutput`, and the streams its own
 * composers send to, which take the reply they compose from the session's
 * composer state.
 */
export interface FabriChatRoomCoreOutput extends ChatRoomOutput {
  /** The main composer's send, replying to the reply being composed. */
  composerSend: Stream<RoomStreamEvent>;

  /** The thread composer's send, replying in the open thread. */
  threadComposerSend: Stream<RoomStreamEvent>;
}

/**
 * A conversation with a composer that sends as the viewer: the whole of
 * `ChatRoomOutput`, given the viewer's profile.
 */
export const FabriChatRoomCore = pattern<
  FabriChatRoomCoreInput,
  FabriChatRoomCoreOutput
>((input) => {
  const {
    myProfile,
    about,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    roster,
    addRequests,
    startsDirect,
    startDirect,
  } = input;
  const composer = new Writable.perSession<ComposerState>({});
  const kind = computed((): ChatRoomKind => about?.get()?.kind ?? "group");
  const records = {
    kind,
    composer,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
  };
  const alsoToMain = new Writable.perSession(false);
  const windows = new Writable.perSession<WindowsValue>();

  const entries = computed(() => messageEntries(messages));
  const mainEntries = computed(() =>
    entries.filter(isInMain).sort(compareEntries)
  );
  const latest = computed(() => ({
    messages: mainEntries.slice(-FABRICHAT_POLICY.maxWindowCount).map((
      entry,
    ) => entry.cell),
    hasOlder: mainEntries.length > FABRICHAT_POLICY.maxWindowCount,
  }));
  const count = computed(() => entries.length);
  const sortedEntries = computed(() => [...entries].sort(compareEntries));
  const oldestAt = computed(() => sortedEntries[0]?.record.sentAt);
  const newestAt = computed(() =>
    sortedEntries[sortedEntries.length - 1]?.record.sentAt
  );
  // A room the manager created has `about`, and is its space's root; a
  // space's own chat, sharing its space, has none.
  const ownSpace = computed(() => about?.get() !== undefined);
  // The space's participants as its root lists them, for a room that isn't
  // that root. A root room's `#default` is the room itself, so it reads only
  // its own; a space whose root isn't there yet lists none.
  const space = wish<{ participants?: ProfileCell[] }>({ query: "#default" });
  const joined = computed(() =>
    roster === undefined ? [] : participantEntries(roster)
  );
  const listed = computed((): ProfileCell[] =>
    ownSpace ? [...joined] : [...(space.result?.participants ?? []), ...joined]
  );
  const participants = computed(() => participantsOf(listed, entries));
  const join = addParticipant({ roster });
  const canSend = computed(() => canActIn(messages, myProfile));
  const addMember = AddMember({
    room: messages,
    myProfile,
    ownSpace,
    kind,
    requests: addRequests,
  });
  const addOutcomes = computed((): Record<string, AddMemberOutcome> =>
    addRequests?.get() ?? {}
  );
  const cannotSend = computed(() => !canSend);
  // The policy is a document of its own, which `about` links.
  const policy = new Writable.perSpace<ChatRoomPolicy>(FABRICHAT_POLICY);
  const aboutView = {
    kind,
    title: computed(() => about?.get()?.title),
    createdAt: computed(() => about?.get()?.createdAt),
    policy,
    // The stored record itself, as a link, so a reader can read its label.
    record: about,
  };
  const expiredThrough = computed(() =>
    ((counters.elementById(NUMBERING_KEY).get() ??
      NO_ACTIVITY) as ActivityCounters).expiredThrough
  );
  const title = computed(() =>
    about?.get()?.title ?? (kind === "direct" ? "Direct chat" : "Chat")
  );
  const hasThread = computed(() => {
    const root = composer.get()?.thread;
    return root?.get() !== undefined && entryFor(entries, root) !== undefined;
  });
  const replyingTo = computed(() => bodyText(composer.get()?.replyTo?.get()));
  // Per-session and per-viewer parts are hidden by a prop, never built as a
  // different tree (see `FabriChatMessageRow`).
  const replyDisplay = computed(
    (): ChatDisplay => (replyingTo ? "flex" : "none"),
  );
  const threadDisplay = computed(
    (): ChatDisplay => (hasThread ? "flex" : "none"),
  );
  const isEmpty = computed(() => mainEntries.length === 0);
  const threadShownIn = computed((): ShownIn =>
    alsoToMain.get() ? "both" : "thread"
  );

  const sendMessage = commitSend({ myProfile, ...records });
  const composeSend = commitSend({
    myProfile,
    ...records,
    replyFrom: "replyTo",
  });
  const sendThreadReply = commitSend({
    myProfile,
    ...records,
    replyFrom: "thread",
    shownIn: threadShownIn,
  });
  const streams = {
    sendMessage,
    editMessage: commitEdit({
      myProfile,
      ...records,
    }),
    deleteMessage: commitDelete({
      myProfile,
      ...records,
    }),
    obliterateMessage: commitObliterate({
      myProfile,
      ...records,
    }),
    sendReaction: commitSendReaction({
      myProfile,
      ...records,
    }),
    deleteReaction: commitDeleteReaction({
      myProfile,
      ...records,
    }),
  };
  const messageList = {
    count,
    oldestAt,
    newestAt,
    latest,
    windows,
    openWindow: commitWindow({ op: "open", messages, windows }),
    closeWindow: commitWindow({ op: "close", messages, windows }),
  };
  const view = {
    about: aboutView,
    recentActivity: activity,
    recentActivityExpiredThrough: expiredThrough,
    participants,
    addParticipant: join,
    messages: messageList,
    canSend,
    ...streams,
    addMember: addMember.add,
    canAdd: addMember.canAdd,
    addRequests: addOutcomes,
  };
  const closeThread = action(() => composer.key("thread").set(undefined));
  const cancelReply = action(() => composer.key("replyTo").set(undefined));

  return {
    [NAME]: title,
    [UI]: (
      <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "720px" }}>
        <cf-hstack justify="between" align="center" gap="4">
          <cf-heading level={3}>{title}</cf-heading>
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
            <ParticipantChip
              participant={participant}
              myProfile={myProfile}
              startsDirect={startsDirect}
              startDirect={startDirect}
            />
          ))}
        </div>
        {addMember[UI]}

        <cf-vstack
          id="fabrichat-messages"
          gap="3"
          style={{ minHeight: "160px" }}
        >
          {messages.map((message) => (
            <FabriChatMessageRow
              message={message}
              inThread={false}
              myProfile={myProfile}
              kind={kind}
              composer={composer}
              messages={messages}
              reactionLists={reactionLists}
              requests={requests}
              usedTimes={usedTimes}
              activity={activity}
              counters={counters}
            />
          ))}
          {isEmpty
            ? <cf-empty-state message="No messages yet. Say hello!" />
            : null}
        </cf-vstack>

        <cf-hstack
          gap="2"
          align="center"
          hidden
          style={{ display: replyDisplay }}
        >
          <cf-text variant="caption">Replying to: {replyingTo}</cf-text>
          <cf-button size="sm" variant="ghost" onClick={cancelReply}>
            Cancel
          </cf-button>
        </cf-hstack>
        <div
          data-ui-pattern={CHAT_SEND_SURFACE}
          data-ui-event-integrity={CHAT_SEND_SURFACE}
        >
          <cf-submit-input
            data-ui-action={CHAT_SEND_ACTION}
            inputId="fabrichat-message"
            placeholder="Message"
            buttonText="Send"
            disabled={cannotSend}
            onClick={composeSend}
          />
        </div>

        <cf-vstack
          id="fabrichat-thread"
          gap="2"
          hidden
          style={{
            display: threadDisplay,
            borderTop: "1px solid var(--cf-theme-color-border)",
            paddingTop: "0.75rem",
          }}
        >
          <cf-hstack justify="between" align="center">
            <cf-heading level={4}>Thread</cf-heading>
            <cf-button size="sm" variant="ghost" onClick={closeThread}>
              Close
            </cf-button>
          </cf-hstack>
          {messages.map((message) => (
            <FabriChatMessageRow
              message={message}
              inThread
              myProfile={myProfile}
              kind={kind}
              composer={composer}
              messages={messages}
              reactionLists={reactionLists}
              requests={requests}
              usedTimes={usedTimes}
              activity={activity}
              counters={counters}
            />
          ))}
          <cf-checkbox $checked={alsoToMain}>
            Also send to the conversation
          </cf-checkbox>
          <div
            data-ui-pattern={CHAT_SEND_SURFACE}
            data-ui-event-integrity={CHAT_SEND_SURFACE}
          >
            <cf-submit-input
              data-ui-action={CHAT_SEND_ACTION}
              inputId="fabrichat-thread-message"
              placeholder="Reply in thread"
              buttonText="Reply"
              disabled={cannotSend}
              onClick={sendThreadReply}
            />
          </div>
        </cf-vstack>
      </cf-vstack>
    ),
    [VIEWS]: { room: view },
    ...view,
    composerSend: composeSend,
    threadComposerSend: sendThreadReply,
  };
});

/**
 * What a room stores. Each record but `about` has a default, so a space's own
 * chat starts with none of them.
 */
export interface FabriChatRoomInput {
  /**
   * What the room says about itself, written once by the manager that creates
   * it. A space's own chat has none, and reads as a group room with no title.
   */
  about?: StoredAbout;

  /** The room's messages. */
  messages?: MessagesCell;

  /** Every message's reaction list. */
  reactionLists?: ReactionListsCell;

  /** The requests the room has acted on. */
  requests?: RequestsCell;

  /** The times the room has recorded something at. */
  usedTimes?: UsedTimesCell;

  /** The room's recent activity. */
  activity?: ActivityCell;

  /** Where the activity's numbering stands. */
  counters?: ActivityCountersCell;

  /**
   * Those who joined the room. It changes only through `addParticipant`, the
   * one writer its write contract admits.
   */
  participants?: ParticipantRosterCell;
}

/**
 * A FabriChat room whose viewer is the person looking at it: the
 * `ChatRoomOutput` its space's members share. A viewer with no profile can
 * read the conversation, and is offered the form that creates one.
 */
const FabriChatRoom = pattern<FabriChatRoomInput, ChatRoomOutput>(
  ({
    about,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    participants,
    // The room itself, the link another member's manager lists it by.
    [SELF]: self,
  }) => {
    const profileWish = wish<ChatProfile>({ query: "#profile" });
    // The viewer's adds' outcomes, which follow them, and only them, across
    // sessions.
    const addRequests = new Writable.perUser<
      Record<string, AddMemberOutcome>
    >({});
    // The viewer's manager, which starts a direct chat with a participant,
    // and lists this room when asked to.
    const managerWish = wish<{
      openDirect: Stream<StartDirectEvent>;
      accept: Stream<AcceptRoomEvent>;
      sharedSpaceCatalog: SharedSpaceCatalogStorage;
    }>({ query: "#chatManager" });
    const startsDirect = computed(() => managerWish.result !== undefined);
    // Hidden by a prop rather than a branch, and `hidden` until the prop has a
    // value, as `FabriChatMessageRow` says.
    const setupDisplay = computed((): ChatDisplay =>
      profileWish.result === undefined ? "block" : "none"
    );
    const room = FabriChatRoomCore(
      {
        myProfile: profileWish.result,
        about,
        messages,
        reactionLists,
        requests,
        usedTimes,
        activity,
        counters,
        roster: participants,
        addRequests,
        startsDirect,
        startDirect: managerWish.result?.openDirect,
      },
    );

    return {
      [NAME]: room[NAME],
      [VIEWS]: room[VIEWS],
      about: room.about,
      recentActivity: room.recentActivity,
      recentActivityExpiredThrough: room.recentActivityExpiredThrough,
      participants: room.participants,
      addParticipant: room.addParticipant,
      messages: room.messages,
      canSend: room.canSend,
      sendMessage: room.sendMessage,
      editMessage: room.editMessage,
      deleteMessage: room.deleteMessage,
      obliterateMessage: room.obliterateMessage,
      sendReaction: room.sendReaction,
      deleteReaction: room.deleteReaction,
      addMember: room.addMember,
      canAdd: room.canAdd,
      addRequests: room.addRequests,
      [UI]: (
        <cf-screen>
          <AddToChats
            room={self}
            catalog={managerWish.result?.sharedSpaceCatalog}
            accept={managerWish.result?.accept}
          />
          {room[UI]}
          <div
            id="fabrichat-profile-setup"
            hidden
            style={{
              display: setupDisplay,
              padding: "0 1rem 1rem",
              maxWidth: "720px",
            }}
          >
            {profileWish[UI]}
          </div>
        </cf-screen>
      ),
    };
  },
);

export default FabriChatRoom;
