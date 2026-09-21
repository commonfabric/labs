import ts from "typescript";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { getNodeText } from "../ast/mod.ts";
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
      if (ts.isNewExpression(node)) {
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
      !isSupportedWriteAuthorizedByBindingName(
        bindingType.exprName.text,
        context.sourceFile,
      )
    ) {
      context.reportDiagnostic({
        node: bindingType.exprName,
        type: "cfc-write-authorized-by",
        message:
          "WriteAuthorizedBy only supports local handler(), module(), requireEventIntegrity(), or function-declaration bindings.",
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
      isWriteAuthorizedByLikeTypeName(current.typeName.text)
    ) {
      matches.push(substituteTypeReferenceNode(current, typeParamMap));
      return;
    }

    if (ts.isTypeReferenceNode(current) && ts.isIdentifier(current.typeName)) {
      const declaration = getLocalTypeDeclaration(current, context);
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

function isWriteAuthorizedByLikeTypeName(name: string): boolean {
  return name === "WriteAuthorizedBy" ||
    name === "TrustedActionWrite" ||
    name === "TrustedActionWriteWithIntegrity";
}

function isSupportedWriteAuthorizedByBindingName(
  name: string,
  sourceFile: ts.SourceFile,
): boolean {
  let found = false;
  // The file as its author wrote it. By this stage earlier ones have rewritten
  // `sourceFile`, and a declaration they carried over still reports the
  // authored file as its own, so identity against the rewritten file holds
  // for nothing.
  const authored = ts.getOriginalNode(sourceFile, ts.isSourceFile) ??
    sourceFile;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (
      ts.isFunctionDeclaration(node) && node.name?.text === name
    ) {
      found = true;
      return;
    }

    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node.initializer !== undefined &&
        isSupportedWriteAuthorizedByInitializer(node.initializer);
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(authored);
  return found;
}

function getLocalTypeDeclaration(
  node: ts.TypeReferenceNode,
  context: TransformationContext,
): ts.TypeAliasDeclaration | ts.InterfaceDeclaration | undefined {
  const symbol = context.checker.getSymbolAtLocation(node.typeName);
  const declaration = symbol?.declarations?.find((
    decl,
  ): decl is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
    (ts.isTypeAliasDeclaration(decl) || ts.isInterfaceDeclaration(decl)) &&
    // By file name: earlier stages have rewritten `context.sourceFile`, and a
    // declaration the checker returns belongs to the file as authored.
    decl.getSourceFile().fileName === context.sourceFile.fileName
  );
  return declaration;
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
