/**
 * Mints reviewed intents for the trusted host's reviewed-intent surface. A
 * reviewed intent is a create-only record, written under this module's builtin
 * identity, stating that the authenticated actor released exactly these
 * parameters to exactly these destinations, recently, once. An application
 * that acts outside the fabric on the actor's behalf (the consumer) publishes
 * a descriptor of what it accepts; the host previews the destinations the
 * pattern binds against it, and a trusted gesture on the host's surface
 * commits the record. This module is absent from authored pattern imports.
 *
 * The record is what a consumer acts on, and {@link verifyReviewedIntentRecord}
 * is how it tells a record this module wrote from one a pattern wrote. The
 * rest of the contract, the consumer's half included, is
 * `docs/specs/cfc-reviewed-intent.md`.
 */

import type { JSONValue } from "@commonfabric/api";
import type { CfcAtom } from "@commonfabric/api/cfc";

import type { Cell } from "../cell.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { AtomPattern } from "./atom-pattern.ts";

/** Builtin implementation identity that alone writes reviewed intents. */
export const REVIEWED_INTENT_WRITER = "cfc-reviewed-intent";

/** The `provenance.ui.pattern` mark of the host's commit gesture. */
export const REVIEWED_INTENT_GESTURE = "ReviewedIntent";

/** The host surface a record names as its evidence. */
export const REVIEWED_INTENT_COMPONENT = "cf-reviewed-intent";

/**
 * The longest a reviewed intent stays good for, whatever its descriptor asks:
 * ten minutes, the short-intent window ruled by @seefeldb.
 */
export const SHORT_INTENT_WINDOW_MS = 10 * 60 * 1000;

/** A declared parameter whose value is one or more bound destinations. */
export interface ReviewedIntentDestinationsParameter {
  readonly kind: "destinations";

  /** Fewest destinations a record carries for this key. */
  readonly min: number;

  /** Most destinations a record carries for this key; at least 1. */
  readonly max: number;
}

/** A declared parameter whose value is text the actor enters on the surface. */
export interface ReviewedIntentTextParameter {
  readonly kind: "text";

  /** Most Unicode code points the text holds, as JSON Schema counts them. */
  readonly maxLength: number;
}

/** One declared parameter of a descriptor. */
export type ReviewedIntentParameter =
  | ReviewedIntentDestinationsParameter
  | ReviewedIntentTextParameter;

/**
 * What a consumer accepts, published by the consumer in a cell the host
 * reads. A record names its descriptor by digest (`endpoint`), so a consumer
 * acts only on records reviewed against the descriptor it publishes. Every
 * member is required and no other is accepted, at any level: a member this
 * build does not know could be a limit it would fail to enforce, so a
 * descriptor carrying one is refused rather than read without it.
 */
export interface ReviewedIntentDescriptor {
  /** What a record authorizes, such as `send-message`. */
  readonly operation: string;

  /** The name the surface shows the actor as the way the intent is carried. */
  readonly endpointName: string;

  /** The consumer that acts on records. */
  readonly consumer: string;

  /** The only parameter keys a record carries, each with its kind. */
  readonly parameters: Readonly<Record<string, ReviewedIntentParameter>>;

  /**
   * Atom patterns every destination's stored integrity must satisfy together,
   * as one conjunction with shared variables. Nonempty when any parameter is
   * of kind `destinations`.
   */
  readonly destinationIntegrity: readonly AtomPattern[];

  /**
   * How long after the gesture a record is good for, in milliseconds. A record
   * takes the smaller of this and {@link SHORT_INTENT_WINDOW_MS}.
   */
  readonly windowMs: number;

  /** How many delivery attempts a consumer may make on one record. */
  readonly maxAttempts: number;
}

/** A destination as reviewed: its stored value and the integrity it carries. */
export interface ReviewedDestination {
  /** The destination cell's stored value, exactly as the surface shows it. */
  readonly address: JSONValue;

  /** The atoms of the destination's stored integrity the descriptor names. */
  readonly integrity: readonly CfcAtom[];
}

/** The cells a pattern binds for one reviewed intent. */
export interface ReviewedIntentBindings {
  /** The consumer's published descriptor. */
  readonly descriptor: Cell<unknown>;

  /**
   * The destination cells for each declared `destinations` parameter, in the
   * order the record lists them.
   */
  readonly destinations: Readonly<Record<string, readonly Cell<unknown>[]>>;

  /**
   * The pattern's cell that receives a link to the committed record. Its write
   * target is reviewed with the rest, and the link is written without this
   * module's identity, so a target in a document that admits only this
   * module's writes refuses it.
   */
  readonly result: Cell<unknown>;
}

/** Type-only brand for host-held consent objects. */
declare const consentBrand: unique symbol;

/** One-use commit authority held only by the trusted host. */
export interface ReviewedIntentConsent {
  /** Nominal token whose identity is verified against a private registry. */
  readonly [consentBrand]: true;
}

/** Frozen preview for the trusted host's surface. */
export interface PreparedReviewedIntent {
  /** The authenticated actor the record names as its subject. */
  readonly actor: string;

  /** The descriptor's `operation`. */
  readonly operation: string;

  /** The descriptor's `endpointName`. */
  readonly endpointName: string;

  /** The descriptor's `consumer`. */
  readonly consumer: string;

  /** The descriptor's digest, which the record carries as `endpoint`. */
  readonly endpoint: string;

  /** Every `destinations` parameter, as the record carries it. */
  readonly destinations: Readonly<
    Record<string, readonly ReviewedDestination[]>
  >;

  /** Every `text` parameter, for the field the surface draws for it. */
  readonly text: Readonly<Record<string, { readonly maxLength: number }>>;

  /** How long after the gesture the record is good for, in milliseconds. */
  readonly windowMs: number;

  /** The descriptor's `maxAttempts`. */
  readonly maxAttempts: number;

  /** One-use authority bound to this preview and the authenticated actor. */
  readonly consent: ReviewedIntentConsent;
}

/** What the actor entered on the surface, given to the commit. */
export interface ReviewedIntentInput {
  /** The text of every declared `text` parameter, and nothing else. */
  readonly text: Readonly<Record<string, string>>;
}

/**
 * The record a commit writes, as a consumer that verified it acts on it.
 */
export interface ReviewedIntentRecord {
  /** The descriptor's `operation`. */
  readonly operation: string;

  /** The digest of the descriptor the actor reviewed against. */
  readonly endpoint: string;

  /** The descriptor's `consumer`. */
  readonly consumer: string;

  /** The actor who made the gesture; the record lives in their home space. */
  readonly subject: string;

  /**
   * Every declared parameter: a `destinations` parameter as its reviewed
   * destinations, a `text` parameter as the text entered.
   *
   * The stored record holds this as its JSON text with sorted keys, a leaf,
   * and {@link verifyReviewedIntentRecord} returns it parsed. The runtime
   * stores an object inside an array as a document of its own, which the
   * record's root stamp would not cover; a leaf keeps every parameter inside
   * the one document the stamp vouches for.
   */
  readonly parameters: Readonly<
    Record<string, string | readonly ReviewedDestination[]>
  >;

  /** The data-model digest of `parameters`. */
  readonly payloadDigest: string;

  /** Unique to the consent; what a consumer keys its delivery attempts on. */
  readonly idempotencyKey: string;

  /** When the commit wrote the record, in milliseconds since the epoch. */
  readonly at: number;

  /** When the record stops being good, in milliseconds since the epoch. */
  readonly exp: number;

  /** The descriptor's `maxAttempts`. */
  readonly maxAttempts: number;

  /** The surface and the host event the gesture was made on. */
  readonly evidence: {
    readonly component: string;
    readonly event: string;
  };
}

/** What a commit wrote. */
export interface ReviewedIntentResult {
  /** The record, in the actor's home space. */
  readonly record: Cell<unknown>;

  /** The actor-private receipt, in the actor's home space. */
  readonly receipt: Cell<unknown>;
}

/**
 * Reads a reviewed-intent descriptor.
 *
 * @throws Always, until reviewed intents are built.
 */
export function parseReviewedIntentDescriptor(
  _value: unknown,
): ReviewedIntentDescriptor {
  throw new Error("Reviewed intents are not built");
}

/** The digest a record carries as `endpoint` for `descriptor`. */
export const reviewedIntentEndpoint = (
  _descriptor: ReviewedIntentDescriptor,
): string => {
  throw new Error("Reviewed intents are not built");
};

/**
 * Prepares a reviewed intent.
 *
 * @throws Always, until reviewed intents are built.
 */
export function prepareReviewedIntent(
  _bindings: ReviewedIntentBindings,
): Promise<PreparedReviewedIntent> {
  return Promise.reject(new Error("Reviewed intents are not built"));
}

/**
 * Commits a reviewed intent.
 *
 * @throws Always, until reviewed intents are built.
 */
export function commitReviewedIntent(
  _consent: ReviewedIntentConsent,
  _event: unknown,
  _input: ReviewedIntentInput,
): Promise<ReviewedIntentResult> {
  return Promise.reject(new Error("Reviewed intents are not built"));
}

/**
 * Verifies a reviewed intent record.
 *
 * @throws Always, until reviewed intents are built.
 */
export function verifyReviewedIntentRecord(
  _record: Cell<unknown>,
  _tx?: IExtendedStorageTransaction,
): ReviewedIntentRecord {
  throw new Error("Reviewed intents are not built");
}
