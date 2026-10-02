/** Keeps one user's conversation index and resumable private-room creations. */
import {
  action,
  type AuthoredByCurrentUser,
  Cell,
  computed,
  currentPrincipal,
  equals,
  eventKey,
  FabricEpochNsec,
  handler,
  isWellFormedDID,
  NAME,
  type OpaqueCell,
  pattern,
  principalOf,
  spaceMembers,
  type Stream,
  toSchema,
  type TrustedActionWrite,
  UI,
  viewerPrincipal,
  VIEWS,
  type VNode,
  wish,
  Writable,
  type WriteAuthorizedBy,
  type WritePolicyAnyOf,
} from "commonfabric";
import { FabriChatRoom, type StoredMemory } from "./room.tsx";
import type { SpaceChat, SpaceChatRoom } from "./space.ts";
import { CHAT_POLICY } from "./records.ts";
import type {
  ChatIndexEntry,
  ChatManagerOutput,
  ChatProfile,
  ChatRequestOutcome,
  ChatRoomAbout,
  ChatRoomLink,
  ChatRoomOutput,
  ChatRoomPolicy,
  ChatRoomRecord,
  ManagerStreamEvent,
} from "./schemas.ts";

/** A creation's immutable user choices, retained across interruptions. */
interface CreationIntent {
  creator: string;
  kind: "direct" | "group";
  counterpart?: string;
  title?: string;
  members: string[];
  joinableByLink?: boolean;
  createdAt: FabricEpochNsec;
  target?: Cell<CreationTarget>;
}

/** The private provisioning record, separate from the room's public surface. */
interface CreationTarget {
  room: SpaceChatRoom;
  registration: "missing" | "registered" | "occupied";
  register: Stream<
    { requestId: string; resume: Stream<{ requestId: string }> }
  >;
}

/** Manager storage; every room reference stays in its original space. */
interface ManagerState {
  rooms: Writable<ChatIndexEntry[]>;
  direct: Writable<Record<string, ChatIndexEntry>>;
  requests: Writable<Record<string, ChatRequestOutcome>>;
  intents: Writable<Record<string, CreationIntent>>;
  pendingDirect: Writable<Record<string, string>>;
  waiters: Writable<Record<string, string[]>>;
  outgoingNotices: Writable<
    { id: string; room: Cell<ChatRoomOutput>; recipient: string }[]
  >;
}

/** The room remains a full output when a handler stores its reference. */
type ManagerHandlerEvent = Omit<ManagerStreamEvent, "room"> & {
  room?: Cell<ChatRoomOutput>;
};

/** Resolving an event's room reads only metadata shared with its members. */
type ManagerReadEvent = Omit<ManagerStreamEvent, "room"> & {
  room?: Cell<Pick<ChatRoomLink, "about">>;
};

/** Index updates compare room references without reading their contents. */
type ManagerIndexRead = Omit<ChatIndexEntry, "room"> & {
  room: OpaqueCell<unknown>;
};

/** Shared metadata suffices for every manager handler's room dependencies. */
type ManagerReadState =
  & Omit<
    ManagerState,
    "rooms" | "direct" | "requests" | "intents" | "outgoingNotices"
  >
  & {
    rooms: Writable<ManagerIndexRead[]>;
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
          target?: Cell<
            Omit<CreationTarget, "room"> & { room: Pick<ChatRoomLink, "about"> }
          >;
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
      advance(event.requestId, state, resumeCreation(state));
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
    advance(creationId, state, state.resume);
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

/** Prepends an entry once, retaining its room's entity identity. */
function remember(entry: ChatIndexEntry, state: ManagerState): void {
  if (!state.rooms.get().some((known) => equals(known.room, entry.room))) {
    const stored = new Writable<Managed<ChatIndexEntry>>();
    stored.set(entry);
    state.rooms.set([stored, ...state.rooms.get()]);
  }
}

/** Advances a creation using only the choices recorded by its first request. */
function advance(
  requestId: string,
  state: ManagerState,
  resume: Stream<{ requestId: string }>,
): void {
  const actor = currentPrincipal();
  if (!actor) return;
  const intentCell = state.intents.key(requestId);
  const intent = intentCell.get();
  if (!intent || intent.creator !== actor) return;
  if (!intent.target) {
    const allocation = `fabrichat:${requestId}`;
    const grants = Object.fromEntries(
      intent.members.map((member) => [member, "WRITE" as const]),
    );
    if (intent.kind === "group" && intent.joinableByLink === true) {
      grants["*"] = "WRITE";
    }
    const record = RoomRecord.inSpace(allocation, { grants })({
      value: {
        kind: intent.kind,
        title: intent.title,
        createdAt: intent.createdAt,
      },
    });
    const policy = RoomPolicy.inSpace(allocation)({
      value: CHAT_POLICY,
    });
    const target = PrivateRoom.inSpace(allocation)({
      about: {
        kind: intent.kind,
        title: intent.title,
        createdAt: intent.createdAt,
        policy: policy.value,
        record: record.value,
      },
    });
    intentCell.key("target").set(target);
    return;
  }
  const target = intent.target;
  const room = target.key("room").resolveAsCell();
  const registration = target.key("registration").get();
  if (registration === "occupied") {
    refuse(requestId, "That space already has a conversation.", state);
    return;
  }
  if (registration !== "registered") {
    target.key("register").send({ requestId, resume });
    return;
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
    if (!state.outgoingNotices.get().some((notice) => notice.id === id)) {
      const notice = new Writable<
        Managed<{
          id: string;
          room: Cell<ChatRoomOutput>;
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
  event: { requestId: string; counterpart: string },
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
    !actor || !isWellFormedDID(event.counterpart) ||
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
  const waiting = state.waiters.key(creationId);
  if (!(waiting.get() ?? []).includes(event.requestId)) {
    waiting.set([...(waiting.get() ?? []), event.requestId]);
  }
  advance(creationId, state, state.resume);
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
    const counterpart = event.counterpart ??
      event.target?.dataset?.chatCounterpart ?? event.target?.value?.trim() ??
      "";
    state.latestStart?.set({ requestId, input: counterpart });
    writeOpenDirect({ requestId, counterpart }, state);
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
    members: string[];
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
    event.members.some((member) => !isWellFormedDID(member))
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
  advance(event.requestId, state, state.resume);
  state.resume.send({ requestId: event.requestId });
}

/** Admits the group protocol request from its reviewed creation surface. */
export const createGroup = handler<ManagerHandlerEvent, StartState>(
  toSchema<ManagerReadEvent>(),
  toSchema<StartReadState>(),
  (event, state) => {
    writeCreateGroup({
      requestId: event.requestId ?? eventKey(),
      members: event.members ?? [],
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
    const acl = spaceMembers(event.room);
    const about = event.room.key("about").get();
    const counterpart = about?.kind === "direct"
      ? principalOf(about.record, "authored-by")
      : undefined;
    if (
      !actor || !(acl?.[actor] ?? acl?.["*"]) || !about ||
      (about.kind === "direct" &&
        (!counterpart || !acl[counterpart] || counterpart === actor ||
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
    const entry: ChatIndexEntry = {
      room: event.room,
      kind: about.kind,
      since: new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
      ...(about.kind === "direct" ? { counterpart } : {}),
    };
    remember(entry, state);
    if (entry.counterpart && !state.direct.key(entry.counterpart).get()) {
      state.direct.key(entry.counterpart).set(entry);
    }
    state.requests.key(requestId).set({ status: "done", entry });
  },
);

/** The index fields needed to hide an entry without reading any room data. */
interface ForgetState {
  rooms: Writable<
    (Omit<ChatIndexEntry, "room"> & { room: OpaqueCell<unknown> })[]
  >;
  requests: Writable<
    Record<string, { status: "pending" | "done" | "refused"; reason?: string }>
  >;
}

/** Hides a room by link identity even after its contents become inaccessible. */
export const forget = handler<ManagerHandlerEvent, ForgetState>(
  toSchema<Omit<ManagerStreamEvent, "room"> & { room?: OpaqueCell<unknown> }>(),
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
    state.rooms.set(
      state.rooms.get().filter((entry) =>
        !Cell.equalLinks(entry.room, event.room) &&
        !equals(entry.room, event.room)
      ),
    );
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
type Created<T> = AuthoredByCurrentUser<
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

/** Stores the creator's attestation separately from the room's public view. */
const RoomRecord = pattern<
  { value: Cell<Created<ChatRoomRecord>> },
  { value: Cell<ChatRoomRecord> }
>(({ value }) => ({ value }));

/** Stores policy in a separate document within the conversation's space. */
const RoomPolicy = pattern<
  { value: Cell<Created<ChatRoomPolicy>> },
  { value: Cell<ChatRoomPolicy> }
>(({ value }) => ({ value }));

/** Claims the conversation in its own space before continuing the home index. */
const registerRoom = handler<{
  requestId: string;
  resume: Stream<{ requestId: string }>;
}, {
  space: Writable<SpaceChat | undefined>;
  room: Cell<SpaceChatRoom>;
  registration: Writable<"missing" | "registered" | "occupied">;
}>(
  (event, { space, room, registration }) => {
    const registered = space.get()?.chat;
    if (registered && !equals(registered, room)) {
      registration.set("occupied");
    } else {
      if (!registered) {
        space.key("chat").set(room);
      }
      registration.set("registered");
    }
    event.resume.send({ requestId: event.requestId });
  },
);

/** The private room's initialization belongs to its creator's reviewed request. */
const PrivateRoom = pattern<{
  about: Cell<
    Created<
      Omit<ChatRoomAbout, "policy"> & { policy: Cell<Created<ChatRoomPolicy>> }
    >
  >;
}, CreationTarget>(({ about }) => {
  const room = FabriChatRoom({
    about,
    memory: new Writable<StoredMemory>({
      requests: {},
      authors: {},
      usedTimes: {},
      nextSeq: 1,
      expiredThrough: 0,
    }),
  });
  const space = wish<Writable<SpaceChat>>({ query: "/" });
  const registration = new Writable<"missing" | "registered" | "occupied">(
    "missing",
  );
  return {
    room,
    registration,
    register: registerRoom({ space: space.result!, room, registration }),
  };
});

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

/** Owns the user's protected index, with their profile supplied by its host. */
export const FabriChatManagerCore = pattern<
  { myProfile: Cell<ChatProfile | undefined> },
  FabriChatManagerOutput
>(({ myProfile }) => {
  const state: ManagerState = {
    rooms: new Writable<Managed<ChatIndexEntry[]>>([]),
    direct: new Writable<Managed<Record<string, ChatIndexEntry>>>({}),
    requests: new Writable<Managed<Record<string, ChatRequestOutcome>>>({}),
    intents: new Writable<Managed<Record<string, CreationIntent>>>({}),
    pendingDirect: new Writable<Managed<Record<string, string>>>({}),
    waiters: new Writable<Managed<Record<string, string[]>>>({}),
    outgoingNotices: new Writable<
      Managed<{ id: string; room: Cell<ChatRoomOutput>; recipient: string }[]>
    >([]),
  };
  const latestStart = new Writable.perSession({ requestId: "", input: "" });
  const starts = {
    ...state,
    profile: myProfile,
    latestStart,
    resume: resumeCreation(state),
  };
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
  const title = new Writable.perSession("");
  const joinableByLink = new Writable.perSession(false);
  const members = new Writable.perSession("");
  const myAddress = computed(() => viewerPrincipal() ?? "");
  const selected = new Writable.perSession<{ room?: Cell<ChatRoomOutput> }>({});
  const entries = computed(() => state.rooms.get());
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
          <details id="fabrichat-start-controls">
            <summary>Start a conversation</summary>
            <cf-vstack
              gap="3"
              data-ui-pattern="ChatStartSurface"
              data-ui-event-integrity="ChatStartSurface"
            >
              <cf-submit-input
                inputId="fabrichat-start-direct"
                placeholder="Person's principal"
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
                <cf-button
                  variant="ghost"
                  onClick={action(() => selected.set({ room: entry.room }))}
                >
                  {entry.room.get()?.about?.title || (entry.kind === "direct"
                    ? `With ${entry.counterpart ?? "someone"}`
                    : "Group conversation")}
                </cf-button>
                <cf-cell-link $cell={entry.room} label="Open" />
                <cf-button
                  variant="ghost"
                  onClick={action(() =>
                    facts.forget.send({
                      requestId: eventKey(),
                      room: entry.room,
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
                <cf-cell-link $cell={notice.room} label="Open conversation" />
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
          <div id="fabrichat-selected">
            {selected.get().room !== undefined
              ? <cf-render $cell={selected.get().room} />
              : <cf-text>Select a conversation or start one.</cf-text>}
          </div>
        </cf-vstack>
      </cf-screen>
    ),
    [VIEWS]: { chats: facts },
  };
});

/** Resolves the home user's profile for their single chat manager. */
export default pattern<Record<string, never>, FabriChatManagerOutput>(() => {
  const profile = wish<ChatProfile>({ query: "#profile" });
  return FabriChatManagerCore({ myProfile: profile.result });
});
