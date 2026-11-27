import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import ts from "typescript";

import { createLiftAppliedCall } from "../../src/transformers/builtins/lift-applied.ts";
import { CFHelpers } from "../../src/core/cf-helpers.ts";
import { CrossStageState, TransformationContext } from "../../src/core/mod.ts";
import {
  calleeName,
  callsNamed,
  collect,
  parseModule,
} from "../transformed-ast.ts";
import { describe, it, test } from "@commonfabric/test-support/test";

test("createLiftAppliedCall keeps fallback refs synced when names collide", () => {
  const source = ts.createSourceFile(
    "test.tsx",
    "",
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );

  let printed: string | undefined;

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const { factory } = context;

    const cfHelpers = {
      getHelperExpr(name: string) {
        return factory.createPropertyAccessExpression(
          factory.createIdentifier("__cfHelpers"),
          name,
        );
      },
      createHelperCall(
        name: string,
        _originalNode: ts.Node,
        typeArguments: readonly ts.TypeNode[] | undefined,
        argumentsArray: readonly ts.Expression[],
      ) {
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier("__cfHelpers"),
            name,
          ),
          typeArguments,
          argumentsArray,
        );
      },
    } as unknown as CFHelpers;

    // Create a minimal program for type checking
    const program = ts.createProgram(["test.tsx"], {
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    });
    const checker = program.getTypeChecker();

    const transformContext = {
      factory,
      tsContext: context,
      checker,
      sourceFile: source,
      cfHelpers,
      options: {},
      state: new CrossStageState(),
    } as any;

    const rootIdentifier = factory.createIdentifier("_v1");
    // Use a non-parseable expression for the fallback ref. (We previously used
    // `(_v1)` here, but parseCaptureExpression now unwraps non-semantic wrappers
    // including parens, so a parenthesized identifier parses to the same root
    // as the bare identifier and no rename happens. A call expression with a
    // non-`key` callee is reliably non-parseable.)
    const fallbackExpr = factory.createCallExpression(
      factory.createIdentifier("_v1"),
      undefined,
      [],
    );

    const derive = createLiftAppliedCall(fallbackExpr, [
      rootIdentifier,
      fallbackExpr,
    ], {
      factory,
      tsContext: context,
      cfHelpers,
      context: transformContext,
    });

    if (!derive) {
      throw new Error("expected derive call");
    }

    const printer = ts.createPrinter();
    printed = printer.printNode(ts.EmitHint.Unspecified, derive, source);

    return (file) => file;
  };

  ts.transform(source, [transformer]);

  if (!printed) {
    throw new Error("derive call not printed");
  }

  // The colliding fallback binding is renamed: the lift callback destructures
  // `v1__` under the fresh name `_v1_1` and returns that same identifier.
  const root = parseModule(printed);
  const liftCall = callsNamed(root, "lift").at(0);
  assert(liftCall, "expected a lift call");
  const callback = liftCall.arguments[0];
  assert(callback && ts.isArrowFunction(callback), "expected a lift callback");
  const binding = callback.parameters[0]?.name;
  assert(
    binding && ts.isObjectBindingPattern(binding),
    "expected a destructuring parameter",
  );
  const renamed = binding.elements.find((element) =>
    element.propertyName !== undefined &&
    ts.isIdentifier(element.propertyName) &&
    element.propertyName.text === "v1__"
  );
  assert(renamed, "expected a `v1__` binding element");
  assert(ts.isIdentifier(renamed.name));
  assertEquals(renamed.name.text, "_v1_1");
  assert(
    ts.isIdentifier(callback.body) && callback.body.text === "_v1_1",
    "expected the callback body to return the renamed binding",
  );
});

describe("createLiftAppliedCall()", () => {
  /**
   * Calls `createLiftAppliedCall` on the initializer of `const result` in a
   * small program, passing the identifiers named by `refNames` as refs, and
   * returns the printed result.
   */
  function liftOf(refNames: readonly string[]): string | undefined {
    const fileName = "/test.ts";
    const source = `import { __cfHelpers } from "commonfabric";
declare const value: number;
const result = value + 1;
`;
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      strict: true,
      noLib: true,
    };
    const sourceFile = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.ESNext,
      true,
    );
    const host = ts.createCompilerHost(options, true);
    host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
    host.fileExists = (name) => name === fileName;
    const program = ts.createProgram([fileName], options, host);

    let printed: string | undefined;
    const transformer: ts.TransformerFactory<ts.SourceFile> =
      (tsContext) => (file) => {
        const context = new TransformationContext({
          program,
          sourceFile: file,
          tsContext,
          options: { state: new CrossStageState() },
        });
        const declaration = file.statements.filter(ts.isVariableStatement)
          .at(-1)?.declarationList.declarations[0];
        const expression = declaration?.initializer;
        if (!expression || !ts.isBinaryExpression(expression)) {
          throw new Error("Expected `const result = value + 1`");
        }
        const refs = refNames.map((name) => {
          if (!ts.isIdentifier(expression.left)) {
            throw new Error("Expected an identifier operand");
          }
          return name === expression.left.text
            ? expression.left
            : tsContext.factory.createIdentifier(name);
        });
        const call = createLiftAppliedCall(expression, refs, {
          factory: tsContext.factory,
          tsContext,
          cfHelpers: context.cfHelpers,
          context,
        });
        printed = call &&
          ts.createPrinter().printNode(ts.EmitHint.Unspecified, call, file);
        return file;
      };
    ts.transform(sourceFile, [transformer]).dispose();
    return printed;
  }

  it("returns `undefined` for an empty refs array", () => {
    expect(liftOf([])).toBeUndefined();
  });

  it("returns a lift applied to an object holding each ref", () => {
    const printed = liftOf(["value"]);
    if (printed === undefined) throw new Error("Expected a lift call");

    const root = parseModule(printed);
    const applied = collect(root, ts.isCallExpression).find((call) =>
      ts.isCallExpression(call.expression) &&
      calleeName(call.expression) === "lift"
    );
    expect(applied?.arguments.map((arg) => arg.getText(root))).toEqual([
      "{ value: value }",
    ]);
  });
});
