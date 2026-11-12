/**
 * What a fresh client of a person's Home loads in the spaces of the person's
 * FabriChat rooms while it brings Home up and lists the rooms, the way a
 * client that draws natively does: nothing, at any point, however many rooms
 * there are, and whatever another client of the person's derived before it. The
 * manager lists a room from its own records, and every link to a room those
 * records hold is a handle that declares nothing of the room, so neither
 * Home's sync nor a read of the list reaches a room's space. A client loads a
 * room's documents when a read of its reaches the room, and its bring-up
 * names nothing a node reads past a link into another space, so what the
 * manager's view or its `people` declare of the rooms is read only by whoever
 * reads them. A room is
 * checked when it is opened, which is where a deleted room, or one that no
 * longer admits the person, is refused.
 *
 * Each client is a runtime of its own, beside an in-process storage server,
 * in the posture the run resolves, as `multi-runtime-harness.ts` resolves it:
 * with server execution on, the server is a serving one, whose loop computes
 * and stores what the clients' Homes derive. No toolshed or browser required.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { Identity } from "@commonfabric/identity";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { isDeletedSpaceError } from "@commonfabric/memory/v2/client";
import {
  ACLManager,
  type Cell,
  isCell,
  type MemorySpace,
} from "@commonfabric/runner";
import { namesInstancesByDefault } from "@commonfabric/runner/storage/cache.deno";
import {
  CHAT_START,
  closeMember,
  type MemberSession,
  MemberWaits,
  openMember,
  sendTrusted,
} from "./fabrichat-room-fixture.ts";
import {
  type ListeningServingMemoryServer,
  listenServingMemoryServer,
  runsInWorker,
} from "@commonfabric/runner/executor/serving-memory-server.deno";
import { getTimingStatsBreakdown } from "@commonfabric/logger";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import {
  claimPatternEnvironment,
  resolveServerExecution,
  systemPatternsRoute,
} from "./multi-runtime-harness.ts";
import {
  initializePiecesController,
  moduleByteCache,
  type PiecesController,
} from "./pieces-controller.ts";

/** How many rooms the person keeps, besides the two that are gone. */
const ROOMS = 3;

/** A room link as a list reads it: a handle that declares nothing of it. */
const HANDLE = { type: "unknown", asCell: ["cell"] } as const;

/** One row of the list, as a client that draws natively declares it. */
const ROW = {
  type: "object",
  properties: {
    room: HANDLE,
    kind: { type: "string" },
    counterpart: { type: "string" },
    since: {},
    title: { type: "string" },
  },
} as const;

/** What a client that draws natively reads of the manager's chats view. */
const CHATS = {
  type: "object",
  properties: {
    rooms: { type: "array", items: ROW },
    requests: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          status: { type: "string" },
          reason: { type: "string" },
          entry: ROW,
        },
      },
    },
    sharedSpaceCatalog: {
      type: "object",
      properties: {
        entries: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: { kind: { type: "string" }, title: { type: "string" } },
          },
        },
      },
    },
  },
} as const;

/** A row of the list, as it arrives. */
interface Row {
  room: Cell<unknown>;
  kind: string;
  counterpart?: string;
  title?: string;
}

/** The chats view, as it arrives. */
interface Chats {
  rooms?: Row[];
}

/** A fresh client of the person's Home, and what it has loaded since it began. */
interface Client {
  controller: PiecesController;
  home: Cell<unknown>;
  waits: MemberWaits;

  /** The documents each space has delivered to this client, by space. */
  arrived: Map<string, Set<string>>;

  /** The spaces this client was refused, each with the error it got. */
  refused: Map<string, Error>;
}

describe("fabrichat-room-list", () => {
  let server: StandaloneMemoryServer | ListeningServingMemoryServer;
  let owner: Identity;
  let bob: Identity;

  /** The spaces of the rooms the person keeps, in the order they were made. */
  const kept: DID[] = [];

  /** A room deleted after it was listed. */
  let deleted: DID;

  /** A room whose space no longer admits the person. */
  let revoked: DID;

  /**
   * Waits for `controller`'s writes to reach the server, for what the serving
   * loop does in answer, when there is one, and for `controller` to have
   * heard of it.
   */
  async function settle(controller: PiecesController): Promise<void> {
    await controller.runtime.idle();
    await controller.synced();
    await served?.host.host?.whenQuiescent();
    await served?.idle();
    await controller.synced();
  }

  /** Has `member` create a group with `members`, and returns its space. */
  async function createGroup(
    member: MemberSession,
    requestId: string,
    title: string,
    members: readonly DID[] = [],
  ): Promise<DID> {
    const manager = member.home.key("chatManager");
    await sendTrusted(member.controller, manager.key("createGroup"), {
      requestId,
      title,
      members,
    }, CHAT_START);
    const outcome = await member.waits.until(
      `the creation of ${title}`,
      manager.key("requests").key(requestId) as Cell<
        { status?: string; reason?: string } | undefined
      >,
      (value) => value?.status !== undefined,
    );
    if (outcome.status !== "done") {
      throw new Error(`The manager refused ${title}: ${outcome.reason}`);
    }
    await settle(member.controller);
    const room = await manager.key("requests").key(requestId).key("entry")
      .key("room").asSchema<Cell<unknown>>(HANDLE).pull();
    return room.space as DID;
  }

  /**
   * Starts a runtime of `person`'s that records every document a space
   * delivers to it and every space it is refused, from its start on, and
   * brings up nothing.
   */
  async function startRecording(person: Identity): Promise<{
    controller: PiecesController;
    arrived: Map<string, Set<string>>;
    refused: Map<string, Error>;
  }> {
    const controller = await initializePiecesController({
      space: person.did(),
      apiUrl: server.url,
      identity: person,
    });
    const arrived = new Map<string, Set<string>>();
    const refused = new Map<string, Error>();
    controller.runtime.storageManager.subscribe({
      next(notification) {
        if (
          notification.type === "load" || notification.type === "pull" ||
          notification.type === "integrate"
        ) {
          const ids = arrived.get(notification.space) ?? new Set<string>();
          for (const change of notification.changes) {
            ids.add(change.address.id);
          }
          arrived.set(notification.space, ids);
        }
        return undefined;
      },
    });
    controller.runtime.storageManager.subscribeSpaceAccessLoss?.(
      (space, error) => refused.set(space, error),
    );
    return { controller, arrived, refused };
  }

  /**
   * Starts a fresh client of `person`'s Home, the person's unless another is
   * named, recording every document a space delivers to it and every space
   * it is refused, from before Home is brought up, and brings Home up, with
   * the housekeeping that adopts the catalog's rooms unless `adopt` is false.
   * With `early`, the client subscribes to the chats view before Home is
   * brought up, and holds it.
   */
  async function bootClient(
    { adopt = true, early = false, person = owner } = {},
  ): Promise<Client> {
    const { controller, arrived, refused } = await startRecording(person);
    const waits = new MemberWaits(controller.runtime.scheduler);
    if (early) {
      const root = await controller.getDefaultPattern(false);
      if (root === undefined) throw new Error("The person has no Home");
      root.key("chatManager").key("$VIEWS").key("chats").asSchema<Chats>(CHATS)
        .sink(() => {});
    }
    const home = (await controller.ensureDefaultPattern()).getCell();
    if (adopt) await controller.adoptCatalogRooms();
    await settle(controller);
    return { controller, home, waits, arrived, refused };
  }

  /**
   * Subscribes `client` to the chats view, and waits for it to list `count`
   * rooms or more: a room another test creates may be listed too.
   */
  async function listRooms(client: Client, count: number): Promise<Row[]> {
    const view = client.home.key("chatManager").key("$VIEWS").key("chats")
      .asSchema<Chats>(CHATS);
    const chats = await client.waits.until(
      `a list of ${count} rooms`,
      view,
      (value) => (value?.rooms?.length ?? 0) >= count,
    );
    await settle(client.controller);
    return chats.rooms ?? [];
  }

  /** `client` as the member whose Home it brought up. */
  const memberOf = (client: Client): MemberSession => ({
    index: 0,
    identity: owner,
    controller: client.controller,
    home: client.home,
    sent: 0,
    waits: client.waits,
  });

  /** How many documents each of `spaces` has delivered to `client`. */
  const arrivedIn = (client: Client, spaces: readonly DID[]): number[] =>
    spaces.map((space) => client.arrived.get(space)?.size ?? 0);

  /**
   * Which of `spaces` `client` has opened a session to. The storage manager
   * keeps each space it opens for its runtime's lifetime, so this is every
   * space opened since the client began, through Home's bring-up as well.
   */
  const openedOf = (client: Client, spaces: readonly DID[]): DID[] => {
    const opened = new Set<string>(
      client.controller.runtime.storageManager.openedSpaces?.() ?? [],
    );
    return spaces.filter((space) => opened.has(space));
  };

  /**
   * How many plan reads the resume pre-sync's cross-space pass has made in
   * this process (`runner/start/resumeCrossSpaceRead`).
   */
  const crossSpaceReads = (): number =>
    getTimingStatsBreakdown().runner?.["start/resumeCrossSpaceRead"]?.count ??
      0;

  /** How many documents `client` holds now in each of `spaces`. */
  function heldIn(client: Client, spaces: readonly DID[]): number[] {
    const sizes = client.controller.runtime.getSizes().storage as
      | { bySpace?: { space: string; documents: number }[] }
      | null;
    return spaces.map((space) =>
      sizes?.bySpace?.find((entry) => entry.space === space)?.documents ?? 0
    );
  }

  /** Whether this run's clients, and the server beside them, serve. */
  const serving = resolveServerExecution();

  /** The serving loop, when the posture serves. */
  let served: ListeningServingMemoryServer | undefined;

  /** Releases the pattern environment a served handler reads. */
  let releasePatternEnvironment = () => {};

  beforeAll(async () => {
    const serve = (request: Request) => systemPatternsRoute().serve(request);
    if (serving) {
      served = await listenServingMemoryServer({
        serve,
        aclMode: "enforce",
        ...(runsInWorker() ? {} : { moduleByteCache }),
      });
      releasePatternEnvironment = claimPatternEnvironment(served.url);
    }
    server = served ?? StandaloneMemoryServer.start({
      namesInstances: () => namesInstancesByDefault(undefined),
      serve,
      acl: { mode: "enforce" },
    });
    const passphrase = `fabrichat-room-list ${crypto.randomUUID()}`;
    owner = await Identity.fromPassphrase(`${passphrase} owner`, {
      implementation: "noble",
    });
    bob = await Identity.fromPassphrase(`${passphrase} bob`, {
      implementation: "noble",
    });
    const ada = await openMember(server.url, owner, 0);
    try {
      for (let index = 0; index < ROOMS; index++) {
        kept.push(await createGroup(ada, `kept-${index}`, `Room ${index}`));
      }
      deleted = await createGroup(ada, "deleted", "Deleted room");
      revoked = await createGroup(ada, "revoked", "Revoked room", [bob.did()]);
      await new ACLManager(ada.controller.runtime, deleted).delete(owner.did());
    } finally {
      await closeMember(ada);
    }
    // Bob, an OWNER of the room, takes the person off its access list.
    const bobs = await initializePiecesController({
      space: bob.did(),
      apiUrl: server.url,
      identity: bob,
    });
    try {
      await new ACLManager(bobs.runtime, revoked).remove(owner.did());
      await settle(bobs);
    } finally {
      await bobs.dispose();
    }
  });

  afterAll(async () => {
    await server?.close();
    releasePatternEnvironment();
  });

  //
  // Listing the rooms
  //

  describe("a fresh client listing the rooms", () => {
    let client: Client;
    let rows: Row[];

    beforeAll(async () => {
      client = await bootClient();
      rows = await listRooms(client, ROOMS + 2);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("lists every room with the kind and title its manager recorded", () => {
      const titles = rows.map((row) => row.title)
        .filter((title) => title !== "Later room").sort();
      expect(titles).toEqual([
        "Deleted room",
        "Revoked room",
        ...kept.map((_, index) => `Room ${index}`),
      ].sort());
      expect(rows.every((row) => row.kind === "group")).toBe(true);
      expect(
        rows.filter((row) => row.title !== "Later room")
          .map((row) => row.room.space).sort(),
      ).toEqual([...kept, deleted, revoked].sort());
    });

    it("receives no document from any room's space, from bring-up on", () => {
      const spaces = [...kept, deleted, revoked];
      expect(arrivedIn(client, spaces)).toEqual(spaces.map(() => 0));
      expect(heldIn(client, spaces)).toEqual(spaces.map(() => 0));
    });

    it("is refused no room's space while it lists them", () => {
      expect([...client.refused.keys()]).toEqual([]);
    });

    it("opens no session to any room's space, from bring-up on", () => {
      expect(openedOf(client, [...kept, deleted, revoked])).toEqual([]);
    });

    it("receives no document from another room's space when it creates a group", async () => {
      const created = await createGroup(
        memberOf(client),
        "later",
        "Later room",
      );
      const others = [...kept, deleted, revoked];
      expect(others).not.toContain(created);
      expect(arrivedIn(client, others)).toEqual(others.map(() => 0));
    });

    it("receives no document from another room's space when it opens a direct room", async () => {
      const manager = client.home.key("chatManager");
      await sendTrusted(client.controller, manager.key("openDirect"), {
        requestId: "direct",
        counterpart: bob.did(),
      }, CHAT_START);
      const outcome = await client.waits.until(
        "the direct room with Bob",
        manager.key("requests").key("direct") as Cell<
          { status?: string } | undefined
        >,
        (value) => value?.status !== undefined,
      );
      await settle(client.controller);
      const others = [...kept, deleted, revoked];
      expect(outcome.status).toBe("done");
      expect(arrivedIn(client, others)).toEqual(others.map(() => 0));
    });
  });

  //
  // A replacement client
  //

  describe("a second fresh client of the same Home", () => {
    let client: Client;

    beforeAll(async () => {
      client = await bootClient();
      await listRooms(client, ROOMS + 2);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("receives no document from any room's space either", () => {
      const spaces = [...kept, deleted, revoked];
      expect(arrivedIn(client, spaces)).toEqual(spaces.map(() => 0));
      expect(openedOf(client, spaces)).toEqual([]);
    });
  });

  //
  // A client that subscribes before Home is brought up
  //

  describe("a fresh client subscribing to the list before Home is brought up", () => {
    let client: Client;

    beforeAll(async () => {
      client = await bootClient({ early: true });
      await listRooms(client, ROOMS + 2);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("receives no document from any room's space, from bring-up on", () => {
      const spaces = [...kept, deleted, revoked];
      expect(arrivedIn(client, spaces)).toEqual(spaces.map(() => 0));
      expect(heldIn(client, spaces)).toEqual(spaces.map(() => 0));
      expect(openedOf(client, spaces)).toEqual([]);
    });
  });

  //
  // Adopting a room the catalog lists with no membership
  //

  describe("a room the catalog lists with no membership", () => {
    let legacy: DID;
    let client: Client;
    let before: Row[];
    let after: Row[];

    beforeAll(async () => {
      // A room listed before the manager recorded memberships: its catalog
      // entry is there, and its membership is not.
      const ada = await openMember(server.url, owner, 0);
      try {
        legacy = await createGroup(ada, "legacy", "Legacy room");
        const memberships = ada.home.key("chatManager").key("roomMembership");
        const rooms = memberships.asSchema<{ room?: Cell<unknown> }[]>({
          type: "array",
          items: { type: "object", properties: { room: HANDLE } },
        });
        const held = await rooms.pull() ?? [];
        const stored = memberships.resolveAsCell();
        const raw = stored.getRaw() as unknown[];
        const others = raw.filter((_, index) =>
          held[index]?.room?.space !== legacy
        );
        expect(others.length).toBe(raw.length - 1);
        const tx = ada.controller.runtime.edit();
        stored.withTx(tx).setRaw(others as never);
        const { error } = await tx.commit().settled;
        if (error) throw new Error(`Dropping the membership: ${error.message}`);
      } finally {
        await closeMember(ada);
      }
      client = await bootClient({ adopt: false });
      before = await listRooms(client, ROOMS + 2);
      await client.controller.adoptCatalogRooms();
      after = await listRooms(client, before.length + 1);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("lists the room once the host adopts it, and not before", () => {
      expect(before.map((row) => row.room.space)).not.toContain(legacy);
      expect(after.find((row) => row.room.space === legacy)?.title).toBe(
        "Legacy room",
      );
    });

    it("reads the adopted room's space, and no other room's", () => {
      expect(client.arrived.get(legacy)?.size ?? 0).toBeGreaterThan(0);
      expect(arrivedIn(client, kept)).toEqual(kept.map(() => 0));
    });
  });

  //
  // A fresh client once another client has derived what reads the rooms
  //

  /**
   * Has a fresh person keep `count` rooms of their own, so that nothing a
   * test does with them reaches the rooms the other tests count, and returns
   * the person and the rooms' spaces.
   */
  async function personWithRooms(
    name: string,
    count: number,
  ): Promise<{ person: Identity; rooms: DID[] }> {
    const person = await Identity.fromPassphrase(
      `fabrichat-room-list ${name} ${crypto.randomUUID()}`,
      { implementation: "noble" },
    );
    const member = await openMember(server.url, person, 0);
    const rooms: DID[] = [];
    try {
      for (let index = 0; index < count; index++) {
        rooms.push(
          await createGroup(member, `${name}-${index}`, `${name}'s ${index}`),
        );
      }
    } finally {
      await closeMember(member);
    }
    return { person, rooms };
  }

  /**
   * Renders the manager's view as a renderer does, holding every cell the
   * view holds, a level at a time, and returns the spaces the view's links
   * name: the rows link their rooms.
   */
  async function renderManagerView(client: Client): Promise<Set<string>> {
    const view = client.home.key("chatManager").key("$UI").asSchema(
      rendererVDOMSchema,
    );
    const linked = new Set<string>();
    const held = new Set<string>();
    const visit = async (value: unknown): Promise<void> => {
      if (value === null || typeof value !== "object") return;
      if (isCell(value)) {
        const { space, id, path } = value.getAsNormalizedFullLink();
        linked.add(space);
        // A link out of Home's space is a row's room, which the view names
        // and doesn't render.
        if (space !== client.home.space) return;
        const key = `${id}/${JSON.stringify(path)}`;
        if (held.has(key)) return;
        held.add(key);
        value.sink(() => {});
        await value.pull();
        await settle(client.controller);
        await visit(value.get());
        return;
      }
      for (const each of Object.values(value)) await visit(each);
    };
    await visit(view);
    return linked;
  }

  describe("a fresh client once another has rendered the manager's view", () => {
    let rooms: DID[];
    let linked: Set<string>;
    let client: Client;

    beforeAll(async () => {
      const made = await personWithRooms("dana", 2);
      rooms = made.rooms;
      const renderer = await bootClient({ person: made.person });
      try {
        linked = await renderManagerView(renderer);
      } finally {
        await renderer.controller.dispose();
      }
      client = await bootClient({ person: made.person });
      await listRooms(client, rooms.length);
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("finds the rendered view linking each room", () => {
      expect(rooms.filter((space) => linked.has(space))).toEqual(rooms);
    });

    it("receives no document from any room's space, from bring-up on", () => {
      expect(arrivedIn(client, rooms)).toEqual(rooms.map(() => 0));
      expect(heldIn(client, rooms)).toEqual(rooms.map(() => 0));
    });

    it("opens no session to any room's space, from bring-up on", () => {
      expect(openedOf(client, rooms)).toEqual([]);
    });
  });

  describe("a fresh client once another has read the people list", () => {
    let rooms: DID[];
    let reader: Client;
    let client: Client;

    /** The plan reads the resume pre-sync's cross-space pass made. */
    let crossSpaceReadsAtBringUp: number;

    beforeAll(async () => {
      const made = await personWithRooms("carol", 2);
      rooms = made.rooms;
      reader = await bootClient({ person: made.person });
      try {
        const people = reader.home.key("chatManager").key("people").asSchema({
          type: "object",
          additionalProperties: { type: "array", items: HANDLE },
        });
        people.sink(() => {});
        await people.pull();
        await settle(reader.controller);
      } finally {
        await reader.controller.dispose();
      }
      const before = crossSpaceReads();
      client = await bootClient({ person: made.person });
      await listRooms(client, rooms.length);
      crossSpaceReadsAtBringUp = crossSpaceReads() - before;
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("finds the people list reading each room's roster", () => {
      // Under server execution the serving loop reads the rosters, and the
      // reader holds what it derived from them.
      if (serving) return;
      expect(
        rooms.filter((space) => (reader.arrived.get(space)?.size ?? 0) > 0),
      )
        .toEqual(rooms);
    });

    it("receives no document from any room's space, from bring-up on", () => {
      expect(arrivedIn(client, rooms)).toEqual(rooms.map(() => 0));
      expect(heldIn(client, rooms)).toEqual(rooms.map(() => 0));
    });

    it("opens no session to any room's space, from bring-up on", () => {
      expect(openedOf(client, rooms)).toEqual([]);
    });

    it("runs no cross-space pass while it brings Home up", () => {
      // The serving loop runs in this process under server execution, and
      // its pass is counted with the clients'.
      if (serving) return;
      expect(crossSpaceReadsAtBringUp).toBe(0);
    });
  });

  //
  // Opening a room that is gone
  //

  describe("opening a room that is gone", () => {
    let client: Client;

    beforeAll(async () => {
      client = await bootClient();
      const rows = await listRooms(client, ROOMS + 2);
      const storage = client.controller.runtime.storageManager;
      for (const space of [deleted, revoked]) {
        const row = rows.find((each) => each.room.space === space)!;
        await row.room.sync();
        await storage.awaitSpaceAnswer?.(space as MemorySpace);
      }
    });

    afterAll(async () => {
      await client?.controller.dispose();
    });

    it("is refused a deleted room's space as deleted", () => {
      const error = client.refused.get(deleted);
      expect(error?.name).toBe("AuthorizationError");
      expect(isDeletedSpaceError(error)).toBe(true);
    });

    it("is refused a revoked room's space, not as deleted", () => {
      const error = client.refused.get(revoked);
      expect(error?.name).toBe("AuthorizationError");
      expect(isDeletedSpaceError(error)).toBe(false);
    });

    it("receives no document from the rooms it didn't open", () => {
      expect(arrivedIn(client, kept)).toEqual(kept.map(() => 0));
    });

    it("has opened a session to the rooms it opened, and to no other room", () => {
      expect(openedOf(client, [...kept, deleted, revoked]).sort()).toEqual(
        [deleted, revoked].sort(),
      );
    });
  });
});
