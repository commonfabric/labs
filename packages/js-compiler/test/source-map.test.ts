import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { StaticCache } from "@commonfabric/static";
import { SourceMapConsumer, SourceMapGenerator } from "source-map-js";

import {
  composeBundleSourceMap,
  getTypeScriptEnvironmentTypes,
  identitySourceMap,
  InMemoryProgram,
  parseSourceMap,
  type SourceMap,
  SourceMapParser,
  TypeScriptCompiler,
} from "../mod.ts";

const staticCache = StaticCache.fromFileSystem();
const types = await getTypeScriptEnvironmentTypes(staticCache);
types["commonfabric.d.ts"] = await staticCache.getText(
  "types/commonfabric.d.ts",
);

/** Compile a single-module program and return its emitted CommonJS + map. */
async function compileMain(
  compiler: TypeScriptCompiler,
  program: InMemoryProgram,
): Promise<{ js: string; sourceMap?: SourceMap }> {
  const resolved = await compiler.resolveProgram(program);
  return compiler.compileToModules(resolved).get("/main.tsx")!;
}

/**
 * Mirror the ESM module-record loader's execution shape: wrap the compiled
 * CommonJS body in the 1-line factory wrapper tagged with a `//# sourceURL`,
 * eval it, and return the populated exports. Stack frames from inside the
 * module then carry `<filename>:<line>:<column>` coordinates relative to the
 * eval'd string (body line N = eval line N+1).
 */
function evaluateModule(
  js: string,
  filename: string,
): Record<string, (...args: unknown[]) => unknown> {
  const factory = (0, eval)(
    `(function (exports, require, module) {\n${js}\n})\n//# sourceURL=${filename}`,
  ) as (
    exports: Record<string, unknown>,
    require: (specifier: string) => Record<string, unknown>,
    module: { exports: Record<string, unknown> },
  ) => void;
  const exports: Record<string, unknown> = {};
  factory(exports, () => ({}), { exports });
  return exports as Record<string, (...args: unknown[]) => unknown>;
}

/**
 * The map the engine registers under a module's eval `//# sourceURL`: the
 * per-module compiler map shifted by the 1-line factory wrapper, with the
 * source path overridden to the full module path.
 */
function moduleSourceMap(map: SourceMap, sourceUrl: string): SourceMap {
  return composeBundleSourceMap(
    [{ body: "", map, source: "/main.tsx" }],
    sourceUrl,
    1, // the `(function (exports, require, module) {` wrapper line
  )!;
}

describe("SourceMap", () => {
  it("inspects source map structure", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
function throwError(): never {
  throw new Error("test error");
}

export function test() {
  return throwError();
}

export default test;
`,
    });

    const compiled = await compileMain(compiler, program);

    console.log("=== Compiled Output ===");
    console.log(compiled.js);
    console.log("\n=== Source Map ===");
    console.log("file:", compiled.sourceMap?.file);
    console.log("sources:", compiled.sourceMap?.sources);
    console.log(
      "sourcesContent length:",
      compiled.sourceMap?.sourcesContent?.length,
    );
    console.log(
      "mappings (first 200 chars):",
      compiled.sourceMap?.mappings?.slice(0, 200),
    );

    expect(compiled.sourceMap).toBeDefined();

    // Parse the source map
    const consumer = new SourceMapConsumer(compiled.sourceMap!);
    let mapped = 0;

    console.log("\n=== Sample Position Mappings ===");
    // Check what various line/column positions map to
    for (let line = 1; line <= 10; line++) {
      for (const col of [0, 10, 20, 30]) {
        const pos = consumer.originalPositionFor({ line, column: col });
        if (pos.source !== null) {
          mapped++;
          console.log(
            `Line ${line}, Col ${col} -> ${pos.source}:${pos.line}:${pos.column} (name: ${pos.name})`,
          );
        }
      }
    }
    expect(mapped).toBeGreaterThan(0);
  });

  it("parses error stack traces with source map", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
function throwError(): never {
  throw new Error("test error");
}

export function test() {
  return throwError();
}

export default test;
`,
    });

    const compiled = await compileMain(compiler, program);

    const parser = new SourceMapParser();
    parser.load(
      "test-error.js",
      moduleSourceMap(compiled.sourceMap!, "test-error.js"),
    );

    // Execute the compiled module the way the ESM loader does and get an error
    let threw = false;
    try {
      const exports = evaluateModule(compiled.js, "test-error.js");
      exports.test();
    } catch (e: any) {
      threw = true;
      console.log("\n=== Raw Error Stack ===");
      console.log(e.stack);

      const parsed = parser.parse(e.stack);
      console.log("\n=== Parsed (Source Mapped) Stack ===");
      console.log(parsed);

      // The throw on source line 3 must resolve back to the authored source.
      expect(parsed).toContain("main.tsx:3:");
    }
    expect(threw).toBe(true);
  });

  it("verifies error line mapping through full stack", async () => {
    const compiler = new TypeScriptCompiler(types);
    // Create a program where we know exactly which line should error
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `// line 1
// line 2
// line 3
// line 4
function errorOnLine6(): never {
  throw new Error("error from line 6"); // THIS IS LINE 6
}

export default errorOnLine6;
`,
    });

    const compiled = await compileMain(compiler, program);

    const parser = new SourceMapParser();
    parser.load(
      "known-line.js",
      moduleSourceMap(compiled.sourceMap!, "known-line.js"),
    );

    let threw = false;
    try {
      const exports = evaluateModule(compiled.js, "known-line.js");
      // Call the default export which should throw
      exports.default();
    } catch (e: any) {
      threw = true;
      const parsed = parser.parse(e.stack);
      console.log("\n=== Stack for known line 6 error ===");
      console.log("Raw:", e.stack);
      console.log("\nParsed:", parsed);

      // The error should mention line 6 from main.tsx
      expect(parsed).toContain("main.tsx");
      expect(parsed).toContain(":6:");
    }
    expect(threw).toBe(true);
  });

  it("matches various stack trace formats", () => {
    const parser = new SourceMapParser();
    // Don't load any source maps - we just want to test regex matching

    // Test patterns that should match (returns original line if no source map)
    const patterns = [
      // Standard function call
      "    at doubleOrThrow (recipe-abc.js, <anonymous>:14:15)",
      // Object method with [as factory]
      "    at Object.eval [as factory] (recipe-abc.js, <anonymous>:4:52)",
      // Object method with [as default]
      "    at Object.errorOnLine6 [as default] (known-line.js, <anonymous>:5:15)",
      // Function with digits
      "    at func123 (file.js, <anonymous>:1:1)",
      // Namespaced function
      "    at MyClass.myMethod (file.js, <anonymous>:10:5)",
      // Nested namespace
      "    at A.B.C.method (file.js, <anonymous>:20:10)",
      // Source-labeled function name used by runner action/module ids
      "    at ba4jcaraqictevfcqama4n7ugtfosjasodvm43iojcw4ss6m4y54d3uvn/main.tsx:3:19 (file.js, <anonymous>:20:10)",
      // eval
      "    at eval (recipe-abc.js, <anonymous>:17:10)",
      // Namespaced methods on a column-1 frame
      "    at Loader.resolveModule (recipe-abc.js, <anonymous>:1:1764)",
      "    at Loader.require (recipe-abc.js, <anonymous>:1:923)",
    ];

    for (const pattern of patterns) {
      const input = `Error: test\n${pattern}`;
      const result = parser.parse(input);
      // Should either transform the line or leave it unchanged (not drop it)
      expect(result.includes("at ")).toBe(true);
    }
  });

  it("maps stack frames with source-labeled function names", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `// line 1
// line 2
// line 3
// line 4
function errorOnLine6(): never {
  throw new Error("error from line 6"); // THIS IS LINE 6
}

export default errorOnLine6;
`,
    });

    const compiled = await compileMain(compiler, program);

    const map = moduleSourceMap(compiled.sourceMap!, "known-line.js");
    const parser = new SourceMapParser();
    parser.load("known-line.js", map);

    // Find the eval-relative coordinate of the throw on authored line 6, so
    // the synthetic frame below points at a real mapping.
    const gen = new SourceMapConsumer(map).generatedPositionFor({
      source: "/main.tsx",
      line: 6,
      column: 2,
    });
    expect(gen.line).not.toBeNull();

    const parsed = parser.parse(`Error: test
    at ba4jcaraqictevfcqama4n7ugtfosjasodvm43iojcw4ss6m4y54d3uvn/main.tsx:3:19 (known-line.js, <anonymous>:${gen.line}:${gen.column})`);

    expect(parsed).toContain("main.tsx:6:");
  });

  it("preserves unmapped stack frames from external files", () => {
    const parser = new SourceMapParser();
    // Load a source map for a specific file
    const dummySourceMap = {
      version: "3",
      file: "test.js",
      sourceRoot: "",
      sources: ["test.tsx"],
      names: [],
      mappings: "AAAA",
      sourcesContent: ["test"],
    };
    parser.load("test.js", dummySourceMap);

    const stack = `Error: test
    at func (test.js, <anonymous>:1:1)
    at external (other-file.js:100:50)
    at anotherExternal (https://example.com/lib.js:200:30)`;

    const parsed = parser.parse(stack);

    // External files should be preserved unchanged
    expect(parsed).toContain("other-file.js:100:50");
    expect(parsed).toContain("https://example.com/lib.js:200:30");
  });
});

describe("composeBundleSourceMap", () => {
  const buildMap = (
    file: string,
    mappings: Array<{ gen: number; src: string; orig: number }>,
  ) => {
    const g = new SourceMapGenerator({ file });
    for (const m of mappings) {
      g.addMapping({
        generated: { line: m.gen, column: 0 },
        original: { line: m.orig, column: 0 },
        source: m.src,
      });
    }
    return JSON.parse(g.toString());
  };

  it("offsets each module's generated lines by its start in the joined bundle", () => {
    const mapA = buildMap("a.js", [
      { gen: 1, src: "a.ts", orig: 10 },
      { gen: 2, src: "a.ts", orig: 11 },
    ]);
    const mapB = buildMap("b.js", [{ gen: 1, src: "b.ts", orig: 20 }]);
    // Bodies joined with "\n": A occupies bundle lines 1..3 (3 lines), so B's
    // gen line 1 lands at bundle line 4.
    const composed = composeBundleSourceMap(
      [{ body: "x\ny\nz", map: mapA }, { body: "p\nq", map: mapB }],
      "bundle.js",
    )!;
    const consumer = new SourceMapConsumer(composed);
    expect(consumer.originalPositionFor({ line: 1, column: 0 }).source).toBe(
      "a.ts",
    );
    expect(consumer.originalPositionFor({ line: 1, column: 0 }).line).toBe(10);
    const b = consumer.originalPositionFor({ line: 4, column: 0 });
    expect(b.source).toBe("b.ts");
    expect(b.line).toBe(20);
  });

  it("applies startLineOffset to the first module (eval wrapper line)", () => {
    const mapA = buildMap("a.js", [{ gen: 1, src: "a.ts", orig: 10 }]);
    // startLineOffset 1 mirrors the `(function (...) {` wrapper: the body's
    // gen line 1 maps to bundle line 2.
    const composed = composeBundleSourceMap(
      [{ body: "x", map: mapA }],
      "m.js",
      1,
    )!;
    const consumer = new SourceMapConsumer(composed);
    expect(consumer.originalPositionFor({ line: 2, column: 0 }).source).toBe(
      "a.ts",
    );
    expect(consumer.originalPositionFor({ line: 2, column: 0 }).line).toBe(10);
  });

  it("returns undefined when no module has a map", () => {
    expect(composeBundleSourceMap([{ body: "x" }], "m.js")).toBe(undefined);
  });

  it("overrides the recorded source path when `source` is given", () => {
    // Compiler maps record only the basename; the override rewrites it to the
    // full module path so mapped error stacks keep the authored path.
    const mapA = buildMap("a.js", [{ gen: 1, src: "main.tsx", orig: 10 }]);
    const composed = composeBundleSourceMap(
      [{ body: "x", map: mapA, source: "/id/dir/main.tsx" }],
      "m.js",
    )!;
    const consumer = new SourceMapConsumer(composed);
    const pos = consumer.originalPositionFor({ line: 1, column: 0 });
    expect(pos.source).toBe("/id/dir/main.tsx");
    expect(pos.line).toBe(10);
  });

  it("preserves sourcesContent under the overridden source name", () => {
    const g = new SourceMapGenerator({ file: "a.js" });
    g.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 10, column: 0 },
      source: "main.tsx",
    });
    g.setSourceContent("main.tsx", "const authored = 1;");
    const mapA = JSON.parse(g.toString());
    const composed = composeBundleSourceMap(
      [{ body: "x", map: mapA, source: "/id/dir/main.tsx" }],
      "m.js",
    )!;
    // Content must be reachable under the OVERRIDDEN name (what the mappings
    // now point at), so DevTools can display the authored source.
    expect(
      composed.sourcesContent?.[composed.sources.indexOf("/id/dir/main.tsx")],
    )
      .toBe("const authored = 1;");
  });
});

describe("composeBundleSourceMap textual fast path (vs consumer/generator)", () => {
  /**
   * The pre-#4455 implementation, verbatim, kept as the TEST-ONLY differential
   * oracle (the production fallback was removed — no live users; guards fail
   * loud instead). The public composer must stay position-equivalent to this
   * for every well-formed input shape.
   */
  function legacyCompose(
    modules: ReadonlyArray<{ body: string; map?: SourceMap; source?: string }>,
    bundleFilename: string,
    startLineOffset = 0,
  ): SourceMap | undefined {
    const generator = new SourceMapGenerator({ file: bundleFilename });
    let lineOffset = startLineOffset;
    let any = false;
    for (const { body, map, source } of modules) {
      if (map) {
        const consumer = new SourceMapConsumer(map);
        consumer.eachMapping((m) => {
          if (
            m.source == null || m.originalLine == null ||
            m.originalColumn == null
          ) return;
          generator.addMapping({
            generated: {
              line: m.generatedLine + lineOffset,
              column: m.generatedColumn,
            },
            original: { line: m.originalLine, column: m.originalColumn },
            source: source ?? m.source,
            name: m.name ?? undefined,
          });
          any = true;
        });
        const contents =
          (map as { sourcesContent?: (string | null)[] }).sourcesContent;
        if (source) {
          const content = contents?.find((c) => c != null);
          if (content != null) generator.setSourceContent(source, content);
        } else {
          const sources = map.sources ?? [];
          if (contents) {
            sources.forEach((src, i) => {
              const content = contents[i];
              if (src != null && content != null) {
                generator.setSourceContent(src, content);
              }
            });
          }
        }
      }
      lineOffset += (body.match(/\n/g)?.length ?? 0) + 1;
    }
    if (!any) return undefined;
    return JSON.parse(generator.toString()) as SourceMap;
  }

  /** Every mapping as an ordered position tuple — the equivalence currency. */
  function mappingTuples(map: SourceMap): string[] {
    const out: string[] = [];
    new SourceMapConsumer(map).eachMapping((m) => {
      out.push(
        [
          m.generatedLine,
          m.generatedColumn,
          m.source,
          m.originalLine,
          m.originalColumn,
          m.name ?? "",
        ].join("|"),
      );
    });
    return out;
  }

  function expectEquivalent(
    modules: ReadonlyArray<{ body: string; map?: SourceMap; source?: string }>,
    bundleFilename: string,
    startLineOffset = 0,
    { minMappings = 1 }: { minMappings?: number } = {},
  ) {
    const fast = composeBundleSourceMap(
      modules,
      bundleFilename,
      startLineOffset,
    );
    const legacy = legacyCompose(modules, bundleFilename, startLineOffset);
    expect(fast === undefined).toBe(legacy === undefined);
    if (fast === undefined || legacy === undefined) return;
    const fastTuples = mappingTuples(fast);
    expect(fastTuples.length).toBeGreaterThanOrEqual(minMappings);
    expect(fastTuples).toEqual(mappingTuples(legacy));
    expect(fast.file).toBe(legacy.file);
    // Content must resolve identically under every mapped source name.
    const legacyConsumer = new SourceMapConsumer(legacy);
    const fastConsumer = new SourceMapConsumer(fast);
    for (const source of legacy.sources) {
      expect(fastConsumer.sourceContentFor(source, true)).toBe(
        legacyConsumer.sourceContentFor(source, true),
      );
    }
  }

  /** Compile a real multi-module program and return each module's js + map. */
  async function compileTwoModules(): Promise<
    Array<{ js: string; sourceMap?: SourceMap }>
  > {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
import { helper, tag } from "./util.ts";

export function test(n: number) {
  return helper(n) + tag.length;
}

export default test;
`,
      "/util.ts": `
export function helper(n: number): number {
  const doubled = n * 2;
  return doubled + 1;
}

export const tag = "util";
`,
    });
    const resolved = await compiler.resolveProgram(program);
    const emitted = compiler.compileToModules(resolved);
    return [emitted.get("/main.tsx")!, emitted.get("/util.ts")!];
  }

  it("matches on real compiler maps with overrides (the eval-bundle shape)", async () => {
    const [main, util] = await compileTwoModules();
    expectEquivalent(
      [
        { body: main.js, map: main.sourceMap, source: "/id/main.tsx" },
        { body: util.js, map: util.sourceMap, source: "/id/util.ts" },
      ],
      "load1.js",
      0,
      { minMappings: 10 },
    );
  });

  it("matches on a single module with the wrapper offset (the per-module shape)", async () => {
    const [main] = await compileTwoModules();
    expectEquivalent(
      [{ body: "", map: main.sourceMap, source: "/id/main.tsx" }],
      "/main.tsx",
      1,
      { minMappings: 5 },
    );
  });

  it("matches on identity maps mixed with real maps and mapless modules", async () => {
    const [main, util] = await compileTwoModules();
    expectEquivalent(
      [
        { body: main.js, map: identitySourceMap(main.js, "/id/main.tsx") },
        { body: "no map\nfor me" },
        { body: util.js, map: util.sourceMap, source: "/id/util.ts" },
      ],
      "mixed.js",
      0,
      { minMappings: 10 },
    );
  });

  it("matches when mappings carry names across module boundaries", () => {
    // This compiler config emits empty `names`, so exercise the cross-stream
    // name-index rebasing with generator-built maps that do carry names.
    const named = (
      file: string,
      entries: Array<{ line: number; col: number; name: string }>,
    ) => {
      const g = new SourceMapGenerator({ file });
      for (const e of entries) {
        g.addMapping({
          generated: { line: e.line, column: e.col },
          original: { line: e.line, column: 0 },
          source: `${file}.ts`,
          name: e.name,
        });
      }
      return JSON.parse(g.toString()) as SourceMap;
    };
    const mapA = named("a", [
      { line: 1, col: 0, name: "alpha" },
      { line: 1, col: 8, name: "beta" },
      { line: 2, col: 0, name: "alpha" },
    ]);
    const mapB = named("b", [
      { line: 1, col: 4, name: "gamma" },
      { line: 2, col: 2, name: "delta" },
    ]);
    expect(mapA.names.length).toBeGreaterThan(0);
    expectEquivalent(
      [
        { body: "x\ny", map: mapA },
        { body: "p\nq", map: mapB },
      ],
      "names.js",
      0,
      { minMappings: 5 },
    );
  });

  it("drops generated-only (1-field) segments like the legacy filter", () => {
    const g = new SourceMapGenerator({ file: "a.js" });
    g.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 3, column: 0 },
      source: "a.ts",
    });
    // A mapping with no original position — serialized as a 1-field segment.
    g.addMapping({ generated: { line: 1, column: 8 } });
    g.addMapping({
      generated: { line: 1, column: 12 },
      original: { line: 4, column: 2 },
      source: "a.ts",
    });
    const map = JSON.parse(g.toString());
    expect(map.mappings).toContain(","); // the 1-field segment is really there
    expectEquivalent([{ body: "x", map }], "drop.js", 0, { minMappings: 2 });
  });

  it("collapses a multi-source map onto a source override like the oracle", () => {
    const g = new SourceMapGenerator({ file: "a.js" });
    g.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "one.ts",
    });
    g.addMapping({
      generated: { line: 2, column: 0 },
      original: { line: 1, column: 0 },
      source: "two.ts",
    });
    const map = JSON.parse(g.toString());
    expect(map.sources.length).toBe(2);
    // The override collapses both mappings onto one source — only the legacy
    // path can do that, so the public function must match it via fallback.
    expectEquivalent(
      [{ body: "x\ny", map, source: "/override.ts" }],
      "multi.js",
      0,
      { minMappings: 2 },
    );
  });

  it("fails loud on non-empty sourceRoot and on unsorted mappings", () => {
    const rooted: SourceMap = {
      version: "3",
      file: "a.js",
      sourceRoot: "/root",
      sources: ["a.ts"],
      names: [],
      mappings: "AAAA",
    } as SourceMap;
    expect(() => composeBundleSourceMap([{ body: "x", map: rooted }], "r.js"))
      .toThrow(/sourceRoot/);
    // genCol 4 then genCol 2 on the same line.
    const unsorted: SourceMap = {
      version: "3",
      file: "a.js",
      sourceRoot: "",
      sources: ["a.ts"],
      names: [],
      mappings: "IAAA,FAAC",
    } as SourceMap;
    expect(() => composeBundleSourceMap([{ body: "x", map: unsorted }], "u.js"))
      .toThrow(/not sorted/);
  });

  it("takes the fast path on compiler-shaped inputs (observable via kept declared names)", () => {
    // The generator collects only first-USE names; the textual path carries the
    // declared array wholesale. An unused declared name surviving into the
    // composed map proves the fast path ran (tuple equivalence above proves the
    // divergence is benign).
    const map: SourceMap = {
      version: "3",
      file: "a.js",
      sourceRoot: "",
      sources: ["a.ts"],
      names: ["used", "unused"],
      // line 1, col 0 -> a.ts:1:0 with name index 0.
      mappings: "AAAAA",
    } as SourceMap;
    const composed = composeBundleSourceMap([{ body: "x", map }], "fast.js")!;
    expect(composed.names).toContain("unused");
    expect(mappingTuples(composed)).toEqual(
      mappingTuples(legacyCompose([{ body: "x", map }], "fast.js")!),
    );
  });

  it("keeps the hot loop off live map objects (proxy-backed maps)", async () => {
    const [main, util] = await compileTwoModules();
    let gets = 0;
    const proxied = (map: SourceMap): SourceMap =>
      new Proxy(map, {
        get(t, p, r) {
          gets++;
          return Reflect.get(t, p, r);
        },
      }) as SourceMap;
    const composed = composeBundleSourceMap(
      [
        {
          body: main.js,
          map: proxied(main.sourceMap!),
          source: "/id/main.tsx",
        },
        { body: util.js, map: proxied(util.sourceMap!), source: "/id/util.ts" },
      ],
      "prox.js",
    )!;
    // Correctness: identical to composing the plain maps.
    expect(mappingTuples(composed)).toEqual(mappingTuples(
      composeBundleSourceMap(
        [
          { body: main.js, map: main.sourceMap, source: "/id/main.tsx" },
          { body: util.js, map: util.sourceMap, source: "/id/util.ts" },
        ],
        "prox.js",
      )!,
    ));
    // On the cached boot path these maps are storage-backed proxies whose every
    // property read is a transaction read. The transcoder must materialize the
    // handful of fields once per module — not consult the live object
    // per-segment (measured as a ~9ms → ~87ms per-boot regression).
    expect(gets).toBeLessThan(24);
  });

  it("fails loud on corrupt streams, per guard", () => {
    // Each shape trips a distinct transcoder guard; with the legacy fallback
    // removed these are hard, descriptive errors.
    const raw = (mappings: string, sources: string[] = ["a.ts"]): SourceMap =>
      ({
        version: "3",
        file: "a.js",
        sourceRoot: "",
        sources,
        names: [],
        mappings,
      }) as SourceMap;
    const expectSameOutcome = (
      modules: ReadonlyArray<
        { body: string; map?: SourceMap; source?: string }
      >,
    ) => {
      let fast: SourceMap | undefined;
      let fastErr: unknown;
      let legacy: SourceMap | undefined;
      let legacyErr: unknown;
      try {
        fast = composeBundleSourceMap(modules, "hostile.js");
      } catch (e) {
        fastErr = e;
      }
      try {
        legacy = legacyCompose(modules, "hostile.js");
      } catch (e) {
        legacyErr = e;
      }
      expect(fastErr === undefined).toBe(legacyErr === undefined);
      if (fast !== undefined && legacy !== undefined) {
        expect(mappingTuples(fast)).toEqual(mappingTuples(legacy));
      } else {
        expect(fast === undefined).toBe(legacy === undefined);
      }
    };
    const boom = (
      modules: ReadonlyArray<
        { body: string; map?: SourceMap; source?: string }
      >,
      msg: RegExp,
    ) =>
      expect(() => composeBundleSourceMap(modules, "hostile.js")).toThrow(msg);
    // Malformed VLQ characters.
    boom([{ body: "x", map: raw("!!invalid!!") }], /malformed VLQ/);
    // Negative generated column (VLQ -1 = "D").
    boom([{ body: "x", map: raw("DAAA") }], /negative generated column/);
    // Oversized segment (6 VLQ fields).
    boom([{ body: "x", map: raw("AAAAAA") }], /more than 5 fields/);
    // Source index out of range (delta +1 with a single source).
    boom([{ body: "x", map: raw("ACAA") }], /index out of range/);
    // First module's map claims more lines than its 1-line body occupies, so
    // the second module's offset falls behind the emitted line cursor.
    boom([
      { body: "x", map: raw("AAAA;AACA;AACA") },
      { body: "y", map: raw("AAAA", ["b.ts"]) },
    ], /extends past its body/);
    // Empty mappings alongside a real module (contributes nothing) stays
    // equivalent to the oracle.
    expectSameOutcome([
      { body: "x", map: raw("") },
      { body: "y", map: raw("AAAA", ["b.ts"]) },
    ]);
  });

  it("identitySourceMap synthesizes the generator-equivalent map", () => {
    for (const body of ["one line", "a\nb\nc", "trailing\n", ""]) {
      const direct = identitySourceMap(body, "/id/main.tsx");
      const g = new SourceMapGenerator({ file: "/id/main.tsx" });
      const lineCount = (body.match(/\n/g)?.length ?? 0) + 1;
      for (let line = 1; line <= lineCount; line++) {
        g.addMapping({
          generated: { line, column: 0 },
          original: { line, column: 0 },
          source: "/id/main.tsx",
        });
      }
      const viaGenerator = JSON.parse(g.toString()) as SourceMap;
      expect(direct.mappings).toBe(viaGenerator.mappings);
      expect([...direct.sources]).toEqual([...viaGenerator.sources]);
      expect(direct.file).toBe(viaGenerator.file);
      expect(mappingTuples(direct)).toEqual(mappingTuples(viaGenerator));
    }
  });
});

describe("deferred composition inputs and lazy registration (CT-1819)", () => {
  // CT-1819: the boot path defers composition, capturing per-module LINE COUNTS
  // instead of bodies — pin that the count-shaped inputs are byte-equivalent to
  // the body-shaped ones, and that the parser's lazy slot has one-shot,
  // lookup-driven semantics.

  const raw = (mappings: string, sources: string[] = ["a.ts"]): SourceMap =>
    ({
      version: 3,
      file: "m.js",
      sources,
      names: [],
      mappings,
    }) as unknown as SourceMap;

  it("bodyLineCount is byte-equivalent to body for composition", () => {
    const bodies = ["a\nbb\nccc", "one", "x\n", ""];
    const withBodies = composeBundleSourceMap(
      bodies.map((body, i) => ({
        body,
        map: raw("AAAA;AACA", [`s${i}.ts`]),
        source: `/id/s${i}.ts`,
      })),
      "bundle.js",
    );
    const withCounts = composeBundleSourceMap(
      bodies.map((body, i) => ({
        bodyLineCount: (body.match(/\n/g)?.length ?? 0) + 1,
        map: raw("AAAA;AACA", [`s${i}.ts`]),
        source: `/id/s${i}.ts`,
      })),
      "bundle.js",
    );
    expect(withCounts).toEqual(withBodies);
  });

  it("identitySourceMap accepts a line count in place of the body", () => {
    for (const body of ["one line", "a\nb\nc", "trailing\n", ""]) {
      const lineCount = (body.match(/\n/g)?.length ?? 0) + 1;
      expect(identitySourceMap(lineCount, "/id/m.tsx")).toEqual(
        identitySourceMap(body, "/id/m.tsx"),
      );
    }
  });

  it("an entry with neither body nor bodyLineCount throws", () => {
    expect(() =>
      composeBundleSourceMap(
        [{ map: raw("AAAA") }],
        "bundle.js",
      )
    ).toThrow(/body or bodyLineCount/);
  });

  it("loadLazy defers the provider until a lookup needs the filename", () => {
    const parser = new SourceMapParser();
    let calls = 0;
    parser.loadLazy("lazy.js", () => {
      calls++;
      return identitySourceMap("a\nb", "/id/lazy.tsx");
    });
    expect(calls).toBe(0);
    // A lookup for a DIFFERENT filename does not materialize it.
    expect(parser.mapPosition("other.js", 1, 0)).toBeNull();
    expect(calls).toBe(0);
    // First matching lookup materializes (once) and resolves.
    const pos = parser.mapPosition("lazy.js", 2, 0);
    expect(calls).toBe(1);
    expect(pos?.source).toBe("/id/lazy.tsx");
    expect(pos?.line).toBe(2);
    parser.mapPosition("lazy.js", 1, 0);
    expect(calls).toBe(1); // one-shot: provider dropped after first use
  });

  it("parse() materializes pending providers for frames it maps", () => {
    const parser = new SourceMapParser();
    let calls = 0;
    parser.loadLazy("lazy.js", () => {
      calls++;
      return identitySourceMap("a\nb\nc", "/id/lazy.tsx");
    });
    const mapped = parser.parse("    at fn (lazy.js:3:0)");
    expect(calls).toBe(1);
    expect(mapped).toContain("/id/lazy.tsx:3:0");
  });

  it("an explicit load supersedes a pending provider; clear drops both", () => {
    const parser = new SourceMapParser();
    let calls = 0;
    parser.loadLazy("lazy.js", () => {
      calls++;
      return identitySourceMap("a", "/id/stale.tsx");
    });
    parser.load("lazy.js", identitySourceMap("a", "/id/fresh.tsx"));
    expect(parser.mapPosition("lazy.js", 1, 0)?.source).toBe("/id/fresh.tsx");
    expect(calls).toBe(0);

    parser.loadLazy("dropped.js", () => {
      calls++;
      return identitySourceMap("a", "/id/dropped.tsx");
    });
    parser.clear();
    expect(parser.mapPosition("dropped.js", 1, 0)).toBeNull();
    expect(calls).toBe(0);
  });

  it("a provider returning undefined leaves the name unmapped", () => {
    const parser = new SourceMapParser();
    let calls = 0;
    parser.loadLazy("empty.js", () => {
      calls++;
      return undefined;
    });
    expect(parser.mapPosition("empty.js", 1, 0)).toBeNull();
    expect(calls).toBe(1);
    expect(parser.mapPosition("empty.js", 1, 0)).toBeNull();
    expect(calls).toBe(1);
  });

  it("pendingProviders is LRU-bounded: never-looked-up providers don't accumulate (CT-1819 leak guard)", () => {
    const parser = new SourceMapParser();
    // The leak scenario: evaluations that never error, so their source maps are
    // never looked up / materialized. Each registers a unique `${evalId}.js`
    // provider; a plain Map would retain one per eval until dispose.
    const register = (from: number, count: number) => {
      for (let i = from; i < from + count; i++) {
        parser.loadLazy(
          `eval-${i}.js`,
          () => identitySourceMap("a", "/id/x.tsx"),
        );
      }
    };
    register(0, 4096);
    const afterFirst = parser.pendingProviderCountForTesting();
    register(4096, 4096); // 4096 more, all unique, still never looked up
    const afterSecond = parser.pendingProviderCountForTesting();
    // Bounded far below the 8192 registered, and it plateaus (the second batch
    // evicts rather than grows). A plain Map would give 4096 then 8192.
    expect(afterFirst).toBeLessThan(4096);
    expect(afterSecond).toBe(afterFirst);
  });
});

describe("parseSourceMap()", () => {
  it("throws naming what the document holds, given JSON that is not a source map", () => {
    expect(() => parseSourceMap('{"foo": 1}')).toThrow(
      "Could not parse source map: \n```\n{\n  foo: 1\n}\n```",
    );
  });
});
