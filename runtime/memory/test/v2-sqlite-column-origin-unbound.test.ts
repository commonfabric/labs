// The column-origin binding before anything has tried to bind it. Deno gives
// each test file its own module state, so `cached` starts undefined here: the
// state the server sees before the first labeled query. The sibling files
// v2-sqlite-column-origin-bind-failure.test.ts and
// v2-sqlite-column-origin.test.ts cover a failed bind and the bound, happy
// path. Each of the three needs module state of its own.

import { assertThrows } from "@std/assert";
import { columnOrigins } from "../v2/sqlite/column-origin.ts";

Deno.test("columnOrigins throws before the FFI is bound", () => {
  // Nothing has bound the FFI and no reason has been recorded: columnOrigins
  // must refuse rather than read through a null library handle, and the
  // message names the call the caller skipped.

  assertThrows(
    () => columnOrigins(null, 1),
    Error,
    "column-origin FFI not bound",
  );
  assertThrows(
    () => columnOrigins(null, 1),
    Error,
    "ensureColumnOriginAvailable() must resolve",
  );
});
