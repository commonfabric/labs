// Sound read-label provenance via SQLite column-origin metadata.
//
// `@db/sqlite` returns rows keyed by the SELECT's OUTPUT column names, which is
// unsound for CFC labeling: `SELECT body AS x` hides a confidential column, and
// `SELECT subject AS from_email` spoofs another column's name. The bundled
// libsqlite3 is compiled with SQLITE_ENABLE_COLUMN_METADATA, so we ask the
// engine for each result column's TRUE origin `(table, column)` via FFI on the
// prepared statement's `unsafeHandle`:
//   - alias  `from_email AS r`      -> origin (emails, from_email)   [resolved]
//   - spoof  `subject AS from_email`-> origin (emails, subject)      [defeated]
//   - expr   `upper(from_email)`    -> origin (null, null)           [fail closed]
//
// We are NOT switching SQLite implementations: this binds the SAME libsqlite3
// `@db/sqlite` already loaded (compiled with SQLITE_ENABLE_COLUMN_METADATA). The
// origin symbols live in that lib but `@db/sqlite` doesn't expose them, so we
// `Deno.dlopen` its file to declare them. We pick that file the way `@db/sqlite`
// picks it, in its order: `DENO_SQLITE_LOCAL`, then `DENO_SQLITE_PATH`, then
// plug's `download({ cache: "use" })`, which on a cache hit just RETURNS the
// already-downloaded path (no network, no scanning). Exactly one of those is
// opened. Opening a file other than the one `@db/sqlite` opened would give the
// process a second libsqlite3 image, so a source that can't be opened reports
// why and leaves provenance unavailable. Resolution is async, so call
// `ensureColumnOriginAvailable()` once before issuing labeled queries;
// `columnOrigins()` then reads the memoized handle synchronously.

import { download } from "@denosaurs/plug";

type OriginLib = {
  origin: Deno.DynamicLibrary<{
    sqlite3_column_origin_name: {
      parameters: ["pointer", "i32"];
      result: "pointer";
    };
    sqlite3_column_table_name: {
      parameters: ["pointer", "i32"];
      result: "pointer";
    };
  }>;
};

let cached: OriginLib | null | undefined;
let problem: string | undefined;
let pending: Promise<Resolution> | undefined;

const SYMBOLS = {
  sqlite3_column_origin_name: {
    parameters: ["pointer", "i32"],
    result: "pointer",
  },
  sqlite3_column_table_name: {
    parameters: ["pointer", "i32"],
    result: "pointer",
  },
} as const;

// The `@db/sqlite` prebuilt release. `@db/sqlite` builds its own download URL
// from its package version, so this must be the version the lockfile resolves
// `@db/sqlite` to. Plug's cache is keyed by URL: a different version here names
// a different file, and dlopen'ing that gives the process a second libsqlite3
// image instead of the one `@db/sqlite` loaded. Each image carries its own copy
// of SQLite's global state, and `@db/sqlite` calls `sqlite3_initialize()` only
// on the image it loaded, so a statement handle passed into the second image
// segfaults. Calling `sqlite3_initialize()` on the second image stops the crash
// and is not the repair: two initialized images still hold separate allocators
// and mutexes, and would then share handles. The requirement is one image, so
// both bindings must name one file. `deno test` in this package checks this
// version against the lockfile.
export const SQLITE3_RELEASE_VERSION = "0.13.0";

const SQLITE3_RELEASE = {
  name: "sqlite3",
  url:
    `https://github.com/denodrivers/sqlite3/releases/download/${SQLITE3_RELEASE_VERSION}/`,
  suffixes: { aarch64: "_aarch64" },
  cache: "use",
} as const;

/** The libsqlite3 `@db/sqlite` loads. `local` is the build in its own checkout,
 *  `path` is `$DENO_SQLITE_PATH`, `release` is the pinned prebuilt. */
export type LibrarySource =
  | { kind: "local" }
  | { kind: "path"; path: string }
  | { kind: "release" };

/** `@db/sqlite` reads these vars behind a try/catch so a denied `--allow-env`
 *  falls through to its default rather than throwing; this does the same. Only a
 *  denied read is swallowed — `NotCapable` on current Deno, `PermissionDenied` on
 *  older ones — and reported as the var being unset; any other failure is
 *  unexpected and propagates. */
function readEnv(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch (e) {
    if (
      e instanceof Deno.errors.NotCapable ||
      e instanceof Deno.errors.PermissionDenied
    ) {
      return undefined;
    }
    throw e;
  }
}

/**
 * Which libsqlite3 `@db/sqlite` will load, in the branch order its own `ffi.ts`
 * uses: `DENO_SQLITE_LOCAL` outranks `DENO_SQLITE_PATH`, and with neither set it
 * takes the release its package version names.
 */
export function librarySource(
  getEnv: (key: string) => string | undefined = readEnv,
): LibrarySource {
  if (getEnv("DENO_SQLITE_LOCAL") === "1") return { kind: "local" };
  const path = getEnv("DENO_SQLITE_PATH");
  return path ? { kind: "path", path } : { kind: "release" };
}

type Resolution = { lib: OriginLib } | { problem: string };

const describe = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Open one source, or report why it could not be opened. Only the source
 * `@db/sqlite` itself uses is ever opened: any other file would give the process
 * a second libsqlite3 image, so there is nothing to fall back to.
 */
export async function openSource(source: LibrarySource): Promise<Resolution> {
  if (source.kind === "local") {
    return {
      problem:
        "DENO_SQLITE_LOCAL=1 points @db/sqlite at the libsqlite3 built in its " +
        "own checkout, and that path is not derived here",
    };
  }
  let path: string;
  let label: string;
  if (source.kind === "path") {
    path = source.path;
    label = "$DENO_SQLITE_PATH";
  } else {
    label = `the pinned libsqlite3 release ${SQLITE3_RELEASE_VERSION}`;
    try {
      path = await download(SQLITE3_RELEASE);
    } catch (e) {
      return { problem: `${label} could not be resolved (${describe(e)})` };
    }
  }
  try {
    return { lib: { origin: Deno.dlopen(path, SYMBOLS) } };
  } catch (e) {
    return {
      problem:
        `${label} names ${path}, whose column-origin symbols could not ` +
        `be bound (${describe(e)}). A libsqlite3 built without ` +
        `SQLITE_ENABLE_COLUMN_METADATA does not export them.`,
    };
  }
}

/**
 * Resolve + dlopen the column-origin symbols against `@db/sqlite`'s own
 * libsqlite3 (memoized, single-flight). Async because the path comes from plug.
 * Callers that need provenance MUST await this before `columnOrigins()` and fail
 * loudly when it returns false.
 */
export async function ensureColumnOriginAvailable(): Promise<boolean> {
  if (cached === undefined) {
    pending ??= openSource(librarySource());
    const resolution = await pending;
    if ("lib" in resolution) {
      cached = resolution.lib;
    } else {
      cached = null;
      problem = resolution.problem;
    }
  }
  return cached !== null;
}

/** True if the column-origin lib is bound — meaningful only AFTER
 *  `ensureColumnOriginAvailable()` has resolved. */
export function columnOriginAvailable(): boolean {
  return !!cached;
}

/** Why the symbols could not be bound, once `ensureColumnOriginAvailable()` has
 *  resolved false. Undefined while they are bound or unresolved. */
export function columnOriginUnavailableReason(): string | undefined {
  return cached === null ? problem : undefined;
}

export type ColumnOrigin = {
  /** Origin table, or null for an expression/computed/compound column. */
  table: string | null;

  /** Origin column, or null when there is no single source column. */
  column: string | null;
};

const cstr = (p: Deno.PointerValue): string | null =>
  p === null ? null : new Deno.UnsafePointerView(p).getCString();

/**
 * Per-result-column TRUE origin for a prepared `@db/sqlite` statement. `count`
 * is the number of result columns (`stmt.columnNames().length`). A column with
 * no single source (expression, literal, some compound selects) reports
 * `{ table: null, column: null }` — callers MUST fail closed on that.
 *
 * Throws if the lib isn't bound — call `ensureColumnOriginAvailable()` first; a
 * labeled query fails loudly rather than silently mislabeling.
 */
export function columnOrigins(
  stmtHandle: Deno.PointerValue,
  count: number,
): ColumnOrigin[] {
  const l = cached ?? null;
  if (!l) {
    throw new Error(
      "sqlite: column-origin FFI not bound — " +
        (problem ??
          "ensureColumnOriginAvailable() must resolve before a labeled query " +
            "reads column provenance"),
    );
  }
  const out: ColumnOrigin[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      table: cstr(l.origin.symbols.sqlite3_column_table_name(stmtHandle, i)),
      column: cstr(l.origin.symbols.sqlite3_column_origin_name(stmtHandle, i)),
    });
  }
  return out;
}
