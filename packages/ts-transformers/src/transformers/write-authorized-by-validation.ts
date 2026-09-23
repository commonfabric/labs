import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { getNodeText } from "../ast/mod.ts";
import { detectNewExpressionKind } from "../ast/call-kind.ts";
import { resolveWriterBinding } from "@commonfabric/schema-generator/writer-binding";
import { unwrapExpression } from "../utils/expression.ts";

export class WriteAuthorizedByValidationTransformer
  extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const { sourceFile } = context;

    const visit: ts.Visitor = (node) => {
      if (isToSchemaNode(node)) {
        const typeArg = node.typeArguments?.[0];
        if (typeArg) {
          validateWriteAuthorizedByUsage(typeArg, context);
        }
      }
      if (isPatternNode(node)) {
        const resultTypeArg = node.typeArguments?.[1];
        if (resultTypeArg) {
          validateWriteAuthorizedByUsage(resultTypeArg, context);
        }
      }
      // A constructed cell's policy is written on its constructor, and reaches
      // the lift-result and pattern-result schemas from there. Unvalidated, a
      // binding the generator cannot read produced a schema with no writer.
      // Only a cell's constructor: `new Map<string, WriteAuthorizedBy<T, B>>()`
      // generates no schema, and its unresolved `B` is no defect.
      if (
        ts.isNewExpression(node) &&
        detectNewExpressionKind(node, context.checker) !== undefined
      ) {
        for (const typeArg of node.typeArguments ?? []) {
          validateWriteAuthorizedByUsage(typeArg, context);
        }
      }

      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return ts.visitNode(sourceFile, visit) as ts.SourceFile;
  }
}

function isPatternNode(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const { typeArguments, expression } = node;
  if (!typeArguments || typeArguments.length < 2) return false;

  if (ts.isIdentifier(expression) && expression.text === "pattern") {
    return true;
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "pattern"
  ) {
    return true;
  }

  return false;
}

function isToSchemaNode(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const { typeArguments, expression } = node;
  if (!typeArguments || typeArguments.length !== 1) return false;

  if (ts.isIdentifier(expression) && expression.text === "toSchema") {
    return true;
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "toSchema"
  ) {
    return true;
  }

  return false;
}

function validateWriteAuthorizedByUsage(
  typeNode: ts.TypeNode,
  context: TransformationContext,
): void {
  const references = findWriteAuthorizedByReferences(typeNode, context);
  for (const reference of references) {
    const [schemaType, bindingType] = reference.typeArguments ?? [];
    if (!schemaType || !bindingType || !ts.isTypeQueryNode(bindingType)) {
      context.reportDiagnostic({
        node: reference,
        type: "cfc-write-authorized-by",
        message:
          "WriteAuthorizedBy<T, typeof binding> requires a direct typeof binding reference.",
      });
      continue;
    }

    if (!ts.isIdentifier(bindingType.exprName)) {
      context.reportDiagnostic({
        node: bindingType,
        type: "cfc-write-authorized-by",
        message:
          "WriteAuthorizedBy<T, typeof binding> requires a simple identifier binding.",
      });
      continue;
    }

    if (
      !isSupportedWriteAuthorizedByBinding(bindingType.exprName, context)
    ) {
      context.reportDiagnostic({
        node: bindingType.exprName,
        type: "cfc-write-authorized-by",
        message:
          "WriteAuthorizedBy only supports handler(), module(), requireEventIntegrity(), or function-declaration bindings declared in an authored module.",
      });
    }
  }
}

function findWriteAuthorizedByReferences(
  node: ts.TypeNode,
  context: TransformationContext,
): ts.TypeReferenceNode[] {
  const matches: ts.TypeReferenceNode[] = [];
  const visited = new Set<string>();
  const visit = (
    current: ts.Node,
    typeParamMap: ReadonlyMap<string, ts.TypeNode>,
  ): void => {
    if (ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName)) {
      const mapped = typeParamMap.get(current.typeName.text);
      if (mapped && !current.typeArguments?.length) {
        visit(mapped, typeParamMap);
        return;
      }
    }

    if (
      ts.isTypeReferenceNode(current) &&
      ts.isIdentifier(current.typeName) &&
      (isWriteAuthorizedByLikeTypeName(current.typeName.text) ||
        isWriteAuthorizedByLikeTypeName(
          importedDeclarationName(current.typeName, context),
        ))
    ) {
      matches.push(substituteTypeReferenceNode(current, typeParamMap));
      return;
    }

    if (ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName)) {
      const declaration = getTypeDeclaration(current, context);
      if (declaration) {
        const key = declarationKey(declaration, current);
        if (visited.has(key)) {
          return;
        }
        visited.add(key);

        const nextParamMap = new Map<string, ts.TypeNode>(typeParamMap);
        const typeParameters = declaration.typeParameters ?? [];
        for (let i = 0; i < typeParameters.length; i++) {
          const paramName = typeParameters[i]?.name.text;
          const actual = current.typeArguments?.[i];
          if (paramName && actual) {
            nextParamMap.set(
              paramName,
              substituteTypeNode(actual, typeParamMap),
            );
          }
        }

        if (ts.isTypeAliasDeclaration(declaration)) {
          visit(declaration.type, nextParamMap);
          return;
        }

        for (const member of declaration.members) {
          if (ts.isPropertySignature(member) && member.type) {
            visit(member.type, nextParamMap);
          }
          if (ts.isIndexSignatureDeclaration(member) && member.type) {
            visit(member.type, nextParamMap);
          }
        }
        return;
      }
    }
    ts.forEachChild(current, (child) => visit(child, typeParamMap));
  };
  visit(node, new Map());
  return matches;
}

function isWriteAuthorizedByLikeTypeName(name: string | undefined): boolean {
  return name === "WriteAuthorizedBy" ||
    name === "TrustedActionWrite" ||
    name === "TrustedActionWriteWithIntegrity";
}

/**
 * The declared name behind an import binding — `Guarded` for
 * `import { WriteAuthorizedBy as Guarded }` is `WriteAuthorizedBy`. The
 * schema generator reads the claim through the rename, so the check must.
 */
function importedDeclarationName(
  name: ts.Identifier,
  context: TransformationContext,
): string | undefined {
  const symbol = context.checker.getSymbolAtLocation(name);
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) return undefined;
  return context.checker.getAliasedSymbol(symbol).declarations?.find(
    ts.isTypeAliasDeclaration,
  )?.name.text;
}

/**
 * Whether `binding` names a writer the claim may cite: a `handler()`,
 * `module()` or `requireEventIntegrity()` binding, or a function declaration,
 * declared in an authored module — this one, or one it imports, through any
 * re-export. The schema generator stamps the claim with the DECLARING module's
 * identity, and the runtime verifies the write against the writer's own
 * provenance, so an imported writer is as sound a claim as a local one. A
 * declaration file has no provenance to verify against.
 *
 * Resolved through the checker rather than by scanning the file for the name:
 * the file this stage sees has been rewritten by the ones before it, and a
 * name scan cannot tell a module-level writer from a shadowing local.
 */
function isSupportedWriteAuthorizedByBinding(
  binding: ts.Identifier,
  context: TransformationContext,
): boolean {
  const resolved = resolveWriterBinding(binding, context.checker);
  if (!resolved) return false;
  const { declaration } = resolved;
  if (ts.isFunctionDeclaration(declaration)) return true;
  return declaration.initializer !== undefined &&
    isSupportedWriteAuthorizedByInitializer(declaration.initializer);
}

/**
 * The type alias or interface a reference names, wherever it is declared:
 * this file, a module it imports through any re-export, or a declaration
 * file. The schema generator resolves a reference the same way, so a policy
 * any alias carries reaches the schema, and must reach this check — a
 * declaration file's alias that names a writer is refused by the binding
 * check, since a declaration has no provenance for the runtime to verify.
 * The library's own `WriteAuthorizedBy` and `TrustedActionWrite*` are matched
 * by name before their declarations would be read.
 *
 * Resolved through the checker: the file this stage sees has been rewritten
 * by the ones before it, and a declaration the checker returns belongs to the
 * file as authored, so neither identity nor a scan of the rewritten file
 * would find it.
 */
function getTypeDeclaration(
  node: ts.TypeReferenceNode,
  context: TransformationContext,
): ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined {
  let symbol = context.checker.getSymbolAtLocation(node.typeName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = context.checker.getAliasedSymbol(symbol);
  }
  return symbol?.declarations?.find((
    decl,
  ): decl is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
    ts.isTypeAliasDeclaration(decl) || ts.isInterfaceDeclaration(decl)
  );
}

function declarationKey(
  declaration: ts.Declaration,
  reference: ts.TypeReferenceNode,
): string {
  const args =
    reference.typeArguments?.map((arg) => getNodeText(arg)).join(",") ??
      "";
  return `${declaration.getSourceFile().fileName}:${declaration.pos}:${args}`;
}

function substituteTypeReferenceNode(
  node: ts.TypeReferenceNode,
  paramMap: ReadonlyMap<string, ts.TypeNode>,
): ts.TypeReferenceNode {
  return substituteTypeNode(node, paramMap) as ts.TypeReferenceNode;
}

function substituteTypeNode(
  node: ts.TypeNode,
  paramMap: ReadonlyMap<string, ts.TypeNode>,
): ts.TypeNode {
  if (paramMap.size === 0) {
    return node;
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const mapped = paramMap.get(node.typeName.text);
    if (mapped && !node.typeArguments?.length) {
      return mapped;
    }
    if (node.typeArguments?.length) {
      return ts.factory.updateTypeReferenceNode(
        node,
        node.typeName,
        ts.factory.createNodeArray(
          node.typeArguments.map((arg) => substituteTypeNode(arg, paramMap)),
        ),
      );
    }
    return node;
  }
  if (ts.isTypeLiteralNode(node)) {
    return ts.factory.updateTypeLiteralNode(
      node,
      ts.factory.createNodeArray(node.members.map((member) => {
        if (ts.isPropertySignature(member) && member.type) {
          return ts.factory.updatePropertySignature(
            member,
            member.modifiers,
            member.name,
            member.questionToken,
            substituteTypeNode(member.type, paramMap),
          );
        }
        if (ts.isIndexSignatureDeclaration(member) && member.type) {
          return ts.factory.updateIndexSignature(
            member,
            member.modifiers,
            member.parameters,
            substituteTypeNode(member.type, paramMap),
          );
        }
        return member;
      })),
    );
  }
  if (ts.isTupleTypeNode(node)) {
    return ts.factory.updateTupleTypeNode(
      node,
      node.elements.map((element) =>
        substituteTypeNode(element as ts.TypeNode, paramMap) as ts.TypeNode
      ),
    );
  }
  if (ts.isArrayTypeNode(node)) {
    return ts.factory.updateArrayTypeNode(
      node,
      substituteTypeNode(node.elementType, paramMap),
    );
  }
  if (ts.isUnionTypeNode(node)) {
    return ts.factory.updateUnionTypeNode(
      node,
      ts.factory.createNodeArray(
        node.types.map((type) => substituteTypeNode(type, paramMap)),
      ),
    );
  }
  if (ts.isIntersectionTypeNode(node)) {
    return ts.factory.updateIntersectionTypeNode(
      node,
      ts.factory.createNodeArray(
        node.types.map((type) => substituteTypeNode(type, paramMap)),
      ),
    );
  }
  if (ts.isTypeOperatorNode(node)) {
    return ts.factory.updateTypeOperatorNode(
      node,
      substituteTypeNode(node.type, paramMap),
    );
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return ts.factory.updateParenthesizedType(
      node,
      substituteTypeNode(node.type, paramMap),
    );
  }
  return node;
}

function isSupportedWriteAuthorizedByInitializer(
  initializer: ts.Expression,
): boolean {
  const expression = unwrapExpression(initializer);
  return ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    (
      expression.expression.text === "handler" ||
      expression.expression.text === "module" ||
      expression.expression.text === "requireEventIntegrity"
    );
}
