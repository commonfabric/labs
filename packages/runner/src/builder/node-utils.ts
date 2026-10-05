import { FabricInstance, refuseFabricInstance } from "@commonfabric/data-model";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { exportCell, isCell } from "../cell.ts";
import { ContextualFlowControl } from "../cfc.ts";
import type { CfcConfClause } from "../cfc/clause.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { getAuthoredDebugSource } from "../harness/authored-debug-source.ts";
import { closureCaptureErrorMessage } from "./closure-capture-diagnostic.ts";
import { traverseValue } from "./traverse-utils.ts";
import { type FactoryInput, type JSONSchema, type NodeRef } from "./types.ts";

export function connectInputAndOutputs(node: NodeRef) {
  function connect(value: any): any {
    if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);
    if (isCell(value)) {
      const exported = exportCell(value);
      if (exported.frame !== node.frame) {
        const implementation = isObjectOrArray(node.module)
          ? node.module.implementation
          : undefined;
        // A factory applied during module evaluation predates the provenance
        // walk that records authored positions, so the location is routinely
        // absent here. The body preview is stamped at mint time and does not
        // depend on that walk, so it names the offending callback either way.
        const debugSource = getAuthoredDebugSource(implementation);
        const preview = typeof implementation === "function"
          ? (implementation as { preview?: string }).preview
          : undefined;
        throw new Error(
          closureCaptureErrorMessage({
            capturedCell: {
              path: exported.path,
              scope: exported.scope,
              name: exported.name,
            },
            sourceLocation: debugSource?.src ?? null,
            implementationPreview: preview ?? null,
          }),
        );
      }
      value.connect(node);
    }
    return undefined;
  }

  node.inputs = traverseValue(node.inputs, connect);
  node.outputs = traverseValue(node.outputs, connect);

  // Every module's outputs carry the join of its inputs' ifc tags. The graph is
  // assembled before anything is read, so the join over-approximates what any
  // one attempt goes on to consume, and it stays the floor: it mints a
  // `declared` entry, and a path's effective label is the join of all its
  // components, so no later measurement narrows it. Labeling an output below
  // the join is the flow-precision claim of CFC §8.9.1, which that section
  // holds to trust in the executing implementation for `flow-taint-precision`
  // under the acting user, and this seam names no user.
  // `docs/specs/cfc-render-boundary-composition.md` states the rest.
  applyInputIfcToOutput(node.inputs, node.outputs);
}

export function applyArgumentIfcToResult(
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
): JSONSchema | undefined {
  if (argumentSchema !== undefined) {
    const joined = new Set<unknown>();
    ContextualFlowControl.joinSchema(joined, argumentSchema);
    return (joined.size !== 0)
      ? ContextualFlowControl.schemaWithLub(
        resultSchema ?? true,
        ContextualFlowControl.lub(joined),
      )
      : resultSchema;
  }
  return resultSchema;
}

// If our inputs had any ifc tags, carry them through to our outputs
export function applyInputIfcToOutput<T, R>(
  inputs: FactoryInput<T>,
  outputs: FactoryInput<R>,
) {
  const collectedClassifications = new Set<unknown>();
  traverseValue(inputs, (item: unknown) => {
    if (isCell(item)) {
      const { schema: inputSchema } = exportCell(item);
      if (inputSchema !== undefined) {
        ContextualFlowControl.joinSchema(collectedClassifications, inputSchema);
      }
    }
  });
  if (collectedClassifications.size !== 0) {
    attachCfcToOutputs(
      outputs,
      ContextualFlowControl.lub(collectedClassifications),
    );
  }
}

// Attach ifc confidentiality to Reactive objects reachable
// from the outputs without descending into Reactive objects
// TODO(@ubik2) Investigate: can we have cycles here?
function attachCfcToOutputs(
  outputs: unknown,
  lubConfidentiality: readonly CfcConfClause[],
) {
  if (isCell(outputs)) {
    const exported = exportCell(outputs);
    const outputSchema = exported.schema ?? true;
    // we may have fields in the output schema, so incorporate those
    const joined = new Set<unknown>(lubConfidentiality);
    ContextualFlowControl.joinSchema(joined, outputSchema);
    const ifc =
      (isObjectOrArray(outputSchema) && outputSchema.ifc !== undefined)
        ? { ...outputSchema.ifc }
        : {};
    ifc.confidentiality = ContextualFlowControl.lub(joined);
    const cfcSchema: JSONSchema = {
      ...ContextualFlowControl.toSchemaObj(outputSchema),
      ifc,
    };
    // The label reaches the cell through its link schema, which `setSchema`
    // takes only while the cell carries neither a cause nor a link. A cell
    // carrying either throws here, stopping the build.
    outputs.setSchema(cfcSchema);
    return;
  } else if (isObjectOrArray(outputs)) {
    // Descend into objects and arrays.
    //
    // A `FabricPrimitive` among them is inert here and correctly so: it has
    // zero enumerable own properties, so the descent ends at it, and a leaf
    // holds no cell to label.
    //
    // A `FabricInstance` is refused. Its codec contents can hold a `Cell`,
    // unreachable by property name, so passing one through leaves that cell
    // _unlabelled_ while its plain siblings are labeled -- confidentiality
    // silently not applied, which is the unsafe direction, unlike the
    // policy-input walks in `runner.ts` whose equivalent gap fails closed.
    //
    // Nothing reaches this in production today, de facto rather than by
    // construction: a `FabricError` is ungated and exposed to pattern authors,
    // so what keeps this safe is that no pattern yet returns one holding a
    // cell.
    //
    // TODO(danfuzz): descend by codec-mediated traversal into instance state,
    // at which point this becomes a walk rather than a refusal.
    if (outputs instanceof FabricInstance) {
      refuseFabricInstance(outputs, "when attaching CFC labels to outputs");
    }

    for (const [_, value] of Object.entries(outputs)) {
      attachCfcToOutputs(value, lubConfidentiality);
    }
  }
}
