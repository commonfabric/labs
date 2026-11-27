/**
 * A union read over a value whose type names no schema type: a registry symbol
 * is a stored value, but no `type` keyword accepts it, so its type selects no
 * branch of an `anyOf` and the union is decided whole.
 */

import { expect } from "@std/expect";

import type { JSONSchema } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { snapshotQueryResult } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("schema-symbol-value");
const space = signer.did();

const stringOrNumber: JSONSchema = {
  anyOf: [{ type: "string" }, { type: "number" }],
};

describe("schema", () => {
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

  /** Stores `value` raw under `id`, then reads it through `schema`. */
  const readThrough = async (
    id: string,
    value: FabricValue,
    schema: JSONSchema,
    lazy: boolean,
  ): Promise<unknown> => {
    const write = runtime.edit();
    runtime.getCell(space, id, undefined, write).setRaw(value);
    await write.commit().settled;
    const tx = runtime.edit();
    tx.markLazyMaterialize(lazy);
    try {
      const read = runtime.getCell(space, id, schema, tx).get();
      expect(tx.takeSchemaRefusal()).toBeUndefined();
      return snapshotQueryResult(read);
    } finally {
      await tx.commit().settled;
    }
  };

  describe("a union read over a registry symbol", () => {
    for (const lazy of [false, true]) {
      const mode = lazy ? "lazily" : "eagerly";

      it(`returns \`undefined\` ${mode}, since no branch's type accepts it`, async () => {
        expect(
          await readThrough(
            `symbol-${mode}`,
            Symbol.for("schema-symbol-value"),
            stringOrNumber,
            lazy,
          ),
        ).toBeUndefined();
      });

      it(`returns the value ${mode} where a branch's type accepts it`, async () => {
        expect(
          await readThrough(`string-${mode}`, "glaze", stringOrNumber, lazy),
        ).toBe("glaze");
      });
    }
  });
});
