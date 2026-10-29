/**
 * This module is the package's public surface: the runtime machinery for the
 * JSON Schema dialect the fabric uses. Interning and content-hashing a schema,
 * deriving one from a value, rewriting one, and interning the path selectors
 * that pair a schema with a location in a document.
 *
 * The declarations these operate on -- `JSONSchema` and its family -- belong to
 * `@commonfabric/api`, and nothing here re-exports them.
 */

export { SchemaAndHash } from "./SchemaAndHash.ts";

export { hashSchema } from "./hashSchema.ts";

export {
  deepFrozenCloneAndInternSchema,
  findInternedSchema,
  internSchema,
  internSchemaAsTaggedHashString,
  internSchemaPairAsKey,
  isInternedSchema,
} from "./schema-intern.ts";

export {
  DEFAULT_SELECTOR,
  internPathSelector,
  REJECTING_SELECTOR,
} from "./path-selector.ts";

export { emptySchemaObject, schemaForValueType } from "./basic-schemas.ts";

export { isNontrivialSchema } from "./isNontrivialSchema.ts";

export {
  schemaWithoutProperties,
  schemaWithProperties,
} from "./schema-rewrite.ts";

export { cloneSchemaMutable, toDeepFrozenSchema } from "./schema-copy.ts";
