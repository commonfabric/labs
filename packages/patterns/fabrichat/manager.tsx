/**
 * `FabriChatManager`: a user's index of the rooms they belong to, an
 * implementation of `ChatManagerOutput` (`docs/specs/fabrichat/`). It lives in
 * the user's home space, where `#chatManager` finds it, so everything it holds
 * is private to its user.
 *
 * It creates each room in a space of its own with `inSpace()`, which grants its
 * creator OWNER and each other member named at creation WRITE, and no one
 * else. A pattern can't change a space's grants after that, so a member added
 * later is granted access only by a host.
 */
import {
  type Cell,
  computed,
  currentPrincipal,
  type Default,
  equals,
  eventKey,
  handler,
  type InSpaceGrants,
  NAME,
  pattern,
  spaceAccess,
  Stream,
  UI,
  VIEWS,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import { isPrincipal } from "./logic.ts";
import FabriChatRoom from "./room.tsx";
import {
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomKind,
  type ChatRoomLink,
  epochNsecFromMsec,
  nsecOf,
  type ProfileCell,
} from "./schemas.tsx";

/** The reviewed action a start is, on `CHAT_START_SURFACE`. */
export const CHAT_START_ACTION = "ChatStart";

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

/** Every act `commitManager` performs, each bound to one of its streams. */
export type ManagerAct =
  | "openDirect"
  | "createGroup"
  | "accept"
  | "forget"
  | "delivered";

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

  /** The DIDs of a new group room's other members. */
  members?: string[];

  /** A new group room's title. */
  title?: string;

  /** A room to accept or forget. */
  room?: Cell<ChatRoomLink>;

  /** The id of a notice delivered. */
  id?: string;

  /** A rendered control's text. */
  readonly target?: { readonly value?: string };
}

/** A group room being composed in the manager's own rendering. */
export interface GroupDraft {
  /** The room's title. */
  title: string;

  /** The other members' DIDs, one per line or separated by spaces. */
  members: string;
}

/** An empty group draft. */
const EMPTY_DRAFT = { title: "", members: "" } satisfies GroupDraft;

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

  /** The session's group draft, which a rendered create reads. */
  draft: Writable<GroupDraft>;

  /** Whether this binding creates a group from `draft`. */
  fromDraft?: boolean;

  /** A rendered control's room. */
  room?: Cell<ChatRoomLink>;

  /** A rendered control's notice id. */
  id?: string;
}

/** The DIDs in `text`, separated by spaces, commas, or lines. */
const principalsIn = (text: string): string[] =>
  text.split(/[\s,]+/).filter((part) => part !== "");

/** `members`, without duplicates, `self`, or anything but a DID. */
const otherMembers = (
  members: readonly unknown[],
  self: string,
): string[] =>
  members.reduce<string[]>(
    (found, member) =>
      isPrincipal(member) && member !== self && !found.includes(member)
        ? [...found, member]
        : found,
    [],
  );

/**
 * Records a request's outcome. A `done` or `refused` outcome is kept for as
 * long as the manager exists.
 */
const recordOutcome = (
  requests: RequestsCell,
  requestId: string,
  outcome: ChatRequestOutcome,
): void => {
  requests.key(requestId).set(outcome);
};

/** Whether `rooms` already lists `room`. */
const lists = (rooms: RoomsCell, room: Cell<ChatRoomLink>): boolean =>
  ((rooms.get() ?? []) as ChatIndexEntry[]).some((entry) =>
    equals(entry.room, room)
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
 * Creates a room in a space of its own, and its notices, and records its
 * entry. Everything happens in one transaction, since a pattern can't grant
 * access, which would otherwise have to commit apart.
 */
const createRoom = (
  state: ManagerActState,
  requestId: string,
  kind: ChatRoomKind,
  members: readonly string[],
  title?: string,
  counterpart?: string,
): ChatIndexEntry => {
  const createdAt = epochNsecFromMsec(Date.now());
  // The room's space grants this user OWNER and each other member WRITE.
  const grants = Object.fromEntries(
    members.map((member) => [member, "WRITE"]),
  ) as InSpaceGrants;
  const room = roomLinkOf(
    FabriChatRoom.inSpace(undefined, { grants })({
      about: {
        kind,
        createdAt,
        ...(title === undefined ? {} : { title }),
      },
      ownSpace: true,
      // The profile itself, not the link through this user's home space that
      // reached it, which other members can't follow.
      creatorProfile: state.myProfile?.resolveAsCell(),
    }),
  );
  members.forEach((recipient) => {
    state.outgoingNotices.push({
      id: JSON.stringify([recipient, requestId]),
      room,
      recipient,
    });
  });
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
 * group room, accepting a room, forgetting one, or reporting a notice
 * delivered. Each act's outcome is recorded under its `requestId`, and a
 * request already decided changes nothing.
 */
export const commitManager = handler<ManagerStreamEvent, ManagerActState>(
  (event, state) => {
    const { act, rooms, direct, requests, outgoingNotices } = state;
    const requestId = event?.requestId ?? eventKey();
    const earlier = requests.key(requestId).get();
    if (earlier !== undefined && earlier.status !== "pending") return;
    const typed = event?.target?.value?.trim();

    // A room remembers its creator by profile, so it can't be started
    // without one.
    if (
      (act === "openDirect" || act === "createGroup") &&
      state.myProfile?.get() === undefined
    ) {
      recordOutcome(requests, requestId, {
        status: "refused",
        reason: "Starting a chat needs a profile.",
      });
      return;
    }

    if (act === "delivered") {
      const id = event?.id ?? state.id;
      if (typeof id !== "string") return;
      outgoingNotices.set(
        ((outgoingNotices.get() ?? []) as ChatManagerNotice[]).filter((
          notice,
        ) => notice.id !== id),
      );
      return;
    }

    // A start needs to know who this user is, to leave them out of the
    // room's other members.
    const self = currentPrincipal();
    if ((act === "openDirect" || act === "createGroup") && self === undefined) {
      recordOutcome(requests, requestId, {
        status: "refused",
        reason: "Starting a chat needs a signed-in user.",
      });
      return;
    }

    if (act === "openDirect") {
      const counterpart = event?.counterpart ?? typed;
      if (!isPrincipal(counterpart)) {
        recordOutcome(requests, requestId, {
          status: "refused",
          reason: "The counterpart is not a principal.",
        });
        return;
      }
      if (counterpart === self) {
        recordOutcome(requests, requestId, {
          status: "refused",
          reason: "The counterpart is this user.",
        });
        return;
      }
      const known = direct.key(counterpart).get();
      if (known !== undefined) {
        if (!lists(rooms, known.room)) {
          rooms.set([...((rooms.get() ?? []) as ChatIndexEntry[]), known]);
        }
        recordOutcome(requests, requestId, { status: "done", entry: known });
        return;
      }
      const entry = createRoom(
        state,
        requestId,
        "direct",
        [counterpart],
        undefined,
        counterpart,
      );
      direct.key(counterpart).set(entry);
      recordOutcome(requests, requestId, { status: "done", entry });
      return;
    }

    if (act === "createGroup") {
      const draft = state.fromDraft === true ? state.draft.get() : undefined;
      const title = (event?.title ?? draft?.title ?? "").trim();
      if (title === "") {
        recordOutcome(requests, requestId, {
          status: "refused",
          reason: "A group room needs a title.",
        });
        return;
      }
      const members = otherMembers(
        event?.members ?? principalsIn(draft?.members ?? ""),
        self ?? "",
      );
      const entry = createRoom(state, requestId, "group", members, title);
      if (state.fromDraft === true) state.draft.set(EMPTY_DRAFT);
      recordOutcome(requests, requestId, { status: "done", entry });
      return;
    }

    const room = event?.room ?? state.room;
    if (room === undefined) return;

    if (act === "forget") {
      rooms.set(
        ((rooms.get() ?? []) as ChatIndexEntry[]).filter((entry) =>
          !equals(entry.room, room)
        ),
      );
      recordOutcome(requests, requestId, { status: "done" });
      return;
    }

    // `accept`.
    const kind = room.key("about").get()?.kind;
    if (
      spaceAccess(room) === "none" || (kind !== "direct" && kind !== "group")
    ) {
      recordOutcome(requests, requestId, {
        status: "refused",
        reason: "The room can't be read.",
      });
      return;
    }
    const counterpart = event?.counterpart;
    if (kind === "direct" && !isPrincipal(counterpart)) {
      recordOutcome(requests, requestId, {
        status: "refused",
        reason: "A direct room needs its counterpart.",
      });
      return;
    }
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
    recordOutcome(requests, requestId, { status: "done", entry });
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
export interface FabriChatManagerCoreInput extends FabriChatManagerInput {
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
  ({ myProfile, rooms, direct, requests, outgoingNotices }) => {
    const draft = new Writable.perSession<GroupDraft>(EMPTY_DRAFT);
    const selected = new Writable.perSession<{ room?: Cell<ChatRoomLink> }>(
      {},
    );
    const records = {
      myProfile,
      rooms: rooms!,
      direct: direct!,
      requests: requests!,
      outgoingNotices: outgoingNotices!,
      draft,
    };
    const newestFirst = computed(() =>
      [...((rooms!.get() ?? []) as ChatIndexEntry[])].sort((a, b) =>
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
    const noticeList = computed(
      () => [...((outgoingNotices!.get() ?? []) as ChatManagerNotice[])],
    );
    const cannotStart = computed(() => myProfile === undefined);
    const streams = {
      openDirect: commitManager({ act: "openDirect", ...records }),
      createGroup: commitManager({ act: "createGroup", ...records }),
      accept: commitManager({ act: "accept", ...records }),
      forget: commitManager({ act: "forget", ...records }),
      delivered: commitManager({ act: "delivered", ...records }),
    };
    const view = {
      rooms: newestFirst,
      direct,
      requests,
      outgoingNotices: noticeList,
      ...streams,
    };

    return {
      [NAME]: "Chats",
      [UI]: (
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-heading level={3}>Chats</cf-heading>
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
                <cf-button
                  size="sm"
                  variant="ghost"
                  onClick={commitManager({
                    act: "forget",
                    myProfile,
                    rooms: rooms!,
                    direct: direct!,
                    requests: requests!,
                    outgoingNotices: outgoingNotices!,
                    draft,
                    room: entry.room,
                  })}
                >
                  Forget
                </cf-button>
              </cf-hstack>
            ))}
          </cf-vstack>
          {hasSelection
            ? <cf-render $cell={selectedRoom} />
            : <cf-empty-state message="Choose a chat, or start one." />}
          <div
            data-ui-pattern={CHAT_START_SURFACE}
            data-ui-event-integrity={CHAT_START_SURFACE}
          >
            <cf-vstack gap="2">
              <cf-submit-input
                data-ui-action={CHAT_START_ACTION}
                inputId="fabrichat-start-direct"
                placeholder="did:key:… of the person to chat with"
                buttonText="Chat"
                disabled={cannotStart}
                onClick={streams.openDirect}
              />
              <cf-input
                $value={draft.key("title")}
                placeholder="New group's title"
              />
              <cf-textarea
                $value={draft.key("members")}
                placeholder="Members' did:key:…, one per line"
              />
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
            </cf-vstack>
          </div>
          {noticeList.map((notice) => (
            <cf-hstack gap="2" align="center">
              <cf-text variant="caption">
                Tell {notice.recipient} about their new chat
              </cf-text>
              <cf-button
                size="sm"
                variant="ghost"
                onClick={commitManager({
                  act: "delivered",
                  myProfile,
                  rooms: rooms!,
                  direct: direct!,
                  requests: requests!,
                  outgoingNotices: outgoingNotices!,
                  draft,
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
    } as Parameters<typeof FabriChatManagerCore>[0],
  );
  return {
    [NAME]: core[NAME],
    [UI]: core[UI],
    [VIEWS]: core[VIEWS],
    rooms: core.rooms,
    direct: core.direct,
    requests: core.requests,
    outgoingNotices: core.outgoingNotices,
    openDirect: core.openDirect,
    createGroup: core.createGroup,
    accept: core.accept,
    forget: core.forget,
    delivered: core.delivered,
  };
});

export default FabriChatManager;
