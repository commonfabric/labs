import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { StaticCache } from "@commonfabric/static";
import ts from "typescript";

import { collect, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

const commonfabricTypes = await StaticCache.fromFileSystem().getText(
  "types/commonfabric.d.ts",
);

describe("obsolete", () => {
  it("authorizes the exact retired-output capture and preserves its native schema", async () => {
    const output = await transformSource(
      `
      import { type AsyncResult, computed, isObsolete, pattern, resultOf } from "commonfabric";
      export default pattern((input: { request: AsyncResult<string> }) => ({
        diagnostic: computed(() => isObsolete(input.request)
          ? input.request.obsoleteMessage ?? "Retired output"
          : resultOf(input.request)),
      }));
    `,
      { types: { "commonfabric.d.ts": commonfabricTypes }, typeCheck: true },
    );
    const root = parseModule(output);
    const lift = collect(root, ts.isCallExpression).find((node) =>
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "lift"
    );
    expect(lift).toBeDefined();
    expect(literalToValue(lift!.arguments.at(-1)!)).toMatchObject({
      unavailableInputPolicy: [{
        path: ["input", "request"],
        reasons: ["obsolete"],
      }],
    });
    expect(literalToValue(lift!.arguments[1]!)).toMatchObject({
      $defs: { IsObsolete: { type: "FabricUnavailable" } },
    });
  });

  it("accepts explicit obsolete observations on encapsulated plain data", async () => {
    const output = await transformSource(
      `
      import { computed, isObsolete, observeAvailability, pattern, resultOf } from "commonfabric";
      export default pattern((input: { request: string }) => {
        const observed = observeAvailability(input.request, "obsolete");
        return { diagnostic: computed(() => isObsolete(observed)
          ? observed.obsoleteMessage ?? "Retired output"
          : resultOf(observed)) };
      });
    `,
      { types: { "commonfabric.d.ts": commonfabricTypes }, typeCheck: true },
    );
    expect(output).toContain('reasons: ["obsolete"]');
    expect(output).toContain('type: "FabricUnavailable"');
  });
});
