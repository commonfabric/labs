import ts from "typescript";
import type { TransformationContext } from "../../core/mod.ts";
import { createCaptureAccessExpression } from "../../utils/capture-tree.ts";
import type { CaptureTreeNode } from "../../utils/capture-tree.ts";
import {
  getUniqueIdentifier,
  maybeReuseIdentifier,
  normalizeBindingName,
} from "../../utils/identifiers.ts";
import { createLiftAppliedCall } from "../../transformers/builtins/lift-applied.ts";

function isBindingPattern(name: ts.BindingName): name is ts.BindingPattern {
  return ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name);
}

export interface ComputedAliasInfo {
  readonly symbol: ts.Symbol;
  readonly aliasName: string;
  readonly keyExpression: ts.Expression;
  readonly keyIdentifier: ts.Identifier;
  readonly path: readonly string[];
  readonly baseTemplate?: ts.Expression;
}

export interface ElementBindingAnalysis {
  readonly bindingName: ts.BindingName;
  readonly elementIdentifier: ts.Identifier;
  readonly computedAliases: readonly ComputedAliasInfo[];
  readonly destructureStatement?: ts.Statement;
}

interface ElementBindingPlan {
  readonly aliases: ComputedAliasInfo[];
  readonly residualPattern?: ts.BindingName;
}

function buildElementBindingPlan(
  elemParam: ts.ParameterDeclaration,
  context: TransformationContext,
): ElementBindingPlan {
  const { factory, checker } = context;

  const aliasBucket: ComputedAliasInfo[] = [];
  const keyNames = new Set<string>();

  const walk = (
    node: ts.BindingName,
    path: readonly string[],
    template: ts.Expression | undefined,
  ): ts.BindingName | undefined => {
    if (ts.isIdentifier(node)) {
      return factory.createIdentifier(node.text);
    }

    if (ts.isObjectBindingPattern(node)) {
      const elements: ts.BindingElement[] = [];

      for (const element of node.elements) {
        const propertyName = element.propertyName;
        let nextPath = path;
        let nextTemplate = template;

        if (propertyName && ts.isComputedPropertyName(propertyName)) {
          if (ts.isIdentifier(element.name)) {
            const symbol = checker.getSymbolAtLocation(element.name);
            if (symbol) {
              const aliasName = element.name.text;
              const keyBase = `__cf_${aliasName}_key`;
              const unique = getUniqueIdentifier(keyBase, keyNames, {
                fallback: keyBase,
              });
              keyNames.add(unique);
              aliasBucket.push({
                symbol,
                aliasName,
                keyExpression: propertyName.expression,
                keyIdentifier: factory.createIdentifier(unique),
                path,
                baseTemplate: template,
              });
            }
          }
          continue;
        }

        if (propertyName && ts.isIdentifier(propertyName)) {
          nextPath = [...path, propertyName.text];
          const base = nextTemplate ??
            factory.createIdentifier("__cf_placeholder");
          nextTemplate = factory.createPropertyAccessExpression(
            base,
            factory.createIdentifier(propertyName.text),
          );
        } else if (propertyName && ts.isStringLiteral(propertyName)) {
          nextPath = [...path, propertyName.text];
          const base = nextTemplate ??
            factory.createIdentifier("__cf_placeholder");
          nextTemplate = factory.createElementAccessExpression(
            base,
            factory.createStringLiteral(propertyName.text),
          );
        } else if (!propertyName && ts.isIdentifier(element.name)) {
          nextPath = [...path, element.name.text];
          const base = nextTemplate ??
            factory.createIdentifier("__cf_placeholder");
          nextTemplate = factory.createPropertyAccessExpression(
            base,
            factory.createIdentifier(element.name.text),
          );
        }

        let clonedName: ts.BindingName | undefined;
        if (ts.isIdentifier(element.name)) {
          clonedName = factory.createIdentifier(element.name.text);
        } else if (isBindingPattern(element.name)) {
          clonedName = walk(element.name, nextPath, nextTemplate);
        }

        if (!clonedName && !element.dotDotDotToken) {
          continue;
        }

        elements.push(
          factory.createBindingElement(
            element.dotDotDotToken,
            element.propertyName,
            clonedName ?? element.name,
            element.initializer as ts.Expression | undefined,
          ),
        );
      }

      if (elements.length === 0) return undefined;
      return factory.createObjectBindingPattern(elements);
    }

    if (ts.isArrayBindingPattern(node)) {
      const newElements = node.elements.map((element) => {
        if (ts.isOmittedExpression(element)) return element;
        if (ts.isBindingElement(element)) {
          let clonedName: ts.BindingName | undefined;
          if (ts.isIdentifier(element.name)) {
            clonedName = factory.createIdentifier(element.name.text);
          } else if (isBindingPattern(element.name)) {
            clonedName = walk(element.name, path, template);
          }
          if (!clonedName && !element.dotDotDotToken) {
            return element;
          }
          return factory.createBindingElement(
            element.dotDotDotToken,
            element.propertyName,
            clonedName ?? element.name,
            element.initializer as ts.Expression | undefined,
          );
        }
        return element;
      });
      return factory.createArrayBindingPattern(newElements);
    }

    return undefined;
  };

  const residualPattern = walk(elemParam.name, [], undefined);

  return {
    aliases: aliasBucket,
    residualPattern,
  };
}

export function analyzeElementBinding(
  elemParam: ts.ParameterDeclaration | undefined,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext,
  used: Set<string>,
  createBindingIdentifier: (candidate: string) => ts.Identifier,
): ElementBindingAnalysis {
  const { factory } = context;

  if (!elemParam) {
    const identifier = createBindingIdentifier(
      captureTree.has("element") ? "__cf_element" : "element",
    );
    return {
      bindingName: identifier,
      elementIdentifier: identifier,
      computedAliases: [],
    };
  }

  if (ts.isIdentifier(elemParam.name)) {
    const identifier = maybeReuseIdentifier(elemParam.name, used);
    return {
      bindingName: identifier,
      elementIdentifier: identifier,
      computedAliases: [],
    };
  }

  const plan = buildElementBindingPlan(elemParam, context);

  if (plan.aliases.length === 0) {
    const normalized = normalizeBindingName(
      elemParam.name,
      factory,
      used,
    );
    return {
      bindingName: normalized,
      elementIdentifier: factory.createIdentifier(
        ts.isIdentifier(normalized) ? normalized.text : "element",
      ),
      computedAliases: [],
    };
  }

  const elementIdentifier = createBindingIdentifier(
    captureTree.has("element") ? "__cf_element" : "element",
  );

  let destructureStatement: ts.Statement | undefined;
  if (plan.residualPattern) {
    const normalized = normalizeBindingName(
      plan.residualPattern,
      factory,
      used,
    );
    destructureStatement = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            normalized,
            undefined,
            undefined,
            factory.createIdentifier(elementIdentifier.text),
          ),
        ],
        ts.NodeFlags.Const,
      ),
    );
  }

  return {
    bindingName: elementIdentifier,
    elementIdentifier,
    computedAliases: plan.aliases,
    destructureStatement,
  };
}

function createAliasExpressionAsLiftApplied(
  info: ComputedAliasInfo,
  elementIdentifier: ts.Identifier,
  context: TransformationContext,
): ts.Expression {
  const { factory, cfHelpers, tsContext, checker } = context;
  const keyIdent = factory.createIdentifier(info.keyIdentifier.text);

  const accessBase = createCaptureAccessExpression(
    elementIdentifier.text,
    info.path,
    factory,
    info.baseTemplate,
  );

  const elementAccess = factory.createElementAccessExpression(
    accessBase,
    keyIdent,
  );

  // Register the type of the synthetic elementAccess in typeRegistry.
  // The type comes from info.symbol which was captured from the original
  // binding element. Without this registration, createLiftAppliedCall cannot
  // determine the correct result type for the synthetic lift-applied call.
  if (info.symbol) {
    const symbolType = checker.getTypeOfSymbol(info.symbol);
    if (symbolType) {
      context.state.typeRegistry.set(elementAccess, symbolType);
    }
  }

  const elementRef = factory.createIdentifier(elementIdentifier.text);

  const liftAppliedExpression = createLiftAppliedCall(
    elementAccess,
    [elementRef, keyIdent],
    {
      factory,
      tsContext,
      cfHelpers,
      context,
    },
  );

  return liftAppliedExpression ?? elementAccess;
}

export function rewriteCallbackBody(
  body: ts.ConciseBody,
  analysis: ElementBindingAnalysis,
  context: TransformationContext,
): ts.ConciseBody {
  if (analysis.computedAliases.length === 0) {
    return body;
  }

  const { factory } = context;

  let block: ts.Block;
  if (ts.isBlock(body)) {
    block = body;
  } else {
    block = factory.createBlock([
      factory.createReturnStatement(body as ts.Expression),
    ], true);
  }

  const prologue: ts.Statement[] = [];

  if (analysis.destructureStatement) {
    prologue.push(analysis.destructureStatement);
  }

  for (const info of analysis.computedAliases) {
    prologue.push(
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              factory.createIdentifier(info.aliasName),
              undefined,
              undefined,
              createAliasExpressionAsLiftApplied(
                info,
                analysis.elementIdentifier,
                context,
              ),
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
    );
  }

  const keyStatements: ts.Statement[] = [];
  for (const info of analysis.computedAliases) {
    keyStatements.push(
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              factory.createIdentifier(info.keyIdentifier.text),
              undefined,
              undefined,
              info.keyExpression,
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
    );
  }

  return factory.createBlock(
    [...keyStatements, ...prologue, ...block.statements],
    true,
  );
}
