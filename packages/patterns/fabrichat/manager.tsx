/** Keeps one user's conversation index and resumable private-room creations. */
import {
  type AuthoredByCurrentUser,
  type Cell,
  currentPrincipal,
  equals,
  FabricEpochNsec,
  handler,
  pattern,
  setSpaceMembers,
  spaceMembers,
  type Stream,
  type TrustedActionWrite,
  VIEWS,
  wish,
  Writable,
  type WriteAuthorizedBy,
  type WritePolicyAnyOf,
} from "commonfabric";
import { FabriChatRoom, type StoredMemory } from "./room.tsx";
import { CHAT_POLICY } from "./records.ts";
import type {
  ChatIndexEntry,
  ChatManagerOutput,
  ChatProfile,
  ChatRequestOutcome,
  ChatRoomAbout,
  ChatRoomOutput,
  ChatRoomPolicy,
} from "./schemas.ts";

/** A creation's immutable user choices, retained across interruptions. */
interface CreationIntent {
  creator: string;
  kind: "direct" | "group";
  counterpart?: string;
  title?: string;
  members: string[];
  createdAt: FabricEpochNsec;
  target?: Cell<CreationTarget>;
}

/** The private provisioning record, separate from the room's public surface. */
interface CreationTarget {
  room: ChatRoomOutput;
  configured: boolean;
}

/** Manager storage; every room reference stays in its original space. */
interface ManagerState {
  rooms: Writable<ChatIndexEntry[]>;
  direct: Writable<Record<string, ChatIndexEntry>>;
  requests: Writable<Record<string, ChatRequestOutcome>>;
  intents: Writable<Record<string, CreationIntent>>;
  pendingDirect: Writable<Record<string, string>>;
  outgoingNotices: Writable<
    { id: string; room: Cell<ChatRoomOutput>; recipient: string }[]
  >;
}

/** Creation handlers queue a continuation after their first durable step. */
interface StartState extends ManagerState {
  resume: Stream<{ requestId: string }>;
}

/** Continues only an intent already admitted for this authenticated creator. */
const resumeCreation = handler<{ requestId: string }, ManagerState>(
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

/** Records a terminal refusal without exposing it to the shared room. */
function refuse(requestId: string, reason: string, state: ManagerState): void {
  state.requests.key(requestId).set({ status: "refused", reason });
}

/** Prepends an entry once, retaining its room's entity identity. */
function remember(entry: ChatIndexEntry, state: ManagerState): void {
  if (!state.rooms.get().some((known) => equals(known.room, entry.room))) {
    state.rooms.set([entry, ...state.rooms.get()]);
  }
}

/** Advances a creation using only the choices recorded by its first request. */
function advance(requestId: string, state: ManagerState): void {
  const actor = currentPrincipal();
  if (!actor) return;
  const intentCell = state.intents.key(requestId);
  const intent = intentCell.get();
  if (!intent || intent.creator !== actor) return;
  if (!intent.target) {
    const allocation = `fabrichat:${requestId}`;
    const policy = RoomPolicy.inPrivateSpace(allocation)({
      value: CHAT_POLICY,
    });
    const target = PrivateRoom.inPrivateSpace(allocation)({
      initialMembers: [actor, ...intent.members],
      about: {
        kind: intent.kind,
        title: intent.title,
        createdAt: intent.createdAt,
        policy: policy.value,
      },
    });
    intentCell.key("target").set(target);
    return;
  }
  const target = intent.target;
  const room = target.key("room").resolveAsCell();
  if (!target.key("configured").get()) {
    const current = spaceMembers(target);
    if (!current || current[actor] !== "OWNER" || current["*"] !== undefined) {
      refuse(
        requestId,
        "The private room cannot be administered by this user.",
        state,
      );
      return;
    }
    const next = { ...current };
    for (const member of intent.members) next[member] ??= "WRITE";
    setSpaceMembers(next, target);
    target.key("configured").set(true);
  }
  const entry: ChatIndexEntry = {
    room,
    kind: intent.kind,
    since: intent.createdAt,
    ...(intent.counterpart ? { counterpart: intent.counterpart } : {}),
  };
  remember(entry, state);
  if (intent.counterpart) state.direct.key(intent.counterpart).set(entry);
  for (const recipient of intent.members) {
    const id = JSON.stringify([requestId, recipient]);
    const notice = state.outgoingNotices.elementById(id);
    if (!notice.get()) notice.set({ id, room, recipient });
    state.outgoingNotices.addUnique(notice);
  }
  state.requests.key(requestId).set({ status: "done", entry });
}

/** Finds the existing direct room, or resumes its single pending creation. */
export const openDirect = handler<
  { requestId: string; counterpart: string },
  StartState
>((event, state) => {
  if (!canRequest(event.requestId, state)) return;
  const actor = currentPrincipal();
  if (
    !actor || !event.counterpart?.startsWith("did:") ||
    event.counterpart === actor
  ) {
    refuse(event.requestId, "Choose another person's principal.", state);
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
      createdAt: new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    });
    state.pendingDirect.key(event.counterpart).set(creationId);
  }
  state.requests.key(event.requestId).set({ status: "pending" });
  advance(creationId, state);
  state.resume.send({ requestId: creationId });
  const outcome = state.requests.key(creationId).get();
  if (outcome && outcome.status !== "pending") {
    state.requests.key(event.requestId).set(outcome);
  }
});

/** Creates a distinct group for a new request and resumes that group on redelivery. */
export const createGroup = handler<
  { requestId: string; members: string[]; title: string },
  StartState
>((event, state) => {
  if (!canRequest(event.requestId, state)) return;
  const actor = currentPrincipal();
  if (
    !actor || typeof event.title !== "string" || !event.title.trim() ||
    !Array.isArray(event.members) || event.members.some((member) =>
      typeof member !== "string" || !member.startsWith("did:")
    )
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
      members: [...new Set(event.members)].filter((member) =>
        member !== actor
      ),
      createdAt: new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    });
  }
  state.requests.key(event.requestId).set({ status: "pending" });
  advance(event.requestId, state);
  state.resume.send({ requestId: event.requestId });
});

/** Accepts a readable admitted room; the client supplies its checked creator for a direct room. */
export const accept = handler<
  { requestId: string; room: Cell<ChatRoomOutput>; counterpart?: string },
  ManagerState
>((event, state) => {
  if (!canRequest(event.requestId, state)) return;
  const actor = currentPrincipal();
  const acl = spaceMembers(event.room);
  const about = event.room.key("about").get();
  if (
    !actor || !acl?.[actor] || !about ||
    (about.kind === "direct" &&
      (!event.counterpart || !acl[event.counterpart] ||
        event.counterpart === actor))
  ) {
    refuse(
      event.requestId,
      "This user is not admitted to that conversation.",
      state,
    );
    return;
  }
  const entry: ChatIndexEntry = {
    room: event.room,
    kind: about.kind,
    since: new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    ...(about.kind === "direct" ? { counterpart: event.counterpart } : {}),
  };
  remember(entry, state);
  if (entry.counterpart && !state.direct.key(entry.counterpart).get()) {
    state.direct.key(entry.counterpart).set(entry);
  }
  state.requests.key(event.requestId).set({ status: "done", entry });
});

/** Hides a room while retaining the direct-room mapping for reopening. */
export const forget = handler<
  { requestId: string; room: Cell<ChatRoomOutput> },
  ManagerState
>((event, state) => {
  if (!canRequest(event.requestId, state)) return;
  state.rooms.set(
    state.rooms.get().filter((entry) => !equals(entry.room, event.room)),
  );
  state.requests.key(event.requestId).set({ status: "done" });
});

/** Retires a notice after its client confirms delivery. */
export const delivered = handler<
  { requestId: string; id: string },
  ManagerState
>((event, state) => {
  if (!canRequest(event.requestId, state)) return;
  state.outgoingNotices.set(
    state.outgoingNotices.get().filter((notice) => notice.id !== event.id),
  );
  state.requests.key(event.requestId).set({ status: "done" });
});

/** Creation data can be written only by the manager's reviewed start handlers. */
type Created<T> = AuthoredByCurrentUser<
  WritePolicyAnyOf<T, [
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

/** Stores policy in a separate document within the conversation's space. */
const RoomPolicy = pattern<
  { value: Cell<Created<ChatRoomPolicy>> },
  { value: Cell<ChatRoomPolicy> }
>(({ value }) => ({ value }));

/** The private room's initialization belongs to its creator's reviewed request. */
const PrivateRoom = pattern<{
  initialMembers: string[];
  about: Cell<
    Created<
      Omit<ChatRoomAbout, "policy"> & { policy: Cell<Created<ChatRoomPolicy>> }
    >
  >;
  configured?: Writable<Managed<boolean>>;
}, CreationTarget>(({ about, configured, initialMembers }) => {
  const profile = wish<ChatProfile>({ query: "#profile" });
  const room = FabriChatRoom({
    about,
    myProfile: profile.result,
    dedicated: true,
    initialMembers,
    memory: new Writable<StoredMemory>({
      requests: {},
      authors: {},
      usedTimes: {},
      nextSeq: 1,
      expiredThrough: 0,
      left: {},
      admissions: {},
      profiles: {},
      abandoned: false,
      notices: [],
    }),
  });
  return { room, configured: configured! };
});

/** The handlers permitted to update the private index and request memory. */
type Managed<T> = WritePolicyAnyOf<T, [
  WriteAuthorizedBy<unknown, typeof resumeCreation>,
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

/** The user's single chat manager, instantiated by the home pattern. */
export default pattern<Record<string, never>, ChatManagerOutput>(() => {
  const state: ManagerState = {
    rooms: new Writable<Managed<ChatIndexEntry[]>>([]),
    direct: new Writable<Managed<Record<string, ChatIndexEntry>>>({}),
    requests: new Writable<Managed<Record<string, ChatRequestOutcome>>>({}),
    intents: new Writable<Managed<Record<string, CreationIntent>>>({}),
    pendingDirect: new Writable<Managed<Record<string, string>>>({}),
    outgoingNotices: new Writable<
      Managed<{ id: string; room: Cell<ChatRoomOutput>; recipient: string }[]>
    >([]),
  };
  const starts = { ...state, resume: resumeCreation(state) };
  const facts = {
    rooms: state.rooms,
    direct: state.direct,
    requests: state.requests,
    outgoingNotices: state.outgoingNotices,
    openDirect: openDirect(starts),
    createGroup: createGroup(starts),
    accept: accept(state),
    forget: forget(state),
    delivered: delivered(state),
  };
  return { ...facts, [VIEWS]: { chats: facts } };
});
