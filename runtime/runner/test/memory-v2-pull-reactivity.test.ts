import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { Server as MemoryV2Server } from "@commonfabric/memory/v2/server";

import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createGraphFixture } from "./memory-v2-graph.fixture.ts";
import { testSessionOpenAuthFactory } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory-v2-pull-reactivity");
const space = signer.did();

const waitFor = async (
  predicate: () => boolean,
  timeout = 500,
): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      throw new Error("Timed out waiting for condition");
    }
    await clock.tick(5);
  }
};

const visibleIds = (
  provider: { get(uri: URI): { value?: unknown } | undefined },
  ids: readonly URI[],
) => ids.filter((id) => provider.get(id)?.value !== undefined).sort();

describe("Memory v2 pull reactivity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let remoteClient: MemoryV2Client.Client;
  let remoteSession: MemoryV2Client.SpaceSession;
  let remoteLocalSeq: number;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const candidate = storageManager as unknown as {
      server?: () => MemoryV2Server;
    };
    if (typeof candidate.server !== "function") {
      throw new Error("Expected a memory/v2 emulated storage manager");
    }
    remoteClient = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(candidate.server()),
    });
    remoteSession = await remoteClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
    remoteLocalSeq = 1;
  });

  afterEach(async () => {
    const status = tx?.status();
    if (status?.status === "ready") {
      await tx.commit().settled;
    }
    await runtime.dispose();
    await remoteClient.close();
    await storageManager.close();
    await clock.tick(1);
  });

  it("marks pull-mode computations dirty after remote integrate and recomputes on pull", async () => {
    const source = runtime.getCell<number>(
      space,
      `memory-v2-pull-source-${Date.now()}`,
      undefined,
      tx,
    );
    source.set(1);
    const result = runtime.getCell<number>(
      space,
      `memory-v2-pull-result-${Date.now()}`,
      undefined,
      tx,
    );
    result.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    await source.sync();
    await runtime.storageManager.synced();

    let computationRuns = 0;
    const computation: Action = (actionTx) => {
      computationRuns++;
      const value = source.withTx(actionTx).get();
      result.withTx(actionTx).send(value * 10);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      {},
    );

    await result.pull();
    expect(result.get()).toBe(10);
    expect(computationRuns).toBe(1);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: source.getAsNormalizedFullLink().id,
        value: { value: 2 },
      }],
    });

    await waitFor(() => runtime.scheduler.isDirty(computation));
    expect(computationRuns).toBe(1);

    await result.pull();
    expect(result.get()).toBe(20);
    expect(computationRuns).toBe(2);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);
  });

  it("marks pull-mode graph computations dirty when a 64-node frontier expands", async () => {
    const fixture = createGraphFixture(space);
    const expandedChildId = "of:test-node-33" as URI;
    const expandedChildValue = structuredClone(
      fixture.docs.find((doc) => doc.id === expandedChildId)?.value,
    );
    const observer = storageManager.open(space) as unknown as {
      get(uri: URI): { value: unknown } | undefined;
      sync(
        uri: URI,
        selector: { path: string[]; schema: unknown },
      ): Promise<{ ok?: Record<PropertyKey, never> }>;
    };

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: fixture.docs.map(({ id, value }) => ({
        op: "set" as const,
        id,
        value: { value },
      })),
    });

    if (!expandedChildValue) {
      throw new Error(`Missing graph fixture doc ${expandedChildId}`);
    }

    const root = runtime.getCellFromEntityId<any>(
      space,
      fixture.rootId,
      [],
      fixture.schema as any,
      tx,
    );
    const result = runtime.getCell<string>(
      space,
      `memory-v2-pull-graph-result-${Date.now()}`,
      undefined,
      tx,
    );
    result.set("init");
    await tx.commit().settled;
    tx = runtime.edit();

    expect(
      await observer.sync(fixture.rootId, { path: [], schema: fixture.schema }),
    ).toEqual({ ok: {} });
    await root.sync();
    await root.pull();
    await storageManager.synced();
    await waitFor(() =>
      visibleIds(observer, fixture.expandedReachableIds).length ===
        fixture.initialReachableIds.length
    );

    let computationRuns = 0;
    const computation: Action = (actionTx) => {
      computationRuns++;
      const current = root.withTx(actionTx).get();
      const next = current?.alternate?.children?.[0]?.name ?? "missing";
      result.withTx(actionTx).send(next);
    };

    runtime.scheduler.subscribe(
      computation,
      {
        reads: [toMemorySpaceAddress(root.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(result.getAsNormalizedFullLink())],
      },
      {},
    );

    await result.pull();
    expect(result.get()).toBe("Node 29");
    expect(computationRuns).toBe(1);
    expect(visibleIds(observer, fixture.expandedReachableIds)).toEqual(
      fixture.initialReachableIds,
    );

    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: fixture.rootId,
        value: { value: fixture.expandedRootValue },
      }],
    });

    await waitFor(() => runtime.scheduler.isDirty(computation));
    await waitFor(() =>
      visibleIds(observer, fixture.expandedReachableIds).length ===
        fixture.expandedReachableIds.length
    );
    expect(computationRuns).toBe(1);

    await result.pull();
    expect(result.get()).toBe("Node 33");
    expect(computationRuns).toBe(2);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);
    expect(visibleIds(observer, fixture.expandedReachableIds)).toEqual(
      fixture.expandedReachableIds,
    );

    expandedChildValue.name = "Expanded Node 33";
    await remoteSession.transact({
      localSeq: remoteLocalSeq++,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: expandedChildId,
        value: { value: expandedChildValue },
      }],
    });

    await waitFor(() => runtime.scheduler.isDirty(computation));
    expect(computationRuns).toBe(2);

    await result.pull();
    expect(result.get()).toBe("Expanded Node 33");
    expect(computationRuns).toBe(3);
    expect(runtime.scheduler.isDirty(computation)).toBe(false);
  });
});
