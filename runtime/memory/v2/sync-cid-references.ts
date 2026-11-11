/**
 * Delivery of `cid:` schema documents by reference (`syncCidReferencesV1`,
 * `docs/specs/content-addressed-schemas.md`, "Delivery by reference"). A
 * schema document's bytes are the same in every space that stores it, so a
 * server names one its realm registry holds by id and seq alone, and the
 * client takes its body from its own registry, fetching only what that
 * lacks. This module holds both halves of the rewrite: the server's, which
 * turns a qualifying upsert into a reference, and the client's, which turns
 * a reference back into the upsert it stands for. Neither half reads
 * storage or the network; the client's fetch lives with its connection.
 */

import type { JSONSchema } from "@commonfabric/api";
import { verifySchemaDocument } from "@commonfabric/data-model-schema/schema-closure";
import { isObjectNotArray, isPlainObject } from "@commonfabric/js-values/types";

import type {
  EntityDocument,
  ServerMessage,
  SessionSync,
  SessionSyncUpsert,
} from "../v2.ts";
import { serverMessageSync } from "./message-parts.ts";

/** The id prefix of a content-addressed document. */
const CID_PREFIX = "cid:";

/** The registry lookup each half consults: a verified schema, or nothing. */
export type SchemaDocumentLookup = (hash: string) => JSONSchema | undefined;

/** What resolving a message's references found. */
export interface CidReferenceResolution {
  /**
   * The message to hand on: every reference replaced by the upsert it
   * stands for, and every one named in `unresolvable` dropped. It is the
   * message as received when `missing` is not empty.
   */
  readonly message: unknown;

  /** The hashes of references the lookup could not resolve, in order. */
  readonly missing: readonly string[];
}

/**
 * The hash a `cid:` upsert may travel as a reference under, or `undefined`
 * when it must keep its body: when it is not a `cid:` document, is deleted,
 * holds anything beside `value`, or holds a value `lookup` does not return
 * as the schema document its id names.
 */
const referenceableHash = (
  upsert: SessionSyncUpsert,
  lookup: SchemaDocumentLookup,
): string | undefined => {
  if (!upsert.id.startsWith(CID_PREFIX) || upsert.deleted === true) {
    return undefined;
  }
  const doc = upsert.doc;
  if (!isObjectNotArray(doc)) return undefined;
  const keys = Object.keys(doc);
  if (keys.length !== 1 || keys[0] !== "value") return undefined;
  const hash = upsert.id.slice(CID_PREFIX.length);
  if (lookup(hash) === undefined) return undefined;
  return verifySchemaDocument(hash, doc.value) === undefined ? undefined : hash;
};

/**
 * Helper for the exported rewrites, which returns `message` with its sync's
 * upserts replaced by `rewrite`'s, or `message` itself when the rewrite
 * changed none of them.
 */
const withRewrittenUpserts = (
  message: unknown,
  rewrite: (upserts: SessionSync["upserts"]) => SessionSync["upserts"],
): unknown => {
  const sync = serverMessageSync(message);
  if (sync === undefined) return message;
  const upserts = rewrite(sync.upserts);
  if (upserts === sync.upserts) return message;
  const next = { ...sync, upserts };
  const outer = message as Record<string, unknown>;
  return outer.type === "session/effect" ? { ...outer, effect: next } : {
    ...outer,
    ok: { ...(outer.ok as Record<string, unknown>), sync: next },
  };
};

/**
 * Returns `message` with every `cid:` schema document in its sync that
 * `lookup` holds named by reference: id, seq and the upsert's other fields,
 * without `doc`. The server applies it to a message for a connection that
 * negotiated `syncCidReferencesV1`. A message carrying no sync, or no such
 * document, is returned as it is.
 */
export const referenceServerMessageSchemaDocuments = (
  message: ServerMessage,
  lookup: SchemaDocumentLookup,
): ServerMessage =>
  withRewrittenUpserts(message, (upserts) => {
    let changed = false;
    const next = upserts.map((upsert) => {
      if (referenceableHash(upsert, lookup) === undefined) return upsert;
      changed = true;
      const { doc: _doc, ...rest } = upsert;
      return { ...rest, byReference: true as const };
    });
    return changed ? next : upserts;
  }) as ServerMessage;

/** Whether `message` carries a sync naming any document by reference. */
export const hasServerMessageCidReferences = (message: unknown): boolean =>
  serverMessageSync(message)?.upserts.some((upsert) =>
    upsert.byReference !== undefined
  ) ?? false;

/**
 * Resolves the references in `message`'s sync through `lookup`. A hash in
 * `unresolvable` is one the client could not fetch: its reference is dropped,
 * which leaves arrival validation to quarantine every document whose refs
 * reach it. When any other hash misses, nothing is rewritten and `missing`
 * names them, so the caller fetches them and resolves again.
 *
 * @throws TypeError when a reference is not a live `cid:` upsert, which is
 *   a form no server sends.
 */
export const resolveServerMessageCidReferences = (
  message: unknown,
  lookup: SchemaDocumentLookup,
  unresolvable: ReadonlySet<string> = new Set(),
): CidReferenceResolution => {
  const missing: string[] = [];
  const resolved = withRewrittenUpserts(message, (upserts) => {
    if (!upserts.some((upsert) => upsert.byReference !== undefined)) {
      return upserts;
    }
    const next: SessionSync["upserts"] = [];
    for (const upsert of upserts) {
      if (upsert.byReference === undefined) {
        next.push(upsert);
        continue;
      }
      if (
        upsert.byReference !== true || !upsert.id.startsWith(CID_PREFIX) ||
        upsert.deleted !== undefined || upsert.doc !== undefined
      ) {
        throw new TypeError(
          `Malformed schema document reference for \`${upsert.id}\``,
        );
      }
      const hash = upsert.id.slice(CID_PREFIX.length);
      if (unresolvable.has(hash)) continue;
      const schema = lookup(hash);
      if (schema === undefined) {
        missing.push(hash);
        continue;
      }
      const { byReference: _byReference, ...rest } = upsert;
      const doc: EntityDocument = { value: schema };
      next.push({ ...rest, doc });
    }
    return next;
  });
  return missing.length > 0
    ? { message, missing }
    : { message: resolved, missing };
};

/**
 * The schema `document`, a `graph.query` entity's stored document, holds
 * as the schema document `hash` names, or `undefined` when it holds
 * anything else.
 */
export const fetchedSchemaDocument = (
  hash: string,
  document: unknown,
): JSONSchema | undefined =>
  isPlainObject(document)
    ? verifySchemaDocument(hash, document.value)
    : undefined;
