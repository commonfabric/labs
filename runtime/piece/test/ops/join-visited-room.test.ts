import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { createSession, Identity } from "@commonfabric/identity";
import type { ACL } from "@commonfabric/memory/acl";
import {
  type Cell,
  inSpaceRootCause,
  type MemorySpace,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { joinVisitedRoomOf } from "../../src/ops/join-visited-room.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import { installCustomRoot } from "../install-custom-root.ts";

const identity = await Identity.fromPassphrase("join visited room owner");

/** A principal who is not the visitor. */
const someoneElse = (await Identity.fromPassphrase("join visited room other"))
  .did();

/** The origin of the host the test's runtime is served by. */
const HOST = "https://home.example";

// A Home pattern reduced to its chat manager's `joinRoom`, which records the
// space of the room each event names, and whether it named a request.
const program: RuntimeProgram = {
  main: "/home.tsx",
  files: [{
    name: "/home.tsx",
    contents: `
import { type Cell, equals, handler, pattern, spaceOf, Writable } from "commonfabric";

type Join = { room?: Cell<unknown>; container?: Cell<{ chatRoom: Cell<unknown> }>; requestId?: string };

type Joined = { space?: string; named: boolean; container?: string; declared?: boolean };

const joinRoom = handler<Join, { joined: Writable<Joined[]> }>(
  (event, { joined }) => {
    joined.push({
      space: spaceOf(event.room),
      named: event.requestId !== undefined,
      ...(event.container ? {
        container: spaceOf(event.container),
        declared: equals(event.container.key("chatRoom").get(), event.room),
      } : {}),
    });
  },
);

export default pattern(() => {
  const joined = new Writable<Joined[]>([]).for("joined");
  return { joined, chatManager: { joinRoom: joinRoom({ joined }) } };
});`,
  }],
};

/** A stand-in for a room, which a visited space's root runs. */
const roomProgram: RuntimeProgram = {
  main: "/room.tsx",
  files: [{
    name: "/room.tsx",
    contents: `
import { pattern } from "commonfabric";

export default pattern(() => ({ about: { kind: "group" } }));`,
  }],
};

/** What Home's stand-in records of each join it is sent. */
const joinedSchema = {
  type: "array",
  items: { type: "object", additionalProperties: true },
} as const;

describe("join-visited-room", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;
  let home: Cell<unknown>;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL(HOST),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    controller = new PiecesController(
      createSession({ identity, spaceDid: identity.did() }),
      runtime,
    );
    await controller.synced();
    home = await installCustomRoot(runtime, controller, program);
    await runtime.idle();
  });

  afterEach(async () => {
    await controller.dispose();
    await storage.close();
  });

  /** Commits fixture writes and surfaces any refused transaction. */
  async function edit(
    fn: Parameters<Runtime["editWithRetry"]>[0],
  ): Promise<void> {
    const { error } = await runtime.editWithRetry(fn);
    expect(error).toBeUndefined();
  }

  /**
   * A space granting `grants`, owned by the visitor unless `owner` says
   * otherwise, which declares `spaceKind`, `fabrichat-room` by default, or no
   * kind for `null`. Its root is a room at the address its genesis commit
   * reserves, a room elsewhere in the space for `"misplaced"`, and none for
   * `false`.
   */
  async function visitedSpace(
    grants: ACL,
    { owner, root = "reserved", spaceKind = "fabrichat-room" }: {
      owner?: string;
      root?: "reserved" | "misplaced" | false;
      spaceKind?: string | null;
    } = {},
  ): Promise<MemorySpace> {
    const space = await runtime.createSpace({
      grants,
      ...(owner === undefined ? {} : { owner: owner as never }),
      root: (created) => ({ cause: inSpaceRootCause(created) }),
      ...(spaceKind === null ? {} : { spaceKind }),
    });
    if (root !== false && spaceKind !== "fabrichat-room") {
      const container = runtime.getCell(
        space,
        root === "reserved" ? inSpaceRootCause(space) : "container",
      );
      await edit((tx) => {
        container.withTx(tx).set({ about: { kind: "group" } });
        runtime.getSpaceCell(space).withTx(tx).key("defaultPattern").set(
          container,
        );
      });
    } else if (root !== false) {
      // Disposing a controller disposes the runtime, which `afterEach` does
      // through the Home space's controller.
      const rooms = new PiecesController(
        createSession({ identity, spaceDid: space }),
        runtime,
      );
      await rooms.synced();
      await installCustomRoot(
        runtime,
        rooms,
        roomProgram,
        root === "reserved" ? { cause: inSpaceRootCause(space) } : {},
      );
    }
    return space;
  }

  /** What Home's chat manager has been sent, once its handling has settled. */
  async function joinedNow(): Promise<Record<string, unknown>[]> {
    await runtime.idle();
    return (await home.key("joined" as never).asSchema(joinedSchema)
      .pull() ?? []) as Record<string, unknown>[];
  }

  describe("joinVisitedRoomOf()", () => {
    it("sends the chat manager's `joinRoom` the room of a space the visitor owns, naming no request", async () => {
      const space = await visitedSpace({});

      expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
        .toBe("sent");
      expect(await joinedNow()).toStrictEqual([{ space, named: false }]);
    });

    it("sends the room of a space anyone may write to, as a group joinable by its link is", async () => {
      const space = await visitedSpace({ "*": "WRITE" }, {
        owner: someoneElse,
      });

      expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
        .toBe("sent");
      expect(await joinedNow()).toStrictEqual([{ space, named: false }]);
    });

    it("returns `recipient-access-refused`, sending nothing, for a space the visitor may only read", async () => {
      const space = await visitedSpace({ "*": "READ" }, {
        owner: someoneElse,
      });

      expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
        .toBe("recipient-access-refused");
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("returns `chat-room-missing` for an undeclared or other kind with no explicit chat declaration", async () => {
      const undeclared = await visitedSpace({}, { spaceKind: null });
      const other = await visitedSpace({}, { spaceKind: "loom" });

      expect([
        await joinVisitedRoomOf(runtime, home, identity.did(), undeclared),
        await joinVisitedRoomOf(runtime, home, identity.did(), other),
      ]).toStrictEqual(["chat-room-missing", "chat-room-missing"]);
      expect(await joinedNow()).toStrictEqual([]);
    });

    for (const spaceKind of [null, "loom", "photo-album"]) {
      it(`sends a declared nested room and its container for kind ${spaceKind}`, async () => {
        const space = await visitedSpace({}, { spaceKind, root: "misplaced" });
        const root = await runtime.getSpaceCell(space).key("defaultPattern")
          .pull();
        const room = runtime.getCell(space, "nested-chat");
        await edit((tx) => {
          room.withTx(tx).set({ about: { kind: "group" } });
          root!.withTx(tx).key("chatRoom").set(room);
        });

        expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
          .toBe("sent");
        expect(await joinedNow()).toStrictEqual([
          { space, named: false, container: space, declared: true },
        ]);
      });
    }

    it("returns `chat-room-missing` for a declaration alias with no room yet", async () => {
      const space = await visitedSpace({}, { spaceKind: "loom" });
      const root = await runtime.getSpaceCell(space).key("defaultPattern")
        .pull();
      const declaration = runtime.getCell(space, "pending-room");
      await edit((tx) => {
        declaration.withTx(tx).set(undefined);
        root!.withTx(tx).key("chatRoom").set(declaration);
      });

      expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
        .toBe("chat-room-missing");
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("follows a declaration alias to a foreign standalone room", async () => {
      const space = await visitedSpace({}, { spaceKind: null });
      const roomSpace = await visitedSpace({});
      const root = await runtime.getSpaceCell(space).key("defaultPattern")
        .pull();
      const room = await runtime.getSpaceCell(roomSpace).key("defaultPattern")
        .pull();
      const alias = runtime.getCell(space, "room-alias");
      await edit((tx) => {
        alias.withTx(tx).set(room);
        root!.withTx(tx).key("chatRoom").set(alias);
      });

      expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
        .toBe("sent");
      expect(await joinedNow()).toStrictEqual([
        { space: roomSpace, named: false, container: space, declared: true },
      ]);
    });

    it("returns `chat-room-invalid` for inline objects, scalars, and links into a document", async () => {
      const space = await visitedSpace({}, { spaceKind: "loom" });
      const root = await runtime.getSpaceCell(space).key("defaultPattern")
        .pull();
      const nested = runtime.getCell(space, "nested-value");
      await edit((tx) => {
        nested.withTx(tx).set({ room: { about: { kind: "group" } } });
      });
      for (
        const declaration of [
          42,
          { about: { kind: "group" } },
          nested.key("room"),
        ]
      ) {
        await edit((tx) => {
          root!.withTx(tx).key("chatRoom").set(declaration);
        });
        expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
          .toBe("chat-room-invalid");
      }
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("returns `recipient-access-refused` for a read-only container or its read-only foreign room", async () => {
      const roomSpace = await visitedSpace({ "*": "READ" }, {
        owner: someoneElse,
      });
      const space = await visitedSpace({}, { spaceKind: "loom" });
      const readOnly = await visitedSpace({ "*": "READ" }, {
        owner: someoneElse,
        spaceKind: "loom",
      });
      const root = await runtime.getSpaceCell(space).key("defaultPattern")
        .pull();
      const readOnlyRoot = await runtime.getSpaceCell(readOnly).key(
        "defaultPattern",
      ).pull();
      const room = await runtime.getSpaceCell(roomSpace).key("defaultPattern")
        .pull();
      await edit((tx) => {
        root!.withTx(tx).key("chatRoom").set(room);
      });
      await edit((tx) => {
        readOnlyRoot!.withTx(tx).key("chatRoom").set(root);
      });

      expect([
        await joinVisitedRoomOf(runtime, home, identity.did(), space),
        await joinVisitedRoomOf(runtime, home, identity.did(), readOnly),
      ]).toStrictEqual([
        "recipient-access-refused",
        "recipient-access-refused",
      ]);
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("refuses a foreign declaration target whose space is unkinded or whose room is not its root", async () => {
      const space = await visitedSpace({}, { spaceKind: "loom" });
      const unkinded = await visitedSpace({}, { spaceKind: null });
      const standalone = await visitedSpace({});
      const root = await runtime.getSpaceCell(space).key("defaultPattern")
        .pull();
      const unknownRoom = await runtime.getSpaceCell(unkinded).key(
        "defaultPattern",
      ).pull();
      const otherRoom = runtime.getCell(standalone, "other-room");
      await edit((tx) => {
        otherRoom.withTx(tx).set({ about: { kind: "group" } });
      });
      const decisions = [];
      for (const target of [unknownRoom, otherRoom]) {
        await edit((tx) => {
          root!.withTx(tx).key("chatRoom").set(target);
        });
        decisions.push(
          await joinVisitedRoomOf(runtime, home, identity.did(), space),
        );
      }
      expect(decisions).toStrictEqual([
        "space-kind-undeclared",
        "chat-room-invalid",
      ]);
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("returns `recipient-access-refused` when the declared room cannot be read for want of access", async () => {
      const space = await visitedSpace({}, { spaceKind: "loom" });
      const foreign = await visitedSpace({});
      const root = await runtime.getSpaceCell(space).key("defaultPattern")
        .pull();
      const room = await runtime.getSpaceCell(foreign).key("defaultPattern")
        .pull();
      await edit((tx) => root!.withTx(tx).key("chatRoom").set(room));
      const failure = new Error("room access refused");
      using _session = stub(
        storage,
        "spaceSessionError",
        (each) => each === foreign ? failure : undefined,
      );
      using _refused = stub(
        storage,
        "spaceAccessError",
        (each) => each === foreign ? failure : undefined,
      );

      expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
        .toBe("recipient-access-refused");
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("throws the original failure when reading a declaration fails without an access refusal", async () => {
      const space = await visitedSpace({}, { spaceKind: "loom" });
      const foreign = await visitedSpace({});
      const root = await runtime.getSpaceCell(space).key("defaultPattern")
        .pull();
      const room = await runtime.getSpaceCell(foreign).key("defaultPattern")
        .pull();
      await edit((tx) => root!.withTx(tx).key("chatRoom").set(room));
      const failure = new Error("declaration transport failed");
      using _session = stub(
        storage,
        "spaceSessionError",
        (each) => each === foreign ? failure : undefined,
      );

      await expect(joinVisitedRoomOf(runtime, home, identity.did(), space))
        .rejects.toBe(failure);
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("returns `recipient-access-refused` when access is revoked after the kind lookup", async () => {
      const space = await visitedSpace({}, { spaceKind: "loom" });
      let revoked = false;
      const spaceKind = runtime.spaceKind.bind(runtime);
      using _kind = stub(runtime, "spaceKind", async (each) => {
        const kind = await spaceKind(each);
        if (each === space) revoked = true;
        return kind;
      });
      using _refused = stub(
        storage,
        "spaceAccessError",
        (each) =>
          revoked && each === space ? new Error("access revoked") : undefined,
      );

      expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
        .toBe("recipient-access-refused");
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("returns `space-root-missing` for a container root in another space or inside a document", async () => {
      const space = await visitedSpace({}, { spaceKind: "loom" });
      const elsewhere = await visitedSpace({});
      const foreign = await runtime.getSpaceCell(elsewhere).key(
        "defaultPattern",
      ).pull();
      const own = runtime.getCell(space, "own-container");
      for (const target of [foreign, own.key("inside")]) {
        await edit((tx) => {
          own.withTx(tx).set({ inside: { chatRoom: foreign } });
          runtime.getSpaceCell(space).withTx(tx).key("defaultPattern").set(
            target,
          );
        });
        expect(await joinVisitedRoomOf(runtime, home, identity.did(), space))
          .toBe("space-root-missing");
      }
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("returns `space-root-missing` for a space with no root, and `space-root-misplaced` for one whose root isn't at the reserved address", async () => {
      const missing = await visitedSpace({}, { root: false });
      const misplaced = await visitedSpace({}, { root: "misplaced" });

      expect([
        await joinVisitedRoomOf(runtime, home, identity.did(), missing),
        await joinVisitedRoomOf(runtime, home, identity.did(), misplaced),
      ]).toStrictEqual(["space-root-missing", "space-root-misplaced"]);
      expect(await joinedNow()).toStrictEqual([]);
    });

    it("returns `no-chat-manager`, vetting nothing, for a Home whose chat manager has no `joinRoom`", async () => {
      const space = await visitedSpace({});
      // Home, but for a `chatManager` holding no `joinRoom` stream.
      const managerless = {
        key: (name: string) =>
          name === "chatManager"
            ? { key: () => ({ getRaw: () => undefined }) }
            : home.key(name as never),
      };

      expect(
        await joinVisitedRoomOf(
          runtime,
          managerless as never,
          identity.did(),
          space,
        ),
      ).toBe("no-chat-manager");
      expect(await joinedNow()).toStrictEqual([]);
    });
  });

  describe("PiecesController.joinVisitedRoom()", () => {
    it("joins the visitor to the room through their Home's chat manager", async () => {
      const space = await visitedSpace({});

      expect(await controller.joinVisitedRoom(space)).toBe("sent");
      expect(await joinedNow()).toStrictEqual([{ space, named: false }]);
    });
  });
});
