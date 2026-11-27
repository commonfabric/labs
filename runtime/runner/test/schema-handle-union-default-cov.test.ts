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

import { isCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("schema-handle-union-default-cov");
const space = signer.did();

describe("schema", () => {
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

  describe("a read at a union whose every option is a handle", () => {
    // Every option declares a handle, so the union is one, and a read rooted at
    // it takes the handle path rather than traversing the value.
    const handleUnion = {
      anyOf: [
        { type: "object", asCell: ["cell"] },
        { type: "number", asCell: ["cell"] },
      ],
    } as const satisfies JSONSchema;

    /** Reads the absent `slot` of a stored empty record through `schema`. */
    async function readAbsentSlot(cause: string, schema: JSONSchema) {
      const write = runtime.edit();
      runtime.getCell(space, cause, undefined, write).setRaw({});
      await write.commit().settled;
      return runtime.getCell<Record<string, unknown>>(space, cause)
        .key("slot").asSchema(schema).get();
    }

    it("returns the declared default for an absent value", async () => {
      const value = await readAbsentSlot("absent-with-default", {
        ...handleUnion,
        default: 5,
      });
      expect(isCell(value)).toBe(false);
      expect(value).toBe(5);
    });

    it("returns `undefined` for an absent value where no default is declared", async () => {
      const value = await readAbsentSlot("absent-without-default", handleUnion);
      expect(value).toBeUndefined();
    });
  });
});
