// The column-origin binding after a bind that failed. Deno gives each test file
// its own module state, so the failure recorded here cannot reach
// v2-sqlite-column-origin-unbound.test.ts, which needs a module that has never
// tried to bind.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  columnOrigins,
  columnOriginUnavailableReason,
  ensureColumnOriginAvailable,
} from "../v2/sqlite/column-origin.ts";

Deno.test("a bind failure is recorded and surfaces in the reason and the throw", async () => {
  // Point @db/sqlite's own loader at a file that is not a library at all, so
  // the bind fails. ensureColumnOriginAvailable must resolve false, record
  // why, and make a later labeled read throw the reason. DENO_SQLITE_LOCAL
  // outranks DENO_SQLITE_PATH when it is "1", so it is cleared for the test.

  const notALibrary = Deno.makeTempFileSync({ suffix: ".dylib" });
  Deno.writeTextFileSync(notALibrary, "not a library");
  const previous = {
    DENO_SQLITE_PATH: Deno.env.get("DENO_SQLITE_PATH"),
    DENO_SQLITE_LOCAL: Deno.env.get("DENO_SQLITE_LOCAL"),
  };
  Deno.env.set("DENO_SQLITE_PATH", notALibrary);
  Deno.env.delete("DENO_SQLITE_LOCAL");
  try {
    assertEquals(await ensureColumnOriginAvailable(), false);

    const reason = columnOriginUnavailableReason();
    assertStringIncludes(reason ?? "", "$DENO_SQLITE_PATH");
    assertStringIncludes(reason ?? "", notALibrary);

    // A labeled read now fails loudly, carrying the recorded reason rather than
    // the generic "must resolve first" message.
    assertThrows(() => columnOrigins(null, 1), Error, reason!);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    Deno.removeSync(notALibrary);
  }
});
