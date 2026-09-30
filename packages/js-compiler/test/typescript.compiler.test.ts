import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { StaticCache } from "@commonfabric/static";
import { transformCfDirective } from "@commonfabric/ts-transformers";

import {
  CompilerError,
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  type SourceMap,
  TypeScriptCompiler,
  TypeScriptCompilerOptions,
} from "../mod.ts";

type TestDef =
  & { name: string; source: string; expectedError?: string }
  & TypeScriptCompilerOptions;

const TESTS: TestDef[] = [
  {
    name: "Default es2023 types applied",
    source: "export default new Map()",
  },
  {
    name: "Default lib.d.ts applied",
    source:
      "const x: Readonly<{ value: number }> = {value:5}; export default x;",
  },
  {
    name: "Throws: type check failure",
    source:
      "function add(x:number, y:number): number {return x+y}; export default add(`0`, 2);",
    expectedError:
      "Argument of type 'string' is not assignable to parameter of type 'number'.",
  },
  {
    // Parse errors fail at the syntactic gate, before type-checking.
    name: "Throws: Invalid source",
    source: "}x",
    expectedError: "Declaration or statement expected.",
  },
  {
    // `noCheck` skips type-checking, never parsing. With noEmitOnError off,
    // this explicit gate is the only thing between malformed source and a
    // malformed emit.
    name: "Throws: syntax error still fatal under noCheck",
    source: "export const x = ;",
    noCheck: true,
    expectedError: "Expression expected.",
  },
  {
    // The most permissive mode combination: storedSource turns noEmitOnError
    // off and noCheck skips semantics — the explicit syntactic gate is the
    // ONLY thing standing, and it must still stand.
    name: "Throws: syntax error still fatal under storedSource + noCheck",
    source: "export const x = ;",
    storedSource: true,
    noCheck: true,
    expectedError: "Expression expected.",
  },
  {
    name: "Throws: Invalid import",
    source: "import { foo } from './foo.ts';export default foo()",
    expectedError: "Cannot find module './foo.ts'",
  },
  {
    // Authoring surfaces stay strict: with the author present, the right fix
    // for a stale directive is removing it.
    name: "Throws: unused @ts-expect-error is fatal when authoring",
    source: [
      "const add = (x: number, y: number): number => x + y;",
      "// @ts-expect-error -- suppressed an error under an older type env",
      "export default add(1, 2);",
      "",
    ].join("\n"),
    expectedError: "Unused '@ts-expect-error' directive.",
  },
  {
    // Stored sources are recompiled by every future toolchain against
    // PLATFORM-supplied types; a directive that becomes unnecessary when
    // those types improve must not brick the reload (CT-1916 — 2026-07-28
    // estuary, loom-mobile patterns vs. a jsx.d.ts that gained a prop).
    name: "Unused @ts-expect-error compiles under storedSource",
    source: [
      "const add = (x: number, y: number): number => x + y;",
      "// @ts-expect-error -- suppressed an error under an older type env",
      "export default add(1, 2);",
      "",
    ].join("\n"),
    storedSource: true,
  },
  {
    // The tolerance is code-2578-narrow: a directive that still covers a
    // REAL error keeps suppressing it in either mode, and errors outside any
    // directive still fail (covered by "Throws: type check failure" above).
    name: "@ts-expect-error still suppresses a live error",
    source: [
      "const add = (x: number, y: number): number => x + y;",
      "// @ts-expect-error -- intentionally wrong argument type",
      "export default add('1', 2);",
      "",
    ].join("\n"),
  },
  {
    // storedSource must not weaken real type errors — only hygiene codes.
    name: "Throws: real type error still fatal under storedSource",
    source:
      "function add(x:number, y:number): number {return x+y}; export default add(`0`, 2);",
    storedSource: true,
    expectedError:
      "Argument of type 'string' is not assignable to parameter of type 'number'.",
  },
];

const staticCache = StaticCache.fromFileSystem();
const types = await getTypeScriptEnvironmentTypes(staticCache);
types["commonfabric.d.ts"] = await staticCache.getText(
  "types/commonfabric.d.ts",
);

/**
 * The modules a pattern's `commonfabric` import resolves to, as the compiler
 * takes them: one program file per module name, since the resolver maps a
 * runtime module to a `.d.ts` of the same name among the program's files.
 */
const FABRIC_RUNTIME_MODULES = ["commonfabric", "commonfabric/schema"];
const fabricTypeModules: Record<string, string> = {
  "commonfabric.d.ts": types["commonfabric.d.ts"],
  "commonfabric/schema.d.ts": await staticCache.getText(
    "types/commonfabric-schema.d.ts",
  ),
  "cfc.ts": await staticCache.getText("types/cfc.ts"),
};

/** Resolve via the compiler's resolver, then emit per-module CommonJS. */
async function resolveAndCompileToModules(
  compiler: TypeScriptCompiler,
  program: InMemoryProgram,
  options: TypeScriptCompilerOptions = {},
): Promise<Map<string, { js: string; sourceMap?: SourceMap }>> {
  const resolved = await compiler.resolveProgram(program, options);
  return compiler.compileToModules(resolved, options);
}

describe("TypeScriptCompiler", () => {
  describe("JSX factory binding", () => {
    for (const extension of ["tsx", "jsx"]) {
      it(`evaluates elements and fragments with local and parameter bindings named \`h\` in .${extension}`, async () => {
        const name = `/main.${extension}`;
        const compiler = new TypeScriptCompiler(types);
        const source = `
export function render() {
  const h = [0, 1, 2];
  return <div>{h.map((h) => <><span>{h}</span><br /></>)}</div>;
}
`;
        const modules = await resolveAndCompileToModules(
          compiler,
          new InMemoryProgram(name, {
            ...fabricTypeModules,
            [name]: transformCfDirective(source, name),
          }),
          { runtimeModules: FABRIC_RUNTIME_MODULES },
        );
        const factory = Object.assign(
          (name: string, props: unknown, ...children: unknown[]) => ({
            name,
            props,
            children,
          }),
          { fragment: "fragment" },
        );
        const exports: { render?: () => unknown } = {};
        new Function("exports", "require", modules.get(name)!.js)(
          exports,
          (specifier: string) => {
            expect(specifier).toBe("commonfabric");
            return { __cfHelpers: { h: factory } };
          },
        );

        expect(exports.render!()).toEqual({
          name: "div",
          props: null,
          children: [[0, 1, 2].map((value) => ({
            name: "fragment",
            props: null,
            children: [
              { name: "span", props: null, children: [value] },
              { name: "br", props: null, children: [] },
            ],
          }))],
        });
      });
    }

    it("evaluates elements when the module itself binds `h` at top level", async () => {
      // The pre-transform appends its forwarding shim as `__cfHelpersShim`
      // instead of `h` here, so the authored `h` is neither a duplicate
      // identifier nor the JSX factory.
      const name = "/main.tsx";
      const compiler = new TypeScriptCompiler(types);
      const source = `
export const h = ["a", "b"];
export function render() {
  return <ul>{h.map((item) => <li>{item}</li>)}</ul>;
}
`;
      const modules = await resolveAndCompileToModules(
        compiler,
        new InMemoryProgram(name, {
          ...fabricTypeModules,
          [name]: transformCfDirective(source, name),
        }),
        { runtimeModules: FABRIC_RUNTIME_MODULES },
      );
      const factory = (
        name: string,
        props: unknown,
        ...children: unknown[]
      ) => ({
        name,
        props,
        children,
      });
      const js = modules.get(name)!.js;
      expect(js).toContain("function __cfHelpersShim(");
      expect(js).not.toContain("function h(");
      const exports: { h?: unknown; render?: () => unknown } = {};
      let helpersRequired = 0;
      new Function("exports", "require", modules.get(name)!.js)(
        exports,
        (specifier: string) => {
          expect(specifier).toBe("commonfabric");
          helpersRequired += 1;
          return { __cfHelpers: { h: factory } };
        },
      );

      expect(helpersRequired).toBe(1);
      expect(exports.h).toEqual(["a", "b"]);
      expect(exports.render!()).toEqual({
        name: "ul",
        props: null,
        children: [["a", "b"].map((item) => ({
          name: "li",
          props: null,
          children: [item],
        }))],
      });
    });
  });

  it("registers virtual environment types as default libraries", async () => {
    const compiler = new TypeScriptCompiler(types);
    const resolved = await compiler.resolveProgram(
      new InMemoryProgram("/main.ts", {
        "/main.ts": "export const values = [1, 2, 3];",
      }),
    );
    let classifications: Record<string, boolean> | undefined;

    compiler.compileToModules(resolved, {
      beforeTransformers: (program) => {
        classifications = Object.fromEntries(
          program.getSourceFiles()
            .filter((sourceFile) => sourceFile.fileName.startsWith("$types/"))
            .map((sourceFile) => [
              sourceFile.fileName,
              program.isSourceFileDefaultLibrary(sourceFile),
            ]),
        );
        return [];
      },
    });

    expect(classifications).toEqual({
      "$types/dom.d.ts": true,
      "$types/es2023.d.ts": true,
      "$types/jsx.d.ts": true,
    });
  });

  it("compileToModules emits per-module CommonJS for each source", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx":
        "import { sub } from './math/subtract.ts';export const run = () => sub(10,2);export default run;",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
      "/math/subtract.ts":
        "import { add } from '../utils.ts';export const sub = (x:number,y:number)=>add(x,y*-1)",
    });
    const modules = await resolveAndCompileToModules(compiler, program);

    // One compiled CommonJS body per source file (no bundle).
    expect(new Set(modules.keys())).toEqual(
      new Set(["/main.tsx", "/utils.ts", "/math/subtract.ts"]),
    );
    const main = modules.get("/main.tsx")!;
    expect(main.js).toContain('require("./math/subtract.ts")');
    expect(main.js).toContain("exports.run");
    expect(main.sourceMap).toBeDefined();
    // Bare CommonJS: no bundler wrapper, no `define()` registration.
    expect(main.js).not.toContain("define(");
    expect(modules.get("/utils.ts")!.js).toContain("exports.add");
  });

  it("carries transformer sidecars beside emitted JavaScript", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.ts", {
      "/main.ts": "export const value = 1;",
    });
    const resolved = await compiler.resolveProgram(program);
    const manifest = {
      policyDigest: "sha256:policy",
      manifest: { version: 1 },
    };
    const builderSourceSites = {
      formatVersion: 1 as const,
      sites: { value: { line: 1, col: 13, bindingName: "value" } },
    };
    const modules = compiler.compileToModules(resolved, {
      beforeTransformers: () => ({
        factories: [],
        getBuilderSourceSites: () =>
          new Map([["/main.ts", builderSourceSites]]),
        getPolicyManifests: () => new Map([["/main.ts", [manifest]]]),
      }),
    });

    expect(modules.get("/main.ts")?.builderSourceSites).toEqual(
      builderSourceSites,
    );
    expect(modules.get("/main.ts")?.policyManifests).toEqual([manifest]);
    expect(modules.get("/main.ts")?.js).not.toContain("bindingName");
    expect(modules.get("/main.ts")?.js).not.toContain("sha256:policy");

    const collected = compiler.compileToModulesCollecting(resolved, {
      beforeTransformers: () => ({
        factories: [],
        getBuilderSourceSites: () =>
          new Map([["/main.ts", builderSourceSites]]),
        getPolicyManifests: () => new Map([["/main.ts", [manifest]]]),
      }),
    });
    expect(collected.diagnostics).toEqual([]);
    expect(collected.modules.get("/main.ts")?.builderSourceSites).toEqual(
      builderSourceSites,
    );
    expect(collected.modules.get("/main.ts")?.policyManifests).toEqual([
      manifest,
    ]);
  });

  it("compileToModulesCollecting reports stale directives AND real errors", async () => {
    // The corpus check is an AUTHORING surface — no stored-source tolerance:
    // an unused @ts-expect-error is reported (for the author to remove)
    // alongside real type errors, each attributed to its file.
    const compiler = new TypeScriptCompiler(types);
    const resolved = await compiler.resolveProgram(
      new InMemoryProgram("/main.ts", {
        "/main.ts": [
          "import { bad } from './bad.ts';",
          "const add = (x: number, y: number): number => x + y;",
          "// @ts-expect-error -- suppressed under an older type env",
          "export default add(1, 2) + bad;",
          "",
        ].join("\n"),
        "/bad.ts": "export const bad: number = 'not a number';\n",
      }),
    );
    const collected = compiler.compileToModulesCollecting(resolved);
    // The emit pass re-reports per-file diagnostics, so assert the SET of
    // attributed files rather than exact multiplicity.
    expect([...new Set(collected.diagnostics.map((d) => d.file))].sort())
      .toEqual([
        "/bad.ts",
        "/main.ts",
      ]);
    const byFile = Object.fromEntries(
      collected.diagnostics.map((d) => [d.file, d.message]),
    );
    expect(byFile["/main.ts"]).toContain("Unused '@ts-expect-error'");
    expect(byFile["/bad.ts"]).toContain(
      "Type 'string' is not assignable to type 'number'.",
    );
  });

  it("compileToModulesCollecting times each authored file separately", async () => {
    // What a batch caller charges each of the programs it unioned. Only
    // authored files carry a figure: the declaration libs emit nothing and
    // `skipLibCheck` keeps them out of the diagnostics pass.
    const compiler = new TypeScriptCompiler(types);
    const resolved = await compiler.resolveProgram(
      new InMemoryProgram("/main.ts", {
        "/main.ts": "import { one } from './other.ts';\nexport default one;\n",
        "/other.ts": "export const one = 1;\n",
      }),
    );

    const collected = compiler.compileToModulesCollecting(resolved);

    expect(collected.diagnostics).toEqual([]);
    expect([...collected.durations.keys()].toSorted())
      .toEqual(["/main.ts", "/other.ts"]);
    // The sum rather than each figure. These are wall-clock, and a
    // one-line module can take less than the clock resolves, so a floor
    // under one of them would fail on a loaded machine; a compile that
    // did anything cannot have spent nothing between them.
    const spent = [...collected.durations.values()].reduce((a, b) => a + b, 0);
    expect(spent).toBeGreaterThan(0);
  });

  it("compileToModulesInterleaved emits byte-identical output to compileToModules", async () => {
    // The interleaved driver only changes WHERE the event loop can run
    // (macrotask yields at module boundaries) — never what is emitted. Pin
    // byte-for-byte equivalence across a multi-module program so the two
    // drivers cannot drift.
    const compiler = new TypeScriptCompiler(types);
    const files = {
      "/main.tsx":
        "import { sub } from './math/subtract.ts';export const run = () => sub(10,2);export default run;",
      "/utils.ts": "export const add=(x:number,y:number):number =>x+y;",
      "/math/subtract.ts":
        "import { add } from '../utils.ts';export const sub = (x:number,y:number)=>add(x,y*-1)",
    };
    const resolved = await compiler.resolveProgram(
      new InMemoryProgram("/main.tsx", files),
    );
    const sync = compiler.compileToModules(resolved);
    const interleaved = await compiler.compileToModulesInterleaved(resolved);

    expect(new Set(interleaved.keys())).toEqual(new Set(sync.keys()));
    for (const [name, out] of sync) {
      expect(interleaved.get(name)!.js).toBe(out.js);
      expect(JSON.stringify(interleaved.get(name)!.sourceMap)).toBe(
        JSON.stringify(out.sourceMap),
      );
    }
  });

  it("compileToModulesInterleaved surfaces type errors like compileToModules", async () => {
    const compiler = new TypeScriptCompiler(types);
    const resolved = await compiler.resolveProgram(
      new InMemoryProgram("/main.tsx", {
        "/main.tsx":
          "function add(x:number, y:number): number {return x+y}; export default add(`0`, 2);",
      }),
    );
    const expected =
      "Argument of type 'string' is not assignable to parameter of type 'number'.";
    expect(() => compiler.compileToModules(resolved)).toThrow(expected);
    await expect(compiler.compileToModulesInterleaved(resolved)).rejects
      .toThrow(expected);
  });

  it("aggregates type errors across multiple files identically in both drivers", async () => {
    // The per-file type-check steps collect diagnostics from EVERY source file
    // before throwing (aggregate-then-throw), so a program with errors in two
    // files reports both in one CompilerError — in program order, byte-equal
    // between the sync and interleaved drivers.
    const compiler = new TypeScriptCompiler(types);
    const resolved = await compiler.resolveProgram(
      new InMemoryProgram("/main.tsx", {
        "/main.tsx":
          "import { dep } from './dep.ts';\nexport const wrong: string = 123;\nexport default dep;",
        "/dep.ts": "export const dep: number = 'not-a-number';",
      }),
    );

    let syncError: CompilerError | undefined;
    try {
      compiler.compileToModules(resolved);
    } catch (error) {
      syncError = error as CompilerError;
    }
    expect(syncError).toBeInstanceOf(CompilerError);
    // Both files' diagnostics, not just the first file's.
    expect(syncError!.message).toContain(
      "Type 'number' is not assignable to type 'string'.",
    );
    expect(syncError!.message).toContain(
      "Type 'string' is not assignable to type 'number'.",
    );
    expect(syncError!.errors.map((e) => e.file).sort()).toEqual([
      "/dep.ts",
      "/main.tsx",
    ]);

    const interleavedError = await compiler.compileToModulesInterleaved(
      resolved,
    ).then(() => undefined, (error) => error as CompilerError);
    expect(interleavedError).toBeInstanceOf(CompilerError);
    expect(interleavedError!.message).toBe(syncError!.message);
  });

  it("surfaces declaration diagnostics in both drivers", async () => {
    // A function-scoped unique symbol cannot be named in the exported
    // declaration (TS4025), which only the DECLARATION check catches — the
    // semantic check is clean. Pins that the per-file declaration-check step
    // still runs and throws in both drivers.
    const compiler = new TypeScriptCompiler(types);
    const artifact = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents:
          "function f() { const s: unique symbol = Symbol(); return { [s]: 1 }; }\n" +
          "export const v = f();\nexport default v;",
      }],
    };
    const expected = "Exported variable 'v' has or is using private name 's'.";
    expect(() => compiler.compileToModules(artifact)).toThrow(expected);
    await expect(compiler.compileToModulesInterleaved(artifact)).rejects
      .toThrow(expected);
  });

  it("filters known exported-symbol declaration false positives", () => {
    // Same TS4025 shape, but the private name is one of the
    // KNOWN_EXPORTED_SYMBOLS (CELL_BRAND): TypeScript's declaration
    // diagnostics report these commonfabric brand symbols spuriously, so the
    // checker skips them and the compile succeeds.
    const compiler = new TypeScriptCompiler(types);
    const artifact = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents:
          "function f() { const CELL_BRAND: unique symbol = Symbol(); return { [CELL_BRAND]: 1 }; }\n" +
          "export const v = f();\nexport default v;",
      }],
    };
    const modules = compiler.compileToModules(artifact);
    expect(modules.get("/main.tsx")).toBeDefined();
  });

  it("Compiles programs that include authored .js sources", async () => {
    // `allowJs` on the per-module emit path: a `.js` source emits its compiled
    // body under its own name (`/math.js` → `/math.js`), which TypeScript
    // normally vetoes as an input overwrite. The VirtualFs keeps reads and
    // writes separate, so the veto is suppressed (`suppressOutputPathCheck`).
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx":
        "import { add } from './math.js';export const run = () => add(1,2);export default run;",
      "/math.js": "export const add = (x, y) => x + y;",
    });
    const modules = await resolveAndCompileToModules(compiler, program);

    expect(new Set(modules.keys())).toEqual(
      new Set(["/main.tsx", "/math.js"]),
    );
    const main = modules.get("/main.tsx")!;
    expect(main.js).toContain('require("./math.js")');
    const math = modules.get("/math.js")!;
    expect(math.js).toContain("exports.add");
    expect(math.sourceMap).toBeDefined();
  });

  it("Throws when a .ts and .js source collide on one emit target", () => {
    const compiler = new TypeScriptCompiler(types);
    const artifact = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents:
            "import { a } from './a.ts';import { b } from './a.js';export default [a, b];",
        },
        { name: "/a.ts", contents: "export const a = 1;" },
        { name: "/a.js", contents: "export const b = 2;" },
      ],
    };
    expect(() => compiler.compileToModules(artifact)).toThrow(
      "Ambiguous emit target",
    );
  });

  it("Typechecks a runtime dependency, providing typedefs", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    });
    const modules = await resolveAndCompileToModules(compiler, program, {
      runtimeModules: ["@std/math"],
    });
    expect(modules.get("/main.tsx")!.js).toContain('require("@std/math")');
  });

  it("uses specifier aliases for type resolution without rewriting emitted imports", () => {
    const compiler = new TypeScriptCompiler(types);
    const specifierAliases = new Map([["x-scheme:thing", "/dep.tsx"]]);
    const program = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents:
            `import { value } from "x-scheme:thing";\nexport const run = (): string => value;`,
        },
        {
          name: "/dep.tsx",
          contents: `export const value: string = "ok";`,
        },
      ],
    };

    const modules = compiler.compileToModules(program, { specifierAliases });
    expect(modules.get("/main.tsx")!.js).toContain(
      'require("x-scheme:thing")',
    );

    const badProgram = {
      ...program,
      files: [
        {
          name: "/main.tsx",
          contents:
            `import { missing } from "x-scheme:thing";\nexport const run = missing;`,
        },
        program.files[1],
      ],
    };
    expect(() => compiler.compileToModules(badProgram, { specifierAliases }))
      .toThrow(`has no exported member 'missing'.`);
  });

  it("Resolves nested relative type imports from runtime module typedefs", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts": `
export type { Num } from "./num.ts";
import type { Num } from "./num.ts";
export declare function add(x: Num, y: Num): Num;
`,
      "@std/num.ts": "export type Num = number;",
    });
    await resolveAndCompileToModules(compiler, program, {
      runtimeModules: ["@std/math"],
    });
  });

  it("Throws if runtime module not defined", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": "import { add } from '@std/math';export default add(10,2)",
      "@std/math.d.ts":
        "export declare function add(x: number, y: number): number;",
    });
    await expect(resolveAndCompileToModules(compiler, program)).rejects
      .toThrow();
  });

  it("Compiles TSX with standard-decorator accessor fields", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
function tracked(
  _value: ClassAccessorDecoratorTarget<Counter, number>,
  _context: ClassAccessorDecoratorContext<Counter, number>,
) {
  return {
    init(value: number) {
      return value;
    },
  };
}

declare namespace JSX {
  interface IntrinsicElements {
    div: {};
  }
}

declare const __cfHelpers: {
  h(
    tag: string,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
};

class Counter {
  @tracked accessor count = 1;
}

export default <div>{new Counter().count}</div>;
`,
    });

    const modules = await resolveAndCompileToModules(compiler, program);
    const main = modules.get("/main.tsx");
    expect(main).toBeDefined();
    expect(main!.sourceMap).toBeDefined();
  });

  it("allows exported APIs to use scoped phantom wrapper types", async () => {
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
import type { PerUser } from "commonfabric";

export interface ScopedOutput {
  name: PerUser<string>;
}

export default function build(): ScopedOutput {
  return { name: "Ada" as PerUser<string> };
}
`,
      "commonfabric.d.ts": `
export declare const SCOPE_BRAND: unique symbol;
export type PerUser<T> = T & { readonly [SCOPE_BRAND]?: "user" };
`,
    });
    const compiler = new TypeScriptCompiler(types);
    await resolveAndCompileToModules(compiler, program, {
      runtimeModules: ["commonfabric"],
    });
  });

  it("compiles a pattern whose default export is typed by a branded runtime handle", async () => {
    // The pattern API's branded handle types key on `unique symbol`s the
    // sandbox module declares, and TypeScript's declaration emit cannot name
    // one from the pattern's own emitted declaration. Only the compiler's
    // filter over those brands (`KNOWN_EXPORTED_SYMBOLS`) keeps this
    // compiling, and only when the brand is on it — so the real type module
    // is what this compiles against, not a stand-in.

    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
import { pattern, type SqliteDb } from "commonfabric";

interface BillRow { id: number; subject: string; }
type Input = { mail: SqliteDb };
type Output = { bills: unknown };

export default pattern<Input, Output>(({ mail }) => ({
  bills: mail.query<BillRow>("SELECT id, subject FROM messages", {}),
}));
`,
      ...fabricTypeModules,
    });
    const compiler = new TypeScriptCompiler(types);
    const modules = await resolveAndCompileToModules(compiler, program, {
      runtimeModules: FABRIC_RUNTIME_MODULES,
    });
    expect(modules.get("/main.tsx")).toBeDefined();
  });

  it("Inlines errors", async () => {
    const compiler = new TypeScriptCompiler(types);
    const program = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `
function add(x: number, y: number): number {
  return x + y;
} 

export default add(5, "5");`,
    });

    const expected = `4 | } 
5 | 
6 | export default add(5, \"5\");
  |                       ^
`;
    await expect(resolveAndCompileToModules(compiler, program)).rejects
      .toThrow(expected);
  });

  for (const { name, source, expectedError, ...options } of TESTS) {
    it(name, () => {
      const artifact = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      };
      const compiler = new TypeScriptCompiler(types);
      if (expectedError) {
        expect(() => compiler.compileToModules(artifact, options)).toThrow(
          expectedError,
        );
      } else {
        const modules = compiler.compileToModules(artifact, options);
        expect(modules.get("/main.tsx")).toBeDefined();
      }
    });
  }
});
