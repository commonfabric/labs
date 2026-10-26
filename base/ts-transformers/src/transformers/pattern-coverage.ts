import ts from "typescript";
import { isSyntheticNode } from "../ast/mod.ts";
import {
  PATTERN_COVERAGE_GLOBAL,
  type PatternCoverageSpan,
  TransformationContext,
  Transformer,
} from "../core/mod.ts";

export class PatternCoverageTransformer extends Transformer {
  override filter(context: TransformationContext): boolean {
    return context.options.patternCoverage !== undefined &&
      !context.sourceFile.isDeclarationFile;
  }

  transform(context: TransformationContext): ts.SourceFile {
    const coverage = context.options.patternCoverage;
    if (!coverage) return context.sourceFile;

    let nextSpanId = 0;
    const fileName = coverage.fileName?.(context.sourceFile.fileName) ??
      context.sourceFile.fileName;

    const coverageGlobal = () =>
      context.factory.createPropertyAccessExpression(
        context.factory.createIdentifier("globalThis"),
        PATTERN_COVERAGE_GLOBAL,
      );

    // `createCallChain`, not `createCallExpression`: the call has to be part of
    // the optional chain. A plain call wrapping a chained callee prints as
    // `(globalThis.__cfPatternCoverage?.hit)(...)`, whose parentheses end the
    // chain — the short-circuit yields `undefined` and the call then throws. As a
    // chain it prints `globalThis.__cfPatternCoverage?.hit(...)` and a body with
    // no collector installed skips the probe instead of throwing.
    const makeHitStatement = (spanId: number): ts.Statement => {
      return context.factory.createExpressionStatement(
        context.factory.createCallChain(
          context.factory.createPropertyAccessChain(
            coverageGlobal(),
            context.factory.createToken(ts.SyntaxKind.QuestionDotToken),
            "hit",
          ),
          undefined,
          undefined,
          [
            context.factory.createStringLiteral(fileName),
            context.factory.createNumericLiteral(spanId),
          ],
        ),
      );
    };

    const sourceRangeForSpan = (
      node: ts.Node,
    ): { start: number; end: number } | undefined => {
      const original = ts.getOriginalNode(node);
      const candidates = original === node ? [node] : [node, original];
      for (const candidate of candidates) {
        if (isSyntheticNode(candidate)) continue;
        try {
          const start = candidate.getStart(context.sourceFile);
          const end = candidate.getEnd();
          if (end > start) return { start, end };
        } catch {
          // Try the next source-linked candidate.
        }
      }

      const sourceMapRange = ts.getSourceMapRange(node);
      if (sourceMapRange.pos >= 0 && sourceMapRange.end > sourceMapRange.pos) {
        return {
          start: sourceMapRange.pos,
          end: sourceMapRange.end,
        };
      }
      return undefined;
    };

    const registerSpan = (node: ts.Node): number | undefined => {
      const sourceRange = sourceRangeForSpan(node);
      if (!sourceRange) return undefined;
      const { start, end } = sourceRange;
      if (end <= start) return undefined;
      const startLoc = context.sourceFile.getLineAndCharacterOfPosition(start);
      const endLoc = context.sourceFile.getLineAndCharacterOfPosition(end - 1);
      const rawSpan: PatternCoverageSpan = {
        fileName,
        id: ++nextSpanId,
        kind: "runtime",
        startLine: startLoc.line + 1,
        endLine: endLoc.line + 1,
        startColumn: startLoc.character + 1,
        endColumn: endLoc.character + 1,
      };
      const span = coverage.mapSpan ? coverage.mapSpan(rawSpan) : rawSpan;
      if (span === undefined) return undefined;
      coverage.registerSpan(span);
      return span.id;
    };

    const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean => {
      return ts.canHaveModifiers(node) &&
        (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ??
          false);
    };

    const hasDeclareModifier = (node: ts.Node): boolean =>
      hasModifier(node, ts.SyntaxKind.DeclareKeyword);

    const isConstEnumDeclaration = (statement: ts.Statement): boolean =>
      ts.isEnumDeclaration(statement) &&
      hasModifier(statement, ts.SyntaxKind.ConstKeyword);

    const isErasedNamespaceStatement = (statement: ts.Statement): boolean => {
      return hasDeclareModifier(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        isConstEnumDeclaration(statement) ||
        (ts.isImportEqualsDeclaration(statement) && statement.isTypeOnly) ||
        (ts.isModuleDeclaration(statement) &&
          isErasedModuleDeclaration(statement));
    };

    const isErasedModuleDeclaration = (
      statement: ts.ModuleDeclaration,
    ): boolean => {
      if (statement.body === undefined) return true;
      if (ts.isModuleDeclaration(statement.body)) {
        return isErasedModuleDeclaration(statement.body);
      }
      if (!ts.isModuleBlock(statement.body)) return true;
      return statement.body.statements.every(isErasedNamespaceStatement);
    };

    const shouldInstrumentStatement = (statement: ts.Statement): boolean => {
      return !hasDeclareModifier(statement) &&
        !ts.isFunctionDeclaration(statement) &&
        !ts.isClassDeclaration(statement) &&
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement) &&
        !isConstEnumDeclaration(statement) &&
        !(ts.isModuleDeclaration(statement) &&
          isErasedModuleDeclaration(statement)) &&
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement);
    };

    const isDirectiveStatement = (statement: ts.Statement): boolean =>
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression) &&
      statement.expression.text === "use strict";

    const instrumentStatements = (
      statements: ts.NodeArray<ts.Statement>,
      preserveDirectivePrologue = false,
    ): ts.Statement[] => {
      const out: ts.Statement[] = [];
      let inDirectivePrologue = true;
      for (const statement of statements) {
        const visited = isErasedNamespaceStatement(statement)
          ? statement
          : ts.visitNode(statement, visit, ts.isStatement);
        const isDirective = preserveDirectivePrologue &&
          inDirectivePrologue &&
          isDirectiveStatement(statement);
        if (!isDirective && shouldInstrumentStatement(statement)) {
          const spanId = registerSpan(statement);
          if (spanId !== undefined) out.push(makeHitStatement(spanId));
        }
        out.push(visited);
        if (!isDirective) inDirectivePrologue = false;
      }
      return out;
    };

    const instrumentBlock = (
      body: ts.Block,
      preserveDirectivePrologue = false,
    ): ts.Block => {
      return context.factory.updateBlock(
        body,
        instrumentStatements(body.statements, preserveDirectivePrologue),
      );
    };

    const instrumentStatementBody = (statement: ts.Statement): ts.Statement => {
      if (ts.isBlock(statement)) return instrumentBlock(statement);
      const visited = ts.visitNode(statement, visit, ts.isStatement);
      if (!shouldInstrumentStatement(statement)) return visited;
      const spanId = registerSpan(statement);
      return context.factory.createBlock(
        spanId === undefined ? [visited] : [makeHitStatement(spanId), visited],
        true,
      );
    };

    const wrapVisitedStatementBody = (
      statement: ts.Statement,
    ): ts.Statement => {
      if (ts.isBlock(statement)) return statement;
      if (!shouldInstrumentStatement(statement)) return statement;
      const spanId = registerSpan(statement);
      return context.factory.createBlock(
        spanId === undefined
          ? [statement]
          : [makeHitStatement(spanId), statement],
        true,
      );
    };

    const visitIfStatement = (node: ts.IfStatement): ts.IfStatement => {
      return context.factory.updateIfStatement(
        node,
        ts.visitNode(node.expression, visit, ts.isExpression),
        instrumentStatementBody(node.thenStatement),
        node.elseStatement
          ? instrumentStatementBody(node.elseStatement)
          : undefined,
      );
    };

    const visitIterationStatement = <
      T extends ts.DoStatement | ts.WhileStatement | ts.ForStatement,
    >(node: T): T => {
      const visited = ts.visitEachChild(node, visit, context.tsContext) as T;
      if (ts.isDoStatement(visited)) {
        return context.factory.updateDoStatement(
          visited,
          wrapVisitedStatementBody(visited.statement),
          visited.expression,
        ) as T;
      }
      if (ts.isWhileStatement(visited)) {
        return context.factory.updateWhileStatement(
          visited,
          visited.expression,
          wrapVisitedStatementBody(visited.statement),
        ) as T;
      }
      return context.factory.updateForStatement(
        visited,
        visited.initializer,
        visited.condition,
        visited.incrementor,
        wrapVisitedStatementBody(visited.statement),
      ) as T;
    };

    const visitForInOrOfStatement = (
      node: ts.ForInStatement | ts.ForOfStatement,
    ): ts.ForInStatement | ts.ForOfStatement => {
      const visited = ts.visitEachChild(node, visit, context.tsContext);
      if (ts.isForInStatement(visited)) {
        return context.factory.updateForInStatement(
          visited,
          visited.initializer,
          visited.expression,
          wrapVisitedStatementBody(visited.statement),
        );
      }
      return context.factory.updateForOfStatement(
        visited,
        visited.awaitModifier,
        visited.initializer,
        visited.expression,
        wrapVisitedStatementBody(visited.statement),
      );
    };

    const visitCaseOrDefaultClause = (
      node: ts.CaseClause | ts.DefaultClause,
    ): ts.CaseClause | ts.DefaultClause => {
      const instrumentedStatements = node.statements.length === 0
        ? (() => {
          const spanId = registerSpan(node);
          return spanId === undefined ? [] : [makeHitStatement(spanId)];
        })()
        : instrumentStatements(node.statements);
      if (ts.isCaseClause(node)) {
        return context.factory.updateCaseClause(
          node,
          ts.visitNode(node.expression, visit, ts.isExpression),
          instrumentedStatements,
        );
      }
      return context.factory.updateDefaultClause(
        node,
        instrumentedStatements,
      );
    };

    const instrumentConciseBody = (
      body: ts.ConciseBody,
    ): ts.ConciseBody => {
      if (ts.isBlock(body)) return instrumentBlock(body, true);

      const visited = ts.visitNode(body, visit, ts.isExpression);
      const spanId = registerSpan(body);
      const statements: ts.Statement[] = [];
      if (spanId !== undefined) statements.push(makeHitStatement(spanId));
      statements.push(context.factory.createReturnStatement(visited));
      return context.factory.createBlock(statements, true);
    };

    const visitFunctionLike = (node: ts.Node): ts.Node => {
      if (ts.isArrowFunction(node)) {
        return context.factory.updateArrowFunction(
          node,
          node.modifiers,
          node.typeParameters,
          node.parameters,
          node.type,
          node.equalsGreaterThanToken,
          instrumentConciseBody(node.body),
        );
      }
      if (ts.isFunctionDeclaration(node)) {
        return context.factory.updateFunctionDeclaration(
          node,
          node.modifiers,
          node.asteriskToken,
          node.name,
          node.typeParameters,
          node.parameters,
          node.type,
          node.body ? instrumentBlock(node.body, true) : node.body,
        );
      }
      if (ts.isFunctionExpression(node)) {
        return context.factory.updateFunctionExpression(
          node,
          node.modifiers,
          node.asteriskToken,
          node.name,
          node.typeParameters,
          node.parameters,
          node.type,
          instrumentBlock(node.body, true),
        );
      }
      if (ts.isMethodDeclaration(node)) {
        return context.factory.updateMethodDeclaration(
          node,
          node.modifiers,
          node.asteriskToken,
          node.name,
          node.questionToken,
          node.typeParameters,
          node.parameters,
          node.type,
          node.body ? instrumentBlock(node.body, true) : node.body,
        );
      }
      if (ts.isConstructorDeclaration(node)) {
        return context.factory.updateConstructorDeclaration(
          node,
          node.modifiers,
          node.parameters,
          node.body ? instrumentBlock(node.body, true) : node.body,
        );
      }
      if (ts.isGetAccessorDeclaration(node)) {
        return context.factory.updateGetAccessorDeclaration(
          node,
          node.modifiers,
          node.name,
          node.parameters,
          node.type,
          node.body ? instrumentBlock(node.body, true) : node.body,
        );
      }
      if (ts.isSetAccessorDeclaration(node)) {
        return context.factory.updateSetAccessorDeclaration(
          node,
          node.modifiers,
          node.name,
          node.parameters,
          node.body ? instrumentBlock(node.body, true) : node.body,
        );
      }
      return node;
    };

    const visit = (node: ts.Node): ts.Node => {
      if (
        ts.isArrowFunction(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        return visitFunctionLike(node);
      }
      if (ts.isBlock(node)) {
        return instrumentBlock(node);
      }
      if (ts.isIfStatement(node)) {
        return visitIfStatement(node);
      }
      if (
        ts.isDoStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isForStatement(node)
      ) {
        return visitIterationStatement(node);
      }
      if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        return visitForInOrOfStatement(node);
      }
      if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
        return visitCaseOrDefaultClause(node);
      }
      if (ts.isModuleBlock(node)) {
        return context.factory.updateModuleBlock(
          node,
          instrumentStatements(node.statements),
        );
      }
      if (ts.isClassStaticBlockDeclaration(node)) {
        return context.factory.updateClassStaticBlockDeclaration(
          node,
          instrumentBlock(node.body),
        );
      }
      return ts.visitEachChild(node, visit, context.tsContext);
    };

    return context.factory.updateSourceFile(
      context.sourceFile,
      instrumentStatements(context.sourceFile.statements, true),
    );
  }
}
