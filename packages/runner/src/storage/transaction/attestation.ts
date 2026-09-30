import {
  type DebugValueOptions,
  FabricInstance,
  type FabricPlainObject,
  type FabricValue,
  isWalkableObjectOrArray,
  toCompactDebugString,
  toDebugKindString,
  valueEqual,
} from "@commonfabric/data-model";
import {
  extractDataUriPayloadText,
  isDataUriMediaType,
  isFabricDataUri,
  valueFromDataUriPayloadText,
} from "@commonfabric/data-model/codec-data-uri";
import { LRUCache } from "@commonfabric/utils/cache";
import { getLogger } from "@commonfabric/utils/logger";

import type {
  IAttestation,
  IInvalidDataURIError,
  IMemoryAddress,
  INotFoundError,
  ISpaceReplica,
  IStorageTransactionInconsistent,
  ITypeMismatchError,
  IUnsupportedMediaTypeError,
  MemoryAddressPathComponent,
  MemorySpace,
  Result,
  State,
} from "../interface.ts";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import { toTransactionDocumentValue } from "../v2-document.ts";

const logger = getLogger("attestation", {
  enabled: false,
  level: "debug",
});

const cacheHitLogger = getLogger("attestation-hit", {
  enabled: false,
  level: "debug",
});

/**
 * Cache for parsed data URIs to avoid redundant parsing.
 * Key format: `${address.id}::${address.type}`
 */
const dataURICache = new LRUCache<
  string,
  Result<IAttestation, IInvalidDataURIError | IUnsupportedMediaTypeError>
>({ capacity: 1000 });

export const InvalidDataURIError = (
  message: string,
  cause?: IInvalidDataURIError["cause"],
): IInvalidDataURIError => ({
  name: "InvalidDataURIError",
  message,
  cause,
  from(_space: MemorySpace) {
    return this;
  },
});

export const UnsupportedMediaTypeError = (
  message: string,
): IUnsupportedMediaTypeError => ({
  name: "UnsupportedMediaTypeError",
  message,
  from(_space: MemorySpace) {
    return this;
  },
});

/**
 * Reads requested `address` from the provided `source` attestation and either
 * succeeds with derived {@link IAttestation} with the given `address` or fails
 * with inconsistency error if resolving an `address` encounters a value it
 * cannot address by key along the path. A non-object is one such value; so is
 * a `FabricSpecialObject`, which holds its state behind no property name, and
 * which therefore stops a resolution the way a scalar does rather than
 * reporting the slot beneath it as absent. Note it will succeed with
 * `undefined` if last component of the path does not exist on the object.
 * Below are some examples illustrating read behavior
 *
 * ```ts
 * const address = {
 *   id: "test:1",
 *   type: "application/json",
 *   path: []
 * }
 * const value = { hello: "world", from: { user: { name: "Alice" } } }
 * const source = { address, value }
 *
 * read({ ...address, path: [] }, source)
 * // { ok: { address, value } }
 * read({ ...address, path: ['hello'] }, source)
 * // { ok: { address: { ...address, path: ['hello'] }, value: "hello" } }
 * read({ ...address, path: ['hello', 'length'] }, source)
 * // { ok: { address: { ...address, path: ['hello'] }, value: undefined } }
 * read({ ...address, path: ['hello', 0] }, source)
 * // { ok: { address: { ...address, path: ['hello', 0] }, value: undefined } }
 * read({ ...address, path: ['hello', 0, 0] }, source)
 * // { error }
 * read({ ...address, path: ['from', 'user'] }, source)
 * // { ok: { address: { ...address, path: ['from', 'user'] }, value: {name: "Alice"} } }
 *
 * const empty = { address, value: undefined }
 * read(address, empty)
 * // { ok: { address, value: undefined } }
 * read({ ...address, path: ['a'] }, empty)
 * // { error }
 * ```
 */
export const read = (
  source: IAttestation,
  address: IMemoryAddress,
): Result<
  IAttestation,
  IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
> => resolve(source, address);

/**
 * Takes a source {@link State} and derives an attestation describing it.
 */
export const attest = (
  { the, of, is, scope }: State & Pick<IMemoryAddress, "scope">,
): IAttestation => {
  return {
    address: { id: of, type: the, path: [], scope },
    value: is,
  };
};

/**
 * Verifies consistency of provided attestation with a given replica. If
 * current state matches provided attestation function succeeds with a state
 * of the address in the given replica otherwise function fails with
 * `IStorageTransactionInconsistent` error.
 *
 * Values are compared with `valueEqual()`.
 */
export const claim = (
  { address, value: expected }: IAttestation,
  replica: ISpaceReplica,
  // The reading transaction's scope-instance identity (server-execution v2
  // stage A — OW17's tx→replica seam): the claim re-reads the SAME instance
  // the load came from; absent = the replica's own, as before.
  identity?: ScopeKeyIdentity,
  durable = false,
): Result<State, IStorageTransactionInconsistent> => {
  const type = address.type ?? "application/json";
  const state = replica.get(address) ?? { the: type, of: address.id };
  const source = attest(state);
  const actual = type === "application/json" &&
      address.path.length === 0 &&
      typeof replica.getDocument === "function"
    ? toTransactionDocumentValue(
      durable && replica.getNonSpeculativeDocument
        ? replica.getNonSpeculativeDocument(
          address.id,
          address.scope,
          identity,
        )
        : replica.getDocument(address.id, address.scope, identity),
    )
    : read(source, address)?.ok?.value;

  if (valueEqual(expected, actual)) {
    return { ok: state };
  } else {
    return {
      error: StateInconsistency({ address, expected, actual }),
    };
  }
};

/**
 * Attempts to resolve given `address` from the `source` attestation. Function
 * succeeds with derived attestation that will have provided `address` or fails
 * with a not found error if the path doesn't exist, or a type mismatch error if
 * resolving an address encounters a value it cannot address by key along the
 * resolution path -- a non-object, or a `FabricSpecialObject`, whose state
 * sits behind no property name.
 */
export const resolve = (
  source: IAttestation,
  address: IMemoryAddress,
): Result<
  IAttestation,
  IStorageTransactionInconsistent | INotFoundError | ITypeMismatchError
> => {
  const { path } = address;
  let at = source.address.path.length - 1;
  let value = source.value;

  // If the source value is undefined (document doesn't exist), return NotFound
  if (source.value === undefined && path.length > source.address.path.length) {
    return {
      error: NotFound(
        source,
        address,
        // Return the source path (empty array for root). This is consistent with
        // how writes handle document-not-found. If source.address.path has content,
        // we slice off the last element since that's what points to undefined.
        source.address.path.length > 0 ? source.address.path.slice(0, -1) : [],
      ),
    };
  }

  while (++at < path.length) {
    const key = path[at];
    // A path reaching a `FabricInstance` reports the `TypeMismatchError` this
    // function is declared to return, so a caller handles it like every other
    // unresolvable address. The fetch builtins store a `FabricError` as a
    // result, and resolving a link whose path continues past one lands here.
    if (value instanceof FabricInstance) {
      return {
        error: TypeMismatchError(
          { ...address, path: path.slice(0, at + 1) },
          toDebugKindString(value),
          "read",
        ),
      };
    }
    // A `FabricPrimitive` takes the mismatch arm below alongside the scalars:
    // a path addresses nothing inside a leaf.
    if (isWalkableObjectOrArray(value)) {
      const record = value as FabricPlainObject;
      value = Object.hasOwn(record, key) ? record[key] : undefined;
    } else {
      // If the value is undefined, the path doesn't exist, but we can still
      // write onto it. Return error with last valid path component.
      if (value === undefined) {
        return {
          error: NotFound(source, address, path.slice(0, Math.max(0, at))),
        };
      }
      // Type mismatch - trying to access property on non-object.
      // `toDebugKindString` names the class, where `typeof` returns "object"
      // for every special object alike.
      const actualType = toDebugKindString(value);
      return {
        error: TypeMismatchError(
          { ...address, path: path.slice(0, at + 1) },
          actualType,
          "read",
        ),
      };
    }
  }

  return { ok: { value, address } };
};

/**
 * Loads an attestation from a data URI address. Parses the data URI content
 * and returns an attestation with the parsed value.
 * Results are cached to avoid redundant parsing of the same data URIs.
 */
export const load = (
  address: Omit<IMemoryAddress, "path">,
): Result<IAttestation, IInvalidDataURIError | IUnsupportedMediaTypeError> => {
  // Check cache first
  const cacheKey = address.id;
  const cached = dataURICache.get(cacheKey);
  if (cached) {
    cacheHitLogger.debug("cache-hit", "found cached result");
    return cached;
  }

  logger.debug("storage-datauri-parse", () => ["Parsing data URI"]);

  let result: Result<
    IAttestation,
    IInvalidDataURIError | IUnsupportedMediaTypeError
  >;

  try {
    if (!isFabricDataUri(address.id)) {
      result = {
        error: UnsupportedMediaTypeError(
          `Unsupported media type in data URI: ${address.id.slice(0, 64)}`,
        ),
      };
      dataURICache.put(cacheKey, result);
      return result;
    }

    const { mediaType, text } = extractDataUriPayloadText(address.id);

    if (isDataUriMediaType(mediaType)) {
      let value: FabricValue;
      try {
        // The payload encodes the cell VALUE; the document that the
        // address grammar resolves against (`["value", ...]`-rooted and
        // facet paths) is synthesized here, at the one reader that
        // thinks in documents. Synthesis also guarantees payload
        // content can never alias a document facet (`cfc`, `source`).
        value = Object.freeze({
          value: valueFromDataUriPayloadText(text),
        });
        result = { ok: { address: { ...address, path: [] }, value } };
      } catch (error) {
        const reason = error as Error;
        result = {
          error: InvalidDataURIError(
            `Failed to decode data URI payload: ${reason.message}`,
          ),
        };
      }
    } else {
      result = {
        error: UnsupportedMediaTypeError(
          `Unsupported media type ${mediaType}`,
        ),
      };
    }
  } catch (error) {
    const reason = error as Error;
    result = {
      error: InvalidDataURIError(
        `Invalid data URI: ${reason.message}`,
      ),
    };
  }

  dataURICache.put(cacheKey, result);

  return result;
};

/**
 * Creates a NotFoundError.
 *
 * @param source - The attestation that was being read from or written to
 * @param address - The full address that was attempted
 * @param path - Path to the non-existent key (includes the missing key).
 *   Consistent for both reads and writes. See INotFoundError docs.
 */
export const NotFound = (
  source: IAttestation,
  address: IMemoryAddress,
  path: readonly MemoryAddressPathComponent[],
): INotFoundError => {
  let message: string;

  // Document doesn't exist
  if (source.value === undefined && source.address.path.length === 0) {
    message = `Document not found: ${address.id}`;
  } // Path doesn't exist within document
  else {
    message = `Cannot access path [${address.path.join(", ")}] - ${
      source.value === undefined
        ? "document does not exist"
        : "path does not exist"
    }`;
  }

  return {
    name: "NotFoundError",
    message,
    source,
    address,
    path,
    from(_space: MemorySpace) {
      // Return the same error instance as it doesn't use space in the message
      return this;
    },
  };
};

export const TypeMismatchError = (
  address: IMemoryAddress,
  actualType: string,
  operation: "read" | "write",
): ITypeMismatchError => ({
  name: "TypeMismatchError",
  message: `Cannot ${operation} property at path [${
    address.path.join(", ")
  }] - expected object but found ${actualType}`,
  address,
  actualType,
  from(_space: MemorySpace) {
    // Return the same error instance as it doesn't use space in the message
    return this;
  },
});

/**
 * Rendering options for the two values an inconsistency message compares:
 * arrays, buffers, objects, and strings whole, so that a change past the
 * renderer's default limits shows as a difference rather than as two
 * identical renderings.
 */
const INCONSISTENCY_RENDER_OPTIONS: DebugValueOptions = {
  maxArrayLength: Infinity,
  maxBufferLength: Infinity,
  maxProperties: Infinity,
  maxStringLines: Infinity,
};

export const StateInconsistency = (source: {
  address: IMemoryAddress;
  expected?: FabricValue;
  actual?: FabricValue;
  space?: MemorySpace;
  emptyReactiveCommit?: true;
}): IStorageTransactionInconsistent => {
  const { address, space, expected, actual } = source;
  const message = [
    `Transaction consistency violated: The "${address.type}" of "${address.id}" at "${
      address.path.join(".")
    }"`,
    space ? ` in space "${space}"` : "",
    ` hash changed. Previously it used to be:\n `,
    toCompactDebugString(expected, INCONSISTENCY_RENDER_OPTIONS),
    "\n and currently it is:\n ",
    toCompactDebugString(actual, INCONSISTENCY_RENDER_OPTIONS),
  ].join("");

  return {
    name: "StorageTransactionInconsistent",
    message,
    address,
    ...(source.emptyReactiveCommit
      ? { emptyReactiveCommit: true as const }
      : {}),
    from(newSpace: MemorySpace) {
      return StateInconsistency({
        ...source,
        space: newSpace,
      });
    },
  };
};
