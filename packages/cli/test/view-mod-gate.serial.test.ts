/**
 * Coverage gate for mod.ts: drives safeCwd()'s catch branch.
 *
 * safeCwd() returns Deno.cwd(), falling back to "." when that throws. The
 * source path's lazy semantics closure evaluates `{ cwd: safeCwd(), ... }`, so
 * removing the process working directory before invoking that closure forces
 * Deno.cwd() to throw NotFound and runs the fallback.
 */

import { assert } from "@std/assert";
import { buildView } from "../lib/view/mod.ts";

const SRC = "export const x = 1;\nconst y = x + 1;\n";

Deno.test("buildView: safeCwd falls back to '.' when Deno.cwd() throws", () => {
  // Build the source-path view while the cwd is still valid; semantics are lazy.
  const r = buildView(SRC, "transformed.ts");
  assert(r.doc.lines.length > 0);

  const original = Deno.cwd();
  const removed = Deno.makeTempDirSync();
  Deno.chdir(removed);
  Deno.removeSync(removed);
  try {
    // Deno.cwd() now throws NotFound. Invoking the semantics closure evaluates
    // `{ cwd: safeCwd(), ... }`, so safeCwd() runs first and must swallow the
    // throw and return "." rather than propagate. discoverConfig downstream is
    // itself guarded, so the closure completes.
    const s = r.semantics();
    assert(
      s === undefined || typeof s.prewarm === "function",
      "semantics resolves with the cwd fallback in place",
    );
  } finally {
    Deno.chdir(original);
  }
});
