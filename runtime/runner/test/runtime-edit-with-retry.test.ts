import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { setCell } from "../src/cell.ts";
import { DEFAULT_MAX_RETRIES, Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("Runtime.editWithRetry", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("commits successfully without retry", async () => {
    const cell = runtime.getCell<number>(
      space,
      "editWithRetry-success",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;

    const { ok, error } = await runtime.editWithRetry((t) => {
      cell.withTx(t).send(1);
      return true;
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(cell.get()).toBe(1);
  });

  it("retries commit failures and eventually succeeds", async () => {
    // Prepare a cell and commit initial value
    const cell = runtime.getCell<number>(
      space,
      "editWithRetry-retry-succeed",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;

    // Track attempts and force early aborts to trigger retry
    let attempts = 0;
    const { ok, error } = await runtime.editWithRetry((t) => {
      attempts++;
      // Abort the first few attempts to force retry
      if (attempts <= 2) {
        t.abort("force-abort-for-retry");
        return;
      }
      cell.withTx(t).send(2);
      return attempts;
    }, 5);

    expect(attempts).toBe(3); // initial + 2 retries
    expect(ok).toBe(3);
    expect(error).toBeUndefined();
    expect(cell.get()).toBe(2);
  });

  it("returns false after exhausting retries", async () => {
    const cell = runtime.getCell<number>(
      space,
      "editWithRetry-retry-fail",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;

    let attempts = 0;
    const max = 3;
    const { error } = await runtime.editWithRetry((t) => {
      attempts++;
      t.abort("always-fail");
    }, max);

    expect(error).toBeDefined();
    // initial + max retries
    expect(attempts).toBe(max + 1);
    // Value unchanged
    expect(cell.get()).toBe(0);
  });

  it("uses DEFAULT_MAX_RETRIES when not provided", async () => {
    const cell = runtime.getCell<number>(
      space,
      "editWithRetry-default-retries",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;

    let attempts = 0;
    const { error } = await runtime.editWithRetry((t) => {
      attempts++;
      t.abort("always-fail");
    });

    expect(error).toBeDefined();
    expect(attempts).toBe(DEFAULT_MAX_RETRIES + 1);
    expect(cell.get()).toBe(0);
  });

  it("prepares relevant transactions before committing", async () => {
    let committedTx: IExtendedStorageTransaction | undefined;
    const { ok, error } = await runtime.editWithRetry((t) => {
      committedTx = t;
      const cell = runtime.getCell(
        space,
        "editWithRetry-cfc-prepare",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        t,
      );
      cell.set({ secret: "value" });
      return true;
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(committedTx?.getCfcState().prepare.status).toBe("prepared");
  });

  it("recomputes prepare on each retry with fresh transactions", async () => {
    const attempts: IExtendedStorageTransaction[] = [];
    const { ok, error } = await runtime.editWithRetry((t) => {
      attempts.push(t);
      const cell = runtime.getCell(
        space,
        "editWithRetry-cfc-retry",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        t,
      );
      if (attempts.length === 1) {
        t.abort("force retry");
        return false;
      }
      cell.set({ secret: "value" });
      return true;
    }, 2);

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(attempts.length).toBe(2);
    expect(attempts[0]).not.toBe(attempts[1]);
    expect(attempts[0].getCfcState().prepare.status).not.toBe("prepared");
    expect(attempts[1].getCfcState().prepare.status).toBe("prepared");
  });

  it("recomputes trust snapshots on each retry with fresh transactions", async () => {
    await runtime.dispose();
    await storageManager.close();

    let snapshotCalls = 0;
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      trustSnapshotProvider: () => ({
        id: `trust-${++snapshotCalls}`,
        actingPrincipal: signer.did(),
        revision: `rev-${snapshotCalls}`,
      }),
    });

    const snapshots: string[] = [];
    let attempts = 0;
    const { ok, error } = await runtime.editWithRetry((t) => {
      attempts++;
      snapshots.push(t.getCfcState().trustSnapshot?.id ?? "");
      const cell = runtime.getCell(
        space,
        "editWithRetry-trust-snapshot",
        {
          type: "object",
          properties: {
            secret: {
              type: "string",
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["secret"],
        },
        t,
      );
      if (attempts === 1) {
        t.abort("force retry");
        return false;
      }
      cell.set({ secret: "value" });
      return true;
    }, 2);

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(attempts).toBe(2);
    expect(snapshotCalls).toBe(2);
    expect(snapshots).toEqual(["trust-1", "trust-2"]);
  });

  it("fires success callbacks once after the winning retry commit", async () => {
    const cell = runtime.getCell<number>(
      space,
      "editWithRetry-oncommit-once",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit().settled;
    tx = runtime.edit();

    const statuses: string[] = [];
    let attempts = 0;
    const { ok, error } = await runtime.editWithRetry((t) => {
      attempts++;
      if (attempts === 1) {
        t.abort("force retry");
        return false;
      }
      setCell(cell.withTx(t), 1, (committedTx) => {
        statuses.push(committedTx.status().status);
      });
      return true;
    }, 2);

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(attempts).toBe(2);
    expect(statuses).toEqual(["done"]);
    expect(cell.get()).toBe(1);
  });
});
