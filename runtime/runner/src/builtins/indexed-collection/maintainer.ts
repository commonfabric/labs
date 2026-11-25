import { isPlainObject } from "@commonfabric/js-values/types";
import { getLogger } from "@commonfabric/logger";
import { isSqliteDbRef, type SqliteDbRef } from "@commonfabric/memory/v2";

import { type Cell, createSqliteWriter } from "../../cell.ts";
import { waveSettlementOf } from "../../executor/wave.ts";
import type { NormalizedFullLink } from "../../link-types.ts";
import type { Runtime } from "../../runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageSubscription,
  MemorySpace,
  StorageNotification,
} from "../../storage/interface.ts";
import { parseCfLinkToSigil } from "../sqlite/cf-link-codec.ts";
import {
  COLLECTION_META_TABLE,
  type IndexedCollectionDescriptor,
  indexedCollectionDescriptorOf,
  MEMBER_COLUMN,
  MEMBER_DEPS_TABLE,
  SOURCE_COLUMN,
  TARGET_COLUMN,
} from "./definition.ts";
import {
  type IndexedColumnValue,
  type MemberRows,
  moveMemberRows,
  projectMember,
  refreshMemberRows,
  sameMemberRows,
} from "./maintenance.ts";
import { indexedCollectionRegistry } from "./registry.ts";

const logger = getLogger("indexed-collection");

/** Members re-read per maintenance transaction. */
const MEMBERS_PER_EVENT = 50;

/**
 * How many times in a row a collection's withdrawn maintenance is asked
 * again before it waits for the next write.
 */
const WITHDRAWALS_OWED_AGAIN = 3;

/**
 * Which indexed collections a runtime keeps current: every collection the
 * registries of the spaces it hears of list, as well as those it declares or
 * writes (`"listed"`); only those it declares or writes (`"own"`); or none
 * (`"none"`).
 */
export type IndexedCollectionMaintenance = "listed" | "own" | "none";

/** What the maintainer holds for one indexed collection. */
interface CollectionState {
  /** The collection's database handle cell. */
  readonly handle: NormalizedFullLink;

  /** Stream the maintenance events are queued on. */
  readonly stream: NormalizedFullLink;

  /** Ids of documents written since the last drain started. */
  readonly pending: Set<string>;

  /**
   * Rows of members a handler added since the last drain started, as `add()`
   * stored them. The next drain re-reads each without asking the database
   * for it, which may not answer yet for a row written a moment ago.
   */
  readonly added: Map<string, MemberRows>;

  /** The drain in flight, if any. */
  draining: Promise<void> | undefined;

  /** Maintenance transactions withdrawn since one last landed. */
  withdrawn: number;

  /**
   * Settles once the tables have been brought up to the collection's
   * declaration, which every drain waits for.
   */
  reconciled: Promise<void>;

  /** Removes the maintenance event handler. */
  readonly cancel: () => void;
}

/** What the maintainer holds for one space. */
interface SpaceState {
  /** Collections by database id. */
  readonly collections: Map<string, CollectionState>;

  /** Ids written while the registry was loading. */
  readonly early: Set<string>;

  /** Settles once the space's registry of collections has been read. */
  loaded: Promise<void> | undefined;

  /** Whether the registry needs no reading, or has been read. */
  read: boolean;
}

/**
 * One maintenance event: members to re-read, with the rows they have now; or
 * a declaration to record in the collection's own database, under the key
 * given.
 */
type MaintenanceEvent =
  | { members: MemberRows[] }
  | { record: "migrating" | "declaration"; declaration: string };

/**
 * Keeps the tables of every indexed collection current with the cells they
 * mirror. It hears of each committed write, asks the collection's
 * `member_deps` table which members were read from the written documents, and
 * re-reads those members in a scheduler-run transaction that writes their
 * rows. A member none of whose rows changed is written nowhere, so such a
 * write leaves the database, and every query over it, untouched.
 *
 * When a collection's declaration differs from the one its tables were last
 * brought up to, every member is re-read once, which is what carries a
 * column or a relation added to the declaration into the rows of members
 * that are never written again.
 *
 * The mirror follows stored state: a member field computed by a derivation
 * is re-read when that derivation's result is written, not when its inputs
 * are. One runtime maintains the collections of a space: its serving runtime
 * under server execution, and otherwise the toolshed's
 * `IndexedCollectionHost`, or the one runtime of a process that has no
 * server. Every other runtime maintains nothing.
 */
export class IndexedCollectionMaintainer {
  readonly #runtime: Runtime;
  readonly #mode: IndexedCollectionMaintenance;
  readonly #enabled: boolean;
  readonly #spaces = new Map<MemorySpace, SpaceState>();

  /** Per space, what settles once its last queued event's wave has. */
  readonly #turns = new Map<MemorySpace, Promise<void>>();
  readonly #subscription: IStorageSubscription;
  #disposed = false;

  /**
   * Constructs an instance which maintains the collections of `runtime` that
   * `mode` names.
   */
  constructor(runtime: Runtime, mode: IndexedCollectionMaintenance) {
    this.#runtime = runtime;
    this.#mode = mode;
    this.#enabled = mode !== "none";
    this.#subscription = {
      next: (notification: StorageNotification) => {
        if (this.#disposed) return { done: true };
        // A load or a pull brings a document into this runtime without
        // anything having been written to it.
        if (
          notification.type === "commit" ||
          notification.type === "integrate" ||
          notification.type === "revert"
        ) {
          const ids = new Set<string>();
          for (const change of notification.changes) {
            ids.add(change.address.id);
          }
          this.noteWrites(notification.space, ids);
        }
        return { done: false };
      },
    };
    if (this.#enabled) runtime.storageManager.subscribe(this.#subscription);
  }

  /**
   * Records that `handle` is the database handle cell of an indexed
   * collection, so that writes to its members' documents reach it.
   */
  register(handle: NormalizedFullLink, id: string): void {
    if (!this.#enabled || this.#disposed) return;
    const space = this.#spaceState(handle.space);
    if (space.collections.has(id)) return;
    this.#adopt(space, handle, id);
  }

  /**
   * Reports that a handler's transaction, now committed, added the member
   * `rows` describes to the collection with database `id`. The member is
   * re-read: a piece the handler made is set up as its transaction ends,
   * after `add()` read it, so the rows stored for it hold nothing yet and
   * name none of the documents the piece is made of.
   */
  noteAdded(space: MemorySpace, id: string, rows: MemberRows): void {
    if (!this.#enabled || this.#disposed) return;
    const collection = this.#spaceState(space).collections.get(id);
    if (collection === undefined) return;
    collection.added.set(memberId(rows), rows);
    this.#schedule(collection);
  }

  /**
   * Reports that the documents `ids` of `space` were written. Collections
   * whose members were read from one of them re-read those members.
   */
  noteWrites(space: MemorySpace, ids: Iterable<string>): void {
    if (!this.#enabled || this.#disposed) return;
    const state = this.#spaceState(space);
    // A space with no collection has nothing to follow. A runtime that
    // maintains listed collections knows that once the registry has been
    // read; any other, at once.
    if (state.collections.size === 0 && state.read) return;
    for (const id of ids) state.early.add(id);
    if (state.read) return this.#flush(state);
    // The registry read is not tracked as async work of the runtime: only a
    // drain is, and a space that lists nothing starts none.
    state.loaded ??= this.#loadRegistry(space, state).then((read) => {
      state.read = read;
      if (!read) state.loaded = undefined;
    });
    // Writes stay held while the registry could not be read, for the read
    // the next write starts.
    void state.loaded.then(() => {
      if (state.read) this.#flush(state);
    });
  }

  /** Hands the writes held for a space to each of its collections. */
  #flush(state: SpaceState): void {
    if (state.early.size === 0 || this.#disposed) return;
    const written = [...state.early];
    state.early.clear();
    for (const collection of state.collections.values()) {
      for (const id of written) {
        if (id !== collection.handle.id) collection.pending.add(id);
      }
      this.#schedule(collection);
    }
  }

  /** Stops maintaining. Writes reported afterward are dropped. */
  dispose(): void {
    this.#disposed = true;
    if (this.#enabled) {
      this.#runtime.storageManager.unsubscribe?.(this.#subscription);
    }
    for (const space of this.#spaces.values()) {
      for (const collection of space.collections.values()) collection.cancel();
    }
    this.#spaces.clear();
  }

  #spaceState(space: MemorySpace): SpaceState {
    let state = this.#spaces.get(space);
    if (state === undefined) {
      state = {
        collections: new Map(),
        early: new Set(),
        loaded: undefined,
        // Only a runtime that maintains listed collections maintains one
        // whose declaring piece it never loaded, so only it reads the
        // registry.
        read: this.#mode !== "listed",
      };
      this.#spaces.set(space, state);
    }
    return state;
  }

  /**
   * Reads the collections the space's registry lists, and returns whether it
   * could. After a failure the next write to the space reads it again.
   */
  async #loadRegistry(space: MemorySpace, state: SpaceState): Promise<boolean> {
    try {
      const registry = indexedCollectionRegistry(this.#runtime, space);
      // Asked without loading the document: a space that holds no collection
      // has no registry, and takes on no watch of one.
      const listed = await this.#runtime.storageManager.open(space)
        .entityIdExists?.(registry.getAsNormalizedFullLink().id);
      if (listed !== true) return true;
      await registry.sync();
      const entries = registry.getRaw({ lastNode: "value" });
      if (!isPlainObject(entries)) return true;
      for (const [id, link] of Object.entries(entries)) {
        if (state.collections.has(id)) continue;
        try {
          const sigil = parseCfLinkToSigil(link);
          if (sigil === null) continue;
          const handle = this.#runtime.getCellFromLink(sigil);
          await handle.sync();
          this.#adopt(state, handle.getAsNormalizedFullLink(), id);
        } catch (error) {
          logger.warn("registry-entry-unreadable", () => [space, id, error]);
        }
      }
      return true;
    } catch (error) {
      logger.warn("registry-load-failed", () => [space, error]);
      return false;
    }
  }

  #adopt(
    space: SpaceState,
    handle: NormalizedFullLink,
    id: string,
  ): CollectionState {
    const stream = this.#runtime.getCell(handle.space, {
      indexedCollectionMaintenance: id,
    }).getAsNormalizedFullLink();
    const collection: CollectionState = {
      handle,
      stream,
      pending: new Set(),
      added: new Map(),
      draining: undefined,
      withdrawn: 0,
      reconciled: Promise.resolve(),
      cancel: this.#runtime.scheduler.addEventHandler(
        (tx: IExtendedStorageTransaction, event: MaintenanceEvent) =>
          this.#maintain(tx, handle, event),
        stream,
      ),
    };
    space.collections.set(id, collection);
    collection.reconciled = this.#reconcile(collection).catch((error) => {
      if (!this.#disposed) {
        logger.warn("reconcile-failed", () => [handle.id, error]);
      }
    });
    this.#runtime.trackAsyncWork(collection.reconciled);
    return collection;
  }

  /** Reads the handle of `collection`, as a database and as a declaration. */
  async #open(collection: CollectionState): Promise<
    | { db: SqliteDbRef; descriptor: IndexedCollectionDescriptor }
    | undefined
  > {
    const handle = this.#runtime.getCellFromLink(collection.handle);
    await handle.sync();
    const value: unknown = handle.getRaw({ lastNode: "value" });
    const descriptor = indexedCollectionDescriptorOf(value);
    if (descriptor === undefined || !isSqliteDbRef(value)) return undefined;
    return { db: toDbRef(value), descriptor };
  }

  /**
   * Queues `event` for `collection` and waits for its transaction to end.
   *
   * A serving runtime commits in waves. A wave carries the transactions that
   * ended together, a commit may write one database only, and a wave that is
   * refused takes every transaction in it along. So the events of a space go
   * one at a time, each after the wave of the one before has settled, and an
   * event whose transaction a wave withdrew is owed again.
   */
  async #dispatch(
    collection: CollectionState,
    event: MaintenanceEvent,
  ): Promise<void> {
    const space = collection.handle.space;
    const before = this.#turns.get(space);
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
    this.#turns.set(space, settled);
    await before;
    const { promise: ended, resolve: end } = Promise.withResolvers<void>();
    this.#runtime.scheduler.queueEvent(
      collection.stream,
      event,
      true,
      (tx) => {
        end();
        const settlement = waveSettlementOf(tx);
        if (settlement === undefined) return settle();
        void settlement.then((verdict) => {
          settle();
          if (verdict.error) {
            this.#owe(collection, event);
          } else {
            collection.withdrawn = 0;
          }
        });
      },
    );
    await ended;
  }

  /**
   * Makes `event`, whose transaction was withdrawn, owed again. Members are
   * owed through the documents they were read from, so that the drain asks
   * the database what it holds for them now rather than trusting the rows
   * the event carried. Past `WITHDRAWALS_OWED_AGAIN` withdrawals with no
   * transaction landing between them, what is owed waits for the drain the
   * next write to the space starts: a refusal that repeats is not one to
   * answer by asking again.
   */
  #owe(collection: CollectionState, event: MaintenanceEvent): void {
    if (this.#disposed) return;
    const again = ++collection.withdrawn <= WITHDRAWALS_OWED_AGAIN;
    if (!again) {
      logger.warn("maintenance-withdrawn", () => [collection.handle.id]);
    }
    if ("record" in event) {
      if (again) void this.#dispatch(collection, event);
      return;
    }
    for (const rows of event.members) {
      for (const doc of rows.deps) collection.pending.add(doc);
    }
    if (again) this.#schedule(collection);
  }

  /** Re-reads `members` of `collection`, a batch per transaction. */
  async #reread(
    collection: CollectionState,
    members: readonly MemberRows[],
  ): Promise<void> {
    await Promise.all(members.map((rows) => this.#memberCell(rows).sync()));
    for (let start = 0; start < members.length; start += MEMBERS_PER_EVENT) {
      if (this.#disposed) return;
      await this.#dispatch(collection, {
        members: members.slice(start, start + MEMBERS_PER_EVENT),
      });
    }
  }

  /**
   * Brings the tables of `collection` up to its declaration, when the
   * database records another one or none. The first write creates whatever
   * table, column or index the declaration has gained, and every member is
   * then re-read. The declaration is recorded last, so an interrupted pass is
   * made again by the next runtime that adopts the collection.
   */
  async #reconcile(collection: CollectionState): Promise<void> {
    const opened = await this.#open(collection);
    const provider = this.#runtime.storageManager.open(
      collection.handle.space,
    );
    if (opened === undefined || provider.sqliteQuery === undefined) return;
    const declaration = JSON.stringify(opened.descriptor);
    const recorded = await provider.sqliteQuery(
      opened.db,
      `SELECT value FROM ${COLLECTION_META_TABLE} WHERE key = 'declaration'`,
    );
    const [row] = recorded.rows as { value?: unknown }[];
    if (this.#disposed || row?.value === declaration) return;
    await this.#dispatch(collection, { record: "migrating", declaration });
    const { rows } = await provider.sqliteQuery(
      opened.db,
      memberRowsSql(opened.descriptor, allMembersSql(opened.descriptor)),
    );
    await this.#reread(collection, groupMemberRows(opened.descriptor, rows));
    if (this.#disposed) return;
    await this.#dispatch(collection, { record: "declaration", declaration });
  }

  /** Returns the member cell `rows` is stored under. */
  #memberCell(
    rows: MemberRows,
    tx?: IExtendedStorageTransaction,
  ): Cell<unknown> {
    const sigil = parseCfLinkToSigil(rows.member);
    if (sigil === null) {
      throw new TypeError("an indexed collection row names no member");
    }
    return this.#runtime.getCellFromLink(sigil, undefined, tx);
  }

  #schedule(collection: CollectionState): void {
    if (
      collection.draining !== undefined ||
      (collection.pending.size === 0 && collection.added.size === 0)
    ) {
      return;
    }
    const draining = this.#drain(collection).catch((error) => {
      if (!this.#disposed) {
        logger.warn("drain-failed", () => [collection.handle.id, error]);
      }
      // A failed drain keeps what it owes for the drain the next write
      // starts, and is not started again by itself.
      return false;
    }).then((drained) => {
      collection.draining = undefined;
      if (drained !== false && !this.#disposed) this.#schedule(collection);
    });
    collection.draining = draining;
    // `runtime.settled()` waits for tracked work, which neither `idle()` nor
    // `synced()` covers.
    this.#runtime.trackAsyncWork(draining);
  }

  /**
   * Carries the pending writes of one collection into its tables. A failure
   * before every affected member was re-read leaves the writes owed, so that the next
   * drain of this collection asks about them again.
   */
  async #drain(collection: CollectionState): Promise<void> {
    await collection.reconciled;
    const docs = [...collection.pending];
    collection.pending.clear();
    const added = [...collection.added.values()];
    collection.added.clear();
    // What this drain took is owed again if it cannot be carried out.
    const owe = () => {
      for (const doc of docs) collection.pending.add(doc);
      for (const rows of added) {
        if (!collection.added.has(memberId(rows))) {
          collection.added.set(memberId(rows), rows);
        }
      }
    };
    try {
      const opened = await this.#open(collection);
      const provider = this.#runtime.storageManager.open(
        collection.handle.space,
      );
      if (opened === undefined || provider.sqliteQuery === undefined) return;
      const { rows } = await provider.sqliteQuery(
        opened.db,
        memberRowsSql(opened.descriptor, AFFECTED_MEMBERS_SQL),
        { docs: JSON.stringify(docs) },
      );
      const members = groupMemberRows(opened.descriptor, rows);
      const found = new Set(members.map(memberId));
      for (const rows of added) {
        if (!found.has(memberId(rows))) members.push(rows);
      }
      await this.#reread(collection, members);
    } catch (error) {
      owe();
      throw error;
    }
  }

  /**
   * Runs one maintenance event: records a declaration in the collection's
   * database, or re-reads the members the event names and writes the rows
   * that changed.
   */
  #maintain(
    tx: IExtendedStorageTransaction,
    handle: NormalizedFullLink,
    event: MaintenanceEvent,
  ): void {
    const writer = createSqliteWriter(this.#runtime, handle, tx);
    if ("record" in event) {
      writer.exec(
        `INSERT INTO ${COLLECTION_META_TABLE} (key, value) VALUES (?, ?) ` +
          "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [event.record, event.declaration],
      );
      return;
    }
    const descriptor = indexedCollectionDescriptorOf(
      this.#runtime.getCellFromLink(handle, undefined, tx).getRaw({
        lastNode: "value",
      }),
    );
    if (descriptor === undefined) return;
    for (const previous of event.members) {
      // One member that cannot be read leaves the others of its batch to be
      // written.
      try {
        if (!Object.hasOwn(descriptor.kinds, previous.kind)) continue;
        const kind = descriptor.kinds[previous.kind];
        const rows = projectMember(
          tx,
          previous.kind,
          kind,
          this.#memberCell(previous, tx),
        );
        if (rows.member !== previous.member) {
          // A member added by the transaction that created it was stored
          // under a reference that has since resolved to another cell. Its
          // rows move to the reference other members hold to it.
          moveMemberRows(writer, kind, previous.member, rows);
        } else if (!sameMemberRows(previous, rows)) {
          refreshMemberRows(writer, kind, rows, previous);
        }
      } catch (error) {
        logger.warn("member-unreadable", () => [previous.member, error]);
      }
    }
  }
}

/**
 * Returns what tells one member's rows from another's: its kind and its
 * reference together, since one cell can be a member of several kinds.
 */
function memberId(rows: MemberRows): string {
  return `${rows.kind}\n${rows.member}`;
}

/** Helper for `#drain()`, which reads the wire form of a handle value. */
function toDbRef(handle: SqliteDbRef): SqliteDbRef {
  const { id, tables, scope, owner } = handle;
  return {
    id,
    ...(tables !== undefined && { tables }),
    ...(scope !== undefined && { scope }),
    ...(owner !== undefined && { owner }),
  };
}

/** Quotes an identifier the collection's declaration already validated. */
function q(name: string): string {
  return `"${name}"`;
}

/**
 * Subquery returning the `kind` and reference `k` of every member read from
 * a document in the `:docs` JSON list.
 */
const AFFECTED_MEMBERS_SQL = `SELECT DISTINCT kind, ${
  q(MEMBER_COLUMN)
} AS k FROM ${
  q(MEMBER_DEPS_TABLE)
} WHERE doc IN (SELECT value FROM json_each(:docs))`;

/**
 * Returns the subquery returning the `kind` and reference `k` of every
 * member the collection holds.
 */
function allMembersSql(descriptor: IndexedCollectionDescriptor): string {
  return Object.entries(descriptor.kinds).map(([kind, { table }]) =>
    `SELECT '${kind}' AS kind, ${q(MEMBER_COLUMN)} AS k FROM ${q(table)}`
  ).join(" UNION ALL ");
}

/**
 * Returns the query that selects every row the collection holds for the
 * members `selection` returns: part `0` carries a member's column values as a
 * JSON list, part `n` a reference of the relation at position `n - 1`, and
 * part `-1` a document the member was read from.
 */
function memberRowsSql(
  descriptor: IndexedCollectionDescriptor,
  selection: string,
): string {
  const arms = Object.entries(descriptor.kinds).flatMap(([kind, own]) => {
    const selected = `SELECT k FROM selected WHERE kind = '${kind}'`;
    return [
      `SELECT '${kind}' AS kind, 0 AS part, ${
        q(MEMBER_COLUMN)
      } AS member, json_array(${own.columns.map(q).join(", ")}) AS value FROM ${
        q(own.table)
      } WHERE ${q(MEMBER_COLUMN)} IN (${selected})`,
      ...own.relations.map((name, at) =>
        `SELECT '${kind}', ${at + 1}, ${q(SOURCE_COLUMN)}, ${
          q(TARGET_COLUMN)
        } FROM ${q(own.relationTables[name])} WHERE ${
          q(SOURCE_COLUMN)
        } IN (${selected})`
      ),
      `SELECT kind, -1, ${q(MEMBER_COLUMN)}, doc FROM ${
        q(MEMBER_DEPS_TABLE)
      } WHERE kind = '${kind}' AND ${q(MEMBER_COLUMN)} IN (${selected})`,
    ];
  });
  return `WITH selected AS (${selection}) ${arms.join(" UNION ALL ")}`;
}

/** Helper for the maintainer, which gathers the rows of `memberRowsSql()`. */
function groupMemberRows(
  descriptor: IndexedCollectionDescriptor,
  rows: readonly unknown[],
): MemberRows[] {
  const members = new Map<string, MemberRows>();
  for (const row of rows) {
    const { kind, part, member, value } = row as {
      kind: string;
      part: number;
      member: string;
      value: string;
    };
    const key = `${kind}\n${member}`;
    let entry = members.get(key);
    if (entry === undefined) {
      entry = {
        kind,
        member,
        values: descriptor.kinds[kind].columns.map(() => null),
        relations: descriptor.kinds[kind].relations.map(() => []),
        deps: [],
      };
      members.set(key, entry);
    }
    if (part === 0) {
      entry.values = JSON.parse(value) as IndexedColumnValue[];
    } else if (part === -1) {
      entry.deps.push(value);
    } else {
      entry.relations[part - 1].push(value);
    }
  }
  return [...members.values()];
}
