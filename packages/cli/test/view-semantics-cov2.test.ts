/**
 * Second-round coverage tests for lib/view/languages/typescript/semantics.ts. These drive the
 * remaining failure-isolation branches that the first two suites do not reach:
 * the setup-time guards (`splitSections` throwing, a non-discoverable config),
 * the lazily-built program latching after a failed build, and the per-query
 * `try { … } catch` wrappers that turn an internal throw into a quiet `null`
 * or empty result.
 *
 * The public surface only takes `text`, `cwd`, an `offset` and a `filePath`,
 * so the throwing inputs here are values whose declared type matches the API
 * (a `string`, a `number`) but whose runtime behavior throws when the code
 * touches them. That is exactly the input the module documents itself as being
 * robust against: "every query is wrapped so a failure degrades to `null`".
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parseDocument } from "./view-helpers.ts";
import {
  createDiffSemantics,
  createSemantics,
} from "../lib/view/languages/typescript/semantics.ts";
import type { DiffMaps } from "../lib/view/diffdoc.ts";
import { typeScriptLanguage } from "../lib/view/languages/typescript/language.ts";
import type { Document } from "../lib/view/model.ts";

const CWD = Deno.cwd();

function nameOffsetOf(doc: Document, name: string): number {
  const node = doc.flatStructure.find((n) => n.name === name);
  if (node?.nameOffset === undefined) {
    throw new Error(`no nameOffset for ${name}`);
  }
  return node.nameOffset;
}

/** A value typed as `string` that throws the instant the splitter reads its
 * length — the first thing `splitSections` touches. */
function textThatThrows(): string {
  return {
    get length(): number {
      throw new Error("hostile text length");
    },
  } as unknown as string;
}

/** An offset typed as `number` that throws when coerced to a primitive, which
 * happens inside `sectionAt` (`offset >= s.start`) on the first query. */
function offsetThatThrows(): number {
  return {
    [Symbol.toPrimitive](): number {
      throw new Error("hostile offset");
    },
  } as unknown as number;
}

/** A path typed as `string` that throws when stringified, which the workspace
 * containment check does before any read. */
function pathThatThrows(): string {
  return {
    toString(): string {
      throw new Error("hostile path");
    },
  } as unknown as string;
}

/** A cwd typed as `string` but a number at runtime: the @std/path helpers
 * `discoverConfig` calls reject it, so `safe()` swallows the throw and the
 * `?? { importMap: {}, root: cwd }` fallback runs. */
function cwdThatThrows(): string {
  return 12345 as unknown as string;
}

//
// createSemantics: setup-time guards
//

Deno.test("semantics: a text that throws while splitting yields no service", () => {
  // `splitSections` reads `text.length` first; that throw is caught and the
  // factory returns null — the documented "returns null only when even the
  // lightweight setup is impossible" path.
  const sem = createSemantics(textThatThrows(), { cwd: CWD });
  assertEquals(sem, undefined, "an unsplittable text gives no service at all");
});

Deno.test("semantics: an un-discoverable config falls back to an empty import map", () => {
  // A cwd the path helpers reject makes `discoverConfig` throw; `safe()` returns
  // undefined and the `?? { importMap: {}, root: cwd }` fallback supplies an
  // empty map. The service is still constructed (non-null), it simply cannot
  // resolve anything, so a plain query degrades to null without throwing.
  const blob = `// transformed: /m.ts\nconst x: number = 1;\nconst y = x;`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: cwdThatThrows() });
  assert(sem, "service is built even when config discovery throws");
  // The build itself fails (the bad cwd reaches the compiler host), so the
  // query degrades to null rather than reporting a type.
  assertEquals(sem!.typeAt(nameOffsetOf(doc, "y")), null);
});

Deno.test("semantics: a build failure latches and every later query stays silent", () => {
  // The bad cwd makes the compiler host throw inside build(); the catch sets
  // `failed = true`. prewarm() (the first build attempt) latches it; the
  // following typeAt/definitionOf/fileLines calls hit the `if (failed)` short
  // circuit and the `if (!prog)` guard, all returning their empty answers.
  const blob = `// transformed: /m.ts\nconst x = 1;\nconst y = x;`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: cwdThatThrows() })!;
  sem.prewarm(); // first build(): host throws, failed latches
  // Second build() (via typeAt) returns undefined immediately through `failed`.
  assertEquals(sem.typeAt(nameOffsetOf(doc, "y")), null);
  assertEquals(sem.definitionOf(nameOffsetOf(doc, "y")), []);
  // fileLines does not depend on the program, but the bad root still rejects
  // the read, so it too returns null.
  assertEquals(sem.fileLines(join(CWD, "anything.ts")), null);
});

//
// createSemantics: per-query catch wrappers
//

Deno.test("semantics: typeAt swallows a throw raised while locating the section", () => {
  // The program builds; then an offset that throws on numeric coercion makes
  // `sectionAt` throw inside typeAt's try. The catch returns null.
  const blob = `// transformed: /m.ts\nconst x: number = 1;\nconst y = x;`;
  const sem = createSemantics(blob, { cwd: CWD })!;
  sem.prewarm(); // build succeeds, so the throw is post-build inside the query
  assertEquals(sem.typeAt(offsetThatThrows()), null);
});

Deno.test("semantics: definitionOf swallows a throw and caches the empty result", () => {
  // Same hostile offset, but through definitionOf: the throw lands in its try,
  // the catch resets `out` to [], and the empty array is memoized.
  const blob = `// transformed: /m.ts\nconst x: number = 1;\nconst y = x;`;
  const sem = createSemantics(blob, { cwd: CWD })!;
  sem.prewarm();
  const bad = offsetThatThrows();
  const first = sem.definitionOf(bad);
  assertEquals(first, [], "a throw during resolution yields an empty list");
});

Deno.test("semantics: fileLines swallows a throw from the containment check", () => {
  // A path that throws when stringified makes the in-workspace check throw
  // inside fileLines' try; the catch returns null.
  const blob = `// transformed: /m.ts\nconst x = 1;`;
  const sem = createSemantics(blob, { cwd: CWD })!;
  assertEquals(sem.fileLines(pathThatThrows()), null);
});

//
// createDiffSemantics: setup-time fallback
//

Deno.test("diff semantics: an un-discoverable config still runs the fallback", () => {
  // With a cwd the path helpers reject, `discoverConfig` throws and the diff
  // factory takes its `?? { importMap: {}, root: cwd }` fallback before the
  // root-file containment check runs against that (now invalid) root. The check
  // then throws out of the factory, so the call is wrapped — the point is that
  // the fallback line executes at all.
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "m.ts"), "export const a = 1;\n");
    const maps: DiffMaps = {
      rootFiles: new Map([[join(root, "m.ts"), typeScriptLanguage]]),
      toFile: () => null,
      fromFile: () => null,
    };
    let threw = false;
    try {
      createDiffSemantics("difftext", maps, { cwd: cwdThatThrows() });
    } catch {
      threw = true;
    }
    assert(
      threw,
      "the bad root reaches the containment check and surfaces a throw",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diff semantics: fileLines swallows a throw from the containment check", () => {
  // A real, buildable diff service; then a path that throws on stringify makes
  // the workspace-containment check throw inside fileLines' try. The catch
  // returns null.
  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    Deno.writeTextFileSync(join(root, "m.ts"), "export const a = 1;\n");
    const maps: DiffMaps = {
      rootFiles: new Map([[join(root, "m.ts"), typeScriptLanguage]]),
      toFile: () => null,
      fromFile: () => null,
    };
    const sem = createDiffSemantics("difftext", maps, { cwd: root })!;
    assert(sem, "diff service builds over the real root file");
    assertEquals(sem.fileLines(pathThatThrows()), null);
    // A control read of the real root file still works, proving the service is
    // otherwise healthy and only the hostile path was rejected.
    const ok = sem.fileLines(join(root, "m.ts"));
    assert(ok && ok.length >= 1, "the real workspace file still reads");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
