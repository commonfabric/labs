import ts from "typescript";

import { getDeclaredTypeNodeForBindingElement } from "./type-building.ts";
import type { SchemaHint, TransformationContext } from "../core/mod.ts";

export type FactoryContractHint = NonNullable<
  SchemaHint["factoryContracts"]
>[number];

export interface FactoryContractProvenance {
  readonly contracts: readonly FactoryContractHint[];
  /** Every alternate union arm has its own compiler-owned provenance. */
  readonly complete: boolean;
}

/** Recover the authored type node that gives one value binding its contract. */
export function factoryContractDeclaredTypeNode(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): ts.TypeNode | undefined {
  if (ts.isBindingElement(declaration)) {
    return getDeclaredTypeNodeForBindingElement(declaration, checker);
  }
  if (
    ts.isVariableDeclaration(declaration) ||
    ts.isParameter(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isPropertyDeclaration(declaration)
  ) {
    return declaration.type;
  }
  return undefined;
}

/**
 * Collect node-scoped compiler contracts through transparent type wrappers and
 * authored aliases. Structural `ts.Type` identity is intentionally not a
 * fallback because it cannot distinguish same-shaped privileged wrappers.
 */
export function factoryContractProvenanceFromTypeNode(
  typeNode: ts.TypeNode,
  context: TransformationContext,
  seen: Set<ts.Node> = new Set(),
): FactoryContractProvenance {
  const original = ts.getOriginalNode(typeNode);
  if (seen.has(typeNode) || seen.has(original)) {
    return { contracts: [], complete: false };
  }
  seen.add(typeNode);
  seen.add(original);
  const direct = context.lookupSchemaHint(typeNode)?.factoryContracts;
  if (direct?.length) return { contracts: direct, complete: true };

  if (ts.isParenthesizedTypeNode(typeNode) || ts.isTypeOperatorNode(typeNode)) {
    return factoryContractProvenanceFromTypeNode(typeNode.type, context, seen);
  }
  if (ts.isUnionTypeNode(typeNode)) {
    const arms = typeNode.types.map((member) =>
      factoryContractProvenanceFromTypeNode(member, context, new Set(seen))
    );
    return {
      contracts: dedupeFactoryContractHints(
        arms.flatMap((arm) => arm.contracts),
      ),
      complete: arms.every((arm) => arm.complete && arm.contracts.length > 0),
    };
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    const parts = typeNode.types.map((member) =>
      factoryContractProvenanceFromTypeNode(member, context, new Set(seen))
    );
    return {
      contracts: dedupeFactoryContractHints(
        parts.flatMap((part) => part.contracts),
      ),
      // An intersection refines one value; one provenanced factory constituent
      // is sufficient, unlike an alternate union arm.
      complete: parts.some((part) =>
        part.complete && part.contracts.length > 0
      ),
    };
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    let symbol = context.checker.getSymbolAtLocation(typeNode.typeName);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        symbol = context.checker.getAliasedSymbol(symbol);
      } catch {
        // Preserve the local alias if the checker cannot resolve the import.
      }
    }
    const declaration = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
    if (declaration) {
      return factoryContractProvenanceFromTypeNode(
        declaration.type,
        context,
        seen,
      );
    }
  }
  return { contracts: [], complete: false };
}

function dedupeFactoryContractHints(
  contracts: readonly FactoryContractHint[],
): readonly FactoryContractHint[] {
  return [...new Set(contracts)];
}
