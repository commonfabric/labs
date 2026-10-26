import {
  deepFrozenCloneAndInternSchema,
  hashSchema,
  internSchema,
} from "@commonfabric/data-model-schema";
import { LRUCache } from "@commonfabric/utils/cache";
import { type JSONSchema, UI } from "../builder/types.ts";
import { snapshotQueryResult } from "../query-result-proxy.ts";
import { isCellScope } from "../scope.ts";

// asCell-wrapped schemas keyed by content hash. `hashSchema()` is the cache
// key: it is `FabricValue`-aware, so schemas that differ only in non-JSON
// `FabricValue` content (e.g. a `FabricBytes` default) get distinct keys — a
// `JSON.stringify()` key would collide them. The clone-and-intern repeats for
// the same content on every wish send, so cache it.
const schemaAsCellCache = new LRUCache<string, JSONSchema>({ capacity: 256 });

function schemaAsCell(schema: unknown): JSONSchema {
  if (schema === false) return false;
  if (schema && typeof schema === "object") {
    // A requested schema arrives as a query-result view of the wish's input.
    // One walk detaches it, keeping `FabricValue` leaves that a JSON
    // round-trip would mangle, and the hash and the clone both read the copy.
    const objectSchema = snapshotQueryResult(schema) as Exclude<
      JSONSchema,
      boolean
    >;
    const key = hashSchema(objectSchema);
    let result = schemaAsCellCache.get(key);
    if (result === undefined) {
      result = deepFrozenCloneAndInternSchema({
        ...objectSchema,
        asCell: objectSchema.asCell ?? ["cell"],
      });
      schemaAsCellCache.put(key, result);
    }
    return result;
  }
  return { asCell: ["cell"] };
}

/**
 * Wraps the requested resource schema in the wish output contract: `result`
 * and `candidates` under the requested schema, `error` as written, and `[UI]`
 * as a handle to the view the wish shows, which declares nothing about the
 * view itself.
 */
export function wishStateSchemaForResult(
  schema: unknown,
): JSONSchema | undefined {
  if (schema === undefined) return undefined;
  const resultSchema = schemaAsCell(schema);
  // Fragment references resolve from the wish-state schema root after the
  // requested schema is nested under result and candidates.
  const schemaWithDefinitions =
    (typeof resultSchema === "object" ? resultSchema : {}) as
      & Record<string, unknown>
      & {
        $defs?: Record<string, JSONSchema>;
      };
  // The requested scope selects the state instance. Candidate references keep
  // their source scope instead of allocating a scoped copy of the provider.
  const { $defs, scope: stateScope, ...nestedSchemaObject } =
    schemaWithDefinitions;
  const nestedResultSchema = resultSchema === false
    ? false
    : nestedSchemaObject as JSONSchema;
  const candidateSchema = nestedResultSchema;
  return internSchema({
    ...($defs === undefined ? {} : { $defs }),
    ...(isCellScope(stateScope) ? { scope: stateScope } : {}),
    type: "object",
    properties: {
      result: {
        anyOf: [
          { type: "undefined" },
          nestedResultSchema,
        ],
      },
      candidates: {
        type: "array",
        items: candidateSchema,
      },
      error: true,
      // An opaque handle with no value shape, which a read under this schema
      // hands on without following, and which a pre-sync of the state does
      // not load the target of. Every reader of a wish reads its state under
      // this schema, and most use `result` alone: a value shape declared here
      // is one each of them follows into the found piece's view, loading it.
      // A reader that shows the view reads it through the handle, under a
      // schema of its own.
      [UI]: { type: "unknown", asCell: ["opaque"] },
    },
    required: ["result", "candidates"],
  });
}
