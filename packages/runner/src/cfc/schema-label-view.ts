import type { JSONSchema } from "@commonfabric/api";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  forEachSubschema,
  isSubschema,
} from "@commonfabric/data-model-schema/schema-walk";
import { ContextualFlowControl } from "../cfc.ts";
import { holdsClause, ifcConfidentialitySources } from "./input-join.ts";
import { isPrefix } from "./path-prefix-index.ts";
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
    const inputConfidentiality = ifcConfidentialitySources(resolved.ifc)
      .inputJoin;
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

/**
 * Whether `entry`, one of a schema's `entries`, holds nothing but its
 * producer's input join (`ifc.inputConfidentiality`), so that where the
 * runtime persists the measured label of what that producer writes
 * (`measured`) the declared component takes nothing from it: the measurement,
 * with whatever exchange rules released at the producer's observations (spec
 * §5.3), labels the value instead. Such an entry is no authored declaration,
 * so the store at its path is one §8.12.5 lets the runtime tighten to cover
 * what is written there.
 *
 * An entry that declares anything of its own — integrity, or a clause outside
 * the input join — keeps the whole of its label, as does one whose input join
 * holds a clause an entry at its path or above it declares: within the
 * declared component a more specific entry replaces its ancestors at every
 * read beneath it.
 */
export const leftToMeasurement = (
  entry: CfcSchemaEntry,
  entries: readonly CfcSchemaEntry[],
  measured: boolean,
): boolean => {
  const inputs = entry.inputConfidentiality;
  if (!measured || inputs === undefined || inputs.length === 0) return false;
  if ((entry.label.integrity?.length ?? 0) > 0) return false;
  const own = entry.label.confidentiality ?? [];
  if (!own.every((clause) => holdsClause(inputs, clause))) return false;
  return !entries.some((other) =>
    isPrefix(other.path, entry.path) &&
    (other.label.confidentiality ?? []).some((clause) =>
      !holdsClause(other.inputConfidentiality ?? [], clause) &&
      holdsClause(own, clause)
    )
  );
};

/**
 * The label `entry`, one of a schema's `entries`, persists as declared store
 * policy: nothing when it is {@link leftToMeasurement}, and otherwise the
 * whole of its label.
 */
export const persistedSchemaEntryLabel = (
  entry: CfcSchemaEntry,
  entries: readonly CfcSchemaEntry[],
  measured: boolean,
): IFCLabel => {
  if (!leftToMeasurement(entry, entries, measured)) return entry.label;
  const { confidentiality: _joined, ...rest } = entry.label;
  return rest;
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
