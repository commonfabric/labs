import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  normalize,
  readBuildInfoFrom,
} from "@commonfabric/platform/build-info";

const fixture = (name: string) =>
  new URL(`./fixtures/build-info/${name}`, import.meta.url);

const UNKNOWN = { commitSha: null, builtAt: null };

describe("build-info", () => {
  describe("normalize()", () => {
    it("returns the value with surrounding whitespace removed", () => {
      expect(normalize("  abc \n")).toBe("abc");
    });

    it("returns `null` for a missing or blank value", () => {
      for (const value of [undefined, null, "", "  \t\n"]) {
        expect(normalize(value)).toBeNull();
      }
    });
  });

  describe("readBuildInfoFrom()", () => {
    it("returns the trimmed fields of a metadata file", () => {
      expect(readBuildInfoFrom(fixture("complete.json"))).toEqual({
        commitSha: "abc123",
        builtAt: "2026-01-02T03:04:05Z",
      });
    });

    it("returns `null` for each blank field", () => {
      expect(readBuildInfoFrom(fixture("blank-fields.json"))).toEqual(UNKNOWN);
    });

    it("returns both fields `null` for a file that is missing, empty, malformed, or not an object", () => {
      for (
        const name of [
          "missing.json",
          "empty.json",
          "malformed.txt",
          "string.json",
        ]
      ) {
        expect(readBuildInfoFrom(fixture(name))).toEqual(UNKNOWN);
      }
    });
  });
});
