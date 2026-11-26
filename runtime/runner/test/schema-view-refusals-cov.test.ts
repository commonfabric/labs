import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { Runtime } from "../src/runtime.ts";
import { UnresolvedInputError } from "../src/schema-view.ts";

const signer = await Identity.fromPassphrase("schema-view-refusals-cov");
const space = signer.did();

describe("schema-view", () => {
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

  describe("a property that declares a default over a union evaluated whole", () => {
    // Both branches are objects, so the value's type does not settle the
    // union, and the property's union is evaluated whole when it is read.
    const schema: JSONSchema = {
      type: "object",
      properties: {
        box: {
          anyOf: [
            {
              type: "object",
              properties: { n: { type: "number" } },
              required: ["n"],
            },
            {
              type: "object",
              properties: { m: { type: "string" } },
              required: ["m"],
            },
          ],
          default: { n: 7 },
        },
      },
    };

    it("refuses where the union meets a link to a document the replica lacks", async () => {
      const write = runtime.edit();
      const missing = runtime.getCell(
        space,
        "unserved-boxed",
        undefined,
        write,
      );
      runtime.getCell(space, "unserved-box", undefined, write).setRaw({
        box: { n: missing.getAsLink() },
      });
      await write.commit().settled;
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      try {
        const value = runtime.getCell<{ box: unknown }>(
          space,
          "unserved-box",
          schema,
          tx,
        ).get();
        expect(() => value.box).toThrow(UnresolvedInputError);
        expect(tx.takeSchemaRefusal()).toBeInstanceOf(UnresolvedInputError);
      } finally {
        await tx.commit().settled;
      }
    });

    it("returns the default where the union refuses the value it holds", async () => {
      const write = runtime.edit();
      runtime.getCell(space, "invalid-box", undefined, write).setRaw({
        box: { n: "seven" },
      });
      await write.commit().settled;
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      try {
        const value = runtime.getCell<{ box: { n: number } }>(
          space,
          "invalid-box",
          schema,
          tx,
        ).get();
        expect(value.box.n).toBe(7);
        expect(tx.takeSchemaRefusal()).toBeUndefined();
      } finally {
        await tx.commit().settled;
      }
    });
  });

  describe("an array view read after its transaction has committed", () => {
    const schema: JSONSchema = {
      type: "array",
      items: { type: ["number", "null"] },
    };

    /** Returns a view of `[1, 2]` whose transaction has committed. */
    async function committedView(
      cause: string,
    ): Promise<readonly (number | null)[]> {
      const write = runtime.edit();
      runtime.getCell(space, cause, undefined, write).setRaw([1, 2]);
      await write.commit().settled;
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      const value = runtime.getCell<(number | null)[]>(space, cause, schema, tx)
        .get();
      expect(value[1]).toBe(2);
      await tx.commit().settled;
      return value;
    }

    it("throws from an element where a substitute is allowed", async () => {
      // The items admit `null`, which a schema refusal would read as, so only
      // an error that is not a refusal passes through.
      const value = await committedView("committed-element");
      expect(() => value[0]).toThrow("Transaction is complete");
    });

    it("throws from a read-only array method", async () => {
      const value = await committedView("committed-method");
      expect(() => value.map((n) => n)).toThrow("Transaction is complete");
    });
  });
});
