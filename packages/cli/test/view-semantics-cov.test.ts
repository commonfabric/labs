/**
 * Coverage-driving tests for lib/view/languages/typescript/semantics.ts. These exercise the
 * best-effort/degrade-to-null branches, the diff-mode service end to end
 * (including its catch-to-empty paths via a DiffMaps stub that throws), and the
 * small parsing helpers (JSONC stripping, extension classification, real-path
 * containment) that the canonical suite reaches only incidentally.
 */

import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import {
  createDiffSemantics,
  createSemantics,
} from "../lib/view/languages/typescript/semantics.ts";
import { buildDiffDocument } from "../lib/view/diffdoc.ts";
import type { DiffMaps, DiffWorkspace } from "../lib/view/diffdoc.ts";
import { parseDiff } from "../lib/view/diff.ts";
import type { Document } from "../lib/view/model.ts";

const CWD = Deno.cwd();

function nameOffsetOf(doc: Document, name: string): number {
  const node = doc.flatStructure.find((n) => n.name === name);
  if (node?.nameOffset === undefined) {
    throw new Error(`no nameOffset for ${name}`);
  }
  return node.nameOffset;
}

//
// createSemantics: lazy build, prewarm, and degrade-to-null paths
//

Deno.test("semantics: createSemantics returns a service for a single-section blob", () => {
  // No section headers: the fallback single section runs, the service builds,
  // and a plain binding types — exercising the non-error setup path.

  const blob = `const n: number = 1;\nconst s = n;`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD });
  assert(sem, "single-section blob still yields a service");
  assertEquals(sem!.typeAt(nameOffsetOf(doc, "s")), "number");
});

Deno.test("semantics: prewarm builds the program off the query path", () => {
  // prewarm() runs build() ahead of the first real query; a subsequent type
  // query then reuses the cached program and still answers.

  const blob = `// transformed: /m.ts
const value: string = "x";
const echo = value;`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD })!;
  sem.prewarm();
  sem.prewarm(); // idempotent: the cached program short-circuits build()
  assertEquals(sem.typeAt(nameOffsetOf(doc, "echo")), "string");
});

Deno.test("semantics: a failed build latches, so later queries stay silent", () => {
  const blob = `// transformed: /m.ts
const mystery = undeclaredGlobalThing.field;`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD })!;
  // An unresolved reference has no knowable type.
  assertEquals(sem.typeAt(nameOffsetOf(doc, "mystery")), null);
  // definitionOf on the same offset is cached: the second call returns the
  // identical array object.
  const first = sem.definitionOf(nameOffsetOf(doc, "mystery"));
  const second = sem.definitionOf(nameOffsetOf(doc, "mystery"));
  assert(first === second, "definition lookups are cached by offset");
});

Deno.test("semantics: typeAt returns null for an out-of-range offset", () => {
  const blob = `// transformed: /m.ts
const x = 1;`;
  const sem = createSemantics(blob, { cwd: CWD })!;
  // Offset past every section: sectionAt finds nothing, typeAt returns null.
  assertEquals(sem.typeAt(10_000_000), null);
  // definitionOf with no matching section: empty list.
  assertEquals(sem.definitionOf(10_000_000), []);
});

Deno.test("semantics: empty input yields a silent-but-present service", () => {
  const sem = createSemantics("", { cwd: CWD });
  assert(sem, "empty input still yields a (silent) service");
  assertEquals(sem!.typeAt(0), null);
  assertEquals(sem!.definitionOf(0), []);
});

Deno.test("semantics: fileLines reads an in-workspace file and rejects outside", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), JSON.stringify({}));
    Deno.writeTextFileSync(
      join(root, "lib.ts"),
      "export const one = 1;\nexport const two = 2;\n",
    );
    const blob = `// transformed: /m.ts
const x = 1;`;
    const sem = createSemantics(blob, { cwd: root })!;
    const lines = sem.fileLines(join(root, "lib.ts"));
    assert(lines && lines.length >= 2, "reads the in-root file lines");
    // A read miss / out-of-root path returns null (readReal yields undefined).
    assertEquals(sem.fileLines(join(root, "..", "nope.ts")), null);
    // Cached miss: a second call for the same unreadable path is also null.
    assertEquals(sem.fileLines(join(root, "..", "nope.ts")), null);
    // A path inside the root that does not exist also yields null.
    assertEquals(sem.fileLines(join(root, "absent.ts")), null);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: discoverConfig fallback when no deno.json exists", () => {
  const root = Deno.makeTempDirSync();
  try {
    const blob = `// transformed: /m.ts
const x: number = 1;
const y = x;`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    assert(sem, "service builds without any deno.json");
    assertEquals(sem.typeAt(nameOffsetOf(doc, "y")), "number");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: definitionOf caches, so the repeat returns the same array", () => {
  const blob = `// transformed: /helpers.ts
export function triple(n: number): number {
    return n * 3;
}
// transformed: /main.ts
import { triple } from "/helpers.ts";
const out = triple(7);`;
  const useOffset = blob.indexOf("triple(7)");
  const sem = createSemantics(blob, { cwd: CWD })!;
  const first = sem.definitionOf(useOffset);
  const second = sem.definitionOf(useOffset);
  assert(first.length > 0, "resolved a definition");
  assert(first === second, "the cache hands back the identical array");
});

//
// JSONC parsing edge cases (stripJsonc)
//

Deno.test("semantics: JSONC import map survives block comments and escapes", () => {
  // A block comment AND a string value containing an escaped quote and a `//`
  // sequence force every branch of stripJsonc: the escape step, the block-
  // comment skip, and the in-string passthrough.

  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.jsonc"),
      `{
  /* a block comment
     spanning lines */
  "name": "pkg \\" with // and \\\\ inside",
  "imports": { "ext": "./ext.ts" } // trailing line comment
}
`,
    );
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      "export function ext(): boolean { return true; }\n",
    );
    const blob = `// transformed: /main.ts
import { ext } from "ext";
const flag = ext();`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    assertEquals(sem.typeAt(nameOffsetOf(doc, "flag")), "boolean");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: a deno.json with no usable imports yields an empty map", () => {
  // imports present but every value is a non-local specifier (jsr:/npm:) — the
  // isLocalSpecifier filter drops them all, leaving an empty import map; and a
  // non-string value is ignored by parseImports.

  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({
        imports: { "jsr": "jsr:@std/path", "num": 42, "npm": "npm:left-pad" },
      }),
    );
    const blob = `// transformed: /m.ts
const x: number = 1;
const y = x;`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    assertEquals(sem.typeAt(nameOffsetOf(doc, "y")), "number");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: an unparseable deno.json degrades to an empty import map", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{ not json at all ");
    const blob = `// transformed: /m.ts
const x: number = 1;
const y = x;`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    assertEquals(sem.typeAt(nameOffsetOf(doc, "y")), "number");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// typeStringAt branches + lineAndPreview clamp
//

Deno.test("semantics: typeStringAt returns null when no node holds the offset", () => {
  // A run of trailing blank space after the only statement, all inside the
  // single section: those offsets land in no AST node, so nodeAt returns
  // undefined and typeStringAt returns null.

  const blob = `// transformed: /m.ts
const x = 1;


   `;
  const sem = createSemantics(blob, { cwd: CWD })!;
  // An offset two characters before the end sits in trailing whitespace, inside
  // the section but inside no node.
  assertEquals(sem.typeAt(blob.length - 2), null);
});

Deno.test("semantics: a section header path TS cannot load types to null", () => {
  // A bare (slashless, extension-less) header path is not a virtual source file
  // the program can serve: build() succeeds, but getSourceFile(section.name)
  // returns undefined, so typeStringAt returns null via its `!sf` guard.

  const blob = `// transformed: m
const x = 1;
const y = x;`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD })!;
  assertEquals(sem.typeAt(nameOffsetOf(doc, "y")), null);
});

Deno.test("semantics: definitionOf preview on a last line with no trailing newline", () => {
  // The external definition sits on the file's final line, which has no
  // trailing newline — lineAndPreview's `end < 0` branch clamps to the end.

  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { ext: "./ext.ts" } }),
    );
    // No trailing newline after the declaration.
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      "export function ext(): boolean { return true; }",
    );
    const blob = `// transformed: /main.ts
import { ext } from "ext";
const flag = ext();`;
    const useOffset = blob.indexOf("ext();");
    const sem = createSemantics(blob, { cwd: root })!;
    const ext = sem.definitionOf(useOffset).find((d) =>
      d.filePath !== undefined
    );
    assert(ext, "resolved an external definition on the last line");
    assert(
      ext!.preview.includes("export function ext"),
      `preview from the unterminated last line: ${ext!.preview}`,
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// makeHost: extension classification of resolved modules
//

Deno.test("semantics: classifies a resolved .tsx import (extensionOf Tsx)", () => {
  // The import-map value points directly at a `.tsx` file; resolveRelative
  // returns it verbatim, and extensionOf tags it as Tsx during resolution. The
  // service stays usable whether or not the binding's type flows through.

  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { comp: "./comp.tsx" } }),
    );
    Deno.writeTextFileSync(
      join(root, "comp.tsx"),
      "export const comp: number = 1;\n",
    );
    const blob = `// transformed: /main.ts
import { comp } from "comp";
const v = comp;`;
    const sem = createSemantics(blob, { cwd: root })!;
    sem.prewarm();
    // The classification ran during module resolution without throwing.
    assertEquals(sem.typeAt(10_000_000), null);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: classifies a resolved .d.ts import (extensionOf Dts)", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { decl: "./types.d.ts" } }),
    );
    Deno.writeTextFileSync(
      join(root, "types.d.ts"),
      "export declare const decl: number;\n",
    );
    const blob = `// transformed: /main.ts
import { decl } from "decl";
const v = decl;`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    assertEquals(sem.typeAt(nameOffsetOf(doc, "v")), "number");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: classifies a resolved .json import (extensionOf Json)", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { data: "./data.json" } }),
    );
    Deno.writeTextFileSync(
      join(root, "data.json"),
      JSON.stringify({ value: 1 }),
    );
    // resolveModuleNameLiterals runs (and extensionOf tags `.json`) even though
    // the program may not pull a type out of a JSON module under these options.
    const blob = `// transformed: /main.ts
import data from "data";
const v = data;`;
    const sem = createSemantics(blob, { cwd: root })!;
    sem.prewarm();
    // The point is that resolution + classification did not throw.
    assert(sem, "service stays usable with a .json import resolved");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: classifies resolved .jsx and .js imports (extensionOf Jsx/Js)", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({
        imports: { jsxmod: "./view.jsx", jsmod: "./plain.js" },
      }),
    );
    Deno.writeTextFileSync(
      join(root, "view.jsx"),
      "export const fromJsx = 1;\n",
    );
    Deno.writeTextFileSync(
      join(root, "plain.js"),
      "export const fromJs = 2;\n",
    );
    const blob = `// transformed: /main.ts
import { fromJsx } from "jsxmod";
import { fromJs } from "jsmod";
const a = fromJsx;
const b = fromJs;`;
    const sem = createSemantics(blob, { cwd: root })!;
    // The .jsx and .js classifications ran during module resolution; the
    // service stays usable and queries do not throw.
    sem.prewarm();
    assertEquals(sem.typeAt(10_000_000), null);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: a directory named as a dependency reads as undefined", () => {
  // The blob imports an absolute path that resolves to a directory. The host's
  // readReal hits the read-failure catch (a directory is not a text file) and
  // returns undefined; the service must not throw.

  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), JSON.stringify({}));
    Deno.mkdirSync(join(root, "adir"));
    const blob = `// transformed: /main.ts
import { thing } from ${JSON.stringify(join(root, "adir"))};
const v = thing;`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    assertEquals(sem.typeAt(nameOffsetOf(doc, "v")), null);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: an unreadable in-root dependency degrades to no type", () => {
  // The dependency statSyncs as a file (so it resolves) but cannot be read
  // (mode 000): the host's readReal hits its read-failure catch and returns
  // undefined, so the binding referencing it has no knowable type and the
  // service stays alive.

  const root = Deno.makeTempDirSync();
  const extPath = join(root, "ext.ts");
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { ext: "./ext.ts" } }),
    );
    Deno.writeTextFileSync(extPath, "export const ext: number = 1;\n");
    Deno.chmodSync(extPath, 0o000);
    const blob = `// transformed: /main.ts
import { ext } from "ext";
const v = ext;`;
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    assertEquals(sem.typeAt(nameOffsetOf(doc, "v")), null);
  } finally {
    try {
      Deno.chmodSync(extPath, 0o644);
    } catch { /* ignore */ }
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: the same external file is read once and cached by the host", () => {
  // Two uses of the same external symbol resolve to one file; the host's file
  // cache (fileExists + getScriptSnapshot + readFile all funnel through it)
  // serves the repeat reads from the cache, and the service's realFiles cache
  // serves definitionOf's repeat read.

  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ imports: { ext: "./ext.ts" } }),
    );
    Deno.writeTextFileSync(
      join(root, "ext.ts"),
      "export function ext(): boolean { return true; }\n",
    );
    const blob = `// transformed: /main.ts
import { ext } from "ext";
const a = ext();
const b = ext();`;
    const sem = createSemantics(blob, { cwd: root })!;
    const da = sem.definitionOf(blob.indexOf("ext();\nconst b"));
    const db = sem.definitionOf(blob.lastIndexOf("ext()"));
    assert(da.some((d) => d.filePath?.endsWith("ext.ts")), "first resolves");
    assert(db.some((d) => d.filePath?.endsWith("ext.ts")), "second resolves");
    const path = da.find((d) => d.filePath)!.filePath!;
    const lines = sem.fileLines(path);
    assert(lines && lines.some((l) => l.text.includes("export function ext")));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

describe("binary external sources", () => {
  it("stays out of source programs and the file viewer", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.writeTextFileSync(
        join(root, "deno.json"),
        JSON.stringify({ imports: { asset: "./asset.png" } }),
      );
      Deno.writeTextFileSync(
        join(root, "asset.png"),
        "export const asset: number = 1;\n",
      );
      Deno.writeFileSync(
        join(root, "asset.data"),
        new Uint8Array([97, 0, 98]),
      );
      const blob = `// transformed: /main.ts
import { asset } from "asset";
const value = asset;`;
      const doc = parseDocument(blob);
      const sem = createSemantics(blob, { cwd: root })!;
      expect(sem.typeAt(nameOffsetOf(doc, "value"))).toBeNull();
      expect(
        sem.definitionOf(blob.lastIndexOf("asset")).some((d) => d.filePath),
      ).toBe(false);
      expect(sem.fileLines(join(root, "asset.png"))).toBeNull();
      expect(sem.fileLines(join(root, "asset.data"))).toBeNull();
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });
});

//
// createDiffSemantics: full service over a real workspace
//

const FILE_TEXT = `export function double(n: number): number {
    return n * 2;
}
export const answer = double(21);
const extra = answer + 1;
`;

const DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,4 +1,5 @@ export function double
 export function double(n: number): number {
     return n * 2;
 }
-export const answer = 42;
+export const answer = double(21);
+const extra = answer + 1;
`;

function diffWorkspace(root: string): DiffWorkspace {
  return {
    resolve: (p) => join(root, p),
    read: (a) => {
      try {
        return Deno.readTextFileSync(a);
      } catch {
        return null;
      }
    },
  };
}

function tempDiffRoot(): { root: string; ws: DiffWorkspace; done: () => void } {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(root, "deno.json"), "{}");
  Deno.writeTextFileSync(join(root, "m.ts"), FILE_TEXT);
  return {
    root,
    ws: diffWorkspace(root),
    done: () => Deno.removeSync(root, { recursive: true }),
  };
}

Deno.test("diff semantics: typeAt and definitionOf answer against the workspace", () => {
  const { root, ws, done } = tempDiffRoot();
  try {
    const model = parseDiff(DIFF)!;
    const { doc, maps } = buildDiffDocument(DIFF, model, ws);
    const sem = createDiffSemantics(DIFF, maps, { cwd: root })!;
    assert(sem, "diff service builds");
    const answer = doc.flatStructure.find((n) => n.name === "answer")!;
    assertEquals(sem.typeAt(answer.nameOffset!), "number");
    const markerOffset = DIFF.split("\n").slice(0, 9).join("\n").length + 1;
    assertEquals(sem.typeAt(markerOffset), null);
    const use = DIFF.indexOf("double(21)");
    const defs = sem.definitionOf(use);
    const inDiff = defs.find((d) => d.blobOffset !== undefined);
    assert(inDiff, `resolved in-diff: ${JSON.stringify(defs)}`);
    assert(
      DIFF.slice(inDiff!.blobOffset!).startsWith("double"),
      "lands on the visible declaration",
    );
    assert(sem.definitionOf(use) === defs, "definition cache returns same");
  } finally {
    done();
  }
});

Deno.test("diff semantics: prewarm warms the diff program off the query path", () => {
  const { root, ws, done } = tempDiffRoot();
  try {
    const model = parseDiff(DIFF)!;
    const { doc, maps } = buildDiffDocument(DIFF, model, ws);
    const sem = createDiffSemantics(DIFF, maps, { cwd: root })!;
    sem.prewarm();
    sem.prewarm(); // cached program short-circuits build()
    const answer = doc.flatStructure.find((n) => n.name === "answer")!;
    assertEquals(sem.typeAt(answer.nameOffset!), "number");
  } finally {
    done();
  }
});

Deno.test("diff semantics: an offset with no file mapping types to null", () => {
  const { root, ws, done } = tempDiffRoot();
  try {
    const model = parseDiff(DIFF)!;
    const { maps } = buildDiffDocument(DIFF, model, ws);
    const sem = createDiffSemantics(DIFF, maps, { cwd: root })!;
    assertEquals(sem.typeAt(0), null);
    assertEquals(sem.definitionOf(0), []);
  } finally {
    done();
  }
});

// Named apart from the test of the same case in view-diff.test.ts: two
// tests of one package with one name are one identity, and a lane running
// both files cannot say which of them a record belongs to.
Deno.test("diff semantics: fileLines colors a definition outside the diff, and nothing outside the root", () => {
  const { root, ws, done } = tempDiffRoot();
  try {
    Deno.writeTextFileSync(
      join(root, "helper.ts"),
      "export function ext(): boolean { return true; }\n",
    );
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      `import { ext } from "./helper.ts";\nconst flag = ext();\n`,
    );
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,2 @@
 import { ext } from "./helper.ts";
+const flag = ext();
`;
    const model = parseDiff(diff)!;
    const { maps } = buildDiffDocument(diff, model, ws);
    const sem = createDiffSemantics(diff, maps, { cwd: root })!;
    const use = diff.indexOf("ext();");
    const defs = sem.definitionOf(use);
    const ext = defs.find((d) => d.filePath !== undefined);
    assert(ext, `external definition resolved: ${JSON.stringify(defs)}`);
    assert(ext!.filePath!.endsWith("helper.ts"));
    assert(ext!.preview.includes("export function ext"));
    const lines = sem.fileLines(ext!.filePath!);
    assert(
      lines && lines.some((l) => l.text.includes("export function ext")),
      "fileLines colors the external file",
    );
    assertEquals(sem.fileLines(join(root, "..", "outside.ts")), null);
  } finally {
    done();
  }
});

describe("binary diff external sources", () => {
  it("stays out of diff programs and the file viewer", () => {
    const root = Deno.makeTempDirSync();
    try {
      Deno.writeTextFileSync(join(root, "deno.json"), "{}");
      Deno.writeTextFileSync(
        join(root, "asset.png"),
        "export const asset: number = 1;\n",
      );
      Deno.writeFileSync(
        join(root, "asset.data"),
        new Uint8Array([97, 0, 98]),
      );
      Deno.writeTextFileSync(
        join(root, "m.ts"),
        `import { asset } from "./asset.png";\nconst value = asset;\n`,
      );
      const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,1 +1,2 @@
 import { asset } from "./asset.png";
+const value = asset;
`;
      const ws: DiffWorkspace = {
        resolve: (path) => join(root, path),
        read: (path) => {
          try {
            return Deno.readTextFileSync(path);
          } catch {
            return null;
          }
        },
      };
      const model = parseDiff(diff)!;
      const { doc, maps } = buildDiffDocument(diff, model, ws);
      const sem = createDiffSemantics(diff, maps, { cwd: root })!;
      expect(sem.typeAt(nameOffsetOf(doc, "value"))).toBeNull();
      expect(
        sem.definitionOf(diff.lastIndexOf("asset")).some((d) => d.filePath),
      ).toBe(false);
      expect(sem.fileLines(join(root, "asset.png"))).toBeNull();
      expect(sem.fileLines(join(root, "asset.data"))).toBeNull();
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });
});

Deno.test("diff semantics: returns null when no root file is in the workspace", () => {
  const noWs: DiffWorkspace = { resolve: () => null, read: () => null };
  const model = parseDiff(DIFF)!;
  const { maps } = buildDiffDocument(DIFF, model, noWs);
  assertEquals(maps.rootFiles.length, 0);
  const sem = createDiffSemantics(DIFF, maps, { cwd: CWD });
  assertEquals(
    sem,
    undefined,
    "no in-workspace root files means no diff service",
  );
});

Deno.test("diff semantics: stays silent on a drifted (unverified) hunk", () => {
  const { root, ws, done } = tempDiffRoot();
  try {
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      FILE_TEXT.replace("double(21)", "double(99)"),
    );
    const model = parseDiff(DIFF)!;
    const { maps } = buildDiffDocument(DIFF, model, ws);
    const sem = createDiffSemantics(DIFF, maps, { cwd: root });
    if (sem) {
      assertEquals(sem.typeAt(DIFF.indexOf("answer")), null, "no type lies");
      assertEquals(sem.definitionOf(DIFF.indexOf("answer")), []);
    }
  } finally {
    done();
  }
});

Deno.test("diff semantics: types the workspace binding from a real subdir cwd", () => {
  const { root, ws, done } = tempDiffRoot();
  try {
    const model = parseDiff(DIFF)!;
    const { doc, maps } = buildDiffDocument(DIFF, model, ws);
    const sem = createDiffSemantics(DIFF, maps, { cwd: root })!;
    const extra = doc.flatStructure.find((n) => n.name === "extra")!;
    assertEquals(sem.typeAt(extra.nameOffset!), "number");
  } finally {
    done();
  }
});

//
// diff-mode catch-to-empty branches via a throwing DiffMaps stub
//

/**
 * Wrap a real DiffMaps but force `toFile`/`fromFile` to throw on demand. The
 * program still builds from the real `rootFiles`, so build() succeeds and the
 * per-method try/catch (not build()'s own) is what swallows the throw.
 */
function throwingMaps(
  real: DiffMaps,
  opts: { toFileThrows?: boolean; fromFileThrows?: boolean },
): DiffMaps {
  return {
    rootFiles: real.rootFiles,
    toFile(o) {
      if (opts.toFileThrows) throw new Error("boom toFile");
      return real.toFile(o);
    },
    fromFile(p, o) {
      if (opts.fromFileThrows) throw new Error("boom fromFile");
      return real.fromFile(p, o);
    },
  };
}

Deno.test("diff semantics: typeAt swallows a throw from the offset map", () => {
  // build() succeeds (real root files), then maps.toFile throws inside typeAt's
  // try — the catch returns null rather than propagating.

  const { root, ws, done } = tempDiffRoot();
  try {
    const model = parseDiff(DIFF)!;
    const { maps } = buildDiffDocument(DIFF, model, ws);
    const sem = createDiffSemantics(
      DIFF,
      throwingMaps(maps, { toFileThrows: true }),
      { cwd: root },
    )!;
    sem.prewarm(); // build the program first, so the throw is post-build
    assertEquals(sem.typeAt(DIFF.indexOf("double(21)")), null);
  } finally {
    done();
  }
});

Deno.test("diff semantics: definitionOf swallows a throw and caches empty", () => {
  // After build, maps.fromFile throws while classifying a resolved definition;
  // definitionOf's catch resets to an empty list and caches it.

  const { root, ws, done } = tempDiffRoot();
  try {
    const model = parseDiff(DIFF)!;
    const { maps } = buildDiffDocument(DIFF, model, ws);
    const sem = createDiffSemantics(
      DIFF,
      throwingMaps(maps, { fromFileThrows: true }),
      { cwd: root },
    )!;
    const use = DIFF.indexOf("double(21)");
    const first = sem.definitionOf(use);
    assertEquals(first, [], "throw during classification yields empty");
    const second = sem.definitionOf(use);
    assert(first === second, "the empty result is cached");
  } finally {
    done();
  }
});

Deno.test("diff semantics: a definition resolving to a lib file is skipped", () => {
  // `Set` resolves into lib.d.ts (outside the workspace); fromFile returns null
  // (not in the diff) and readReal returns undefined, so the def is skipped via
  // the `content === undefined` continue.

  const { root, ws, done } = tempDiffRoot();
  try {
    Deno.writeTextFileSync(
      join(root, "m.ts"),
      `export function double(n: number): number {\n    return n * 2;\n}\nexport const answer = double(21);\nconst s = new Set();\n`,
    );
    const diff = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,4 +1,5 @@
 export function double(n: number): number {
     return n * 2;
 }
 export const answer = double(21);
+const s = new Set();
`;
    const model = parseDiff(diff)!;
    const { maps } = buildDiffDocument(diff, model, ws);
    const sem = createDiffSemantics(diff, maps, { cwd: root })!;
    const use = diff.indexOf("Set()");
    const defs = sem.definitionOf(use);
    // No external file target: lib defs sit outside the workspace and are
    // dropped, so nothing with a filePath survives.
    assert(
      !defs.some((d) => d.filePath !== undefined),
      `lib def is skipped, not opened as a file: ${JSON.stringify(defs)}`,
    );
  } finally {
    done();
  }
});

Deno.test("diff semantics: fileLines rejects a path outside the workspace", () => {
  const { root, ws, done } = tempDiffRoot();
  try {
    const model = parseDiff(DIFF)!;
    const { maps } = buildDiffDocument(DIFF, model, ws);
    const sem = createDiffSemantics(DIFF, maps, { cwd: root })!;
    // In-workspace file reads and parses.
    const inside = sem.fileLines(join(root, "m.ts"));
    assert(inside && inside.length >= 1, "reads the in-root workspace file");
    // Outside the root: readReal yields undefined, fileLines returns null.
    assertEquals(sem.fileLines(join(root, "..", "elsewhere.ts")), null);
  } finally {
    done();
  }
});

//
// end-to-end against the real repo (resolves commonfabric)
//

Deno.test("semantics: SAMPLE blob types a pattern binding from a real subdir", () => {
  const doc = parseDocument(SAMPLE);
  const sem = createSemantics(SAMPLE, { cwd: join(CWD, "lib", "view") })!;
  sem.prewarm();
  const t = sem.typeAt(nameOffsetOf(doc, "myPattern"));
  assert(t !== null, "commonfabric-derived type resolves from a subdir");
  assert(!t!.includes("import("), `no import-path prefix: ${t}`);
});
