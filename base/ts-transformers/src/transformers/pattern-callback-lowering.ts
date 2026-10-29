import ts from "typescript";
import {
  classifyArrayMethodCall,
  getCapabilitySummaryCallbackArgument,
  getPatternBuilderCallbackArgument,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import {
  registerCapabilitySummary,
  transformPatternCallback,
} from "./pattern-callback-transform.ts";
import {
  addBindingTargetSymbols,
  isOpaqueSourceExpression,
} from "./opaque-roots.ts";

interface PatternScopeInfo {
  opaqueNames: Set<string>;
  opaqueSymbols: Set<ts.Symbol>;
}

interface ArrayMethodCallbackInfo {
  readonly isArrayMethodCallback: boolean;
  readonly nonReactiveCaptures?: ReadonlySet<string>;
}

function collectBindingNames(
  name: ts.BindingName,
  names: Set<string>,
): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
  } else if (ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) {
      collectBindingNames(el.name, names);
    }
  } else if (ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (!ts.isOmittedExpression(el)) {
        collectBindingNames(el.name, names);
      }
    }
  }
}

function buildPatternScope(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  context: TransformationContext,
): PatternScopeInfo {
  const opaqueNames = new Set<string>();
  const opaqueSymbols = new Set<ts.Symbol>();
  const firstParam = callback.parameters[0];
  if (firstParam) {
    collectBindingNames(firstParam.name, opaqueNames);
    addBindingTargetSymbols(
      firstParam.name,
      opaqueSymbols,
      context.checker,
    );
  }

  if (!ts.isBlock(callback.body)) {
    return { opaqueNames, opaqueSymbols };
  }

  const visit = (node: ts.Node): void => {
    if (node !== callback.body && ts.isFunctionLike(node)) {
      return;
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isOpaqueSourceExpression(
        node.initializer,
        opaqueNames,
        opaqueSymbols,
        context,
      )
    ) {
      collectBindingNames(node.name, opaqueNames);
      addBindingTargetSymbols(
        node.name,
        opaqueSymbols,
        context.checker,
      );
    }

    ts.forEachChild(node, visit);
  };

  visit(callback.body);
  return { opaqueNames, opaqueSymbols };
}

function getCaptureSourceSymbol(
  prop: ts.ObjectLiteralElementLike,
  context: TransformationContext,
): ts.Symbol | undefined {
  if (ts.isShorthandPropertyAssignment(prop)) {
    return context.checker.getShorthandAssignmentValueSymbol(prop) ??
      context.checker.getSymbolAtLocation(prop.name);
  }

  if (
    ts.isPropertyAssignment(prop) &&
    ts.isIdentifier(prop.initializer)
  ) {
    return context.checker.getSymbolAtLocation(prop.initializer);
  }

  return undefined;
}

function getArrayMethodCallbackInfo(
  patternCall: ts.CallExpression,
  scope: PatternScopeInfo | undefined,
  context: TransformationContext,
): ArrayMethodCallbackInfo {
  const parent = patternCall.parent;
  if (
    !parent ||
    !ts.isCallExpression(parent) ||
    parent.arguments[0] !== patternCall ||
    !classifyArrayMethodCall(parent)?.lowered
  ) {
    return { isArrayMethodCallback: false };
  }

  const capturesArg = parent.arguments[1];
  if (!scope || !capturesArg || !ts.isObjectLiteralExpression(capturesArg)) {
    return { isArrayMethodCallback: true };
  }

  const nonReactiveCaptures = new Set<string>();
  for (const prop of capturesArg.properties) {
    let originalName: string | undefined;
    let captureName: string | undefined;
    if (ts.isShorthandPropertyAssignment(prop)) {
      originalName = prop.name.text;
      captureName = prop.name.text;
    } else if (
      ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)
    ) {
      captureName = prop.name.text;
      originalName = ts.isIdentifier(prop.initializer)
        ? prop.initializer.text
        : prop.name.text;
    }
    const originalSymbol = getCaptureSourceSymbol(prop, context);
    const isReactiveCapture = originalSymbol
      ? scope.opaqueSymbols.has(originalSymbol)
      : !!originalName && scope.opaqueNames.has(originalName);
    if (originalName && captureName && !isReactiveCapture) {
      nonReactiveCaptures.add(captureName);
    }
  }

  return {
    isArrayMethodCallback: true,
    nonReactiveCaptures,
  };
}

function maybeRegisterBuilderCapabilitySummary(
  node: ts.CallExpression,
  context: TransformationContext,
): void {
  const callback = getCapabilitySummaryCallbackArgument(node, context.checker);
  if (callback) {
    registerCapabilitySummary(callback, context, { interprocedural: true });
  }
}

function registerBuilderSummariesInSubtree(
  node: ts.Node,
  context: TransformationContext,
): void {
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) {
      maybeRegisterBuilderCapabilitySummary(current, context);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
}

export class PatternCallbackLoweringTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const scopeStack: PatternScopeInfo[] = [];

    // Main transform pass
    const visit: ts.Visitor = (node: ts.Node): ts.Node => {
      const callback = ts.isCallExpression(node)
        ? getPatternBuilderCallbackArgument(node, context.checker)
        : undefined;
      const arrayMethodInfo = ts.isCallExpression(node) && callback
        ? getArrayMethodCallbackInfo(node, scopeStack.at(-1), context)
        : undefined;
      const currentScope = callback
        ? buildPatternScope(callback, context)
        : undefined;
      if (currentScope) {
        scopeStack.push(currentScope);
      }

      const visitedNode = visitEachChildWithJsx(node, visit, context.tsContext);

      if (currentScope) {
        scopeStack.pop();
      }

      if (!ts.isCallExpression(visitedNode)) {
        return visitedNode;
      }

      const callbackArg = getPatternBuilderCallbackArgument(
        visitedNode,
        context.checker,
      );
      if (callbackArg) {
        const transformedCallback = transformPatternCallback(
          callbackArg,
          context,
          !!arrayMethodInfo?.isArrayMethodCallback,
          arrayMethodInfo?.nonReactiveCaptures,
        );
        const rewritten = context.factory.updateCallExpression(
          visitedNode,
          visitedNode.expression,
          visitedNode.typeArguments,
          [
            transformedCallback,
            ...visitedNode.arguments.slice(1),
          ],
        );
        registerBuilderSummariesInSubtree(transformedCallback.body, context);
        maybeRegisterBuilderCapabilitySummary(rewritten, context);
        return rewritten;
      }

      maybeRegisterBuilderCapabilitySummary(visitedNode, context);
      return visitedNode;
    };

    return visitEachChildWithJsx(
      context.sourceFile,
      visit,
      context.tsContext,
    ) as ts.SourceFile;
  }
}
