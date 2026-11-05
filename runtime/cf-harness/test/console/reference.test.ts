import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parseConsoleReference } from "../../console/reference.ts";

describe("reference", () => {
  it("requires a complete entity scheme and a nonempty identifier", () => {
    for (
      const id of [
        "ofx",
        "computedx",
        "of",
        "computed",
        "of:",
        "computed:",
        "data:x",
        "fid1:x",
      ]
    ) {
      expect(parseConsoleReference(id)).toBeUndefined();
      expect(parseConsoleReference(`/${id}`)).toBeUndefined();
    }
  });

  it("preserves short recorded entity identities and literal path keys", () => {
    for (const id of ["of:x", "computed:x"]) {
      expect(parseConsoleReference(`  /${id}/..//title `)).toEqual({
        id,
        space: undefined,
        scope: "space",
        path: ["..", "", "title "],
      });
    }
  });
});
