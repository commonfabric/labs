import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { hashOf } from "@commonfabric/data-model";
import {
  entityRefToString,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createRef, entityIdFrom, getEntityId } from "../src/create-ref.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("hashOf", () => {
  it("should create a reference that is equal to another reference with the same source", () => {
    const ref = hashOf({ hello: "world" });
    const ref2 = hashOf({ hello: "world" });
    expect(ref.taggedHashString).toEqual(ref2.taggedHashString);
  });
});

describe("getEntityId (string forms)", () => {
  const tagged = hashOf({ test: "get-entity-id" }).taggedHashString;

  afterEach(() => {
    resetModernCellRepConfig();
  });

  for (const modernCellRep of [false, true]) {
    it(`reads a bare id string (modernCellRep=${modernCellRep})`, () => {
      setModernCellRepConfig(modernCellRep);
      expect(entityRefToString(getEntityId(tagged)!)).toBe(tagged);
    });

    it(`reads an \`of:\`-prefixed id string (modernCellRep=${modernCellRep})`, () => {
      setModernCellRepConfig(modernCellRep);
      expect(entityRefToString(getEntityId(`of:${tagged}`)!)).toBe(tagged);
    });
  }
});

describe("cell-map", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    // Create memory service for testing
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

  describe("createRef", () => {
    it("should create a reference with custom source and cause", () => {
      const source = { foo: "bar" };
      const cause = "custom-cause";
      const ref = createRef(source, cause);
      const ref2 = createRef(source);
      expect(ref.taggedHashString).not.toEqual(ref2.taggedHashString);
    });

    it("hashes FabricPrimitive values atomically (distinct values → distinct ids)", () => {
      // A FabricPrimitive has no enumerable own props, so it must be hashed
      // atomically via its codec rather than descended into. A fixed cause keeps
      // the id determined by the source rather than random.
      const a = createRef(
        { data: new FabricBytes(new Uint8Array([1, 2, 3])) },
        "c",
      );
      const b = createRef(
        { data: new FabricBytes(new Uint8Array([4, 5, 6])) },
        "c",
      );
      expect(a.taggedHashString).not.toEqual(b.taggedHashString);
    });

    it("treats a sigil link in the source as an atomic reference", () => {
      const link = (id: string) => ({
        "/": { [LINK_V1_TAG]: { id, path: [] } },
      });
      // Distinct links → distinct ids; the same link → a stable id.
      expect(createRef({ ref: link("of:fid1:aaa") }, "c").taggedHashString)
        .not.toEqual(
          createRef({ ref: link("of:fid1:bbb") }, "c").taggedHashString,
        );
      expect(createRef({ ref: link("of:fid1:aaa") }, "c").taggedHashString)
        .toEqual(createRef({ ref: link("of:fid1:aaa") }, "c").taggedHashString);
    });

    it("distinguishes `null` from `undefined` in the source", () => {
      const id = (x: unknown) => createRef({ x }, "c").taggedHashString;
      expect(id(null)).not.toEqual(id(undefined));
      expect(id([null])).not.toEqual(id([undefined]));
      expect(id({ y: null })).not.toEqual(id({ y: undefined }));
    });
  });

  describe("getEntityId", () => {
    it("should return undefined for non-cell values", () => {
      expect(getEntityId({})).toBeUndefined();
      expect(getEntityId(null)).toBeUndefined();
      expect(getEntityId(42)).toBeUndefined();
    });

    it("should return the entity ID for a cell", () => {
      const cell = runtime.getCell(space, "test-cell", undefined, tx);
      cell.set({});
      const id = getEntityId(cell);

      expect(getEntityId(cell)).toEqual(id);
      expect(getEntityId(cell.getAsQueryResult())).toEqual(id);
      expect(getEntityId(cell.getAsLink())).toEqual(id);
    });

    it("should return a different entity ID for reference with paths", () => {
      const c = runtime.getCell<{ foo: { bar: number } }>(
        space,
        "test-with-paths",
        undefined,
        tx,
      );
      c.set({ foo: { bar: 42 } });
      const id = getEntityId(c);

      expect(getEntityId(c.getAsQueryResult())).toEqual(id);
      expect(getEntityId(c.getAsQueryResult(["foo"]))).not.toEqual(id);
      expect(getEntityId(c.key("foo"))).not.toEqual(id);
      expect(getEntityId(c.key("foo").getAsLink())).not.toEqual(id);

      expect(getEntityId(c.getAsQueryResult(["foo"]))).toEqual(
        getEntityId(c.key("foo")),
      );
      expect(getEntityId(c.getAsQueryResult(["foo"]))).toEqual(
        getEntityId(c.key("foo").getAsLink()),
      );
    });
  });

  describe("getCellByEntityId and setCellByEntityId", () => {
    it("should set and get a cell by entity ID", () => {
      const c = runtime.getCell<{ value: number }>(
        space,
        "test-by-entity-id",
        undefined,
        tx,
      );
      c.set({ value: 42 });
      tx.commit();

      // Use Cell API to retrieve by entity ID
      const retrievedCell = runtime.getCellFromEntityId<{ value: number }>(
        space,
        entityIdFrom(entityRefToString(c.entityId)),
      );

      // Verify we got the same cell
      expect(retrievedCell.entityId).toEqual(c.entityId);
      expect(retrievedCell.get()).toEqual({ value: 42 });

      // Also verify the cells are equal
      expect(retrievedCell.equals(c)).toBe(true);
    });
  });
});
