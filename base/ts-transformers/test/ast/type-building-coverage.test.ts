import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import ts from "typescript";

import {
  buildCaptureTypeElements,
  reportUnknownReactiveType,
  shouldPreserveBindingDeclaredTypeNode,
} from "../../src/ast/type-building.ts";
import { TransformationContext } from "../../src/core/mod.ts";
import {
  type CaptureTreeNode,
  createCaptureTreeNode,
} from "../../src/utils/capture-tree.ts";
import { collect, parseModule } from "../transformed-ast.ts";

/**
 * Reparse a printed capture-type literal and return its members keyed by name,
 * each carrying its optional flag and the printed text of its declared type.
 * Asserting on these AST-derived members is stronger than substring-matching
 * the printed text: an optional token and a member type are pinned exactly.
 */
function typeLiteralProps(printed: string): Map<
  string,
  { optional: boolean; type: string }
> {
  const decl = collect(
    parseModule(`type __T = ${printed};`),
    ts.isTypeAliasDeclaration,
  )[0];
  if (!decl) throw new Error(`Could not parse type literal: ${printed}`);
  const out = new Map<string, { optional: boolean; type: string }>();
  for (const signature of collect(decl.type, ts.isPropertySignature)) {
    const name = ts.isIdentifier(signature.name)
      ? signature.name.text
      : signature.name.getText(decl.getSourceFile());
    out.set(name, {
      optional: !!signature.questionToken,
      type: signature.type ? signature.type.getText(decl.getSourceFile()) : "",
    });
  }
  return out;
}

function createProgram(fileName: string, sourceText: string) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const options: ts.CompilerOptions = {
    noLib: true,
    strict: true,
    target: ts.ScriptTarget.ES2020,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => name === fileName,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.d.ts",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (name) => name === fileName ? sourceFile : undefined,
    readFile: (name) => name === fileName ? sourceText : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  return {
    program: ts.createProgram([fileName], options, host),
    sourceFile,
  };
}

/** Run `body` with a TransformationContext wired to a throwaway program. */
function withContext(
  sourceText: string,
  body: (context: TransformationContext, sourceFile: ts.SourceFile) => void,
): void {
  const { program, sourceFile } = createProgram("capture.ts", sourceText);
  let tsContext!: ts.TransformationContext;
  const transformed = ts.transform(sourceFile, [
    (context) => {
      tsContext = context;
      return (node) => node;
    },
  ]);
  try {
    const context = new TransformationContext({
      program,
      sourceFile,
      tsContext,
    });
    body(context, sourceFile);
  } finally {
    transformed.dispose();
  }
}

function findPropertyAccess(
  sourceFile: ts.SourceFile,
  memberName: string,
): ts.PropertyAccessExpression {
  let found: ts.PropertyAccessExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === memberName) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error(`Property access .${memberName} not found`);
  return found;
}

//
// shouldPreserveBindingDeclaredTypeNode
//

Deno.test("shouldPreserveBindingDeclaredTypeNode: unwraps parentheses to find a preserved Default alias", () => {
  const factory = ts.factory;
  // `(Default<string>)` — the parenthesized-unwrap loop must strip the parens
  // before the Default-alias name check succeeds.
  const node = factory.createParenthesizedType(
    factory.createTypeReferenceNode("Default", [
      factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
    ]),
  );
  assertEquals(shouldPreserveBindingDeclaredTypeNode(node), true);
});

Deno.test("shouldPreserveBindingDeclaredTypeNode: strips nested parentheses around a Writable of a preserved type", () => {
  const factory = ts.factory;
  // `((Writable<Default<string>>))` — two layers of parentheses exercise the
  // while-loop, and Writable is preserved only because its argument is itself
  // a preserved type.
  const node = factory.createParenthesizedType(
    factory.createParenthesizedType(
      factory.createTypeReferenceNode("Writable", [
        factory.createTypeReferenceNode("Default", [
          factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ]),
      ]),
    ),
  );
  assertEquals(shouldPreserveBindingDeclaredTypeNode(node), true);
});

Deno.test("shouldPreserveBindingDeclaredTypeNode: a Writable of a plain type is not preserved", () => {
  const factory = ts.factory;
  // `Writable<string>` — Writable is preserved only when an argument is itself
  // preservable; a plain `string` argument is not.
  const node = factory.createTypeReferenceNode("Writable", [
    factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
  ]);
  assertEquals(shouldPreserveBindingDeclaredTypeNode(node), false);
});

Deno.test("shouldPreserveBindingDeclaredTypeNode: a union containing a scope wrapper is preserved", () => {
  const factory = ts.factory;
  // A union whose members are walked; `PerSpace<string>` triggers preservation.
  const node = factory.createUnionTypeNode([
    factory.createTypeReferenceNode("PerSpace", [
      factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
    ]),
    factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
  ]);
  assertEquals(shouldPreserveBindingDeclaredTypeNode(node), true);
});

//
// reportUnknownReactiveType / describeCapture
//

Deno.test("reportUnknownReactiveType: an unknown-typed capture with no printable text falls back to the label", () => {
  // The capture expression prints to empty text, so describeCapture returns the
  // supplied label; the reported diagnostic message embeds that label.
  withContext(`declare const value: unknown; value;`, (context, sourceFile) => {
    const captured: Array<{ type: string; message: string }> = [];
    (context as unknown as {
      reportDiagnosticOnce: (d: { type: string; message: string }) => void;
    }).reportDiagnosticOnce = (d) => captured.push(d);

    let unknownExpr: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) unknownExpr = node.expression;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const unknownType = context.checker.getTypeAtLocation(unknownExpr!);

    // A synthetic identifier with empty text prints to nothing.
    const emptyTextExpr = ts.factory.createIdentifier("");
    reportUnknownReactiveType(
      context,
      emptyTextExpr,
      unknownType,
      "captureLabel",
    );

    assertEquals(captured.length, 1);
    assertEquals(captured[0].type, "reactive-capture:unknown-type");
    assertStringIncludes(captured[0].message, "captureLabel");
  });
});

Deno.test("reportUnknownReactiveType: a non-unknown capture is not reported", () => {
  withContext(`declare const value: string; value;`, (context, sourceFile) => {
    let reported = 0;
    (context as unknown as {
      reportDiagnosticOnce: (d: unknown) => void;
    }).reportDiagnosticOnce = () => reported++;

    let expr: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) expr = node.expression;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    reportUnknownReactiveType(
      context,
      ts.factory.createIdentifier("value"),
      context.checker.getTypeAtLocation(expr!),
      "label",
    );
    assertEquals(reported, 0);
  });
});

//
// buildCaptureTypeElements: intermediate nodes
//

Deno.test("buildCaptureTypeElements: an optional intermediate property is emitted with a question token", () => {
  // `config.nested.value` where `nested?: Nested` on `Config`. The intermediate
  // `nested` node is looked up on the parent (Config) type, and its optional
  // flag drives the emitted `nested?` question token.
  const source = `
    interface Nested { value: string; }
    interface Config { nested?: Nested; }
    function collect(config: Config) {
      return [config.nested.value];
    }
  `;
  withContextEmit(source, (context, sourceFile) => {
    const valueExpr = findPropertyAccess(sourceFile, "value");
    const root = createCaptureTreeNode([]);
    const nested = createCaptureTreeNode(["nested"]);
    const valueLeaf = createCaptureTreeNode(["nested", "value"]);
    valueLeaf.expression = valueExpr;
    nested.properties.set("value", valueLeaf);
    root.properties.set("nested", nested);

    const elements = buildCaptureTypeElements(
      new Map<string, CaptureTreeNode>([["config", root]]),
      context,
    );
    const printed = ts.createPrinter().printNode(
      ts.EmitHint.Unspecified,
      ts.factory.createTypeLiteralNode(elements),
      sourceFile,
    );
    const members = typeLiteralProps(printed);
    assertEquals(members.get("nested")?.optional, true);
    assertEquals(members.get("value")?.type, "string");
  });
});

Deno.test("buildCaptureTypeElements: a required intermediate property has no question token, resolving its type from the root identifier", () => {
  // `config.nested.value` where `nested: Nested` (required). The root `config`
  // entry has no parent type, so its type is recovered from the root identifier
  // via the descendant-expression search; the required `nested` gets no `?`.
  const source = `
    interface Nested { value: string; }
    interface Config { nested: Nested; }
    function collect(config: Config) {
      return [config.nested.value];
    }
  `;
  withContextEmit(source, (context, sourceFile) => {
    const valueExpr = findPropertyAccess(sourceFile, "value");
    const root = createCaptureTreeNode([]);
    const nested = createCaptureTreeNode(["nested"]);
    const valueLeaf = createCaptureTreeNode(["nested", "value"]);
    valueLeaf.expression = valueExpr;
    nested.properties.set("value", valueLeaf);
    root.properties.set("nested", nested);

    const elements = buildCaptureTypeElements(
      new Map<string, CaptureTreeNode>([["config", root]]),
      context,
    );
    const printed = ts.createPrinter().printNode(
      ts.EmitHint.Unspecified,
      ts.factory.createTypeLiteralNode(elements),
      sourceFile,
    );
    const members = typeLiteralProps(printed);
    // The required `nested` intermediate is emitted without a question token,
    // and resolves to an object literal carrying its `value` leaf.
    assertEquals(members.get("nested")?.optional, false);
    assertEquals(members.get("value")?.type, "string");
  });
});

Deno.test("buildCaptureTypeElements: an intermediate node with neither expression nor children throws the invariant error", () => {
  // A capture tree node that is neither a leaf (has an expression) nor an
  // interior node (has children) violates the tree invariant.
  withContextEmit(`function f(x: number) { return x; } f;`, (context) => {
    const root = createCaptureTreeNode([]);
    const emptyChild = createCaptureTreeNode(["a"]);
    root.properties.set("a", emptyChild);

    assertThrows(
      () =>
        buildCaptureTypeElements(
          new Map<string, CaptureTreeNode>([["root", root]]),
          context,
        ),
      Error,
      "Invariant violated",
    );
  });
});

/** Same as withContext but named to make the emit-oriented tests read clearly. */
function withContextEmit(
  sourceText: string,
  body: (context: TransformationContext, sourceFile: ts.SourceFile) => void,
): void {
  withContext(sourceText, body);
}
