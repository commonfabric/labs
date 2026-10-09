// Stand-in for `jsr:@db/sqlite` (0.13.0), a Deno FFI binding, over Node's
// built-in `node:sqlite`. It implements the part of `@db/sqlite`'s API the
// workspace uses, with `@db/sqlite`'s value semantics where the two differ:
//
// * Reading: an INTEGER column reads as a 32-bit integer (`@db/sqlite` uses
//   `sqlite3_column_int`) unless `int64` is set, in which case a value past
//   2^53 reads as a `bigint`. Rows are plain objects, not null-prototype ones.
// * Binding: an integral `number` binds as an INTEGER (`node:sqlite` binds
//   every `number` as a REAL), a `boolean` as 0 or 1, a `Date` as ISO text,
//   any other object as JSON text, and `undefined` as NULL.
// * Opening: foreign keys off, double-quoted string literals on, and
//   defensive mode off, as SQLite's own defaults have them (`node:sqlite`
//   changes all three).
//
// Not emulated: `parseJson`. `node:sqlite` does not expose a value's subtype,
// so TEXT carrying SQLite's JSON subtype reads as text, as it does under
// `parseJson: false`. Also absent: `openBlob()`, `backup()`, `isComplete()`.
//
// Mapped from `jsr:@db/sqlite` by `hooks.mjs`.

import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const SQLITE3_OPEN_READONLY = 0x00000001;
const SQLITE3_OPEN_CREATE = 0x00000004;
const SQLITE3_OPEN_MEMORY = 0x00000080;

const BIG_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export class SqliteError extends Error {
  name = "SqliteError";

  constructor(code = 1, message = "Unknown Error") {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** A `bigint` read from SQLite, as `@db/sqlite` hands it to a caller. */
function fromInteger(value, int64) {
  if (!int64) return Number(BigInt.asIntN(32, value));
  return (value < -BIG_MAX || value > BIG_MAX) ? value : Number(value);
}

/** A row of values read with `readBigInts`, converted in place. */
function convertRow(row, int64) {
  for (let i = 0; i < row.length; i++) {
    if (typeof row[i] === "bigint") row[i] = fromInteger(row[i], int64);
  }
  return row;
}

/** One bind value, as `node:sqlite` should receive it. */
function toBindValue(value) {
  switch (typeof value) {
    case "number": {
      if (Number.isInteger(value)) {
        const big = BigInt(value);
        if (big >= INT64_MIN && big <= INT64_MAX) return big;
      }
      return value;
    }
    case "string":
    case "bigint":
      return value;
    case "boolean":
      return value ? 1n : 0n;
    case "undefined":
      return null;
    case "object": {
      if (value === null || value instanceof Uint8Array) return value;
      if (value instanceof Date) return value.toISOString();
      return JSON.stringify(value);
    }
    default:
      throw new Error(`Value of unsupported type: ${String(value)}`);
  }
}

/**
 * The arguments for a `node:sqlite` statement call, from `@db/sqlite`'s rest
 * parameters: positional values, or a single array of them, or a single
 * record of named values.
 */
function toBindArgs(params) {
  let args = params;
  const first = params[0];
  if (
    typeof first === "object" && first !== null &&
    !(first instanceof Uint8Array) && !(first instanceof Date)
  ) {
    args = first;
  }
  if (Array.isArray(args)) return args.map(toBindValue);
  const named = {};
  for (const [name, value] of Object.entries(args)) {
    named[name] = toBindValue(value);
  }
  return [named];
}

/** Converts a `node:sqlite` open failure to the error `@db/sqlite` throws. */
function openError(error) {
  if (error && typeof error.errcode === "number") {
    return new SqliteError(error.errcode, error.errstr ?? error.message);
  }
  return error;
}

/** A user-defined function's argument, as `@db/sqlite` passes it. */
function fromFunctionArg(value) {
  return typeof value === "bigint" ? fromInteger(value, true) : value;
}

/** A user-defined function's result, as `node:sqlite` should receive it. */
function toFunctionResult(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  return value;
}

/** `wrapped`, given `length` as its arity (which SQLite reads). */
function withArity(length, wrapped) {
  Object.defineProperty(wrapped, "length", { value: length });
  return wrapped;
}

export class Statement {
  #stmt;
  #closed = false;
  #boundArgs = null;
  #columnNames;

  int64;
  parseJson;

  constructor(db, sql) {
    this.db = db;
    this.#stmt = db._prepareNative(sql);
    this.#stmt.setReadBigInts(true);
    this.#stmt.setReturnArrays(true);
  }

  /** The `node:sqlite` statement; see `columnOriginsOf()`. */
  get unsafeHandle() {
    return this.#stmt;
  }

  get sql() {
    return this.#stmt.sourceSQL;
  }

  get expandedSql() {
    return this.#stmt.expandedSQL;
  }

  get bindParameterCount() {
    return (this.#stmt.sourceSQL.match(/[?:@$]/g) ?? []).length;
  }

  #int64() {
    return this.int64 ?? this.db.int64;
  }

  #args(params) {
    if (this.#boundArgs !== null && params.length === 0) {
      return this.#boundArgs;
    }
    return toBindArgs(params);
  }

  bind(...params) {
    if (this.#boundArgs !== null) {
      throw new Error("Statement already bound to values");
    }
    this.#boundArgs = toBindArgs(params);
    return this;
  }

  columnNames() {
    this.#columnNames ??= this.#stmt.columns().map((c) => c.name);
    return this.#columnNames;
  }

  #toObject(row) {
    const names = this.columnNames();
    const out = {};
    for (let i = 0; i < names.length; i++) out[names[i]] = row[i];
    return out;
  }

  run(...params) {
    return Number(this.#stmt.run(...this.#args(params)).changes);
  }

  values(...params) {
    const int64 = this.#int64();
    return this.#stmt.all(...this.#args(params)).map((row) =>
      convertRow(row, int64)
    );
  }

  all(...params) {
    return this.values(...params).map((row) => this.#toObject(row));
  }

  value(...params) {
    const row = this.#stmt.get(...this.#args(params));
    return row === undefined ? undefined : convertRow(row, this.#int64());
  }

  get(...params) {
    const row = this.value(...params);
    return row === undefined ? undefined : this.#toObject(row);
  }

  *iter(...params) {
    const int64 = this.#int64();
    for (const row of this.#stmt.iterate(...this.#args(params))) {
      yield this.#toObject(convertRow(row, int64));
    }
  }

  [Symbol.iterator]() {
    return this.iter();
  }

  enableInt64() {
    this.int64 = true;
    return this;
  }

  disableInt64() {
    this.int64 = false;
    return this;
  }

  defaultInt64() {
    this.int64 = undefined;
    return this;
  }

  enableParseJson() {
    this.parseJson = true;
    return this;
  }

  disableParseJson() {
    this.parseJson = false;
    return this;
  }

  defaultParseJson() {
    this.parseJson = undefined;
    return this;
  }

  finalize() {
    if (this.#closed) return;
    this.#closed = true;
    this.db._forget(this);
    if (this.db.open) this.#stmt.close?.();
  }

  [Symbol.dispose]() {
    this.finalize();
  }

  toString() {
    return this.expandedSql;
  }
}

export class Database {
  #db;
  #path;
  #open = true;
  #statements = new Set();
  #info;
  #enableLoadExtension = false;

  int64;
  parseJson;
  unsafeConcurrency;

  constructor(path, options = {}) {
    this.#path = path instanceof URL ? fileURLToPath(path) : path;
    this.int64 = options.int64 ?? false;
    this.parseJson = options.parseJson ?? true;
    this.unsafeConcurrency = options.unsafeConcurrency ?? false;

    let readOnly;
    let create;
    let memory;
    if (options.flags !== undefined) {
      readOnly = (options.flags & SQLITE3_OPEN_READONLY) !== 0;
      create = (options.flags & SQLITE3_OPEN_CREATE) !== 0;
      memory = (options.flags & SQLITE3_OPEN_MEMORY) !== 0;
    } else {
      readOnly = options.readonly ?? false;
      create = (options.create ?? true) && !readOnly;
      memory = options.memory ?? false;
    }

    // `node:sqlite` always opens a writable database with `SQLITE_OPEN_CREATE`.
    const target = memory ? ":memory:" : this.#path;
    if (
      !create && !readOnly && target !== ":memory:" && target !== "" &&
      !target.startsWith("file:") && !fs.existsSync(target)
    ) {
      throw new SqliteError(14, "unable to open database file");
    }

    try {
      this.#db = new DatabaseSync(target, {
        readOnly,
        enableForeignKeyConstraints: false,
        enableDoubleQuotedStringLiterals: true,
        defensive: false,
        allowExtension: true,
      });
    } catch (error) {
      throw openError(error);
    }
    if (options.enableLoadExtension) this.enableLoadExtension = true;
  }

  get open() {
    return this.#open;
  }

  get path() {
    return this.#path;
  }

  /** The `node:sqlite` database. */
  get unsafeHandle() {
    return this.#db;
  }

  #infoStatement() {
    this.#info ??= this.#db.prepare(
      "SELECT changes(), total_changes(), last_insert_rowid()",
    );
    this.#info.setReadBigInts(true);
    this.#info.setReturnArrays(true);
    return this.#info.get();
  }

  get changes() {
    return Number(this.#infoStatement()[0]);
  }

  get totalChanges() {
    return Number(this.#infoStatement()[1]);
  }

  get lastInsertRowId() {
    return Number(this.#infoStatement()[2]);
  }

  get autocommit() {
    return !this.#db.isTransaction;
  }

  get inTransaction() {
    return this.#open && this.#db.isTransaction;
  }

  get enableLoadExtension() {
    return this.#enableLoadExtension;
  }

  set enableLoadExtension(enabled) {
    this.#db.enableLoadExtension(enabled);
    this.#enableLoadExtension = enabled;
  }

  /** Prepares a native statement; used by `Statement`. */
  _prepareNative(sql) {
    return this.#db.prepare(sql);
  }

  /** Stops tracking a finalized statement; used by `Statement`. */
  _forget(stmt) {
    this.#statements.delete(stmt);
  }

  prepare(sql) {
    const stmt = new Statement(this, sql);
    this.#statements.add(stmt);
    return stmt;
  }

  exec(sql, ...params) {
    if (params.length === 0) {
      this.#db.exec(sql);
    } else {
      const stmt = this.prepare(sql);
      try {
        stmt.run(...params);
      } finally {
        stmt.finalize();
      }
    }
    return this.changes;
  }

  run(sql, ...params) {
    return this.exec(sql, ...params);
  }

  sql(strings, ...parameters) {
    const stmt = this.prepare(strings.join("?"));
    try {
      return stmt.all(...parameters);
    } finally {
      stmt.finalize();
    }
  }

  transaction(fn) {
    const controller = getController(this);
    const properties = {
      default: { value: wrapTransaction(fn, this, controller.default) },
      deferred: { value: wrapTransaction(fn, this, controller.deferred) },
      immediate: { value: wrapTransaction(fn, this, controller.immediate) },
      exclusive: { value: wrapTransaction(fn, this, controller.exclusive) },
      database: { value: this, enumerable: true },
    };
    Object.defineProperties(properties.default.value, properties);
    Object.defineProperties(properties.deferred.value, properties);
    Object.defineProperties(properties.immediate.value, properties);
    Object.defineProperties(properties.exclusive.value, properties);
    return properties.default.value;
  }

  function(name, fn, options = {}) {
    const wrapped = withArity(
      fn.length,
      (...args) => toFunctionResult(fn(...args.map(fromFunctionArg))),
    );
    this.#db.function(name, {
      varargs: options.varargs ?? false,
      deterministic: options.deterministic ?? false,
      directOnly: options.directOnly ?? false,
      useBigIntArguments: true,
    }, wrapped);
  }

  aggregate(name, options) {
    const step = withArity(
      options.step.length,
      (acc, ...args) => options.step(acc, ...args.map(fromFunctionArg)),
    );
    const final = options.final;
    this.#db.aggregate(name, {
      start: options.start,
      step,
      result: (acc) => toFunctionResult(final ? final(acc) : acc),
      varargs: options.varargs ?? false,
      deterministic: options.deterministic ?? false,
      directOnly: options.directOnly ?? false,
      useBigIntArguments: true,
    });
  }

  loadExtension(file, entryPoint) {
    if (!this.#enableLoadExtension) {
      throw new Error("Extension loading is not enabled");
    }
    this.#db.loadExtension(file, entryPoint);
  }

  openBlob() {
    throw new Error("@db/sqlite `openBlob()` is not available under Node");
  }

  backup() {
    throw new Error("@db/sqlite `backup()` is not available under Node");
  }

  close() {
    if (!this.#open) return;
    for (const stmt of [...this.#statements]) stmt.finalize();
    this.#info = undefined;
    this.#db.close();
    this.#open = false;
  }
}

const controllers = new WeakMap();

/** The database's transaction statements, as `@db/sqlite` keeps them. */
function getController(db) {
  let controller = controllers.get(db);
  if (!controller) {
    const shared = {
      commit: db.prepare("COMMIT"),
      rollback: db.prepare("ROLLBACK"),
      savepoint: db.prepare("SAVEPOINT `\t_bs3.\t`"),
      release: db.prepare("RELEASE `\t_bs3.\t`"),
      rollbackTo: db.prepare("ROLLBACK TO `\t_bs3.\t`"),
    };
    controller = {
      default: { begin: db.prepare("BEGIN"), ...shared },
      deferred: { begin: db.prepare("BEGIN DEFERRED"), ...shared },
      immediate: { begin: db.prepare("BEGIN IMMEDIATE"), ...shared },
      exclusive: { begin: db.prepare("BEGIN EXCLUSIVE"), ...shared },
    };
    controllers.set(db, controller);
  }
  return controller;
}

function wrapTransaction(
  fn,
  db,
  { begin, commit, rollback, savepoint, release, rollbackTo },
) {
  return function sqliteTransaction(...args) {
    let before, after, undo;
    if (db.inTransaction) {
      before = savepoint;
      after = release;
      undo = rollbackTo;
    } else {
      before = begin;
      after = commit;
      undo = rollback;
    }
    before.run();
    try {
      const result = fn.apply(this, args);
      after.run();
      return result;
    } catch (error) {
      if (!db.autocommit) {
        undo.run();
        if (undo !== rollback) after.run();
      }
      throw error;
    }
  };
}

const versionDb = new DatabaseSync(":memory:");

export const SQLITE_VERSION = versionDb.prepare("SELECT sqlite_version() v")
  .get().v;

export const SQLITE_SOURCEID = versionDb.prepare(
  "SELECT sqlite_source_id() v",
).get().v;

versionDb.close();

/**
 * Each result column's origin `(table, column)`, for a statement's
 * `unsafeHandle`. `node:sqlite`'s SQLite is built with
 * `SQLITE_ENABLE_COLUMN_METADATA`, which `StatementSync.columns()` reports.
 */
export function columnOriginsOf(handle) {
  return handle.columns().map((c) => ({ table: c.table, column: c.column }));
}
