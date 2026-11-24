import ts from "typescript";

import { getExpressionText, type NormalizedDataFlow } from "../../ast/mod.ts";
import { createPropertyParamNames } from "../../utils/identifiers.ts";

export interface BindingPlanEntry {
  readonly dataFlow: NormalizedDataFlow;
  readonly propertyName: string;
  readonly paramName: string;
}

export interface BindingPlan {
  readonly entries: readonly BindingPlanEntry[];
  readonly usesObjectBinding: boolean;
}

export function createBindingPlan(
  dataFlows: readonly NormalizedDataFlow[],
): BindingPlan {
  const usedPropertyNames = new Set<string>();
  const usedParamNames = new Set<string>();
  const entries: BindingPlanEntry[] = [];

  dataFlows.forEach((dataFlow, index) => {
    const { propertyName, paramName } = createPropertyParamNames(
      getExpressionText(dataFlow.expression),
      ts.isIdentifier(dataFlow.expression),
      index,
      usedPropertyNames,
      usedParamNames,
    );

    entries.push({ dataFlow, propertyName, paramName });
  });

  return {
    entries,
    usesObjectBinding: entries.length > 1,
  };
}
