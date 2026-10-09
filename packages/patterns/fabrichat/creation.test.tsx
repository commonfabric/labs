/** Exercises catalog membership, replay, and validation through the manager. */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  currentPrincipal,
  equals,
  pattern,
  spaceAccess,
  spaceAccessOf,
  spaceOf,
  TESTS,
  Writable,
} from "commonfabric";
import {
  readSharedSpaceCatalog,
  type SharedSpaceCatalogStorage,
} from "../system/shared-space-catalog.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import FabriChatRoom from "./room.tsx";
import {
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
} from "./schemas.tsx";

const BOB = "did:key:z6MkBob";
const CAROL = "did:key:z6MkCaro1";
const gesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;
type HeldRoom = ChatRoomLink & { participants: Cell<ChatProfile>[] };

/** Views a pattern result as its room reference. */
function roomLink(room: unknown): Cell<ChatRoomLink>;
function roomLink(room: unknown): unknown {
  return room;
}

/** The room behind a held reference, selected without changing its identity. */
function heldRoom(room: unknown): Cell<HeldRoom>;
function heldRoom(room: unknown): unknown {
  return room;
}

/** Names a request's failure in an assertion diagnostic. */
function outcomeOf(
  requests: Record<string, ChatRequestOutcome>,
  id: string,
): string {
  const result = requests[id];
  return result?.status === "refused"
    ? result.reason
    : result?.status ?? "missing";
}

export default pattern(() => {
  const catalog = Writable.of<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  });
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const notices = Writable.of<ChatManagerNotice[]>([]);
  const profile = Writable.of<TestProfile>({ name: "Tester" });
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: catalog,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: notices,
  });
  const held = Writable.of<{ room?: Cell<HeldRoom> }>({});
  const revision = Writable.of("");
  const actor = Writable.of("");
  const hold = action(() => {
    held.key("room").set(
      requests.key("direct").key("entry").key("room").resolveAsCell(),
    );
    revision.set(manager.rooms[0]?.revision ?? "");
    actor.set(currentPrincipal() ?? "");
  });
  const forget = action(() =>
    manager.forget.send({
      requestId: "forget",
      room: held.key("room").resolveAsCell(),
      revision: revision.get(),
    })
  );
  const stale = action(() =>
    manager.forget.send({
      requestId: "stale",
      room: held.key("room").resolveAsCell(),
      revision: revision.get(),
    })
  );
  const missingRevision = action(() =>
    manager.forget.send({
      requestId: "missing-revision",
      room: held.key("room").resolveAsCell(),
    })
  );
  const invalidRoom = action(() =>
    manager.forget.send({
      requestId: "not-room",
      room: held.key("room").key("messages").resolveAsCell(),
      revision: manager.rooms[0]?.revision,
    })
  );
  const group = Writable.of<{ room?: Cell<ChatRoomLink> }>({});
  const holdGroup = action(() =>
    group.key("room").set(
      requests.key("group").key("entry").key("room").resolveAsCell(),
    )
  );
  const forgetGroup = action(() =>
    manager.forget.send({
      requestId: "forget-group",
      room: group.key("room").resolveAsCell(),
      revision: manager.rooms.find((entry) =>
        equals(entry.room, group.key("room"))
      )?.revision,
    })
  );
  const acceptGroup = action(() =>
    manager.accept.send({
      requestId: "accept-group",
      room: group.key("room").resolveAsCell(),
    })
  );
  const ownChat = FabriChatRoom({});
  const acceptOwn = action(() =>
    manager.accept.send({ requestId: "own-chat", room: roomLink(ownChat) })
  );
  const acceptSelf = action(() =>
    manager.accept.send({
      requestId: "own-direct",
      room: held.key("room").resolveAsCell(),
      counterpart: BOB,
    })
  );
  const deliver = action(() =>
    manager.delivered.send({ requestId: "delivered", id: notices.get()[0]?.id })
  );
  const ownDirect = action(() =>
    manager.openDirect.send({ requestId: "self", counterpart: actor.get() })
  );

  return {
    [TESTS]: [
      {
        action: manager.openDirect,
        event: { requestId: "direct", counterpart: BOB },
        trustedUi: gesture,
      },
      { action: hold },
      {
        assertion: assert(() =>
          manager.rooms.length === 1 && manager.rooms[0]?.counterpart === BOB &&
          notices.get().length === 1 && requests.get().direct?.status === "done"
        ),
      },
      {
        assertion: assert(() => {
          const room = heldRoom(held.key("room").resolveAsCell());
          const space = spaceOf(room);
          const entry = space
            ? readSharedSpaceCatalog(catalog).entries[space]
            : undefined;
          return entry?.kind === "fabrichat-room" && entry.state === "saved" &&
            entry.revision === revision.get() &&
            spaceAccessOf(room, BOB) === "OWNER" &&
            (held.key("room").get()?.get()?.participants ?? []).some((
              participant,
            ) => equals(participant, profile));
        }),
      },
      {
        action: manager.openDirect,
        event: { requestId: "same-person", counterpart: BOB },
        trustedUi: gesture,
      },
      {
        assertion: assert(() =>
          manager.rooms.length === 1 && notices.get().length === 1
        ),
      },
      { action: missingRevision },
      { action: invalidRoom },
      {
        assertion: assert(() =>
          requests.get()["missing-revision"]?.status === "refused" &&
          requests.get()["not-room"]?.status === "refused" &&
          manager.rooms.length === 1
        ),
      },
      { action: forget },
      {
        assertion: assert(() =>
          manager.rooms.length === 0 && manager.direct[BOB] !== undefined &&
          Object.values(readSharedSpaceCatalog(catalog).entries)[0]?.state ===
            "archived"
        ),
      },
      { action: stale },
      { assertion: assert(() => requests.get().stale?.status === "refused") },
      {
        action: manager.openDirect,
        event: { requestId: "restore", counterpart: BOB },
        trustedUi: gesture,
      },
      {
        assertion: assert(() =>
          manager.rooms.length === 1 &&
          equals(manager.rooms[0]?.room, held.key("room")) &&
          manager.rooms[0]?.revision !== revision.get()
        ),
      },
      { action: acceptSelf },
      {
        assertion: assert(() =>
          requests.get()["own-direct"]?.status === "refused"
        ),
      },
      {
        action: manager.createGroup,
        event: {
          requestId: "group",
          title: "Team",
          members: [CAROL, CAROL, actor],
        },
        trustedUi: gesture,
      },
      { action: holdGroup },
      {
        assertion: assert(() =>
          manager.rooms.length === 2 && notices.get().length === 2 &&
          Object.values(readSharedSpaceCatalog(catalog).entries).some((entry) =>
            entry.title === "Team"
          )
        ),
      },
      {
        action: manager.createGroup,
        event: { requestId: "group", title: "Changed", members: [] },
        trustedUi: gesture,
      },
      {
        assertion: assert(() =>
          manager.rooms.length === 2 &&
          group.key("room").key("about").get()?.title === "Team"
        ),
      },
      {
        assertion: assert(() =>
          group.key("room").key("about").get()?.kind === "group" &&
          spaceAccess(group.key("room")) === "OWNER" &&
          equals(
            manager.rooms.find((entry) => entry.kind === "group")?.room,
            group.key("room"),
          )
        ),
      },
      { action: forgetGroup },
      {
        assertion: assert(() =>
          outcomeOf(requests.get(), "forget-group") === "done" &&
          manager.rooms.length === 1
        ),
      },
      { action: acceptGroup },
      {
        assertion: assert(() =>
          manager.rooms.length === 2 &&
          outcomeOf(requests.get(), "accept-group") === "done"
        ),
      },
      { action: ownDirect, trustedUi: gesture },
      {
        action: manager.openDirect,
        event: { requestId: "bad-principal", counterpart: "not a principal" },
        trustedUi: gesture,
      },
      {
        action: manager.createGroup,
        event: { requestId: "bad-title", title: " ", members: [] },
        trustedUi: gesture,
      },
      {
        action: manager.createGroup,
        event: { requestId: "missing-members", title: "Missing" },
        trustedUi: gesture,
      },
      {
        action: manager.createGroup,
        event: { requestId: "bad-members", title: "Bad", members: ["invalid"] },
        trustedUi: gesture,
      },
      {
        action: manager.openDirect,
        event: { requestId: "punctuated-principal", counterpart: `${BOB}.` },
        trustedUi: gesture,
      },
      {
        action: manager.createGroup,
        event: {
          requestId: "punctuated-member",
          title: "Bad",
          members: [`${CAROL}.`],
        },
        trustedUi: gesture,
      },
      { action: manager.forget, event: { requestId: "missing-room" } },
      { action: manager.accept, event: { requestId: "missing-accept" } },
      { action: manager.delivered, event: { requestId: "missing-notice" } },
      {
        assertion: assert(() =>
          [
            "self",
            "bad-principal",
            "bad-title",
            "missing-members",
            "bad-members",
            "punctuated-principal",
            "punctuated-member",
            "missing-room",
            "missing-accept",
            "missing-notice",
          ].every((id) => requests.get()[id]?.status === "refused") &&
          manager.rooms.length === 2
        ),
      },
      { action: acceptOwn },
      {
        assertion: assert(() => {
          const result = requests.get()["own-chat"];
          return result?.status === "refused" &&
            result.code === "space-own-chat" && manager.rooms.length === 2;
        }),
      },
      { action: deliver },
      { assertion: assert(() => notices.get().length === 1) },
    ],
  };
});
