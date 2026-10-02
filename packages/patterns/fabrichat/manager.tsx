/**
 * `FabriChatManager`: a user's index of the rooms they belong to, an
 * implementation of `ChatManagerOutput` (`docs/specs/fabrichat/`). It lives in
 * the user's home space, where `#chatManager` finds it, so everything it holds
 * is private to its user.
 *
 * It creates each room in a space of its own with `inSpace()`, which grants its
 * creator OWNER and each other member named at creation WRITE, and no one
 * else, except that a group made joinable by its link grants everyone WRITE
 * as well. After that, who is in the space is the space's business, changed
 * through the space's own tools and never through the manager or the room.
 *
 * A room is offered to each other member whose profile the request names,
 * through the private inbox the profile points at, and the manager lists the
 * rooms offered to its own user through theirs. A notice is queued for every
 * other member all the same, since nothing tells the sender an offer arrived.
 */
import {
  type Cell,
  computed,
  currentPrincipal,
  debugStr,
  type Default,
  type DID,
  equals,
  eventKey,
  handler,
  type InSpaceGrants,
  isWellFormedDID,
  NAME,
  pattern,
  principalOf,
  spaceAccess,
  Stream,
  UI,
  VIEWS,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import FabriChatRoom from "./room.tsx";
import {
  type AboutRecord,
  CHAT_ROOM_OFFER_KIND,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatInbox,
  type ChatInboxOffer,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatManagerOffer,
  type ChatOfferHandling,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomKind,
  type ChatRoomLink,
  epochNsecFromMsec,
  nsecOf,
  type ProfileCell,
} from "./schemas.tsx";

/** The manager's rooms, in the order it recorded them. */
export type RoomsCell = Writable<ChatIndexEntry[] | Default<[]>>;

/** The direct room shared with each counterpart, by principal. */
export type DirectCell = Writable<
  Record<string, ChatIndexEntry> | Default<Record<PropertyKey, never>>
>;

/** Each request's outcome, by its `requestId`. */
export type RequestsCell = Writable<
  Record<string, ChatRequestOutcome> | Default<Record<PropertyKey, never>>
>;

/** Notices waiting for a client to deliver them. */
export type NoticesCell = Writable<ChatManagerNotice[] | Default<[]>>;

/** What this user did with each offer they acted on, by the offer's key. */
export type HandledOffersCell = Writable<
  | Record<string, ChatOfferHandling>
  | Default<Record<PropertyKey, never>>
>;

/** Every act `commitManager` performs, each bound to one of its streams. */
export type ManagerAct =
  | "openDirect"
  | "createGroup"
  | "accept"
  | "forget"
  | "delivered"
  | "dismissOffer";

/** Whether `act` starts a chat. */
const isStart = (act: ManagerAct): boolean =>
  act === "openDirect" || act === "createGroup";

/**
 * An event on one of the manager's streams. Each stream's event carries the
 * fields its act needs. A rendered control sends the text it holds as
 * `target.value`, and no request id, which the manager then mints.
 */
export interface ManagerStreamEvent {
  /** Chosen by the sender; the outcome is recorded under it. */
  requestId?: string;

  /** The DID of a direct room's other member. */
  counterpart?: string;

  // `Cell<…>` is written out rather than reached through an alias: the
  // event's schema marks a reference position only where the wrapper is
  // written in the event type.
  /**
   * A direct room's other member's profile, through whose private inbox a new
   * room is offered to them.
   */
  profile?: Cell<ChatProfile>;

  /** The DIDs of a new group room's other members. */
  members?: string[];

  /** A new group room's title. */
  title?: string;

  /**
   * Whether a new group room admits anyone who has its link; absent for a room
   * admitting its members alone.
   */
  joinableByLink?: boolean;

  /** A room to accept or forget. */
  room?: Cell<ChatRoomLink>;

  /** The id of a notice delivered. */
  id?: string;

  /** The key of the offer accepted or dismissed. */
  offer?: string;

  /** A rendered control's text. */
  readonly target?: { readonly value?: string };
}

/** A group room being composed in the manager's own rendering. */
export interface GroupDraft {
  /** The room's title. */
  title: string;

  /** The other members' DIDs, one per line or separated by spaces. */
  members: string;

  /** Whether the room admits anyone who has its link. */
  joinableByLink: boolean;
}

/** An empty group draft. */
const EMPTY_DRAFT = {
  title: "",
  members: "",
  joinableByLink: false,
} satisfies GroupDraft;

/** The manager's records, and a rendered control's bindings. */
export interface ManagerActState {
  /** The act this binding performs. */
  act: ManagerAct;

  /** The user's profile, which holds no value until it resolves. */
  myProfile: ProfileCell | undefined;

  /** The rooms this user belongs to. */
  rooms: RoomsCell;

  /** The direct room shared with each counterpart. */
  direct: DirectCell;

  /** Each request's outcome. */
  requests: RequestsCell;

  /** Notices waiting for a client to deliver them. */
  outgoingNotices: NoticesCell;

  /** What this user did with each offer they acted on. */
  handledOffers: HandledOffersCell;

  /** Offers a newly created room to the members a request named profiles of. */
  offerRooms: Stream<OfferRoomEvent>;

  /** The session's group draft, which a rendered create reads. */
  draft: Writable<GroupDraft>;

  /**
   * Why the session's latest start was refused, which the rendering shows;
   * empty when it wasn't refused.
   */
  startRefusal: Writable<string>;

  /** Whether this binding creates a group from `draft`. */
  fromDraft?: boolean;

  /** A rendered control's room. */
  room?: Cell<ChatRoomLink>;

  /** A rendered control's notice id. */
  id?: string;

  /** A rendered control's offer key. */
  offer?: string;

  /** Who sent a rendered control's offer. */
  counterpart?: string;
}

/** A `did:key` whose key is base58btc multibase, as every principal's is. */
const DID_KEY = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Whether `value` is a DID a principal can have: well formed, and, for a
 * `did:key`, a base58btc key, so that a key a period or other punctuation
 * follows is refused.
 */
const isPrincipalDID = (value: unknown): value is DID =>
  isWellFormedDID(value) &&
  (!value.startsWith("did:key:") || DID_KEY.test(value));

/** The DIDs in `text`, separated by spaces, commas, or lines. */
const principalsIn = (text: string): string[] =>
  text.split(/[\s,]+/).filter((part) => part !== "");

/** `members`, without duplicates, `self`, or anything but a DID. */
const otherMembers = (
  members: readonly unknown[],
  self: string,
): DID[] =>
  members.reduce<DID[]>(
    (found, member) =>
      isPrincipalDID(member) && member !== self && !found.includes(member)
        ? [...found, member]
        : found,
    [],
  );

/**
 * Records a request's outcome. A `done` or `refused` outcome is kept for as
 * long as the manager exists. A start's outcome also replaces what the
 * session's rendering says about its latest start: `shown` or the reason for
 * a refusal, and nothing for a start that is done.
 */
const recordOutcome = (
  state: ManagerActState,
  requestId: string,
  outcome: ChatRequestOutcome,
  shown?: string,
): void => {
  state.requests.key(requestId).set(outcome);
  if (isStart(state.act)) {
    state.startRefusal.set(
      outcome.status === "refused" ? shown ?? outcome.reason : "",
    );
  }
};

/** Whether `rooms` already lists `room`. */
const lists = (rooms: RoomsCell, room: Cell<ChatRoomLink>): boolean =>
  ((rooms.get() ?? []) as ChatIndexEntry[]).some((entry) =>
    equals(entry.room, room)
  );

/**
 * The key an offer is named by: who sent it, and when the inbox received it,
 * which together pick out one offer in one inbox.
 */
const offerKeyOf = (offer: ChatInboxOffer): string =>
  JSON.stringify([offer.from, offer.receivedAt]);

/**
 * A profile's inbox pointer, as the cell of the inbox it names. A profile
 * types the pointer as a link, and a link's target is reached as a cell.
 */
function inboxOf(pointer: unknown): Cell<ChatInbox>;
function inboxOf(pointer: unknown): unknown {
  return pointer;
}

/** What offering a new room asks: the room, and whom to offer it to. */
export interface OfferRoomEvent {
  // `Cell<…>` is written out rather than reached through an alias: the
  // event's schema marks a reference position only where the wrapper is
  // written in the event type.
  /** The room offered. */
  room: Cell<ChatRoomLink>;

  /** The profiles of the members to offer it to. */
  profiles: Cell<ChatProfile>[];
}

/**
 * Offers a room to each person in the event's `profiles`, through the private
 * inbox each profile points at; a profile pointing at no inbox is offered
 * nothing.
 *
 * It runs as an event of its own, queued by the one that creates the room: an
 * offer links the room into a labeled inbox, and that link has to name the
 * room's result document, which exists only once the room's creation has
 * committed.
 */
const offerRooms = handler<OfferRoomEvent, Record<PropertyKey, never>>(
  (event) => {
    const room = event?.room?.resolveAsCell();
    if (room === undefined) return;
    for (const profile of event.profiles ?? []) {
      // The pointer is read through its parent: a link-typed field read on
      // its own is a cell whether or not anything is stored there.
      const pointer = profile?.key("inbox").get()?.piece;
      if (pointer === undefined) continue;
      inboxOf(pointer.resolveAsCell()).key("receive").send({
        kind: CHAT_ROOM_OFFER_KIND,
        entry: room,
      });
    }
  },
);

/**
 * A room's result, as the link an index entry holds. The room is created
 * where the link can't be typed as a cell, and stored as a link to it.
 */
function roomLinkOf(room: unknown): Cell<ChatRoomLink>;
function roomLinkOf(room: unknown): unknown {
  return room;
}

/**
 * The record a room's creator wrote, which the room's `about` links, as a
 * cell: what `principalOf()` reads the creator from, and what reads without
 * the room running. It holds nothing for a space's own chat.
 */
function aboutRecordOf(room: Cell<ChatRoomLink>): Cell<AboutRecord>;
function aboutRecordOf(room: Cell<ChatRoomLink>): unknown {
  return room.key("about").key("record");
}

/** How a room `createRoom()` makes differs by its kind. */
interface RoomOptions {
  /** A group room's title. */
  title?: string;

  /** A direct room's other member. */
  counterpart?: string;

  /**
   * Whether the room's space admits anyone with its link, with WRITE: its
   * address is then all that keeps it private.
   */
  joinableByLink?: boolean;

  /** The profiles of the other members to offer the room to. */
  offerTo?: readonly Cell<ChatProfile>[];
}

/**
 * Creates a room in a space of its own, and its notices, and records its
 * entry, all in one transaction: the space's grants are part of creating it,
 * so nothing has to commit apart. A notice for each other member is queued for
 * a client to deliver, and offering the room to each profile in `offerTo` is
 * queued to follow.
 */
const createRoom = (
  state: ManagerActState,
  requestId: string,
  kind: ChatRoomKind,
  members: readonly DID[],
  { title, counterpart, joinableByLink = false, offerTo = [] }: RoomOptions =
    {},
): ChatIndexEntry => {
  const createdAt = epochNsecFromMsec(Date.now());
  // The room's space grants this user OWNER, each other member WRITE, and,
  // for a room joinable by its link, everyone WRITE.
  const grants = Object.fromEntries([
    ...members.map((member) => [member, "WRITE"]),
    ...(joinableByLink ? [["*", "WRITE"]] : []),
  ]) as InSpaceGrants;
  const room = roomLinkOf(
    FabriChatRoom.inSpace(undefined, { grants })({
      about: {
        kind,
        createdAt,
        ...(title === undefined ? {} : { title }),
      },
    }),
  );
  members.forEach((recipient) => {
    state.outgoingNotices.push({
      id: JSON.stringify([recipient, requestId]),
      room,
      recipient,
    });
  });
  if (offerTo.length > 0) {
    state.offerRooms.send({ room, profiles: [...offerTo] });
  }
  const entry: ChatIndexEntry = {
    room,
    kind,
    ...(counterpart === undefined ? {} : { counterpart }),
    since: createdAt,
  };
  state.rooms.push(entry);
  return entry;
};

/**
 * Performs one manager act: finding or creating a direct room, creating a
 * group room, accepting a room, forgetting one, reporting a notice delivered,
 * or dismissing an offer. Each act's outcome is recorded under its
 * `requestId`, and a request already decided changes nothing.
 */
export const commitManager = handler<ManagerStreamEvent, ManagerActState>(
  (event, state) => {
    const { act, rooms, direct, requests, outgoingNotices, handledOffers } =
      state;
    const requestId = event?.requestId ?? eventKey();
    const earlier = requests.key(requestId).get();
    if (earlier !== undefined && earlier.status !== "pending") return;
    const typed = event?.target?.value?.trim();

    // A chat is started by someone who can take part in it, and taking part
    // needs a profile.
    if (
      isStart(act) &&
      state.myProfile?.get() === undefined
    ) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "Starting a chat needs a profile.",
      });
      return;
    }

    if (act === "delivered") {
      const id = event?.id ?? state.id;
      // An event's type doesn't refuse an event that lacks a field it
      // requires, so each act refuses the request itself, where a rendered
      // control's binding doesn't supply the field.
      if (typeof id !== "string") {
        recordOutcome(state, requestId, {
          status: "refused",
          reason: "The request names no notice.",
        });
        return;
      }
      outgoingNotices.set(
        ((outgoingNotices.get() ?? []) as ChatManagerNotice[]).filter((
          notice,
        ) => notice.id !== id),
      );
      return;
    }

    // The offer an `accept` comes from, if any, and the one `dismissOffer`
    // names.
    const offer = event?.offer ?? state.offer;
    if (act === "dismissOffer") {
      if (typeof offer !== "string") {
        recordOutcome(state, requestId, {
          status: "refused",
          reason: "The request names no offer.",
        });
        return;
      }
      handledOffers.key(offer).set("dismissed");
      recordOutcome(state, requestId, { status: "done" });
      return;
    }

    // A start needs to know who this user is, to leave them out of the
    // room's other members.
    const self = currentPrincipal();
    if (isStart(act) && self === undefined) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "Starting a chat needs a signed-in user.",
      });
      return;
    }

    if (act === "openDirect") {
      const counterpart = event?.counterpart ?? typed;
      if (!isPrincipalDID(counterpart)) {
        const reason = "The counterpart is not a principal.";
        // The session is shown the text it sent, which says what is wrong
        // with it. The recorded reason is kept for as long as the manager
        // exists, so it holds no text a person typed.
        recordOutcome(
          state,
          requestId,
          { status: "refused", reason },
          counterpart === undefined || counterpart === ""
            ? undefined
            : debugStr`${reason} Received: $long${counterpart}`,
        );
        return;
      }
      if (counterpart === self) {
        recordOutcome(state, requestId, {
          status: "refused",
          reason: "The counterpart is this user.",
        });
        return;
      }
      // The room is offered through the profile's inbox, so the profile has
      // to be the counterpart's own.
      const profile = event?.profile;
      if (
        profile !== undefined &&
        principalOf(profile, "represents-principal") !== counterpart
      ) {
        recordOutcome(state, requestId, {
          status: "refused",
          reason: "The profile is not the counterpart's.",
        });
        return;
      }
      const known = direct.key(counterpart).get();
      if (known !== undefined) {
        if (!lists(rooms, known.room)) {
          rooms.set([...((rooms.get() ?? []) as ChatIndexEntry[]), known]);
        }
        recordOutcome(state, requestId, { status: "done", entry: known });
        return;
      }
      const entry = createRoom(state, requestId, "direct", [counterpart], {
        counterpart,
        offerTo: profile === undefined ? [] : [profile],
      });
      direct.key(counterpart).set(entry);
      recordOutcome(state, requestId, { status: "done", entry });
      return;
    }

    if (act === "createGroup") {
      const draft = state.fromDraft === true ? state.draft.get() : undefined;
      const title = (event?.title ?? draft?.title ?? "").trim();
      if (title === "") {
        recordOutcome(state, requestId, {
          status: "refused",
          reason: "A group room needs a title.",
        });
        return;
      }
      if (draft === undefined && !Array.isArray(event?.members)) {
        recordOutcome(state, requestId, {
          status: "refused",
          reason: "A group's members must be listed.",
        });
        return;
      }
      const listed = event?.members ?? principalsIn(draft?.members ?? "");
      const notPrincipals = listed.filter((member) => !isPrincipalDID(member));
      if (notPrincipals.length > 0) {
        const reason = "A group's members must be principals.";
        // As for a direct room, the session is shown what it sent that isn't
        // one, and the recorded reason holds no text a person typed.
        recordOutcome(
          state,
          requestId,
          { status: "refused", reason },
          debugStr`${reason} Received: $long${notPrincipals}`,
        );
        return;
      }
      const members = otherMembers(listed, self ?? "");
      const joinableByLink = event?.joinableByLink ??
        draft?.joinableByLink ?? false;
      const entry = createRoom(state, requestId, "group", members, {
        title,
        joinableByLink,
      });
      if (state.fromDraft === true) state.draft.set(EMPTY_DRAFT);
      recordOutcome(state, requestId, { status: "done", entry });
      return;
    }

    const room = event?.room ?? state.room;
    if (room === undefined) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The request names no room.",
      });
      return;
    }

    if (act === "forget") {
      rooms.set(
        ((rooms.get() ?? []) as ChatIndexEntry[]).filter((entry) =>
          !equals(entry.room, room)
        ),
      );
      recordOutcome(state, requestId, { status: "done" });
      return;
    }

    // `accept`. The kind comes from the record the room's creator wrote,
    // which reads without the room running, as its own view needs; a space's
    // own chat has none, and its view says what it is.
    const record = aboutRecordOf(room);
    const kind = record.key("kind").get() ?? room.key("about").get()?.kind;
    if (
      currentPrincipal() === undefined || spaceAccess(room) === "none" ||
      (kind !== "direct" && kind !== "group")
    ) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: "The room can't be read by this user.",
      });
      return;
    }
    // A direct room's counterpart is its creator, as its `about` is labeled,
    // whatever the event claims. A room this user created is found again with
    // `openDirect`, and its label names no one else. An offered room of
    // either kind is the offer's sender's own: an offer's `entry` is whatever
    // its sender put there, which only the room's label vouches for.
    const offered = typeof offer === "string";
    const claimed = event?.counterpart ?? state.counterpart;
    const creator = kind === "direct" || offered
      ? principalOf(record, "authored-by")
      : undefined;
    const refusal = kind !== "direct" && !offered
      ? undefined
      : creator === undefined
      ? "The room's creator can't be verified."
      : kind === "direct" && creator === currentPrincipal()
      ? "The room was created by this user."
      : claimed !== undefined && claimed !== creator
      ? offered
        ? "The offer's sender is not the room's creator."
        : "The counterpart is not the room's creator."
      : undefined;
    if (refusal !== undefined) {
      recordOutcome(state, requestId, {
        status: "refused",
        reason: refusal,
      });
      return;
    }
    const counterpart = creator;
    const entry: ChatIndexEntry = {
      room,
      kind,
      ...(kind === "direct" ? { counterpart } : {}),
      since: epochNsecFromMsec(Date.now()),
    };
    if (!lists(rooms, room)) {
      rooms.set([...((rooms.get() ?? []) as ChatIndexEntry[]), entry]);
    }
    if (
      kind === "direct" && counterpart !== undefined &&
      direct.key(counterpart).get() === undefined
    ) {
      direct.key(counterpart).set(entry);
    }
    if (typeof offer === "string") handledOffers.key(offer).set("accepted");
    recordOutcome(state, requestId, { status: "done", entry });
  },
);

/** What a manager stores. Every field has a default. */
export interface FabriChatManagerInput {
  /** The rooms this user belongs to. */
  rooms?: RoomsCell;

  /** The direct room shared with each counterpart. */
  direct?: DirectCell;

  /** Each request's outcome. */
  requests?: RequestsCell;

  /** Notices waiting for a client to deliver them. */
  outgoingNotices?: NoticesCell;

  /** What this user did with each offer they acted on. */
  handledOffers?: HandledOffersCell;
}

/** What a manager offers: `ChatManagerOutput`. */
export interface FabriChatManagerOutput {
  /** The manager's name, for lists of pieces. */
  [NAME]: string;

  /** The manager's rendering. */
  [UI]: VNode;

  /** Every room this user belongs to and hasn't forgotten, newest first. */
  rooms: ChatIndexEntry[];

  /** The direct room this user shares with each counterpart, by principal. */
  direct: Record<string, ChatIndexEntry>;

  /** The outcome of each request, by the `requestId` its caller chose. */
  requests: Record<string, ChatRequestOutcome>;

  /** Notices this user's requests have produced that no one has delivered. */
  outgoingNotices: ChatManagerNotice[];

  /** The rooms offered to this user that they haven't acted on, oldest first. */
  offers: ChatManagerOffer[];

  /** Finds or creates the direct room with a person. */
  openDirect: Stream<ManagerStreamEvent>;

  /** Creates a group room. */
  createGroup: Stream<ManagerStreamEvent>;

  /** Records a room this user has been admitted to. */
  accept: Stream<ManagerStreamEvent>;

  /** Removes a room from this user's list. */
  forget: Stream<ManagerStreamEvent>;

  /** Reports a notice delivered. */
  delivered: Stream<ManagerStreamEvent>;

  /** Sets an offer aside without accepting it. */
  dismissOffer: Stream<ManagerStreamEvent>;

  /** The manager's data face, as one group. */
  [VIEWS]: { chats: FabriChatManagerView };
}

/** A manager's data face, for hosts that draw it natively. */
export type FabriChatManagerView = Omit<
  FabriChatManagerOutput,
  typeof NAME | typeof UI | typeof VIEWS
>;

/** Shows `room` in the manager's own rendering. */
const selectRoom = handler<
  unknown,
  {
    selected: Writable<{ room?: Cell<ChatRoomLink> }>;
    room: Cell<ChatRoomLink>;
  }
>((_event, { selected, room }) => {
  selected.set({ room });
});

/** A room in the manager's own rendering. */
interface ShownEntry {
  /** The room. */
  room: Cell<ChatRoomLink>;

  /** How the entry is labeled. */
  label: string;
}

/** What a manager's core needs: what it stores, and whose it is. */
export interface FabriChatManagerCoreInput
  extends Required<FabriChatManagerInput> {
  /** The user's profile, which holds no value until it resolves. */
  myProfile: ProfileCell | undefined;
}

/**
 * A person's rooms, those they belong to, and the way to start new ones,
 * given the person's profile.
 */
export const FabriChatManagerCore = pattern<
  FabriChatManagerCoreInput,
  FabriChatManagerOutput
>(
  ({ myProfile, rooms, direct, requests, outgoingNotices, handledOffers }) => {
    const draft = new Writable.perSession<GroupDraft>(EMPTY_DRAFT);
    const startRefusal = new Writable.perSession<string>("");
    const selected = new Writable.perSession<{ room?: Cell<ChatRoomLink> }>(
      {},
    );
    const records = {
      myProfile,
      rooms,
      direct,
      requests,
      outgoingNotices,
      handledOffers,
      offerRooms: offerRooms({}),
      draft,
      startRefusal,
    };
    const newestFirst = computed(() =>
      [...((rooms.get() ?? []) as ChatIndexEntry[])].sort((a, b) =>
        nsecOf(b.since) < nsecOf(a.since)
          ? -1
          : nsecOf(b.since) > nsecOf(a.since)
          ? 1
          : 0
      )
    );
    const shown = computed((): ShownEntry[] =>
      newestFirst.map((entry) => ({
        room: entry.room,
        label: entry.kind === "direct"
          ? `With ${entry.counterpart ?? "someone"}`
          : entry.room.key("about").get()?.title ?? "Group chat",
      }))
    );
    const hasSelection = computed(() => selected.get()?.room !== undefined);
    const selectedRoom = computed(() => selected.get()?.room);
    // The chosen room differs by session, so both parts are always rendered
    // and one is hidden by a prop: a tree built differently per session is
    // stored once for every session, and runtimes that built it differently
    // overwrite each other without end.
    const selectedDisplay = computed(() => (hasSelection ? "block" : "none"));
    const unselectedDisplay = computed(() => (hasSelection ? "none" : "block"));
    // A refusal is the session's too, and is hidden by a prop for the same
    // reason.
    const refusalDisplay = computed(() =>
      startRefusal.get() === "" ? "none" : "block"
    );
    const noticeList = computed(
      () => [...((outgoingNotices.get() ?? []) as ChatManagerNotice[])],
    );
    // The rooms offered through the inbox this user's profile points at, less
    // those they have acted on or already list, and those whose label doesn't
    // name the offer's sender as their creator: an offer's `entry` is
    // whatever its sender put there, and only the room's label vouches for
    // it. Each offer is read on its own, so one this can't read costs only
    // itself.
    const offers = computed((): ChatManagerOffer[] => {
      const received = (myProfile?.key("inbox").key("piece").key("offers")
        .get() ?? []) as ChatInboxOffer[];
      const handled = handledOffers.get() ?? {};
      return received.flatMap((offer): ChatManagerOffer[] => {
        if (
          offer?.kind !== CHAT_ROOM_OFFER_KIND || offer.entry === undefined ||
          typeof offer.from !== "string"
        ) {
          return [];
        }
        const key = offerKeyOf(offer);
        return handled[key] !== undefined || lists(rooms, offer.entry) ||
            principalOf(aboutRecordOf(offer.entry), "authored-by") !==
              offer.from
          ? []
          : [{ key, room: offer.entry, from: offer.from }];
      });
    });
    const cannotStart = computed(() => myProfile?.get() === undefined);
    // The principal this user's profile attests, which someone starting a
    // chat with them needs; empty when the profile attests none.
    const myAddress = computed(() =>
      principalOf(myProfile, "represents-principal") ?? ""
    );
    const addressDisplay = computed(
      () => (myAddress === "" ? "none" : "block"),
    );
    const streams = {
      openDirect: commitManager({ act: "openDirect", ...records }),
      createGroup: commitManager({ act: "createGroup", ...records }),
      accept: commitManager({ act: "accept", ...records }),
      forget: commitManager({ act: "forget", ...records }),
      delivered: commitManager({ act: "delivered", ...records }),
      dismissOffer: commitManager({ act: "dismissOffer", ...records }),
    };
    const view = {
      rooms: newestFirst,
      direct,
      requests,
      outgoingNotices: noticeList,
      offers,
      ...streams,
    };

    return {
      [NAME]: "Chats",
      [UI]: (
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-heading level={3}>Chats</cf-heading>
          <cf-vstack id="fabrichat-offers" gap="1">
            {offers.map((offer) => (
              <cf-hstack gap="2" align="center">
                <cf-text variant="caption">
                  {offer.from} offered you a chat:
                </cf-text>
                <cf-cell-link $cell={offer.room} label="Open" />
                <cf-button
                  size="sm"
                  onClick={commitManager({
                    act: "accept",
                    ...records,
                    room: offer.room,
                    offer: offer.key,
                    counterpart: offer.from,
                  })}
                >
                  Add to my chats
                </cf-button>
                <cf-button
                  size="sm"
                  variant="ghost"
                  onClick={commitManager({
                    act: "dismissOffer",
                    ...records,
                    offer: offer.key,
                  })}
                >
                  Dismiss
                </cf-button>
              </cf-hstack>
            ))}
          </cf-vstack>
          <cf-vstack id="fabrichat-rooms" gap="1">
            {shown.map((entry) => (
              <cf-hstack gap="2" align="center">
                <cf-button
                  size="sm"
                  variant="ghost"
                  onClick={selectRoom({ selected, room: entry.room })}
                >
                  {entry.label}
                </cf-button>
                <cf-cell-link $cell={entry.room} label="Open" />
                <cf-button
                  size="sm"
                  variant="ghost"
                  onClick={commitManager({
                    act: "forget",
                    ...records,
                    room: entry.room,
                  })}
                >
                  Forget
                </cf-button>
              </cf-hstack>
            ))}
          </cf-vstack>
          <div id="fabrichat-selected" style={{ display: selectedDisplay }}>
            <cf-render $cell={selectedRoom} />
          </div>
          <div
            id="fabrichat-unselected"
            style={{ display: unselectedDisplay }}
          >
            <cf-empty-state message="Choose a chat, or start one." />
          </div>
          <div id="fabrichat-my-address" style={{ display: addressDisplay }}>
            <cf-hstack gap="2" align="center">
              <cf-text variant="caption">
                Your chat address: {myAddress}
              </cf-text>
              <cf-copy-button text={myAddress} size="sm" icon-only />
            </cf-hstack>
          </div>
          <div
            data-ui-pattern={CHAT_START_SURFACE}
            data-ui-event-integrity={CHAT_START_SURFACE}
          >
            <cf-vstack gap="2">
              <cf-submit-input
                data-ui-action={CHAT_START_ACTION}
                inputId="fabrichat-start-direct"
                placeholder="Their chat address (did:key:…)"
                buttonText="Chat"
                disabled={cannotStart}
                onClick={streams.openDirect}
              />
              <cf-input
                id="fabrichat-group-title"
                $value={draft.key("title")}
                placeholder="New group's title"
              />
              <cf-textarea
                $value={draft.key("members")}
                placeholder="Members' chat addresses, one per line"
              />
              <cf-checkbox $checked={draft.key("joinableByLink")}>
                Anyone with its link can join
              </cf-checkbox>
              <cf-button
                data-ui-action={CHAT_START_ACTION}
                disabled={cannotStart}
                onClick={commitManager({
                  act: "createGroup",
                  ...records,
                  fromDraft: true,
                })}
              >
                Create group
              </cf-button>
              <div
                id="fabrichat-start-refusal"
                style={{ display: refusalDisplay }}
              >
                <cf-alert status="error">{startRefusal}</cf-alert>
              </div>
            </cf-vstack>
          </div>
          {noticeList.map((notice) => (
            <cf-hstack gap="2" align="center">
              <cf-text variant="caption">
                {notice.recipient}{" "}
                may not know of this chat yet. Open it, and send them its
                address:
              </cf-text>
              <cf-cell-link $cell={notice.room} />
              <cf-button
                size="sm"
                variant="ghost"
                onClick={commitManager({
                  act: "delivered",
                  ...records,
                  id: notice.id,
                })}
              >
                Done
              </cf-button>
            </cf-hstack>
          ))}
        </cf-vstack>
      ),
      [VIEWS]: { chats: view },
      ...view,
    };
  },
);

/**
 * A person's chat manager, whose person is the one looking at it: what
 * `#chatManager` resolves to.
 */
const FabriChatManager = pattern<
  FabriChatManagerInput,
  FabriChatManagerOutput
>((input) => {
  const profileWish = wish<ChatProfile>({ query: "#profile" });
  const core = FabriChatManagerCore(
    {
      myProfile: profileWish.result,
      rooms: input.rooms,
      direct: input.direct,
      requests: input.requests,
      outgoingNotices: input.outgoingNotices,
      handledOffers: input.handledOffers,
    },
  );
  return {
    [NAME]: core[NAME],
    [UI]: core[UI],
    [VIEWS]: core[VIEWS],
    rooms: core.rooms,
    direct: core.direct,
    requests: core.requests,
    outgoingNotices: core.outgoingNotices,
    offers: core.offers,
    openDirect: core.openDirect,
    createGroup: core.createGroup,
    accept: core.accept,
    forget: core.forget,
    delivered: core.delivered,
    dismissOffer: core.dismissOffer,
  };
});

export default FabriChatManager;
