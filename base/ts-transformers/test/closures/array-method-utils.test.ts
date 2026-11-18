import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { validateSource } from "../utils.ts";

describe("array-method-utils", () => {
  describe("a computed key in a collection callback's element parameter", () => {
    // A computed key is read through an alias lifted from the element and the
    // key, which has no way to apply a destructuring default on or around it.

    /** The `pattern-context:computation` messages for `callback` over rows. */
    async function computationErrors(callback: string): Promise<string[]> {
      const { diagnostics } = await validateSource(
        `/// <cts-enable />
import { pattern } from "commonfabric";
const fallback: Record<string, number> = { x: 1 };
export default pattern<{
  rows: (Record<string, number> | undefined)[][];
  records: Record<string, number>[];
  k: string;
}>(({ rows, records, k }) => ({
  out: ${callback},
}));`,
        { types: COMMONFABRIC_TYPES },
      );
      return diagnostics
        .filter(({ type }) => type === "pattern-context:computation")
        .map(({ message }) => message);
    }

    it("reports a default on the array element a computed key is read from", async () => {
      expect(
        await computationErrors(
          "rows.map(([{ [k]: chosen } = fallback]) => chosen)",
        ),
      ).toEqual([expect.stringContaining("computed key")]);
    });

    it("reports a default on the binding a computed key names", async () => {
      expect(
        await computationErrors("records.map(({ [k]: chosen = 0 }) => chosen)"),
      ).toEqual([expect.stringContaining("computed key")]);
    });

    it("reports nothing for a computed key with no default", async () => {
      expect(
        await computationErrors("records.map(({ [k]: chosen }) => chosen)"),
      )
        .toEqual([]);
    });
  });
});
