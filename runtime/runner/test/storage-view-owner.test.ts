import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
  type ViewInterest,
  type ViewPlan,
  type WatchSetResult,
} from "@commonfabric/memory/v2";
import {
  type Client,
  connect,
  loopback,
  type SpaceSession,
} from "@commonfabric/memory/v2/client";

import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("retired view interest response");
const space = signer.did();

const interest = (
  id: string,
  revision: number,
  root = "of:root",
): ViewInterest => ({
  id,
  revision,
  mode: "speculate",
  componentContractVersion: "1",
  query: { roots: [{ id: root, selector: { path: [], schema: false } }] },
});

describe("storage-view-owner", () => {
  let server: ReturnType<typeof newSharedServer>;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  let writer: Client;
  let writerSession: SpaceSession;
  let localSeq: number;
  const cleanup: (() => void)[] = [];

  beforeEach(async () => {
    setServerExecutionConfig(true);
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    writer = await connect({ transport: loopback(server) });
    writerSession = await writer.mount(
      space,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    localSeq = 0;
    expect(await manager.open(space).replica.supportsViewReplication!()).toBe(
      true,
    );
  });

  afterEach(async () => {
    for (const cancel of cleanup.splice(0).reverse()) cancel();
    await runtime.dispose({ closeStorage: false });
    await manager.close();
    await writer.close();
    await server.close();
    resetServerExecutionConfig();
  });

  async function write(id: string, value: string): Promise<void> {
    await writerSession.transact({
      localSeq: ++localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: { value } }],
    });
  }

  function holdViewResponse(id: string) {
    const entered = Promise.withResolvers<WatchSetResult>();
    const release = Promise.withResolvers<void>();
    const original = server.watchSet.bind(server);
    const requests = stub(server, "watchSet", async (message) => {
      const result = await original(message);
      if (message.views?.some((view) => view.id === id)) {
        if (result.ok === undefined) {
          throw new Error(`View request failed: ${result.error?.message}`);
        }
        entered.resolve(result.ok);
        await release.promise;
      }
      return result;
    });
    cleanup.push(requests.restore, release.resolve);
    return { entered: entered.promise, release: release.resolve, requests };
  }

  it("ignores view plans after their owner retires", async () => {
    const replica = manager.open(space).replica;
    const held = holdViewResponse("retired");
    const observed: (readonly ViewPlan[])[] = [];
    cleanup.push(replica.subscribeViewPlans!((value) => observed.push(value)));
    const first = replica.acquireViewInterests!(() => {});
    const pending = first.set([interest("retired", first.nextRevision())]);
    await held.entered;
    replica.acquireViewInterests!(() => {});
    held.release();
    expect(await pending).toBe(false);
    expect(observed).toEqual([[]]);
  });

  it("integrates ordinary watch updates when a replacement owner has not set views", async () => {
    const ordinary = runtime.getCell(space, "ordinary", { type: "string" });
    const id = ordinary.getAsNormalizedFullLink().id;
    await write(id, "before");
    await ordinary.sync();
    await write(id, "after");
    expect(ordinary.get()).toBe("before");
    const replica = manager.open(space).replica;
    const held = holdViewResponse("retired");
    const first = replica.acquireViewInterests!(() => {});
    const pending = first.set([interest("retired", first.nextRevision())]);
    const response = await held.entered;
    expect(response.sync.upserts.some((upsert) => upsert.id === id)).toBe(true);
    replica.acquireViewInterests!(() => {});
    held.release();
    expect(await pending).toBe(false);
    expect(ordinary.get()).toBe("after");
  });

  it("integrates retired changes before a replacement computes its delivery base", async () => {
    const ordinary = runtime.getCell(space, "ordinary", { type: "string" });
    const retained = runtime.getCell(space, "retained", { type: "string" });
    const ordinaryId = ordinary.getAsNormalizedFullLink().id;
    const retainedId = retained.getAsNormalizedFullLink().id;
    await write(ordinaryId, "before");
    await write(retainedId, "retained");
    await ordinary.sync();
    const replica = manager.open(space).replica;
    const first = replica.acquireViewInterests!(() => {});
    await first.set([interest("initial", first.nextRevision(), retainedId)]);
    await write(ordinaryId, "after");
    const held = holdViewResponse("retired");
    const pending = first.set([interest("retired", first.nextRevision())]);
    const response = await held.entered;
    expect(response.sync.removes.some((remove) => remove.id === retainedId))
      .toBe(true);
    const ordinarySeq = response.sync.upserts.find((upsert) =>
      upsert.id === ordinaryId
    )?.seq;
    expect(ordinarySeq).toBeGreaterThan(0);
    const replacement = replica.acquireViewInterests!(() => {});
    const replacing = replacement.set([
      interest("replacement", replacement.nextRevision(), retainedId),
    ]);
    held.release();
    expect(await pending).toBe(false);
    expect(await replacing).toBe(true);
    const request =
      held.requests.calls.find((call) =>
        call.args[0].views?.some((view) => view.id === "replacement")
      )!.args[0];
    expect(request.holdings?.find((holding) => holding.id === ordinaryId)?.seq)
      .toBe(ordinarySeq);
    expect(request.holdings?.some((holding) => holding.id === retainedId))
      .toBe(false);
    expect(ordinary.get()).toBe("after");
    expect(retained.get()).toBe("retained");
  });

  it("keeps replacement demand intact after retired lease operations", async () => {
    const replica = manager.open(space).replica;
    let retired = 0;
    const first = replica.acquireViewInterests!(() => retired++);
    await first.set([interest("old", first.nextRevision())]);
    const replacement = replica.acquireViewInterests!(() => {});
    const views = [interest("new", replacement.nextRevision())];
    expect(await replacement.set(views)).toBe(true);
    expect(retired).toBe(1);
    expect(first.isCurrent()).toBe(false);
    expect(() => first.nextRevision()).toThrow();
    expect(await first.set([])).toBe(false);
    first.release();
    expect(replacement.isCurrent()).toBe(true);
    expect(server.viewInterestsForSpace(space).map((entry) => entry.view))
      .toEqual(views);
    replacement.release();
  });

  it("refuses nonempty view demand when the server does not advertise support", async () => {
    setServerExecutionConfig(false);
    const unsupported = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    try {
      const replica = unsupported.open(space).replica;
      expect(await replica.supportsViewReplication!()).toBe(false);
      const owner = replica.acquireViewInterests!(() => {});
      expect(await owner.set([interest("unsupported", owner.nextRevision())]))
        .toBe(false);
      expect(server.viewInterestsForSpace(space)).toEqual([]);
      owner.release();
    } finally {
      await unsupported.close();
    }
  });
});
