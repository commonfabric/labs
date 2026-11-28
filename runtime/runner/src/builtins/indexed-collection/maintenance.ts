/**
 * Reads what an indexed collection mirrors of one member, and writes that
 * member's rows. Both halves run inside the caller's transaction: the reads
 * are ordinary cell reads, so the transaction's flow labels cover what the
 * rows are derived from, and the writes are `db.exec()` calls that commit
 * with it.
 */

import type { CfcConfClause } from "@commonfabric/memory/v2/cfc-release-authority";

import type { Cell } from "../../cell.ts";
import { portableSnapshotId } from "../../data-uri.ts";
import type { JSONSchema } from "../../builder/types.ts";
import { cfcLabelViewForCellFailClosed } from "../../cfc/label-view.ts";
import {
  cfcConfidentialityForObservationNode,
  cfcObservationFitsCeiling,
} from "../../cfc/observation.ts";

import { createSigilLinkFromParsedLink, isCellLink } from "../../link-utils.ts";
import type {
  IExtendedStorageTransaction,
  IReadActivity,
  MemorySpace,
} from "../../storage/interface.ts";
import {
  type IndexedColumnLabel,
  indexedFieldPath,
  type IndexedKindDescriptor,
  MEMBER_COLUMN,
  MEMBER_DEPS_TABLE,
  SOURCE_COLUMN,
  TARGET_COLUMN,
} from "./definition.ts";

/** A value a mirrored column holds. */
export type IndexedColumnValue = string | number | null;

/** What a collection's tables hold, or should hold, for one member. */
export interface MemberRows {
  /** The kind the member is one of. */
  kind: string;

  /** The member's reference, as its `member_cf_link` column stores it. */
  member: string;

  /** Column values, in the kind's column order. */
  values: IndexedColumnValue[];

  /** Referenced cells per relation, in the kind's relation order. */
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
 * Reads the fields of `member` that `descriptor` mirrors through `tx`, and
 * returns the rows they amount to for a member of `kind`. A column field
 * holding anything but a string, a finite number, or a boolean reads as
 * `null`; a boolean reads as `0` or `1`. A relation field holds a list of
 * cell references, in which a repeated one counts once, or a single
 * reference, or nothing. It holds a list when the value its links lead to is
 * one. Otherwise it holds a reference when it stores a link, whatever the
 * cell that link names holds. A write redirect is an alias rather than a
 * reference: the field holds what the cell it leads to holds, so a field
 * aliasing the cell a derivation writes, as a piece's result does, holds
 * nothing until the derivation has run. A field that is absent, on a member
 * or anywhere along a nested path, reads as `null` or as empty. `deps` names
 * every document the reads touched, the member's own included, and so the
 * document of the cell an alias leads to: a derivation that writes that cell
 * later has the member read again.
 *
 * Throws when a read reaches a value stored per user or per session: the
 * collection's database is shared by every reader of its space, and such a
 * value differs by who reads it. Throws as well when a mirrored value carries
 * confidentiality that its column's declared label does not cover, or that
 * exceeds the column's declared ceiling: a row holds no label but the one its
 * column declares, so storing the value would drop what it carries. A
 * relation declares no label, so a relation field carrying any is refused.
 */
export function projectMember(
  tx: IExtendedStorageTransaction,
  kind: string,
  descriptor: IndexedKindDescriptor,
  member: Cell<unknown>,
): MemberRows {
  const firstRead = countReads(tx);
  const bound = member.withTx(tx);
  const resolved = bound.resolveAsCell();
  const field = (name: string): Cell<unknown> =>
    indexedFieldPath(descriptor, name).reduce<Cell<unknown>>(
      (cell, key) => (cell as Cell<Record<string, unknown>>).key(key),
      resolved,
    );
  // A mirrored value is bound as a bare scalar, which carries no label of
  // its own into the database, so what it carries is measured here against
  // the label its column declares. Nothing is measured where no gate could
  // act on the result.
  const labeled = tx.getCfcState().enforcementMode !== "disabled";
  const values = descriptor.columns.map((name) => {
    const cell = field(name);
    if (labeled) assertLabelKept(name, cell, descriptor.labels[name]);
    return toColumnValue(cell.get());
  });
  const relations = descriptor.relations.map((name) => {
    if (labeled) assertLabelKept(name, field(name), undefined);
    const targets = field(name).asSchema(RELATION_SCHEMA).get() as unknown;
    if (Array.isArray(targets)) {
      const keys = new Set<string>();
      for (const target of targets as Cell<unknown>[]) {
        keys.add(memberKeyOf(target.withTx(tx)));
      }
      return [...keys];
    }
    // A field that is not a list holds one reference, or nothing. Reading it
    // to its write target follows the aliases and stops at a link stored as
    // a value, which is the reference whatever the cell it names holds.
    const single = field(name);
    return isCellLink(single.getRaw({ lastNode: "writeRedirect" }))
      ? [memberKeyOf(single)]
      : [];
  });
  const deps = new Set<string>([
    bound.getAsNormalizedFullLink().id,
    resolved.getAsNormalizedFullLink().id,
  ]);
  for (const read of readsFrom(tx, firstRead)) {
    if (read.scope === "user" || read.scope === "session") {
      throw new TypeError(
        `an indexed collection cannot mirror a value stored per ${read.scope}`,
      );
    }
    deps.add(read.id);
  }
  return {
    kind,
    member: memberKeyOf(resolved),
    values,
    relations,
    deps: [...deps],
  };
}

/** Cause of the document that names a collection's last maintenance write. */
const REVISION_CAUSE = "indexed-collection-revision";

/**
 * The cell that names the last write maintenance made to the collection
 * whose database is `id`. A document of its own, because the collection's
 * handle is read by every handler that adds to the collection: a revision
 * kept on the handle would make each of those handlers lose its commit to
 * maintenance running beside it.
 */
export function maintenanceRevisionCell(
  runtime: {
    getCell<T>(
      space: MemorySpace,
      cause: unknown,
      schema?: JSONSchema,
      tx?: IExtendedStorageTransaction,
    ): Cell<T>;
  },
  space: MemorySpace,
  id: string,
  tx?: IExtendedStorageTransaction,
): Cell<string> {
  return runtime.getCell<string>(
    space,
    { [REVISION_CAUSE]: id },
    undefined,
    tx,
  );
}

/** What tells this process's maintenance revisions from another's. */
const REVISION_ORIGIN = crypto.randomUUID();

let revisionCount = 0;

/**
 * Returns a maintenance revision no write has carried. Not a count read from
 * the cell and advanced: a transaction that is run again would then write the
 * value its first attempt wrote, and a query that asked at that value, before
 * the rows were there, would take itself to be current.
 */
export function nextMaintenanceRevision(): string {
  return `${REVISION_ORIGIN}:${++revisionCount}`;
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
  descriptor: IndexedKindDescriptor,
  rows: MemberRows,
): void {
  const columns = [MEMBER_COLUMN, ...descriptor.columns].map(quote);
  db.exec(
    `INSERT INTO ${quote(descriptor.table)} (${columns.join(", ")}) VALUES (${
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
  descriptor: IndexedKindDescriptor,
  rows: MemberRows,
  previous: MemberRows,
): void {
  if (
    descriptor.columns.length > 0 && !sameList(previous.values, rows.values)
  ) {
    db.exec(
      `UPDATE ${quote(descriptor.table)} SET ${
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
  descriptor: IndexedKindDescriptor,
  from: string,
  rows: MemberRows,
): void {
  const columns = [MEMBER_COLUMN, ...descriptor.columns].map(quote);
  db.exec(
    `INSERT INTO ${quote(descriptor.table)} (${columns.join(", ")}) SELECT ${
      columns.map(() => "?").join(", ")
    } WHERE EXISTS (${memberExists(descriptor)}) ON CONFLICT (${
      quote(MEMBER_COLUMN)
    }) ${onConflict(descriptor)}`,
    [rows.member, ...rows.values, from],
  );
  writeOwnedRows(db, descriptor, rows);
  deleteMemberRows(db, rows.kind, descriptor, from);
}

/**
 * Deletes every row `db` holds for the member of `kind` stored under
 * `member`.
 */
export function deleteMemberRows(
  db: IndexedCollectionWriter,
  kind: string,
  descriptor: IndexedKindDescriptor,
  member: string,
): void {
  db.exec(
    `DELETE FROM ${quote(descriptor.table)} WHERE ${quote(MEMBER_COLUMN)} = ?`,
    [member],
  );
  for (const name of descriptor.relations) {
    db.exec(
      `DELETE FROM ${quote(descriptor.relationTables[name])} WHERE ${
        quote(SOURCE_COLUMN)
      } = ?`,
      [member],
    );
  }
  db.exec(
    `DELETE FROM ${quote(MEMBER_DEPS_TABLE)} WHERE kind = ? AND ${
      quote(MEMBER_COLUMN)
    } = ?`,
    [kind, member],
  );
}

/** Subquery selecting the row of the member bound as its one parameter. */
function memberExists(descriptor: IndexedKindDescriptor): string {
  return `SELECT 1 FROM ${quote(descriptor.table)} WHERE ${
    quote(MEMBER_COLUMN)
  } = ?`;
}

/** Helper for the row writers, which returns a member row's conflict clause. */
function onConflict(descriptor: IndexedKindDescriptor): string {
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
 * The values travel as one JSON list, so a statement's size does not grow
 * with their number.
 */
function writeOwnedRows(
  db: IndexedCollectionWriter,
  descriptor: IndexedKindDescriptor,
  rows: MemberRows,
  previous?: MemberRows,
): void {
  const exists = memberExists(descriptor);
  descriptor.relations.forEach((name, at) => {
    if (
      previous !== undefined &&
      sameSet(previous.relations[at] ?? [], rows.relations[at])
    ) {
      return;
    }
    const relation = quote(descriptor.relationTables[name]);
    db.exec(
      `DELETE FROM ${relation} WHERE ${quote(SOURCE_COLUMN)} = ?`,
      [rows.member],
    );
    if (rows.relations[at].length === 0) return;
    db.exec(
      `INSERT INTO ${relation} (${quote(SOURCE_COLUMN)}, ${
        quote(TARGET_COLUMN)
      }) SELECT ?, value FROM json_each(?) WHERE EXISTS (${exists})`,
      [rows.member, JSON.stringify(rows.relations[at]), rows.member],
    );
  });
  if (previous !== undefined && sameSet(previous.deps, rows.deps)) return;
  db.exec(
    `DELETE FROM ${quote(MEMBER_DEPS_TABLE)} WHERE kind = ? AND ${
      quote(MEMBER_COLUMN)
    } = ?`,
    [rows.kind, rows.member],
  );
  db.exec(
    `INSERT INTO ${quote(MEMBER_DEPS_TABLE)} (kind, ${
      quote(MEMBER_COLUMN)
    }, doc) SELECT ?, ?, value FROM json_each(?) WHERE EXISTS (${exists})`,
    [rows.kind, rows.member, JSON.stringify(rows.deps), rows.member],
  );
}

/**
 * Helper for `projectMember()`, which throws unless the confidentiality the
 * value of `cell` carries is covered by `label`, the label its column
 * declares.
 */
function assertLabelKept(
  name: string,
  cell: Cell<unknown>,
  label: IndexedColumnLabel | undefined,
): void {
  const view = cfcLabelViewForCellFailClosed(cell);
  const carried = view === undefined
    ? []
    : cfcConfidentialityForObservationNode({ labelView: view });
  if (carried.length === 0) return;
  const declared = label?.confidentiality as
    | readonly CfcConfClause[]
    | undefined;
  const ceiling = label?.maxConfidentiality as
    | readonly CfcConfClause[]
    | undefined;
  if (
    declared === undefined || declared.length === 0 ||
    !cfcObservationFitsCeiling(carried, declared) ||
    !cfcObservationFitsCeiling(carried, ceiling)
  ) {
    throw new TypeError(
      `an indexed collection cannot mirror \`${name}\`: its value carries ` +
        "confidentiality that the column's declared `ifc` does not cover",
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

/**
 * Number of reads `tx` has journaled so far. A log kept as an array is asked
 * for its length. A member is read once per `add()`, and a handler may add
 * thousands of members in one transaction, so counting the entries one by one
 * would cost each member the reads of every member before it.
 */
function countReads(tx: IExtendedStorageTransaction): number {
  const log = tx.tx.getReadActivities?.() ?? [];
  if (Array.isArray(log)) return log.length;
  let count = 0;
  for (const _read of log) count++;
  return count;
}

/**
 * The reads `tx` has journaled from position `first` on. On a log kept as an
 * array, none of the entries before `first` is visited.
 */
function* readsFrom(
  tx: IExtendedStorageTransaction,
  first: number,
): Iterable<IReadActivity> {
  const log = tx.tx.getReadActivities?.() ?? [];
  if (Array.isArray(log)) {
    for (let at = first; at < log.length; at++) yield log[at];
    return;
  }
  let position = 0;
  for (const read of log) {
    if (position++ >= first) yield read;
  }
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
