import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  compileWithEntryBody,
  Engine,
  joinedBodies,
  Runtime,
  signer,
  StorageManager,
} from "./engine-test-support.ts";
import type { RuntimeProgram } from "./engine-test-support.ts";
describe("Engine in SES mode", () => {
  let runtime: Runtime;
  let engine: Engine;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("evaluates safe programs inside SES compartments", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: "export default 42;",
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default).toBe(42);
  });

  it("allows direct top-level builder definitions with schema constants", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern, schema } from "commonfabric";',
            "const model = schema({",
            '  type: "object",',
            '  properties: { count: { type: "number" } },',
            '  required: ["count"],',
            "});",
            "export default pattern<{ count: number }>(({ count }) => ({ count }), model, model);",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main).toBeDefined();
    expect(main?.default).toBeDefined();
    expect(main?.default.nodes).toBeDefined();
  });

  it("allows CTS-wrapped top-level data to be captured by builder callbacks", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { lift } from "commonfabric";',
            'const labels = (() => ({ open: "Open" }))();',
            "export default lift(() => labels.open);",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(main?.default).toBeDefined();
  });

  it("allows CTS-wrapped accessor-backed data snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { lift } from "commonfabric";',
            "const lookup = {",
            '  get open() { return "Open"; },',
            "};",
            "export default lift(() => lookup.open);",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(main?.default).toBeDefined();
  });

  it("rejects proxy-backed top-level snapshots while Proxy stays disabled", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { lift } from "commonfabric";',
            'const lookup = new Proxy({ open: "Open" }, {',
            "  get(target, key) {",
            '    return key === "open" ? "Open" : Reflect.get(target, key);',
            "  },",
            "});",
            "export default lift(() => lookup.open);",
          ].join("\n"),
        },
      ],
    };

    // The type libraries declare no `Proxy` value, so naming the constructor
    // is turned away at type check, which runs ahead of the snapshot verifier.
    // Either rejection keeps proxy-backed data out of a top-level snapshot.
    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      /Cannot find name 'Proxy'|Mutable top-level data must be wrapped in __cf_data|Only verified plain data|Only trusted builder calls/,
    );
  });

  it("allows CTS-wrapped symbol-keyed data snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { lift } from "commonfabric";',
            "const lookup = (() => {",
            '  const tag = Symbol("open");',
            '  return { [tag]: "Open" };',
            "})();",
            "export default lift(() => Object.getOwnPropertySymbols(lookup).length);",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(main?.default).toBeDefined();
  });

  it("compiles JSX fragments without helper mutation escape hatches", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { pattern } from "commonfabric";',
            "export default pattern(() => ({",
            "  ui: <>Hello</>,",
            "}));",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    const bodies = joinedBodies(graph);

    expect(bodies).toContain("__cfHelpers.h.fragment");
    expect(bodies).not.toContain(".fragment =");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(main?.default).toBeDefined();
  });

  it("allows CTS-wrapped local helper calls for inert top-level data", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "function buildYears() {",
            "  const currentYear = 2024;",
            "  const years: string[] = [];",
            "  for (let year = currentYear; year >= currentYear - 2; year--) {",
            "    years.push(String(year));",
            "  }",
            "  return years;",
            "}",
            "const years = buildYears();",
            "export default years;",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data(buildYears())");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(main?.default).toHaveLength(3);
    expect(typeof main?.default?.[0]).toBe("string");
  });

  it("allows CTS-wrapped Object.fromEntries() top-level snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'const scopeMap = { gmail: "gmail.readonly" } as const;',
            "const scopes = Object.fromEntries(",
            "  Object.entries(scopeMap).map(([key, value]) => [key, { value }]),",
            ");",
            "export default scopes;",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data(Object.fromEntries(");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(main?.default).toEqual({
      gmail: { value: "gmail.readonly" },
    });
  });

  it("allows CTS-wrapped RegExp top-level snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "const matcher = /^[a-z]+$/;",
            "export default matcher;",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cf_data(/^[a-z]+$/)");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(main?.default).toBeInstanceOf(RegExp);
    expect(main?.default?.test("hello")).toBe(true);
  });

  it("allows top-level template literal snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "const layout = `# Aisle 1",
            "Milk",
            "Eggs`;",
            "export default layout;",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default).toContain("# Aisle 1");
    expect(main?.default).toContain("Eggs");
  });

  it("wraps imported helper modules inside CTS graphs", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { TEMPLATE_REGISTRY } from "./template-registry.ts";',
            'export { INTERNAL_MODULE_TYPES } from "./schema-utils-pure.ts";',
            "export default TEMPLATE_REGISTRY.person.label;",
          ].join("\n"),
        },
        {
          name: "/template-registry.ts",
          contents: [
            "export const TEMPLATE_REGISTRY = {",
            '  person: { label: "Person" },',
            "};",
          ].join("\n"),
        },
        {
          name: "/schema-utils-pure.ts",
          contents:
            'export const INTERNAL_MODULE_TYPES = new Set(["type-picker"]);',
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    const bodies = joinedBodies(graph);
    expect(bodies).toMatch(
      /exports\.TEMPLATE_REGISTRY = commonfabric_\d+\.__cfHelpers\.__cf_data\(\{/,
    );
    expect(bodies).toMatch(
      /exports\.INTERNAL_MODULE_TYPES = commonfabric_\d+\.__cfHelpers\.__cf_data\(new Set\(\["type-picker"\]\)\);/,
    );

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(main?.default).toBe("Person");
  });

  it("compiles the self-improving classifier pattern", async () => {
    const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
      /\/$/,
      "",
    );
    const sourcePath = new URL(
      "../../patterns/self-improving-classifier.tsx",
      import.meta.url,
    ).pathname;
    const program = await resolveLocalProgram(
      (resolver) => engine.resolve(resolver),
      { main: sourcePath, root: repoRoot },
    );

    const { graph } = await engine.compileToRecordGraph(program);
    expect(joinedBodies(graph).length).toBeGreaterThan(0);
  });

  it("rejects top-level mutable bindings", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "let counter = 0;",
            "export default function next() {",
            "  counter += 1;",
            "  return counter;",
            "}",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Top-level mutable bindings are not allowed in SES mode",
    );
  });

  it("rejects top-level IIFEs that try to hide mutable state", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [{ name: "/main.ts", contents: "export default 42;\n" }],
    };

    await expect(
      compileWithEntryBody(
        engine,
        program,
        [
          "const state = (() => ({ count: 0 }))();",
          "exports.default = 42;",
        ].join("\n"),
      ),
    ).rejects.toThrow("Only trusted builder calls");
  });

  it("rejects top-level patternTool() bindings in SES mode", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern, patternTool } from "commonfabric";',
            "export default patternTool(pattern(() => ({ ok: true })));",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Only trusted builder calls",
    );
  });

  it("compiles and evaluates a patternTool whose pattern is hoisted to module scope", async () => {
    // patternTool's `pattern(...)` argument is hoisted to a module-scope const
    // by BuilderCallHoistingTransformer. Compile + evaluate end-to-end (not
    // just transformer goldens) to confirm the hoisted pattern doesn't trip a
    // module-load error and the tool survives. The pattern returns a plain-data
    // object (as patternTool patterns do); `count` is supplied per-call.
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern, patternTool } from "commonfabric";',
            "export default pattern(() => {",
            "  const tool = patternTool(",
            "    pattern(({ count }: { count: number }) => ({ doubled: count * 2 })),",
            "  );",
            "  return { tool };",
            "});",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default).toBeDefined();
  });

  it("allows trusted-builder callbacks that capture top-level schema snapshots", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift, schema } from "commonfabric";',
            "const state = schema({",
            '  type: "object",',
            '  properties: { count: { type: "number" } },',
            "});",
            "export default lift(() => state.type);",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default).toBeDefined();
  });

  it("allows trusted-builder callbacks that capture top-level schema snapshots via shorthand properties", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift, schema } from "commonfabric";',
            "const state = schema({",
            '  type: "object",',
            '  properties: { count: { type: "number" } },',
            "});",
            "export default lift(() => ({ state }));",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default).toBeDefined();
  });

  it("rejects a toSchema() call that compile-time substitution never replaced", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [{ name: "/main.ts", contents: "export default 42;\n" }],
    };

    await expect(
      compileWithEntryBody(
        engine,
        program,
        [
          'const commonfabric = require("commonfabric");',
          "exports.default = commonfabric.toSchema({ default: { count: 0 } });",
        ].join("\n"),
      ),
    ).rejects.toThrow("Only trusted builder calls");
  });

  it("hardens direct top-level functions against hidden mutable state", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "function next() {",
            "  const self = next as typeof next & { count?: number };",
            "  self.count = (self.count ?? 0) + 1;",
            "  return self.count;",
            "}",
            "export default next;",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    expect(() => (main?.default as () => number)()).toThrow();
  });

  it("rejects top-level fragment mutation escape hatches", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "function counter() {",
            "  const self = counter as typeof counter & { fragment?: { count: number } };",
            "  self.fragment!.count += 1;",
            "  return self.fragment!.count;",
            "}",
            "counter.fragment = { count: 0 };",
            "export default counter;",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow();
  });

  it("hardens trusted builder callbacks against hidden mutable state", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { lift } from "commonfabric";',
            "export default lift(function step() {",
            "  const self = step as typeof step & { count?: number };",
            "  self.count = (self.count ?? 0) + 1;",
            "  return self.count;",
            "});",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    const implementation = (main?.default as {
      implementation: () => number;
    }).implementation;

    expect(() => implementation()).toThrow();
  });

  it("reconstructs stringified functions through cached callback creators", () => {
    const next = engine.getInvocation("function next(x) { return x + 1; }") as (
      input: number,
    ) => number;

    expect(next(1)).toBe(2);
  });

  it("accepts function-producing callback expressions with fresh state", () => {
    const next = engine.getInvocation(
      "(() => { let leaked = 0; return () => ++leaked; })()",
    ) as () => number;

    expect(next()).toBe(1);
    expect(next()).toBe(1);
  });

  it("rejects non-function callback source when invoked", () => {
    const notFn = engine.getInvocation("42") as () => unknown;

    expect(() => notFn()).toThrow();
  });

  it("reconstructs callbacks with embedded quotes safely", () => {
    const probe = engine.getInvocation(
      `() => 'single "double" \`template\` \\\\ slash'`,
    ) as () => string;

    expect(probe()).toBe(`single "double" \`template\` \\ slash`);
  });

  it("rehydrates stringified functions in the smaller callback compartment", () => {
    const probe = engine.getInvocation(
      "function probe() { return typeof globalThis.RUNTIME_ENGINE_CONSOLE_HOOK; }",
    ) as () => string;

    expect(probe()).toBe("undefined");
  });

  it("owns callback creator caches on the engine runtime and clears them on dispose", () => {
    const next = engine.getInvocation("function next(x) { return x + 1; }") as (
      input: number,
    ) => number;

    expect(next(1)).toBe(2);
    expect(
      engine.accessForTestingOnly.sesRuntime!.accessForTestingOnly
        .callbackEvaluator.accessForTestingOnly.callbackCreatorCache.size,
    ).toBe(1);

    engine.dispose();

    expect(
      engine.accessForTestingOnly.sesRuntime?.accessForTestingOnly
        .callbackEvaluator.accessForTestingOnly.callbackCreatorCache.size ?? 0,
    ).toBe(0);
  });
});
