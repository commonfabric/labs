import ts from "typescript";
import {
  type SchemaGenerationDiagnostic,
  SchemaGenerator,
} from "@commonfabric/schema-generator";

import {
  classifyLegacyPatternCarrier,
  findEnclosingPatternBuilderCallbackDescriptor,
  getPatternBuilderCallbackArgument,
  inferWidenedTypeFromExpression,
  isPatternBuilderCall,
} from "../../ast/mod.ts";
import { expressionToTypeNode } from "../../ast/type-building.ts";
import type { TransformationContext } from "../../core/mod.ts";
import {
  findFactoryInputFrameworkProvidedPaths,
  findFrameworkProvidedPaths,
} from "../../policy/framework-provided.ts";
import {
  buildCapturePropertyAssignments,
  type CaptureTreeNode,
  findCaptureRootIdentifier,
  preserveCaptureReferenceOrigins,
} from "../../utils/capture-tree.ts";
import {
  createPropertyName,
  extractBindingNames,
  reserveIdentifier,
} from "../../utils/identifiers.ts";
import { unwrapExpression } from "../../utils/expression.ts";
import {
  type PatternFactorySchemaContractHint,
  propagateFactoryContractHints,
  resolvePatternFactorySchemaContract,
} from "../../transformers/schema-injection.ts";
import { CaptureCollector } from "../capture-collector.ts";
import { createHandlerStateSchema } from "../utils/schema-factory.ts";

/**
 * Closure-convert an authored pattern used as a value inside another pattern.
 *
 * Public input remains callback argument 0. Non-module lexical captures are
 * supplied through compiler-private callback argument 1 and bound exactly once
 * by the generated `.curry(captures)` call. Module-scoped declarations remain
 * lexical so the base artifact can be evaluated in its defining module.
 */
export class PatternStrategy {
  canTransform(
    node: ts.Node,
    context: TransformationContext,
  ): boolean {
    return ts.isCallExpression(node) &&
      isPatternBuilderCall(node, context.checker) &&
      isPatternOwnedNestedValue(node, context.checker) &&
      classifyLegacyPatternCarrier(node) === undefined;
  }

  transform(
    node: ts.Node,
    context: TransformationContext,
    visitor: ts.Visitor,
  ): ts.Node | undefined {
    if (!ts.isCallExpression(node)) {
      throw new Error("PatternStrategy.transform requires a call expression");
    }

    const callback = getPatternBuilderCallbackArgument(node, context.checker);
    if (!callback) return undefined;

    const collector = new CaptureCollector(context.checker, {
      captureNonModuleExternalIdentifiers: true,
      captureNonModuleExternalPropertyAccesses: true,
    });
    const { captureTree } = collector.analyzeCurrentAndOriginal(callback);

    const frameworkProvided = findFrameworkProvidedViolation(
      captureTree,
      context,
    );
    if (frameworkProvided) {
      context.reportDiagnosticOnce({
        severity: "error",
        type: "pattern-callback:framework-provided-wrapper",
        message: frameworkProvided.message,
        node: frameworkProvided.node,
      });
      return node;
    }

    const transformedBody = ts.visitNode(
      callback.body,
      visitor,
    ) as ts.ConciseBody;

    const visitedCallback = updateCallbackBody(
      callback,
      transformedBody,
      context.factory,
    );
    const originalPattern = ts.getOriginalNode(node);
    const contractPattern = ts.isCallExpression(originalPattern)
      ? originalPattern
      : node;
    // Resolve after recursive closure conversion so an outer wrapper's
    // output contract sees the compiler-owned hints attached to nested
    // factories rather than freezing the source overload's `any` result.
    const factoryContract = resolvePatternFactorySchemaContract(
      contractPattern,
      visitedCallback,
      context,
    );

    // A capture-free nested pattern has no private params slot and therefore no
    // compiler-only wrapper or curry. BuilderCallHoistingTransformer still
    // relocates the base factory and replaces this site with its hoisted name.
    if (captureTree.size === 0) {
      const captureFreePattern = context.cfHelpers.createHelperCall(
        "pattern",
        node,
        node.typeArguments,
        [visitedCallback, ...node.arguments.slice(1)],
      );
      registerOriginalFactoryType(node, captureFreePattern, context);
      registerFactoryContractHint(
        captureFreePattern,
        node,
        factoryContract,
        context,
      );
      return captureFreePattern;
    }

    const captureRenames = resolveCaptureNameCollisions(
      callback,
      captureTree,
      context.factory,
    );
    const callbackWithRenamedCaptures = rewriteRenamedCaptureReferences(
      visitedCallback,
      captureTree,
      captureRenames,
      context,
    );
    const callbackWithParams = addCaptureParameter(
      callbackWithRenamedCaptures,
      captureTree.keys(),
      captureRenames,
      context.factory,
    );

    const captureProperties = buildCapturePropertyAssignments(
      captureTree,
      context.factory,
    );
    preserveCaptureReferenceOrigins(captureProperties, captureTree);
    const captures = context.factory.createObjectLiteralExpression(
      captureProperties,
      captureTree.size > 1,
    );

    const hasUnrepresentableCapture = reportUnrepresentableCaptureSchemas(
      captureTree,
      context,
    );
    const paramsType = hasUnrepresentableCapture
      ? context.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)
      : createHandlerStateSchema(captureTree, undefined, context);
    if (!hasUnrepresentableCapture) {
      propagateFactoryContractHints(captures, paramsType, context);
    }
    const paramsSchema = context.cfHelpers.createHelperCall(
      "toSchema",
      callback,
      [paramsType],
      [],
    );
    const wrappedCallback = context.cfHelpers.createHelperCall(
      "withPatternParamsSchema",
      callback,
      undefined,
      [callbackWithParams, paramsSchema],
    );

    const basePattern = context.cfHelpers.createHelperCall(
      "pattern",
      node,
      node.typeArguments,
      [wrappedCallback, ...node.arguments.slice(1)],
    );

    const curriedPattern = context.factory.createCallExpression(
      context.factory.createPropertyAccessExpression(basePattern, "curry"),
      undefined,
      [captures],
    );
    registerOriginalFactoryType(node, basePattern, context);
    registerOriginalFactoryType(node, curriedPattern, context);
    registerFactoryContractHint(basePattern, node, factoryContract, context);
    registerFactoryContractHint(curriedPattern, node, factoryContract, context);
    return curriedPattern;
  }
}

function registerFactoryContractHint(
  generated: ts.Expression,
  authored: ts.CallExpression,
  contract: PatternFactorySchemaContractHint | undefined,
  context: TransformationContext,
): void {
  if (!contract) return;
  const hint = { factoryContracts: [contract] } as const;
  context.recordSchemaHint(generated, hint);
  context.recordSchemaHint(authored, hint);
}

function reportUnrepresentableCaptureSchemas(
  captureTree: ReadonlyMap<string, CaptureTreeNode>,
  context: TransformationContext,
): boolean {
  const schemaGenerator = new SchemaGenerator();
  let found = false;

  const visit = (node: CaptureTreeNode): void => {
    if (node.expression) {
      const type = inferWidenedTypeFromExpression(
        node.expression,
        context.checker,
        context.options.state?.typeRegistry,
      );
      if (!type) return;

      try {
        let generationError: SchemaGenerationDiagnostic | undefined;
        schemaGenerator.generateSchema(
          type,
          context.checker,
          expressionToTypeNode(node.expression, context),
          {
            onDiagnostic: (diagnostic) => {
              if (diagnostic.severity === "error" && !generationError) {
                generationError = diagnostic;
              }
            },
          },
          context.options.state?.schemaHints,
          context.sourceFile,
        );
        if (generationError) throw new Error(generationError.message);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        found = true;
        const typeName = context.checker.typeToString(type);
        context.reportDiagnosticOnce({
          severity: "error",
          type: "pattern-capture:unrepresentable-schema",
          message:
            `Pattern closure capture \`${captureLabel(node.expression)}\` ` +
            `has type \`${typeName}\`, which cannot be represented by a ` +
            `Fabric schema. Capture only serializable data with a supported ` +
            `schema type. ${error.message}`,
          node: node.expression,
        });
      }
      return;
    }

    for (const child of node.properties.values()) visit(child);
  };

  for (const node of captureTree.values()) visit(node);
  return found;
}

function captureLabel(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "value";
}

interface FrameworkProvidedViolation {
  readonly message: string;
  readonly node: ts.Node;
}

function findFrameworkProvidedViolation(
  captureTree: ReadonlyMap<string, CaptureTreeNode>,
  context: TransformationContext,
): FrameworkProvidedViolation | undefined {
  for (const [root, capture] of captureTree) {
    const violation = findFrameworkProvidedCaptureViolation(
      root,
      capture,
      context,
    );
    if (violation) return violation;
  }

  return undefined;
}

function findFrameworkProvidedCaptureViolation(
  root: string,
  capture: CaptureTreeNode,
  context: TransformationContext,
): FrameworkProvidedViolation | undefined {
  if (capture.expression) {
    const capturePath = [root, ...capture.path];
    const privileged = findFrameworkProvidedExpressionOrigin(
      capture.expression,
      context,
      new Set(),
      new Set(),
    );
    const factoryInputPath = privileged?.factoryInputPath;
    if (factoryInputPath) {
      return {
        message: "Captured factory '" + formatPath(capturePath) +
          "' has a FrameworkProvided operation input '" +
          formatPath(factoryInputPath) +
          "'. Nested pattern closure params cannot carry trusted framework " +
          "obligations; invoke the factory directly so the runner can supply " +
          "those trusted inputs.",
        node: sourceNode(capture.expression),
      };
    }

    const directPath = privileged?.directPath;
    if (directPath) {
      return {
        message: "FrameworkProvided path '" +
          formatPath([...capturePath, ...directPath]) +
          "' cannot be moved into nested pattern closure params. Trusted " +
          "framework values must remain public inputs or be forwarded by a " +
          "direct factory invocation.",
        node: sourceNode(capture.expression),
      };
    }
    return undefined;
  }

  for (const child of capture.properties.values()) {
    const violation = findFrameworkProvidedCaptureViolation(
      root,
      child,
      context,
    );
    if (violation) return violation;
  }
  return undefined;
}

interface FrameworkProvidedExpressionOrigin {
  readonly directPath?: readonly string[];
  readonly factoryInputPath?: readonly string[];
}

function findFrameworkProvidedExpressionOrigin(
  expression: ts.Expression,
  context: TransformationContext,
  activeNodes: Set<ts.Node>,
  activeSymbols: Set<ts.Symbol>,
): FrameworkProvidedExpressionOrigin | undefined {
  const source = sourceNode(expression);
  if (activeNodes.has(source)) return undefined;
  activeNodes.add(source);
  try {
    const type = typeAtSourceNode(source, context);
    if (type) {
      const factoryInputPath = findFactoryInputFrameworkProvidedPaths(
        type,
        context.checker,
      )[0];
      if (factoryInputPath) return { factoryInputPath };
      const directPath = findFrameworkProvidedPaths(type, context.checker)[0];
      if (directPath) return { directPath };
    }

    const target = unwrapExpression(source);
    if (target !== source) {
      return findFrameworkProvidedExpressionOrigin(
        target,
        context,
        activeNodes,
        activeSymbols,
      );
    }

    if (ts.isIdentifier(target)) {
      let symbol = target.parent &&
          ts.isShorthandPropertyAssignment(target.parent)
        ? context.checker.getShorthandAssignmentValueSymbol(target.parent) ??
          context.checker.getSymbolAtLocation(target)
        : context.checker.getSymbolAtLocation(target);
      if (!symbol || activeSymbols.has(symbol)) return undefined;
      const activeSymbol = symbol;
      activeSymbols.add(activeSymbol);
      try {
        if (symbol.flags & ts.SymbolFlags.Alias) {
          symbol = context.checker.getAliasedSymbol(symbol);
        }
        for (const declaration of symbol.getDeclarations() ?? []) {
          if (ts.isBindingElement(declaration)) {
            const bindingOrigin = findFrameworkProvidedBindingOrigin(
              declaration,
              context,
            );
            if (bindingOrigin) return bindingOrigin;
          }
          const initializer = initializerForDeclaration(declaration);
          if (!initializer) continue;
          const origin = findFrameworkProvidedExpressionOrigin(
            initializer,
            context,
            activeNodes,
            activeSymbols,
          );
          if (origin) return origin;
        }
      } finally {
        activeSymbols.delete(activeSymbol);
      }
      return undefined;
    }

    if (
      ts.isPropertyAccessExpression(target) ||
      ts.isElementAccessExpression(target)
    ) {
      return findFrameworkProvidedExpressionOrigin(
        target.expression,
        context,
        activeNodes,
        activeSymbols,
      );
    }

    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        const initializer = ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : ts.isSpreadAssignment(property)
          ? property.expression
          : undefined;
        if (!initializer) continue;
        const origin = findFrameworkProvidedExpressionOrigin(
          initializer,
          context,
          activeNodes,
          activeSymbols,
        );
        if (origin) return origin;
      }
      return undefined;
    }

    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue;
        const value = ts.isSpreadElement(element)
          ? element.expression
          : element;
        const origin = findFrameworkProvidedExpressionOrigin(
          value,
          context,
          activeNodes,
          activeSymbols,
        );
        if (origin) return origin;
      }
      return undefined;
    }

    if (ts.isConditionalExpression(target)) {
      return findFrameworkProvidedExpressionOrigin(
        target.whenTrue,
        context,
        activeNodes,
        activeSymbols,
      ) ?? findFrameworkProvidedExpressionOrigin(
        target.whenFalse,
        context,
        activeNodes,
        activeSymbols,
      );
    }

    if (
      ts.isBinaryExpression(target) &&
      (target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        target.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return findFrameworkProvidedExpressionOrigin(
        target.left,
        context,
        activeNodes,
        activeSymbols,
      ) ?? findFrameworkProvidedExpressionOrigin(
        target.right,
        context,
        activeNodes,
        activeSymbols,
      );
    }
    return undefined;
  } finally {
    activeNodes.delete(source);
  }
}

function findFrameworkProvidedBindingOrigin(
  binding: ts.BindingElement,
  context: TransformationContext,
): FrameworkProvidedExpressionOrigin | undefined {
  const resolved = bindingPathToParameter(binding);
  if (!resolved) return undefined;
  const descriptor = (ts.isArrowFunction(resolved.parameter.parent) ||
      ts.isFunctionExpression(resolved.parameter.parent))
    ? findEnclosingPatternBuilderCallbackDescriptor(
      resolved.parameter.parent,
      context.checker,
    )
    : undefined;
  const parameterTypeNode = descriptor?.call.typeArguments?.[0] ??
    resolved.parameter.type ?? resolved.parameter;
  const parameterType = typeAtSourceNode(parameterTypeNode, context);
  if (!parameterType) return undefined;

  const factoryInputPath = findFactoryInputFrameworkProvidedPaths(
    parameterType,
    context.checker,
  ).find((path) => pathStartsWith(path, resolved.path));
  if (factoryInputPath) {
    return { factoryInputPath: factoryInputPath.slice(resolved.path.length) };
  }
  const directPath = findFrameworkProvidedPaths(
    parameterType,
    context.checker,
  ).find((path) => pathStartsWith(path, resolved.path));
  return directPath
    ? { directPath: directPath.slice(resolved.path.length) }
    : undefined;
}

function bindingPathToParameter(
  binding: ts.BindingElement,
):
  | { readonly parameter: ts.ParameterDeclaration; readonly path: string[] }
  | undefined {
  const path: string[] = [];
  let current: ts.BindingElement = binding;
  while (true) {
    const pattern = current.parent;
    if (ts.isObjectBindingPattern(pattern)) {
      const name = current.propertyName ?? current.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) {
        return undefined;
      }
      path.unshift(name.text);
    } else if (ts.isArrayBindingPattern(pattern)) {
      path.unshift("[]");
    } else {
      return undefined;
    }

    const owner = pattern.parent;
    if (ts.isParameter(owner)) return { parameter: owner, path };
    if (!ts.isBindingElement(owner)) return undefined;
    current = owner;
  }
}

function pathStartsWith(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  return prefix.length <= path.length &&
    prefix.every((segment, index) => path[index] === segment);
}

function initializerForDeclaration(
  declaration: ts.Declaration,
): ts.Expression | undefined {
  if (
    ts.isVariableDeclaration(declaration) ||
    ts.isParameter(declaration) ||
    ts.isBindingElement(declaration)
  ) {
    if (declaration.initializer) return declaration.initializer;
  }
  if (ts.isBindingElement(declaration)) {
    let current: ts.Node | undefined = declaration.parent;
    while (current && !ts.isFunctionLike(current)) {
      if (ts.isVariableDeclaration(current)) return current.initializer;
      current = current.parent;
    }
  }
  return undefined;
}

function typeAtSourceNode(
  node: ts.Node,
  context: TransformationContext,
): ts.Type | undefined {
  const original = sourceNode(node);
  const registry = context.options.state?.typeRegistry;
  const registered = registry?.get(node) ?? registry?.get(original);
  if (registered) return registered;
  try {
    return context.checker.getTypeAtLocation(original);
  } catch {
    return undefined;
  }
}

function sourceNode<T extends ts.Node>(node: T): T {
  return ts.getOriginalNode(node) as T;
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? "<root>" : path.join(".").replaceAll(".[]", "[]");
}

function registerOriginalFactoryType(
  original: ts.CallExpression,
  generated: ts.Expression,
  context: TransformationContext,
): void {
  const typeRegistry = context.options.state?.typeRegistry;
  if (typeRegistry) {
    typeRegistry.set(generated, context.checker.getTypeAtLocation(original));
  }
}

function updateCallbackBody(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  body: ts.ConciseBody,
  factory: ts.NodeFactory,
): ts.ArrowFunction | ts.FunctionExpression {
  if (ts.isArrowFunction(callback)) {
    return factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      callback.parameters,
      callback.type,
      callback.equalsGreaterThanToken,
      body,
    );
  }
  return factory.updateFunctionExpression(
    callback,
    callback.modifiers,
    callback.asteriskToken,
    callback.name,
    callback.typeParameters,
    callback.parameters,
    callback.type,
    body as ts.Block,
  );
}

function addCaptureParameter(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  captureNames: Iterable<string>,
  captureRenames: ReadonlyMap<string, string>,
  factory: ts.NodeFactory,
): ts.ArrowFunction | ts.FunctionExpression {
  const params = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createObjectBindingPattern(
      Array.from(captureNames, (name) => {
        const bindingName = captureRenames.get(name) ?? name;
        return factory.createBindingElement(
          undefined,
          bindingName === name ? undefined : createPropertyName(name, factory),
          factory.createIdentifier(bindingName),
          undefined,
        );
      }),
    ),
    undefined,
    undefined,
    undefined,
  );
  const publicInput = callback.parameters[0] ??
    factory.createParameterDeclaration(
      undefined,
      undefined,
      factory.createIdentifier("__cf_pattern_input"),
      undefined,
      // Preserve the authored zero-input contract through schema injection.
      // The runtime still supplies callback argument 0; `never` emits the same
      // `false` public schema that an authored zero-parameter callback had.
      factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword),
      undefined,
    );
  const parameters = factory.createNodeArray([
    publicInput,
    params,
  ]);

  if (ts.isArrowFunction(callback)) {
    return factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      parameters,
      callback.type,
      callback.equalsGreaterThanToken,
      callback.body,
    );
  }
  return factory.updateFunctionExpression(
    callback,
    callback.modifiers,
    callback.asteriskToken,
    callback.name,
    callback.typeParameters,
    parameters,
    callback.type,
    callback.body,
  );
}

function resolveCaptureNameCollisions(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  captureTree: ReadonlyMap<string, CaptureTreeNode>,
  factory: ts.NodeFactory,
): Map<string, string> {
  const usedNames = new Set<string>();
  for (const parameter of callback.parameters) {
    for (const name of extractBindingNames(parameter.name)) {
      usedNames.add(name);
    }
  }

  // Destructured public input is lowered to this identifier in the next stage.
  // Reserve it now so a lexical capture with the same authored name cannot
  // produce duplicate bindings in the generated two-argument callback.
  const firstParameter = callback.parameters[0];
  if (!firstParameter || !ts.isIdentifier(firstParameter.name)) {
    usedNames.add("__cf_pattern_input");
  }

  const renames = new Map<string, string>();
  for (const captureName of captureTree.keys()) {
    if (!usedNames.has(captureName)) {
      usedNames.add(captureName);
      continue;
    }
    renames.set(
      captureName,
      reserveIdentifier(captureName, usedNames, factory).text,
    );
  }
  return renames;
}

function rewriteRenamedCaptureReferences(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  captureTree: ReadonlyMap<string, CaptureTreeNode>,
  renames: ReadonlyMap<string, string>,
  context: TransformationContext,
): ts.ArrowFunction | ts.FunctionExpression {
  if (renames.size === 0) return callback;

  const renameBySymbol = new Map<ts.Symbol, string>();
  for (const [rootName, renamed] of renames) {
    const root = findCaptureRootIdentifier(captureTree.get(rootName));
    const symbol = root && context.checker.getSymbolAtLocation(root);
    if (symbol) renameBySymbol.set(symbol, renamed);
  }

  const renamedForIdentifier = (identifier: ts.Identifier) => {
    const symbol = context.checker.getSymbolAtLocation(identifier);
    if (symbol) return renameBySymbol.get(symbol);
    return identifier.pos < 0 ? renames.get(identifier.text) : undefined;
  };

  const visit: ts.Visitor = (node) => {
    if (ts.isShorthandPropertyAssignment(node)) {
      const symbol = context.checker.getShorthandAssignmentValueSymbol(node) ??
        context.checker.getSymbolAtLocation(node.name);
      const renamed = symbol ? renameBySymbol.get(symbol) : undefined;
      if (renamed) {
        return context.factory.createPropertyAssignment(
          node.name,
          context.factory.createIdentifier(renamed),
        );
      }
    }
    if (ts.isIdentifier(node)) {
      const renamed = renamedForIdentifier(node);
      if (renamed) return context.factory.createIdentifier(renamed);
    }
    return ts.visitEachChild(node, visit, context.tsContext);
  };

  const body = ts.visitNode(callback.body, visit) as ts.ConciseBody;
  return updateCallbackBody(callback, body, context.factory);
}

/** True when this builder call appears in the callback subtree of another pattern. */
function isPatternOwnedNestedValue(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  if (hasEnclosingPatternBuilder(call.parent, checker)) return true;

  // Earlier passes (notably symbolic factory-call lowering) clone every
  // ancestor between a rewritten call and the source file. TypeScript keeps
  // the authored call as the clone's original, but the clone's parent chain
  // does not necessarily retain the enclosing builder. Consult the authored
  // ancestry as the stable ownership source so eager calls inside a nested
  // pattern cannot accidentally suppress its closure conversion.
  const original = ts.getOriginalNode(call);
  return original !== call && hasEnclosingPatternBuilder(
    original.parent,
    checker,
  );
}

function hasEnclosingPatternBuilder(
  node: ts.Node | undefined,
  checker: ts.TypeChecker,
): boolean {
  let current = node;
  while (current) {
    if (
      ts.isCallExpression(current) && isPatternBuilderCall(current, checker)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}
