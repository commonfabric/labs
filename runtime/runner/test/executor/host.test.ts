import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type {
  Server,
  ServerExecutionObserver,
} from "@commonfabric/memory/v2/server";
import { defer } from "@commonfabric/async/defer";
import {
  ExecutorHost,
  type ExecutorHostOptions,
  type HostOccupancy,
  type LifecycleVerb,
} from "../../src/executor/host.ts";
import { inServingContext } from "../../src/executor/serving-context.ts";
import { servingRuntimeFactory } from "../../src/executor/serving-runtime.ts";
import { SpaceServer } from "../../src/executor/space-server.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { DelegationStore } from "../../src/storage/delegation-store.ts";
import {
  EmulatedStorageManager,
  loopbackSessionOpenAuth,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";

const service = await Identity.fromPassphrase("executor host service");
const owner = await Identity.fromPassphrase("executor host owner");
const space = owner.did() as MemorySpace;

/**
 * A host over its own in-process memory server, which builds each serving
 * runtime over an emulated storage manager and records, per build, the
 * spaces whose access-list change reached that runtime's storage manager.
 * `close()` closes the host and then the server.
 */
function newHost(
  options: Partial<ExecutorHostOptions> = {},
): {
  host: ExecutorHost;
  server: Server;
  builds: MemorySpace[][];
  close: () => Promise<void>;
} {
  const server = newLoopbackServer();
  const builds: MemorySpace[][] = [];
  const host = new ExecutorHost({
    server,
    serviceIdentity: service.did(),
    ensureSpaceRoots: false,
    policy: { idleParkMs: 600_000 },
    createRuntime: () => {
      const manager = EmulatedStorageManager.connectTo(server, {
        as: service,
      });
      const aclChanges: MemorySpace[] = [];
      builds.push(aclChanges);
      const note = manager.noteSpaceAclChanged.bind(manager);
      manager.noteSpaceAclChanged = (changed) => {
        aclChanges.push(changed);
        note(changed);
      };
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        servingPosture: true,
        experimental: { serverExecution: true },
      });
      return Promise.resolve({
        runtime,
        dispose: async () => {
          await runtime.dispose();
          await manager.close();
        },
      });
    },
    ...options,
  });
  return {
    host,
    server,
    builds,
    close: async () => {
      await host.close();
      await server.close();
    },
  };
}

/**
 * Opens a session on `space` signed by `signer`, over a connection `server`
 * takes as one from this process when `inProcess` is `true` and as one from
 * another process otherwise, and returns its client once the open has been
 * answered.
 */
async function openSession(
  server: Server,
  signer: Identity,
  { inProcess }: { inProcess: boolean },
): Promise<MemoryV2Client.Client> {
  const client = await MemoryV2Client.connect({
    transport: MemoryV2Client.loopback(server, { inProcess }),
  });
  await client.mount(
    space,
    {},
    loopbackSessionOpenAuth(new DelegationStore(), space, signer),
  );
  return client;
}

/** A verb that writes nothing and returns `receipt`, recording its runtime. */
function probeVerb(
  receipt: string,
  ranOn: Runtime[],
): LifecycleVerb<string> {
  return {
    name: receipt,
    run: (runtime) => {
      ranOn.push(runtime);
      return Promise.resolve(receipt);
    },
  };
}

describe("ExecutorHost", () => {
  describe("constructor()", () => {
    it("activates the space an admitted commit names in the serving context, though called from outside it", async () => {
      // A warm notice activates its space with no session open on it, so the
      // admission hook is the only thing that starts the activation.
      const server = newLoopbackServer();
      let observer: ServerExecutionObserver | undefined;
      const setObserver = server.setServerExecutionObserver.bind(server);
      server.setServerExecutionObserver = (next) => {
        observer = next;
        setObserver(next);
      };
      const factory = servingRuntimeFactory({
        server,
        identity: service,
        apiUrl: new URL(import.meta.url),
      });
      const builds: boolean[] = [];
      const settled = defer<string>();
      const host = new ExecutorHost({
        server,
        serviceIdentity: service.did(),
        ensureSpaceRoots: false,
        createRuntime: (space, context) => {
          builds.push(inServingContext());
          return factory(space, context);
        },
        onActivationSettled: (_space, outcome) => settled.resolve(outcome),
      });
      try {
        observer!.commitAdmitted!({
          space: owner.did(),
          seq: 1,
          class: "authored",
          sessionId: "executor-host-test",
          writes: [],
          warm: true,
        });
        expect(await settled.promise).toBe("active");
      } finally {
        await host.close();
        await server.close();
      }
      expect(builds).toStrictEqual([true]);
    });

    it("activates a space when a session signed by the service identity opens on it from another process", async () => {
      // A local toolshed signs with the key its operator's CLI also uses,
      // so the owner's own client sessions carry the service principal.

      const settled = defer<string>();
      const { host, server, close } = newHost({
        onActivationSettled: (_space, outcome) => settled.resolve(outcome),
      });
      try {
        const client = await openSession(server, service, {
          inProcess: false,
        });
        try {
          // The host decides as the open is answered, so a space it left
          // alone shows here rather than as an activation never reported.
          expect(host.occupancy).toBe("busy");
          expect(await settled.promise).toBe("active");
          expect(host.spaceServer(space)?.active).toBe(true);
        } finally {
          await client.close();
        }
      } finally {
        await close();
      }
    });

    it("leaves a space unactivated when a session signed by the service identity opens on it from this process", async () => {
      // The serving runtime's own loopback sessions are not client demand.

      const { host, server, close } = newHost();
      try {
        const client = await openSession(server, service, { inProcess: true });
        try {
          expect(host.occupancy).toBe("vacant");
          expect(host.spaceServer(space)).toBeUndefined();
        } finally {
          await client.close();
        }
      } finally {
        await close();
      }
    });

    it("keeps reporting the occupancy after its observer throws", async () => {
      const reports: HostOccupancy[] = [];
      const parkedReported = defer<void>();
      const { host, close } = newHost({
        onOccupancyChanged: (occupancy) => {
          reports.push(occupancy);
          if (occupancy === "parked") parkedReported.resolve();
          throw new Error("occupancy observer failure");
        },
      });
      try {
        await host.runLifecycleVerb(space, probeVerb("served", []));
        await host.spaceServer(space)!.park("idle");
        await parkedReported.promise;
        expect(reports).toStrictEqual(["busy", "parked"]);
      } finally {
        await close();
      }
    });
  });

  describe("runLifecycleVerb()", () => {
    it("waits out a park in progress and runs the verb on the tenure after it", async () => {
      const events: string[] = [];
      const { host, builds, close } = newHost({
        onSpaceParked: (_space, reason) => events.push(`parked ${reason}`),
        onActivationSettled: (_space, outcome) => events.push(outcome),
      });
      const ranOn: Runtime[] = [];
      try {
        await host.runLifecycleVerb(space, probeVerb("first", ranOn));
        const first = host.spaceServer(space)!;
        const parking = first.park("test-park");
        expect(first.active).toBe(false);

        expect(await host.runLifecycleVerb(space, probeVerb("second", ranOn)))
          .toBe("second");
        await parking;
        expect(events).toStrictEqual(["active", "parked test-park", "active"]);
        const second = host.spaceServer(space)!;
        expect(second).not.toBe(first);
        expect(second.active).toBe(true);
        expect(builds.length).toBe(2);
        expect(ranOn.length).toBe(2);
        expect(ranOn[1]).not.toBe(ranOn[0]);
      } finally {
        await close();
      }
    });

    it("runs a verb again on the next tenure when its space parks before the verb ran", async () => {
      const { host, builds, close } = newHost();
      const ranOn: Runtime[] = [];
      try {
        await host.runLifecycleVerb(space, probeVerb("activate", ranOn));
        const first = host.spaceServer(space)!;
        let parking: Promise<void> | undefined;
        const parker = host.runLifecycleVerb(space, {
          name: "parker",
          run: (runtime) => {
            ranOn.push(runtime);
            parking = first.park("test-park");
            return Promise.resolve("parker");
          },
        });
        const parkerOutcome = parker.then(
          (value) => value,
          (error: Error) => error.message,
        );
        const queued = host.runLifecycleVerb(space, probeVerb("queued", ranOn));

        expect(await parkerOutcome).toBe("parker");
        expect(await queued).toBe("queued");
        await parking;
        expect(builds.length).toBe(2);
        expect(ranOn.length).toBe(3);
        expect(ranOn[1]).toBe(ranOn[0]);
        expect(ranOn[2]).not.toBe(ranOn[0]);
        expect(host.spaceServer(space)).not.toBe(first);
      } finally {
        await close();
      }
    });
  });

  describe("close()", () => {
    /**
     * Has each park the host's close asks for complete and then fail, and
     * returns the failures in the order the parks were asked for.
     */
    const failParksOnClose = (): Disposable & { failures: Error[] } => {
      const failures: Error[] = [];
      const park = SpaceServer.prototype.park;
      const parks = stub(
        SpaceServer.prototype,
        "park",
        async function (this: SpaceServer, reason: string) {
          const failure = new Error(`${this.space} failed to park`);
          await park.call(this, reason);
          if (reason !== "host-closed") return;
          failures.push(failure);
          throw failure;
        },
      );
      return { failures, [Symbol.dispose]: () => parks.restore() };
    };

    it("rejects with the failure of the one space whose park failed", async () => {
      const { host, close } = newHost();
      try {
        await host.runLifecycleVerb(space, probeVerb("served", []));
        using parks = failParksOnClose();

        const error = await host.close().then(() => undefined, (e) => e);
        expect(parks.failures.length).toBe(1);
        expect(error).toBe(parks.failures[0]);
      } finally {
        await close();
      }
    });

    it("rejects with an `AggregateError` holding every failure when several spaces' parks failed", async () => {
      const { host, close } = newHost();
      const other = (await Identity.generate()).did() as MemorySpace;
      try {
        await host.runLifecycleVerb(space, probeVerb("served", []));
        await host.runLifecycleVerb(other, probeVerb("served", []));
        using parks = failParksOnClose();

        const error = await host.close().then(() => undefined, (e) => e);
        expect(parks.failures.length).toBe(2);
        expect(error).toBeInstanceOf(AggregateError);
        expect(error).toMatchObject({
          message: "2 spaces failed to park while the host closed",
          errors: parks.failures,
        });
      } finally {
        await close();
      }
    });
  });

  describe("noteSpaceAclChanged()", () => {
    it("tells each tenure's runtime of the change, and tells none once the host is closing", async () => {
      const { host, builds, close } = newHost();
      const changed = (await Identity.generate()).did() as MemorySpace;
      const late = (await Identity.generate()).did() as MemorySpace;
      try {
        await host.runLifecycleVerb(space, probeVerb("served", []));
        host.noteSpaceAclChanged(changed);
        expect(builds).toStrictEqual([[changed]]);

        const closing = host.close();
        expect(host.spaceServer(space)).toBeDefined();
        host.noteSpaceAclChanged(late);
        await closing;
        expect(builds).toStrictEqual([[changed]]);
      } finally {
        await close();
      }
    });
  });
});
