import ts from "typescript";
import type { JSONSchema } from "@commonfabric/api";
import { addRequiredSchemaPaths } from "@commonfabric/data-model-schema";
import { SchemaGenerator } from "@commonfabric/schema-generator";
import { utf8Compare } from "@commonfabric/text/utf8";

import {
  classifyFactoryCallTarget,
  detectCallKind,
  getPatternBuilderCallbackDescriptor,
  isFactoryModifierAccess,
  isPatternBuilderCall,
  updatePatternBuilderCallbackArgument,
} from "../ast/mod.ts";
import {
  type FactoryContractHint,
  factoryContractProvenanceFromTypeNode,
} from "../ast/factory-contract-hints.ts";
import { unwrapExpression } from "../utils/expression.ts";
import {
  extractBindingNames,
  reserveIdentifier,
} from "../utils/identifiers.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import {
  findFactoryInputFrameworkProvidedPaths,
  findFrameworkProvidedPaths,
  type FrameworkProvidedPath,
} from "../policy/framework-provided.ts";
import { resolvePatternFactorySchemaContract } from "./schema-injection.ts";

type FunctionExpression = ts.ArrowFunction | ts.FunctionExpression;
type ResolvedFunction =
  | FunctionExpression
  | (ts.FunctionDeclaration & { readonly body: ts.Block });
/** Structurally forward protected aliases before symbolic call lowering. */
export class FrameworkProvidedForwardingTransformer
  extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const visit: ts.Visitor = (node) => {
      const visited = ts.visitEachChild(node, visit, context.tsContext);
      if (!ts.isCallExpression(visited)) return visited;
      const descriptor = getPatternBuilderCallbackDescriptor(
        visited,
        context.checker,
      );
      if (!descriptor) {
        validateScheduledFactoryCalls(visited, context);
        return visited;
      }
      const rewritten = rewritePatternCallback(descriptor.callback, context);
      if (rewritten.callback === descriptor.callback) return visited;
      const updatedArgument = updatePatternBuilderCallbackArgument(
        descriptor,
        rewritten.callback,
        context.factory,
      );
      const updated = context.factory.updateCallExpression(
        visited,
        visited.expression,
        visited.typeArguments,
        [updatedArgument, ...visited.arguments.slice(1)],
      );
      recordTransitiveFactoryContract(
        visited,
        updated,
        rewritten.callback,
        rewritten.paths,
        context,
      );
      return updated;
    };
    const transformed = ts.visitNode(
      context.sourceFile,
      visit,
    ) as ts.SourceFile;
    annotateFactoryContractTypeNodes(transformed, context);
    return transformed;
  }
}

function recordTransitiveFactoryContract(
  authored: ts.CallExpression,
  generated: ts.CallExpression,
  callback: FunctionExpression,
  paths: readonly FrameworkProvidedPath[],
  context: TransformationContext,
): void {
  const authoritative = buildTransitiveFactoryContract(
    authored,
    callback,
    paths,
    context,
  );
  if (!authoritative) return;
  context.recordSchemaHint(authored, { factoryContracts: [authoritative] });
  context.recordSchemaHint(generated, { factoryContracts: [authoritative] });

  const owner = factoryContractOwnerSymbol(authored, context.checker);
  if (owner) {
    context.recordFactoryContractForSymbol(owner, authoritative);
  }
}

function buildTransitiveFactoryContract(
  authored: ts.CallExpression,
  callback: FunctionExpression,
  paths: readonly FrameworkProvidedPath[],
  context: TransformationContext,
): FactoryContractHint | undefined {
  if (paths.length === 0) return undefined;
  const contract = resolvePatternFactorySchemaContract(
    authored,
    callback,
    context,
  );
  if (!contract) return undefined;

  const inputType = contract.inputType ?? typeAtNode(
    contract.inputTypeNode,
    context,
  );
  if (!inputType && contract.inputSchema === undefined) return undefined;
  const baseSchema = contract.inputSchema as JSONSchema | undefined ??
    new SchemaGenerator().generateSchema(
      inputType!,
      context.checker,
      contract.inputTypeNode,
      undefined,
      context.options.state?.schemaHints,
      context.sourceFile,
    );
  return {
    ...contract,
    inputSchema: addRequiredSchemaPaths(baseSchema, paths),
    frameworkProvidedPaths: paths,
  };
}

function annotateFactoryContractTypeNodes(
  sourceFile: ts.SourceFile,
  context: TransformationContext,
): void {
  const visitedTypes = new Set<ts.Node>();
  const annotateQueries = (node: ts.Node): void => {
    const original = ts.getOriginalNode(node);
    if (visitedTypes.has(node) || visitedTypes.has(original)) return;
    visitedTypes.add(node);
    visitedTypes.add(original);
    if (ts.isTypeQueryNode(node)) {
      const symbol = canonicalSymbol(
        context.checker.getSymbolAtLocation(node.exprName),
        context.checker,
      );
      const contracts = symbol && (
        context.lookupFactoryContractsForSymbol(symbol) ??
          discoverFactoryContractsForSymbol(symbol, context, new Set())
      );
      if (contracts?.length) {
        context.recordSchemaHint(node, { factoryContracts: contracts });
      }
    }
    if (ts.isTypeReferenceNode(node)) {
      let symbol = context.checker.getSymbolAtLocation(node.typeName);
      symbol = canonicalSymbol(symbol, context.checker);
      const alias = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
      if (alias) annotateQueries(alias.type);
    }
    ts.forEachChild(node, annotateQueries);
  };
  annotateQueries(sourceFile);

  const annotateAliasesAndUnions = (node: ts.Node): void => {
    if (
      ts.isTypeReferenceNode(node) || ts.isUnionTypeNode(node) ||
      ts.isIntersectionTypeNode(node) || ts.isParenthesizedTypeNode(node) ||
      ts.isTypeOperatorNode(node)
    ) {
      const provenance = factoryContractProvenanceFromTypeNode(node, context);
      if (provenance.complete && provenance.contracts.length > 0) {
        context.recordSchemaHint(node, {
          factoryContracts: provenance.contracts,
        });
      }
    }
    ts.forEachChild(node, annotateAliasesAndUnions);
  };
  annotateAliasesAndUnions(sourceFile);
}

function discoverFactoryContractsForSymbol(
  symbol: ts.Symbol,
  context: TransformationContext,
  activeSymbols: Set<ts.Symbol>,
): readonly FactoryContractHint[] | undefined {
  const canonical = canonicalSymbol(symbol, context.checker) ?? symbol;
  const existing = context.lookupFactoryContractsForSymbol(canonical);
  if (existing?.length || activeSymbols.has(canonical)) return existing;
  activeSymbols.add(canonical);
  try {
    for (const declaration of canonical.getDeclarations() ?? []) {
      const initializer = ts.isVariableDeclaration(declaration)
        ? isConstVariableDeclaration(declaration)
          ? declaration.initializer
          : undefined
        : ts.isExportAssignment(declaration)
        ? declaration.expression
        : undefined;
      if (!initializer) continue;
      const declarationContext = contextForDeclaration(declaration, context);
      const contracts = discoverFactoryContractsForExpression(
        initializer,
        declarationContext,
        activeSymbols,
      );
      if (!contracts?.length) continue;
      for (const contract of contracts) {
        declarationContext.recordFactoryContractForSymbol(canonical, contract);
      }
      return contracts;
    }
    return undefined;
  } finally {
    activeSymbols.delete(canonical);
  }
}

function discoverFactoryContractsForExpression(
  expression: ts.Expression,
  context: TransformationContext,
  activeSymbols: Set<ts.Symbol>,
): readonly FactoryContractHint[] | undefined {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    const symbol = canonicalSymbol(
      context.checker.getSymbolAtLocation(target),
      context.checker,
    );
    return symbol
      ? discoverFactoryContractsForSymbol(symbol, context, activeSymbols)
      : undefined;
  }
  if (!ts.isCallExpression(target)) return undefined;
  if (isPatternBuilderCall(target, context.checker)) {
    const descriptor = getPatternBuilderCallbackDescriptor(
      target,
      context.checker,
    );
    if (!descriptor) return undefined;
    const rewritten = rewritePatternCallback(descriptor.callback, context);
    const contract = buildTransitiveFactoryContract(
      target,
      rewritten.callback,
      rewritten.paths,
      context,
    );
    if (!contract) return undefined;
    context.recordSchemaHint(target, { factoryContracts: [contract] });
    return [contract];
  }
  const callee = unwrapExpression(target.expression);
  if (isFactoryModifierAccess(callee)) {
    return discoverFactoryContractsForExpression(
      callee.expression,
      context,
      activeSymbols,
    );
  }
  return undefined;
}

function contextForDeclaration(
  declaration: ts.Declaration,
  context: TransformationContext,
): TransformationContext {
  const sourceFile = declaration.getSourceFile();
  return sourceFile === context.sourceFile
    ? context
    : new TransformationContext({
      program: context.program,
      sourceFile,
      tsContext: context.tsContext,
      options: context.options,
    });
}

function factoryContractOwnerSymbol(
  node: ts.Node,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      if (!isConstVariableDeclaration(current)) return undefined;
      const initializer = current.initializer &&
        unwrapExpression(current.initializer);
      if (
        !initializer ||
        (initializer !== node &&
          ts.getOriginalNode(initializer) !== ts.getOriginalNode(node))
      ) {
        // A nested factory in an object/array-valued initializer does not
        // grant that containing variable the nested factory's authority.
        return undefined;
      }
      return canonicalSymbol(
        checker.getSymbolAtLocation(current.name),
        checker,
      );
    }
    current = current.parent;
  }
  return undefined;
}

function isConstVariableDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  return ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function canonicalSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function typeAtNode(
  node: ts.Node,
  context: TransformationContext,
): ts.Type | undefined {
  const original = ts.getOriginalNode(node);
  const registered = context.options.state?.typeRegistry.get(node) ??
    context.options.state?.typeRegistry.get(original);
  if (registered) return registered;
  try {
    return context.checker.getTypeAtLocation(original);
  } catch {
    return undefined;
  }
}

/** Attach trusted path metadata after schema and callback lowering. */
export class FrameworkProvidedTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const visit: ts.Visitor = (node) => {
      const visited = ts.visitEachChild(node, visit, context.tsContext);
      if (!ts.isCallExpression(visited)) return visited;

      const descriptor = getPatternBuilderCallbackDescriptor(
        visited,
        context.checker,
      );
      if (!descriptor) {
        return addNonPatternFactoryMetadata(visited, context);
      }

      const declared = frameworkPathsForParameter(
        descriptor.callback.parameters[0],
        context,
      );
      const paths = mergePaths(
        declared,
        frameworkPathsForCallback(descriptor.callback, context),
      );
      const call = visited;
      if (paths.length === 0) return call;
      const invalid = paths.find((path) => !isSupportedPath(path));
      if (invalid) {
        context.reportDiagnosticOnce({
          severity: "error",
          type: "framework-provided:non-static-path",
          message: `FrameworkProvided path '${
            invalid.join(".")
          }' cannot be forwarded; only non-empty object-property paths are supported.`,
          node: descriptor.callback,
        });
        return call;
      }

      const currentDescriptor = getPatternBuilderCallbackDescriptor(
        call,
        context.checker,
      );
      if (!currentDescriptor) return call;
      const carrier = context.cfHelpers.createHelperCall(
        "withFrameworkProvidedPaths",
        currentDescriptor.argument,
        undefined,
        [currentDescriptor.argument, pathsExpression(paths, context.factory)],
      );
      return context.factory.updateCallExpression(
        call,
        call.expression,
        call.typeArguments,
        [carrier, ...call.arguments.slice(1)],
      );
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }
}

function frameworkPathsForCallback(
  callback: ResolvedFunction,
  context: TransformationContext,
): readonly FrameworkProvidedPath[] {
  const paths: FrameworkProvidedPath[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== callback.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && !isInternalFrameworkHelper(node)) {
      for (
        const path of frameworkPathsForFactoryExpression(
          node.expression,
          context,
          new Set(),
          new Set(),
        )
      ) paths.push(path);
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return mergePaths(paths);
}

function addNonPatternFactoryMetadata(
  call: ts.CallExpression,
  context: TransformationContext,
): ts.CallExpression {
  const kind = detectCallKind(call, context.checker);
  if (
    kind?.kind !== "builder" ||
    (kind.builderName !== "lift" && kind.builderName !== "handler")
  ) {
    return call;
  }
  const callbackIndex = call.arguments.findIndex((argument) =>
    !!resolveFunction(argument, context.checker)
  );
  if (callbackIndex < 0) return call;
  const callbackExpression = call.arguments[callbackIndex]!;
  const callback = resolveFunction(callbackExpression, context.checker);
  if (!callback) return call;
  const parameterIndex = kind.builderName === "handler" ? 1 : 0;
  const paths = frameworkPathsForParameter(
    callback.parameters[parameterIndex],
    context,
  );
  if (paths.length === 0) return call;
  const carrier = context.cfHelpers.createHelperCall(
    "withFrameworkProvidedPaths",
    callbackExpression,
    undefined,
    [callbackExpression, pathsExpression(paths, context.factory)],
  );
  const args = [...call.arguments];
  args[callbackIndex] = carrier;
  return context.factory.updateCallExpression(
    call,
    call.expression,
    call.typeArguments,
    args,
  );
}

function resolveFunction(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ResolvedFunction | undefined {
  const target = unwrapExpression(expression);
  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
    return target;
  }
  if (!ts.isIdentifier(target)) return undefined;
  let symbol = checker.getSymbolAtLocation(ts.getOriginalNode(target));
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (ts.isFunctionDeclaration(declaration) && declaration.body) {
      return declaration as ts.FunctionDeclaration & {
        readonly body: ts.Block;
      };
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const resolved = resolveFunction(declaration.initializer, checker, seen);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function rewritePatternCallback(
  callback: FunctionExpression,
  context: TransformationContext,
): { callback: FunctionExpression; paths: readonly FrameworkProvidedPath[] } {
  // Preserve ordinary callbacks byte-for-byte. Parameter rewriting is needed
  // only when this callback actually forwards a protected factory input; doing
  // it speculatively would perturb every destructured pattern in the repo.
  const protectedCallPaths = frameworkPathsForCallback(callback, context);
  if (protectedCallPaths.length === 0) {
    return { callback, paths: [] };
  }
  let root = callback.parameters[0];
  let updated = callback;
  let bindingPrologue: ts.Statement | undefined;
  if (!root || !ts.isIdentifier(root.name)) {
    const usedNames = new Set<string>();
    for (const parameter of callback.parameters) {
      for (const name of extractBindingNames(parameter.name)) {
        usedNames.add(name);
      }
    }
    const collectNames = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) usedNames.add(node.text);
      ts.forEachChild(node, collectNames);
    };
    collectNames(callback.body);
    const identifier = reserveIdentifier(
      "__cf_framework_input",
      usedNames,
      context.factory,
    );
    const replacement = root
      ? context.factory.updateParameterDeclaration(
        root,
        root.modifiers,
        root.dotDotDotToken,
        identifier,
        root.questionToken,
        root.type,
        root.initializer,
      )
      : context.factory.createParameterDeclaration(
        undefined,
        undefined,
        identifier,
      );
    if (root && !ts.isIdentifier(root.name)) {
      bindingPrologue = context.factory.createVariableStatement(
        undefined,
        context.factory.createVariableDeclarationList(
          [context.factory.createVariableDeclaration(
            root.name,
            undefined,
            undefined,
            identifier,
          )],
          ts.NodeFlags.Const,
        ),
      );
    }
    updated = updateFunctionParameters(
      callback,
      [replacement, ...callback.parameters.slice(root ? 1 : 0)],
      context.factory,
    );
    root = replacement;
  }

  const paths: FrameworkProvidedPath[] = [];
  const rewrite: ts.Visitor = (node) => {
    if (node !== updated.body && ts.isFunctionLike(node)) return node;
    if (!ts.isCallExpression(node)) {
      return ts.visitEachChild(node, rewrite, context.tsContext);
    }
    if (isInternalFrameworkHelper(node)) return node;
    if (
      classifyFactoryCallTarget(node, context.checker).kind === "derivation"
    ) {
      return ts.visitEachChild(node, rewrite, context.tsContext);
    }
    const protectedPaths = frameworkPathsForFactoryExpression(
      node.expression,
      context,
      new Set(),
      new Set(),
    );
    if (protectedPaths.length === 0) {
      return ts.visitEachChild(node, rewrite, context.tsContext);
    }
    const invalid = protectedPaths.find((path) => !isSupportedPath(path));
    if (invalid) {
      context.reportDiagnosticOnce({
        severity: "error",
        type: "framework-provided:non-static-path",
        message: `FrameworkProvided path '${
          invalid.join(".")
        }' cannot be forwarded; only non-empty object-property paths are supported.`,
        node,
      });
      return node;
    }

    const authored = node.arguments[0];
    const object = authored && asObjectLiteral(authored);
    if (!object) {
      context.reportDiagnosticOnce({
        severity: "error",
        type: "pattern-callback:framework-provided-wrapper",
        message:
          "A factory with FrameworkProvided inputs requires a proven object-literal call so authored values cannot be laundered into system paths.",
        node,
      });
      return node;
    }
    const supplied = protectedPaths.find((path) =>
      objectLiteralSuppliesPath(object, path)
    );
    if (supplied) {
      context.reportDiagnosticOnce({
        severity: "error",
        type: "pattern-callback:framework-provided-wrapper",
        message:
          `An authored factory input cannot supply FrameworkProvided path '${
            supplied.join(".")
          }'; the framework forwards it from wrapper argument 0.`,
        node: authored,
      });
      return node;
    }
    const untrustedShorthand = protectedPaths.map((path) =>
      findUntrustedFrameworkShorthand(object, path, callback, context)
    ).find((candidate) => candidate !== undefined);
    if (untrustedShorthand) {
      context.reportDiagnosticOnce({
        severity: "error",
        type: "pattern-callback:framework-provided-wrapper",
        message: `A shorthand factory input for protected subtree '${
          untrustedShorthand.path.join(".")
        }' must be an immutable alias of wrapper argument 0; body-local or mutable authored values cannot supply FrameworkProvided paths.`,
        node: untrustedShorthand.node,
      });
      return node;
    }

    for (const path of protectedPaths) paths.push(path);
    const input = addForwardedPathsToObject(
      object,
      root!.name as ts.Identifier,
      protectedPaths,
      context,
    );
    return context.factory.updateCallExpression(
      node,
      node.expression,
      node.typeArguments,
      [input],
    );
  };

  let body = ts.visitNode(updated.body, rewrite) as ts.ConciseBody;
  if (bindingPrologue) {
    body = ts.isBlock(body)
      ? context.factory.updateBlock(body, [bindingPrologue, ...body.statements])
      : context.factory.createBlock([
        bindingPrologue,
        context.factory.createReturnStatement(body),
      ], true);
  }
  return {
    callback: updateFunctionBody(updated, body, context.factory),
    paths: mergePaths(paths),
  };
}

function validateScheduledFactoryCalls(
  call: ts.CallExpression,
  context: TransformationContext,
): void {
  const kind = detectCallKind(call, context.checker);
  if (
    kind?.kind !== "builder" ||
    (kind.builderName !== "lift" && kind.builderName !== "handler")
  ) return;
  const callback = call.arguments.map((argument) =>
    resolveFunction(argument, context.checker)
  ).find((candidate) => candidate !== undefined);
  if (!callback) return;
  const visitedFunctions = new Set<ResolvedFunction>([callback]);
  let reported = false;
  const visit = (node: ts.Node): void => {
    if (reported || node !== callback.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const target = classifyFactoryCallTarget(node, context.checker);
      if (target.kind === "invocation" || target.kind === "ambiguous") {
        const paths = frameworkPathsForFactoryExpression(
          node.expression,
          context,
          new Set(),
          new Set(),
        );
        if (paths.length > 0) {
          const path = paths[0]!;
          context.reportDiagnosticOnce({
            severity: "error",
            type: "scheduled-callback:framework-provided-factory-call",
            message:
              `A materialized factory call inside ${kind.builderName} requires FrameworkProvided path '${
                path.join(".")
              }', but handler event/context and lift input are authored data, not a trusted system-input channel.`,
            node,
          });
          reported = true;
          return;
        }
      }

      const helper = resolveFunction(node.expression, context.checker);
      if (helper && !visitedFunctions.has(helper)) {
        visitedFunctions.add(helper);
        visit(helper.body);
        if (reported) return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
}

function addForwardedPathsToObject(
  object: ts.ObjectLiteralExpression,
  root: ts.Identifier,
  paths: readonly FrameworkProvidedPath[],
  context: TransformationContext,
): ts.ObjectLiteralExpression {
  let result = object;
  for (const path of paths) {
    result = addForwardedPathToObject(
      result,
      root,
      path,
      path,
      context,
    );
  }
  return result;
}

function addForwardedPathToObject(
  object: ts.ObjectLiteralExpression,
  root: ts.Identifier,
  remaining: readonly string[],
  complete: readonly string[],
  context: TransformationContext,
): ts.ObjectLiteralExpression {
  const factory = context.factory;
  const [head, ...tail] = remaining;
  if (!head) return object;
  const properties = [...object.properties];
  const index = properties.findIndex((property) => {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) return false;
    return (ts.isIdentifier(property.name) ||
      ts.isStringLiteralLike(property.name)) &&
      property.name.text === head;
  });
  if (tail.length === 0) {
    if (index >= 0) {
      const existing = properties[index]!;
      if (
        ts.isPropertyAssignment(existing) &&
        isFrameworkAlias(existing.initializer, root, complete)
      ) {
        return object;
      }
      throw new Error(
        "FrameworkProvided forwarding attempted to emit a duplicate protected key",
      );
    }
    properties.push(factory.createPropertyAssignment(
      factory.createStringLiteral(head),
      frameworkAlias(root, complete, factory),
    ));
  } else if (index >= 0) {
    const existing = properties[index]!;
    const prefixLength = complete.length - tail.length;
    const prefix = complete.slice(0, prefixLength);
    if (ts.isShorthandPropertyAssignment(existing)) {
      properties[index] = factory.createPropertyAssignment(
        factory.createStringLiteral(head),
        frameworkAlias(root, prefix, factory),
      );
      return factory.updateObjectLiteralExpression(object, properties);
    }
    if (!ts.isPropertyAssignment(existing)) {
      throw new Error(
        "FrameworkProvided forwarding found an unsupported protected subtree",
      );
    }
    const child = asObjectLiteral(existing.initializer);
    if (child === undefined) {
      if (isFrameworkAlias(existing.initializer, root, prefix)) return object;
      throw new Error(
        "FrameworkProvided forwarding cannot safely reconstruct an authored protected subtree",
      );
    }
    properties[index] = factory.createPropertyAssignment(
      factory.createStringLiteral(head),
      addForwardedPathToObject(
        child,
        root,
        tail,
        complete,
        context,
      ),
    );
  } else {
    properties.push(factory.createPropertyAssignment(
      factory.createStringLiteral(head),
      addForwardedPathToObject(
        factory.createObjectLiteralExpression(),
        root,
        tail,
        complete,
        context,
      ),
    ));
  }
  return factory.updateObjectLiteralExpression(object, properties);
}

function isSupportedPath(path: readonly string[]): boolean {
  return path.length > 0 &&
    path.every((segment) =>
      segment.length > 0 && segment !== "*" && segment !== "[]" &&
      segment !== "__proto__" && segment !== "prototype" &&
      segment !== "constructor"
    );
}

function frameworkAlias(
  root: ts.Identifier,
  path: readonly string[],
  factory: ts.NodeFactory,
): ts.Expression {
  let value: ts.Expression = factory.createIdentifier(root.text);
  for (const segment of path) {
    value = factory.createCallExpression(
      factory.createPropertyAccessExpression(value, "key"),
      undefined,
      [factory.createStringLiteral(segment)],
    );
  }
  return value;
}

function isFrameworkAlias(
  expression: ts.Expression,
  root: ts.Identifier,
  path: readonly string[],
): boolean {
  let value = unwrapExpression(expression);
  for (let index = path.length - 1; index >= 0; index--) {
    if (!ts.isCallExpression(value) || value.arguments.length !== 1) {
      return false;
    }
    const argument = value.arguments[0];
    if (!argument || !ts.isStringLiteralLike(argument)) return false;
    if (argument.text !== path[index]) return false;
    const target = unwrapExpression(value.expression);
    if (
      !ts.isPropertyAccessExpression(target) || target.name.text !== "key"
    ) {
      return false;
    }
    value = unwrapExpression(target.expression);
  }
  return ts.isIdentifier(value) && value.text === root.text;
}

function frameworkPathsForFactoryExpression(
  expression: ts.Expression,
  context: TransformationContext,
  activeNodes: Set<ts.Node>,
  activeSymbols: Set<ts.Symbol>,
): readonly FrameworkProvidedPath[] {
  const source = ts.getOriginalNode(expression) as ts.Expression;
  if (activeNodes.has(source)) return [];
  activeNodes.add(source);
  try {
    try {
      const direct = findFactoryInputFrameworkProvidedPaths(
        context.checker.getTypeAtLocation(source),
        context.checker,
      );
      if (direct.length > 0) return direct;
    } catch {
      // Fall through to declaration tracing for rewritten expressions.
    }

    const target = unwrapExpression(source);
    if (ts.isIdentifier(target)) {
      let symbol = context.checker.getSymbolAtLocation(target);
      if (!symbol || activeSymbols.has(symbol)) return [];
      const active = symbol;
      activeSymbols.add(active);
      try {
        if (symbol.flags & ts.SymbolFlags.Alias) {
          symbol = context.checker.getAliasedSymbol(symbol);
        }
        const paths: FrameworkProvidedPath[] = [];
        for (const declaration of symbol.getDeclarations() ?? []) {
          if (
            ts.isVariableDeclaration(declaration) && declaration.initializer
          ) {
            const initializer = unwrapExpression(declaration.initializer);
            if (
              ts.isCallExpression(initializer) &&
              isPatternBuilderCall(initializer, context.checker)
            ) {
              for (
                const path of frameworkPathsForPatternBuilder(
                  initializer,
                  context,
                  activeNodes,
                  activeSymbols,
                )
              ) paths.push(path);
            } else {
              for (
                const path of frameworkPathsForFactoryExpression(
                  initializer,
                  context,
                  activeNodes,
                  activeSymbols,
                )
              ) paths.push(path);
            }
          }
        }
        return mergePaths(paths);
      } finally {
        activeSymbols.delete(active);
      }
    }
    if (isFactoryModifierAccess(target)) {
      // The modifier callable itself is not a factory type, but derives one
      // from its receiver and must preserve that receiver's trusted paths.
      // Do not recurse through arbitrary methods: a containing input object
      // may have a privileged factory in one sibling while an unrelated call
      // such as `input.text.toUpperCase()` uses another.
      return frameworkPathsForFactoryExpression(
        target.expression,
        context,
        activeNodes,
        activeSymbols,
      );
    }
    return [];
  } finally {
    activeNodes.delete(source);
  }
}

function frameworkPathsForPatternBuilder(
  call: ts.CallExpression,
  context: TransformationContext,
  activeNodes: Set<ts.Node>,
  activeSymbols: Set<ts.Symbol>,
): readonly FrameworkProvidedPath[] {
  const descriptor = getPatternBuilderCallbackDescriptor(
    call,
    context.checker,
  );
  if (!descriptor) return [];
  const paths: FrameworkProvidedPath[] = [
    ...frameworkPathsForParameter(descriptor.callback.parameters[0], context),
  ];
  const visit = (node: ts.Node): void => {
    if (node !== descriptor.callback.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      if (
        classifyFactoryCallTarget(node, context.checker).kind !== "derivation"
      ) {
        for (
          const path of frameworkPathsForFactoryExpression(
            node.expression,
            context,
            activeNodes,
            activeSymbols,
          )
        ) paths.push(path);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(descriptor.callback.body);
  return mergePaths(paths);
}

function frameworkPathsForParameter(
  parameter: ts.ParameterDeclaration | undefined,
  context: TransformationContext,
): readonly FrameworkProvidedPath[] {
  if (!parameter) return [];
  try {
    return findFrameworkProvidedPaths(
      context.checker.getTypeAtLocation(ts.getOriginalNode(parameter)),
      context.checker,
    );
  } catch {
    return [];
  }
}

function asObjectLiteral(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  const value = unwrapExpression(expression);
  return ts.isObjectLiteralExpression(value) ? value : undefined;
}

function findUntrustedFrameworkShorthand(
  object: ts.ObjectLiteralExpression,
  path: readonly string[],
  callback: FunctionExpression,
  context: TransformationContext,
):
  | { node: ts.ShorthandPropertyAssignment; path: readonly string[] }
  | undefined {
  let current = object;
  const prefix: string[] = [];
  for (const segment of path) {
    prefix.push(segment);
    const property = current.properties.find((candidate) => {
      if (
        !ts.isPropertyAssignment(candidate) &&
        !ts.isShorthandPropertyAssignment(candidate)
      ) return false;
      const name = candidate.name;
      return (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
        name.text === segment;
    });
    if (property === undefined) return undefined;
    if (ts.isShorthandPropertyAssignment(property)) {
      const source = ts.getOriginalNode(
        property,
      ) as ts.ShorthandPropertyAssignment;
      const symbol = context.checker.getShorthandAssignmentValueSymbol(
        source,
      ) ?? context.checker.getSymbolAtLocation(source.name);
      const trustedPath = symbol && frameworkInputPathForSymbol(
        symbol,
        callback,
        context,
        new Set(),
      );
      return pathsEqual(trustedPath, prefix)
        ? undefined
        : { node: property, path: [...prefix] };
    }
    if (!ts.isPropertyAssignment(property)) return undefined;
    const child = asObjectLiteral(property.initializer);
    if (child === undefined) return undefined;
    current = child;
  }
  return undefined;
}

function frameworkInputPathForIdentifier(
  identifier: ts.Identifier,
  callback: FunctionExpression,
  context: TransformationContext,
  active: Set<ts.Symbol>,
): readonly string[] | undefined {
  const source = ts.getOriginalNode(identifier) as ts.Identifier;
  const symbol = context.checker.getSymbolAtLocation(source);
  return symbol && frameworkInputPathForSymbol(
    symbol,
    callback,
    context,
    active,
  );
}

function frameworkInputPathForSymbol(
  symbol: ts.Symbol,
  callback: FunctionExpression,
  context: TransformationContext,
  active: Set<ts.Symbol>,
): readonly string[] | undefined {
  if (active.has(symbol)) return undefined;
  active.add(symbol);
  try {
    const parameter = (ts.getOriginalNode(callback) as FunctionExpression)
      .parameters[0];
    if (parameter) {
      for (const declaration of symbol.getDeclarations() ?? []) {
        const path = bindingPathToOwner(declaration, parameter);
        if (path !== undefined) return path;
      }
    }

    for (const declaration of symbol.getDeclarations() ?? []) {
      const alias = immutableAliasInitializer(declaration);
      if (alias === undefined) continue;
      const base = frameworkInputPathForExpression(
        alias.initializer,
        callback,
        context,
        active,
      );
      if (base !== undefined) return [...base, ...alias.path];
    }
    return undefined;
  } finally {
    active.delete(symbol);
  }
}

function frameworkInputPathForExpression(
  expression: ts.Expression,
  callback: FunctionExpression,
  context: TransformationContext,
  active: Set<ts.Symbol>,
): readonly string[] | undefined {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) {
    return frameworkInputPathForIdentifier(value, callback, context, active);
  }
  if (ts.isPropertyAccessExpression(value)) {
    const base = frameworkInputPathForExpression(
      value.expression,
      callback,
      context,
      active,
    );
    return base === undefined ? undefined : [...base, value.name.text];
  }
  if (ts.isElementAccessExpression(value)) {
    const argument = value.argumentExpression &&
      unwrapExpression(value.argumentExpression);
    if (!argument || !ts.isStringLiteralLike(argument)) return undefined;
    const base = frameworkInputPathForExpression(
      value.expression,
      callback,
      context,
      active,
    );
    return base === undefined ? undefined : [...base, argument.text];
  }
  if (
    ts.isCallExpression(value) && value.arguments.length === 1 &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === "key"
  ) {
    const argument = value.arguments[0];
    if (!argument || !ts.isStringLiteralLike(argument)) return undefined;
    const base = frameworkInputPathForExpression(
      value.expression.expression,
      callback,
      context,
      active,
    );
    return base === undefined ? undefined : [...base, argument.text];
  }
  return undefined;
}

function immutableAliasInitializer(
  declaration: ts.Declaration,
): { initializer: ts.Expression; path: readonly string[] } | undefined {
  if (ts.isVariableDeclaration(declaration)) {
    if (
      !declaration.initializer || !ts.isVariableDeclarationList(
        declaration.parent,
      ) || !(declaration.parent.flags & ts.NodeFlags.Const)
    ) return undefined;
    if (ts.isIdentifier(declaration.name)) {
      return { initializer: declaration.initializer, path: [] };
    }
    return undefined;
  }
  if (!ts.isBindingElement(declaration)) return undefined;
  const owner = bindingOwner(declaration);
  if (
    !owner || !ts.isVariableDeclaration(owner.owner) ||
    !owner.owner.initializer ||
    !ts.isVariableDeclarationList(owner.owner.parent) ||
    !(owner.owner.parent.flags & ts.NodeFlags.Const)
  ) return undefined;
  return { initializer: owner.owner.initializer, path: owner.path };
}

function bindingPathToOwner(
  declaration: ts.Declaration,
  expectedOwner: ts.ParameterDeclaration,
): readonly string[] | undefined {
  if (expectedOwner.dotDotDotToken || expectedOwner.initializer) {
    return undefined;
  }
  if (declaration === expectedOwner && ts.isIdentifier(expectedOwner.name)) {
    return [];
  }
  if (!ts.isBindingElement(declaration)) return undefined;
  const owner = bindingOwner(declaration);
  return owner?.owner === expectedOwner ? owner.path : undefined;
}

function bindingOwner(
  declaration: ts.BindingElement,
):
  | { owner: ts.ParameterDeclaration | ts.VariableDeclaration; path: string[] }
  | undefined {
  const path: string[] = [];
  let current = declaration;
  while (true) {
    if (current.dotDotDotToken || current.initializer) return undefined;
    const parent = current.parent;
    if (!ts.isObjectBindingPattern(parent)) return undefined;
    const name = current.propertyName ?? current.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) {
      return undefined;
    }
    path.unshift(name.text);
    const owner = parent.parent;
    if (ts.isBindingElement(owner)) {
      current = owner;
      continue;
    }
    return ts.isParameter(owner) || ts.isVariableDeclaration(owner)
      ? { owner, path }
      : undefined;
  }
}

function pathsEqual(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  return left !== undefined && left.length === right.length &&
    left.every((segment, index) => segment === right[index]);
}

function objectLiteralSuppliesPath(
  object: ts.ObjectLiteralExpression,
  path: readonly string[],
): boolean {
  const [head, ...tail] = path;
  if (!head) return false;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) return true;
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) continue;
    const name = property.name;
    const text = ts.isIdentifier(name) || ts.isStringLiteralLike(name)
      ? name.text
      : undefined;
    if (text !== head) continue;
    if (tail.length === 0) return true;
    if (ts.isShorthandPropertyAssignment(property)) return false;
    const initializer = asObjectLiteral(property.initializer);
    return !initializer || objectLiteralSuppliesPath(initializer, tail);
  }
  return false;
}

function pathsExpression(
  paths: readonly FrameworkProvidedPath[],
  factory: ts.NodeFactory,
): ts.ArrayLiteralExpression {
  return factory.createArrayLiteralExpression(
    paths.map((path) =>
      factory.createArrayLiteralExpression(
        path.map((segment) => factory.createStringLiteral(segment)),
      )
    ),
  );
}

function mergePaths(
  ...groups: readonly (readonly FrameworkProvidedPath[])[]
): FrameworkProvidedPath[] {
  const byKey = new Map<string, FrameworkProvidedPath>();
  for (const path of groups.flat()) byKey.set(JSON.stringify(path), [...path]);
  return [...byKey.values()].sort((a, b) =>
    utf8Compare(JSON.stringify(a), JSON.stringify(b))
  );
}

function isInternalFrameworkHelper(call: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "__cfHelpers" &&
    call.expression.name.text === "withFrameworkProvidedPaths";
}

function updateFunctionParameters(
  callback: FunctionExpression,
  parameters: readonly ts.ParameterDeclaration[],
  factory: ts.NodeFactory,
): FunctionExpression {
  return ts.isArrowFunction(callback)
    ? factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      parameters,
      callback.type,
      callback.equalsGreaterThanToken,
      callback.body,
    )
    : factory.updateFunctionExpression(
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

function updateFunctionBody(
  callback: FunctionExpression,
  body: ts.ConciseBody,
  factory: ts.NodeFactory,
): FunctionExpression {
  return ts.isArrowFunction(callback)
    ? factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      callback.parameters,
      callback.type,
      callback.equalsGreaterThanToken,
      body,
    )
    : factory.updateFunctionExpression(
      callback,
      callback.modifiers,
      callback.asteriskToken,
      callback.name,
      callback.typeParameters,
      callback.parameters,
      callback.type,
      ts.isBlock(body)
        ? body
        : factory.createBlock([factory.createReturnStatement(body)], true),
    );
}
