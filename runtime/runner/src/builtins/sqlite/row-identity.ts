/**
 * What a `sqliteQuery` result row's entity document is keyed on. Each row is
 * stored as a document of its own under the query's result cell, and the key
 * chosen here, hashed with that cell's coordinates, is the document's id.
 *
 * A row document is immutable (CFC spec §8.17.6, rule 4): its key is its
 * content and the label that content is written under, so a document holds one
 * content under one label for as long as it exists, and a row whose data or
 * label changed is another document. A result changes only in which row
 * references sit at which of its slots.
 *
 * Every key also carries the space's row salt, a runtime secret
 * (`runtime-secret.ts`). Without it the id would be a value computable from
 * the row, and a reader who could not read a row could still confirm a guess
 * at its content by recomputing the id and comparing it with the reference at
 * a result slot. With it the id says nothing about the row to anyone who
 * cannot read the salt, and no executed code can use the salt.
 */

import type { SqliteResultColumn } from "@commonfabric/memory/v2";

/** The name of the runtime secret row keys are salted with. */
export const SQLITE_ROW_SALT = "sqlite-result-row-salt";

/**
 * A row's key. A row carrying no confidentiality is keyed on the salt and its
 * content, so equal rows share a document wherever they land in a result. A
 * row carrying a per-column label or a row label is keyed on the salt, its
 * content and what decides its label: the row label itself, and for the
 * per-column labels the projection, each output column and its origin,
 * together with the handle's `tables` declaration, which maps an origin to a
 * label. A commit attaches label metadata only to the documents it writes, so
 * a row whose label changed under unchanged content has to land on a document
 * of its own for the new label to reach it. The selected database, its space
 * and id, is part of the key as well, so rows of two databases never share a
 * document.
 */
export type ResultRowKey =
  | { readonly salt: string; readonly row: unknown }
  | {
    readonly salt: string;
    readonly database: ResultRowDatabase;
    readonly projection: readonly SqliteResultColumn[] | undefined;
    readonly tables: unknown;
    readonly row: unknown;
    readonly label?: unknown;
  };

/** The database a result's rows were read from: its space and its id. */
export type ResultRowDatabase = {
  readonly space: string;
  readonly id: string;
};

/**
 * Chooses the key of every row of one result, in row order. `salt` is the
 * space's row salt, `columnLabeled` says whether the projection carries a
 * per-column label, and `rowLabel` is the row label of the row at an index, or
 * `undefined` for a row carrying none. `columns` is the server's origin per
 * output column, present whenever the db declares any label, and `database` is
 * the database the rows were read from.
 */
export function resultRowKeys(options: {
  salt: string;
  rows: readonly unknown[];
  columns: readonly SqliteResultColumn[] | undefined;
  tables: Record<string, unknown> | undefined;
  database: ResultRowDatabase;
  columnLabeled: boolean;
  rowLabel: (index: number) => unknown;
}): ResultRowKey[] {
  const { salt, rows, columns, tables, database, columnLabeled, rowLabel } =
    options;
  return rows.map((row, index) => {
    const label = rowLabel(index);
    if (label !== undefined) {
      return { salt, database, projection: columns, tables, row, label };
    }
    if (!columnLabeled) return { salt, row };
    return { salt, database, projection: columns, tables, row };
  });
}
