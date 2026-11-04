import { assertThrows } from "@std/assert";
import ts from "typescript";

import { assertValidSyntheticComputeOwnedArrayMethodContext } from "../../src/closures/strategies/array-method-strategy.ts";
import type { ReactiveContextInfo } from "../../src/ast/mod.ts";

function parseMapCall(source: string): {
  methodCall: ts.CallExpression;
  sourceFile: ts.SourceFile;
} {
  const sourceFile = ts.createSourceFile(
    "test.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  let methodCall: ts.CallExpression | undefined;

  const visit = (node: ts.Node): void => {
    if (methodCall) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      methodCall = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!methodCall) {
    throw new Error("expected to find call expression");
  }

  return { methodCall, sourceFile };
}

function createSyntheticComputeLookup(
  sourceFile: ts.SourceFile,
  ownedNodes: readonly ts.Node[],
) {
  const owned = new Set(ownedNodes);
  return {
    sourceFile,
    isSyntheticComputeOwnedNode(node: ts.Node): boolean {
      return owned.has(node);
    },
  };
}

Deno.test(
  "synthetic compute-owned array method context guardrail rejects stale pattern ownership",
  () => {
    const { methodCall, sourceFile } = parseMapCall(
      "const out = sorted.map((item) => item.name);",
    );
    const lookup = createSyntheticComputeLookup(sourceFile, [methodCall]);
    const stalePatternContext: ReactiveContextInfo = {
      kind: "pattern",
      owner: "pattern",
      inJsxExpression: true,
    };

    assertThrows(
      () =>
        assertValidSyntheticComputeOwnedArrayMethodContext(
          methodCall,
          stalePatternContext,
          lookup,
        ),
      Error,
      "synthetic compute-owned array method retained a non-compute context",
    );
  },
);

Deno.test(
  "synthetic compute-owned array method context guardrail allows compute and array-method contexts",
  () => {
    const { methodCall, sourceFile } = parseMapCall(
      "const out = sorted.map((item) => item.name);",
    );
    const lookup = createSyntheticComputeLookup(sourceFile, [methodCall]);
    const computeContext: ReactiveContextInfo = {
      kind: "compute",
      owner: "unknown",
      inJsxExpression: true,
    };
    const arrayMethodContext: ReactiveContextInfo = {
      kind: "pattern",
      owner: "array-method",
      inJsxExpression: true,
    };

    assertValidSyntheticComputeOwnedArrayMethodContext(
      methodCall,
      computeContext,
      lookup,
    );
    assertValidSyntheticComputeOwnedArrayMethodContext(
      methodCall,
      arrayMethodContext,
      lookup,
    );
  },
);

Deno.test(
  "synthetic compute-owned array method context guardrail ignores non-synthetic nodes",
  () => {
    const { methodCall, sourceFile } = parseMapCall(
      "const out = sorted.map((item) => item.name);",
    );
    const lookup = createSyntheticComputeLookup(sourceFile, []);
    const patternContext: ReactiveContextInfo = {
      kind: "pattern",
      owner: "pattern",
      inJsxExpression: false,
    };

    assertValidSyntheticComputeOwnedArrayMethodContext(
      methodCall,
      patternContext,
      lookup,
    );
  },
);
