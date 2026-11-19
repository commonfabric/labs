import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import {
  type Cell,
  recordRelevantSchemaWritePolicyInput,
} from "../src/cell.ts";
import { setCfcImplementationIdentity } from "../src/cfc/trust-authority.ts";
import { diffAndUpdate } from "../src/data-updating.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runner-cfc-array-member-writes");
const space = signer.did();

/** A clause any reader in the space satisfies, so reads see every value. */
const CLAUSE = {
  anyOf: ["input:items", { type: CFC_ATOM_TYPE.Space, id: space }],
};

const ITEMS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      subItems: {
        type: "array",
        items: {
          type: "object",
          properties: { count: { type: "number" } },
        },
      },
    },
  },
  ifc: { confidentiality: [CLAUSE] },
} as JSONSchema;

/** The builtin a claim on the items names. */
const WRITER = "cfc-array-member-writes-writer";

const ITEMS = [
  { name: "a", subItems: [{ count: 0 }] },
  { name: "b", subItems: [{ count: 0 }, { count: 1 }] },
];

describe("cfc-array-member-writes", () => {
  // A labeled document whose array holds its records in place, as a lift's
  // result is written, and an ordinary cell write somewhere inside it. The
  // schema a write answers to is placed at the write's path against the
  // schema the document stores: an index where that schema declares an array
  // is an item of the array, and a numeric key of a record is a property.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
    });
  });
  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Writes `value` at `name`'s root in place, with no record anchored, as
   * the builtin {@link WRITER}.
   */
  const createInPlace = async <T extends FabricValue>(
    name: string,
    schema: JSONSchema,
    value: T,
  ): Promise<Cell<T>> => {
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, { kind: "builtin", builtinId: WRITER });
    const cell = runtime.getCell<T>(space, { name }, schema, tx);
    const link = cell.getAsNormalizedFullLink();
    recordRelevantSchemaWritePolicyInput(tx, link, schema);
    diffAndUpdate(runtime, tx, link, value);
    expect((await tx.commit().settled).error).toBeUndefined();
    return cell;
  };

  /** Commits `write` and returns the commit's error, if any. */
  const commit = async (write: (tx: IExtendedStorageTransaction) => void) => {
    const tx = runtime.edit();
    write(tx);
    return (await tx.commit().settled).error;
  };

  describe("below an index of an array of records", () => {
    it("commits a number written in a record below two indexes", async () => {
      const cell = await createInPlace("number", ITEMS_SCHEMA, ITEMS);

      const error = await commit((tx) =>
        cell.withTx(tx).key(1).key("subItems").key(1).key("count").set(6)
      );

      expect(error).toBeUndefined();
      expect(cell.get()[1].subItems[1].count).toBe(6);
    });

    it("commits a record written at an index below another index", async () => {
      const cell = await createInPlace("record", ITEMS_SCHEMA, ITEMS);

      const error = await commit((tx) =>
        cell.withTx(tx).key(1).key("subItems").key(1).set({ count: 7 })
      );

      expect(error).toBeUndefined();
      expect(cell.get()[1].subItems).toEqual([{ count: 0 }, { count: 7 }]);
    });

    it("commits a string written in a record at an index", async () => {
      const cell = await createInPlace("string", ITEMS_SCHEMA, ITEMS);

      const error = await commit((tx) =>
        cell.withTx(tx).key(1).key("name").set("c")
      );

      expect(error).toBeUndefined();
      expect(cell.get()[1].name).toBe("c");
    });
  });

  describe("at an index with nothing named below it", () => {
    it("commits a string written at an index of an array of strings", async () => {
      const cell = await createInPlace(
        "strings",
        {
          type: "array",
          items: { type: "string" },
          ifc: { confidentiality: [CLAUSE] },
        } as JSONSchema,
        ["a", "b"],
      );

      const error = await commit((tx) => cell.withTx(tx).key(1).set("c"));

      expect(error).toBeUndefined();
      expect(cell.get()).toEqual(["a", "c"]);
    });

    it("commits an item written at an index of an array inside a record", async () => {
      const cell = await createInPlace(
        "member",
        {
          type: "object",
          properties: {
            tags: { type: "array", items: { type: "string" } },
          },
          ifc: { confidentiality: [CLAUSE] },
        } as JSONSchema,
        { tags: ["a", "b"] },
      );

      const error = await commit((tx) =>
        cell.withTx(tx).key("tags").key(1).set("c")
      );

      expect(error).toBeUndefined();
      expect(cell.get()).toEqual({ tags: ["a", "c"] });
    });
  });

  describe("through the other writes of a cell", () => {
    it("commits a record pushed onto an array below an index", async () => {
      const cell = await createInPlace("push", ITEMS_SCHEMA, ITEMS);

      const error = await commit((tx) =>
        cell.withTx(tx).key(1).key("subItems").push({ count: 9 })
      );

      expect(error).toBeUndefined();
      expect(cell.get()[1].subItems.map(({ count }) => count)).toEqual([
        0,
        1,
        9,
      ]);
    });

    it("commits a record updated at an index", async () => {
      const cell = await createInPlace("update", ITEMS_SCHEMA, ITEMS);

      const error = await commit((tx) =>
        cell.withTx(tx).key(1).update({ name: "c" })
      );

      expect(error).toBeUndefined();
      expect(cell.get()[1].name).toBe("c");
    });
  });

  describe("below an index of an array a reference names", () => {
    it("commits a string written in a record at an index", async () => {
      const cell = await createInPlace(
        "reference",
        {
          type: "object",
          properties: { list: { $ref: "#/$defs/List" } },
          $defs: {
            List: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
          ifc: { confidentiality: [CLAUSE] },
        } as JSONSchema,
        { list: [{ name: "a" }, { name: "b" }] },
      );

      const error = await commit((tx) =>
        cell.withTx(tx).key("list").key(1).key("name").set("c")
      );

      expect(error).toBeUndefined();
      expect(cell.get()).toEqual({ list: [{ name: "a" }, { name: "c" }] });
    });
  });

  describe("under a claim on a member of the items", () => {
    const claimed = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", ifc: { writeAuthorizedBy: [WRITER] } },
        },
      },
      ifc: { confidentiality: [CLAUSE] },
    } as JSONSchema;

    it("commits the claimed writer's string in a record at an index", async () => {
      const cell = await createInPlace("claimed-writer", claimed, [
        { name: "a" },
        { name: "b" },
      ]);

      const error = await commit((tx) => {
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: WRITER,
        });
        cell.withTx(tx).key(1).key("name").set("c");
      });

      expect(error).toBeUndefined();
      expect(cell.get()).toEqual([{ name: "a" }, { name: "c" }]);
    });

    it("refuses another writer's string in a record at an index by the claim", async () => {
      const cell = await createInPlace("claimed-other", claimed, [
        { name: "a" },
        { name: "b" },
      ]);

      const error = await commit((tx) => {
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: "cfc-array-member-writes-other",
        });
        cell.withTx(tx).key(1).key("name").set("c");
      });

      expect(error).toMatchObject({
        name: "CfcCommitRefusalError",
        reasons: [expect.stringMatching(/^writeAuthorizedBy /)],
      });
      expect(cell.get()).toEqual([{ name: "a" }, { name: "b" }]);
    });
  });

  describe("below a numeric property name of a record", () => {
    it("commits a string written in a record a numeric key names", async () => {
      const cell = await createInPlace(
        "numeric",
        {
          type: "object",
          properties: {
            "1": {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
          ifc: { confidentiality: [CLAUSE] },
        } as JSONSchema,
        { "1": { name: "a" } },
      );

      const error = await commit((tx) =>
        cell.withTx(tx).key("1").key("name").set("c")
      );

      expect(error).toBeUndefined();
      expect(cell.get()).toEqual({ "1": { name: "c" } });
    });
  });
});
