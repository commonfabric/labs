import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  broaderCellScopes,
  broaderEntriesForReader,
} from "../v2/cfc-scoped-instance-labels.ts";

/** A label-map entry, as far as the selection reads one. */
interface Entry {
  path: string[];
  origin?: string;
  observes?: string;
}

describe("cfc-scoped-instance-labels", () => {
  describe("broaderCellScopes()", () => {
    it("returns no scope for the space scope", () => {
      expect(broaderCellScopes("space")).toEqual([]);
    });

    it("returns the space scope for the user scope", () => {
      expect(broaderCellScopes("user")).toEqual(["space"]);
    });

    it("returns the user scope, then the space scope, for the session scope", () => {
      expect(broaderCellScopes("session")).toEqual(["user", "space"]);
    });
  });

  describe("broaderEntriesForReader()", () => {
    it("returns the covering entries and those of the content classes, in the order given", () => {
      const covering: Entry = { path: ["text"] };
      const value: Entry = {
        path: ["text"],
        origin: "derived",
        observes: "value",
      };
      const shape: Entry = {
        path: ["text"],
        origin: "declared",
        observes: "shape",
      };
      const enumerate: Entry = { path: [], observes: "enumerate" };

      expect(broaderEntriesForReader([[covering, value], [shape, enumerate]]))
        .toEqual([covering, value, shape, enumerate]);
    });

    it("returns no entry for the pointer a broader slot holds", () => {
      // A link-origin entry with no class is of the `followRef` class.

      expect(broaderEntriesForReader([[
        { path: ["text"], origin: "link" },
        { path: ["text"], origin: "derived", observes: "followRef" },
      ]])).toEqual([]);
    });

    it("returns a link-origin entry of a content class", () => {
      const entry: Entry = {
        path: ["text"],
        origin: "link",
        observes: "value",
      };

      expect(broaderEntriesForReader([[entry]])).toEqual([entry]);
    });

    it("returns no label-metadata template entry, and none of a class it does not know", () => {
      expect(broaderEntriesForReader([[
        {
          path: ["cfc", "labels", "text"],
          origin: "label-metadata",
          observes: "labelMetadata",
        },
        { path: ["text"], observes: "unknown" },
      ]])).toEqual([]);
    });

    it("returns no entry for an instance that stores none", () => {
      expect(broaderEntriesForReader<Entry>([undefined, []])).toEqual([]);
    });
  });
});
