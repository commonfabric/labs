import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import { Server, SessionRegistry } from "@commonfabric/memory/v2/server";
import { ServerTransport } from "../../../memory/test/support/server-transport.ts";
import { LoopbackStorageManager } from "../../src/executor/loopback-storage.ts";
import { inServingContext } from "../../src/executor/serving-context.ts";
import { newLoopbackServer } from "../../src/storage/v2-emulate.ts";
import type { StorageManager } from "../../src/storage/v2.ts";
import { TEST_MEMORY_SERVER_AUTH } from "../memory-v2-test-utils.ts";

const service = await Identity.fromPassphrase("loopback storage service");

describe("LoopbackStorageManager", () => {
  describe("static members", () => {
    describe("connect()", () => {
      it("attributes its space sessions to one runtime and distinguishes another runtime", async () => {
        const sessions = new SessionRegistry();
        const server = newLoopbackServer({ sessions });
        const clientBuild = { application: "toolshed", gitSha: "a".repeat(40) };
        const manager = LoopbackStorageManager.connect(server, {
          as: service,
          clientBuild,
        });
        const other = LoopbackStorageManager.connect(server, {
          as: service,
          clientBuild,
        });
        const spaces = [
          service.did(),
          (await Identity.generate()).did(),
        ] as MemorySpace[];
        try {
          for (const space of spaces) {
            const result = await manager.open(space).sync(
              "of:loopback-identity",
              { path: [], schema: false },
            );
            expect(result.error).toBeUndefined();
          }
          const first = sessions.sessionsForSpace(spaces[0])[0]?.client;
          const second = sessions.sessionsForSpace(spaces[1])[0]?.client;
          expect(first).toMatchObject(clientBuild);
          expect(first?.instanceId).toEqual(expect.any(String));
          expect(second).toEqual(first);
          const result = await other.open(spaces[0]).sync(
            "of:loopback-other-runtime",
            { path: [], schema: false },
          );
          expect(result.error).toBeUndefined();
          const reports = sessions.sessionsForSpace(spaces[0]).map((session) =>
            session.client
          );
          // Admission probes can leave detached sessions in the registry.
          expect(reports.length).toBeGreaterThanOrEqual(2);
          for (const report of reports) {
            expect(report).toMatchObject(clientBuild);
          }
          expect(new Set(reports.map((report) => report?.instanceId)).size)
            .toBe(2);
        } finally {
          await manager.close();
          await other.close();
          await server.close();
        }
      });

      it("takes each server frame in the serving context, whatever sent the request", async () => {
        // The read is sent from outside the serving context, which is also
        // the context the turn delivering its reply carries.
        const server = newLoopbackServer();
        const seen: boolean[] = [];
        const manager = LoopbackStorageManager.connect(
          server,
          { as: service },
          () => seen.push(inServingContext()),
        );
        try {
          const result = await manager.open(service.did() as MemorySpace)
            .sync("of:loopback-storage-probe", { path: [], schema: false });
          expect(result.error).toBeUndefined();
        } finally {
          await manager.close();
          await server.close();
        }
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((serving) => serving)).toBe(true);
      });
    });
  });

  /**
   * A manager whose first read of a routed space is still mounting: the
   * connection dropped while the mount's open was being signed, the owner
   * has stayed down since, and the client has tried it again and found it
   * gone. `settle` brings the owner back and waits for the read.
   */
  const mountingWhileOwnerIsDown = async () => {
    const server = new Server(TEST_MEMORY_SERVER_AUTH);
    const transport = new ServerTransport(server);
    const identity = await Identity.fromPassphrase(
      "loopback routed owner down",
    );
    const signing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    const signer: Signer = {
      did: () => identity.did(),
      verifier: identity.verifier,
      async sign(bytes) {
        if (first) {
          first = false;
          signing.resolve();
          await release.promise;
        }
        return await identity.sign(bytes);
      },
    };
    const manager = LoopbackStorageManager.connect(server, {
      as: signer,
      servingHomeSpace: "did:key:z6Mk-loopback-owner-down-home" as MemorySpace,
      route: { createTransport: () => transport },
    });
    const reading = manager.open(
      "did:key:z6Mk-loopback-owner-down" as MemorySpace,
    ).serverHeadSeq!().then(() => "read", () => "failed");
    await signing.promise;
    const refused = transport.whenRefused();
    transport.hostDown();
    release.resolve();
    await refused;
    const settle = async () => {
      transport.hostUp();
      await reading;
      await manager.closeNow();
      await server.close();
    };
    return { manager, transport, reading, settle };
  };

  describe("close()", () => {
    it("resolves while a routed space's mount waits for an owner that stays down, without dialing the owner again", async () => {
      const t = await mountingWhileOwnerIsDown();
      let closing: Promise<void> | undefined;
      try {
        const dialedAgain = t.transport.whenRefused();
        closing = t.manager.close();
        const outcome = await Promise.race([
          closing.then(() => "closed"),
          dialedAgain.then(() => "dialed again"),
        ]);

        expect(outcome).toBe("closed");
        expect(await t.reading).toBe("failed");
      } finally {
        await t.settle();
        await closing;
      }
    });
  });

  describe("closeNow()", () => {
    it("closes the connection to a routed space whose mount waits for an owner that stays down", async () => {
      const t = await mountingWhileOwnerIsDown();
      try {
        await t.manager.closeNow();

        expect(t.transport.closes).toBeGreaterThan(0);
      } finally {
        await t.settle();
      }
    });

    it("closes the connection to a routed space whose first dial finds its owner down", async () => {
      const server = new Server(TEST_MEMORY_SERVER_AUTH);
      const transport = new ServerTransport(server);
      const manager = LoopbackStorageManager.connect(server, {
        as: service,
        servingHomeSpace: "did:key:z6Mk-loopback-dial-down-home" as MemorySpace,
        route: { createTransport: () => transport },
      });
      const refused = transport.whenRefused();
      transport.hostDown();
      const reading = manager.open(
        "did:key:z6Mk-loopback-dial-down" as MemorySpace,
      ).serverHeadSeq!().then(() => "read", () => "failed");
      try {
        await refused;
        await manager.closeNow();

        expect(transport.closes).toBeGreaterThan(0);
      } finally {
        transport.hostUp();
        await reading;
        await manager.closeNow();
        await server.close();
      }
    });
  });

  describe("registerSpaceHostDetailed()", () => {
    it("refuses every host hint, and the space's sessions stay on the plane", async () => {
      const server = newLoopbackServer();
      // Addressed as the storage manager its callers hold, whose method
      // takes the space and the host.
      const manager: StorageManager = LoopbackStorageManager.connect(server, {
        as: service,
      });
      const space = service.did() as MemorySpace;
      try {
        expect(
          manager.registerSpaceHostDetailed(space, "https://elsewhere.example"),
        ).toStrictEqual({ accepted: false, reason: "no-remote-resolution" });
        expect(manager.registerSpaceHost(space, "https://elsewhere.example"))
          .toBe(false);
        const result = await manager.open(space).sync(
          "of:loopback-host-hint",
          { path: [], schema: false },
        );
        expect(result.error).toBeUndefined();
      } finally {
        await manager.close();
        await server.close();
      }
    });
  });
});
