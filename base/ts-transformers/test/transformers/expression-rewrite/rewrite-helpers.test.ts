import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { isArrayMethodReceiverExpression } from "../../../src/transformers/expression-rewrite/rewrite-helpers.ts";

describe("rewrite-helpers", () => {
  describe("isArrayMethodReceiverExpression()", () => {
    const sourceFile = ts.createSourceFile(
      "/test.ts",
      `const mapped = (xs as number[]).map((x) => x);
const length = ys.length;`,
      ts.ScriptTarget.ES2020,
      true,
    );

    /** The first node in the module whose text is `text`. */
    function nodeWithText(text: string): ts.Node {
      let found: ts.Node | undefined;
      const visit = (node: ts.Node): void => {
        if (!found && node.getText(sourceFile) === text) found = node;
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      if (!found) throw new Error(`no node \`${text}\``);
      return found;
    }

    it("returns `true` for a receiver behind wrappers", () => {
      expect(isArrayMethodReceiverExpression(nodeWithText("xs"))).toBe(true);
    });

    it("returns `false` for the type a wrapper asserts", () => {
      expect(isArrayMethodReceiverExpression(nodeWithText("number[]")))
        .toBe(false);
    });

    it("returns `false` for the receiver of a property read", () => {
      expect(isArrayMethodReceiverExpression(nodeWithText("ys"))).toBe(false);
    });
  });
});
