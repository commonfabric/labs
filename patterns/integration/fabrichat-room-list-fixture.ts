/**
 * The setup the `fabrichat-room-list-*` tests share: an in-process storage
 * server, fresh clients of a person's Home that record what they load, and the
 * ways those tests come to have the rooms they count. Each test file starts a
 * server of its own, so that running one of its tests runs no other file's
 * setup, and sets each scenario up the first time one of its tests reads it,
 * so that running one test runs no other scenario's setup either.
 *
 * Each client is a runtime of its own, beside the server, in the posture the
 * run resolves, as `multi-runtime-harness.ts` resolves it: with server
 * execution on, the server is a serving one, whose loop computes and stores
 * what the clients' Homes derive. No toolshed or browser required.
 */

import type { DID } from "@commonfabric/identity";
import { Identity } from "@commonfabric/identity";
import { getTimingStatsBreakdown } from "@commonfabric/logger";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { adoptionRequestId } from "@commonfabric/piece/ops";
import { sendVerbEvent } from "@commonfabric/piece/verb-call";
import {
  ACLManager,
  type Cell,
  isCell,
  normalizeSpaceHost,
} from "@commonfabric/runner";
import {
  type ListeningServingMemoryServer,
  listenServingMemoryServer,
  runsInWorker,
} from "@commonfabric/runner/executor/serving-memory-server.deno";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { namesInstancesByDefault } from "@commonfabric/runner/storage/cache.deno";
import type { ModuleByteCache } from "@commonfabric/test-support/compile-byte-cache";
import {
  CHAT_START,
  closeMember,
  enterRoom,
  type MemberSession,
  MemberWaits,
  openMember,
  sendTrusted,
  writeAs,
} from "./fabrichat-room-fixture.ts";
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
export const ROOMS = 3;

/**
 * How many messages the person sends in each room they keep, by its place
 * among them; a room past the end of the list holds none.
 */
export const SENT = [1, 2];

/** A room link as a list reads it: a handle that declares nothing of it. */
export const HANDLE = { type: "unknown", asCell: ["cell"] } as const;

/** One row of the list, as a client that draws natively declares it. */
export const ROW = {
  type: "object",
  properties: {
    room: HANDLE,
    kind: { type: "string" },
    counterpart: { type: "string" },
    since: {},
    title: { type: "string" },
    activity: {
      type: "object",
      properties: { count: { type: "number" }, newestAt: {} },
    },
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
export interface Row {
  room: Cell<unknown>;
  kind: string;
  counterpart?: string;
  title?: string;
  activity?: { count: number; newestAt?: unknown };
}

/** The chats view, as it arrives. */
interface Chats {
  rooms?: Row[];
}

/**
 * A fresh client of the person's Home, and what it has loaded since it began.
 * `RoomListServer.dispose` disposes of one.
 */
export interface Client {
  controller: PiecesController;
  home: Cell<unknown>;
  waits: MemberWaits;

  /** The documents each space has delivered to this client, by space. */
  arrived: Map<string, Set<string>>;

  /** The spaces this client was refused, each with the error it got. */
  refused: Map<string, Error>;
}

/** The rooms of the person whose Home the listing tests bring up. */
export interface KeptRooms {
  /** The person. */
  owner: Identity;

  /** An OWNER of the revoked room, who took the person off its access list. */
  bob: Identity;

  /** The spaces of the rooms the person keeps, in the order they were made. */
  kept: DID[];

  /** A room deleted after it was listed. */
  deleted: DID;

  /** A room whose space no longer admits the person. */
  revoked: DID;
}

/** Whether this run's clients, and the server beside them, serve. */
export const serving = resolveServerExecution();

/**
 * An in-process storage server in the posture the run resolves, and the
 * clients and rooms the room-list tests make on it.
 */
export class RoomListServer {
  /** The server the clients open their spaces on. */
  readonly #server: StandaloneMemoryServer | ListeningServingMemoryServer;

  /** The serving loop, when the posture serves. */
  readonly #served: ListeningServingMemoryServer | undefined;

  /** Releases the pattern environment a served handler reads. */
  readonly #releasePatternEnvironment: () => void;

  /** The runtimes `startRecording` has started and nothing has disposed of. */
  readonly #live = new Set<PiecesController>();

  private constructor(
    server: StandaloneMemoryServer | ListeningServingMemoryServer,
    served: ListeningServingMemoryServer | undefined,
    releasePatternEnvironment: () => void,
  ) {
    this.#server = server;
    this.#served = served;
    this.#releasePatternEnvironment = releasePatternEnvironment;
  }

  /** The URL the clients open their spaces on. */
  get url(): URL {
    return this.#server.url;
  }

  /**
   * Disposes of every client still running, stops the server, and releases
   * the pattern environment.
   */
  async close(): Promise<void> {
    try {
      await this.disposeClients();
    } finally {
      await this.#server.close();
      this.#releasePatternEnvironment();
    }
  }

  /** Disposes of `controller`, unless it has been disposed of already. */
  async dispose(controller: PiecesController): Promise<void> {
    if (this.#live.delete(controller)) await controller.dispose();
  }

  /**
   * Disposes of every runtime `startRecording` started that is still running.
   * The outermost block holding a scenario's tests does this after them, so
   * that no client of one scenario is still running while the next one is set
   * up. It tries every runtime, and then throws the errors any disposals
   * threw, together.
   */
  async disposeClients(): Promise<void> {
    const failures: unknown[] = [];
    for (const controller of [...this.#live]) {
      try {
        await this.dispose(controller);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Disposing of the clients failed");
    }
  }

  /**
   * Waits for `controller`'s writes to reach the server, for what the serving
   * loop does in answer, when there is one, and for `controller` to have
   * heard of it.
   */
  async settle(controller: PiecesController): Promise<void> {
    await controller.runtime.idle();
    await controller.synced();
    await this.#served?.host.host?.whenQuiescent();
    await this.#served?.idle();
    await controller.synced();
  }

  /** Has `member` create a group with `members`, and returns its space. */
  async createGroup(
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
    await this.settle(member.controller);
    const room = await manager.key("requests").key(requestId).key("entry")
      .key("room").asSchema<Cell<unknown>>(HANDLE).pull();
    return room.space as DID;
  }

  /**
   * Has a person keep `ROOMS` rooms, writing `SENT` messages in them, a room
   * deleted after it was made, and a room whose space Bob, an OWNER of it,
   * took the person off the access list of.
   */
  async keptRooms(): Promise<KeptRooms> {
    const passphrase = `fabrichat-room-list ${crypto.randomUUID()}`;
    const owner = await Identity.fromPassphrase(`${passphrase} owner`, {
      implementation: "noble",
    });
    const bob = await Identity.fromPassphrase(`${passphrase} bob`, {
      implementation: "noble",
    });
    const kept: DID[] = [];
    let deleted: DID;
    let revoked: DID;
    const ada = await openMember(this.url, owner, 0);
    try {
      for (let index = 0; index < ROOMS; index++) {
        kept.push(
          await this.createGroup(ada, `kept-${index}`, `Room ${index}`),
        );
      }
      // The person writes in some of the rooms, and their manager hears where
      // each conversation stands from each message.
      for (const [index, count] of SENT.entries()) {
        const link = await ada.home.key("chatManager").key("requests")
          .key(`kept-${index}`).key("entry").key("room")
          .asSchema<Cell<unknown>>({ asCell: ["cell"] }).pull();
        const room = await enterRoom(ada, link);
        await ada.waits.until(
          `the person's leave to write in Room ${index}`,
          room.key("canSend") as Cell<boolean | undefined>,
          (value) => value === true,
        );
        for (let sent = 1; sent <= count; sent++) {
          await writeAs(ada, `message ${sent} in Room ${index}`, {
            target: { value: `Message ${sent}` },
          }, sent);
        }
        await this.settle(ada.controller);
      }
      deleted = await this.createGroup(ada, "deleted", "Deleted room");
      revoked = await this.createGroup(ada, "revoked", "Revoked room", [
        bob.did(),
      ]);
      await new ACLManager(ada.controller.runtime, deleted).delete(owner.did());
    } finally {
      await closeMember(ada);
    }
    // Bob, an OWNER of the room, takes the person off its access list.
    const bobs = await initializePiecesController({
      space: bob.did(),
      apiUrl: this.url,
      identity: bob,
    });
    try {
      await new ACLManager(bobs.runtime, revoked).remove(owner.did());
      await this.settle(bobs);
    } finally {
      await bobs.dispose();
    }
    return { owner, bob, kept, deleted, revoked };
  }

  /**
   * Starts a runtime of `person`'s that records every document a space
   * delivers to it and every space it is refused, from its start on, and
   * brings up nothing.
   */
  async startRecording(person: Identity): Promise<{
    controller: PiecesController;
    arrived: Map<string, Set<string>>;
    refused: Map<string, Error>;
  }> {
    const controller = await initializePiecesController({
      space: person.did(),
      apiUrl: this.url,
      identity: person,
    });
    this.#live.add(controller);
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
   * Starts a fresh client of `person`'s Home, recording every document a
   * space delivers to it and every space it is refused, from before Home is
   * brought up, and brings Home up, with the housekeeping that adopts the
   * catalog's rooms unless `adopt` is false. With `early`, the client
   * subscribes to the chats view before Home is brought up, and holds it.
   */
  async bootClient(
    { adopt = true, early = false, person }: {
      adopt?: boolean;
      early?: boolean;
      person: Identity;
    },
  ): Promise<Client> {
    const { controller, arrived, refused } = await this.startRecording(person);
    try {
      const waits = new MemberWaits(controller.runtime.scheduler);
      if (early) {
        const root = await controller.getDefaultPattern(false);
        if (root === undefined) throw new Error("The person has no Home");
        root.key("chatManager").key("$VIEWS").key("chats")
          .asSchema<Chats>(CHATS).sink(() => {});
      }
      const home = (await controller.ensureDefaultPattern()).getCell();
      if (adopt) await controller.adoptCatalogRooms();
      await this.settle(controller);
      return { controller, home, waits, arrived, refused };
    } catch (error) {
      await this.dispose(controller);
      throw error;
    }
  }

  /**
   * Subscribes `client` to the chats view, and waits for it to list `count`
   * rooms or more: a room another test creates may be listed too.
   */
  async listRooms(client: Client, count: number): Promise<Row[]> {
    const view = client.home.key("chatManager").key("$VIEWS").key("chats")
      .asSchema<Chats>(CHATS);
    const chats = await client.waits.until(
      `a list of ${count} rooms`,
      view,
      (value) => (value?.rooms?.length ?? 0) >= count,
    );
    await this.settle(client.controller);
    return chats.rooms ?? [];
  }

  /**
   * Has a fresh person keep `count` rooms of their own, so that nothing a
   * test does with them reaches the rooms the other tests count, and returns
   * the person and the rooms' spaces.
   */
  async personWithRooms(
    name: string,
    count: number,
  ): Promise<{ person: Identity; rooms: DID[] }> {
    const person = await Identity.fromPassphrase(
      `fabrichat-room-list ${name} ${crypto.randomUUID()}`,
      { implementation: "noble" },
    );
    const member = await openMember(this.url, person, 0);
    const rooms: DID[] = [];
    try {
      for (let index = 0; index < count; index++) {
        rooms.push(
          await this.createGroup(
            member,
            `${name}-${index}`,
            `${name}'s ${index}`,
          ),
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
   * name, since the rows link their rooms, and the labels of the
   * `cf-cell-link`s it renders, which the rows are.
   */
  async renderManagerView(
    client: Client,
  ): Promise<{ linked: Set<string>; labels: string[] }> {
    const view = client.home.key("chatManager").key("$UI").asSchema(
      rendererVDOMSchema,
    );
    const linked = new Set<string>();
    const labels: string[] = [];
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
        await this.settle(client.controller);
        await visit(value.get());
        return;
      }
      for (const each of Object.values(value)) await visit(each);
      const node = value as { name?: unknown; props?: unknown };
      if (node.name !== "cf-cell-link") return;
      // A node's props are a cell of their own, which the walk above has
      // already pulled.
      const props = (isCell(node.props) ? node.props.get() : node.props) as
        | { label?: unknown }
        | undefined;
      const label = isCell(props?.label) ? props.label.get() : props?.label;
      if (typeof label === "string") labels.push(label);
    };
    await visit(view);
    return { linked, labels };
  }

  /**
   * Makes `rooms`, which `person` keeps, rooms the catalog lists with no
   * membership, as a catalog kept before the manager recorded memberships
   * lists them: drops their memberships, lists the second, when there is one,
   * under the `loom` kind, and lists `person`'s profile space, which declares
   * no room, beside them. Returns that profile space.
   */
  async orphanRooms(
    person: Identity,
    rooms: readonly DID[],
  ): Promise<DID> {
    const member = await openMember(this.url, person, 0);
    let noRoom: DID;
    try {
      const manager = member.home.key("chatManager");
      const memberships = manager.key("roomMembership");
      const held = await memberships.asSchema<{ room?: Cell<unknown> }[]>({
        type: "array",
        items: { type: "object", properties: { room: HANDLE } },
      }).pull() ?? [];
      const stored = memberships.resolveAsCell();
      const raw = stored.getRaw() as unknown[];
      const catalog = manager.key("sharedSpaceCatalog").key("entries")
        .resolveAsCell();
      await catalog.sync();
      const entries = { ...catalog.getRaw() as Record<string, object> };
      const profile = await member.home.key("profiles").key(0)
        .asSchema<Cell<unknown>>({ asCell: ["cell"] }).pull();
      noRoom = profile.space as DID;
      entries[noRoom] = {
        ...entries[rooms[0]],
        space: noRoom,
        kind: "loom",
        title: "A space with no room",
      };
      if (rooms.length > 1) {
        entries[rooms[1]] = { ...entries[rooms[1]], kind: "loom" };
      }

      const tx = member.controller.runtime.edit();
      stored.withTx(tx).setRaw(
        raw.filter((_, index) =>
          !rooms.includes(held[index]?.room?.space as DID)
        ) as never,
      );
      catalog.withTx(tx).setRaw(entries as never);
      const { error } = await tx.commit().settled;
      if (error) throw new Error(`Orphaning the rooms: ${error.message}`);
    } finally {
      await closeMember(member);
    }
    return noRoom;
  }

  /**
   * Has `person`'s Home register `room`, which `from` offered under `id`, as
   * Home's share intake registers an offered room, with no acceptance after,
   * as when the intake's acceptance did not land: the catalog then lists the
   * room with no membership, and the room's roster doesn't list `person`.
   * Returns the space of `person`'s profile.
   */
  async registerOffered(
    person: Identity,
    room: DID,
    from: Identity,
    id: string,
  ): Promise<DID> {
    const member = await openMember(this.url, person, 0);
    try {
      const runtime = member.controller.runtime;
      const registered = await sendVerbEvent(
        member.home.key("registerSharedSpace"),
        {
          space: room,
          host: normalizeSpaceHost(new URL(runtime.apiUrl).origin).origin,
          kind: "fabrichat-room",
          title: "Offered room",
          offer: { from: from.did(), id },
        },
      );
      if (registered.status !== "committed") {
        throw new Error("Registering the room did not commit");
      }
      await this.settle(member.controller);
      const profile = await member.home.key("profiles").key(0)
        .asSchema<Cell<unknown>>({ asCell: ["cell"] }).pull();
      return profile.space as DID;
    } finally {
      await closeMember(member);
    }
  }

  /**
   * Starts a server in the posture the run resolves. A serving loop in this
   * process compiles into `cache`, the clients' shared cache unless another is
   * named.
   */
  static async start(
    cache: ModuleByteCache = moduleByteCache,
  ): Promise<RoomListServer> {
    const serve = (request: Request) => systemPatternsRoute().serve(request);
    if (serving) {
      const served = await listenServingMemoryServer({
        serve,
        aclMode: "enforce",
        // A loop the environment puts in a worker takes no closure; the
        // worker builds a cache of its own.
        ...(runsInWorker() ? {} : { moduleByteCache: cache }),
      });
      return new RoomListServer(
        served,
        served,
        claimPatternEnvironment(served.url),
      );
    }
    const server = StandaloneMemoryServer.start({
      namesInstances: () => namesInstancesByDefault(undefined),
      serve,
      acl: { mode: "enforce" },
    });
    return new RoomListServer(server, undefined, () => {});
  }
}

/** `client` as the member `person`, whose Home it brought up. */
export const memberOf = (client: Client, person: Identity): MemberSession => ({
  index: 0,
  identity: person,
  controller: client.controller,
  home: client.home,
  sent: 0,
  waits: client.waits,
});

/** How many documents each of `spaces` has delivered to `client`. */
export const arrivedIn = (client: Client, spaces: readonly DID[]): number[] =>
  spaces.map((space) => client.arrived.get(space)?.size ?? 0);

/**
 * Which of `spaces` `client` has opened a session to. The storage manager
 * keeps each space it opens for its runtime's lifetime, so this is every
 * space opened since the client began, through Home's bring-up as well.
 */
export const openedOf = (client: Client, spaces: readonly DID[]): DID[] => {
  const opened = new Set<string>(
    client.controller.runtime.storageManager.openedSpaces?.() ?? [],
  );
  return spaces.filter((space) => opened.has(space));
};

/**
 * How many plan reads the resume pre-sync's cross-space pass has made in
 * this process (`runner/start/resumeCrossSpaceRead`).
 */
export const crossSpaceReads = (): number =>
  getTimingStatsBreakdown().runner?.["start/resumeCrossSpaceRead"]?.count ??
    0;

/** How many documents `client` holds now in each of `spaces`. */
export function heldIn(client: Client, spaces: readonly DID[]): number[] {
  const sizes = client.controller.runtime.getSizes().storage as
    | { bySpace?: { space: string; documents: number }[] }
    | null;
  return spaces.map((space) =>
    sizes?.bySpace?.find((entry) => entry.space === space)?.documents ?? 0
  );
}

/** The keys of the pieces running on `client`'s runtime. */
export const runningOn = (client: Client): string[] =>
  [...client.controller.runtime.runner.cancels.keys()].sort();

/** How many of the scheduler's nodes on `client` the room pattern authored. */
export const roomNodesOn = (client: Client): number =>
  client.controller.runtime.scheduler.getGraphSnapshot().nodes.filter(
    (node) => /fabrichat\/room\.tsx:/.test(node.src ?? ""),
  ).length;

/** The room each of `rooms`' adoption outcomes names, on `client`. */
export async function adoptedRooms(
  client: Client,
  rooms: readonly DID[],
): Promise<{ status?: string; room?: Cell<unknown> }[]> {
  const catalog = client.home.key("chatManager").key("sharedSpaceCatalog")
    .key("entries").asSchema<Record<string, { revision?: string }>>({
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { revision: { type: "string" } },
      },
    });
  const entries = await catalog.pull() ?? {};
  const requests = client.home.key("chatManager").key("requests");
  return await Promise.all(
    rooms.map((space) =>
      requests.key(adoptionRequestId(space, entries[space]?.revision ?? ""))
        .asSchema<{ status?: string; room?: Cell<unknown> }>({
          type: "object",
          properties: {
            status: { type: "string" },
            entry: { type: "object", properties: { room: HANDLE } },
          },
        }).pull().then((outcome) => ({
          status: outcome?.status,
          room: (outcome as { entry?: { room?: Cell<unknown> } } | undefined)
            ?.entry?.room,
        }))
    ),
  );
}

/**
 * The profile spaces the roster of `room` lists, as `runtime` reads the
 * room's stored argument.
 */
export async function rosterOf(
  controller: PiecesController,
  room: Cell<unknown>,
): Promise<string[]> {
  const cell = controller.runtime.getCellFromLink(
    room.getAsNormalizedFullLink(),
  );
  await cell.sync();
  const roster = cell.getArgumentCell()?.key("participants").asSchema<
    { items?: Cell<unknown>[] }
  >({
    type: "object",
    properties: { items: { type: "array", items: HANDLE } },
  });
  if (roster === undefined) throw new Error("The room has no argument");
  const value = await roster.pull();
  return (value?.items ?? []).map((profile) => profile.space);
}

/** A fresh identity named for `name`. */
export const identityNamed = (name: string): Promise<Identity> =>
  Identity.fromPassphrase(
    `fabrichat-room-list ${name} ${crypto.randomUUID()}`,
    { implementation: "noble" },
  );
