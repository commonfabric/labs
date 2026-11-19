import { isPlainObject } from "@commonfabric/js-values/types";
import { getLogger } from "@commonfabric/logger";
import type { SqliteDbRef } from "@commonfabric/memory/v2";

import { type Cell, createCell } from "../../cell.ts";
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
  deleteMemberRows,
  type IndexedCollectionWriter,
  type IndexedColumnValue,
  type MemberRows,
  projectMember,
  sameMemberRows,
  writeMemberRows,
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
        if ("changes" in notification) {
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
    void state.loaded.then(() => {
      if (state.early.size === 0) return;
      const written = [...state.early];
      state.early.clear();
      for (const collection of state.collections.values()) {
        for (const id of written) {
          if (id !== collection.handle.id) collection.pending.add(id);
        }
        this.#schedule(collection);
      }
    });
  }

  /**
   * Returns a promise that settles once every write reported so far has been
   * carried into the collections it affects.
   */
  async settled(): Promise<void> {
    for (;;) {
      const waits: Promise<void>[] = [];
      for (const space of this.#spaces.values()) {
        if (space.loaded !== undefined && space.early.size > 0) {
          waits.push(space.loaded);
        }
        for (const collection of space.collections.values()) {
          if (collection.draining !== undefined) {
            waits.push(collection.draining);
          }
        }
      }
      if (waits.length === 0) return;
      await Promise.all(waits);
    }
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

  /** Reads the collections the space's registry lists. */
  async #loadRegistry(space: MemorySpace, state: SpaceState): Promise<void> {
    try {
      const registry = this.#registryCell(space);
      await registry.sync();
      const listed = registry.getRaw({ lastNode: "value" });
      if (!isPlainObject(listed)) return;
      for (const [id, link] of Object.entries(listed)) {
        if (state.collections.has(id)) continue;
        const handle = this.#runtime.getCellFromLink(
          parseCfLinkToSigil(link)!,
        );
        await handle.sync();
        this.#adopt(state, handle.getAsNormalizedFullLink(), id);
      }
    } catch (error) {
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

  #schedule(collection: CollectionState): void {
    if (collection.draining !== undefined || collection.pending.size === 0) {
      return;
    }
    const draining = this.#drain(collection).catch((error) => {
      if (!this.#disposed) {
        logger.warn("drain-failed", () => [collection.handle.id, error]);
      }
    }).finally(() => {
      collection.draining = undefined;
      if (!this.#disposed) this.#schedule(collection);
    });
    collection.draining = draining;
    // `runtime.settled()` waits for tracked work, which neither `idle()` nor
    // `synced()` covers.
    this.#runtime.trackAsyncWork(draining);
  }

  /** Carries the pending writes of one collection into its tables. */
  async #drain(collection: CollectionState): Promise<void> {
    const docs = [...collection.pending];
    collection.pending.clear();
    const handle = this.#runtime.getCellFromLink(collection.handle);
    await handle.sync();
    const value = handle.getRaw({ lastNode: "value" });
    const descriptor = indexedCollectionDescriptorOf(value);
    if (descriptor === undefined) return;
    const provider = this.#runtime.storageManager.open(collection.handle.space);
    if (provider.sqliteQuery === undefined) return;
    const { rows } = await provider.sqliteQuery(
      toDbRef(value),
      affectedRowsSql(descriptor),
      { docs: JSON.stringify(docs) },
    );
    if (this.#disposed) return;
    const members = groupMemberRows(descriptor, rows);
    if (members.length === 0) return;
    await Promise.all(
      members.map((rows) =>
        this.#runtime.getCellFromLink(parseCfLinkToSigil(rows.member)!).sync()
      ),
    );
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
    const db = createCell(this.#runtime, handle, tx, false, "sqlite");
    const descriptor = indexedCollectionDescriptorOf(
      db.getRaw({ lastNode: "value" }),
    );
    if (descriptor === undefined) return;
    const writer = db as unknown as IndexedCollectionWriter;
    for (const previous of event.members) {
      const member = this.#runtime.getCellFromLink(
        parseCfLinkToSigil(previous.member)!,
        undefined,
        tx,
      );
      const rows = projectMember(tx, descriptor, member);
      if (rows.member !== previous.member) {
        // A member added by the transaction that created it was stored
        // under a reference that has since resolved to another cell. Its
        // rows move to the reference other members hold to it.
        deleteMemberRows(writer, descriptor, previous.member);
        writeMemberRows(writer, descriptor, rows);
      } else if (!sameMemberRows(previous, rows)) {
        writeMemberRows(writer, descriptor, rows, previous);
      }
    }
  }
}

/** Helper for `#drain()`, which reads the wire form of a handle value. */
function toDbRef(handle: unknown): SqliteDbRef {
  const { id, tables, scope, owner } = handle as SqliteDbRef;
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
