import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONValue } from "@commonfabric/api";
import { deepFreeze } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import { createRef } from "../src/create-ref.ts";
import { DerivedInternalCellIds } from "../src/derived-internal-cell-ids.ts";
import { getDerivedInternalCellLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("derived-internal-cell-ids");
const space = signer.did();

describe("derived-internal-cell-ids", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let first: Cell<unknown>;
  let second: Cell<unknown>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    first = runtime.getCell(space, "derived-internal-cell-ids first");
    second = runtime.getCell(space, "derived-internal-cell-ids second");
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** An instance, and the count of ids it has hashed. */
  function counted(capacity?: number): {
    ids: DerivedInternalCellIds;
    mints: () => number;
  } {
    const ids = new DerivedInternalCellIds(capacity);
    let mints = 0;
    ids.accessForTestingOnly.mintRecorder = () => {
      mints += 1;
    };
    return { ids, mints: () => mints };
  }

  /** The id `createRef` derives for `partialCause` on `cell`. */
  function derived(cell: Cell<unknown>, partialCause: JSONValue): string {
    return createRef({}, {
      parent: cell.entityId,
      type: "internal",
      cause: partialCause,
    }).toString();
  }

  describe("idFor()", () => {
    describe("returns the id derived from the result cell's entity and the partial cause", () => {
      const causes: [string, JSONValue][] = [
        ["a string", "count"],
        ["a number", 3],
        ["a boolean", true],
        ["`null`", null],
        ["an object", deepFreeze({ $generated: 2 })],
        ["an array", deepFreeze(["a", 1])],
      ];
      for (const [kind, partialCause] of causes) {
        it(`returns it for a partial cause that is ${kind}`, () => {
          const { ids } = counted();

          expect(ids.idFor(first, partialCause).toString()).toBe(
            derived(first, partialCause),
          );
          // The second read is the one the instance kept.
          expect(ids.idFor(first, partialCause).toString()).toBe(
            derived(first, partialCause),
          );
        });
      }
    });

    it("hashes an id once for one result cell and one deep-frozen partial cause", () => {
      const { ids, mints } = counted();
      const partialCause = Object.freeze({ $generated: 1 });
      ids.idFor(first, partialCause);
      ids.idFor(first, partialCause);
      ids.idFor(first.withTx(runtime.readTx()), partialCause);

      expect(mints()).toBe(1);
    });

    it("hashes an id once for a partial cause equal by value", () => {
      const { ids, mints } = counted();
      ids.idFor(first, "count");
      ids.idFor(first, "count");
      ids.idFor(first, 7);
      ids.idFor(first, 7);

      expect(mints()).toBe(2);
    });

    it('returns ids that differ for `1`, `"1"` and `true`', () => {
      const { ids, mints } = counted();
      const found = new Set([
        ids.idFor(first, 1).toString(),
        ids.idFor(first, "1").toString(),
        ids.idFor(first, true).toString(),
      ]);

      expect(found.size).toBe(3);
      expect(mints()).toBe(3);
    });

    it("returns the id of `0` and the id of `-0`, each as derived", () => {
      const { ids } = counted();

      expect(ids.idFor(first, -0).toString()).toBe(derived(first, -0));
      expect(ids.idFor(first, 0).toString()).toBe(derived(first, 0));
    });

    it("returns the id of each result cell for one partial cause", () => {
      const { ids, mints } = counted();
      const partialCause = deepFreeze({ $generated: 1 });

      expect(ids.idFor(first, partialCause).toString()).toBe(
        derived(first, partialCause),
      );
      expect(ids.idFor(second, partialCause).toString()).toBe(
        derived(second, partialCause),
      );
      expect(derived(first, partialCause)).not.toBe(
        derived(second, partialCause),
      );
      expect(mints()).toBe(2);
    });

    it("returns the id of a string partial cause that holds a line break", () => {
      // A cause and a result id are joined into one key, and neither may be
      // read as part of the other.

      const { ids } = counted();
      const partialCause = `count\n${first.getAsNormalizedFullLink().id}`;

      expect(ids.idFor(second, partialCause).toString()).toBe(
        derived(second, partialCause),
      );
      expect(ids.idFor(second, "count").toString()).toBe(
        derived(second, "count"),
      );
    });

    it("hashes again for an equal deep-frozen partial cause held in another object", () => {
      const { ids, mints } = counted();
      const one = ids.idFor(first, Object.freeze({ $generated: 1 }));
      const other = ids.idFor(first, Object.freeze({ $generated: 1 }));

      expect(other.toString()).toBe(one.toString());
      expect(mints()).toBe(2);
    });

    it("throws for a partial cause that is an object but not deep-frozen", () => {
      const { ids, mints } = counted();

      expect(() => ids.idFor(first, { $generated: 1 })).toThrow(
        "not deep-frozen",
      );
      expect(() => ids.idFor(first, ["a", 1])).toThrow("not deep-frozen");
      expect(mints()).toBe(0);
    });

    it("throws for a frozen partial cause that holds an object that is not", () => {
      const { ids, mints } = counted();
      const partialCause = Object.freeze({ $generated: 1, name: ["a"] });

      expect(() => ids.idFor(first, partialCause)).toThrow("not deep-frozen");
      expect(mints()).toBe(0);
    });

    it("returns ids that differ for `{ n: 0 }` and `{ n: -0 }`, each as derived", () => {
      const { ids } = counted();
      const zero = ids.idFor(first, deepFreeze({ n: 0 })).toString();
      const negativeZero = ids.idFor(first, deepFreeze({ n: -0 })).toString();

      expect(zero).toBe(derived(first, { n: 0 }));
      expect(negativeZero).toBe(derived(first, { n: -0 }));
      expect(zero).not.toBe(negativeZero);
    });

    it("returns ids that differ for an array holding a hole, one holding `undefined` and one holding `null`, each as derived", () => {
      const { ids } = counted();
      const hole = deepFreeze([1, , 3]) as JSONValue;
      const holdingUndefined = deepFreeze(
        [1, undefined, 3],
      ) as unknown as JSONValue;
      const holdingNull = deepFreeze([1, null, 3]);
      const found = [hole, holdingUndefined, holdingNull].map((partialCause) =>
        ids.idFor(first, partialCause).toString()
      );

      expect(found).toEqual(
        [hole, holdingUndefined, holdingNull].map((partialCause) =>
          derived(first, partialCause)
        ),
      );
      expect(new Set(found).size).toBe(3);
    });

    it("returns ids that differ for a partial cause holding one object twice and one holding two equal objects, each as derived", () => {
      // `createRef()` derives an object it reaches a second time as `null`,
      // so where a cause holds the same object twice its content alone does
      // not say what the id was derived from.

      const { ids } = counted();
      const shared = { name: "a" };
      const twice = deepFreeze({ x: shared, y: shared });
      const equal = deepFreeze({ x: { name: "a" }, y: { name: "a" } });
      const twiceId = ids.idFor(first, twice).toString();
      const equalId = ids.idFor(first, equal).toString();

      expect(twiceId).toBe(derived(first, twice));
      expect(equalId).toBe(derived(first, equal));
      expect(twiceId).not.toBe(equalId);
    });

    it("hashes each time for a partial cause that is no JSON value", () => {
      // A cause outside the declared type is derived as `createRef` derives
      // it, and no id is kept for it.

      const { ids, mints } = counted();
      const partialCause = undefined as unknown as JSONValue;
      const one = ids.idFor(first, partialCause);
      const other = ids.idFor(first, partialCause);

      expect(one.toString()).toBe(derived(first, partialCause));
      expect(other.toString()).toBe(one.toString());
      expect(mints()).toBe(2);
    });

    it("hashes again for an id past its capacity", () => {
      const { ids, mints } = counted(1);
      ids.idFor(first, "a");
      ids.idFor(first, "b");
      ids.idFor(first, "a");

      expect(mints()).toBe(3);
    });
  });

  describe("on a runtime", () => {
    it("supplies the id of a derived internal cell's link", () => {
      const partialCause = Object.freeze({ $generated: 4 });
      let mints = 0;
      runtime.derivedInternalCellIds.accessForTestingOnly.mintRecorder = () => {
        mints += 1;
      };
      const link = getDerivedInternalCellLink(first, { partialCause });
      const computed = getDerivedInternalCellLink(first, {
        partialCause,
        kind: "computed",
      });

      expect(link.id).toBe(`of:${derived(first, partialCause)}`);
      expect(computed.id).toBe(`computed:${derived(first, partialCause)}`);
      expect(mints).toBe(1);
    });
  });
});
