import type { JSONSchemaObj, SchemaPathSelector } from "@commonfabric/api";
import {
  hashSchema,
  internPathSelector,
  REJECTING_SELECTOR,
} from "@commonfabric/data-model-schema";
import {
  collectExternalSchemaRefHashes,
  containsExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import { hashStringOf } from "@commonfabric/data-model";
import type { MIME } from "@commonfabric/memory/interface";
import type {
  CellScope,
  ScopeKey,
  ScopeKeyIdentity,
} from "@commonfabric/memory/v2";

import { pruneCfcSchemaDefinitions } from "../cfc/schema-refs.ts";
import {
  decomposeSchema,
  recomposeSchema,
  SchemaNotDecomposableError,
} from "../schema-decompose.ts";
import { getContentAddressedSchemasConfig } from "../schema-doc-config.ts";
import {
  lookupSchemaDocument,
  registerSchemaDocument,
} from "../schema-registry.ts";
import type { PullError, Result, Unit, URI } from "./interface.ts";
import { SelectorTracker } from "./selector-tracker.ts";

const DOCUMENT_MIME = "application/json" as const;
type ScopedWatchAddress = {
  id: URI;
  type: MIME;
  scope?: CellScope;

  /** The explicit scope INSTANCE an instance-named load targets
   * (server-execution v2 stage A); absent = the session's own. */
  scopeKey?: ScopeKey;
};

export const normalizeSyncSelector = (
  selector: SchemaPathSelector | undefined,
): SchemaPathSelector => {
  if (selector === undefined || selector.schema === false) {
    return REJECTING_SELECTOR;
  }
  const schema = selector.schema === undefined
    ? undefined
    : pruneCfcSchemaDefinitions(selector.schema);
  return internPathSelector(
    schema === selector.schema ? selector : { path: selector.path, schema },
  );
};

/**
 * Thrown instead of emitting a selector whose schema carries `cid:` refs
 * the target space is not confirmed to persist — see
 * {@link externalizeSyncSelector}.
 */
export class SelectorClosureUnavailableError extends Error {
  constructor(readonly refs: readonly string[], cause: unknown) {
    super(
      `Selector schema references ${refs.length} schema document(s) not ` +
        `confirmed persisted in the target space [${
          refs.slice(0, 3).join(", ")
        }${
          refs.length > 3 ? ", …" : ""
        }]; emitting the reference form would only move this failure to ` +
        `the server. ${cause instanceof Error ? cause.message : ""}`,
    );
    this.name = "SelectorClosureUnavailableError";
  }
}

/**
 * Normalizes a selector's schema for the wire
 * (`docs/specs/content-addressed-schemas.md`, Phase 2; the
 * `contentAddressedSchemas` flag, shared with the link writer — the two
 * emissions deploy together). Two obligations meet here:
 *
 * - PREFERENCE (flag-gated): a schema whose whole closure
 *   `isContentAddressedDocPersisted` confirms in the target space emits as a
 *   reference — server-confirmed local presence implies server presence,
 *   since a confirmed document arrived by delivery or an acknowledged
 *   commit and can never change.
 *
 * - CORRECTNESS (unconditional): a schema that already carries `cid:`
 *   refs — a live pattern's binding schema, a schema minted in another
 *   space — must NOT reach the wire unless the target space persists the
 *   closure, because the server answers an unpersisted selector reference
 *   loudly. When the closure is not confirmed there, the schema
 *   recomposes to the fully inline form through the realm registry, which
 *   holds every document behind a locally created reference.
 *
 * A decomposition refusal keeps the selector exactly as given when the
 * schema carries no references — inline is inline, and the server accepts
 * it. Refusal is structural as often as it is a missing document, so a
 * ref-bearing refusal splits on what the SERVER can answer: a schema
 * whose every reference the target space is confirmed to persist passes
 * through as given, and any other throws
 * {@link SelectorClosureUnavailableError} — a document held only in the
 * local registry backs nothing on the wire, the structural refusal rules
 * out recomposing inline, and emitting would violate the client's
 * send-only-what-you-can-back obligation while spending a round trip on
 * the server's refusal. The retainer invariant is one instance: a
 * reference dies with the registry epoch that minted it, and every
 * retainer of externalized forms drops them on the registry clear (the
 * wish sidecar pattern caches, the sanitize memo), so a cross-epoch
 * reference reaches this gate with nothing confirmed anywhere — a bug to
 * surface at its source, not to forward.
 */
export const externalizeSyncSelector = (
  selector: SchemaPathSelector,
  isContentAddressedDocPersisted: (hash: string) => boolean,
): SchemaPathSelector => {
  const schema = selector.schema;
  if (schema === undefined || typeof schema === "boolean") return selector;
  const carriesRefs = containsExternalSchemaRef(schema);
  if (!carriesRefs && !getContentAddressedSchemasConfig()) return selector;
  try {
    const { rootRef, documents } = decomposeSchema(schema as JSONSchemaObj, {
      resolveDocument: lookupSchemaDocument,
    });
    for (const [hash, document] of documents) {
      registerSchemaDocument(hash, document);
    }
    const persisted = [...documents.keys()].every((hash) =>
      isContentAddressedDocPersisted(hash)
    );
    if (persisted && getContentAddressedSchemasConfig()) {
      return internPathSelector({
        path: selector.path,
        schema: { $ref: rootRef },
      });
    }
    if (!carriesRefs) return selector;
    return internPathSelector({
      path: selector.path,
      schema: recomposeSchema(
        rootRef,
        (hash) => documents.get(hash) ?? lookupSchemaDocument(hash),
      ),
    });
  } catch (error) {
    if (error instanceof SchemaNotDecomposableError) {
      if (!carriesRefs) return selector;
      // Decomposition refuses for structural reasons too — a nested
      // `$defs`, a `$id`, an unsupported `$ref` form — and those say
      // nothing about whether the `cid:` refs the schema carries are
      // emittable. What decides emittability is the server's store, not
      // the local registry: the server validates a selector reference
      // against what the target space persists, so a document held only
      // locally backs nothing on the wire. The selector goes out as given
      // exactly when every reference is confirmed persisted there — a
      // persisted document's closure persisted with it, the same
      // write-side guarantee the decomposing arm leans on — and otherwise
      // this throws: rebuilding the inline form needs the decomposition
      // that just refused, and emitting would only move the failure to
      // the server's refusal.
      const unemittable = [
        ...collectExternalSchemaRefHashes(schema as JSONSchemaObj),
      ].filter((hash) => !isContentAddressedDocPersisted(hash));
      if (unemittable.length === 0) return selector;
      throw new SelectorClosureUnavailableError(unemittable, error);
    }
    throw error;
  }
};

export const normalizeSyncEntries = (
  entries: [ScopedWatchAddress, SchemaPathSelector | undefined][],
): [ScopedWatchAddress, SchemaPathSelector][] =>
  entries.map((
    [address, selector],
  ) => [address, normalizeSyncSelector(selector)]);

export const compactWatchEntries = (
  entries: [ScopedWatchAddress, SchemaPathSelector][],
  identity: ScopeKeyIdentity,
): [ScopedWatchAddress, SchemaPathSelector][] => {
  const tracker = new SelectorTracker<Result<Unit, PullError>>(() => identity);
  const compacted: [ScopedWatchAddress, SchemaPathSelector][] = [];

  for (const entry of entries) {
    const [address, selector] = entry;
    const baseAddress = {
      id: address.id,
      type: DOCUMENT_MIME,
      path: [],
      scope: address.scope ?? "space",
      ...(address.scopeKey !== undefined ? { scopeKey: address.scopeKey } : {}),
    };
    const [superset] = tracker.getSupersetSelector(
      baseAddress,
      selector,
    );
    if (superset !== undefined) {
      continue;
    }
    tracker.add(
      baseAddress,
      selector,
      Promise.resolve({ ok: {} } as Result<Unit, PullError>),
    );
    compacted.push(entry);
  }

  return compacted;
};

const selectorIdentity = (selector: SchemaPathSelector): string =>
  hashStringOf({
    path: selector.path,
    schemaHash: selector.schema === undefined
      ? ""
      : hashSchema(selector.schema),
  });

export const watchIdForEntry = (
  address: ScopedWatchAddress,
  selector: SchemaPathSelector,
  branch = "",
): string =>
  `replica:${
    hashStringOf({
      branch,
      id: address.id,
      scope: address.scope ?? "space",
      type: DOCUMENT_MIME,
      selector: selectorIdentity(selector),
      // The explicit instance (stage A) is watch identity: two instances
      // of one doc are two watches, never merged by id. Absent from the
      // hashed object when unnamed, so the OFF-arm id is byte-identical.
      ...(address.scopeKey !== undefined ? { scopeKey: address.scopeKey } : {}),
    })
  }`;
