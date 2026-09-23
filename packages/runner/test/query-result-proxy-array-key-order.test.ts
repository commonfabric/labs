/**
 * A proxied array reports its own keys in the array's own order -- indices,
 * then `length`, then any other name -- because the `ownKeys` trap reports the
 * stored array's keys as they are. Own-key order is what distinguishes an
 * index-only array from one carrying named properties, and
 * `isArrayWithOnlyIndexProperties()` reads exactly that. The trap used to
 * supply a `length` of its own for an array-bound view over a value with none,
 * a state only reachable by rewriting the document to another kind; such a
 * view refuses now (`ViewDriftError`), so the stored array's keys are the
 * whole story.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isArrayWithOnlyIndexProperties } from "@commonfabric/utils/arrays";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("query result proxy array key order", () => {
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
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("reports a stored array's keys with `length` after the indices", () => {
    const cell = runtime.getCell<unknown[]>(
      space,
      "order-clean",
      undefined,
      tx,
    );
    cell.set(["a", "b"]);
    const proxy = createQueryResultProxy<unknown[]>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );

    expect(Reflect.ownKeys(proxy).map(String)).toEqual(["0", "1", "length"]);
    expect(isArrayWithOnlyIndexProperties(proxy)).toBe(true);
  });

  it("keeps `length` last as elements are added", () => {
    const cell = runtime.getCell<unknown[]>(
      space,
      "order-grows",
      undefined,
      tx,
    );
    cell.set(["a"]);
    const proxy = createQueryResultProxy<unknown[]>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
      0,
    );
    cell.set(["a", "b", "c"]);

    expect(Reflect.ownKeys(proxy).map(String)).toEqual([
      "0",
      "1",
      "2",
      "length",
    ]);
    expect(isArrayWithOnlyIndexProperties(proxy)).toBe(true);
  });
});
