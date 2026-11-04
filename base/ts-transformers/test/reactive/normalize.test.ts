import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import {
  getRelevantDataFlows,
  normalizeDataFlows,
  selectDataFlowsWithin,
} from "../../src/ast/mod.ts";
import { analyzeExpression } from "./harness.ts";

describe("normalizeDataFlows", () => {
  it("filters data flows within a specific node", () => {
    const { analysis } = analyzeExpression(
      "ifElse(state.count > 3, 'hi', 'bye')",
    );

    const dataFlows = normalizeDataFlows(analysis.graph);
    const predicate =
      analysis.rewriteHint && analysis.rewriteHint.kind === "call-if-else"
        ? analysis.rewriteHint.predicate
        : undefined;
    if (!predicate) {
      throw new Error("Expected predicate hint");
    }

    const filtered = selectDataFlowsWithin(dataFlows, predicate);
    assertEquals(filtered.length, 1);
    const firstDependency = filtered[0];
    assert(
      firstDependency,
      "Expected dataFlow inside predicate",
    );
    assertEquals(firstDependency.expression.getText(), "state.count");
  });

  it("filters ignored params after dropping synthetic map params", () => {
    const { checker, sourceFile } = analyzeExpression(
      "((_ignored: number) => _ignored)(1)",
    );

    const findFirst = <T extends ts.Node>(
      node: ts.Node,
      predicate: (candidate: ts.Node) => candidate is T,
    ): T | undefined => {
      if (predicate(node)) return node;
      return node.forEachChild((child) => findFirst(child, predicate));
    };

    const callback = findFirst(
      sourceFile,
      (node): node is ts.ArrowFunction => ts.isArrowFunction(node),
    );
    assert(callback, "Expected arrow callback");

    const ignoredParam = callback.parameters[0];
    assert(ignoredParam, "Expected ignored parameter");
    assert(ts.isIdentifier(ignoredParam.name), "Expected identifier parameter");

    const ignoredUse = findFirst(
      callback.body,
      (node): node is ts.Identifier =>
        ts.isIdentifier(node) && node.text === "_ignored",
    );
    assert(ignoredUse, "Expected ignored parameter reference");

    const ignoredSymbol = checker.getSymbolAtLocation(ignoredParam.name);
    assert(ignoredSymbol, "Expected ignored parameter symbol");

    const syntheticElement = ts.factory.createIdentifier("element");
    const scope = {
      id: 1,
      parentId: null,
      parameters: [{
        name: "_ignored",
        symbol: ignoredSymbol,
        declaration: ignoredParam,
      }],
    } as const;

    const relevant = getRelevantDataFlows({
      containsReactive: true,
      requiresRewrite: true,
      dataFlows: [syntheticElement, ignoredUse],
      graph: {
        nodes: [{
          id: 1,
          expression: syntheticElement,
          canonicalKey: "1:element",
          parentId: null,
          scopeId: scope.id,
          isExplicit: true,
        }, {
          id: 2,
          expression: ignoredUse,
          canonicalKey: "1:_ignored",
          parentId: null,
          scopeId: scope.id,
          isExplicit: true,
        }],
        scopes: [scope],
        rootScopeId: scope.id,
      },
    }, checker);

    assertEquals(relevant, []);
  });
});
