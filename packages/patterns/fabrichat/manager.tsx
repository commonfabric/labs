/** Keeps one user's conversation index and resumable private-room creations. */
import {
  action,
  type AuthoredByCurrentUser,
  Cell,
  computed,
  currentPrincipal,
  type Default,
  equals,
  eventKey,
  FabricEpochNsec,
  getPatternEnvironment,
  handler,
  isWellFormedDID,
  NAME,
  type OpaqueCell,
  pattern,
  principalOf,
  spaceAccess,
  spaceAccessOf,
  spaceOf,
  type Stream,
  toSchema,
  type TrustedActionWrite,
  UI,
  VIEWS,
  type VNode,
  wish,
  Writable,
  type WriteAuthorizedBy,
  type WritePolicyAnyOf,
} from "commonfabric";
import {
  OFFER_TITLE_MAX_LENGTH,
  type OfferEvent,
  type PrivateInboxOutput,
} from "../system/private-inbox.tsx";
import type { ProfileInbox, ShareInboxPiece } from "../system/profile-home.tsx";
import {
  changeSharedSpaceMembershipIn,
  isSharedSpaceCatalog,
  readSharedSpaceCatalog,
  registerSharedSpaceIn,
  type SharedSpaceCatalogStorage,
  type SharedSpaceEntry,
} from "../system/shared-space-catalog.ts";
import FabriChatRoom from "./room.tsx";
import {
  type ChatIndexEntry,
  type ChatManagerOutput,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
  isPrincipalDID,
  type ManagerStreamEvent,
} from "./schemas.tsx";

export type { ManagerStreamEvent } from "./schemas.tsx";

/** A creation's immutable user choices, retained across interruptions. */
interface CreationIntent {
  creator: string;
  kind: "direct" | "group";
  counterpart?: string;
  title?: string;
  members: string[];
  joinableByLink?: boolean;
  createdAt: FabricEpochNsec;
  profile?: Cell<ManagerProfile>;
  target?: Cell<ChatRoomLink>;
}

/** The profile pointer a manager reads when it offers a room. */
interface ManagerProfile extends ChatProfile {
  inbox?: ProfileInbox;
}

/** The catalog Home shares with its chat manager. */
export type CatalogCell = Writable<
  | SharedSpaceCatalogStorage
  | Default<
    { entries: Record<PropertyKey, never>; offers: Record<PropertyKey, never> }
  >
>;

/** Manager storage; every room reference stays in its original space. */
interface ManagerState {
  catalog: CatalogCell;
  profile: Cell<ChatProfile | undefined>;
  join: Stream<
    {
      room: Cell<{ addParticipant: Stream<{ profile: Cell<ChatProfile> }> }>;
      profile: Cell<ChatProfile>;
    }
  >;
  offer: Stream<
    {
      room: Cell<ChatRoomLink>;
      profile: Cell<ManagerProfile>;
      id: string;
      title: string;
    }
  >;
  direct: Writable<Record<string, ChatIndexEntry>>;
  requests: Writable<Record<string, ChatRequestOutcome>>;
  intents: Writable<Record<string, CreationIntent>>;
  pendingDirect: Writable<Record<string, string>>;
  waiters: Writable<Record<string, string[]>>;
  outgoingNotices: Writable<
    { id: string; room: Cell<ChatRoomLink>; recipient: string }[] | Default<[]>
  >;
}

/** The room remains a full output when a handler stores its reference. */
type ManagerHandlerEvent = Omit<ManagerStreamEvent, "room"> & {
  room?: Cell<ChatRoomLink>;
};

/** Resolving an event's room reads only metadata shared with its members. */
type ManagerReadEvent = Omit<ManagerStreamEvent, "room"> & {
  room?: Cell<Pick<ChatRoomLink, "about">>;
};

/** Index updates compare room references without reading their contents. */
type ManagerIndexRead = Omit<ChatIndexEntry, "room"> & {
  room: Cell<ChatRoomLink>;
};

/** Shared metadata suffices for every manager handler's room dependencies. */
type ManagerReadState =
  & Omit<
    ManagerState,
    "direct" | "requests" | "intents" | "outgoingNotices"
  >
  & {
    direct: Writable<Record<string, ManagerIndexRead>>;
    requests: Writable<
      Record<
        string,
        | { status: "pending" }
        | { status: "done"; entry?: ManagerIndexRead }
        | { status: "refused"; reason: string }
      >
    >;
    intents: Writable<
      Record<
        string,
        Omit<CreationIntent, "target"> & {
          target?: Cell<Pick<ChatRoomLink, "about">>;
        }
      >
    >;
    outgoingNotices: Writable<
      { id: string; room: OpaqueCell<unknown>; recipient: string }[]
    >;
  };

/** Creation handlers queue a continuation after their first durable step. */
interface StartState extends ManagerState {
  profile: Cell<ChatProfile | undefined>;
  resume: Stream<{ requestId: string }>;
  uiTitle?: Writable<string>;
  uiJoinableByLink?: Writable<boolean>;
  uiMembers?: Writable<string>;
  latestStart?: Writable<{ requestId: string; input: string }>;
}

/** Creation adds its profile and continuation to the shared-only state view. */
type StartReadState = ManagerReadState & Omit<StartState, keyof ManagerState>;

/** Continues only an intent already admitted for this authenticated creator. */
const resumeCreation = handler<{ requestId: string }, ManagerState>(
  toSchema<{ requestId: string }>(),
  toSchema<ManagerReadState>(),
  (event, state) => {
    if (state.requests.key(event.requestId).get()?.status === "pending") {
      advance(event.requestId, state);
    }
  },
);

/** Whether a request is new or has an unfinished creation to resume. */
function canRequest(requestId: string, state: ManagerState): boolean {
  if (typeof requestId !== "string" || !requestId.trim()) return false;
  const outcome = state.requests.key(requestId).get();
  return outcome === undefined || outcome.status === "pending";
}

/** Resumes the original choices before considering any redelivered payload. */
function resumePending(requestId: string, state: StartState): boolean {
  if (state.requests.key(requestId).get()?.status !== "pending") return false;
  const creationId = state.intents.key(requestId).get()
    ? requestId
    : Object.entries(state.waiters.get()).find(([, ids]) =>
      ids.includes(requestId)
    )?.[0];
  if (creationId) {
    advance(creationId, state);
    state.resume.send({ requestId: creationId });
  }
  return true;
}

/** Records a terminal refusal without exposing it to the shared room. */
function refuse(requestId: string, reason: string, state: ManagerState): void {
  state.requests.key(requestId).set({ status: "refused", reason });
  for (const waiting of state.waiters.key(requestId).get() ?? []) {
    state.requests.key(waiting).set({ status: "refused", reason });
  }
}

/** Registers a room, restoring an archived entry at its current revision. */
function remember(entry: ChatIndexEntry, state: ManagerState): void {
  const space = spaceOf(entry.room);
  if (!isWellFormedDID(space)) return;
  const known = readSharedSpaceCatalog(state.catalog).entries[space];
  if (known === undefined) {
    registerSharedSpaceIn(state.catalog, {
      space,
      host: new URL(getPatternEnvironment().apiUrl).origin,
      kind: "fabrichat-room",
      since: Number(entry.since.value / 1_000_000n),
      ...(entry.kind === "group"
        ? {
          title: entry.room.key("about").get()?.title?.slice(
            0,
            OFFER_TITLE_MAX_LENGTH,
          ),
        }
        : {}),
    });
  } else if (known.state === "archived") {
    changeSharedSpaceMembershipIn(state.catalog, {
      space,
      id: eventKey(),
      expectedRevision: known.revision,
      state: "saved",
    });
  }
}

/** Selects a profile already checked to have a value. */
function presentProfile(
  profile: Cell<ChatProfile | undefined>,
): Cell<ChatProfile>;
function presentProfile(profile: Cell<ChatProfile | undefined>): unknown {
  return profile;
}

/** Selects the room roster stream for a follow-on join event. */
function joinTarget(
  room: Cell<ChatRoomLink>,
): Cell<{ addParticipant: Stream<{ profile: Cell<ChatProfile> }> }>;
function joinTarget(room: Cell<ChatRoomLink>): unknown {
  return room;
}

/** Adds the creator or accepting user once the room's streams exist. */
const joinRoom = handler<{
  room: Cell<{ addParticipant: Stream<{ profile: Cell<ChatProfile> }> }>;
  profile: Cell<ChatProfile>;
}, Record<PropertyKey, never>>((event) => {
  if (event.profile.get() !== undefined) {
    event.room.key("addParticipant").send({
      profile: event.profile,
    });
  }
});

/** Reads an inbox's receiving stream without including its private offers. */
function receivingInbox(
  pointer: Cell<ShareInboxPiece>,
): Cell<Pick<PrivateInboxOutput, "receive">>;
function receivingInbox(pointer: Cell<ShareInboxPiece>): unknown {
  return pointer;
}

/** Offers the new room in a separate event after its space name resolves. */
const offerRoom = handler<{
  room: Cell<ChatRoomLink>;
  profile: Cell<ManagerProfile>;
  id: string;
  title: string;
}, Record<PropertyKey, never>>((event) => {
  const space = spaceOf(event.room);
  const from = currentPrincipal();
  const pointer = event.profile.key("inbox").get()?.piece;
  if (!isWellFormedDID(space) || !from || !pointer) return;
  const origin = new URL(getPatternEnvironment().apiUrl).origin;
  const offer: OfferEvent = {
    kind: "fabrichat-room",
    id: event.id,
    space,
    host: origin,
    ownerOrigin: origin,
    title: event.title.slice(0, OFFER_TITLE_MAX_LENGTH),
    from,
    sharedAt: Date.now(),
  };
  receivingInbox(pointer.resolveAsCell()).key("receive").send(offer);
});

/** Advances a creation using only the choices recorded by its first request. */
function advance(
  requestId: string,
  state: ManagerState,
): void {
  const actor = currentPrincipal();
  if (!actor) return;
  const intentCell = state.intents.key(requestId);
  const intent = intentCell.get();
  if (!intent || intent.creator !== actor) return;
  if (!intent.target) {
    const allocation = `fabrichat:${requestId}`;
    const grants: Record<string, "OWNER" | "WRITE"> = Object.fromEntries(
      intent.members.map((member) => [member, "OWNER" as const]),
    );
    if (intent.kind === "group" && intent.joinableByLink === true) {
      grants["*"] = "WRITE";
    }
    const room = FabriChatRoom.inSpace(allocation, {
      grants,
      root: true,
      spaceKind: "fabrichat-room",
    })({
      about: {
        kind: intent.kind,
        title: intent.title,
        createdAt: intent.createdAt,
      },
    });
    intentCell.key("target").set(room);
    return;
  }
  const room = intent.target.resolveAsCell();
  const space = spaceOf(room);
  if (!isWellFormedDID(space)) return;
  const entry: ChatIndexEntry = {
    room,
    kind: intent.kind,
    since: intent.createdAt,
    ...(intent.counterpart ? { counterpart: intent.counterpart } : {}),
  };
  remember(entry, state);
  if (state.profile.get() !== undefined) {
    state.join.send({
      room: joinTarget(room),
      profile: presentProfile(state.profile),
    });
  }
  if (intent.profile) {
    state.offer.send({
      room,
      profile: intent.profile,
      id: requestId,
      title: intent.title ?? "",
    });
  }
  if (intent.counterpart) state.direct.key(intent.counterpart).set(entry);
  for (const recipient of intent.members) {
    const id = JSON.stringify([requestId, recipient]);
    if (!state.outgoingNotices.get().some((notice) => notice.id === id)) {
      const notice = new Writable<
        Managed<{
          id: string;
          room: Cell<ChatRoomLink>;
          recipient: string;
        }>
      >();
      notice.set({ id, room, recipient });
      state.outgoingNotices.addUnique(notice);
    }
  }
  state.requests.key(requestId).set({ status: "done", entry });
  for (const waiting of state.waiters.key(requestId).get() ?? []) {
    state.requests.key(waiting).set({ status: "done", entry });
  }
}

/** Finds the existing direct room, or resumes its single pending creation. */
function writeOpenDirect(
  event: {
    requestId: string;
    counterpart: string;
    profile?: Cell<ManagerProfile>;
  },
  state: StartState,
): void {
  if (!canRequest(event.requestId, state)) return;
  if (resumePending(event.requestId, state)) return;
  if (!state.profile.get()) {
    refuse(
      event.requestId,
      "Create a profile before starting a conversation.",
      state,
    );
    return;
  }
  const actor = currentPrincipal();
  if (!actor) {
    refuse(event.requestId, "Sign in before starting a conversation.", state);
    return;
  }
  if (!isPrincipalDID(event.counterpart)) {
    refuse(event.requestId, "The counterpart is not a principal.", state);
    return;
  }
  if (event.counterpart === actor) {
    refuse(event.requestId, "The counterpart is this user.", state);
    return;
  }
  if (
    event.profile &&
    principalOf(event.profile, "represents-principal") !== event.counterpart
  ) {
    refuse(event.requestId, "The profile is not the counterpart's.", state);
    return;
  }
  const existing = state.direct.key(event.counterpart).get();
  if (existing) {
    remember(existing, state);
    state.requests.key(event.requestId).set({
      status: "done",
      entry: existing,
    });
    return;
  }
  const creationId = state.pendingDirect.key(event.counterpart).get() ??
    event.requestId;
  if (!state.intents.key(creationId).get()) {
    state.intents.key(creationId).set({
      creator: actor,
      kind: "direct",
      counterpart: event.counterpart,
      members: [event.counterpart],
      ...(event.profile ? { profile: event.profile } : {}),
      createdAt: new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    });
    state.pendingDirect.key(event.counterpart).set(creationId);
  }
  state.requests.key(event.requestId).set({ status: "pending" });
  const waiting = state.waiters.key(creationId);
  if (!(waiting.get() ?? []).includes(event.requestId)) {
    waiting.set([...(waiting.get() ?? []), event.requestId]);
  }
  advance(creationId, state);
  state.resume.send({ requestId: creationId });
  const outcome = state.requests.key(creationId).get();
  if (outcome && outcome.status !== "pending") {
    state.requests.key(event.requestId).set(outcome);
  }
}

/** Admits the protocol request from its reviewed creation surface. */
export const openDirect = handler<ManagerHandlerEvent, StartState>(
  toSchema<ManagerReadEvent>(),
  toSchema<StartReadState>(),
  (event, state) => {
    const requestId = event.requestId ?? eventKey();
    const named = event.target?.name;
    const namedPrincipal = named === undefined
      ? undefined
      : principalOf(named, "represents-principal");
    // Deployed chips may still name a principal without carrying a profile.
    // TODO(danfuzz): Remove the dataset fallbacks once no deployed room sends
    // them, and record the resulting event-contract break.
    const counterpart = event.counterpart ?? namedPrincipal ??
      event.target?.dataset?.counterpart ??
      event.target?.dataset?.chatCounterpart ?? event.target?.value?.trim() ??
      "";
    state.latestStart?.set({ requestId, input: counterpart });
    const profile = event.profile ??
      (namedPrincipal === undefined ? undefined : named);
    writeOpenDirect({ requestId, counterpart, profile }, state);
  },
);

/** Starts a direct room for the principal entered in the reviewed control. */
const openDirectFromUi = handler<{ target?: { value?: string } }, StartState>(
  toSchema<{ target?: { value?: string } }>(),
  toSchema<StartReadState>(),
  (event, state) => {
    const requestId = eventKey();
    const counterpart = event.target?.value?.trim() ?? "";
    state.latestStart?.set({ requestId, input: counterpart });
    writeOpenDirect({ requestId, counterpart }, state);
  },
);

/** Creates a distinct group for a new request and resumes that group on redelivery. */
function writeCreateGroup(
  event: {
    requestId: string;
    members?: string[];
    title: string;
    joinableByLink?: boolean;
  },
  state: StartState,
): void {
  if (!canRequest(event.requestId, state)) return;
  if (resumePending(event.requestId, state)) return;
  if (!state.profile.get()) {
    refuse(
      event.requestId,
      "Create a profile before starting a conversation.",
      state,
    );
    return;
  }
  const actor = currentPrincipal();
  if (
    !actor || typeof event.title !== "string" || !event.title.trim() ||
    !Array.isArray(event.members) ||
    event.members.some((member) => !isPrincipalDID(member))
  ) {
    refuse(
      event.requestId,
      "A group requires a title and valid member principals.",
      state,
    );
    return;
  }
  if (!state.intents.key(event.requestId).get()) {
    state.intents.key(event.requestId).set({
      creator: actor,
      kind: "group",
      title: event.title,
      joinableByLink: event.joinableByLink === true,
      members: [...new Set(event.members)].filter((member) => member !== actor),
      createdAt: new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    });
  }
  state.requests.key(event.requestId).set({ status: "pending" });
  advance(event.requestId, state);
  state.resume.send({ requestId: event.requestId });
}

/** Admits the group protocol request from its reviewed creation surface. */
export const createGroup = handler<ManagerHandlerEvent, StartState>(
  toSchema<ManagerReadEvent>(),
  toSchema<StartReadState>(),
  (event, state) => {
    writeCreateGroup({
      requestId: event.requestId ?? eventKey(),
      members: event.members,
      title: event.title?.trim() ?? "",
      joinableByLink: event.joinableByLink,
    }, state);
  },
);

/** Captures a group title and the principals shown in its start control. */
const createGroupFromUi = handler<{ target?: { value?: string } }, StartState>(
  toSchema<{ target?: { value?: string } }>(),
  toSchema<StartReadState>(),
  (event, state) => {
    const requestId = eventKey();
    const input = state.uiMembers?.get() ?? event.target?.value ?? "";
    state.latestStart?.set({ requestId, input });
    writeCreateGroup({
      requestId,
      title: state.uiTitle?.get() ?? "",
      members: input.split(/[\s,]+/u).filter(Boolean),
      joinableByLink: state.uiJoinableByLink?.get() === true,
    }, state);
  },
);

/** Accepts an admitted room and verifies a direct room's attested creator. */
export const accept = handler<ManagerHandlerEvent, ManagerState>(
  toSchema<ManagerReadEvent>(),
  toSchema<ManagerReadState>(),
  (event, state) => {
    const requestId = event.requestId ?? eventKey();
    if (!canRequest(requestId, state)) return;
    if (!event.room) {
      refuse(requestId, "Choose a conversation to add.", state);
      return;
    }
    const actor = currentPrincipal();
    if (state.profile.get() === undefined) {
      refuse(
        requestId,
        "Create a profile before accepting a conversation.",
        state,
      );
      return;
    }
    const access = spaceAccess(event.room);
    const about = event.room.key("about").get();
    const counterpart = about?.kind === "direct"
      ? principalOf(about.record, "authored-by")
      : undefined;
    if (
      !actor ||
      (access !== "READ" && access !== "WRITE" && access !== "OWNER") ||
      !about ||
      (about.kind === "direct" &&
        (!counterpart ||
          !(["READ", "WRITE", "OWNER"] as const).some((level) =>
            spaceAccessOf(event.room, counterpart) === level
          ) ||
          counterpart === actor ||
          (event.counterpart !== undefined &&
            event.counterpart !== counterpart)))
    ) {
      refuse(
        requestId,
        "This user is not admitted to that conversation.",
        state,
      );
      return;
    }
    if (about.record?.get()?.kind === undefined) {
      state.requests.key(requestId).set({
        status: "refused",
        reason: "A social space's own chat cannot be listed here.",
        code: "space-own-chat",
      });
      return;
    }
    const entry: ChatIndexEntry = {
      room: event.room,
      kind: about.kind,
      since: new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
      ...(about.kind === "direct" ? { counterpart } : {}),
    };
    remember(entry, state);
    state.join.send({
      room: joinTarget(event.room),
      profile: presentProfile(state.profile),
    });
    if (entry.counterpart && !state.direct.key(entry.counterpart).get()) {
      state.direct.key(entry.counterpart).set(entry);
    }
    state.requests.key(requestId).set({ status: "done", entry });
  },
);

/** The index fields needed to hide an entry without reading any room data. */
interface ForgetState {
  catalog: CatalogCell;
  direct: Writable<Record<string, ManagerIndexRead>>;
  requests: Writable<
    Record<string, { status: "pending" | "done" | "refused"; reason?: string }>
  >;
}

/** Archives a room at the revision its caller observed. */
export const forget = handler<ManagerHandlerEvent, ForgetState>(
  toSchema<ManagerReadEvent>(),
  toSchema<ForgetState>(),
  (event, state) => {
    const requestId = event.requestId ?? eventKey();
    if (!requestId.trim()) return;
    const prior = state.requests.key(requestId).get();
    if (prior && prior.status !== "pending") return;
    if (!event.room) {
      state.requests.key(requestId).set({
        status: "refused",
        reason: "Choose a conversation to forget.",
      });
      return;
    }
    if (!event.revision) {
      state.requests.key(requestId).set({
        status: "refused",
        reason: "The request names no revision of the room's entry.",
      });
      return;
    }
    const space = spaceOf(event.room);
    const entry = isWellFormedDID(space)
      ? readSharedSpaceCatalog(state.catalog).entries[space]
      : undefined;
    const known = Object.values(state.direct.get()).find((entry) =>
      spaceOf(entry.room) === space
    )?.room;
    if (
      known
        ? !Cell.equalLinks(known, event.room) && !equals(known, event.room)
        : !event.room.key("about").get()?.record
    ) {
      state.requests.key(requestId).set({
        status: "refused",
        reason: "The request names no room.",
      });
      return;
    }
    if (!entry || entry.kind !== "fabrichat-room" || entry.state !== "saved") {
      state.requests.key(requestId).set({
        status: "refused",
        reason: "The room is no longer listed at that revision.",
      });
      return;
    }
    const outcome = changeSharedSpaceMembershipIn(state.catalog, {
      space: entry.space,
      id: eventKey(),
      expectedRevision: event.revision,
      state: "archived",
    });
    if (outcome.status === "conflict") {
      state.requests.key(requestId).set({
        status: "refused",
        reason: "The room's entry has changed since this list was read.",
      });
      return;
    }
    state.requests.key(requestId).set({ status: "done" });
  },
);

/** Retires a notice after its client confirms delivery. */
export const delivered = handler<ManagerHandlerEvent, ManagerState>(
  toSchema<ManagerReadEvent>(),
  toSchema<ManagerReadState>(),
  (event, state) => {
    const requestId = event.requestId ?? eventKey();
    if (!canRequest(requestId, state)) return;
    if (!event.id?.trim()) {
      refuse(requestId, "Choose a notice to mark delivered.", state);
      return;
    }
    state.outgoingNotices.set(
      state.outgoingNotices.get().filter((notice) => notice.id !== event.id),
    );
  },
);

/** Creation data can be written only by the manager's reviewed start handlers. */
export type Created<T> = AuthoredByCurrentUser<
  WritePolicyAnyOf<T, [
    TrustedActionWrite<
      unknown,
      typeof openDirectFromUi,
      "ChatStart",
      "ChatStartSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof createGroupFromUi,
      "ChatStart",
      "ChatStartSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof openDirect,
      "ChatStart",
      "ChatStartSurface"
    >,
    TrustedActionWrite<
      unknown,
      typeof createGroup,
      "ChatStart",
      "ChatStartSurface"
    >,
  ]>
>;

/** The handlers permitted to update the private index and request memory. */
type Managed<T> = WritePolicyAnyOf<T, [
  WriteAuthorizedBy<unknown, typeof resumeCreation>,
  TrustedActionWrite<
    unknown,
    typeof openDirectFromUi,
    "ChatStart",
    "ChatStartSurface"
  >,
  TrustedActionWrite<
    unknown,
    typeof createGroupFromUi,
    "ChatStart",
    "ChatStartSurface"
  >,
  TrustedActionWrite<
    unknown,
    typeof openDirect,
    "ChatStart",
    "ChatStartSurface"
  >,
  TrustedActionWrite<
    unknown,
    typeof createGroup,
    "ChatStart",
    "ChatStartSurface"
  >,
  WriteAuthorizedBy<unknown, typeof accept>,
  WriteAuthorizedBy<unknown, typeof forget>,
  WriteAuthorizedBy<unknown, typeof delivered>,
]>;

/** The manager's protocol and its rendered page. */
export type FabriChatManagerOutput = ChatManagerOutput & {
  [UI]: VNode;
  [NAME]: string;
};

/** Inputs whose cells may be shared with Home or an embedding host. */
export interface FabriChatManagerInput {
  sharedSpaceCatalog?: CatalogCell;
  direct?: Writable<
    Record<string, ChatIndexEntry> | Default<Record<PropertyKey, never>>
  >;
  requests?: Writable<
    Record<string, ChatRequestOutcome> | Default<Record<PropertyKey, never>>
  >;
  outgoingNotices?: Writable<
    { id: string; room: Cell<ChatRoomLink>; recipient: string }[] | Default<[]>
  >;
}

/** A saved catalog room resolved at its space's default root. */
const FoundRoom = pattern<{ space: string }, { room?: Cell<ChatRoomLink> }>(
  ({ space }) => {
    const root = wish<Cell<ChatRoomLink>>({
      query: "#default",
      scope: computed(() => isWellFormedDID(space) ? [space] : []),
    });
    return { room: root.result };
  },
);

/** Owns the user's protected index, with their profile supplied by its host. */
export const FabriChatManagerCore = pattern<
  FabriChatManagerInput & { myProfile: Cell<ChatProfile | undefined> },
  FabriChatManagerOutput
>(({ myProfile, sharedSpaceCatalog, direct, requests, outgoingNotices }) => {
  const catalog = sharedSpaceCatalog ??
    new Writable<SharedSpaceCatalogStorage>({ entries: {}, offers: {} });
  const state: ManagerState = {
    catalog,
    profile: myProfile,
    join: joinRoom({}),
    offer: offerRoom({}),
    direct: direct ?? new Writable<Managed<Record<string, ChatIndexEntry>>>({}),
    requests: requests ??
      new Writable<Managed<Record<string, ChatRequestOutcome>>>({}),
    intents: new Writable<Managed<Record<string, CreationIntent>>>({}),
    pendingDirect: new Writable<Managed<Record<string, string>>>({}),
    waiters: new Writable<Managed<Record<string, string[]>>>({}),
    outgoingNotices: outgoingNotices ?? new Writable<
      Managed<{ id: string; room: Cell<ChatRoomLink>; recipient: string }[]>
    >([]),
  };
  const savedRooms = computed((): SharedSpaceEntry[] => {
    const stored = catalog.get();
    return isSharedSpaceCatalog(stored)
      ? Object.values(stored.entries).filter((entry) =>
        entry.kind === "fabrichat-room" && entry.state === "saved"
      )
      : [];
  });
  const foundRooms = savedRooms.map((entry) =>
    FoundRoom({ space: entry.space })
  );
  const entries = computed((): ChatIndexEntry[] =>
    savedRooms.flatMap((entry, index): ChatIndexEntry[] => {
      const room = foundRooms[index]?.room;
      const about = room?.key("about").get();
      if (!room || !about) return [];
      const known = Object.entries(state.direct.get()).find(([, value]) =>
        spaceOf(value.room) === entry.space
      )?.[0];
      const creator = principalOf(about.record, "authored-by");
      const counterpart = known ??
        (creator ===
            principalOf(presentProfile(myProfile), "represents-principal")
          ? undefined
          : creator);
      return [{
        room,
        kind: about.kind,
        since: new FabricEpochNsec(BigInt(entry.since ?? 0) * 1_000_000n),
        revision: entry.revision,
        ...(about.kind === "direct" && counterpart ? { counterpart } : {}),
      }];
    }).sort((a, b) =>
      a.since.value > b.since.value ? -1 : a.since.value < b.since.value ? 1 : 0
    )
  );
  const latestStart = new Writable.perSession({ requestId: "", input: "" });
  const starts = {
    ...state,
    profile: myProfile,
    latestStart,
    resume: resumeCreation(state),
  };
  const facts = {
    rooms: entries,
    sharedSpaceCatalog: catalog,
    direct: state.direct,
    requests: state.requests,
    outgoingNotices: state.outgoingNotices,
    openDirect: openDirect(starts),
    createGroup: createGroup(starts),
    accept: accept(state),
    forget: forget(state),
    delivered: delivered(state),
  };
  const title = new Writable.perSession("");
  const joinableByLink = new Writable.perSession(false);
  const members = new Writable.perSession("");
  const myAddress = computed(() =>
    principalOf(presentProfile(myProfile), "represents-principal") ?? ""
  );
  const latestOutcome = computed(() =>
    state.requests.key(latestStart.get().requestId).get()
  );
  return {
    ...facts,
    [NAME]: "Conversations",
    [UI]: (
      <cf-screen>
        <cf-heading slot="header" level={2}>Conversations</cf-heading>
        <cf-vstack padding="4" gap="4">
          <cf-hstack id="fabrichat-my-address" gap="2">
            <cf-text>Your chat address: {myAddress}</cf-text>
            <cf-copy-button text={myAddress} />
          </cf-hstack>
          <details id="fabrichat-start-controls" open>
            <summary>Start a conversation</summary>
            <cf-vstack
              gap="3"
              data-ui-pattern="ChatStartSurface"
              data-ui-event-integrity="ChatStartSurface"
            >
              <cf-submit-input
                inputId="fabrichat-start-direct"
                placeholder="Person's principal"
                disabled={myProfile.get() === undefined}
                buttonText="Start direct conversation"
                data-ui-action="ChatStart"
                onClick={openDirectFromUi(starts)}
              />
              <cf-input
                id="fabrichat-group-title"
                $value={title}
                placeholder="Group title"
              />
              <cf-checkbox $checked={joinableByLink}>
                Anyone with its link can join
              </cf-checkbox>
              <cf-textarea
                id="fabrichat-group-members"
                $value={members}
                placeholder="Member principals, separated by commas"
              />
              <cf-button
                data-ui-action="ChatStart"
                disabled={myProfile.get() === undefined}
                onClick={createGroupFromUi({
                  ...starts,
                  uiTitle: title,
                  uiMembers: members,
                  uiJoinableByLink: joinableByLink,
                })}
              >
                Create group
              </cf-button>
            </cf-vstack>
          </details>
          <cf-text id="fabrichat-start-refusal">
            {latestOutcome?.status === "pending"
              ? "Creating conversation…"
              : latestOutcome?.status === "refused"
              ? `${latestOutcome.reason} ${latestStart.get().input}`
              : ""}
          </cf-text>
          <cf-vstack id="fabrichat-rooms" gap="2">
            {entries.map((entry) => (
              <cf-hstack gap="2">
                <cf-cell-link
                  $cell={entry.room}
                  label={entry.room.get()?.about?.title ||
                    (entry.kind === "direct"
                      ? `With ${entry.counterpart ?? "someone"}`
                      : "Group conversation")}
                />
                <cf-button
                  variant="ghost"
                  onClick={action(() =>
                    facts.forget.send({
                      requestId: eventKey(),
                      room: entry.room,
                      revision: entry.revision,
                    })
                  )}
                >
                  Forget
                </cf-button>
              </cf-hstack>
            ))}
          </cf-vstack>
          <cf-vstack id="fabrichat-outgoing-notices" gap="2">
            {state.outgoingNotices.get().map((notice) => (
              <cf-hstack gap="2">
                <cf-text>Send to {notice.recipient}</cf-text>
                <cf-cell-link $cell={notice.room} />
                <cf-button
                  onClick={action(() =>
                    facts.delivered.send({
                      requestId: eventKey(),
                      id: notice.id,
                    })
                  )}
                >
                  Delivered
                </cf-button>
              </cf-hstack>
            ))}
          </cf-vstack>
        </cf-vstack>
      </cf-screen>
    ),
    [VIEWS]: { chats: facts },
  };
});

/** Resolves the home user's profile for their single chat manager. */
export default pattern<FabriChatManagerInput, FabriChatManagerOutput>(
  (input) => {
    const profile = wish<ChatProfile>({ query: "#profile" });
    return FabriChatManagerCore({
      sharedSpaceCatalog: input.sharedSpaceCatalog,
      direct: input.direct,
      requests: input.requests,
      outgoingNotices: input.outgoingNotices,
      myProfile: profile.result,
    });
  },
);
