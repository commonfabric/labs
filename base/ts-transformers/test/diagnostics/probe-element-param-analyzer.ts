/**
 * Phase 1 instrumentation probe.
 *
 * For each `arr.map((p, ...) => …)` callback in fixture inputs, asks the
 * dataflow analyzer what it currently reports for every read of `p`, `p.x`,
 * `p.x.y`, etc. inside the callback body. This captures the analyzer's
 * blind spot before the Phase 2 fix: any line where `containsReactive=false`
 * for a `p.foo`-style access is a place where the analyzer fails to recognize
 * the read as reactive.
 *
 * Usage (from base/ts-transformers):
 *   deno run -A test/probe-element-param-analyzer.ts          # all fixtures
 *   deno run -A test/probe-element-param-analyzer.ts <glob>   # subset
 *
 * Output: tab-separated lines on stdout, plus a summary on stderr.
 *
 * THIS IS NOT A TEST. It does not assert anything. It is a one-shot diagnostic
 * tool used during the Phase 1 investigation. Safe to delete after Phase 2.
 */

import { walk } from "@std/fs";
import { join } from "@std/path";

import ts from "typescript";

import { createDataFlowAnalyzer } from "../../src/ast/dataflow.ts";
import { batchTypeCheckFixtures } from "../utils.ts";

interface Probe {
  fixture: string;
  callbackLine: number;
  paramName: string;
  accessText: string;
  accessKind: "identifier-only" | "property-access";
  inJsx: boolean;
  inMethodCall: boolean;
  typeText: string;
  containsReactive: boolean;
  requiresRewrite: boolean;
  dataFlowsLength: number;
  reactiveMap: boolean;
}

/**
 * Heuristic: the corresponding .expected fixture mentions `mapWithPattern` or
 * `filterWithPattern` etc., meaning the pipeline considered this map reactive.
 * Crude — collapses across all maps in a file — but enough to separate true
 * positives (silent on a reactive map) from false positives (silent on a plain
 * array map, which is correct).
 */
async function fixtureHasReactiveMapLowering(
  inputPath: string,
): Promise<boolean> {
  const expectedPath = inputPath
    .replace(/\.input\.tsx$/, ".expected.jsx")
    .replace(/\.input\.ts$/, ".expected.js");
  try {
    const text = await Deno.readTextFile(
      join(FIXTURE_ROOT, expectedPath.replace(/^\//, "")),
    );
    return /\b(mapWithPattern|filterWithPattern|flatMapWithPattern)\b/.test(
      text,
    );
  } catch {
    return false;
  }
}

const FIXTURE_ROOT = join(import.meta.dirname!, "..", "fixtures");

async function loadAllFixtureSources(
  match?: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const entry of walk(FIXTURE_ROOT, { exts: [".tsx", ".ts"] })) {
    if (!entry.isFile) continue;
    if (
      !entry.name.endsWith(".input.tsx") && !entry.name.endsWith(".input.ts")
    ) {
      continue;
    }
    const rel = entry.path.slice(FIXTURE_ROOT.length + 1);
    if (match && !rel.includes(match)) continue;
    out["/" + rel] = await Deno.readTextFile(entry.path);
  }
  return out;
}

function findArrayMapCallbacks(
  sourceFile: ts.SourceFile,
): Array<{
  callbackParam: ts.ParameterDeclaration;
  paramName: string;
  body: ts.ConciseBody;
  callbackLine: number;
}> {
  const out: Array<{
    callbackParam: ts.ParameterDeclaration;
    paramName: string;
    body: ts.ConciseBody;
    callbackLine: number;
  }> = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      ["map", "filter", "flatMap"].includes(node.expression.name.text)
    ) {
      const callback = node.arguments[0];
      if (
        callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      ) {
        const param = callback.parameters[0];
        if (param && ts.isIdentifier(param.name)) {
          const lineCol = sourceFile.getLineAndCharacterOfPosition(
            callback.getStart(sourceFile),
          );
          out.push({
            callbackParam: param,
            paramName: param.name.text,
            body: callback.body,
            callbackLine: lineCol.line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return out;
}

function findElementParamAccesses(
  body: ts.ConciseBody,
  paramSymbol: ts.Symbol | undefined,
  paramName: string,
  checker: ts.TypeChecker,
): Array<{
  expression: ts.Expression;
  accessKind: "identifier-only" | "property-access";
  inJsx: boolean;
  inMethodCall: boolean;
}> {
  const out: Array<{
    expression: ts.Expression;
    accessKind: "identifier-only" | "property-access";
    inJsx: boolean;
    inMethodCall: boolean;
  }> = [];
  const seen = new WeakSet<ts.Node>();

  const isReceiverOfMethodCall = (
    expr: ts.PropertyAccessExpression,
  ): boolean => {
    const parent = expr.parent;
    return ts.isCallExpression(parent) && parent.expression === expr;
  };

  const isInsideJsx = (node: ts.Node): boolean => {
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
      if (ts.isJsxExpression(cur) || ts.isJsxAttribute(cur)) return true;
      if (ts.isFunctionLike(cur)) return false;
      cur = cur.parent;
    }
    return false;
  };

  const isElementParamRoot = (id: ts.Identifier): boolean => {
    if (id.text !== paramName) return false;
    if (paramSymbol) {
      const sym = checker.getSymbolAtLocation(id);
      if (sym && sym !== paramSymbol) return false;
    }
    return true;
  };

  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;

    if (ts.isPropertyAccessExpression(node)) {
      // Walk to the leftmost identifier
      let cur: ts.Expression = node;
      while (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
      if (ts.isIdentifier(cur) && isElementParamRoot(cur)) {
        // Only record the topmost access (avoid recording p.a then p.a.b
        // separately as two duplicate base records).
        const parent = node.parent;
        const isReceiverForLongerAccess =
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node;
        if (!isReceiverForLongerAccess && !seen.has(node)) {
          seen.add(node);
          out.push({
            expression: node,
            accessKind: "property-access",
            inJsx: isInsideJsx(node),
            inMethodCall: isReceiverOfMethodCall(node),
          });
        }
      }
    } else if (ts.isIdentifier(node) && isElementParamRoot(node)) {
      // Bare identifier reference, but skip those that are part of a property
      // access (already handled) or property names (left of dot).
      const parent = node.parent;
      const partOfPropertyAccess = ts.isPropertyAccessExpression(parent) &&
        parent.expression === node;
      const isPropertyName = ts.isPropertyAccessExpression(parent) &&
        parent.name === node;
      const isParamDecl = ts.isParameter(parent);
      if (!partOfPropertyAccess && !isPropertyName && !isParamDecl) {
        if (!seen.has(node)) {
          seen.add(node);
          out.push({
            expression: node,
            accessKind: "identifier-only",
            inJsx: isInsideJsx(node),
            inMethodCall: false,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return out;
}

async function main() {
  const matchArg = Deno.args[0];

  const sources = await loadAllFixtureSources(matchArg);
  const fixtureCount = Object.keys(sources).length;
  if (fixtureCount === 0) {
    console.error(
      `No fixtures matched ${matchArg ?? "(all)"}. Looked in ${FIXTURE_ROOT}`,
    );
    Deno.exit(2);
  }
  console.error(`Loaded ${fixtureCount} fixture(s).`);

  // Build one program containing every fixture as a separate file. This is
  // expensive but only happens once.
  const { program } = await batchTypeCheckFixtures(sources, {});
  const checker = program.getTypeChecker();
  const analyze = createDataFlowAnalyzer(checker);

  // Header (TSV).
  console.log(
    [
      "fixture",
      "cb_line",
      "param",
      "kind",
      "in_jsx",
      "in_method_call",
      "access",
      "type",
      "opaque",
      "requires_rewrite",
      "dataflows",
      "reactive_map",
    ].join("\t"),
  );

  let totalProbes = 0;
  let analyzerSilent = 0;
  let analyzerSilentNonJsx = 0;
  let analyzerSilentOnReactiveMap = 0;

  for (const fileName of Object.keys(sources)) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) continue;

    const reactiveMap = await fixtureHasReactiveMapLowering(fileName);

    const callbacks = findArrayMapCallbacks(sourceFile);
    for (const cb of callbacks) {
      const paramSymbol = checker.getSymbolAtLocation(cb.callbackParam.name);
      const accesses = findElementParamAccesses(
        cb.body,
        paramSymbol,
        cb.paramName,
        checker,
      );
      for (const acc of accesses) {
        let typeText = "?";
        try {
          const t = checker.getTypeAtLocation(acc.expression);
          typeText = checker.typeToString(t).slice(0, 60);
        } catch (_) {
          // best effort
        }

        let analysis;
        try {
          analysis = analyze(acc.expression);
        } catch (_) {
          analysis = {
            containsReactive: false,
            requiresRewrite: false,
            dataFlows: [],
          };
        }

        totalProbes++;
        const silent = !analysis.containsReactive &&
          !analysis.requiresRewrite;
        if (silent) {
          analyzerSilent++;
          if (!acc.inJsx) analyzerSilentNonJsx++;
          if (reactiveMap) analyzerSilentOnReactiveMap++;
        }

        const accessText = acc.expression
          .getText(sourceFile)
          .replace(/\s+/g, " ")
          .slice(0, 80);

        console.log(
          [
            fileName.replace(/^\//, "").replace(/^.*?fixtures\//, ""),
            cb.callbackLine,
            cb.paramName,
            acc.accessKind,
            acc.inJsx ? "y" : "n",
            acc.inMethodCall ? "y" : "n",
            accessText,
            typeText,
            analysis.containsReactive ? "y" : "n",
            analysis.requiresRewrite ? "y" : "n",
            analysis.dataFlows.length,
            reactiveMap ? "y" : "n",
          ].join("\t"),
        );
      }
    }
  }

  console.error("");
  console.error("=== summary ===");
  console.error(`total element-param accesses probed: ${totalProbes}`);
  console.error(
    `analyzer reported nothing (no opaque, no rewrite): ${analyzerSilent}`,
  );
  console.error(
    `  ...of which were NOT inside JSX:                ${analyzerSilentNonJsx}`,
  );
  console.error(
    `  ...of which were in a reactive-map fixture:     ${analyzerSilentOnReactiveMap}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    Deno.exit(1);
  });
}
