import ts from "typescript";
import {
  deepFreeze,
  type FabricValue,
  hashStringOf,
} from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { TransformationContext, Transformer } from "../core/mod.ts";
import type { CfcPolicyCompilerManifestV1 } from "../core/runtime-contract.ts";
import { unwrapExpression } from "../utils/expression.ts";

const USER = "https://commonfabric.org/cfc/atom/User";
const HAS_ROLE = "https://commonfabric.org/cfc/atom/HasRole";
export const CFC_AUTHORING_MODULES = new Set([
  "commonfabric/cfc",
  "@commonfabric/api/cfc-authoring",
]);

type AuthoringImports = {
  readonly exchangeRule: Set<string>;
  readonly exchangeRules: Set<string>;
  readonly variable: Set<string>;
  readonly pattern: Set<string>;
  readonly thisPolicy: Set<string>;
};

type AuthoredRule = {
  readonly name: string;
  readonly preCondition: {
    readonly confidentiality: readonly FabricValue[];
    readonly integrity: readonly FabricValue[];
  };
  readonly preConfScope?: "targetClause" | "anywhere";
  readonly postCondition: {
    readonly confidentiality: readonly FabricValue[];
    readonly integrity: readonly FabricValue[];
  };
  readonly guard?: { readonly policyState: readonly FabricValue[] };
};

class StaticAuthoringError extends Error {
  constructor(readonly node: ts.Node, message: string) {
    super(message);
  }
}

const assertKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  node: ts.Node,
  where: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new StaticAuthoringError(node, `unknown ${where} field "${key}"`);
    }
  }
};

const isCallOf = (node: ts.Expression, names: ReadonlySet<string>): boolean =>
  ts.isIdentifier(node) && names.has(node.text);

const propertyName = (node: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  return undefined;
};

const evaluateStatic = (
  input: ts.Expression,
  imports: AuthoringImports,
): FabricValue => {
  const node = unwrapExpression(input);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        throw new StaticAuthoringError(
          element,
          "policy declarations require dense static arrays without spreads",
        );
      }
      return evaluateStatic(element, imports);
    });
  }

  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, FabricValue> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new StaticAuthoringError(
          property,
          "policy declarations require explicit static object fields",
        );
      }
      const key = propertyName(property.name);
      if (key === undefined) {
        throw new StaticAuthoringError(
          property.name,
          "computed policy declaration fields are not supported",
        );
      }
      if (Object.hasOwn(result, key)) {
        throw new StaticAuthoringError(
          property.name,
          `duplicate field "${key}"`,
        );
      }
      result[key] = evaluateStatic(property.initializer, imports);
    }
    return result;
  }

  if (ts.isIdentifier(node) && imports.thisPolicy.has(node.text)) {
    return { thisPolicy: true };
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    imports.thisPolicy.has(node.expression.text) &&
    node.name.text === "subject"
  ) {
    return { thisPolicyField: "subject" };
  }

  if (ts.isCallExpression(node)) {
    if (isCallOf(node.expression, imports.variable)) {
      if (
        node.arguments.length !== 1 ||
        !ts.isStringLiteral(unwrapExpression(node.arguments[0]!))
      ) {
        throw new StaticAuthoringError(
          node,
          "v() requires one non-empty static string",
        );
      }
      const name = (unwrapExpression(node.arguments[0]!) as ts.StringLiteral)
        .text;
      if (name.length === 0) {
        throw new StaticAuthoringError(node, "v() requires a non-empty name");
      }
      return { var: name };
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      imports.pattern.has(node.expression.expression.text)
    ) {
      const method = node.expression.name.text;
      if (method === "user" && node.arguments.length === 1) {
        return {
          type: USER,
          subject: evaluateStatic(node.arguments[0]!, imports),
        };
      }
      if (method === "hasRole" && node.arguments.length === 3) {
        return {
          type: HAS_ROLE,
          principal: evaluateStatic(node.arguments[0]!, imports),
          space: evaluateStatic(node.arguments[1]!, imports),
          role: evaluateStatic(node.arguments[2]!, imports),
        };
      }
      throw new StaticAuthoringError(
        node,
        `unsupported cfcPattern.${method}() declaration`,
      );
    }
  }

  throw new StaticAuthoringError(
    node,
    "policy declarations require static literal content and CFC pattern constructors",
  );
};

const expressionFromStatic = (
  value: unknown,
  factory: ts.NodeFactory,
): ts.Expression => {
  if (value === null) return factory.createNull();
  if (typeof value === "string") return factory.createStringLiteral(value);
  if (typeof value === "number") return factory.createNumericLiteral(value);
  if (typeof value === "boolean") {
    return value ? factory.createTrue() : factory.createFalse();
  }
  if (Array.isArray(value)) {
    return factory.createArrayLiteralExpression(
      value.map((entry) => expressionFromStatic(entry, factory)),
    );
  }
  if (isObjectNotArray(value)) {
    return factory.createObjectLiteralExpression(
      Object.entries(value).map(([key, field]) =>
        factory.createPropertyAssignment(
          factory.createStringLiteral(key),
          expressionFromStatic(field, factory),
        )
      ),
    );
  }
  throw new TypeError("unsupported static policy declaration value");
};

const collectVariables = (value: unknown, into: Set<string>): void => {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectVariables(entry, into));
  } else if (isObjectNotArray(value)) {
    if (
      Object.keys(value).length === 1 && typeof value.var === "string"
    ) {
      into.add(value.var);
      return;
    }
    Object.values(value).forEach((entry) => collectVariables(entry, into));
  }
};

const containsThisPolicy = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsThisPolicy);
  if (!isObjectNotArray(value)) return false;
  if (value.thisPolicy === true) return true;
  return Object.values(value).some(containsThisPolicy);
};

const lowerRule = (
  symbol: string,
  value: FabricValue,
  node: ts.Node,
): AuthoredRule => {
  if (!isObjectNotArray(value)) {
    throw new StaticAuthoringError(node, "exchangeRule() requires an object");
  }
  assertKeys(
    value,
    new Set(["appliesTo", "pre", "preConfScope", "guard", "post"]),
    node,
    "rule",
  );
  if (
    !isObjectNotArray(value.appliesTo) || value.appliesTo.thisPolicy !== true ||
    Object.keys(value.appliesTo).length !== 1
  ) {
    throw new StaticAuthoringError(
      node,
      "authored rules must apply to THIS_POLICY",
    );
  }

  const pre = value.pre === undefined ? {} : value.pre;
  if (!isObjectNotArray(pre)) {
    throw new StaticAuthoringError(node, "rule pre must be a static object");
  }
  assertKeys(pre, new Set(["confidentiality", "integrity"]), node, "pre");
  const confidentiality = pre.confidentiality ?? [];
  const integrity = pre.integrity ?? [];
  if (!Array.isArray(confidentiality) || !Array.isArray(integrity)) {
    throw new StaticAuthoringError(
      node,
      "pre confidentiality and integrity fields must be static arrays",
    );
  }
  if (containsThisPolicy(confidentiality) || containsThisPolicy(integrity)) {
    throw new StaticAuthoringError(
      node,
      "THIS_POLICY is only valid in the appliesTo position",
    );
  }

  let guard: AuthoredRule["guard"];
  if (value.guard !== undefined) {
    if (!isObjectNotArray(value.guard)) {
      throw new StaticAuthoringError(
        node,
        "rule guard must be a static object",
      );
    }
    assertKeys(value.guard, new Set(["policyState"]), node, "guard");
    if (
      !Array.isArray(value.guard.policyState) ||
      value.guard.policyState.length === 0
    ) {
      throw new StaticAuthoringError(
        node,
        "guard.policyState must be a non-empty static array",
      );
    }
    for (const entry of value.guard.policyState) {
      if (
        !isObjectNotArray(entry) || typeof entry.kind !== "string" ||
        entry.kind === ""
      ) {
        throw new StaticAuthoringError(
          node,
          "guard.policyState entries require a concrete non-empty kind",
        );
      }
    }
    guard = { policyState: value.guard.policyState };
  }
  if (integrity.length === 0 && guard === undefined) {
    throw new StaticAuthoringError(
      node,
      "general authored rules require non-empty integrity or policyState evidence",
    );
  }

  if (
    value.preConfScope !== undefined &&
    value.preConfScope !== "targetClause" &&
    value.preConfScope !== "anywhere"
  ) {
    throw new StaticAuthoringError(node, "invalid preConfScope");
  }
  if (!isObjectNotArray(value.post)) {
    throw new StaticAuthoringError(node, "rule post must be a static object");
  }
  assertKeys(
    value.post,
    new Set(["addAlternatives", "dropClause"]),
    node,
    "post",
  );
  const hasAdds = Object.hasOwn(value.post, "addAlternatives");
  const drops = value.post.dropClause === true;
  if (hasAdds === drops) {
    throw new StaticAuthoringError(
      node,
      "post must specify exactly one of addAlternatives or dropClause",
    );
  }
  const postConfidentiality = hasAdds ? value.post.addAlternatives : [];
  if (
    !Array.isArray(postConfidentiality) ||
    (hasAdds && postConfidentiality.length === 0)
  ) {
    throw new StaticAuthoringError(
      node,
      "post.addAlternatives must be a non-empty static array",
    );
  }
  if (containsThisPolicy(postConfidentiality)) {
    throw new StaticAuthoringError(
      node,
      "THIS_POLICY is only valid in the appliesTo position",
    );
  }

  const bound = new Set<string>();
  collectVariables(confidentiality, bound);
  collectVariables(integrity, bound);
  collectVariables(guard?.policyState, bound);
  const postVariables = new Set<string>();
  collectVariables(postConfidentiality, postVariables);
  for (const variable of postVariables) {
    if (!bound.has(variable)) {
      throw new StaticAuthoringError(
        node,
        `postcondition variable "${variable}" is not bound by a precondition`,
      );
    }
  }

  return {
    name: symbol,
    preCondition: {
      confidentiality: [{ thisPolicy: true }, ...confidentiality],
      integrity,
    },
    ...(value.preConfScope === undefined
      ? {}
      : { preConfScope: value.preConfScope }),
    postCondition: { confidentiality: postConfidentiality, integrity: [] },
    ...(guard === undefined ? {} : { guard }),
  };
};

const collectImports = (sourceFile: ts.SourceFile): AuthoringImports => {
  const result: AuthoringImports = {
    exchangeRule: new Set(),
    exchangeRules: new Set(),
    variable: new Set(),
    pattern: new Set(),
    thisPolicy: new Set(),
  };
  const targets = new Map<string, Set<string>>([
    ["exchangeRule", result.exchangeRule],
    ["exchangeRules", result.exchangeRules],
    ["v", result.variable],
    ["cfcPattern", result.pattern],
    ["THIS_POLICY", result.thisPolicy],
  ]);
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !CFC_AUTHORING_MODULES.has(statement.moduleSpecifier.text) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      targets.get(imported)?.add(element.name.text);
    }
  }
  return result;
};

const exportedNames = (sourceFile: ts.SourceFile): Set<string> => {
  const result = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const exported = (ts.getModifiers(statement) ?? []).some((modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword
      );
      if (exported) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            result.add(declaration.name.text);
          }
        }
      }
    } else if (
      ts.isExportDeclaration(statement) && !statement.moduleSpecifier &&
      statement.exportClause && ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (
          element.propertyName === undefined ||
          element.propertyName.text === element.name.text
        ) {
          result.add(element.name.text);
        }
      }
    }
  }
  return result;
};

const renamedExportBindings = (sourceFile: ts.SourceFile): Set<string> => {
  const result = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) || statement.moduleSpecifier ||
      !statement.exportClause || !ts.isNamedExports(statement.exportClause)
    ) continue;
    for (const element of statement.exportClause.elements) {
      if (
        element.propertyName !== undefined &&
        element.propertyName.text !== element.name.text
      ) {
        result.add(element.propertyName.text);
      }
    }
  }
  return result;
};

/** Order-independent manifest extraction used by PolicyOf schema lowering. */
export function compileCfcPolicyManifestsForSource(
  sourceFile: ts.SourceFile,
  moduleIdentity: string,
): readonly CfcPolicyCompilerManifestV1[] {
  const imports = collectImports(sourceFile);
  const exported = exportedNames(sourceFile);
  const rules = new Map<string, AuthoredRule>();
  const ruleNodes = new Map<string, ts.VariableDeclaration>();
  const declarations = new Map<string, ts.VariableDeclaration>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        declarations.set(declaration.name.text, declaration);
      }
    }
  }
  for (const [name, declaration] of declarations) {
    const initializer = declaration.initializer &&
      unwrapExpression(declaration.initializer);
    if (
      !initializer || !ts.isCallExpression(initializer) ||
      !isCallOf(initializer.expression, imports.exchangeRule)
    ) continue;
    ruleNodes.set(name, declaration);
    if (initializer.arguments.length !== 1) {
      throw new StaticAuthoringError(
        initializer,
        "exchangeRule() requires one argument",
      );
    }
    if (!exported.has(name)) {
      throw new StaticAuthoringError(
        declaration.name,
        "exchangeRule() bindings must be exported at module scope",
      );
    }
    const authored = evaluateStatic(initializer.arguments[0]!, imports);
    rules.set(name, lowerRule(name, authored, initializer));
  }

  const manifests: CfcPolicyCompilerManifestV1[] = [];
  const useCounts = new Map<string, number>();
  for (const [symbol, declaration] of declarations) {
    const initializer = declaration.initializer &&
      unwrapExpression(declaration.initializer);
    if (
      !initializer || !ts.isCallExpression(initializer) ||
      !isCallOf(initializer.expression, imports.exchangeRules)
    ) continue;
    if (!exported.has(symbol)) {
      throw new StaticAuthoringError(
        declaration.name,
        "exchangeRules() bindings must be exported at module scope",
      );
    }
    const argument = initializer.arguments[0] &&
      unwrapExpression(initializer.arguments[0]);
    if (
      initializer.arguments.length !== 1 || !argument ||
      !ts.isArrayLiteralExpression(argument)
    ) {
      throw new StaticAuthoringError(
        initializer,
        "exchangeRules() requires one static array of exported rule identifiers",
      );
    }
    const seen = new Set<string>();
    const selected = argument.elements.map((element) => {
      if (!ts.isIdentifier(element)) {
        throw new StaticAuthoringError(
          element,
          "exchangeRules() entries must be direct rule identifiers",
        );
      }
      const rule = rules.get(element.text);
      if (!rule) {
        throw new StaticAuthoringError(
          element,
          `exchangeRules() references invalid rule "${element.text}"`,
        );
      }
      if (seen.has(element.text)) {
        throw new StaticAuthoringError(
          element,
          `exchangeRules() contains duplicate rule "${element.text}"`,
        );
      }
      seen.add(element.text);
      useCounts.set(element.text, (useCounts.get(element.text) ?? 0) + 1);
      return rule;
    });
    const manifest = {
      formatVersion: 1 as const,
      moduleIdentity,
      symbol,
      template: {
        templateVersion: 1 as const,
        exchangeRules: selected,
        dependencies: { authorityOnly: [], dataBearing: [] },
        integrityRequirements: {},
      },
    };
    manifests.push(deepFreeze({
      policyDigest: hashStringOf({
        domain: "cfc/policy-manifest/v1",
        manifest,
      }),
      manifest,
    }));
  }
  for (const [name, declaration] of ruleNodes) {
    const count = useCounts.get(name) ?? 0;
    if (count !== 1) {
      throw new StaticAuthoringError(
        declaration.name,
        count === 0
          ? `exported rule "${name}" must belong to one exchangeRules() declaration`
          : `exported rule "${name}" cannot be reused across exchangeRules() declarations`,
      );
    }
  }
  return manifests;
}

export class CfcPolicyAuthoringTransformer extends Transformer {
  transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile } = context;
    const imports = collectImports(sourceFile);
    if (imports.exchangeRule.size === 0 && imports.exchangeRules.size === 0) {
      return sourceFile;
    }

    const exported = exportedNames(sourceFile);
    const renamedExports = renamedExportBindings(sourceFile);
    const declarations = new Map<string, ts.VariableDeclaration>();
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          declarations.set(declaration.name.text, declaration);
        }
      }
    }

    const rules = new Map<string, AuthoredRule>();
    const ruleNodes = new Map<string, ts.VariableDeclaration>();
    const handledCalls = new WeakSet<ts.CallExpression>();
    const replacements = new WeakMap<ts.CallExpression, ts.Expression>();
    const ruleSets: Array<{
      symbol: string;
      rules: readonly string[];
      node: ts.VariableDeclaration;
    }> = [];
    const report = (error: StaticAuthoringError): void =>
      context.reportDiagnostic({
        node: error.node,
        type: "cfc-policy-authoring",
        message: error.message,
      });

    for (const [name, declaration] of declarations) {
      if (!declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (!ts.isCallExpression(initializer)) continue;
      if (isCallOf(initializer.expression, imports.exchangeRule)) {
        handledCalls.add(initializer);
        ruleNodes.set(name, declaration);
        if (renamedExports.has(name)) {
          report(
            new StaticAuthoringError(
              declaration.name,
              "exchangeRule() bindings do not support renamed export specifiers",
            ),
          );
          continue;
        }
        if (!exported.has(name)) {
          report(
            new StaticAuthoringError(
              declaration.name,
              "exchangeRule() bindings must be exported at module scope",
            ),
          );
          continue;
        }
        try {
          if (initializer.arguments.length !== 1) {
            throw new StaticAuthoringError(
              initializer,
              "exchangeRule() requires one argument",
            );
          }
          const authored = evaluateStatic(initializer.arguments[0]!, imports);
          rules.set(name, lowerRule(name, authored, initializer));
          replacements.set(
            initializer,
            expressionFromStatic(authored, context.factory),
          );
        } catch (error) {
          if (error instanceof StaticAuthoringError) report(error);
          else throw error;
        }
      } else if (isCallOf(initializer.expression, imports.exchangeRules)) {
        handledCalls.add(initializer);
        if (renamedExports.has(name)) {
          report(
            new StaticAuthoringError(
              declaration.name,
              "exchangeRules() bindings do not support renamed export specifiers",
            ),
          );
          continue;
        }
        if (!exported.has(name)) {
          report(
            new StaticAuthoringError(
              declaration.name,
              "exchangeRules() bindings must be exported at module scope",
            ),
          );
          continue;
        }
        try {
          const argument = initializer.arguments[0] &&
            unwrapExpression(initializer.arguments[0]);
          if (
            initializer.arguments.length !== 1 || !argument ||
            !ts.isArrayLiteralExpression(argument)
          ) {
            throw new StaticAuthoringError(
              initializer,
              "exchangeRules() requires one static array of exported rule identifiers",
            );
          }
          const names = argument.elements.map((element) => {
            if (!ts.isIdentifier(element)) {
              throw new StaticAuthoringError(
                element,
                "exchangeRules() entries must be direct rule identifiers",
              );
            }
            return element.text;
          });
          replacements.set(initializer, argument);
          ruleSets.push({ symbol: name, rules: names, node: declaration });
        } catch (error) {
          if (error instanceof StaticAuthoringError) report(error);
          else throw error;
        }
      }
    }

    const findNonModuleCalls = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) && !handledCalls.has(node) &&
        (isCallOf(node.expression, imports.exchangeRule) ||
          isCallOf(node.expression, imports.exchangeRules))
      ) {
        context.reportDiagnostic({
          node,
          type: "cfc-policy-authoring",
          message:
            "exchangeRule() and exchangeRules() must be module-level exported bindings",
        });
      }
      ts.forEachChild(node, findNonModuleCalls);
    };
    findNonModuleCalls(sourceFile);

    const useCounts = new Map<string, number>();
    const manifests: CfcPolicyCompilerManifestV1[] = [];
    const moduleIdentity = context.options.moduleIdentities?.get(
      sourceFile.fileName,
    );
    for (const ruleSet of ruleSets) {
      const selected: AuthoredRule[] = [];
      let valid = true;
      const seen = new Set<string>();
      for (const name of ruleSet.rules) {
        const rule = rules.get(name);
        if (!rule || !exported.has(name)) {
          report(
            new StaticAuthoringError(
              ruleSet.node,
              `exchangeRules() references non-exported or invalid rule "${name}"`,
            ),
          );
          valid = false;
          continue;
        }
        if (seen.has(name)) {
          report(
            new StaticAuthoringError(
              ruleSet.node,
              `exchangeRules() contains duplicate rule "${name}"`,
            ),
          );
          valid = false;
          continue;
        }
        seen.add(name);
        useCounts.set(name, (useCounts.get(name) ?? 0) + 1);
        selected.push(rule);
      }
      if (!valid) continue;
      if (!moduleIdentity) {
        report(
          new StaticAuthoringError(
            ruleSet.node,
            "compiler did not provide a module identity for this policy declaration",
          ),
        );
        continue;
      }
      const manifest = {
        formatVersion: 1 as const,
        moduleIdentity,
        symbol: ruleSet.symbol,
        template: {
          templateVersion: 1 as const,
          exchangeRules: selected,
          dependencies: { authorityOnly: [], dataBearing: [] },
          integrityRequirements: {},
        },
      };
      manifests.push(deepFreeze({
        policyDigest: hashStringOf({
          domain: "cfc/policy-manifest/v1",
          manifest,
        }),
        manifest,
      }));
    }

    for (const [name, declaration] of ruleNodes) {
      const count = useCounts.get(name) ?? 0;
      if (count !== 1) {
        context.reportDiagnostic({
          node: declaration.name,
          type: "cfc-policy-authoring",
          message: count === 0
            ? `exported rule "${name}" must belong to one exchangeRules() declaration`
            : `exported rule "${name}" cannot be reused across exchangeRules() declarations`,
        });
      }
    }
    context.state.recordPolicyManifests(
      sourceFile.fileName,
      manifests,
    );
    const lowerDeclarations: ts.Visitor = (node) => {
      if (ts.isCallExpression(node)) {
        const replacement = replacements.get(node);
        if (replacement) return ts.setOriginalNode(replacement, node);
      }
      return ts.visitEachChild(node, lowerDeclarations, context.tsContext);
    };
    return ts.visitNode(sourceFile, lowerDeclarations) as ts.SourceFile;
  }
}
