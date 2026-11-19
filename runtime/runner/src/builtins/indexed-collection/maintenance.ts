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
import type { IExtendedStorageTransaction } from "../../storage/interface.ts";
import { encodeCellToSigilString } from "../sqlite/cf-link-codec.ts";
import {
  type IndexedCollectionDescriptor,
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

/** Rows per `INSERT`, keeping a statement well under SQLite's bind limit. */
const INSERT_CHUNK = 400;

/**
 * Returns the reference `cell` is stored and looked up under: the absolute
 * link of the cell it resolves to, so that two links to one cell agree.
 */
export function memberKeyOf(cell: Cell<unknown>): string {
  return encodeCellToSigilString(cell.resolveAsCell(), portableSnapshotId);
}

/**
 * Reads `member`'s mirrored fields through `tx` and returns the rows they
 * amount to. A column field holding anything but a string, a finite number,
 * or a boolean reads as `null`; a boolean reads as `0` or `1`. A relation
 * field holding anything but a list of cell references reads as empty, and a
 * repeated reference counts once. `deps` names every document the reads
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
  const key = encodeCellToSigilString(resolved, portableSnapshotId);
  const values = descriptor.columns.map((name) =>
    toColumnValue((resolved as Cell<Record<string, unknown>>).key(name).get())
  );
  const relations = descriptor.relations.map((name) => {
    const targets = (resolved as Cell<Record<string, unknown>>).key(name)
      .asSchema(RELATION_SCHEMA).get() as unknown;
    if (!Array.isArray(targets)) return [];
    const keys = new Set<string>();
    for (const target of targets as Cell<unknown>[]) {
      keys.add(memberKeyOf(target.withTx(tx)));
    }
    return [...keys];
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
 * Writes `rows` over whatever `db` holds for that member. `previous`, when
 * given, is what the tables hold now: a table whose part of it is unchanged
 * is left alone.
 */
export function writeMemberRows(
  db: IndexedCollectionWriter,
  descriptor: IndexedCollectionDescriptor,
  rows: MemberRows,
  previous?: MemberRows,
): void {
  if (previous === undefined || !sameList(previous.values, rows.values)) {
    const columns = [MEMBER_COLUMN, ...descriptor.columns].map(quote);
    const update = descriptor.columns.length === 0
      ? "DO NOTHING"
      : `DO UPDATE SET ${
        descriptor.columns.map((name) =>
          `${quote(name)} = excluded.${quote(name)}`
        ).join(", ")
      }`;
    db.exec(
      `INSERT INTO ${quote(MEMBERS_TABLE)} (${columns.join(", ")}) VALUES (${
        columns.map(() => "?").join(", ")
      }) ON CONFLICT (${quote(MEMBER_COLUMN)}) ${update}`,
      [rows.member, ...rows.values],
    );
  }
  descriptor.relations.forEach((name, at) => {
    if (
      previous !== undefined &&
      sameSet(previous.relations[at] ?? [], rows.relations[at])
    ) {
      return;
    }
    replaceRows(
      db,
      name,
      SOURCE_COLUMN,
      TARGET_COLUMN,
      rows.member,
      rows.relations[at],
      previous === undefined || (previous.relations[at]?.length ?? 0) > 0,
    );
  });
  if (previous === undefined || !sameSet(previous.deps, rows.deps)) {
    replaceRows(
      db,
      MEMBER_DEPS_TABLE,
      MEMBER_COLUMN,
      "doc",
      rows.member,
      rows.deps,
      true,
    );
  }
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

/**
 * Helper for `writeMemberRows()`, which replaces the rows of `table` owned by
 * `owner` with one row per entry of `values`.
 */
function replaceRows(
  db: IndexedCollectionWriter,
  table: string,
  ownerColumn: string,
  valueColumn: string,
  owner: string,
  values: readonly string[],
  mayHoldRows: boolean,
): void {
  if (mayHoldRows) {
    db.exec(
      `DELETE FROM ${quote(table)} WHERE ${quote(ownerColumn)} = ?`,
      [owner],
    );
  }
  for (let start = 0; start < values.length; start += INSERT_CHUNK) {
    const chunk = values.slice(start, start + INSERT_CHUNK);
    db.exec(
      `INSERT INTO ${quote(table)} (${quote(ownerColumn)}, ${
        quote(valueColumn)
      }) VALUES ${chunk.map(() => "(?, ?)").join(", ")}`,
      chunk.flatMap((value) => [owner, value]),
    );
  }
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
