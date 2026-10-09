import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  Engine,
  InMemoryProgram,
  joinedBodies,
  Runtime,
  signer,
  StorageManager,
} from "./engine-test-support.ts";
import type { RuntimeProgram } from "./engine-test-support.ts";
describe("Engine.compileToRecordGraph()", () => {
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

  it("compiles a simple program to a verified record graph", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42;",
        },
      ],
    };

    const result = await engine.compileToRecordGraph(program);

    expect(result.id).toBeDefined();
    expect(result.mainSpecifier.startsWith("cf:module/")).toBe(true);
    expect(result.graph.records.has(result.mainSpecifier)).toBe(true);
    expect(result.graph.compiledBodies.size).toBeGreaterThan(0);
    expect(joinedBodies(result.graph).length).toBeGreaterThan(0);
  });

  it("compiles an empty attached source root", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      sourceRoots: ["/main.test.ts"],
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42;",
        },
        {
          name: "/main.test.ts",
          contents: "",
        },
      ],
    };

    const result = await engine.compileToRecordGraph(program);

    expect(
      [...result.graph.specifierByPath.keys()].some((path) =>
        path.endsWith("/main.test.ts")
      ),
    ).toBe(true);
  });

  it("compiles a multi-file program", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/utils.ts",
          contents: "export const double = (x: number) => x * 2;",
        },
        {
          name: "/main.tsx",
          contents: [
            "import { double } from './utils.ts';",
            "export default function run() {",
            "  return double(21);",
            "}",
          ].join("\n"),
        },
      ],
    };

    const result = await engine.compileToRecordGraph(program);

    expect(joinedBodies(result.graph)).toContain("double");
  });

  it("accepts default-import normalization in compiled module bodies", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/dep.ts",
          contents: "const value = 21; export default value;",
        },
        {
          name: "/main.ts",
          contents: "import value from './dep.ts'; export default value;",
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__importDefault");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(main?.default).toBe(21);
  });

  it("accepts top-level async function declarations in SES modules", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "export async function load() {",
            "  return 21;",
            "}",
            "export default load;",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(await main?.default()).toBe(21);
  });

  it("accepts module-scope handlers that capture async function declarations", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { handler, type Writable } from "commonfabric";',
            "const trigger = handler<unknown, { value: Writable<number> }>(",
            "  async (_event, state) => {",
            "    state.value.set(await process(state.value.get()));",
            "  },",
            ");",
            "export async function process(value: number): Promise<number> {",
            "  return value + 1;",
            "}",
            "export default trigger;",
          ].join("\n"),
        },
      ],
    };

    const { graph } = await engine.compileToRecordGraph(program);

    expect(joinedBodies(graph)).toContain("process");
  });

  it("produces per-module source maps", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 'hello';",
        },
      ],
    };

    const { graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );

    expect(graph.moduleSourceMaps.size).toBeGreaterThan(0);
    expect(graph.moduleSourceMaps.get(mainSpecifier)).toBeDefined();
  });

  it("produces deterministic output for the same input", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 123;",
        },
      ],
    };

    const first = await engine.compileToRecordGraph(program);
    const second = await engine.compileToRecordGraph(program);

    expect(first.id).toBe(second.id);
    expect(first.mainSpecifier).toBe(second.mainSpecifier);
    expect(joinedBodies(first.graph)).toBe(joinedBodies(second.graph));
  });

  it("resolves programs when host fetch is mocked before SES init", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    try {
      const program = await engine.resolve(
        new InMemoryProgram("/main.ts", {
          "/main.ts": "export default 1;",
        }),
      );

      expect(program.main).toBe("/main.ts");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on compilation errors", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents:
            "import { nonExistent } from './missing.ts'; export default nonExistent;",
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow();
  });

  describe("a compile error's location", () => {
    // The engine adds a helper import ahead of each authored file before
    // compiling it, so the compiler sees every authored line one line lower.

    /** The message `compileToRecordGraph()` rejects with for `body`. */
    async function compileErrorMessage(body: string): Promise<string> {
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: body }],
      };
      try {
        await engine.compileToRecordGraph(program);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("Expected the compile to fail");
    }

    it("names the authored line of a type error and quotes it", async () => {
      const message = await compileErrorMessage(
        "export default 1;\nconst wrong: number = 'text';\n",
      );

      expect(message).toContain("2 | const wrong: number = 'text';");
      expect(message).not.toContain("3 | const wrong");
    });

    it("names the authored line of a transformer error and quotes it", async () => {
      const message = await compileErrorMessage(
        "export default 1;\nlet counter = 0;\n",
      );

      expect(message).toContain("/main.tsx:2:1 - error:");
      expect(message).toContain("2 | let counter = 0;");
    });
  });

  it("emits __cf_data for CTS top-level data and evaluates it at runtime", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            'const lookup = (() => ({ open: "Open" }))();',
            "export default lookup.open;",
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
    expect(main?.default).toBe("Open");
  });

  it("preserves the gated ambient clock/entropy intrinsics in CTS modules", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "export default function probe() {",
            "  const startedAt = Date.now();",
            "  const seed = Math.random();",
            "  return {",
            "    startedAt,",
            "    seed,",
            "    now: Date.now(),",
            "    random: Math.random(),",
            "  };",
            "}",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    const bodies = joinedBodies(graph);
    expect(bodies).toContain("Date.now");
    expect(bodies).toContain("Math.random");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );

    // The compiled body wired up the gated ambient intrinsics, not the real
    // clock/entropy: invoking them outside a handler trips the time/entropy
    // capability gate. (This test runs inside a runtime pattern frame, so
    // probe() is a non-handler context.)
    expect(() => main?.default()).toThrow(
      "ambient clock",
    );
  });
});
