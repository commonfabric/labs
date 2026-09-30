import type { FabricValue, SchemaPathSelector } from "@commonfabric/api";
import type { DID, Signer as IdentitySigner } from "@commonfabric/identity";
import type { CellScope, ClientCommit } from "./v2.ts";

export type {
  AsBytes,
  AuthorizationError,
  DID,
  DIDKey,
  Principal,
  Signature,
  Verifier,
} from "@commonfabric/identity";

/**
 * The signing half of the principal contract as the memory protocol uses it:
 * an {@link IdentitySigner} without the `keyPair` accessor that hands back its
 * key material.
 */
export type Signer<ID extends DID = DID> = Omit<
  IdentitySigner<ID>,
  "keyPair"
>;

export type AsString<T> = string & {
  valueOf(): AsString<T>;
};

/**
 * Unique identifier for the memory space.
 */
export type MemorySpace = DID;

/**
 * Unique identifier for the mutable entity.
 */
export type Entity = URI;

/**
 * Media type of the value held at a memory address. Documents are
 * "application/json"; other media types address inline data payloads.
 */
export type The = MIME;

/**
 * The value a memory address holds. `is` is absent when the address holds
 * nothing, either because it was never written or because it was deleted.
 */
export type State = {
  /**
   * Media type of the value, usually "application/json".
   */
  the: MIME;

  /**
   * Stable memory identifier that uniquely identifies the entity.
   */
  of: URI;

  /**
   * The value itself, inline rather than by reference.
   */
  is?: FabricValue;
};

export type Revision<T = Unit> = T & { since: number };

export type ANYONE = "*";

export type ACLUser = DID | ANYONE;

/**
 * Capability levels for space access control.
 * - READ: Can query and read data from the space
 * - WRITE: Can read and transact (write) data to the space
 * - OWNER: Full control including ACL management
 */
export type Capability = "READ" | "WRITE" | "OWNER";

/**
 * Access Control List entry mapping DIDs to their capabilities
 */
export type ACL = {
  [user in ACLUser]?: Capability;
};

// Entity identifier (typically `of:<base32-digest>`, but sometimes `did:<something>`).
export type URI = `${string}:${string}`;
// Mime type or Media Type -- often called 'the'
export type MIME = `${string}/${string}`;

export type Unit = NonNullable<unknown>;

export type AsyncResult<T extends Unit = Unit, E extends Error = Error> =
  Promise<Result<T, E>>;

export type Await<T> = PromiseLike<T> | T;

export type AwaitResult<T extends Unit = Unit, E extends Error = Error> = Await<
  Result<T, E>
>;

export type Result<T extends Unit = Unit, E extends Error = Error> =
  | Ok<T>
  | Fail<E>;

export type Ok<T extends Unit> = {
  ok: T;

  /**
   * Discriminant to differentiate between Ok and Fail.
   */
  error?: undefined;
};

export type Fail<E extends Error> = {
  error: E;

  /**
   * Discriminant to differentiate between Ok and Fail.
   */
  ok?: undefined;
};

export type Conflict = {
  /**
   * Identifier of the replica where conflict occurred.
   */
  space: MemorySpace;

  /**
   * Media type of the value where a conflict occurred.
   */
  the: The;

  /**
   * Identifier of the entity where conflict occurred.
   */
  of: Entity;

  /** Scope of the conflicting instance; omitted by peers without scoped errors. */
  scope?: CellScope;
};

export interface ConflictError extends Error {
  name: "ConflictError";

  /** The commit that was rejected. */
  transaction: ClientCommit;

  conflict: Conflict;

  /** All known conflicts; `conflict` is the first for compatibility. */
  conflicts?: Conflict[];
  retryAfterSeq?: number;
  readyToRetry?: () => Promise<void>;
}

export interface SystemError extends Error {
  code: number;
}

export interface ConnectionError extends Error {
  name: "ConnectionError";
  cause: SystemError;
  address: string;
}

/**
 * Error from the underlying storage.
 */
export interface TransactionError extends Error {
  name: "TransactionError";
  cause: SystemError;

  /**
   * The commit being stored when the error occurred.
   */
  transaction: ClientCommit;
}

export interface QueryError extends Error {
  name: "QueryError";
  cause: SystemError;

  space: MemorySpace;
  selector: SchemaPathSelector;
}

/**
 * Utility type for defining a [keyed union] type as in IPLD Schema. In practice
 * this just works around typescript limitation that requires discriminant field
 * on all variants.
 *
 * ```ts
 * type Result<T, X> =
 *   | { ok: T }
 *   | { error: X }
 *
 * const demo = (result: Result<string, Error>) => {
 *   if (result.ok) {
 *   //  ^^^^^^^^^ Property 'ok' does not exist on type '{ error: Error; }`
 *   }
 * }
 * ```
 *
 * Using `Variant` type we can define same union type that works as expected:
 *
 * ```ts
 * type Result<T, X> = Variant<{
 *   ok: T
 *   error: X
 * }>
 *
 * const demo = (result: Result<string, Error>) => {
 *   if (result.ok) {
 *     result.ok.toUpperCase()
 *   }
 * }
 * ```
 *
 * [keyed union]:https://ipld.io/docs/schemas/features/representation-strategies/#union-keyed-representation
 */
export type Variant<U extends Record<string, unknown>> = {
  [Key in keyof U]:
    & { [K in Exclude<keyof U, Key>]?: never }
    & {
      [K in Key]: U[Key];
    };
}[keyof U];
