import { assert, assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { fromFileUrl } from "@std/path";
import { InMemoryProgram } from "@commonfabric/js-compiler/program";
import { resolveRuntimeProgram } from "../src/harness/program-resolution.ts";

const names = (files: readonly { name: string }[]) =>
  files.map((file) => file.name).sort();

describe("resolveRuntimeProgram", () => {
  it("follows imports and leaves the runtime's own modules unresolved", async () => {
    const program = await resolveRuntimeProgram(
      new InMemoryProgram("/main.tsx", {
        "/main.tsx": 'import { pattern } from "commonfabric";\n' +
          'import { helper } from "./helper.ts";\n' +
          "export default pattern(() => helper());\n",
        "/helper.ts": "export const helper = () => 1;\n",
        "/unreached.ts": "export const unreached = 2;\n",
      }),
    );
    assertEquals(program.main, "/main.tsx");
    assertEquals(names(program.files), ["/helper.ts", "/main.tsx"]);
    assertEquals(program.sourceRoots, undefined);
    assertEquals(program.dataFiles, undefined);
  });

  it("refuses a bare import the runtime does not provide", async () => {
    await assertRejects(
      () =>
        resolveRuntimeProgram(
          new InMemoryProgram("/main.tsx", {
            "/main.tsx":
              'import lodash from "lodash";\nexport default lodash;\n',
          }),
        ),
      Error,
      'Could not resolve "lodash", imported by "/main.tsx".',
    );
  });

  it("attaches the data files the source declares", async () => {
    const program = await resolveRuntimeProgram(
      new InMemoryProgram("/main.tsx", {
        "/main.tsx": 'import { dataFile } from "commonfabric";\n' +
          'export default () => dataFile("/data/cities.json");\n',
        "/data/cities.json": '["Oslo"]\n',
      }),
    );
    assertEquals(program.dataFiles, ["/data/cities.json"]);
    assertEquals(names(program.files), ["/data/cities.json", "/main.tsx"]);
  });

  it("merges each source root's closure and names the roots", async () => {
    const program = await resolveRuntimeProgram(
      new InMemoryProgram("/main.tsx", {
        "/main.tsx": "export default 1;\n",
        "/main.test.tsx": 'import main from "./main.tsx";\n' +
          'import { fixture } from "./fixture.ts";\n' +
          "export const t = [main, fixture];\n",
        "/fixture.ts": "export const fixture = 3;\n",
      }),
      { sourceRoots: ["/main.test.tsx"] },
    );
    assertEquals(program.main, "/main.tsx");
    assertEquals(program.sourceRoots, ["/main.test.tsx"]);
    assertEquals(
      names(program.files),
      ["/fixture.ts", "/main.test.tsx", "/main.tsx"],
    );
  });

  // The module exists so a caller that only resolves need not load a
  // runtime. Resolution loads the compiler stack by dynamic import, so the
  // graph checked is the module's static imports plus that stack's.
  it("loads neither the runtime nor the engine", async () => {
    const entry = fromFileUrl(
      new URL("../src/harness/program-resolution.ts", import.meta.url),
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--no-lock", "--json", entry],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(output.success, new TextDecoder().decode(output.stderr));
    const info: {
      modules: {
        specifier: string;
        dependencies?: {
          isDynamic?: boolean;
          code?: { specifier?: string };
        }[];
      }[];
    } = JSON.parse(new TextDecoder().decode(output.stdout));
    const modules = new Map(info.modules.map((m) => [m.specifier, m]));
    const root = new URL(`file://${entry}`).href;
    const loaded = new Set<string>();
    const pending = [root];
    while (pending.length > 0) {
      const specifier = pending.pop()!;
      if (loaded.has(specifier)) continue;
      loaded.add(specifier);
      for (const dependency of modules.get(specifier)?.dependencies ?? []) {
        const target = dependency.code?.specifier;
        if (target === undefined) continue;
        if (
          dependency.isDynamic &&
          !target.endsWith("/src/harness/compiler-stack.ts")
        ) continue;
        pending.push(target);
      }
    }
    assert(
      [...loaded].some((s) => s.endsWith("/src/harness/compiler-stack.ts")),
      "the walk reached the compiler stack",
    );
    const heavy = [...loaded].filter((s) =>
      s.endsWith("/runtime/runner/src/runtime.ts") ||
      s.endsWith("/runtime/runner/src/harness/engine.ts")
    );
    assertEquals(heavy, []);
  });
});
