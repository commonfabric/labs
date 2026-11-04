import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import type { CfcAddress } from "../src/cfc/mod.ts";

const signer = await Identity.fromPassphrase("runner-cfc-structure-container");
const space = signer.did();

describe("CFC structure-container declaration (tx plumbing)", () => {
  // Unit coverage for the structure-container declaration seam (S16): list
  // coordinators (filter/flatMap) declare their result container so prepare
  // re-derives its `structure` label from J every reconcile. The end-to-end
  // behavior is in cfc-flow-pointwise.test.ts; this pins the tx plumbing.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const addr = (id: string): CfcAddress => ({
    space,
    id,
    scope: "space",
    path: [],
  });

  it("records declared structure containers on the tx state", () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcFlowLabels: "persist",
    });
    const tx = runtime.edit();
    tx.recordCfcStructureContainer(addr("of:fid1:container-a"));
    tx.recordCfcStructureContainer(addr("of:fid1:container-b"));
    const recorded = tx.getCfcState().structureContainers;
    expect(recorded.length).toBe(2);
    expect(recorded[0].id).toBe("of:fid1:container-a");
    // frozen on entry (owned by the tx, identity-stable)
    expect(Object.isFrozen(recorded[0])).toBe(true);
  });

  it("invalidates a prepared digest when recorded after prepare", () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcFlowLabels: "persist",
    });
    const tx = runtime.edit();
    tx.prepareCfc();
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    tx.recordCfcStructureContainer(addr("of:fid1:late-container"));
    expect(tx.getCfcState().prepare.status).toBe("invalidated");
  });

  it("clears declared structure containers on abort", () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcFlowLabels: "persist",
    });
    const tx = runtime.edit();
    tx.recordCfcStructureContainer(addr("of:fid1:container-c"));
    expect(tx.getCfcState().structureContainers.length).toBe(1);
    tx.abort();
    expect(tx.getCfcState().structureContainers.length).toBe(0);
  });

  it("TransactionWrapper delegates recordCfcStructureContainer to the wrapped tx", () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcFlowLabels: "persist",
    });
    const inner = runtime.edit();
    const wrapper = new TransactionWrapper(inner);
    wrapper.recordCfcStructureContainer(addr("of:fid1:wrapped-container"));
    const recorded = inner.getCfcState().structureContainers;
    expect(recorded.length).toBe(1);
    expect(recorded[0].id).toBe("of:fid1:wrapped-container");
  });
});
