/**
 * Gate-coverage tests for lib/view/languages/typescript/semantics.ts.
 *
 * The duplicated build/cache/latch logic the two factories shared was factored
 * into `lazyProgram`; the `lazyProgram` test below drives its success, throw,
 * and no-program paths directly through the test-only `_internal` handle. The
 * redundant `prewarm` and `realDir` try/catch wrappers and the always-true
 * `splitSections` guard were removed at the source. The remaining tests drive
 * the surrounding, reachable behavior: the observable degrade-to-null and
 * degrade-to-empty results the failure isolation protects.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import ts from "typescript";
import { parseDocument } from "./view-helpers.ts";
import {
  _internal,
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

//
// createSemantics: build's own isolation, which the !program guard backstops
//

Deno.test("semantics: a healthy build returns a Program (the !program guard is a backstop)", () => {
  // build() runs createLanguageService + getProgram and returns a real Program,
  // so the subsequent query answers a concrete type. The `if (!program)` latch
  // exists only for a host that yields no Program, which this one never does.

  const blob = `// transformed: /m.ts
const x: number = 1;
const y = x;`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: CWD })!;
  sem.prewarm();
  assertEquals(sem.typeAt(nameOffsetOf(doc, "y")), "number");
});

Deno.test("semantics: prewarm never sees a throw because build isolates its own", () => {
  // A hostile cwd makes build()'s own try/catch latch `failed`; the throw is
  // swallowed inside build(), so prewarm()'s surrounding try/catch observes
  // nothing. The service stays silent on every later query.

  const blob = `// transformed: /m.ts
const x = 1;
const y = x;`;
  const doc = parseDocument(blob);
  const sem = createSemantics(blob, { cwd: 12345 as unknown as string })!;
  sem.prewarm(); // build throws internally, latches failed, does not propagate
  sem.prewarm(); // the latch short-circuits the second attempt
  assertEquals(sem.typeAt(nameOffsetOf(doc, "y")), null);
  assertEquals(sem.definitionOf(nameOffsetOf(doc, "y")), []);
});

//
// createSemantics: the host file cache (populated once, never re-hit)
//

Deno.test("semantics: the host reads each real file once (cache populated, not re-hit)", () => {
  // Under Bundler resolution the host loads each resolved file a single time;
  // the file cache is filled on that read. The cache-hit return is a backstop
  // for resolution modes that probe the same path repeatedly.

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
    const doc = parseDocument(blob);
    const sem = createSemantics(blob, { cwd: root })!;
    sem.prewarm();
    assertEquals(sem.typeAt(nameOffsetOf(doc, "a")), "boolean");
    assertEquals(sem.typeAt(nameOffsetOf(doc, "b")), "boolean");
    // The external definition still resolves through the service's own cache.
    const def = sem.definitionOf(blob.indexOf("ext();")).find((d) =>
      d.filePath !== undefined
    );
    assert(def, "external definition resolves");
    assert(def!.filePath!.endsWith("ext.ts"));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// within()/realDir: the child resolves first, and the root only after
//

Deno.test("semantics: within() resolves a real child under a real root (realDir succeeds)", () => {
  // realDir(root) is only reached after the child's realPathSync succeeds; the
  // child sits under the root, so the root resolves too and realDir's catch is
  // never taken. The read therefore succeeds.

  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), JSON.stringify({}));
    Deno.writeTextFileSync(join(root, "inside.ts"), "export const x = 1;\n");
    const blob = `// transformed: /m.ts
const x = 1;`;
    const sem = createSemantics(blob, { cwd: root })!;
    const lines = sem.fileLines(join(root, "inside.ts"));
    assert(lines && lines.length >= 1, "the in-root file reads");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("semantics: a child whose realpath fails is rejected before realDir runs", () => {
  // When the child itself cannot be realpath-resolved, within() throws on the
  // child read and is caught before realDir(root) is consulted — the read
  // degrades to null. (This is the path that pre-empts realDir's own catch.)

  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), JSON.stringify({}));
    const blob = `// transformed: /m.ts
const x = 1;`;
    const sem = createSemantics(blob, { cwd: root })!;
    // A path under the root that does not exist: realPathSync(child) fails, so
    // within() returns false and fileLines yields null.
    assertEquals(sem.fileLines(join(root, "absent.ts")), null);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

//
// createDiffSemantics: where the failure guards are backstops
//

const FILE_TEXT = `export function double(n: number): number {
    return n * 2;
}
export const answer = double(21);
`;

function diffMapsFor(file: string): DiffMaps {
  return {
    rootFiles: new Map([[file, typeScriptLanguage]]),
    toFile: () => null,
    fromFile: () => null,
  };
}

Deno.test("diff semantics: build succeeds over real root files, so typeAt's !prog guard is a backstop", () => {
  // The diff factory passes its containment check, build() makes a host over
  // the real root file and returns a Program. typeAt's `if (!prog) return null`
  // never triggers on the build itself; a null here comes from the offset map,
  // not a failed build.

  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "deno.json"), "{}");
    const file = join(root, "m.ts");
    Deno.writeTextFileSync(file, FILE_TEXT);
    const sem = createDiffSemantics("difftext", diffMapsFor(file), {
      cwd: root,
    })!;
    assert(sem, "diff service builds over the real root file");
    sem.prewarm();
    sem.prewarm(); // the cached Program short-circuits the second build()
    // No offset maps into a file here, so typeAt degrades to null via the map,
    // with build() having already succeeded.
    assertEquals(sem.typeAt(0), null);
    assertEquals(sem.definitionOf(0), []);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diff semantics: a hostile cwd is rejected by containment before build runs", () => {
  // The diff factory filters root files through the workspace-containment check
  // first; a cwd the path helpers reject makes that check throw out of the
  // factory, so build()'s own failure arms are never the thing that fires.

  const root = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(join(root, "m.ts"), "export const a = 1;\n");
    let threw = false;
    try {
      createDiffSemantics("difftext", diffMapsFor(join(root, "m.ts")), {
        cwd: 12345 as unknown as string,
      });
    } catch {
      threw = true;
    }
    assert(threw, "the containment check surfaces the throw before build()");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("diff semantics: no in-workspace root file means no service (not a failed build)", () => {
  // With every root file filtered out, the factory returns undefined up front —
  // the service is never constructed, so build()'s failure guards are not in
  // play.

  const sem = createDiffSemantics(
    "difftext",
    { rootFiles: new Map(), toFile: () => null, fromFile: () => null },
    { cwd: CWD },
  );
  assertEquals(sem, undefined);
});

//
// lazyProgram: the shared build, cache and latch
//

Deno.test("lazyProgram: caches a success and latches a failed build", () => {
  // lazyProgram is the shared build/cache/latch both factories use. The
  // configured host never makes it fail, so its failure isolation is exercised
  // directly: a build is cached after the first success, and a throwing or
  // program-less build latches so it is not retried.

  const fake = {} as unknown as ts.Program;

  let okCalls = 0;
  const ok = _internal.lazyProgram(() => {
    okCalls++;
    return fake;
  });
  ok.prewarm();
  assertEquals(ok.build(), fake);
  assertEquals(okCalls, 1, "the program is built once and then cached");

  let throwCalls = 0;
  const thrown = _internal.lazyProgram((): ts.Program => {
    throwCalls++;
    throw new Error("build failed");
  });
  assertEquals(thrown.build(), undefined);
  assertEquals(thrown.build(), undefined);
  assertEquals(throwCalls, 1, "a thrown build latches and is not retried");

  let nullCalls = 0;
  const none = _internal.lazyProgram(() => {
    nullCalls++;
    return undefined;
  });
  assertEquals(none.build(), undefined);
  assertEquals(none.build(), undefined);
  assertEquals(nullCalls, 1, "a program-less build latches and is not retried");
});

//
// makeHost: the readReal memo
//

Deno.test("makeHost: a repeated read of the same file is served from the cache", () => {
  // makeHost's readReal memoizes real-file reads. Under the pager's module
  // resolution TypeScript reads each file once, so the cache hit never fires
  // there; reading the same path twice through the host exercises it directly.

  const dir = Deno.makeTempDirSync();
  try {
    const file = join(dir, "dep.ts");
    Deno.writeTextFileSync(file, "export const dep = 1;\n");
    const host = _internal.makeHost([], {}, undefined, dir, dir);
    const first = host.readFile!(file);
    const second = host.readFile!(file); // returned from fileCache
    assertEquals(first, "export const dep = 1;\n");
    assertEquals(second, first);
    assertEquals(host.directoryExists!(dir), true);
    assertEquals(host.directoryExists!(join(dir, "missing")), false);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

//
// signedNumericElementDefinitions: which positions name a key
//

Deno.test("signed numeric definitions reject positions that do not name a supported key", () => {
  const fileName = "/signed-numeric.ts";
  const text = `const key = 1;
const value = { [-1](): void {} };
value[1];
value[-key];
value[!1];
value[+1e999];
value[-2];
value[-1];
`;
  const host = _internal.makeHost(
    [{ name: fileName, start: 0, end: text.length, text }],
    {},
    undefined,
    CWD,
    CWD,
  );
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  try {
    const program = service.getProgram();
    assert(program, "the test source produces a TypeScript program");
    const atArgument = (snippet: string): number => {
      const start = text.indexOf(snippet);
      assert(start >= 0, `source contains ${snippet}`);
      return start + snippet.indexOf("[") + 1;
    };

    assertEquals(
      _internal.signedNumericElementDefinitions(
        program!,
        "/missing.ts",
        0,
      ),
      [],
    );
    assertEquals(
      _internal.signedNumericElementDefinitions(
        program!,
        fileName,
        text.length,
      ),
      [],
    );
    assertEquals(
      _internal.signedNumericElementDefinitions(
        program!,
        fileName,
        text.indexOf("const key"),
      ),
      [],
    );
    for (
      const snippet of [
        "value[1]",
        "value[-key]",
        "value[!1]",
        "value[+1e999]",
        "value[-2]",
      ]
    ) {
      assertEquals(
        _internal.signedNumericElementDefinitions(
          program!,
          fileName,
          atArgument(snippet),
        ),
        [],
        `${snippet} has no supported signed numeric definition`,
      );
    }
    const definitions = _internal.signedNumericElementDefinitions(
      program!,
      fileName,
      atArgument("value[-1]"),
    );
    assertEquals(definitions.length, 1);
    assertEquals(definitions[0].name, "-1");
  } finally {
    service.dispose();
  }
});
