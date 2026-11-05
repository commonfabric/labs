/// <reference lib="deno.unstable" />

// Forbids bare `node.getText()` (called with no SourceFile argument) in the
// transformer source.
//
// `ts.Node.getText()` reads the node's source positions, which are absent on
// synthetic nodes the transformer creates — so it throws at runtime on them.
// Use `getNodeText()` / `getExpressionText()` from `src/ast/utils.ts`, which
// print synthetic nodes instead. The `getText(sourceFile)` form is left alone:
// that is the sanctioned wrapper's own call.
//
// Test files are exempt: they assert against source parsed in the test, whose
// nodes always carry real positions, so `getText()` is safe and idiomatic there.
interface LintContext {
  readonly filename: string;
  report(report: { node: unknown; message: string }): void;
}

interface LintCallExpression {
  readonly callee: {
    readonly type: string;
    readonly computed?: boolean;
    readonly property?: {
      readonly type: string;
      readonly name?: string;
    };
  };
  readonly arguments: readonly unknown[];
}

export default {
  name: "cf-ts-transformers",
  rules: {
    "no-node-get-text": {
      create(context) {
        const localContext = context as unknown as LintContext;
        if (localContext.filename.includes("/test/")) {
          return {};
        }
        return {
          CallExpression(node) {
            const localNode = node as unknown as LintCallExpression;
            const callee = localNode.callee;
            if (
              callee.type === "MemberExpression" &&
              !callee.computed &&
              callee.property &&
              callee.property.type === "Identifier" &&
              callee.property.name === "getText" &&
              localNode.arguments.length === 0
            ) {
              localContext.report({
                node,
                message:
                  "Bare node.getText() throws on synthetic AST nodes. Use " +
                  "getNodeText()/getExpressionText() from ast/utils.ts, or pass " +
                  "a SourceFile.",
              });
            }
          },
        };
      },
    },
  },
} satisfies Deno.lint.Plugin;
