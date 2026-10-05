/**
 * A `FabricPrimitive` (byte sequence, temporal value, hash, ...) is an
 * immutable leaf. The query-result proxy must hand it back raw rather than
 * wrapping it in a live proxy: a wrapped primitive leaks the proxy into any
 * consumer that deep-clones or freezes the surrounding value -- notably schema
 * interning, which deep-freezes its argument and trips the proxy's
 * structural-mutation guard.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { FabricPrimitive } from "@commonfabric/data-model";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { internCellLinkSchema } from "../src/cell.ts";
import { isCellResultForDereferencing } from "../src/query-result-proxy.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test proxy fabric primitive");
const space = signer.did();

describe("query-result proxy: FabricPrimitive leaves are not proxy-wrapped", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
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

  it("returns a FabricBytes leaf raw, not as a cell-result proxy", () => {
    const cell = runtime.getCell(space, "bytesCell", undefined, tx);
    cell.set({ bytes: new Uint8Array([1, 2, 3, 4]) });
    const leaf = (cell.getAsQueryResult() as Record<string, unknown>).bytes;
    expect(isCellResultForDereferencing(leaf)).toBe(false);
    expect(leaf instanceof FabricPrimitive).toBe(true);
  });

  it("returns a temporal (Date -> FabricEpochNsec) leaf raw", () => {
    const cell = runtime.getCell(space, "dateCell", undefined, tx);
    cell.set({ when: new Date(0) });
    const leaf = (cell.getAsQueryResult() as Record<string, unknown>).when;
    expect(isCellResultForDereferencing(leaf)).toBe(false);
    expect(leaf instanceof FabricPrimitive).toBe(true);
  });
});

describe("internCellLinkSchema preserves FabricValue schema defaults read through a proxy", () => {
  // End-to-end: a schema whose `default` carries a non-JSON FabricValue, read
  // through a query-result proxy, must intern without throwing AND without
  // losing the value to a JSON shadow.

  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
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

  it("preserves a FabricBytes default (no throw, no JSON-mangling)", () => {
    const cell = runtime.getCell(space, "schemaBytes", undefined, tx);
    cell.set({ type: "object", default: { bytes: new Uint8Array([5, 6, 7]) } });
    const proxySchema = cell.getAsQueryResult();
    const interned = internCellLinkSchema(proxySchema as never) as {
      default: { bytes: unknown };
    };
    expect(interned.default.bytes instanceof FabricPrimitive).toBe(true);
  });

  it("preserves a temporal default (no throw, no JSON-mangling)", () => {
    const cell = runtime.getCell(space, "schemaDate", undefined, tx);
    cell.set({ type: "object", default: { when: new Date(0) } });
    const proxySchema = cell.getAsQueryResult();
    const interned = internCellLinkSchema(proxySchema as never) as {
      default: { when: unknown };
    };
    expect(interned.default.when instanceof FabricPrimitive).toBe(true);
  });
});
