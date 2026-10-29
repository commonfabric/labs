import { assertEquals } from "@std/assert";
import { parseDiff } from "../lib/view/diff.ts";

//
// Coverage-focused tests for lib/view/diff.ts, exercising body-loop branches
// the canonical suite does not reach: a `\ No newline` marker *inside* a hunk
// body, a malformed body line that stops the hunk, the empty trailing-context
// fallback, and a quoted file path in the `---`/`+++` headers.
//

Deno.test("diff: a `\\ No newline` marker mid-body is metadata, the body continues", () => {
  // git emits the no-newline marker for the OLD side between the removal and
  // the addition when the pre-image had no trailing newline. The marker arrives
  // while the new side still has a line to consume, so it is classified inside
  // the body loop (not by the trailing-marker branch) and parsing continues to
  // the `+` line that follows.
  const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files.length, 1);
  const lines = diff.split("\n");
  const delIdx = lines.indexOf("-old");
  const markerIdx = lines.findIndex((l) => l.startsWith("\\"));
  const addIdx = lines.indexOf("+new");
  // The removal classifies, the in-body marker is meta, and the following
  // addition still classifies (the body loop did not stop at the marker).
  assertEquals(model.lines[delIdx], { kind: "del", oldLine: 0 });
  assertEquals(model.lines[markerIdx].kind, "meta", "in-body marker is meta");
  assertEquals(model.lines[addIdx], { kind: "add", newLine: 0 });
  // Both counted lines were consumed, so the hunk closes right after the add.
  assertEquals(model.files[0].hunks[0].endLine, addIdx);
});

Deno.test("diff: a malformed body line stops the hunk leniently", () => {
  // After one context line is consumed, an out-of-grammar line (no `\`, `+`,
  // `-`, space, and non-empty) arrives while both counts still have lines to
  // go. The body loop breaks on it; the stray line and everything after it
  // classify as `other`, and the hunk's range stops at the last good body line.
  const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 keep
GARBAGE not a diff line
 tail
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files.length, 1);
  const lines = diff.split("\n");
  const ctxIdx = lines.indexOf(" keep");
  const garbageIdx = lines.indexOf("GARBAGE not a diff line");
  // The first context line classified; the malformed line did not.
  assertEquals(model.lines[ctxIdx], { kind: "ctx", newLine: 0, oldLine: 0 });
  assertEquals(
    model.lines[garbageIdx].kind,
    "other",
    "break leaves it `other`",
  );
  // The hunk ended at the last consumed body line (the one context line), so
  // its end is the context line, not the garbage or the trailing line.
  assertEquals(model.files[0].hunks[0].endLine, ctxIdx);
});

Deno.test("diff: a hunk header with no trailing context yields an empty context", () => {
  // The `@@ … @@` header has no enclosing-function suffix: the context field
  // trims to the empty string rather than carrying junk.
  const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@
-old
+new
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files[0].hunks[0].context, "", "no context suffix");

  // And a header WITH a (whitespace-padded) suffix trims to just the text.
  const withCtx = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,1 @@   export function f
-old
+new
`;
  const m2 = parseDiff(withCtx)!;
  assertEquals(m2.files[0].hunks[0].context, "export function f", "trimmed");
});

Deno.test("diff: quoted paths in `---`/`+++` headers are unquoted", () => {
  // git quotes paths containing spaces (or other special bytes). The quotes are
  // stripped so the stored path is the bare name.
  const diff = `diff --git a/with space.ts b/with space.ts
--- "a/with space.ts"
+++ "b/with space.ts"
@@ -1,1 +1,1 @@
-old
+new
`;
  const model = parseDiff(diff)!;
  assertEquals(model.files.length, 1);
  assertEquals(model.files[0].oldPath, "with space.ts", "old quotes stripped");
  assertEquals(model.files[0].newPath, "with space.ts", "new quotes stripped");

  // A quoted path that also carries a trailing timestamp still unquotes: the
  // tab-split keeps the quoted path, then the quotes come off.
  const withTs = `--- "a/x y.ts"\t2026-06-11 15:08:19
+++ "b/x y.ts"\t2026-06-11 15:08:25
@@ -1,1 +1,1 @@
-old
+new
`;
  const m2 = parseDiff(withTs)!;
  assertEquals(m2.files[0].oldPath, "x y.ts");
  assertEquals(m2.files[0].newPath, "x y.ts");
});

Deno.test("diff: a `\\` mid-body and a malformed line in the same parse", () => {
  // A belt-and-braces case: a no-newline marker arrives mid-body and is meta,
  // and a later hunk's body has a malformed line that stops it. Confirms the
  // two lenient branches coexist across hunks in one file.
  const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,2 @@
 ctxA
\\ No newline at end of file
+added
@@ -10,2 +11,2 @@
 ctxB
@@@ junk
`;
  const model = parseDiff(diff)!;
  const f = model.files[0];
  assertEquals(f.hunks.length, 2, "both hunks parsed");
  const lines = diff.split("\n");
  const markerIdx = lines.findIndex((l) => l.startsWith("\\"));
  assertEquals(model.lines[markerIdx].kind, "meta");
  const addIdx = lines.indexOf("+added");
  assertEquals(model.lines[addIdx], { kind: "add", newLine: 1 });
  const junkIdx = lines.indexOf("@@@ junk");
  assertEquals(model.lines[junkIdx].kind, "other", "malformed body broke out");
  // The second hunk ended at its last good context line.
  assertEquals(f.hunks[1].endLine, lines.indexOf(" ctxB"));
});
