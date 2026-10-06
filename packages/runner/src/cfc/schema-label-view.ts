import type { JSONSchema } from "@commonfabric/api";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  forEachSubschema,
  isSubschema,
} from "@commonfabric/data-model-schema/schema-walk";
import { ContextualFlowControl } from "../cfc.ts";
import {
  cfcSchemaResolvedRoot,
  resolveCfcSchemaRefRoot,
} from "./schema-refs.ts";
import { type CfcLabelView, mergeCfcLabelViews } from "./label-view-state.ts";
import type { IFCLabel, LabelObservationClass } from "./types.ts";

/** One `ifc` declaration found while walking a CFC schema. */
export interface CfcSchemaEntry {
  readonly path: readonly string[];
  readonly label: IFCLabel;

  /**
   * The clauses of `label` only the producing module's input join put there
   * (`ifc.inputConfidentiality`); see {@link persistedSchemaEntryLabel}.
   */
  readonly inputConfidentiality?: readonly unknown[];

  readonly schema: JSONSchema;

  /** The schema document that resolves local references inside `.schema`. */
  readonly root: JSONSchema;

  /**
   * Set when the declaration sits inside an `anyOf` or `oneOf` branch, so it
   * holds only for the values that branch matches.
   */
  readonly conditional?: true;
}

interface IfcSchemaVisit {
  root: object;
  schema: object;
  parent?: IfcSchemaVisit;
}

/**
 * Return every `ifc` declaration in a schema at its logical value path.
 *
 * Compound schemas contribute at their current path. Array items and
 * record-only additional properties use a wildcard path. Tuple entries use
 * their concrete index. Negated schemas do not describe labels on real data.
 * A declaration reached through an `anyOf` or `oneOf` branch is marked
 * `conditional`.
 */
export const cfcSchemaEntries = (
  schema: JSONSchema,
  path: readonly string[] = [],
  entries: CfcSchemaEntry[] = [],
  root: JSONSchema = schema,
  active?: IfcSchemaVisit,
  conditional = false,
): CfcSchemaEntry[] => {
  if (!isSubschema(schema) || typeof schema === "boolean") {
    return entries;
  }
  const schemaRoot = root;
  const rootKey = isObjectOrArray(schemaRoot) ? schemaRoot : schema;
  for (let cursor = active; cursor !== undefined; cursor = cursor.parent) {
    if (cursor.root === rootKey && cursor.schema === schema) return entries;
  }
  const nextActive = { root: rootKey, schema, parent: active };

  const resolved = typeof schema.$ref === "string"
    ? ContextualFlowControl.resolveSchemaRefs(schema, schemaRoot) ?? schema
    : schema;
  if (typeof resolved === "boolean") {
    return entries;
  }

  // A ref that did not resolve leaves `resolved` as the schema itself, whose
  // own `$defs` is inert under the root it sits in.
  const childRoot = resolved !== schema
    ? cfcSchemaResolvedRoot(
      resolved,
      resolveCfcSchemaRefRoot(schema, schemaRoot),
    )
    : schemaRoot;
  if (isObjectOrArray(resolved.ifc)) {
    const inputConfidentiality = ContextualFlowControl.inputConfidentialityOnly(
      Array.isArray(resolved.ifc.inputConfidentiality)
        ? resolved.ifc.inputConfidentiality
        : [],
      [],
    );
    entries.push({
      path,
      label: {
        integrity: Array.isArray(resolved.ifc.integrity)
          ? [...resolved.ifc.integrity]
          : undefined,
        confidentiality: Array.isArray(resolved.ifc.confidentiality)
          ? [...resolved.ifc.confidentiality]
          : undefined,
      },
      ...(inputConfidentiality.length > 0 ? { inputConfidentiality } : {}),
      schema: resolved,
      root: childRoot,
      ...(conditional ? { conditional: true as const } : {}),
    });
  }

  const recordOnly = resolved.properties === undefined ||
    (isObjectOrArray(resolved.properties) &&
      Object.keys(resolved.properties).length === 0);
  const walk = (
    child: JSONSchema,
    childPath: readonly string[],
    childConditional = conditional,
  ) =>
    cfcSchemaEntries(
      child,
      childPath,
      entries,
      childRoot,
      nextActive,
      childConditional,
    );
  forEachSubschema(resolved, (child, keyword, key, index) => {
    switch (keyword) {
      case "properties":
        walk(child, [...path, key!]);
        break;
      case "anyOf":
      case "oneOf":
        walk(child, path, true);
        break;
      case "allOf":
        walk(child, path);
        break;
      case "items":
        // The wildcard covers tuple positions and the rest schema when
        // `.prefixItems` is present.
        walk(child, [...path, "*"]);
        break;
      case "prefixItems":
        walk(child, [...path, String(index!)]);
        break;
      case "additionalProperties":
        // A wildcard cannot express "all properties except the named ones".
        // It is exact only when the schema declares no named properties.
        if (recordOnly) {
          walk(child, [...path, "*"]);
        }
        break;
      case "not":
        // A negated schema does not describe declarations on real data.
        break;
      default:
        // Unknown structural keywords contribute at the current position.
        walk(child, path);
        break;
    }
  });
  return entries;
};

const declaredObservationClass = (
  schema: JSONSchema,
): LabelObservationClass | undefined => {
  const observes = isObjectOrArray(schema) && isObjectOrArray(schema.ifc)
    ? schema.ifc.observes
    : undefined;
  return observes === "value" || observes === "shape" ||
      observes === "enumerate" || observes === "followRef"
    ? observes
    : undefined;
};

/** Whether a declaration at `above` covers one at `path`. */
const coversDeclaration = (
  above: readonly string[],
  path: readonly string[],
): boolean =>
  above.length <= path.length &&
  above.every((segment, index) =>
    segment === path[index] || segment === "*" || path[index] === "*"
  );

/** The clauses of `entry` its schema declares, not an input join. */
const declaredConfidentiality = (entry: CfcSchemaEntry): readonly unknown[] => {
  const inputs = entry.inputConfidentiality ?? [];
  return (entry.label.confidentiality ?? []).filter((atom) =>
    !inputs.some((input) => deepEqual(input, atom))
  );
};

/**
 * The label `entry`, one of a schema's `entries`, persists as declared store
 * policy. Where the runtime persists the measured label of what a module
 * writes (`measured`), the clauses only that module's input join put in the
 * schema stand in for the measurement and are left out: the derived
 * component labels the value instead, with whatever exchange rules released
 * at the module's observations (spec §5.3). A clause the schema declares at
 * the entry's path or above it stays, since within the declared component a
 * more specific entry replaces its ancestors at every read beneath it.
 * Elsewhere the label is the schema's whole.
 */
export const persistedSchemaEntryLabel = (
  entry: CfcSchemaEntry,
  entries: readonly CfcSchemaEntry[],
  measured: boolean,
): IFCLabel => {
  const inputs = entry.inputConfidentiality;
  if (!measured || inputs === undefined || inputs.length === 0) {
    return entry.label;
  }
  const declaredAbove = entries
    .filter((other) => coversDeclaration(other.path, entry.path))
    .flatMap(declaredConfidentiality);
  const kept = (entry.label.confidentiality ?? []).filter((atom) =>
    !inputs.some((input) => deepEqual(input, atom)) ||
    declaredAbove.some((declared) => deepEqual(declared, atom))
  );
  const { confidentiality: _all, ...rest } = entry.label;
  return kept.length > 0 ? { ...rest, confidentiality: kept } : rest;
};

/** Return the label view declared by a schema. */
export const cfcLabelViewFromSchema = (
  schema: JSONSchema | undefined,
): CfcLabelView | undefined => {
  if (schema === undefined) return undefined;
  const entries = cfcSchemaEntries(schema).map((entry) => {
    const observes = declaredObservationClass(entry.schema);
    return {
      path: entry.path,
      label: entry.label,
      ...(observes === undefined ? {} : { observes }),
    };
  });
  return mergeCfcLabelViews([
    entries.length === 0 ? undefined : { version: 1, entries },
  ]);
};
