import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  Engine,
  joinedBodies,
  Runtime,
  signer,
  StorageManager,
} from "./engine-test-support.ts";
import type { RuntimeProgram } from "./engine-test-support.ts";
describe("Engine compile + evaluate", () => {
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

  it("compile+evaluate works with pattern source", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "const double = lift<number>((x) => x * 2);",
            "export default pattern<{ value: number }>(({ value }) => {",
            "  return { result: double(value) };",
            "});",
          ].join("\n"),
        },
      ],
    };

    const result = await engine.compileAndEvaluateModules(program);

    expect(result.main).toBeDefined();
    expect(result.main!["default"]).toBeDefined();
  });

  it("compile returns a record graph, evaluate executes it", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 'hello';",
        },
      ],
    };

    // compileToRecordGraph() should not execute the modules
    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(graph.compiledBodies.size).toBeGreaterThan(0);

    // evaluateRecordGraph() should execute them
    const result = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(result.main!["default"]).toBe("hello");
  });

  it("compiles and evaluates a pattern whose module binds `h` at top level", async () => {
    // The pre-transform's forwarding `h` shim would collide with the authored
    // `h`, so it is emitted as `__cfHelpersShim`: still a direct function,
    // which the module-body verifier admits at module scope (a bare
    // `void __cfHelpers;` use is rejected as top-level executable code).
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern, UI } from 'commonfabric';",
            "const h = ['a', 'b'];",
            "export default pattern<{ title: string }>(({ title }) => ({",
            "  [UI]: <ul title={title}>{h.map((item) => <li>{item}</li>)}</ul>,",
            "}));",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    const bodies = joinedBodies(graph);
    expect(bodies).toContain("function __cfHelpersShim(");
    expect(bodies).not.toContain("function h(");

    const result = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(result.main!["default"]).toBeDefined();
  });

  it("compile+evaluate returns the default export pattern", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "export default pattern<{ x: number }>(({ x }) => ({ doubled: x }));",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main).toBeDefined();
    expect(main!["default"]).toBeDefined();
    expect(main!["default"].nodes).toBeDefined();
  });

  it("evaluate returns undefined for missing named export", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      mainExport: "nonExistent",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42;",
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main).toBeDefined();
    expect(main!["nonExistent"]).toBeUndefined();
  });

  it("compile+evaluate retrieves named export", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      mainExport: "myPattern",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "export const myPattern = pattern<{ x: number }>(({ x }) => ({ x }));",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main).toBeDefined();
    expect(main!["myPattern"]).toBeDefined();
    expect(main!["myPattern"].nodes).toBeDefined();
  });
});
