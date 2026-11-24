/**
 * Prepared SQLite statements that take named parameters and bind them by
 * position, with the statement's parameter names and result columns read once
 * when it is prepared rather than on every execution.
 */

import type { BindValue, Database } from "@db/sqlite";

/** One execution's named parameters. A name with no entry binds `NULL`. */
export type StatementParameters = Readonly<Record<string, BindValue>>;

/** A result row, by column name. */
export type StatementRow = Record<string, unknown>;

/** A statement {@link prepare} returns. */
export type PreparedStatement = {
  /** Runs the statement and returns its first row, if any. */
  get(parameters?: StatementParameters): StatementRow | undefined;

  /** Runs the statement and returns every row. */
  all(parameters?: StatementParameters): StatementRow[];

  /** Runs the statement and yields its rows as it steps to each. */
  iter(parameters?: StatementParameters): IterableIterator<StatementRow>;

  /** Runs the statement and returns the number of rows it changed. */
  run(parameters?: StatementParameters): number;
};

/**
 * Prepares `sql` on `database`. Every parameter `sql` has is named, with one
 * of the prefixes `:`, `@` or `$`, and a name is written with one prefix.
 *
 * @throws When two of `sql`'s parameters share a name, and when an execution
 * names a parameter `sql` does not have.
 */
export const prepare = (
  database: Database,
  sql: string,
): PreparedStatement => {
  const statement = database.prepare(sql);
  // A parameter's index is its position among the distinct names `sql`
  // uses, and its name keeps the `:`, `@` or `$` it was written with.
  const names = Array.from(
    { length: statement.bindParameterCount },
    (_, index) => statement.bindParameterName(index + 1).slice(1),
  );
  if (new Set(names).size !== names.length) {
    throw new Error(`Parameters share a name: ${names.join(", ")}`);
  }
  const columns = statement.columnNames();
  const bind = (parameters: StatementParameters = {}): BindValue[] => {
    let bound = 0;
    const values = names.map((name) => {
      if (!Object.hasOwn(parameters, name)) return null;
      bound++;
      return parameters[name];
    });
    if (bound !== Object.keys(parameters).length) {
      const unknown = Object.keys(parameters).filter((name) =>
        !names.includes(name)
      );
      throw new Error(`No such parameter: ${unknown.join(", ")}`);
    }
    return values;
  };
  const toRow = (values: unknown[]): StatementRow => {
    const row: StatementRow = {};
    for (let index = 0; index < columns.length; index++) {
      row[columns[index]] = values[index];
    }
    return row;
  };
  return {
    get: (parameters) => {
      const values = statement.value(bind(parameters));
      return values === undefined ? undefined : toRow(values);
    },
    all: (parameters) => statement.values(bind(parameters)).map(toRow),
    iter: (parameters) => statement.iter(bind(parameters)),
    run: (parameters) => statement.run(bind(parameters)),
  };
};
