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
import { collectExternalSchemaRefHashes } from "@commonfabric/data-model-schema/schema-refs";
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

/**
 * {@link namesPrincipal}'s settled answers, by the schema object it was asked
 * of. An answer is settled once every document the schema's closure reaches
 * has resolved. It is then a fact about content: each `cid:` reference names
 * its document by hash, and a lookup returns only a schema verified against
 * that hash (`registerSchemaDocument()` refuses any other), so the closure
 * holds a DID or does not whatever the registry holds later. A registry
 * clear therefore leaves a settled answer as it is.
 */
const principalNamingSchemas = new WeakMap<object, boolean>();

/**
 * Whether `value` holds a DID anywhere: in a string at any depth, or in a key.
 * Helper for {@link closureNamesPrincipal}.
 */
const holdsDid = (value: unknown): boolean => {
  if (typeof value === "string") return value.includes("did:");
  if (Array.isArray(value)) return value.some(holdsDid);
  if (!isObjectNotArray(value)) return false;
  return Object.entries(value).some(([key, entry]) =>
    key.includes("did:") || holdsDid(entry)
  );
};

/**
 * Helper for {@link namesPrincipal}, which answers for `schema`'s closure
 * through `lookup`: `true` when a document in it holds a DID, `false` when
 * every document in it resolved and none does, and `undefined` when one did
 * not resolve and none that did holds a DID. Only a `true` or `false` is
 * memoized. Content addressing rules out a cycle between documents, since a
 * document's hash commits to the hash of each document it names.
 */
const closureNamesPrincipal = (
  schema: JSONSchema,
  lookup: SchemaDocumentLookup,
): boolean | undefined => {
  if (!isObjectNotArray(schema)) return false;
  const settled = principalNamingSchemas.get(schema);
  if (settled !== undefined) return settled;
  let answer: boolean | undefined = holdsDid(schema);
  if (!answer) {
    for (const hash of collectExternalSchemaRefHashes(schema)) {
      const named = lookup(hash);
      const namedAnswer = named === undefined
        ? undefined
        : closureNamesPrincipal(named, lookup);
      if (namedAnswer === true) {
        answer = true;
        break;
      }
      if (namedAnswer === undefined) answer = undefined;
    }
  }
  if (answer !== undefined) principalNamingSchemas.set(schema, answer);
  return answer;
};

/**
 * Whether `schema` names a principal: whether a DID appears anywhere in its
 * closure, the schema itself and every document it names through `lookup`,
 * as a confidentiality or integrity clause bound to its principal does, or a
 * DID among its values. A decomposed schema puts a bound clause in a
 * document of its own and names it by hash, so a schema whose own content
 * holds no DID can still commit to one. Such a schema's hash identifies whom
 * it was bound to, so it never travels by reference and never resolves from
 * the registry (`docs/specs/content-addressed-schemas.md`, "Delivery by
 * reference"). A document `lookup` cannot resolve counts as naming one,
 * since nothing rules it out. A `CurrentPrincipal` placeholder not yet bound
 * holds no DID, and does not count. Memoized on the schema object, which a
 * registry holds interned and frozen, so a closure is walked once. Errs
 * toward `true`: a string that merely mentions `did:` keeps a body that
 * could have been referenced.
 */
export const namesPrincipal = (
  schema: JSONSchema,
  lookup: SchemaDocumentLookup,
): boolean => closureNamesPrincipal(schema, lookup) !== false;

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
 * holds anything beside `value`, holds a value `lookup` does not return as
 * the schema document its id names, or holds one that names a principal.
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
  const schema = verifySchemaDocument(hash, doc.value);
  return schema === undefined || namesPrincipal(schema, lookup)
    ? undefined
    : hash;
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
 * Throws as {@link resolveServerMessageCidReferences} does when `message`'s
 * sync holds a malformed reference, and returns otherwise, resolving
 * nothing. The client checks a sync it holds back this way when it arrives,
 * so one it hands on later cannot fail.
 *
 * @throws TypeError when a reference is not a live `cid:` upsert.
 */
export const assertCidReferencesWellFormed = (message: unknown): void => {
  resolveServerMessageCidReferences(message, () => undefined);
};

/**
 * Resolves the references in `message`'s sync through `lookup`. A hash in
 * `unresolvable` is one the client could not fetch: its reference is dropped,
 * which leaves arrival validation to quarantine every document whose refs
 * reach it. A schema that names a principal resolves only once its hash is in
 * `fetched`, the hashes whose bodies this frame's own space returned, so a
 * client fetches such a body even when `lookup` holds it. When any other hash
 * misses, nothing is rewritten and `missing` names them, so the caller fetches
 * them and resolves again.
 *
 * @throws TypeError when a reference is not a live `cid:` upsert, which is
 *   a form no server sends.
 */
export const resolveServerMessageCidReferences = (
  message: unknown,
  lookup: SchemaDocumentLookup,
  unresolvable: ReadonlySet<string> = new Set(),
  fetched: ReadonlySet<string> = new Set(),
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
      if (
        schema === undefined ||
        (namesPrincipal(schema, lookup) && !fetched.has(hash))
      ) {
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
