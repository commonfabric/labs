import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { validateSource } from "../utils.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { calleeName, parseModule } from "../transformed-ast.ts";

/**
 * The callee names of the calls that initialize the module-scope `__cfLift_N`
 * declarations in `output`, in source order.
 */
function hoistedLiftCallees(output: string): (string | undefined)[] {
  const callees: (string | undefined)[] = [];
  for (const statement of parseModule(output).statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.name.text.startsWith("__cfLift_")
      ) {
        continue;
      }
      const initializer = declaration.initializer;
      callees.push(
        initializer && ts.isCallExpression(initializer)
          ? calleeName(initializer)
          : undefined,
      );
    }
  }
  return callees;
}

/** Transforms a pattern whose `computed()` calls an over-applied `lift()`. */
async function transformOverAppliedLift(): Promise<string> {
  const { diagnostics, output } = await validateSource(
    `
      import { computed, lift, pattern } from "commonfabric";

      export default pattern<{ n: number }>(({ n }) => ({
        v: computed(() => lift((a: number) => () => a)(n)()),
      }));
    `,
    { types: COMMONFABRIC_TYPES },
  );
  expect(diagnostics).toEqual([]);
  return output;
}

describe("builder-call-hoisting", () => {
  describe("an over-applied `lift()` call", () => {
    // In `lift(cb)(n)()` only `lift(cb)(n)` applies the factory; the outer
    // call is a call of what that application returned. A hoist of that outer
    // application would move `__cfLift_1(n)` to module scope, where `n` is not
    // bound.

    it("hoists the `lift()` factory call", async () => {
      const output = await transformOverAppliedLift();

      expect(hoistedLiftCallees(output)).toContain("lift");
    });

    it("hoists no call of another hoisted lift", async () => {
      const output = await transformOverAppliedLift();

      expect(
        hoistedLiftCallees(output).filter((callee) =>
          callee?.startsWith("__cfLift_")
        ),
      ).toEqual([]);
    });
  });
});
