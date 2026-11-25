/**
 * What a path of the two-principal comparison stored, read from the memory
 * server's own store after each step: the store is a directory of SQLite
 * files, one for each space, and is read with the state inspector
 * (`@commonfabric/state-inspector`), read-only, as `cf inspect` reads a
 * deployment's store. Nothing here goes through a runtime, so a document of
 * the scope `user` or `session` of either principal is read as the store
 * holds it, whoever the reader is.
 *
 * - **The documents.** Each document of a space at its current revision,
 *   for each scope instance (`head`), with its stored label envelope
 *   resolved by the runner's own reader (`interpretStoredEnvelope`,
 *   `resolveStoredCfcMetadata`), whose label documents are the `cid:`
 *   documents of the same space.
 * - **Error states.** A value that is an error state: the record
 *   `{ $error: … }` of the executor (`isErrorState`) and an encoded error
 *   (`FabricError`), counted by message over the current revision of each
 *   document and over the data of every revision row of every space.
 * - **What was written.** The revision rows after a sequence number:
 *   the documents they name, the bytes of their data and their number.
 */
import {
  type FabricValue,
  isFabricArray,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import {
  decodedLinkOf,
  decodeStored,
  openSpace,
  parseScope,
  reconstructDocument,
  type SpaceDb,
} from "@commonfabric/state-inspector";

import {
  interpretStoredEnvelope,
  resolveStoredCfcMetadata,
} from "../../../runtime/runner/src/cfc/metadata.ts";
import type { CfcMetadata } from "../../../runtime/runner/src/cfc/types.ts";
import { resolveSpaceStoreUrl } from "../../../runtime/memory/v2/storage-path.ts";
import { isErrorState } from "../exec/store.ts";

/** One scope instance of a document at its current revision. */
export type StoredDocument = {
  space: string;
  id: string;
  /** The scope key as stored: `space`, `user:<did>`, `session:<did>:<id>`. */
  scopeKey: string;
  /** The kind of the scope and its principal, from the key. */
  scope: { kind: string; principal?: string; session?: string };
  /** The document's `value`. */
  value: FabricValue | undefined;
  /** The stored label envelope, resolved, where the document has one. */
  metadata?: CfcMetadata;
  /** Why the envelope could not be read, where it could not. */
  metadataError?: string;
};

/** A link found in a stored value, with its target resolved to an address. */
export type StoredLink = {
  space: string;
  id: string;
  /** The name of the scope the link names, or the scope of its document. */
  scope: string;
  path: string[];
};

/** The documents of one space at the current revision of each. */
export type SpaceSnapshot = {
  space: string;
  /** The highest sequence number of the space's store. */
  seq: number;
  documents: StoredDocument[];
  /** A document by its id and scope key. */
  get(id: string, scopeKey: string): StoredDocument | undefined;
  /** The value of a `cid:` document of the space. */
  contentOf(id: string): FabricValue | undefined;
};

/** The SQLite file of `space` in the store at `store`. */
export const spaceStorePath = (store: URL, space: string): string =>
  decodeURIComponent(
    resolveSpaceStoreUrl(store, space as `did:${string}:${string}`).pathname,
  );

/** Opens the store of `space`, or gives `undefined` where it has none. */
const opened = (store: URL, space: string): SpaceDb | undefined => {
  try {
    return openSpace(spaceStorePath(store, space));
  } catch {
    return undefined;
  }
};

/** Every document of `space` in the store at `store`, at its current revision. */
export const snapshotOf = (store: URL, space: string): SpaceSnapshot => {
  const db = opened(store, space);
  const documents: StoredDocument[] = [];
  const byKey = new Map<string, StoredDocument>();
  const contents = new Map<string, FabricValue | undefined>();
  let seq = 0;
  if (db === undefined) {
    return {
      space,
      seq,
      documents,
      get: () => undefined,
      contentOf: () => undefined,
    };
  }
  try {
    seq = db.get<{ seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM revision",
    )?.seq ?? 0;
    const heads = db.all<{ id: string; scope_key: string; op: string }>(
      "SELECT id, scope_key, op FROM head WHERE branch = '' ORDER BY id, scope_key",
    );
    const raw = new Map<string, FabricValue | undefined>();
    for (const head of heads) {
      if (head.op === "delete") continue;
      let document: Record<string, FabricValue> | undefined;
      try {
        document = reconstructDocument(db, {
          id: head.id,
          scope: head.scope_key,
        }) as Record<string, FabricValue> | undefined;
      } catch {
        document = undefined;
      }
      raw.set(`${head.id}\n${head.scope_key}`, document as never);
      if (head.id.startsWith("cid:") && head.scope_key === "space") {
        contents.set(head.id, document?.value);
      }
    }
    for (const head of heads) {
      if (head.op === "delete") continue;
      const document = raw.get(`${head.id}\n${head.scope_key}`) as
        | Record<string, FabricValue>
        | undefined;
      const parsed = parseScope(head.scope_key);
      const stored: StoredDocument = {
        space,
        id: head.id,
        scopeKey: head.scope_key,
        scope: {
          kind: parsed.kind,
          ...(parsed.principal === undefined
            ? {}
            : { principal: parsed.principal }),
          ...(parsed.sessionId === undefined
            ? {}
            : { session: parsed.sessionId }),
        },
        value: document?.value,
      };
      try {
        const envelope = interpretStoredEnvelope(head.id, document?.cfc);
        if (envelope !== undefined) {
          stored.metadata = resolveStoredCfcMetadata(
            envelope,
            (id) => raw.get(`${id}\nspace`),
          );
        }
      } catch (error) {
        stored.metadataError = error instanceof Error
          ? error.message.split("\n")[0]
          : String(error);
      }
      documents.push(stored);
      byKey.set(`${head.id}\n${head.scope_key}`, stored);
    }
  } finally {
    db.close();
  }
  return {
    space,
    seq,
    documents,
    get: (id, scopeKey) => byKey.get(`${id}\n${scopeKey}`),
    contentOf: (id) => contents.get(id),
  };
};

/** The message of an error state, where `value` is one. */
export const errorMessageOf = (value: unknown): string | undefined => {
  if (isErrorState(value)) return String(value.$error.message);
  if (value instanceof FabricError) {
    return `encoded ${value.name}: ${value.message}`;
  }
  if (value instanceof Error) return `encoded ${value.name}: ${value.message}`;
  return undefined;
};

/** Counts each error state that `value` holds into `into`, by message. */
export const countErrorStates = (
  value: unknown,
  into: Record<string, number>,
): void => {
  const message = errorMessageOf(value);
  if (message !== undefined) {
    into[message] = (into[message] ?? 0) + 1;
    return;
  }
  if (isFabricArray(value as FabricValue) || Array.isArray(value)) {
    for (const member of value as unknown[]) countErrorStates(member, into);
  } else if (isFabricPlainObject(value as FabricValue)) {
    for (const member of Object.values(value as Record<string, unknown>)) {
      countErrorStates(member, into);
    }
  }
};

/** The error states a path's store holds, by message. */
export type ErrorCounts = {
  /** In the current revision of each document. */
  current: Record<string, number>;
  /** In the data of every revision row, current or not. */
  all: Record<string, number>;
};

/** The error states of `spaces` in the store at `store`. */
export const errorStatesOf = (
  store: URL,
  spaces: readonly string[],
): ErrorCounts => {
  const counts: ErrorCounts = { current: {}, all: {} };
  for (const space of spaces) {
    for (const document of snapshotOf(store, space).documents) {
      countErrorStates(document.value, counts.current);
    }
    const db = opened(store, space);
    if (db === undefined) continue;
    try {
      for (
        const row of db.all<{ data: string | null }>(
          "SELECT data FROM revision WHERE data IS NOT NULL",
        )
      ) {
        let decoded: FabricValue;
        try {
          decoded = decodeStored(row.data!);
        } catch {
          continue;
        }
        countErrorStates(decoded, counts.all);
      }
    } finally {
      db.close();
    }
  }
  return counts;
};

/** What the revision rows of a space after a sequence number wrote. */
export type Written = {
  /** The scope instances of documents the rows name. */
  documents: number;
  /** The length of the rows' data. */
  bytes: number;
  /** The rows. */
  writes: number;
};

/** What `space` was written after `since`, and the space's last sequence. */
export const writtenSince = (
  store: URL,
  space: string,
  since: number,
): Written & { seq: number } => {
  const db = opened(store, space);
  if (db === undefined) {
    return { documents: 0, bytes: 0, writes: 0, seq: since };
  }
  try {
    const row = db.get<{
      documents: number;
      bytes: number | null;
      writes: number;
      seq: number | null;
    }>(
      `SELECT COUNT(DISTINCT id || char(10) || scope_key) AS documents,
              SUM(LENGTH(data)) AS bytes, COUNT(*) AS writes, MAX(seq) AS seq
         FROM revision WHERE seq > ?`,
      since,
    );
    return {
      documents: row?.documents ?? 0,
      bytes: row?.bytes ?? 0,
      writes: row?.writes ?? 0,
      seq: Math.max(since, row?.seq ?? since),
    };
  } finally {
    db.close();
  }
};

/**
 * Each link a stored value holds, by its path in the value, with its
 * target's space, id and scope filled in from the document it is in where
 * the link leaves them out.
 */
export const linksIn = (
  document: StoredDocument,
  value: FabricValue | undefined = document.value,
  at: string[] = [],
  found: { path: string[]; link: StoredLink }[] = [],
): { path: string[]; link: StoredLink }[] => {
  if (value === undefined || value === null) return found;
  const link = decodedLinkOf(value);
  if (link !== null) {
    found.push({
      path: at,
      link: {
        space: link.space ?? document.space,
        id: link.id ?? document.id,
        scope: link.scope ?? document.scope.kind,
        path: [...(link.path ?? [])],
      },
    });
    return found;
  }
  if (isFabricArray(value) || Array.isArray(value)) {
    (value as FabricValue[]).forEach((member, index) =>
      linksIn(document, member, [...at, String(index)], found)
    );
  } else if (isFabricPlainObject(value)) {
    for (const [name, member] of Object.entries(value)) {
      linksIn(document, member as FabricValue, [...at, name], found);
    }
  }
  return found;
};
