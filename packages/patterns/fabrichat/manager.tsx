/** Keeps one user's conversation index and resumable private-room creations. */
import {
  action,
  type AuthoredByCurrentUser,
  Cell,
  computed,
  currentPrincipal,
  equals,
  FabricEpochNsec,
  handler,
  NAME,
  type OpaqueCell,
  pattern,
  setSpaceMembers,
  spaceMembers,
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
import { FabriChatRoom, type StoredMemory } from "./room.tsx";
import { chatPolicy } from "./records.ts";
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
  waiters: Writable<Record<string, string[]>>;
  outgoingNotices: Writable<
    { id: string; room: Cell<ChatRoomOutput>; recipient: string }[]
  >;
}

/** Creation handlers queue a continuation after their first durable step. */
interface StartState extends ManagerState {
  profile: Cell<ChatProfile | undefined>;
  resume: Stream<{ requestId: string }>;
  uiTitle?: Writable<string>;
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

/** Prepends an entry once, retaining its room's entity identity. */
function remember(entry: ChatIndexEntry, state: ManagerState): void {
  if (!state.rooms.get().some((known) => equals(known.room, entry.room))) {
    const stored = new Writable<Managed<ChatIndexEntry>>();
    stored.set(entry);
    state.rooms.set([stored, ...state.rooms.get()]);
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
      value: chatPolicy(),
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
export const openDirect = handler<
  { requestId: string; counterpart: string },
  StartState
>((event, state) => writeOpenDirect(event, state));

/** Starts a direct room for the principal entered in the reviewed control. */
const openDirectFromUi = handler<{ target?: { value?: string } }, StartState>((
  event,
  state,
) =>
  writeOpenDirect({
    requestId: newRequestId(),
    counterpart: event.target?.value?.trim() ?? "",
  }, state)
);

/** Creates a distinct group for a new request and resumes that group on redelivery. */
function writeCreateGroup(
  event: { requestId: string; members: string[]; title: string },
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
    event.members.some((member) =>
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
      members: [...new Set(event.members)].filter((member) => member !== actor),
      createdAt: new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    });
  }
  state.requests.key(event.requestId).set({ status: "pending" });
  advance(event.requestId, state);
  state.resume.send({ requestId: event.requestId });
}

/** Admits the group protocol request from its reviewed creation surface. */
export const createGroup = handler<
  { requestId: string; members: string[]; title: string },
  StartState
>((event, state) => writeCreateGroup(event, state));

/** Captures a group title and the principals shown in its start control. */
const createGroupFromUi = handler<{ target?: { value?: string } }, StartState>((
  event,
  state,
) =>
  writeCreateGroup({
    requestId: newRequestId(),
    title: state.uiTitle?.get() ?? "",
    members: (event.target?.value ?? "").split(/[\s,]+/u).filter(Boolean),
  }, state)
);

/** Gives each independent UI request its own idempotency key. */
function newRequestId(): string {
  return Array.from(
    { length: 4 },
    () =>
      Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, "0"),
  ).join("");
}

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

/** The index fields needed to hide an entry without reading any room data. */
interface ForgetState {
  rooms: Writable<
    (Omit<ChatIndexEntry, "room"> & { room: OpaqueCell<unknown> })[]
  >;
  requests: Writable<
    Record<string, { status: "pending" | "done" | "refused" }>
  >;
}

/** Hides a room by link identity even after its contents become inaccessible. */
export const forget = handler<
  { requestId: string; room: Cell<ChatRoomOutput> },
  ForgetState
>(
  toSchema<{ requestId: string; room: OpaqueCell<unknown> }>(),
  toSchema<ForgetState>(),
  (event, state) => {
    if (!event.requestId.trim()) return;
    const prior = state.requests.key(event.requestId).get();
    if (prior && prior.status !== "pending") return;
    state.rooms.set(
      state.rooms.get().filter((entry) =>
        !Cell.equalLinks(entry.room, event.room) &&
        !equals(entry.room, event.room)
      ),
    );
    state.requests.key(event.requestId).set({ status: "done" });
  },
);

/** Retires a notice after its client confirms delivery. */
export const delivered = handler<
  { requestId: string; id: string },
  ManagerState
>((event, state) => {
  if (!canRequest(event.requestId, state)) return;
  state.outgoingNotices.set(
    state.outgoingNotices.get().filter((notice) => notice.id !== event.id),
  );
});

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
}, CreationTarget>(({ about, initialMembers }) => {
  const configured = new Writable<Managed<boolean>>(false);
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
  return { room, configured };
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

/** The user's single chat manager, instantiated by the home pattern. */
export default pattern<
  Record<string, never>,
  ChatManagerOutput & { [UI]: VNode; [NAME]: string }
>(() => {
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
  const profile = wish<ChatProfile>({ query: "#profile" });
  const starts = {
    ...state,
    profile: profile.result,
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
  const selected = new Writable.perSession<{ room?: Cell<ChatRoomOutput> }>({});
  const entries = computed(() => state.rooms.get());
  const outcomes = computed(() =>
    Object.entries(state.requests.get()).filter(([, outcome]) =>
      outcome.status !== "done"
    ).map(([id, outcome]) => ({ id, ...outcome }))
  );
  return {
    ...facts,
    [NAME]: "Conversations",
    [UI]: (
      <cf-screen>
        <cf-heading slot="header" level={2}>Conversations</cf-heading>
        <cf-vstack padding="4" gap="4">
          <details>
            <summary>Start a conversation</summary>
            <cf-vstack
              gap="3"
              data-ui-pattern="ChatStartSurface"
              data-ui-event-integrity="ChatStartSurface"
            >
              <cf-submit-input
                placeholder="Person's principal"
                buttonText="Start direct conversation"
                data-ui-action="ChatStart"
                onClick={openDirectFromUi(starts)}
              />
              <cf-input $value={title} placeholder="Group title" />
              <cf-submit-input
                placeholder="Member principals, separated by commas"
                buttonText="Create group"
                data-ui-action="ChatStart"
                onClick={createGroupFromUi({ ...starts, uiTitle: title })}
              />
            </cf-vstack>
          </details>
          {outcomes.map((outcome) => (
            <cf-text>
              {outcome.status === "pending"
                ? "Creating conversation…"
                : outcome.status === "refused"
                ? outcome.reason
                : ""}
            </cf-text>
          ))}
          {entries.map((entry) => (
            <cf-hstack gap="2">
              <cf-button
                variant="ghost"
                onClick={action(() => selected.set({ room: entry.room }))}
              >
                {entry.room.get()?.about?.title || (entry.kind === "direct"
                  ? "Direct conversation"
                  : "Group conversation")}
              </cf-button>
              <cf-button
                variant="ghost"
                onClick={action(() =>
                  facts.forget.send({
                    requestId: newRequestId(),
                    room: entry.room,
                  })
                )}
              >
                Forget
              </cf-button>
            </cf-hstack>
          ))}
          {selected.get().room?.get() !== undefined
            ? <cf-render $cell={selected.get().room} />
            : <cf-text>Select a conversation or start one.</cf-text>}
        </cf-vstack>
      </cf-screen>
    ),
    [VIEWS]: { chats: facts },
  };
});
