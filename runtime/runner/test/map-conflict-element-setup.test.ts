// A `mapWithPattern` coordinator materializes a new list element inside the
// same reconcile transaction that links the element's result cell into the
// shared output container. Two replicas of one piece each run their own
// coordinator against the same container document, so a reconcile's commit
// can be rejected with a cross-replica ConflictError when the peer's write
// lands first. The element the losing reconcile was creating must still
// materialize: its setup writes rode the rejected transaction, and the
// post-catch-up re-run is responsible for issuing them again. This suite
// pins that requirement — the mapped value for the element appears even
// when the reconcile that first created it lost a commit race.
//
// Harness: two Runtimes share one in-process memory server (the
// effect-conflict-recovery recipe). The replica under test (B) runs the
// pattern; a second runtime (A) stands in for the peer coordinator by
// bumping the container document directly. B's incoming `session/effect`
// frames are held while A bumps, so B's reconcile provably commits against
// the stale container and its rejection is a real server ConflictError, not
// a timing accident. Releasing the frames delivers the catch-up the
// rejection's retry gate waits on.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import type { FabricValue } from "@commonfabric/api";
import { Runtime } from "../src/runtime.ts";
import type { StorageNotification } from "../src/storage/interface.ts";
import {
  type Options as V2Options,
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../src/storage/v2.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("map-conflict-element-setup");
const space = signer.did();

/**
 * Holds server-push `session/effect` frames while closed, delivering every
 * other message (request responses in particular) immediately. Released
 * frames flow in their original order.
 */
type FrameGate = {
  hold(): void;
  release(): void;

  /**
   * Resolves once a response carrying a `ConflictError` has passed through:
   * the verdict, which the gate never holds. The catch-up its retry gate
   * waits on rides the held frames, so the storage layer surfaces the
   * rejection — the `revert` notification — only after a release.
   */
  conflictResponded: Promise<void>;
};

const gatedLoopback = (
  server: MemoryV2Server.Server,
): { transport: MemoryV2Client.Transport; gate: FrameGate } => {
  let receiver: (payload: string) => void = () => {};
  let held: string[] | null = null;
  const conflictResponded = Promise.withResolvers<void>();
  const connection = server.connect((message) => {
    const payload = encodeMemoryBoundary(message as unknown as FabricValue);
    const frame = message as { type?: string; error?: { name?: string } };
    if (frame.type === "response" && frame.error?.name === "ConflictError") {
      conflictResponded.resolve();
    }
    if (held !== null && frame.type === "session/effect") {
      held.push(payload);
      return;
    }
    receiver(payload);
  });
  return {
    transport: {
      async send(payload: string) {
        await connection.receive(payload);
      },
      close() {
        connection.close();
        return Promise.resolve();
      },
      setReceiver(next) {
        receiver = next;
      },
      setCloseReceiver() {},
    },
    gate: {
      hold() {
        if (held === null) held = [];
      },
      release() {
        if (held === null) return;
        const queued = held;
        held = null;
        for (const payload of queued) receiver(payload);
      },
      conflictResponded: conflictResponded.promise,
    },
  };
};

class GatedSessionFactory implements SessionFactory {
  gate: FrameGate | undefined;

  readonly #getServer: () => MemoryV2Server.Server;

  constructor(getServer: () => MemoryV2Server.Server) {
    this.#getServer = getServer;
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryV2Client.MountOptions = {},
  ) {
    const { transport, gate } = gatedLoopback(this.#getServer());
    this.gate = gate;
    const client = await MemoryV2Client.connect({ transport });
    const session = await client.mount(
      space,
      mountOptions,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: {
          principal: signer?.did(),
        },
      }),
    );
    return { client, session };
  }
}

class SharedServerStorageManager extends V2StorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<V2Options, "memoryHost" | "spaceHostMap">,
  ): { manager: SharedServerStorageManager; factory: GatedSessionFactory } {
    const factory = new GatedSessionFactory(() => server);
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      factory,
    );
    return { manager, factory };
  }

  private constructor(options: V2Options, sessionFactory: SessionFactory) {
    super(options, sessionFactory);
  }
}

describe("map element setup across a commit conflict", () => {
  let server: MemoryV2Server.Server;
  let storageA: SharedServerStorageManager;
  let storageB: SharedServerStorageManager;
  let factoryB: GatedSessionFactory;
  let rtA: Runtime;
  let rtB: Runtime;
  let conflicts: Error[];

  beforeEach(() => {
    conflicts = [];
    server = newSharedServer();
    ({ manager: storageA } = SharedServerStorageManager.connectTo(server, {
      as: signer,
    }));
    ({ manager: storageB, factory: factoryB } = SharedServerStorageManager
      .connectTo(server, { as: signer }));
    storageB.subscribe({
      next: (notification: StorageNotification) => {
        if (
          notification.type === "revert" &&
          notification.reason.name === "ConflictError"
        ) {
          conflicts.push(notification.reason);
        }
        return undefined;
      },
    });
    rtA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    rtB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
  });

  afterEach(async () => {
    factoryB.gate?.release();
    await rtB.dispose();
    await rtA.dispose();
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  it("materializes an element whose creating reconcile lost a commit race", async () => {
    const { cell, lift, pattern } = createTrustedBuilder(rtB).commonfabric;
    const operation = pattern<{ element: number }>(({ element }) =>
      lift((value: number) => value * 2)(element)
    );
    const parentPattern = pattern(() => {
      const items = cell<number[]>([]);
      return {
        items,
        mapped: (items as unknown as {
          mapWithPattern(
            operation: unknown,
            params: Record<string, never>,
          ): unknown;
        }).mapWithPattern(operation, {}),
      };
    });
    const setupTx = rtB.edit();
    const parent = rtB.getCell<{
      items: number[];
      mapped: number[];
    }>(space, "map conflict element setup", undefined, setupTx);
    const result = rtB.run(setupTx, parentPattern, {}, parent);
    expect((await setupTx.commit().settled).error).toBeUndefined();

    // The mapped container converged to two slots — resolved by the sink
    // below once the retry's container write lands. Both slots present is
    // the wait condition; their contents are asserted at the end.
    const twoSlots = Promise.withResolvers<void>();
    const stopReading = result.key("mapped").sink((value) => {
      if (Array.isArray(value) && value.length === 2) {
        twoSlots.resolve();
      }
    });

    try {
      // Seed one element and settle: mapped = [2] and the shared result
      // container is durable on the server.
      {
        const tx = rtB.edit();
        result.key("items").withTx(tx).set([1]);
        rtB.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      await rtB.scheduler.idleWithPendingCommits();
      expect(await result.key("mapped").pull()).toEqual([2]);
      await storageB.synced();

      // The peer coordinator (stood in by runtime A) advances the shared
      // container. B's incoming frames are held first, so B provably keeps
      // the stale confirmed container version.
      const containerLink = result.key("mapped").resolveAsCell()
        .getAsNormalizedFullLink();
      const containerA = rtA.getCellFromLink<unknown[]>(containerLink);
      await containerA.sync();
      factoryB.gate!.hold();
      {
        const tx = rtA.edit();
        containerA.withTx(tx).set([]);
        rtA.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      await storageA.synced();

      // B appends the second element. The reconcile that materializes it
      // reads the container at the stale version, so its commit — carrying
      // the element's setup writes — is rejected with a ConflictError. The
      // append's own commit promise resolves at marker coverage, and the
      // held frames carry the markers, so it is awaited only after release.
      const appendTx = rtB.edit();
      result.key("items").withTx(appendTx).set([1, 2]);
      rtB.prepareTxForCommit(appendTx);
      const appendCommit = appendTx.commit().settled;
      // The verdict is what to wait for here: the rejection surfaces as a
      // revert only once its retry gate has the catch-up, and that rides the
      // held frames. The waits here and below carry no bound, per the
      // suite's ban on timeouts; a resolver that never fires fails the test
      // as a pending promise once the loop empties.
      await factoryB.gate!.conflictResponded;

      // Deliver the held catch-up; the reconcile re-runs against the fresh
      // container and its rewrite lands both element links.
      factoryB.gate!.release();
      expect((await appendCommit).error).toBeUndefined();
      await twoSlots.promise;
      expect(
        conflicts.length,
        "the reconcile's commit hit a real ConflictError",
      ).toBeGreaterThanOrEqual(1);
      await rtB.scheduler.idleWithPendingCommits();
      await storageB.synced();

      expect(
        await result.key("mapped").pull(),
        "the element created by the conflicted reconcile materialized",
      ).toEqual([2, 4]);
    } finally {
      stopReading();
    }
  });
});
