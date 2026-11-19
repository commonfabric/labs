/**
 * Reads what an indexed collection mirrors of one member, and writes that
 * member's rows. Both halves run inside the caller's transaction: the reads
 * are ordinary cell reads, so the transaction's flow labels cover what the
 * rows are derived from, and the writes are `db.exec()` calls that commit
 * with it.
 */

import type { Cell } from "../../cell.ts";
import { portableSnapshotId } from "../../data-uri.ts";
import type { JSONSchema } from "../../builder/types.ts";
import { createSigilLinkFromParsedLink } from "../../link-utils.ts";
import type { IExtendedStorageTransaction } from "../../storage/interface.ts";
import {
  type IndexedCollectionDescriptor,
  indexedFieldPath,
  MEMBER_COLUMN,
  MEMBER_DEPS_TABLE,
  MEMBERS_TABLE,
  SOURCE_COLUMN,
  TARGET_COLUMN,
} from "./definition.ts";

/** A value a mirrored column holds. */
export type IndexedColumnValue = string | number | null;

/** What a collection's tables hold, or should hold, for one member. */
export interface MemberRows {
  /** The member's reference, as its `member_cf_link` column stores it. */
  member: string;

  /** Column values, in the descriptor's column order. */
  values: IndexedColumnValue[];

  /** Referenced cells per relation, in the descriptor's relation order. */
  relations: string[][];

  /** Ids of the documents the values and references were read from. */
  deps: string[];
}

/** The write half of a database handle cell. */
export interface IndexedCollectionWriter {
  /** Records one SQLite write onto the handle's transaction. */
  exec(sql: string, params?: ReadonlyArray<unknown>): void;
}

/** Schema reading a relation field as cells, without reading their contents. */
const RELATION_SCHEMA = {
  type: "array",
  items: { asCell: ["cell"] },
} as const satisfies JSONSchema;

/**
 * Returns the reference `cell` is stored and looked up under: the absolute
 * link of the cell it resolves to, holding its space, id, scope and path and
 * nothing else. Two references to one cell therefore agree, whatever each
 * was reached through and whatever else its link carries.
 */
export function memberKeyOf(cell: Cell<unknown>): string {
  return keyOfLink(cell.resolveAsCell());
}

/**
 * Returns every reference `cell` may be stored under: the one it resolves to,
 * and its own where that differs. A member added by the transaction that
 * created it is stored under its own until its first re-read.
 */
export function memberKeysOf(cell: Cell<unknown>): string[] {
  return [...new Set([memberKeyOf(cell), keyOfLink(cell)])];
}

/** Helper for the key functions, which encodes the address of `cell`. */
function keyOfLink(cell: Cell<unknown>): string {
  const { id, space, scope, path } = cell.getAsNormalizedFullLink();
  return JSON.stringify(
    createSigilLinkFromParsedLink(
      { id: portableSnapshotId(id), space, scope, path },
      { includeSchema: false },
    ),
  );
}

/**
 * Reads `member`'s mirrored fields through `tx` and returns the rows they
 * amount to. A column field holding anything but a string, a finite number,
 * or a boolean reads as `null`; a boolean reads as `0` or `1`. A relation
 * field holds a list of cell references, in which a repeated one counts
 * once, or a single reference, or nothing. A field that is absent, on a
 * member or anywhere along a nested path, reads as `null` or as empty. `deps` names every document the reads
 * touched, the member's own included.
 */
export function projectMember(
  tx: IExtendedStorageTransaction,
  descriptor: IndexedCollectionDescriptor,
  member: Cell<unknown>,
): MemberRows {
  const firstRead = countReads(tx);
  const bound = member.withTx(tx);
  const resolved = bound.resolveAsCell();
  const key = memberKeyOf(resolved);
  const field = (name: string): Cell<unknown> =>
    indexedFieldPath(descriptor, name).reduce<Cell<unknown>>(
      (cell, key) => (cell as Cell<Record<string, unknown>>).key(key),
      resolved,
    );
  const values = descriptor.columns.map((name) =>
    toColumnValue(field(name).get())
  );
  const relations = descriptor.relations.map((name) => {
    const targets = field(name).asSchema(RELATION_SCHEMA).get() as unknown;
    if (Array.isArray(targets)) {
      const keys = new Set<string>();
      for (const target of targets as Cell<unknown>[]) {
        keys.add(memberKeyOf(target.withTx(tx)));
      }
      return [...keys];
    }
    // A field that is not a list holds one reference, or nothing.
    const single = field(name).resolveAsCell();
    const held = single.getRaw();
    return held === undefined || held === null ? [] : [memberKeyOf(single)];
  });
  const deps = new Set<string>([
    bound.getAsNormalizedFullLink().id,
    resolved.getAsNormalizedFullLink().id,
  ]);
  let position = 0;
  for (const read of tx.tx.getReadActivities?.() ?? []) {
    if (position++ >= firstRead) deps.add(read.id);
  }
  return { member: key, values, relations, deps: [...deps] };
}

/**
 * Whether `next` holds what `previous` holds. References and dependencies
 * compare as sets, since a table returns its rows in no fixed order.
 */
export function sameMemberRows(
  previous: MemberRows | undefined,
  next: MemberRows,
): boolean {
  if (previous === undefined) return false;
  return sameList(previous.values, next.values) &&
    previous.relations.length === next.relations.length &&
    previous.relations.every((targets, at) =>
      sameSet(targets, next.relations[at])
    ) &&
    sameSet(previous.deps, next.deps);
}

/**
 * Writes `rows` as the rows of a member being added, over whatever `db` holds
 * for it.
 */
export function addMemberRows(
  db: IndexedCollectionWriter,
  descriptor: IndexedCollectionDescriptor,
  rows: MemberRows,
): void {
  const columns = [MEMBER_COLUMN, ...descriptor.columns].map(quote);
  db.exec(
    `INSERT INTO ${quote(MEMBERS_TABLE)} (${columns.join(", ")}) VALUES (${
      columns.map(() => "?").join(", ")
    }) ON CONFLICT (${quote(MEMBER_COLUMN)}) ${onConflict(descriptor)}`,
    [rows.member, ...rows.values],
  );
  writeOwnedRows(db, descriptor, rows);
}

/**
 * Brings the rows `db` holds for a member up to `rows`, given that it holds
 * `previous` now: a table whose part is unchanged is left alone. Every
 * statement applies only while the member's row is there when it commits, so
 * a member removed since `previous` was read stays removed.
 */
export function refreshMemberRows(
  db: IndexedCollectionWriter,
  descriptor: IndexedCollectionDescriptor,
  rows: MemberRows,
  previous: MemberRows,
): void {
  if (
    descriptor.columns.length > 0 && !sameList(previous.values, rows.values)
  ) {
    db.exec(
      `UPDATE ${quote(MEMBERS_TABLE)} SET ${
        descriptor.columns.map((name) => `${quote(name)} = ?`).join(", ")
      } WHERE ${quote(MEMBER_COLUMN)} = ?`,
      [...rows.values, rows.member],
    );
  }
  writeOwnedRows(db, descriptor, rows, previous);
}

/**
 * Moves the rows `db` holds under the reference `from` to `rows.member`,
 * bringing them up to `rows`. Nothing is written unless a member is stored
 * under `from` when the statements commit.
 */
export function moveMemberRows(
  db: IndexedCollectionWriter,
  descriptor: IndexedCollectionDescriptor,
  from: string,
  rows: MemberRows,
): void {
  const columns = [MEMBER_COLUMN, ...descriptor.columns].map(quote);
  db.exec(
    `INSERT INTO ${quote(MEMBERS_TABLE)} (${columns.join(", ")}) SELECT ${
      columns.map(() => "?").join(", ")
    } WHERE EXISTS (${MEMBER_EXISTS}) ON CONFLICT (${quote(MEMBER_COLUMN)}) ${
      onConflict(descriptor)
    }`,
    [rows.member, ...rows.values, from],
  );
  writeOwnedRows(db, descriptor, rows);
  deleteMemberRows(db, descriptor, from);
}

/** Deletes every row `db` holds for the member stored under `member`. */
export function deleteMemberRows(
  db: IndexedCollectionWriter,
  descriptor: IndexedCollectionDescriptor,
  member: string,
): void {
  db.exec(
    `DELETE FROM ${quote(MEMBERS_TABLE)} WHERE ${quote(MEMBER_COLUMN)} = ?`,
    [member],
  );
  for (const name of descriptor.relations) {
    db.exec(
      `DELETE FROM ${quote(name)} WHERE ${quote(SOURCE_COLUMN)} = ?`,
      [member],
    );
  }
  db.exec(
    `DELETE FROM ${quote(MEMBER_DEPS_TABLE)} WHERE ${quote(MEMBER_COLUMN)} = ?`,
    [member],
  );
}

/** Subquery selecting the row of the member bound as its one parameter. */
const MEMBER_EXISTS = `SELECT 1 FROM ${quote(MEMBERS_TABLE)} WHERE ${
  quote(MEMBER_COLUMN)
} = ?`;

/** Helper for the row writers, which returns a member row's conflict clause. */
function onConflict(descriptor: IndexedCollectionDescriptor): string {
  return descriptor.columns.length === 0
    ? "DO NOTHING"
    : `DO UPDATE SET ${
      descriptor.columns.map((name) =>
        `${quote(name)} = excluded.${quote(name)}`
      ).join(", ")
    }`;
}

/**
 * Helper for the row writers, which replaces the relation and dependency
 * rows of `rows.member`, leaving alone each table whose part of `previous` is
 * unchanged. The rows are inserted only while the member's own row exists.
 */
function writeOwnedRows(
  db: IndexedCollectionWriter,
  descriptor: IndexedCollectionDescriptor,
  rows: MemberRows,
  previous?: MemberRows,
): void {
  descriptor.relations.forEach((name, at) => {
    if (
      previous === undefined ||
      !sameSet(previous.relations[at] ?? [], rows.relations[at])
    ) {
      replaceRows(
        db,
        name,
        SOURCE_COLUMN,
        TARGET_COLUMN,
        rows,
        rows.relations[at],
      );
    }
  });
  if (previous === undefined || !sameSet(previous.deps, rows.deps)) {
    replaceRows(db, MEMBER_DEPS_TABLE, MEMBER_COLUMN, "doc", rows, rows.deps);
  }
}

/**
 * Helper for `writeOwnedRows()`, which replaces the rows of `table` owned by
 * `rows.member` with one row per entry of `values`. The values travel as one
 * JSON list, so a statement's size does not grow with their number.
 */
function replaceRows(
  db: IndexedCollectionWriter,
  table: string,
  ownerColumn: string,
  valueColumn: string,
  rows: MemberRows,
  values: readonly string[],
): void {
  db.exec(
    `DELETE FROM ${quote(table)} WHERE ${quote(ownerColumn)} = ?`,
    [rows.member],
  );
  if (values.length === 0) return;
  db.exec(
    `INSERT INTO ${quote(table)} (${quote(ownerColumn)}, ${
      quote(valueColumn)
    }) SELECT ?, value FROM json_each(?) WHERE EXISTS (${MEMBER_EXISTS})`,
    [rows.member, JSON.stringify(values), rows.member],
  );
}

/** Helper for `projectMember()`, which maps a field value to a column value. */
function toColumnValue(value: unknown): IndexedColumnValue {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
}

/** Number of reads `tx` has journaled so far. */
function countReads(tx: IExtendedStorageTransaction): number {
  let count = 0;
  for (const _read of tx.tx.getReadActivities?.() ?? []) count++;
  return count;
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, at) => value === b[at]);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const members = new Set(a);
  return b.every((value) => members.has(value));
}

/** Quotes an identifier the collection's declaration already validated. */
function quote(identifier: string): string {
  return `"${identifier}"`;
}
