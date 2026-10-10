// Stand-in for `jsr:@denosaurs/plug`, which downloads and caches native
// libraries for `Deno.dlopen`. Node has no FFI, so the only library this
// serves is the one `@db/sqlite` would have loaded: `download()` of the
// `sqlite3` release names `NODE_SQLITE_LIBRARY`, and `Deno.dlopen()` of that
// name binds the symbols the workspace declares against it to `node:sqlite`.
//
// The symbols are the column-origin pair (`sqlite3_column_table_name` and
// `sqlite3_column_origin_name`), which take a statement's `unsafeHandle` and
// return a C string. Here a "pointer" is an object carrying the string, and
// `Deno.UnsafePointerView` reads it back.
//
// Mapped from `jsr:@denosaurs/plug` by `hooks.mjs`.

import { columnOriginsOf } from "./sqlite.mjs";

/** The library name `download()` returns for `@db/sqlite`'s release. */
export const NODE_SQLITE_LIBRARY = "node:sqlite";

const CSTRING = Symbol("cstring");

/** A fake C-string pointer, or `null` for a `null` string. */
function cstringPointer(value) {
  return value === null ? null : { [CSTRING]: value };
}

const SQLITE_SYMBOLS = {
  sqlite3_column_table_name: (handle, i) =>
    cstringPointer(columnOriginsOf(handle)[i]?.table ?? null),
  sqlite3_column_origin_name: (handle, i) =>
    cstringPointer(columnOriginsOf(handle)[i]?.column ?? null),
};

class UnsafePointerView {
  #pointer;

  constructor(pointer) {
    this.#pointer = pointer;
  }

  getCString() {
    return UnsafePointerView.getCString(this.#pointer);
  }

  static getCString(pointer) {
    if (pointer && Object.hasOwn(pointer, CSTRING)) return pointer[CSTRING];
    throw new Error("Deno.UnsafePointerView: not available under Node");
  }
}

const Deno = globalThis.Deno;
const priorDlopen = Deno.dlopen;

Deno.dlopen = (path, symbols) => {
  if (path !== NODE_SQLITE_LIBRARY) {
    if (priorDlopen) return priorDlopen(path, symbols);
    throw new Error(`Deno.dlopen: no FFI under Node (opening ${path})`);
  }
  const bound = {};
  for (const name of Object.keys(symbols)) {
    if (!Object.hasOwn(SQLITE_SYMBOLS, name)) {
      throw new Error(
        `Deno.dlopen: symbol ${name} is not available from node:sqlite`,
      );
    }
    bound[name] = SQLITE_SYMBOLS[name];
  }
  return { symbols: bound, close() {} };
};
Deno.UnsafePointerView ??= UnsafePointerView;

export function download(options) {
  const name = typeof options === "string" ? options : options?.name;
  if (name === "sqlite3") return Promise.resolve(NODE_SQLITE_LIBRARY);
  return Promise.reject(
    new Error(`plug: cannot download native library ${name} under Node`),
  );
}
