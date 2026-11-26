import { expect } from "@std/expect";
import { isCfLinkColumn, sqlAffinity } from "../v2/sqlite/columns.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("columns", () => {
  describe("isCfLinkColumn()", () => {
    it("returns `true` for a name ending in `_cf_link` after a prefix", () => {
      expect(isCfLinkColumn("author_cf_link")).toBe(true);
    });

    it("returns `false` for the bare suffix and for other names", () => {
      expect(isCfLinkColumn("_cf_link")).toBe(false);
      expect(isCfLinkColumn("author_cf_links")).toBe(false);
    });
  });

  describe("sqlAffinity()", () => {
    it("returns the affinity SQLite's rules give each declared type", () => {
      const cases: [string, string][] = [
        ["INTEGER", "integer"],
        ["int blob", "integer"],
        ["VARCHAR(20)", "text"],
        ["CLOB", "text"],
        ["text", "text"],
        ["BLOB", "blob"],
        ["", "blob"],
        ["  ", "blob"],
        ["REAL", "real"],
        ["FLOAT", "real"],
        ["DOUBLE PRECISION", "real"],
        ["NUMERIC", "numeric"],
        ["DECIMAL(10,5)", "numeric"],
        ["BOOLEAN", "numeric"],
        ["DATE", "numeric"],
      ];
      expect(cases.map(([type]) => [type, sqlAffinity(type)])).toEqual(cases);
    });
  });
});
