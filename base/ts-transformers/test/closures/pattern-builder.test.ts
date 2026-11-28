import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import { CrossStageState, TransformationContext } from "../../src/core/mod.ts";
import type { CaptureTreeNode } from "../../src/utils/capture-tree.ts";
import { PatternBuilder } from "../../src/closures/utils/pattern-builder.ts";
import { collect, parseModule } from "../transformed-ast.ts";
import { test } from "@commonfabric/test-support/test";

function createProgramAndContext(source: string): {
  sourceFile: ts.SourceFile;
  context: TransformationContext;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  const context = new TransformationContext({
    program,
    sourceFile,
    tsContext: { factory: ts.factory } as ts.TransformationContext,
    options: {
      state: new CrossStageState(),
    },
  });

  return { sourceFile, context };
}

function findFirstNode<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  predicate: (node: ts.Node) => node is T,
): T {
  let found: T | undefined;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error("Expected node not found");
  }

  return found;
}

test("PatternBuilder avoids capture collisions with nested explicit bindings", () => {
  const { sourceFile, context } = createProgramAndContext(`
    const callback = ({ isExpanded }) => !isExpanded;
  `);
  const originalCallback = findFirstNode(sourceFile, ts.isArrowFunction);
  const originalParam = originalCallback.parameters[0];
  if (!originalParam) {
    throw new Error("Expected callback parameter");
  }

  const captureTree = new Map<string, CaptureTreeNode>([
    ["isExpanded", { properties: new Map(), path: [] }],
  ]);

  const rebuilt = new PatternBuilder(context)
    .addParameter("input", originalParam.name, "input")
    .setCaptureTree(captureTree)
    .buildCallback(originalCallback, originalCallback.body, null, null);

  const printer = ts.createPrinter();
  const printed = printer.printNode(
    ts.EmitHint.Unspecified,
    rebuilt,
    sourceFile,
  );

  // The nested explicit `isExpanded` binding forces the captured `isExpanded`
  // to be rebound under the fresh name `isExpanded_1`.
  const root = parseModule(printed);
  const renamed = collect(root, ts.isBindingElement).find((element) =>
    element.propertyName !== undefined &&
    ts.isIdentifier(element.propertyName) &&
    element.propertyName.text === "isExpanded" &&
    ts.isIdentifier(element.name)
  );
  assert(renamed, "expected an `isExpanded` binding element to be renamed");
  assert(ts.isIdentifier(renamed.name));
  assertEquals(renamed.name.text, "isExpanded_1");
});

function printHandlerCallback(
  source: string,
  captureNames: readonly string[],
): string {
  const { sourceFile, context } = createProgramAndContext(source);
  const originalCallback = findFirstNode(sourceFile, ts.isArrowFunction);
  const captureTree = new Map<string, CaptureTreeNode>(
    captureNames.map((name) => [name, { properties: new Map(), path: [] }]),
  );
  const rebuilt = new PatternBuilder(context)
    .setCaptureTree(captureTree)
    .buildHandlerCallback(
      originalCallback,
      originalCallback.body,
      "__event",
      "__params",
    );
  return ts.createPrinter().printNode(
    ts.EmitHint.Unspecified,
    rebuilt,
    sourceFile,
  );
}

test("PatternBuilder handler callback keeps the authored event and destructures captures as params", () => {
  assertEquals(
    printHandlerCallback(`const cb = (e) => count.set(e);`, ["count"]),
    "(e, { count }) => count.set(e)",
  );
  // Without captures, params is a plain identifier named by the caller.
  assertEquals(
    printHandlerCallback(`const cb = (e) => log(e);`, []),
    "(e, __params) => log(e)",
  );
});

test("PatternBuilder handler callback names a missing event parameter apart from the captures", () => {
  assertEquals(
    printHandlerCallback(`const cb = () => count.set(1);`, ["count"]),
    "(__event, { count }) => count.set(1)",
  );
  assertEquals(
    printHandlerCallback(`const cb = () => __event.set(1);`, ["__event"]),
    "(__event_1, { __event }) => __event.set(1)",
  );
});
