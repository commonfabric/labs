import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { Frame } from "../src/builder/types.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { LoopbackStorageManager } from "../src/executor/loopback-storage.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { TEST_SESSION_OPEN_AUDIENCE } from "./memory-v2-test-utils.ts";

const alice = await Identity.fromPassphrase("creator-only space alice");
const bob = await Identity.fromPassphrase("creator-only space bob");
const carol = await Identity.fromPassphrase("creator-only space carol");
const service = await Identity.fromPassphrase("creator-only space service");
const servedHome = (await Identity.fromPassphrase("creator-only space home"))
  .did() as MemorySpace;

/**
 * A pattern whose `create` handler makes a `Room` in a creator-only space and
 * pushes it onto `rooms`, and whose `createPlain` handler does the same with a
 * plain `inSpace()`.
 */
const ROOM_PATTERN = [
  "import { handler, pattern, Writable } from 'commonfabric';",
  "import type { SpaceMember } from 'commonfabric';",
  "const Room = pattern<{ title: string }, { title: string }>(",
  "  ({ title }) => ({ title }),",
  ");",
  "type CreateEvent = { name?: string; members?: SpaceMember[] };",
  "const create = handler<CreateEvent, { rooms: Writable<unknown[]> }>(",
  "  (event, { rooms }) => {",
  "    rooms.push(",
  "      Room.inSpace(event.name, {",
  "        access: 'creator',",
  "        members: event.members,",
  "      })({ title: 'a room' }),",
  "    );",
  "  },",
  ");",
  "const createPlain = handler<CreateEvent, { rooms: Writable<unknown[]> }>(",
  "  (event, { rooms }) => {",
  "    rooms.push(Room.inSpace(event.name)({ title: 'a plain room' }));",
  "  },",
  ");",
  "export default pattern<",
  "  { rooms: Writable<unknown[]> },",
  "  { rooms: unknown[]; create: unknown; createPlain: unknown }",
  ">(({ rooms }) => ({",
  "  rooms,",
  "  create: create({ rooms }),",
  "  createPlain: createPlain({ rooms }),",
  "}));",
].join("\n");

/** An event carrying `payload`, marked as the renderer marks a gesture. */
const gesture = (payload: Record<string, unknown>): Record<string, unknown> => {
  const event = {
    ...payload,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "RoomStartSurface",
        eventIntegrity: ["RoomStartSurface"],
        uiContractDataset: { uiAction: "RoomStart" },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
};

describe("creator-only inSpace()", () => {
  let server: MemoryV2Server.Server;
  let cleanups: Array<() => Promise<void>>;
  let storeSeq = 0;

  beforeEach(() => {
    storeSeq += 1;
    server = new MemoryV2Server.Server({
      store: new URL(`memory://creator-only-space-${storeSeq}`),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message) => {
        const iss = (message.invocation as { iss?: unknown } | undefined)?.iss;
        return typeof iss === "string" ? iss : undefined;
      },
      sessionOpenAuth: { audience: TEST_SESSION_OPEN_AUDIENCE },
      acl: { mode: "enforce", delegatingDids: [service.did()] },
    });
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  /**
   * A runtime over storage that can write a genesis, acting as `as`, serving
   * `servedHome` when `serving` is set. `registered` receives the DID of every
   * space identity its storage is handed.
   */
  const newRuntime = (
    as: Identity,
    options: { serving?: boolean } = {},
  ): {
    runtime: Runtime;
    manager: LoopbackStorageManager;
    registered: string[];
  } => {
    const manager = LoopbackStorageManager.connect(server, {
      as,
      ...(options.serving ? { servingHomeSpace: servedHome } : {}),
    });
    const registered: string[] = [];
    const register = manager.registerSpaceIdentity.bind(manager);
    manager.registerSpaceIdentity = (
      identity: Signer,
      registration?: Parameters<typeof register>[1],
    ) => {
      registered.push(identity.did());
      register(identity, registration);
    };
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      ...(options.serving
        ? { servingPosture: true, experimental: { serverExecution: true } }
        : {}),
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await manager.close();
    });
    return { runtime, manager, registered };
  };

  /** Compiles and runs `ROOM_PATTERN` in `as`'s home space. */
  const standUp = async (runtime: Runtime, as: Identity, name: string) => {
    const space = as.did() as MemorySpace;
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: ROOM_PATTERN }],
    }, { space });
    const result = runtime.getCell<{
      rooms: unknown[];
      create: unknown;
      createPlain: unknown;
    }>(space, name, compiled.resultSchema);
    await runtime.runSynced(result, compiled, { rooms: [] });
    return result;
  };

  /** Settles `runtime` and its storage. */
  const settle = async (runtime: Runtime): Promise<void> => {
    await runtime.idle();
    await runtime.storageManager.synced();
  };

  /** The errors `runtime`'s scheduler reports from now on. */
  const errorsOf = (runtime: Runtime): string[] => {
    const errors: string[] = [];
    runtime.scheduler.onError((error: Error) => {
      errors.push(error.message);
    });
    return errors;
  };

  /** The space the `index`th room of `result` lives in. */
  const roomSpace = (
    result: ReturnType<Runtime["getCell"]>,
    index: number,
  ): MemorySpace =>
    result.key("rooms").key(index).resolveAsCell().getAsNormalizedFullLink()
      .space;

  /** The access list the memory server holds for `space`. */
  const aclOf = async (space: MemorySpace): Promise<unknown> =>
    (await server.readDocument(space, `of:${space}`))?.value;

  /**
   * Runs `fn` under a pushed handler frame over `tx`, calling from `space`,
   * whose event was a trusted gesture when `trustedGesture` is set.
   */
  const inHandler = <T>(
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    space: MemorySpace,
    trustedGesture: boolean,
    fn: (frame: Frame) => T,
  ): T => {
    const frame = pushFrame({
      runtime,
      tx,
      space,
      inHandler: true,
      frameKind: "handler",
      trustedGesture,
    });
    try {
      return fn(frame);
    } finally {
      popFrame(frame);
    }
  };

  /** A `Room` pattern factory, built under a frame on `runtime`. */
  const roomFactory = (runtime: Runtime) => {
    const frame = pushFrame({ runtime });
    try {
      return pattern<{ title: string }, { title: string }>(
        ({ title }) => ({ title }),
      );
    } finally {
      popFrame(frame);
    }
  };

  describe("PatternFactory.inSpace() options", () => {
    const refusals: Array<[string, unknown, unknown, string]> = [
      [
        "a DID target",
        alice.did(),
        { access: "creator" },
        "not a DID or a cell",
      ],
      [
        "an access other than `creator`",
        "room",
        { access: "everyone" },
        "options must be",
      ],
      ["a wildcard member", "room", {
        access: "creator",
        members: [{ principal: "*", level: "WRITE" }],
      }, "never the wildcard"],
      ["a member that is not a DID", "room", {
        access: "creator",
        members: [{ principal: "bob", level: "WRITE" }],
      }, "must be a principal's DID"],
      ["a member at `READ`", "room", {
        access: "creator",
        members: [{ principal: bob.did(), level: "READ" }],
      }, "admitted at `WRITE` or `OWNER`"],
      ["a member listed twice", "room", {
        access: "creator",
        members: [
          { principal: bob.did(), level: "WRITE" },
          { principal: bob.did(), level: "OWNER" },
        ],
      }, "as a member twice"],
    ];
    for (const [what, target, options, message] of refusals) {
      it(`throws given ${what}`, () => {
        const { runtime } = newRuntime(alice);
        const Room = roomFactory(runtime);
        expect(() =>
          Room.inSpace(target as string, options as { access: "creator" })
        ).toThrow(message);
      });
    }

    it("throws given a cell target", () => {
      const { runtime } = newRuntime(alice);
      const Room = roomFactory(runtime);
      const cell = runtime.getCell(alice.did(), "creator-only-cell-target");
      expect(() => Room.inSpace(cell, { access: "creator" })).toThrow(
        "not a DID or a cell",
      );
    });

    it("accepts a name with members at `WRITE` and `OWNER`", () => {
      const { runtime } = newRuntime(alice);
      const Room = roomFactory(runtime);
      expect(() =>
        Room.inSpace("room", {
          access: "creator",
          members: [
            { principal: bob.did(), level: "WRITE" },
            { principal: carol.did(), level: "OWNER" },
          ],
        })
      ).not.toThrow();
    });
  });

  describe("where it may run", () => {
    it("throws in a `lift()` frame", () => {
      const { runtime } = newRuntime(alice);
      const Room = roomFactory(runtime).inSpace("room", { access: "creator" });
      const tx = runtime.edit();
      const frame = pushFrame({
        runtime,
        tx,
        space: alice.did() as MemorySpace,
        frameKind: "lift",
      });
      try {
        expect(() => Room({ title: "a room" })).toThrow(
          "available only in a handler",
        );
      } finally {
        popFrame(frame);
        tx.abort(new Error("test-only"));
      }
    });

    it("throws in a pattern body, even one built inside a handler", () => {
      const { runtime } = newRuntime(alice);
      const Room = roomFactory(runtime).inSpace("room", { access: "creator" });
      const tx = runtime.edit();
      try {
        inHandler(runtime, tx, alice.did() as MemorySpace, true, () => {
          expect(() =>
            pattern(() => {
              Room({ title: "a room" });
              return {};
            })
          ).toThrow("available only in a handler");
        });
      } finally {
        tx.abort(new Error("test-only"));
      }
    });

    it("throws in a `computed()` in a compiled pattern", async () => {
      const { runtime } = newRuntime(alice);
      const errors = errorsOf(runtime);
      const space = alice.did() as MemorySpace;
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "const Room = pattern<{ title: string }, { title: string }>(",
            "  ({ title }) => ({ title }),",
            ");",
            "export default pattern<{}, { room: unknown }>(() => ({",
            "  room: computed(() =>",
            "    Room.inSpace('room', { access: 'creator' })({ title: 't' })",
            "  ),",
            "}));",
          ].join("\n"),
        }],
      }, { space });
      const result = runtime.getCell<{ room: unknown }>(
        space,
        "creator-only-computed",
        compiled.resultSchema,
      );
      await runtime.runSynced(result, compiled, {});
      const cancel = result.sink(() => {});
      try {
        await settle(runtime);
        expect(errors.some((e) => e.includes("available only in a handler")))
          .toBe(true);
      } finally {
        cancel();
      }
    });
  });

  describe("in a client handler", () => {
    it("names exactly the creator as OWNER and the members at their levels", async () => {
      const { runtime } = newRuntime(alice);
      const result = await standUp(runtime, alice, "genesis-members");
      await result.key("create").send(gesture({
        name: "room",
        members: [
          { principal: bob.did(), level: "WRITE" },
          { principal: carol.did(), level: "OWNER" },
        ],
      }));
      await settle(runtime);

      const space = roomSpace(result, 0);
      expect(space).not.toBe(alice.did());
      expect(await aclOf(space)).toEqual({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
        [carol.did()]: "OWNER",
      });
    });

    it("names exactly the creator with no members, and needs no gesture", async () => {
      const { runtime } = newRuntime(alice);
      const result = await standUp(runtime, alice, "genesis-alone");
      await result.key("create").send({ name: "room" });
      await settle(runtime);

      expect(await aclOf(roomSpace(result, 0))).toEqual({
        [alice.did()]: "OWNER",
      });
    });

    it("names the runtime's own user as creator, whatever the event payload names", async () => {
      const { runtime } = newRuntime(alice);
      const result = await standUp(runtime, alice, "genesis-payload");
      await result.key("create").send({
        acting: { user: bob.did(), session: "bob-session" },
        user: bob.did(),
        principal: bob.did(),
        creator: bob.did(),
        firedAt: { user: bob.did(), session: "bob-session" },
      });
      await settle(runtime);

      expect(await aclOf(roomSpace(result, 0))).toEqual({
        [alice.did()]: "OWNER",
      });
    });

    it("creates no space and commits nothing when `members` comes without a trusted gesture", async () => {
      const { runtime, registered } = newRuntime(alice);
      const errors = errorsOf(runtime);
      const result = await standUp(runtime, alice, "no-gesture");
      await result.key("create").send({
        name: "room",
        members: [{ principal: bob.did(), level: "WRITE" }],
      });
      await settle(runtime);

      expect(errors.some((e) => e.includes("needs a trusted gesture")))
        .toBe(true);
      expect(registered).toEqual([]);
      expect(result.key("rooms").get()).toEqual([]);

      // The same event as a gesture creates the room, so what refused the
      // one above was the missing gesture.
      await result.key("create").send(gesture({
        name: "room",
        members: [{ principal: bob.did(), level: "WRITE" }],
      }));
      await settle(runtime);
      expect(registered).toHaveLength(1);
      expect(await aclOf(roomSpace(result, 0))).toEqual({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
    });

    it("refuses the creator as a member, and creates no space", async () => {
      const { runtime, registered } = newRuntime(alice);
      const errors = errorsOf(runtime);
      const result = await standUp(runtime, alice, "creator-member");
      await result.key("create").send(gesture({
        name: "room",
        members: [{ principal: alice.did(), level: "WRITE" }],
      }));
      await settle(runtime);

      expect(errors.some((e) => e.includes("lists its creator"))).toBe(true);
      expect(registered).toEqual([]);
      expect(result.key("rooms").get()).toEqual([]);
    });

    it("reaches the recorded space again on a later run, creating no second one", async () => {
      const { runtime, registered } = newRuntime(alice);
      const result = await standUp(runtime, alice, "rerun");
      await result.key("create").send({ name: "room" });
      await settle(runtime);
      await result.key("create").send({ name: "room" });
      await settle(runtime);

      expect(result.key("rooms").get()).toHaveLength(2);
      expect(roomSpace(result, 1)).toBe(roomSpace(result, 0));
      expect(registered).toEqual([roomSpace(result, 0)]);
    });

    it("gives each name, and each anonymous call, a space of its own", async () => {
      const { runtime, registered } = newRuntime(alice);
      const result = await standUp(runtime, alice, "distinct");
      await result.key("create").send({ name: "one" });
      await settle(runtime);
      await result.key("create").send({ name: "two" });
      await settle(runtime);
      await result.key("create").send({});
      await settle(runtime);

      const spaces = [0, 1, 2].map((index) => roomSpace(result, index));
      expect(new Set(spaces).size).toBe(3);
      expect(registered).toEqual(spaces);
    });

    it("never reaches the space a plain `inSpace()` of the same name reaches", async () => {
      const { runtime } = newRuntime(alice);
      const result = await standUp(runtime, alice, "namespace");
      await result.key("createPlain").send({ name: "shared-name" });
      await settle(runtime);
      await result.key("create").send({ name: "shared-name" });
      await settle(runtime);

      const plain = roomSpace(result, 0);
      const creatorOnly = roomSpace(result, 1);
      expect(plain).toBe(await runtime.resolveSpaceName("shared-name"));
      expect(creatorOnly).not.toBe(plain);
      expect(await aclOf(creatorOnly)).toEqual({ [alice.did()]: "OWNER" });
    });

    it("keeps no key for the space once its genesis is confirmed", async () => {
      const { runtime, manager, registered } = newRuntime(alice);
      const result = await standUp(runtime, alice, "forgotten-key");
      await result.key("create").send({ name: "room" });
      await settle(runtime);

      const space = roomSpace(result, 0);
      // The storage held this space's key once, to write its genesis.
      expect(registered).toEqual([space]);
      expect(manager.accessForTestingOnly.spaceIdentities.has(space))
        .toBe(false);
    });

    it("converges concurrent creations on the recorded space", async () => {
      const first = newRuntime(alice);
      const second = newRuntime(alice);
      const firstResult = await standUp(first.runtime, alice, "concurrent");
      const secondResult = await standUp(second.runtime, alice, "concurrent");

      await Promise.all([
        firstResult.key("create").send({ name: "room" }),
        secondResult.key("create").send({ name: "room" }),
      ]);
      await Promise.all([settle(first.runtime), settle(second.runtime)]);
      await waitForCellValue<unknown[]>(
        first.runtime,
        firstResult.key("rooms"),
        (rooms) => rooms?.length === 2,
      );

      // Each runtime created a space before either saw the other's record,
      // so exactly one of the two is the one both rooms reach.
      expect(first.registered).toHaveLength(1);
      expect(second.registered).toHaveLength(1);
      expect(first.registered[0]).not.toBe(second.registered[0]);
      const recorded = roomSpace(firstResult, 0);
      expect(roomSpace(firstResult, 1)).toBe(recorded);
      expect([first.registered[0], second.registered[0]]).toContain(recorded);
    });
  });

  describe("over storage that writes no genesis", () => {
    it("throws rather than create a space with no access list", async () => {
      const manager = EmulatedStorageManager.connectTo(server, { as: alice });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
      });
      cleanups.push(async () => {
        await runtime.dispose();
        await manager.close();
      });
      await expect(runtime.createCreatorSpace({
        key: "no-genesis",
        creator: alice.did(),
        members: {},
      })).rejects.toThrow("cannot bootstrap an ACL");
    });
  });

  describe("on a serving runtime", () => {
    /** Opens a serving transaction stamped as a handler run. */
    const servedHandlerTx = (
      runtime: Runtime,
      stamp: { acting?: string; instanceOwner?: string },
    ): IExtendedStorageTransaction => {
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "handler/creator-only-space",
        kind: "event-handler",
        eventId: "event-1",
        ...(stamp.acting !== undefined
          ? { acting: { user: stamp.acting, session: "acting-session" } }
          : {}),
        ...(stamp.instanceOwner !== undefined
          ? {
            scopeKeyIdentity: {
              principal: stamp.instanceOwner,
              sessionId: "owner-session",
            },
          }
          : {}),
      });
      return tx;
    };

    /**
     * Invokes a creator-only `Room` under a served handler frame, then runs
     * the runner's resolution of what that left pending, and returns the
     * frame.
     */
    const createServed = async (
      runtime: Runtime,
      tx: IExtendedStorageTransaction,
      options: { members?: { principal: `did:${string}`; level: "WRITE" }[] },
    ): Promise<Frame> => {
      const Room = roomFactory(runtime).inSpace("served-room", {
        access: "creator",
        ...options,
      });
      const frame = inHandler(runtime, tx, servedHome, true, (frame) => {
        Room({ title: "a served room" });
        return frame;
      });
      await expect(
        runtime.runner.accessForTestingOnly.resolvePendingSpaceNamesAndRetry(
          frame,
          tx,
        ),
      ).rejects.toThrow();
      return frame;
    };

    it("creates a creator-only space owned by the actor, not the instance owner", async () => {
      const { runtime, registered } = newRuntime(service, { serving: true });
      const tx = servedHandlerTx(runtime, {
        acting: alice.did(),
        instanceOwner: bob.did(),
      });
      try {
        const frame = await createServed(runtime, tx, {});
        const [pending] = [...frame.pendingCreatorSpaces!.values()];
        expect(pending.creator).toBe(alice.did());
        const space = runtime.preparedCreatorSpace(pending.key)!;
        expect(registered).toEqual([space]);
        expect(await aclOf(space)).toEqual({ [alice.did()]: "OWNER" });
      } finally {
        tx.abort(new Error("test-only"));
      }
    });

    it("refuses `members`, creating no space", async () => {
      const { runtime, registered } = newRuntime(service, { serving: true });
      const tx = servedHandlerTx(runtime, { acting: alice.did() });
      try {
        const Room = roomFactory(runtime).inSpace("served-room", {
          access: "creator",
          members: [{ principal: bob.did(), level: "WRITE" }],
        });
        const frame = inHandler(runtime, tx, servedHome, true, (frame) => {
          Room({ title: "a served room" });
          return frame;
        });
        await expect(
          runtime.runner.accessForTestingOnly.resolvePendingSpaceNamesAndRetry(
            frame,
            tx,
          ),
        ).rejects.toThrow("does not create a space with `members`");
        expect(registered).toEqual([]);
      } finally {
        tx.abort(new Error("test-only"));
      }
    });

    it("throws in a run that acts for no principal, creating no space", () => {
      const { runtime, registered } = newRuntime(service, { serving: true });
      const tx = servedHandlerTx(runtime, { instanceOwner: bob.did() });
      try {
        const Room = roomFactory(runtime).inSpace("served-room", {
          access: "creator",
        });
        inHandler(runtime, tx, servedHome, true, () => {
          expect(() => Room({ title: "a served room" })).toThrow(
            "this run acts for none",
          );
        });
        expect(registered).toEqual([]);
      } finally {
        tx.abort(new Error("test-only"));
      }
    });
  });
});
