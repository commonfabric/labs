import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { SpaceAccessFunction } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import * as Engine from "@commonfabric/memory/v2/engine";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { spaceAccess } from "../../src/builder/space-access.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { ExecutorHost } from "../../src/executor/host.ts";
import { stampWaveRunContext } from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { ArrivalLog, awaitAdmitted } from "../support/serving-waits.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const AUDIENCE = "did:key:z6Mk-runner-space-access-audience";

const spaceSigner = await Identity.fromPassphrase("space-access space");
const space = spaceSigner.did() as MemorySpace;
const alice = await Identity.fromPassphrase("space-access alice");
const bob = await Identity.fromPassphrase("space-access bob");
const carol = await Identity.fromPassphrase("space-access carol");
const dave = await Identity.fromPassphrase("space-access dave");
const service = await Identity.fromPassphrase("space-access service");

type AclValue = Record<string, "OWNER" | "WRITE" | "READ">;

describe("spaceAccess()", () => {
  let server: Server;
  let cleanups: (() => Promise<void>)[];
  let serverCount = 0;
  let sessionOpens: { principal?: string; space: string }[];

  beforeEach(() => {
    cleanups = [];
    sessionOpens = [];
    server = new Server({
      store: new URL(`memory://space-access-${++serverCount}`),
      authorizeSessionOpen: async (message, context) => {
        const principal = await authorizeLoopbackSessionOpen(message, context);
        sessionOpens.push({ principal, space: message.space });
        return principal;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      acl: {
        mode: "enforce",
        serviceDids: [service.did()],
        delegatingDids: [service.did()],
      },
      subscriptionRefreshDelayMs: 0,
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  /**
   * Returns a function writing a document in the space `owner` is the
   * identity of, `space` unless given, on the memory server `on`, the test's
   * own unless given. It writes as the service identity, which the test's
   * memory server treats as an owner of every space, genesis included.
   */
  async function writerFor(
    owner: Identity = spaceSigner,
    on: Server = server,
  ): Promise<(id: string, value: FabricValue) => Promise<void>> {
    const target = owner.did() as MemorySpace;
    const client = await connect({ transport: loopback(on) });
    cleanups.push(() => client.close());
    const session = await client.mount(
      target,
      {},
      (_space, _options, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: service.did() },
      }),
    );
    let localSeq = 0;
    return async (id, value) => {
      await session.transact({
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: id as URI, value: { value } }],
      });
    };
  }

  /**
   * Returns a setter for the access list of the space `owner` is the identity
   * of, `space` unless given, which writes as that identity.
   */
  async function aclWriter(
    owner: Identity = spaceSigner,
  ): Promise<(acl: AclValue) => Promise<void>> {
    const write = await writerFor(owner);
    return (acl) => write(`of:${owner.did()}`, acl);
  }

  /**
   * Returns how many sessions `user` has asked the memory server to open on
   * `target`, `space` unless given, whether it admitted them or not.
   */
  function sessionOpensBy(user: Identity, target: MemorySpace = space): number {
    return sessionOpens.filter((open) =>
      open.principal === user.did() && open.space === target
    ).length;
  }

  /** Returns a client runtime acting as `user`. */
  function clientRuntime(user: Identity): Runtime {
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: user,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await storageManager.close();
    });
    return runtime;
  }

  /** Returns a serving runtime, whose sessions read as each space's owner. */
  function servingRuntime(): Runtime {
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: service,
      servingHomeSpace: space,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await storageManager.close();
    });
    return runtime;
  }

  /**
   * Brings the access list of `target`, `space` unless given, into
   * `runtime`'s replica, or tries to.
   */
  async function syncAcl(
    runtime: Runtime,
    target: MemorySpace = space,
  ): Promise<void> {
    await runtime.getCellFromLink({
      space: target,
      id: `of:${target}` as URI,
      path: [],
    }).sync();
    await runtime.storageManager.synced();
  }

  /** Returns a transaction whose run acts for `principal`, if one is given. */
  function servedTx(
    runtime: Runtime,
    principal?: Identity,
  ): IExtendedStorageTransaction {
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "space-access/test",
      kind: "derivation",
      ...(principal === undefined ? {} : {
        scopeKeyIdentity: { principal: principal.did(), sessionId: "s" },
      }),
    });
    return tx;
  }

  /**
   * Returns a transaction for a served handler run on `owner`'s instance,
   * fired by `actor` if one is given.
   */
  function handlerTx(
    runtime: Runtime,
    owner: Identity,
    actor?: Identity,
  ): IExtendedStorageTransaction {
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "space-access/handler",
      kind: "event-handler",
      eventId: "space-access-event",
      scopeKeyIdentity: { principal: owner.did(), sessionId: "owner" },
      ...(actor === undefined
        ? {}
        : { acting: { user: actor.did(), session: "actor" } }),
    });
    return tx;
  }

  /** Returns the space a frame built from `options` runs in. */
  function frameSpaceOf(options: { frameSpace?: MemorySpace }): MemorySpace {
    return options.frameSpace ?? space;
  }

  /**
   * Calls `spaceAccess()` as code in a `kind` frame of `frameSpace` would,
   * through `tx`, and returns what it returns. The target is `target`, or a
   * cell in `frameSpace`.
   */
  function callIn(
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    options: {
      kind?: "lift" | "handler";
      frameSpace?: MemorySpace;
      target?: Cell<unknown>;
    } = {},
  ): ReturnType<typeof spaceAccess> {
    const frame = pushFrame({
      runtime,
      tx,
      space: frameSpaceOf(options),
      frameKind: options.kind ?? "lift",
    });
    try {
      return spaceAccess(
        options.target ??
          runtime.getCell<unknown>(frameSpaceOf(options), "space-access here"),
      );
    } finally {
      popFrame(frame);
    }
  }

  describe("on a client", () => {
    it("returns each member's level from the access list", async () => {
      const setAcl = await aclWriter();
      await setAcl({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
        [carol.did()]: "READ",
      });

      for (
        const [user, level] of [
          [alice, "OWNER"],
          [bob, "WRITE"],
          [carol, "READ"],
        ] as const
      ) {
        const runtime = clientRuntime(user);
        await syncAcl(runtime);
        expect(callIn(runtime, runtime.edit())).toBe(level);
      }
    });

    it("returns the `*` entry's level to a principal the list does not name, and a named entry over it", async () => {
      const setAcl = await aclWriter();
      await setAcl({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
        "*": "READ",
      });

      const daveRuntime = clientRuntime(dave);
      await syncAcl(daveRuntime);
      expect(callIn(daveRuntime, daveRuntime.edit())).toBe("READ");

      const bobRuntime = clientRuntime(bob);
      await syncAcl(bobRuntime);
      expect(callIn(bobRuntime, bobRuntime.edit())).toBe("WRITE");
    });

    it("returns `none` to the space's own identity when the list does not name it", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER" });

      const runtime = clientRuntime(spaceSigner);
      await syncAcl(runtime);
      expect(callIn(runtime, runtime.edit())).toBe("none");
    });

    it("returns `none` to a principal the memory server refuses the space", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER" });

      const runtime = clientRuntime(dave);
      await syncAcl(runtime);
      expect(runtime.storageManager.spaceAccessError?.(space)?.name).toBe(
        "AuthorizationError",
      );
      expect(callIn(runtime, runtime.edit())).toBe("none");
    });

    it("returns `undefined` before the access list has arrived", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });

      const runtime = clientRuntime(bob);
      expect(callIn(runtime, runtime.edit())).toBeUndefined();

      // The same runtime returns the level once the list is in, so what the
      // first call lacked was the list and nothing else.
      await syncAcl(runtime);
      expect(callIn(runtime, runtime.edit())).toBe("WRITE");
    });

    it("returns `undefined` for a space that has no access list", async () => {
      const runtime = clientRuntime(bob);
      await syncAcl(runtime);
      expect(runtime.storageManager.spaceAccessError?.(space)).toBeUndefined();
      expect(callIn(runtime, runtime.edit())).toBeUndefined();
    });

    it("returns the level in a cell's space, not the calling code's", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [carol.did()]: "READ" });

      const home = carol.did() as MemorySpace;
      await (await aclWriter(carol))({ [home]: "OWNER" });

      const runtime = clientRuntime(carol);
      await syncAcl(runtime);
      await syncAcl(runtime, home);
      const target = runtime.getCell<unknown>(space, "space-access target");

      expect(callIn(runtime, runtime.edit(), { frameSpace: home, target }))
        .toBe("READ");
      expect(callIn(runtime, runtime.edit(), { frameSpace: home }))
        .toBe("OWNER");
    });

    it("returns the level in the space a linked cell's value lives in", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [carol.did()]: "READ" });
      const home = carol.did() as MemorySpace;
      await (await aclWriter(carol))({ [home]: "OWNER" });

      const runtime = clientRuntime(carol);
      await syncAcl(runtime);
      const tx = runtime.edit();
      const link = runtime.getCell<unknown>(
        home,
        "space-access link",
        undefined,
        tx,
      );
      link.set(runtime.getCell<unknown>(space, "space-access target"));
      expect((await tx.commit()).error).toBeUndefined();

      expect(
        callIn(runtime, runtime.edit(), { frameSpace: home, target: link }),
      )
        .toBe("READ");
    });

    it("returns `undefined` for a target passed as `undefined`, not the calling code's level", async () => {
      const home = bob.did() as MemorySpace;
      await (await aclWriter(bob))({ [home]: "OWNER" });

      const runtime = clientRuntime(bob);
      await syncAcl(runtime, home);
      const frame = pushFrame({
        runtime,
        tx: runtime.edit(),
        space: bob.did() as MemorySpace,
        frameKind: "lift",
      });
      try {
        const home = runtime.getCell<unknown>(
          bob.did() as MemorySpace,
          "space-access here",
        );
        expect(spaceAccess(home)).toBe("OWNER");
        expect(spaceAccess(undefined)).toBeUndefined();
      } finally {
        popFrame(frame);
      }
    });

    it("returns the runtime user's level in a handler", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });

      const runtime = clientRuntime(bob);
      await syncAcl(runtime);
      expect(callIn(runtime, runtime.edit(), { kind: "handler" })).toBe(
        "WRITE",
      );
    });

    it("narrows a computation's read scope to `user`", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });

      const runtime = clientRuntime(bob);
      await syncAcl(runtime);
      const tx = runtime.edit();
      expect(tx.getNarrowestReadScope()).toBe("space");
      expect(callIn(runtime, tx)).toBe("WRITE");
      expect(tx.getNarrowestReadScope()).toBe("user");

      // An answer that needs no read narrows it all the same.
      const unknownTx = runtime.edit();
      const frame = pushFrame({
        runtime,
        tx: unknownTx,
        space,
        frameKind: "lift",
      });
      try {
        expect(spaceAccess(undefined)).toBeUndefined();
      } finally {
        popFrame(frame);
      }
      expect(unknownTx.getNarrowestReadScope()).toBe("user");
    });
  });

  describe("on a serving runtime", () => {
    it("returns each demanding principal's own level, not the serving session's", async () => {
      const setAcl = await aclWriter();
      await setAcl({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
        [carol.did()]: "READ",
      });

      const runtime = servingRuntime();
      await syncAcl(runtime);
      expect(callIn(runtime, servedTx(runtime, bob))).toBe("WRITE");
      expect(callIn(runtime, servedTx(runtime, carol))).toBe("READ");
      expect(callIn(runtime, servedTx(runtime, dave))).toBe("none");
    });

    it("returns `undefined` to a run with no demanding principal", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER" });

      const runtime = servingRuntime();
      await syncAcl(runtime);
      expect(callIn(runtime, servedTx(runtime))).toBeUndefined();
    });

    it("narrows a computation's read scope to `user`, with or without a demanding principal", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });

      const runtime = servingRuntime();
      await syncAcl(runtime);
      const demanded = servedTx(runtime, bob);
      expect(callIn(runtime, demanded)).toBe("WRITE");
      expect(demanded.getNarrowestReadScope()).toBe("user");

      const undemanded = servedTx(runtime);
      expect(callIn(runtime, undemanded)).toBeUndefined();
      expect(undemanded.getNarrowestReadScope()).toBe("user");
    });
  });

  describe("in a served handler", () => {
    it("returns the event's actor's level, not the instance owner's", async () => {
      const setAcl = await aclWriter();
      await setAcl({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
        [carol.did()]: "READ",
      });

      const runtime = servingRuntime();
      await syncAcl(runtime);
      expect(
        callIn(runtime, handlerTx(runtime, bob, carol), { kind: "handler" }),
      ).toBe("READ");
      expect(
        callIn(runtime, handlerTx(runtime, carol, bob), { kind: "handler" }),
      ).toBe("WRITE");
    });

    it("returns `undefined` to a run with no actor", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });

      const runtime = servingRuntime();
      await syncAcl(runtime);
      expect(callIn(runtime, handlerTx(runtime, bob), { kind: "handler" }))
        .toBeUndefined();
    });
  });

  describe("in a dependent computation", () => {
    const resultSchema = {
      type: "object",
      properties: { level: { type: "string" }, derived: { type: "string" } },
    } as const satisfies JSONSchema;

    /**
     * Runs, in `user`'s home space, a pattern whose computation `level`
     * returns `user`'s level in the space of a cell in `space`, and returns
     * the result cell; `unknown` stands in for `undefined`. The computation
     * takes the cell as a cell, or with `byValue` as the value it holds. A
     * second computation, `derived`, reads `level`'s value and nothing else.
     */
    async function levelCell(
      runtime: Runtime,
      user: Identity,
      options: { byValue?: boolean } = {},
    ): Promise<Cell<{ level?: string; derived?: string }>> {
      const argumentSchema = {
        type: "object",
        properties: {
          target: options.byValue
            ? { type: "object" }
            : { type: "unknown", asCell: ["cell"] },
        },
      } as const satisfies JSONSchema;
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const level = lift(
        (input: { target?: unknown }) =>
          spaceAccess(input.target as Cell<unknown>) ?? "unknown",
        argumentSchema,
        { type: "string" },
      );
      const derive = lift(
        (input: { level?: string }) => `derived:${input.level}`,
        { type: "object", properties: { level: { type: "string" } } },
        { type: "string" },
      );
      const levelPattern = pattern(
        ({ target }) => {
          const levelOf = level({ target });
          return { level: levelOf, derived: derive({ level: levelOf }) };
        },
        argumentSchema,
        resultSchema,
      );

      const home = user.did() as MemorySpace;
      await (await aclWriter(user))({ [home]: "OWNER" });
      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        home,
        "space-access level",
        undefined,
        tx,
      );
      const target = runtime.getCell<unknown>(space, "space-access target");
      const result = runtime.run(tx, levelPattern, { target }, resultCell);
      await tx.commit();
      return result as Cell<{ level?: string; derived?: string }>;
    }

    it("writes its value where only its own user reads it", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });

      const runtime = clientRuntime(bob);
      const level = (await levelCell(runtime, bob)).key("level");
      await waitForCellValue(runtime, level, (v) => v === "WRITE", {
        stuckLabel: "bob's level to arrive as `WRITE`",
      });
      expect(level.resolveAsCell().getAsNormalizedFullLink().scope).toBe(
        "user",
      );
    });

    it("writes a computation that reads only its value where only its own user reads it", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });

      const runtime = clientRuntime(bob);
      const derived = (await levelCell(runtime, bob)).key("derived");
      await waitForCellValue(runtime, derived, (v) => v === "derived:WRITE", {
        stuckLabel: "bob's derived value to arrive as `derived:WRITE`",
      });
      expect(derived.resolveAsCell().getAsNormalizedFullLink().scope).toBe(
        "user",
      );
    });

    it("returns the level in the space of a value it reads, and `undefined` for one it cannot read", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });
      const bobRuntime = clientRuntime(bob);
      const targetId = bobRuntime.getCell<unknown>(space, "space-access target")
        .getAsNormalizedFullLink().id;
      await (await writerFor())(targetId, { note: "in the space" });

      const bobLevel = (await levelCell(bobRuntime, bob, { byValue: true }))
        .key("level");
      await waitForCellValue(bobRuntime, bobLevel, (v) => v === "WRITE", {
        stuckLabel: "bob's level to arrive as `WRITE`",
      });

      const daveRuntime = clientRuntime(dave);
      const daveLevel = (await levelCell(daveRuntime, dave, { byValue: true }))
        .key("level");
      await waitForCellValue(daveRuntime, daveLevel, (v) => v !== undefined, {
        stuckLabel: "dave's level to arrive",
      });
      expect(daveLevel.get()).toBe("unknown");
    });

    it("runs again when a grant or revoke changes the level", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });

      const runtime = clientRuntime(bob);
      const level = (await levelCell(runtime, bob)).key("level");
      await waitForCellValue(runtime, level, (v) => v === "WRITE", {
        stuckLabel: "bob's level to arrive as `WRITE`",
      });

      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "READ" });
      await waitForCellValue(runtime, level, (v) => v === "READ", {
        stuckLabel: "bob's level to follow the grant down to `READ`",
      });

      await setAcl({ [alice.did()]: "OWNER" });
      await waitForCellValue(runtime, level, (v) => v === "none", {
        stuckLabel: "bob's level to follow the revoke to `none`",
      });
    });

    it("runs again when the memory server refuses the space, and again when it readmits the runtime after a grant", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER" });

      const runtime = clientRuntime(dave);
      const level = (await levelCell(runtime, dave)).key("level");
      await waitForCellValue(runtime, level, (v) => v === "none", {
        stuckLabel: "dave's level to arrive as `none`",
      });

      // A read of a document the replica has not asked for opens the space
      // again, and the memory server now admits it.
      await setAcl({ [alice.did()]: "OWNER", [dave.did()]: "READ" });
      const reopened = await runtime.storageManager.open(space).sync(
        "of:space-access-reopen" as URI,
      );
      expect(reopened.error).toBeUndefined();
      await waitForCellValue(runtime, level, (v) => v === "READ", {
        stuckLabel: "dave's level to follow the grant to `READ`",
      });
    });

    describe("when the host retries the space", () => {
      /**
       * Returns dave's level cell once it reads `none`, the memory server
       * having refused dave's runtime the space, and every load that refusal
       * set off has been refused too.
       */
      async function refusedLevel(
        runtime: Runtime,
      ): Promise<Cell<string | undefined>> {
        const level = (await levelCell(runtime, dave)).key("level");
        await waitForCellValue(runtime, level, (v) => v === "none", {
          stuckLabel: "dave's level to arrive as `none`",
        });
        await runtime.idle();
        await runtime.storageManager.synced();
        return level as Cell<string | undefined>;
      }

      it("stays `none` after a grant until the host retries the space", async () => {
        const setAcl = await aclWriter();
        await setAcl({ [alice.did()]: "OWNER" });
        const runtime = clientRuntime(dave);
        const level = await refusedLevel(runtime);

        // Dave's runtime holds no session on the space, so nothing the grant
        // commits reaches it.
        await setAcl({ [alice.did()]: "OWNER", [dave.did()]: "READ" });
        await runtime.idle();
        await runtime.storageManager.synced();
        expect(level.get()).toBe("none");
        expect(runtime.storageManager.spaceAccessError?.(space)?.name).toBe(
          "AuthorizationError",
        );
      });

      it("runs again with the granted level once the host retries the space", async () => {
        const setAcl = await aclWriter();
        await setAcl({ [alice.did()]: "OWNER" });
        const runtime = clientRuntime(dave);
        const level = await refusedLevel(runtime);

        await setAcl({ [alice.did()]: "OWNER", [dave.did()]: "READ" });
        await runtime.idle();
        expect(level.get()).toBe("none");
        const opens = sessionOpensBy(dave);
        await runtime.retrySpaceAccess(space);
        expect(sessionOpensBy(dave)).toBe(opens + 1);
        expect(runtime.storageManager.spaceAccessError?.(space))
          .toBeUndefined();
        await waitForCellValue(runtime, level, (v) => v === "READ", {
          stuckLabel: "dave's level to follow the retry to `READ`",
        });
      });

      it("runs again with the granted level when a refused open was still in flight at the retry", async () => {
        // The refusal runs the computation again, and its load opens the
        // space once more. That open is decided on the access list as it
        // stood before the grant, so the retry has to make its own.

        const setAcl = await aclWriter();
        await setAcl({ [alice.did()]: "OWNER" });
        const runtime = clientRuntime(dave);
        const level = (await levelCell(runtime, dave)).key("level");
        await waitForCellValue(runtime, level, (v) => v === "none", {
          stuckLabel: "dave's level to arrive as `none`",
        });
        const refusal = runtime.storageManager.spaceAccessError?.(space);

        await setAcl({ [alice.did()]: "OWNER", [dave.did()]: "READ" });
        // The second open has reached the memory server, and its refusal
        // has not reached the runtime, which would replace the first.
        expect(sessionOpensBy(dave)).toBe(2);
        expect(runtime.storageManager.spaceAccessError?.(space)).toBe(refusal);
        await runtime.retrySpaceAccess(space);
        expect(sessionOpensBy(dave)).toBe(3);
        await waitForCellValue(runtime, level, (v) => v === "READ", {
          stuckLabel: "dave's level to follow the retry to `READ`",
        });
      });

      it("loads again what the refusal kept from a computation that reads the space without calling it", async () => {
        const setAcl = await aclWriter();
        await setAcl({ [alice.did()]: "OWNER" });
        const runtime = clientRuntime(dave);
        const target = runtime.getCell<unknown>(space, "space-access target");
        const write = await writerFor();
        await write(target.getAsNormalizedFullLink().id, { note: "granted" });
        const noteSchema = {
          type: "object",
          properties: {
            target: {
              type: "object",
              properties: { note: { type: "string" } },
            },
          },
        } as const satisfies JSONSchema;
        const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
        const noteOf = lift(
          (input: { target?: { note?: string } }) =>
            input.target?.note ?? "unread",
          noteSchema,
          { type: "string" },
        );
        const notePattern = pattern(
          ({ target }) => ({ note: noteOf({ target }) }),
          noteSchema,
          { type: "object", properties: { note: { type: "string" } } },
        );
        const home = dave.did() as MemorySpace;
        await (await aclWriter(dave))({ [home]: "OWNER" });
        const tx = runtime.edit();
        const resultCell = runtime.getCell(
          home,
          "space-access note",
          undefined,
          tx,
        );
        const note =
          (runtime.run(tx, notePattern, { target }, resultCell) as Cell<
            { note?: string }
          >).key("note");
        await tx.commit();
        await waitForCellValue(runtime, note, (v) => v === "unread", {
          stuckLabel: "dave's note to arrive as `unread`",
        });
        await runtime.idle();
        await runtime.storageManager.synced();

        await setAcl({ [alice.did()]: "OWNER", [dave.did()]: "READ" });
        await runtime.retrySpaceAccess(space);
        await waitForCellValue(runtime, note, (v) => v === "granted", {
          stuckLabel: "dave's note to follow the retry to `granted`",
        });
      });

      it("stays `none`, without throwing, when the memory server refuses the space again", async () => {
        const setAcl = await aclWriter();
        await setAcl({ [alice.did()]: "OWNER" });
        const runtime = clientRuntime(dave);
        const level = await refusedLevel(runtime);
        const refusal = runtime.storageManager.spaceAccessError?.(space);
        expect(refusal?.name).toBe("AuthorizationError");
        const opens = sessionOpensBy(dave);

        await runtime.retrySpaceAccess(space);
        expect(sessionOpensBy(dave)).toBe(opens + 1);
        // A refusal of the retry's own session replaces the first one.
        const again = runtime.storageManager.spaceAccessError?.(space);
        expect(again?.name).toBe("AuthorizationError");
        expect(again).not.toBe(refusal);
        await runtime.idle();
        expect(level.get()).toBe("none");
      });

      it("opens nothing for a space the runtime has not opened", async () => {
        const setAcl = await aclWriter();
        await setAcl({ [alice.did()]: "OWNER" });
        const runtime = clientRuntime(dave);

        await runtime.retrySpaceAccess(space);
        expect(sessionOpensBy(dave)).toBe(0);
        expect(runtime.storageManager.openedSpaces?.()).not.toContain(space);
        expect(runtime.storageManager.spaceAccessError?.(space))
          .toBeUndefined();
      });

      it("opens no session for a member, whose level stays and keeps following the access list", async () => {
        const setAcl = await aclWriter();
        await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });
        const runtime = clientRuntime(bob);
        const level = (await levelCell(runtime, bob)).key("level");
        await waitForCellValue(runtime, level, (v) => v === "WRITE", {
          stuckLabel: "bob's level to arrive as `WRITE`",
        });

        const opens = sessionOpensBy(bob);
        await runtime.retrySpaceAccess(space);
        expect(sessionOpensBy(bob)).toBe(opens);
        expect(level.get()).toBe("WRITE");
        // The session still delivers the access list's changes.
        await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "READ" });
        await waitForCellValue(runtime, level, (v) => v === "READ", {
          stuckLabel: "bob's level to follow the grant down to `READ`",
        });
      });
    });
  });

  describe("downstream of a computation calling it, on a serving loop", () => {
    // Two principals with different levels demand the same piece, which runs
    // on the serving loop. `derived` reads `level` and never calls
    // `spaceAccess()` itself.

    const LEVEL_PATTERN = [
      "import { computed, pattern, spaceAccess, Writable } from 'commonfabric';",
      "export default pattern<",
      "  { anchor: Writable<string> },",
      "  { level: string; derived: string }",
      ">(({ anchor }) => {",
      "  const level = computed(() => spaceAccess(anchor) ?? 'unknown');",
      "  const derived = computed(() => 'derived:' + level);",
      "  return { level, derived };",
      "});",
    ].join("\n");

    /** Whether any document of the scope instance `scopeKey` holds `needle`. */
    const instanceHolds = (
      engine: Engine.Engine,
      scopeKey: string,
      needle: string,
    ): boolean =>
      (engine.database.prepare(
        `SELECT id FROM head WHERE scope_key = :scope_key AND op != 'delete'`,
      ).all({ scope_key: scopeKey }) as { id: string }[]).some(({ id }) =>
        JSON.stringify(
          Engine.read(engine, { id, scopeKey } as never)?.value ?? null,
        ).includes(needle)
      );

    it("gives each demanding principal their own value of a computation that reads only its value", async () => {
      const shared = newSharedServer({ subscriptionRefreshDelayMs: 0 });
      cleanups.push(() => shared.close());
      const activations = new ArrivalLog<string>();
      const host = new ExecutorHost({
        server: shared,
        serviceIdentity: service.did(),
        // deno-lint-ignore require-await
        createRuntime: async () => {
          const manager = EmulatedStorageManager.connectTo(shared, {
            as: service,
          });
          const runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: manager,
            servingPosture: true,
            experimental: { serverExecution: true },
          });
          return {
            runtime,
            dispose: async () => {
              await runtime.dispose();
              await manager.close();
            },
          };
        },
        policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
        ensureSpaceRoots: false,
        onActivationSettled: (activated, outcome) => {
          if (outcome === "active") activations.record(activated);
        },
      });
      cleanups.push(() => host.close());
      const openClient = (user: Identity): Runtime => {
        const manager = EmulatedStorageManager.connectTo(shared, { as: user });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: true },
        });
        cleanups.push(async () => {
          await runtime.dispose();
          await manager.close();
        });
        return runtime;
      };

      const writeAsSpace = await writerFor(spaceSigner, shared);
      await writeAsSpace(`of:${space}`, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
        [carol.did()]: "READ",
      });

      const aliceRuntime = openClient(alice);
      const engine = await shared.engineForSpace(space);
      const compiled = await aliceRuntime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: LEVEL_PATTERN }],
      }, { space });
      const argument = aliceRuntime.getCell<Record<string, unknown>>(
        space,
        "space-access served argument",
        undefined,
      );
      const result = aliceRuntime.getCell<Record<string, unknown>>(
        space,
        "space-access served result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      {
        const tx = aliceRuntime.edit();
        argument.withTx(tx).set({ anchor: "here" });
        expect((await tx.commit()).error).toBeUndefined();
      }
      {
        const tx = aliceRuntime.edit();
        aliceRuntime.run(tx, compiled, argument, result);
        expect((await tx.commit()).error).toBeUndefined();
      }
      await aliceRuntime.idle();
      await aliceRuntime.storageManager.synced();
      const resultId = result.getAsNormalizedFullLink().id;

      for (const user of [bob, carol]) {
        const runtime = openClient(user);
        const root = runtime.getCell<Record<string, unknown>>(
          space,
          "space-access served result",
          undefined,
        );
        await root.sync();
        const cancel = root.sink(() => {});
        cleanups.push(() => Promise.resolve(cancel()));
      }
      await activations.matching((activated) => activated === space);
      await awaitAdmitted(shared, () => {
        const demanded = host.spaceServer(space)?.demandedIdentitiesOf(
          resultId,
        ) ?? [];
        return [bob, carol].every((user) =>
          demanded.some((identity) => identity.principal === user.did())
        );
      });

      const bobKey = resolveScopeKey("user", { principal: bob.did() });
      const carolKey = resolveScopeKey("user", { principal: carol.did() });
      await awaitAdmitted(
        shared,
        () =>
          instanceHolds(engine, bobKey, '"derived:WRITE"') &&
          instanceHolds(engine, carolKey, '"derived:READ"'),
      );
      expect(instanceHolds(engine, bobKey, '"derived:READ"')).toBe(false);
      expect(instanceHolds(engine, carolKey, '"derived:WRITE"')).toBe(false);
      // The space instance holds the argument, so the scan reaches it.
      expect(instanceHolds(engine, "space", '"here"')).toBe(true);
      expect(instanceHolds(engine, "space", '"derived:')).toBe(false);
    });
  });

  it("throws when called without a `target`", () => {
    const runtime = clientRuntime(bob);
    const frame = pushFrame({
      runtime,
      tx: runtime.edit(),
      space: bob.did() as MemorySpace,
      frameKind: "lift",
    });
    try {
      // The declared type refuses this call; the runtime check is for callers
      // the compiler never saw.
      const declared: SpaceAccessFunction = spaceAccess;
      // @ts-expect-error: `target` is required.
      expect(() => declared()).toThrow("requires a `target`");
    } finally {
      popFrame(frame);
    }
  });

  it("throws in a pattern body", () => {
    const runtime = clientRuntime(bob);
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    expect(() =>
      pattern(() => {
        spaceAccess(undefined);
        return {};
      })
    ).toThrow("can only be called from a handler or a reactive computation");
  });
});
