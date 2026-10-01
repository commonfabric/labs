import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { defer } from "@commonfabric/utils/defer";

import { ACLManager } from "../src/acl-manager.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { MAX_RETRIES_FOR_REACTIVE } from "../src/scheduler/constants.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { RuntimeTelemetryEvent } from "../src/telemetry.ts";

const AUDIENCE = "did:key:z6Mk-runner-refused-derived-write-audience";

/** Opens each session on the one in-process server, as `signer`. */
class LoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    const session = await client.mount(
      space,
      requested,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    return { client, session };
  }
}

class TestStorageManager extends StorageManager {
  static overServer(
    options: Omit<Options, "memoryHost">,
    factory: SessionFactory,
  ): TestStorageManager {
    return new TestStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      factory,
    );
  }
}

describe("refused derived write", () => {
  let server: MemoryV2Server.Server;
  let runtimes: Runtime[];

  const open = (identity: Identity): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: TestStorageManager.overServer(
        { as: identity },
        new LoopbackSessionFactory(server),
      ),
    });
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      store: new URL(`memory://refused-derived-write-${crypto.randomUUID()}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: AUDIENCE },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await server.close();
  });

  /**
   * Opens `space`, holding `source`, as the owner and as a READ principal,
   * and subscribes an action in the reader's runtime that writes
   * `derive(source)` to `derived`. The action reads the cell it writes, as a
   * computation reads its own output to leave an unchanged one alone. The
   * returned `settled` resolves once the reader is idle, or once the action
   * has run more often than any retry could account for, so a run that never
   * stops fails its case rather than hanging it.
   */
  const readerDerives = async <S, D>(source: S, derive: (s: S) => D) => {
    const owner = await Identity.fromPassphrase("refused write owner");
    const reader = await Identity.fromPassphrase("refused write reader");
    const ownerRuntime = open(owner);
    const space = await ownerRuntime.createSpace({
      grants: { [reader.did()]: "READ" },
    });
    await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell<S>(space, "source", undefined, tx).set(source);
    });
    await ownerRuntime.storageManager.synced();

    const readerRuntime = open(reader);
    const sourceCell = readerRuntime.getCell<S>(space, "source");
    const derived = readerRuntime.getCell<D>(space, "derived");
    await sourceCell.sync();
    await derived.sync();

    const counts = { runs: 0, refusals: 0 };
    readerRuntime.telemetry.addEventListener("telemetry", (event) => {
      const { marker } = event as RuntimeTelemetryEvent;
      if (
        marker.type === "storage.push.error" &&
        marker.error === "AuthorizationError"
      ) {
        counts.refusals++;
      }
    });
    let overBudget = defer();
    const action: Action = (tx) => {
      counts.runs++;
      if (counts.runs > MAX_RETRIES_FOR_REACTIVE) overBudget.resolve();
      const value = derive(sourceCell.withTx(tx).get());
      if (!deepEqual(derived.withTx(tx).get(), value)) {
        derived.withTx(tx).set(value);
      }
    };
    readerRuntime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    const settled = async () => {
      await Promise.race([
        readerRuntime.scheduler.idleWithPendingCommits(),
        overBudget.promise,
      ]);
      overBudget = defer();
    };
    await settled();
    return {
      ownerRuntime,
      readerRuntime,
      space,
      reader,
      derived,
      counts,
      settled,
    };
  };

  it("keeps the value a READ principal computes but cannot store, after one refused commit", async () => {
    const { ownerRuntime, space, derived, counts } = await readerDerives(
      2,
      (n: number) => n * 2,
    );

    expect(counts.refusals).toBe(1);
    expect(derived.get()).toBe(4);
    // The second run reads the kept value and has nothing to write.
    expect(counts.runs).toBe(2);
    const stored = ownerRuntime.getCell<number>(space, "derived");
    await stored.sync();
    expect(stored.get()).toBeUndefined();
  });

  it("stores the whole document written over a kept value once the principal may write", async () => {
    // The second write is a change to one field of the kept value, and the
    // store holds no value to apply such a patch to.

    const { ownerRuntime, readerRuntime, space, reader, counts, settled } =
      await readerDerives(
        { n: 2 },
        ({ n }: { n: number }) => ({ doubled: n * 2, from: "reader" }),
      );
    expect(counts.refusals).toBe(1);

    await new ACLManager(ownerRuntime, space).grant(reader.did(), "WRITE");
    await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell<{ n: number }>(space, "source", undefined, tx)
        .set({ n: 3 });
    });
    await ownerRuntime.storageManager.synced();
    await readerRuntime.storageManager.pullOpenSpacesToHead();
    await settled();
    await readerRuntime.storageManager.synced();

    expect(counts.refusals).toBe(1);
    const stored = ownerRuntime.getCell<unknown>(space, "derived");
    await ownerRuntime.storageManager.pullOpenSpacesToHead();
    await stored.sync();
    expect(stored.get()).toEqual({ doubled: 6, from: "reader" });
  });
});
