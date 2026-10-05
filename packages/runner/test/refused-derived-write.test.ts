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
   * Opens `space`, holding `source` and, when given, `stored` as `derived`,
   * as the owner and as a READ principal,
   * and subscribes an action in the reader's runtime that writes
   * `derive(source)` to `derived`. The action reads the cell it writes, as a
   * computation reads its own output to leave an unchanged one alone. The
   * returned `settled` resolves once the reader is idle, or once the action
   * has run more often than any retry could account for, so a run that never
   * stops fails its case rather than hanging it.
   */
  const readerDerives = async <S, D>(
    source: S,
    derive: (s: S) => D,
    stored?: D,
  ) => {
    const owner = await Identity.fromPassphrase("refused write owner");
    const reader = await Identity.fromPassphrase("refused write reader");
    const ownerRuntime = open(owner);
    const space = await ownerRuntime.createSpace({
      grants: { [reader.did()]: "READ" },
    });
    await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell<S>(space, "source", undefined, tx).set(source);
      if (stored !== undefined) {
        ownerRuntime.getCell<D>(space, "derived", undefined, tx).set(stored);
      }
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

  it("reverts the value a READ principal computes but cannot store, after one refused commit", async () => {
    const { ownerRuntime, space, derived, counts } = await readerDerives(
      2,
      (n: number) => n * 2,
    );

    expect(counts.refusals).toBe(1);
    expect(counts.runs).toBe(1);
    expect(derived.get()).toBeUndefined();
    const stored = ownerRuntime.getCell<number>(space, "derived");
    await stored.sync();
    expect(stored.get()).toBeUndefined();
  });

  it("issues one more write when an input of the refused computation changes", async () => {
    const { ownerRuntime, readerRuntime, space, counts, settled } =
      await readerDerives(2, (n: number) => n * 2);
    expect(counts.refusals).toBe(1);

    await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell<number>(space, "source", undefined, tx).set(3);
    });
    await ownerRuntime.storageManager.synced();
    await readerRuntime.storageManager.pullOpenSpacesToHead();
    await settled();

    expect(counts.runs).toBe(2);
    expect(counts.refusals).toBe(2);
  });

  it("stores the value a refused computation derives once the principal may write", async () => {
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

  it("leaves a document two principals may write alone once each has derived it from a sum only one of them reads in full", async () => {
    // The owner reads both terms of `sum` and the reader only one, the other
    // sitting in a space the reader has no grant on. Each writes `sum` to a
    // space the reader holds READ on, and `doubled`, computed from `sum`, to
    // a space both may write. The reader's `sum` is refused and reverted, so
    // its `doubled` is computed from the `sum` the owner stored.

    const owner = await Identity.fromPassphrase("refused write owner");
    const reader = await Identity.fromPassphrase("refused write reader");
    const ownerRuntime = open(owner);
    const withheldSpace = await ownerRuntime.createSpace();
    const readOnlySpace = await ownerRuntime.createSpace({
      grants: { [reader.did()]: "READ" },
    });
    const writableSpace = await ownerRuntime.createSpace({
      grants: { [reader.did()]: "WRITE" },
    });
    await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell<number>(readOnlySpace, "available", undefined, tx)
        .set(2);
    });
    await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell<number>(withheldSpace, "withheld", undefined, tx)
        .set(3);
    });
    await ownerRuntime.storageManager.synced();

    /**
     * Subscribes, in `runtime`, one action writing `sum` from the terms and
     * one writing `doubled` from `sum`, where `terms` are the terms that
     * runtime's principal may read. Returns the `doubled` cell and a count of
     * the writes made to it.
     */
    const derives = async (
      runtime: Runtime,
      terms: readonly [MemorySpace, string][],
    ) => {
      const termCells = terms.map(([space, name]) =>
        runtime.getCell<number>(space, name)
      );
      const sum = runtime.getCell<number>(readOnlySpace, "sum");
      const doubled = runtime.getCell<number>(writableSpace, "doubled");
      for (const cell of [...termCells, sum, doubled]) await cell.sync();

      const counts = { doubledWrites: 0 };
      const writeSum: Action = (tx) => {
        let value = 0;
        for (const cell of termCells) value += cell.withTx(tx).get() ?? 0;
        if (sum.withTx(tx).get() !== value) sum.withTx(tx).set(value);
      };
      const writeDoubled: Action = (tx) => {
        const value = (sum.withTx(tx).get() ?? 0) * 2;
        if (doubled.withTx(tx).get() !== value) {
          counts.doubledWrites++;
          doubled.withTx(tx).set(value);
        }
      };
      for (const action of [writeSum, writeDoubled]) {
        runtime.scheduler.subscribe(
          action,
          { reads: [], shallowReads: [], writes: [] },
          { isEffect: true },
        );
      }
      await runtime.scheduler.idleWithPendingCommits();
      await runtime.storageManager.synced();
      return { doubled, counts };
    };

    // Brings each runtime in turn up to what the store holds, and lets it
    // store whatever it derives from that.
    const exchange = async () => {
      for (const runtime of [ownerRuntime, readerRuntime]) {
        await runtime.storageManager.pullOpenSpacesToHead();
        await runtime.scheduler.idleWithPendingCommits();
        await runtime.storageManager.synced();
      }
    };

    const asOwner = await derives(ownerRuntime, [
      [readOnlySpace, "available"],
      [withheldSpace, "withheld"],
    ]);
    const readerRuntime = open(reader);
    const asReader = await derives(readerRuntime, [
      [readOnlySpace, "available"],
    ]);
    await exchange();
    const settledWrites = {
      owner: asOwner.counts.doubledWrites,
      reader: asReader.counts.doubledWrites,
    };

    for (let round = 0; round < 3; round++) await exchange();

    expect({
      owner: asOwner.counts.doubledWrites,
      reader: asReader.counts.doubledWrites,
    }).toEqual(settledWrites);
    expect(asOwner.doubled.get()).toBe(10);
    expect(asReader.doubled.get()).toBe(10);
  });

  describe("a computation that read from a space its principal is refused", () => {
    /**
     * Opens, as the owner, a space the reader has no grant on holding
     * `withheld`, and one the reader may write holding `out`. Subscribes an
     * action in the reader's runtime that writes `withheld + 1` to `out`,
     * after the reader has synced `withheld` when `warm` is set. Returns once
     * the reader is idle.
     */
    const readerDerivesFromRefused = async (warm: boolean) => {
      const owner = await Identity.fromPassphrase("refused write owner");
      const reader = await Identity.fromPassphrase("refused write reader");
      const ownerRuntime = open(owner);
      const withheldSpace = await ownerRuntime.createSpace();
      const writableSpace = await ownerRuntime.createSpace({
        grants: { [reader.did()]: "WRITE" },
      });
      await ownerRuntime.editWithRetry((tx) => {
        ownerRuntime.getCell<number>(withheldSpace, "withheld", undefined, tx)
          .set(5);
      });
      await ownerRuntime.editWithRetry((tx) => {
        ownerRuntime.getCell<number>(writableSpace, "out", undefined, tx)
          .set(4);
      });
      await ownerRuntime.storageManager.synced();

      const readerRuntime = open(reader);
      const withheld = readerRuntime.getCell<number>(withheldSpace, "withheld");
      const out = readerRuntime.getCell<number>(writableSpace, "out");
      await out.sync();
      if (warm) await withheld.sync();

      const counts = { runs: 0 };
      const action: Action = (tx) => {
        counts.runs++;
        const value = (withheld.withTx(tx).get() ?? 0) + 1;
        if (out.withTx(tx).get() !== value) out.withTx(tx).set(value);
      };
      readerRuntime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );
      await readerRuntime.scheduler.idleWithPendingCommits();
      await readerRuntime.storageManager.synced();
      const stored = ownerRuntime.getCell<number>(writableSpace, "out");
      await ownerRuntime.storageManager.pullOpenSpacesToHead();
      await stored.sync();
      return {
        ownerRuntime,
        readerRuntime,
        reader,
        withheldSpace,
        out,
        stored,
        counts,
      };
    };

    it("stores nothing when the refusal is known before the computation runs", async () => {
      const { out, stored, counts } = await readerDerivesFromRefused(true);

      expect(counts.runs).toBe(1);
      expect(stored.get()).toBe(4);
      expect(out.get()).toBe(4);
    });

    it("stores nothing when the computation's own read is the first of the space", async () => {
      // The first run reads `withheld` as absent while its load is in flight,
      // and the second runs once that load has been refused.

      const { out, stored, counts } = await readerDerivesFromRefused(false);

      expect(counts.runs).toBe(2);
      expect(stored.get()).toBe(4);
      expect(out.get()).toBe(4);
    });

    it("stores the value it derives once the principal is admitted to the space", async () => {
      const {
        ownerRuntime,
        readerRuntime,
        reader,
        withheldSpace,
        stored,
      } = await readerDerivesFromRefused(true);
      expect(stored.get()).toBe(4);

      await new ACLManager(ownerRuntime, withheldSpace).grant(
        reader.did(),
        "READ",
      );
      await readerRuntime.storageManager.retrySpaceAccess!(withheldSpace);
      await readerRuntime.scheduler.idleWithPendingCommits();
      await readerRuntime.storageManager.synced();

      await ownerRuntime.storageManager.pullOpenSpacesToHead();
      expect(stored.get()).toBe(6);
    });
  });
});
