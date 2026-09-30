import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { deepFreeze } from "@commonfabric/data-model";

import { isOrClause } from "../../src/cfc/clause.ts";
import {
  type CfcLabelView,
  cloneCfcLabelView,
  rebaseCfcLabelView,
} from "../../src/cfc/label-view-core.ts";
import { CfcLabelViewRebaser } from "../../src/cfc/label-view-rebaser.ts";

describe("CfcLabelViewRebaser", () => {
  describe("constructor()", () => {
    it("owns the base arrays without freezing the caller's view", () => {
      const path = ["old"];
      const integrity = ["source"];
      const view: CfcLabelView = {
        version: 1,
        entries: [{ path, label: { integrity } }],
      };
      const rebaser = new CfcLabelViewRebaser(view);
      path[0] = "new";
      integrity.push("changed");
      view.entries.push({ path: [], label: { integrity: ["added"] } });

      expect(rebaser.rebase([])).toEqual({
        version: 1,
        entries: [{ path: ["old"], label: { integrity: ["source"] } }],
      });
      expect(Object.isFrozen(view)).toBe(false);
      expect(Object.keys(rebaser)).toEqual([]);
    });
  });

  describe("instance members", () => {
    describe("rebase()", () => {
      it("preserves wildcards, observation classes, and escaped paths", () => {
        const view: CfcLabelView = {
          version: 1,
          entries: [
            { path: [], label: { integrity: ["cover"] } },
            { path: [], label: { integrity: ["value"] }, observes: "value" },
            { path: [], label: { integrity: ["shape"] }, observes: "shape" },
            {
              path: [],
              label: { integrity: ["enumerate"] },
              observes: "enumerate",
            },
            {
              path: [],
              label: { integrity: ["ref"] },
              observes: "followRef",
            },
            { path: ["items", "*"], label: { integrity: ["wild"] } },
            { path: ["items", "0"], label: { integrity: ["exact"] } },
            {
              path: ["items", "0", "~/"],
              label: { integrity: ["child"] },
              observes: "followRef",
            },
            { path: ["value", "value", "leaf"], label: { integrity: ["v"] } },
            { path: ["other"], label: {} },
          ],
        };
        const rebaser = new CfcLabelViewRebaser(view);
        const paths = [
          [],
          ["value"],
          ["value", "value"],
          ["items"],
          ["items", "0"],
          ["items", "*"],
          ["items", "0", "~/"],
          ["missing"],
        ];
        for (const path of paths) {
          const expected = rebaseCfcLabelView(cloneCfcLabelView(view), path);
          expect(rebaser.rebase(path)).toEqual(expected);
          expect(rebaser.rebase([...path])).toEqual(expected);
        }
      });

      it("returns fresh paths, labels, and normalized OR alternatives on hits", () => {
        const clause = deepFreeze({ anyOf: ["b", "a"] });
        const view: CfcLabelView = {
          version: 1,
          entries: [{
            path: ["item"],
            label: { confidentiality: [clause], integrity: ["source"] },
          }],
        };
        const rebaser = new CfcLabelViewRebaser(view);
        const expected = rebaseCfcLabelView(cloneCfcLabelView(view), []);
        const first = rebaser.rebase([])!;
        const firstEntry = first.entries[0];
        // The public type is readonly; these arrays are mutable result data.
        (firstEntry.path as string[])[0] = "changed";
        firstEntry.observes = "shape";
        firstEntry.label.integrity!.push("output-only");
        const firstClause = firstEntry.label.confidentiality![0];
        expect(isOrClause(firstClause)).toBe(true);
        (firstClause as { anyOf: string[] }).anyOf.push("output-only");
        first.entries.push({ path: [], label: { integrity: ["output-only"] } });

        const second = rebaser.rebase([])!;
        expect(second).toEqual(expected);
        expect(second).not.toBe(first);
        expect(second.entries).not.toBe(first.entries);
        expect(second.entries[0]).not.toBe(firstEntry);
        expect(second.entries[0].label).not.toBe(firstEntry.label);
        expect(view.entries[0].label.confidentiality).toEqual([clause]);
      });

      it("rechecks mutable nested atoms when their equality changes", () => {
        const changing = { type: "test", value: "different" };
        const stable = { type: "test", value: "same" };
        const view: CfcLabelView = {
          version: 1,
          entries: [{ path: [], label: { integrity: [changing, stable] } }],
        };
        const rebaser = new CfcLabelViewRebaser(view);
        expect(rebaser.rebase([])!.entries[0].label.integrity).toHaveLength(2);
        changing.value = "same";
        expect(rebaser.rebase([])!.entries[0].label.integrity).toHaveLength(1);
        expect(Object.isFrozen(changing)).toBe(false);
      });
    });

    describe("setView()", () => {
      it("invalidates populated slices and misses even for the same input", () => {
        const view: CfcLabelView = {
          version: 1,
          entries: [{ path: ["old"], label: { integrity: ["before"] } }],
        };
        const rebaser = new CfcLabelViewRebaser(view);
        expect(rebaser.rebase(["new"])).toBeUndefined();
        expect(rebaser.rebase(["old"])!.entries[0].label.integrity)
          .toEqual(["before"]);
        view.entries = [{ path: ["new"], label: { integrity: ["after"] } }];
        rebaser.setView(view);
        expect(rebaser.rebase(["old"])).toBeUndefined();
        expect(rebaser.rebase(["new"])!.entries[0].label.integrity)
          .toEqual(["after"]);
        rebaser.setView(undefined);
        expect(rebaser.rebase(["new"])).toBeUndefined();
        rebaser.setView(view);
        expect(rebaser.rebase(["new"])!.entries[0].label.integrity)
          .toEqual(["after"]);
      });
    });
  });
});
