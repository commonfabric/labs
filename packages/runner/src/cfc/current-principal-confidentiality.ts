/** Binds reader-private declarations to the principal creating their store. */

import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { internSchema } from "@commonfabric/data-model-schema";
import {
  formatExternalSchemaRef,
  isExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import { mapSubschemas } from "@commonfabric/data-model-schema/schema-walk";
import { isDID } from "@commonfabric/identity/did";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../builder/types.ts";
import { registerSchemaDocument } from "../schema-registry.ts";
import { resolveExternalCfcSchemaRefAsDocument } from "./schema-refs.ts";

/** The supported creator-bound confidentiality declaration. */
export function isCurrentPrincipalUserClause(value: unknown): boolean {
  return isObjectNotArray(value) && value.type === CFC_ATOM_TYPE.User &&
    Object.keys(value).length === 2 && isObjectNotArray(value.subject) &&
    Object.keys(value.subject).length === 1 &&
    value.subject.__ctCurrentPrincipal === true;
}

/** Retains every concrete stored reader matching a creator-bound declaration. */
export function bindCurrentPrincipalToStoredClauses<Clause>(
  candidate: readonly Clause[],
  stored: readonly Clause[],
): readonly Clause[] {
  const users = stored.filter((clause) =>
    isObjectNotArray(clause) && clause.type === CFC_ATOM_TYPE.User &&
    Object.keys(clause).length === 2 && isDID(clause.subject)
  );
  return candidate.flatMap((clause) =>
    isCurrentPrincipalUserClause(clause) && users.length > 0 ? users : [clause]
  );
}

function hasCurrentPrincipal(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCurrentPrincipal);
  if (!isObjectNotArray(value)) return false;
  return value.__ctCurrentPrincipal === true ||
    Object.values(value).some(hasCurrentPrincipal);
}

/** Persists fresh User declarations concretely while retaining resolved policy. */
export function bindCurrentPrincipalConfidentiality(
  schema: JSONSchema,
  principal: string | undefined,
): JSONSchema {
  if (!isObjectNotArray(schema)) return schema;
  let result = schema;
  if (typeof schema.$ref === "string" && isExternalSchemaRef(schema.$ref)) {
    const document = resolveExternalCfcSchemaRefAsDocument(schema.$ref);
    if (document !== undefined) {
      const bound = bindCurrentPrincipalConfidentiality(document, principal);
      if (internSchema(bound) !== internSchema(document)) {
        const { taggedHashString } = internSchema(bound, true);
        registerSchemaDocument(taggedHashString, bound);
        result = { ...schema, $ref: formatExternalSchemaRef(taggedHashString) };
      }
    }
  }
  if (
    isObjectNotArray(schema.ifc) && Array.isArray(schema.ifc.confidentiality)
  ) {
    let changed = false;
    const confidentiality = schema.ifc.confidentiality.map((clause) => {
      if (!hasCurrentPrincipal(clause)) return clause;
      if (!isCurrentPrincipalUserClause(clause)) {
        throw new Error(
          "CurrentPrincipal confidentiality requires a User subject",
        );
      }
      if (!isDID(principal)) {
        throw new Error(
          "CurrentPrincipal confidentiality requires an authenticated creator",
        );
      }
      changed = true;
      return cfcAtom.user(principal);
    });
    if (changed) {
      result = { ...result, ifc: { ...schema.ifc, confidentiality } };
    }
  }
  return mapSubschemas(
    result,
    (child) => bindCurrentPrincipalConfidentiality(child, principal),
    { includeDefs: true, includeUnused: true, visitBooleans: true },
  );
}

/** Refuses persisted placeholders whose creating principal is not recorded. */
export function assertStoredPrincipalConfidentialityBound(
  schema: JSONSchema,
  labels: readonly { readonly confidentiality?: readonly unknown[] }[],
): void {
  const reason =
    "Stored CurrentPrincipal confidentiality requires explicit migration";
  if (labels.some((label) => hasCurrentPrincipal(label.confidentiality))) {
    throw new Error(reason);
  }
  try {
    // With no principal, the binder validates that every declaration is already
    // concrete. A stored placeholder cannot borrow the next writer's identity.
    bindCurrentPrincipalConfidentiality(schema, undefined);
  } catch {
    throw new Error(reason);
  }
}
