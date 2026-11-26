import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  runBeforeAbort,
  TransactionWrapper,
} from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("before-abort-cov");

/** How many before-abort callbacks have thrown in this process. */
const throwingCallbacks = (): number => {
  const counts = getLoggerCountsBreakdown()["extended-storage-transaction"];
  return typeof counts === "object" ? counts["before-abort"]?.total ?? 0 : 0;
};

describe("runBeforeAbort()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("registers the callback on the transaction a wrapper wraps", () => {
    const inner = runtime.edit();
    const wrapper = new TransactionWrapper(inner, { childCellTx: inner });
    const seen: string[] = [];
    runBeforeAbort(wrapper, () => seen.push(inner.status().status));
    wrapper.abort();

    expect(seen).toEqual(["ready"]);
  });

  it("throws for a transaction the runtime did not create", () => {
    const inner = runtime.edit();
    const foreign = new Proxy(inner, {}) as IExtendedStorageTransaction;

    expect(() => runBeforeAbort(foreign, () => {})).toThrow(
      "runBeforeAbort() requires a transaction the runtime created",
    );
    inner.abort();
  });

  it("logs a callback that throws, and aborts the transaction all the same", () => {
    const tx = runtime.edit();
    const before = throwingCallbacks();
    runBeforeAbort(tx, () => {
      throw new Error("callback failed");
    });

    expect(tx.abort().error).toBeUndefined();
    expect(tx.status().status).not.toBe("ready");
    expect(throwingCallbacks()).toBe(before + 1);
  });

  it("logs nothing for a callback that returns", () => {
    const tx = runtime.edit();
    const before = throwingCallbacks();
    runBeforeAbort(tx, () => {});

    expect(tx.abort().error).toBeUndefined();
    expect(throwingCallbacks()).toBe(before);
  });
});
