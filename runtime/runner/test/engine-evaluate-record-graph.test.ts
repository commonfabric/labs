import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  compileWithEntryBody,
  Engine,
  evaluateWithEntryBody,
  getVerifiedProvenance,
  joinedBodies,
  Runtime,
  signer,
  StorageManager,
} from "./engine-test-support.ts";
import type { RuntimeProgram } from "./engine-test-support.ts";
import { validateCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { getPatternProgram } from "../src/builder/pattern-metadata.ts";
describe("Engine.evaluateRecordGraph()", () => {
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

  it("evaluates compiled modules and returns exports", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42; export const name = 'test';",
        },
      ],
    };

    const result = await engine.compileAndEvaluateModules(program);

    expect(result.main).toBeDefined();
    expect(result.main!["default"]).toBe(42);
    expect(result.exportMap).toBeDefined();
  });

  it("carries compiler-verified policy manifests outside module exports", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import {
            cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
          } from "commonfabric/cfc";
          export const release = exchangeRule({
            appliesTo: THIS_POLICY,
            pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
            post: { addAlternatives: [cfcPattern.user(v("user"))] },
          });
          export const rules = exchangeRules([release]);
        `,
      }],
    };

    const compiled = await engine.compileToRecordGraph(program);
    const module = compiled.modules[0]!;
    const artifact = validateCfcPolicyArtifactManifest(
      module.policyManifests?.[0],
    );

    expect(artifact.manifest.moduleIdentity).toBe(module.identity);
    expect(artifact.manifest.symbol).toBe("rules");
    expect(module.js).not.toContain(artifact.policyDigest);

    const checked = await engine.typeCheckBatch([program]);
    expect(checked.patternCount).toBe(1);
    expect(checked.diagnostics).toEqual([]);

    const recovered = await engine.compileResolvedToRecordGraph(
      program.files,
      program.main,
    );
    expect(recovered.modules[0]?.policyManifests).toHaveLength(1);
  });

  it("does not initialize the TypeScript compiler when evaluating a precompiled graph", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42;",
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    const evaluateOnlyEngine = new class extends Engine {
      override initializeCompiler(): never {
        throw new Error("compiler initialized during evaluate");
      }
    }(runtime);

    try {
      const result = evaluateOnlyEngine.evaluateRecordGraph(
        id,
        graph,
        mainSpecifier,
        program,
      );
      expect(result.main!["default"]).toBe(42);
    } finally {
      evaluateOnlyEngine.dispose();
    }
  });

  it("correctly maps exports from multi-file programs", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/utils.ts",
          contents:
            "export const double = (x: number) => x * 2; export const triple = (x: number) => x * 3;",
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

    const result = await engine.compileAndEvaluateModules(program);

    expect(result.main).toBeDefined();
    expect(result.main!["default"]()).toBe(42);
    expect(result.exportMap).toBeDefined();

    // exportMap should include exports from source files
    // (also includes the injected /index.ts re-export entry)
    const files = Object.keys(result.exportMap!);
    expect(files.length).toBeGreaterThanOrEqual(2);

    // Find the utils entry — keys are normalized authored paths.
    const utilsKey = files.find((f) => f.includes("utils"));
    expect(utilsKey).toBeDefined();
    const utilExports = result.exportMap![utilsKey!];
    expect(typeof utilExports["double"]).toBe("function");
    expect(typeof utilExports["triple"]).toBe("function");
  });

  it("retains source roots without evaluating them", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      sourceRoots: ["/main.test.tsx"],
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42;",
        },
        {
          name: "/main.test.tsx",
          contents: [
            'import { pattern } from "commonfabric";',
            "export default pattern(() => ({ test: true }));",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(
      [...graph.specifierByPath.keys()].some((path) =>
        path.endsWith("/main.test.tsx")
      ),
    ).toBe(true);

    const result = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(result.main?.default).toBe(42);
    expect(
      Object.keys(result.exportMap ?? {}).some((path) =>
        path.endsWith("/main.test.tsx")
      ),
    ).toBe(false);
    expect(graph.registrationSink.size).toBe(0);
  });

  it("retains data files without compiling them", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/data/cities.json", "/data/notes.txt"],
      files: [
        {
          name: "/main.tsx",
          contents: "export default 42;",
        },
        {
          name: "/data/cities.json",
          contents: '{"cities": ["Oslo", "Lima"]}',
        },
        {
          // Bytes that are not TypeScript, and that a parser would read as an
          // import edge if a data file were ever scanned.
          name: "/data/notes.txt",
          contents: 'import nonsense from "./nowhere.ts";\nnot code at all',
        },
      ],
    };

    const { id, graph, mainSpecifier, modules, entryIdentity } = await engine
      .compileToRecordGraph(program);

    expect(
      [...graph.specifierByPath.keys()].some((path) =>
        path.endsWith("/data/cities.json")
      ),
    ).toBe(false);

    const stored = new Map(modules.map((m) => [m.filename, m]));
    expect(stored.get("/data/cities.json")?.source).toBe(
      '{"cities": ["Oslo", "Lima"]}',
    );
    // A data entry's compiled form is its own bytes, so the compiled set alone
    // carries what a warm load needs.
    expect(stored.get("/data/cities.json")?.js).toBe(
      '{"cities": ["Oslo", "Lima"]}',
    );
    expect(stored.get("/data/cities.json")?.isData).toBe(true);
    expect(stored.get("/main.tsx")).not.toHaveProperty("isData");
    expect(stored.get("/data/notes.txt")?.imports).toEqual([]);

    const entry = modules.find((m) => m.identity === entryIdentity)!;
    expect(
      entry.imports.map((edge) => edge.specifier).filter((specifier) =>
        specifier.startsWith("cf:data-file/")
      ),
    ).toEqual(["cf:data-file/data/cities.json", "cf:data-file/data/notes.txt"]);

    const result = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(result.main?.default).toBe(42);
    expect(
      Object.keys(result.exportMap ?? {}).some((path) =>
        path.startsWith("/data/")
      ),
    ).toBe(false);
  });

  it("marks the data files on the program it records for an export", async () => {
    // Every exported pattern is recorded with the program it came from, and
    // that program names data entries among its files. Recorded without
    // `dataFiles`, the entries are there with nothing saying they are data, so
    // anything that later builds from that program compiles the JSON.
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: "import { pattern } from 'commonfabric';\n" +
            "export const child = pattern(() => ({ value: 1 }));\n" +
            "export default child;\n",
        },
        { name: "/data/cities.json", contents: '["Oslo"]\n' },
      ],
      dataFiles: ["/data/cities.json"],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    const result = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    const child = (result.main as Record<string, unknown>).child;
    expect(getPatternProgram(child)?.dataFiles).toEqual(["/data/cities.json"]);
  });

  it("reads an attached data file's bytes from the pattern", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/data/cities.json"],
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { __cf_data, dataFile } from "commonfabric";',
            // A value computed at module scope is a top-level value like any
            // other, so it takes the same `__cf_data` snapshot the SES verifier
            // requires of one. Reading inside a pattern body needs no wrapper.
            "const cities = __cf_data(",
            '  JSON.parse(dataFile("/data/cities.json")).cities,',
            ");",
            "export default cities;",
          ].join("\n"),
        },
        { name: "/data/cities.json", contents: '{"cities": ["Oslo", "Lima"]}' },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    expect(main?.default).toEqual(["Oslo", "Lima"]);
  });

  it("resolves a relative read against the module that makes it", async () => {
    // The reading module sits two directories down and names the file beside
    // it. Nothing in the program spells the path the file is stored under, so
    // the read has to work it out from where the reader is.
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/lists/nordic/cities.json"],
      files: [
        {
          name: "/main.tsx",
          contents: 'export { cities } from "./lists/nordic/read.ts";\n',
        },
        {
          name: "/lists/nordic/read.ts",
          contents: [
            'import { __cf_data, dataFile } from "commonfabric";',
            "export const cities = __cf_data(",
            '  JSON.parse(dataFile("./cities.json")).cities,',
            ");",
          ].join("\n"),
        },
        {
          name: "/lists/nordic/cities.json",
          contents: '{"cities": ["Oslo", "Bergen"]}',
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    expect((main as Record<string, unknown>).cities).toEqual([
      "Oslo",
      "Bergen",
    ]);
  });

  it("resolves a bare read against the module that makes it", async () => {
    // No leading `./`. A data file has no bare-package namespace, so a path
    // that is not grounded at the package root is relative to the reader.
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/lists/cities.json"],
      files: [
        {
          name: "/main.tsx",
          contents: 'export { cities } from "./lists/read.ts";\n',
        },
        {
          name: "/lists/read.ts",
          contents: [
            'import { __cf_data, dataFile } from "commonfabric";',
            "export const cities = __cf_data(",
            '  JSON.parse(dataFile("cities.json")).cities,',
            ");",
          ].join("\n"),
        },
        { name: "/lists/cities.json", contents: '{"cities": ["Rio"]}' },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    expect((main as Record<string, unknown>).cities).toEqual(["Rio"]);
  });

  it("climbs out of the reading module's directory for a parent read", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/shared/cities.json"],
      files: [
        {
          name: "/main.tsx",
          contents: 'export { cities } from "./nordic/read.ts";\n',
        },
        {
          name: "/nordic/read.ts",
          contents: [
            'import { __cf_data, dataFile } from "commonfabric";',
            "export const cities = __cf_data(",
            '  JSON.parse(dataFile("../shared/cities.json")).cities,',
            ");",
          ].join("\n"),
        },
        { name: "/shared/cities.json", contents: '{"cities": ["Lima"]}' },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    expect((main as Record<string, unknown>).cities).toEqual(["Lima"]);
  });

  it("gives two modules at different depths their own sibling file", async () => {
    // Both modules read `./cities.json`, and each gets the one beside it.
    // A read resolved anywhere but at the reader would hand both the same
    // file.
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/nordic/cities.json", "/andean/deep/cities.json"],
      files: [
        {
          name: "/main.tsx",
          contents: [
            'export { cities as nordic } from "./nordic/read.ts";',
            'export { cities as andean } from "./andean/deep/read.ts";',
          ].join("\n"),
        },
        {
          name: "/nordic/read.ts",
          contents: [
            'import { __cf_data, dataFile } from "commonfabric";',
            "export const cities = __cf_data(",
            '  JSON.parse(dataFile("./cities.json")).cities,',
            ");",
          ].join("\n"),
        },
        {
          name: "/andean/deep/read.ts",
          contents: [
            'import { __cf_data, dataFile } from "commonfabric";',
            "export const cities = __cf_data(",
            '  JSON.parse(dataFile("./cities.json")).cities,',
            ");",
          ].join("\n"),
        },
        { name: "/nordic/cities.json", contents: '{"cities": ["Oslo"]}' },
        { name: "/andean/deep/cities.json", contents: '{"cities": ["Lima"]}' },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    expect((main as Record<string, unknown>).nordic).toEqual(["Oslo"]);
    expect((main as Record<string, unknown>).andean).toEqual(["Lima"]);
  });

  it("leaves a module's own export named dataFile alone", async () => {
    // Only the runtime's `dataFile` reads attached data. A local module is free
    // to export a value under that name, and an importer gets the one it
    // imported.
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/cities.json"],
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { __cf_data } from "commonfabric";',
            'import { dataFile } from "./local.ts";',
            'export default __cf_data(dataFile("/cities.json"));',
          ].join("\n"),
        },
        {
          name: "/local.ts",
          contents:
            "export const dataFile = (path: string) => `local:${path}`;\n",
        },
        { name: "/cities.json", contents: '{"cities": []}' },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    expect(main?.default).toBe("local:/cities.json");
  });

  it("names the path a failed relative read resolved to", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/nordic/cities.json"],
      files: [
        {
          name: "/main.tsx",
          contents: 'export { text } from "./nordic/read.ts";\n',
        },
        {
          name: "/nordic/read.ts",
          contents: [
            'import { __cf_data, dataFile } from "commonfabric";',
            'export const text = __cf_data(dataFile("./absent.json"));',
          ].join("\n"),
        },
        { name: "/nordic/cities.json", contents: "[]" },
      ],
    };

    await expect(engine.compileAndEvaluateModules(program)).rejects.toThrow(
      'No attached data file "/nordic/absent.json". ' +
        "Attached: /nordic/cities.json.",
    );
  });

  it("names the attached data files when a path matches none", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/data/cities.json"],
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { __cf_data, dataFile } from "commonfabric";',
            'export default __cf_data(dataFile("/data/absent.json"));',
          ].join("\n"),
        },
        { name: "/data/cities.json", contents: "[]" },
      ],
    };

    await expect(engine.compileAndEvaluateModules(program)).rejects.toThrow(
      'No attached data file "/data/absent.json". Attached: /data/cities.json.',
    );
  });

  it("separates identities for data files differing only in line endings", async () => {
    // A data file's bytes are the payload a pattern reads, so CRLF and LF are
    // different content — unlike source text, where they are formatting.
    const compile = (contents: string) =>
      engine.compileToRecordGraph({
        main: "/main.tsx",
        dataFiles: ["/data/rows.csv"],
        files: [
          { name: "/main.tsx", contents: "export default 42;" },
          { name: "/data/rows.csv", contents },
        ],
      });

    const lf = await compile("a,b\nc,d\n");
    const crlf = await compile("a,b\r\nc,d\r\n");

    expect(lf.entryIdentity).not.toBe(crlf.entryIdentity);
    const dataIdentity = (r: Awaited<ReturnType<typeof compile>>) =>
      r.modules.find((m) => m.filename === "/data/rows.csv")!.identity;
    expect(dataIdentity(lf)).not.toBe(dataIdentity(crlf));
  });

  it("refuses a program naming its entry as a data file", async () => {
    await expect(engine.compileToRecordGraph({
      main: "/main.tsx",
      dataFiles: ["/main.tsx"],
      files: [{ name: "/main.tsx", contents: "export default 42;" }],
    })).rejects.toThrow("cannot be a data file");
  });

  it("refuses an import that lands on a data file", async () => {
    await expect(engine.compileToRecordGraph({
      main: "/main.tsx",
      dataFiles: ["/data.json"],
      files: [
        {
          name: "/main.tsx",
          contents: 'import data from "./data.json";\nexport default data;',
        },
        { name: "/data.json", contents: "{}" },
      ],
    })).rejects.toThrow(/Could not resolve ".*\/data\.json"/);
  });

  it("refuses a program naming a data file it does not carry", async () => {
    await expect(engine.compileToRecordGraph({
      main: "/main.tsx",
      dataFiles: ["/absent.json"],
      files: [{ name: "/main.tsx", contents: "export default 42;" }],
    })).rejects.toThrow(
      "Program names data files it does not carry: /absent.json",
    );
  });

  it("separates load identities for different data-file sets", async () => {
    const files = [
      { name: "/main.tsx", contents: "export default 42;" },
      { name: "/a.json", contents: '{"a": 1}' },
      { name: "/b.json", contents: '{"b": 2}' },
    ];

    const aOnly = await engine.compileToRecordGraph({
      main: "/main.tsx",
      files,
      dataFiles: ["/a.json"],
    });
    const both = await engine.compileToRecordGraph({
      main: "/main.tsx",
      files,
      dataFiles: ["/a.json", "/b.json"],
    });
    const reordered = await engine.compileToRecordGraph({
      main: "/main.tsx",
      files,
      dataFiles: ["/b.json", "/a.json", "/a.json"],
    });
    const contentChanged = await engine.compileToRecordGraph({
      main: "/main.tsx",
      files: files.map((file) =>
        file.name === "/a.json" ? { ...file, contents: '{"a": 9}' } : file
      ),
      dataFiles: ["/a.json", "/b.json"],
    });

    expect(aOnly.entryIdentity).not.toBe(both.entryIdentity);
    expect(reordered.id).toBe(both.id);
    expect(reordered.entryIdentity).toBe(both.entryIdentity);
    expect(contentChanged.entryIdentity).not.toBe(both.entryIdentity);
  });

  it("separates load identities for different source-root sets", async () => {
    const files = [
      {
        name: "/main.tsx",
        contents: "export default 42;",
      },
      {
        name: "/a.test.tsx",
        contents: [
          'import "./b.test.tsx";',
          'import type { Marker } from "./types.d.ts";',
          "export type TestMarker = Marker;",
          "export default 1;",
        ].join("\n"),
      },
      {
        name: "/b.test.tsx",
        contents: "export default 2;",
      },
      {
        name: "/types.d.ts",
        contents: "export interface Marker { value: number; }",
      },
    ];

    const aOnly = await engine.compileToRecordGraph({
      main: "/main.tsx",
      files,
      sourceRoots: ["/a.test.tsx"],
    });
    const both = await engine.compileToRecordGraph({
      main: "/main.tsx",
      files,
      sourceRoots: ["/a.test.tsx", "/b.test.tsx"],
    });
    const reordered = await engine.compileToRecordGraph({
      main: "/main.tsx",
      files,
      sourceRoots: ["/b.test.tsx", "/a.test.tsx", "/a.test.tsx"],
    });
    const declarationChanged = await engine.compileToRecordGraph({
      main: "/main.tsx",
      files: files.map((file) =>
        file.name === "/types.d.ts"
          ? {
            ...file,
            contents: "export interface Marker { value: string; }",
          }
          : file
      ),
      sourceRoots: ["/a.test.tsx", "/b.test.tsx"],
    });

    expect(aOnly.id).not.toBe(both.id);
    expect(aOnly.entryIdentity).not.toBe(both.entryIdentity);
    expect(reordered.id).toBe(both.id);
    expect(reordered.entryIdentity).toBe(both.entryIdentity);
    expect(declarationChanged.id).not.toBe(both.id);
    expect(declarationChanged.entryIdentity).not.toBe(both.entryIdentity);
    expect(
      reordered.modules.find((module) =>
        module.identity === reordered.entryIdentity
      )?.imports,
    ).toEqual(
      both.modules.find((module) => module.identity === both.entryIdentity)
        ?.imports,
    );
  });

  it("serializes verified javascript modules by stable $implRef", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "const doubled = lift((value: number) => value * 2);",
            "export default pattern<{ value: number }>(({ value }) => ({ result: doubled(value) }));",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    runtime.patternManager.associatePatternProgram(
      main!.default as never,
      program,
    );
    const pattern = main!.default as { nodes: Array<{ module: unknown }> };
    const serialized = JSON.parse(
      JSON.stringify(
        pattern,
        (_key, value) => typeof value === "function" ? undefined : value,
      ),
    );

    const module = serialized.nodes[0].module as {
      $implRef?: { identity: string; symbol: string };
      implementationRef?: string;
      implementation?: string;
    };
    // Since the flip the serialized identity is the content-addressed
    // `$implRef`; the legacy `implementationRef` is runtime-only and the body
    // is omitted because this engine's implementation index resolves the ref.
    expect(module.$implRef).toBeDefined();
    expect(typeof module.$implRef!.identity).toBe("string");
    expect(typeof module.$implRef!.symbol).toBe("string");
    expect("implementationRef" in module).toBe(false);
    expect(module.implementation).toBeUndefined();
    expect(
      engine.getVerifiedImplementation(
        module.$implRef!.identity,
        module.$implRef!.symbol,
      ),
    ).toBeDefined();
  });

  it("keeps the serialized identity stable across separate load sessions of the same source", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "const doubled = lift((value: number) => value * 2);",
            "export default pattern<{ value: number }>(({ value }) => ({ result: doubled(value) }));",
          ].join("\n"),
        },
      ],
    };

    const first = await engine.compileAndEvaluateModules(program);
    const second = await engine.compileAndEvaluateModules(program);

    const firstSerialized = JSON.parse(
      JSON.stringify(
        first.main!.default,
        (_key, value) => typeof value === "function" ? undefined : value,
      ),
    );
    const secondSerialized = JSON.parse(
      JSON.stringify(
        second.main!.default,
        (_key, value) => typeof value === "function" ? undefined : value,
      ),
    );

    // Content-addressed `$implRef` is byte-derived, so two loads of identical
    // source serialize the identical ref.
    expect(firstSerialized.nodes[0].module.$implRef).toBeDefined();
    expect(firstSerialized.nodes[0].module.$implRef).toEqual(
      secondSerialized.nodes[0].module.$implRef,
    );
  });

  it("rejects authored local-module namespace imports in SES mode", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/helper.ts",
          contents: "export const value = 1;",
        },
        {
          name: "/main.ts",
          contents: [
            "import * as helper from './helper.ts';",
            "export default function probe() {",
            "  try {",
            "    (helper as typeof helper & { state?: number }).state = 1;",
            '    return "allowed";',
            "  } catch (error) {",
            "    return (error as Error).name;",
            "  }",
            "}",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Top-level mutable bindings are not allowed in SES mode",
    );
  });

  it("allows top-level schema() without CTS because it is a runtime helper", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { schema } from "commonfabric";',
            "const model = schema({",
            '  type: "object",',
            '  properties: { count: { type: "number" } },',
            '  required: ["count"],',
            "});",
            "export default model;",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main).toBeDefined();
    expect(main!["default"]).toEqual({
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    });
  });

  it("allows explicit __cf_data() snapshots without CTS", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { __cf_data } from "commonfabric";',
            "const startedAt = 1_700_000_000_000;",
            "const seed = 0.5;",
            "const snapshot = __cf_data({ startedAt, seed });",
            "export default snapshot;",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(typeof main?.default?.startedAt).toBe("number");
    expect(typeof main?.default?.seed).toBe("number");
  });

  it("rejects raw mutable top-level exports without __cf_data()", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [{ name: "/main.ts", contents: "export default 42;\n" }],
    };

    await expect(
      compileWithEntryBody(
        engine,
        program,
        "exports.default = { nested: { count: 1 } };\n",
      ),
    ).rejects.toThrow();
  });

  it("rejects raw top-level helper calls without __cf_data()", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [{ name: "/main.ts", contents: "export default 42;\n" }],
    };

    await expect(
      compileWithEntryBody(
        engine,
        program,
        [
          "function build() {",
          "  return { count: 1 };",
          "}",
          "exports.default = build();",
        ].join("\n"),
      ),
    ).rejects.toThrow(
      "Top-level call results must be wrapped in __cf_data() in SES mode",
    );
  });

  it("rejects default-exported functions returning builder call results", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern, type FactoryInput } from "commonfabric";',
            "const Wrapper = pattern(() => ({ value: 1 }));",
            "function ChildManager(input: FactoryInput<{}>) {",
            "  input;",
            "  return Wrapper({});",
            "}",
            "export default ChildManager;",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "pattern() is not allowed inside standalone functions",
    );
  });

  it("rejects nested and branched default-exported builder call results", async () => {
    const bodyVariants = [
      [
        "  return true",
        "    ? Wrapper({})",
        "    : null;",
      ],
      [
        "  return {",
        "    child: Wrapper({}),",
        "  };",
      ],
    ];

    for (const body of bodyVariants) {
      const program: RuntimeProgram = {
        main: "/main.ts",
        files: [
          {
            name: "/main.ts",
            contents: [
              'import { pattern, type FactoryInput } from "commonfabric";',
              "const Wrapper = pattern(() => ({ value: 1 }));",
              "function ChildManager(input: FactoryInput<{}>) {",
              "  input;",
              ...body,
              "}",
              "export default ChildManager;",
            ].join("\n"),
          },
        ],
      };

      await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
        "pattern() is not allowed inside standalone functions",
      );
    }
  });

  it("rejects default-exported trusted runtime helper references", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern } from "commonfabric";',
            "export default pattern;",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Default exports must be trusted builders, direct functions, verified data, or import re-exports",
    );
  });

  it("rejects default-exported aliases of trusted runtime helpers", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { pattern } from "commonfabric";',
            "const rawPattern = pattern;",
            "export default rawPattern;",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(program)).rejects.toThrow(
      "Default exports must be trusted builders, direct functions, verified data, or import re-exports",
    );
  });

  it("allows default-exported functions that call plain local helpers", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "function double(value: number) {",
            "  return value * 2;",
            "}",
            "export default function run() {",
            "  return double(21);",
            "}",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);

    expect(main?.default()).toBe(42);
  });

  it("compiles default export calls that evaluate to primitive snapshots through __cf_data", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/math.ts",
          contents: [
            "export function pow(x: number): number {",
            "  return x * x;",
            "}",
          ].join("\n"),
        },
        {
          name: "/main.ts",
          contents: [
            'import { pow } from "./math.ts";',
            "export default pow(5);",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cfHelpers.__cf_data(");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(main?.default).toBe(25);
  });

  it("compiles mixed CTS and non-CTS files with snapshot helpers through __cfHelpers", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/helpers.ts",
          contents: [
            'import { lift } from "commonfabric";',
            "export const increment = lift((value: number) => value + 1);",
          ].join("\n"),
        },
        {
          name: "/math.ts",
          contents: [
            "export function pow(x: number): number {",
            "  return x * x;",
            "}",
          ].join("\n"),
        },
        {
          name: "/main.ts",
          contents: [
            'import "./helpers.ts";',
            'import { pow } from "./math.ts";',
            "export default pow(5);",
          ].join("\n"),
        },
      ],
    };

    const { id, graph, mainSpecifier } = await engine.compileToRecordGraph(
      program,
    );
    expect(joinedBodies(graph)).toContain("__cfHelpers.__cf_data(");

    const { main } = engine.evaluateRecordGraph(
      id,
      graph,
      mainSpecifier,
      program,
    );
    expect(main?.default).toBe(25);
  });

  it("throws when handler() relies on CTS inference without CTS", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [{ name: "/main.ts", contents: "export default 42;\n" }],
    };

    // A handler built from a single callback has no schemas of its own and
    // depends on the ones CTS infers, so a body that never went through the
    // transform has to fail rather than build a schemaless handler.
    await expect(
      evaluateWithEntryBody(
        engine,
        program,
        [
          'const commonfabric_1 = require("commonfabric");',
          "exports.default = commonfabric_1.handler((_event, state) => {",
          "  state.count = state.count + 1;",
          "});",
        ].join("\n"),
      ),
    ).rejects.toThrow("Handler requires schemas or CTS transformer");
  });

  it("keeps handler implementation refs bound to the handler callback", async () => {
    const program: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            'import { handler, pattern, schema } from "commonfabric";',
            'import "commonfabric/schema";',
            "const model = schema({",
            '  type: "object",',
            "  properties: {",
            '    value: { type: "number", default: 0, asCell: ["cell"] },',
            "  },",
            "  default: { value: 0 },",
            "});",
            "const increment = handler({}, model, (_, state) => {",
            "  state.value.set(state.value.get() + 1);",
            "});",
            "export { increment };",
            "export default pattern(",
            "  (cell) => ({",
            "    increment: increment(cell),",
            "    value: cell.value,",
            "  }),",
            "  model,",
            "  model,",
            ");",
          ].join("\n"),
        },
      ],
    };

    const { main } = await engine.compileAndEvaluateModules(program);
    const handlerNode = main?.default?.nodes?.find((node: {
      module?: { wrapper?: string };
    }) => node.module?.wrapper === "handler");
    const module = handlerNode?.module as {
      implementation?: unknown;
    } | undefined;

    expect(typeof module?.implementation).toBe("function");
    // The handler callback's identity facts ride its provenance, and the
    // engine's implementation index resolves the {identity, symbol} back to
    // the SAME live function — the binding the legacy ref index used to pin.
    const provenance = getVerifiedProvenance(
      module!.implementation as (...args: unknown[]) => unknown,
    );
    expect(provenance?.symbol).toBeDefined();
    expect(
      engine.getVerifiedImplementation(
        provenance!.identity,
        provenance!.symbol!,
      ),
    ).toBe(module?.implementation);
  });
});
