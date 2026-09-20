/**
 * The `LlmDerived` provenance stamp a builtin puts on the model output it
 * writes back, and the schema forms that carry it.
 *
 * `LlmDerived` is a runtime-minted evidence family: the persist-time gate
 * (`gateRuntimeMintedIntegrity`, audit S4) admits it only from a write whose
 * implementation identity is a builtin, which is what stops pattern code
 * from forging it. A writer therefore pairs one of these schemas with
 * `tx.setCfcImplementationIdentity({ kind: "builtin", builtinId })` on the
 * transaction that writes the model bytes, and applies the stamp at that
 * write rather than on a shared result schema, so a builtin's control-state
 * writes stay CFC-inert.
 *
 * The llm builtins and the harness's agent result writer are the writers.
 * The two forms serve the two write shapes: a whole field written at one
 * path, and an object written through a caller's schema whose parts may
 * split into documents of their own.
 */

import type { JSONSchema } from "@commonfabric/api";
import { cfcAtom } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model-schema";
import { mapSubschemas } from "@commonfabric/data-model-schema/schema-walk";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchemaObj } from "../builder/types.ts";

/**
 * The stamp for a whole model-output field written at one path: an `llm` or
 * `generateText` result, or a streaming `partial`.
 */
export const LLM_DERIVED_RESULT_STAMP_SCHEMA = internSchema(
  { ifc: { addIntegrity: [cfcAtom.llmDerived()] } } as JSONSchema,
);

/** Merges `LlmDerived` into one schema node's `ifc.addIntegrity`, idempotently. */
const mergeLlmDerivedIntoNode = (
  node: Record<string, unknown>,
): Record<string, unknown> => {
  const ifc = isObjectOrArray(node.ifc) ? node.ifc : {};
  const addIntegrity = Array.isArray(ifc.addIntegrity) ? ifc.addIntegrity : [];
  const stamp = cfcAtom.llmDerived();
  const already = addIntegrity.some((atom) =>
    isObjectOrArray(atom) && isObjectOrArray(stamp) && atom.type === stamp.type
  );
  return {
    ...node,
    ifc: {
      ...ifc,
      addIntegrity: already ? addIntegrity : [...addIntegrity, stamp],
    },
  };
};

/**
 * `schema` with the `LlmDerived` stamp merged into every object subschema:
 * properties, additional properties, items and prefix items, compound
 * branches, and `$defs` targets. A model-output object written through a
 * caller's schema can split into child documents — an `asCell` field, an
 * ID-anchored array item — and the child write descends through
 * `ContextualFlowControl.getSchemaAtPath`, which carries ancestor
 * confidentiality but not `ifc.addIntegrity`. Stamping every node keeps the
 * mark on whichever document the model bytes land in, so `walkIfcSchema`
 * mints the `LlmDerived` entry on a split child too. The shared walker's
 * whole vocabulary is stamped, including keywords the generators do not emit:
 * this runs once per model result, and completeness here costs nothing
 * noticeable while preserving provenance if more keywords become
 * storage-addressable.
 *
 * The merge is idempotent, so a schema already carrying the stamp on a node
 * is left as it is. The recursion follows the finite, acyclic JSON-Schema
 * tree — `$ref` is a string this does not dereference, so a recursive `$defs`
 * self-reference is a leaf — and the result is interned. An absent schema
 * defaults to a plain object schema.
 */
export const withLlmDerivedStamp = (
  schema: JSONSchema | undefined,
): JSONSchema => {
  const stampNode = (node: Record<string, unknown>): JSONSchema =>
    mapSubschemas(
      mergeLlmDerivedIntoNode(node) as JSONSchemaObj,
      (child) => (isObjectOrArray(child) ? stampNode(child) : child),
      { includeDefs: true, includeUnused: true },
    );

  const base: Record<string, unknown> = isObjectOrArray(schema)
    ? schema
    : { type: "object" };
  return internSchema(stampNode(base));
};
