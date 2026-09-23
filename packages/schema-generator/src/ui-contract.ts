import ts from "typescript";
import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { GenerationContext, UiContractHint } from "./interface.ts";

type EmittedUiContract = NonNullable<
  NonNullable<MutableJSONSchemaObj["ifc"]>["uiContract"]
>;

/**
 * Read the UI contract a caller attached to `typeNode`, falling back to the
 * node the current context is formatting. Synthetic nodes are looked up under
 * their original as well.
 */
export function getUiContractHint(
  context: GenerationContext,
  typeNode: ts.TypeNode | undefined = context.typeNode,
): UiContractHint | undefined {
  if (!context.schemaHints || !typeNode) {
    return undefined;
  }

  return context.schemaHints.get(typeNode)?.cfcUiContract ??
    context.schemaHints.get(ts.getOriginalNode(typeNode))?.cfcUiContract;
}

/** Emit `hint` under the schema's `ifc.uiContract`, replacing any prior one. */
export function attachUiContract(
  schema: MutableJSONSchema,
  hint: UiContractHint,
): MutableJSONSchema {
  // The hint belongs to the caller and the emitted schema is mutable, so the
  // integrity list is copied rather than aliased.
  const { requiredEventIntegrity, ...rest } = hint;
  const uiContract: EmittedUiContract = requiredEventIntegrity
    ? { ...rest, requiredEventIntegrity: [...requiredEventIntegrity] }
    : rest;

  if (typeof schema === "boolean") {
    return schema === false
      ? { not: true, ifc: { uiContract } }
      : { ifc: { uiContract } };
  }

  const existingIfc = isObjectOrArray(schema.ifc) ? schema.ifc : {};
  return {
    ...schema,
    ifc: {
      ...existingIfc,
      uiContract,
    },
  };
}
