import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { ViewInterest, ViewPlan } from "@commonfabric/memory/v2";

import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { patternIdentityKey } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  ISpaceReplica,
} from "../src/storage/interface.ts";
import {
  LocalReadUnavailable,
  validateLocalReadBasis,
} from "../src/storage/local-read-policy.ts";
import { viewInputFingerprint } from "../src/view-input-basis.ts";

const signer = await Identity.fromPassphrase("initial view currency");
const space = signer.did();
const source = { identity: "currency-fixture", symbol: "default" };
const identity = patternIdentityKey(source);

describe("view-server-currency", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let replica: Required<ISpaceReplica>;
  let root: Cell<unknown>;
  let input: Cell<number>;
  let upstream: Cell<number>;
  let middle: Cell<number>;
  let output: Cell<number>;
  let plan: ViewPlan;
  let emit: (plans: readonly ViewPlan[]) => void;
  let interests: ViewInterest[];
  let restore: (() => void)[];
  let coverage: (() => void)[];
  let uncovered: Set<string>;
  let runs: number;
  let completedRuns: number;

  /** Fingerprints the value the scheduler actually reads through a cell. */
  function basis(cell: Cell<number>) {
    const link = cell.getAsNormalizedFullLink();
    const path = ["value", ...link.path];
    return {
      id: link.id,
      scope: link.scope,
      path,
      fingerprint: viewInputFingerprint(
        replica.getDocument(link.id, link.scope),
        path,
      ),
    };
  }

  /** Registers a real guarded computation over the resident test values. */
  function register(options: { adopt?: boolean; isEffect?: boolean } = {}) {
    const action: Action = Object.assign((tx: IExtendedStorageTransaction) => {
      runs++;
      output.withTx(tx).set(input.withTx(tx).get() + middle.withTx(tx).get());
      completedRuns++;
    }, {
      viewPiece: root.getAsNormalizedFullLink(),
      viewNodeId: "visible",
      viewLocalOnly: true,
      writes: [output.getAsNormalizedFullLink()],
    });
    runtime.scheduler.register(action, {
      adoptViewIdentity: options.adopt === false ? undefined : identity,
      isEffect: options.isEffect,
    });
    return action;
  }

  /** Reads the current proof without registering or running a computation. */
  function proof(expectedIdentity = identity) {
    return runtime.viewReplication.initialViewDependencies(
      root.getAsNormalizedFullLink(),
      "visible",
      expectedIdentity,
    );
  }

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      clientClass: "web",
      experimental: { serverExecution: true, viewScopedReplication: true },
    });
    replica = storage.open(space).replica as Required<ISpaceReplica>;
    restore = [];
    interests = [];
    coverage = [];
    uncovered = new Set();
    runs = 0;
    completedRuns = 0;
    restore.push(
      stub(replica, "supportsViewReplication", () => Promise.resolve(true))
        .restore,
      stub(replica, "viewReplicationSupported", () => true).restore,
      stub(replica, "subscribeViewPlans", (observer) => {
        emit = observer;
        observer([]);
        return () => {};
      }).restore,
      stub(replica, "setViewInterests", (views) => {
        interests = views;
        return Promise.resolve(true);
      }).restore,
      stub(runtime.runner, "startViewPiece", () => Promise.resolve(undefined))
        .restore,
    );
    const hasCoverage = replica.hasLocalDocumentCoverage.bind(replica);
    const subscribeCoverage = replica.subscribeLocalCoverage.bind(replica);
    restore.push(
      stub(
        replica,
        "hasLocalDocumentCoverage",
        (id, scope) => !uncovered.has(id) && hasCoverage(id, scope),
      ).restore,
      stub(replica, "subscribeLocalCoverage", (observer) => {
        coverage.push(() => observer([]));
        return subscribeCoverage(observer);
      }).restore,
    );
    root = runtime.getCell(space, "currency root", undefined);
    input = runtime.getCell(space, "currency input", { type: "number" });
    upstream = runtime.getCell(space, "currency upstream", { type: "number" });
    middle = runtime.getCell(space, "currency middle", { type: "number" });
    output = runtime.getCell(space, "currency output", { type: "number" });
    await runtime.editWithRetry((tx) => {
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        source,
        rawMetaWriteAuthorization,
      );
      input.withTx(tx).set(3);
      upstream.withTx(tx).set(2);
      middle.withTx(tx).set(4);
      output.withTx(tx).set(7);
    });
    await runtime.storageManager.synced();
    await runtime.viewReplication.mount(root, "screen");
    plan = {
      id: "screen",
      revision: interests[0].revision,
      generation: 1,
      eligibleActions: ["visible"],
      inputs: [input, middle, output].map((cell) =>
        cell.getAsNormalizedFullLink()
      ),
      pieces: [{
        ...root.getAsNormalizedFullLink(),
        patternIdentity: identity,
      }],
      producers: [{
        id: "visible",
        writes: [basis(output)],
        basis: {
          reads: [basis(input), basis(middle)],
          outputs: [basis(output)],
        },
      }, {
        id: "upstream",
        writes: [basis(middle)],
        basis: { reads: [basis(upstream)], outputs: [basis(middle)] },
      }],
    };
    emit([plan]);
    await runtime.idle();
  });

  afterEach(async () => {
    await runtime.dispose();
    for (const undo of restore.reverse()) undo();
    await storage.close();
  });

  it("adopts only initial registrations and executes first and subsequent edits", async () => {
    const action = register();
    expect(runtime.scheduler.isDirty(action)).toBe(false);
    const cancel = output.sink(() => {});
    await runtime.idle();
    expect(runs).toBe(0);
    expect(output.get()).toBe(7);
    for (const value of [5, 8]) {
      await runtime.editWithRetry((tx) => input.withTx(tx).set(value));
      await runtime.idle();
      expect(output.get()).toBe(value + 4);
    }
    expect(runs).toBe(2);
    runtime.scheduler.register(action, { adoptViewIdentity: identity });
    expect(runtime.scheduler.isDirty(action)).toBe(true);
    cancel();
  });

  it("keeps unchanged evidence current through plan and coverage notifications", async () => {
    register();
    const cancel = output.sink(() => {});
    emit([{ ...plan, generation: 2 }]);
    for (const notify of coverage) notify();
    await runtime.idle();
    expect(runs).toBe(0);
    cancel();
  });

  for (const field of ["input", "output", "ancestor"] as const) {
    it(`rejects a changed ${field} value`, async () => {
      const cell = field === "input"
        ? input
        : field === "output"
        ? output
        : upstream;
      await runtime.editWithRetry((tx) => cell.withTx(tx).set(99));
      expect(proof()).toBeUndefined();
      expect(runtime.scheduler.isDirty(register())).toBe(true);
    });
  }

  it("rejects missing and cyclic producer evidence", () => {
    const producer = plan.producers![1];
    emit([{
      ...plan,
      generation: 2,
      producers: [plan.producers![0], {
        ...producer,
        basis: undefined,
      }],
    }]);
    expect(proof()).toBeUndefined();
    emit([{
      ...plan,
      generation: 3,
      producers: [plan.producers![0], {
        ...producer,
        basis: { reads: [basis(output)], outputs: [basis(middle)] },
      }],
    }]);
    expect(proof()).toBeUndefined();
  });

  it("requires the bound source, admitted inputs, eligibility, and own coverage", async () => {
    expect(proof("other#default")).toBeUndefined();
    const id = input.getAsNormalizedFullLink().id;
    uncovered.add(id);
    expect(proof()).toBeUndefined();
    uncovered.delete(id);
    emit([{ ...plan, generation: 2, inputs: [] }]);
    expect(proof()).toBeUndefined();
    emit([{ ...plan, generation: 3, eligibleActions: [] }]);
    expect(proof()).toBeUndefined();
    emit([{ ...plan, generation: 4 }]);
    await runtime.editWithRetry((tx) =>
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        { ...source, identity: "replacement" },
        rawMetaWriteAuthorization,
      )
    );
    expect(proof()).toBeUndefined();
  });

  it("wakes on output changes and reestablishes the computed value", async () => {
    register();
    const cancel = output.sink(() => {});
    await runtime.idle();
    await runtime.editWithRetry((tx) => output.withTx(tx).set(99));
    await runtime.idle();
    expect(runs).toBe(1);
    expect(output.get()).toBe(7);
    cancel();
  });

  it("tracks transitive producer reads and resumes after same-value settlement", async () => {
    register();
    const cancel = output.sink(() => {});
    await runtime.idle();
    await runtime.editWithRetry((tx) => upstream.withTx(tx).set(3));
    await runtime.idle();
    expect(output.get()).toBe(7);
    expect(runs).toBeGreaterThan(0);
    const attempts = runs;
    emit([{
      ...plan,
      generation: 2,
      producers: [plan.producers![0], {
        ...plan.producers![1],
        basis: { reads: [basis(upstream)], outputs: [basis(middle)] },
      }],
    }]);
    await runtime.idle();
    expect(runs).toBeGreaterThan(attempts);
    expect(output.get()).toBe(7);
    cancel();
  });

  it("retires adopted evidence on coverage loss and parks without overwriting", async () => {
    const action = register();
    const cancel = output.sink(() => {});
    await runtime.idle();
    uncovered.add(input.getAsNormalizedFullLink().id);
    for (const notify of [...coverage]) notify();
    expect(runtime.scheduler.isDirty(action)).toBe(true);
    await runtime.idle();
    expect(output.get()).toBe(7);
    uncovered.clear();
    for (const notify of [...coverage]) notify();
    await runtime.idle();
    expect(runs).toBeGreaterThan(0);
    expect(output.get()).toBe(7);
    cancel();
  });

  it("rechecks omitted ancestors on plan changes without claiming a local outcome", async () => {
    uncovered.add(upstream.getAsNormalizedFullLink().id);
    // No local intent touches the ancestor that the server alone retains.
    restore.push(
      stub(replica, "speculationRetirementView", () => ({
        confirmedSeq: 0,
        pendingLocalSeqs: [],
      })).restore,
    );
    const action = register();
    expect(runtime.scheduler.isDirty(action)).toBe(false);
    const cancel = output.sink(() => {});
    await runtime.idle();
    expect(runs).toBe(0);
    emit([{
      ...plan,
      generation: 2,
      producers: [plan.producers![0], {
        ...plan.producers![1],
        basis: undefined,
      }],
    }]);
    expect(runtime.scheduler.isDirty(action)).toBe(true);
    await runtime.idle();
    expect(output.get()).toBe(7);
    cancel();
  });

  it("fences source changes and stale plans after a remount", async () => {
    const action = register();
    await runtime.editWithRetry((tx) =>
      root.withTx(tx).setMetaRaw(
        "patternIdentity",
        { ...source, identity: "replacement" },
        rawMetaWriteAuthorization,
      )
    );
    expect(runtime.scheduler.isDirty(action)).toBe(true);
    await runtime.viewReplication.mount(root, "screen");
    emit([plan]);
    expect(proof()).toBeUndefined();
    expect(runtime.viewReplication.eligible(space, "visible")).toBe(false);
  });

  it("checks server evidence when a dependent reads an adopted producer", () => {
    register();
    emit([{
      ...plan,
      generation: 2,
      eligibleActions: ["visible", "consumer"],
    }]);
    const documentAt = replica.getDocument.bind(replica);
    restore.push(
      stub(replica, "getDocument", (id, scope) => {
        return id === upstream.getAsNormalizedFullLink().id
          ? { value: 99 }
          : documentAt(id, scope);
      }).restore,
    );
    const consumer: Action = Object.assign(() => {}, {
      viewPiece: root.getAsNormalizedFullLink(),
      viewNodeId: "consumer",
      viewLocalOnly: true,
    });
    const tx = runtime.edit();
    try {
      runtime.scheduler.prepareViewAction(tx, consumer);
      expect(() => output.withTx(tx).get()).toThrow(LocalReadUnavailable);
    } finally {
      tx.abort();
    }
  });

  it("wakes two adopted nodes through a shared basis and a same-value local producer", async () => {
    emit([{
      ...plan,
      generation: 2,
      eligibleActions: ["visible", "upstream"],
      inputs: [...plan.inputs!, upstream.getAsNormalizedFullLink()],
    }]);
    let upstreamRuns = 0;
    const producer: Action = Object.assign(
      (tx: IExtendedStorageTransaction) => {
        upstreamRuns++;
        upstream.withTx(tx).get();
        middle.withTx(tx).set(4);
      },
      {
        viewPiece: root.getAsNormalizedFullLink(),
        viewNodeId: "upstream",
        viewLocalOnly: true,
        writes: [middle.getAsNormalizedFullLink()],
      },
    );
    runtime.scheduler.register(producer, { adoptViewIdentity: identity });
    register();
    const cancel = output.sink(() => {});
    await runtime.idle();
    expect([upstreamRuns, runs]).toEqual([0, 0]);
    await runtime.editWithRetry((tx) => upstream.withTx(tx).set(3));
    await runtime.idle();
    expect(upstreamRuns).toBe(1);
    expect(completedRuns).toBe(1);
    expect(output.get()).toBe(7);
    cancel();
  });

  it("proves a producer that two adopted nodes reach once per wake", async () => {
    emit([{
      ...plan,
      generation: 2,
      eligibleActions: ["visible", "upstream"],
      inputs: [...plan.inputs!, upstream.getAsNormalizedFullLink()],
    }]);
    const producer: Action = Object.assign(
      (tx: IExtendedStorageTransaction) => {
        upstream.withTx(tx).get();
        middle.withTx(tx).set(4);
      },
      {
        viewPiece: root.getAsNormalizedFullLink(),
        viewNodeId: "upstream",
        viewLocalOnly: true,
        writes: [middle.getAsNormalizedFullLink()],
      },
    );
    runtime.scheduler.register(producer, { adoptViewIdentity: identity });
    register();
    const cancel = output.sink(() => {});
    await runtime.idle();
    const upstreamId = upstream.getAsNormalizedFullLink().id;
    let upstreamReads = 0;
    const documentAt = replica.getDocument.bind(replica);
    restore.push(
      stub(replica, "getDocument", (id, scope, identity) => {
        if (id === upstreamId) upstreamReads++;
        return documentAt(id, scope, identity);
      }).restore,
    );
    using sources = spy(runtime.viewReplication, "pieceCurrent");
    emit([{
      ...plan,
      generation: 3,
      eligibleActions: ["visible", "upstream"],
      inputs: [...plan.inputs!, upstream.getAsNormalizedFullLink()],
    }]);
    expect(upstreamReads).toBe(1);
    expect(sources.calls).toHaveLength(1);
    await runtime.idle();
    expect(runs).toBe(0);
    cancel();
  });

  it("proves again under a plan accepted while a pass ran", () => {
    const pass = runtime.viewReplication.createProofPass();
    const piece = root.getAsNormalizedFullLink();
    expect(
      runtime.viewReplication.initialViewDependencies(
        piece,
        "visible",
        identity,
        pass,
      ),
    ).toBeDefined();
    emit([{
      ...plan,
      generation: 2,
      producers: [plan.producers![0], {
        ...plan.producers![1],
        basis: {
          reads: [{ ...basis(upstream), fingerprint: "stale" }],
          outputs: [basis(middle)],
        },
      }],
    }]);
    expect(
      runtime.viewReplication.initialViewDependencies(
        piece,
        "visible",
        identity,
        pass,
      ),
    ).toBeUndefined();
  });

  it("does not resubscribe an adopted node whose proof a wake finds unchanged", async () => {
    const action = register();
    const cancel = output.sink(() => {});
    await runtime.idle();
    using resubscribes = spy(runtime.scheduler, "resubscribe");
    emit([{ ...plan, generation: 2 }]);
    expect(resubscribes.calls.filter((call) => call.args[0] === action))
      .toHaveLength(0);
    expect(runtime.scheduler.isDirty(action)).toBe(false);
    cancel();
  });

  it("rejects a plan replacement during initial proof validation", () => {
    const documentAt = replica.getDocument.bind(replica);
    let replaced = false;
    restore.push(
      stub(replica, "getDocument", (id, scope) => {
        if (!replaced) {
          replaced = true;
          emit([{ ...plan, generation: 2 }]);
        }
        return documentAt(id, scope);
      }).restore,
    );
    expect(runtime.scheduler.isDirty(register())).toBe(true);
    expect(replaced).toBe(true);
  });

  it("does not adopt an old runtime after a replacement acquires its replica", async () => {
    const replacement = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      clientClass: "web",
      experimental: { serverExecution: true, viewScopedReplication: true },
    });
    try {
      await replacement.viewReplication.enable(space);
      expect(proof()).toBeUndefined();
      expect(runtime.scheduler.isDirty(register())).toBe(true);
    } finally {
      await replacement.dispose({ closeStorage: false });
    }
  });

  it("keeps effect and ordinary registrations on their execution path", () => {
    expect(runtime.scheduler.isDirty(register({ isEffect: true }))).toBe(true);
    expect(runtime.scheduler.isDirty(register({ adopt: false }))).toBe(true);
  });
  it("revokes a canceled local producer's currency in an open reader transaction", async () => {
    emit([{
      ...plan,
      generation: 2,
      eligibleActions: ["visible", "consumer"],
    }]);
    const action = register();
    const cancel = output.sink(() => {});
    await runtime.editWithRetry((tx) => input.withTx(tx).set(5));
    await runtime.idle();
    expect(completedRuns).toBe(1);
    expect(output.get()).toBe(9);
    const consumer: Action = Object.assign(() => {}, {
      viewPiece: root.getAsNormalizedFullLink(),
      viewNodeId: "consumer",
      viewLocalOnly: true,
    });
    const tx = runtime.edit();
    try {
      runtime.scheduler.prepareViewAction(tx, consumer);
      expect(output.withTx(tx).get()).toBe(9);
      expect(validateLocalReadBasis(tx)).toBeUndefined();
      runtime.scheduler.unsubscribe(action);
      expect(validateLocalReadBasis(tx)).toBeInstanceOf(LocalReadUnavailable);
    } finally {
      tx.abort();
      cancel();
    }
  });

  it("removes retired observed writes and their reader edges from an adopted producer", async () => {
    const retired = runtime.getCell<number>(space, "retired output", {
      type: "number",
    });
    await runtime.editWithRetry((tx) => retired.withTx(tx).set(11));
    await runtime.storageManager.synced();
    const expanded = {
      ...plan.producers![0],
      writes: [basis(output), basis(retired)],
      basis: {
        reads: [basis(input), basis(middle)],
        outputs: [basis(output), basis(retired)],
      },
    };
    emit([{
      ...plan,
      generation: 2,
      inputs: [...plan.inputs!, retired.getAsNormalizedFullLink()],
      producers: [expanded, plan.producers![1]],
    }]);
    const action = register();
    const reader: Action = (tx) => {
      retired.withTx(tx).get();
    };
    const cancelReader = runtime.scheduler.register(reader, { isEffect: true });
    try {
      await runtime.idle();
      expect(runs).toBe(0);
      expect(runtime.scheduler.getDependents(action).has(reader)).toBe(true);
      emit([{ ...plan, generation: 3 }]);
      await runtime.idle();
      expect(runs).toBe(0);
      expect(
        runtime.scheduler.getMightWrite(action)?.some((write) =>
          write.id === retired.getAsNormalizedFullLink().id
        ),
      ).toBe(false);
      expect(runtime.scheduler.getDependents(action).has(reader)).toBe(false);
    } finally {
      cancelReader();
    }
  });

  it("wakes a parked consumer when a local producer settles with the same output", async () => {
    plan.eligibleActions.push("upstream");
    plan.inputs!.push(upstream.getAsNormalizedFullLink());
    plan.producers![1] = { ...plan.producers![1], basis: undefined };
    emit([{ ...plan, generation: 2 }]);
    register({ adopt: false });
    const cancel = output.sink(() => {});
    try {
      await runtime.idle();
      expect(runs).toBeGreaterThan(0);
      expect(completedRuns).toBe(0);
      expect(output.get()).toBe(7);
      let producerRuns = 0;
      const producer: Action = Object.assign(
        (tx: IExtendedStorageTransaction) => {
          producerRuns++;
          middle.withTx(tx).set(upstream.withTx(tx).get() * 2);
        },
        {
          viewPiece: root.getAsNormalizedFullLink(),
          viewNodeId: "upstream",
          viewLocalOnly: true,
          writes: [middle.getAsNormalizedFullLink()],
        },
      );
      runtime.scheduler.register(producer);
      const cancelProducer = middle.sink(() => {});
      try {
        await runtime.idle();
      } finally {
        cancelProducer();
      }
      expect(producerRuns).toBe(1);
      expect(completedRuns).toBe(1);
      expect(output.get()).toBe(7);
    } finally {
      cancel();
    }
  });

  it("blocks only overlapping pending local writers absent from the server plan", async () => {
    const record = runtime.getCell<{ visible: number; hidden: number }>(
      space,
      "local writer record",
      undefined,
    );
    await runtime.editWithRetry((tx) =>
      record.withTx(tx).set({ visible: 7, hidden: 8 })
    );
    await record.sync();
    plan.inputs!.push(record.getAsNormalizedFullLink());
    emit([{ ...plan, generation: 2 }]);
    const consumer = register({ adopt: false });
    const writer = (path: "visible" | "hidden", annotated: boolean) =>
      Object.assign(() => {}, {
        writes: [record.key(path).getAsNormalizedFullLink()],
        ...(annotated
          ? {
            viewPiece: root.getAsNormalizedFullLink(),
            viewNodeId: `local-${path}`,
          }
          : {}),
      });
    runtime.scheduler.register(writer("hidden", true));
    runtime.scheduler.register(writer("visible", false));
    const allowed = runtime.edit();
    try {
      runtime.scheduler.prepareViewAction(allowed, consumer);
      expect(record.key("visible").withTx(allowed).get()).toBe(7);
    } finally {
      allowed.abort();
    }
    runtime.scheduler.register(writer("visible", true));
    const blocked = runtime.edit();
    try {
      runtime.scheduler.prepareViewAction(blocked, consumer);
      expect(() => record.key("visible").withTx(blocked).get()).toThrow(
        LocalReadUnavailable,
      );
    } finally {
      blocked.abort();
    }
    expect(record.get()).toEqual({ visible: 7, hidden: 8 });
  });

  it("executes an ordinary registration even when given a view identity", async () => {
    let executions = 0;
    const action: Action = Object.assign((tx: IExtendedStorageTransaction) => {
      executions++;
      output.withTx(tx).set(9);
    }, { writes: [output.getAsNormalizedFullLink()] });
    runtime.scheduler.register(action, { adoptViewIdentity: identity });
    expect(runtime.scheduler.isDirty(action)).toBe(true);
    const cancel = output.sink(() => {});
    try {
      await runtime.idle();
      expect(executions).toBe(1);
      expect(output.get()).toBe(9);
    } finally {
      cancel();
    }
  });

  it("adopts an inline input without acquiring replica coverage for it", () => {
    input = runtime.getImmutableCell(space, 3);
    plan.producers![0] = {
      ...plan.producers![0],
      basis: { reads: [basis(input), basis(middle)], outputs: [basis(output)] },
    };
    emit([{ ...plan, generation: 2 }]);
    const evidence = proof();
    expect(evidence).toBeDefined();
    expect(evidence!.reads.map((read) => read.id)).toContain(
      input.getAsNormalizedFullLink().id,
    );
    expect(runtime.scheduler.isDirty(register())).toBe(false);
  });
});
