import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { StagedMap } from "../src/staged-map.ts";

describe("StagedMap", () => {
  describe("instance members", () => {
    describe("changedKeys()", () => {
      it("yields each changed key once after deletion or clearing and reinsertion", () => {
        for (const clear of [false, true]) {
          const stage = new StagedMap(new Map([["a", 1], ["b", 2]]));
          if (clear) stage.clear();
          else {
            stage.delete("a");
            stage.delete("b");
          }
          stage.set("a", 3);
          stage.set("c", 4);
          expect([...stage.changedKeys()]).toEqual(["b", "a", "c"]);
        }
      });

      it("reads only changed keys when the base is not cleared", () => {
        const base = new Map([["a", 1], ["b", 2]]);
        base.keys = () => {
          throw new Error("The unchanged base must not be enumerated");
        };
        const stage = new StagedMap(base);
        expect([...stage.changedKeys()]).toEqual([]);
        stage.set("a", 3);
        stage.delete("b");
        stage.set("c", 4);
        expect([...stage.changedKeys()]).toEqual(["b", "a", "c"]);
        expect(base.get("a")).toBe(1);
        expect(base.has("b")).toBe(true);
      });
    });

    describe("getOrInsertComputed()", () => {
      it("rejects non-callable callbacks before checking membership", () => {
        const stage = new StagedMap(new Map([["present", 1]]));
        for (const key of ["present", "absent"]) {
          expect(() =>
            Reflect.apply(stage.getOrInsertComputed, stage, [key, undefined])
          ).toThrow(TypeError);
        }
      });
      it("uses staged membership and preserves callback mutations", () => {
        const base = new Map<string | number, number | undefined>([[
          "existing",
          undefined,
        ]]);
        const stage = new StagedMap(base);
        expect(stage.getOrInsert("existing", 5)).toBeUndefined();
        expect(stage.getOrInsertComputed("existing", () => {
          throw new Error("Existing value must suppress the callback");
        })).toBeUndefined();
        expect(stage.getOrInsert("added", 7)).toBe(7);
        expect(stage.getOrInsertComputed("computed", (key) => {
          stage.set(key, 9);
          stage.delete("added");
          return 11;
        })).toBe(11);
        expect(stage.getOrInsertComputed(-0, (key) => {
          expect(Object.is(key, 0)).toBe(true);
          return 13;
        })).toBe(13);
        expect([...base]).toEqual([["existing", undefined]]);
        stage.commit();
        expect([...base]).toEqual([["existing", undefined], ["computed", 11], [
          0,
          13,
        ]]);
      });
    });

    describe("commit()", () => {
      it("preserves Map membership and order across deletion, reinsertion, and clear", () => {
        const operations = [
          (map: Map<string, number | undefined>) => map.set("a", 4),
          (map: Map<string, number | undefined>) => map.delete("a"),
          (map: Map<string, number | undefined>) => map.set("c", undefined),
          (map: Map<string, number | undefined>) => map.clear(),
        ];
        for (let sequence = 0; sequence < 256; sequence++) {
          const base = new Map<string, number | undefined>([["a", 1], [
            "b",
            2,
          ]]);
          const expected = new Map(base);
          const stage = new StagedMap(base);
          for (let step = 0; step < 4; step++) {
            const operation = operations[(sequence >> (2 * step)) & 3]!;
            operation(stage);
            operation(expected);
            expect([...stage]).toEqual([...expected]);
            expect(stage.size).toBe(expected.size);
            for (const key of ["a", "b", "c"]) {
              expect(stage.get(key)).toBe(expected.get(key));
              expect(stage.has(key)).toBe(expected.has(key));
            }
            expect([...base]).toEqual([["a", 1], ["b", 2]]);
          }
          stage.commit();
          expect([...base]).toEqual([...expected]);
        }
      });

      it("isolates mutable values until publication", () => {
        const original = new Set(["original"]);
        const base = new Map([["a", original]]);
        const abandoned = new StagedMap(base, (value) => new Set(value));
        abandoned.get("a")!.add("abandoned");
        const stage = new StagedMap(base, (value) => new Set(value));
        stage.get("a")!.add("published");
        expect([...original]).toEqual(["original"]);
        stage.commit();
        expect([...base.get("a")!]).toEqual(["original", "published"]);
        expect([...original]).toEqual(["original"]);
      });

      it("does not enumerate untouched base entries", () => {
        const base = new Map(Array.from({ length: 1000 }, (_, i) => [i, i]));
        base[Symbol.iterator] =
          base.entries =
          base.keys =
          base.values =
            () => {
              throw new Error("Unexpected base iteration");
            };
        const stage = new StagedMap(base);
        stage.set(1001, 7);
        stage.delete(2);
        stage.set(3, 8);
        expect(stage.size).toBe(1000);
        stage.commit();
        expect(base.size).toBe(1000);
        expect(base.get(1001)).toBe(7);
        expect(base.get(3)).toBe(8);
        expect(base.has(2)).toBe(false);
      });
    });

    describe("entries()", () => {
      it("validates forEach callbacks even when empty and invokes callable values directly", () => {
        const stage = new StagedMap(new Map<string, number>());
        expect(() => Reflect.apply(stage.forEach, stage, [undefined])).toThrow(
          TypeError,
        );
        stage.set("a", 1);
        const visited: number[] = [];
        const callback = (value: number) => visited.push(value);
        Object.defineProperty(callback, "call", { value: undefined });
        stage.forEach(callback);
        expect(visited).toEqual([1]);
      });
      it("observes insertion and reinsertion during iteration", () => {
        const base = new Map([["a", 1], ["b", 2]]);
        const stage = new StagedMap(base);
        const visited: string[] = [];
        for (const [key] of stage) {
          visited.push(key);
          if (key === "a" && visited.length === 1) {
            stage.delete("a");
            stage.delete("b");
            stage.set("c", 3);
            stage.set("a", 4);
          }
        }
        expect(visited).toEqual(["a", "c", "a"]);
        expect([...stage.keys()]).toEqual(["c", "a"]);
        expect([...stage.values()]).toEqual([3, 4]);
        const receiver = new Map<string, number>();
        stage.forEach(function (this: Map<string, number>, value, key, map) {
          expect(map).toBe(stage);
          this.set(key, value);
        }, receiver);
        expect([...receiver]).toEqual([...stage]);
      });
    });
  });
});
