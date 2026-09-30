/**
 * Durable reference schemas must enforce every scope cap retained by their
 * live acquisition. The link format carries schemas, but no inherited cap
 * positions, so a write refuses a projection that would lose that restriction.
 */

import type { JSONSchema } from "../builder/types.ts";
import { deepFrozenCloneAndInternSchema } from "@commonfabric/data-model-schema";
import {
  ContextualFlowControl,
  resolveExternalRootRefForStructure,
} from "../cfc.ts";
import type { ScopeCapAtDepth } from "../link-types.ts";
import { narrowerScopeCap } from "../scope.ts";

/** Encodes the narrowest retained follow cap in a generated durable schema. */
export function schemaWithRetainedReferenceScope(
  schema: JSONSchema | undefined,
  scopeCaps: readonly ScopeCapAtDepth[] | undefined,
): JSONSchema | undefined {
  const schemaCap = narrowerScopeCap(
    ContextualFlowControl.getSchemaScopeCap(schema),
    ContextualFlowControl.getAsCellFollowScopeCap(schema),
  );
  const retainedCap = scopeCaps?.reduce(
    (cap, retained) => narrowerScopeCap(cap, retained.scope),
    schemaCap,
  ) ?? schemaCap;
  if (retainedCap === schemaCap) return schema;
  const object = ContextualFlowControl.toSchemaObj(schema ?? true);
  const entries = ContextualFlowControl.getAsCellValues(
    resolveExternalRootRefForStructure(object),
  );
  const first = entries[0];
  return deepFrozenCloneAndInternSchema({
    ...object,
    scope: retainedCap,
    // The outer asCell entry takes precedence over the node's scope. Keep
    // that immediate follow boundary at the same retained restriction.
    ...(first === undefined ? {} : {
      asCell: [
        {
          ...(typeof first === "string" ? { kind: first } : first),
          scope: retainedCap,
        },
        ...entries.slice(1),
      ],
    }),
  });
}

/** Whether a durable link schema enforces every acquired follow cap. */
export function referenceScopeIsSerializable(
  schema: JSONSchema | undefined,
  scopeCaps: readonly ScopeCapAtDepth[] | undefined,
): boolean {
  const schemaCap = narrowerScopeCap(
    ContextualFlowControl.getSchemaScopeCap(schema),
    ContextualFlowControl.getAsCellFollowScopeCap(schema),
  );
  return !scopeCaps?.some(({ scope }) =>
    narrowerScopeCap(scope, schemaCap) !== schemaCap
  );
}

/** Refuses a durable link whose schema cannot retain its acquired scope caps. */
export function assertSerializableReferenceScope(
  schema: JSONSchema | undefined,
  scopeCaps: readonly ScopeCapAtDepth[] | undefined,
): void {
  if (!referenceScopeIsSerializable(schema, scopeCaps)) {
    throw new Error(
      "Reference acquisition scope cap cannot be widened for storage",
    );
  }
}
