import ts from "typescript";
import { preserveSourceMapRange } from "../ast/mod.ts";
import {
  type CapabilityParamDefault,
  TransformationContext,
} from "../core/mod.ts";
import { analyzeFunctionCapabilities } from "../policy/mod.ts";
import { cloneKeyExpression } from "../utils/reactive-keys.ts";
import {
  collectDestructureBindings,
  createPathRead,
  type DefaultDestructureBinding,
  type DestructureBinding,
} from "./destructuring-lowering.ts";
import { addBindingTargetSymbols } from "./opaque-roots.ts";
import {
  reportComputationError,
  rewritePatternCallbackBody,
} from "./pattern-body-reactive-root-lowering.ts";
import { uniquePaths } from "../utils/path-serialization.ts";

/** Property names that correspond to reactive data in map callback params. */
const MAP_REACTIVE_PROPERTIES = new Set(["element", "index", "array"]);

/**
 * Check if a map callback binding is for a non-reactive capture.
 *
 * In map callbacks created by the ClosureTransformer, bindings under the
 * "params" namespace are captures from the outer scope. Some captures are
 * reactive and some are plain values. The `nonReactiveCaptures` set, computed
 * by the pre-scan pass, tells us which capture names correspond to plain
 * outer variables.
 */
function isNonReactiveCapture(
  binding: DestructureBinding,
  nonReactiveCaptures?: ReadonlySet<string>,
): boolean {
  if (!nonReactiveCaptures || nonReactiveCaptures.size === 0) return false;
  if (binding.path.length < 2) return false;
  if (binding.path[0] !== "params") return false;
  const captureName = binding.path[1];
  return typeof captureName === "string" &&
    nonReactiveCaptures.has(captureName);
}

function isReactiveArrayMethodBinding(
  binding: DestructureBinding,
  nonReactiveCaptures?: ReadonlySet<string>,
): boolean {
  if (binding.path.length === 0) return false;
  const rootProp = binding.path[0];
  if (typeof rootProp !== "string") return false;
  if (MAP_REACTIVE_PROPERTIES.has(rootProp)) return true;
  if (rootProp === "params") {
    return !isNonReactiveCapture(binding, nonReactiveCaptures);
  }
  return true;
}

function buildPlainCaptureAccessExpression(
  root: ts.Expression,
  binding: DestructureBinding,
  factory: ts.NodeFactory,
): ts.Expression {
  if (binding.directKeyExpression) {
    return factory.createElementAccessExpression(
      root,
      cloneKeyExpression(binding.directKeyExpression, factory),
    );
  }

  let current = root;
  for (const segment of binding.path) {
    current = typeof segment === "string"
      ? factory.createPropertyAccessExpression(
        current,
        factory.createIdentifier(segment),
      )
      : factory.createElementAccessExpression(
        current,
        cloneKeyExpression(segment, factory),
      );
  }
  return current;
}

/** How `registerCapabilitySummary()` analyzes the callback it is handed. */
export interface CapabilitySummaryRegistration {
  /** Whether the analysis follows calls into the callees it can resolve. */
  readonly interprocedural: boolean;

  /**
   * Whether the callback is a `pattern()` callback, whose first parameter is
   * the pattern's input (`patternCallback` in `CapabilityAnalysisOptions`).
   */
  readonly patternCallback?: boolean;

  /** Static destructuring defaults to merge in, by parameter name. */
  readonly defaultsByParamName?: ReadonlyMap<
    string,
    readonly CapabilityParamDefault[]
  >;
}

/**
 * Analyzes `callback`'s capabilities and records the summary on `context`,
 * where schema injection reads it back for the callback's parameters.
 */
export function registerCapabilitySummary(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  { interprocedural, patternCallback, defaultsByParamName }:
    CapabilitySummaryRegistration,
): void {
  const summary = analyzeFunctionCapabilities(callback, {
    checker: context.checker,
    typeRegistry: context.state.typeRegistry,
    interprocedural,
    patternCallback,
  });

  if (!defaultsByParamName || defaultsByParamName.size === 0) {
    context.recordCapabilitySummary(callback, summary);
    return;
  }

  context.recordCapabilitySummary(callback, {
    ...summary,
    params: summary.params.map((param) => {
      const defaults = defaultsByParamName.get(param.name);
      if (!defaults || defaults.length === 0) {
        return param;
      }
      const defaultPaths = defaults.map((entry) => entry.path);
      return {
        ...param,
        readPaths: uniquePaths([...param.readPaths, ...defaultPaths]),
        defaults,
      };
    }),
  });
}

export function transformPatternCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
  isArrayMethodCallback = false,
  nonReactiveCaptures?: ReadonlySet<string>,
): ts.ArrowFunction | ts.FunctionExpression {
  const factory = context.factory;
  const firstParam = callback.parameters[0];
  const opaqueRoots = new Set<string>();
  const opaqueRootSymbols = new Set<ts.Symbol>();
  const diagnostics: string[] = [];
  const extractedDefaults: DefaultDestructureBinding[] = [];
  let hasUnsupportedDestructuring = false;
  let summaryParamName: string | undefined;

  let updatedParameters = callback.parameters;
  let prologue: ts.Statement[] = [];

  if (firstParam) {
    if (ts.isIdentifier(firstParam.name)) {
      opaqueRoots.add(firstParam.name.text);
      const symbol = context.checker.getSymbolAtLocation(firstParam.name);
      if (symbol) {
        opaqueRootSymbols.add(symbol);
      }
      summaryParamName = firstParam.name.text;
    } else if (
      ts.isObjectBindingPattern(firstParam.name) ||
      ts.isArrayBindingPattern(firstParam.name)
    ) {
      const bindings: DestructureBinding[] = [];
      collectDestructureBindings(
        firstParam.name,
        [],
        bindings,
        extractedDefaults,
        diagnostics,
        context,
      );
      if (diagnostics.length > 0) {
        for (const message of diagnostics) {
          reportComputationError(context, firstParam, message);
        }
        hasUnsupportedDestructuring = true;
      }

      const inputIdentifier = factory.createIdentifier("__cf_pattern_input");
      opaqueRoots.add(inputIdentifier.text);
      const inputSymbol = context.checker.getSymbolAtLocation(firstParam.name);
      if (inputSymbol) {
        opaqueRootSymbols.add(inputSymbol);
      }
      addBindingTargetSymbols(
        firstParam.name,
        opaqueRootSymbols,
        context.checker,
      );

      const rewrittenFirstParam = factory.updateParameterDeclaration(
        firstParam,
        firstParam.modifiers,
        firstParam.dotDotDotToken,
        inputIdentifier,
        firstParam.questionToken,
        firstParam.type,
        firstParam.initializer,
      );
      summaryParamName = inputIdentifier.text;

      updatedParameters = factory.createNodeArray([
        rewrittenFirstParam,
        ...callback.parameters.slice(1),
      ]);

      prologue = bindings.map((binding) => {
        let initializer: ts.Expression;
        if (binding.directKeyExpression) {
          initializer = factory.createElementAccessExpression(
            factory.createIdentifier(inputIdentifier.text),
            cloneKeyExpression(binding.directKeyExpression, factory),
          );
        } else if (binding.path.length === 0) {
          initializer = factory.createIdentifier(inputIdentifier.text);
        } else {
          initializer = createPathRead(
            inputIdentifier,
            binding.path,
            factory,
          );
        }

        if (
          isArrayMethodCallback &&
          isNonReactiveCapture(binding, nonReactiveCaptures)
        ) {
          initializer = buildPlainCaptureAccessExpression(
            factory.createIdentifier(inputIdentifier.text),
            binding,
            factory,
          );
        }

        const declaration = preserveSourceMapRange(
          factory.createVariableDeclaration(
            factory.createIdentifier(binding.localName),
            undefined,
            undefined,
            initializer,
          ),
          binding.bindingNode,
        );
        return preserveSourceMapRange(
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [declaration],
              ts.NodeFlags.Const,
            ),
          ),
          binding.bindingNode,
        );
      });
      for (const binding of bindings) {
        if (
          isArrayMethodCallback &&
          !isReactiveArrayMethodBinding(binding, nonReactiveCaptures)
        ) {
          continue;
        }
        opaqueRoots.add(binding.localName);
      }
    } else {
      reportComputationError(
        context,
        firstParam,
        "Pattern parameter destructuring form is not lowerable. Use an object parameter and explicit input.key(...) bindings.",
      );
      hasUnsupportedDestructuring = true;
    }
  }

  if (hasUnsupportedDestructuring) {
    registerCapabilitySummary(callback, context, {
      interprocedural: false,
      patternCallback: true,
    });
    return callback;
  }

  const defaultsByParamName = new Map<
    string,
    readonly CapabilityParamDefault[]
  >();
  if (summaryParamName && extractedDefaults.length > 0) {
    defaultsByParamName.set(
      summaryParamName,
      extractedDefaults.map((entry) => ({
        path: entry.path,
        defaultType: entry.defaultType,
      })),
    );
  }

  let body: ts.ConciseBody = callback.body;
  body = rewritePatternCallbackBody(
    body,
    opaqueRoots,
    opaqueRootSymbols,
    context,
  );

  if (prologue.length > 0) {
    if (ts.isBlock(body)) {
      body = factory.createBlock([...prologue, ...body.statements], true);
    } else {
      body = factory.createBlock(
        [...prologue, factory.createReturnStatement(body)],
        true,
      );
    }
  }

  if (ts.isArrowFunction(callback)) {
    const transformed = factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      updatedParameters,
      callback.type,
      callback.equalsGreaterThanToken,
      body,
    );
    registerCapabilitySummary(transformed, context, {
      interprocedural: false,
      patternCallback: true,
      defaultsByParamName,
    });
    return transformed;
  }

  const transformed = factory.updateFunctionExpression(
    callback,
    callback.modifiers,
    callback.asteriskToken,
    callback.name,
    callback.typeParameters,
    updatedParameters,
    callback.type,
    body as ts.Block,
  );
  registerCapabilitySummary(transformed, context, {
    interprocedural: false,
    patternCallback: true,
    defaultsByParamName,
  });
  return transformed;
}
