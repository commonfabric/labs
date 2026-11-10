/**
 * Pins the error a pattern gets where a schema it generates would have to
 * describe a symbol that the runtime could store, which the schema dialect
 * has no way to do.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type TransformationDiagnostic,
  transformCfDirective,
} from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { transformFiles } from "./utils.ts";

/** A module that generates a schema for `type`. */
const moduleFor = (type: string) =>
  `import { type Confidential, type PerUser, toSchema } from "commonfabric";
   export default toSchema<${type}>();`;

/** The diagnostics compiling `source` reports. */
async function diagnosticsFor(
  source: string,
): Promise<TransformationDiagnostic[]> {
  const diagnostics: TransformationDiagnostic[] = [];
  await transformFiles({ "/test.tsx": source }, {
    types: COMMONFABRIC_TYPES,
    pipelineDiagnostics: diagnostics,
  });
  return diagnostics;
}

describe("symbol-type-diagnostic", () => {
  it("reports an error at the symbol type the author wrote", async () => {
    const source = moduleFor("{ k: string | symbol }");
    const diagnostics = await diagnosticsFor(source);

    expect(diagnostics.map(({ type, severity, fileName, start, length }) => ({
      type,
      severity,
      fileName,
      start,
      length,
    }))).toEqual([{
      type: "schema-type:symbol",
      severity: "error",
      fileName: "/test.tsx",
      // A position in the text the compiler reads, which the helper import
      // the harness adds in front of the authored text shifts.
      start: transformCfDirective(source).indexOf("symbol }"),
      length: "symbol".length,
    }]);
    expect(diagnostics[0]!.message).toContain("`symbol` is a symbol type");
  });

  it("reports an error at the alias naming a key union that holds a symbol", async () => {
    const source = `import { toSchema } from "commonfabric";
       declare const s: unique symbol;
       type Key = keyof { a: 1; [s]: 2 };
       export default toSchema<{ k: Key }>();`;
    const diagnostics = await diagnosticsFor(source);

    expect(diagnostics.map(({ type, start, length }) => ({
      type,
      start,
      length,
    }))).toEqual([{
      type: "schema-type:symbol",
      start: transformCfDirective(source).indexOf("Key }"),
      length: "Key".length,
    }]);
    expect(diagnostics[0]!.message).toContain("`Exclude<Key, symbol>`");
  });

  for (
    const [position, type] of [
      ["the payload of a CFC alias", `Confidential<keyof any, ["secret"]>`],
      ["the payload of a scope wrapper", "PerUser<keyof any>"],
    ] as const
  ) {
    it(`reports an error at a key union in ${position}`, async () => {
      const source = moduleFor(`{ k: ${type} }`);
      const diagnostics = await diagnosticsFor(source);

      expect(diagnostics.map(({ type, start, length }) => ({
        type,
        start,
        length,
      }))).toEqual([{
        type: "schema-type:symbol",
        start: transformCfDirective(source).indexOf("keyof any"),
        length: "keyof any".length,
      }]);
      expect(diagnostics[0]!.message).toContain(
        "`keyof any` includes the symbol type `symbol`",
      );
    });
  }

  for (
    const [position, type] of [
      ["the payload of a CFC alias", `Confidential<symbol, ["secret"]>`],
      ["the payload of a scope wrapper", "PerUser<symbol>"],
    ] as const
  ) {
    it(`reports an error at a bare \`symbol\` as ${position}`, async () => {
      const source = moduleFor(`{ k: ${type} }`);
      const diagnostics = await diagnosticsFor(source);

      expect(diagnostics.map(({ type, start, length }) => ({
        type,
        start,
        length,
      }))).toEqual([{
        type: "schema-type:symbol",
        start: transformCfDirective(source).indexOf("symbol"),
        length: "symbol".length,
      }]);
      expect(diagnostics[0]!.message).toContain("`symbol` is a symbol type");
    });
  }

  describe("reports nothing", () => {
    // `keyof string` holds `typeof Symbol.iterator`, a well-known symbol,
    // which the runtime never stores.

    it("for `keyof string`", async () => {
      expect(await diagnosticsFor(moduleFor("{ k: keyof string }")))
        .toEqual([]);
    });

    it("for a record keyed by `PropertyKey`", async () => {
      expect(
        await diagnosticsFor(moduleFor("{ k: Record<PropertyKey, never> }")),
      ).toEqual([]);
    });

    it("for `keyof string` as the payload of a CFC alias", async () => {
      expect(
        await diagnosticsFor(
          moduleFor(`{ k: Confidential<keyof string, ["secret"]> }`),
        ),
      ).toEqual([]);
    });
  });
});
