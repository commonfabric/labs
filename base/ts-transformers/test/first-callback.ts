import ts from "typescript";

import {
  analyzeFunctionCapabilities,
  type MergeablePushMisuse,
} from "../src/policy/mod.ts";

/** The first arrow function or function expression in `source`. */
export function parseFirstCallback(
  source: string,
): ts.ArrowFunction | ts.FunctionExpression {
  const file = ts.createSourceFile(
    "/test.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  let callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (callback) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      callback = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  if (!callback) {
    throw new Error("Expected a callback expression in test source.");
  }

  return callback;
}

/**
 * The mergeable-push misuses `analyzeFunctionCapabilities()` reports for the
 * first callback in `source`.
 */
export function collectMergeablePushMisuses(
  source: string,
): MergeablePushMisuse[] {
  const findings: MergeablePushMisuse[] = [];
  analyzeFunctionCapabilities(parseFirstCallback(source), {
    mergeablePushMisuseSink: (finding) => findings.push(finding),
  });
  return findings;
}
