import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  mergedPlanWrites,
  planWriteTargets,
} from "../../src/cfc/plan-write-targets.ts";
import type { CfcAddress, PlanWrite } from "../../src/cfc/types.ts";

const space = "did:key:z6MkPlanWriteTargets" as CfcAddress["space"];

const address = (id: string, path: readonly string[]): CfcAddress => ({
  space,
  id,
  scope: "space",
  path,
});

/** A record of output `output` at `target` with the inputs at `inputs`. */
const write = (
  target: CfcAddress,
  inputs: number,
  more: Partial<PlanWrite> = {},
): PlanWrite => ({
  inputs,
  target,
  compiledPattern: "pattern",
  record: { output: 0 },
  instance: "of:instance",
  keys: [],
  ...more,
});

/** The targets of `writes`, each as text, in order. */
const targetsOf = (writes: readonly PlanWrite[]): string[] =>
  writes.flatMap((each) =>
    planWriteTargets(each).map((target) =>
      `${target.id} /${target.path.join("/")}`
    )
  );

describe("plan-write-targets", () => {
  describe("mergedPlanWrites()", () => {
    it("gives one record for the records of one plan record with one set of inputs at the members of one container", () => {
      const merged = mergedPlanWrites(
        Array.from(
          { length: 5 },
          (_, index) => write(address("of:a", ["rows", `${index}`, "x"]), 3),
        ),
      );

      expect(merged).toEqual([
        write(address("of:a", ["rows", "*", "x"]), 3, { members: [[0, 4]] }),
      ]);
    });

    it("lists a member that is no index by its name, and indices that are not next to each other apart", () => {
      const merged = mergedPlanWrites(
        ["0", "1", "5", "name"].map((member) =>
          write(address("of:a", ["rows", member]), 3)
        ),
      );

      expect(merged).toEqual([
        write(address("of:a", ["rows", "*"]), 3, {
          members: [[0, 1], "5", "name"],
        }),
      ]);
    });

    it("gives one record for the records with one set of inputs at one path of several documents", () => {
      const merged = mergedPlanWrites(
        ["of:a", "of:b", "of:c"].map((id) => write(address(id, []), 3)),
      );

      expect(merged).toEqual([
        write(address("of:a", []), 3, { documents: ["of:b", "of:c"] }),
      ]);
    });

    it("keeps apart records that differ in the plan record, the inputs, or a mark", () => {
      const writes = [
        write(address("of:a", ["rows", "0"]), 3),
        write(address("of:a", ["rows", "1"]), 4),
        write(address("of:a", ["rows", "2"]), 3, { record: { output: 1 } }),
        write(address("of:a", ["rows", "3"]), 3, { unchanged: true }),
        write(address("of:a", ["rows", "4"]), 3, { relabel: true }),
      ];

      expect(mergedPlanWrites(writes)).toEqual(writes);
    });

    it("keeps a record of a container's membership, and one that names positions it observed, as it is", () => {
      const observed = [{
        address: address("of:a", ["rows"]),
        observes: "shape" as const,
      }];
      const writes = [
        write(address("of:a", ["rows", "0"]), 3, { decided: observed }),
        write(address("of:a", ["rows", "1"]), 3, { decided: observed }),
        write(address("of:a", ["rows"]), 3, { enumeration: true }),
        write(address("of:b", ["rows"]), 3, { enumeration: true }),
        write(address("of:a", ["list"]), 3, { membersChanged: true }),
        write(address("of:b", ["list"]), 3, { membersChanged: true }),
      ];

      expect(mergedPlanWrites(writes)).toEqual(writes);
    });

    it("leaves before the merged records a record that a later record of the same path replaces", () => {
      const replaced = write(address("of:a", ["rows", "1"]), 4);
      const merged = mergedPlanWrites([
        write(address("of:a", ["rows", "0"]), 3),
        replaced,
        write(address("of:a", ["rows", "1"]), 3),
        write(address("of:a", ["rows", "2"]), 4),
      ]);

      expect(merged).toEqual([
        replaced,
        write(address("of:a", ["rows", "*"]), 3, { members: [[0, 1]] }),
        write(address("of:a", ["rows", "2"]), 4),
      ]);
    });

    it("leaves before the merged records a record that stands alone and that a later record of the same path replaces", () => {
      const replaced = write(address("of:a", ["rows", "1"]), 4, {
        observed: [{
          address: address("of:a", ["rows"]),
          observes: "shape",
        }],
      });
      const merged = mergedPlanWrites([
        write(address("of:a", ["rows", "0"]), 3),
        replaced,
        write(address("of:a", ["rows", "1"]), 3),
      ]);

      expect(merged).toEqual([
        replaced,
        write(address("of:a", ["rows", "*"]), 3, { members: [[0, 1]] }),
      ]);
    });

    it("covers the targets the records given cover, each once", () => {
      const writes = [
        ...Array.from(
          { length: 40 },
          (_, index) => write(address("of:a", ["rows", `${index}`, "x"]), 3),
        ),
        ...Array.from(
          { length: 40 },
          (_, index) => write(address(`of:doc-${index}`, ["value"]), 5),
        ),
        write(address("of:a", ["other"]), 3),
      ];

      const merged = mergedPlanWrites(writes);

      expect(merged.length).toBe(3);
      expect(targetsOf(merged).sort()).toEqual(targetsOf(writes).sort());
    });
  });

  describe("planWriteTargets()", () => {
    it("returns the target of a record that names one path", () => {
      const target = address("of:a", ["rows", "0"]);

      expect(planWriteTargets(write(target, 3))).toEqual([target]);
    });

    it("returns the path of each member a record lists, in order", () => {
      const targets = planWriteTargets(
        write(address("of:a", ["rows", "*", "x"]), 3, {
          members: [[1, 3], "name"],
        }),
      );

      expect(targets.map(({ path }) => path.join("/"))).toEqual([
        "rows/1/x",
        "rows/2/x",
        "rows/3/x",
        "rows/name/x",
      ]);
    });

    it("returns the path in each document a record lists", () => {
      const targets = planWriteTargets(
        write(address("of:a", ["value"]), 3, { documents: ["of:b"] }),
      );

      expect(targets).toEqual([
        address("of:a", ["value"]),
        address("of:b", ["value"]),
      ]);
    });

    it("throws for a record that lists members and has no `*` in the path of its target", () => {
      expect(() =>
        planWriteTargets(
          write(address("of:a", ["rows", "0"]), 3, { members: ["1"] }),
        )
      ).toThrow();
    });
  });
});
