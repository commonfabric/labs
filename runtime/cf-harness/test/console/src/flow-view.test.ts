import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { labelRegime } from "../../../console/src/flow-view.ts";

describe("console/src/flow-view", () => {
  describe("labelRegime", () => {
    it("counts the cells that carry a label when every one was read whole", () => {
      expect(labelRegime({
        status: "read",
        cellsRead: 3,
        cellsLabelled: 2,
        cellsPartial: 0,
      })).toBe("cell labels read · 2 of 3 carry one");
    });

    it("states a partial reading where a cell was read only in part", () => {
      // The count is a floor under a partial reading — another label may sit
      // at a path nothing was read at — so the line may not lead with it as a
      // total.
      expect(labelRegime({
        status: "read",
        cellsRead: 3,
        cellsLabelled: 2,
        cellsPartial: 1,
      })).toBe(
        "cell labels read in part · 2 of 3 carry one, 1 only partly read",
      );
    });

    it("says nobody asked where the run recorded no snapshot", () => {
      expect(labelRegime({
        status: "absent",
        cellsRead: 0,
        cellsLabelled: 0,
        cellsPartial: 0,
      })).toBe("cell labels not read");
    });

    it("names why the space could not be read", () => {
      expect(labelRegime({
        status: "unavailable",
        detail: "no space database on this host",
        cellsRead: 0,
        cellsLabelled: 0,
        cellsPartial: 0,
      })).toBe("cell labels unavailable · no space database on this host");
    });
  });
});
