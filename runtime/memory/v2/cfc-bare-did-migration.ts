/**
 * The one-shot migration that respells every stored confidentiality label
 * naming a principal by bare DID string so that it names
 * `User{subject: DID}`. Each instance that needs it gets one patch replacing
 * its `cfc` member, so no value changes and no collaborative field is
 * touched.
 *
 * An atom is a structured value with a type and parameters (§4.1.1), and the
 * atom registry (§15.2) has no string form: a principal is spelled
 * `User{subject: DID}`, and the boundary that mints a label names it so
 * (Decision D7, §13.11). Stores written before every minting site did so
 * still hold the bare string, and a ceiling naming the principal as
 * `User{subject}` does not admit it, because the fit kernel compares atoms
 * structurally (§8.12.1's `atomLe`). The two spellings name one principal,
 * so respelling releases nothing, and once every store is respelled no code
 * need tell them apart.
 *
 * It reaches space and user scope, not session scope. A session's instances
 * are read by that session alone, and a client mints a fresh session id for
 * each process (`runtime/runner/src/storage/v2.ts`), so the instances of an
 * ended session are never read again. A client connected across the store's
 * opening keeps its session id on reconnecting; a write of its that carries
 * a bare DID out of one of its own instances into another document is
 * refused, until the client starts again under a new id.
 *
 * The patches are written through the store's own commit path, as `system`
 * commits under the session id `store-migration:<name>`, a batch of
 * instances each, so history keeps every state the documents went through
 * and every reader sees the rewrite as an ordinary revision. Each batch is
 * read under the store's write lock, so a write another process makes to
 * the store cannot land between the read and the rewrite. A batch the store
 * refuses is retried one instance at a time, so an instance the store will
 * not take costs only itself, keeps the labels it stores, and is reported
 * with the reason. A row in the `store_migration` table, written once the
 * walk has reached every instance, marks the store done; a run that stops
 * before then leaves what it committed, and the next run finds only what
 * remains. The walk yields to the event loop between batches, so a host
 * opening the store keeps serving its others meanwhile.
 *
 * The walk is written over any rewrite of a document, `DocumentMigration`,
 * so that a second one-shot migration can take it over before this one is
 * deleted; until then it has this one client, and goes with it.
 *
 * This module is temporary. `docs/development/EXPERIMENTAL_OPTIONS.md`,
 * `MEMORY_RETIRE_BARE_DID_LABELS`, says when it is deleted.
 */

// SPEC-PENDING https://github.com/commonfabric/specs/pull/107

import { CFC_ATOM_TYPE, type CfcAtom } from "@commonfabric/api/cfc";
import { type FabricValue, valueEqual } from "@commonfabric/data-model";
import { isWellFormedDID } from "@commonfabric/identity/did";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import { yieldToEventLoop } from "@commonfabric/async/sleep";

import {
  DEFAULT_BRANCH,
  type EntityDocument,
  type PatchOp,
  type PatchOperation,
  scopeOfScopeKey,
} from "../v2.ts";
import { type CfcConfClause, isOrClause } from "./cfc-release-authority.ts";
import { resolveStoredLabel } from "./cfc-stored-label-map.ts";
import * as Engine from "./engine.ts";

/** The respelling, as {@link runDocumentMigration} runs it. */
export const BARE_DID_RESPELLING: DocumentMigration = {
  name: "cfc-bare-did-respelling/1",
  scopes: ["space", "user"],
  rewrite: (document, readDocument) => {
    const cfc = respellBareDidEnvelope(
      (document as { cfc?: unknown }).cfc,
      (ref) => readDocument(ref)?.value,
    );
    return cfc === undefined
      ? undefined
      : [{ op: "replace", path: "/cfc", value: cfc as FabricValue }];
  },
};

/**
 * Respells the store `engine` opens, unless it already has been. `space` is
 * the space the store holds.
 */
export const retireBareDidLabels = (
  engine: Engine.Engine,
  options: { space?: string } = {},
): Promise<DocumentMigrationReport> =>
  runDocumentMigration(engine, BARE_DID_RESPELLING, options);

/** Whether the store `engine` opens has been respelled. */
export const isRespelled = (engine: Engine.Engine): boolean =>
  isMigrationDone(engine, BARE_DID_RESPELLING.name);

/**
 * Whether `atom` is a bare `did:key` DID: the method every principal this
 * runtime mints is named by, in DID Core syntax. A string of another method,
 * or a malformed one, is no principal's spelling and admits no reader, so it
 * stays as stored.
 */
const isBareDidAtom = (atom: unknown): atom is string =>
  isWellFormedDID(atom) && atom.startsWith("did:key:");

/** `atom` respelled as `User{subject}` when it is a bare DID. */
const respellAtom = (atom: CfcAtom): CfcAtom =>
  isBareDidAtom(atom) ? { type: CFC_ATOM_TYPE.User, subject: atom } : atom;

/** `values` without the later of any two that are equal. */
const withoutRepeats = <T>(values: readonly T[]): T[] =>
  values.filter((value, index) =>
    values.findIndex((earlier) =>
      valueEqual(earlier as FabricValue, value as FabricValue)
    ) === index
  );

/**
 * `clause` with every bare-DID atom respelled, as an atom or as an `anyOf`
 * alternative, or `clause` itself when it holds none. An alternative the
 * respelling makes equal to another is dropped, since it names no one the
 * other does not.
 */
const respellBareDidClause = (
  clause: CfcConfClause,
): CfcConfClause => {
  if (isOrClause(clause)) {
    if (!clause.anyOf.some(isBareDidAtom)) return clause;
    return { anyOf: withoutRepeats(clause.anyOf.map(respellAtom)) };
  }
  return respellAtom(clause as CfcAtom);
};

/**
 * `label` with its confidentiality respelled, or `undefined` when it holds no
 * bare-DID atom. Integrity is left as it is: its atoms name
 * subjects inside typed records, and nothing writes a bare DID there.
 */
const respellBareDidLabel = (
  label: unknown,
): Record<string, unknown> | undefined => {
  if (!isObjectNotArray(label)) return undefined;
  const confidentiality = label.confidentiality;
  if (!Array.isArray(confidentiality)) return undefined;
  let changed = false;
  const respelled = confidentiality.map((clause) => {
    const next = respellBareDidClause(clause as CfcConfClause);
    if (next !== clause) changed = true;
    return next;
  });
  return changed
    ? { ...label, confidentiality: withoutRepeats(respelled) }
    : undefined;
};

/**
 * The `cfc` member of a stored document with every label-map entry's label
 * respelled, or `undefined` when no entry needs it. Every origin is
 * respelled alike, and only the entry's `label` changes. An entry holding its
 * label by `cid:` reference, whose label document needs respelling, gets the
 * respelled label inline, which both envelope versions allow; the label
 * document stays as it is. `resolveLabel` returns the content of the label
 * document a `cid:` reference names.
 */
export const respellBareDidEnvelope = (
  cfc: unknown,
  resolveLabel: (ref: string) => unknown,
): Record<string, unknown> | undefined => {
  if (!isObjectNotArray(cfc)) return undefined;
  const labelMap = cfc.labelMap;
  if (!isObjectNotArray(labelMap) || !Array.isArray(labelMap.entries)) {
    return undefined;
  }
  let changed = false;
  const entries = labelMap.entries.map((entry: unknown) => {
    if (!isObjectNotArray(entry)) return entry;
    const respelled = respellBareDidLabel(
      resolveStoredLabel(entry.label, resolveLabel),
    );
    if (respelled === undefined) return entry;
    changed = true;
    return { ...entry, label: respelled };
  });
  return changed ? { ...cfc, labelMap: { ...labelMap, entries } } : undefined;
};

/** A scope a migration reaches, as its scope keys begin. */
export type MigrationScope = "space" | "user" | "session";

/** A one-shot rewrite of a store's documents. */
export interface DocumentMigration {
  /**
   * The migration's name: its `store_migration` row and its commits' session
   * id. A versioned name, such as `cfc-bare-did-respelling/1`, lets a fixed
   * migration run again under the next version.
   */
  readonly name: string;

  /** The scopes whose instances the migration reaches. */
  readonly scopes: readonly MigrationScope[];

  /**
   * The patches that rewrite `document`, or `undefined` when it needs none.
   * `readDocument` returns a document of the same branch at space scope,
   * such as a `cid:` document the instance names.
   */
  readonly rewrite: (
    document: EntityDocument,
    readDocument: (id: string) => EntityDocument | undefined,
  ) => PatchOp[] | undefined;
}

/** An instance the store refused to take the rewrite of. */
export interface SkippedInstance {
  readonly id: string;
  readonly scopeKey: string;
  readonly reason: string;
}

/** What one run did. */
export interface DocumentMigrationReport {
  /**
   * Whether the store holds the migration's row: it did before the run, or
   * the run reached every instance.
   */
  readonly done: boolean;

  /** How many instances the run rewrote. */
  readonly rewritten: number;

  /**
   * The instances the store refused the rewrite of, with the reasons. They
   * keep the labels they store, and no later run tries them again.
   */
  readonly skipped: readonly SkippedInstance[];
}

/** How many instances one commit rewrites. */
const BATCH_SIZE = 256;

/** The session id the commits of `migration` carry. */
export const migrationSessionId = (migration: DocumentMigration): string =>
  `store-migration:${migration.name}`;

/** Whether the store `engine` opens holds the row of the migration `name`. */
export const isMigrationDone = (
  engine: Engine.Engine,
  name: string,
): boolean => {
  engine.database.exec(`
CREATE TABLE IF NOT EXISTS store_migration (
  name          TEXT NOT NULL PRIMARY KEY,
  completed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
  return engine.prepare(`SELECT 1 FROM store_migration WHERE name = :name`)
    .get({ name }) !== undefined;
};

/**
 * Runs `migration` over the store `engine` opens, unless the store holds its
 * row, and writes the row once the walk has reached every instance.
 * `space` is the space the store holds, which each commit names.
 */
export const runDocumentMigration = async (
  engine: Engine.Engine,
  migration: DocumentMigration,
  options: { space?: string } = {},
): Promise<DocumentMigrationReport> => {
  if (isMigrationDone(engine, migration.name)) {
    return { done: true, rewritten: 0, skipped: [] };
  }
  const sessionId = migrationSessionId(migration);
  let localSeq = nextLocalSeq(engine, sessionId);
  const skipped: SkippedInstance[] = [];
  let rewritten = 0;

  // Reads each instance and commits its rewrite under the store's write
  // lock, so a write another process makes to the store between the two
  // cannot be overwritten. Returns how many instances it rewrote. The store
  // refusing the commit throws a `Refused`; a rewrite that throws is a fault
  // of the migration, and stops the run.
  const rewrite = (instances: readonly Instance[]): number =>
    Engine.runAtomicCommit(engine, (apply) => {
      const operations: PatchOperation[] = [];
      const scopeKeys = new Map<number, string>();
      for (const { id, scopeKey } of instances) {
        const patches = rewriteOf(engine, migration, id, scopeKey);
        if (patches === undefined) continue;
        const scope = scopeOfScopeKey(scopeKey);
        if (scope !== "space") scopeKeys.set(operations.length, scopeKey);
        operations.push({ op: "patch", id, scope, patches });
      }
      if (operations.length === 0) return 0;
      try {
        apply({
          sessionId,
          ...(options.space === undefined ? {} : { space: options.space }),
          commit: {
            localSeq: localSeq++,
            reads: { confirmed: [], pending: [] },
            operations,
          },
          commitClass: "system",
          scopeKeys,
        });
      } catch (error) {
        throw new Refused(error);
      }
      return operations.length;
    });

  for (const page of currentInstancePages(engine, migration.scopes)) {
    try {
      rewritten += rewrite(page);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      for (const instance of page) {
        try {
          rewritten += rewrite([instance]);
        } catch (error) {
          if (!(error instanceof Refused)) throw error;
          skipped.push({ ...instance, reason: error.message });
        }
      }
    }
    await yieldToEventLoop();
  }

  // The row is written once the walk has reached every instance, the
  // skipped ones included: one the store refuses to take the rewrite of
  // would refuse it again at every opening, and keeps the clause it stores.
  engine.prepare(
    `INSERT OR IGNORE INTO store_migration (name) VALUES (:name)`,
  ).run({ name: migration.name });
  return { done: true, rewritten, skipped };
};

/** The store's refusal of a migration's commit. */
class Refused extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** An instance of a document, as a scope key names it. */
interface Instance {
  readonly id: string;
  readonly scopeKey: string;
}

/**
 * The current instances of the default branch at `scopes`, a page at a
 * time, in primary-key order. A page is read when the walk reaches it, so an
 * instance a batch before it rewrote is read as rewritten.
 */
function* currentInstancePages(
  engine: Engine.Engine,
  scopes: readonly MigrationScope[],
): Generator<Instance[]> {
  // Session instances can outnumber the rest by a hundred to one in a
  // space used for long, so a walk that leaves them out skips them in the
  // query rather than reading each into a page to drop it.
  const sessions = scopes.includes("session")
    ? ""
    : `AND substr(scope_key, 1, 8) <> 'session:'`;
  const page = engine.prepare(`
SELECT id, scope_key FROM head
WHERE branch = :branch AND op <> 'delete' AND (id, scope_key) > (:id, :scopeKey)
${sessions}
ORDER BY id, scope_key
LIMIT :limit
`);
  let after = { id: "", scopeKey: "" };
  while (true) {
    const rows = page.all({
      branch: DEFAULT_BRANCH,
      id: after.id,
      scopeKey: after.scopeKey,
      limit: BATCH_SIZE,
    }) as Array<{ id: string; scope_key: string }>;
    if (rows.length === 0) return;
    const last = rows[rows.length - 1];
    after = { id: last.id, scopeKey: last.scope_key };
    yield rows
      .filter(({ scope_key }) =>
        scopes.includes(scopeOfScopeKey(scope_key) as MigrationScope)
      )
      .map(({ id, scope_key }) => ({ id, scopeKey: scope_key }));
  }
}

/**
 * The patches `migration` rewrites the instance `id` at `scopeKey` with, or
 * `undefined` when it needs none or is absent.
 */
const rewriteOf = (
  engine: Engine.Engine,
  migration: DocumentMigration,
  id: string,
  scopeKey: string,
): PatchOp[] | undefined => {
  const document = Engine.readState(engine, { id, scopeKey })?.document;
  if (document === null || document === undefined) return undefined;
  return migration.rewrite(document, (ref) => {
    const named = Engine.readState(engine, { id: ref })?.document;
    return named === null ? undefined : named;
  });
};

/**
 * The first local seq `sessionId` has not used, so a run after an
 * interrupted one commits under fresh `(session, localSeq)` pairs.
 */
const nextLocalSeq = (engine: Engine.Engine, sessionId: string): number =>
  (engine.prepare(`
SELECT COALESCE(MAX(local_seq), 0) AS seq FROM "commit"
WHERE session_id = :session
`).get({ session: sessionId }) as { seq: number }).seq + 1;
