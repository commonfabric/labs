import { expect } from "@std/expect";
import { dirname, join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type {
  Program,
  ProgramResolver,
  Source,
} from "@commonfabric/js-compiler";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { getProgramFromFile } from "../lib/piece.ts";

describe("piece source package", () => {
  it("infers a shared root for sibling main and test directories", async () => {
    const root = await Deno.makeTempDir();
    const patternsDirectory = join(root, "patterns");
    const testsDirectory = join(root, "tests");
    await Deno.mkdir(patternsDirectory);
    await Deno.mkdir(testsDirectory);
    const mainPath = join(patternsDirectory, "main.tsx");
    const testPath = join(testsDirectory, "main.test.tsx");
    await Deno.writeTextFile(mainPath, "export default {};");
    await Deno.writeTextFile(
      testPath,
      'import "../patterns/main.tsx"; export default {};',
    );

    const resolve = async (resolver: ProgramResolver): Promise<Program> => {
      const main = await resolver.main();
      const siblingMain = main.name.endsWith("/tests/main.test.tsx")
        ? await resolver.resolveSource(
          main.name.replace(
            /\/tests\/main\.test\.tsx$/,
            "/patterns/main.tsx",
          ),
        )
        : undefined;
      return {
        main: main.name,
        files: siblingMain === undefined ? [main] : [main, siblingMain],
      };
    };

    try {
      const inferred = await getProgramFromFile(
        { runtime: { harness: { resolve } } } as any,
        { mainPath, testPaths: [testPath] },
      );
      expect(inferred.main).toBe("/patterns/main.tsx");
      expect(inferred.sourceRoots).toEqual(["/tests/main.test.tsx"]);

      const explicit = await getProgramFromFile(
        { runtime: { harness: { resolve } } } as any,
        { mainPath, rootPath: dirname(root), testPaths: [testPath] },
      );
      const rootName = root.slice(dirname(root).length);
      expect(explicit.main).toBe(`${rootName}/patterns/main.tsx`);
      expect(explicit.sourceRoots).toEqual([
        `${rootName}/tests/main.test.tsx`,
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("includes attached tests and their imports in the authored program", async () => {
    const root = await Deno.makeTempDir();
    const testsDirectory = join(root, "tests");
    await Deno.mkdir(testsDirectory);
    const mainPath = join(root, "main.tsx");
    const sharedPath = join(root, "shared.ts");
    const testPath = join(testsDirectory, "main.test.tsx");
    await Deno.writeTextFile(mainPath, "export default {};");
    await Deno.writeTextFile(sharedPath, "export const shared = 1;");
    await Deno.writeTextFile(testPath, "export default {};");

    const resolve = async (resolver: ProgramResolver): Promise<Program> => {
      const main = await resolver.main();
      const files: Source[] = [main];
      const shared = await resolver.resolveSource("/shared.ts");
      if (shared !== undefined) files.push(shared);
      return { main: main.name, files };
    };

    try {
      const program = await getProgramFromFile(
        { runtime: { harness: { resolve } } } as any,
        {
          mainPath,
          mainExport: "piece",
          rootPath: root,
          testPaths: [testPath],
        },
      );

      expect(program.main).toBe("/main.tsx");
      expect(program.mainExport).toBe("piece");
      expect(program.sourceRoots).toEqual(["/tests/main.test.tsx"]);
      expect(program.files).toEqual([
        { name: "/main.tsx", contents: "export default {};" },
        { name: "/shared.ts", contents: "export const shared = 1;" },
        { name: "/tests/main.test.tsx", contents: "export default {};" },
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("attaches data files alongside the main entry and its tests", async () => {
    const root = await Deno.makeTempDir();
    const dataDirectory = join(root, "data");
    await Deno.mkdir(dataDirectory);
    const mainPath = join(root, "main.tsx");
    const testPath = join(root, "main.test.tsx");
    const citiesPath = join(dataDirectory, "cities.json");
    const notesPath = join(root, "notes.txt");
    await Deno.writeTextFile(mainPath, "export default {};");
    await Deno.writeTextFile(testPath, "export default {};");
    await Deno.writeTextFile(citiesPath, '{"cities": ["Oslo"]}');
    // Text a TypeScript parser would read as an import, if a data file were
    // ever parsed.
    await Deno.writeTextFile(notesPath, 'import x from "./absent.ts";');

    const resolve = async (resolver: ProgramResolver): Promise<Program> => ({
      main: (await resolver.main()).name,
      files: [await resolver.main()],
    });

    try {
      const program = await getProgramFromFile(
        { runtime: { harness: { resolve } } } as any,
        {
          mainPath,
          rootPath: root,
          testPaths: [testPath],
          dataFilePaths: [citiesPath, notesPath],
        },
      );

      expect(program.main).toBe("/main.tsx");
      expect(program.sourceRoots).toEqual(["/main.test.tsx"]);
      expect(program.dataFiles).toEqual(["/data/cities.json", "/notes.txt"]);
      expect(
        program.files.find((file) => file.name === "/data/cities.json")
          ?.contents,
      ).toBe('{"cities": ["Oslo"]}');
      expect(
        program.files.find((file) => file.name === "/notes.txt")?.contents,
      ).toBe('import x from "./absent.ts";');
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("infers a shared root covering a data file outside the entry directory", async () => {
    const root = await Deno.makeTempDir();
    const patternsDirectory = join(root, "patterns");
    const dataDirectory = join(root, "data");
    await Deno.mkdir(patternsDirectory);
    await Deno.mkdir(dataDirectory);
    const mainPath = join(patternsDirectory, "main.tsx");
    const dataPath = join(dataDirectory, "cities.json");
    await Deno.writeTextFile(mainPath, "export default {};");
    await Deno.writeTextFile(dataPath, "[]");

    const resolve = async (resolver: ProgramResolver): Promise<Program> => ({
      main: (await resolver.main()).name,
      files: [await resolver.main()],
    });

    try {
      const program = await getProgramFromFile(
        { runtime: { harness: { resolve } } } as any,
        { mainPath, dataFilePaths: [dataPath] },
      );
      expect(program.main).toBe("/patterns/main.tsx");
      expect(program.dataFiles).toEqual(["/data/cities.json"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("refuses a data file outside the deployment root", async () => {
    const root = await Deno.makeTempDir();
    const inner = join(root, "inner");
    await Deno.mkdir(inner);
    const mainPath = join(inner, "main.tsx");
    const outsidePath = join(root, "outside.json");
    await Deno.writeTextFile(mainPath, "export default {};");
    await Deno.writeTextFile(outsidePath, "{}");

    const resolve = async (resolver: ProgramResolver): Promise<Program> => ({
      main: (await resolver.main()).name,
      files: [await resolver.main()],
    });

    try {
      await expect(getProgramFromFile(
        { runtime: { harness: { resolve } } } as any,
        { mainPath, rootPath: inner, dataFilePaths: [outsidePath] },
      )).rejects.toThrow("must be within root directory");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("refuses a data file that is not valid UTF-8 text", async () => {
    const root = await Deno.makeTempDir();
    const mainPath = join(root, "main.tsx");
    const binaryPath = join(root, "blob.bin");
    await Deno.writeTextFile(mainPath, "export default {};");
    await Deno.writeFile(binaryPath, new Uint8Array([0xff, 0xfe, 0x00]));

    const resolve = async (resolver: ProgramResolver): Promise<Program> => ({
      main: (await resolver.main()).name,
      files: [await resolver.main()],
    });

    try {
      await expect(getProgramFromFile(
        { runtime: { harness: { resolve } } } as any,
        { mainPath, rootPath: root, dataFilePaths: [binaryPath] },
      )).rejects.toThrow("is not valid UTF-8 text");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("refuses a data file that is also a source module", async () => {
    const root = await Deno.makeTempDir();
    const mainPath = join(root, "main.tsx");
    const sharedPath = join(root, "shared.ts");
    await Deno.writeTextFile(
      mainPath,
      'import "./shared.ts"; export default {};',
    );
    await Deno.writeTextFile(sharedPath, "export const shared = 1;");

    const resolve = async (resolver: ProgramResolver): Promise<Program> => {
      const main = await resolver.main();
      const files: Source[] = [main];
      const shared = await resolver.resolveSource("/shared.ts");
      if (shared !== undefined) files.push(shared);
      return { main: main.name, files };
    };

    try {
      await expect(getProgramFromFile(
        { runtime: { harness: { resolve } } } as any,
        { mainPath, rootPath: root, dataFilePaths: [sharedPath] },
      )).rejects.toThrow(
        'Data file "/shared.ts" is also a source module of this program.',
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("accepts a repeated --datafile path once", async () => {
    const root = await Deno.makeTempDir();
    const mainPath = join(root, "main.tsx");
    const dataPath = join(root, "cities.json");
    await Deno.writeTextFile(mainPath, "export default {};");
    await Deno.writeTextFile(dataPath, "[]");

    const resolve = async (resolver: ProgramResolver): Promise<Program> => ({
      main: (await resolver.main()).name,
      files: [await resolver.main()],
    });

    try {
      const program = await getProgramFromFile(
        { runtime: { harness: { resolve } } } as any,
        { mainPath, rootPath: root, dataFilePaths: [dataPath, dataPath] },
      );
      expect(program.dataFiles).toEqual(["/cities.json"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("recovers attached data files from the fabric source package", async () => {
    const root = await Deno.makeTempDir();
    const dataDirectory = join(root, "data");
    await Deno.mkdir(dataDirectory);
    const mainPath = join(root, "main.tsx");
    const dataPath = join(dataDirectory, "cities.json");
    await Deno.writeTextFile(
      mainPath,
      `import { pattern } from "commonfabric";
export default pattern(() => ({ value: 1 }));`,
    );
    await Deno.writeTextFile(dataPath, '{"cities": ["Oslo"]}');

    const signer = await Identity.fromPassphrase("attached piece data files");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const program = await getProgramFromFile(
        { runtime } as any,
        { mainPath, rootPath: root, dataFilePaths: [dataPath] },
      );
      const compiled = await runtime.patternManager.compilePattern(program, {
        space: signer.did(),
      });
      const entry = runtime.patternManager.getArtifactEntryRef(compiled);
      expect(entry).toBeDefined();

      const recovered = await runtime.patternManager
        .getPatternSourceProgramByIdentity(entry!.identity, signer.did());
      expect(recovered?.dataFiles).toEqual(["/data/cities.json"]);
      expect(
        recovered?.files.find((file) => file.name === "/data/cities.json")
          ?.contents,
      ).toBe('{"cities": ["Oslo"]}');

      const recompiled = await runtime.harness.compileResolvedToRecordGraph(
        recovered!.files,
        recovered!.main,
        { dataFiles: recovered!.dataFiles },
      );
      expect(recompiled.entryIdentity).toBe(entry!.identity);

      // A data-only edit is a distinct source revision, so the earlier one
      // stays recoverable with its own bytes.
      await Deno.writeTextFile(dataPath, '{"cities": ["Lima"]}');
      const nextProgram = await getProgramFromFile(
        { runtime } as any,
        { mainPath, rootPath: root, dataFilePaths: [dataPath] },
      );
      const nextCompiled = await runtime.patternManager.compilePattern(
        nextProgram,
        { space: signer.did() },
      );
      const nextEntry = runtime.patternManager.getArtifactEntryRef(
        nextCompiled,
      );
      expect(nextEntry).toBeDefined();
      expect(nextEntry!.identity).not.toBe(entry!.identity);

      const firstAgain = await runtime.patternManager
        .getPatternSourceProgramByIdentity(entry!.identity, signer.did());
      const second = await runtime.patternManager
        .getPatternSourceProgramByIdentity(nextEntry!.identity, signer.did());
      expect(
        firstAgain?.files.find((file) => file.name === "/data/cities.json")
          ?.contents,
      ).toBe('{"cities": ["Oslo"]}');
      expect(
        second?.files.find((file) => file.name === "/data/cities.json")
          ?.contents,
      ).toBe('{"cities": ["Lima"]}');
    } finally {
      await runtime.settled();
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
      await Deno.remove(root, { recursive: true });
    }
  });

  it("recovers attached tests from the fabric source package", async () => {
    const root = await Deno.makeTempDir();
    const testsDirectory = join(root, "tests");
    await Deno.mkdir(testsDirectory);
    const mainPath = join(root, "main.tsx");
    const testPath = join(testsDirectory, "main.test.tsx");
    const helperPath = join(testsDirectory, "helper.ts");
    const typesPath = join(testsDirectory, "types.d.ts");
    await Deno.writeTextFile(
      mainPath,
      `import { pattern } from "commonfabric";
export default pattern(() => ({ value: 1 }));`,
    );
    await Deno.writeTextFile(
      testPath,
      `import "../main.tsx";
import { pattern } from "commonfabric";
import { expected } from "./helper.ts";
import type { Expected } from "./types.d.ts";
const typed: Expected = expected;
export default pattern(() => ({ tests: [typed] }));`,
    );
    await Deno.writeTextFile(helperPath, 'export const expected = "first";');
    await Deno.writeTextFile(typesPath, 'export type Expected = "first";');

    const signer = await Identity.fromPassphrase("attached piece tests");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const program = await getProgramFromFile(
        { runtime } as any,
        { mainPath, rootPath: root, testPaths: [testPath] },
      );
      const compiled = await runtime.patternManager.compilePattern(program, {
        space: signer.did(),
      });
      const entry = runtime.patternManager.getArtifactEntryRef(compiled);

      expect(entry).toBeDefined();
      const recovered = await runtime.patternManager
        .getPatternSourceProgramByIdentity(
          entry!.identity,
          signer.did(),
        );
      expect(recovered?.files.map((file) => file.name).sort()).toEqual([
        "/main.tsx",
        "/tests/helper.ts",
        "/tests/main.test.tsx",
        "/tests/types.d.ts",
      ]);
      expect(recovered?.files.map((file) => file.name)).toContain(
        "/tests/main.test.tsx",
      );
      expect(recovered?.files.map((file) => file.name)).toContain(
        "/tests/helper.ts",
      );
      expect(recovered?.files.map((file) => file.name)).toContain(
        "/tests/types.d.ts",
      );
      expect(recovered?.sourceRoots).toEqual(["/tests/main.test.tsx"]);

      const recompiled = await runtime.harness.compileResolvedToRecordGraph(
        recovered!.files,
        recovered!.main,
        { sourceRoots: recovered!.sourceRoots },
      );
      expect(recompiled.entryIdentity).toBe(entry!.identity);

      await Deno.writeTextFile(
        testPath,
        `import "../main.tsx";
import { pattern } from "commonfabric";
export default pattern(() => ({ tests: ["second"] }));`,
      );
      const nextProgram = await getProgramFromFile(
        { runtime } as any,
        { mainPath, rootPath: root, testPaths: [testPath] },
      );
      const nextCompiled = await runtime.patternManager.compilePattern(
        nextProgram,
        { space: signer.did() },
      );
      const nextEntry = runtime.patternManager.getArtifactEntryRef(
        nextCompiled,
      );
      expect(nextEntry).toBeDefined();
      expect(nextEntry!.identity).not.toBe(entry!.identity);

      const firstAgain = await runtime.patternManager
        .getPatternSourceProgramByIdentity(entry!.identity, signer.did());
      const second = await runtime.patternManager
        .getPatternSourceProgramByIdentity(nextEntry!.identity, signer.did());
      expect(
        firstAgain?.files.find((file) => file.name === "/tests/main.test.tsx")
          ?.contents,
      ).toContain("expected");
      expect(
        second?.files.find((file) => file.name === "/tests/main.test.tsx")
          ?.contents,
      ).toContain('tests: ["second"]');
    } finally {
      await runtime.settled();
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
      await Deno.remove(root, { recursive: true });
    }
  });
});
