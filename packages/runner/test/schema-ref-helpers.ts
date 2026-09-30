/**
 * Expectation helpers for schemas that ride as content-addressed references
 * (`docs/specs/content-addressed-schemas.md`) under the
 * `contentAddressedSchemas` default. A reference is the at-rest form; a
 * structural expectation compares the recomposed closure — decomposition's
 * documented inverse, equivalent to the sanitized input the writer was
 * handed. The link or binding carrying the reference is never rewritten;
 * consumers resolve at their point of use.
 */

import type { JSONSchemaObj } from "@commonfabric/api";

import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import {
  isExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../src/builder/types.ts";
import { recomposeSchema } from "../src/schema-decompose.ts";
import { lookupSchemaDocument } from "../src/schema-registry.ts";

/** The recomposed closure behind a reference-form schema; others as-is. */
export const resolvedSchema = (
  schema: JSONSchema | undefined,
): JSONSchema | undefined => {
  if (!isObjectNotArray(schema)) return schema;
  const ref = (schema as JSONSchemaObj).$ref;
  return typeof ref === "string" && isExternalSchemaRef(ref)
    ? recomposeSchema(ref, lookupSchemaDocument)
    : schema;
};

/** The reference a leaf schema (no references of its own) emits as. */
export const externalRefTo = (schema: JSONSchema): JSONSchemaObj => ({
  $ref: `cid:${internSchemaAsTaggedHashString(schema)}`,
});
