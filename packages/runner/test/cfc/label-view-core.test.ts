import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { isOrClause } from "../../src/cfc/clause.ts";
import {
  type CfcLabelView,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "../../src/cfc/label-view-core.ts";

describe("label-view-core", () => {
  it("orders escaped logical paths and retains observation order at a path", () => {
    const paths = [["~"], ["/"], ["a"], ["*"], [], ["a"], ["value", "a"]];
    const view: CfcLabelView = {
      version: 1,
      entries: paths.map((path, index) => ({
        path,
        label: { integrity: [`atom-${index}`] },
        observes: index === 5 ? "shape" : "value",
      })),
    };

    for (
      const result of [cloneCfcLabelView(view), mergeCfcLabelViews([view])]
    ) {
      expect(result?.entries.map((entry) => entry.path)).toEqual([
        [],
        ["*"],
        ["a"],
        ["a"],
        ["value", "a"],
        ["~"],
        ["/"],
      ]);
      expect(result?.entries.map((entry) => entry.label.integrity)).toEqual([
        ["atom-4"],
        ["atom-3"],
        ["atom-2"],
        ["atom-5"],
        ["atom-6"],
        ["atom-0"],
        ["atom-1"],
      ]);
      expect(result?.entries[3].observes).toBe("shape");
    }
    expect(view.entries.map((entry) => entry.path)).toEqual(paths);
  });

  it("reads changed input paths and returns independently owned arrays", () => {
    for (
      const operation of [
        cloneCfcLabelView,
        (view: CfcLabelView) => mergeCfcLabelViews([view]),
        (view: CfcLabelView) => rebaseCfcLabelView(view, []),
      ]
    ) {
      const path = ["z"];
      const integrity = ["source"];
      const view: CfcLabelView = {
        version: 1,
        entries: [
          { path, label: { integrity } },
          { path: ["m"], label: { integrity: ["middle"] } },
        ],
      };
      const first = operation(view)!;
      path[0] = "a";
      integrity.push("changed");
      const second = operation(view)!;

      expect(first.entries[1]).toEqual({
        path: ["z"],
        label: { integrity: ["source"] },
      });
      expect(second.entries[0]).toEqual({
        path: ["a"],
        label: { integrity: ["source", "changed"] },
      });
      second.entries[0].label.integrity!.push("output-only");
      expect(integrity).toEqual(["source", "changed"]);
    }
  });

  it("rebases wildcard content and keeps CNF clauses and node classes separate", () => {
    const view: CfcLabelView = {
      version: 1,
      entries: [
        { path: [], label: { confidentiality: ["covering"] } },
        {
          path: [],
          label: { confidentiality: ["ancestor-shape"] },
          observes: "shape",
        },
        {
          path: ["items", "*"],
          label: { confidentiality: [{ anyOf: ["a", "b"] }] },
        },
        { path: ["items", "0"], label: { confidentiality: ["c"] } },
        {
          path: ["items", "0"],
          label: { integrity: ["node-shape"] },
          observes: "shape",
        },
        {
          path: ["items", "0", "body~/"],
          label: { integrity: ["child"] },
          observes: "followRef",
        },
      ],
    };
    const result = rebaseCfcLabelView(view, ["items", "0"])!;
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0].path).toEqual([]);
    expect(result.entries[0].label.confidentiality).toHaveLength(3);
    expect(result.entries[0].label.confidentiality).toEqual(
      expect.arrayContaining(["covering", "c", {
        anyOf: expect.arrayContaining(["a", "b"]),
      }]),
    );
    expect(result.entries[0].label.confidentiality?.find(isOrClause)?.anyOf)
      .toHaveLength(2);
    expect(result.entries[1]).toEqual({
      path: [],
      label: { integrity: ["node-shape"] },
      observes: "shape",
    });
    expect(result.entries[2]).toEqual({
      path: ["body~/"],
      label: { integrity: ["child"] },
      observes: "followRef",
    });
  });
});
