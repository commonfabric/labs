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
  type SpaceAccessLevel,
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
  type ParticipantRosterCell,
  rosterProfiles,
} from "../loom/participants.tsx";
import { isInMain, type ShownIn, viewPlaces } from "./logic.ts";
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
  commitSetTitle,
  commitWindow,
  compareEntries,
  type ComposerState,
  entryFor,
  FABRICHAT_POLICY,
  isOwnerOf,
  type JoinRoomRequest,
  type MessageCell,
  messageEntries,
  type MessageEntry,
  type MessageRights,
  messageRightsOf,
  type MessagesCell,
  NO_ACTIVITY,
  NO_MESSAGE_RIGHTS,
  NUMBERING_KEY,
  ownersMayObliterateBy,
  ownersMayObliterateIn,
  type ReactionListsCell,
  type RequestsCell,
  type RoomStreamEvent,
  type RoomWindowEvent,
  type SetTitleEvent,
  type StoredAbout,
  tellManagerJoined,
  TITLE_KEY,
  type TitlesCell,
  type UsedTimesCell,
  type WindowsCell,
  type WindowsValue,
} from "./room-records.tsx";
import { bodyText, FabriChatMessageRow } from "./message-row.tsx";
import {
  type AboutRecord,
  type AddMemberDelivery,
  addMemberOfferId,
  type AddMemberOutcome,
  type AddMemberRefusalCode,
  CHAT_ADD_MEMBER_ACTION,
  CHAT_ADD_MEMBER_SURFACE,
  CHAT_RETITLE_ACTION,
  CHAT_RETITLE_SURFACE,
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatContainer,
  type ChatDisplay,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomAbout,
  type ChatRoomActivity,
  type ChatRoomKind,
  type ChatRoomLink,
  type ChatRoomPolicy,
  epochNsec,
  isPrincipalDID,
  type MessageActOutcome,
  type ProfileCell,
  type SetTitleOutcome,
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

/** A participant, with the principal their profile attests. */
export interface ParticipantEntry {
  /** The participant's profile. */
  profile: ProfileCell;

  /**
   * The principal the profile's `represents-principal` label attests; absent
   * when it attests none, or when the label can't be read where the entry is
   * derived.
   */
  principal?: string;
}

/**
 * One entry for each of `participants`, in their order, each with the
 * principal its profile attests where that can be read.
 */
export const participantEntriesOf = (
  participants: readonly ProfileCell[],
): ParticipantEntry[] =>
  participants.map((profile) => ({
    profile,
    principal: principalOf(profile, "represents-principal"),
  }));

/** The principals `entries` attest, each once, in the order of `entries`. */
export const principalsOf = (
  entries: readonly ParticipantEntry[],
): string[] =>
  entries.reduce<string[]>(
    (found, { principal }) =>
      principal === undefined || found.includes(principal)
        ? found
        : [...found, principal],
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
  /** The chat control, naming the other person by their profile. */
  readonly target?: {
    /** The other person's profile, bound as the control's `name`. */
    // `Cell<…>` is written out rather than reached through an alias: the
    // event's schema marks a reference position only where the wrapper is
    // written in the event type.
    readonly name?: Cell<ChatProfile>;
  };
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
 * has a manager. It names the participant to the manager by their profile,
 * bound as the control's `name`, which crosses into the click's event as the
 * profile's own cell; the manager reads whom it names from the profile's
 * `represents-principal` label, and offers the room through the share inbox
 * the profile points at.
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
            $name={participant}
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

/**
 * What adding a member asks of a room: the person to admit, by their chat
 * address, by their profile, or by both.
 */
export interface AddMemberEvent {
  /**
   * Chosen by the sender, and unique among its adds. The outcome is recorded
   * under it, and sending the same event again with it changes nothing. A
   * rendered control's click carries none, and is given one of its own.
   */
  readonly requestId?: string;

  /**
   * The new member's profile, whose `represents-principal` label names them,
   * through whose share inbox the viewer's manager offers them the room.
   */
  // `Cell<…>` is written out rather than reached through an alias: the
  // event's schema marks a reference position only where the wrapper is
  // written in the event type.
  readonly profile?: Cell<ChatProfile>;

  /** The control, holding the new member's chat address. */
  readonly target?: { readonly value?: string };
}

/**
 * What a room asks of its viewer's manager when the viewer adds someone: the
 * event of the manager's `offerRoom`.
 */
export interface OfferRoomRequest {
  /**
   * Keys the request among the manager's, as `addMemberOfferId()` composes it
   * from the room's space and the add's own `requestId`.
   */
  requestId: string;

  /** The room. */
  // `Cell<…>` is written out rather than reached through an alias: the
  // event's schema marks a reference position only where the wrapper is
  // written in the event type.
  room: Cell<ChatRoomLink>;

  /** The new member's DID. */
  member: string;

  /** The new member's profile, when the add named one. */
  // `Cell<…>` is written out rather than reached through an alias, as for
  // `room`.
  profile?: Cell<ChatProfile>;
}

/**
 * The part of the viewer's manager a room reaches: what it tells a member it
 * admits through, and what it tells of the viewer joining it.
 */
export interface RoomManager {
  /** Offers the room to a member, and records how it told them. */
  offerRoom: Stream<OfferRoomRequest>;

  /** The outcome of each of the manager's requests, by its `requestId`. */
  requests: Record<string, ChatRequestOutcome>;

  /**
   * The people the viewer's rooms list, other than the viewer: by principal,
   * the profiles attesting it.
   */
  people: PerSession<Record<string, ProfileCell[]>>;

  /** Makes a room the viewer has joined one of their chats. */
  joinRoom?: Stream<JoinRoomRequest>;
}

/** Each of the viewer's adds' outcomes, by its `requestId`. */
export type AddRequestsCell = Writable<
  Record<string, AddMemberOutcome> | Default<Record<PropertyKey, never>>
>;

/**
 * `outcomes`, where each add that is done with no `delivery` of its own takes
 * the one the viewer's manager decided for it, which `requests` records under
 * `addMemberOfferId()`: its `delivery`, or, where the manager refused to tell
 * the member, `access-only`, with the manager's reason as
 * `deliveryRefusal`. An add whose verdict hasn't landed keeps none.
 */
export const withDeliveries = (
  outcomes: Readonly<Record<string, AddMemberOutcome>>,
  space: string | undefined,
  requests: Readonly<Record<string, ChatRequestOutcome>> | undefined,
): Record<string, AddMemberOutcome> =>
  Object.fromEntries(
    Object.entries(outcomes).map(([id, outcome]) => {
      if (
        outcome?.status !== "done" || outcome.delivery !== undefined ||
        space === undefined
      ) {
        return [id, outcome];
      }
      const verdict = requests?.[addMemberOfferId(space, id)];
      if (verdict?.status === "refused") {
        return [id, {
          ...outcome,
          delivery: "access-only",
          deliveryRefusal: verdict.reason,
        }];
      }
      const delivery = verdict?.status === "done"
        ? verdict.delivery
        : undefined;
      return [id, delivery === undefined ? outcome : { ...outcome, delivery }];
    }),
  );

/** What the session's latest add came to, which the control shows. */
interface LatestAdd {
  /** The add's `requestId`. */
  requestId: string;

  /** Whom it admitted, when it did. */
  member?: string;

  /** How they were told of the room, where the add itself decided it. */
  delivery?: AddMemberDelivery;

  /** Why it was refused, when it was. */
  refusal?: string;
}

/**
 * What an add asks of the viewer's manager once it has admitted someone: the
 * event of `offerAddedMember`.
 */
interface AddedMemberEvent {
  /** The add's `requestId`. */
  requestId: string;

  /** The DID of the person the add admitted. */
  member: string;

  /** The person's profile, when the add named one. */
  // `Cell<…>` is written out rather than reached through an alias: the
  // event's schema marks a reference position only where the wrapper is
  // written in the event type.
  profile?: Cell<ChatProfile>;
}

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
  latest: Writable<LatestAdd | undefined>;

  /**
   * Has the viewer's manager tell the person admitted of the room, as
   * `offerAddedMember` does, in an event of its own. The add's own
   * transaction reads nothing of the manager, which can carry a label the
   * room's space doesn't admit.
   */
  offer: Stream<AddedMemberEvent>;

  /**
   * A rendered picker's person, by their profile, which an event's own
   * outranks.
   */
  picked?: Cell<ChatProfile>;
}

/** What `offerAddedMember` is bound to. */
interface OfferAddedMemberState {
  /** One of the room's records, which names the room's space. */
  room: MessagesCell;

  /** The viewer's adds' outcomes; absent where they aren't remembered. */
  requests?: AddRequestsCell;

  /** What the session's latest add came to, which the control shows. */
  latest: Writable<LatestAdd | undefined>;

  /**
   * The room itself, as the viewer's manager links it; absent for a core used
   * on its own, which can't name itself to a manager.
   */
  self?: Cell<ChatRoomLink>;

  /**
   * Whether the room can ask the viewer's manager to tell someone of it: the
   * viewer has a manager that has resolved, with an `offerRoom`, and the room
   * has `self` to name itself by.
   */
  canOffer: boolean;

  /** The viewer's manager's `offerRoom`, when `canOffer` holds. */
  offerRoom?: Stream<OfferRoomRequest>;
}

/**
 * Has the viewer's manager offer the room to the person an add admitted, and
 * decide how they were told, which it records and the room's `addRequests`
 * then reads. With no manager to ask, because the viewer has none or theirs
 * hasn't resolved, it records that the person was told nothing.
 */
const offerAddedMember = handler<AddedMemberEvent, OfferAddedMemberState>(
  (event, state) => {
    const { requestId, member, profile } = event;
    const space = spaceOf(state.room);
    // `offerRoom` is read only once `canOffer` holds, since reading it reads
    // the manager.
    if (
      state.canOffer && state.self !== undefined && space !== undefined
    ) {
      state.offerRoom?.send({
        requestId: addMemberOfferId(space, requestId),
        room: state.self,
        member,
        ...(profile === undefined ? {} : { profile }),
      });
      return;
    }
    state.requests?.key(requestId).set({
      status: "done",
      delivery: "access-only",
    });
    if (state.latest.get()?.requestId === requestId) {
      state.latest.set({ requestId, member, delivery: "access-only" });
    }
  },
);

/**
 * Admits a person to the room's space, with OWNER, so that they too may add
 * others, from a trusted gesture on `ChatAddMemberSurface`, and has the
 * viewer's manager tell them of the room. Only an OWNER of the space may admit
 * someone, only to a group room, and the session is shown what came of it.
 *
 * The person is named by chat address, or by a profile whose label names them,
 * or by both, which then have to agree. Once they are admitted and the add is
 * recorded, `offer` has the viewer's manager offer them the room through the
 * profile's share inbox, or, given only their address, through the profiles
 * its people list for them, and decide how they were told.
 */
const commitAddMember = handler<AddMemberEvent, AddMemberState>(
  (
    event,
    {
      room,
      ownSpace,
      kind,
      requests,
      latest,
      offer,
      picked,
    },
  ) => {
    const requestId = event?.requestId ?? eventKey();
    if (requests?.key(requestId).get() !== undefined) return;
    const refuse = (reason: string, code?: AddMemberRefusalCode): void => {
      requests?.key(requestId).set({
        status: "refused",
        reason,
        ...(code === undefined ? {} : { code }),
      });
      latest.set({ requestId, refusal: reason });
    };
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
    // A profile names the person its `represents-principal` label attests, so
    // one attesting no one names no one.
    const profile = event?.profile ?? picked;
    const attested = profile === undefined
      ? undefined
      : principalOf(profile, "represents-principal");
    if (profile !== undefined && !isPrincipalDID(attested)) {
      refuse("That profile doesn't say whose it is.");
      return;
    }
    const typed = event?.target?.value?.trim() ?? "";
    const member = typed === "" ? attested ?? "" : typed;
    if (!isPrincipalDID(member)) {
      refuse("That isn't a chat address.");
      return;
    }
    if (attested !== undefined && attested !== member) {
      refuse("That profile isn't theirs.");
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
    requests?.key(requestId).set({ status: "done" });
    latest.set({ requestId, member });
    offer.send({
      requestId,
      member,
      ...(profile === undefined ? {} : { profile }),
    });
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

  /**
   * The room itself, as the viewer's manager links it; absent for a core used
   * on its own, which can't name itself to a manager.
   */
  self?: Cell<ChatRoomLink>;

  /**
   * The viewer's manager; absent while the viewer has none, or theirs hasn't
   * resolved.
   */
  manager?: RoomManager;

  /** The principals of those already in the room, whom the picker leaves out. */
  present: PerSession<string[]>;
}

/** What the control adding a member to a room provides. */
export interface AddMemberOutput {
  /**
   * The control, shown only to an OWNER of a group room in a space of its own
   * whose profile has resolved, as the room's other controls are.
   */
  [UI]: VNode;

  /** Admits the person the event names, from a trusted gesture. */
  add: Stream<AddMemberEvent>;

  /**
   * The outcome of each of the viewer's adds, with how the person was told of
   * the room once that is decided.
   */
  outcomes: Record<string, AddMemberOutcome>;

  /**
   * Whether the viewer can add someone: an OWNER of a group room in a space of
   * its own.
   */
  canAdd: boolean;
}

/**
 * Offers an OWNER of a group room's space a way to admit someone else to it,
 * by their chat address, or by picking them from the people the viewer's
 * manager lists who aren't in the room yet.
 */
export const AddMember = pattern<AddMemberInput, AddMemberOutput>(
  (
    {
      room,
      myProfile,
      ownSpace,
      kind,
      requests,
      self,
      manager,
      present,
    },
  ) => {
    const latest = new Writable.perSession<LatestAdd | undefined>(undefined);
    // Read as values: a handler bound to a manager that isn't there is bound
    // to a stream that still reads as present, whose sends are dropped.
    const canOffer = computed(() =>
      manager?.offerRoom !== undefined && self !== undefined
    );
    const offer = offerAddedMember({
      room,
      requests,
      latest,
      self,
      canOffer,
      offerRoom: manager?.offerRoom,
    });
    const bindings = { room, ownSpace, kind, requests, latest, offer };
    const add = commitAddMember(bindings);
    const canAdd = computed(() =>
      ownSpace && kind !== "direct" && spaceAccess(room) === "OWNER"
    );
    // Who may add differs by viewer, and what came of an add by session, so
    // both are hidden by a prop rather than built as a different tree (see
    // `FabriChatMessageRow`).
    const addDisplay = computed((): ChatDisplay =>
      canAdd && myProfile?.get() !== undefined ? "flex" : "none"
    );
    const outcomes = computed((): Record<string, AddMemberOutcome> =>
      withDeliveries(requests?.get() ?? {}, spaceOf(room), manager?.requests)
    );
    // What the session's latest add came to: how the person was told of the
    // room, once that is decided, and what to do where they weren't.
    const shown = computed((): string => {
      const add = latest.get();
      if (add === undefined) return "";
      if (add.refusal !== undefined) return add.refusal;
      const recorded = outcomes[add.requestId];
      const done = recorded?.status === "done" ? recorded : undefined;
      const delivery = done?.delivery ?? add.delivery;
      return delivery === undefined
        ? `Added ${add.member}.`
        : delivery === "offered"
        ? `Added ${add.member}, and offered them this chat.`
        : delivery === "noticed"
        ? `Added ${add.member}. Your chats remind you to send them this chat's link.`
        : done?.deliveryRefusal !== undefined
        ? `Added ${add.member}, who couldn't be told of this chat: ${done.deliveryRefusal} Send them its link.`
        : `Added ${add.member}. Send them this chat's link.`;
    });
    const outcomeDisplay = computed((): ChatDisplay =>
      shown === "" ? "none" : "block"
    );
    // Each person the manager lists who isn't in the room, by the first
    // profile attesting them, per session, as the manager's people are.
    const candidates = computed((): PerSession<ProfileCell[]> =>
      Object.entries(manager?.people ?? {}).flatMap(
        ([principal, profiles]): ProfileCell[] =>
          present.includes(principal) || profiles[0] === undefined
            ? []
            : [profiles[0]],
      )
    );
    const candidatesDisplay = computed((): ChatDisplay =>
      candidates.length === 0 ? "none" : "block"
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
            id="fabrichat-add-member-people"
            hidden
            style={{ display: candidatesDisplay }}
          >
            <cf-vstack gap="1">
              <cf-text variant="caption">
                Or add people from your chats:
              </cf-text>
              {candidates.map((profile) => (
                <cf-hstack
                  gap="2"
                  align="center"
                  data-ui-pattern={CHAT_ADD_MEMBER_SURFACE}
                  data-ui-event-integrity={CHAT_ADD_MEMBER_SURFACE}
                >
                  <cf-profile-badge variant="chip" $profile={profile} />
                  <cf-button
                    data-ui-action={CHAT_ADD_MEMBER_ACTION}
                    size="sm"
                    variant="ghost"
                    onClick={commitAddMember({ ...bindings, picked: profile })}
                  >
                    Add
                  </cf-button>
                </cf-hstack>
              ))}
            </cf-vstack>
          </div>
          <div
            id="fabrichat-add-member-outcome"
            hidden
            style={{ display: outcomeDisplay }}
          >
            <cf-text variant="caption">{shown}</cf-text>
          </div>
        </cf-vstack>
      ),
      add,
      outcomes,
      canAdd,
    };
  },
);

/**
 * A thread, as the main conversation shows it beside its root: how many
 * replies it holds, and when the newest was sent. A deleted or obliterated
 * reply stays in its thread, so it is counted, and its `sentAt` can be the
 * newest.
 */
export interface ChatThreadSummary {
  /** The thread's root, a message the main conversation shows. */
  root: MessageCell;

  /** How many messages the thread holds besides its root; never 0. */
  replyCount: number;

  /** The newest `sentAt` among those messages. */
  latestReplyAt: FabricEpochNsec;
}

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

  /**
   * Every thread in the room that holds a reply, oldest root first. A message
   * of the main conversation that roots none has no entry.
   */
  threads: ChatThreadSummary[];

  /** This session's open windows, by the `windowId` its client chose. */
  windows: PerSession<WindowsCell>;

  /** Opens a window, or moves one already open. */
  openWindow: Stream<RoomWindowEvent>;

  /** Closes a window. */
  closeWindow: Stream<RoomWindowEvent>;
}

/** Who is reading a room. */
export interface ChatRoomViewer {
  /**
   * The reader's profile, as a link to the profile itself, which is the form
   * a message's `authorProfile` takes; absent until it resolves.
   */
  profile?: ProfileCell;

  /**
   * The principal the reader's profile's `represents-principal` label attests;
   * absent when it attests none, or the label can't be read.
   */
  principal?: string;

  /**
   * The reader's access to the room's space, as its access list grants it;
   * absent while that isn't known.
   */
  role?: SpaceAccessLevel;
}

/**
 * The reader's profile, as a link to the profile itself, which `myProfile`
 * may reach only through another link; `undefined` while it holds no value.
 */
const viewerProfileOf = (
  myProfile: ProfileCell | undefined,
): ProfileCell | undefined =>
  myProfile?.get() === undefined ? undefined : myProfile.resolveAsCell();

/** What a room's reader may do to one of its messages. */
export interface ChatMessageRights extends MessageRights {
  /** The message, as `messages.latest` links it. */
  message: MessageCell;
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
   * Those who joined the room itself, each added once through
   * `addParticipant`, in the order they were added. Unlike `participants`, it
   * lists no author it doesn't hold, and no participant of another space, so
   * it is read from the roster alone. Like `participants`, it is a claim, not
   * proof of access.
   */
  roster: ProfileCell[];

  /**
   * One entry for each of `participants`, in their order: the profile, and the
   * principal its `represents-principal` label attests, absent where it
   * attests none or the label can't be read where the list is derived. Like
   * `participants`, it is not proof of access.
   */
  participantEntries: PerSession<ParticipantEntry[]>;

  /**
   * The principals `participantEntries` holds, each once, in the order of
   * `participants`.
   */
  participantPrincipals: PerSession<string[]>;

  /**
   * Adds a profile to those who joined the room, once. Any participant may add
   * any profile, so an entry is a claim: it does not say that the profile's
   * principal holds access to the room's space.
   */
  addParticipant: Stream<JoinRoomEvent>;

  /** The room's messages. */
  messages: ChatMessageList;

  /**
   * The message list's `openWindow`, here as well for a client that sends only
   * to a view's own streams, as it reads a thread through a window.
   */
  openWindow: Stream<RoomWindowEvent>;

  /** The message list's `closeWindow`, here as well, as `openWindow` is. */
  closeWindow: Stream<RoomWindowEvent>;

  /** Whether this reader can send, edit, delete, and react. */
  canSend: boolean;

  /** Who is reading the room: their profile, its principal, and their access. */
  viewer: ChatRoomViewer;

  /**
   * What this reader may do to each of the room's messages, oldest first.
   * Nothing at all while `canSend` doesn't hold.
   */
  messageRights: ChatMessageRights[];

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
   * through the sanctioned issuing path, and has the viewer's manager tell
   * them of the room. Only an OWNER of a group room in a space of its own may
   * admit someone.
   */
  addMember: Stream<AddMemberEvent>;

  /**
   * Whether this reader can add someone: an OWNER of a group room in a space
   * of its own.
   */
  canAdd: boolean;

  /**
   * The outcome of each of this reader's adds, by its `requestId`, with how
   * the member was told of the room once that is decided.
   */
  addRequests: Record<string, AddMemberOutcome>;

  /**
   * The outcome of each of this reader's message acts, by its `requestId`:
   * sends, edits, deletions, obliterations, and reactions added or removed.
   */
  messageRequests: Record<string, MessageActOutcome>;

  /**
   * Sets the room's title, which every member shares, from a trusted gesture
   * on the rendering's `ChatRetitleSurface`, or from a client's own control
   * through the sanctioned issuing path. Any member who can write in the room
   * may, in a group room or a direct one.
   */
  setTitle: Stream<SetTitleEvent>;

  /** The outcome of each of this reader's retitles, by its `requestId`. */
  titleRequests: Record<string, SetTitleOutcome>;
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
  /** The space's root, which may explicitly declare this conversation. */
  container?: Cell<ChatContainer>;

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

  /**
   * The room's title as a member last set it; absent for a room whose title
   * no member sets.
   */
  titles?: TitlesCell;

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

  /**
   * The room itself, as the viewer's manager links it; absent, the room can't
   * name itself to a manager, and an add tells the person added nothing.
   */
  self?: Cell<ChatRoomLink>;

  /**
   * The viewer's manager, which tells someone they add of the room; absent
   * while the viewer has none, or theirs hasn't resolved.
   */
  manager?: RoomManager;

  /**
   * Whether the room's policy lets an OWNER of its space obliterate its
   * messages, which picks the policy `about.policy` links; absent, as for
   * every room the room's own pattern runs, yes for a group room and no for a
   * direct room.
   */
  ownersMayObliterate?: boolean;
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
    container,
    about,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    titles,
    roster,
    addRequests,
    startsDirect,
    startDirect,
    self,
    manager,
    ownersMayObliterate: ownersMayObliterateGiven,
  } = input;
  const composer = new Writable.perSession<ComposerState>({});
  const kind = computed((): ChatRoomKind => about?.get()?.kind ?? "group");
  // A room the manager created has `about`, and is its space's root; a
  // space's own chat, sharing its space, has none.
  const ownSpace = computed(() => about?.get() !== undefined);
  // The room's policy, a document of its own that `about` links, and which
  // the message acts read: one for each answer to whether OWNERs may
  // obliterate, since the rest of a room's policy is the same.
  const policyWithOwners = new Writable.perSpace<ChatRoomPolicy>({
    ...FABRICHAT_POLICY,
    ownersMayObliterate: true,
  });
  const policyWithoutOwners = new Writable.perSpace<ChatRoomPolicy>({
    ...FABRICHAT_POLICY,
    ownersMayObliterate: false,
  });
  const policy = computed((): Cell<ChatRoomPolicy> =>
    ownersMayObliterateIn(kind, ownersMayObliterateGiven)
      ? policyWithOwners
      : policyWithoutOwners
  );
  // Read as a value, as `canOffer` is: a handler bound to a manager that
  // isn't there is bound to a stream that still reads as present.
  const canJoin = computed(() =>
    (ownSpace || (container?.key("chatRoom").get() !== undefined &&
      equals(container?.key("chatRoom").get(), self))) &&
    manager?.joinRoom !== undefined && self !== undefined
  );
  // The sender's outcomes, which follow them, and only them, across sessions,
  // and why the session's latest act was refused, which the composer shows.
  const messageRequests = new Writable.perUser<
    Record<string, MessageActOutcome>
  >({});
  const refusal = new Writable.perSession<string>("");
  const records = {
    kind,
    policy,
    composer,
    outcomes: messageRequests,
    refusal,
    messages,
    reactionLists,
    requests,
    usedTimes,
    activity,
    counters,
    joined: tellManagerJoined({
      canJoin,
      container: ownSpace ? undefined : container,
      joinRoom: manager?.joinRoom,
      self,
    }),
  };
  const alsoToMain = new Writable.perSession(false);
  const windows = new Writable.perSession<WindowsValue>();

  const entries = computed(() => messageEntries(messages));
  // Every message's place in the views, derived once for the whole list. Each
  // row reads its own message's entry, so no row scans the list, and a change
  // to one message re-runs only the rows whose entries changed.
  const places = computed(() =>
    viewPlaces(
      entries.map(({ key, sentAt, replyTo }) => ({ key, sentAt, replyTo })),
    )
  );
  const mainEntries = computed(() =>
    entries.filter(isInMain).sort(compareEntries)
  );
  const latest = computed(() => ({
    messages: mainEntries.slice(-FABRICHAT_POLICY.maxWindowCount).map((
      entry,
    ) => entry.cell),
    hasOlder: mainEntries.length > FABRICHAT_POLICY.maxWindowCount,
  }));
  // A thread's root is always in the main conversation, so its entries, in
  // order, name every root.
  const threads = computed((): ChatThreadSummary[] =>
    mainEntries.flatMap((entry) => {
      const place = places[entry.key];
      return place?.latestReplyAt === undefined ? [] : [{
        root: entry.cell,
        replyCount: place.replies,
        latestReplyAt: epochNsec(place.latestReplyAt),
      }];
    })
  );
  const count = computed(() => entries.length);
  const sortedEntries = computed(() => [...entries].sort(compareEntries));
  const oldestAt = computed(() => sortedEntries[0]?.record.sentAt);
  const newestAt = computed(() =>
    sortedEntries[sortedEntries.length - 1]?.record.sentAt
  );
  // The space's participants as its root lists them, for a room that isn't
  // that root. A root room's `#default` is the room itself, so it reads only
  // its own; a space whose root isn't there yet lists none.
  const space = wish<{ participants?: ProfileCell[] }>({ query: "#default" });
  const joined = computed(() =>
    roster === undefined ? [] : rosterProfiles(roster)
  );
  const listed = computed((): ProfileCell[] =>
    ownSpace ? [...joined] : [...(space.result?.participants ?? []), ...joined]
  );
  const participants = computed(() => participantsOf(listed, entries));
  // A profile lives in its owner's own space, and attests no one to a reader
  // that space refuses, so the entries, and the principals taken from them,
  // are derived per session: one instance for every reader is one their
  // runtimes hold differently.
  const participantEntries = computed((): PerSession<ParticipantEntry[]> =>
    participantEntriesOf(participants)
  );
  const participantPrincipals = computed((): PerSession<string[]> =>
    principalsOf(participantEntries)
  );
  const join = addParticipant({ roster });
  const canSend = computed(() => canActIn(messages, myProfile));
  const addMember = AddMember({
    room: messages,
    myProfile,
    ownSpace,
    kind,
    requests: addRequests,
    self,
    manager,
    present: participantPrincipals,
  });
  const cannotSend = computed(() => !canSend);
  const isOwner = computed(() => isOwnerOf(messages));
  const viewer = computed((): ChatRoomViewer => {
    const profile = viewerProfileOf(myProfile);
    const principal = profile === undefined
      ? undefined
      : principalOf(profile, "represents-principal");
    const role = spaceAccess(messages);
    return {
      ...(profile === undefined ? {} : { profile }),
      ...(principal === undefined ? {} : { principal }),
      ...(role === undefined ? {} : { role }),
    };
  });
  // Every message's rights for the reader, by the rule the handlers admit an
  // act by, derived once for the whole list as `places` is.
  const messageRights = computed((): ChatMessageRights[] => {
    const profile = viewerProfileOf(myProfile);
    return sortedEntries.map((entry) => ({
      message: entry.cell,
      ...(canSend && profile !== undefined
        ? messageRightsOf(
          entry.record,
          profile,
          kind,
          isOwner,
          ownersMayObliterateBy(policy),
        )
        : NO_MESSAGE_RIGHTS),
    }));
  });
  // The title a member last set outranks the one the room was created with.
  const title = computed((): string | undefined =>
    titles?.elementById(TITLE_KEY).get()?.title ?? about?.get()?.title
  );
  const aboutView = {
    kind,
    title,
    createdAt: computed(() => about?.get()?.createdAt),
    policy,
    // The stored record itself, as a link, so a reader can read its label.
    record: about,
  };
  const expiredThrough = computed(() =>
    ((counters.elementById(NUMBERING_KEY).get() ??
      NO_ACTIVITY) as ActivityCounters).expiredThrough
  );
  const name = computed(() =>
    title ?? (kind === "direct" ? "Direct chat" : "Chat")
  );
  // The sender's retitles' outcomes, which follow them, and only them, across
  // sessions, and why the session's latest was refused, which the rendered
  // control shows.
  const titleRequests = new Writable.perUser<
    Record<string, SetTitleOutcome>
  >({});
  const titleRefusal = new Writable.perSession<string>("");
  const setTitle = commitSetTitle({
    titles,
    ownSpace,
    messages,
    outcomes: titleRequests,
    refusal: titleRefusal,
  });
  // Who may retitle differs by viewer, and what came of a retitle by session,
  // so both are hidden by a prop rather than built as a different tree (see
  // `FabriChatMessageRow`).
  const retitleDisplay = computed((): ChatDisplay =>
    ownSpace && titles !== undefined && canSend ? "flex" : "none"
  );
  const titleRefusalDisplay = computed((): ChatDisplay =>
    titleRefusal.get() === "" ? "none" : "block"
  );
  // The key of the session's open thread's root; `""` while no thread is
  // open.
  const openThreadKey = computed(() => {
    const root = composer.get()?.thread;
    return (root?.get() === undefined ? undefined : entryFor(entries, root))
      ?.key ?? "";
  });
  const hasThread = computed(() => openThreadKey !== "");
  // The session's open thread: its root, and every message in the thread the
  // root starts, in the order the room recorded them. The thread's list maps
  // it, so a session holds a thread row for each message of the thread it has
  // open, and none while it has no thread open. The list is the session's
  // own, as the open thread is, and the rows mapped from it are stored per
  // session with it, so no viewer's rows replace another's.
  const threadMessages = computed((): PerSession<MessageCell[]> =>
    openThreadKey === ""
      ? []
      : entries.filter((entry) =>
        entry.key === openThreadKey ||
        places[entry.key]?.thread === openThreadKey
      ).map((entry) => entry.cell)
  );
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
  // Per session, so hidden by a prop rather than a branch (see
  // `FabriChatMessageRow`).
  const refusalDisplay = computed((): ChatDisplay =>
    refusal.get() === "" ? "none" : "block"
  );
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
  const openWindow = commitWindow({ op: "open", messages, windows });
  const closeWindow = commitWindow({ op: "close", messages, windows });
  const messageList = {
    count,
    oldestAt,
    newestAt,
    latest,
    threads,
    windows,
    openWindow,
    closeWindow,
  };
  const view = {
    about: aboutView,
    recentActivity: activity,
    recentActivityExpiredThrough: expiredThrough,
    participants,
    roster: joined,
    participantEntries,
    participantPrincipals,
    addParticipant: join,
    messages: messageList,
    openWindow,
    closeWindow,
    canSend,
    viewer,
    messageRights,
    ...streams,
    addMember: addMember.add,
    canAdd: addMember.canAdd,
    addRequests: addMember.outcomes,
    messageRequests,
    setTitle,
    titleRequests,
  };
  const closeThread = action(() => composer.key("thread").set(undefined));
  const cancelReply = action(() => composer.key("replyTo").set(undefined));

  return {
    [NAME]: name,
    [UI]: (
      <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "720px" }}>
        <cf-hstack justify="between" align="center" gap="4">
          <cf-heading level={3}>{name}</cf-heading>
          <cf-profile-badge $profile={myProfile} size="sm" />
        </cf-hstack>
        <cf-vstack
          id="fabrichat-retitle"
          gap="1"
          hidden
          style={{ display: retitleDisplay }}
        >
          <div
            data-ui-pattern={CHAT_RETITLE_SURFACE}
            data-ui-event-integrity={CHAT_RETITLE_SURFACE}
          >
            <cf-submit-input
              data-ui-action={CHAT_RETITLE_ACTION}
              inputId="fabrichat-title"
              placeholder="New title"
              buttonText="Rename"
              onClick={setTitle}
            />
          </div>
          <cf-text
            id="fabrichat-retitle-refusal"
            variant="caption"
            hidden
            style={{ display: titleRefusalDisplay }}
          >
            {titleRefusal}
          </cf-text>
        </cf-vstack>

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
              places={places}
              cannotWrite={cannotSend}
              isOwner={isOwner}
              policy={policy}
              messages={messages}
              reactionLists={reactionLists}
              requests={requests}
              usedTimes={usedTimes}
              activity={activity}
              counters={counters}
              outcomes={messageRequests}
              refusal={refusal}
              canJoin={canJoin}
              container={ownSpace ? undefined : container}
              joinRoom={manager?.joinRoom}
              self={self}
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
        <cf-text
          id="fabrichat-act-refusal"
          variant="caption"
          hidden
          style={{ display: refusalDisplay }}
        >
          {refusal}
        </cf-text>

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
          {threadMessages.map((message) => (
            <FabriChatMessageRow
              message={message}
              inThread
              myProfile={myProfile}
              kind={kind}
              composer={composer}
              places={places}
              cannotWrite={cannotSend}
              isOwner={isOwner}
              policy={policy}
              messages={messages}
              reactionLists={reactionLists}
              requests={requests}
              usedTimes={usedTimes}
              activity={activity}
              counters={counters}
              outcomes={messageRequests}
              refusal={refusal}
              canJoin={canJoin}
              container={ownSpace ? undefined : container}
              joinRoom={manager?.joinRoom}
              self={self}
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
   * The room's title as a member last set it. It changes only through
   * `setTitle`.
   */
  titles?: TitlesCell;

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
    titles,
    participants,
    // The room itself, the link another member's manager lists it by.
    [SELF]: self,
  }) => {
    const profileWish = wish<ChatProfile>({ query: "#profile" });
    const containerWish = wish<Cell<ChatContainer>>({ query: "#default" });
    // The viewer's adds' outcomes, which follow them, and only them, across
    // sessions.
    const addRequests = new Writable.perUser<
      Record<string, AddMemberOutcome>
    >({});
    // The viewer's manager, which starts a direct chat with a participant,
    // makes this room one of the viewer's chats once they join it, and tells
    // someone the viewer adds of it.
    const managerWish = wish<
      RoomManager & { openDirect: Stream<StartDirectEvent> }
    >({ query: "#chatManager" });
    const startsDirect = computed(() => managerWish.result !== undefined);
    // Hidden by a prop rather than a branch, and `hidden` until the prop has a
    // value, as `FabriChatMessageRow` says.
    const setupDisplay = computed((): ChatDisplay =>
      profileWish.result === undefined ? "block" : "none"
    );
    const room = FabriChatRoomCore(
      {
        myProfile: profileWish.result,
        container: containerWish.result,
        about,
        messages,
        reactionLists,
        requests,
        usedTimes,
        activity,
        counters,
        titles,
        roster: participants,
        addRequests,
        startsDirect,
        startDirect: managerWish.result?.openDirect,
        self,
        manager: managerWish.result,
      },
    );

    return {
      [NAME]: room[NAME],
      [VIEWS]: room[VIEWS],
      about: room.about,
      recentActivity: room.recentActivity,
      recentActivityExpiredThrough: room.recentActivityExpiredThrough,
      participants: room.participants,
      roster: room.roster,
      participantEntries: room.participantEntries,
      participantPrincipals: room.participantPrincipals,
      addParticipant: room.addParticipant,
      messages: room.messages,
      openWindow: room.openWindow,
      closeWindow: room.closeWindow,
      canSend: room.canSend,
      viewer: room.viewer,
      messageRights: room.messageRights,
      sendMessage: room.sendMessage,
      editMessage: room.editMessage,
      deleteMessage: room.deleteMessage,
      obliterateMessage: room.obliterateMessage,
      sendReaction: room.sendReaction,
      deleteReaction: room.deleteReaction,
      addMember: room.addMember,
      canAdd: room.canAdd,
      addRequests: room.addRequests,
      messageRequests: room.messageRequests,
      setTitle: room.setTitle,
      titleRequests: room.titleRequests,
      [UI]: (
        <cf-screen>
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
