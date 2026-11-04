import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import { createDataFlowAnalyzer } from "../../src/ast/mod.ts";
import { CrossStageState, TransformationContext } from "../../src/core/mod.ts";
import {
  classifyExpressionSiteHandling,
  classifyRestrictedReactiveComputation,
  findLowerableExpressionSite,
} from "../../src/transformers/expression-site-policy.ts";
import type { ExpressionContainerKind } from "../../src/transformers/expression-site-types.ts";

function createProgramAndContext(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  context: TransformationContext;
} {
  const fileName = "/test.tsx";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
    ts.ScriptKind.TSX,
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

  return { sourceFile, checker: program.getTypeChecker(), context };
}

function findVariableInitializer(
  sourceFile: ts.SourceFile,
  declarationName: string,
): ts.Expression {
  let found: ts.Expression | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declarationName &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error(`Initializer for ${declarationName} not found`);
  }

  return found;
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

function findAllNodes<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];

  const visit = (node: ts.Node): void => {
    if (predicate(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (found.length === 0) {
    throw new Error("Expected matching nodes");
  }

  return found;
}

function findArrayMethodCallback(
  sourceFile: ts.SourceFile,
  methodName = "map",
): ts.ArrowFunction | ts.FunctionExpression {
  const call = findFirstNode(
    sourceFile,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === methodName,
  );

  const callback = call.arguments[0];
  if (
    !callback || (!ts.isArrowFunction(callback) &&
      !ts.isFunctionExpression(callback))
  ) {
    throw new Error(`Expected ${methodName} callback function`);
  }

  return callback;
}

type ExpressionSiteHandling = ReturnType<typeof classifyExpressionSiteHandling>;
type JsxRoute =
  | { route: "shared-pre-closure" }
  | { route: "shared-post-closure" }
  | {
    route: "owned-pre-closure";
    owner: "jsx-root";
  }
  | {
    route: "skip";
    reason:
      | "no-authored-source-site"
      | "event-handler-jsx-attribute"
      | "non-pattern-context"
      | "array-method-owned"
      | "deferred-jsx-array-method-root"
      | "not-shared-jsx-root-kind";
  };

function toJsxRoute(decision: ExpressionSiteHandling): JsxRoute {
  switch (decision.kind) {
    case "shared":
      return { route: decision.jsxRoute ?? "shared-post-closure" };
    case "owned":
      if (decision.owner === "jsx-root") {
        return { route: "owned-pre-closure", owner: "jsx-root" };
      }
      if (decision.owner === "array-method-callback-jsx") {
        return { route: "skip", reason: "array-method-owned" };
      }
      if (decision.owner === "helper") {
        return { route: "skip", reason: "not-shared-jsx-root-kind" };
      }
      throw new Error(
        `Non-JSX owned handling should not be projected as a JSX route: ${decision.owner}`,
      );
    case "skip":
      return {
        route: "skip",
        reason: decision.reason === "not-lowerable"
          ? "not-shared-jsx-root-kind"
          : decision.reason,
      };
  }
}

function classifyJsxRoute(
  expression: ts.Expression,
  context: TransformationContext,
  analyze: ReturnType<typeof createDataFlowAnalyzer>,
  options?: { allowDeferredRootOwner?: boolean },
): JsxRoute {
  return toJsxRoute(
    classifyExpressionSiteHandling(
      expression,
      "jsx-expression",
      context,
      analyze,
      options,
    ),
  );
}

const classifyJsxExpressionSiteRoute = classifyJsxRoute;

function canRewriteExpressionSite(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  context: TransformationContext,
  analyze: ReturnType<typeof createDataFlowAnalyzer>,
): boolean {
  const decision = classifyExpressionSiteHandling(
    expression,
    containerKind,
    context,
    analyze,
  );
  return (decision.kind === "shared" ||
    (decision.kind === "owned" && decision.owner === "jsx-root")) &&
    decision.lowerable;
}

function canRewriteHelperOwnedExpressionSite(
  expression: ts.Expression,
  containerKind: ExpressionContainerKind,
  context: TransformationContext,
  analyze: ReturnType<typeof createDataFlowAnalyzer>,
): boolean {
  const decision = classifyExpressionSiteHandling(
    expression,
    containerKind,
    context,
    analyze,
  );
  return decision.kind === "owned" && decision.owner === "helper" &&
    decision.lowerable;
}

interface JsxRouteCase {
  name: string;
  source: string;
  find?: (sourceFile: ts.SourceFile) => ts.Expression;
  findAll?: (sourceFile: ts.SourceFile) => ts.Expression[];
  expected: JsxRoute;
}

function assertJsxRouteCase(testCase: JsxRouteCase): void {
  const { sourceFile, checker, context } = createProgramAndContext(
    testCase.source,
  );
  const analyze = createDataFlowAnalyzer(checker);
  const expressions = testCase.findAll
    ? testCase.findAll(sourceFile)
    : testCase.find
    ? [testCase.find(sourceFile)]
    : [];

  if (expressions.length === 0) {
    throw new Error(`No route expressions found for ${testCase.name}`);
  }

  for (const expression of expressions) {
    assertEquals(
      classifyJsxRoute(expression, context, analyze),
      testCase.expected,
    );
  }
}

Deno.test(
  "Expression site policy: array-method callback call arguments under local helper roots defer to the enclosing call root",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function identity<T>(value: T): T;

      const callback = (__cf_pattern_input: any) => {
        const row = __cf_pattern_input.key("element");
        const label = identity(row.done ? "Done" : "Pending");
        return label;
      };
    `);

    const callback = findVariableInitializer(sourceFile, "callback");
    if (!ts.isArrowFunction(callback)) {
      throw new Error("Expected callback arrow function");
    }
    context.markAsArrayMethodCallback(callback);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const helperCall = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "identity",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(
      canRewriteExpressionSite(
        conditional,
        "call-argument",
        context,
        analyze,
      ),
      false,
    );
    assertEquals(
      canRewriteHelperOwnedExpressionSite(
        conditional,
        "call-argument",
        context,
        analyze,
      ),
      false,
    );

    const lowerableSite = findLowerableExpressionSite(
      conditional,
      context,
      analyze,
    );
    assert(lowerableSite);
    assert(lowerableSite.expression === helperCall);
    assertEquals(lowerableSite.containerKind, "variable-initializer");
  },
);

Deno.test(
  "Expression site policy: array-method-owned receiver-method roots classify distinctly from shared expression sites",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) =>
        state.items.map((item: any) => item.name.toUpperCase())
      );
    `);

    const callback = findArrayMethodCallback(sourceFile);
    context.markAsArrayMethodCallback(callback);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "toUpperCase",
    );

    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(
      classifyExpressionSiteHandling(
        call,
        "return-expression",
        context,
        analyze,
      ),
      {
        kind: "owned",
        owner: "array-method-receiver-method",
        lowerable: true,
      },
    );
  },
);

Deno.test(
  "Expression site policy: optionality preserves receiver-method call-root ownership",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => ({
        receiverOptional: state.name?.toUpperCase(),
        invocationOptional: state.name.toUpperCase?.(),
        bothOptional: state.name?.toUpperCase?.(),
      }));
    `);

    const calls = findAllNodes(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "toUpperCase",
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(calls.length, 3);
    for (const call of calls) {
      assertEquals(
        classifyExpressionSiteHandling(
          call,
          "object-property",
          context,
          analyze,
        ),
        {
          kind: "shared",
          lowerable: true,
        },
      );
    }
  },
);

Deno.test(
  "Expression site policy: aliased reactive array callbacks keep receiver-method ownership",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function computed<T>(fn: () => T): T;
      declare function pattern<T>(fn: (state: { items: string[] }) => T): T;

      const view = pattern((state) => {
        const inner = computed(() => state.items);
        return computed(() => {
          const foo = computed(() => inner);
          const filtered = foo.filter((item) => item.length > 1);
          return filtered.map((item) => item.toUpperCase());
        });
      });
    `);

    const mapCall = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "map",
    );
    const callback = mapCall.arguments[0];
    if (!callback || !ts.isArrowFunction(callback)) {
      throw new Error("Expected map callback arrow function");
    }
    context.markAsArrayMethodCallback(callback);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "toUpperCase",
    );

    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(
      classifyExpressionSiteHandling(
        call,
        "return-expression",
        context,
        analyze,
      ),
      {
        kind: "owned",
        owner: "array-method-receiver-method",
        lowerable: true,
      },
    );
  },
);

Deno.test(
  "Expression site policy: reactive direct JSX array-method roots use the generic owned pre-closure route when enabled",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.items.map((row: any) => row.done ? "Done" : "Pending")}</div>
      ));
    `);

    const mapCall = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "map",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(classifyJsxExpressionSiteRoute(mapCall, context, analyze), {
      route: "skip",
      reason: "deferred-jsx-array-method-root",
    });
    assertEquals(
      classifyJsxExpressionSiteRoute(mapCall, context, analyze, {
        allowDeferredRootOwner: true,
      }),
      {
        route: "owned-pre-closure",
        owner: "jsx-root",
      },
    );
  },
);

Deno.test(
  "Expression site policy: nested JSX array-method roots inside authored callbacks stay array-method-owned",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          section: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.sections.map((section: any) => (
            <section>
              {section.tasks.map((task: any) => <span>{task.label}</span>)}
            </section>
          ))}
        </div>
      ));
    `);

    const nestedMapCall = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "map" &&
        node.expression.expression.getText(sourceFile) === "section.tasks",
    );

    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(
      classifyJsxExpressionSiteRoute(nestedMapCall, context, analyze),
      {
        route: "skip",
        reason: "array-method-owned",
      },
    );
  },
);

Deno.test(
  "Expression site policy: non-reactive direct JSX array-method roots stay skipped",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => {
        const rows = [{ done: true }, { done: false }];
        return <div>{rows.map((row: any) => row.done ? "Done" : "Pending")}</div>;
      });
    `);

    const mapCall = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "map",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(classifyJsxExpressionSiteRoute(mapCall, context, analyze), {
      route: "skip",
      reason: "deferred-jsx-array-method-root",
    });
    assertEquals(
      classifyJsxExpressionSiteRoute(mapCall, context, analyze, {
        allowDeferredRootOwner: true,
      }),
      {
        route: "skip",
        reason: "deferred-jsx-array-method-root",
      },
    );
  },
);

const ownedOrSkippedJsxRouteCases: JsxRouteCase[] = [
  {
    name:
      "reactive dynamic JSX element-access roots use the generic owned pre-closure route",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.items[state.index]}</div>
      ));
    `,
    find: (sourceFile) =>
      findFirstNode(
        sourceFile,
        (node): node is ts.ElementAccessExpression =>
          ts.isElementAccessExpression(node) &&
          node.getText(sourceFile) === "state.items[state.index]",
      ),
    expected: {
      route: "owned-pre-closure",
      owner: "jsx-root",
    },
  },
  {
    name:
      "non-reactive dynamic JSX element-access roots stay in the residual skip bucket",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => {
        const rows = ["a", "b", "c"];
        let index = 1;
        return <div>{rows[index]}</div>;
      });
    `,
    find: (sourceFile) =>
      findFirstNode(
        sourceFile,
        (node): node is ts.ElementAccessExpression =>
          ts.isElementAccessExpression(node) &&
          node.getText(sourceFile) === "rows[index]",
      ),
    expected: {
      route: "skip",
      reason: "not-shared-jsx-root-kind",
    },
  },
  {
    name:
      "reactive direct JSX object-literal roots use the shared post-closure route",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{{
          color: state.theme.primary,
          fontSize: state.theme.size + "px",
        }}</div>
      ));
    `,
    find: (sourceFile) =>
      findFirstNode(
        sourceFile,
        (node): node is ts.ObjectLiteralExpression =>
          ts.isObjectLiteralExpression(node) &&
          node.getText(sourceFile).includes("color: state.theme.primary"),
      ),
    expected: {
      route: "shared-post-closure",
    },
  },
  {
    name:
      "non-reactive direct JSX object-literal roots stay in the residual skip bucket",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => (
        <div>{{ color: "red", fontSize: "12px" }}</div>
      ));
    `,
    find: (sourceFile) =>
      findFirstNode(sourceFile, ts.isObjectLiteralExpression),
    expected: {
      route: "skip",
      reason: "not-shared-jsx-root-kind",
    },
  },
];

for (const testCase of ownedOrSkippedJsxRouteCases) {
  Deno.test(`Expression site policy: ${testCase.name}`, () => {
    assertJsxRouteCase(testCase);
  });
}

Deno.test(
  "Expression site policy: direct JSX helper-call roots use the generic owned pre-closure route",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;
      declare function ifElse<T>(condition: any, whenTrue: T, whenFalse: T): T;

      const view = pattern((state: any) => (
        <div>{ifElse(state.ready, <span>Ready</span>, <span>Waiting</span>)}</div>
      ));
    `);

    const helperCall = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "ifElse",
    );

    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(
      classifyJsxExpressionSiteRoute(helperCall, context, analyze),
      {
        route: "owned-pre-closure",
        owner: "jsx-root",
      },
    );
  },
);

Deno.test(
  "Expression site policy: synthetic compute-owned authored subtrees stay out of rewrite eligibility",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => {
        const label = state.done ? state.name : "Pending";
        return label;
      });
    `);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    context.markSyntheticComputeOwnedSubtree(conditional);

    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(
      canRewriteExpressionSite(
        conditional,
        "variable-initializer",
        context,
        analyze,
      ),
      false,
    );
    assertEquals(
      canRewriteHelperOwnedExpressionSite(
        conditional,
        "variable-initializer",
        context,
        analyze,
      ),
      false,
    );
  },
);

Deno.test(
  "Expression site policy: lowerable-site search skips non-pattern JSX roots without analyzing them",
  () => {
    const { sourceFile, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      const ui = <div>{value}</div>;
    `);

    const valueRef = findFirstNode(
      sourceFile,
      (node): node is ts.Identifier =>
        ts.isIdentifier(node) && node.text === "value",
    );

    let analyzeCalls = 0;
    const analyze = (_expression: ts.Expression) => {
      analyzeCalls++;
      return {
        containsReactive: false,
        requiresRewrite: false,
        dataFlows: [],
        graph: {
          nodes: [],
          scopes: [],
          rootScopeId: 0,
        },
      };
    };

    assertEquals(
      findLowerableExpressionSite(valueRef, context, analyze),
      undefined,
    );
    assertEquals(analyzeCalls, 0);
  },
);

Deno.test(
  "Expression site policy: restricted reactive computation classification reuses lowerable expression-site handling",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;
      declare function identity<T>(value: T): T;

      const view = pattern((state: any) => {
        const label = identity(state.done ? "Done" : "Pending");
        return label;
      });
    `);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const analyze = createDataFlowAnalyzer(checker);
    const decision = classifyRestrictedReactiveComputation(
      conditional,
      context,
      analyze,
    );

    assertEquals(decision.kind, "allowed");
    assert(decision.kind === "allowed");
    assertEquals(decision.lowerableSite?.containerKind, "call-argument");
    assertEquals(decision.lowerableSite?.expression, conditional);
  },
);

Deno.test(
  "Expression site policy: restricted reactive if-conditions still require computed()",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => {
        if (state.done && state.name) {
          return <div>{state.name}</div>;
        }
        return <div>Pending</div>;
      });
    `);

    const condition = findFirstNode(
      sourceFile,
      (node): node is ts.BinaryExpression =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyRestrictedReactiveComputation(condition, context, analyze),
      { kind: "requires-computed" },
    );
  },
);

Deno.test(
  "Expression site policy: top-level JSX wrapper roots defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => <div>{state.user.name}</div>);
    `);

    const propertyAccess = findFirstNode(
      sourceFile,
      ts.isPropertyAccessExpression,
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(propertyAccess, context, analyze),
      {
        route: "shared-post-closure",
      },
    );
  },
);

Deno.test(
  "Expression site policy: JSX free-function call roots defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => <div>{Math.max(state.a, state.b)}</div>);
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "max",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: JSX receiver-method call roots defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => <div>{state.name.toUpperCase()}</div>);
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "toUpperCase",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: receiver-method chains over reactive array-method sinks defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.items.filter((item: number) => item > state.threshold).join(", ").toUpperCase()}</div>
      ));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "toUpperCase",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: array-method-owned nested join chains stay out of the shared sink-chain slice",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.people.map((person: any) => (
            <span>{person.spotPreferences.map((n: string) => "#" + n).join(", ").toUpperCase()}</span>
          ))}
        </div>
      ));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "toUpperCase",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "skip",
      reason: "array-method-owned",
    });
  },
);

Deno.test(
  "Expression site policy: JSX opaque path-terminal calls use the owned pre-closure root path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      interface Cell<T> {
        get(): T;
        key(name: string): Cell<unknown>;
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((input: Cell<{ foo: string }>) => (
        <div>{input.key("foo").get()}</div>
      ));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "get",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "owned-pre-closure",
      owner: "jsx-root",
    });
  },
);

Deno.test(
  "Expression site policy: local helper calls join the shared non-JSX ordinary-call slice",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;
      const identity = <T,>(value: T) => value;

      const view = pattern((state: any) => ({
        label: identity(state.name),
      }));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "identity",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(
      canRewriteExpressionSite(call, "object-property", context, analyze),
      true,
    );
  },
);

Deno.test(
  "Expression site policy: non-JSX array callback local helper calls join the shared ordinary-call slice",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;
      const identity = <T,>(value: T) => value;

      const view = pattern(({ items }: { items: string[] }) =>
        items.map((item) => identity(item.toUpperCase()))
      );
    `);

    const callback = findArrayMethodCallback(sourceFile);
    context.markAsArrayMethodCallback(callback);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "identity",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(
      canRewriteExpressionSite(call, "return-expression", context, analyze),
      true,
    );
  },
);

Deno.test(
  "Expression site policy: lowerable-site search prefers an ordinary parent call over an array-callback receiver-method child",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;
      const identity = <T,>(value: T) => value;

      const view = pattern(({ items }: { items: string[] }) =>
        items.map((item) => identity(item.toUpperCase()))
      );
    `);

    const callback = findArrayMethodCallback(sourceFile);
    context.markAsArrayMethodCallback(callback);

    const receiverCall = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "toUpperCase",
    );

    const identityCall = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "identity",
    );

    const analyze = createDataFlowAnalyzer(checker);
    const lowerableSite = findLowerableExpressionSite(
      receiverCall,
      context,
      analyze,
    );
    assert(lowerableSite);
    assert(lowerableSite.expression === identityCall);
    assertEquals(lowerableSite.containerKind, "return-expression");
  },
);

Deno.test(
  "Expression site policy: JSX local helper call roots with reactive args defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      function previous(value: number) {
        return value - 1;
      }

      const view = pattern((state: any) => <div>{previous(state.value)}</div>);
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "previous",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: JSX parameterized inline-function call roots join the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{((value: string) => state.prefix + value)(state.count)}</div>
      ));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isParenthesizedExpression(node.expression) &&
        ts.isArrowFunction(node.expression.expression),
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: parameterized inline-function call roots join the shared non-JSX slice",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => ({
        label: ((value: string) => state.prefix + value)(state.count),
      }));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isParenthesizedExpression(node.expression) &&
        ts.isArrowFunction(node.expression.expression),
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(
      canRewriteExpressionSite(call, "object-property", context, analyze),
      true,
    );
  },
);

Deno.test(
  "Expression site policy: wildcard traversal calls share the ordinary-call lowering slice",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => ({
        serialized: JSON.stringify(state),
      }));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "JSON" &&
        node.expression.name.text === "stringify",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(
      canRewriteExpressionSite(call, "object-property", context, analyze),
      true,
    );
  },
);

Deno.test(
  "Expression site policy: JSX wildcard traversal call roots defer to the shared post-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          p: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          <p>{JSON.stringify(state.wishes[1])}</p>
        </div>
      ));
    `);

    const call = findFirstNode(
      sourceFile,
      (node): node is ts.CallExpression =>
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "JSON" &&
        node.expression.name.text === "stringify",
    );
    const analyze = createDataFlowAnalyzer(checker);
    assertEquals(classifyJsxExpressionSiteRoute(call, context, analyze), {
      route: "shared-post-closure",
    });
  },
);

Deno.test(
  "Expression site policy: array-method-owned JSX wrapper roots stay out of the shared JSX routes",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.items.map((item: any) => <span>{item.name}</span>)}</div>
      ));
    `);

    const callback = findFirstNode(
      sourceFile,
      (node): node is ts.ArrowFunction =>
        ts.isArrowFunction(node) &&
        ts.isJsxElement(node.body),
    );
    context.markAsArrayMethodCallback(callback);

    const propertyAccess = findFirstNode(
      sourceFile,
      (node): node is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "item" &&
        node.name.text === "name",
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(propertyAccess, context, analyze),
      { route: "skip", reason: "array-method-owned" },
    );
  },
);

const sharedPostClosureJsxRouteCases: JsxRouteCase[] = [
  {
    name:
      "plain-array callback JSX arithmetic roots use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      interface Array<T> {
        map<U>(callback: (value: T) => U): U[];
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{[1, 2, 3].map((n: number) => <span>{n * state.multiplier}</span>)}</div>
      ));
    `,
    find: (sourceFile) =>
      findFirstNode(
        sourceFile,
        (node): node is ts.BinaryExpression =>
          ts.isBinaryExpression(node) &&
          ts.isIdentifier(node.left) &&
          node.left.text === "n" &&
          ts.isPropertyAccessExpression(node.right) &&
          ts.isIdentifier(node.right.expression) &&
          node.right.expression.text === "state" &&
          node.right.name.text === "multiplier",
      ),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "JSX wrapper roots over reactive array-method results use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.items.filter((item: any) => item.active).length}</div>
      ));
    `,
    find: (sourceFile) =>
      findFirstNode(
        sourceFile,
        (node): node is ts.PropertyAccessExpression =>
          ts.isPropertyAccessExpression(node) &&
          node.name.text === "length" &&
          ts.isCallExpression(node.expression),
      ),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "JSX comparison wrappers over reactive array-method results use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.items.filter((item: any) => item.active).length > 0}</div>
      ));
    `,
    find: (sourceFile) =>
      findFirstNode(
        sourceFile,
        (node): node is ts.BinaryExpression =>
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken,
      ),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "pure JSX ternary branches over map subtrees use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.recentEvents.length === 0
            ? <span>No events yet</span>
            : (
              <div>
                {state.recentEvents.map((event: any) => <span>{event.label}</span>)}
              </div>
            )}
        </div>
      ));
    `,
    find: (sourceFile) => findFirstNode(sourceFile, ts.isConditionalExpression),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "length guards over JSX-local map containers use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => {
        return (
          <div>
            {state.list.get().length > 0 && (
              <div>
                {state.list.map((name: string) => <span>{name}</span>)}
              </div>
            )}
          </div>
        );
      });
    `,
    find: (sourceFile) =>
      findFirstNode(
        sourceFile,
        (node): node is ts.BinaryExpression =>
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
      ),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "logical roots with reactive get guards and direct map values use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>{state.recentEvents.get() && state.recentEvents.map((event: any) => <span>{event.label}</span>)}</div>
      ));
    `,
    find: (sourceFile) =>
      findFirstNode(
        sourceFile,
        (node): node is ts.BinaryExpression =>
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
      ),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "JSX-local ternary branch containers with nested scalar lowerables use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
          ul: any;
          li: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.showAdmin
            ? (
              <div>
                <span>{state.count + " people"}</span>
                <ul>
                  {state.adminData.map((entry: any) => <li>{entry.name}</li>)}
                </ul>
              </div>
            )
            : null}
        </div>
      ));
    `,
    find: (sourceFile) => findFirstNode(sourceFile, ts.isConditionalExpression),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "nested logical branches with structural map subtrees use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
          "cf-vstack": any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.showEmpty
            ? <span>No events yet</span>
            : state.recentEvents.get() &&
              state.recentEvents.map((event: any) => (
              <cf-vstack>
                <span>{event.label}</span>
                {event.tags.map((tag: string) => <span>{tag}</span>)}
              </cf-vstack>
              ))}
        </div>
      ));
    `,
    find: (sourceFile) => findFirstNode(sourceFile, ts.isConditionalExpression),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "parenthesized nested ternary branches use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.isActive
            ? (state.isPremium ? "Premium Active" : "Regular Active")
            : "Inactive"}
        </div>
      ));
    `,
    find: (sourceFile) => findFirstNode(sourceFile, ts.isConditionalExpression),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "parenthesized nested logical branches use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.isAdult && (state.name || "Anonymous Adult")}
        </div>
      ));
    `,
    find: (sourceFile) =>
      findFirstNode(
        sourceFile,
        (node): node is ts.BinaryExpression =>
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
      ),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "logical JSX branches with non-JSX wrapper roots use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          p: any;
        }
      }

      declare function cell<T>(value: T): { get(): T };
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => {
        const user = cell<{ name: string; age: number }>({ name: "", age: 0 });
        return (
          <div>
            <p>{user.get().name.length > 0 && \`Hello, \${user.get().name}!\`}</p>
            <p>{user.get().age > 18 && user.get().age}</p>
          </div>
        );
      });
    `,
    findAll: (sourceFile) =>
      findAllNodes(
        sourceFile,
        (node): node is ts.BinaryExpression =>
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken,
      ),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "ternary JSX branches with non-JSX wrapper roots use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          p: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          <p>{state.arr[state.a]! > 10 ? state.items[state.b]! : state.items[0]!}</p>
          <p>{state.user.settings.notifications
            ? state.user.name + " has notifications on with " + state.user.settings.theme + " theme"
            : state.user.name + " has notifications off"}</p>
        </div>
      ));
    `,
    findAll: (sourceFile) =>
      findAllNodes(sourceFile, ts.isConditionalExpression),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "logical JSX fallbacks with opaque path-terminal call values use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function cell<T>(value: T): { get(): T };
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => {
        const user = cell<{ name: string }>({ name: "" });
        const defaultMessage = cell("Guest");
        return (
          <div>
            <span>{(user.get().name.length > 0 && user.get().name) || defaultMessage.get()}</span>
          </div>
        );
      });
    `,
    find: (sourceFile) =>
      findFirstNode(
        sourceFile,
        (node): node is ts.BinaryExpression =>
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken,
      ),
    expected: { route: "shared-post-closure" },
  },
  {
    name:
      "ternary JSX branches with opaque path-terminal call values use the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function cell<T>(value: T): { get(): T };
      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((_state: any) => {
        const user = cell<{ name: string }>({ name: "" });
        const defaultMessage = cell("Guest");
        return (
          <div>
            <span>{user.get().name.length > 0 ? user.get().name : defaultMessage.get()}</span>
          </div>
        );
      });
    `,
    find: (sourceFile) => findFirstNode(sourceFile, ts.isConditionalExpression),
    expected: { route: "shared-post-closure" },
  },
  {
    name: "JSX nullish-coalescing roots defer to the shared post-closure path",
    source: `
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => <div>{state.label ?? "Pending"}</div>);
    `,
    find: (sourceFile) => findFirstNode(sourceFile, ts.isBinaryExpression),
    expected: { route: "shared-post-closure" },
  },
];

for (const testCase of sharedPostClosureJsxRouteCases) {
  Deno.test(`Expression site policy: ${testCase.name}`, () => {
    assertJsxRouteCase(testCase);
  });
}

Deno.test(
  "Expression site policy: whole-branch compute-wrap ternaries use the shared pre-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.showList
            ? (() => {
              const itemCount = state.count + " items";
              return (
                <div>
                  <span>{itemCount}</span>
                  {state.sorted.map((item: any) => <span>{item.name}</span>)}
                </div>
              );
            })()
            : <span>Hidden</span>}
        </div>
      ));
    `);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(conditional, context, analyze),
      {
        route: "shared-pre-closure",
      },
    );
  },
);

Deno.test(
  "Expression site policy: ternary branches with direct deferred JSX array-method roots use the shared pre-closure path",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
          p: any;
        }
      }

      type Cell<T> = T & { get(): T };

      declare function pattern<T>(fn: (state: any) => T): T;
      declare function computed<T>(fn: () => T): T;

      interface Item {
        name: string;
      }

      const view = pattern(({ items }: { items: Cell<Item[]> }) => {
        const hasItems = computed(() => items.get().length > 0);
        return <div>{
          hasItems
            ? items.map((item) => <span>{item.name}</span>)
            : <p>No items</p>
        }</div>;
      });
    `);

    const conditional = findFirstNode(sourceFile, ts.isConditionalExpression);
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(conditional, context, analyze),
      { route: "shared-pre-closure" },
    );
  },
);

Deno.test(
  "Expression site policy: array-method-owned JSX wrapper roots with reactive array-method subexpressions stay out of the shared JSX routes",
  () => {
    const { sourceFile, checker, context } = createProgramAndContext(`
      declare namespace JSX {
        interface IntrinsicElements {
          div: any;
          span: any;
        }
      }

      declare function pattern<T>(fn: (state: any) => T): T;

      const view = pattern((state: any) => (
        <div>
          {state.people.map((person: any) => (
            <span>{person.tags.filter((tag: any) => tag.active).length}</span>
          ))}
        </div>
      ));
    `);

    const propertyAccess = findFirstNode(
      sourceFile,
      (node): node is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "length" &&
        ts.isCallExpression(node.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "filter",
    );
    const analyze = createDataFlowAnalyzer(checker);

    assertEquals(
      classifyJsxExpressionSiteRoute(propertyAccess, context, analyze),
      {
        route: "skip",
        reason: "array-method-owned",
      },
    );
  },
);
