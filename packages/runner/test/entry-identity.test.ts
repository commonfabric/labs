import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { InMemoryProgram } from "@commonfabric/js-compiler/program";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  computeEntryIdentity,
  resolveEntryIdentity,
} from "../src/harness/entry-identity.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import { transformInjectHelperModule } from "../src/harness/pretransform.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";

// `computeEntryIdentity` and `resolveModuleImports` parse with the TS parser, so
// the compiler stack must be loaded before any standalone (no-engine) call.
await ensureCompilerStack();

const signer = await Identity.fromPassphrase("test operator");

// A shared module carrying a default export so it can be an entry point too.
const SHARED =
  "export const shared = (x: number) => x + 1;\nexport default shared;\n";
const ENTRY =
  `import { shared } from "./shared.ts";\nexport default () => shared(1);\n`;

describe("computeEntryIdentity (light, drift-free)", () => {
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

  it("matches the engine's stored entryIdentity (the linchpin)", async () => {
    // A representative multi-file program: entry imports a sibling.
    const program: RuntimeProgram = {
      main: "/entry.tsx",
      files: [
        { name: "/entry.tsx", contents: ENTRY },
        { name: "/shared.ts", contents: SHARED },
      ],
    };

    const { entryIdentity } = await engine.compileToRecordGraph(program);
    const light = computeEntryIdentity(program.main, program.files);

    expect(light).toBe(entryIdentity);
  });

  it("hashes PRISTINE authored bytes, not the helper-injected form", () => {
    // The engine restores pre-injection bytes before hashing; a helper that
    // hashed `pretransformProgramForModules(...).files` (the injected form)
    // would drift. Prove the two byte-forms genuinely differ, and that we
    // picked pristine.
    const files = [{ name: "/m.tsx", contents: SHARED }];
    const pristineId = computeModuleHashes({ main: "/m.tsx", files })
      .get("/m.tsx")!;
    const injectedId = computeModuleHashes(
      transformInjectHelperModule({ main: "/m.tsx", files }),
    ).get("/m.tsx")!;

    expect(pristineId).not.toBe(injectedId);
    expect(computeEntryIdentity("/m.tsx", files)).toBe(pristineId);
  });

  it("is independent of the entry-point / program id", async () => {
    // The engine's id is a content hash of the whole program; ours is a
    // constant. Same source ⇒ same identity regardless.
    const asEntry: RuntimeProgram = {
      main: "/shared.ts",
      files: [{ name: "/shared.ts", contents: SHARED }],
    };
    const withSibling: RuntimeProgram = {
      main: "/entry.tsx",
      files: [
        { name: "/entry.tsx", contents: ENTRY },
        { name: "/shared.ts", contents: SHARED },
      ],
    };

    const idFromEntryProgram = await engine.compileToRecordGraph(asEntry);
    // /shared.ts has the same identity whether it is the entry or a sibling.
    const lightAsEntry = computeEntryIdentity("/shared.ts", asEntry.files);
    const lightAsSibling = computeEntryIdentity(
      "/shared.ts",
      withSibling.files,
    );

    expect(lightAsEntry).toBe(idFromEntryProgram.entryIdentity);
    expect(lightAsSibling).toBe(lightAsEntry);
  });

  it("throws when the entry's import closure is incomplete", () => {
    // Drop the sibling: `./shared.ts` no longer resolves to an included file.
    expect(() =>
      computeEntryIdentity("/entry.tsx", [
        { name: "/entry.tsx", contents: ENTRY },
      ])
    ).toThrow(/incomplete closure/);
  });

  it("ignores unreachable files (a superset is safe)", () => {
    // An unrelated file with a dangling relative import must NOT trip the
    // entry's closure guard — the guard is scoped to the entry's reachable set.
    const identity = computeEntryIdentity("/entry.tsx", [
      { name: "/entry.tsx", contents: ENTRY },
      { name: "/shared.ts", contents: SHARED },
      {
        name: "/unrelated.tsx",
        contents:
          `import { x } from "./does-not-exist.ts";\nexport default x;\n`,
      },
    ]);
    expect(identity).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a fabric (cf:) import in the reachable closure", () => {
    expect(() =>
      computeEntryIdentity("/entry.tsx", [
        {
          name: "/entry.tsx",
          contents:
            `import { thing } from "cf:pattern/abc";\nexport default () => thing;\n`,
        },
      ])
    ).toThrow(/fabric import/);
  });

  it("is transitively sensitive to source changes", () => {
    const base = computeEntryIdentity("/entry.tsx", [
      { name: "/entry.tsx", contents: ENTRY },
      { name: "/shared.ts", contents: SHARED },
    ]);
    // Change a byte in the entry.
    const entryChanged = computeEntryIdentity("/entry.tsx", [
      { name: "/entry.tsx", contents: ENTRY + "\n" },
      { name: "/shared.ts", contents: SHARED },
    ]);
    // Change a byte in the (transitively imported) sibling.
    const siblingChanged = computeEntryIdentity("/entry.tsx", [
      { name: "/entry.tsx", contents: ENTRY },
      {
        name: "/shared.ts",
        contents: "export const shared = (x: number) => x + 2;\n" +
          "export default shared;\n",
      },
    ]);

    expect(entryChanged).not.toBe(base);
    expect(siblingChanged).not.toBe(base);
  });

  it("produces a 43-char base64url identity", () => {
    const identity = computeEntryIdentity("/shared.ts", [
      { name: "/shared.ts", contents: SHARED },
    ]);
    expect(identity).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("throws when the entry itself is not among the files", () => {
    expect(() =>
      computeEntryIdentity("/missing.tsx", [
        { name: "/other.ts", contents: SHARED },
      ])
    ).toThrow(/produced no identity/);
  });
  it("matches the engine for an entry importing an authored declaration file", async () => {
    const program: RuntimeProgram = {
      main: "/entry.tsx",
      files: [
        {
          name: "/entry.tsx",
          contents: 'import type { N } from "./types.d.ts";\n' +
            "export default (): N => 1;\n",
        },
        { name: "/types.d.ts", contents: "export type N = number;\n" },
      ],
    };
    const { entryIdentity } = await engine.compileToRecordGraph(program);
    expect(computeEntryIdentity(program.main, program.files)).toBe(
      entryIdentity,
    );
  });

  it("gives an entry a new identity when only its authored declaration file changed", async () => {
    // An authored declaration file is a module like any other: a type-only
    // import edge resolves to it, so editing one moves the importer's identity
    // and the entry's. Without this a declaration-only change would reuse the
    // compiled bytes built against the old types.
    const entry = 'import type { N } from "./types.d.ts";\n' +
      "export default (): N => 1;\n";
    const program = (declarations: string): RuntimeProgram => ({
      main: "/entry.tsx",
      files: [
        { name: "/entry.tsx", contents: entry },
        { name: "/types.d.ts", contents: declarations },
      ],
    });
    const before = program("export type N = number;\n");
    const after = program("export type N = 1 | 2 | 3;\n");

    const beforeIdentity = computeEntryIdentity(before.main, before.files);
    const afterIdentity = computeEntryIdentity(after.main, after.files);
    expect(afterIdentity).not.toBe(beforeIdentity);

    // The engine agrees with the light path on both sides, so the light path
    // does not merely differ — it differs the same way.
    expect((await engine.compileToRecordGraph(before)).entryIdentity).toBe(
      beforeIdentity,
    );
    expect((await engine.compileToRecordGraph(after)).entryIdentity).toBe(
      afterIdentity,
    );
  });

  it("ignores an ambient declaration file, which is not authored source", () => {
    const files = (declarations: string) => [
      { name: "/entry.tsx", contents: "export default () => 1;\n" },
      { name: "ambient.d.ts", contents: declarations },
    ];
    expect(computeEntryIdentity("/entry.tsx", files("declare const x: 1;\n")))
      .toBe(
        computeEntryIdentity("/entry.tsx", files("declare const x: 2;\n")),
      );
  });

  it("throws when the entry is named as a data file", () => {
    const files = [{ name: "/entry.ts", contents: "export default 1;\n" }];
    expect(() =>
      computeEntryIdentity("/entry.ts", files, { dataFiles: ["/entry.ts"] })
    ).toThrow("cannot be a data file");
  });

  it("throws when a package path is not among the files", () => {
    const files = [{ name: "/entry.ts", contents: "export default 1;\n" }];
    expect(() =>
      computeEntryIdentity("/entry.ts", files, { dataFiles: ["/data.json"] })
    ).toThrow("/data.json");
    expect(() =>
      computeEntryIdentity("/entry.ts", files, { sourceRoots: ["/other.ts"] })
    ).toThrow("/other.ts");
  });

  it("returns a different identity when a declaration-named file is data", () => {
    // The contents would dangle if scanned as an import, and the name would
    // vanish under the `.d.ts` filter if data were partitioned after it.
    const files = [
      { name: "/entry.ts", contents: "export default 1;\n" },
      { name: "/payload.d.ts", contents: 'import "./missing.ts";\n' },
    ];
    const identity = computeEntryIdentity("/entry.ts", files, {
      dataFiles: ["/payload.d.ts"],
    });
    expect(identity).not.toBe(computeEntryIdentity("/entry.ts", files));
  });

  it("matches the engine with attached roots and data files together", async () => {
    const program: RuntimeProgram = {
      main: "/entry.tsx",
      sourceRoots: ["/attached%20root.ts"],
      dataFiles: ["/payload.txt"],
      files: [
        { name: "/entry.tsx", contents: ENTRY },
        { name: "/shared.ts", contents: SHARED },
        {
          name: "/attached%20root.ts",
          contents: 'import { dataFile } from "commonfabric";\n' +
            'export const attached = () => dataFile("./payload.txt");\n',
        },
        { name: "/payload.txt", contents: 'import "./missing.ts";\r\n' },
      ],
    };
    const light = computeEntryIdentity(program.main, program.files, program);
    const compiled = await engine.compileToRecordGraph(program);
    expect(light).toBe(compiled.entryIdentity);
    expect(light).not.toBe(computeEntryIdentity(program.main, program.files));
    const changedData = program.files.map((file) =>
      file.name === "/payload.txt" ? { ...file, contents: "changed\n" } : file
    );
    expect(computeEntryIdentity(program.main, changedData, program)).not.toBe(
      light,
    );
  });

  it("throws for a source root whose closure is incomplete", () => {
    const files = [
      { name: "/entry.ts", contents: "export default 1;\n" },
      {
        name: "/root.ts",
        contents: 'import "./gone.ts";\nexport default 2;\n',
      },
    ];
    expect(() =>
      computeEntryIdentity("/entry.ts", files, { sourceRoots: ["/root.ts"] })
    ).toThrow("incomplete closure");
  });
});

describe("resolveEntryIdentity (closure walk via readFile)", () => {
  const APP =
    `import { shared } from "../lib/shared.ts";\nexport default () => shared(1);\n`;
  const disk = new Map<string, string>([
    ["/system/app.tsx", APP],
    ["/lib/shared.ts", SHARED],
    ["/system/unused.tsx", `import { gone } from "./missing.ts";\n`],
  ]);
  const reads: string[] = [];
  const readFile = (name: string): Promise<string> => {
    reads.push(name);
    const contents = disk.get(name);
    if (contents === undefined) {
      return Promise.reject(new Error(`not found: ${name}`));
    }
    return Promise.resolve(contents);
  };

  it("walks only the reachable closure and matches computeEntryIdentity", async () => {
    reads.length = 0;
    const walked = await resolveEntryIdentity("system/app.tsx", readFile);

    // Same value as feeding the closure explicitly.
    const explicit = computeEntryIdentity("/system/app.tsx", [
      { name: "/system/app.tsx", contents: APP },
      { name: "/lib/shared.ts", contents: SHARED },
    ]);
    expect(walked).toBe(explicit);

    // It read exactly the entry and its one sibling — never the unrelated
    // (broken) file.
    expect(new Set(reads)).toEqual(
      new Set(["/system/app.tsx", "/lib/shared.ts"]),
    );
  });

  it("reads a data file without scanning it for imports", async () => {
    const reads: string[] = [];
    const contents = new Map([
      ["/entry.ts", "export default 1;\n"],
      ["/notes.json", 'import "./missing.ts";\n'],
    ]);
    const readFile = (name: string): Promise<string> => {
      reads.push(name);
      const found = contents.get(name);
      if (found === undefined) {
        return Promise.reject(new Error(`no such file: ${name}`));
      }
      return Promise.resolve(found);
    };

    const identity = await resolveEntryIdentity("/entry.ts", readFile, {
      dataFiles: ["/notes.json"],
    });
    expect(identity.length).toBe(43);
    // The import-like text inside the data file was never followed.
    expect(new Set(reads)).toEqual(new Set(["/entry.ts", "/notes.json"]));
  });

  it("matches the engine for an entry that reads a data file", async () => {
    // Resolving a program acts on the `dataFile()` calls in its source, and the
    // compiler folds each file they name into the entry's hash.

    const files: Record<string, string> = {
      "/speller.tsx": 'import { dataFile } from "commonfabric";\n' +
        'export default () => dataFile("./words.txt");\n',
      "/words.txt": "able\nbaker\n",
    };
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const engine = runtime.harness as Engine;
      const program = await engine.resolve(
        new InMemoryProgram("/speller.tsx", files),
      );
      expect(program.dataFiles).toEqual(["/words.txt"]);
      const { entryIdentity } = await engine.compileToRecordGraph(program);

      const light = await resolveEntryIdentity(
        "/speller.tsx",
        (name) =>
          name in files
            ? Promise.resolve(files[name])
            : Promise.reject(new Error(`not found: ${name}`)),
      );
      expect(light).toBe(entryIdentity);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("walks a diamond closure once and skips bare imports", async () => {
    // entry → a, b; a → c, b → c (diamond: c visited once). entry also has a
    // bare `commonfabric` import (an external specifier the walk skips).
    const files = new Map<string, string>([
      [
        "/entry.tsx",
        `import { a } from "./a.ts";\nimport { b } from "./b.ts";\nimport "commonfabric";\nexport default () => a + b;\n`,
      ],
      ["/a.ts", `import { c } from "./c.ts";\nexport const a = c;\n`],
      ["/b.ts", `import { c } from "./c.ts";\nexport const b = c;\n`],
      ["/c.ts", `export const c = 1;\n`],
    ]);
    const reads: string[] = [];
    const walked = await resolveEntryIdentity("/entry.tsx", (name) => {
      reads.push(name);
      const c = files.get(name);
      return c === undefined
        ? Promise.reject(new Error(`nf: ${name}`))
        : Promise.resolve(c);
    });
    // c is read exactly once despite being imported by both a and b.
    expect(reads.filter((r) => r === "/c.ts").length).toBe(1);
    expect(walked).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("propagates a read failure for a genuinely missing dependency", async () => {
    const broken = new Map([[
      "/system/app.tsx",
      `import { gone } from "./missing.ts";\nexport default gone;\n`,
    ]]);
    await expect(
      resolveEntryIdentity(
        "/system/app.tsx",
        (name) =>
          broken.has(name)
            ? Promise.resolve(broken.get(name)!)
            : Promise.reject(new Error(`not found: ${name}`)),
      ),
    ).rejects.toThrow(/not found/);
  });
});
