import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { labelResultSchema } from "../src/builtins/sqlite-builtins.ts";

describe("CFC sqlite aggregate column integrity", () => {
  // A null-origin result column (aggregate, expression, literal) takes the
  // confidentiality union over every labeled db column, which is a sound
  // over-approximation. For INTEGRITY the same union over-claims: a COUNT(*)
  // would claim an integrity atom held by a single column. §8.17.1 requires a
  // class-aware meet (never union) for integrity; with propagation classes
  // still pending, the conservative result is empty integrity (an aggregate
  // is a new computed value with no inherited evidence).

  it("gives a null-origin column the confidentiality union but no integrity", () => {
    // deno-lint-ignore no-explicit-any
    const tables: any = {
      notes: {
        properties: {
          body: {
            ifc: {
              confidentiality: ["secret-body"],
              integrity: ["trusted-body"],
            },
          },
        },
      },
    };
    // deno-lint-ignore no-explicit-any
    const columns: any = [{ output: "cnt", table: null, column: null }];

    const { schema } = labelResultSchema(columns, tables);
    const ifc = (schema as any)?.properties?.result?.items?.properties?.cnt
      ?.ifc;

    expect(ifc).toBeDefined();
    expect(ifc.confidentiality).toEqual(["secret-body"]);
    expect(ifc.integrity ?? []).toEqual([]);
  });
});
