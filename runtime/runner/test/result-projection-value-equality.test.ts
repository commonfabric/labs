/**
 * Setting up a pattern over a result cell that already holds a projection
 * writes only when the projection differs from what is stored. A result whose
 * only difference is inside a `FabricPrimitive` is a difference: those keep
 * their state in private `#fields`, so a comparison that walks enumerable own
 * properties sees two distinct values as identical and drops the write.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { Pattern } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "result-projection-value-equality",
);
const space = signer.did();

function patternWithBytes(bytes: number[]): Pattern {
  return {
    argumentSchema: { type: "object", properties: {} } as const,
    resultSchema: undefined,
    result: { data: new FabricBytes(new Uint8Array(bytes)) },
    nodes: [],
  } as unknown as Pattern;
}

function storedBytes(runtime: Runtime, cause: string): number[] {
  const raw = runtime.getCell(space, cause, undefined).getRaw() as {
    data: FabricBytes;
  };
  return [...raw.data.slice()];
}

describe("result projection", () => {
  it("re-projects when only the bytes of a result value change", async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const tx = runtime.edit();
      runtime.run(
        tx,
        patternWithBytes([1, 2, 3]),
        {},
        runtime.getCell(space, "bytes-result", undefined, tx),
      );
      await tx.commit().settled;
      expect(storedBytes(runtime, "bytes-result")).toEqual([1, 2, 3]);

      const tx2 = runtime.edit();
      runtime.run(
        tx2,
        patternWithBytes([9, 9, 9]),
        {},
        runtime.getCell(space, "bytes-result", undefined, tx2),
      );
      await tx2.commit().settled;
      expect(storedBytes(runtime, "bytes-result")).toEqual([9, 9, 9]);
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  it("compares the projection in the representation it stores", async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    // A result value that only becomes a `FabricValue` once converted: raw, it
    // is unhashable, so comparing the projection before converting it throws
    // (`` `hashOf()`: unsupported object type ``) instead of deciding
    // anything. The two setups differ, so the second one reaches the
    // comparison.
    const patternTagged = (tag: number) =>
      ({
        argumentSchema: { type: "object", properties: {} } as const,
        resultSchema: undefined,
        result: { tag, when: new Date("2020-01-01T00:00:00.000Z") },
        nodes: [],
      }) as unknown as Pattern;

    try {
      const tx = runtime.edit();
      runtime.run(
        tx,
        patternTagged(1),
        {},
        runtime.getCell(space, "native-result", undefined, tx),
      );
      await tx.commit().settled;

      const tx2 = runtime.edit();
      runtime.run(
        tx2,
        patternTagged(2),
        {},
        runtime.getCell(space, "native-result", undefined, tx2),
      );
      await tx2.commit().settled;

      const raw = runtime.getCell(space, "native-result", undefined)
        .getRaw() as { tag: number; when: unknown };
      expect(raw.tag).toBe(2);
      expect(raw.when).toBeInstanceOf(FabricEpochNsec);
      expect((raw.when as FabricEpochNsec).value).toBe(1577836800000000000n);
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
});
