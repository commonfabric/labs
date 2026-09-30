import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { snapshotQueryResult } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("query-result-proxy-snapshot");
const space = signer.did();

describe("snapshotQueryResult()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Returns a view of `value`, stored in a document of its own. */
  async function viewOf(value: FabricValue, cause: string): Promise<unknown> {
    const tx = runtime.edit();
    const cell = runtime.getCell<unknown>(space, cause, undefined, tx);
    tx.writeValueOrThrow(cell.getAsNormalizedFullLink(), { value });
    expect((await tx.commit()).error).toBeUndefined();
    return (cell.get() as { value: unknown }).value;
  }

  it("keeps a hole in an array a hole", () => {
    const snapshot = snapshotQueryResult([, "held"]);

    expect(snapshot.length).toBe(2);
    expect(Object.hasOwn(snapshot, 0)).toBe(false);
    expect(snapshot[1]).toBe("held");
  });

  it("keeps a hole in a viewed array a hole", async () => {
    const snapshot = snapshotQueryResult(
      await viewOf([, "held"], "viewed-hole"),
    ) as unknown[];

    expect(snapshot.length).toBe(2);
    expect(Object.hasOwn(snapshot, 0)).toBe(false);
    expect(snapshot[1]).toBe("held");
  });

  it("keeps an element holding `undefined` an element", async () => {
    const snapshot = snapshotQueryResult(
      await viewOf([undefined], "viewed-undefined"),
    ) as unknown[];

    expect(snapshot.length).toBe(1);
    expect(Object.hasOwn(snapshot, 0)).toBe(true);
  });
});
