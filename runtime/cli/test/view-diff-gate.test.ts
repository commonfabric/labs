import { assertEquals } from "@std/assert";
import { parseDiff } from "../lib/view/diff.ts";

//
// Coverage-gate tests for the C-style quoted-path decoder in lib/view/diff.ts.
// They drive the decoder's malformed-input fallbacks, which the canonical suite
// only reaches with well-formed quoted paths: a backslash as the final byte
// before the string ends (no closing quote), an unrecognized escape character,
// and a quoted path that never closes its quote at all. Each fall-through hands
// the path to the surrounding-quote strip so the name is never dropped.
//

Deno.test("diff: a quoted path whose final byte is a lone backslash falls back", () => {
  // The path opens its quote, then ends on a backslash with nothing after it:
  // the escape has no following byte, so the decoder cannot interpret it and
  // returns the surrounding-quote strip (leading quote removed, no trailing one
  // to remove). The `a/` prefix then comes off, leaving the bare backslash.
  const diff = `--- "a/x\\
+++ "b/y\\
@@ -1,1 +1,1 @@
-old
+new
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files.length, 1);
  assertEquals(model.files[0].oldPath, "x\\", "trailing backslash survives");
  assertEquals(model.files[0].newPath, "y\\");
});

Deno.test("diff: a quoted path with an unrecognized escape falls back verbatim", () => {
  // `\z` is neither an octal byte escape nor one of the single-character escapes
  // git emits (`\a \b \t \n \v \f \r \" \\`). The decoder gives up on the
  // unknown escape and returns the surrounding-quote strip, so the literal
  // backslash-z is preserved rather than silently dropped.
  const diff = `--- "a/x\\z.ts"
+++ "b/y\\z.ts"
@@ -1,1 +1,1 @@
-old
+new
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files.length, 1);
  assertEquals(
    model.files[0].oldPath,
    "x\\z.ts",
    "unknown escape kept literal",
  );
  assertEquals(model.files[0].newPath, "y\\z.ts");
});

Deno.test("diff: a quoted path that never closes its quote falls back", () => {
  // The opening quote is present but there is no closing quote and no backslash
  // escape: the decode loop walks every byte without ever returning, then exits
  // and the no-closing-quote fallback strips the leading quote. The `a/` prefix
  // comes off, leaving the plain name.
  const diff = `--- "a/x.ts
+++ "b/y.ts
@@ -1,1 +1,1 @@
-old
+new
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files.length, 1);
  assertEquals(model.files[0].oldPath, "x.ts", "unterminated quote stripped");
  assertEquals(model.files[0].newPath, "y.ts");
});
