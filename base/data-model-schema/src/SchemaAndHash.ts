import type { JSONSchema } from "@commonfabric/api";

import { isDeepFrozen } from "@commonfabric/data-model";
import type { FabricHash } from "@commonfabric/data-model/fabric-primitives";

/**
 * Deep-frozen container pairing a `JSONSchema` with its content hash. Ensures
 * that schemas are always stored in their canonical deep-frozen form and that
 * the hash is computed once.
 *
 * To create instances, use `internSchema()` from `schema-intern.ts` — it handles
 * freezing, hashing, and caching. The constructor is public for direct use when
 * both the frozen schema and hash are already in hand.
 *
 * This class accepts `undefined` as its "schema" upon construction as a
 * concession to making the schema intern mechanism work straightforwardly with
 * `undefined`. However, in nearly every client use having `undefined` be a
 * possible value for `.schema` is undesirable, so that accessor `throw`s
 * instead of returning `undefined`. For the few cases where `undefined` is
 * acceptable, there is `.schemaOrUndefined`.
 */
export class SchemaAndHash {
  readonly #schema: JSONSchema | undefined;
  readonly #hash: FabricHash;

  /**
   * Constructs an instance, from an already-deep-frozen schema and its
   * pre-computed hash. Throws if the schema is not deep-frozen. Prefer
   * `internSchema()` from `schema-intern.ts` for the friendly entry point that
   * handles freezing, hashing, and interning.
   */
  constructor(schema: JSONSchema | undefined, hash: FabricHash) {
    if (!isDeepFrozen(schema)) {
      throw new Error("`SchemaAndHash`: schema must be deep-frozen");
    }
    this.#schema = schema;
    this.#hash = hash;
    Object.freeze(this);
  }

  /** The schema. */
  get schema(): JSONSchema {
    if (typeof this.#schema === "undefined") {
      throw new Error("`schema` is `undefined`.");
    }

    return this.#schema;
  }

  /**
   * The schema per se, or `undefined` if this instance was constructed with
   * `schema === undefined`.
   */
  get schemaOrUndefined(): JSONSchema | undefined {
    return this.#schema;
  }

  /** The content hash of the schema as a `FabricHash`. */
  get hash(): FabricHash {
    return this.#hash;
  }

  /**
   * The hash as a string. This is just a convenient shorthand for
   * `this.hash.taggedHashString`.
   */
  get taggedHashString(): string {
    return this.#hash.taggedHashString;
  }
}
