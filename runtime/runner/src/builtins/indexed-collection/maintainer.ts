import { isPlainObject } from "@commonfabric/js-values/types";
import { getLogger } from "@commonfabric/logger";
import { isSqliteDbRef, type SqliteDbRef } from "@commonfabric/memory/v2";

import { type Cell, createSqliteWriter } from "../../cell.ts";
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
  type IndexedCollectionDescriptor,
  indexedCollectionDescriptorOf,
  MEMBER_COLUMN,
  MEMBER_DEPS_TABLE,
  MEMBERS_TABLE,
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

const logger = getLogger("indexed-collection");

/** Members re-read per maintenance transaction. */
const MEMBERS_PER_EVENT = 50;

/** Cause of the per-space cell listing the space's indexed collections. */
const REGISTRY_CAUSE = "indexed-collection-registry";

/** What the maintainer holds for one indexed collection. */
interface CollectionState {
  /** The collection's database handle cell. */
  readonly handle: NormalizedFullLink;

  /** Stream the maintenance events are queued on. */
  readonly stream: NormalizedFullLink;

  /** Ids of documents written since the last drain started. */
  readonly pending: Set<string>;

  /** The drain in flight, if any. */
  draining: Promise<void> | undefined;

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
}

/**
 * One maintenance event: either members to re-read, with the rows they have
 * now, or the id of a collection to list in its space's registry.
 */
type MaintenanceEvent = { members: MemberRows[] } | { list: string };

/**
 * Keeps the tables of every indexed collection current with the cells they
 * mirror. It hears of each committed write, asks the collection's
 * `member_deps` table which members were read from the written documents, and
 * re-reads those members in a scheduler-run transaction that writes their
 * rows. A member none of whose rows changed is written nowhere, so such a
 * write leaves the database, and every query over it, untouched.
 *
 * The mirror follows stored state: a member field computed by a derivation
 * is re-read when that derivation's result is written, not when its inputs
 * are. A runtime that executes nothing it stores, a client under server
 * execution, maintains nothing.
 */
export class IndexedCollectionMaintainer {
  readonly #runtime: Runtime;
  readonly #enabled: boolean;
  readonly #spaces = new Map<MemorySpace, SpaceState>();
  readonly #subscription: IStorageSubscription;
  #disposed = false;

  /** Constructs an instance which maintains the collections of `runtime`. */
  constructor(runtime: Runtime) {
    this.#runtime = runtime;
    this.#enabled = runtime.experimental.serverExecution !== true ||
      runtime.servingPosture;
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
   * collection, so that writes to its members' documents reach it, and lists
   * it in its space's registry for the runtimes that serve the space later.
   */
  register(handle: NormalizedFullLink, id: string): void {
    if (!this.#enabled || this.#disposed) return;
    const space = this.#spaceState(handle.space);
    if (space.collections.has(id)) return;
    const collection = this.#adopt(space, handle, id);
    // Listing the collection is a write, which a serving runtime commits
    // only from a scheduler run.
    this.#runtime.scheduler.queueEvent(collection.stream, { list: id });
  }

  /**
   * Reports that the documents `ids` of `space` were written. Collections
   * whose members were read from one of them re-read those members.
   */
  noteWrites(space: MemorySpace, ids: Iterable<string>): void {
    if (!this.#enabled || this.#disposed) return;
    const state = this.#spaceState(space);
    if (state.loaded === undefined) {
      state.loaded = this.#loadRegistry(space, state);
    }
    for (const id of ids) state.early.add(id);
    // Tracked so that `runtime.settled()` waits for the registry as well as
    // for the drains this starts.
    this.#runtime.trackAsyncWork(state.loaded.then(() => {
      if (state.early.size === 0) return;
      const written = [...state.early];
      state.early.clear();
      for (const collection of state.collections.values()) {
        for (const id of written) {
          if (id !== collection.handle.id) collection.pending.add(id);
        }
        this.#schedule(collection);
      }
    }));
  }

  /** Stops maintaining. Writes reported afterward are dropped. */
  dispose(): void {
    this.#disposed = true;
    for (const space of this.#spaces.values()) {
      for (const collection of space.collections.values()) collection.cancel();
    }
    this.#spaces.clear();
  }

  #spaceState(space: MemorySpace): SpaceState {
    let state = this.#spaces.get(space);
    if (state === undefined) {
      state = { collections: new Map(), early: new Set(), loaded: undefined };
      this.#spaces.set(space, state);
    }
    return state;
  }

  #registryCell(space: MemorySpace): Cell<Record<string, unknown>> {
    return this.#runtime.getCell<Record<string, unknown>>(
      space,
      REGISTRY_CAUSE,
    );
  }

  /**
   * Reads the collections the space's registry lists, in a serving runtime.
   * A failure leaves the registry unread, so that the next write to the space
   * reads it again.
   */
  async #loadRegistry(space: MemorySpace, state: SpaceState): Promise<void> {
    // Only a serving runtime maintains a collection whose declaring piece it
    // never loaded. Any other runtime knows a collection from having declared
    // or written it.
    if (!this.#runtime.servingPosture) return;
    try {
      const registry = this.#registryCell(space);
      // Asked without loading the document: a space that holds no collection
      // has no registry, and takes on no watch of one.
      const listed = await this.#runtime.storageManager.open(space)
        .entityIdExists?.(registry.getAsNormalizedFullLink().id);
      if (listed !== true) return;
      await registry.sync();
      const entries = registry.getRaw({ lastNode: "value" });
      if (!isPlainObject(entries)) return;
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
    } catch (error) {
      state.loaded = undefined;
      logger.warn("registry-load-failed", () => [space, error]);
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
      draining: undefined,
      cancel: this.#runtime.scheduler.addEventHandler(
        (tx: IExtendedStorageTransaction, event: MaintenanceEvent) =>
          this.#maintain(tx, handle, event),
        stream,
      ),
    };
    space.collections.set(id, collection);
    return collection;
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
    if (collection.draining !== undefined || collection.pending.size === 0) {
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
   * before the members are known leaves the writes owed, so that the next
   * drain of this collection asks about them again.
   */
  async #drain(collection: CollectionState): Promise<void> {
    const docs = [...collection.pending];
    collection.pending.clear();
    let descriptor: IndexedCollectionDescriptor | undefined;
    let members: MemberRows[];
    try {
      const handle = this.#runtime.getCellFromLink(collection.handle);
      await handle.sync();
      const value: unknown = handle.getRaw({ lastNode: "value" });
      descriptor = indexedCollectionDescriptorOf(value);
      if (descriptor === undefined || !isSqliteDbRef(value)) return;
      const provider = this.#runtime.storageManager.open(
        collection.handle.space,
      );
      if (provider.sqliteQuery === undefined) return;
      const { rows } = await provider.sqliteQuery(
        toDbRef(value),
        affectedRowsSql(descriptor),
        { docs: JSON.stringify(docs) },
      );
      members = groupMemberRows(descriptor, rows);
      await Promise.all(members.map((rows) => this.#memberCell(rows).sync()));
    } catch (error) {
      for (const doc of docs) collection.pending.add(doc);
      throw error;
    }
    for (let start = 0; start < members.length; start += MEMBERS_PER_EVENT) {
      if (this.#disposed) return;
      const event: MaintenanceEvent = {
        members: members.slice(start, start + MEMBERS_PER_EVENT),
      };
      const { promise, resolve } = Promise.withResolvers<void>();
      this.#runtime.scheduler.queueEvent(
        collection.stream,
        event,
        true,
        () => resolve(),
      );
      await promise;
    }
  }

  /**
   * Runs one maintenance event: lists the collection in its space's
   * registry, or re-reads the members the event names and writes the rows
   * that changed.
   */
  #maintain(
    tx: IExtendedStorageTransaction,
    handle: NormalizedFullLink,
    event: MaintenanceEvent,
  ): void {
    if ("list" in event) {
      const entry = this.#registryCell(handle.space).withTx(tx).key(
        event.list,
      );
      if (entry.getRaw() === undefined) {
        entry.setRaw(
          JSON.stringify(this.#runtime.getCellFromLink(handle).getAsLink()),
        );
      }
      return;
    }
    const descriptor = indexedCollectionDescriptorOf(
      this.#runtime.getCellFromLink(handle, undefined, tx).getRaw({
        lastNode: "value",
      }),
    );
    if (descriptor === undefined) return;
    const writer = createSqliteWriter(this.#runtime, handle, tx);
    for (const previous of event.members) {
      // One member that cannot be read leaves the others of its batch to be
      // written.
      try {
        const rows = projectMember(
          tx,
          descriptor,
          this.#memberCell(previous, tx),
        );
        if (rows.member !== previous.member) {
          // A member added by the transaction that created it was stored
          // under a reference that has since resolved to another cell. Its
          // rows move to the reference other members hold to it.
          moveMemberRows(writer, descriptor, previous.member, rows);
        } else if (!sameMemberRows(previous, rows)) {
          refreshMemberRows(writer, descriptor, rows, previous);
        }
      } catch (error) {
        logger.warn("member-unreadable", () => [previous.member, error]);
      }
    }
  }
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

/**
 * Returns the query that selects, for the members read from any document in
 * the `:docs` JSON list, every row the collection holds: part `0` carries a
 * member's column values as a JSON list, part `n` a reference of the
 * relation at position `n - 1`, and part `-1` a document the member was read
 * from.
 */
function affectedRowsSql(descriptor: IndexedCollectionDescriptor): string {
  const q = (name: string) => `"${name}"`;
  const affected = `SELECT k FROM affected`;
  const arms = [
    `SELECT 0 AS part, k AS member, json_array(${
      descriptor.columns.map(q).join(", ")
    }) AS value FROM affected LEFT JOIN ${q(MEMBERS_TABLE)} ON ${
      q(MEMBER_COLUMN)
    } = k`,
    ...descriptor.relations.map((name, at) =>
      `SELECT ${at + 1}, ${q(SOURCE_COLUMN)}, ${q(TARGET_COLUMN)} FROM ${
        q(name)
      } WHERE ${q(SOURCE_COLUMN)} IN (${affected})`
    ),
    `SELECT -1, ${q(MEMBER_COLUMN)}, doc FROM ${q(MEMBER_DEPS_TABLE)} WHERE ${
      q(MEMBER_COLUMN)
    } IN (${affected})`,
  ];
  return `WITH affected AS (SELECT DISTINCT ${q(MEMBER_COLUMN)} AS k FROM ${
    q(MEMBER_DEPS_TABLE)
  } WHERE doc IN (SELECT value FROM json_each(:docs))) ${
    arms.join(" UNION ALL ")
  }`;
}

/** Helper for `#drain()`, which gathers the rows of `affectedRowsSql()`. */
function groupMemberRows(
  descriptor: IndexedCollectionDescriptor,
  rows: readonly unknown[],
): MemberRows[] {
  const members = new Map<string, MemberRows>();
  const of = (member: string): MemberRows => {
    let entry = members.get(member);
    if (entry === undefined) {
      entry = {
        member,
        values: descriptor.columns.map(() => null),
        relations: descriptor.relations.map(() => []),
        deps: [],
      };
      members.set(member, entry);
    }
    return entry;
  };
  for (const row of rows) {
    const { part, member, value } = row as {
      part: number;
      member: string;
      value: string;
    };
    const entry = of(member);
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
