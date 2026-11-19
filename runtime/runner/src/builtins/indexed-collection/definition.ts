/**
 * The declaration of an indexed collection, and the SQLite tables derived from
 * it. An indexed collection mirrors chosen fields of its member cells into one
 * database: a `members` table with a row per member, a table per relation
 * with a row per reference a member holds, and a `member_deps` table naming
 * the documents each member's row was read from. Everything here is plain
 * data computed when the pattern is built; nothing reads a cell.
 */

import type { FabricValue } from "@commonfabric/api";
import { isPlainObject } from "@commonfabric/js-values/types";
import {
  cfLink,
  table,
  type TableSchema,
} from "@commonfabric/memory/sqlite/schema";

/** Table holding one row per member. */
export const MEMBERS_TABLE = "members";

/** Table naming the documents each member's rows were read from. */
export const MEMBER_DEPS_TABLE = "member_deps";

/** Column of {@link MEMBERS_TABLE} holding the member's own reference. */
export const MEMBER_COLUMN = "member_cf_link";

/** Column of a relation table holding the referring member. */
export const SOURCE_COLUMN = "source_cf_link";

/** Column of a relation table holding the referenced cell. */
export const TARGET_COLUMN = "target_cf_link";

/** What a pattern passes to `indexedCollection()`. */
export interface IndexedCollectionOptions {
  /**
   * Member fields mirrored as columns of the `members` table, each with the
   * SQLite column type it is stored under.
   */
  columns?: Record<string, string>;

  /**
   * Member fields holding references to other cells. Each becomes a table of
   * that name with one row per reference.
   */
  relations?: readonly string[];

  /** Secondary indexes over the `members` table, each a list of columns. */
  indexes?: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * The part of a collection's declaration the runtime needs to keep its tables
 * current, stored on the database handle beside `tables`.
 */
export interface IndexedCollectionDescriptor {
  /** Mirrored member fields, in declaration order. */
  columns: string[];

  /** Relation fields, in declaration order. */
  relations: string[];

  [key: string]: FabricValue;
}

/** Tables and descriptor derived from one collection declaration. */
export interface IndexedCollectionDefinition {
  /** Table schemas the database is created with. */
  tables: Record<string, TableSchema>;

  /** Descriptor stored on the database handle. */
  index: IndexedCollectionDescriptor;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Derives the tables and the descriptor for `options`. Throws on a field name
 * that is not a plain identifier, on a column or relation named after one of
 * the collection's own tables or columns, and on a field declared as both a
 * column and a relation.
 */
export function defineIndexedCollection(
  options: IndexedCollectionOptions = {},
): IndexedCollectionDefinition {
  const declared: unknown = options;
  if (!isPlainObject(declared)) {
    throw new TypeError(
      "`indexedCollection()` takes its declaration written in the pattern, " +
        "not a pattern input or a computed value",
    );
  }
  const columns = options.columns ?? {};
  const relations = [...(options.relations ?? [])];
  for (const name of Object.keys(columns)) {
    assertFieldName(name, "column");
    if (name === MEMBER_COLUMN) {
      throw new TypeError(
        `\`indexedCollection()\`: column \`${name}\` is the member reference`,
      );
    }
    if (typeof columns[name] !== "string") {
      throw new TypeError(
        `\`indexedCollection()\`: column \`${name}\` needs a SQLite type`,
      );
    }
  }
  const seen = new Set<string>();
  for (const name of relations) {
    assertFieldName(name, "relation");
    if (name === MEMBERS_TABLE || name === MEMBER_DEPS_TABLE) {
      throw new TypeError(
        `\`indexedCollection()\`: relation \`${name}\` is a reserved table`,
      );
    }
    if (Object.hasOwn(columns, name) || seen.has(name)) {
      throw new TypeError(
        `\`indexedCollection()\`: field \`${name}\` is declared twice`,
      );
    }
    seen.add(name);
  }

  // Typed as an open map, so that an index may name any mirrored column.
  const memberColumns: Record<string, string> = {
    [MEMBER_COLUMN]: "text primary key",
    ...columns,
  };
  const tables: Record<string, TableSchema> = {
    [MEMBERS_TABLE]: table(
      memberColumns,
      undefined,
      { indexes: (options.indexes ?? []).map((index) => [...index]) },
    ),
    [MEMBER_DEPS_TABLE]: table(
      { [MEMBER_COLUMN]: "text not null", doc: "text not null" },
      undefined,
      { indexes: [["doc"], [MEMBER_COLUMN]] },
    ),
  };
  for (const name of relations) {
    tables[name] = table(
      {
        [SOURCE_COLUMN]: { ...cfLink(), sqlType: "text not null" },
        [TARGET_COLUMN]: { ...cfLink(), sqlType: "text not null" },
      },
      undefined,
      { indexes: [[SOURCE_COLUMN], [TARGET_COLUMN]] },
    );
  }
  return {
    tables,
    index: { columns: Object.keys(columns), relations },
  };
}

/**
 * Returns the descriptor stored on a database handle value, or `undefined`
 * when the handle is an ordinary database or carries a descriptor naming
 * anything but identifiers.
 */
export function indexedCollectionDescriptorOf(
  handle: unknown,
): IndexedCollectionDescriptor | undefined {
  if (!isPlainObject(handle)) return undefined;
  const index = handle.index;
  if (!isPlainObject(index)) return undefined;
  const { columns, relations } = index;
  if (!isNameList(columns) || !isNameList(relations)) return undefined;
  return { columns: [...columns], relations: [...relations] };
}

/**
 * Whether `value` is a list of identifiers. A descriptor is read back from a
 * stored handle, and its names are written into SQL statements.
 */
function isNameList(value: unknown): value is readonly string[] {
  return Array.isArray(value) &&
    value.every((entry) =>
      typeof entry === "string" && IDENTIFIER_RE.test(entry)
    );
}

/** Helper for `defineIndexedCollection()`, which validates one field name. */
function assertFieldName(name: string, what: "column" | "relation"): void {
  if (typeof name !== "string" || !IDENTIFIER_RE.test(name)) {
    throw new TypeError(
      `\`indexedCollection()\`: ${what} name \`${name}\` is not an identifier`,
    );
  }
}
