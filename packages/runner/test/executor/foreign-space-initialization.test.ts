import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import { applyCommit, read, serverSeq } from "@commonfabric/memory/v2/engine";
import { Server } from "@commonfabric/memory/v2/server";

import { LoopbackStorageManager } from "../../src/executor/loopback-storage.ts";
import { SpaceServer } from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import { stampWaveRunContext } from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace, URI } from "../../src/storage/interface.ts";

const newServer = (mode: "off" | "enforce" = "off") =>
  new Server({
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) =>
      (message.invocation as { iss: string }).iss,
    sessionOpenAuth: { audience: "did:key:foreign-space-initialization" },
    acl: { mode },
  });

describe("foreign-space-initialization", () => {
  for (
    const state of ["wrong-owner", "legacy", "malformed", "retracted"] as const
  ) {
    it(`keeps a ${state} space unauthorized after opening it`, async () => {
      const actor = await Identity.fromPassphrase("ungranted actor");
      const owner = await Identity.fromPassphrase("ungranted owner");
      const server = newServer();
      const manager = LoopbackStorageManager.connect(server, { as: actor });
      try {
        const child = state === "legacy"
          ? (await Identity.fromPassphrase("legacy ungranted child")).did()
          : await manager.createSpace({
            [owner.did()]: "OWNER",
            [actor.did()]: "READ",
          });
        if (state === "legacy") {
          await server.writeDocument(child, "legacy-value", "existing");
        } else if (state === "malformed") {
          await server.writeDocument(child, aclDocId(child), {});
        } else if (state === "retracted") {
          const engine = await server.engineForSpace(child);
          applyCommit(engine, {
            sessionId: "retract-acl",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{ op: "delete", id: aclDocId(child) }],
            },
          });
        }
        expect(
          (await server.foreignWriteAuthorityFor(child, actor.did())).granted,
        ).toBe(false);
        await manager.open(child).sync(aclDocId(child) as URI);
        expect(
          (await server.foreignWriteAuthorityFor(child, actor.did())).granted,
        ).toBe(false);
        expect((await server.readDocument(child, aclDocId(child)))?.value)
          .toEqual(
            state === "wrong-owner"
              ? { [owner.did()]: "OWNER", [actor.did()]: "READ" }
              : state === "malformed"
              ? {}
              : undefined,
          );
      } finally {
        await manager.close();
        await server.close();
      }
    });
  }

  it("does not open an unknown target while checking foreign authority", async () => {
    const actor = await Identity.fromPassphrase("unknown initialization actor");
    const child = await Identity.fromPassphrase("unknown initialization child");
    const server = newServer();
    const manager = LoopbackStorageManager.connect(server, { as: actor });
    let opens = 0;
    server.accessForTestingOnly.engineOpener = (space, open) => {
      opens += 1;
      return open(space);
    };
    try {
      expect(
        (await server.foreignWriteAuthorityFor(child.did(), actor.did()))
          .granted,
      ).toBe(false);
      expect(opens).toBe(0);
      expect(manager.openedSpaces()).toEqual([]);
    } finally {
      await manager.close();
      await server.close();
    }
  });

  it("does not create a foreign ACL by opening an unknown target", async () => {
    const actor = await Identity.fromPassphrase("keyless initialization actor");
    const child = await Identity.fromPassphrase("keyless initialization child");
    const server = newServer();
    const manager = LoopbackStorageManager.connect(server, { as: actor });
    try {
      await manager.open(child.did()).sync(aclDocId(child.did()) as URI);
      expect(
        (await server.readDocument(child.did(), aclDocId(child.did())))?.value,
      ).toBeUndefined();
      expect(
        (await server.foreignWriteAuthorityFor(child.did(), actor.did()))
          .granted,
      ).toBe(false);
    } finally {
      await manager.close();
      await server.close();
    }
  });

  it("propagates rejected creation without granting authority", async () => {
    const actor = await Identity.fromPassphrase(
      "rejected initialization actor",
    );
    const server = newServer("enforce");
    const manager = LoopbackStorageManager.connect(server, { as: actor });
    let child: MemorySpace | undefined;
    server.accessForTestingOnly.engineOpener = (space, open) => {
      child = space as MemorySpace;
      return open(space);
    };
    try {
      await expect(
        manager.createSpace({ "*": "OWNER", [actor.did()]: "WRITE" }),
      )
        .rejects.toThrow("concrete OWNER");
      expect(child).toBeDefined();
      expect((await server.readDocument(child!, aclDocId(child!)))?.value)
        .toBeUndefined();
      expect(
        (await server.foreignWriteAuthorityFor(child!, actor.did())).granted,
      ).toBe(false);
    } finally {
      await manager.close();
      await server.close();
    }
  });

  it("returns a created space only after its genesis ACL commits", async () => {
    const actor = await Identity.fromPassphrase("pending creation actor");
    const server = newServer();
    const manager = LoopbackStorageManager.connect(server, { as: actor });
    const opened = Promise.withResolvers<MemorySpace>();
    const release = Promise.withResolvers<void>();
    let gated = false;
    server.accessForTestingOnly.engineOpener = async (space, open) => {
      const engine = await open(space);
      if (!gated) {
        gated = true;
        opened.resolve(space as MemorySpace);
        await release.promise;
      }
      return engine;
    };
    let returned = false;
    const creating = manager.createSpace({ [actor.did()]: "OWNER" }).then(
      (space) => {
        returned = true;
        return space;
      },
    );
    try {
      const child = await opened.promise;
      expect(returned).toBe(false);
      expect(
        (await server.foreignWriteAuthorityFor(child, actor.did())).granted,
      ).toBe(false);
      release.resolve();
      expect(await creating).toBe(child);
      expect((await server.readDocument(child, aclDocId(child)))?.value)
        .toEqual({ [actor.did()]: "OWNER" });
      expect(
        (await server.foreignWriteAuthorityFor(child, actor.did())).granted,
      ).toBe(true);
    } finally {
      release.resolve();
      await creating.catch(() => {});
      await manager.close();
      await server.close();
    }
  });

  for (const mode of ["off", "persist"] as const) {
    for (const revoked of [false, true]) {
      it(`${revoked ? "refuses a revoked" : "authorizes a created"} foreign target from its current ACL with flow ${mode}`, async () => {
        const actor = await Identity.fromPassphrase("initialization actor");
        const service = await Identity.fromPassphrase("initialization service");
        const other = await Identity.fromPassphrase("initialization other");
        const server = newServer();
        const client = LoopbackStorageManager.connect(server, { as: actor });
        const homeSpace = await client.createSpace({ [actor.did()]: "OWNER" });
        const child = await client.createSpace({ [actor.did()]: "OWNER" });
        const manager = LoopbackStorageManager.connect(server, {
          as: service,
          servingHomeSpace: homeSpace,
        });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager: manager,
          cfcFlowLabels: mode,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        const engine = await server.engineForSpace(homeSpace);
        const stats = emptyServingLoopStats();
        const serving = new SpaceServer({
          space: homeSpace,
          server,
          engine,
          serviceIdentity: service.did(),
          createRuntime: () =>
            Promise.resolve({
              runtime,
              dispose: async () => {
                await runtime.dispose();
                await manager.close();
              },
            }),
          localSeqRef: { value: 0 },
          stats,
          ensureSpaceRoots: false,
        });
        try {
          expect(await serving.activate()).toBe(true);
          expect(
            (await server.foreignWriteAuthorityFor(child, actor.did())).granted,
          ).toBe(true);
          const target = runtime.getCell(child, "child value", undefined);
          await target.sync();
          if (revoked) {
            await server.writeDocument(child, aclDocId(child), {
              [other.did()]: "OWNER",
            });
          }
          const tx = runtime.edit();
          stampWaveRunContext(tx, {
            actionId: "initialize-child",
            kind: "event-handler",
            eventId: "initialize-child-event",
            acting: { user: actor.did(), session: "actor-session" },
            capabilityRef: "event-consequence:initialize-child-event",
          });
          tx.enableMultiSpaceWrites?.([child, homeSpace]);
          target.withTx(tx).set("created value");
          const home = runtime.getCell(
            homeSpace,
            "home consequence",
            undefined,
          );
          home.withTx(tx).set("child created");
          const committed = await tx.commit();
          if (revoked) {
            expect(committed.error?.name).toBe("StorageTransactionAborted");
            expect(stats.foreignWriteRefusals).toBe(1);
          } else {
            expect(committed.error).toBeUndefined();
          }
          await manager.synced();
          const childEngine = await server.engineForSpace(child);
          expect(serverSeq(childEngine)).toBeGreaterThanOrEqual(
            revoked ? 2 : 2,
          );
          expect(read(engine, { id: home.getAsNormalizedFullLink().id })?.value)
            .toBe(revoked ? undefined : "child created");
          expect(read(childEngine, { id: aclDocId(child) })?.value)
            .toEqual({ [(revoked ? other : actor).did()]: "OWNER" });
          expect(
            read(childEngine, { id: target.getAsNormalizedFullLink().id })
              ?.value,
          )
            .toBe(revoked ? undefined : "created value");
        } finally {
          await serving.park("test complete");
          await serving.whenParked;
          await client.close();
          await server.close();
        }
      });
    }
  }
});
