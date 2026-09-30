import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { spaceAccess } from "../../src/builder/space-access.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { stampWaveRunContext } from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
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

  beforeEach(() => {
    cleanups = [];
    server = new Server({
      store: new URL(`memory://space-access-${++serverCount}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
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
   * identity of, `space` unless given, as that identity.
   */
  async function writerFor(
    owner: Identity = spaceSigner,
  ): Promise<(id: string, value: FabricValue) => Promise<void>> {
    const target = owner.did() as MemorySpace;
    const client = await connect({ transport: loopback(server) });
    cleanups.push(() => client.close());
    const session = await client.mount(
      target,
      {},
      (_space, _options, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: target },
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

  /** Brings `space`'s access list into `runtime`'s replica, or tries to. */
  async function syncAcl(runtime: Runtime, target = space): Promise<void> {
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
   * Calls `spaceAccess()` as code in a `kind` frame of `frameSpace` would,
   * through `tx`, and returns what it returns.
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
      space: options.frameSpace ?? space,
      frameKind: options.kind ?? "lift",
    });
    try {
      return options.target === undefined
        ? spaceAccess()
        : spaceAccess(options.target);
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

    it("returns `OWNER` to the space's own identity, which the list does not name", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER" });

      const runtime = clientRuntime(spaceSigner);
      expect(callIn(runtime, runtime.edit())).toBe("OWNER");
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

      const runtime = clientRuntime(carol);
      await syncAcl(runtime);
      const home = carol.did() as MemorySpace;
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
      const runtime = clientRuntime(bob);
      const frame = pushFrame({
        runtime,
        tx: runtime.edit(),
        space: bob.did() as MemorySpace,
        frameKind: "lift",
      });
      try {
        expect(spaceAccess()).toBe("OWNER");
        expect(spaceAccess(undefined)).toBeUndefined();
      } finally {
        popFrame(frame);
      }
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
      const ownTx = runtime.edit();
      expect(callIn(runtime, ownTx, { frameSpace: bob.did() as MemorySpace }))
        .toBe("OWNER");
      expect(ownTx.getNarrowestReadScope()).toBe("user");
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

  describe("in a dependent computation", () => {
    const resultSchema = {
      type: "object",
      properties: { level: { type: "string" } },
    } as const satisfies JSONSchema;

    /**
     * Runs, in `user`'s home space, a pattern whose one computation returns
     * `user`'s level in the space of a cell in `space`, and returns the cell
     * holding that level; `unknown` stands in for `undefined`. The computation
     * takes the cell as a cell, or with `byValue` as the value it holds.
     */
    async function levelCell(
      runtime: Runtime,
      user: Identity,
      options: { byValue?: boolean } = {},
    ): Promise<Cell<string>> {
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
        (input: { target: unknown }) =>
          spaceAccess(input.target as Cell<unknown>) ?? "unknown",
        argumentSchema,
        { type: "string" },
      );
      const levelPattern = pattern(
        ({ target }) => ({ level: level({ target }) }),
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
      return result.key("level") as Cell<string>;
    }

    it("writes its value where only its own user reads it", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });

      const runtime = clientRuntime(bob);
      const level = await levelCell(runtime, bob);
      await waitForCellValue(runtime, level, (v) => v === "WRITE", {
        stuckLabel: "bob's level to arrive as `WRITE`",
      });
      expect(level.resolveAsCell().getAsNormalizedFullLink().scope).toBe(
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

      const bobLevel = await levelCell(bobRuntime, bob, { byValue: true });
      await waitForCellValue(bobRuntime, bobLevel, (v) => v === "WRITE", {
        stuckLabel: "bob's level to arrive as `WRITE`",
      });

      const daveRuntime = clientRuntime(dave);
      const daveLevel = await levelCell(daveRuntime, dave, { byValue: true });
      await waitForCellValue(daveRuntime, daveLevel, (v) => v !== undefined, {
        stuckLabel: "dave's level to arrive",
      });
      expect(daveLevel.get()).toBe("unknown");
    });

    it("runs again when a grant or revoke changes the level", async () => {
      const setAcl = await aclWriter();
      await setAcl({ [alice.did()]: "OWNER", [bob.did()]: "WRITE" });

      const runtime = clientRuntime(bob);
      const level = await levelCell(runtime, bob);
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
      const level = await levelCell(runtime, dave);
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
  });

  it("throws in a pattern body", () => {
    const runtime = clientRuntime(bob);
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    expect(() =>
      pattern(() => {
        spaceAccess();
        return {};
      })
    ).toThrow("can only be called from a handler or a reactive computation");
  });
});
