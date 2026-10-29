/**
 * The derivation behind `cf piece describe`: a piece's documentation, built
 * from the two schemas its compiled pattern already carries.
 *
 * Everything here is pure. Loading the piece and its pattern is
 * `describePiece` (`piece.ts`), which shares one load with the verbs listing;
 * rendering is `pieceDescribeLines` / `pieceDescribeJson`
 * (`../commands/piece.ts`). This module only decides what the page SAYS.
 *
 * The sources, and why each line can exist at all:
 *
 * - The PURPOSE is the doc comment on the pattern's result (Output)
 *   interface, which the schema generator attaches to the result schema's
 *   root as its `description`. That is the one compiled home a pattern's own
 *   prose has — a module-level comment is stripped at emit and survives only
 *   in the stored source.
 * - A STATE field is a declared result property that is not callable: its
 *   prose is the field's own doc comment, compiled verbatim onto the
 *   property.
 * - An INPUT is an argument-schema property: what a caller supplies, where
 *   state is what only the pattern's verbs change. The page keeps the two
 *   apart because that split is the piece's usage model.
 * - A VERB row is the callable listing's row, unchanged — one classification
 *   for `describe`, `verbs`, and `call`, so the three can never disagree
 *   about what is callable.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { PiecePatternRef } from "@commonfabric/piece/ops";
import {
  cfcSchemaResolvedRoot,
  resolveCfcSchemaRefs,
} from "@commonfabric/runner/cfc";
import type { PieceCallableListing } from "@commonfabric/piece/verb-listing";
import { isObjectOrArray, isPlainObject } from "@commonfabric/utils/types";

import type { PieceCallablesListing } from "./piece.ts";

/** One documented data field: a state field of the declared result, or a
 * caller-supplied input. */
export interface PieceFieldDescription {
  name: string;

  /** A compact label for the declared type: a named type keeps its name
   * (`ItemOutput`), an array is its element's label suffixed `[]`, a union
   * joins its members with ` | `. See `schemaTypeLabel`. */
  type: string;

  /** Present, and true, only on an input the argument schema requires. */
  required?: boolean;

  /** The author's doc comment on the field, verbatim. */
  description?: string;
}

/** `cf piece describe` output: the piece's documentation, assembled from the
 * author's own TypeScript. */
export interface PieceDescription {
  /** The piece's display name — its NAME cell. Advisory the way the pattern
   * identity is: absent when the piece is unnamed or the cell unreadable. */
  name?: string;

  pattern: PiecePatternRef | null;

  /** What the pattern is FOR: the result schema's root description. */
  purpose?: string;

  /** Pattern-owned state, in declaration order — the author ordered these
   * fields, and that order is part of the documentation. Absent (never
   * empty-by-default) when the compiled pattern could not be read, so a
   * missing section cannot be mistaken for a pattern that declares none. */
  state?: PieceFieldDescription[];

  /** Caller-supplied inputs, in declaration order. Absent on the same terms
   * as `state`. */
  inputs?: PieceFieldDescription[];

  /** The callable surface, exactly as `listPieceCallables` returned it. */
  verbs: PieceCallableListing[];

  incomplete?: "pattern-unavailable";
}

/** The declared schema with a root `$ref` followed, paired with the root its
 * own references resolve against — the same two-step `declaredVerbProse`
 * performs, for the same reason: a created piece's result compiles to
 * `{$ref: "#/$defs/T", $defs: {…}}`, and reading `properties` or
 * `description` off that root without resolving finds neither. */
function resolveDeclaredRoot(
  schema: unknown,
): { declared: Record<string, unknown>; root: JSONSchema } | undefined {
  if (!isObjectOrArray(schema)) return undefined;
  const declared = typeof schema.$ref === "string"
    ? resolveCfcSchemaRefs(schema, schema as JSONSchema)
    : schema;
  if (!isObjectOrArray(declared)) return undefined;
  return {
    declared,
    root: typeof schema.$ref === "string"
      ? cfcSchemaResolvedRoot(declared as JSONSchema, schema as JSONSchema)
      : schema as JSONSchema,
  };
}

/** Whether a declared result property is verb-shaped on its face: the
 * generator marks a `Stream` property `asCell: ["stream", …]`. A second gate
 * beside the listing's names, for the piece whose store no longer classifies
 * a declared verb — that name must fall out of the state section, not join it
 * with an event type for a shape. */
function isStreamMarked(property: Record<string, unknown>): boolean {
  return Array.isArray(property.asCell) && property.asCell.includes("stream");
}

const ANONYMOUS_DEF_PREFIX = "Anonymous";

function refDefinitionName(ref: string): string | undefined {
  const match = ref.match(/#\/\$defs\/([^/]+)$/);
  return match?.[1];
}

/**
 * A compact, TypeScript-flavored label for a declared type, for the one place
 * a whole schema does not fit: the field column of a documentation page.
 *
 * A named definition is its name and nothing more — `ItemOutput`, not its
 * properties — which is what keeps the label finite over the self-referential
 * types patterns actually declare. Only the generator's `Anonymous…`
 * definitions are read through, because their names say nothing; a cycle
 * among those alone would be a definition naming itself, and the `seen` guard
 * (keyed on the `$ref` string, whose identity is stable where a resolved
 * schema object's is not) stops the walk there.
 *
 * The label is documentation, not a contract: `--json` carries the schemas
 * themselves, and nothing validates against a label.
 */
export function schemaTypeLabel(schema: unknown, root: JSONSchema): string {
  return typeLabel(schema, root, new Set());
}

function typeLabel(
  schema: unknown,
  root: JSONSchema,
  seen: ReadonlySet<string>,
): string {
  if (schema === true) return "unknown";
  if (!isObjectOrArray(schema)) return "unknown";
  if (typeof schema.$ref === "string") {
    const name = refDefinitionName(schema.$ref);
    if (name === undefined) return "unknown";
    if (!name.startsWith(ANONYMOUS_DEF_PREFIX)) return name;
    if (seen.has(schema.$ref)) return name;
    const resolved = resolveCfcSchemaRefs(schema, root);
    return typeLabel(resolved, root, new Set([...seen, schema.$ref]));
  }
  const arms = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(arms)) {
    const labels = arms.map((arm) => typeLabel(arm, root, seen));
    return [...new Set(labels)].join(" | ");
  }
  if (schema.type === "array" || schema.items !== undefined) {
    const element = typeLabel(schema.items, root, seen);
    return element.includes(" | ") ? `(${element})[]` : `${element}[]`;
  }
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  if (isObjectOrArray(schema.properties)) return "object";
  return "unknown";
}

/** The documented fields of one declared object schema, in declaration
 * order. `skip` names the properties that are not data at this position —
 * callables on a result, the `$`-prefixed runtime slots on either.
 * `markRequired` is true only for inputs: required-ness is a statement about
 * what a CALLER must supply, and a result's `required` array marks fields the
 * pattern itself owns, which is not that statement. */
function fieldDescriptions(
  declared: Record<string, unknown>,
  root: JSONSchema,
  markRequired: boolean,
  skip: (name: string, property: Record<string, unknown>) => boolean,
): PieceFieldDescription[] {
  // A plain object only: `properties` as an array is not a schema shape, and
  // entries over one would document its indices as fields.
  if (!isPlainObject(declared.properties)) return [];
  const required = new Set(
    markRequired && Array.isArray(declared.required) ? declared.required : [],
  );
  const fields: PieceFieldDescription[] = [];
  for (const [name, property] of Object.entries(declared.properties)) {
    if (name.startsWith("$")) continue;
    if (!isObjectOrArray(property)) continue;
    if (skip(name, property)) continue;
    fields.push({
      name,
      type: schemaTypeLabel(property, root),
      ...(required.has(name) ? { required: true } : {}),
      ...(typeof property.description === "string"
        ? { description: property.description }
        : {}),
    });
  }
  return fields;
}

/**
 * The description, from parts a single piece load already produced: the NAME
 * cell's value, the callable listing, and the compiled pattern the listing
 * consulted. `compiled` is null exactly when the listing reported itself
 * incomplete — the two halves degrade together, so a page can never document
 * state it could not read beside verbs it could.
 */
export function buildPieceDescription(parts: {
  name?: string;
  listing: PieceCallablesListing;
  compiled: { argumentSchema?: unknown; resultSchema?: unknown } | null;
}): PieceDescription {
  const { name, listing, compiled } = parts;
  const base: PieceDescription = {
    ...(name !== undefined ? { name } : {}),
    pattern: listing.pattern,
    verbs: listing.verbs,
    ...(listing.incomplete !== undefined
      ? { incomplete: listing.incomplete }
      : {}),
  };
  if (compiled === null) return base;

  const callableNames = new Set(listing.verbs.map((verb) => verb.name));
  const result = resolveDeclaredRoot(compiled.resultSchema);
  const argument = resolveDeclaredRoot(compiled.argumentSchema);
  const purpose = result !== undefined &&
      typeof result.declared.description === "string"
    ? result.declared.description
    : undefined;
  return {
    ...(base.name !== undefined ? { name: base.name } : {}),
    pattern: base.pattern,
    ...(purpose !== undefined ? { purpose } : {}),
    state: result === undefined ? [] : fieldDescriptions(
      result.declared,
      result.root,
      false,
      (fieldName, property) =>
        callableNames.has(fieldName) || isStreamMarked(property),
    ),
    inputs: argument === undefined
      ? []
      : fieldDescriptions(argument.declared, argument.root, true, () => false),
    verbs: base.verbs,
    ...(base.incomplete !== undefined ? { incomplete: base.incomplete } : {}),
  };
}
