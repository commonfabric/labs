/**
 * Verifies authored source-map ranges on synthesized replacements outside the
 * builder-artifact path.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import ts from "typescript";

import { recoverAuthoredPosition } from "../src/ast/mod.ts";
import {
  CFC_TRANSFORMER_STAGE_NAMES,
  CommonFabricTransformerPipeline,
} from "../src/cf-pipeline.ts";
import { TransformationContext } from "../src/core/mod.ts";
import { createReactiveWrapperForExpression } from "../src/transformers/expression-rewrite/rewrite-helpers.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { batchTypeCheckFixtures } from "./utils.ts";

const ROUTER_FIXTURE = `import {
  Default,
  pattern,
  UI,
  UiAction,
  UiPromptSlot,
} from "commonfabric";

interface Input {
  visible: boolean | Default<false>;
  count: number | Default<0>;
}

export default pattern<Input>((state) => ({
  [UI]: (
    <div>
      <UiAction action="CT1869_UI">run</UiAction>
      <UiPromptSlot surface="CT1869_SURFACE" role="composer" />
      <span>
        {state.visible
          ? (() => {
            const message = state.count + " CT1869_PRE";
            return <b>{message}</b>;
          })()
          : <i>hidden</i>}
      </span>
    </div>
  ),
}));
`;

const OWNED_ROUTER_FIXTURE = `import {
  ifElse,
  pattern,
  UI,
} from "commonfabric";

interface Input {
  visible: boolean;
  count: number;
}

export default pattern<Input>((state) => ({
  [UI]: <span>{ifElse(state.visible, state.count + 1869, 0)}</span>,
}));
`;

const CLOSURE_FIXTURE = `import {
  Default,
  pattern,
  UI,
} from "commonfabric";

interface Input {
  count: number | Default<0>;
  groups: {
    rows: Array<{ title: string }>;
  };
}

export default pattern<Input>((state) => ({
  [UI]: (
    <div>
      <button onClick={() => state.count + 1869}>run</button>
      <ul>
        {state.groups.rows.map((row) => (
          <li>{row.title === "x" ? "CT1869_MAP" : row.title}</li>
        ))}
      </ul>
    </div>
  ),
}));
`;

const POST_CLOSURE_FIXTURE = `import {
  pattern,
  UI,
} from "commonfabric";

interface Input {
  items: Array<{ ct1869Active: boolean }>;
}

export default pattern<Input>((state) => ({
  [UI]: (
    <span>
      {state.items.filter((item) => item.ct1869Active).length > 0}
    </span>
  ),
}));
`;

const ZERO_INPUT_FIXTURE = `import {
  Default,
  pattern,
} from "commonfabric";

interface Input {
  items: string[] | Default<[]>;
  index: number | Default<0>;
}

export default pattern<Input>((state) => {
  const picked = state.items[state.index] + "CT1869_ZERO";
  return { picked };
});
`;

const PATTERN_BODY_FIXTURE = `import {
  pattern,
} from "commonfabric";

interface Input {
  profile: { label: string };
}

export default pattern<Input>((state) => {
  const label = state.profile.label;
  return { label };
});
`;

const MODULE_DATA_FIXTURE = `import {
  pattern,
} from "commonfabric";

const DATA = { marker: "CT1869_DATA" };

export default pattern(() => ({ DATA }));
`;

const OPAQUE_DESTRUCTURE_FIXTURE = `import {
  fetchText,
  pattern,
} from "commonfabric";

interface Input {
  profile: { label: string };
}

export default pattern<Input>(({ profile: { label: ctLabel } }) => {
  const {
    pending: ctPending,
    result: ctResult,
  } = fetchText({ url: "CT1869_DESTRUCTURE" });
  return { ctLabel, ctPending, ctResult };
});
`;

const ASSERT_DIAGNOSTICS_FIXTURE = `import {
  assert,
  pattern,
} from "commonfabric";

interface Input {
  count: number;
}

export default pattern<Input>((state) => {
  const concise = assert(() => state.count > 0);
  const branched = assert(() => {
    if (state.count > 10) return state.count < 20;
    return state.count === 1;
  });
  return { concise, branched };
});
`;

const CONDITIONAL_HELPER_FIXTURE = `import {
  pattern,
} from "commonfabric";

interface Input {
  count: number;
  visible: boolean;
}

export default pattern<Input>((state) => {
  const shown = state.visible && state.count;
  const fallback = state.visible || state.count;
  const selected = state.visible ? state.count : 0;
  return { shown, fallback, selected };
});
`;

interface StageTransformResult {
  readonly original: ts.SourceFile;
  readonly transformed: ts.SourceFile;
}

/** Runs a fixture through the named stage while preserving emit-node data. */
async function transformThroughStage(
  source: string,
  fileName: string,
  stageName: string,
): Promise<StageTransformResult> {
  const { program } = await batchTypeCheckFixtures(
    { [fileName]: source },
    { types: COMMONFABRIC_TYPES },
  );
  const original = program.getSourceFile(fileName);
  assert(original, `fixture source file present: ${fileName}`);

  const stageIndex = CFC_TRANSFORMER_STAGE_NAMES.indexOf(stageName);
  assert(stageIndex >= 0, `transformer stage present: ${stageName}`);

  const pipeline = new CommonFabricTransformerPipeline();
  const factories = pipeline.toFactories(program).slice(0, stageIndex + 1);
  const result = ts.transform(original, factories);
  const transformed = result.transformed[0];
  assert(transformed, `stage returned a transformed source file: ${stageName}`);

  // Disposing the result can clear emit-node data that stores sourceMapRange.
  return { original, transformed };
}

/** Collects every node in a tree that satisfies the supplied type guard. */
function collectNodes<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

/** Returns whether a subtree contains a node satisfying the predicate. */
function subtreeContains(
  root: ts.Node,
  predicate: (node: ts.Node) => boolean,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Selects the only node matching a structural predicate. */
function findOnly<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
  label: string,
): T {
  const matches = collectNodes(root, predicate);
  expect(matches, label).toHaveLength(1);
  return matches[0]!;
}

/** Asserts that a replacement resolves to the expected authored source. */
function expectAuthoredText(
  node: ts.Node,
  original: ts.SourceFile,
  expected: string,
): void {
  assert(node.pos < 0, `expected a synthesized replacement for ${expected}`);
  const position = recoverAuthoredPosition(node);
  assert(position, `expected authored position for ${expected}`);
  expect(original.text.slice(position.pos, position.end)).toContain(expected);
}

function hasString(root: ts.Node, text: string): boolean {
  return subtreeContains(
    root,
    (node) => ts.isStringLiteral(node) && node.text === text,
  );
}

function hasIdentifier(root: ts.Node, text: string): boolean {
  return subtreeContains(
    root,
    (node) => ts.isIdentifier(node) && node.text === text,
  );
}

/**
 * JSX node kinds that always stand for authored syntax. A synthesized one is a
 * replacement for something the author wrote, so it must be able to name where
 * that was; a stage that rebuilds one without carrying its range is the whole
 * bug class this file guards. Expression kinds are deliberately excluded —
 * injected schemas and hoisting scaffolds synthesize those with no authored
 * counterpart at all.
 */
const AUTHORED_JSX_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.JsxAttribute,
  ts.SyntaxKind.JsxElement,
  ts.SyntaxKind.JsxExpression,
  ts.SyntaxKind.JsxSelfClosingElement,
]);

/** Every `*.input.ts(x)` fixture path, relative to the fixture root. */
async function collectFixturePaths(): Promise<string[]> {
  const root = new URL("./fixtures/", import.meta.url);
  const found: string[] = [];
  const walk = async (dir: URL, prefix: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        await walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      } else if (
        entry.name.endsWith(".input.tsx") || entry.name.endsWith(".input.ts")
      ) {
        found.push(`${prefix}${entry.name}`);
      }
    }
  };
  await walk(root, "");
  return found.sort();
}

/** Synthesized authored-JSX nodes in `root` that cannot name an authored site. */
function unanchoredJsxNodes(root: ts.SourceFile): string[] {
  const printer = ts.createPrinter();
  const unanchored: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      node.pos < 0 && AUTHORED_JSX_KINDS.has(node.kind) &&
      !recoverAuthoredPosition(node)
    ) {
      let printed: string;
      try {
        printed = printer.printNode(ts.EmitHint.Unspecified, node, root)
          .replace(/\s+/g, " ").slice(0, 80);
      } catch {
        printed = "(unprintable)";
      }
      unanchored.push(`${ts.SyntaxKind[node.kind]}: ${printed}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return unanchored;
}

describe("replacement source-map ranges", () => {
  it("preserves authored positions on JSX-router replacements", async () => {
    const { original, transformed } = await transformThroughStage(
      ROUTER_FIXTURE,
      "/ct1869-router.tsx",
      "JsxExpressionSiteRouterTransformer",
    );

    const uiHelper = findOnly(
      transformed,
      (node): node is ts.JsxElement =>
        ts.isJsxElement(node) &&
        ts.isIdentifier(node.openingElement.tagName) &&
        node.openingElement.tagName.text === "ct-button",
      "rewritten UiAction",
    );
    expectAuthoredText(uiHelper, original, "<UiAction");

    const selfClosingUiHelper = findOnly(
      transformed,
      (node): node is ts.JsxSelfClosingElement =>
        ts.isJsxSelfClosingElement(node) &&
        ts.isIdentifier(node.tagName) && node.tagName.text === "ct-textarea",
      "rewritten self-closing UiPromptSlot",
    );
    expectAuthoredText(selfClosingUiHelper, original, "<UiPromptSlot");

    // The data attribute replaces the authored helper prop, so it anchors on
    // that prop rather than on the element that carries it.
    const dataAttr = findOnly(
      transformed,
      (node): node is ts.JsxAttribute =>
        ts.isJsxAttribute(node) &&
        ts.isIdentifier(node.name) && node.name.text === "data-ui-action",
      "rewritten UiAction data attribute",
    );
    expectAuthoredText(dataAttr, original, 'action="CT1869_UI"');

    const sharedPre = findOnly(
      transformed,
      (node): node is ts.JsxExpression =>
        ts.isJsxExpression(node) && hasString(node, " CT1869_PRE"),
      "shared pre-closure JSX expression",
    );
    expectAuthoredText(
      sharedPre,
      original,
      "state.visible",
    );

    const ownedResult = await transformThroughStage(
      OWNED_ROUTER_FIXTURE,
      "/ct1869-owned-router.tsx",
      "JsxExpressionSiteRouterTransformer",
    );
    const owned = findOnly(
      ownedResult.transformed,
      (node): node is ts.JsxExpression =>
        ts.isJsxExpression(node) &&
        subtreeContains(
          node,
          (child) => ts.isNumericLiteral(child) && child.text === "1869",
        ),
      "owned pre-closure JSX expression",
    );
    expectAuthoredText(
      owned,
      ownedResult.original,
      "ifElse(state.visible, state.count + 1869, 0)",
    );
  });

  it("preserves authored positions on closure replacements", async () => {
    const { original, transformed } = await transformThroughStage(
      CLOSURE_FIXTURE,
      "/ct1869-closure.tsx",
      "ClosureTransformer",
    );

    const handler = findOnly(
      transformed,
      (node): node is ts.JsxAttribute =>
        ts.isJsxAttribute(node) &&
        ts.isIdentifier(node.name) && node.name.text === "onClick" &&
        subtreeContains(
          node,
          (child) => ts.isNumericLiteral(child) && child.text === "1869",
        ),
      "rewritten handler attribute",
    );
    expectAuthoredText(
      handler,
      original,
      "onClick={() => state.count + 1869}",
    );
    assert(handler.initializer && ts.isJsxExpression(handler.initializer));
    expectAuthoredText(
      handler.initializer,
      original,
      "{() => state.count + 1869}",
    );

    const receiverKey = findOnly(
      transformed,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "key" &&
        hasString(node, "groups") && hasString(node, "rows"),
      "lowered array-method receiver",
    );
    expectAuthoredText(receiverKey, original, "state.groups.rows");

    const callbackExpression = findOnly(
      transformed,
      (node): node is ts.JsxExpression =>
        ts.isJsxExpression(node) && hasString(node, "CT1869_MAP") &&
        !!node.expression &&
        !subtreeContains(node.expression, ts.isJsxExpression),
      "rewritten array-callback JSX expression",
    );
    expectAuthoredText(
      callbackExpression,
      original,
      '{row.title === "x" ? "CT1869_MAP" : row.title}',
    );
  });

  it("preserves authored positions on post-closure JSX containers", async () => {
    const { original, transformed } = await transformThroughStage(
      POST_CLOSURE_FIXTURE,
      "/ct1869-post-closure.tsx",
      "PatternOwnedExpressionSiteLoweringTransformer",
    );

    const replacement = findOnly(
      transformed,
      (node): node is ts.JsxExpression =>
        ts.isJsxExpression(node) && hasIdentifier(node, "ct1869Active") &&
        subtreeContains(
          node,
          (child) =>
            ts.isBinaryExpression(child) &&
            child.operatorToken.kind === ts.SyntaxKind.GreaterThanToken,
        ),
      "post-closure JSX expression",
    );
    expectAuthoredText(
      replacement,
      original,
      "state.items.filter((item) => item.ct1869Active).length > 0",
    );
  });

  it("preserves the authored branch on zero-input wrappers", async () => {
    const fileName = "/ct1869-zero-input.tsx";
    const { program } = await batchTypeCheckFixtures(
      { [fileName]: ZERO_INPUT_FIXTURE },
      { types: COMMONFABRIC_TYPES },
    );
    const original = program.getSourceFile(fileName);
    assert(original, "zero-input fixture source file present");

    let rewritten: ts.Expression | undefined;
    const result = ts.transform(original, [
      (tsContext) => (sourceFile) => {
        const context = new TransformationContext({
          program,
          sourceFile,
          tsContext,
        });
        const expression = findOnly(
          sourceFile,
          (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) && hasString(node, "CT1869_ZERO"),
          "dynamic pattern-body initializer",
        );
        const analysis = context.getDataFlowAnalyzer()(expression);
        rewritten = createReactiveWrapperForExpression(
          expression,
          context.getRelevantDataFlowsFromAnalysis(analysis),
          context,
        );
        return sourceFile;
      },
    ]);
    assert(result.transformed[0], "zero-input probe transform completed");
    assert(rewritten, "zero-input reactive wrapper created");

    const wrapper = findOnly(
      rewritten,
      (node): node is ts.ArrowFunction =>
        ts.isArrowFunction(node) && node.parameters.length === 0 &&
        hasString(node, "CT1869_ZERO"),
      "zero-input reactive wrapper",
    );
    expectAuthoredText(
      wrapper,
      original,
      'state.items[state.index] + "CT1869_ZERO"',
    );
  });

  it("preserves authored positions on pattern-body replacements", async () => {
    const { original, transformed } = await transformThroughStage(
      PATTERN_BODY_FIXTURE,
      "/ct1869-pattern-body.tsx",
      "PatternCallbackLoweringTransformer",
    );

    const replacement = findOnly(
      transformed,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "key" &&
        hasString(node, "profile") && hasString(node, "label"),
      "pattern-body property replacement",
    );
    expectAuthoredText(replacement, original, "state.profile.label");
  });

  it("preserves authored positions on module-scope data wrappers", async () => {
    const { original, transformed } = await transformThroughStage(
      MODULE_DATA_FIXTURE,
      "/ct1869-module-data.tsx",
      "ModuleScopeCfDataTransformer",
    );

    const replacement = findOnly(
      transformed,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "__cf_data" &&
        hasString(node, "CT1869_DATA"),
      "module-scope data wrapper",
    );
    expectAuthoredText(
      replacement,
      original,
      '{ marker: "CT1869_DATA" }',
    );
  });

  it("preserves authored positions on opaque destructuring declarations", async () => {
    const { original, transformed } = await transformThroughStage(
      OPAQUE_DESTRUCTURE_FIXTURE,
      "/ct1869-opaque-destructure.tsx",
      "PatternCallbackLoweringTransformer",
    );

    const root = findOnly(
      transformed,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text.startsWith("__cf_destructure"),
      "opaque destructuring temporary root",
    );
    expectAuthoredText(
      root,
      original,
      'fetchText({ url: "CT1869_DESTRUCTURE" })',
    );

    const pending = findOnly(
      transformed,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "ctPending",
      "opaque destructuring pending leaf",
    );
    expectAuthoredText(pending, original, "pending: ctPending");

    const result = findOnly(
      transformed,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "ctResult",
      "opaque destructuring result leaf",
    );
    expectAuthoredText(result, original, "result: ctResult");

    const parameterLeaf = findOnly(
      transformed,
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "ctLabel",
      "opaque destructured-parameter leaf",
    );
    expectAuthoredText(parameterLeaf, original, "label: ctLabel");
  });

  it("preserves authored positions on assert-diagnostics replacements", async () => {
    const { original, transformed } = await transformThroughStage(
      ASSERT_DIAGNOSTICS_FIXTURE,
      "/ct1869-assert-diagnostics.tsx",
      "AssertDiagnosticsTransformer",
    );

    const conciseCallback = findOnly(
      transformed,
      (node): node is ts.ArrowFunction =>
        ts.isArrowFunction(node) && node.parameters.length === 0 &&
        hasString(node, "state.count > 0"),
      "rewritten concise assert callback",
    );
    assert(ts.isBlock(conciseCallback.body));
    expectAuthoredText(conciseCallback.body, original, "state.count > 0");

    const conciseReturn = findOnly(
      conciseCallback.body,
      (node): node is ts.ReturnStatement =>
        ts.isReturnStatement(node) && hasString(node, "state.count > 0"),
      "rewritten concise assert return",
    );
    expectAuthoredText(conciseReturn, original, "state.count > 0");

    const branchedCallback = findOnly(
      transformed,
      (node): node is ts.ArrowFunction =>
        ts.isArrowFunction(node) && node.parameters.length === 0 &&
        hasString(node, "state.count < 20") &&
        hasString(node, "state.count === 1"),
      "rewritten block assert callback",
    );
    assert(ts.isBlock(branchedCallback.body));
    expectAuthoredText(
      branchedCallback.body,
      original,
      "if (state.count > 10)",
    );

    const earlyReturnBlock = findOnly(
      branchedCallback.body,
      (node): node is ts.Block =>
        ts.isBlock(node) && hasString(node, "state.count < 20") &&
        node.statements.some(ts.isReturnStatement),
      "rewritten early assert return block",
    );
    expectAuthoredText(
      earlyReturnBlock,
      original,
      "return state.count < 20;",
    );
    const earlyRecordReturn = findOnly(
      earlyReturnBlock,
      ts.isReturnStatement,
      "rewritten early assert record return",
    );
    expectAuthoredText(
      earlyRecordReturn,
      original,
      "return state.count < 20;",
    );

    const finalReturnBlock = findOnly(
      branchedCallback.body,
      (node): node is ts.Block =>
        ts.isBlock(node) && hasString(node, "state.count === 1") &&
        node.statements.some(ts.isReturnStatement),
      "rewritten final assert return block",
    );
    expectAuthoredText(
      finalReturnBlock,
      original,
      "return state.count === 1;",
    );
    const finalRecordReturn = findOnly(
      finalReturnBlock,
      ts.isReturnStatement,
      "rewritten final assert record return",
    );
    expectAuthoredText(
      finalRecordReturn,
      original,
      "return state.count === 1;",
    );
  });

  it("keeps conditional helpers anchored to their semantic authored sites", async () => {
    const { original, transformed } = await transformThroughStage(
      CONDITIONAL_HELPER_FIXTURE,
      "/ct1869-conditional-helpers.tsx",
      "PatternCallbackLoweringTransformer",
    );

    for (const helper of ["when", "unless"] as const) {
      const call = findOnly(
        transformed,
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === helper,
        `rewritten ${helper} call`,
      );
      expectAuthoredText(call, original, "state.visible");
      const position = recoverAuthoredPosition(call);
      assert(position, `expected authored position for ${helper}`);
      expect(original.text.slice(position.pos, position.end)).not.toContain(
        helper === "when" ? "&&" : "||",
      );
    }

    const ifElse = findOnly(
      transformed,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "ifElse",
      "rewritten ifElse call",
    );
    expectAuthoredText(
      ifElse,
      original,
      "state.visible ? state.count : 0",
    );
  });

  it("recovers an authored position for every synthesized JSX node in the corpus", async () => {
    // The cases above pin the sites this file knows about by name. This one is
    // the drift gate: it makes the same guarantee over every fixture, so a NEW
    // stage that rebuilds a JSX node without carrying its range fails here
    // instead of waiting for someone to notice a wrong debug position. The
    // fixtures declared above are included because the corpus reaches no
    // UI-helper element, which would otherwise leave that family ungated.

    const fixturePaths = await collectFixturePaths();
    expect(fixturePaths.length, "fixture corpus is non-empty").toBeGreaterThan(
      100,
    );

    const sources: Record<string, string> = {
      "/inline-router.tsx": ROUTER_FIXTURE,
      "/inline-owned-router.tsx": OWNED_ROUTER_FIXTURE,
      "/inline-closure.tsx": CLOSURE_FIXTURE,
      "/inline-post-closure.tsx": POST_CLOSURE_FIXTURE,
    };
    for (const path of fixturePaths) {
      const url = new URL(`./fixtures/${path}`, import.meta.url);
      sources[`/${path.replaceAll("/", "_")}`] = await Deno.readTextFile(url);
    }

    // Type-check in batches: one program per fixture would dominate runtime.
    const names = Object.keys(sources);
    const BATCH = 25;
    const failures: string[] = [];
    let checked = 0;
    for (let index = 0; index < names.length; index += BATCH) {
      const batch = names.slice(index, index + BATCH);
      const files = Object.fromEntries(
        batch.map((name) => [name, sources[name]!]),
      );
      const { program } = await batchTypeCheckFixtures(files, {
        types: COMMONFABRIC_TYPES,
      });
      for (const name of batch) {
        const sourceFile = program.getSourceFile(name);
        assert(sourceFile, `fixture source file present: ${name}`);
        const pipeline = new CommonFabricTransformerPipeline();
        const result = ts.transform(sourceFile, pipeline.toFactories(program));
        const transformed = result.transformed[0];
        assert(transformed, `pipeline returned a source file: ${name}`);
        checked++;
        for (const unanchored of unanchoredJsxNodes(transformed)) {
          failures.push(`${name} -> ${unanchored}`);
        }
      }
    }

    expect(checked, "every fixture ran through the pipeline").toBe(
      names.length,
    );
    expect(
      failures,
      "synthesized JSX nodes with no recoverable authored position; carry the " +
        "authored range with preserveSourceMapRange at the site that builds them",
    ).toEqual([]);
  });
});
