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
import { readConfirmed } from "../src/confirmed-read.ts";
import { type ExperimentalOptions, Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { MAX_RETRIES_FOR_REACTIVE } from "../src/scheduler/constants.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { RuntimeTelemetryEvent } from "../src/telemetry.ts";

const AUDIENCE = "did:key:z6Mk-runner-refused-derived-write-audience";

/**
 * Opens each session on the one in-process server, as `signer`. A commit
 * waits for `beforeTransact`, when one is set, before it reaches the server.
 */
class LoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  beforeTransact: (() => Promise<void>) | undefined;
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
    const transact = session.transact.bind(session);
    session.transact = async (...args: Parameters<typeof transact>) => {
      await this.beforeTransact?.();
      return transact(...args);
    };
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

  let factories: Map<Runtime, LoopbackSessionFactory>;

  const open = (
    identity: Identity,
    experimental?: ExperimentalOptions,
  ): Runtime => {
    const factory = new LoopbackSessionFactory(server);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: TestStorageManager.overServer({ as: identity }, factory),
      experimental,
    });
    runtimes.push(runtime);
    factories.set(runtime, factory);
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
    factories = new Map();
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await server.close();
  });

  /**
   * Opens `space`, holding `source` and, when given, `stored` as `derived`,
   * as the owner and as a reader whose runtime takes `experimental`, and
   * subscribes an action in the reader's runtime that writes
   * `derive(source)` to `derived`. The action reads the cell it writes, as a
   * computation reads its own output to leave an unchanged one alone. The
   * reader holds `grant` on the space; with `revokeBeforeFirstPush`, the
   * owner lowers it to READ while the reader's first push is on its way to
   * the store, so the reader's replica decides that push by an access list
   * the store no longer holds, and with `withoutAccessList` the reader's
   * replica holds no copy of the list at all. The returned `settled` resolves once the
   * reader is idle, or once the action has run more often than any retry
   * could account for, so a run that never stops fails its case rather than
   * hanging it.
   */
  const readerDerives = async <S, D>(
    source: S,
    derive: (s: S) => D,
    {
      stored,
      experimental,
      grant = "READ",
      revokeBeforeFirstPush = false,
      withoutAccessList = false,
    }: {
      stored?: D;
      experimental?: ExperimentalOptions;
      grant?: "READ" | "WRITE";
      revokeBeforeFirstPush?: boolean;
      withoutAccessList?: boolean;
    } = {},
  ) => {
    const owner = await Identity.fromPassphrase("refused write owner");
    const reader = await Identity.fromPassphrase("refused write reader");
    const ownerRuntime = open(owner);
    const space = await ownerRuntime.createSpace({
      grants: { [reader.did()]: grant },
    });
    await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell<S>(space, "source", undefined, tx).set(source);
      if (stored !== undefined) {
        ownerRuntime.getCell<D>(space, "derived", undefined, tx).set(stored);
      }
    });
    await ownerRuntime.storageManager.synced();

    const readerRuntime = open(reader, experimental);
    const sourceCell = readerRuntime.getCell<S>(space, "source");
    const derived = readerRuntime.getCell<D>(space, "derived");
    await sourceCell.sync();
    await derived.sync();
    // The reader's replica holds the space's access list, as a client that
    // has shown the space's membership does, unless the case wants it cold.
    if (!withoutAccessList) await new ACLManager(readerRuntime, space).get();
    if (revokeBeforeFirstPush) {
      const factory = factories.get(readerRuntime)!;
      factory.beforeTransact = async () => {
        factory.beforeTransact = undefined;
        await new ACLManager(ownerRuntime, space).set(reader.did(), "READ");
        await ownerRuntime.storageManager.synced();
      };
    }

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
    const held = () => readerRuntime.localDerivation?.heldCount(space) ?? 0;
    return {
      ownerRuntime,
      readerRuntime,
      space,
      reader,
      derived,
      counts,
      settled,
      held,
    };
  };

  it("holds the value a READ principal computes but cannot store, and pushes nothing", async () => {
    const { ownerRuntime, space, derived, counts, held } = await readerDerives(
      2,
      (n: number) => n * 2,
    );

    expect(counts.refusals).toBe(0);
    expect(counts.runs).toBe(1);
    expect(derived.get()).toBe(4);
    expect(held()).toBe(1);
    const stored = ownerRuntime.getCell<number>(space, "derived");
    await stored.sync();
    expect(stored.get()).toBeUndefined();
  });

  it("pushes the first derivation of a replica that holds no access list, is refused once, and holds the run that follows", async () => {
    // Nothing on the reader's side says the principal cannot write until the
    // store says so; the refusal teaches it, and the writer runs once more.

    const { ownerRuntime, space, derived, counts, held } = await readerDerives(
      2,
      (n: number) => n * 2,
      { withoutAccessList: true },
    );

    expect(counts.refusals).toBe(1);
    expect(counts.runs).toBe(2);
    expect(derived.get()).toBe(4);
    expect(held()).toBe(1);
    const stored = ownerRuntime.getCell<number>(space, "derived");
    await stored.sync();
    expect(stored.get()).toBeUndefined();
  });

  it("replaces the held value when an input changes, and still pushes nothing", async () => {
    const {
      ownerRuntime,
      readerRuntime,
      space,
      derived,
      counts,
      settled,
      held,
    } = await readerDerives(2, (n: number) => n * 2);
    expect(counts.runs).toBe(1);

    await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell<number>(space, "source", undefined, tx).set(3);
    });
    await ownerRuntime.storageManager.synced();
    await readerRuntime.storageManager.pullOpenSpacesToHead();
    await settled();

    expect(counts.runs).toBe(2);
    expect(counts.refusals).toBe(0);
    expect(derived.get()).toBe(6);
    // The newer derivation wrote the older one's document whole, so it
    // stands in for it.
    expect(held()).toBe(1);
  });

  it("reads a held document as absent and unconfirmed through a confirmed read, beside the source it was computed from read as confirmed", async () => {
    // A confirmed read reads the durable view, which the held derivation is
    // kept out of; the layer standing over the document is what leaves it
    // unconfirmed.

    const { readerRuntime, space, derived } = await readerDerives(
      2,
      (n: number) => n * 2,
    );
    const source = readerRuntime.getCell<number>(space, "source");
    await source.sync();

    expect(derived.get()).toBe(4);
    expect(
      readConfirmed(readerRuntime, space, (tx) => derived.withTx(tx).get()),
    )
      .toEqual({ value: undefined, confirmed: false });
    expect(readConfirmed(readerRuntime, space, (tx) => source.withTx(tx).get()))
      .toMatchObject({ value: 2, confirmed: true });
  });

  it("yields to a value the store holds for the document, holds nothing, and runs no further", async () => {
    // The owner stored `derived` before the reader computed it, so the
    // reader's write is dropped and its view keeps the stored value. The
    // drop notifies nothing, so the reader's computation does not run
    // against the stored value and write the same thing again.

    const { ownerRuntime, space, derived, counts, settled, held } =
      await readerDerives(2, (n: number) => n * 2, { stored: 7 });

    expect(counts.refusals).toBe(0);
    expect(counts.runs).toBe(1);
    expect(derived.get()).toBe(7);
    expect(held()).toBe(0);
    await settled();
    expect(counts.runs).toBe(1);
    const stored = ownerRuntime.getCell<number>(space, "derived");
    await stored.sync();
    expect(stored.get()).toBe(7);
  });

  it("yields to a value the store takes for a held document, without running again", async () => {
    // The reader held its own value first. The arriving stored value retires
    // what it held and replaces it in the reader's view, and the retirement
    // is the reader's own flip, which does not run its computation.

    const {
      ownerRuntime,
      readerRuntime,
      space,
      derived,
      counts,
      settled,
      held,
    } = await readerDerives(2, (n: number) => n * 2);
    expect(derived.get()).toBe(4);
    expect(held()).toBe(1);

    await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell<number>(space, "derived", undefined, tx).set(7);
    });
    await ownerRuntime.storageManager.synced();
    await readerRuntime.storageManager.pullOpenSpacesToHead();
    await settled();

    expect(derived.get()).toBe(7);
    expect(held()).toBe(0);
    expect(counts.refusals).toBe(0);
    await settled();
    expect(counts.runs).toBe(1);
  });

  it("stores the value once the principal is granted WRITE", async () => {
    const {
      ownerRuntime,
      readerRuntime,
      space,
      reader,
      derived,
      counts,
      settled,
      held,
    } = await readerDerives(2, (n: number) => n * 2);
    expect(held()).toBe(1);

    await new ACLManager(ownerRuntime, space).grant(reader.did(), "WRITE");
    await ownerRuntime.storageManager.synced();
    await readerRuntime.storageManager.pullOpenSpacesToHead();
    await settled();
    await readerRuntime.storageManager.synced();

    // The grant released the held derivation and ran its writer again,
    // which committed what it computed.
    expect(counts.refusals).toBe(0);
    expect(counts.runs).toBe(2);
    expect(held()).toBe(0);
    expect(derived.get()).toBe(4);
    const stored = ownerRuntime.getCell<number>(space, "derived");
    await ownerRuntime.storageManager.pullOpenSpacesToHead();
    await stored.sync();
    expect(stored.get()).toBe(4);
  });

  describe("a push decided by an access list the store no longer holds", () => {
    // The reader's replica reads WRITE off its copy of the access list and
    // pushes the derivation, and the store, which has taken the revocation
    // by then, refuses it for lack of a grant.

    it("reverts the refused write, then runs once more and holds what that run computes, when `localFold` is off", async () => {
      const { ownerRuntime, space, derived, counts, held } =
        await readerDerives(
          2,
          (n: number) => n * 2,
          {
            experimental: { localFold: false },
            grant: "WRITE",
            revokeBeforeFirstPush: true,
          },
        );

      // The refusal names a grant no re-run can supply, so the scheduler
      // takes no retry. The runtime, having learned the store's verdict,
      // runs the writer once more after the revert, and that run is held.
      expect(counts.refusals).toBe(1);
      expect(counts.runs).toBe(2);
      expect(derived.get()).toBe(4);
      expect(held()).toBe(1);
      const stored = ownerRuntime.getCell<number>(space, "derived");
      await stored.sync();
      expect(stored.get()).toBeUndefined();
    });

    it("holds the next derivation once an input changes, when `localFold` is off", async () => {
      const {
        ownerRuntime,
        readerRuntime,
        space,
        derived,
        counts,
        settled,
        held,
      } = await readerDerives(
        2,
        (n: number) => n * 2,
        {
          experimental: { localFold: false },
          grant: "WRITE",
          revokeBeforeFirstPush: true,
        },
      );
      expect(counts.refusals).toBe(1);

      await ownerRuntime.editWithRetry((tx) => {
        ownerRuntime.getCell<number>(space, "source", undefined, tx).set(3);
      });
      await ownerRuntime.storageManager.synced();
      await readerRuntime.storageManager.pullOpenSpacesToHead();
      await settled();

      expect(counts.runs).toBe(3);
      expect(counts.refusals).toBe(1);
      expect(derived.get()).toBe(6);
      expect(held()).toBe(1);
    });

    it("keeps the refused write as a fold, when `localFold` is on", async () => {
      // The run after the revert reads the folded value and has nothing to
      // write, so nothing is held.

      const { ownerRuntime, space, derived, counts, held } =
        await readerDerives(
          2,
          (n: number) => n * 2,
          {
            experimental: { localFold: true },
            grant: "WRITE",
            revokeBeforeFirstPush: true,
          },
        );

      expect(counts.refusals).toBe(1);
      expect(counts.runs).toBe(2);
      expect(derived.get()).toBe(4);
      expect(held()).toBe(0);
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
          {
            experimental: { localFold: true },
            grant: "WRITE",
            revokeBeforeFirstPush: true,
          },
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

    it("refuses a write over a kept value when the store changed the document since", async () => {
      // The reader's change is to `doubled` alone, and the owner's concurrent
      // one to `from` alone, so only a read of the whole document can
      // conflict.

      const { ownerRuntime, readerRuntime, space, reader, derived, counts } =
        await readerDerives(
          { n: 2 },
          ({ n }: { n: number }) => ({ doubled: n * 2, from: "reader" }),
          {
            stored: { doubled: 0, from: "owner" },
            experimental: { localFold: true },
            grant: "WRITE",
            revokeBeforeFirstPush: true,
          },
        );
      expect(counts.refusals).toBe(1);
      expect(derived.get()).toEqual({ doubled: 4, from: "reader" });

      await new ACLManager(ownerRuntime, space).grant(reader.did(), "WRITE");
      await ownerRuntime.storageManager.synced();
      await readerRuntime.storageManager.pullOpenSpacesToHead();
      factories.get(readerRuntime)!.beforeTransact = async () => {
        factories.get(readerRuntime)!.beforeTransact = undefined;
        await ownerRuntime.editWithRetry((tx) => {
          ownerRuntime.getCell<{ from: string }>(
            space,
            "derived",
            undefined,
            tx,
          )
            .key("from").set("concurrent");
        });
        await ownerRuntime.storageManager.synced();
      };
      const tx = readerRuntime.edit();
      derived.withTx(tx).key("doubled").set(6);
      const result = await tx.commit().settled;

      expect(result.error?.name).toBe("ConflictError");
      const stored = ownerRuntime.getCell<unknown>(space, "derived");
      await ownerRuntime.storageManager.pullOpenSpacesToHead();
      await stored.sync();
      expect(stored.get()).toEqual({ doubled: 0, from: "concurrent" });
    });
  });
});
