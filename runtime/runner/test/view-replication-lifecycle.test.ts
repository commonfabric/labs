import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { ViewInterest, ViewPlan } from "@commonfabric/memory/v2";

import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { viewInputFingerprint } from "../src/view-input-basis.ts";
import type {
  IMemorySpaceAddress,
  ISpaceReplica,
} from "../src/storage/interface.ts";
import { LocalReadUnavailable } from "../src/storage/local-read-policy.ts";

const signer = await Identity.fromPassphrase("view lifetime test");
const space = signer.did();

describe("view replication lifetimes", () => {
  let runtime: Runtime;
  let storage: ReturnType<typeof StorageManager.emulate>;
  let replica: Required<ISpaceReplica>;
  let capable: boolean;
  let emit: (plans: readonly ViewPlan[]) => void;
  let interests: ViewInterest[];
  let restore: (() => void)[];

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      clientClass: "web",
      experimental: { serverExecution: true, viewScopedReplication: true },
    });
    replica = storage.open(space).replica as Required<ISpaceReplica>;
    capable = true;
    interests = [];
    restore = [];
    restore.push(
      stub(replica, "supportsViewReplication", () => Promise.resolve(capable))
        .restore,
    );
    restore.push(
      stub(replica, "viewReplicationSupported", () => capable).restore,
    );
    restore.push(
      stub(replica, "subscribeViewPlans", (observer) => {
        emit = observer;
        observer([]);
        return () => {};
      }).restore,
    );
    restore.push(
      stub(replica, "setViewInterests", (views) => {
        interests = views;
        return Promise.resolve(true);
      }).restore,
    );
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    for (const undo of restore.reverse()) undo();
    await storage.close();
  });

  it("checks shared producer ancestors once per proof and observes every basis", async () => {
    const root = runtime.getCell(space, "shared ancestors", undefined);
    const cancel = await runtime.viewReplication.mount(root, "screen");
    const document = { value: 1 };
    let changed = false;
    restore.push(stub(replica, "hasLocalDocumentCoverage", () => true).restore);
    restore.push(
      stub(
        replica,
        "getDocument",
        (id) => changed && id === "of:producer-0" ? { value: 2 } : document,
      ).restore,
    );
    const basis = (index: number) => ({
      id: `of:producer-${index}`,
      scope: "space" as const,
      path: ["value"],
      fingerprint: viewInputFingerprint(document, ["value"]),
    });
    const producers = Array.from({ length: 18 }, (_, index) => ({
      id: `producer-${index}`,
      writes: [basis(index)],
      basis: {
        reads: [index - 1, index - 2].filter((i) => i >= 0).map(basis),
        outputs: [basis(index)],
      },
    }));
    emit([{
      id: "screen",
      revision: interests[0].revision,
      generation: 1,
      eligibleActions: [],
      pieces: [],
      producers,
    }]);
    const observed: IMemorySpaceAddress[] = [];
    expect(runtime.viewReplication.producerCurrent(
      space,
      "producer-17",
      () => false,
      (address) => observed.push(address),
    )).toBe(true);
    const expected = producers.flatMap((producer) => [
      ...producer.basis.reads,
      ...producer.basis.outputs,
    ]);
    expect(observed.length).toBeLessThanOrEqual(expected.length);
    expect(new Set(observed.map((address) => address.id))).toEqual(
      new Set(expected.map((address) => address.id)),
    );
    observed.length = 0;
    const check = runtime.viewReplication.createProducerCheck(
      space,
      () => false,
      (address) => observed.push(address),
    );
    expect(check("producer-17")).toBe(true);
    expect(check("producer-16")).toBe(true);
    expect(observed.length).toBeLessThanOrEqual(expected.length);
    changed = true;
    expect(runtime.viewReplication.producerCurrent(
      space,
      "producer-17",
      () => false,
      () => {},
    )).toBe(false);
    expect(runtime.viewReplication.producerCurrent(
      space,
      "producer-17",
      (id) => id === "producer-0",
      () => {},
    )).toBe(false);
    cancel!();
  });

  it("matches scoped overlapping writes and retires replaced producer surfaces", async () => {
    const root = runtime.getCell(space, "producer surfaces", undefined);
    const cancel = await runtime.viewReplication.mount(root, "screen");
    const address = {
      space,
      id: "of:shared",
      type: "application/json",
      scope: "user",
      path: ["value", "item"],
    } satisfies IMemorySpaceAddress;
    const plan: ViewPlan = {
      id: "screen",
      revision: interests[0].revision,
      generation: 1,
      eligibleActions: [],
      pieces: [],
      inputs: [{ id: address.id, scope: "user" }],
      producers: [
        { id: "parent", writes: [{ ...address, path: ["value"] }] },
        { id: "child", writes: [{ ...address, path: ["value", "item", "x"] }] },
        { id: "sibling", writes: [{ ...address, path: ["value", "other"] }] },
        { id: "other scope", writes: [{ ...address, scope: "session" }] },
      ],
    };
    emit([plan]);
    expect(runtime.viewReplication.permits(address)).toBe(true);
    expect(runtime.viewReplication.permits({ ...address, scope: "session" }))
      .toBe(false);
    expect(runtime.viewReplication.producers(address)).toEqual(
      new Set(["parent", "child"]),
    );
    emit([{ ...plan, generation: 2, producers: [], inputs: [] }]);
    expect(runtime.viewReplication.producers(address)).toEqual(new Set());
    expect(runtime.viewReplication.permits(address)).toBe(false);
    cancel!();
  });

  it("rejects producer cycles unless a current local result breaks the cycle", async () => {
    const root = runtime.getCell(space, "cyclic producers", undefined);
    const cancel = await runtime.viewReplication.mount(root, "screen");
    restore.push(stub(replica, "hasLocalDocumentCoverage", () => true).restore);
    restore.push(stub(replica, "getDocument", () => ({ value: 1 })).restore);
    const basis = (id: string) => ({
      id: `of:${id}`,
      scope: "space" as const,
      path: ["value"],
      fingerprint: viewInputFingerprint({ value: 1 }, ["value"]),
    });
    emit([{
      id: "screen",
      revision: interests[0].revision,
      generation: 1,
      eligibleActions: [],
      pieces: [],
      producers: ["a", "b"].map((id) => ({
        id,
        writes: [basis(id)],
        basis: { reads: [basis(id === "a" ? "b" : "a")], outputs: [basis(id)] },
      })),
    }]);
    expect(
      runtime.viewReplication.producerCurrent(
        space,
        "a",
        () => false,
        () => {},
      ),
    )
      .toBe(false);
    expect(
      runtime.viewReplication.producerCurrent(
        space,
        "a",
        (id) => id === "b",
        () => {},
      ),
    )
      .toBe(true);
    expect(
      runtime.viewReplication.producerCurrent(
        space,
        "a",
        () => false,
        () => {},
      ),
    )
      .toBe(false);
    cancel!();
  });

  it("ignores a delayed plan after a mount id is reused for another root", async () => {
    const first = runtime.getCell(space, "first", undefined);
    const second = runtime.getCell(space, "second", undefined);
    let starts = 0;
    restore.push(
      stub(runtime.runner, "startViewPiece", () => {
        starts++;
        return Promise.resolve(
          Object.assign(() => {}, {
            graphIsInstalled: () => true,
            resume: () => true,
          }),
        );
      }).restore,
    );
    const cancelFirst = await runtime.viewReplication.mount(first, "screen");
    const old: ViewPlan = {
      id: "screen",
      revision: interests[0].revision,
      generation: 1,
      eligibleActions: ["old"],
      pieces: [{
        id: first.getAsNormalizedFullLink().id,
        scope: "space",
        patternIdentity: "first",
      }],
    };
    cancelFirst!();
    const cancelSecond = await runtime.viewReplication.mount(second, "screen");
    expect(interests[0].revision).toBe(1);
    emit([old]);
    await runtime.idle();
    expect(starts).toBe(0);
    expect(runtime.viewReplication.eligible(space, "old")).toBe(false);
    emit([{
      ...old,
      revision: 1,
      eligibleActions: ["new"],
      pieces: [{
        id: second.getAsNormalizedFullLink().id,
        scope: "space",
        patternIdentity: "second",
      }],
    }]);
    await runtime.idle();
    expect(starts).toBe(1);
    cancelSecond!();
  });

  it("resumes a partial graph across plan generations and retires replaced sources", async () => {
    const root = runtime.getCell(space, "partial graph", undefined);
    let starts = 0;
    let resumes = 0;
    let cancellations = 0;
    restore.push(
      stub(runtime.runner, "startViewPiece", () => {
        starts++;
        return Promise.resolve(Object.assign(() => cancellations++, {
          graphIsInstalled: () => false,
          resume: () => {
            resumes++;
            return true;
          },
        }));
      }).restore,
    );
    const cancel = await runtime.viewReplication.mount(root, "screen");
    const plan: ViewPlan = {
      id: "screen",
      revision: interests[0].revision,
      generation: 1,
      eligibleActions: [],
      pieces: [{
        id: root.getAsNormalizedFullLink().id,
        scope: "space",
        patternIdentity: "first",
      }],
    };
    emit([plan]);
    await runtime.idle();
    expect(starts).toBe(1);
    emit([{ ...plan, generation: 2 }]);
    await runtime.idle();
    expect(resumes).toBe(1);
    expect(starts).toBe(1);
    expect(cancellations).toBe(0);
    emit([{
      ...plan,
      generation: 3,
      pieces: [{ ...plan.pieces[0], patternIdentity: "replacement" }],
    }]);
    await runtime.idle();
    expect(starts).toBe(2);
    expect(cancellations).toBe(1);
    cancel!();
    await runtime.idle();
    expect(cancellations).toBe(2);
  });

  it("waits for restored authentication before falling back from an empty plan", async () => {
    const root = runtime.getCell(space, "fallback", undefined);
    const resumed = Promise.withResolvers<void>();
    restore.push(
      stub(replica, "whenSessionRestored", () => resumed.promise).restore,
    );
    let starts = 0;
    restore.push(
      stub(runtime, "start", () => {
        starts++;
        return Promise.resolve(true);
      }).restore,
    );
    const cancel = await runtime.viewReplication.mount(root, "screen");
    const cancelOther = await runtime.viewReplication.mount(root, "other");
    capable = false;
    emit([]);
    expect(runtime.viewReplication.active(space)).toBe(false);
    expect(starts).toBe(0);
    const action = Object.assign(() => {}, {
      viewLocalOnly: true,
      viewPiece: root.getAsNormalizedFullLink(),
      viewNodeId: "stale",
    }) as Action;
    const tx = runtime.edit();
    expect(() => runtime.scheduler.prepareViewAction(tx, action)).toThrow(
      LocalReadUnavailable,
    );
    tx.abort();
    resumed.resolve();
    await runtime.idle();
    expect(starts).toBe(2);
    capable = true;
    emit([]);
    expect(runtime.viewReplication.active(space)).toBe(false);
    expect(await runtime.viewReplication.enable(space)).toBe(false);
    cancel!();
    expect(interests).toEqual([]);
    cancelOther!();
  });

  it("continues fallback after a root and its error callback fail", async () => {
    const failed = runtime.getCell(space, "failed fallback", undefined);
    const healthy = runtime.getCell(space, "healthy fallback", undefined);
    const failure = new Error("root unavailable");
    const reported: Error[] = [];
    const started: string[] = [];
    restore.push(
      stub(runtime, "start", (root) => {
        if (root.equals(failed)) return Promise.reject(failure);
        started.push(root.getAsNormalizedFullLink().id);
        return Promise.resolve(true);
      }).restore,
    );
    await runtime.viewReplication.mount(failed, "failed", (error) => {
      reported.push(error);
      throw new Error("error callback failed");
    });
    await runtime.viewReplication.mount(healthy, "healthy");
    capable = false;
    emit([]);
    await runtime.idle();
    expect(reported).toEqual([failure]);
    expect(started).toEqual([healthy.getAsNormalizedFullLink().id]);
  });

  it("accepts all plan state when a view error callback throws", async () => {
    const root = runtime.getCell(space, "throwing callback", undefined);
    const observed: string[] = [];
    await runtime.viewReplication.mount(root, "first", () => {
      observed.push("first");
      throw new Error("error callback failed");
    });
    await runtime.viewReplication.mount(root, "second", () => {
      observed.push("second");
    });
    const plans: ViewPlan[] = interests.map((interest) => ({
      id: interest.id,
      revision: interest.revision,
      generation: 1,
      eligibleActions: [interest.id],
      pieces: [],
      errors: [{
        nodeId: "failed",
        pieceId: root.getAsNormalizedFullLink().id,
        message: "computation failed",
      }],
    }));
    expect(() => emit(plans)).not.toThrow();
    await runtime.idle();
    expect(runtime.viewReplication.eligible(space, "first")).toBe(true);
    expect(runtime.viewReplication.eligible(space, "second")).toBe(true);
    expect(observed).toEqual(["first", "second"]);
    emit(plans);
    expect(observed).toEqual(["first", "second"]);
  });

  it("reports current view failures once and fences errors from retired mounts", async () => {
    const root = runtime.getCell(space, "error view", undefined);
    const errors: Error[] = [];
    const cancel = await runtime.viewReplication.mount(
      root,
      "screen",
      (error) => errors.push(error),
    );
    const failure = {
      nodeId: "visible",
      pieceId: root.getAsNormalizedFullLink().id,
      message: "Visible computation failed",
      stack: "mapped pattern stack",
    };
    const plan: ViewPlan = {
      id: "screen",
      revision: interests[0].revision,
      generation: 1,
      eligibleActions: [],
      pieces: [],
      errors: [failure],
    };
    emit([plan]);
    emit([{ ...plan, generation: 2 }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      pieceId: failure.pieceId,
      message: failure.message,
      stack: failure.stack,
      space,
    });
    emit([{ ...plan, generation: 3, errors: [] }]);
    emit([{ ...plan, generation: 4 }]);
    expect(errors).toHaveLength(2);
    cancel!();
    await runtime.viewReplication.mount(
      root,
      "screen",
      (error) => errors.push(error),
    );
    emit([{ ...plan, generation: 5 }]);
    expect(errors).toHaveLength(2);
    emit([{ ...plan, revision: interests[0].revision, generation: 1 }]);
    expect(errors).toHaveLength(3);
    await runtime.viewReplication.mount(root, "screen");
    emit([{ ...plan, revision: interests[0].revision, generation: 1 }]);
    expect(errors).toHaveLength(3);
  });

  for (const end of ["disposal", "capability loss"] as const) {
    it(`cancels an installed preview graph once after ${end}`, async () => {
      const root = runtime.getCell(space, `installed graph ${end}`, undefined);
      let cancellations = 0;
      using starts = stub(
        runtime.runner,
        "startViewPiece",
        () =>
          Promise.resolve(Object.assign(() => cancellations++, {
            graphIsInstalled: () => true,
            resume: () => true,
          })),
      );
      using fallback = stub(runtime, "start", () => Promise.resolve(true));
      await runtime.viewReplication.mount(root, "screen");
      const plan: ViewPlan = {
        id: "screen",
        revision: interests[0].revision,
        generation: 1,
        eligibleActions: ["preview"],
        pieces: [{
          id: root.getAsNormalizedFullLink().id,
          scope: "space",
          patternIdentity: "installed#default",
        }],
      };
      emit([plan]);
      await runtime.idle();
      expect(starts.calls).toHaveLength(1);
      expect(cancellations).toBe(0);
      expect(runtime.viewReplication.eligible(space, "preview")).toBe(true);

      if (end === "disposal") runtime.viewReplication.dispose();
      else {
        capable = false;
        emit([]);
      }
      await runtime.idle();
      expect(cancellations).toBe(1);
      expect(runtime.viewReplication.active(space)).toBe(false);
      expect(runtime.viewReplication.eligible(space, "preview")).toBe(false);
      expect(fallback.calls).toHaveLength(end === "disposal" ? 0 : 1);
      emit([{ ...plan, generation: 2 }]);
      runtime.viewReplication.dispose();
      await runtime.idle();
      expect(starts.calls).toHaveLength(1);
      expect(cancellations).toBe(1);
    });
  }

  it("retires a held graph load before draining a kept storage manager", async () => {
    const root = runtime.getCell(space, "held load", undefined);
    const entered = Promise.withResolvers<void>();
    const loaded = Promise.withResolvers<void>();
    const canceled = Promise.withResolvers<void>();
    restore.push(
      stub(runtime.runner, "startViewPiece", async () => {
        entered.resolve();
        await loaded.promise;
        return Object.assign(() => canceled.resolve(), {
          graphIsInstalled: () => true,
          resume: () => true,
        });
      }).restore,
    );
    await runtime.viewReplication.mount(root, "screen");
    emit([{
      id: "screen",
      revision: 0,
      generation: 1,
      eligibleActions: ["node"],
      pieces: [{
        id: root.getAsNormalizedFullLink().id,
        scope: "space",
        patternIdentity: "held",
      }],
    }]);
    await entered.promise;
    await runtime.dispose({ closeStorage: false });
    expect(interests).toEqual([]);
    loaded.resolve();
    await canceled.promise;
    expect(runtime.viewReplication.active(space)).toBe(false);
  });

  it("coalesces concurrent negotiation into one capability check", async () => {
    restore[0]();
    restore[0] = () => {};
    const ready = Promise.withResolvers<boolean>();
    using capability = stub(
      replica,
      "supportsViewReplication",
      () => ready.promise,
    );
    const first = runtime.viewReplication.enable(space);
    const second = runtime.viewReplication.enable(space);
    expect(capability.calls).toHaveLength(1);
    ready.resolve(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(runtime.viewReplication.active(space)).toBe(true);
  });

  it("does not acquire a view lease after disposal during negotiation", async () => {
    restore[0]();
    restore[0] = () => {};
    const ready = Promise.withResolvers<boolean>();
    using _capability = stub(
      replica,
      "supportsViewReplication",
      () => ready.promise,
    );
    const acquire = replica.acquireViewInterests.bind(replica);
    using lease = stub(replica, "acquireViewInterests", acquire);
    const enabling = runtime.viewReplication.enable(space);
    await runtime.dispose({ closeStorage: false });
    ready.resolve(true);
    expect(await enabling).toBe(false);
    expect(lease.calls).toHaveLength(0);
    expect(await runtime.viewReplication.enable(space)).toBe(false);
    expect(
      await runtime.viewReplication.mount(
        runtime.getCell(space, "disposed", undefined),
        "screen",
      ),
    ).toBeUndefined();
  });

  it("releases a failed initial interest lease and permits a later negotiation", async () => {
    restore[3]();
    restore[3] = () => {};
    const acquire = replica.acquireViewInterests.bind(replica);
    const leases: ReturnType<typeof acquire>[] = [];
    using _acquisition = stub(replica, "acquireViewInterests", (onReplaced) => {
      const lease = acquire(onReplaced);
      leases.push(lease);
      return lease;
    });
    let fail = true;
    using _requests = stub(replica, "setViewInterests", (views) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("Initial interest failed"));
      }
      interests = views;
      return Promise.resolve(true);
    });
    await expect(runtime.viewReplication.enable(space)).rejects.toThrow(
      "Initial interest failed",
    );
    expect(runtime.viewReplication.active(space)).toBe(false);
    expect(leases).toHaveLength(1);
    expect(leases[0].isCurrent()).toBe(false);
    const cancel = await runtime.viewReplication.mount(
      runtime.getCell(space, "recovered", undefined),
      "screen",
    );
    expect(cancel).toBeDefined();
    expect(interests.map((view) => view.id)).toEqual(["screen"]);
    expect(runtime.viewReplication.active(space)).toBe(true);
    cancel!();
    await runtime.idle();
  });

  it("removes a failed mount while retaining another view's demand", async () => {
    restore[3]();
    restore[3] = () => {};
    let fail = true;
    using _requests = stub(replica, "setViewInterests", (views) => {
      if (fail && views.some((view) => view.id === "failed")) {
        fail = false;
        return Promise.reject(new Error("Mount refused"));
      }
      interests = views;
      return Promise.resolve(true);
    });
    const root = runtime.getCell(space, "mount recovery", undefined);
    const healthy = await runtime.viewReplication.mount(root, "healthy");
    await expect(runtime.viewReplication.mount(root, "failed")).rejects.toThrow(
      "Mount refused",
    );
    await runtime.idle();
    expect(interests.map((view) => view.id)).toEqual(["healthy"]);
    const recovered = await runtime.viewReplication.mount(root, "failed");
    expect(interests.map((view) => view.id)).toEqual(["healthy", "failed"]);
    recovered!();
    healthy!();
    await runtime.idle();
    expect(interests).toEqual([]);
  });

  it("leaves ordinary startup inactive until the view plan installs a graph", async () => {
    const root = runtime.getCell(space, "unplanned graph", undefined);
    const cancel = await runtime.viewReplication.mount(root, "screen");
    expect(await runtime.start(root)).toBe(false);
    expect(runtime.viewReplication.active(space)).toBe(true);
    cancel!();
    await runtime.idle();
  });

  for (const rejected of [false, true]) {
    it(`ignores a retired fallback root after its synchronization ${rejected ? "fails" : "finishes"}`, async () => {
      const root = runtime.getCell(space, "retired fallback", undefined);
      const healthy = runtime.getCell(space, "retained fallback", undefined);
      const entered = Promise.withResolvers<void>();
      const ready = Promise.withResolvers<void>();
      const syncCell = storage.syncCell.bind(storage);
      using _sync = stub(storage, "syncCell", async (cell, ...args) => {
        if (cell.equals(root)) {
          entered.resolve();
          await ready.promise;
          if (rejected) throw new Error("Retired root unavailable");
        }
        return await syncCell(cell, ...args);
      });
      const started: string[] = [];
      using _starts = stub(runtime, "start", (cell) => {
        started.push(cell.getAsNormalizedFullLink().id);
        return Promise.resolve(true);
      });
      const errors: Error[] = [];
      const cancel = await runtime.viewReplication.mount(
        root,
        "retired",
        (error) => errors.push(error),
      );
      await runtime.viewReplication.mount(healthy, "healthy");
      capable = false;
      emit([]);
      try {
        await entered.promise;
        cancel!();
        ready.resolve();
        await runtime.idle();
        expect(errors).toEqual([]);
        expect(started).toEqual([healthy.getAsNormalizedFullLink().id]);
      } finally {
        ready.resolve();
      }
    });
  }

  it("admits inline values without claiming producer evidence before negotiation", () => {
    const inline = runtime.getImmutableCell(space, "literal");
    const remote = runtime.getCell(space, "unnegotiated", undefined);
    expect(
      runtime.viewReplication.permits(
        toMemorySpaceAddress(inline.getAsNormalizedFullLink()),
      ),
    ).toBe(true);
    expect(
      runtime.viewReplication.permits(
        toMemorySpaceAddress(remote.getAsNormalizedFullLink()),
      ),
    ).toBe(false);
    expect(
      runtime.viewReplication.producers(
        toMemorySpaceAddress(remote.getAsNormalizedFullLink()),
      ),
    ).toEqual(new Set());
    expect(
      runtime.viewReplication.producerCurrent(
        space,
        "unknown",
        () => true,
        () => {},
      ),
    ).toBe(false);
  });

  it("waits for a piece's source identity before installing its graph", async () => {
    const root = runtime.getCell(space, "source pending", undefined);
    using starts = stub(
      runtime.runner,
      "startViewPiece",
      () => Promise.resolve(undefined),
    );
    const cancel = await runtime.viewReplication.mount(root, "screen");
    const plan: ViewPlan = {
      id: "screen",
      revision: interests[0].revision,
      generation: 1,
      eligibleActions: ["preview"],
      pieces: [root.getAsNormalizedFullLink()],
    };
    emit([plan]);
    await runtime.idle();
    expect(starts.calls).toHaveLength(0);
    expect(runtime.viewReplication.pieceCurrent(root.getAsNormalizedFullLink()))
      .toBe(false);
    emit([{
      ...plan,
      generation: 2,
      pieces: [{ ...plan.pieces[0], patternIdentity: "source#default" }],
    }]);
    await runtime.idle();
    expect(starts.calls).toHaveLength(1);
    cancel!();
    await runtime.idle();
  });
});
