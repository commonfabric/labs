import { FabricInstance, refuseFabricInstance } from "@commonfabric/data-model";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { exportCell, isCell } from "../cell.ts";
import { ContextualFlowControl } from "../cfc.ts";
import type { CfcConfClause } from "../cfc/clause.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { getAuthoredDebugSource } from "../harness/authored-debug-source.ts";
import { REPLAYABLE_BUILTIN_REFS } from "./builtin-replayability.ts";
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
  // one attempt goes on to consume. For a module whose writes the runtime
  // measures (`measuresOutputs`) the join stands in for that measurement and
  // is named `ifc.inputConfidentiality` as well, which a runtime persisting
  // flow labels does not persist as declared policy: the measurement, with
  // its exchange-rule releases (CFC §5.3), labels what the module writes.
  // For any other module it is the floor: it mints a `declared` entry, and a
  // path's effective label is the join of all its components, so no later
  // measurement narrows it. `docs/specs/cfc-render-boundary-composition.md`
  // states the rest.
  applyInputIfcToOutput(
    node.inputs,
    node.outputs,
    measuresOutputs(node.module),
  );
}

/**
 * Whether the runtime measures what `module` writes against what it reads,
 * in the one transaction that does both: a JavaScript action, or a builtin
 * whose execution is a replayable derivation of its inputs
 * (`REPLAYABLE_BUILTIN_REFS`). A builtin that writes later, after a fetch or
 * a model call, is measured against nothing it was given.
 */
export function measuresOutputs(module: unknown): boolean {
  if (!isObjectOrArray(module)) return false;
  const { type, implementation } = module as {
    type?: unknown;
    implementation?: unknown;
  };
  return type === "javascript" ||
    (type === "ref" && typeof implementation === "string" &&
      REPLAYABLE_BUILTIN_REFS.has(implementation));
}

/**
 * `resultSchema` joined with the confidentiality `argumentSchema` declares.
 * When `measured`, the module's writes are measured (`measuresOutputs`), and
 * the joined clauses the result schema does not declare itself are also
 * named in `ifc.inputConfidentiality`.
 */
export function applyArgumentIfcToResult(
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
  measured = false,
): JSONSchema | undefined {
  if (argumentSchema !== undefined) {
    const joined = new Set<unknown>();
    ContextualFlowControl.joinSchema(joined, argumentSchema);
    return (joined.size !== 0)
      ? ContextualFlowControl.schemaWithLub(
        resultSchema ?? true,
        ContextualFlowControl.lub(joined),
        { fromInputs: measured },
      )
      : resultSchema;
  }
  return resultSchema;
}

/**
 * Carries the ifc tags of `inputs` through to `outputs`, as
 * `ifc.inputConfidentiality` too when `measured` (`measuresOutputs`).
 */
export function applyInputIfcToOutput<T, R>(
  inputs: FactoryInput<T>,
  outputs: FactoryInput<R>,
  measured = false,
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
      measured,
    );
  }
}

// Attach ifc confidentiality to Reactive objects reachable
// from the outputs without descending into Reactive objects
// TODO(@ubik2) Investigate: can we have cycles here?
function attachCfcToOutputs(
  outputs: unknown,
  lubConfidentiality: readonly CfcConfClause[],
  measured: boolean,
) {
  if (isCell(outputs)) {
    const exported = exportCell(outputs);
    const outputSchema = exported.schema ?? true;
    // we may have fields in the output schema, so incorporate those
    const joined = new Set<unknown>(lubConfidentiality);
    ContextualFlowControl.joinSchema(joined, outputSchema);
    // What the output schema declares anywhere, its own input join aside,
    // stays declared; only the rest of the inputs' join stands in for the
    // measurement.
    const ownIfc = isObjectOrArray(outputSchema) ? outputSchema.ifc : undefined;
    const ownInputs = ContextualFlowControl.uniqueAtoms(
      ownIfc?.inputConfidentiality ?? [],
    );
    const fromInputs = new Set<unknown>([
      ...(measured ? lubConfidentiality : []),
      ...ownInputs,
    ]);
    const declared = new Set<unknown>(measured ? [] : lubConfidentiality);
    for (
      const atom of ContextualFlowControl.joinSchema(new Set(), outputSchema)
    ) {
      if (!ownInputs.some((input) => deepEqual(input, atom))) {
        declared.add(atom);
      }
    }
    const ifc = ContextualFlowControl.withConfidentiality(
      ownIfc,
      ContextualFlowControl.lub(joined),
      ContextualFlowControl.inputConfidentialityOnly(fromInputs, declared),
    );
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
      attachCfcToOutputs(value, lubConfidentiality, measured);
    }
  }
}
