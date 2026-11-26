import { expect } from "@std/expect";
import ts from "typescript";

import { LiftLoweringTransformer } from "../../src/lift/transformer.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";
import { callsNamed, parseModule } from "../transformed-ast.ts";
import { createInMemoryProgram } from "../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

/**
 * Runs only `LiftLoweringTransformer` over `source`, compiled against the
 * commonfabric types without the helper-import prelude the pipeline injects,
 * and returns the printed result.
 */
function lower(source: string): ts.SourceFile {
  const program = createInMemoryProgram({
    "/test.ts": source,
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    "/cfc.ts": COMMONFABRIC_TYPES["cfc.ts"]!,
  }, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
  });
  const sourceFile = program.getSourceFile("/test.ts");
  if (!sourceFile) throw new Error("Expected the test source file");
  const result = ts.transform(sourceFile, [
    new LiftLoweringTransformer({}).toFactory(program),
  ]);
  const printed = ts.createPrinter().printFile(result.transformed[0]!);
  result.dispose();
  return parseModule(printed);
}

describe("transformer", () => {
  describe("LiftLoweringTransformer", () => {
    it("lowers a one-argument `computed` call to an applied `lift`", () => {
      const root = lower(`
import { __cfHelpers } from "commonfabric";
import { computed } from "commonfabric";
export const value = computed(() => 1);
`);

      expect(callsNamed(root, "computed")).toHaveLength(0);
      const lift = callsNamed(root, "lift");
      expect(lift).toHaveLength(1);
      const applied = lift[0]!.parent;
      if (!ts.isCallExpression(applied)) {
        throw new Error("Expected the lift call to be applied");
      }
      expect(applied.arguments.map((arg) => arg.getText(root))).toEqual(["{}"]);
    });

    it("leaves `computed` unlowered in a source without the helper import", () => {
      const root = lower(`
import { computed } from "commonfabric";
export const value = computed(() => 1);
`);

      expect(callsNamed(root, "computed")).toHaveLength(1);
      expect(callsNamed(root, "lift")).toHaveLength(0);
    });

    it("leaves a `computed` call with a second argument unlowered", () => {
      const root = lower(`
import { __cfHelpers } from "commonfabric";
import { computed } from "commonfabric";
export const two = computed(() => 1, 2);
export const one = computed(() => 1);
`);

      const computedCalls = callsNamed(root, "computed");
      expect(computedCalls.map((call) => call.arguments.length)).toEqual([2]);
      expect(callsNamed(root, "lift")).toHaveLength(1);
    });
  });
});
