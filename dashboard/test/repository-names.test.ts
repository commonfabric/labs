import { expect } from "@std/expect";

import { currentRepoName, formerRepoNames } from "../repository-names.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("repository-names", () => {
  describe("currentRepoName()", () => {
    it("returns the name a renamed repository has now for a name it had before", () => {
      expect(currentRepoName("commonfabric/loom")).toBe("commonfabric/cfs");
      expect(currentRepoName("commonfabric/commonfabric-weaver")).toBe(
        "commonfabric/weaver",
      );
      expect(currentRepoName("CommonFabric/Loom")).toBe("commonfabric/cfs");
    });

    it("returns any other name as it is", () => {
      for (
        const name of [
          "commonfabric/cfs",
          "commonfabric/weaver",
          "commonfabric/labs",
          "commonfabric/loom-scripts",
          "someone/loom",
          "CommonFabric/Labs",
        ]
      ) {
        expect(currentRepoName(name)).toBe(name);
      }
    });
  });

  describe("formerRepoNames()", () => {
    it("returns the names a renamed repository had before", () => {
      expect(formerRepoNames("commonfabric/cfs")).toEqual(["commonfabric/loom"]);
      expect(formerRepoNames("commonfabric/weaver")).toEqual([
        "commonfabric/commonfabric-weaver",
      ]);
    });

    it("returns no names for a repository that was not renamed to the name given", () => {
      for (
        const name of [
          "commonfabric/loom",
          "commonfabric/labs",
          "commonfabric/loom-scripts",
          "someone/cfs",
        ]
      ) {
        expect(formerRepoNames(name)).toEqual([]);
      }
    });
  });
});
