/**
 * Drives `emitPropertyAccess()` through `rewriteExpression()` on the callee of
 * a call: only an event handler is lifted off the receiver it is called on.
 */
import { expect } from "@std/expect";
import ts from "typescript";

import { TransformationContext } from "../../../../src/core/mod.ts";
import { rewriteExpression } from "../../../../src/transformers/expression-rewrite/mod.ts";
import { COMMONFABRIC_TYPES } from "../../../commonfabric-test-types.ts";
import { createInMemoryProgram } from "../../../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

const SOURCE = `import { __cfHelpers, pattern } from "commonfabric";
interface Row {
  onPick: () => void;
  pick: () => void;
}
export default pattern<{ row: Row }>(({ row }) => {
  row.onPick();
  row.pick();
  return {};
});`;

/** The property access whose name is `name`, as the source spells it. */
function propertyAccess(
  sourceFile: ts.SourceFile,
  name: string,
): ts.PropertyAccessExpression {
  let found: ts.PropertyAccessExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`No \`.${name}\` in the source.`);
  return found;
}

/**
 * What `rewriteExpression()` makes of the `.name` access in {@link SOURCE},
 * printed, or `undefined` when it leaves the access alone.
 */
function rewriteAccess(name: string): string | undefined {
  const program = createInMemoryProgram({
    "/main.ts": SOURCE,
    "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    "/cfc.ts": COMMONFABRIC_TYPES["cfc.ts"]!,
  }, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noLib: true,
  });
  const sourceFile = program.getSourceFile("/main.ts");
  if (!sourceFile) throw new Error("`/main.ts` was not loaded.");
  const expression = propertyAccess(sourceFile, name);

  let printed: string | undefined;
  ts.transform(sourceFile, [(tsContext) => (root) => {
    const context = new TransformationContext({
      program,
      sourceFile,
      tsContext,
    });
    const analyze = context.getDataFlowAnalyzer();
    const result = rewriteExpression({
      expression,
      analysis: analyze(expression),
      context,
      analyze,
      reactiveContextKind: "pattern",
      preferInputBoundWrappers: true,
    });
    printed = result &&
      ts.createPrinter({ removeComments: true })
        .printNode(ts.EmitHint.Unspecified, result, sourceFile)
        .replace(/\s+/g, " ");
    return root;
  }]);
  return printed;
}

describe("emitPropertyAccess()", () => {
  it("lifts an event handler off a reactive value where it is called", () => {
    expect(rewriteAccess("onPick")).toMatch(
      /^__cfHelpers\.lift(<.*>)?\(\(\{ row \}\) => row\.onPick\)\(\{ row: row \}\)$/,
    );
  });

  it("leaves any other method on its receiver where it is called", () => {
    expect(rewriteAccess("pick")).toBeUndefined();
  });
});
