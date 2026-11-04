/**
 * `addUnique` and `removeByValue` match a plain (non-cell) argument against the
 * stored elements by content. These cases pin what "same content" means for the
 * values an own-property walk gets wrong: a `FabricSpecialObject` keeps its
 * state in private `#fields`, and the weird numbers whose identity `===` does
 * not capture.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("collection-write-value-equality");
const space = signer.did();

const bytesListSchema = {
  type: "array",
  items: { type: "object", properties: {} },
} as const satisfies JSONSchema;

const numberListSchema = {
  type: "array",
  items: { type: "number" },
} as const satisfies JSONSchema;

function withSeeded<T>(
  cause: string,
  schema: JSONSchema,
  seed: T[],
  run: (rt: Runtime) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const tx = rt.edit();
      rt.getCell<T[]>(space, cause, schema, tx).set(seed);
      await tx.commit().settled;
      await run(rt);
    } finally {
      await rt.dispose();
      await storage.close();
    }
  };
}

describe("collection writes compare plain values by content", () => {
  it(
    "addUnique keeps a FabricBytes with different bytes",
    withSeeded("bytes-distinct", bytesListSchema, [
      new FabricBytes(new Uint8Array([1, 2, 3])),
    ], async (rt) => {
      const tx = rt.edit();
      rt.getCell<FabricBytes[]>(space, "bytes-distinct", bytesListSchema, tx)
        .addUnique(new FabricBytes(new Uint8Array([9, 9, 9])));
      await tx.commit().settled;

      const after = rt.getCell<FabricBytes[]>(
        space,
        "bytes-distinct",
        bytesListSchema,
      ).get();
      expect(after.length).toBe(2);
      expect(after[1]).toEqual(new FabricBytes(new Uint8Array([9, 9, 9])));
    }),
  );

  it(
    "addUnique dedups a FabricBytes with the same bytes",
    withSeeded("bytes-same", bytesListSchema, [
      new FabricBytes(new Uint8Array([1, 2, 3])),
    ], async (rt) => {
      const tx = rt.edit();
      rt.getCell<FabricBytes[]>(space, "bytes-same", bytesListSchema, tx)
        .addUnique(new FabricBytes(new Uint8Array([1, 2, 3])));
      await tx.commit().settled;

      const after = rt.getCell<FabricBytes[]>(
        space,
        "bytes-same",
        bytesListSchema,
      ).get();
      expect(after.length).toBe(1);
    }),
  );

  it(
    "removeByValue removes only the FabricBytes it matches",
    withSeeded("bytes-remove", bytesListSchema, [
      new FabricBytes(new Uint8Array([1, 2, 3])),
      new FabricBytes(new Uint8Array([9, 9, 9])),
    ], async (rt) => {
      const tx = rt.edit();
      rt.getCell<FabricBytes[]>(space, "bytes-remove", bytesListSchema, tx)
        .removeByValue(new FabricBytes(new Uint8Array([1, 2, 3])));
      await tx.commit().settled;

      const after = rt.getCell<FabricBytes[]>(
        space,
        "bytes-remove",
        bytesListSchema,
      ).get();
      expect(after).toEqual([new FabricBytes(new Uint8Array([9, 9, 9]))]);
    }),
  );

  it(
    "NaN is the same value as NaN",
    withSeeded("nan", numberListSchema, [NaN], async (rt) => {
      const tx = rt.edit();
      rt.getCell<number[]>(space, "nan", numberListSchema, tx).addUnique(NaN);
      await tx.commit().settled;

      const added = rt.getCell<number[]>(space, "nan", numberListSchema).get();
      expect(added.length).toBe(1);

      const tx2 = rt.edit();
      rt.getCell<number[]>(space, "nan", numberListSchema, tx2)
        .removeByValue(NaN);
      await tx2.commit().settled;

      const after = rt.getCell<number[]>(space, "nan", numberListSchema).get();
      expect(after).toEqual([]);
    }),
  );

  it(
    "-0 and +0 are different values",
    withSeeded("signed-zero", numberListSchema, [-0], async (rt) => {
      const tx = rt.edit();
      rt.getCell<number[]>(space, "signed-zero", numberListSchema, tx)
        .addUnique(+0);
      await tx.commit().settled;

      const added = rt.getCell<number[]>(space, "signed-zero", numberListSchema)
        .get();
      expect(added.length).toBe(2);
      expect(Object.is(added[0], -0)).toBe(true);
      expect(Object.is(added[1], +0)).toBe(true);

      const tx2 = rt.edit();
      rt.getCell<number[]>(space, "signed-zero", numberListSchema, tx2)
        .removeByValue(+0);
      await tx2.commit().settled;

      const after = rt.getCell<number[]>(space, "signed-zero", numberListSchema)
        .get();
      expect(after.length).toBe(1);
      expect(Object.is(after[0], -0)).toBe(true);
    }),
  );
});
