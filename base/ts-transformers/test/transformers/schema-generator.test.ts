import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { transformCfDirective } from "../../src/mod.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { validateFiles } from "../utils.ts";

const MAIN = `/// <cts-enable />
import { toSchema } from "commonfabric";
import type { Imported } from "./types.ts";
interface Local { key: symbol }
export const local = toSchema<Local>();
export const imported = toSchema<Imported>();
`;

describe("schema-generator", () => {
  describe("generation diagnostics", () => {
    it("reports a problem in an imported type at the call that generated the schema", async () => {
      // A local type's problem is reported where the type says it; an
      // imported one has no position in this file, so it is reported at the
      // `toSchema()` call instead.

      const { diagnostics } = await validateFiles({
        "/types.ts": `export interface Imported { key: symbol }\n`,
        "/main.tsx": MAIN,
      }, { types: COMMONFABRIC_TYPES });
      const compiled = transformCfDirective(MAIN);
      expect(
        diagnostics.map(({ type, fileName, start, length }) => ({
          type,
          fileName,
          text: compiled.slice(start, start + length),
        })),
      ).toEqual([
        { type: "schema-type:symbol", fileName: "/main.tsx", text: "symbol" },
        {
          type: "schema-type:symbol",
          fileName: "/main.tsx",
          text: "toSchema<Imported>()",
        },
      ]);
    });
  });
});
