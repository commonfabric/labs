/**
 * The vocabulary of content-addressed schema document references: the `cid:`
 * reference form and its parser, the scan that finds every such reference a
 * schema carries, and the grammar of the reserved `schema` metadata member a
 * stored document may carry. The design is
 * `docs/specs/content-addressed-schemas.md`; this module is pure value code
 * shared by every layer that reads or writes those references, the storage
 * engine included, and nothing here reads or writes storage or resolves a
 * reference to its document.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { isDeepFrozen } from "@commonfabric/data-model";
import {
  decodeJsonPointer,
  encodeJsonPointer,
} from "@commonfabric/utils/json-pointer";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { anySchema, walkSchema } from "./schema-walk.ts";

/**
 * The URI scheme prefix of a content-addressed schema document reference,
 * `cid` being short for content identifier. RFC 2392 registers the same
 * name for a body part of a MIME message, addressed by its `Content-ID`
 * header. The two uses share the name and nothing else. `entity-kind.ts`
 * records the other scheme names this tree uses.
 */
export const SCHEMA_DOCUMENT_REF_PREFIX = "cid:";

/** A parsed external schema reference. */
export type ExternalSchemaRef = {
  /** Tagged hash of the referenced document (the id without `cid:`). */
  readonly taggedHash: string;

  /**
   * For a reference into a cyclic-group document: the member definition's
   * name. Absent for a bare reference to a document's own schema.
   */
  readonly defName?: string;
};

/** Formats an external schema reference from its parts. */
export function formatExternalSchemaRef(
  taggedHash: string,
  defName?: string,
): string {
  const fragment = defName === undefined
    ? ""
    : encodeJsonPointer(["#", "$defs", defName]);
  return `${SCHEMA_DOCUMENT_REF_PREFIX}${taggedHash}${fragment}`;
}

/**
 * Parses an external schema reference. Returns `undefined` when `ref` does
 * not carry the `cid:` prefix or its fragment is not a `#/$defs/<name>`
 * pointer.
 */
export function parseExternalSchemaRef(
  ref: string,
): ExternalSchemaRef | undefined {
  if (!ref.startsWith(SCHEMA_DOCUMENT_REF_PREFIX)) return undefined;
  const rest = ref.slice(SCHEMA_DOCUMENT_REF_PREFIX.length);
  const fragmentAt = rest.indexOf("#");
  const taggedHash = fragmentAt === -1 ? rest : rest.slice(0, fragmentAt);
  if (taggedHash.length === 0) return undefined;
  if (fragmentAt === -1) return { taggedHash };
  const pointer = decodeJsonPointer(rest.slice(fragmentAt));
  if (
    pointer.length !== 3 || pointer[0] !== "#" || pointer[1] !== "$defs" ||
    pointer[2]!.length === 0
  ) {
    return undefined;
  }
  return { taggedHash, defName: pointer[2] };
}

/** Whether `ref` parses as an external schema reference. */
export function isExternalSchemaRef(ref: string): boolean {
  return parseExternalSchemaRef(ref) !== undefined;
}

// Presence of an external ref anywhere in a schema, memoized for frozen
// inputs. This is the guard the resolution caches consult before memoizing a
// FAILED resolution: a schema that can reach an external ref may resolve
// later, once the referenced document arrives, so pinning the miss would
// pin the failure past the arrival. Presence itself is safe to memoize —
// frozen content cannot gain or lose a ref.
const externalRefPresenceCache = new WeakMap<JSONSchemaObj, boolean>();

/**
 * Whether `schema` contains an external schema reference anywhere — its own
 * `$ref`, any subschema's (the never-emitted keywords included), or inside
 * a `$defs` body.
 */
export function containsExternalSchemaRef(
  schema: JSONSchema | undefined,
): boolean {
  if (!isObjectNotArray(schema)) return false;
  const cached = externalRefPresenceCache.get(schema);
  if (cached !== undefined) return cached;
  const result = anySchema(
    schema,
    (node) =>
      isObjectNotArray(node.schema) &&
      typeof node.schema.$ref === "string" &&
      isExternalSchemaRef(node.schema.$ref),
    { includeDefs: true, includeUnused: true },
  );
  if (isDeepFrozen(schema)) externalRefPresenceCache.set(schema, result);
  return result;
}

const EMPTY_HASHES: ReadonlySet<string> = new Set();
const externalRefHashCache = new WeakMap<JSONSchemaObj, ReadonlySet<string>>();

/**
 * The tagged hashes of every schema document `schema` references — its own
 * `$ref`, any subschema's (the never-emitted keywords included), and inside
 * `$defs` bodies. Memoized for frozen inputs.
 */
export function collectExternalSchemaRefHashes(
  schema: JSONSchema | undefined,
): ReadonlySet<string> {
  if (!isObjectNotArray(schema)) return EMPTY_HASHES;
  const cached = externalRefHashCache.get(schema);
  if (cached !== undefined) return cached;
  const hashes = new Set<string>();
  walkSchema(
    schema,
    (node) => {
      if (
        isObjectNotArray(node.schema) && typeof node.schema.$ref === "string"
      ) {
        const parsed = parseExternalSchemaRef(node.schema.$ref);
        if (parsed !== undefined) hashes.add(parsed.taggedHash);
      }
    },
    { includeDefs: true, includeUnused: true },
  );
  const result: ReadonlySet<string> = hashes.size === 0 ? EMPTY_HASHES : hashes;
  if (isDeepFrozen(schema)) externalRefHashCache.set(schema, result);
  return result;
}

/**
 * The reserved root member of a stored document that carries the
 * document's schema metadata — a result document's result schema, a
 * receipt's shape (`EntityDocument.schema`,
 * `docs/specs/memory-v2/01-data-model.md`). Its grammar is two forms and
 * nothing else: a self-contained inline schema carrying no `cid:`
 * reference, or a single-member `{ "$ref": "cid:<hash>" }` root (the
 * `#/$defs/<name>` fragment form included). Every layer that collects a
 * document's schema-document obligations — the commit boundary, result
 * assembly, arrival validation, and the writer's own closure staging —
 * classifies it through {@link classifySchemaMeta} and refuses the third
 * shape, a hybrid, at its own boundary.
 */
export const SCHEMA_META_MEMBER = "schema";

/** The form a document's {@link SCHEMA_META_MEMBER} takes. */
export type SchemaMetaForm =
  /** No member, or a member holding `undefined`. */
  | { readonly kind: "absent" }
  /** A self-contained schema: no `cid:` reference anywhere in it. */
  | { readonly kind: "inline"; readonly schema: JSONSchema }
  /** A single-member `{ "$ref": "cid:…" }` root. */
  | {
    readonly kind: "reference";
    readonly ref: string;
    readonly taggedHash: string;
    readonly defName?: string;
  }
  /** A non-schema value, or a `cid:` reference nested or with siblings. */
  | { readonly kind: "malformed"; readonly reason: string };

/**
 * Thrown for a {@link SCHEMA_META_MEMBER} in the malformed form. Each
 * boundary translates it into its own refusal — a `ProtocolError` at the
 * commit boundary, a `SchemaClosureError` in result assembly, a quarantine
 * on arrival — and the writer's staging lets it propagate, so a malformed
 * member never reaches a transaction's writes.
 */
export class MalformedSchemaMetaError extends Error {
  constructor(reason: string) {
    super(`Malformed schema metadata: ${reason}`);
    this.name = "MalformedSchemaMetaError";
  }
}

/** Classifies a stored document's {@link SCHEMA_META_MEMBER}. */
export function classifySchemaMeta(document: unknown): SchemaMetaForm {
  if (!isObjectNotArray(document)) return { kind: "absent" };
  const schema = (document as { [SCHEMA_META_MEMBER]?: unknown })[
    SCHEMA_META_MEMBER
  ];
  return classifySchemaMetaValue(schema);
}

/**
 * Classifies a value held AT a {@link SCHEMA_META_MEMBER}, for a writer
 * that has the member's value rather than the document around it.
 */
export function classifySchemaMetaValue(schema: unknown): SchemaMetaForm {
  if (schema === undefined) return { kind: "absent" };
  if (typeof schema === "boolean") return { kind: "inline", schema };
  if (!isObjectNotArray(schema)) {
    return {
      kind: "malformed",
      reason: "the member holds a value that is not a schema",
    };
  }
  const obj = schema as JSONSchemaObj;
  if (typeof obj.$ref === "string" && isCidPrefixedRef(obj.$ref)) {
    const parsed = parseExternalSchemaRef(obj.$ref);
    if (parsed === undefined) {
      return {
        kind: "malformed",
        reason:
          `the root \`$ref\` is not a well-formed \`cid:\` reference: \`${obj.$ref}\``,
      };
    }
    if (Object.keys(obj).length !== 1) {
      return {
        kind: "malformed",
        reason: "a `cid:` root reference carries sibling keywords",
      };
    }
    return { kind: "reference", ref: obj.$ref, ...parsed };
  }
  // Any `cid:`-prefixed ref below the root is outside the grammar, whether
  // or not it parses: an unparseable one names no document at all, and a
  // classifier that let it through as inline would persist metadata whose
  // closure nothing can install.
  if (containsCidPrefixedRef(obj)) {
    return {
      kind: "malformed",
      reason:
        "a `cid:` reference appears inside an inline schema; only a single " +
        '`{ "$ref": "cid:…" }` root may reference a schema document',
    };
  }
  return { kind: "inline", schema: obj };
}

/** Whether `ref` claims the `cid:` scheme, well-formed or not. */
function isCidPrefixedRef(ref: string): boolean {
  return ref.startsWith(SCHEMA_DOCUMENT_REF_PREFIX);
}

/**
 * Whether any `$ref` anywhere in `schema` — subschemas and `$defs` bodies
 * included — claims the `cid:` scheme, parseable or not. Broader than
 * {@link containsExternalSchemaRef} by design: this is the grammar check,
 * and a `cid:` string that does not parse is exactly the kind of member
 * the grammar exists to keep out.
 */
function containsCidPrefixedRef(schema: JSONSchemaObj): boolean {
  return anySchema(
    schema,
    (node) =>
      isObjectNotArray(node.schema) &&
      typeof node.schema.$ref === "string" &&
      isCidPrefixedRef(node.schema.$ref),
    { includeDefs: true, includeUnused: true },
  );
}

/**
 * The tagged hash a stored document's {@link SCHEMA_META_MEMBER}
 * references: one for the reference form, none for the inline or absent
 * forms. Throws {@link MalformedSchemaMetaError} for the malformed form.
 * This inspects document-level metadata. A `schema` keyword inside a schema
 * document's `value` belongs to that schema and is not a metadata position.
 */
export function collectSchemaMetaRefHashes(
  document: unknown,
): ReadonlySet<string> {
  return schemaMetaRefHashes(classifySchemaMeta(document));
}

/** {@link collectSchemaMetaRefHashes} over an already classified form. */
export function schemaMetaRefHashes(form: SchemaMetaForm): ReadonlySet<string> {
  switch (form.kind) {
    case "reference":
      return new Set([form.taggedHash]);
    case "malformed":
      throw new MalformedSchemaMetaError(form.reason);
    default:
      return EMPTY_HASHES;
  }
}
