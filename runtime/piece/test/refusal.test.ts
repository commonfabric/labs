import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { editDistance, listFlags, nearestName } from "../src/refusal.ts";

describe("refusal", () => {
  describe("editDistance", () => {
    it("returns 0 for identical names", () => {
      expect(editDistance("title", "title")).toBe(0);
    });

    it("counts an adjacent transposition as one edit, not two", () => {
      // The whole reason this is Damerau rather than plain Levenshtein: a
      // transposition is THE typo the refusal exists for, and at two edits it
      // would fall outside the threshold for every short field name.
      expect(editDistance("titel", "title")).toBe(1);
    });

    it("counts a substitution, an insertion and a deletion as one each", () => {
      expect(editDistance("bitle", "title")).toBe(1);
      expect(editDistance("titlee", "title")).toBe(1);
      expect(editDistance("ttle", "title")).toBe(1);
    });
  });

  describe("nearestName", () => {
    it("returns the candidate one transposition away", () => {
      expect(nearestName("titel", ["title", "body"])).toBe("title");
    });

    it("returns the candidate's own casing, not the caller's", () => {
      // The caller has to retype it, so the answer must be typeable as given.
      expect(nearestName("agentname", ["agentName"])).toBe("agentName");
    });

    it("returns undefined when nothing is close enough", () => {
      // A wrong guess is worse than none: it sends the caller to a field they
      // did not mean, and the vocabulary beside it is the real remedy.
      expect(nearestName("zzzzzzzz", ["title", "body"])).toBeUndefined();
    });

    it("forgives one edit even on a name too short to earn one", () => {
      // floor(2/4) is 0, so without the max() a two-character name could
      // never match anything and the near miss would silently never fire.
      expect(nearestName("ttle", ["title"])).toBe("title");
      expect(nearestName("ab", ["ac"])).toBe("ac");
    });

    it("returns undefined over an empty vocabulary", () => {
      expect(nearestName("title", [])).toBeUndefined();
    });
  });

  describe("listFlags", () => {
    it("returns an empty string for no flags, and a single flag as it is", () => {
      expect(listFlags([])).toBe("");
      expect(listFlags(["--a"])).toBe("--a");
    });

    it("joins two flags with `and`", () => {
      expect(listFlags(["--a", "--b"])).toBe("--a and --b");
    });

    it("joins three or more with commas and a final `and`", () => {
      expect(listFlags(["--a", "--b", "--c"])).toBe("--a, --b and --c");
    });
  });
});
