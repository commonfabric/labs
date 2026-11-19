/**
 * The declaration of an indexed collection, and the SQLite tables derived from
 * it. An indexed collection mirrors chosen fields of its member cells into one
 * database. Its members come in one or more kinds, each with a table holding
 * a row per member and a table per relation holding a row per reference a
 * member holds. Two more tables serve the runtime: `member_deps` names the
 * documents each member's rows were read from, and `collection_meta` records
 * the declaration the tables were last brought up to. Everything here is plain
 * data computed when the pattern is built; nothing reads a cell.
 */

import type { FabricValue } from "@commonfabric/api";
import { isPlainObject } from "@commonfabric/js-values/types";
import {
  cfLink,
  type ColumnSpec,
  jsonTypeForSql,
  table,
  type TableSchema,
} from "@commonfabric/memory/sqlite/schema";

/** Table naming the documents each member's rows were read from. */
export const MEMBER_DEPS_TABLE = "member_deps";

/** Table recording the declaration the other tables were brought up to. */
export const COLLECTION_META_TABLE = "collection_meta";

/** Column of a kind's table holding the member's own reference. */
export const MEMBER_COLUMN = "member_cf_link";

/** Column of a relation table holding the referring member. */
export const SOURCE_COLUMN = "source_cf_link";

/** Column of a relation table holding the referenced cell. */
export const TARGET_COLUMN = "target_cf_link";

/** The label a column declares for the values it holds. */
export interface IndexedColumnLabel {
  /** Confidentiality every value read out of the column carries. */
  confidentiality?: readonly FabricValue[];

  /** The most confidentiality a value stored in the column may carry. */
  maxConfidentiality?: readonly FabricValue[];

  [key: string]: FabricValue;
}

/** A column declared with more than its SQLite type. */
export interface IndexedColumnSpec {
  /** SQLite column type the value is stored under. */
  type: string;

  /** Keys leading from the member to the value, when it is nested. */
  path?: readonly string[];

  /**
   * The column's label. A member's value that carries confidentiality is
   * mirrored only into a column whose label covers it.
   */
  ifc?: IndexedColumnLabel;
}

/** What a pattern declares of one kind of member. */
export interface IndexedCollectionOptions {
  /**
   * Values mirrored as columns of the kind's table. A column is named for
   * the member field it mirrors and given the SQLite type it is stored
   * under, or is given a type and the path of a nested value.
   */
  columns?: Record<string, string | IndexedColumnSpec>;

  /**
   * Member fields holding one reference to another cell, or a list of them.
   * Each becomes a table with one row per reference. A list names fields; a
   * map gives each relation the path of a nested field.
   */
  relations?: readonly string[] | Record<string, readonly string[]>;

  /** Secondary indexes over the kind's table, each a list of columns. */
  indexes?: ReadonlyArray<ReadonlyArray<string>>;
}

/** What the runtime needs to keep one kind's tables current. */
export interface IndexedKindDescriptor {
  /** Table holding a row per member of the kind. */
  table: string;

  /** Mirrored values, in declaration order. */
  columns: string[];

  /** Relations, in declaration order. */
  relations: string[];

  /** Table of each relation. */
  relationTables: Record<string, string>;

  /**
   * Where a column or relation is read from, for each one that is not the
   * member field of its own name.
   */
  paths: Record<string, string[]>;

  /** The label of each column that declares one. */
  labels: Record<string, IndexedColumnLabel>;

  [key: string]: FabricValue;
}

/**
 * The part of a collection's declaration the runtime needs to keep its tables
 * current, stored on the database handle beside `tables`.
 */
export interface IndexedCollectionDescriptor {
  /** The collection's kinds of member, by name. */
  kinds: Record<string, IndexedKindDescriptor>;

  [key: string]: FabricValue;
}

/** Tables and descriptor derived from one collection declaration. */
export interface IndexedCollectionDefinition {
  /** Table schemas the database is created with. */
  tables: Record<string, TableSchema>;

  /** Descriptor stored on the database handle. */
  index: IndexedCollectionDescriptor;
}

// `__proto__` is spelled like an identifier, and as a key of an ordinary
// object it names the prototype rather than an entry.
const IDENTIFIER_RE = /^(?!__proto__$)[A-Za-z_][A-Za-z0-9_]*$/;

/** Tables no kind or relation may be named for. */
const RESERVED_TABLES: readonly string[] = [
  MEMBER_DEPS_TABLE,
  COLLECTION_META_TABLE,
];

/**
 * Derives the tables and the descriptor of a collection with the kinds of
 * member `kinds` declares. A kind's table is named for the kind, and a
 * relation's table for the kind and the relation, joined by an underscore.
 */
export function defineIndexedCollections(
  kinds: Record<string, IndexedCollectionOptions>,
): IndexedCollectionDefinition {
  const declared: unknown = kinds;
  if (!isPlainObject(declared) || Object.keys(declared).length === 0) {
    throw new TypeError(
      "`indexedCollections()` takes a declaration per kind of member",
    );
  }
  return define(kinds);
}

/**
 * Helper for `defineIndexedCollections()`, which derives the tables and the
 * descriptor of `kinds`. Throws on a declaration that is not written in the
 * pattern, on a name that is not a plain identifier, on a field declared
 * twice within a kind, and on two tables that would share a name.
 */
function define(
  kinds: Record<string, IndexedCollectionOptions>,
): IndexedCollectionDefinition {
  const tables: Record<string, TableSchema> = {
    [MEMBER_DEPS_TABLE]: table(
      {
        kind: "text not null",
        [MEMBER_COLUMN]: "text not null",
        doc: "text not null",
      },
      undefined,
      { indexes: [["doc"], ["kind", MEMBER_COLUMN]] },
    ),
    [COLLECTION_META_TABLE]: table({
      key: "text primary key",
      value: "text",
    }),
  };
  const claim = (name: string, schema: TableSchema): void => {
    if (RESERVED_TABLES.includes(name) || Object.hasOwn(tables, name)) {
      throw new TypeError(
        `an indexed collection declares the table \`${name}\` twice, or ` +
          "names one for a table of its own",
      );
    }
    tables[name] = schema;
  };
  const descriptors: Record<string, IndexedKindDescriptor> = {};
  for (const [kind, options] of Object.entries(kinds)) {
    assertName(kind, "kind");
    const declared: unknown = options;
    if (!isPlainObject(declared)) {
      throw new TypeError(
        "an indexed collection takes its declaration written in the " +
          "pattern, not a pattern input or a computed value",
      );
    }
    const paths: Record<string, string[]> = {};
    const labels: Record<string, IndexedColumnLabel> = {};
    // Typed as an open map, so that an index may name any mirrored column.
    const columns: Record<string, ColumnSpec> = {
      [MEMBER_COLUMN]: "text primary key",
    };
    for (const [name, spec] of Object.entries(options.columns ?? {})) {
      assertName(name, "column");
      if (name === MEMBER_COLUMN) {
        throw new TypeError(
          `an indexed collection's column \`${name}\` is the member reference`,
        );
      }
      const type = typeof spec === "string" ? spec : spec?.type;
      if (typeof type !== "string") {
        throw new TypeError(
          `an indexed collection's column \`${name}\` needs a SQLite type`,
        );
      }
      columns[name] = type;
      if (typeof spec === "string") continue;
      if (spec.path !== undefined) paths[name] = toPath(name, spec.path);
      if (spec.ifc !== undefined) {
        if (!isPlainObject(spec.ifc)) {
          throw new TypeError(
            `an indexed collection's column \`${name}\` needs its \`ifc\` ` +
              "written as a label",
          );
        }
        labels[name] = spec.ifc;
        columns[name] = {
          type: jsonTypeForSql(type),
          sqlType: type,
          ifc: spec.ifc,
        };
      }
    }
    const declaredRelations = options.relations ?? [];
    const relations = Array.isArray(declaredRelations)
      ? [...declaredRelations as readonly string[]]
      : Object.keys(declaredRelations);
    if (!Array.isArray(declaredRelations)) {
      for (const [name, path] of Object.entries(declaredRelations)) {
        paths[name] = toPath(name, path);
      }
    }
    claim(
      kind,
      table(columns, undefined, {
        indexes: (options.indexes ?? []).map((index) => [...index]),
      }),
    );
    const relationTables: Record<string, string> = {};
    const seen = new Set<string>();
    for (const name of relations) {
      assertName(name, "relation");
      if (Object.hasOwn(columns, name) || seen.has(name)) {
        throw new TypeError(
          `an indexed collection declares the field \`${name}\` twice`,
        );
      }
      seen.add(name);
      relationTables[name] = `${kind}_${name}`;
      claim(
        relationTables[name],
        table(
          {
            [SOURCE_COLUMN]: { ...cfLink(), sqlType: "text not null" },
            [TARGET_COLUMN]: { ...cfLink(), sqlType: "text not null" },
          },
          undefined,
          { indexes: [[SOURCE_COLUMN], [TARGET_COLUMN]] },
        ),
      );
    }
    descriptors[kind] = {
      table: kind,
      columns: Object.keys(columns).filter((name) => name !== MEMBER_COLUMN),
      relations,
      relationTables,
      paths,
      labels,
    };
  }
  return { tables, index: { kinds: descriptors } };
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
  if (!isPlainObject(index) || !isPlainObject(index.kinds)) return undefined;
  const kinds: Record<string, IndexedKindDescriptor> = {};
  for (const [kind, stored] of Object.entries(index.kinds)) {
    if (!IDENTIFIER_RE.test(kind) || !isPlainObject(stored)) return undefined;
    const { table, columns, relations, relationTables, paths, labels } = stored;
    if (
      typeof table !== "string" || !IDENTIFIER_RE.test(table) ||
      !isNameList(columns) || !isNameList(relations) ||
      !isPlainObject(relationTables)
    ) {
      return undefined;
    }
    const tablesOf: Record<string, string> = {};
    for (const relation of relations) {
      const name = relationTables[relation];
      if (typeof name !== "string" || !IDENTIFIER_RE.test(name)) {
        return undefined;
      }
      tablesOf[relation] = name;
    }
    const pathsOf: Record<string, string[]> = {};
    if (isPlainObject(paths)) {
      for (const [name, path] of Object.entries(paths)) {
        if (
          Array.isArray(path) && path.length > 0 &&
          path.every((key) => typeof key === "string")
        ) {
          pathsOf[name] = [...path];
        }
      }
    }
    const labelsOf: Record<string, IndexedColumnLabel> = {};
    if (isPlainObject(labels)) {
      for (const [name, label] of Object.entries(labels)) {
        if (isPlainObject(label)) labelsOf[name] = label as IndexedColumnLabel;
      }
    }
    kinds[kind] = {
      table,
      columns: [...columns],
      relations: [...relations],
      relationTables: tablesOf,
      paths: pathsOf,
      labels: labelsOf,
    };
  }
  return Object.keys(kinds).length === 0 ? undefined : { kinds };
}

/**
 * Returns the descriptor of the kind named `kind`. Throws on a kind the
 * collection does not declare.
 */
export function indexedKindOf(
  descriptor: IndexedCollectionDescriptor,
  kind: string,
): { kind: string; descriptor: IndexedKindDescriptor } {
  if (!Object.hasOwn(descriptor.kinds, kind)) {
    throw new TypeError(
      `this indexed collection declares no kind of member \`${kind}\``,
    );
  }
  return { kind, descriptor: descriptor.kinds[kind] };
}

/**
 * Returns the keys leading from a member to the value the column or relation
 * `name` of `kind` mirrors.
 */
export function indexedFieldPath(
  kind: IndexedKindDescriptor,
  name: string,
): readonly string[] {
  return Object.hasOwn(kind.paths, name) ? kind.paths[name] : [name];
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

/** Helper for `define()`, which validates one path. */
function toPath(name: string, path: unknown): string[] {
  if (
    !Array.isArray(path) || path.length === 0 ||
    !path.every((key) => typeof key === "string")
  ) {
    throw new TypeError(
      `an indexed collection's \`${name}\` needs a path of one or more keys`,
    );
  }
  return [...path];
}

/** Helper for `define()`, which validates one declared name. */
function assertName(name: string, what: "kind" | "column" | "relation"): void {
  if (typeof name !== "string" || !IDENTIFIER_RE.test(name)) {
    throw new TypeError(
      `an indexed collection's ${what} name \`${name}\` is not an identifier`,
    );
  }
}
