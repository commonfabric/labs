/**
 * Coverage-gate tests for `lib/view/diffedit.ts`.
 *
 * `save` collects each verified hunk's path into `byFile`, then looks the path's
 * pristine content up in the captured `fileText` before splicing. When a
 * verified hunk's path made it into `byFile` but no base content was captured
 * for it, the splice loop skips that path. This drives that skip with a diff
 * that parses into a real hunk whose recorded path is deliberately absent from
 * `fileText`.
 */

import { assertEquals } from "@std/assert";
import { type DiffEdit, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";

Deno.test("diffedit gate: save skips a verified hunk whose path parsed but has no captured base content", () => {
  // A real one-file, one-hunk diff that `parseDiff` accepts (a `diff --git`
  // header, a `---`/`+++` pair, and a counted body), so save's `modelHunks`
  // holds one hunk and matches it to the recorded `hunks[0]`.
  const text = [
    "diff --git a/m.ts b/m.ts",
    "--- a/m.ts",
    "+++ b/m.ts",
    "@@ -1,1 +1,1 @@",
    "-old line",
    "+only line",
    "",
  ].join("\n");
  // The recorded hunk is verified and carries an absolute path, so save pushes
  // it into `byFile`. But `fileText` holds a different path, so when the splice
  // loop fetches the base content for the hunk's path it gets `undefined` and
  // skips that path — leaving nothing written.
  const edit: DiffEdit = {
    lines: new Map([[5, { absPath: "/ghost/m.ts", newLine: 0, markerLen: 1 }]]),
    fileText: new Map([["/unrelated/other.ts", "kept\n"]]),
    oldFileLines: [],
    languages: [],
    hunks: [
      { absPath: "/ghost/m.ts", newStart: 1, newCount: 1, verified: true },
    ],
  };
  const ws: DiffWorkspace = { resolve: () => null, read: () => null };
  const src = diffSource(ws, edit);
  assertEquals(
    src.editable,
    true,
    "a non-empty lines map is the editable source",
  );
  assertEquals(
    src.save(text, src.lineEndingProvenance!(text)),
    "Saved 0 files",
    "a path with no captured base content is skipped, leaving nothing written",
  );
});
